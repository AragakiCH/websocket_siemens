// =========================================================================
// Preview.tsx  (ruta /preview)
// La pantalla tal y como la verá el operador: sin cuadrícula, sin
// herramientas de edición, con las medidas exactas del diseño y los valores
// del PLC en vivo. Pensada para abrirse en una pestaña nueva.
//
// MULTIPANTALLA
// El HMI tiene varias pantallas (una por proyecto del backend). Cuál se ve
// sale, en este orden:
//
//   1. `?pantalla=<id>` en la URL — lo pone el botón "Vista previa" del
//      Diseñador, para que se abra la que estabas editando y no otra.
//   2. la última pantalla abierta en este navegador.
//
// El selector de arriba permite saltar entre ellas sin volver al Diseñador,
// que es lo que hace falta para revisar un HMI de seis pantallas.
//
// DE DÓNDE SALEN LOS DATOS
//   * El diseño, del SERVIDOR (`/proyectos/<id>`), con la caché local como
//     respaldo si el backend no responde: es preferible enseñar el último
//     diseño conocido que una pantalla en blanco delante de un operario.
//   * Los valores, de `useAppStore().variables`: al montar este contexto el
//     RealPLCService abre su WebSocket y el snapshot llega solo.
// =========================================================================
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  MonitorIcon,
  ChevronDownIcon,
  Loader2Icon,
  AlertTriangleIcon,
} from 'lucide-react';
import { useAppStore } from '../context/AppStore';
import { WidgetRenderer } from '../components/hmi/WidgetRenderer';
import { useVistaActiva, GRUPO_POR_DEFECTO } from '../components/hmi/custom/navegacion/store';

import {
  cargarProyecto,
  listarProyectos,
  loadDesign,
  getUltimaPantalla,
  SavedDesign,
  ResumenPantalla,
} from '../utils/designStorage';

/** Pantalla pedida en la URL, si la hay. */
function pantallaDeLaUrl(): string {
  try {
    return new URLSearchParams(window.location.search).get('pantalla') ?? '';
  } catch {
    return '';
  }
}

export function Preview() {
  const { variables, isDark } = useAppStore();

  // Vista abierta en la navegación. Al pulsar un botón del Menú Lateral
  // cambia, y este componente se vuelve a dibujar mostrando solo los widgets
  // de esa sección.
  const vistaActiva = useVistaActiva(GRUPO_POR_DEFECTO);

  const inicial = useMemo(() => pantallaDeLaUrl() || getUltimaPantalla(), []);
  const [pantallaId, setPantallaId] = useState<string>(inicial);
  const [pantallas, setPantallas] = useState<ResumenPantalla[]>([]);
  const [design, setDesign] = useState<SavedDesign | null>(() =>
    loadDesign(inicial)
  );
  const [cargando, setCargando] = useState(true);

  // `true` mientras lo pintado venga de la caché del navegador y no del
  // servidor. Empieza en true porque el primer render ES la caché: hasta que
  // el servidor conteste, no se puede afirmar que esté en vivo.
  const [desfasado, setDesfasado] = useState(true);

  // Sesión caducada o ausente. Antes esto acababa mostrando en silencio un
  // diseño viejo de la caché; ahora se dice, porque son cosas distintas.
  const [sinSesion, setSinSesion] = useState(false);

  // ── Catálogo de pantallas para el selector ──────────────────────
  useEffect(() => {
    let vivo = true;
    void (async () => {
      try {
        const lista = await listarProyectos();
        if (vivo) setPantallas(lista);
      } catch {
        // Sin lista no hay selector, pero la pantalla pedida sigue viéndose.
      }
    })();
    return () => {
      vivo = false;
    };
  }, []);

  // ── Carga del diseño ────────────────────────────────────────────
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
    // Se pinta la caché al instante y se reconcilia con el servidor: cambiar
    // de pantalla en el selector no debe dejar un hueco en blanco.
    setDesign(loadDesign(pantallaId));
    void cargar(pantallaId);
    // La URL sigue a la selección, para que recargar o compartir el enlace
    // devuelva la misma pantalla.
    try {
      const url = new URL(window.location.href);
      url.searchParams.set('pantalla', pantallaId);
      window.history.replaceState(null, '', url.toString());
    } catch {
      /* history bloqueado: no es crítico */
    }
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
  // `hmi.design`. Comparar contra la clave sin sufijo (como se hacía antes)
  // significaba que este efecto no se disparaba nunca.
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
  const hayVarias = pantallas.length > 1;

  return (
    <div className="flex h-full w-full flex-col bg-slate-200 dark:bg-navy">

      {/* ── Selector de pantalla ──────────────────────────────────
          Solo aparece si hay más de una: con una sola sería una barra que
          ocupa sitio para ofrecer una única opción. */}
      {hayVarias && (
        <div className="flex shrink-0 items-center gap-2.5 border-b border-slate-300 bg-white px-4 py-2 dark:border-navy-slate dark:bg-navy-soft">
          <MonitorIcon className="h-4 w-4 shrink-0 text-siemens" />
          <div className="relative">
            <select
              value={pantallaId}
              onChange={(e) => setPantallaId(e.target.value)}
              aria-label="Pantalla que se está viendo"
              className="cursor-pointer appearance-none rounded-lg border border-slate-200 bg-white py-1.5 pl-3 pr-8 text-xs font-semibold text-navy outline-none transition focus:border-siemens focus:ring-2 focus:ring-siemens/20 dark:border-navy-slate dark:bg-navy dark:text-slate-100"
            >
              {pantallas.map((p) => (
                <option key={p.project_id} value={p.project_id}>
                  {p.nombre}
                </option>
              ))}
            </select>
            <ChevronDownIcon
              aria-hidden="true"
              className="pointer-events-none absolute right-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400"
            />
          </div>

          <span className="text-[11px] text-slate-400">
            {design ? `${design.widgets.length} widgets` : ''}
          </span>

          {cargando && (
            <Loader2Icon className="h-3.5 w-3.5 animate-spin text-slate-400" />
          )}

          {/* Lo que se ve NO viene del servidor. Decirlo no es un adorno:
              sin este aviso, una pantalla en caché es indistinguible de una
              en vivo, y alguien puede tomar una decisión mirando un diseño
              que ya no existe. */}
          {desfasado ? (
            <span
              className="ml-auto flex items-center gap-1.5 rounded-md bg-amber-500/15 px-2 py-1 text-[11px] font-semibold text-amber-600 dark:text-amber-400"
              title="No se pudo contactar con el servidor. Se muestra la última
                     copia guardada en este navegador, que puede estar desfasada."
            >
              <AlertTriangleIcon className="h-3.5 w-3.5" />
              Sin conexión · copia local
            </span>
          ) : (
            <span className="ml-auto text-[11px] text-slate-400">
              Vista de operación · datos en vivo
            </span>
          )}
        </div>
      )}

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
                  Arrastra widgets sobre su lienzo en el Diseñador y vuelve
                  aquí{hayVarias ? ', o elige otra pantalla arriba' : ''}.
                </p>
              </>
            )}
          </div>
        ) : (
          <div
            className={`relative shrink-0 overflow-hidden rounded-lg shadow-xl ${
              isDark ? 'bg-navy-soft' : 'bg-white'
            }`}
            style={{ width: design.canvas.width, height: design.canvas.height }}
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
                  />
                </div>
              ))}
          </div>
        )}
      </div>
    </div>
  );
}
