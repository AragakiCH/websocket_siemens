// =========================================================================
// simbolos/tipos.ts
// La biblioteca de símbolos: qué es un símbolo y cómo se carga un catálogo.
//
// SE CARGAN BAJO DEMANDA, Y ESO NO ES UN DETALLE
// Un catálogo son cientos de kilobytes de geometría. Metidos en el paquete
// principal viajarían a TODOS los paneles de la planta, incluidos los que no
// usan ni un símbolo, y al arrancar. Con `import()` cada catálogo es un
// trozo aparte que el navegador sólo se descarga la primera vez que alguien
// coloca uno.
//
// EL TONO, Y POR QUÉ SE GUARDA
// Teñir un símbolo es girar su tono hasta el que se quiera, así que hay que
// saber de cuál se parte: un cuerpo de válvula azul gira 120° para ponerse
// verde, uno rojo gira 240°. `hue: null` significa que el símbolo es gris
// metálico y no hay tono que girar — se dice en el Inspector en vez de dejar
// un control que no hace nada.
// =========================================================================

export interface Simbolo {
  /** Identificador dentro del catálogo. Es lo que guarda el widget. */
  id: string;
  /** El nombre que le puso el fabricante: «Blue control valve with flange». */
  nombre: string;
  /** Tono dominante en grados (0-360), o `null` si es gris metálico. */
  hue: number | null;
  /** El dibujo, ya listo para meter en la página. */
  svg: string;
}

export interface Catalogo {
  id: string;
  titulo: string;
  cargar: () => Promise<Simbolo[]>;
}

export const CATALOGOS: Catalogo[] = [
  {
    id: 'valvulas',
    titulo: 'Válvulas',
    cargar: () => import('./valvulas').then((m) => m.SIMBOLOS),
  },
];

// ─── Caché ───────────────────────────────────────────────────────
//
// Un sinóptico con quince símbolos monta quince widgets, y cada uno pide su
// catálogo al dibujarse. Sin esto serían quince descargas del mismo módulo
// —o quince promesas en vuelo, que es peor—; con esto, una.

const cache = new Map<string, Simbolo[]>();
const enVuelo = new Map<string, Promise<Simbolo[]>>();

export function catalogoCargado(id: string): Simbolo[] | undefined {
  return cache.get(id);
}

export function cargarCatalogo(id: string): Promise<Simbolo[]> {
  const ya = cache.get(id);
  if (ya) return Promise.resolve(ya);

  let p = enVuelo.get(id);
  if (!p) {
    const def = CATALOGOS.find((c) => c.id === id);
    p = (def ? def.cargar() : Promise.resolve([]))
      .then((lista) => {
        cache.set(id, lista);
        return lista;
      })
      .catch(() => {
        // Sin catálogo el widget lo dice y se queda en su sitio. Dejar que
        // la promesa reviente tumbaría el render de toda la pantalla por no
        // poder dibujar una válvula.
        cache.set(id, []);
        return [];
      })
      .finally(() => {
        enVuelo.delete(id);
      });
    enVuelo.set(id, p);
  }
  return p;
}

/**
 * El SVG del símbolo, listo para ocupar su hueco.
 *
 * Se le meten `width`/`height` al 100 % y `preserveAspectRatio`: el símbolo
 * viene con su `viewBox` y sus proporciones, y sin esto se dibujaría a su
 * tamaño intrínseco —el que tenía en 2002— en vez de al del widget.
 */
export function svgAjustado(svg: string): string {
  return svg.replace(
    '<svg ',
    '<svg width="100%" height="100%" preserveAspectRatio="xMidYMid meet" '
  );
}

/** El tono de un color `#rrggbb`, o `null` si es un gris. */
export function tonoDe(hex: string): number | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  const r = ((n >> 16) & 255) / 255;
  const g = ((n >> 8) & 255) / 255;
  const b = (n & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max - min < 0.08) return null;           // gris: no hay tono
  let h: number;
  if (max === r) h = ((g - b) / (max - min)) % 6;
  else if (max === g) h = (b - r) / (max - min) + 2;
  else h = (r - g) / (max - min) + 4;
  h *= 60;
  return h < 0 ? h + 360 : h;
}

/**
 * El filtro CSS que tiñe un símbolo, o `''` si no hay nada que teñir.
 *
 * Se gira el tono en vez de repintar las figuras una a una, y eso tiene una
 * ventaja que se ve: los GRISES NO CAMBIAN. Un giro de tono no puede alterar
 * lo que no tiene color, así que el cuerpo de la válvula cambia y sus bridas
 * y vástagos metálicos siguen siendo metal. Repintando por colores habría
 * que decidir cuáles son «el cuerpo», y en 3.705 símbolos eso no se acierta.
 */
export function filtroTinte(hueSimbolo: number | null, color: string): string {
  if (!color || hueSimbolo === null) return '';
  const destino = tonoDe(color);
  if (destino === null) return '';
  const giro = Math.round(((destino - hueSimbolo) % 360 + 360) % 360);
  return giro === 0 ? '' : `hue-rotate(${giro}deg)`;
}
