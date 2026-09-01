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
// 1. El color va por POSICIÓN, nunca rotando. La serie 3 es azul siempre,
//    aunque borres la 1 y la 2. Si los colores se recalcularan al quitar una
//    serie, las que quedan cambiarían de color y el operador creería que está
//    mirando otra variable.
//
// 2. El modo oscuro NO es el claro invertido. Son los mismos tonos re-pisados
//    para el fondo oscuro y validados aparte contra él. Un color que se lee
//    bien sobre blanco puede desaparecer sobre navy.
//
// Tope de 6 series a propósito: más colores en pantalla dejan de distinguirse
// aunque se elijan bien, y un trend con ocho líneas ya no se lee.
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

/** Cuántas series caben antes de que dejen de distinguirse. */
export const MAX_SERIES = COLORES_SERIE.length;

/**
 * Color de la serie que ocupa esa posición.
 *
 * Si algún día se superan las 6, se repite la última en vez de inventar un
 * tono nuevo: un color generado al vuelo no está validado y lo más probable
 * es que choque con alguno de los seis.
 */
export function colorSerie(indice: number, oscuro: boolean): string {
  const c = COLORES_SERIE[Math.min(indice, MAX_SERIES - 1)];
  return oscuro ? c.oscuro : c.claro;
}
