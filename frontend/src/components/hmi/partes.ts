// =========================================================================
// partes.ts
// Estilo por PARTES de un widget (la caja, el texto, el icono, el botón).
//
// EL PROBLEMA
// `WidgetStyle` es plano: un solo `color`, un solo `fontSize`, un solo
// `background` para todo el widget. En cuanto un widget tiene más de un
// elemento visible eso se queda corto — en el Menú Lateral, ¿`color` es el
// del fondo del botón activo o el del texto? Hoy: los dos, quieras o no.
//
// EL MODELO, COPIADO DE WEBIQ
// WebIQ Designer llama a esto "IQ-Styling": eliges la parte en un campo
// «Selector» (Widget Box, Icon, Label, Unit, Input, Buttons) y editas solo
// sus propiedades. Cada tipo de widget declara qué partes expone, así que no
// te ofrece "color del icono" en un widget sin icono.
//
// Se copia el eje PARTE × PROPIEDAD y NO el de estados (hover/pressed):
// WebIQ tampoco lo tiene, porque en un HMI el estado que importa no es el del
// ratón sino el del proceso, y eso se resuelve por otro lado.
//
// DÓNDE SE GUARDA CADA COSA
// `box` y `label` siguen escribiendo en `widget.style`, que es donde ya
// vivían: `background`/`border*` son la caja y `color`/`fontSize`/`bold`/
// `align` son el texto. Así los diseños que ya existen se leen tal cual, sin
// migración y sin que nada se vea distinto de un día para otro.
//
// Las demás partes (icono, botón…) van a `widget.partes`, porque chocarían:
// `icon.color` y `label.color` son dos cosas y `WidgetStyle` solo tiene un
// hueco para ambas.
// =========================================================================
import type { HmiWidget, WidgetStyle, EstiloParte, ParteId } from '../../models/widget';

/** Una propiedad editable de una parte. El Inspector dibuja el control. */
export type PropParte = keyof EstiloParte;

export interface DefParte {
  id: ParteId;
  /** Lo que se lee en el selector del Inspector. */
  label: string;
  /** Qué se puede tocar de esta parte, y en este orden. */
  props: PropParte[];
}

// ─── Recetas de partes ───────────────────────────────────────────
//
// Se repiten mucho, así que se declaran una vez y se referencian.

const CAJA: DefParte = {
  id: 'box',
  label: 'Caja',
  props: ['background', 'borderColor', 'borderWidth', 'borderRadius', 'opacity'],
};

const TEXTO: DefParte = {
  id: 'label',
  label: 'Texto',
  props: ['color', 'fontSize', 'bold', 'align'],
};

const ICONO: DefParte = {
  id: 'icon',
  label: 'Icono',
  props: ['color'],
};

const BOTON: DefParte = {
  id: 'boton',
  label: 'Botón',
  props: ['background', 'color', 'borderRadius', 'fontSize', 'bold'],
};

const VALOR: DefParte = {
  id: 'valor',
  label: 'Valor',
  props: ['color', 'fontSize', 'bold'],
};

/** Lo que expone un widget del que no se declaró nada. */
export const PARTES_POR_DEFECTO: DefParte[] = [CAJA, TEXTO];

/**
 * Qué partes expone cada widget.
 *
 * Solo hace falta declarar los que se apartan de caja + texto. Un widget que
 * no esté aquí usa `PARTES_POR_DEFECTO`, que es exactamente el comportamiento
 * plano de siempre repartido en dos grupos.
 */
export const PARTES_POR_KIND: Record<string, DefParte[]> = {
  // Formas: no tienen texto propio que estilizar.
  rectangle: [CAJA],
  circle: [CAJA],
  line: [CAJA],
  image: [CAJA],

  // Un botón es su caja y su rótulo; el rótulo va sobre el color de fondo.
  button: [{ ...CAJA, props: ['borderRadius', 'opacity'] }, BOTON],

  // Indicadores: la caja, el relleno/indicador, y el número.
  tank: [CAJA, { ...ICONO, label: 'Nivel' }, VALOR],
  gaugeCircular: [CAJA, { ...ICONO, label: 'Aguja' }, VALOR],
  gaugeLinear: [CAJA, { ...ICONO, label: 'Barra' }, VALOR],
  progress: [CAJA, { ...ICONO, label: 'Barra' }, VALOR],
  led: [CAJA, { ...ICONO, label: 'Luz' }, TEXTO],

  // Los dos de navegación, que son los que más lo pedían.
  'custom:sidebar-navegacion': [
    CAJA,
    // Era «Título», y el título del menú ya no existe. La parte sigue
    // siendo la misma y escribe donde escribía, así que un menú al que ya
    // le habían tocado el color no cambia de aspecto: ahora ese color es
    // el de los encabezados de nivel.
    // Sin `align`: el encabezado de nivel va siempre a la izquierda, en
    // la misma columna por la que se lee el menú. Ofrecer el control y
    // que no hiciera nada sería peor que no ofrecerlo.
    { ...TEXTO, label: 'Niveles', props: ['color', 'fontSize', 'bold'] },
    { ...BOTON, label: 'Secciones' },
  ],
  'custom:pantalla-screen': [CAJA, { ...TEXTO, label: 'Cabecera' }],

  // El Contenedor es marco y título, nada más: lo de dentro son widgets
  // aparte y cada uno se estiliza solo.
  'custom:contenedor': [CAJA, { ...TEXTO, label: 'Título' }],

  // El número y la unidad se estilizan por separado a propósito: casi
  // siempre quieres el valor grande y la unidad discreta al lado.
  'custom:valor-unidad': [CAJA, VALOR, { ...TEXTO, label: 'Unidad' }],

  // El color de cada línea NO se toca aquí: lo asigna la posición de la serie
  // desde una paleta validada para daltonismo. Lo que sí se ajusta es el
  // marco, la rejilla de referencia y la tipografía de ejes y leyenda.
  'custom:trend': [
    CAJA,
    { ...ICONO, label: 'Rejilla' },
    { ...TEXTO, label: 'Ejes' },
  ],
};

export function partesDe(kind: string): DefParte[] {
  return PARTES_POR_KIND[kind] ?? PARTES_POR_DEFECTO;
}

// ─── Lectura ─────────────────────────────────────────────────────

/**
 * Propiedades de `WidgetStyle` que son, por naturaleza, de cada parte.
 *
 * Es el puente con el formato plano de siempre: leer `box` devuelve el
 * `background` de toda la vida, así que un diseño viejo se ve idéntico.
 */
const BASE_BOX: PropParte[] = [
  'background',
  'borderColor',
  'borderWidth',
  'borderRadius',
  'opacity',
];
const BASE_LABEL: PropParte[] = ['color', 'fontSize', 'bold', 'align'];

function desdeStyle(style: WidgetStyle, props: PropParte[]): EstiloParte {
  const out: EstiloParte = {};
  for (const p of props) {
    const v = (style as any)[p];
    if (v !== undefined) (out as any)[p] = v;
  }
  return out;
}

/**
 * Estilo efectivo de una parte: la base del `WidgetStyle` de siempre, con
 * encima lo que se haya guardado para esa parte concreta.
 *
 * Las partes que no son `box` ni `label` heredan una base razonable en vez de
 * salir vacías — un icono sin color declarado usa el color del widget, que es
 * lo que hacía antes.
 */
export function estiloDeParte(widget: HmiWidget, parte: ParteId): EstiloParte {
  const s = widget.style;
  const guardado = widget.partes?.[parte] ?? {};

  if (parte === 'box') return { ...desdeStyle(s, BASE_BOX), ...guardado };
  if (parte === 'label') return { ...desdeStyle(s, BASE_LABEL), ...guardado };

  // icon / boton / valor: heredan color y tipografía del widget.
  return {
    ...desdeStyle(s, ['color', 'fontSize', 'bold', 'align', 'background', 'borderRadius']),
    ...guardado,
  };
}

// ─── Escritura ───────────────────────────────────────────────────

export interface CambioParte {
  /** Va a `widget.style` (las propiedades que ya vivían ahí). */
  style?: Partial<WidgetStyle>;
  /** Va a `widget.partes[parte]` (lo que no cabe en el estilo plano). */
  partes?: HmiWidget['partes'];
}

/**
 * Traduce "cambia `color` de la parte `label`" al sitio donde toca guardarlo.
 *
 * `box` y `label` escriben en `widget.style` para que sigan siendo la misma
 * fuente de verdad de siempre; el resto va a `widget.partes`. Sin esta regla
 * habría dos sitios donde vive el color del texto y acabarían discrepando.
 */
export function cambioDeParte(
  widget: HmiWidget,
  parte: ParteId,
  prop: PropParte,
  valor: any
): CambioParte {
  const enStyle =
    (parte === 'box' && BASE_BOX.includes(prop)) ||
    (parte === 'label' && BASE_LABEL.includes(prop));

  if (enStyle) return { style: { [prop]: valor } as Partial<WidgetStyle> };

  return {
    partes: {
      ...widget.partes,
      [parte]: { ...(widget.partes?.[parte] ?? {}), [prop]: valor },
    },
  };
}

/** ¿Esta parte tiene algo cambiado a mano? Para marcarla en el selector. */
export function parteTocada(widget: HmiWidget, parte: ParteId): boolean {
  return Object.keys(widget.partes?.[parte] ?? {}).length > 0;
}

/** Deja una parte como estaba de fábrica. */
export function limpiarParte(widget: HmiWidget, parte: ParteId): HmiWidget['partes'] {
  const { [parte]: _, ...resto } = widget.partes ?? {};
  return resto;
}
