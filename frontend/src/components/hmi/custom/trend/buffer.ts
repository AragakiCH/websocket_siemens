// =========================================================================
// custom/trend/buffer.ts
// La memoria del trend: los últimos N minutos de cada variable.
//
// VENTANA Y RETENCIÓN SON DOS COSAS
//
//   ventanaSeg    cuánto se VE de un vistazo        (ej. 60 s)
//   retencionSeg  cuánto se GUARDA para retroceder  (ej. 30 min)
//
// Mientras el búfer solo guardaba la ventana, «retroceder» no existía: los
// datos anteriores ya se habían tirado.
//
// FORMATO COLUMNAR, PORQUE ES EL QUE PIDE uPlot
// uPlot no quiere una lista de puntos {t, v}: quiere un array de tiempos y un
// array de valores por serie, todos de la MISMA longitud y con el tiempo
// estrictamente creciente. Ese formato es además el más barato de mantener:
// añadir una muestra es un `push` por columna, y dibujar no copia nada.
//
// POR QUÉ SE MUESTREA A INTERVALO FIJO Y NO «CUANDO CAMBIA UN TAG»
// Un tag OPC UA solo avisa cuando cambia; entre dos avisos el valor real es
// el último recibido (retención de orden cero). Y uPlot necesita UNA columna
// de tiempos compartida. Así que cada vez que llegan valores se escribe una
// FILA con el valor vigente de todas las series. Eso no inventa nada: repetir
// el último valor conocido es exactamente lo que vale la señal.
//
// LO QUE SÍ SERÍA INVENTAR: DIBUJAR DURANTE UN CORTE
// Si el WebSocket se cae, `variables` se queda con los últimos valores y una
// línea recta seguiría avanzando como si el proceso siguiera reportando. Eso
// es mentira. Por eso hay un latido: mientras la CONEXIÓN está viva repite el
// valor vigente (la traza avanza suave aunque nada cambie), y si el socket o
// el PLC de esa serie están caídos escribe `null`, que uPlot dibuja como
// HUECO. Un corte se ve como un corte.
//
// LA FRESCURA SE MIDE POR LA CONEXIÓN, NO POR LOS CAMBIOS. Antes el latido
// cortaba la traza si en 4 s no había llegado NINGÚN valor nuevo. Parecía
// razonable y era un error de concepto: OPC UA solo avisa cuando un valor
// cambia, y una variable interna a la que le pones un número fijo no cambia
// nunca. Resultado: cada serie estable se cortaba a los 4 s de su último
// cambio y "reaparecía" al siguiente, como si la señal fuera intermitente.
// Un valor que no cambia es una línea recta, no un hueco. Lo que dice si
// esa recta es verdad es si el servidor sigue conectado y si el PLC de la
// serie sigue reportando — y eso lo sabe `RealPLCService.plcDisponible`.
//
// LOS HUECOS SON NULL, NO CEROS
// Guardar 0 sería mentir: una temperatura que desaparece no es 0 °C.
//
// EL TIEMPO VA EN SEGUNDOS
// Es lo que espera la escala temporal de uPlot. Con decimales, así que no se
// pierde precisión de milisegundos.
// =========================================================================
import { useEffect, useRef } from 'react';
import type { PlcVariable } from '../../../../models/plc';
import { RealPLCService } from '../../../../services/RealPLCService';
import { guardarBuffer, leerBuffer } from './sesionTrend';

/** Tope duro de muestras. Protege la memoria del navegador. */
export const MAX_PUNTOS = 120_000;

/** Cada cuánto late el muestreo cuando el PLC no reporta cambios. */
const LATIDO_MS = 1000;

export class BufferTrend {
  /** Marcas de tiempo, en segundos epoch. Estrictamente creciente. */
  t: number[] = [];
  /** variableId -> valores, alineados con `t`. */
  cols = new Map<string, (number | null)[]>();

  /**
   * Ajusta las columnas a la lista de series actual.
   *
   * Una serie nueva nace con el pasado en `null`: no se inventa historia que
   * no se llegó a recibir, y el gráfico lo enseña como lo que es, un hueco
   * hasta que la agregaste.
   */
  sincronizar(ids: string[]): void {
    for (const id of ids) {
      if (!this.cols.has(id)) {
        this.cols.set(id, new Array(this.t.length).fill(null));
      }
    }
    const vivos = new Set(ids);
    for (const id of Array.from(this.cols.keys())) {
      if (!vivos.has(id)) this.cols.delete(id);
    }
  }

  /** Añade una fila. `ts` en segundos. */
  push(ts: number, valores: Map<string, number | null>): void {
    const ultimo = this.t.length ? this.t[this.t.length - 1] : -Infinity;
    // uPlot exige que el tiempo crezca SIEMPRE. Dos flushes en el mismo
    // milisegundo (pasa con updateRate a 100 ms y una pestaña ocupada)
    // producirían dos x iguales y el gráfico se dibuja mal.
    const t = ts > ultimo ? ts : ultimo + 0.001;

    this.t.push(t);
    for (const [id, col] of this.cols) {
      const v = valores.get(id);
      col.push(v === undefined ? null : v);
    }
  }

  /**
   * Tira lo que se salió de la retención.
   *
   * Se poda por LOTES: `splice` mueve todo el array, así que hacerlo diez
   * veces por segundo sobre 100.000 puntos se nota. Se deja crecer un margen
   * y se corta de una vez. El margen NUNCA hace que se pierda dato que la
   * pantalla todavía puede pedir: solo retrasa la limpieza de lo ya caducado.
   */
  podar(retencionSeg: number, maxPuntos: number = MAX_PUNTOS): void {
    const n = this.t.length;
    if (n === 0) return;

    const corte = this.t[n - 1] - retencionSeg;
    let caducadas = 0;
    while (caducadas < n && this.t[caducadas] < corte) caducadas++;

    const exceso = Math.max(0, n - maxPuntos);
    // Se limpia cuando ya sobra un lote que valga la pena, o cuando se pasó
    // del tope duro (eso sí es inmediato: es la memoria del navegador).
    const porRetencion = caducadas >= 500 || caducadas > n * 0.1 ? caducadas : 0;
    const cuantas = Math.max(porRetencion, exceso);
    if (cuantas <= 0) return;

    this.t.splice(0, cuantas);
    for (const col of this.cols.values()) col.splice(0, cuantas);
  }

  /**
   * Los datos tal y como los quiere `uPlot.setData()`.
   *
   * Devuelve las MISMAS arrays, no copias: el array exterior es nuevo (barato)
   * pero las columnas se pasan por referencia. Copiar 100.000 puntos diez
   * veces por segundo sería el único trabajo pesado de todo el widget.
   */
  datos(ids: string[]): any {
    return [this.t, ...ids.map((id) => this.cols.get(id) ?? [])];
  }

  /** Columna de una serie, para leer el valor bajo el cursor. */
  columna(id: string): (number | null)[] | undefined {
    return this.cols.get(id);
  }

  /** Primer y último instante guardados, en segundos. `null` si está vacío. */
  rango(): [number, number] | null {
    if (!this.t.length) return null;
    return [this.t[0], this.t[this.t.length - 1]];
  }

  get puntos(): number {
    return this.t.length;
  }

  /**
   * ¿Están todas las columnas alineadas con `t`?
   *
   * uPlot lee `data[i][idx]` sin comprobar nada: una columna más corta que la
   * de tiempos es un `undefined` en medio del dibujo. Esto no debería fallar
   * nunca — está para que, si algún día falla, se vea aquí y no como una
   * línea rara en la pantalla de un operario.
   */
  alineado(ids: string[]): boolean {
    return ids.every((id) => (this.cols.get(id)?.length ?? -1) === this.t.length);
  }

  vaciar(): void {
    this.t = [];
    for (const id of Array.from(this.cols.keys())) this.cols.set(id, []);
  }
}

/**
 * Alimenta el búfer y avisa al llamador en cada muestra.
 *
 * El búfer vive en un `ref` y NO en el estado: mutarlo no provoca un render.
 * Quien dibuja es uPlot, al que se le pasan los datos a mano en `alActualizar`.
 * Si esto fuera estado, cada muestra sería un `setState` y a 100 ms serían
 * diez renders por segundo del widget entero para no cambiar ni un píxel de
 * React.
 */
export function useBufferTrend(
  variables: PlcVariable[],
  ids: string[],
  retencionSeg: number,
  alActualizar: (buffer: BufferTrend) => void,
  /**
   * En la Vista Previa: el búfer es de la SESIÓN, no del widget (ver
   * «GRABADORES DE SESIÓN» abajo). `clave` identifica al Trend. Sin esto
   * (Diseñador), el búfer vive y muere con el widget, como siempre.
   */
  sesion?: { clave: string }
): BufferTrend {
  const global = useBufferDeSesion(sesion?.clave ?? null, ids, retencionSeg, alActualizar);
  const local = useBufferLocal(sesion ? [] : variables, sesion ? [] : ids, retencionSeg, alActualizar);
  return global ?? local;
}

function useBufferLocal(
  variables: PlcVariable[],
  ids: string[],
  retencionSeg: number,
  alActualizar: (buffer: BufferTrend) => void
): BufferTrend {
  const buffer = useRef(new BufferTrend());
  const cb = useRef(alActualizar);
  cb.current = alActualizar;

  // Lo último que se sabe, para que el latido pueda repetirlo.
  const vigentes = useRef(new Map<string, number | null>());
  const ultimoPush = useRef(0);

  const clave = ids.join('|');

  useEffect(() => {
    buffer.current.sincronizar(ids);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clave]);

  // Se reasigna en cada render para que vea la `retencionSeg` vigente sin
  // tener que recrear el intervalo del latido.
  const muestrear = useRef<(v: Map<string, number | null>) => void>(() => {});
  muestrear.current = (valores: Map<string, number | null>) => {
    const ahora = Date.now();
    buffer.current.push(ahora / 1000, valores);
    buffer.current.podar(retencionSeg);
    ultimoPush.current = ahora;
    cb.current(buffer.current);
  };

  // ---- Llegaron valores nuevos ---------------------------------------- //
  useEffect(() => {
    if (!ids.length) return;

    const valores = new Map<string, number | null>();
    let alguno = false;
    for (const id of ids) {
      const v = variables.find((x) => x.id === id);
      // Sin valor (PLC sin conexión) cuenta como "no hay dato": Number(null)
      // es 0 y dibujaría una caída a cero que nunca ocurrió.
      if (!v || v.value === null || v.value === undefined) {
        valores.set(id, null);
        continue;
      }
      const num = typeof v.value === 'number' ? v.value : Number(v.value);
      valores.set(id, Number.isFinite(num) ? num : null);
      alguno = true;
    }
    if (!alguno) return;

    vigentes.current = valores;
    muestrear.current(valores);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [variables, clave, retencionSeg]);

  // ---- Latido: mantiene la traza avanzando, y corta si no hay datos ---- //
  useEffect(() => {
    if (!ids.length) return;
    const id = setInterval(() => {
      const ahora = Date.now();
      // Si acaba de entrar una muestra por el efecto de arriba, no se duplica.
      if (ahora - ultimoPush.current < LATIDO_MS * 0.9) return;

      // Serie a serie: la de un PLC caído se corta (hueco), las demás
      // siguen. Sin cambios en el PLC, el valor vigente SIGUE siendo el
      // valor: se repite para que la traza avance en el tiempo en vez de
      // congelarse. Una línea plana durante una caída del WebSocket o del
      // PLC diría que el proceso sigue reportando, y no es verdad.
      const fila = new Map<string, number | null>();
      for (const k of ids) {
        const plc = k.slice(0, k.indexOf('|'));
        fila.set(k, RealPLCService.plcDisponible(plc)
          ? (vigentes.current.get(k) ?? null)
          : null);
      }
      muestrear.current(fila);
    }, LATIDO_MS);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clave]);

  return buffer.current;
}


// =========================================================================
// GRABADORES DE SESIÓN (Vista Previa)
//
// El búfer de un Trend ya no vive DENTRO del widget en la Vista Previa: vive
// aquí, uno por Trend, mientras la ventana siga abierta. Por eso:
//
//   * Cambiar de sección o de pantalla (el widget se desmonta) NO borra lo
//     graficado, y el grabador SIGUE muestreando aunque no se esté viendo:
//     al volver no hay hueco.
//   * Cada 2 s se copia a IndexedDB con la llave de la sesión, así que al
//     RECARGAR (F5) se recupera. Cerrar la ventana empieza una sesión nueva
//     y lo viejo se borra (ver sesionTrend.ts).
//
// Los valores llegan directamente de `RealPLCService.subscribe`, que es lo
// mismo que alimenta `useAppStore().variables`: no hace falta React para
// seguir grabando.
// =========================================================================

const GUARDAR_CADA_MS = 2000;

interface Grabador {
  buffer: BufferTrend;
  ids: string[];
  retencion: number;
  vigentes: Map<string, number | null>;
  ultimoPush: number;
  oyentes: Set<(b: BufferTrend) => void>;
  sucio: boolean;
}

const grabadores = new Map<string, Grabador>();

function muestrearGrabador(g: Grabador, valores: Map<string, number | null>): void {
  const ahora = Date.now();
  g.buffer.push(ahora / 1000, valores);
  g.buffer.podar(g.retencion);
  g.ultimoPush = ahora;
  g.sucio = true;
  g.oyentes.forEach((f) => f(g.buffer));
}

/** Mete lo recuperado de IndexedDB DELANTE de lo que ya se haya grabado. */
function fundir(g: Grabador, r: { t: number[]; cols: Record<string, (number | null)[]> }): void {
  const b = g.buffer;
  const primero = b.t.length ? b.t[0] : Infinity;
  let n = 0;
  while (n < r.t.length && r.t[n] < primero) n++;
  if (n === 0) return;
  const tViejo = r.t.slice(0, n);
  const ids = new Set([...b.cols.keys(), ...Object.keys(r.cols)]);
  for (const id of ids) {
    const viejo = (r.cols[id] ?? []).slice(0, n);
    while (viejo.length < n) viejo.push(null);
    const actual = b.cols.get(id) ?? new Array(b.t.length).fill(null);
    b.cols.set(id, viejo.concat(actual));
  }
  b.t = tViejo.concat(b.t);
  b.podar(g.retencion);
}

/**
 * Graba los valores de `vars` para las variables del grabador. También se
 * llama al ASIGNARLE las variables: la foto inicial de `subscribe` llega
 * cuando todavía no sabe cuáles son, y una variable que no cambia (una
 * interna fija) no vuelve a emitir nunca — sin esto no se dibujaba.
 */
function tomarValores(g: Grabador, vars: PlcVariable[]): void {
  if (!g.ids.length) return;
  const valores = new Map<string, number | null>();
  let alguno = false;
  for (const id of g.ids) {
    const v = vars.find((x) => x.id === id);
    if (!v || v.value === null || v.value === undefined) {
      valores.set(id, null);
      continue;
    }
    const num = typeof v.value === 'number' ? v.value : Number(v.value);
    valores.set(id, Number.isFinite(num) ? num : null);
    alguno = true;
  }
  if (!alguno) return;
  g.vigentes = valores;
  muestrearGrabador(g, valores);
}

function crearGrabador(clave: string): Grabador {
  const g: Grabador = {
    buffer: new BufferTrend(),
    ids: [],
    retencion: 1800,
    vigentes: new Map(),
    ultimoPush: 0,
    oyentes: new Set(),
    sucio: false,
  };

  // Lo que se grabó antes de recargar.
  void leerBuffer(clave).then((r) => {
    if (!r) return;
    fundir(g, r);
    if (g.ids.length) g.buffer.sincronizar(g.ids);
    g.oyentes.forEach((f) => f(g.buffer));
  });

  // Valores nuevos: lo mismo que hacía el efecto de `useBufferLocal`.
  RealPLCService.subscribe((vars) => tomarValores(g, vars));

  // Latido: la traza avanza aunque el PLC no cambie (y corta si se cae).
  setInterval(() => {
    if (!g.ids.length) return;
    if (Date.now() - g.ultimoPush < LATIDO_MS * 0.9) return;
    const fila = new Map<string, number | null>();
    for (const k of g.ids) {
      const plc = k.slice(0, k.indexOf('|'));
      fila.set(k, RealPLCService.plcDisponible(plc) ? (g.vigentes.get(k) ?? null) : null);
    }
    muestrearGrabador(g, fila);
  }, LATIDO_MS);

  // Copia para sobrevivir a F5.
  const guardar = () => {
    if (!g.sucio || !g.buffer.t.length) return;
    g.sucio = false;
    const cols: Record<string, (number | null)[]> = {};
    for (const [id, col] of g.buffer.cols) cols[id] = col;
    void guardarBuffer(clave, { t: g.buffer.t, cols });
  };
  setInterval(guardar, GUARDAR_CADA_MS);
  try {
    window.addEventListener('pagehide', guardar);
  } catch {
    /* sin ventana (pruebas) */
  }
  return g;
}

function useBufferDeSesion(
  clave: string | null,
  ids: string[],
  retencionSeg: number,
  alActualizar: (buffer: BufferTrend) => void
): BufferTrend | null {
  const cb = useRef(alActualizar);
  cb.current = alActualizar;
  let g: Grabador | null = null;
  if (clave) {
    g = grabadores.get(clave) ?? null;
    if (!g) {
      g = crearGrabador(clave);
      grabadores.set(clave, g);
    }
    g.retencion = retencionSeg;
  }
  const idsClave = ids.join('|');

  useEffect(() => {
    if (!g) return;
    g.ids = ids;
    g.buffer.sincronizar(ids);
    // Lo que valen AHORA (las internas fijas no volverían a avisar).
    tomarValores(g, RealPLCService.getVariables());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clave, idsClave]);

  useEffect(() => {
    if (!g) return;
    const oyente = (b: BufferTrend) => cb.current(b);
    g.oyentes.add(oyente);
    // Lo que ya había (al volver a la sección o tras recargar): de una vez.
    if (g.buffer.t.length) cb.current(g.buffer);
    return () => {
      g!.oyentes.delete(oyente);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clave]);

  return g ? g.buffer : null;
}
