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
import {
  aplicarCambio,
  versionEncaja,
  type MensajeProjectUpdated,
} from '../../../../utils/aplicarCambio';
import { WidgetRenderer } from '../../WidgetRenderer';
import { ContextoEmbebido, esWidgetDeNavegacion } from './store';
import { ContextoMapaTags } from '../faceplate/contexto';

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
// Versión de lo que hay en `cache`, por pantalla. Es lo que permite aplicar
// un `project.updated` encima sin volver a pedir la pantalla: solo si el
// evento es justo la versión siguiente. 0 o ausente = desconocida.
const versiones = new Map<string, number>();

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
        versiones.set(projectId, doc.desdeCache ? 0 : doc.version);
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

  // ── Lo que le pase a ESA pantalla, en vivo ────────────────────────────
  //
  // Los dos eventos llegan de verdad: `project.updated` y `project.removed`
  // están los dos en la lista que reemite `RealPLCService` (no como
  // `lock.changed` y los `alarma.*`, que se caen ahí).
  //
  // EL BORRADO HACE FALTA ESCUCHARLO, no basta con el 404 al recargar. El
  // panel puede llevar horas abierto en la vista de un operador: sin esto,
  // alguien borra la pantalla desde el Diseñador y el operador sigue viendo
  // un HMI que ya no existe, con valores que nadie va a volver a tocar,
  // hasta que a alguien se le ocurra recargar. Eso en planta no vale.
  useEffect(() => {
    if (!projectId) return;
    let vivo = true;

    const alEvento = (ev: Event) => {
      const msg = (ev as CustomEvent).detail;
      if (msg?.project_id !== projectId) return;

      if (msg.type === 'project.removed') {
        // Se tira la caché a la vez que el estado. Si solo se limpiara el
        // estado, el siguiente montaje del panel volvería a pintar el diseño
        // borrado desde el módulo — el fantasma otra vez.
        cache.delete(projectId);
        versiones.delete(projectId);
        if (vivo) setEstado({ design: null, cargando: false, error: 'no_existe' });
        return;
      }

      if (msg.type === 'project.updated') {
        // Primero se intenta aplicar lo que trae el evento (el widget del
        // PATCH o el diff del PUT) sobre lo cacheado, sin ir al servidor.
        // Con diez visores, que cada panel descargara la pantalla entera
        // por cada movimiento del ratón era el pico que no hacía falta.
        // Si no encaja (sin datos, versión con hueco), se pide como antes.
        const actual = cache.get(projectId) ?? null;
        const aplicado = versionEncaja(versiones.get(projectId) ?? 0, msg.version)
          ? aplicarCambio(actual, msg as MensajeProjectUpdated)
          : null;
        if (aplicado) {
          cache.set(projectId, aplicado);
          versiones.set(projectId, msg.version);
          if (vivo) setEstado({ design: aplicado, cargando: false, error: '' });
        } else {
          pedir(projectId, () => vivo);
        }
      }
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
  /**
   * Dibujar SOLO los widgets de esta sección.
   *
   * Sin esto se dibuja la pantalla entera, que es lo que hace falta cuando
   * una sección abre otra pantalla. Pero hay secciones que no abren nada:
   * simplemente filtran los widgets de su propio lienzo. Para enseñar una de
   * esas en miniatura hay que cargar esa misma pantalla y quedarse con los
   * widgets que le pertenecen — que es exactamente lo que verá el operador
   * al entrar en ella.
   */
  soloVista?: string;
  /**
   * Qué tag real corresponde a cada parámetro, cuando esta pantalla se está
   * dibujando como un FACEPLATE.
   *
   * Dentro de un tipo, los widgets no apuntan a un tag sino a un parámetro:
   * guardan `param:marcha` en su `variableId`. Aquí se cambia ese prefijo por
   * el tag que le toque a esta instancia. Sin mapa, la pantalla se dibuja tal
   * cual y los `param:` no resuelven a nada — que es exactamente lo que debe
   * pasar al abrir el tipo como pantalla normal para editarlo.
   */
  mapaTags?: Record<string, string>;
}

/**
 * El tamano del lienzo de una pantalla, sin dibujarla.
 *
 * Lo necesita el marco de un POPUP: tiene que decidir cuanto mide la ventana
 * ANTES de que dentro haya nada, y lo correcto es que mida lo que el tipo se
 * dibujo. Va por la misma cache que el dibujo, asi que preguntar aqui no
 * cuesta una peticion extra: cuando la ventana se abre, la pantalla ya se
 * esta pidiendo.
 *
 * `null` mientras no se sabe. Quien llama pone su medida por defecto.
 */
export function useTamanoPantalla(
  projectId: string
): { ancho: number; alto: number } | null {
  const { design } = usePantallaEmpotrada(projectId);
  const c = design?.canvas;
  return c?.width && c?.height ? { ancho: c.width, alto: c.height } : null;
}

export default function PantallaEmbebida({
  projectId,
  modo,
  interactivo,
  soloVista,
  mapaTags,
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
      (design?.widgets ?? []).filter((w) => {
        if (w.visible === false || esWidgetDeNavegacion(w.kind)) return false;
        if (!soloVista) return true;
        // Los de vista vacía se ven en TODAS las secciones (un logo, una
        // barra fija), así que también pertenecen a ésta.
        const v = (w.vista ?? '').trim();
        return !v || v === soloVista;
      }),
    [design, soloVista]
  );

  /**
   * De lo que el widget guarda al valor que hay que pintar.
   *
   * Un `param:<id>` se cambia por el tag de esta instancia; cualquier otra
   * cosa se busca tal cual. Un parámetro sin asignar devuelve `undefined`, y
   * entonces el widget pinta «—» en vez de un cero: un cero de mentira en un
   * panel de planta es peor que un hueco, porque nadie lo distingue de una
   * lectura real.
   */
  const resolver = (variableId: string | null | undefined) => {
    if (!variableId) return undefined;
    if (variableId.startsWith('param:')) {
      const tag = mapaTags?.[variableId.slice('param:'.length)];
      return tag ? variables.find((v) => v.id === tag) : undefined;
    }
    return variables.find((v) => v.id === variableId);
  };

  const cw = design?.canvas?.width ?? 0;
  const ch = design?.canvas?.height ?? 0;

  // El fondo viaja con la pantalla, no con el marco que la enseña. Una vista
  // de alarmas oscura sigue siendo oscura cuando se empotra dentro de un
  // sinóptico claro: es parte de su diseño, no del sitio donde se muestra.
  const fondo = design?.canvas?.fondo || undefined;

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
    /* Todo lo de dentro sabe que ya está empotrado. Lo usa la Tarjeta de
       Acceso para no dibujar su propia miniatura aquí: dos tarjetas que se
       apuntaran la una a la otra se pintarían sin final. */
    <ContextoEmbebido.Provider value>
    <ContextoMapaTags.Provider value={mapaTags}>
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
            background: fondo,
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
                variable={resolver(w.variableId)}
                interactivo={interactivo}
                // El MISMO resolutor que traduce la variable principal, así
                // que las variables con nombre de un faceplate leen los tags
                // de ESTA instancia sin ningún camino aparte.
                resolver={resolver}
              />
            </div>
          ))}
        </div>
      )}
    </div>
    </ContextoMapaTags.Provider>
    </ContextoEmbebido.Provider>
  );
}
