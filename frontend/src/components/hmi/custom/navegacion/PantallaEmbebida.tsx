// =========================================================================
// custom/navegacion/PantallaEmbebida.tsx
// Dibuja OTRA pantalla del proyecto dentro del marco del Panel de Sección.
//
// QUÉ PROBLEMA RESUELVE
// Cada pestaña de arriba del Diseñador es un proyecto distinto del servidor,
// con sus propios widgets. Navegar entre ellas sustituye la lista ENTERA de
// widgets — incluido el propio menú, que es un widget más. O sea que un menú
// que llevara a otra pantalla se iría con ella y dejaría al operador dentro,
// sin forma de volver.
//
// Aquí no se navega a ninguna parte: se sigue estando en la misma pantalla y
// lo único que cambia es lo que hay DENTRO del panel. Por eso el menú no
// desaparece — nunca se sale del proyecto que lo contiene.
//
// POR QUÉ ESTE MÓDULO ESTÁ SEPARADO DEL WIDGET
// Por un ciclo de imports. Para dibujar widgets hace falta `WidgetRenderer`,
// y `WidgetRenderer` importa `custom/registry`, que a su vez importa
// `PantallaScreen`:
//
//     registry → PantallaScreen → WidgetRenderer → registry
//
// `PantallaScreen` carga este módulo con `React.lazy()`, y un import dinámico
// NO forma parte del grafo estático: el ciclo no llega a existir. De regalo,
// todo esto (con `designStorage` detrás) solo se descarga cuando alguien usa
// de verdad una sección con pantalla asignada.
//
// LO QUE NO SE DIBUJA AQUÍ DENTRO: LOS WIDGETS DE NAVEGACIÓN
// Una sola regla que resuelve dos problemas a la vez:
//
//   1. MENÚ DENTRO DE MENÚ. `store.ts` guarda la vista activa bajo la llave
//      `pantalla + grupo`, y `pantallaActual` es una variable global del
//      módulo. Un Menú Lateral dibujado aquí publicaría sus secciones sobre
//      la llave de la pantalla de AFUERA y machacaría el menú principal.
//   2. RECURSIÓN. Si una sección apuntara a la pantalla que contiene este
//      mismo panel, se dibujaría un panel dentro de otro sin fin y colgaría
//      la pestaña. Como el Panel de Sección también es un widget de
//      navegación, la misma regla lo corta en seco.
//
// Consecuencia práctica: una pantalla pensada para empotrarse enseña TODOS
// sus widgets de contenido. No le pongas su propio menú interno — no va a
// funcionar, y ahora ya sabes por qué.
// =========================================================================
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Loader2Icon, MonitorXIcon, AlertTriangleIcon } from 'lucide-react';
import type { HmiWidget } from '../../../../models/widget';
import { useAppStore } from '../../../../context/AppStore';
import { cargarProyecto, type SavedDesign } from '../../../../utils/designStorage';
import { WidgetRenderer } from '../../WidgetRenderer';
import { esWidgetDeNavegacion } from './store';

/** Cómo encaja el lienzo de la pantalla dentro del marco del panel. */
export type ModoAjuste = 'ajustar' | 'estirar' | 'real';

// ─── Caché de pantallas empotradas ───────────────────────────────
//
// PARA QUÉ SIRVE (y para qué NO)
// Sirve para PINTAR AL INSTANTE al montar, no para ahorrarse la petición: el
// servidor se pregunta siempre. Su trabajo es que cambiar de sección enseñe
// el contenido de inmediato en vez de un spinner, mientras la respuesta de
// verdad viene en camino. La explicación de por qué se revalida siempre está
// en el efecto de `usePantallaEmpotrada()`.
//
// Vive en el MÓDULO y no en el componente porque el panel se desmonta cada
// vez que se cambia de sección o de pantalla: dentro del componente moriría
// con él y no habría nada que pintar al volver, que es justo cuando hace
// falta.
//
// `enVuelo` cubre el otro caso: dos paneles (o el Diseñador y una Vista
// Previa en la misma pestaña) pidiendo la misma pantalla a la vez. Sin él
// serían dos peticiones idénticas por cada clic.

const cache = new Map<string, SavedDesign>();
const enVuelo = new Map<string, Promise<SavedDesign | null>>();

async function traer(projectId: string): Promise<SavedDesign | null> {
  let pendiente = enVuelo.get(projectId);
  if (!pendiente) {
    pendiente = cargarProyecto(projectId)
      .then((doc) => {
        if (!doc) {
          // 404: la pantalla se borró. Se quita de la caché para que no
          // reaparezca como un fantasma en el siguiente montaje.
          cache.delete(projectId);
          return null;
        }
        const design: SavedDesign = { widgets: doc.widgets, canvas: doc.canvas };
        cache.set(projectId, design);
        return design;
      })
      .finally(() => enVuelo.delete(projectId));
    enVuelo.set(projectId, pendiente);
  }
  return pendiente;
}

// ─── Carga ───────────────────────────────────────────────────────

interface EstadoCarga {
  design: SavedDesign | null;
  cargando: boolean;
  /** `''` = bien. `'no_existe'` = 404. Cualquier otra cosa = texto del fallo. */
  error: string;
}

function usePantallaEmpotrada(projectId: string): EstadoCarga {
  const [estado, setEstado] = useState<EstadoCarga>(() => ({
    design: projectId ? cache.get(projectId) ?? null : null,
    cargando: !!projectId && !cache.has(projectId),
    error: '',
  }));

  const pedir = useCallback(
    (id: string, vivo: () => boolean) => {
      traer(id)
        .then((d) => {
          if (!vivo()) return;
          // `null` es un 404: esa pantalla ya no existe. Es definitivo, así
          // que se tira lo que hubiera pintado — seguir enseñando el diseño
          // de una pantalla borrada sería mentir.
          setEstado({ design: d, cargando: false, error: d ? '' : 'no_existe' });
        })
        .catch((e: unknown) => {
          if (!vivo()) return;
          // AQUÍ NO SE TIRA LO QUE YA SE ESTABA VIENDO.
          //
          // Un fallo de red o un 5xx es transitorio, y esto se mira en un
          // panel de planta: cambiar una pantalla que funciona por un cartel
          // de error porque el servidor parpadeó medio segundo es peor que
          // enseñar un dato de hace un minuto. Solo se muestra el error
          // cuando no hay NADA que enseñar.
          //
          // (De los 401/403 no hay que preocuparse aquí: `cargarProyecto` los
          // propaga a propósito y `fetchAuth` ya emite `hmi:sesion-caducada`
          // para llevar al login.)
          const msg =
            (e as { message?: string })?.message ??
            'No se pudo cargar esa pantalla.';
          setEstado((prev) =>
            prev.design
              ? { ...prev, cargando: false }
              : { design: null, cargando: false, error: msg }
          );
        });
    },
    []
  );

  useEffect(() => {
    if (!projectId) {
      setEstado({ design: null, cargando: false, error: '' });
      return;
    }
    let vivo = true;

    // ── LO DE LA CACHÉ SE PINTA, PERO SIEMPRE SE VUELVE A PEDIR ──────────
    //
    // Las dos mitades importan, y la segunda es la que arregla un fallo real:
    //
    //   * se pinta lo cacheado AL INSTANTE, para que cambiar de sección no
    //     deje un hueco en blanco parpadeando;
    //   * y se revalida SIEMPRE, aunque hubiera caché.
    //
    // Sin lo segundo pasaba esto, que es justo lo que uno hace mientras
    // diseña: abres «principal», el panel empotra «Pantalla 2» y la cachea →
    // te vas a la pestaña de «Pantalla 2» y la editas (el panel se desmonta,
    // así que su listener de `project.updated` ya no está para enterarse) →
    // vuelves a «principal» y el panel te enseña la versión vieja. Y no se
    // arreglaba ni recargando, porque la caché vive en el módulo.
    //
    // Revalidar siempre cuesta un GET por acción del usuario, y `enVuelo`
    // impide que dos paneles pidiendo lo mismo hagan dos peticiones.
    const enCache = cache.get(projectId) ?? null;
    setEstado({ design: enCache, cargando: !enCache, error: '' });
    pedir(projectId, () => vivo);

    return () => {
      vivo = false;
    };
  }, [projectId, pedir]);

  // Alguien editó esa pantalla en otro equipo (o en otra pestaña). El evento
  // ya llega: `project.updated` sí está en la lista que reemite
  // `RealPLCService`. Se refresca sin recargar nada.
  useEffect(() => {
    if (!projectId) return;
    let vivo = true;
    const alEvento = (ev: Event) => {
      const msg = (ev as CustomEvent).detail;
      if (msg?.type !== 'project.updated') return;
      if (msg.project_id !== projectId) return;
      pedir(projectId, () => vivo);
    };
    window.addEventListener('hmi:ws', alEvento as EventListener);
    return () => {
      vivo = false;
      window.removeEventListener('hmi:ws', alEvento as EventListener);
    };
  }, [projectId, pedir]);

  return estado;
}

// ─── Medida real del hueco ───────────────────────────────────────
//
// Se MIDE en vez de calcularse a partir de `widget.width/height`. El marco
// tiene borde, y la cabecera ocupa una franja que se puede apagar desde el
// Inspector: restarlo a mano sería una constante que se descuadra en cuanto
// alguien toque el estilo de la caja.

function useTamano<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [tam, setTam] = useState({ ancho: 0, alto: 0 });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const medir = () =>
      setTam({ ancho: el.clientWidth, alto: el.clientHeight });
    medir();
    // El panel cambia de tamaño al estirarlo en el lienzo, no solo al
    // cambiar la ventana. `ResizeObserver` cubre los dos casos.
    const ro = new ResizeObserver(medir);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return [ref, tam] as const;
}

// ─── Avisos ──────────────────────────────────────────────────────

function Aviso({
  icono,
  titulo,
  detalle,
}: {
  icono: React.ReactNode;
  titulo: string;
  detalle?: string;
}) {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-1.5 p-4 text-center">
      <span className="text-slate-400">{icono}</span>
      <p className="text-xs font-semibold text-slate-500 dark:text-slate-400">
        {titulo}
      </p>
      {!!detalle && (
        <p className="max-w-[26ch] text-[11px] leading-snug text-slate-400">
          {detalle}
        </p>
      )}
    </div>
  );
}

// ─── El componente ───────────────────────────────────────────────

interface Props {
  /** `project_id` de la pantalla a dibujar. */
  projectId: string;
  /** Cómo encaja su lienzo en el marco. */
  modo: ModoAjuste;
  /** true en la Vista Previa: los widgets se operan. */
  interactivo: boolean;
}

export default function PantallaEmbebida({
  projectId,
  modo,
  interactivo,
}: Props) {
  const { variables } = useAppStore();
  const { design, cargando, error } = usePantallaEmpotrada(projectId);
  const [ref, { ancho, alto }] = useTamano<HTMLDivElement>();

  /**
   * Lo que se dibuja: contenido sí, navegación no.
   *
   * Ver la nota larga de la cabecera — esta línea es la que corta el menú
   * anidado y la recursión de una pantalla dentro de sí misma.
   */
  const aDibujar = useMemo<HmiWidget[]>(
    () =>
      (design?.widgets ?? []).filter(
        (w) => w.visible !== false && !esWidgetDeNavegacion(w.kind)
      ),
    [design]
  );

  const cw = design?.canvas?.width ?? 0;
  const ch = design?.canvas?.height ?? 0;

  /**
   * Escala y desplazamiento.
   *
   * Con `transformOrigin: 'top left'` el escalado no mueve nada de sitio, así
   * que centrar es sumar el margen sobrante partido por dos. Con el origen
   * por defecto (`center`) habría que compensar además el desplazamiento que
   * introduce el propio `transform`, y las cuentas dejan de ser evidentes.
   */
  const { sx, sy, offX, offY } = useMemo(() => {
    const medible = cw > 0 && ch > 0 && ancho > 0 && alto > 0;
    if (!medible || modo === 'real') {
      return { sx: 1, sy: 1, offX: 0, offY: 0 };
    }
    if (modo === 'estirar') {
      return { sx: ancho / cw, sy: alto / ch, offX: 0, offY: 0 };
    }
    // Ajustar: una sola escala para los dos ejes, así no se deforma nada.
    const e = Math.min(ancho / cw, alto / ch);
    return {
      sx: e,
      sy: e,
      offX: Math.max(0, (ancho - cw * e) / 2),
      offY: Math.max(0, (alto - ch * e) / 2),
    };
  }, [cw, ch, ancho, alto, modo]);

  // ── Estados que no son "hay algo que dibujar" ──────────────────
  let contenido: React.ReactNode = null;

  if (!projectId) {
    contenido = null; // sin pantalla asignada: el marco se queda vacío
  } else if (error === 'no_existe') {
    contenido = (
      <Aviso
        icono={<MonitorXIcon className="h-5 w-5" />}
        titulo={`«${projectId}» ya no existe`}
        detalle="Alguien borró esa pantalla. Elige otra en el menú, en Propiedades."
      />
    );
  } else if (error) {
    contenido = (
      <Aviso
        icono={<AlertTriangleIcon className="h-5 w-5" />}
        titulo="No se pudo cargar la pantalla"
        detalle={error}
      />
    );
  } else if (cargando && !design) {
    contenido = (
      <Aviso
        icono={<Loader2Icon className="h-5 w-5 animate-spin" />}
        titulo={`Cargando «${projectId}»…`}
      />
    );
  } else if (design && aDibujar.length === 0) {
    contenido = (
      <Aviso
        icono={<MonitorXIcon className="h-5 w-5" />}
        titulo={`«${projectId}» está vacía`}
        detalle="Arrastra widgets sobre su lienzo desde su pestaña del Diseñador."
      />
    );
  }

  return (
    <div
      ref={ref}
      style={{
        position: 'relative',
        width: '100%',
        height: '100%',
        // En «tamaño real» el lienzo puede pasarse de largo y hay que poder
        // llegar a lo de abajo. En los otros dos modos cabe por definición.
        overflow: modo === 'real' ? 'auto' : 'hidden',
      }}
    >
      {contenido ?? (
        <div
          style={{
            position: 'absolute',
            left: offX,
            top: offY,
            width: cw || '100%',
            height: ch || '100%',
            transform: `scale(${sx}, ${sy})`,
            transformOrigin: 'top left',
          }}
        >
          {aDibujar.map((w) => (
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
                interactivo={interactivo}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
