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
// CON VARIOS PROYECTOS: LA PRIMERA PANTALLA DE **SU** PROYECTO
// Un proyecto es un HMI distinto, con sus propias pantallas (ver
// `docs/PROYECTOS.md`). Así que «la primera pantalla» tiene que ser la
// primera DEL PROYECTO que se está usando en este navegador, y no la primera
// que devuelva el servidor: si no, abrir la vista previa mientras montas
// «Línea 2» te enseñaría el HMI del proyecto de al lado, sin ningún aviso y
// con una pinta perfectamente normal.
//
// El proyecto sale de la preferencia local que deja el Diseñador
// (`hmi.proyecto.ultimo`) y, a falta de ella, del proyecto por defecto. El
// día que un equipo de planta tenga que arrancar siempre por un proyecto
// concreto, ese ajuste va justo aquí.
//
// LA BARRA DE ARRIBA ES DEL OPERADOR, NO DEL DISEÑADOR
// Por eso enseña lo que hace falta en planta y nada más: la marca, en qué
// pantalla y en qué sección estás, si el enlace con el backend está vivo, y
// la hora. Nada que se pueda tocar.
//
// DE DÓNDE SALEN LOS DATOS
//   * El diseño, del SERVIDOR (`/pantallas/<id>`), con la caché local como
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
  useRef,
  useState,
} from 'react';
import {
  Loader2Icon,
  AlertTriangleIcon,
  MaximizeIcon,
  MinimizeIcon,
} from 'lucide-react';
import { useAppStore } from '../context/AppStore';
import { WidgetRenderer } from '../components/hmi/WidgetRenderer';
import { Logo } from '../components/ui/Logo';
import { RealPLCService } from '../services/RealPLCService';
import CapaPopups from '../components/hmi/custom/faceplate/CapaPopups';
import {
  useVistaActiva,
  useRutaDeVista,
  publicarPantallas,
  useEstructura,
  hermanosDe,
  setVistaActiva,
  esNivel,
  type Seccion,
  setPantalla,
  GRUPO_POR_DEFECTO,
} from '../components/hmi/custom/navegacion/store';

import {
  cargarProyecto,
  listarPantallas,
  loadDesign,
  PANTALLA_POR_DEFECTO,
  SavedDesign,
  ResumenPantalla,
} from '../utils/designStorage';
import {
  getUltimoProyecto,
  listarProyectosHmi,
  PROYECTO_HMI_POR_DEFECTO,
} from '../utils/proyectoStorage';

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
      className="h-6 w-px shrink-0 bg-tema-borde-suave"
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
/**
 * El camino hasta la vista abierta, y debajo dónde estás.
 *
 * Un SOLO camino, de fuera hacia dentro:
 *
 *     PROYECTO / PANTALLA / SECCIÓN / SUBSECCIÓN
 *     Subsección
 *
 * Antes los mismos niveles estaban repartidos: el nombre de la pantalla como
 * una etiqueta suelta y, tras un separador, la ruta de secciones. Nada decía
 * que lo segundo colgara de lo primero, y el proyecto —que en esta versión es
 * un nivel de verdad, un HMI distinto— no salía por ningún lado.
 *
 * Los niveles se van apagando hacia la izquierda y el último va en el color
 * de marca: de un vistazo se ve cuánto has profundizado y por dónde llegaste.
 */
/**
 * Los dos primeros segmentos de la barra.
 *
 *     PROYECTO / PANTALLA / NIVEL        <- dónde está la pestaña abierta
 *     Vista · Nivel                      <- qué vista es, y de quién cuelga
 *
 * El camino NO repite la vista al final: termina en el nivel que la contiene,
 * porque el nombre va justo debajo. Antes se leía dos veces lo mismo, una
 * línea encima de la otra, y el camino no añadía nada al título.
 *
 * El «· Nivel» del título es lo que hace el ejemplo con la línea: el nombre
 * solo («Lavado», «Detalles») se repite entre zonas, y saber de cuál cuelga
 * es la mitad del dato.
 */
function Ruta({
  direccion,
  titulo,
  nivel,
}: {
  direccion: string[];
  titulo: string;
  nivel: string;
}) {
  const camino = direccion.filter(Boolean);
  if (!titulo && camino.length === 0) return null;

  return (
    <div className="flex min-w-0 flex-col justify-center leading-tight">
      {/* `mb-1.5` = los mismos 6 px que la rejilla deja hasta las pestañas.
          Sin esto el camino y el título quedaban pegados y la tercera fila
          muy por debajo: dos líneas juntas y una suelta. */}
      <span className="mb-1.5 flex min-w-0 items-center gap-1 font-mono text-[10px] uppercase tracking-wider text-tema-sobre-superficie-alt">
        {camino.map((label, i) => (
          <span key={`${label}-${i}`} className="flex min-w-0 items-center gap-1">
            {i > 0 && <span className="text-slate-300 dark:text-navy-slate">/</span>}
            <span className="truncate">{label}</span>
          </span>
        ))}
      </span>
      <span className="flex min-w-0 items-baseline gap-1.5">
        <span className="truncate text-[13px] font-bold text-tema-sobre-superficie">
          {titulo}
        </span>
        {nivel && (
          <span className="shrink-0 truncate text-[11px] text-tema-sobre-superficie-alt">
            · {nivel}
          </span>
        )}
      </span>
    </div>
  );
}

/**
 * Tercer segmento: las secciones que están al MISMO nivel que la abierta.
 *
 * Pulsan el mismo `setVistaActiva` que el Menú Lateral, así que no son una
 * segunda navegación compitiendo con él sino otro mando de la misma: al
 * pulsar una pestaña se enciende también su botón en el menú.
 *
 * Con una sola hermana no se dibuja nada. Una pestaña suelta no es una
 * elección: es una fila que le roba alto al sinóptico para no ofrecer nada.
 */
function Hermanas({
  hermanas,
  activa,
  grupo,
}: {
  hermanas: Seccion[];
  activa: string;
  grupo: string;
}) {
  if (hermanas.length < 2) return null;

  return (
    <nav
      aria-label="Secciones del mismo nivel"
      className="flex min-w-0 items-stretch gap-5 overflow-x-auto"
    >
      {hermanas.map((s) => {
        const esActiva = s.id === activa;
        return (
          <button
            key={s.id}
            type="button"
            onClick={() => setVistaActiva(grupo, s.id)}
            aria-current={esActiva ? 'page' : undefined}
            title={s.label || s.id}
            /* `-mb-px` monta el subrayado sobre la línea de la cabecera, en
               vez de dejarlo flotando un píxel por encima. Es lo que hace el
               proyecto de ejemplo con `border-bottom` en la fila y en el
               botón activo. */
            className={`-mb-px shrink-0 whitespace-nowrap border-b-2 px-0.5 pb-2 text-xs transition ${
              esActiva
                ? 'border-tema-primario font-semibold text-tema-primario'
                : 'border-transparent text-tema-sobre-superficie-alt hover:text-tema-sobre-superficie'
            }`}
          >
            {s.label || s.id}
          </button>
        );
      })}
    </nav>
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
          ? 'border-tema-ok bg-tema-ok-fondo text-tema-sobre-ok-fondo'
          : 'border-tema-error bg-tema-error-fondo text-tema-sobre-error-fondo'
      }`}
    >
      <span
        aria-hidden="true"
        className={`h-1.5 w-1.5 rounded-full ${
          vivo ? 'animate-pulse bg-tema-ok' : 'bg-tema-error'
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
      <span className="font-mono text-[10px] tabular-nums text-tema-sobre-superficie-alt">
        {fecha}
      </span>
    </div>
  );
}

// ─── La vista ────────────────────────────────────────────────────

export function Preview() {
  const { variables } = useAppStore();

  /**
   * Buscar una variable por su id.
   *
   * Se le pasa a cada widget para que resuelva sus variables CON NOMBRE. Va
   * en un `useCallback` atado a `variables` y no suelto en el render: sin él
   * cambiaría de identidad en cada dibujo y obligaría a rehacer la búsqueda
   * de todos los widgets de la pantalla aunque no hubiera llegado ni una
   * lectura nueva.
   */
  const resolverVariable = useCallback(
    (id: string | null | undefined) =>
      id ? variables.find((v) => v.id === id) : undefined,
    [variables]
  );

  // Vista abierta en la navegación. Al pulsar un botón del Menú Lateral
  // cambia, y este componente se vuelve a dibujar mostrando solo los widgets
  // de esa sección.
  const vistaActiva = useVistaActiva(GRUPO_POR_DEFECTO);
  const ruta = useRutaDeVista(GRUPO_POR_DEFECTO);
  const estructura = useEstructura(GRUPO_POR_DEFECTO);
  const enVivo = useEnVivo();

  // Qué proyecto es este HMI. Se lee UNA sola vez, al montar: la vista previa
  // vive en su propia pestaña, y que cambiara de proyecto bajo los pies del
  // operador porque alguien toca el Diseñador en otra ventana sería lo último
  // que uno espera de una pantalla de planta.
  const proyecto = useMemo(() => getUltimoProyecto(), []);

  // El nombre legible del proyecto, para encabezar el camino. Se pide una vez
  // y se cae en el id si el servidor no contesta: un camino que empieza por
  // «principal» en vez de «Planta Norte» se entiende igual, y quedarse sin
  // cabecera porque una lista no llegó no se entendería.
  const [nombreProyecto, setNombreProyecto] = useState('');
  useEffect(() => {
    let vivo = true;
    listarProyectosHmi()
      .then((lista) => {
        if (!vivo) return;
        const p = lista.find((x) => x.proyecto_id === proyecto);
        if (p) setNombreProyecto(p.nombre);
      })
      .catch(() => {
        /* sin lista: el camino arranca por la pantalla, ver `niveles` */
      });
    return () => {
      vivo = false;
    };
  }, [proyecto]);

  // ── Qué pantalla se abre ────────────────────────────────────────
  //
  // La lista manda: cuando llega, se abre `pantallas[0]`, que es la
  // definición literal de «la primera del proyecto».
  //
  // Antes de que llegue hay una suposición, y solo sirve para pintar desde la
  // caché en el primer render en vez de enseñar un hueco en blanco. En el
  // proyecto por defecto se puede suponer: su primera pantalla es
  // `principal`, que el backend garantiza (`ProjectStore` la crea y borrarla
  // está prohibido). En cualquier otro proyecto NO se puede adivinar el id de
  // su primera pantalla, y suponer `principal` sería peor que esperar:
  // pintaría durante un instante la pantalla de otro HMI.
  const arranque =
    proyecto === PROYECTO_HMI_POR_DEFECTO ? PANTALLA_POR_DEFECTO : '';

  // ── Ajuste al hueco disponible ─────────────────────────────────
  //
  // El sinóptico se diseña en píxeles fijos, pero la pantalla donde se mira
  // no siempre los tiene. Se mide el hueco y se escala lo que haga falta,
  // hacia abajo (para que quepa) y hacia arriba (para que lo llene).
  const hueco = useRef<HTMLDivElement>(null);
  const [medida, setMedida] = useState({ ancho: 0, alto: 0 });

  /**
   * Pantalla completa: se va el navegador, NO la barra de PsiCore.
   *
   * Antes esta misma acción escondía también la barra, para que un diseño de
   * 1920x1080 cupiera clavado en un monitor de 1920x1080. Era un mal negocio:
   * la barra es la ÚNICA navegación del runtime —las pestañas de sección, el
   * camino de dónde estás, el reloj y el «en vivo»—, así que escondiéndola el
   * operario se quedaba a pantalla completa y sin poder cambiar de pantalla.
   *
   * Y lo que se ganaba era poco: el lienzo ya se escala solo al hueco que
   * tenga, así que sin la barra ese diseño se ve al 100 % y con ella al 87 %.
   * Ver un 13 % más pequeño se arregla acercándose; no poder navegar, no.
   */
  const [pantallaCompleta, setPantallaCompleta] = useState(false);

  // Salir con Esc lo gestiona el navegador, no esta aplicación. Sin escuchar
  // el cambio, el botón se quedaría enseñando «salir» con la ventana ya
  // restaurada.
  useEffect(() => {
    const alCambiar = () => setPantallaCompleta(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', alCambiar);
    return () => document.removeEventListener('fullscreenchange', alCambiar);
  }, []);

  const alternarPantallaCompleta = useCallback(async () => {
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else {
        // Puede fallar —un permiso, un navegador incrustado—. Se ignora: el
        // estado real lo pone `fullscreenchange`, así que si no entró, el
        // botón sigue ofreciendo entrar en vez de mentir.
        await document.documentElement.requestFullscreen();
      }
    } catch {
      /* lo dice el navegador; aquí no hay nada que hacer */
    }
  }, []);

  useEffect(() => {
    const el = hueco.current;
    if (!el) return;
    // ResizeObserver y no el evento `resize` de la ventana: el hueco también
    // cambia sin que la ventana se mueva —cuando aparece el banner de alarmas,
    // por ejemplo—, y ahí `resize` no se dispara.
    const ro = new ResizeObserver(([e]) => {
      const r = e.contentRect;
      setMedida({ ancho: r.width, alto: r.height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const [pantallaId, setPantallaId] = useState<string>(arranque);
  const [pantallas, setPantallas] = useState<ResumenPantalla[]>([]);

  // El catálogo de pantallas hace falta también AQUÍ, no sólo en el
  // Diseñador: lo lee todo el que tenga que poner el NOMBRE de una pantalla
  // en vez de su id —la Tarjeta de Acceso, por ejemplo, que enseña a dónde
  // lleva—. Sin esto se veía «acc_horno» donde debía poner «Horno».
  useEffect(() => {
    publicarPantallas(pantallas);
  }, [pantallas]);
  const [design, setDesign] = useState<SavedDesign | null>(() =>
    arranque ? loadDesign(arranque) : null
  );
  const [cargando, setCargando] = useState(true);

  // `true` mientras lo pintado venga de la caché del navegador y no del
  // servidor. Empieza en true porque el primer render ES la caché: hasta que
  // el servidor conteste, no se puede afirmar que esté en vivo.
  const [desfasado, setDesfasado] = useState(true);

  // Sesión caducada o ausente. Antes esto acababa mostrando en silencio un
  // diseño viejo de la caché; ahora se dice, porque son cosas distintas.
  const [sinSesion, setSinSesion] = useState(false);

  // La lista no llegó y no había suposición de arranque (un proyecto que no
  // es el de por defecto). Sin esta bandera, ese caso se queda en «Cargando…»
  // para siempre: no hay id que pedir, así que nadie vuelve a poner
  // `cargando` en false y el operador mira una pantalla que no avanza sin
  // saber si esperar o avisar a alguien.
  const [sinCatalogo, setSinCatalogo] = useState(false);

  /**
   * Cuánto hay que escalar el sinóptico para que llene el hueco sin
   * deformarse.
   *
   * Se toma el MENOR de los dos factores: el que quepa en los dos ejes. Usar
   * cada eje por su cuenta estiraría el dibujo, y un depósito ovalado o un
   * motor achatado es exactamente lo que no puede pasar en un sinóptico.
   *
   * Mientras no se ha medido (`ancho` en 0, el primer render) se deja en 1:
   * pintar a escala 0 sería un parpadeo en negro en cada carga.
   */
  const escala = useMemo(() => {
    if (!design || !medida.ancho || !medida.alto) return 1;
    const { width, height } = design.canvas;
    if (!width || !height) return 1;
    return Math.min(medida.ancho / width, medida.alto / height);
  }, [design, medida.ancho, medida.alto]);

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
  //
  // Filtrado por proyecto EN EL SERVIDOR. Pedirlas todas y quedarse con la
  // primera daría la primera pantalla del primer proyecto de la instalación,
  // que casi nunca es la de este HMI.
  useEffect(() => {
    let vivo = true;
    void (async () => {
      try {
        const lista = await listarPantallas(proyecto);
        if (!vivo) return;
        setSinCatalogo(false);
        setPantallas(lista);
        const primera = lista[0]?.project_id;
        // Con la forma funcional: este efecto corre una sola vez y leer
        // `pantallaId` de su closure daría siempre el valor inicial.
        if (primera) setPantallaId((prev) => (prev === primera ? prev : primera));
      } catch {
        // Sin lista se sigue con la suposición de arranque. Si no la había,
        // aquí se acaba el camino y hay que decirlo.
        if (vivo) setSinCatalogo(true);
      }
    })();
    return () => {
      vivo = false;
    };
  }, [proyecto]);

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
    // Sin id todavía (un proyecto que no es el de por defecto, esperando su
    // lista). Pedir `/pantallas/` sin id sería un 404 y dejaría la vista en
    // «Cargando…» para siempre.
    if (!pantallaId) return;
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

  /**
   * Los tres segmentos de la barra.
   *
   *   `direccion` — dónde está la pestaña abierta: proyecto, pantalla y los
   *                 niveles por los que se ha bajado. SIN la vista actual,
   *                 que va en el segundo segmento.
   *   `titulo`    — la vista abierta.
   *   `nivel`     — de quién cuelga. El nivel más cercano por encima; si no
   *                 hay ninguno, la pantalla, que es el contenedor de todo.
   *   `hermanas`  — las secciones a su misma altura, para el tercer segmento.
   *                 Se descartan los niveles: son encabezados, no se pulsan.
   */
  const cabecera = useMemo(() => {
    const actual = ruta.length > 0 ? ruta[ruta.length - 1] : null;
    const ancestros = ruta.slice(0, -1);
    const nivelPadre = [...ancestros].reverse().find(esNivel);

    const hermanas = actual
      ? hermanosDe(estructura, actual.id)
          .map((id) => estructura.find((s) => s.id === id))
          .filter((s): s is Seccion => !!s && !esNivel(s))
      : [];

    return {
      direccion: [
        nombreProyecto,
        nombreActual,
        ...ancestros.map((s) => s.label || s.id),
      ],
      titulo: actual ? actual.label || actual.id : nombreActual,
      nivel: actual
        ? nivelPadre
          ? nivelPadre.label || nivelPadre.id
          : nombreActual
        : '',
      hermanas,
      activa: actual?.id ?? '',
    };
  }, [nombreProyecto, nombreActual, ruta, estructura]);

  return (
    <div className="relative flex h-full w-full flex-col bg-tema-fondo">
      {/* Las ventanas de faceplate. Van aqui, en la raiz del runtime, y no
          dentro del lienzo: flotan sobre TODO —cabecera incluida— y no las
          recorta ni las escala el `transform` del lienzo. */}
      <CapaPopups />

      {/* ── Barra de operación ────────────────────────────────────
          Sin un solo control: es informativa de principio a fin. Lo único
          que se puede tocar en esta vista es el HMI. */}
      <header className="shrink-0 border-b border-tema-borde-suave bg-tema-superficie px-4">
        {/* Dos columnas: el logotipo manda el ancho de la primera y los tres
            segmentos viven en la segunda. Así las pestañas caen alineadas con
            el camino y el título sin medir nada ni escribir un ancho a mano,
            que se quedaría desfasado el día que el logotipo cambie. */}
        <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] gap-x-3 gap-y-1.5">
        {/* El aire de ARRIBA lo pone esta fila. El de abajo lo pone el propio
            botón de pestaña: la cabecera no puede llevar `pb` o el subrayado
            de la activa dejaría de caer sobre su línea inferior. */}
        <div
          className={`flex items-center gap-3 ${
            cabecera.hermanas.length > 1 ? 'row-span-2' : 'pt-2'
          }`}
        >
          <Logo variante="barra" />
          <Separador />
        </div>

        {/* Segmentos 1 y 2: dónde está la pestaña abierta, y qué vista es
            —con el nivel del que cuelga—.

            `self-end` y no centrado: así el borde inferior de este bloque ES
            el de la fila, y lo que queda hasta las pestañas es exactamente el
            hueco de la rejilla. Centrado, el alto lo marcaban el logotipo y
            los controles —más altos— y esos píxeles sobrantes se sumaban al
            hueco, que salía de 9 px donde arriba había 6. */}
        <div className="min-w-0 self-end pt-2">
        <Ruta
          direccion={cabecera.direccion}
          titulo={cabecera.titulo}
          nivel={cabecera.nivel}
        />
        </div>

        {/* Tercera columna: los avisos y el reloj. Fuera de la celda de los
            segmentos, que es lo que les devuelve el ritmo. */}
        <div
          className={`flex shrink-0 items-center gap-3 pt-2 ${
            cabecera.hermanas.length > 1 ? 'row-span-2' : ''
          }`}
        >
          {/* Lo que se ve NO viene del servidor. Decirlo no es un adorno: sin
              este aviso, una pantalla en caché es indistinguible de una en
              vivo, y alguien puede decidir algo mirando un diseño que ya no
              existe. */}
          {desfasado && !sinSesion && (
            <span
              className="flex items-center gap-1.5 rounded-md bg-tema-aviso-fondo px-2 py-1 text-[11px] font-semibold text-tema-sobre-aviso-fondo"
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

          {/* El ⛶ del proyecto de ejemplo. Quita el marco del navegador y
              deja el sinóptico con todo el monitor; esta barra se queda,
              porque es la única forma de navegar que tiene el operario. */}
          <button
            type="button"
            onClick={() => void alternarPantallaCompleta()}
            title={
              pantallaCompleta
                ? 'Salir de pantalla completa (Esc)'
                : 'Pantalla completa (Esc para salir)'
            }
            aria-label={
              pantallaCompleta ? 'Salir de pantalla completa' : 'Pantalla completa'
            }
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-tema-sobre-superficie-alt transition hover:text-tema-primario"
          >
            {pantallaCompleta ? (
              <MinimizeIcon className="h-4 w-4" />
            ) : (
              <MaximizeIcon className="h-4 w-4" />
            )}
          </button>

          <Reloj />
        </div>

        {/* Segmento 3, en la MISMA columna que los otros dos: lo coloca solo
            el reparto de la rejilla, porque el logotipo ya ocupa la columna
            de la izquierda en las dos filas. Un relleno vacío aquí empujaría
            las pestañas a una TERCERA fila —se probó, y descentraba el
            logotipo aún más—. */}
        {cabecera.hermanas.length > 1 && (
          <>
            <Hermanas
              hermanas={cabecera.hermanas}
              activa={cabecera.activa}
              grupo={GRUPO_POR_DEFECTO}
            />
          </>
        )}
        </div>
      </header>

      {/* Ya no hace falta un botón flotante para salir: la barra sigue ahí y
          su propio botón hace las dos cosas. */}

      {/* ── El lienzo ─────────────────────────────────────────────── */}
      {/* `overflow-hidden` y no `auto`: ahora el sinóptico SIEMPRE cabe, así
          que una barra de desplazamiento aquí sólo podría significar que el
          cálculo de escala se ha equivocado. Que se note. */}
      <div
        ref={hueco}
        className="mp-scroll mp-scroll-dark flex min-h-0 flex-1 items-center justify-center overflow-hidden"
      >
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
            {sinCatalogo && !pantallaId ? (
              <>
                <p className="font-semibold">No se pudo abrir el HMI</p>
                <p className="mt-1 text-xs leading-relaxed">
                  El servidor no responde, así que no se sabe por qué pantalla
                  arranca este proyecto. Comprueba que el servicio está en
                  marcha y vuelve a cargar.
                </p>
              </>
            ) : cargando ? (
              <span className="flex items-center justify-center gap-2">
                <Loader2Icon className="h-4 w-4 animate-spin" />
                {nombreActual ? `Cargando «${nombreActual}»…` : 'Cargando…'}
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
          /* El envoltorio ocupa el tamaño YA ESCALADO. Sin él, el navegador
             seguiría reservando el tamaño original —`transform` no cambia la
             caja de maquetación— y el centrado saldría torcido con barras de
             desplazamiento fantasma. */
          <div
            style={{
              width: design.canvas.width * escala,
              height: design.canvas.height * escala,
            }}
          >
          <div
            // SIN `rounded-*`, igual que en el Diseñador: esto es la pantalla
            // del panel. Redondearla aquí y no allí, además, haría que el
            // operador viera algo distinto de lo que se diseñó.
            //
            // El fondo elegido en el Diseñador manda; si no hay ninguno se cae
            // en el color del tema.
            className={`relative shrink-0 overflow-hidden shadow-xl ${
              design.canvas.fondo ? '' : 'bg-tema-superficie'
            }`}
            style={{
              width: design.canvas.width,
              height: design.canvas.height,
              background: design.canvas.fondo || undefined,
              // El lienzo mantiene su tamaño CSS real y sólo se escala al
              // pintar: los widgets siguen midiendo lo que se diseñó.
              transform: `scale(${escala})`,
              transformOrigin: 'top left',
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
                    resolver={resolverVariable}
                  />
                </div>
              ))}
          </div>
          </div>
        )}
      </div>
    </div>
  );
}
