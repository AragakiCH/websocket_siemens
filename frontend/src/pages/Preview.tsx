// =========================================================================
// Preview.tsx  (ruta /preview)
// La pantalla tal y como la verá el operador: sin cuadrícula, sin
// herramientas de edición, con las medidas exactas del diseño y los valores
// del PLC en vivo.
//
// SE ABRE SIEMPRE POR LA PRIMERA PANTALLA, Y NO SE PUEDE CAMBIAR DESDE AQUÍ
// Antes había un selector arriba y la pantalla salía de `?pantalla=` o de la
// última que hubieras abierto en este navegador. Eso era razonable cuando
// cada pantalla era una isla; ya no lo es.
//
// Ahora el HMI tiene UN punto de entrada —la primera pantalla, la que el
// backend garantiza que existe— y desde su Menú Lateral se llega al resto:
// una sección puede apuntar a otra pantalla, que se dibuja dentro del Panel
// de Sección sin que el menú se mueva de sitio. Con eso, un selector de
// pantallas en la barra sería un segundo mando compitiendo con el menú, y
// además le daría al operador una navegación que su HMI no tiene.
//
// El operador no elige por dónde entra. Entra por donde arranca el HMI.
//
// LA BARRA DE ARRIBA ES DEL OPERADOR, NO DEL DISEÑADOR
// Por eso enseña lo que hace falta en planta y nada más: la marca, en qué
// pantalla y en qué sección estás, si el enlace con el backend está vivo, y
// la hora. Nada que se pueda tocar.
//
// DE DÓNDE SALEN LOS DATOS
//   * El diseño, del SERVIDOR (`/proyectos/<id>`), con la caché local como
//     respaldo si el backend no responde: es preferible enseñar el último
//     diseño conocido que una pantalla en blanco delante de un operario —
//     pero DICIÉNDOLO, que es lo que hace el aviso «copia local».
//   * Los valores, de `useAppStore().variables`: al montar este contexto el
//     RealPLCService abre su WebSocket y el snapshot llega solo.
// =========================================================================
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
} from 'react';
import { Loader2Icon, AlertTriangleIcon } from 'lucide-react';
import { useAppStore } from '../context/AppStore';
import { WidgetRenderer } from '../components/hmi/WidgetRenderer';
import { Logo } from '../components/ui/Logo';
import { RealPLCService } from '../services/RealPLCService';
import {
  useVistaActiva,
  useRutaDeVista,
  setPantalla,
  GRUPO_POR_DEFECTO,
  type Seccion,
} from '../components/hmi/custom/navegacion/store';

import {
  cargarProyecto,
  listarProyectos,
  loadDesign,
  PROYECTO_POR_DEFECTO,
  SavedDesign,
  ResumenPantalla,
} from '../utils/designStorage';

// ─── Reloj ───────────────────────────────────────────────────────

/**
 * Hora y fecha, refrescadas cada segundo.
 *
 * Se formatea a mano en vez de con `toLocaleTimeString`: el resultado de esa
 * depende del idioma del navegador, y en un panel de planta la hora tiene que
 * verse igual en el equipo del turno de día que en el del de noche, aunque
 * uno tenga Windows en inglés.
 */
function useReloj(): { hora: string; fecha: string } {
  const [ahora, setAhora] = useState(() => new Date());

  useEffect(() => {
    const id = setInterval(() => setAhora(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  return useMemo(() => {
    const dd = (n: number) => String(n).padStart(2, '0');
    return {
      hora: `${dd(ahora.getHours())}:${dd(ahora.getMinutes())}:${dd(ahora.getSeconds())}`,
      fecha: `${ahora.getDate()}/${ahora.getMonth() + 1}/${ahora.getFullYear()}`,
    };
  }, [ahora]);
}

// ─── Estado del enlace ───────────────────────────────────────────

/**
 * ¿Está vivo el WebSocket con el backend?
 *
 * Lo dice el propio `RealPLCService`, que es quien lo tiene abierto. NO se usa
 * `AppStore.connected`: ese solo indica si se dio de alta un PLC, y un cartel
 * de «EN VIVO» que no comprueba el enlace es peor que no tener cartel — dice
 * que hay datos justo cuando dejó de haberlos.
 */
function useEnVivo(): boolean {
  const [vivo, setVivo] = useState(() => RealPLCService.estaConectado());

  useEffect(() => {
    const alCambiar = (ev: Event) =>
      setVivo(!!(ev as CustomEvent).detail?.vivo);
    window.addEventListener('hmi:conexion', alCambiar as EventListener);
    // Por si el socket se abrió entre el primer render y este efecto.
    setVivo(RealPLCService.estaConectado());
    return () =>
      window.removeEventListener('hmi:conexion', alCambiar as EventListener);
  }, []);

  return vivo;
}

// ─── Piezas de la barra ──────────────────────────────────────────

function Separador() {
  return (
    <span
      aria-hidden="true"
      className="h-6 w-px shrink-0 bg-slate-300 dark:bg-navy-slate"
    />
  );
}

/**
 * Dónde está el operador: «GENERAL / DETALLES» arriba y el nombre de la
 * sección debajo.
 *
 * La ruta la da `useRutaDeVista()`, que resuelve los niveles del menú. Si la
 * pantalla no tiene navegación montada no se dibuja nada: un breadcrumb vacío
 * ocupa sitio para no decir nada.
 */
function Ruta({ ruta }: { ruta: Seccion[] }) {
  if (ruta.length === 0) return null;
  const actual = ruta[ruta.length - 1];

  return (
    <div className="flex min-w-0 flex-col justify-center leading-tight">
      <span className="flex min-w-0 items-center gap-1 font-mono text-[10px] uppercase tracking-wider">
        {ruta.map((s, i) => (
          <span key={`${s.id}-${i}`} className="flex min-w-0 items-center gap-1">
            {i > 0 && <span className="text-slate-300 dark:text-navy-slate">/</span>}
            <span
              className={`truncate ${
                i === ruta.length - 1
                  ? 'text-siemens'
                  : 'text-slate-400 dark:text-slate-500'
              }`}
            >
              {s.label || s.id}
            </span>
          </span>
        ))}
      </span>
      <span className="truncate text-[13px] font-bold text-navy dark:text-slate-100">
        {actual.label || actual.id}
      </span>
    </div>
  );
}

function PastillaEnVivo({ vivo }: { vivo: boolean }) {
  return (
    <span
      title={
        vivo
          ? 'Enlace con el servidor abierto: los valores llegan en tiempo real.'
          : 'Sin enlace con el servidor. Los valores que se ven son los últimos que llegaron.'
      }
      className={`flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 font-mono text-[10px] font-semibold uppercase tracking-wider transition ${
        vivo
          ? 'border-state-ok/40 bg-state-ok/10 text-state-ok'
          : 'border-state-error/40 bg-state-error/10 text-state-error'
      }`}
    >
      <span
        aria-hidden="true"
        className={`h-1.5 w-1.5 rounded-full ${
          vivo ? 'animate-pulse bg-state-ok' : 'bg-state-error'
        }`}
      />
      {vivo ? 'En vivo' : 'Sin señal'}
    </span>
  );
}

function Reloj() {
  const { hora, fecha } = useReloj();
  return (
    <div className="flex shrink-0 flex-col items-end leading-tight">
      <span className="font-mono text-[15px] font-bold tabular-nums text-navy dark:text-slate-100">
        {hora}
      </span>
      <span className="font-mono text-[10px] tabular-nums text-slate-400">
        {fecha}
      </span>
    </div>
  );
}

// ─── La vista ────────────────────────────────────────────────────

export function Preview() {
  const { variables, isDark } = useAppStore();

  // Vista abierta en la navegación. Al pulsar un botón del Menú Lateral
  // cambia, y este componente se vuelve a dibujar mostrando solo los widgets
  // de esa sección.
  const vistaActiva = useVistaActiva(GRUPO_POR_DEFECTO);
  const ruta = useRutaDeVista(GRUPO_POR_DEFECTO);
  const enVivo = useEnVivo();

  // ── Qué pantalla se abre ────────────────────────────────────────
  //
  // Se arranca en `principal` sin esperar a nadie, porque el backend la
  // garantiza siempre (`ProjectStore` la crea y `DELETE /proyectos/principal`
  // está prohibido) y su ordenación la pone SIEMPRE primera. Así el lienzo se
  // pinta desde la caché en el primer render, sin un salto en blanco.
  //
  // Cuando llega la lista se reconcilia con `pantallas[0]`, que es la
  // definición literal de «la primera». Hoy las dos coinciden; si mañana
  // cambia la ordenación del servidor, esto sigue siendo correcto y aquello
  // solo habrá sido una suposición de arranque.
  const [pantallaId, setPantallaId] = useState<string>(PROYECTO_POR_DEFECTO);
  const [pantallas, setPantallas] = useState<ResumenPantalla[]>([]);
  const [design, setDesign] = useState<SavedDesign | null>(() =>
    loadDesign(PROYECTO_POR_DEFECTO)
  );
  const [cargando, setCargando] = useState(true);

  // `true` mientras lo pintado venga de la caché del navegador y no del
  // servidor. Empieza en true porque el primer render ES la caché: hasta que
  // el servidor conteste, no se puede afirmar que esté en vivo.
  const [desfasado, setDesfasado] = useState(true);

  // Sesión caducada o ausente. Antes esto acababa mostrando en silencio un
  // diseño viejo de la caché; ahora se dice, porque son cosas distintas.
  const [sinSesion, setSinSesion] = useState(false);

  // ── Navegación por pantalla ─────────────────────────────────────
  // La navegación se guarda por pantalla: sin esto, dos pantallas
  // compartirían una sola y la segunda heredaría la sección abierta en la
  // primera. En `useLayoutEffect` para que ese estado intermedio no se pinte.
  useLayoutEffect(() => {
    setPantalla(pantallaId);
  }, [pantallaId]);

  // ── Catálogo de pantallas ───────────────────────────────────────
  //
  // Ya no alimenta ningún selector: sirve para saber CUÁL es la primera y
  // para poder decir su nombre en la barra en vez de su id.
  useEffect(() => {
    let vivo = true;
    void (async () => {
      try {
        const lista = await listarProyectos();
        if (!vivo) return;
        setPantallas(lista);
        const primera = lista[0]?.project_id;
        // Con la forma funcional: este efecto corre una sola vez y leer
        // `pantallaId` de su closure daría siempre el valor inicial.
        if (primera) setPantallaId((prev) => (prev === primera ? prev : primera));
      } catch {
        // Sin lista se sigue con `principal`, que es la apuesta correcta.
      }
    })();
    return () => {
      vivo = false;
    };
  }, []);

  // ── Carga del diseño ────────────────────────────────────────────
  //
  // Distingue los TRES finales posibles, que es de donde salen los avisos:
  // un `null` (la pantalla ya no existe en el servidor) no puede dejar
  // pintado lo anterior, y una excepción no puede reventar sin dejar rastro.
  const cargar = useCallback(async (id: string) => {
    setCargando(true);
    try {
      const p = await cargarProyecto(id);
      setSinSesion(false);
      if (p) {
        setDesign({ widgets: p.widgets, canvas: p.canvas });
        setDesfasado(p.desdeCache === true);
      } else {
        // null = la pantalla ya no existe en el servidor. Antes se quedaba
        // lo que hubiera pintado, que es como enseñar algo ya borrado.
        setDesign(null);
        setDesfasado(false);
      }
    } catch (e) {
      const status = (e as { status?: number })?.status;
      if (status === 401 || status === 403) {
        // Es el caso que producía los "widgets fantasma": el servidor está
        // bien y pide sesión. NO se pinta la caché — sería el diseño de otra
        // sesión, y no habría forma de saberlo mirando la pantalla.
        setSinSesion(true);
        setDesign(null);
      } else {
        setDesfasado(true);
      }
    } finally {
      setCargando(false);
    }
  }, []);

  useEffect(() => {
    // Se pinta la caché al instante y se reconcilia con el servidor: no debe
    // quedar un hueco en blanco mientras llega el fetch.
    setDesign(loadDesign(pantallaId));
    void cargar(pantallaId);
  }, [pantallaId, cargar]);

  // ── Cambios de otros, en vivo ───────────────────────────────────
  //
  // Llegan por el WebSocket que ya tiene abierto el RealPLCService, reemitidos
  // como evento del navegador. Es lo que hace que mover un widget en el
  // Diseñador se vea aquí sin recargar, incluso desde otro equipo.
  useEffect(() => {
    const alEvento = (ev: Event) => {
      const msg = (ev as CustomEvent).detail;
      if (msg?.type !== 'project.updated' || msg.project_id !== pantallaId) return;
      void cargar(pantallaId);
    };
    window.addEventListener('hmi:ws', alEvento as EventListener);
    return () => window.removeEventListener('hmi:ws', alEvento as EventListener);
  }, [pantallaId, cargar]);

  // Respaldo para el caso local: dos pestañas del MISMO navegador, con el
  // backend caído. El evento `storage` solo se dispara en las otras pestañas.
  //
  // Ojo con la clave: el Diseñador escribe en `hmi.design.<pantalla>`, no en
  // `hmi.design`. Comparar contra la clave sin sufijo significaría que este
  // efecto no se dispara nunca.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (!e.key || !e.key.startsWith('hmi.design')) return;
      if (e.key.endsWith(`.${pantallaId}`) || e.key === 'hmi.design') {
        setDesign(loadDesign(pantallaId));
      }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [pantallaId]);

  const nombreActual =
    pantallas.find((p) => p.project_id === pantallaId)?.nombre ?? pantallaId;

  return (
    <div className="flex h-full w-full flex-col bg-slate-200 dark:bg-navy">

      {/* ── Barra de operación ────────────────────────────────────
          Sin un solo control: es informativa de principio a fin. Lo único
          que se puede tocar en esta vista es el HMI. */}
      <header className="flex shrink-0 items-center gap-3 border-b border-slate-300 bg-white px-4 py-2 dark:border-navy-slate dark:bg-navy-soft">
        <Logo variante="barra" />

        <Separador />

        {/* En qué pantalla. Es un dato, no un selector. */}
        <span className="shrink-0 truncate text-xs font-semibold text-slate-500 dark:text-slate-400">
          {nombreActual}
        </span>

        {ruta.length > 0 && <Separador />}
        <Ruta ruta={ruta} />

        <div className="ml-auto flex shrink-0 items-center gap-3">
          {/* Lo que se ve NO viene del servidor. Decirlo no es un adorno: sin
              este aviso, una pantalla en caché es indistinguible de una en
              vivo, y alguien puede decidir algo mirando un diseño que ya no
              existe. */}
          {desfasado && !sinSesion && (
            <span
              className="flex items-center gap-1.5 rounded-md bg-amber-500/15 px-2 py-1 text-[11px] font-semibold text-amber-600 dark:text-amber-400"
              title="No se pudo contactar con el servidor. Se muestra la última copia guardada en este navegador, que puede estar desfasada."
            >
              <AlertTriangleIcon className="h-3.5 w-3.5" />
              Copia local
            </span>
          )}

          {cargando && (
            <Loader2Icon className="h-3.5 w-3.5 animate-spin text-slate-400" />
          )}

          <PastillaEnVivo vivo={enVivo} />
          <Reloj />
        </div>
      </header>

      {/* ── El lienzo ─────────────────────────────────────────────── */}
      <div className="mp-scroll mp-scroll-dark flex min-h-0 flex-1 items-center justify-center overflow-auto p-6">
        {sinSesion ? (
          <div className="max-w-md text-center text-sm text-slate-500 dark:text-slate-400">
            <p className="font-semibold text-slate-700 dark:text-slate-200">
              Esta pestaña no tiene sesión iniciada
            </p>
            <p className="mt-2 text-xs leading-relaxed">
              La sesión vive en el navegador que la abrió. Si estabas usando
              la aplicación de escritorio y has copiado esta dirección a otro
              navegador, aquí eres otra persona distinta para el servidor.
            </p>
            <p className="mt-2 text-xs leading-relaxed">
              Entra desde este mismo navegador y vuelve a abrir la vista.
            </p>
            <a
              href="/"
              className="mt-4 inline-block rounded-lg bg-siemens px-4 py-2 text-xs font-semibold text-white transition hover:opacity-90"
            >
              Ir al inicio de sesión
            </a>
          </div>
        ) : !design || design.widgets.length === 0 ? (
          <div className="max-w-sm text-center text-sm text-slate-500 dark:text-slate-400">
            {cargando ? (
              <span className="flex items-center justify-center gap-2">
                <Loader2Icon className="h-4 w-4 animate-spin" />
                Cargando «{nombreActual}»…
              </span>
            ) : (
              <>
                <p className="font-semibold">«{nombreActual}» está vacía</p>
                <p className="mt-1 text-xs leading-relaxed">
                  Es la pantalla por la que arranca el HMI. Arrastra widgets
                  sobre su lienzo en el Diseñador y vuelve aquí.
                </p>
              </>
            )}
          </div>
        ) : (
          <div
            // SIN `rounded-*`, igual que en el Diseñador: esto es la pantalla
            // del panel. Redondearla aquí y no allí, además, haría que el
            // operador viera algo distinto de lo que se diseñó.
            //
            // El fondo elegido en el Diseñador manda; si no hay ninguno se cae
            // en el color del tema.
            className={`relative shrink-0 overflow-hidden shadow-xl ${
              design.canvas.fondo ? '' : isDark ? 'bg-navy-soft' : 'bg-white'
            }`}
            style={{
              width: design.canvas.width,
              height: design.canvas.height,
              background: design.canvas.fondo || undefined
            }}
          >
            {design.widgets
              .filter((w) => w.visible !== false)
              // Navegación: aquí SÍ se ocultan los de otras vistas. Es lo que
              // ve el operador, y ver a la vez el contenido de las tres
              // secciones amontonado no tendría ningún sentido.
              //
              // `vistaActiva` no se usa dentro, pero tenerlo como dependencia
              // es lo que hace que este bloque se vuelva a dibujar cuando se
              // pulsa un botón del menú.
              .filter((w) => {
                const v = (w.vista ?? '').trim();
                if (!v) return true;          // "En todas"
                if (!vistaActiva) return true; // aún sin navegación montada
                return v === vistaActiva;
              })
              .map((w) => (
                <div
                  key={w.id}
                  style={{
                    position: 'absolute',
                    left: w.x,
                    top: w.y,
                    width: w.width,
                    height: w.height,
                  }}
                >
                  <WidgetRenderer
                    widget={w}
                    variable={
                      w.variableId
                        ? variables.find((v) => v.id === w.variableId)
                        : undefined
                    }
                    // Aquí el widget se OPERA: el trend escucha el arrastre
                    // para moverse en el tiempo. En el Diseñador no, porque
                    // allí el arrastre sirve para colocarlo.
                    interactivo
                  />
                </div>
              ))}
          </div>
        )}
      </div>
    </div>
  );
}
