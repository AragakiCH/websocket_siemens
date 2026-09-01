// =========================================================================
// grupo.ts
// Quién va dentro de quién, y qué se mueve cuando arrastras un contenedor.
//
// EL MODELO: PADRE, NO ANIDAMIENTO
// Un widget dentro de un contenedor NO se dibuja dentro de él. Sigue siendo
// un widget más del lienzo, con sus coordenadas absolutas de siempre, y lo
// único que cambia es que guarda `padre` con el id del contenedor.
//
// Podría haberse hecho al revés — meter los hijos dentro del contenedor y
// pasar sus coordenadas a relativas — pero eso obliga a rehacer el arrastre,
// el redimensionado, el recorte contra el lienzo, la Vista Previa y el
// guardado. Con `padre` no cambia NADA de eso: un diseño guardado antes de
// que existieran los contenedores se sigue leyendo igual, y el renderizador
// ni se entera de que los grupos existen.
//
// El precio es que agrupar no recorta: un widget que sobresalga del
// contenedor se ve entero, no cortado por el borde. Para un HMI eso es lo
// razonable — el contenedor está para ORGANIZAR y mover en bloque, no para
// hacer de ventana con scroll.
//
// CÓMO SE ENTRA Y SE SALE
// Arrastrando, y por dónde queda el CENTRO del widget al soltarlo. Nada de
// menús ni de casillas: si el centro cae dentro de un contenedor, entra; si
// lo sacas, sale. Se usa el centro y no una esquina porque es lo que la vista
// interpreta como "está dentro", incluso si asoma un poco por un lado.
// =========================================================================
import type { HmiWidget } from '../../models/widget';

/** El `kind` del widget contenedor. Vive aquí para no importar el TSX. */
export const KIND_CONTENEDOR = 'custom:contenedor';

export const esContenedor = (kind: string): boolean => kind === KIND_CONTENEDOR;

// ─── Parentesco ──────────────────────────────────────────────────

/** Hijos directos de un contenedor. */
export function hijosDe(widgets: HmiWidget[], id: string): HmiWidget[] {
  return widgets.filter((w) => w.padre === id);
}

/**
 * Todo lo que cuelga de un contenedor, incluidos los contenedores anidados.
 *
 * Lleva un `vistos` no por elegancia sino por seguridad: si un diseño
 * guardado trajera un ciclo (A dentro de B y B dentro de A), sin él esto se
 * quedaría dando vueltas y colgaría la pestaña.
 */
export function descendientesDe(widgets: HmiWidget[], id: string): string[] {
  const salida: string[] = [];
  const vistos = new Set<string>([id]);
  const pila = [id];

  while (pila.length) {
    const actual = pila.pop()!;
    for (const w of widgets) {
      if (w.padre !== actual || vistos.has(w.id)) continue;
      vistos.add(w.id);
      salida.push(w.id);
      pila.push(w.id);
    }
  }
  return salida;
}

/** El widget y todo lo que cuelga de él: lo que se mueve como un bloque. */
export function bloqueDe(widgets: HmiWidget[], id: string): Set<string> {
  return new Set<string>([id, ...descendientesDe(widgets, id)]);
}

// ─── Dónde cae un widget ─────────────────────────────────────────

const centro = (w: HmiWidget) => ({
  cx: w.x + w.width / 2,
  cy: w.y + w.height / 2,
});

/**
 * Contenedor sobre el que ha quedado un widget, o null si está suelto.
 *
 * Se recorre AL REVÉS porque el orden del array es el orden de pintado: el
 * último está encima. Si dos contenedores se solapan, gana el que se ve, que
 * es el que el usuario cree estar señalando.
 *
 * Un contenedor nunca puede caer dentro de sí mismo ni de uno de sus hijos:
 * eso crearía el ciclo que `descendientesDe` tiene que esquivar, así que
 * mejor no dejar que se forme.
 */
export function contenedorBajo(widgets: HmiWidget[], w: HmiWidget): string | null {
  const { cx, cy } = centro(w);
  const prohibidos = bloqueDe(widgets, w.id);

  for (let i = widgets.length - 1; i >= 0; i--) {
    const c = widgets[i];
    if (!esContenedor(c.kind) || prohibidos.has(c.id)) continue;
    if (cx >= c.x && cx <= c.x + c.width && cy >= c.y && cy <= c.y + c.height) {
      return c.id;
    }
  }
  return null;
}

/**
 * Reasigna el padre de un widget según dónde haya quedado al soltarlo.
 *
 * Además corrige el orden de pintado si hace falta. El array se dibuja en
 * orden y los widgets van en absoluto, así que el último tapa a los
 * anteriores: si el contenedor en el que acabas de meter algo se pinta DESPUÉS
 * que ese algo, lo tapa y parece que se ha perdido. Pasa sobre todo al meter
 * un contenedor dentro de otro. Se arregla moviendo el bloque del hijo justo
 * detrás de su nuevo padre.
 */
export function reasignarPadre(widgets: HmiWidget[], id: string): HmiWidget[] {
  const i = widgets.findIndex((x) => x.id === id);
  if (i < 0) return widgets;

  const w = widgets[i];
  const nuevo = contenedorBajo(widgets, w) ?? undefined;
  if (nuevo === w.padre) return widgets; // mismo array: no re-renderiza de más

  const conPadre = widgets.map((x) => (x.id === id ? { ...x, padre: nuevo } : x));
  if (!nuevo) return conPadre;

  const iPadre = conPadre.findIndex((x) => x.id === nuevo);
  if (iPadre < i) return conPadre; // el padre ya va antes: se ve bien

  // Viaja el bloque entero, no solo el widget: si es un contenedor con cosas
  // dentro, dejar a los hijos detrás los pondría debajo de su propio padre.
  const bloque = bloqueDe(conPadre, id);
  const fuera = conPadre.filter((x) => !bloque.has(x.id));
  const dentro = conPadre.filter((x) => bloque.has(x.id));
  const j = fuera.findIndex((x) => x.id === nuevo);

  return [...fuera.slice(0, j + 1), ...dentro, ...fuera.slice(j + 1)];
}

// ─── Mover ───────────────────────────────────────────────────────

/**
 * Mueve un widget y, si es contenedor, todo lo que lleva dentro.
 *
 * Sirve para CUALQUIER widget: uno suelto es un bloque de uno, así que el
 * Diseñador puede llamar siempre aquí en vez de tener dos caminos.
 *
 * EL TOPE ES DEL BLOQUE ENTERO, NO DEL CONTENEDOR
 * `CanvasWidget` ya impide que el widget arrastrado se salga del lienzo, pero
 * eso no basta: el contenedor puede estar en el borde y tener un hijo que
 * asome. Aquí se recorta el desplazamiento con la caja que envuelve a todo el
 * grupo, así que el contenedor se para antes de tiempo si algún hijo iba a
 * salirse. Se ve como que "topa", que es exactamente lo que pasa.
 */
export function moverBloque(
  widgets: HmiWidget[],
  id: string,
  destinoX: number,
  destinoY: number,
  canvasW: number,
  canvasH: number
): HmiWidget[] {
  const w = widgets.find((x) => x.id === id);
  if (!w) return widgets;

  let dx = destinoX - w.x;
  let dy = destinoY - w.y;
  if (dx === 0 && dy === 0) return widgets;

  const bloque = bloqueDe(widgets, id);

  if (bloque.size > 1) {
    const miembros = widgets.filter((m) => bloque.has(m.id));
    const minX = Math.min(...miembros.map((m) => m.x));
    const minY = Math.min(...miembros.map((m) => m.y));
    const maxX = Math.max(...miembros.map((m) => m.x + m.width));
    const maxY = Math.max(...miembros.map((m) => m.y + m.height));

    dx = Math.max(-minX, Math.min(canvasW - maxX, dx));
    dy = Math.max(-minY, Math.min(canvasH - maxY, dy));
    if (dx === 0 && dy === 0) return widgets;
  }

  return widgets.map((m) =>
    bloque.has(m.id) ? { ...m, x: Math.round(m.x + dx), y: Math.round(m.y + dy) } : m
  );
}

// ─── Borrar ──────────────────────────────────────────────────────

/**
 * Suelta a los hijos de un contenedor en vez de borrarlos con él.
 *
 * Es una decisión deliberada. Borrar el grupo entero de un tecleo es la clase
 * de error que arruina media hora de trabajo, y aquí no hay deshacer. Que se
 * queden donde están cuesta un segundo de rehacer; que desaparezcan, mucho
 * más. Si los quieres fuera, se borran uno a uno.
 */
export function soltarHijos(widgets: HmiWidget[], id: string): HmiWidget[] {
  return widgets.map((w) => (w.padre === id ? { ...w, padre: undefined } : w));
}
