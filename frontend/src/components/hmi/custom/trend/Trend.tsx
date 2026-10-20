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
  MaximizeIcon,
  Loader2Icon,
  DownloadIcon,
  SquareIcon,
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
import { useDescargaHistorico, useGrabacionTrend } from './grabacion';
import { partirId } from '../../../../services/escrituraApi';
import { ColumnaTrend } from './ColumnaTrend';
import {
  CapaEtiquetas,
  CuadroNombre,
  ModalEtiquetas,
  PuntoEtiqueta,
  siguienteNombre,
  useEtiquetasGuardadas,
  type EtiquetaTrend,
} from './Etiquetas';
import {
  ajustar,
  encajar,
  desplazar,
  pluginInteraccion,
  type OpcionesInteraccion,
  zoomPausando,
  desplazarSegundos,
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

  // ── EXPORTAR A EXCEL ────────────────────────────────────────────
  //
  // POR QUÉ ES UN INTERRUPTOR POR WIDGET Y NO ALGO QUE SIEMPRE ESTÁ
  // `/export/*` es, junto a `/ai/*`, uno de los dos routers del backend que
  // NO comprueba rol ni sesión. Si el botón saliera en todos los Trends por
  // defecto, cualquier pantalla de planta ya desplegada pasaría a ofrecerle
  // la descarga de datos a quien tenga delante el panel, sin que nadie lo
  // haya pedido — y por una actualización del programa, no por una decisión.
  //
  // Mismo criterio que `config.escritura` en `components/hmi/acciones.ts`:
  // una pantalla guardada no puede cambiar de comportamiento sola.

  /** Enseñar los botones de exportación en la Vista Previa. */
  exportar: boolean;
  /**
   * Cada cuánto se toma una muestra de TODAS las series, en ms.
   *
   * NO es el refresco del gráfico: es el del fichero. El mínimo real son
   * 100 ms, que es lo que publica el servidor OPC UA del S7-1500 — por
   * debajo solo saldrían filas repetidas.
   */
  grabIntervaloMs: number;
  /**
   * Cuánto dura la grabación, en segundos. **0 = indefinida**, hasta que se
   * pulse parar.
   *
   * El valor por defecto es 0 y no los 60 s del backend a propósito: aquí
   * quien graba está delante de la pantalla mirando el proceso, y una
   * grabación que se corta sola al minuto obliga a volver a empezar justo
   * cuando pasa lo que se quería ver.
   */
  grabDuracionS: number;

  // ── TÍTULO, LOGO Y HERRAMIENTAS ─────────────────────────────────
  //
  // Todo opcional y apagado por defecto: un Trend guardado antes de que
  // existiera esto se ve exactamente igual.

  /** Título del gráfico, a la derecha de la barra de arriba. Vacío = no sale. */
  titulo: string;
  /** Reservar un hueco a la derecha, arriba, para un widget de Imagen (logo). */
  logo: boolean;
  logoAncho: number;
  logoAlto: number;
  /** Panel de herramientas (Eje X, Eje Y, Etiquetas). Por ahora solo diseño. */
  herramientas: boolean;
  herramientasAncho: number;
}

// ── LÍMITES DE LA GRABACIÓN ──────────────────────────────────────
//
// Son una COPIA de los que valida el backend: `NuevaGrabacion` en
// `app/api/export_routes.py` (ge/le de Pydantic) y las constantes de
// `app/export/grabador.py`. Se duplican aquí a propósito, y la duplicación
// tiene un motivo concreto: sin ellos, un intervalo de 50 ms se manda igual y
// el servidor responde un 422 que el operario ve como «no se pudo grabar» sin
// saber por qué. Con ellos, el Inspector no deja escribirlo.
//
// La barrera de verdad sigue siendo el servidor. Esto es cortesía.
export const GRAB_INTERVALO_MIN_MS = 100;
export const GRAB_INTERVALO_MAX_MS = 3_600_000;
export const GRAB_DURACION_MAX_S = 86_400;

/** Un número dentro de su rango, o el respaldo si no es un número válido. */
function limitar(v: any, min: number, max: number, respaldo: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return respaldo;
  return Math.min(max, Math.max(min, Math.round(n)));
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
  exportar: false,
  grabIntervaloMs: 1000,
  grabDuracionS: 0,
  titulo: '',
  logo: false,
  logoAncho: 200,
  logoAlto: 70,
  herramientas: false,
  herramientasAncho: 210,
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

/**
 * Intervalos de muestreo de la grabación.
 *
 * Arrancan en 100 ms porque es el mínimo que acepta el backend, y ese mínimo
 * no es un capricho suyo: por debajo, el servidor OPC UA del S7-1500 no
 * publica más rápido y el Excel solo tendría filas repetidas.
 */
export const INTERVALOS_GRAB = [
  { v: 100, t: '100 ms · transitorios' },
  { v: 250, t: '250 ms' },
  { v: 500, t: '500 ms' },
  { v: 1000, t: '1 segundo' },
  { v: 2000, t: '2 segundos' },
  { v: 5000, t: '5 segundos' },
  { v: 10000, t: '10 segundos' },
  { v: 30000, t: '30 segundos' },
  { v: 60000, t: '1 minuto' },
];

/** Duraciones de la grabación. `0` = hasta que alguien la pare. */
export const DURACIONES_GRAB = [
  { v: 0, t: 'Hasta pararla a mano' },
  { v: 30, t: '30 segundos' },
  { v: 60, t: '1 minuto' },
  { v: 300, t: '5 minutos' },
  { v: 600, t: '10 minutos' },
  { v: 1800, t: '30 minutos' },
  { v: 3600, t: '1 hora' },
  { v: 28800, t: '8 horas · un turno' },
];

/**
 * Unidades del campo de duración personalizada.
 *
 * Existen porque «7200» no se lee y «2 h» sí. El valor guardado SIEMPRE son
 * segundos —es lo que quiere el backend—; esto solo decide cómo se teclea.
 */
export const UNIDADES_DURACION = [
  { v: 1, t: 'segundos' },
  { v: 60, t: 'minutos' },
  { v: 3600, t: 'horas' },
] as const;

/**
 * En qué unidad conviene ENSEÑAR una duración dada en segundos.
 *
 * Se elige la mayor que dé un número redondo: 7200 se lee «2 horas», pero
 * 7230 se lee «7230 segundos» y no «2,008 horas», que no lo entiende nadie.
 */
export function unidadDe(segundos: number): number {
  if (segundos > 0 && segundos % 3600 === 0) return 3600;
  if (segundos > 0 && segundos % 60 === 0) return 60;
  return 1;
}

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
    // Todo lo de exportar entra con valores por defecto, igual que en su día
    // lo hizo el modo histórico: una pantalla guardada antes de que esto
    // existiera abre con los botones apagados y se comporta como siempre.
    // Cero migración.
    exportar: c.exportar === true,
    grabIntervaloMs: limitar(
      c.grabIntervaloMs, GRAB_INTERVALO_MIN_MS, GRAB_INTERVALO_MAX_MS, 1000),
    grabDuracionS: limitar(c.grabDuracionS, 0, GRAB_DURACION_MAX_S, 0),
    titulo: typeof c.titulo === 'string' ? c.titulo : '',
    logo: c.logo === true,
    logoAncho: limitar(c.logoAncho, 20, 1200, 200),
    logoAlto: limitar(c.logoAlto, 20, 1200, 70),
    herramientas: c.herramientas === true,
    herramientasAncho: limitar(c.herramientasAncho, 150, 600, 210),
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

/**
 * Fecha y hora completas (dd/mm/aaaa hh:mm:ss) para la barra de arriba: el
 * tramo que se mira y el instante que señala el cursor. Con solo la hora,
 * un tramo de ayer se confundía con el de hoy.
 */
function fmtFechaHora(t: number): string {
  const d = new Date(t * 1000);
  return (
    `${dos(d.getDate())}/${dos(d.getMonth() + 1)}/${d.getFullYear()} ` +
    `${dos(d.getHours())}:${dos(d.getMinutes())}:${dos(d.getSeconds())}`
  );
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
/**
 * El rojo de «grabando».
 *
 * Literal y no del tema a propósito: el punto rojo de grabar significa lo
 * mismo en cualquier aparato del mundo, y que cambie de color con la paleta
 * del proyecto solo conseguiría que dejara de reconocerse. Es el mismo
 * `state.error` que ya define `tailwind.config.js`.
 */
const ROJO_GRABANDO = '#ef4444';

const CLASE_TREND = 'psi-trend';

let estilosPuestos = false;
function asegurarEstilos(): void {
  if (estilosPuestos || typeof document === 'undefined') return;
  estilosPuestos = true;
  const st = document.createElement('style');
  st.setAttribute('data-psi', 'trend');
  // Mientras se coloca una etiqueta se ocultan los puntitos propios de uPlot:
  // van a la muestra más cercana, no bajo el ratón, y junto al punto de la
  // etiqueta se veían «descuadrados».
  st.textContent =
    `.${CLASE_TREND} .u-cursor-x{display:none!important}` +
    `.${CLASE_TREND}.trend-etiquetando .u-cursor-pt{display:none!important}` +
    // SCROLL DE LA LEYENDA: fino, redondeado, sin flechas y del color del
    // tema (llega por las variables --tl-barra / --tl-barra-encima).
    `.psi-trend-leyenda::-webkit-scrollbar{width:10px}` +
    `.psi-trend-leyenda::-webkit-scrollbar-button{display:none;width:0;height:0}` +
    `.psi-trend-leyenda::-webkit-scrollbar-track{background:transparent}` +
    `.psi-trend-leyenda::-webkit-scrollbar-corner{background:transparent}` +
    `.psi-trend-leyenda::-webkit-scrollbar-thumb{background:var(--tl-barra);border-radius:999px;border:3px solid transparent;background-clip:padding-box;min-height:24px}` +
    `.psi-trend-leyenda::-webkit-scrollbar-thumb:hover{background:var(--tl-barra-encima);background-clip:padding-box}` +
    // Firefox no tiene los ::-webkit-: solo fino y del color del tema.
    `@supports (-moz-appearance:none){.psi-trend-leyenda{scrollbar-width:thin;scrollbar-color:var(--tl-barra) transparent}}`;
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
  /** Rango Y puesto con las herramientas del EJE Y (null = el de la config). */
  rangoY: () => [number, number] | null;
  /** Cambió cualquier escala o el tamaño: las etiquetas se recolocan. */
  alCambiarVista: () => void;
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
      drag: {
        x: false,
        y: false,
        setScale: false,
        // ESTO ES LO QUE HACÍA QUE LA ETIQUETA NO SE GUARDARA.
        //
        // uPlot, al hacer clic, compara dónde se APRETÓ y dónde se SOLTÓ el
        // ratón; si no coinciden, cree que fue un arrastre y se «come» el clic
        // (`stopPropagation`). En la Vista Previa el lienzo va escalado y
        // uPlot mide esas dos posiciones con correcciones distintas, así que
        // SIEMPRE le parecían distintas: ningún clic llegaba al gráfico.
        // Aquí no hay arrastre de uPlot (el desplazamiento es nuestro, en
        // interaccion.ts), así que no hay nada que proteger: el clic pasa.
        click: () => {},
      },

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
      // EL RANGO Y SE DECIDE AQUÍ, EN CADA CÁLCULO DE ESCALA: primero el que
      // haya puesto el operario con el EJE Y (zoom / desplazamiento), luego el
      // fijo de la config, y si no, el automático de uPlot. Al ser una
      // función, un dato nuevo no deshace el zoom Y del operario.
      y: {
        auto: !manual,
        range: (_u: uPlot, dMin: number | null, dMax: number | null): [number, number] => {
          const r = p.rangoY();
          if (r) return r;
          if (manual) return [yMin, yMax];
          if (dMin == null || dMax == null) return [0, 1];
          return uPlot.rangeNum(dMin, dMax, 0.1, true) as [number, number];
        },
      },
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
          p.alCambiarVista();
        },
      ],
      setSize: [() => p.alCambiarVista()],
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

  // ── EJE Y DEL OPERARIO ──
  // Zoom y desplazamiento del EJE Y. En un ref porque lo lee la función de
  // rango de uPlot, que vive fuera del render. null = el de la config.
  const yManualRef = useRef<[number, number] | null>(null);
  // ¿El zoom Y lo puso «Mostrar/Ocultar»? Entonces Restablecer X lo quita
  // también (al volver a EN VIVO no debe quedarse pegado). Uno puesto a mano
  // con los botones del EJE Y no se toca.
  const yDeEtiquetasRef = useRef(false);

  // ── VARIABLE RESALTADA (clic en la leyenda) ── `s.id` de la serie.
  const [resaltada, setResaltada] = useState<string | null>(null);

  // ── ETIQUETAS ──
  const [etiquetas, setEtiquetas] = useEtiquetasGuardadas(widget.id);
  const [etiquetando, setEtiquetando] = useState(false);
  const etiquetandoRef = useRef(false);
  etiquetandoRef.current = etiquetando;
  const [nombreEtiqueta, setNombreEtiqueta] = useState('');
  const [avisoEtiqueta, setAvisoEtiqueta] = useState('');
  const [modalEtiquetas, setModalEtiquetas] = useState<null | 'mostrar' | 'eliminar'>(null);
  // Altura del puntero dentro del área de dibujo: solo hace falta (y solo se
  // actualiza) mientras se coloca una etiqueta.
  const [cursorY, setCursorY] = useState<number | null>(null);

  // Las etiquetas se recolocan cuando cambia la vista. Sin limitarlo, en vivo
  // serían diez renders por segundo; con esto, como mucho ~7.
  const hayEtiquetasRef = useRef(false);
  hayEtiquetasRef.current = interactivo && etiquetas.some((e) => e.visible);
  const [, setRevVista] = useState(0);
  const ultimaRev = useRef(0);
  const revPendiente = useRef<number | null>(null);
  const pedirRevVista = useCallback(() => {
    if (!hayEtiquetasRef.current) return;
    const ahora = performance.now();
    if (ahora - ultimaRev.current > 150) {
      ultimaRev.current = ahora;
      setRevVista((n) => n + 1);
    } else if (revPendiente.current == null) {
      revPendiente.current = window.setTimeout(() => {
        revPendiente.current = null;
        ultimaRev.current = performance.now();
        setRevVista((n) => n + 1);
      }, 150);
    }
  }, []);

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
    if (etiquetandoRef.current) {
      const top = u.cursor.top;
      const y = top == null || top < 0 ? null : Math.round(top);
      setCursorY((prev) => (prev === y ? prev : y));
      setAvisoEtiqueta((prev) => (prev ? '' : prev));
    }

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

  /**
   * «Reanudar»: vuelve al último dato y sigue en vivo, PERO con el zoom que
   * haya —el ancho X actual y el Y tal cual—. Restablecer X es el que además
   * devuelve la ventana configurada.
   */
  const reanudar = useCallback(() => {
    if (esHistoricoRef.current) return;
    const u = plot.current;
    siguiendoRef.current = true;
    setSiguiendo(true);
    const r = bufferRef.current?.rango();
    if (!u || !r) return;
    const { min, max } = u.scales.x;
    const ancho = min != null && max != null && max > min ? max - min : cfg.ventanaSeg;
    u.setScale('x', { min: r[1] - ancho, max: r[1] });
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

  // ── EXPORTAR A EXCEL ──────────────────────────────────────────
  //
  // Solo en la Vista Previa, solo en modo vivo y solo si quien diseñó la
  // pantalla lo habilitó. Las tres condiciones van aquí y no dentro del hook
  // para que en el Diseñador no se monte ni el temporizador de sondeo: un
  // lienzo con seis Trends haría seis peticiones por segundo mientras alguien
  // coloca widgets.
  //
  // En modo HISTÓRICO no aparece a propósito. Grabar captura lo que está
  // pasando AHORA; si el gráfico enseña el martes pasado, el Excel traería
  // otro tiempo distinto del que se ve, y nadie entendería el fichero. La
  // descarga del histórico es otra cosa y va por su propio camino.
  const puedeExportar = interactivo && !esHistorico && cfg.exportar;
  const grab = useGrabacionTrend({
    activo: puedeExportar,
    widgetId: widget.id,
    nombre: widget.name || widget.text || 'Tendencia',
    tags: ids,
    intervaloMs: cfg.grabIntervaloMs,
    duracionS: cfg.grabDuracionS,
  });

  // ── DESCARGAR EL HISTÓRICO ────────────────────────────────────
  //
  // El otro lado de la misma moneda: en histórico no se graba, se pide lo que
  // ya está en la base. Se le pasan LAS MISMAS fechas que el gráfico usó para
  // traer sus puntos (`ventanaHist`, que sale de `resolverRango()` y ya viene
  // en UTC), así que el Excel cubre exactamente el rango que se está viendo.
  const puedeBajarHist = interactivo && esHistorico && cfg.exportar;
  const descHist = useDescargaHistorico({
    activo: puedeBajarHist,
    grupoId: cfg.grupoId,
    // El endpoint quiere el tag SIN el prefijo del PLC; `ids` los lleva en el
    // formato de la vista (`"<plc>|<tag>"`). Se parte con `partirId`, que es
    // la única función que sabe hacerlo en todo el proyecto.
    tags: ids.map((id) => partirId(id).tag).filter(Boolean),
    desde: ventanaHist.desde,
    hasta: ventanaHist.hasta,
    // El límite del endpoint es GLOBAL por consulta, no por tag (el mismo
    // motivo por el que el gráfico pide una llamada por serie). Se multiplica
    // por el número de series para que el Excel dé de sí lo mismo que la
    // pantalla, sin pasar del techo que acepta el backend.
    limite: Math.min(100_000, cfg.limiteSerie * Math.max(1, ids.length)),
  });

  // El mensaje de la grabación se enseña EN LA BARRA, en el hueco del rótulo
  // de la vista, y NO como una capa sobre el gráfico —que es lo que hace el
  // error del histórico—. La diferencia es deliberada: en vivo ese gráfico es
  // el proceso, y taparlo entero para decir «no se pudo descargar el Excel»
  // es justo lo que un HMI no puede hacer. Se usa el ámbar del tema, el mismo
  // que ya usa este widget para avisar.
  const mensajeGrab = grab.error || grab.aviso || descHist.error;

  /** Quita el mensaje, venga del camino que venga. */
  const limpiarMensaje = useCallback(() => {
    grab.limpiarMensajes();
    descHist.limpiarError();
  }, [grab, descHist]);

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
  },
  // EN LA VISTA PREVIA el búfer es de la SESIÓN: sobrevive a cambiar de
  // sección (sigue grabando aunque no se vea) y a recargar; cerrar la ventana
  // lo empieza de cero. La llave lleva las variables: si dos copias de una
  // pantalla repiten el id del widget con otras series, no se mezclan.
  interactivo ? { clave: `${widget.id}|${ids.join(',')}` } : undefined);

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
        rangoY: () => yManualRef.current,
        alCambiarVista: pedirRevVista,
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

  // ---- Variable resaltada (clic en la leyenda) -------------------------- //
  //
  // Solo cambia el TRAZO: la elegida más gruesa y las demás tenues. No toca
  // los datos ni el seguimiento: el gráfico sigue corriendo. Va después del
  // efecto que crea el gráfico (misma `firma`) para reaplicarse si se rehace.
  useEffect(() => {
    const u = plot.current;
    if (!u) return;
    const pos = resaltada ? dibujables.findIndex((d) => d.s.id === resaltada) : -1;
    dibujables.forEach(({ s }, k) => {
      const serie = u.series[k + 1];
      if (!serie) return;
      const base = s.grosor ?? 2;
      serie.alpha = pos < 0 || pos === k ? 1 : 0.16;
      serie.width = pos === k ? Math.max(3.6, base + 1.6) : base;
    });
    u.redraw();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resaltada, firma]);

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
    ? fmtFechaHora(tSeñalado)
    : vista
    ? `${fmtFechaHora(vista.min)}  →  ${fmtFechaHora(vista.max)}`
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
    if (!v || v.value === null || v.value === undefined) return null;
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



  // Leyenda: 1 columna hasta 3 variables y 2 desde ahí (nunca más). Hasta 8
  // se llena por columnas; con más, se enseñan 4 filas y el resto con SCROLL,
  // y entonces se llena por filas (1 2 / 3 4 …) para que al bajar se siga
  // el orden sin saltar de columna.
  const columnasLeyenda = dibujables.length <= 3 ? 1 : 2;
  const leyendaConScroll = dibujables.length > 8;
  const filasLeyenda = Math.max(1, Math.ceil(dibujables.length / columnasLeyenda));
  const columnaDe = (pos: number) =>
    leyendaConScroll ? pos % columnasLeyenda : Math.floor(pos / filasLeyenda);
  // 4 filas (alto de línea 1.6) + 3 huecos de 2 px (el relleno va aparte).
  const altoLeyenda4 = Math.ceil(4 * tamLeyenda * 1.6 + 3 * 2);

  // ---- EJE Y -------------------------------------------------------------- //
  //
  // Como el ejemplo de planta: zoom ×1.25 / ×0.8 sobre el CENTRO del rango
  // visible, flechas que mueven un 20 % del alto, y Restablecer Y que vuelve
  // a la config (autoescala o mín/máx fijos). NADA de esto pausa: el gráfico
  // sigue corriendo; solo cambia qué franja de valores se ve.
  const yMinCfg = Number(cfg.min);
  const yMaxCfg = Number(cfg.max);
  const yFijoCfg =
    !cfg.autoEscala && Number.isFinite(yMinCfg) && Number.isFinite(yMaxCfg) && yMaxCfg > yMinCfg;
  const aplicarY = () => {
    const u = plot.current;
    if (!u) return;
    const r = yManualRef.current;
    if (r) u.setScale('y', { min: r[0], max: r[1] });
    else if (yFijoCfg) u.setScale('y', { min: yMinCfg, max: yMaxCfg });
    else {
      // Autoescala: recalcular X tal cual hace que uPlot vuelva a medir Y.
      const { min, max } = u.scales.x;
      if (min != null && max != null) u.setScale('x', { min, max });
    }
  };
  const rangoYActual = (): [number, number] | null => {
    const u = plot.current;
    const min = u?.scales.y.min;
    const max = u?.scales.y.max;
    return min == null || max == null ? null : [min, max];
  };
  const zoomY = (factor: number) => {
    yDeEtiquetasRef.current = false;
    const r = rangoYActual();
    if (!r) return;
    const c = (r[0] + r[1]) / 2;
    const alto = Math.min(1e9, Math.max(0.01, (r[1] - r[0]) * factor));
    yManualRef.current = [c - alto / 2, c + alto / 2];
    aplicarY();
  };
  const moverY = (signo: 1 | -1) => {
    yDeEtiquetasRef.current = false;
    const r = rangoYActual();
    if (!r) return;
    const d = (r[1] - r[0]) * 0.2 * signo;
    yManualRef.current = [r[0] + d, r[1] + d];
    aplicarY();
  };
  const restablecerY = () => {
    yDeEtiquetasRef.current = false;
    yManualRef.current = null;
    aplicarY();
  };

  // ---- ETIQUETAS ---------------------------------------------------------- //

  /** Píxeles dentro del área de dibujo, o null si (t, y) no está en la vista. */
  const posEnArea = (t: number, y: number) => {
    const u = plot.current;
    if (!u) return null;
    const { min: x0, max: x1 } = u.scales.x;
    const { min: y0, max: y1 } = u.scales.y;
    if (x0 == null || x1 == null || y0 == null || y1 == null) return null;
    if (t < x0 || t > x1 || y < y0 || y > y1) return null;
    return { x: u.valToPos(t, 'x'), y: u.valToPos(y, 'y') };
  };

  /** Nombre completo de una serie, como en la leyenda. */
  const nombreSerie = (variableId: string, etiqueta: string, i: number) =>
    etiqueta || variables.find((v) => v.id === variableId)?.name || `Serie ${i + 1}`;

  /**
   * Mientras se coloca una etiqueta: dónde va el punto.
   *
   * PRECISO SOBRE LO QUE SE VE DIBUJADO. Con datos densos (muchas muestras
   * por píxel, o una señal que sube y baja muy rápido) la línea, en una misma
   * columna de píxeles, cubre todo un TRAMO vertical, no un punto. Antes se
   * tomaba un único valor interpolado y el punto saltaba a un extremo aunque
   * el ratón estuviera encima de la línea. Ahora, por cada curva, se mira qué
   * tramo vertical ocupa en ±2 px alrededor del ratón:
   *   - si el ratón está DENTRO de ese tramo, el punto va exactamente a la
   *     altura del ratón (está sobre la línea);
   *   - si no, al borde más cercano del tramo.
   * Gana la curva más cercana. Así se puede poner en cualquier parte de
   * cualquier línea dibujada.
   */
  const puntoEtiqueta = (() => {
    if (!etiquetando || !señalando || cursorY == null || !posRegla) return null;
    const u = plot.current;
    if (!u) return null;
    const xs = u.data[0] as unknown as number[];
    if (!xs || xs.length === 0) return null;
    const t = u.posToVal(posRegla.x, 'x');
    if (!Number.isFinite(t) || t < xs[0] || t > xs[xs.length - 1]) return null;

    /** Último índice con tiempo <= tt. */
    const indiceHasta = (tt: number): number => {
      let lo = 0;
      let hi = xs.length - 1;
      if (tt <= xs[0]) return 0;
      while (hi - lo > 1) {
        const m = (lo + hi) >> 1;
        if (xs[m] <= tt) lo = m;
        else hi = m;
      }
      return xs[hi] <= tt ? hi : lo;
    };
    /** Valor de la curva k en el instante tt (interpolado), o null en un hueco. */
    const valorEn = (k: number, tt: number): number | null => {
      const col = u.data[k + 1] as unknown as (number | null)[] | undefined;
      if (!col) return null;
      const i = indiceHasta(tt);
      const j = Math.min(i + 1, xs.length - 1);
      const a = col[i];
      const b = col[j];
      if (a == null || !Number.isFinite(a)) return b == null || !Number.isFinite(b) ? null : b;
      if (b == null || !Number.isFinite(b) || xs[j] === xs[i]) return a;
      return a + ((b - a) * (tt - xs[i])) / (xs[j] - xs[i]);
    };

    const tIzq = u.posToVal(posRegla.x - 2, 'x');
    const tDer = u.posToVal(posRegla.x + 2, 'x');
    const iIzq = indiceHasta(tIzq);
    const iDer = indiceHasta(tDer);

    let mejor: { k: number; y: number; d: number } | null = null;
    dibujables.forEach((_d, k) => {
      const col = u.data[k + 1] as unknown as (number | null)[] | undefined;
      if (!col) return;
      let mn = Infinity;
      let mx = -Infinity;
      const ver = (v: number | null | undefined) => {
        if (v == null || !Number.isFinite(v)) return;
        if (v < mn) mn = v;
        if (v > mx) mx = v;
      };
      ver(valorEn(k, tIzq));
      ver(valorEn(k, tDer));
      for (let i = iIzq + 1; i <= iDer; i++) ver(col[i]);
      if (mn === Infinity) return;
      const arriba = u.valToPos(mx, 'y');
      const abajo = u.valToPos(mn, 'y');
      const y = Math.min(abajo, Math.max(arriba, cursorY));
      const d = Math.abs(cursorY - y);
      if (!mejor || d < mejor.d) mejor = { k, y, d };
    });
    const m = mejor as { k: number; y: number; d: number } | null;
    if (!m) return null;
    const v = u.posToVal(m.y, 'y');
    const { s, i } = dibujables[m.k];
    // Lo que valía cada variable en ese instante; la elegida, el valor
    // exacto del punto (es lo que se ve sobre la línea).
    const valores = dibujables.map((_d, k) => (k === m.k ? v : valorEn(k, t)));
    return {
      t,
      v,
      x: posRegla.x,
      y: m.y,
      valores,
      color: colorEfectivo(s.color, i, isDark),
      nombre: nombreSerie(s.variableId, s.etiqueta, i),
    };
  })();

  const terminarEtiquetado = () => {
    setEtiquetando(false);
    setAvisoEtiqueta('');
    setCursorY(null);
  };
  const empezarEtiquetado = () => {
    if (etiquetando) {
      terminarEtiquetado();
      return;
    }
    // Pausa la VISTA (como el zoom): los datos se siguen guardando.
    interaccion.alTomarControl();
    setNombreEtiqueta(siguienteNombre(etiquetas));
    setAvisoEtiqueta('');
    setEtiquetando(true);
  };
  const guardarEtiqueta = () => {
    const nombre = nombreEtiqueta.trim();
    if (!nombre) {
      setAvisoEtiqueta('Escribe un nombre antes de hacer clic en el gráfico.');
      return;
    }
    const p = puntoEtiqueta;
    const u = plot.current;
    if (!p || !u) {
      setAvisoEtiqueta('Acércate a una de las líneas de la gráfica para guardar la etiqueta.');
      return;
    }
    // La FOTO de todas las variables en ese instante: la etiqueta no depende
    // de que el dato siga en memoria mañana.
    const lecturas = dibujables.map(({ s, i }, k) => {
      const v = p.valores[k];
      return {
        nombre: nombreSerie(s.variableId, s.etiqueta, i),
        color: colorEfectivo(s.color, i, isDark),
        valor: v == null || !Number.isFinite(v) ? null : v,
        unidad: variables.find((x) => x.id === s.variableId)?.unit,
      };
    });
    const nueva: EtiquetaTrend = {
      id: `e${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`,
      nombre,
      t: p.t,
      y: p.v,
      color: p.color,
      curva: p.nombre,
      lecturas,
      visible: true,
      expandida: false,
    };
    setEtiquetas((l) => [...l, nueva]);
    terminarEtiquetado();
  };
  const guardarEtiquetaRef = useRef(guardarEtiqueta);
  guardarEtiquetaRef.current = guardarEtiqueta;

  // El clic que guarda: directo sobre el área de dibujo de uPlot.
  useEffect(() => {
    if (!etiquetando || !areaDibujo) return;
    const alClic = (e: MouseEvent) => {
      if ((e.target as HTMLElement | null)?.closest?.('[data-trend-ui]')) return;
      guardarEtiquetaRef.current();
    };
    areaDibujo.addEventListener('click', alClic);
    areaDibujo.style.cursor = 'copy';
    return () => {
      areaDibujo.removeEventListener('click', alClic);
      areaDibujo.style.cursor = 'crosshair';
    };
  }, [etiquetando, areaDibujo]);

  // Escape cancela.
  useEffect(() => {
    if (!etiquetando) return;
    const tecla = (e: KeyboardEvent) => {
      if (e.key === 'Escape') terminarEtiquetado();
    };
    window.addEventListener('keydown', tecla);
    return () => window.removeEventListener('keydown', tecla);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [etiquetando]);

  const alternarEtiqueta = (id: string) =>
    setEtiquetas((l) => l.map((e) => (e.id === id ? { ...e, expandida: !e.expandida } : e)));

  /**
   * «Aplicar» de Mostrar/Ocultar: quedan visibles las marcadas y el gráfico
   * se lleva a ellas (a las 3 más recientes si son más), como el ejemplo.
   */
  const aplicarMostrar = (ids: Set<string>) => {
    setEtiquetas((l) => l.map((e) => ({ ...e, visible: ids.has(e.id) })));
    setModalEtiquetas(null);
    const elegidas = etiquetas.filter((e) => ids.has(e.id));
    const u = plot.current;
    if (!elegidas.length || !u) return;
    const recientes = [...elegidas].sort((a, b) => b.t - a.t).slice(0, 3);
    const primero = Math.min(...recientes.map((e) => e.t));
    const ultimo = Math.max(...recientes.map((e) => e.t));
    // ZOOM X AJUSTADO a las etiquetas: lo que las separa más un margen a
    // cada lado (un 25 %, mínimo 20 s), y como mínimo 1 minuto. Antes eran
    // 15 min como poco: con el preview recién abierto, casi todo era vacío.
    const separacion = ultimo - primero;
    // Tramo REAL grabado (primer y último instante con algún valor): la
    // ventana no debe mostrar vacío antes del primer dato.
    const xs = u.data[0] as ArrayLike<number>;
    let t0 = Infinity;
    let t1 = -Infinity;
    for (let i = 0; i < xs.length; i++) {
      let hay = false;
      for (let k = 1; k < u.data.length && !hay; k++) hay = u.data[k][i] != null;
      if (hay) { t0 = Math.min(t0, xs[i]); t1 = Math.max(t1, xs[i]); }
    }
    let ancho = Math.max(60, separacion + 2 * Math.max(separacion * 0.25, 20));
    // Si lo grabado es más corto que esa ventana, se ajusta a lo grabado
    // (sin cortar las etiquetas).
    if (t1 > t0) ancho = Math.max(Math.min(ancho, t1 - t0), separacion * 1.2, 2);
    let centro = (primero + ultimo) / 2;
    if (t1 > t0) {
      if (centro - ancho / 2 < t0) centro = Math.min(t0 + ancho / 2, primero + ancho / 2);
      if (centro + ancho / 2 > t1) centro = Math.max(t1 - ancho / 2, ultimo - ancho / 2);
    }
    // Pausa la VISTA (los datos se siguen guardando) y la lleva a ellas.
    interaccion.alTomarControl();
    //
    // ZOOM Y a las etiquetas, como el ejemplo de planta.
    const lo = Math.min(...recientes.map((e) => e.y));
    const hi = Math.max(...recientes.map((e) => e.y));
    const visto = rangoYActual();
    const altoVisto = visto ? visto[1] - visto[0] : 0;
    // Ajustado pero con algo de contexto: un 25 % de lo que separa las
    // etiquetas, o un 12 % de lo que se estaba viendo, lo que sea mayor.
    const margen = Math.max((hi - lo) * 0.25, altoVisto * 0.12, Math.abs(hi) * 0.01, 1e-6);
    yManualRef.current = [lo - margen, hi + margen];
    yDeEtiquetasRef.current = true;
    // OJO con el orden: uPlot aplica `setScale` un instante DESPUÉS. Primero
    // el Y (la función de rango ya devuelve el de las etiquetas) y X al final.
    u.setScale('y', { min: lo - margen, max: hi + margen });
    u.setScale('x', encajar(centro - ancho / 2, centro + ancho / 2, interaccion.limites()));
  };
  const aplicarEliminar = (ids: Set<string>) => {
    setEtiquetas((l) => l.filter((e) => !ids.has(e.id)));
    setModalEtiquetas(null);
  };

  // ---- Columna derecha: logo y herramientas ---------------------------- //
  //
  // Si está, el widget pasa a ser una FILA: el Trend de siempre (que se
  // achica) y, separada 12 px, la columna. Sin ella, todo queda como antes.
  const conColumna = cfg.logo || cfg.herramientas;
  const marco: React.CSSProperties = conColumna
    ? { ...marcoWidget(pCaja, fondo, tema), width: 'auto', flex: 1, minWidth: 0 }
    : marcoWidget(pCaja, fondo, tema);
  const envolver = (nucleo: React.ReactElement): React.ReactElement =>
    conColumna ? (
      <div
        style={{
          display: 'flex',
          width: '100%',
          height: '100%',
          gap: 12,
          boxSizing: 'border-box',
        }}
      >
        {nucleo}
        <ColumnaTrend
          tema={tema}
          interactivo={!!interactivo}
          logo={cfg.logo}
          logoAncho={cfg.logoAncho}
          logoAlto={cfg.logoAlto}
          herramientas={cfg.herramientas}
          herramientasAncho={cfg.herramientasAncho}
          // DETENER / REANUDAR (en histórico no hay «en vivo»: sin acción).
          detener={
            esHistorico ?
            undefined :
            { siguiendo, alternar: siguiendo ? interaccion.alTomarControl : reanudar }
          }
          // EJE X: lo mismo que hacían las flechas y las lupas de la barra.
          ejeX={{
            atras: () => plot.current && desplazar(plot.current, -0.3, interaccion),
            adelante: () => plot.current && desplazar(plot.current, 0.3, interaccion),
            // El zoom pausa la vista (los datos se siguen guardando).
            alejar: () => plot.current && zoomPausando(plot.current, 1.5, interaccion),
            acercar: () => plot.current && zoomPausando(plot.current, 1 / 1.5, interaccion),
            menosHora: () => plot.current && desplazarSegundos(plot.current, -3600, interaccion),
            masHora: () => plot.current && desplazarSegundos(plot.current, 3600, interaccion),
            // De vuelta a EN VIVO con la ventana configurada (o, en
            // histórico, al rango completo que se pidió).
            restablecer: () => {
              // Si el Y venía de «Mostrar/Ocultar», se suelta ANTES de mover
              // X: al moverse X la autoescala Y se recalcula sola.
              if (yDeEtiquetasRef.current) {
                yDeEtiquetasRef.current = false;
                yManualRef.current = null;
                if (yFijoCfg) plot.current?.setScale('y', { min: yMinCfg, max: yMaxCfg });
              }
              volverAVivo();
            },
          }}
          // EJE Y: no pausa nada.
          ejeY={{
            alejar: () => zoomY(1.25),
            acercar: () => zoomY(0.8),
            bajar: () => moverY(-1),
            subir: () => moverY(1),
            restablecer: restablecerY,
          }}
          etiquetas={{
            agregar: empezarEtiquetado,
            mostrar: () => setModalEtiquetas('mostrar'),
            eliminar: () => setModalEtiquetas('eliminar'),
            agregando: etiquetando,
          }}
        />
      </div>
    ) : (
      nucleo
    );

  // ---- Estado vacío: ni siquiera hay series configuradas --------------- //
  if (sinSeries) {
    return envolver(
      <div style={marco}>
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

  return envolver(
    <div style={marco}>
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
            color: mensajeGrab
              ? tema.pausa
              : señalando
              ? fuerte
              : tema.tintaSuave,
            fontWeight: mensajeGrab || señalando ? 600 : 400,
            cursor: mensajeGrab ? 'pointer' : 'default',
          }}
          // El texto de la barra se recorta con puntos suspensivos, así que
          // el mensaje entero va en el `title`. Y se quita al pulsarlo: un
          // aviso que no se puede cerrar acaba siendo parte del decorado.
          title={mensajeGrab || undefined}
          onClick={mensajeGrab ? limpiarMensaje : undefined}
        >
          {mensajeGrab || etiquetaVista}
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

        {/* ── DESCARGAR EL HISTÓRICO ──
            En histórico no hay nada que grabar: los datos ya están en la
            base. Un solo botón, sin ciclo. Ocupa el mismo sitio que el de
            grabar porque los dos modos no conviven: o uno o el otro. */}
        {puedeBajarHist && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              flexShrink: 0,
              padding: 2,
              borderRadius: 7,
              border: `1px solid ${tema.borde}`,
            }}
          >
            <BotonBarra
              tema={tema}
              titulo={
                descHist.motivoBloqueo ||
                `Descargar en Excel lo que se está viendo (${ids.length} ` +
                  `variable(s), ${ventanaHist.desde.slice(0, 19).replace('T', ' ')}` +
                  ` → ${ventanaHist.hasta.slice(0, 19).replace('T', ' ')} UTC)`
              }
              onClick={descHist.motivoBloqueo ? limpiarMensaje : descHist.descargar}
            >
              {descHist.bajando ? (
                <Loader2Icon
                  className="animate-spin"
                  style={{ width: 12, height: 12 }}
                />
              ) : (
                <DownloadIcon
                  style={{
                    width: 13,
                    height: 13,
                    // Apagado cuando falta el grupo o las series. No se
                    // esconde: un botón que desaparece deja a quien lo busca
                    // pensando que la función no existe, y el tooltip ya
                    // explica qué falta.
                    opacity: descHist.motivoBloqueo ? 0.4 : 1,
                  }}
                />
              )}
            </BotonBarra>
          </div>
        )}

        {/* ── GRABAR A EXCEL ──
            Un grupo aparte del de zoom, con su propio marco: no son gestos
            sobre el gráfico, son una acción sobre los datos. Y a la izquierda
            de los gestos porque se pulsa mucho menos.

            Los cuatro estados del hook no caben en un botón que cambie de
            icono: «grabando» necesita además el contador, y «lista» son dos
            acciones (bajar y descartar). Por eso se pinta uno u otro. */}
        {puedeExportar && (
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
            {grab.fase === 'grabando' ? (
              <>
                <span
                  title={`${grab.muestras} muestra(s) capturada(s)`}
                  style={{
                    padding: '0 5px',
                    fontSize: 9.5,
                    fontWeight: 700,
                    fontVariantNumeric: 'tabular-nums',
                    color: ROJO_GRABANDO,
                    letterSpacing: '.04em',
                  }}
                >
                  {/* El contador es lo único que dice que esto sigue vivo:
                      una grabación indefinida no tiene barra de progreso
                      contra la que medir. Si el número no sube, algo pasa. */}
                  ● {grab.muestras}
                </span>
                <BotonBarra
                  tema={tema}
                  titulo="Parar la grabación y preparar el Excel"
                  onClick={grab.parar}
                >
                  <SquareIcon style={{ width: 12, height: 12 }} />
                </BotonBarra>
              </>
            ) : grab.fase === 'lista' ? (
              <>
                <BotonBarra
                  tema={tema}
                  titulo={
                    grab.descargable
                      ? `Descargar el Excel (${grab.muestras} fila(s))`
                      : 'La grabación no capturó ninguna muestra'
                  }
                  onClick={grab.descargable ? grab.descargar : grab.descartar}
                >
                  <DownloadIcon
                    style={{
                      width: 13,
                      height: 13,
                      opacity: grab.descargable ? 1 : 0.4,
                    }}
                  />
                </BotonBarra>
                <BotonBarra
                  tema={tema}
                  titulo="Descartar esta grabación y liberar la memoria del servidor"
                  onClick={grab.descartar}
                >
                  <Trash2Icon style={{ width: 12, height: 12 }} />
                </BotonBarra>
              </>
            ) : grab.fase === 'inactiva' ? (
              <BotonBarra
                tema={tema}
                titulo={`Grabar a Excel · cada ${fmtDuracion(
                  cfg.grabIntervaloMs / 1000
                )}, ${
                  cfg.grabDuracionS
                    ? `durante ${fmtDuracion(cfg.grabDuracionS)}`
                    : 'hasta pararla'
                }`}
                onClick={grab.iniciar}
              >
                {/* Un punto rojo y no un icono: es el mando de grabar de
                    cualquier aparato, y se reconoce sin leer el tooltip. */}
                <span
                  style={{
                    width: 9,
                    height: 9,
                    borderRadius: 999,
                    background: ROJO_GRABANDO,
                    flexShrink: 0,
                  }}
                />
              </BotonBarra>
            ) : (
              <span
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  width: 24,
                  height: 22,
                  color: tema.tintaSuave,
                }}
              >
                <Loader2Icon
                  className="animate-spin"
                  style={{ width: 12, height: 12 }}
                />
              </span>
            )}
          </div>
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
          {/* Las flechas y el zoom del tiempo ya no van aquí: están en el
              panel de herramientas de la derecha (EJE X). */}
          <BotonBarra
            tema={tema}
            titulo="Ver todo lo guardado en memoria"
            onClick={() => plot.current && ajustar(plot.current, interaccion)}
          >
            <MaximizeIcon style={{ width: 13, height: 13 }} />
          </BotonBarra>
        </div>

        {/* ── Título ── a la derecha de la barra, como en las pantallas
            de planta. Toma el color del texto del widget. */}
        {cfg.titulo.trim() && (
          <span
            title={cfg.titulo}
            style={{
              flexShrink: 1,
              minWidth: 0,
              maxWidth: '50%',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              marginLeft: 4,
              fontSize: 13.5,
              fontWeight: 700,
              color: colorTinta,
            }}
          >
            {cfg.titulo}
          </span>
        )}
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
          className={etiquetando ? `${CLASE_TREND} trend-etiquetando` : CLASE_TREND}
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

        {/* ── ETIQUETAS ── las guardadas, el punto que sigue a la curva y
            el cuadro del nombre mientras se coloca una. */}
        {interactivo && areaDibujo && etiquetas.some((e) => e.visible) && (
          <CapaEtiquetas
            area={areaDibujo}
            etiquetas={etiquetas}
            posDe={posEnArea}
            tema={tema}
            fuerte={fuerte}
            onAlternar={alternarEtiqueta}
          />
        )}
        {etiquetando && areaDibujo && puntoEtiqueta && (
          <PuntoEtiqueta
            area={areaDibujo}
            x={puntoEtiqueta.x}
            y={puntoEtiqueta.y}
            color={puntoEtiqueta.color}
          />
        )}
        {etiquetando && (
          <CuadroNombre
            tema={tema}
            fuerte={fuerte}
            valor={nombreEtiqueta}
            onCambiar={setNombreEtiqueta}
            ayuda={
              avisoEtiqueta ||
              (puntoEtiqueta
                ? `Haz clic para guardar la etiqueta sobre ${puntoEtiqueta.nombre}.`
                : 'Acércate a una de las líneas para guardar la etiqueta.')
            }
            onCancelar={terminarEtiquetado}
          />
        )}
        {modalEtiquetas && (
          <ModalEtiquetas
            modo={modalEtiquetas}
            etiquetas={etiquetas}
            tema={tema}
            fuerte={fuerte}
            onAceptar={modalEtiquetas === 'mostrar' ? aplicarMostrar : aplicarEliminar}
            onCerrar={() => setModalEtiquetas(null)}
          />
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
          className="psi-trend-leyenda"
          style={{
            ['--tl-barra' as any]: tema.borde,
            ['--tl-barra-encima' as any]: tema.tintaSuave,
            // EN COLUMNAS, LLENADAS DE ARRIBA ABAJO (como la pantalla de
            // planta): nombre a la izquierda, valor alineado a la derecha y
            // todas las filas a la misma altura. Antes cada elemento medía lo
            // que le tocaba y los valores quedaban a saltos.
            display: 'grid',
            gridTemplateColumns: `repeat(${columnasLeyenda}, minmax(0, 1fr))`,
            gridTemplateRows: leyendaConScroll ? undefined : `repeat(${filasLeyenda}, auto)`,
            gridAutoFlow: leyendaConScroll ? 'row' : 'column',
            columnGap: 28,
            rowGap: 2,
            padding: '6px 14px',
            maxHeight: leyendaConScroll ? altoLeyenda4 : '40%',
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
            const esResaltada = resaltada === s.id;
            return (
              <span
                key={s.id}
                title={
                  interactivo
                    ? `${completo} — clic para ${esResaltada ? 'quitar el resaltado' : 'resaltarla en el gráfico'}`
                    : completo
                }
                // Clic en el nombre o el valor: resalta su línea (otro clic
                // lo quita). No pausa nada.
                onClick={
                  interactivo
                    ? () => setResaltada((prev) => (prev === s.id ? null : s.id))
                    : undefined
                }
                role={interactivo ? 'button' : undefined}
                aria-pressed={interactivo ? esResaltada : undefined}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  minWidth: 0,
                  fontSize: tamLeyenda,
                  lineHeight: 1.6,
                  cursor: interactivo ? 'pointer' : 'default',
                  fontWeight: esResaltada ? 700 : undefined,
                  // Separador entre columnas (salvo en la primera).
                  paddingLeft: columnaDe(pos) > 0 ? 14 : 0,
                  borderLeft:
                    columnaDe(pos) > 0 ? `1px solid ${tema.borde}` : 'none',
                }}
              >
                <span
                  style={{
                    width: 12,
                    height: esResaltada ? 5 : 3,
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
                    color: esResaltada ? fuerte : tema.tintaSuave,
                  }}
                >
                  {corto}
                </span>
                <b
                  style={{
                    flexShrink: 0,
                    minWidth: 64,
                    textAlign: 'right',
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

/**
 * Campo de píxeles que SE PUEDE ESCRIBIR: el texto es local mientras se
 * edita (se puede borrar todo y teclear otro número) y se aplica en cuanto es
 * válido. Al salir o con Enter se ajusta al rango; Escape devuelve el valor.
 * Antes el campo iba atado al valor ya limitado: al borrar quedaba 0, saltaba
 * al mínimo y solo servían las flechas.
 */
function NumeroPx({
  valor,
  min,
  max,
  alCambiar,
}: {
  valor: number;
  min: number;
  max: number;
  alCambiar: (n: number) => void;
}) {
  const [texto, setTexto] = useState(String(valor));
  const editando = useRef(false);
  useEffect(() => {
    if (!editando.current) setTexto(String(valor));
  }, [valor]);
  const confirmar = () => {
    editando.current = false;
    const n = Number(texto);
    const final = texto.trim() !== '' && Number.isFinite(n)
      ? Math.min(max, Math.max(min, Math.round(n)))
      : valor;
    setTexto(String(final));
    if (final !== valor) alCambiar(final);
  };
  return (
    <input
      type="number"
      min={min}
      max={max}
      value={texto}
      onFocus={() => { editando.current = true; }}
      onChange={(e) => {
        editando.current = true;
        setTexto(e.target.value);
        const n = Number(e.target.value);
        if (e.target.value.trim() !== '' && Number.isFinite(n) && n >= min && n <= max) {
          alCambiar(Math.round(n));
        }
      }}
      onBlur={confirmar}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        if (e.key === 'Escape') {
          editando.current = false;
          setTexto(String(valor));
          (e.target as HTMLInputElement).blur();
        }
      }}
      className={INPUT}
    />
  );
}

function InspectorTrend({ config, setConfig }: InspectorCtx) {
  const cfg = leerConfigTrend(config);
  const { selectedVariables, isDark } = useAppStore();
  const esHistorico = cfg.origen === 'historico';
  const { grupos, cargando: cargandoGrupos, error: errorGrupos } = useGrupos(esHistorico);
  const grupoElegido = grupos.find((g) => g.grupo_id === cfg.grupoId);
  const [abiertoVarias, setAbiertoVarias] = useState(false);

  // ── DURACIÓN PERSONALIZADA ──
  //
  // El modo va en estado y no se deduce del valor, y la diferencia importa:
  // deduciéndolo, elegir «Personalizada» con 60 s puestos volvería solo al
  // desplegable —60 está en la lista— y el campo se cerraría en la cara de
  // quien acaba de abrirlo. Arranca abierto si el valor guardado no es
  // ninguno de los atajos, que es la única señal fiable al cargar.
  const [duracionLibre, setDuracionLibre] = useState(
    () => !DURACIONES_GRAB.some((d) => d.v === leerConfigTrend(config).grabDuracionS)
  );
  // La unidad es SOLO de presentación: lo que se guarda son segundos.
  const [unidadDuracion, setUnidadDuracion] = useState(
    () => unidadDe(leerConfigTrend(config).grabDuracionS)
  );

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

      <label className="block">
        <span className="mb-1 block text-xs font-medium text-slate-500 dark:text-slate-400">
          Título del gráfico
        </span>
        <input
          type="text"
          value={cfg.titulo}
          onChange={(e) => set({ titulo: e.target.value })}
          placeholder="p. ej. Variables Lazos Críticos - Lavado Línea 3"
          className={INPUT}
        />
      </label>

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
                  {/* El nombre en su PROPIA fila, a todo el ancho. Compartía
                      fila con el grosor y quedaba aplastado en un cuadrito
                      donde no se veía lo escrito. */}
                  <input
                    type="text"
                    value={s.etiqueta}
                    onChange={(e) => editar(s.id, { etiqueta: e.target.value })}
                    placeholder={`Nombre en el gráfico (${
                      numericas.find((v) => v.id === s.variableId)?.name ?? 'opcional'
                    })`}
                    title="Nombre que sale en la leyenda y en la regla. Vacío = el de la variable."
                    className={`${INPUT} text-[11px]`}
                  />
                  <div className="flex gap-1">
                    <select
                      value={String(s.grosor ?? 2)}
                      onChange={(e) => editar(s.id, { grosor: Number(e.target.value) })}
                      title="Grosor de la línea"
                      className={`${INPUT} text-[11px]`}
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

      {/* ── Columna derecha: logo y herramientas ── */}
      <label className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-slate-500 dark:text-slate-400">
          Reservar espacio para logo
        </span>
        <input
          type="checkbox"
          checked={cfg.logo}
          onChange={(e) => set({ logo: e.target.checked })}
          className="h-4 w-4 rounded border-slate-300 text-siemens focus:ring-2 focus:ring-siemens/40 dark:border-navy-slate dark:bg-navy"
        />
      </label>
      {cfg.logo && (
        <div className="space-y-1.5">
          <div className="grid grid-cols-2 gap-2">
            <label className="block">
              <span className="mb-1 block text-[11px] text-slate-500 dark:text-slate-400">
                Ancho (px)
              </span>
              <NumeroPx
                valor={cfg.logoAncho}
                min={20}
                max={1200}
                alCambiar={(n) => set({ logoAncho: n })}
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-[11px] text-slate-500 dark:text-slate-400">
                Alto (px)
              </span>
              <NumeroPx
                valor={cfg.logoAlto}
                min={20}
                max={1200}
                alCambiar={(n) => set({ logoAlto: n })}
              />
            </label>
          </div>
          <p className="text-[10px] leading-relaxed text-slate-400">
            Deja un hueco vacío arriba a la derecha del gráfico. Coloca encima
            un widget de Imagen con el logo.
          </p>
        </div>
      )}

      <label className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-slate-500 dark:text-slate-400">
          Mostrar herramientas
        </span>
        <input
          type="checkbox"
          checked={cfg.herramientas}
          onChange={(e) => set({ herramientas: e.target.checked })}
          className="h-4 w-4 rounded border-slate-300 text-siemens focus:ring-2 focus:ring-siemens/40 dark:border-navy-slate dark:bg-navy"
        />
      </label>
      {cfg.herramientas && (
        <div className="space-y-1.5">
          <label className="block">
            <span className="mb-1 block text-[11px] text-slate-500 dark:text-slate-400">
              Ancho del panel (px)
            </span>
            <NumeroPx
              valor={cfg.herramientasAncho}
              min={150}
              max={600}
              alCambiar={(n) => set({ herramientasAncho: n })}
            />
          </label>
          <p className="text-[10px] leading-relaxed text-slate-400">
            Detener/Reanudar, Eje X, Eje Y y Etiquetas a la derecha del
            gráfico. Funcionan en la vista previa.
          </p>
        </div>
      )}

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

      {/* ══ EXPORTAR A EXCEL ══════════════════════════════════════
          Va al final y detrás de un separador porque no configura el
          GRÁFICO: configura qué puede hacer el operador con él. */}
      <div className="border-t border-slate-200 pt-3 dark:border-navy-slate">
        <label className="flex items-center justify-between gap-2">
          <span className="text-xs font-medium text-slate-500 dark:text-slate-400">
            Permitir exportar a Excel
          </span>
          <input
            type="checkbox"
            checked={cfg.exportar}
            onChange={(e) => set({ exportar: e.target.checked })}
            className="h-4 w-4 rounded border-slate-300 text-siemens focus:ring-2 focus:ring-siemens/40 dark:border-navy-slate dark:bg-navy"
          />
        </label>
        <span className="mt-1 block text-[10px] leading-relaxed text-slate-400">
          {esHistorico
            ? 'Añade a la barra un botón que descarga en Excel exactamente estas series y este rango. Apagado por defecto: el endpoint de exportación no comprueba el rol del usuario, así que se habilita pantalla por pantalla.'
            : 'Añade a la barra del gráfico los botones de grabar, parar y descargar. Apagado por defecto: el endpoint de exportación no comprueba el rol del usuario, así que se habilita pantalla por pantalla.'}
        </span>
      </div>

      {/* Los ajustes de la grabación solo estorban si no se va a exportar, y
          solo tienen sentido en vivo: en histórico no se graba nada. */}
      {cfg.exportar && !esHistorico && (
        <>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-slate-500 dark:text-slate-400">
              Muestra cada
            </span>
            <select
              value={String(cfg.grabIntervaloMs)}
              onChange={(e) => set({ grabIntervaloMs: Number(e.target.value) })}
              className={INPUT}
            >
              {INTERVALOS_GRAB.map((o) => (
                <option key={o.v} value={o.v}>
                  {o.t}
                </option>
              ))}
            </select>
            <span className="mt-1 block text-[10px] leading-relaxed text-slate-400">
              Cada cuánto se escribe una fila con TODAS las series a la vez. No
              es el refresco del gráfico: es el detalle del fichero.
            </span>
          </label>

          <label className="block">
            <span className="mb-1 block text-xs font-medium text-slate-500 dark:text-slate-400">
              Duración de la grabación
            </span>
            <select
              value={duracionLibre ? 'otro' : String(cfg.grabDuracionS)}
              onChange={(e) => {
                if (e.target.value === 'otro') {
                  // No se toca el valor: se abre el campo con lo que ya
                  // había. Poner un número «de ejemplo» al abrir pisaría una
                  // duración que alguien acababa de elegir a conciencia.
                  setUnidadDuracion(unidadDe(cfg.grabDuracionS));
                  setDuracionLibre(true);
                  return;
                }
                setDuracionLibre(false);
                set({ grabDuracionS: Number(e.target.value) });
              }}
              className={INPUT}
            >
              {DURACIONES_GRAB.map((o) => (
                <option key={o.v} value={o.v}>
                  {o.t}
                </option>
              ))}
              <option value="otro">Personalizada…</option>
            </select>

            {duracionLibre && (
              <div className="mt-1.5 grid grid-cols-[1fr_auto] gap-2">
                <input
                  type="number"
                  min={0}
                  // El tope del campo va en la unidad que se esté usando, así
                  // el navegador avisa antes de escribir «48» en horas.
                  max={Math.floor(GRAB_DURACION_MAX_S / unidadDuracion)}
                  step={1}
                  value={
                    cfg.grabDuracionS
                      ? String(cfg.grabDuracionS / unidadDuracion)
                      : ''
                  }
                  placeholder="0 = hasta pararla"
                  onChange={(e) => {
                    const n = Number(e.target.value);
                    // Se acota contra el MISMO límite que valida el backend
                    // (`duracion_s: ge=0, le=86400`). Sin esto, escribir 48
                    // horas se manda igual y el servidor responde un 422 que
                    // el operario lee como «no se pudo grabar».
                    set({
                      grabDuracionS: limitar(
                        (Number.isFinite(n) ? n : 0) * unidadDuracion,
                        0,
                        GRAB_DURACION_MAX_S,
                        0
                      ),
                    });
                  }}
                  className={INPUT}
                />
                <select
                  value={String(unidadDuracion)}
                  onChange={(e) => {
                    // Cambiar de unidad NO cambia la duración: 120 segundos
                    // siguen siendo 120 segundos aunque ahora se lean como
                    // «2 minutos». Solo cambia cómo se escribe.
                    setUnidadDuracion(Number(e.target.value));
                  }}
                  className={`${INPUT} w-auto`}
                >
                  {UNIDADES_DURACION.map((u) => (
                    <option key={u.v} value={u.v}>
                      {u.t}
                    </option>
                  ))}
                </select>
              </div>
            )}
            <span className="mt-1 block text-[10px] leading-relaxed text-slate-400">
              {/* Cuántas filas van a salir, dicho ANTES de grabar. Es la
                  cuenta que nadie hace de cabeza y la que explica por qué una
                  grabación a 100 ms durante una hora es mala idea: el backend
                  corta a las 200.000 muestras y la captura se queda coja sin
                  avisar. */}
              {cfg.grabDuracionS
                ? `${fmtDuracion(cfg.grabDuracionS)} · saldrán unas ${Math.round(
                    cfg.grabDuracionS / (cfg.grabIntervaloMs / 1000)
                  ).toLocaleString('es-PE')} filas. El servidor corta a las 200.000.`
                : 'Se graba hasta que alguien pulse parar. El servidor corta solo a las 200.000 filas.'}
              {duracionLibre && ' Máximo 24 horas.'}
            </span>
          </label>
        </>
      )}
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
