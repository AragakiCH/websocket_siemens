// =========================================================================
// RealPLCService.ts
// Reemplazo REAL del MockPLCService. Expone EXACTAMENTE la misma interfaz
// (getVariables / subscribe / toggleSelected / start / setRate / stop), pero
// en vez de generar datos random se conecta al WebSocket del backend FastAPI
// (/ws) y traduce los tags OPC UA a PlcVariable con plcAdapter.
//
// Gracias a que la interfaz es idéntica, en AppStore.tsx solo cambias la
// línea de import (Mock -> Real). Las vistas no se tocan.
//
// Notas:
//  * La URL es RELATIVA (window.location.host): en dev el proxy de Vite
//    (puerto 5173) reenvía /ws al backend (8000); en producción lo sirve el
//    propio FastAPI, así que también funciona sin tocar nada.
//  * `start(rate)` / `setRate(rate)` ya NO generan datos: ahora el rate es un
//    THROTTLE de re-render (cada cuánto se refresca la UI como máximo). El
//    dato real llega cuando el PLC cambia (sampling mínimo del S7 = 1000 ms).
//  * La selección de variables (checkbox de Configuración) es 100% del
//    frontend y se persiste en localStorage.
// =========================================================================
import { InfoPlc, PlcVariable, PlcVendor } from '../models/plc';
import { toPlcVariables } from './plcAdapter';
import { getToken, tokenParaWs } from './authApi';

const RETRY_MS = 3000;
const SELECTION_KEY = 'hmi.plc.selection'; // localStorage

type Listener = (vars: PlcVariable[]) => void;

class RealPLCServiceImpl {
  // Estado crudo recibido del backend: { "plc|tag": {plc, tag, value, type,...} }
  private tags: Record<string, any> = {};

  // QUIÉN es cada PLC: marca, nombre, endpoint y estado.
  //
  // Viene en el MISMO snapshot que los tags, en `msg.plcs`, y hasta ahora se
  // tiraba: la línea de abajo se quedaba solo con `msg.tags`. Por eso las
  // listas de variables enseñaban `PLC_PRG.rVar1` sin decir de qué autómata
  // salía, teniendo el dato a mano en cada mensaje.
  //
  // No cuesta una petición más ni un byte más de red: ya estaba llegando.
  private plcs: Record<string, InfoPlc> = {};
  // Selección persistida por el usuario: id -> boolean
  private selection: Map<string, boolean> = this.loadSelection();

  private listeners = new Set<Listener>();
  private ws: WebSocket | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private manualClose = false;

  /**
   * ¿El servidor exige sesión para el WebSocket?
   *
   *   true   -> sin token no se intenta (el servidor lo cerraría).
   *   false  -> se abre SIN token: el servidor lo acepta como anónimo.
   *   null   -> todavía no se sabe; se espera al token, como siempre.
   *
   * Lo dice el AppStore en cuanto `GET /auth/me` responde (`auth_requerida`).
   * Sin esto, una instalación sin inicio de sesión —el valor por defecto de
   * `PLC_AUTH_REQUERIDA`, y el habitual en el escritorio— no abría nunca el
   * socket: el guardia de "sin token no se intenta" no distinguía entre "aún
   * no ha entrado" y "aquí no hay que entrar". La vista se quedaba con lo
   * que hubiera y no se movía un valor hasta reabrir el programa.
   */
  private authRequerida: boolean | null = null;

  setAuthRequerida(valor: boolean) {
    const antes = this.authRequerida;
    this.authRequerida = valor;
    // Si acaba de saberse que NO hace falta sesión y el socket estaba
    // esperando un token que nunca iba a llegar, se abre ya, sin esperar al
    // siguiente reintento.
    if (antes !== false && valor === false) this.openSocket();
  }

  private rate = 1000;
  private dirty = false;
  private running = false;
  // `Date.now()` de la última emisión a los suscriptores (ver el throttle).
  private ultimaEmision = 0;

  // ---- localStorage helpers ------------------------------------------- //
  private loadSelection(): Map<string, boolean> {
    try {
      const raw = localStorage.getItem(SELECTION_KEY);
      if (!raw) return new Map();
      return new Map(Object.entries(JSON.parse(raw)));
    } catch {
      return new Map();
    }
  }

  private saveSelection() {
    try {
      localStorage.setItem(
        SELECTION_KEY,
        JSON.stringify(Object.fromEntries(this.selection))
      );
    } catch {
      /* ignore */
    }
  }

  // ---- interfaz PÚBLICA (igual que MockPLCService) -------------------- //
  getVariables(): PlcVariable[] {
    return toPlcVariables(this.tags, this.selection);
  }

  /** Compat con el mock; en modo real no se usa desde fuera. */
  setVariables(_vars: PlcVariable[]) {
    /* no-op: los valores mandan desde el PLC */
  }

  toggleSelected(id: string, selected: boolean) {
    this.selection.set(id, selected);
    this.saveSelection();
    this.emitNow();
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    fn(this.getVariables()); // snapshot inmediato
    return () => this.listeners.delete(fn);
  }

  start(rate: number) {
    this.rate = rate;
    this.running = true;
    this.openSocket();
    this.startFlush();
  }

  setRate(rate: number) {
    if (this.rate === rate) return;
    this.rate = rate;
    if (this.running) this.startFlush(); // reinicia el intervalo con el nuevo rate
  }

  stop() {
    this.running = false;
    this.manualClose = true;
    if (this.flushTimer) clearInterval(this.flushTimer);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.flushTimer = null;
    this.retryTimer = null;
    this.ws?.close();
    this.ws = null;
    this.marcarConexion(false);
  }

  // ---- Estado del enlace ---------------------------------------------- //
  //
  // Para el indicador «EN VIVO» de la Vista Previa. No vale mirar
  // `AppStore.connected`: ese dice si se dio de alta un PLC, no si el enlace
  // con el backend está abierto — y en un SCADA «en vivo» significa
  // exactamente lo segundo. Un cartel verde que no comprueba nada es peor
  // que no tener cartel.
  //
  // Se avisa por evento del navegador, igual que los mensajes de proyecto,
  // para no obligar a nadie a suscribirse a este singleton.
  private vivo = false;

  /** ¿Está abierto el WebSocket ahora mismo? */
  estaConectado(): boolean {
    return this.vivo;
  }

  /**
   * Estado de conexión de cada PLC, según lo último que dijo el servidor.
   *
   * Se alimenta del `plcs` del snapshot y de los mensajes `status` que el
   * backend manda al conectar, al perder la conexión y al reconectar. Hasta
   * ahora esos mensajes se tiraban ("no afectan a las variables"), y sí
   * afectan a una cosa: a saber si un valor que no se mueve es un valor
   * ESTABLE o un valor CONGELADO por un PLC caído. El trend necesita esa
   * diferencia para dibujar una línea plana o un hueco.
   */
  private plcConectado = new Map<string, boolean>();

  /**
   * ¿Se puede confiar en el último valor de este PLC ahora mismo?
   *
   * Sí cuando el socket está vivo y el PLC no se ha reportado caído. Un PLC
   * del que no se sabe nada (todavía no vino en ningún snapshot) se da por
   * bueno: inventar un hueco es peor que no inventarlo. Las internas no
   * tienen conexión que perder: mientras haya socket, están.
   */
  plcDisponible(plcId: string): boolean {
    if (!this.vivo) return false;
    if (plcId === 'interno') return true;
    return this.plcConectado.get(plcId) ?? true;
  }

  private marcarConexion(vivo: boolean) {
    if (this.vivo === vivo) return; // sin cambio, sin evento
    this.vivo = vivo;
    window.dispatchEvent(
      new CustomEvent('hmi:conexion', { detail: { vivo } })
    );
  }

  // ---- WebSocket ------------------------------------------------------ //
  private openSocket() {
    if (this.ws && this.ws.readyState <= WebSocket.OPEN) return; // ya abierto/abriendo
    this.manualClose = false;

    // Sin token no se intenta siquiera... SALVO que el servidor haya dicho
    // que no exige sesión. Con la autenticación activada el backend cierra el
    // socket nada más abrirlo, y el reintento automático convertía eso en un
    // martilleo constante contra una puerta cerrada —se midió: cuatro
    // conexiones rechazadas seguidas en la pantalla de acceso—. Pero con la
    // autenticación desactivada el servidor acepta el socket sin token, y
    // esperar uno que nunca va a llegar dejaba la vista sin datos en vivo
    // (ver `authRequerida`). Cuando alguien entra, el siguiente reintento ve
    // el token y conecta.
    if (!getToken() && this.authRequerida !== false) {
      this.retryTimer = setTimeout(() => this.openSocket(), RETRY_MS);
      return;
    }

    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
    // El token va en el query string porque la API de WebSocket del
    // navegador no permite cabeceras personalizadas al conectar.
    const url = tokenParaWs(`${proto}://${window.location.host}/ws`);
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.onopen = () => this.marcarConexion(true);
    // El resto del sistema escucha `hmi:conexion` para RESINCRONIZAR al
    // volver: mientras el socket estuvo caído se perdieron los eventos de
    // proyecto y de runtime, y el snapshot que manda el servidor al conectar
    // solo cubre los valores de los tags, no el diseño.

    ws.onmessage = (ev) => {
      let msg: any;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }

      if (msg.type === 'snapshot') {
        // Reemplaza todo el estado con lo del snapshot.
        this.tags = msg.tags ?? {};
        // Y el estado de conexión de cada PLC, que viene en el mismo mensaje.
        this.plcConectado.clear();
        for (const [id, p] of Object.entries<any>(msg.plcs ?? {})) {
          this.plcConectado.set(id, p?.conectado !== false);
        }
        // Y la ficha de cada PLC (marca, nombre, endpoint, estado).
        this.fijarPlcs(msg.plcs);
        this.emitNow(); // refresco inmediato al conectar / al agregar PLC
        // Y se avisa al resto (Configuración refresca su lista de PLCs al
        // instante en vez de esperar a su siguiente sondeo).
        window.dispatchEvent(new CustomEvent('hmi:ws', { detail: msg }));
      } else if (msg.type === 'plc_removed') {
        const id = msg.plc_removed;
        this.tags = Object.fromEntries(
          Object.entries(this.tags).filter(([, t]) => t.plc !== id)
        );
        this.plcConectado.delete(id);
        // Y su ficha: dejarla dejaría una marca colgando de un PLC que ya no
        // existe, y las listas seguirían ofreciéndolo.
        if (this.plcs[id]) {
          const { [id]: _fuera, ...resto } = this.plcs;
          this.plcs = resto;
          this.avisarPlcs();
        }
        this.emitNow();
        window.dispatchEvent(new CustomEvent('hmi:ws', { detail: msg }));
      } else if (msg.type === 'status') {
        // Estado de conexión de un PLC. No cambia ningún valor, pero sí si
        // se puede CONFIAR en los valores de ese PLC (ver `plcDisponible`).
        if (typeof msg.plc === 'string' && typeof msg.status === 'string') {
          this.plcConectado.set(msg.plc, msg.status === 'conectado');
        }
        // Y la ficha del PLC: es el aviso de que se cayó o volvió. Sin esto,
        // el «conectado» de la ficha se quedaría clavado en lo que dijera el
        // último snapshot, que puede ser de hace horas.
        const ficha = this.plcs[msg.plc];
        if (ficha && msg.status) {
          this.plcs = {
            ...this.plcs,
            [msg.plc]: {
              ...ficha,
              estado: msg.status,
              conectado: msg.status === 'conectado',
            },
          };
          this.avisarPlcs();
        }
        // Se reemite como evento del sistema: la página de Conexión PLC
        // pinta «conectado / reconectando» en cuanto pasa, no 5 s después.
        window.dispatchEvent(new CustomEvent('hmi:ws', { detail: msg }));
      } else if (msg.tag !== undefined && msg.plc !== undefined) {
        // ── CAMBIO DE VALOR DE UN TAG, EN TIEMPO REAL ──────────────────
        //
        // ESTA RAMA TIENE QUE IR ANTES QUE LA GENÉRICA DE ABAJO. Los mensajes
        // de valor también traen `type`: es el tipo de dato OPC («Float»,
        // «Boolean», «Int32»), tanto en los del PLC como en los de las
        // variables internas. Cuando la rama genérica pasó de una lista
        // cerrada de cuatro tipos a "todo lo que traiga `type`", se tragó
        // también estos, y NINGÚN valor volvió a llegar a los widgets: solo
        // el snapshot al abrir el socket.
        //
        // El síntoma era exactamente "solo se actualiza al cerrar y volver
        // a abrir": el interruptor de una interna no cambiaba (cada clic
        // invertía el valor del servidor sobre una pantalla congelada), un
        // texto escrito "volvía" al anterior, y un PLC que conectaba después
        // de abrir la vista no enseñaba sus tags.
        //
        // Lo que distingue un valor de un evento del sistema no es `type`
        // sino `tag` + `plc`: ningún evento de proyecto, lock, tema o alarma
        // los lleva arriba del todo (las alarmas van dentro de `alarma`).
        const clave = `${msg.plc}|${msg.tag}`;
        this.tags[clave] = { ...(this.tags[clave] ?? {}), ...msg };
        if (msg.plc === 'interno') {
          // Una interna la acaba de mover una persona, y espera verla
          // moverse YA: en la tabla de Variables y en el widget que la
          // enseña. Son pocas y no llegan a ráfagas, así que se emite al
          // instante, sin pasar por el throttle.
          this.emitNow();
        } else if (Date.now() - this.ultimaEmision >= this.rate) {
          // ── THROTTLE «DE BORDE DE SUBIDA» PARA LOS VALORES DEL PLC ──
          //
          // Antes todo valor de PLC esperaba al siguiente tic del flush
          // (`rate`: 1 s por defecto, hasta 5 s si el usuario eligió esa
          // frecuencia en Configuración). Para un PLC virtual que mueve
          // todo cada 100 ms da igual: siempre hay un tic cerca. Para un
          // Siemens de verdad no: sus variables cambian de tarde en tarde,
          // de una en una, y cada cambio llegaba a la pantalla con hasta
          // `rate` de retraso mientras la interna de al lado se movía al
          // instante. Eso es lo que se veía como "las del PLC van lentas".
          //
          // Ahora, si desde la última emisión ya pasó `rate`, el cambio
          // se pinta YA. Si llegan en ráfaga (varios dentro del mismo
          // `rate`), el primero se pinta y el resto se acumula hasta el
          // siguiente tic: la frecuencia elegida sigue siendo el TECHO de
          // repintados por segundo, que es para lo que existe.
          this.emitNow();
        } else {
          this.dirty = true; // ráfaga: se emitirá en el próximo flush
        }
      } else if (typeof msg.type === 'string') {
        // Canal de PROYECTO / CONFIGURACIÓN: baja frecuencia. Este servicio
        // no los interpreta, pero es el único que tiene el socket abierto,
        // así que los reemite como eventos del navegador y quien quiera los
        // escucha (AppStore, Vista Previa, presencia...). Evita abrir un
        // segundo WebSocket solo para esto.
        //
        // SE REEMITE TODO lo que traiga `type` y no sea un dato de PLC (los
        // datos de PLC se reconocen por `tag` + `plc`, arriba). Antes había
        // una lista cerrada de cuatro tipos (`project.updated`,
        // `project.removed`, `config.updated`, `presence`) y todo lo demás
        // se tiraba en silencio: `lock.changed` (el lápiz), `tema.updated`,
        // `proyecto.updated`/`proyecto.removed`, `alarma.*`... con código
        // escuchándolos en `useLock`, `TemaProvider`, `AppStore` y el widget
        // de alarmas que nunca llegaba a enterarse. Cada tipo nuevo del
        // backend obligaba a acordarse de venir aquí, y nadie se acordaba.
        window.dispatchEvent(new CustomEvent('hmi:ws', { detail: msg }));
      }
    };

    ws.onclose = () => {
      this.marcarConexion(false);
      if (!this.manualClose) {
        this.retryTimer = setTimeout(() => this.openSocket(), RETRY_MS);
      }
    };

    ws.onerror = () => ws.close();
  }

  // ---- Quién es cada PLC ---------------------------------------------- //
  //
  // Se avisa por evento del navegador, igual que `hmi:conexion` y por el mismo
  // motivo: quien lo necesita son componentes de módulos que no importan a
  // este de vuelta, y un evento no crea esa dependencia.

  /** Ficha de cada PLC conectado, indexada por `plc_id`. */
  getPlcs(): Record<string, InfoPlc> {
    return this.plcs;
  }

  /** La marca de un PLC, o cadena vacía si no se conoce todavía. */
  vendorDe(plcId: string): string {
    return this.plcs[plcId]?.vendor ?? '';
  }

  private fijarPlcs(crudo: any): void {
    const nuevo: Record<string, InfoPlc> = {};
    for (const [id, p] of Object.entries<any>(crudo ?? {})) {
      nuevo[id] = {
        id,
        nombre: String(p?.nombre ?? ''),
        // Se normaliza aquí y no en quien lo lee: un vendor que no
        // reconozcamos NO se descarta —`etiquetaVendor` lo enseña tal cual—,
        // porque ver «omron» es más útil que no ver nada el día que se añada
        // un driver nuevo al backend y aún no esté en el tipo del frontend.
        vendor: String(p?.vendor ?? '') as PlcVendor,
        endpoint: String(p?.endpoint ?? ''),
        estado: String(p?.estado ?? ''),
        conectado: !!p?.conectado,
        interno: !!p?.interno,
      };
    }
    this.plcs = nuevo;
    this.avisarPlcs();
  }

  private avisarPlcs(): void {
    try {
      window.dispatchEvent(new CustomEvent('hmi:plcs', { detail: this.plcs }));
    } catch {
      /* sin `window` (pruebas): el mapa ya está al día, que es lo que importa */
    }
  }

  // ---- Throttle de re-render ------------------------------------------ //
  private startFlush() {
    if (this.flushTimer) clearInterval(this.flushTimer);
    this.flushTimer = setInterval(() => {
      if (this.dirty) this.emitNow();
    }, this.rate);
  }

  private emitNow() {
    this.dirty = false;
    this.ultimaEmision = Date.now();
    const snapshot = this.getVariables();
    this.listeners.forEach((l) => l(snapshot));
  }
}

// Se exporta con el MISMO nombre-alias que espera AppStore.
export const RealPLCService = new RealPLCServiceImpl();
