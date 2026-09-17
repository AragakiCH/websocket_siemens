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
import { createPortal } from 'react-dom';
import {
  LineChartIcon,
  DatabaseIcon,
  RefreshCwIcon,
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
import { Regla, type PosRegla, type FilaRegla } from './Regla';
import {
  useHistorico,
  resolverRango,
  RANGOS,
  aValorLocal,
  ventanaUtc,
} from './historico';
import { listarGrupos, type GrupoHistorico } from '../../../../services/historicoApi';
import { partirId } from '../../../../services/escrituraApi';
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

/** De dónde salen los datos del gráfico. */
export type OrigenTrend = 'vivo' | 'historico';

export interface ConfigTrend {
  series: SerieTrend[];
  /**
   * `vivo` = lo que llega por WebSocket, guardado en memoria (lo de siempre).
   * `historico` = lo que el historizador escribió en la base de datos.
   *
   * No son dos widgets porque el que mira la pantalla quiere lo mismo en los
   * dos casos —estas líneas, contra el tiempo, con su regla— y duplicar el
   * widget habría duplicado también la leyenda, la regla y los gestos.
   */
  origen: OrigenTrend;
  /** Grupo del historizador. Solo en modo `historico`. */
  grupoId: string;
  /** Atajo de rango (`1h`, `8h`…) o `personalizado`. Ver RANGOS. */
  rango: string;
  /** Solo si `rango === 'personalizado'`. Formato `datetime-local`. */
  desde: string;
  hasta: string;
  /** Puntos que se piden POR SERIE. Ver el porqué en historicoApi.ts. */
  limiteSerie: number;
  /** La línea vertical con la caja de valores. */
  mostrarRegla: boolean;
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
  origen: 'vivo',
  grupoId: '',
  rango: '1h',
  desde: '',
  hasta: '',
  limiteSerie: 1000,
  mostrarRegla: true,
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
    // Todo lo del histórico entra con valores por defecto: una pantalla
    // guardada antes de que existiera el modo abre en `vivo` y se comporta
    // exactamente como siempre. Cero migración.
    origen: c.origen === 'historico' ? 'historico' : 'vivo',
    grupoId: String(c.grupoId ?? ''),
    rango: String(c.rango ?? '1h'),
    desde: String(c.desde ?? ''),
    hasta: String(c.hasta ?? ''),
    limiteSerie: Number(c.limiteSerie) > 0 ? Number(c.limiteSerie) : 1000,
    mostrarRegla: c.mostrarRegla !== false,
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
 * Fecha Y hora, en hora local, para las pistas de «dónde sí hay datos».
 *
 * Lleva el día a propósito: la mitad de las veces el último registro es de
 * ayer, y una hora suelta («17:50») invita a buscarla en el día de hoy.
 */
function fmtInstanteLargo(t: number): string {
  const d = new Date(t * 1000);
  return (
    `${dos(d.getDate())}/${dos(d.getMonth() + 1)} ` +
    `${dos(d.getHours())}:${dos(d.getMinutes())}:${dos(d.getSeconds())}`
  );
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

// ─── La línea del cursor de uPlot, apagada ───────────────────────
//
// EL FALLO DE LAS DOS REGLAS
// uPlot pinta SU propia línea vertical de cursor (`.u-cursor-x`), y este widget
// pinta la suya —la regla, con la caja de valores pegada—. Las dos a la vez
// son dos líneas discontinuas paralelas: exactamente lo que se veía en
// pantalla, y encima separadas entre sí, lo que hacía pensar que la regla
// estaba mal cuando lo que sobraba era la otra.
//
// POR QUÉ NO SE APAGA CON `cursor: { x: false }`
// Porque esa opción no solo quita la línea: también deja de calcular la
// posición horizontal del cursor. Sin ella no hay `cursor.left` ni
// `cursor.idx`, o sea, no hay regla, no hay caja y no hay leyenda. Se deja el
// seguimiento intacto y se esconde solo el div.
const CLASE_TREND = 'psi-trend';

let estilosPuestos = false;
function asegurarEstilos(): void {
  if (estilosPuestos || typeof document === 'undefined') return;
  estilosPuestos = true;
  const st = document.createElement('style');
  st.setAttribute('data-psi', 'trend');
  st.textContent = `.${CLASE_TREND} .u-cursor-x{display:none!important}`;
  document.head.appendChild(st);
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
  /** En histórico se pintan marcadores; ver más abajo. */
  historico: boolean;
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

      // ── LA CAUSA REAL DEL DESCUADRE DE LA REGLA ────────────────────────
      //
      // uPlot calcula la posición del ratón así:
      //
      //     cursor.left = e.clientX - over.getBoundingClientRect().left
      //
      // `getBoundingClientRect()` devuelve píxeles **de pantalla**, ya
      // escalados. Pero TODO lo demás dentro de uPlot —el ancho del área de
      // dibujo, la conversión píxel↔valor, la posición de su propia línea de
      // cursor— trabaja en píxeles **de maquetación**, los que se le pasaron
      // en `setSize()`.
      //
      // Mientras el lienzo se ve al 100 % los dos números coinciden y no pasa
      // nada. Pero la Vista previa escala el lienzo para que quepa en la
      // ventana (`transform: scale(...)` en Preview.tsx), y ahí dejan de
      // coincidir: `cursor.left` viene inflado por el factor de escala. De ahí
      // que la regla se separase del puntero cada vez más hacia la derecha —y
      // que en el Diseñador, sin escalar, pareciera correcta.
      //
      // Y no era solo la línea: con `cursor.left` mal, el índice que uPlot
      // busca también sale mal, así que la caja estaba leyendo el valor de OTRA
      // muestra. El síntoma visible era la regla; el fallo de verdad, el dato.
      //
      // `move` es el gancho que uPlot ofrece justo para esto: recibe la
      // posición cruda y devuelve la corregida. Se divide por el factor real
      // —ancho de maquetación entre ancho en pantalla— y todo vuelve a la misma
      // unidad. Sin escalado el factor es 1 y esto no hace nada.
      move: (u: uPlot, izq: number, arr: number): [number, number] => {
        const over = u.over as HTMLDivElement;
        const r = over.getBoundingClientRect();
        const anchoLayout = over.clientWidth;
        const altoLayout = over.clientHeight;
        if (!(r.width > 0) || !(anchoLayout > 0)) return [izq, arr];
        const kx = anchoLayout / r.width;
        const ky = r.height > 0 && altoLayout > 0 ? altoLayout / r.height : kx;
        // Un factor absurdo (elemento a medio montar, oculto) se ignora: mejor
        // sin corregir que mandando el cursor al limbo.
        if (!(kx > 0.05 && kx < 20)) return [izq, arr];
        return [izq * kx, arr * ky];
      },
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
      ...p.ids.map((_id, i) => {
        const serie: uPlot.Series = {
          label: p.nombres[i],
          stroke: p.colores[i],
          width: p.grosores[i],
          // Un hueco es un hueco: si el PLC dejó de mandar, no se une el punto
          // de antes con el de después fingiendo que hubo continuidad.
          spanGaps: false,
        };
        // EN VIVO los marcadores se apagan: llegan diez muestras por segundo y
        // la línea se convertiría en una tira de puntos.
        //
        // EN HISTÓRICO se dejan en automático, y esto NO es cosmético. Un tramo
        // puede traer UNA sola muestra —o muestras sueltas muy separadas— y una
        // línea de un punto no dibuja absolutamente nada: el dato llegó, está en
        // `u.data`, la leyenda lo enseña… y el gráfico sale en blanco. uPlot
        // decide solo cuándo pintarlos según lo separados que estén, que es
        // justo el criterio que hace falta.
        if (!p.historico) serie.points = { show: false };
        return serie;
      }),
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

  // Dónde está la regla, en píxeles del contenedor. Se saca de `u.over`, que
  // es el div del ÁREA DE DIBUJO: sus `offsetLeft/Top` ya descuentan los ejes,
  // así que no hay que pelearse con `bbox` ni con el devicePixelRatio.
  const [posRegla, setPosRegla] = useState<PosRegla | null>(null);

  // EL ÁREA DE DIBUJO DE uPlot, EN ESTADO.
  //
  // Hace falta durante el render (no solo en un callback) porque la regla se
  // monta DENTRO de ese div con un portal. Ver el comentario de `alMoverCursor`.
  const [areaDibujo, setAreaDibujo] = useState<HTMLDivElement | null>(null);

  const alMoverCursor = useCallback((u: uPlot) => {
    const i = u.cursor.idx;
    const nuevo = i === null || i === undefined ? null : i;
    setIdxCursor((prev) => (prev === nuevo ? prev : nuevo));

    const izq = u.cursor.left;
    const over = u.over as HTMLDivElement | undefined;
    const marco = caja.current;
    if (nuevo === null || izq == null || izq < 0 || !over || !marco) {
      setPosRegla((prev) => (prev === null ? prev : null));
      return;
    }
    // ── SIN ARITMÉTICA. AQUÍ ESTÁ EL ARREGLO DE VERDAD ────────────────
    //
    // Los dos intentos anteriores fueron traducir `u.cursor.left` —que está en
    // píxeles DENTRO de `.u-over`, el área de dibujo— a coordenadas del marco
    // del widget. Primero con `offsetLeft` (mal: se mide contra un div interno
    // de uPlot) y luego con rectángulos corregidos por escala (mejor, pero
    // sigue mezclando píxeles de pantalla con píxeles de maquetación, y en la
    // Vista previa el lienzo va escalado).
    //
    // Toda esa traducción sobra. `.u-over` está posicionado, así que un hijo
    // absoluto suyo colocado en `left: cursor.left` cae EXACTAMENTE bajo el
    // puntero — por definición, sea cual sea el zoom, la escala del lienzo, el
    // ancho del eje Y o dónde esté el widget. La regla se monta ahí dentro con
    // un portal (más abajo) y este callback ya solo copia números.
    //
    // No hay `getBoundingClientRect()`, no hay factor de corrección, no hay
    // nada que pueda descuadrarse. Un problema de conversión de coordenadas se
    // arregla mejor eliminando la conversión que afinándola.
    const p: PosRegla = {
      x: Math.round(izq),
      top: 0,
      alto: over.clientHeight,
      ancho: over.clientWidth
    };
    // Se compara antes de escribir: `setCursor` se dispara en cada píxel de
    // movimiento y sin esto habría un render por píxel recorrido.
    setPosRegla((prev) =>
    prev && prev.x === p.x && prev.top === p.top && prev.alto === p.alto ?
    prev :
    p
    );
  }, []);

  // ── EL MODO, EN REFS ──
  //
  // `interaccion` es un `useMemo([])`: se crea UNA vez y se lo queda el plugin
  // de gestos, que vive fuera del ciclo de render. Si leyera `esHistorico`
  // directamente se quedaría con el valor del primer render para siempre.
  //
  // Esto era el fallo del zoom en histórico: `limites()` devolvía el rango del
  // búfer EN VIVO —unos minutos alrededor de ahora— y `encajar()` aplastaba
  // contra él cualquier intento de alejar o desplazarse por un rango de ayer.
  // El gesto se hacía, y el gráfico volvía solo a su sitio.
  const esHistoricoRef = useRef(false);
  const rangoHistRef = useRef<[number, number] | null>(null);

  const interaccion = useMemo<OpcionesInteraccion>(
    () => ({
      limites: () =>
      esHistoricoRef.current ?
      rangoHistRef.current :
      bufferRef.current?.rango() ?? null,
      // En histórico no se «sigue» nada: no llega dato nuevo. Devolver false
      // hace que el zoom ancle el cursor —que es lo que se espera cuando estás
      // inspeccionando— en vez del borde derecho.
      siguiendo: () => !esHistoricoRef.current && siguiendoRef.current,
      alTomarControl: () => {
        if (esHistoricoRef.current) return;
        if (!siguiendoRef.current) return;
        siguiendoRef.current = false;
        setSiguiendo(false);
      },
      alVolverAlBorde: () => {
        if (esHistoricoRef.current) return;
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
    const u = plot.current;
    // En histórico el doble clic no puede «volver al presente» —no hay
    // presente que enseñar— así que hace lo equivalente: devolver la vista al
    // rango entero que se pidió, deshaciendo el zoom.
    if (esHistoricoRef.current) {
      const r = rangoHistRef.current;
      if (u && r) u.setScale('x', { min: r[0], max: r[1] });
      return;
    }
    siguiendoRef.current = true;
    setSiguiendo(true);
    const r = bufferRef.current?.rango();
    if (u && r) u.setScale('x', { min: r[1] - cfg.ventanaSeg, max: r[1] });
  }, [cfg.ventanaSeg]);

  // ---- MODO HISTÓRICO --------------------------------------------------- //
  //
  // El hook se llama SIEMPRE (un hook no puede ir dentro de un `if`) pero se
  // apaga con `activo`: en modo vivo no pide nada y devuelve vacío.
  const esHistorico = cfg.origen === 'historico';
  const ventanaHist = useMemo(
    () => resolverRango(cfg.rango, cfg.desde, cfg.hasta),
    // Los presets se recalculan contra el reloj en cada recarga, no aquí: esto
    // solo cambia cuando cambia la CONFIGURACIÓN.
    [cfg.rango, cfg.desde, cfg.hasta]
  );
  const hist = useHistorico(
    esHistorico,
    cfg.grupoId,
    ids,
    ventanaHist.desde,
    ventanaHist.hasta,
    cfg.limiteSerie
  );

  // ---- Muestreo en vivo. Alimenta el búfer y empuja los datos al canvas -- //
  //
  // En modo histórico el callback sale por la primera línea: el búfer se sigue
  // llenando (es barato y así volver a «vivo» no arranca de cero) pero NO toca
  // el gráfico, que está enseñando otra cosa.
  useBufferTrend(variables, ids, cfg.retencionSeg, (b) => {
    if (esHistorico) {
      bufferRef.current = b;
      return;
    }
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
    // Cambiar de modo REHACE el gráfico. Es lo más limpio: el encuadre
    // inicial, los gestos y el seguimiento se comportan distinto en cada uno, y
    // reutilizar la instancia dejaría restos del modo anterior (una escala
    // pegada al presente en un gráfico que enseña ayer, por ejemplo).
    esHistorico,
  });

  useEffect(() => {
    const destino = contenedor.current;
    const marco = caja.current;
    if (!destino || !marco || ids.length === 0) return;
    asegurarEstilos();

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
        historico: esHistorico,
        interaccion,
        alCambiarEscala,
        alMoverCursor,
      }),
      (bufferRef.current ?? new BufferTrend()).datos(ids),
      destino
    );
    plot.current = u;
    setAreaDibujo(u.over as HTMLDivElement);

    // Encuadre inicial. En histórico es el rango PEDIDO —ya está calculado en
    // el cuerpo del render, antes de este efecto—; pegarlo al presente aunque
    // fuera un instante producía un salto feo al llegar los datos.
    const rh = rangoHistRef.current;
    if (esHistorico && rh) {
      u.setScale('x', { min: rh[0], max: rh[1] });
    } else {
      const r = bufferRef.current?.rango();
      const fin = r ? r[1] : Date.now() / 1000;
      u.setScale('x', { min: fin - cfg.ventanaSeg, max: fin });
    }

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
      // Primero se desmonta el portal y luego se destruye uPlot: al revés,
      // React intentaría quitar la regla de un div que ya no existe.
      setAreaDibujo(null);
      u.destroy();
      plot.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [firma]);

  // Los refs que leen los gestos, al día en cada render. Se escriben en el
  // cuerpo y no en un efecto a propósito: un efecto corre DESPUÉS de pintar, y
  // entre el primer render en histórico y ese efecto habría una ventana en la
  // que un gesto leería todavía el modo anterior.
  esHistoricoRef.current = esHistorico;
  rangoHistRef.current = (() => {
    if (!esHistorico) return null;
    const d = Date.parse(ventanaHist.desde);
    const h = Date.parse(ventanaHist.hasta);
    // El rango PEDIDO manda sobre el de los datos: es hasta dónde tiene
    // sentido dejar desplazarse, aunque en un tramo no se guardara nada.
    if (Number.isFinite(d) && Number.isFinite(h) && h > d) return [d / 1000, h / 1000];
    return hist.rango;
  })();

  // ---- Datos históricos al canvas --------------------------------------- //
  //
  // Aparte del efecto de creación a propósito: los datos llegan por red y
  // pueden hacerlo DESPUÉS de que el gráfico exista, o cambiar sin que el
  // gráfico tenga que rehacerse (una recarga con el mismo rango).
  useEffect(() => {
    if (!esHistorico) return;
    const u = plot.current;
    if (!u) return;
    if (u.series.length !== ids.length + 1) return;
    u.setData(hist.datos, false);
    // El encuadre es el RANGO PEDIDO, no el de los datos que llegaron. Si se
    // ajustara a los datos, un tramo sin registros haría que el gráfico
    // enseñara otra ventana distinta de la que pone el desplegable, y el hueco
    // —que es información: ahí no se guardó nada— desaparecería de la vista.
    const d = Date.parse(ventanaHist.desde);
    const h = Date.parse(ventanaHist.hasta);
    if (Number.isFinite(d) && Number.isFinite(h) && h > d) {
      u.setScale('x', { min: d / 1000, max: h / 1000 });
    } else if (hist.rango) {
      u.setScale('x', { min: hist.rango[0], max: hist.rango[1] });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [esHistorico, hist.datos, ids.length]);

  // ---- Ventana: al cambiarla, reencuadrar si se está en vivo ----------- //
  useEffect(() => {
    if (esHistorico) return;
    if (!siguiendoRef.current) return;
    const u = plot.current;
    if (!u) return;
    const r = bufferRef.current?.rango();
    const fin = r ? r[1] : Date.now() / 1000;
    u.setScale('x', { min: fin - cfg.ventanaSeg, max: fin });
  }, [cfg.ventanaSeg]);

  // ---- Lo que se lee ---------------------------------------------------- //
  const sinSeries = cfg.series.length === 0;
  const puntos = esHistorico ? hist.puntos : bufferRef.current?.puntos ?? 0;
  // En histórico, «esperando» es mientras la petición está en vuelo. Sin datos
  // y sin petición no se espera nada: es que no hay, y eso se dice con otro
  // mensaje (ver la barra).
  const esperando = !sinSeries && (esHistorico ? hist.cargando && puntos < 2 : puntos < 2);
  const señalando = idxCursor !== null && interactivo;
  const tSeñalado = (() => {
    if (!señalando) return null;
    const t = plot.current?.data?.[0] as unknown as number[] | undefined;
    const v = t?.[idxCursor as number];
    return v === undefined ? null : v;
  })();

  const etiquetaVista = señalando && tSeñalado != null
    ? fmtInstante(tSeñalado)
    : vista
    ? `${fmtHora(vista.min, vista.max - vista.min)} → ${fmtHora(
        vista.max,
        vista.max - vista.min
      )}`
    : '';
  const duracionVista = vista ? fmtDuracion(vista.max - vista.min) : '';

  /**
   * Valor que enseñan la leyenda y la regla.
   *
   * Cuando se está señalando sale de `u.data`, NO del búfer. Es el cambio que
   * hace que la regla funcione igual en los dos modos: `u.data` es lo que el
   * gráfico tiene dibujado ahora mismo —el búfer en vivo o las filas del
   * historizador— y el índice del cursor está referido justamente a eso.
   * Leerlo del búfer daba el valor de OTRA serie de tiempos en modo histórico.
   *
   * Sin cursor, el valor en vivo de la variable; en histórico, el último punto
   * que llegó, que es lo más reciente que se guardó en ese rango.
   */
  const valorDe = (variableId: string, posSerie: number): number | null => {
    const u = plot.current;
    if (señalando && u && u.data.length > posSerie + 1) {
      const col = u.data[posSerie + 1] as unknown as (number | null)[];
      const v = col?.[idxCursor as number];
      return v === undefined || v === null ? null : v;
    }
    if (esHistorico) {
      const col = u?.data?.[posSerie + 1] as unknown as (number | null)[] | undefined;
      if (!col || !col.length) return null;
      for (let i = col.length - 1; i >= 0; i--) {
        if (col[i] != null) return col[i] as number;
      }
      return null;
    }
    const v = variables.find((x) => x.id === variableId);
    if (!v) return null;
    const n = typeof v.value === 'number' ? v.value : Number(v.value);
    return Number.isFinite(n) ? n : null;
  };

  // Prefijo compartido por todos los nombres, para no gastar la leyenda en
  // repetir `PLC_PRG.` cinco veces y truncar lo que sí distingue. Lo usan la
  // leyenda Y la regla, así que se calcula antes que las dos.
  const prefijoRegla = prefijoComun(
    dibujables.map(
      ({ s }) =>
      s.etiqueta || variables.find((v) => v.id === s.variableId)?.name || ''
    )
  );
  const prefijo = prefijoRegla;

  const fuerte = isDark ? '#e2e8f0' : '#0f172a';

  /**
   * Lo que enseña la caja de la regla.
   *
   * Se calcula aquí y no dentro de `<Regla>` porque los nombres cortos, los
   * colores y el formato del número son los MISMOS que usa la leyenda de
   * abajo: si se duplicaran, el día que alguien cambie el formato en un sitio
   * la regla y la leyenda dirían cosas distintas del mismo dato.
   */
  const filasRegla: FilaRegla[] = dibujables.map(({ s, i }, pos) => {
    const v = variables.find((x) => x.id === s.variableId);
    const completo = s.etiqueta || v?.name || '—';
    return {
      clave: s.id,
      nombre:
      prefijoRegla && completo.startsWith(prefijoRegla) ?
      completo.slice(prefijoRegla.length) :
      completo,
      color: colorEfectivo(s.color, i, isDark),
      valor: `${fmtNum(valorDe(s.variableId, pos))}${v?.unit ? ` ${v.unit}` : ''}`
    };
  });



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
          onClick={esHistorico ? hist.recargar : volverAVivo}
          title={
            esHistorico
              ? 'Histórico. Pulsa para volver a consultar la base de datos'
              : siguiendo
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
            border: `1px solid ${
            esHistorico ? tema.tinta : siguiendo ? tema.vivo : tema.pausa}`,
            background: `${
            esHistorico ? tema.tinta : siguiendo ? tema.vivo : tema.pausa}1f`,
            color: esHistorico ? tema.tinta : siguiendo ? tema.vivo : tema.pausa,
            fontSize: 9.5,
            fontWeight: 700,
            letterSpacing: '.09em',
            cursor: 'pointer',
            fontFamily: 'inherit',
          }}
        >
          {esHistorico ? (
            hist.cargando ? (
              <Loader2Icon
                className="animate-spin"
                style={{ width: 9, height: 9, flexShrink: 0 }}
              />
            ) : (
              <RefreshCwIcon style={{ width: 9, height: 9, flexShrink: 0 }} />
            )
          ) : (
            <span
              style={{
                width: 6,
                height: 6,
                borderRadius: 999,
                background: 'currentColor',
                flexShrink: 0,
              }}
            />
          )}
          {esHistorico ? 'HISTÓRICO' : siguiendo ? 'EN VIVO' : 'PAUSADO'}
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
        <div
          ref={contenedor}
          className={CLASE_TREND}
          style={{ position: 'absolute', inset: 0 }}
        />

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
            {esHistorico ? 'Consultando el histórico…' : 'Esperando datos…'}
          </div>
        )}

        {/* En histórico, «no hay datos» no es lo mismo que «estoy esperando», y
            la salida es distinta: ahí no se espera, se cambia el rango o el
            grupo. Por eso tiene su propio mensaje y no el de arriba. */}
        {esHistorico && !esperando && !hist.error && puntos === 0 && !sinSeries && (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 4,
              padding: 12,
              textAlign: 'center',
              pointerEvents: 'none',
              color: tema.tintaSuave,
              fontSize: 11,
            }}
          >
            <DatabaseIcon style={{ width: 16, height: 16, opacity: 0.6 }} />
            {cfg.grupoId
              ? 'No hay nada guardado en este rango.'
              : 'Elige un grupo del historizador en Propiedades.'}
            {/* La ventana REAL que se consultó, en UTC, que es como está la
                tabla. Sin este renglón, «no hay nada» es indistinguible de
                «pedí otra hora sin darme cuenta» — y con cinco horas de
                diferencia horaria, lo segundo pasa constantemente. */}
            {cfg.grupoId && ventanaHist.desde && ventanaHist.hasta && (
              <span style={{ fontSize: 10, opacity: 0.7, fontFamily: 'monospace' }}>
                {ventanaHist.desde.slice(0, 19).replace('T', ' ')} →{' '}
                {ventanaHist.hasta.slice(0, 19).replace('T', ' ')} UTC
              </span>
            )}

            {/* ── DÓNDE SÍ HAY DATOS ──
                Esto es lo que ahorra el viaje a SQL Server. Por cada serie: la
                hora del último registro guardado, en hora LOCAL, o «nunca» si
                de ese tag no hay una sola fila. Con eso se sabe al instante si
                lo que falla es el rango o es el grupo, sin salir del HMI. */}
            {hist.pistas.length > 0 && (
              <div
                style={{
                  marginTop: 6,
                  paddingTop: 6,
                  borderTop: `1px solid ${tema.borde}`,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 2,
                  fontSize: 10,
                }}
              >
                <span style={{ opacity: 0.8, fontWeight: 600 }}>
                  Último dato guardado de cada variable:
                </span>
                {hist.pistas.map((p) => (
                  <span key={p.tag} style={{ fontFamily: 'monospace', opacity: 0.85 }}>
                    {p.tag} ·{' '}
                    {p.ultimo == null ? (
                      <b style={{ color: tema.pausa }}>nunca se guardó</b>
                    ) : (
                      <b style={{ color: fuerte }}>{fmtInstanteLargo(p.ultimo)}</b>
                    )}
                  </span>
                ))}
              </div>
            )}
          </div>
        )}

        {esHistorico && hist.error && (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: 12,
              textAlign: 'center',
              pointerEvents: 'none',
              color: tema.pausa,
              fontSize: 11,
              fontWeight: 600,
            }}
          >
            {hist.error}
          </div>
        )}

        {/* ── LA REGLA, DENTRO DEL ÁREA DE DIBUJO ──
            No va aquí como hermana del canvas: va INYECTADA en `.u-over` con un
            portal. Ese div es el sistema de coordenadas en el que uPlot da
            `cursor.left`, así que dentro de él la regla cae bajo el puntero sin
            traducir nada. Fuera, había que convertir — y toda conversión que
            mezcle píxeles de pantalla con píxeles de maquetación se descuadra
            en cuanto el lienzo se escala, que es lo que pasa en la Vista previa.

            Efecto lateral bueno: `.u-over` recorta por los bordes, así que la
            caja de valores ya no puede asomar fuera de la zona del gráfico. */}
        {cfg.mostrarRegla &&
          interactivo &&
          posRegla &&
          areaDibujo &&
          señalando &&
          tSeñalado != null &&
          createPortal(
            <Regla
              pos={posRegla}
              instante={fmtInstante(tSeñalado)}
              filas={filasRegla}
              tema={tema}
              fuerte={fuerte}
              tam={tamLeyenda}
            />,
            areaDibujo
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
          {dibujables.map(({ s, i }, pos) => {
            const v = variables.find((x) => x.id === s.variableId);
            const valor = valorDe(s.variableId, pos);
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

/**
 * Los grupos del historizador, para el desplegable.
 *
 * Se piden solo cuando el modo es histórico: en un Inspector que se abre a
 * cada clic, una petición que casi nunca se usa es ruido en la red del panel
 * —el mismo criterio que ya sigue el inspector de acciones con los temas.
 */
function useGrupos(activo: boolean) {
  const [grupos, setGrupos] = useState<GrupoHistorico[]>([]);
  const [cargando, setCargando] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!activo) return;
    let vivo = true;
    setCargando(true);
    listarGrupos()
      .then((g) => {
        if (vivo) {
          setGrupos(g);
          setError('');
        }
      })
      .catch((e: any) => {
        if (vivo) setError(e?.message ?? 'No se pudieron leer los grupos.');
      })
      .finally(() => {
        if (vivo) setCargando(false);
      });
    return () => {
      vivo = false;
    };
  }, [activo]);

  return { grupos, cargando, error };
}

/**
 * Añadir MUCHAS variables de una vez.
 *
 * EL PROBLEMA QUE RESUELVE
 * «Agregar variable» pone una fila vacía y hay que elegirle la variable en un
 * desplegable. Para tres series va bien. Con doscientas variables en el PLC
 * —y un grupo del historizador que las guarda todas— es sencillamente
 * impracticable: doscientos clics para montar una pantalla.
 *
 * Aquí se marcan con casillas, se filtra escribiendo, y entran todas juntas.
 *
 * POR QUÉ NO SE AÑADEN SOLAS AL ELEGIR EL GRUPO
 * Porque un grupo puede guardar los doscientos tags, y doscientas líneas en un
 * gráfico no es una tendencia: es una mancha. El grupo dice qué HAY guardado;
 * qué se DIBUJA lo decide quien hace la pantalla.
 *
 * ── LAS DOS PESTAÑAS ────────────────────────────────────────────────────
 * Por defecto se listan SOLO los tags del grupo elegido, que en un grupo de
 * tres tags son tres variables aunque en el PLC haya doscientas. No es que
 * falten: es que de las otras ciento noventa y siete no hay ni una fila
 * guardada, y ponerlas ahí sería ofrecer series que van a salir vacías.
 *
 * Pero eso hay que poder verlo y hay que poder saltárselo —el grupo puede
 * cambiar, o el histórico ser de otro sitio—, así que el recuento va escrito en
 * las dos pestañas y «Todas» está a un clic.
 */
function SelectorVarias({
  delGrupo,
  todas,
  yaPuestas,
  onAñadir,
  onCerrar
}: {
  /** Variables que el grupo del historizador guarda. `null` = no filtra. */
  delGrupo: { id: string; name: string }[] | null;
  /** Todas las numéricas seleccionadas en Controladores. */
  todas: { id: string; name: string }[];
  yaPuestas: Set<string>;
  onAñadir: (ids: string[]) => void;
  onCerrar: () => void;
}) {
  const [busca, setBusca] = useState('');
  const [marcadas, setMarcadas] = useState<Set<string>>(new Set());
  const [soloGrupo, setSoloGrupo] = useState(true);

  const base = delGrupo && soloGrupo ? delGrupo : todas;
  const libres = base.filter((v) => !yaPuestas.has(v.id));
  const q = busca.trim().toLowerCase();
  const vistas = q ? libres.filter((v) => v.name.toLowerCase().includes(q)) : libres;

  const alternar = (id: string) =>
  setMarcadas((prev) => {
    const s = new Set(prev);
    if (s.has(id)) s.delete(id);else
    s.add(id);
    return s;
  });

  return (
    <div className="mt-2 rounded-lg border border-siemens/40 bg-siemens/[0.04] p-2">
      {delGrupo && (
        <>
          <div className="mb-2 flex gap-0.5 rounded-lg bg-slate-100 p-0.5 dark:bg-navy">
            {[
              { v: true, t: `Del grupo (${delGrupo.length})` },
              { v: false, t: `Todas (${todas.length})` }
            ].map((o) => (
              <button
                key={String(o.v)}
                type="button"
                onClick={() => setSoloGrupo(o.v)}
                className={`flex-1 rounded-md px-2 py-1 text-[11px] font-semibold transition ${
                  soloGrupo === o.v
                    ? 'bg-white text-siemens shadow-sm dark:bg-navy-slate'
                    : 'text-slate-500 hover:text-slate-700 dark:text-slate-400'
                }`}
              >
                {o.t}
              </button>
            ))}
          </div>
          <p className="mb-2 text-[10px] leading-relaxed text-slate-400">
            {soloGrupo
              ? 'Solo los tags que este grupo guarda. Del resto no hay ni una fila en la tabla, así que saldrían como series vacías.'
              : 'Todas las numéricas de Controladores. Las que el grupo no guarde saldrán sin datos.'}
          </p>
        </>
      )}

      <input
        autoFocus
        value={busca}
        onChange={(e) => setBusca(e.target.value)}
        placeholder="Filtrar por nombre…"
        className={INPUT} />

      <div className="mp-scroll mp-scroll-dark mt-2 max-h-52 overflow-y-auto rounded border border-slate-200 dark:border-navy-slate">
        {vistas.length === 0 ?
        <p className="px-2 py-3 text-center text-[11px] text-slate-400">
            {base.length === 0 ?
          'El grupo no declara tags concretos.' :
          libres.length === 0 ?
          'Ya están todas puestas.' :
          'Ninguna coincide con el filtro.'}
          </p> :

        vistas.map((v) =>
        <label
          key={v.id}
          className="flex cursor-pointer items-center gap-2 px-2 py-1 text-[11px] text-slate-600 hover:bg-slate-50 dark:text-slate-300 dark:hover:bg-navy-slate/40">
              <input
            type="checkbox"
            checked={marcadas.has(v.id)}
            onChange={() => alternar(v.id)}
            className="h-3.5 w-3.5 shrink-0 rounded border-slate-300 text-siemens focus:ring-1 focus:ring-siemens/40 dark:border-navy-slate dark:bg-navy" />

              <span className="min-w-0 flex-1 truncate font-mono" title={v.name}>
                {v.name}
              </span>
            </label>
        )
        }
      </div>

      <div className="mt-2 flex items-center gap-1.5">
        {/* «Todas las del filtro» y no «todas» a secas: con 200 candidatas, un
            botón que las marca todas de golpe es más fácil de pulsar sin querer
            que de deshacer. Filtrando primero, lo que entra es lo que se ve. */}
        <button
          type="button"
          onClick={() => setMarcadas(new Set(vistas.map((v) => v.id)))}
          disabled={vistas.length === 0}
          className="rounded-lg border border-slate-200 px-2 py-1 text-[11px] text-slate-500 transition hover:bg-slate-50 disabled:opacity-40 dark:border-navy-slate dark:text-slate-400">
          Marcar las {vistas.length} del filtro
        </button>
        <span className="flex-1" />
        <button
          type="button"
          onClick={onCerrar}
          className="rounded-lg px-2 py-1 text-[11px] text-slate-400 transition hover:text-slate-600">
          Cancelar
        </button>
        <button
          type="button"
          disabled={marcadas.size === 0}
          onClick={() => {
            onAñadir(Array.from(marcadas));
            onCerrar();
          }}
          className="rounded-lg bg-siemens px-2.5 py-1 text-[11px] font-semibold text-white transition hover:bg-siemens-600 disabled:opacity-40">
          Añadir {marcadas.size || ''}
        </button>
      </div>
    </div>);

}

function InspectorTrend({ config, setConfig }: InspectorCtx) {
  const cfg = leerConfigTrend(config);
  const { selectedVariables, isDark } = useAppStore();
  const esHistorico = cfg.origen === 'historico';
  const { grupos, cargando: cargandoGrupos, error: errorGrupos } = useGrupos(esHistorico);
  const grupoElegido = grupos.find((g) => g.grupo_id === cfg.grupoId);
  const [abiertoVarias, setAbiertoVarias] = useState(false);

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

  // ── Añadir muchas de golpe ──────────────────────────────────
  //
  // Las candidatas salen de las variables numéricas seleccionadas. Pero si hay
  // un grupo del historizador elegido y ese grupo NO guarda todos los tags, la
  // lista se recorta a lo que el grupo guarda DE VERDAD: ofrecer una variable
  // que nadie historiza solo consigue una serie vacía y media hora buscando
  // por qué el gráfico sale en blanco.
  //
  // Si el cruce sale vacío —otro PLC, otra nomenclatura de tags— se devuelven
  // todas: una lista vacía parecería una avería, y aquí el que decide es quien
  // monta la pantalla.
  const delGrupo = (() => {
    if (!esHistorico || !grupoElegido || grupoElegido.todos_los_tags) return null;
    const tags = new Set(
      (grupoElegido.tags ?? []).map((t) => (t.includes('|') ? partirId(t).tag : t))
    );
    if (tags.size === 0) return null;
    return numericas.filter((v) => tags.has(partirId(v.id).tag));
  })();

  // Una sola llamada a `set` con TODAS las nuevas. Hacer un `set` por variable
  // en un bucle escribiría cada uno sobre el `cfg` que capturó al empezar, y
  // de doscientas marcadas entraría exactamente una.
  const añadirVarias = (ids: string[]) => {
    const usadas = new Set(cfg.series.map((s) => s.variableId));
    const nuevas: SerieTrend[] = ids
      .filter((id) => !usadas.has(id))
      .map((id) => ({
        id: nuevoId(),
        variableId: id,
        etiqueta: '',
        color: '',
        grosor: 2,
      }));
    if (nuevas.length === 0) return;
    set({ series: [...cfg.series, ...nuevas] });
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
  const ventanaEnUtc =
    cfg.rango === 'personalizado' ? ventanaUtc(cfg.desde, cfg.hasta) : '';

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

        <div className="mt-2 flex items-stretch gap-1.5">
          {/* «Agregar variable» sigue estando, y sigue siendo lo primero: para
              una o dos series es el gesto más corto. Lo que se añade al lado es
              la salida para cuando son veinte. */}
          <button
            type="button"
            onClick={agregar}
            className="flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-dashed border-slate-300 py-1.5 text-xs font-semibold text-slate-500 transition hover:border-siemens hover:text-siemens dark:border-navy-slate dark:text-slate-400"
          >
            <PlusIcon className="h-3.5 w-3.5" />
            Agregar variable
          </button>
          <button
            type="button"
            onClick={() => setAbiertoVarias((v) => !v)}
            title="Marcar varias variables y añadirlas todas de una vez"
            className={`shrink-0 rounded-lg border px-2.5 py-1.5 text-xs font-semibold transition ${
              abiertoVarias
                ? 'border-siemens bg-siemens/10 text-siemens'
                : 'border-dashed border-slate-300 text-slate-500 hover:border-siemens hover:text-siemens dark:border-navy-slate dark:text-slate-400'
            }`}
          >
            Añadir varias…
          </button>
        </div>

        {abiertoVarias && (
          <SelectorVarias
            delGrupo={delGrupo}
            todas={numericas}
            yaPuestas={new Set(cfg.series.map((s) => s.variableId))}
            onAñadir={añadirVarias}
            onCerrar={() => setAbiertoVarias(false)}
          />
        )}

        {repetidos.size > 0 && (
          <p className="mt-2 rounded-lg bg-amber-50 px-2.5 py-2 text-[11px] leading-relaxed text-amber-700 dark:bg-amber-500/10 dark:text-amber-400">
            Hay series que comparten color. Los seis tonos del catálogo están
            validados para daltonismo; a partir de la séptima serie el reparto
            automático los repite, así que conviene elegir el color a mano.
          </p>
        )}
      </div>

      {/* ── ORIGEN ──────────────────────────────────────────────── */}
      <label className="block">
        <span className="mb-1 block text-xs font-medium text-slate-500 dark:text-slate-400">
          Origen de los datos
        </span>
        <select
          value={cfg.origen}
          onChange={(e) => set({ origen: e.target.value as OrigenTrend })}
          className={INPUT}
        >
          <option value="vivo">En vivo (memoria del navegador)</option>
          <option value="historico">Histórico (base de datos)</option>
        </select>
        <span className="mt-1 block text-[10px] leading-relaxed text-slate-400">
          {esHistorico
            ? 'Consulta lo que el historizador guardó. No se actualiza solo: se recarga con la píldora «HISTÓRICO» del gráfico.'
            : 'Lo que llega por WebSocket. Nada va a disco, y al recargar la página se empieza de cero.'}
        </span>
      </label>

      {esHistorico && (
        <>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-slate-500 dark:text-slate-400">
              Grupo del historizador
            </span>
            <select
              value={cfg.grupoId}
              onChange={(e) => set({ grupoId: e.target.value })}
              className={INPUT}
            >
              <option value="">
                {cargandoGrupos ? 'Cargando…' : '— Elige un grupo —'}
              </option>
              {grupos.map((g) => (
                <option key={g.grupo_id} value={g.grupo_id}>
                  {g.nombre || g.grupo_id}
                  {g.activo ? '' : ' · pausado'}
                </option>
              ))}
              {/* Un grupo que se configuró y luego se borró del historizador.
                  No se cambia en silencio: se enseña marcado, porque el widget
                  va a salir vacío y hay que poder verlo aquí. */}
              {cfg.grupoId && !cargandoGrupos && !grupoElegido && (
                <option value={cfg.grupoId}>{cfg.grupoId} · ya no existe</option>
              )}
            </select>
            {errorGrupos && (
              <span className="mt-1 block text-[10px] font-semibold text-red-500">
                {errorGrupos}
              </span>
            )}
            {grupoElegido && (
              <span className="mt-1 block text-[10px] leading-relaxed text-slate-400">
                {grupoElegido.todos_los_tags
                  ? 'Guarda TODOS los tags'
                  : `${grupoElegido.num_tags} tag(s)`}{' '}
                en <b>{grupoElegido.tabla}</b>.{' '}
                {grupoElegido.filas_escritas > 0
                  ? `${grupoElegido.filas_escritas.toLocaleString()} filas escritas.`
                  : 'Todavía no ha escrito nada.'}
                {!grupoElegido.activo && ' La captura está pausada.'}
              </span>
            )}
          </label>

          <label className="block">
            <span className="mb-1 block text-xs font-medium text-slate-500 dark:text-slate-400">
              Rango
            </span>
            <select
              value={cfg.rango}
              onChange={(e) => {
                const v = e.target.value;
                // Pasar a «entre dos fechas» con los dos campos en blanco no
                // consulta nada y no lo explica. Se rellena con la última hora,
                // que es un punto de partida que siempre tiene sentido y que se
                // edita en dos teclas.
                if (v === 'personalizado' && !cfg.desde && !cfg.hasta) {
                  const ahora = Date.now();
                  set({
                    rango: v,
                    desde: aValorLocal(ahora - 3600_000),
                    hasta: aValorLocal(ahora)
                  });
                  return;
                }
                set({ rango: v });
              }}
              className={INPUT}
            >
              {RANGOS.map((r) => (
                <option key={r.v} value={r.v}>
                  {r.t}
                </option>
              ))}
            </select>
            <span className="mt-1 block text-[10px] leading-relaxed text-slate-400">
              Los atajos se calculan contra el reloj CADA VEZ que se consulta,
              no al guardar: «última hora» sigue siendo la última hora dentro de
              un mes.
            </span>
          </label>

          {cfg.rango === 'personalizado' && (
            <div className="grid grid-cols-1 gap-2">
              <label className="block">
                <span className="mb-1 block text-[11px] text-slate-400">Desde</span>
                <input
                  type="datetime-local"
                  value={cfg.desde}
                  onChange={(e) => set({ desde: e.target.value })}
                  className={INPUT}
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-[11px] text-slate-400">Hasta</span>
                <input
                  type="datetime-local"
                  value={cfg.hasta}
                  onChange={(e) => set({ hasta: e.target.value })}
                  className={INPUT}
                />
              </label>

              {/* LA LÍNEA MÁS ÚTIL DE ESTE PANEL.
                  Las horas de arriba son LOCALES; la tabla del historizador
                  guarda UTC. Son cinco horas de diferencia, y sin verlas
                  escritas, comparar el HMI con lo que sale en SQL Server
                  parece un fallo cuando es solo la zona horaria. Esto es,
                  literalmente, el WHERE que va a ejecutarse. */}
              {ventanaEnUtc ? (
                <p className="rounded-lg bg-slate-50 px-2.5 py-2 font-mono text-[10px] leading-relaxed text-slate-500 dark:bg-navy dark:text-slate-400">
                  <span className="font-sans font-semibold">En la tabla (UTC): </span>
                  {ventanaEnUtc}
                </p>
              ) : (
                <p className="rounded-lg bg-amber-50 px-2.5 py-2 text-[11px] leading-relaxed text-amber-700 dark:bg-amber-500/10 dark:text-amber-400">
                  Rellena las dos fechas: sin ellas no se consulta nada.
                </p>
              )}
            </div>
          )}

          <label className="block">
            <span className="mb-1 block text-xs font-medium text-slate-500 dark:text-slate-400">
              Puntos por serie
            </span>
            <select
              value={String(cfg.limiteSerie)}
              onChange={(e) => set({ limiteSerie: Number(e.target.value) })}
              className={INPUT}
            >
              <option value="500">500</option>
              <option value="1000">1000</option>
              <option value="2500">2500</option>
              <option value="5000">5000</option>
              <option value="10000">10000 (máximo)</option>
            </select>
            <span className="mt-1 block text-[10px] leading-relaxed text-slate-400">
              Se pide una consulta POR SERIE, así que este número es de cada
              una y no se reparte entre todas. Si el rango tiene más muestras
              que esto, se recorta lo más antiguo y el gráfico lo avisa.
            </span>
          </label>
        </>
      )}

      {/* La ventana y la retención son del modo EN VIVO. En histórico el
          encuadre lo pone el rango y no se guarda nada en memoria, así que
          enseñarlas sería ofrecer dos mandos que no hacen nada. */}
      {!esHistorico && (
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
      )}

      {!esHistorico && (
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
      )}

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
          Mostrar regla
        </span>
        <input
          type="checkbox"
          checked={cfg.mostrarRegla}
          onChange={(e) => set({ mostrarRegla: e.target.checked })}
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
        {esHistorico ? (
          <>
            Lee de la base de datos el rango que elijas. En la{' '}
            <b>Vista previa</b>: arrastra y haz zoom para recorrerlo, y pasa el
            cursor para que la <b>regla</b> te diga el valor de cada serie en
            ese instante. Se recarga con la píldora del gráfico.
          </>
        ) : (
          <>
            Enseña {fmtDuracion(cfg.ventanaSeg)} y guarda{' '}
            {RETENCIONES.find((r) => r.v === cfg.retencionSeg)?.t ??
              fmtDuracion(cfg.retencionSeg)}{' '}
            en memoria. En la <b>Vista previa</b>: arrastra para retroceder,
            rueda para el zoom, pasa el cursor para leer el valor de un
            instante con la <b>regla</b> y doble clic para volver al presente.
            No guarda nada en disco.
          </>
        )}
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
