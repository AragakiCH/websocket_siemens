// =========================================================================
// Trend.tsx
// Tendencia: varias variables numéricas contra el tiempo, en vivo y navegable.
//
// POR QUÉ USA uPlot Y NO UN <polyline> A MANO
// La versión original dibujaba una polilínea SVG por serie y explicaba, con
// razón, que Recharts era mal negocio: remonta su árbol de componentes en cada
// dato y a 100 ms se entrecorta. Ese argumento sigue en pie — lo que cambió es
// lo que hay que dibujar. Una polilínea sirve para pintar los últimos 60 s; no
// sirve para recorrer media hora con zoom, porque cada movimiento del ratón
// obligaría a recalcular miles de coordenadas y a rehacer el nodo SVG entero.
//
// uPlot no es una librería de gráficos de propósito general: es un canvas
// especializado en series de tiempo. Pesa ~45 KB, sin dependencias, y
// `setData()` está escrito para streaming. Trae la escala temporal, el
// autoescalado sobre lo VISIBLE y el cursor. Los gestos se los pone
// `interaccion.ts`; la memoria, `buffer.ts`.
//
// TRES COSAS QUE SE ARREGLARON DESPUÉS DE VERLO CORRER
//
// 1. EL TAMAÑO. El `ResizeObserver` se montaba en un efecto con dependencias
//    vacías, y el div que observaba solo existe cuando el widget YA tiene
//    series. Con el widget recién soltado ese div es `null`, el efecto salía
//    por la guarda y no volvía a correr nunca: `setSize()` no se llamaba jamás
//    y el canvas se quedaba con el tamaño que tuvo al nacer. De ahí el hueco
//    muerto al agrandar y el solape con la leyenda al achicar. Ahora el
//    observador se monta JUNTO al gráfico, en el mismo efecto que lo crea.
//
// 2. LA REJILLA VERDE NEÓN. Los colores salían de `estiloDeParte()`, y las
//    partes `icon` y `label` heredan `style.color` del widget, que en uno
//    recién soltado es el petrol de la marca. La rejilla se estaba pintando
//    con el color de acento y competía con los datos. Ahora los neutros vienen
//    de `temaGrafico()` y solo se pisan si alguien los fija A MANO.
//
// 3. EL ZOOM PAUSABA EL GRÁFICO. Ver `interaccion.ts`: el zoom centraba en el
//    medio de la vista y despegaba el borde derecho del presente.
//
// DE DÓNDE SALEN LOS DATOS
// De las variables que llegan por WebSocket. El widget guarda `retencionSeg`
// en memoria y enseña `ventanaSeg`: la diferencia es lo que se puede recorrer
// hacia atrás. Nada va a disco — para mirar días atrás está el historizador.
//
// LOS GESTOS SOLO VAN EN LA VISTA PREVIA
// En el lienzo del Diseñador el arrastre sirve para COLOCAR el widget. Si el
// gráfico se quedara el gesto, no habría forma de moverlo. Por eso el
// renderizador recibe `interactivo`.
// =========================================================================
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  LineChartIcon,
  PlusIcon,
  Trash2Icon,
  ActivityIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ZoomInIcon,
  ZoomOutIcon,
  MaximizeIcon,
  Loader2Icon,
} from 'lucide-react';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';

import type { CustomWidgetDef, RenderCtx, InspectorCtx } from '../types';
import { useAppStore } from '../../../../context/AppStore';
import { estiloDeParte } from '../../partes';
import { colorEfectivo, sugerencias, temaGrafico, type TemaGrafico } from './paleta';
import { BufferTrend, useBufferTrend } from './buffer';
import {
  ajustar,
  desplazar,
  pluginInteraccion,
  zoom,
  type OpcionesInteraccion,
} from './interaccion';

// ─── Config ──────────────────────────────────────────────────────

export interface SerieTrend {
  /** Id estable de la fila. No es el de la variable: así renombrar o
   *  reasignar la variable no pierde el color ni el orden. */
  id: string;
  variableId: string;
  /** Vacío = se usa el nombre de la variable. */
  etiqueta: string;
  /**
   * Color elegido a mano (`#rrggbb`). Vacío = el que toca por posición.
   *
   * Existe porque ya no hay tope de seis series: a partir de la séptima el
   * reparto automático repite tonos, y quien diseña la pantalla necesita poder
   * separarlas. Un color escrito aquí se usa igual en tema claro y oscuro —
   * los del catálogo sí tienen variante para cada uno.
   */
  color?: string;
  /** Grosor de la línea en píxeles. */
  grosor?: number;
}

export interface ConfigTrend {
  series: SerieTrend[];
  /** Ancho de la ventana visible, en segundos. */
  ventanaSeg: number;
  /** Cuánto se GUARDA en memoria para poder retroceder, en segundos. */
  retencionSeg: number;
  mostrarLeyenda: boolean;
  mostrarRejilla: boolean;
  /** Autoescala el eje Y a lo que haya en pantalla. */
  autoEscala: boolean;
  min: string;
  max: string;
}

export const CONFIG_TREND: ConfigTrend = {
  series: [],
  ventanaSeg: 60,
  retencionSeg: 1800,
  mostrarLeyenda: true,
  mostrarRejilla: true,
  autoEscala: true,
  min: '',
  max: '',
};

/** Opciones del desplegable de retención, en segundos. */
export const RETENCIONES = [
  { v: 300, t: '5 minutos' },
  { v: 900, t: '15 minutos' },
  { v: 1800, t: '30 minutos' },
  { v: 3600, t: '1 hora' },
  { v: 7200, t: '2 horas' },
  { v: 21600, t: '6 horas' },
];

export const VENTANAS = [
  { v: 15, t: '15 segundos' },
  { v: 30, t: '30 segundos' },
  { v: 60, t: '1 minuto' },
  { v: 180, t: '3 minutos' },
  { v: 300, t: '5 minutos' },
  { v: 900, t: '15 minutos' },
  { v: 1800, t: '30 minutos' },
  { v: 3600, t: '1 hora' },
];

export function leerConfigTrend(config: any): ConfigTrend {
  const c = config ?? {};
  const ventanaSeg = Number(c.ventanaSeg) > 0 ? Number(c.ventanaSeg) : 60;
  // La retención nunca puede ser menor que la ventana: se estaría tirando dato
  // que la pantalla todavía tiene que enseñar. Los proyectos guardados antes
  // de que existiera este campo entran por aquí y salen con 30 min.
  const cruda = Number(c.retencionSeg);
  const retencionSeg = Math.max(ventanaSeg, cruda > 0 ? cruda : 1800);
  return {
    series: Array.isArray(c.series)
      ? c.series.map((s: any) => ({
          id: String(s?.id ?? ''),
          variableId: String(s?.variableId ?? ''),
          etiqueta: String(s?.etiqueta ?? ''),
          color: typeof s?.color === 'string' ? s.color : '',
          grosor: Number(s?.grosor) > 0 ? Number(s.grosor) : 2,
        }))
      : [],
    ventanaSeg,
    retencionSeg,
    mostrarLeyenda: c.mostrarLeyenda !== false,
    mostrarRejilla: c.mostrarRejilla !== false,
    autoEscala: c.autoEscala !== false,
    min: typeof c.min === 'string' ? c.min : '',
    max: typeof c.max === 'string' ? c.max : '',
  };
}

const nuevoId = () =>
  `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

// ─── Formato ─────────────────────────────────────────────────────

function fmtNum(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  const abs = Math.abs(n);
  if (abs >= 1000) return n.toFixed(0);
  if (abs >= 10) return n.toFixed(1);
  return n.toFixed(2);
}

const dos = (n: number) => String(n).padStart(2, '0');

/**
 * Hora de una marca del eje, con el detalle que pida el zoom.
 *
 * Con la ventana en un minuto hacen falta los segundos; con seis horas, los
 * segundos son ruido. Y al pasar del día, la fecha. Formato dd/mm, no mm/dd.
 */
function fmtHora(t: number, span: number): string {
  const d = new Date(t * 1000);
  const hm = `${dos(d.getHours())}:${dos(d.getMinutes())}`;
  if (span <= 180) return `${hm}:${dos(d.getSeconds())}`;
  if (span <= 86400) return hm;
  return `${dos(d.getDate())}/${dos(d.getMonth() + 1)} ${hm}`;
}

/** Hora completa, para el instante que señala el cursor. */
function fmtInstante(t: number): string {
  const d = new Date(t * 1000);
  return `${dos(d.getHours())}:${dos(d.getMinutes())}:${dos(d.getSeconds())}`;
}

/**
 * Prefijo que comparten TODOS los nombres, cortado en un punto.
 *
 * Cinco series de un mismo POU se llaman `PLC_PRG.rSensor`,
 * `PLC_PRG.rSetPoint`… y en la leyenda no cabían: se truncaban a «PLC_PR…»,
 * que es exactamente la parte que NO distingue una de otra. Quitando el
 * prefijo común quedan `rSensor` y `rSetPoint`, que es lo que hay que leer.
 * El nombre completo sigue estando en el `title` de cada chip.
 *
 * Solo se recorta si hay al menos dos series y a todas les queda algo que
 * enseñar: con una sola serie el prefijo ES el nombre.
 */
export function prefijoComun(nombres: string[]): string {
  if (nombres.length < 2) return '';
  let prefijo = nombres[0];
  for (const n of nombres.slice(1)) {
    let i = 0;
    while (i < prefijo.length && i < n.length && prefijo[i] === n[i]) i++;
    prefijo = prefijo.slice(0, i);
    if (!prefijo) return '';
  }
  const corte = prefijo.lastIndexOf('.');
  if (corte < 0) return '';
  const recorte = prefijo.slice(0, corte + 1);
  return nombres.every((n) => n.length - recorte.length >= 2) ? recorte : '';
}

/** Duración legible de la ventana: «1 min», «30 s», «2 h». */
function fmtDuracion(seg: number): string {
  if (seg < 90) return `${Math.round(seg)} s`;
  if (seg < 5400) return `${Math.round(seg / 60)} min`;
  return `${(seg / 3600).toFixed(seg % 3600 === 0 ? 0 : 1)} h`;
}

// ─── Opciones de uPlot ───────────────────────────────────────────

interface ParamsOpciones {
  cfg: ConfigTrend;
  ids: string[];
  nombres: string[];
  colores: string[];
  grosores: number[];
  ancho: number;
  alto: number;
  tema: TemaGrafico;
  colorRejilla: string;
  colorTinta: string;
  interactivo: boolean;
  interaccion: OpcionesInteraccion;
  alCambiarEscala: (u: uPlot) => void;
  alMoverCursor: (u: uPlot) => void;
}

function construirOpciones(p: ParamsOpciones): uPlot.Options {
  const fuente = '11px Inter, system-ui, Arial, sans-serif';

  // Escala Y manual: solo si los dos números son válidos. Un mínimo escrito a
  // medias («1» y el máximo vacío) no debe dejar el gráfico en blanco; se cae
  // a autoescala, que es el comportamiento que no puede fallar.
  const yMin = Number(p.cfg.min);
  const yMax = Number(p.cfg.max);
  const manual =
    !p.cfg.autoEscala &&
    Number.isFinite(yMin) &&
    Number.isFinite(yMax) &&
    yMax > yMin;

  const ejeComun = {
    stroke: p.colorTinta,
    font: fuente,
    grid: { show: p.cfg.mostrarRejilla, stroke: p.colorRejilla, width: 1 },
    ticks: { show: true, stroke: p.tema.eje, width: 1, size: 4 },
  };

  return {
    width: Math.max(1, p.ancho),
    height: Math.max(1, p.alto),
    padding: [12, 14, 0, 0] as uPlot.Padding,
    // La leyenda de uPlot se desactiva: la de abajo enseña el valor actual —o
    // el del instante señalado— de cada serie, que en un HMI se mira de lejos.
    legend: { show: false },
    cursor: {
      show: p.interactivo,
      // Solo la línea vertical: en una tendencia lo que se señala es un
      // INSTANTE. La horizontal cruzaría cinco series y no diría de cuál es.
      y: false,
      points: { show: true, size: 6 },
      // El arrastre es para DESPLAZARSE en el tiempo (ver interaccion.ts), así
      // que se desactiva el zoom por caja que uPlot trae de fábrica.
      drag: { x: false, y: false, setScale: false },
    },
    scales: {
      x: { time: true },
      y: manual ? { auto: false, range: [yMin, yMax] as [number, number] } : { auto: true },
    },
    axes: [
      {
        ...ejeComun,
        space: 88,
        size: 30,
        values: (u, splits) => {
          const min = u.scales.x.min ?? 0;
          const max = u.scales.x.max ?? 0;
          const span = max - min;
          return splits.map((s) => fmtHora(s, span));
        },
      },
      {
        ...ejeComun,
        size: 52,
        values: (_u, splits) => splits.map((s) => fmtNum(s)),
      },
    ],
    series: [
      { label: 'tiempo' },
      ...p.ids.map((_id, i) => ({
        label: p.nombres[i],
        stroke: p.colores[i],
        width: p.grosores[i],
        // Un hueco es un hueco: si el PLC dejó de mandar, no se une el punto
        // de antes con el de después fingiendo que hubo continuidad.
        spanGaps: false,
        points: { show: false },
      })),
    ],
    hooks: {
      setScale: [
        (u: uPlot, clave: string) => {
          if (clave === 'x') p.alCambiarEscala(u);
        },
      ],
      setCursor: [(u: uPlot) => p.alMoverCursor(u)],
    },
    plugins: p.interactivo ? [pluginInteraccion(p.interaccion)] : [],
  };
}

// ─── El widget ───────────────────────────────────────────────────

function Trend({ widget, interactivo = false }: RenderCtx) {
  const cfg = leerConfigTrend(widget.config);
  const { variables, isDark } = useAppStore();
  const tema = temaGrafico(isDark);

  const pCaja = estiloDeParte(widget, 'box');
  const pTexto = estiloDeParte(widget, 'label');

  // Neutros del tema por defecto. `estiloDeParte` NO sirve aquí: las partes
  // `icon` y `label` heredan `style.color` del widget, así que la rejilla
  // acababa pintada con el color de acento. Solo se pisa lo que alguien haya
  // fijado explícitamente en `widget.partes`.
  const colorRejilla = widget.partes?.icon?.color ?? tema.rejilla;
  const colorTinta = widget.partes?.label?.color ?? tema.tinta;
  const fondo =
    pCaja.background && pCaja.background !== 'transparent'
      ? pCaja.background
      : tema.superficie;
  const tamLeyenda = Math.min(14, Math.max(10, pTexto.fontSize ?? 12));

  const ids = useMemo(
    () => cfg.series.map((s) => s.variableId).filter(Boolean),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [cfg.series.map((s) => s.variableId).join('|')]
  );

  /**
   * Series que de verdad se dibujan, cada una con su índice ORIGINAL.
   *
   * El índice se arrastra a propósito: es lo que determina el color por
   * defecto. Si se usara la posición dentro de esta lista filtrada, una fila a
   * medio configurar correría los colores de todas las de abajo y el operador
   * vería cambiar de color una línea que no tocó nadie.
   */
  const dibujables = useMemo(
    () => cfg.series.map((s, i) => ({ s, i })).filter((x) => x.s.variableId),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      cfg.series
        .map((s) => `${s.variableId}:${s.etiqueta}:${s.color ?? ''}:${s.grosor ?? 2}`)
        .join('|'),
    ]
  );

  const caja = useRef<HTMLDivElement>(null);
  const contenedor = useRef<HTMLDivElement>(null);
  const plot = useRef<uPlot | null>(null);
  const bufferRef = useRef<BufferTrend | null>(null);

  // «Seguir en vivo»: el borde derecho pegado al último dato.
  //
  // Va en estado Y en un ref. El estado pinta la píldora; el ref lo leen el
  // plugin de gestos y el callback del búfer, que viven fuera del ciclo de
  // render y verían un valor congelado si dependieran del estado.
  const [siguiendo, setSiguiendo] = useState(true);
  const siguiendoRef = useRef(true);
  const [vista, setVista] = useState<{ min: number; max: number } | null>(null);
  // Instante señalado por el cursor. `null` = no se está señalando nada y la
  // leyenda enseña el valor en vivo.
  const [idxCursor, setIdxCursor] = useState<number | null>(null);

  const alCambiarEscala = useCallback((u: uPlot) => {
    const min = u.scales.x.min;
    const max = u.scales.x.max;
    if (min == null || max == null) return;
    // Solo se toca el estado si cambió el segundo: en vivo, `setScale` se
    // dispara con cada muestra y esto serían diez renders por segundo para
    // escribir la misma hora.
    setVista((prev) =>
      prev && Math.round(prev.min) === Math.round(min) &&
      Math.round(prev.max) === Math.round(max)
        ? prev
        : { min, max }
    );
  }, []);

  const alMoverCursor = useCallback((u: uPlot) => {
    const i = u.cursor.idx;
    const nuevo = i === null || i === undefined ? null : i;
    setIdxCursor((prev) => (prev === nuevo ? prev : nuevo));
  }, []);

  const interaccion = useMemo<OpcionesInteraccion>(
    () => ({
      limites: () => bufferRef.current?.rango() ?? null,
      siguiendo: () => siguiendoRef.current,
      alTomarControl: () => {
        if (!siguiendoRef.current) return;
        siguiendoRef.current = false;
        setSiguiendo(false);
      },
      alVolverAlBorde: () => {
        if (siguiendoRef.current) return;
        siguiendoRef.current = true;
        setSiguiendo(true);
      },
    }),
    []
  );

  /**
   * Pega la vista al último dato, con el ancho configurado, y reanuda.
   *
   * Es también el «restablecer» del widget: como seguir en vivo conserva el
   * zoom que tenga el operador, hace falta un sitio que devuelva la ventana de
   * fábrica sin tener que ir al Inspector.
   */
  const volverAVivo = useCallback(() => {
    siguiendoRef.current = true;
    setSiguiendo(true);
    const u = plot.current;
    const r = bufferRef.current?.rango();
    if (u && r) u.setScale('x', { min: r[1] - cfg.ventanaSeg, max: r[1] });
  }, [cfg.ventanaSeg]);

  // ---- Muestreo. Alimenta el búfer y empuja los datos al canvas -------- //
  useBufferTrend(variables, ids, cfg.retencionSeg, (b) => {
    bufferRef.current = b;
    const u = plot.current;
    if (!u) return;
    // El gráfico se rehace en un efecto POSTERIOR a este. Entre que se quita
    // una serie del Inspector y que uPlot se reconstruye hay una pasada en la
    // que el búfer tiene una columna menos que series tiene el gráfico, y
    // `setData` reventaría leyendo una columna que no existe.
    if (u.series.length !== ids.length + 1) return;
    if (!b.alineado(ids)) return;
    // `false` = no recalcular escalas: si el usuario está mirando el pasado,
    // un dato nuevo no puede arrastrarle la vista al presente.
    u.setData(b.datos(ids), false);
    if (siguiendoRef.current) {
      const r = b.rango();
      if (r) {
        // SE CONSERVA EL ANCHO QUE HAY, no `ventanaSeg`.
        //
        // Forzar aquí la ventana configurada deshacía el zoom del operador en
        // la siguiente muestra: acercabas, y 100 ms después el gráfico volvía
        // solo a los 60 s de siempre. `ventanaSeg` es el ancho INICIAL, no una
        // camisa de fuerza; una vez que alguien ajusta el zoom, seguir en vivo
        // significa mantener SU ancho pegado al presente. El ancho de fábrica
        // se recupera con la píldora «EN VIVO» o cambiando la ventana.
        const min = u.scales.x.min;
        const max = u.scales.x.max;
        const ancho =
          min != null && max != null && max > min ? max - min : cfg.ventanaSeg;
        u.setScale('x', { min: r[1] - ancho, max: r[1] });
      }
    }
  });

  // ---- Creación del gráfico (y su ResizeObserver) ---------------------- //
  //
  // El observador se monta AQUÍ y no en un efecto aparte. Antes vivía en un
  // efecto con dependencias vacías que corría al montar, cuando el widget
  // todavía no tiene series y el div que hay que observar no existe: salía por
  // la guarda y no volvía a correr nunca. Resultado: `setSize()` no se llamaba
  // jamás y el canvas se quedaba con el tamaño de su nacimiento. Atado al
  // gráfico, los dos aparecen y desaparecen juntos y eso no puede repetirse.
  const firma = JSON.stringify({
    ids,
    nombres: dibujables.map(({ s }) => s.etiqueta),
    colores: dibujables.map(({ s, i }) => colorEfectivo(s.color, i, isDark)),
    grosores: dibujables.map(({ s }) => s.grosor ?? 2),
    isDark,
    colorRejilla,
    colorTinta,
    grid: cfg.mostrarRejilla,
    auto: cfg.autoEscala,
    min: cfg.min,
    max: cfg.max,
    interactivo,
  });

  useEffect(() => {
    const destino = contenedor.current;
    const marco = caja.current;
    if (!destino || !marco || ids.length === 0) return;

    const nombres = dibujables.map(
      ({ s, i }) =>
        s.etiqueta ||
        variables.find((v) => v.id === s.variableId)?.name ||
        `Serie ${i + 1}`
    );
    const colores = dibujables.map(({ s, i }) => colorEfectivo(s.color, i, isDark));
    const grosores = dibujables.map(({ s }) => s.grosor ?? 2);

    const u = new uPlot(
      construirOpciones({
        cfg,
        ids,
        nombres,
        colores,
        grosores,
        ancho: marco.clientWidth,
        alto: marco.clientHeight,
        tema,
        colorRejilla,
        colorTinta,
        interactivo,
        interaccion,
        alCambiarEscala,
        alMoverCursor,
      }),
      (bufferRef.current ?? new BufferTrend()).datos(ids),
      destino
    );
    plot.current = u;

    // Encuadre inicial: la ventana pegada al presente, haya datos o no.
    const r = bufferRef.current?.rango();
    const fin = r ? r[1] : Date.now() / 1000;
    u.setScale('x', { min: fin - cfg.ventanaSeg, max: fin });

    let ro: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(() => {
        u.setSize({
          width: Math.max(1, marco.clientWidth),
          height: Math.max(1, marco.clientHeight),
        });
      });
      ro.observe(marco);
    }

    return () => {
      ro?.disconnect();
      u.destroy();
      plot.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [firma]);

  // ---- Ventana: al cambiarla, reencuadrar si se está en vivo ----------- //
  useEffect(() => {
    if (!siguiendoRef.current) return;
    const u = plot.current;
    if (!u) return;
    const r = bufferRef.current?.rango();
    const fin = r ? r[1] : Date.now() / 1000;
    u.setScale('x', { min: fin - cfg.ventanaSeg, max: fin });
  }, [cfg.ventanaSeg]);

  // ---- Lo que se lee ---------------------------------------------------- //
  const sinSeries = cfg.series.length === 0;
  const puntos = bufferRef.current?.puntos ?? 0;
  const esperando = !sinSeries && puntos < 2;
  const señalando = idxCursor !== null && interactivo;
  const tSeñalado =
    señalando && bufferRef.current ? bufferRef.current.t[idxCursor as number] : null;

  const etiquetaVista = señalando && tSeñalado != null
    ? fmtInstante(tSeñalado)
    : vista
    ? `${fmtHora(vista.min, vista.max - vista.min)} → ${fmtHora(
        vista.max,
        vista.max - vista.min
      )}`
    : '';
  const duracionVista = vista ? fmtDuracion(vista.max - vista.min) : '';

  /** Valor que enseña la leyenda: el del instante señalado, o el de ahora. */
  const valorDe = (variableId: string): number | null => {
    if (señalando && bufferRef.current) {
      const col = bufferRef.current.columna(variableId);
      const v = col?.[idxCursor as number];
      return v === undefined ? null : v;
    }
    const v = variables.find((x) => x.id === variableId);
    if (!v) return null;
    const n = typeof v.value === 'number' ? v.value : Number(v.value);
    return Number.isFinite(n) ? n : null;
  };

  const fuerte = isDark ? '#e2e8f0' : '#0f172a';

  // Prefijo compartido por todos los nombres, para no gastar la leyenda en
  // repetir `PLC_PRG.` cinco veces y truncar lo que sí distingue.
  const prefijo = prefijoComun(
    dibujables.map(
      ({ s }) =>
        s.etiqueta || variables.find((v) => v.id === s.variableId)?.name || ''
    )
  );

  // ---- Estado vacío: ni siquiera hay series configuradas --------------- //
  if (sinSeries) {
    return (
      <div style={marcoWidget(pCaja, fondo, tema)}>
        <div
          style={{
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 8,
            padding: 14,
            textAlign: 'center',
          }}
        >
          <ActivityIcon
            style={{ width: 24, height: 24, color: colorTinta, opacity: 0.45 }}
          />
          <p style={{ margin: 0, fontSize: 12, fontWeight: 600, color: colorTinta }}>
            Tendencia sin variables
          </p>
          <p
            style={{
              margin: 0,
              fontSize: 11,
              lineHeight: 1.5,
              color: tema.tintaSuave,
              maxWidth: 240,
            }}
          >
            Agrégalas en el Inspector para verlas graficadas contra el tiempo.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div style={marcoWidget(pCaja, fondo, tema)}>
      {/* ── Cabecera ─────────────────────────────────────────────────
          Estado, qué tramo se está mirando y los mandos. En el Diseñador se
          pinta apagada: sigue explicando qué hace el widget, pero no se queda
          con el puntero, que ahí sirve para colocarlo. */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          height: 34,
          padding: '0 8px',
          flexShrink: 0,
          background: tema.chapa,
          borderBottom: `1px solid ${tema.borde}`,
          opacity: interactivo ? 1 : 0.5,
          pointerEvents: interactivo ? 'auto' : 'none',
        }}
      >
        <button
          type="button"
          onClick={volverAVivo}
          title={
            siguiendo
              ? 'Siguiendo el dato más reciente'
              : 'Pausado. Pulsa para volver al presente'
          }
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 5,
            height: 21,
            padding: '0 9px',
            flexShrink: 0,
            borderRadius: 999,
            border: `1px solid ${siguiendo ? tema.vivo : tema.pausa}`,
            background: `${siguiendo ? tema.vivo : tema.pausa}1f`,
            color: siguiendo ? tema.vivo : tema.pausa,
            fontSize: 9.5,
            fontWeight: 700,
            letterSpacing: '.09em',
            cursor: 'pointer',
            fontFamily: 'inherit',
          }}
        >
          <span
            style={{
              width: 6,
              height: 6,
              borderRadius: 999,
              background: 'currentColor',
              flexShrink: 0,
            }}
          />
          {siguiendo ? 'EN VIVO' : 'PAUSADO'}
        </button>

        <span
          style={{
            flex: 1,
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            fontSize: 10.5,
            fontVariantNumeric: 'tabular-nums',
            color: señalando ? fuerte : tema.tintaSuave,
            fontWeight: señalando ? 600 : 400,
          }}
        >
          {etiquetaVista}
        </span>

        {duracionVista && !señalando && (
          <span
            style={{
              flexShrink: 0,
              fontSize: 9.5,
              padding: '2px 6px',
              borderRadius: 4,
              color: tema.tintaSuave,
              border: `1px solid ${tema.borde}`,
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            {duracionVista}
          </span>
        )}

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 1,
            flexShrink: 0,
            padding: 2,
            borderRadius: 7,
            border: `1px solid ${tema.borde}`,
          }}
        >
          <BotonBarra
            tema={tema}
            titulo="Atrás en el tiempo"
            onClick={() => plot.current && desplazar(plot.current, -0.3, interaccion)}
          >
            <ChevronLeftIcon style={{ width: 13, height: 13 }} />
          </BotonBarra>
          <BotonBarra
            tema={tema}
            titulo="Adelante en el tiempo"
            onClick={() => plot.current && desplazar(plot.current, 0.3, interaccion)}
          >
            <ChevronRightIcon style={{ width: 13, height: 13 }} />
          </BotonBarra>
          <span style={{ width: 1, height: 14, background: tema.borde, margin: '0 3px' }} />
          <BotonBarra
            tema={tema}
            titulo="Alejar (ver más tiempo)"
            onClick={() => plot.current && zoom(plot.current, 1.5, interaccion)}
          >
            <ZoomOutIcon style={{ width: 13, height: 13 }} />
          </BotonBarra>
          <BotonBarra
            tema={tema}
            titulo="Acercar (ver menos tiempo)"
            onClick={() => plot.current && zoom(plot.current, 1 / 1.5, interaccion)}
          >
            <ZoomInIcon style={{ width: 13, height: 13 }} />
          </BotonBarra>
          <BotonBarra
            tema={tema}
            titulo="Ver todo lo guardado en memoria"
            onClick={() => plot.current && ajustar(plot.current, interaccion)}
          >
            <MaximizeIcon style={{ width: 13, height: 13 }} />
          </BotonBarra>
        </div>
      </div>

      {/* ── El gráfico ────────────────────────────────────────────── */}
      <div
        ref={caja}
        style={{
          position: 'relative',
          flex: 1,
          minHeight: 0,
          background: tema.superficie,
        }}
      >
        <div ref={contenedor} style={{ position: 'absolute', inset: 0 }} />

        {esperando && (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 7,
              pointerEvents: 'none',
              color: tema.tintaSuave,
              fontSize: 11,
            }}
          >
            <Loader2Icon className="animate-spin" style={{ width: 13, height: 13 }} />
            Esperando datos…
          </div>
        )}
      </div>

      {/* ── Leyenda ───────────────────────────────────────────────────
          Rejilla de columnas iguales, no un párrafo que se parte donde caiga:
          con seis series los nombres quedaban a saltos y el número que
          interesa no estaba dos veces en el mismo sitio.

          Enseña el valor DEL INSTANTE SEÑALADO cuando el cursor está sobre el
          gráfico, y el valor en vivo cuando no. Es lo que convierte «vi un pico
          hace dos minutos» en un número que se puede leer. */}
      {cfg.mostrarLeyenda && (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(172px, 1fr))',
            gap: '1px 14px',
            padding: '6px 10px',
            maxHeight: '40%',
            overflowY: 'auto',
            flexShrink: 0,
            background: tema.chapa,
            borderTop: `1px solid ${tema.borde}`,
          }}
        >
          {dibujables.map(({ s, i }) => {
            const v = variables.find((x) => x.id === s.variableId);
            const valor = valorDe(s.variableId);
            const completo = s.etiqueta || v?.name || '—';
            const corto = prefijo && completo.startsWith(prefijo)
              ? completo.slice(prefijo.length)
              : completo;
            return (
              <span
                key={s.id}
                title={completo}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  minWidth: 0,
                  fontSize: tamLeyenda,
                  lineHeight: 1.6,
                }}
              >
                <span
                  style={{
                    width: 12,
                    height: 3,
                    borderRadius: 2,
                    background: colorEfectivo(s.color, i, isDark),
                    flexShrink: 0,
                  }}
                />
                <span
                  style={{
                    flex: 1,
                    minWidth: 0,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    color: tema.tintaSuave,
                  }}
                >
                  {corto}
                </span>
                <b
                  style={{
                    flexShrink: 0,
                    fontWeight: 600,
                    color: fuerte,
                    fontVariantNumeric: 'tabular-nums',
                  }}
                >
                  {fmtNum(valor)}
                  {v?.unit ? ` ${v.unit}` : ''}
                </b>
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** Caja exterior del widget, común a todos sus estados. */
function marcoWidget(
  pCaja: ReturnType<typeof estiloDeParte>,
  fondo: string,
  tema: TemaGrafico
): React.CSSProperties {
  return {
    display: 'flex',
    flexDirection: 'column',
    width: '100%',
    height: '100%',
    boxSizing: 'border-box',
    overflow: 'hidden',
    background: fondo,
    borderRadius: pCaja.borderRadius ?? 8,
    border: pCaja.borderWidth
      ? `${pCaja.borderWidth}px solid ${pCaja.borderColor}`
      : `1px solid ${tema.borde}`,
    opacity: pCaja.opacity,
    fontFamily: 'Inter, system-ui, Arial, sans-serif',
  };
}

/**
 * Botón de la barra, con estado de paso del ratón.
 *
 * Existe porque los estilos van en línea (el widget se dibuja igual en el
 * lienzo, en la Vista previa y dentro de un contenedor) y `:hover` no se
 * puede expresar así. Un mando de un HMI que no responde al pasar por encima
 * parece roto.
 */
function BotonBarra({
  tema,
  titulo,
  onClick,
  children,
}: {
  tema: TemaGrafico;
  titulo: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  const [encima, setEncima] = useState(false);
  return (
    <button
      type="button"
      title={titulo}
      aria-label={titulo}
      onClick={onClick}
      onPointerEnter={() => setEncima(true)}
      onPointerLeave={() => setEncima(false)}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 24,
        height: 22,
        padding: 0,
        border: 'none',
        borderRadius: 5,
        background: encima ? tema.chapa : 'transparent',
        color: encima ? tema.tinta : tema.tintaSuave,
        cursor: 'pointer',
        transition: 'background .12s, color .12s',
      }}
    >
      {children}
    </button>
  );
}

// ─── Inspector ───────────────────────────────────────────────────

const INPUT =
  'w-full rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-navy outline-none transition focus:border-siemens focus:ring-2 focus:ring-siemens/20 dark:border-navy-slate dark:bg-navy dark:text-slate-100';

/** Id del `datalist` que ofrece los tonos validados dentro del selector. */
const LISTA_TONOS = 'trend-tonos-validados';

const GROSORES = [
  { v: 1, t: 'Fina' },
  { v: 2, t: 'Normal' },
  { v: 3, t: 'Gruesa' },
];

function InspectorTrend({ config, setConfig }: InspectorCtx) {
  const cfg = leerConfigTrend(config);
  const { selectedVariables, isDark } = useAppStore();

  // Solo numéricas: una tendencia de un bool sería una escalera entre 0 y 1 y
  // de un texto no se puede dibujar nada.
  const numericas = selectedVariables.filter(
    (v) => v.type === 'int' || v.type === 'double'
  );

  const set = (patch: Partial<ConfigTrend>) => setConfig({ ...cfg, ...patch });

  const agregar = () => {
    const usadas = new Set(cfg.series.map((s) => s.variableId));
    const libre = numericas.find((v) => !usadas.has(v.id));
    set({
      series: [
        ...cfg.series,
        {
          id: nuevoId(),
          variableId: libre?.id ?? '',
          etiqueta: '',
          color: '',
          grosor: 2,
        },
      ],
    });
  };

  const editar = (id: string, patch: Partial<SerieTrend>) =>
    set({ series: cfg.series.map((s) => (s.id === id ? { ...s, ...patch } : s)) });

  const borrar = (id: string) =>
    set({ series: cfg.series.filter((s) => s.id !== id) });

  // Colores repetidos. No se bloquea nada: se avisa. Dos series del mismo
  // color pueden ser intencionales (dos sondas del mismo lazo), y decidirlo es
  // de quien diseña la pantalla, no del editor.
  const efectivos = cfg.series.map((s, i) =>
    colorEfectivo(s.color, i, isDark).toLowerCase()
  );
  const repetidos = new Set(efectivos.filter((c, i) => efectivos.indexOf(c) !== i));

  const tonos = sugerencias(isDark);

  return (
    <>
      {/* Los tonos validados salen como sugerencia DENTRO del selector de
          color del navegador (Chrome y Edge pintan el datalist como swatches),
          así que se ofrecen sin gastar sitio en el panel. */}
      <datalist id={LISTA_TONOS}>
        {tonos.map((t) => (
          <option key={t.tono} value={t.color} />
        ))}
      </datalist>

      <div>
        <div className="mb-1.5 flex items-center justify-between">
          <span className="text-xs font-medium text-slate-500 dark:text-slate-400">
            Variables
          </span>
          <span className="text-[10px] text-slate-400">
            {cfg.series.length} {cfg.series.length === 1 ? 'serie' : 'series'}
          </span>
        </div>

        {numericas.length === 0 && (
          <p className="mb-2 rounded-lg bg-amber-50 px-2.5 py-2 text-[11px] leading-relaxed text-amber-700 dark:bg-amber-500/10 dark:text-amber-400">
            No hay variables numéricas seleccionadas. Márcalas en Configuración
            → Controladores para poder graficarlas.
          </p>
        )}

        <div className="space-y-1.5">
          {cfg.series.map((s, i) => {
            const efectivo = colorEfectivo(s.color, i, isDark);
            const repetido = repetidos.has(efectivo.toLowerCase());
            return (
              <div
                key={s.id}
                className="group flex items-start gap-1.5 rounded-lg border border-slate-200 bg-white p-1.5 dark:border-navy-slate dark:bg-navy"
              >
                {/* El color es editable: ya no hay tope de series, así que a
                    partir de la séptima el reparto automático repite tonos y
                    hay que poder separarlas a mano. */}
                <div className="flex shrink-0 flex-col items-center gap-1 pt-0.5">
                  <input
                    type="color"
                    list={LISTA_TONOS}
                    value={efectivo}
                    onChange={(e) => editar(s.id, { color: e.target.value })}
                    title={
                      s.color
                        ? `Color propio ${s.color}`
                        : `Color automático (serie ${i + 1})`
                    }
                    aria-label={`Color de la serie ${i + 1}`}
                    className={`h-6 w-6 cursor-pointer rounded border bg-transparent p-0 ${
                      repetido
                        ? 'border-amber-500 ring-2 ring-amber-500/30'
                        : 'border-slate-200 dark:border-navy-slate'
                    }`}
                  />
                  {s.color && (
                    <button
                      type="button"
                      onClick={() => editar(s.id, { color: '' })}
                      title="Volver al color automático"
                      className="text-[9px] leading-none text-slate-400 transition hover:text-siemens"
                    >
                      auto
                    </button>
                  )}
                </div>

                <div className="min-w-0 flex-1 space-y-1">
                  <select
                    value={s.variableId}
                    onChange={(e) => editar(s.id, { variableId: e.target.value })}
                    className={INPUT}
                  >
                    <option value="">— Elegir variable —</option>
                    {numericas.map((v) => (
                      <option key={v.id} value={v.id}>
                        {v.name} ({v.type})
                      </option>
                    ))}
                  </select>
                  <div className="flex gap-1">
                    <input
                      type="text"
                      value={s.etiqueta}
                      onChange={(e) => editar(s.id, { etiqueta: e.target.value })}
                      placeholder="Nombre en la leyenda (opcional)"
                      className={`${INPUT} text-[11px]`}
                    />
                    <select
                      value={String(s.grosor ?? 2)}
                      onChange={(e) => editar(s.id, { grosor: Number(e.target.value) })}
                      title="Grosor de la línea"
                      className={`${INPUT} w-[86px] shrink-0 text-[11px]`}
                    >
                      {GROSORES.map((g) => (
                        <option key={g.v} value={g.v}>
                          {g.t}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                <button
                  type="button"
                  onClick={() => borrar(s.id)}
                  title="Quitar serie"
                  aria-label="Quitar serie"
                  className="mt-0.5 shrink-0 rounded p-1 text-slate-400 opacity-0 transition hover:bg-red-50 hover:text-state-error focus-visible:opacity-100 group-hover:opacity-100 dark:hover:bg-state-error/10"
                >
                  <Trash2Icon className="h-3.5 w-3.5" />
                </button>
              </div>
            );
          })}
        </div>

        <button
          type="button"
          onClick={agregar}
          className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-slate-300 py-1.5 text-xs font-semibold text-slate-500 transition hover:border-siemens hover:text-siemens dark:border-navy-slate dark:text-slate-400"
        >
          <PlusIcon className="h-3.5 w-3.5" />
          Agregar variable
        </button>

        {repetidos.size > 0 && (
          <p className="mt-2 rounded-lg bg-amber-50 px-2.5 py-2 text-[11px] leading-relaxed text-amber-700 dark:bg-amber-500/10 dark:text-amber-400">
            Hay series que comparten color. Los seis tonos del catálogo están
            validados para daltonismo; a partir de la séptima serie el reparto
            automático los repite, así que conviene elegir el color a mano.
          </p>
        )}
      </div>

      <label className="block">
        <span className="mb-1 block text-xs font-medium text-slate-500 dark:text-slate-400">
          Ventana de tiempo
        </span>
        <select
          value={String(cfg.ventanaSeg)}
          onChange={(e) => set({ ventanaSeg: Number(e.target.value) })}
          className={INPUT}
        >
          {VENTANAS.map((v) => (
            <option key={v.v} value={v.v}>
              {v.t}
            </option>
          ))}
        </select>
      </label>

      <label className="block">
        <span className="mb-1 block text-xs font-medium text-slate-500 dark:text-slate-400">
          Memoria para retroceder
        </span>
        <select
          value={String(cfg.retencionSeg)}
          onChange={(e) => set({ retencionSeg: Number(e.target.value) })}
          className={INPUT}
        >
          {RETENCIONES.map((r) => (
            <option key={r.v} value={r.v}>
              {r.t}
            </option>
          ))}
        </select>
        <span className="mt-1 block text-[10px] leading-relaxed text-slate-400">
          Cuánto se guarda en el navegador. Es hasta dónde se puede desplazar
          hacia atrás; la ventana de arriba es solo lo que se ve de un vistazo.
        </span>
      </label>

      <label className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-slate-500 dark:text-slate-400">
          Escala automática
        </span>
        <input
          type="checkbox"
          checked={cfg.autoEscala}
          onChange={(e) => set({ autoEscala: e.target.checked })}
          className="h-4 w-4 rounded border-slate-300 text-siemens focus:ring-2 focus:ring-siemens/40 dark:border-navy-slate dark:bg-navy"
        />
      </label>

      {!cfg.autoEscala && (
        <div className="grid grid-cols-2 gap-2">
          <label className="block">
            <span className="mb-1 block text-[11px] text-slate-400">Mínimo</span>
            <input
              type="text"
              inputMode="decimal"
              value={cfg.min}
              onChange={(e) => set({ min: e.target.value })}
              placeholder="0"
              className={INPUT}
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-[11px] text-slate-400">Máximo</span>
            <input
              type="text"
              inputMode="decimal"
              value={cfg.max}
              onChange={(e) => set({ max: e.target.value })}
              placeholder="100"
              className={INPUT}
            />
          </label>
        </div>
      )}

      <label className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-slate-500 dark:text-slate-400">
          Mostrar leyenda
        </span>
        <input
          type="checkbox"
          checked={cfg.mostrarLeyenda}
          onChange={(e) => set({ mostrarLeyenda: e.target.checked })}
          className="h-4 w-4 rounded border-slate-300 text-siemens focus:ring-2 focus:ring-siemens/40 dark:border-navy-slate dark:bg-navy"
        />
      </label>

      <label className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-slate-500 dark:text-slate-400">
          Mostrar rejilla
        </span>
        <input
          type="checkbox"
          checked={cfg.mostrarRejilla}
          onChange={(e) => set({ mostrarRejilla: e.target.checked })}
          className="h-4 w-4 rounded border-slate-300 text-siemens focus:ring-2 focus:ring-siemens/40 dark:border-navy-slate dark:bg-navy"
        />
      </label>

      <p className="rounded-lg bg-slate-100 px-2.5 py-2 text-[11px] leading-relaxed text-slate-500 dark:bg-navy-slate/40 dark:text-slate-400">
        Enseña {fmtDuracion(cfg.ventanaSeg)} y guarda{' '}
        {RETENCIONES.find((r) => r.v === cfg.retencionSeg)?.t ??
          fmtDuracion(cfg.retencionSeg)}{' '}
        en memoria. En la <b>Vista previa</b>: arrastra para retroceder, rueda
        para el zoom, pasa el cursor para leer el valor de un instante y doble
        clic para volver al presente. No guarda nada en disco.
      </p>
    </>
  );
}

// ─── Definición ──────────────────────────────────────────────────

export const trendWidget: CustomWidgetDef = {
  kind: 'custom:trend',
  label: 'Tendencia',
  category: 'Datos',
  icon: LineChartIcon,
  defaultWidth: 480,
  defaultHeight: 300,
  render: (ctx) => <Trend {...ctx} />,
  inspector: (ctx) => <InspectorTrend {...ctx} />,
  defaultConfig: CONFIG_TREND,
};
