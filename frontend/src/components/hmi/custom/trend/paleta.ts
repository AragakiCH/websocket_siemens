// =========================================================================
// custom/trend/paleta.ts
// Colores de las series del trend.
//
// NO SE ELIGIERON A OJO. Se pasaron por el validador de paletas, que mide en
// OKLab la separación entre colores adyacentes tal como los ve alguien con
// daltonismo (protanopía, deuteranopía, tritanopía), el contraste contra el
// fondo y la banda de luminosidad. Los dos modos pasan todas las pruebas:
//
//   claro sobre #ffffff  · peor par adyacente ΔE 13.2 (CVD) / 19.6 (visión normal)
//   oscuro sobre #1e293b · peor par adyacente ΔE 13.2 (CVD) / 19.3 (visión normal)
//
// El umbral es 8 para daltonismo y 15 para visión normal, así que hay margen.
//
// DOS COSAS QUE PARECEN DETALLES Y NO LO SON
//
// 1. El color por defecto va por POSICIÓN, nunca rotando al borrar. La serie 3
//    nace azul, aunque borres la 1 y la 2. Si los colores se recalcularan al
//    quitar una serie, las que quedan cambiarían de color y el operador creería
//    que está mirando otra variable.
//
// 2. El modo oscuro NO es el claro invertido. Son los mismos tonos re-pisados
//    para el fondo oscuro y validados aparte contra él. Un color que se lee
//    bien sobre blanco puede desaparecer sobre navy.
//
// SE QUITÓ EL TOPE DE SEIS SERIES
// Antes `MAX_SERIES` era un límite duro: el botón «Agregar variable» se
// deshabilitaba a la sexta. Ya no. A partir de la séptima el color por defecto
// vuelve a empezar por el petrol, y por eso el Inspector deja elegir el color
// de cada serie a mano: seis tonos validados siguen siendo seis, y con más
// líneas en pantalla la responsabilidad de que se distingan pasa a quien
// diseña la pantalla. El Inspector avisa cuando dos series comparten color.
// =========================================================================

export interface ColorSerie {
  claro: string;
  oscuro: string;
  /** Nombre del tono, para que se entienda el orden al leer el código. */
  tono: string;
}

/** Orden fijo. El primero es el petrol de la marca. */
export const COLORES_SERIE: ColorSerie[] = [
  { tono: 'petrol', claro: '#009999', oscuro: '#0f9d9d' },
  { tono: 'naranja', claro: '#eb6834', oscuro: '#d95926' },
  { tono: 'azul', claro: '#2a78d6', oscuro: '#3987e5' },
  { tono: 'ámbar', claro: '#eda100', oscuro: '#c98500' },
  { tono: 'magenta', claro: '#e87ba4', oscuro: '#d55181' },
  { tono: 'violeta', claro: '#4a3aa7', oscuro: '#9085e9' },
];

/**
 * Cuántos tonos hay validados. **No es un tope de series**: es cuántas veces
 * se puede repartir color automáticamente antes de empezar a repetir.
 */
export const TONOS_VALIDADOS = COLORES_SERIE.length;

/**
 * Color por defecto de la serie que ocupa esa posición.
 *
 * Cicla: la serie 7 vuelve al petrol. Se prefiere repetir un tono validado a
 * inventar uno al vuelo — un color generado por fórmula no está comprobado
 * contra daltonismo y lo más probable es que choque con alguno de los seis.
 * Quien necesite más de seis líneas distinguibles elige los colores a mano.
 */
export function colorSerie(indice: number, oscuro: boolean): string {
  const c = COLORES_SERIE[((indice % TONOS_VALIDADOS) + TONOS_VALIDADOS) % TONOS_VALIDADOS];
  return oscuro ? c.oscuro : c.claro;
}

/**
 * Color efectivo de una serie: el que eligió el usuario, y si no, el que le
 * toca por posición.
 *
 * Un color elegido a mano es UNO SOLO para los dos temas — es la contrapartida
 * de poder elegirlo. Los tonos del catálogo sí tienen variante clara y oscura.
 */
export function colorEfectivo(
  elegido: string | undefined,
  indice: number,
  oscuro: boolean
): string {
  const c = (elegido ?? '').trim();
  return c ? c : colorSerie(indice, oscuro);
}

/** Sugerencias que ofrece el Inspector debajo del selector de color. */
export function sugerencias(oscuro: boolean): { tono: string; color: string }[] {
  return COLORES_SERIE.map((c) => ({ tono: c.tono, color: oscuro ? c.oscuro : c.claro }));
}

// ─── Tema del gráfico ────────────────────────────────────────────
//
// POR QUÉ ESTO NO SALE DE `estiloDeParte()`
// Salía, y era el motivo de que la rejilla se viera verde neón. Las partes
// `icon` y `label` HEREDAN `style.color` del widget cuando no se han tocado a
// mano, y `style.color` de un widget recién soltado es el petrol de la marca.
// Así que la rejilla y los números de los ejes se pintaban con el color de
// acento, compitiendo con las líneas de datos — justo al revés de lo que
// tiene que pasar: la rejilla es referencia, no dato.
//
// Aquí se definen tonos neutros por tema. El Inspector puede seguir pisando
// el color de la rejilla o del texto, pero solo si alguien lo pone
// EXPLÍCITAMENTE (`widget.partes.icon.color`), no por herencia.

export interface TemaGrafico {
  /** Fondo del área de dibujo. */
  superficie: string;
  /** Líneas de la rejilla. Muy tenues: son referencia, no dato. */
  rejilla: string;
  /** Línea de los ejes y las marcas. */
  eje: string;
  /** Números de los ejes. */
  tinta: string;
  /** Texto secundario (rango visible, avisos). */
  tintaSuave: string;
  /** Bordes de las cajas de la interfaz. */
  borde: string;
  /** Fondo de la cabecera y la leyenda. */
  chapa: string;
  /** Verde de «en vivo». */
  vivo: string;
  /** Ámbar de «pausado». */
  pausa: string;
}

export function temaGrafico(oscuro: boolean): TemaGrafico {
  return oscuro
    ? {
        superficie: '#0d1424',
        rejilla: 'rgba(148,163,184,0.13)',
        eje: 'rgba(148,163,184,0.30)',
        tinta: '#8fa3b8',
        tintaSuave: '#64748b',
        borde: 'rgba(148,163,184,0.20)',
        chapa: 'rgba(148,163,184,0.06)',
        vivo: '#34d399',
        pausa: '#fbbf24',
      }
    : {
        superficie: '#ffffff',
        rejilla: 'rgba(100,116,139,0.14)',
        eje: 'rgba(100,116,139,0.32)',
        tinta: '#64748b',
        tintaSuave: '#94a3b8',
        borde: 'rgba(100,116,139,0.22)',
        chapa: 'rgba(100,116,139,0.05)',
        vivo: '#059669',
        pausa: '#b45309',
      };
}
