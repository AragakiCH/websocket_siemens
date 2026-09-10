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
import type { HmiWidget, WidgetStyle } from '../../models/widget';

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

// ─── Orden (qué se dibuja encima de qué) ─────────────────────────
//
// NO HAY z-index EN NINGÚN SITIO, y es a propósito. El orden de pintado es el
// ORDEN DEL ARRAY: el último se dibuja encima. Con un z-index por widget
// habría dos verdades que mantener sincronizadas —el índice y el número— y en
// cuanto se desincronizan aparecen esos bugs de "lo traigo al frente y no
// sube". Con una sola lista, mover en el array ES cambiar el orden.

export type AccionOrden = 'frente' | 'adelante' | 'atras' | 'fondo';

/** Contenedor más externo del que cuelga un widget (o él mismo si va suelto). */
function raizDe(lista: HmiWidget[], w: HmiWidget): string {
  let actual = w;
  const vistos = new Set<string>([w.id]);
  while (actual.padre) {
    const p = lista.find((x) => x.id === actual.padre);
    if (!p || vistos.has(p.id)) break; // un ciclo en un diseño viejo no cuelga esto
    vistos.add(p.id);
    actual = p;
  }
  return actual.id;
}

/**
 * Primer y último índice que ocupa el grupo al que pertenece `lista[k]`.
 *
 * Al dar un paso adelante o atrás hay que saltar al VECINO ENTERO. Si el de al
 * lado es un contenedor con cuatro widgets dentro, avanzar una sola posición
 * dejaría el widget metido en mitad de ese grupo: por delante de unos hijos y
 * por detrás de otros. Visualmente sería un widget atrapado dentro de un grupo
 * al que no pertenece.
 */
function limitesDeGrupo(lista: HmiWidget[], k: number): [number, number] {
  const grupo = bloqueDe(lista, raizDe(lista, lista[k]));
  let min = k;
  let max = k;
  lista.forEach((x, i) => {
    if (!grupo.has(x.id)) return;
    if (i < min) min = i;
    if (i > max) max = i;
  });
  return [min, max];
}

/**
 * Cambia el orden de dibujado de un widget.
 *
 * DOS REGLAS QUE NO SE VEN PERO SE NOTAN
 *
 * 1. Un contenedor viaja CON SU CONTENIDO. Traerlo al frente sin sus hijos lo
 *    pondría delante de ellos y taparía el grupo entero con su propio marco.
 *
 * 2. Un hijo nunca puede quedar POR DETRÁS de su contenedor. Si el contenedor
 *    tiene fondo, el hijo desaparecería y parecería que se ha borrado. Por eso
 *    «enviar al fondo» dentro de un grupo lo deja justo encima del marco, que
 *    es lo más atrás que puede estar sin desaparecer.
 */
export function reordenar(
  widgets: HmiWidget[],
  id: string,
  accion: AccionOrden
): HmiWidget[] {
  const i = widgets.findIndex((w) => w.id === id);
  if (i < 0) return widgets;
  const w = widgets[i];

  const bloque = bloqueDe(widgets, id);
  const movidos = widgets.filter((x) => bloque.has(x.id));
  const resto = widgets.filter((x) => !bloque.has(x.id));
  if (resto.length === 0) return widgets; // está él solo: no hay orden que cambiar

  // Dónde queda el hueco del bloque una vez sacado.
  const hueco = widgets.slice(0, i).filter((x) => !bloque.has(x.id)).length;

  let destino: number;
  if (accion === 'frente') {
    destino = resto.length;
  } else if (accion === 'fondo') {
    destino = 0;
  } else if (accion === 'adelante') {
    if (hueco >= resto.length) return widgets; // ya está arriba del todo
    destino = limitesDeGrupo(resto, hueco)[1] + 1;
  } else {
    if (hueco === 0) return widgets; // ya está al fondo
    destino = limitesDeGrupo(resto, hueco - 1)[0];
  }

  // Regla 2: nunca por detrás del propio contenedor.
  if (w.padre) {
    const iPadre = resto.findIndex((x) => x.id === w.padre);
    if (iPadre >= 0) destino = Math.max(destino, iPadre + 1);
  }

  if (destino === hueco) return widgets; // mismo array: ni re-render ni guardado
  return [...resto.slice(0, destino), ...movidos, ...resto.slice(destino)];
}

/** ¿Tiene sentido ofrecer esta acción, o el widget ya está en ese extremo? */
export function puedeReordenar(
  widgets: HmiWidget[],
  id: string,
  accion: AccionOrden
): boolean {
  return reordenar(widgets, id, accion) !== widgets;
}

// ─── Agrupar y desagrupar ────────────────────────────────────────
//
// AGRUPAR ES CREAR UN CONTENEDOR, no un mecanismo nuevo.
//
// La tentación era inventar un `grupo: string` en el widget y tratar los
// grupos aparte. Habría sido un segundo modelo de pertenencia conviviendo con
// `padre`, con sus propias reglas para mover, borrar, ordenar y recortar
// contra el lienzo — y dos verdades sobre "qué va con qué" acaban siempre
// discrepando.
//
// Con el Contenedor no hay nada que inventar: `moverBloque`, `bloqueDe`,
// `soltarHijos`, el recorte del bloque contra el lienzo y el arreglo del
// orden de pintado ya funcionan, y un diseño agrupado se guarda y se lee como
// cualquier otro. Lo único que se añade es la comodidad de crear el
// contenedor ya ajustado a la selección en vez de dibujarlo a mano.

/**
 * Las RAÍCES de una selección: los seleccionados que no cuelgan de otro
 * seleccionado.
 *
 * Hace falta porque una selección puede traer a un contenedor y a un hijo
 * suyo a la vez —basta con hacer un rectángulo mental con Ctrl— y el hijo ya
 * viaja con su padre. Sin este filtro se le cambiaría el padre al hijo y
 * saldría del contenedor al que pertenece, que es lo contrario de agrupar.
 *
 * Se sube por la cadena entera, no solo un nivel: el hijo de un hijo también
 * está cubierto. El `vistos` corta un ciclo si un diseño editado a mano
 * trajera uno.
 */
export function raicesDeSeleccion(
  widgets: HmiWidget[],
  ids: string[]
): string[] {
  const sel = new Set(ids);
  return ids.filter((id) => {
    const w = widgets.find((x) => x.id === id);
    if (!w) return false;
    const vistos = new Set<string>([id]);
    let p = w.padre;
    while (p && !vistos.has(p)) {
      if (sel.has(p)) return false;
      vistos.add(p);
      p = widgets.find((x) => x.id === p)?.padre;
    }
    return true;
  });
}

/** Todos los ids que se mueven al arrastrar esta selección. */
export function bloqueDeVarios(
  widgets: HmiWidget[],
  ids: string[]
): Set<string> {
  const salida = new Set<string>();
  for (const raiz of raicesDeSeleccion(widgets, ids)) {
    for (const id of bloqueDe(widgets, raiz)) salida.add(id);
  }
  return salida;
}

/**
 * Mueve TODA la selección, no solo el widget que se arrastra.
 *
 * Con un solo seleccionado delega en `moverBloque`, así que el Diseñador
 * puede llamar siempre aquí y no tener dos caminos que puedan divergir.
 *
 * El tope contra el borde es de la caja que envuelve a todo lo que se mueve:
 * el grupo se para cuando el PRIMERO de sus miembros toca el borde, que es lo
 * que se espera al empujar varias cosas a la vez.
 */
export function moverSeleccion(
  widgets: HmiWidget[],
  idArrastrado: string,
  destinoX: number,
  destinoY: number,
  ids: string[],
  canvasW: number,
  canvasH: number
): HmiWidget[] {
  const raices = raicesDeSeleccion(widgets, ids);
  if (raices.length <= 1) {
    return moverBloque(widgets, idArrastrado, destinoX, destinoY, canvasW, canvasH);
  }

  const w = widgets.find((x) => x.id === idArrastrado);
  if (!w) return widgets;

  let dx = destinoX - w.x;
  let dy = destinoY - w.y;
  if (dx === 0 && dy === 0) return widgets;

  const mover = bloqueDeVarios(widgets, ids);
  const miembros = widgets.filter((m) => mover.has(m.id));
  if (miembros.length === 0) return widgets;

  const minX = Math.min(...miembros.map((m) => m.x));
  const minY = Math.min(...miembros.map((m) => m.y));
  const maxX = Math.max(...miembros.map((m) => m.x + m.width));
  const maxY = Math.max(...miembros.map((m) => m.y + m.height));

  dx = Math.max(-minX, Math.min(canvasW - maxX, dx));
  dy = Math.max(-minY, Math.min(canvasH - maxY, dy));
  if (dx === 0 && dy === 0) return widgets;

  return widgets.map((m) =>
    mover.has(m.id) ? { ...m, x: Math.round(m.x + dx), y: Math.round(m.y + dy) } : m
  );
}

/** Lo que el Diseñador aporta al crear el contenedor del grupo. */
export interface OpcionesAgrupar {
  /** Id del contenedor nuevo. Lo genera quien llama, igual que al soltar. */
  id: string;
  nombre: string;
  style: WidgetStyle;
  config?: Record<string, any>;
  /** Aire entre el borde del contenedor y lo que envuelve. */
  margen?: number;
  /**
   * Tamaño del lienzo, para que el marco no se salga.
   *
   * Sin esto, agrupar algo pegado al borde derecho creaba un contenedor 14 px
   * más ancho que la pantalla: no se veía en el Diseñador —que no recorta— y
   * sí en la Vista Previa, que sí. Opcional; si no llega, no se recorta.
   */
  limite?: { width: number; height: number };
}

/**
 * Envuelve la selección en un Contenedor nuevo.
 *
 * Devuelve el MISMO array si no hay al menos dos raíces: agrupar una sola
 * cosa no significa nada, y devolver una copia haría que el Diseñador la
 * guardara y subiera la versión para nada.
 *
 * TRES DECISIONES QUE SE NOTAN AL USARLO
 *
 *   1. LA CAJA ENVUELVE LOS BLOQUES COMPLETOS, no solo los seleccionados. Si
 *      agrupas un contenedor que ya tenía cosas dentro, sus hijos cuentan
 *      para la medida — si no, el grupo nuevo nacería cortando por la mitad
 *      lo que acaba de meter dentro.
 *
 *   2. LA SECCIÓN SE HEREDA SOLO SI TODOS COINCIDEN. Mezclando secciones, el
 *      contenedor nace «En todas». Ponerle la de uno cualquiera haría que el
 *      marco desapareciera al navegar mientras sus hijos se quedan, que es
 *      justo el fallo que el Inspector avisa en los widgets de navegación.
 *
 *   3. EL CONTENEDOR HEREDA EL PADRE COMÚN. Agrupar tres widgets que ya
 *      estaban dentro de otro contenedor deja el grupo nuevo DENTRO de aquel,
 *      en vez de sacarlo a la raíz y romper la agrupación que ya existía.
 *
 * Se inserta justo ANTES del primero de los seleccionados. El orden del array
 * es el orden de pintado, así que ahí queda detrás de todos sus hijos —que es
 * lo que tiene que hacer un marco— y no se toca el orden de nada más.
 */
export function agrupar(
  widgets: HmiWidget[],
  ids: string[],
  opciones: OpcionesAgrupar
): HmiWidget[] {
  const raices = raicesDeSeleccion(widgets, ids);
  if (raices.length < 2) return widgets;

  const enGrupo = new Set(raices);
  const bloque = bloqueDeVarios(widgets, raices);
  const cajas = widgets.filter((w) => bloque.has(w.id));
  if (cajas.length === 0) return widgets;

  const m = opciones.margen ?? 14;
  const lim = opciones.limite;
  const minX = Math.max(0, Math.min(...cajas.map((w) => w.x)) - m);
  const minY = Math.max(0, Math.min(...cajas.map((w) => w.y)) - m);
  const bordeX = Math.max(...cajas.map((w) => w.x + w.width)) + m;
  const bordeY = Math.max(...cajas.map((w) => w.y + w.height)) + m;
  const maxX = lim ? Math.min(lim.width, bordeX) : bordeX;
  const maxY = lim ? Math.min(lim.height, bordeY) : bordeY;

  const miembros = widgets.filter((w) => enGrupo.has(w.id));

  const vistas = new Set(miembros.map((w) => (w.vista ?? '').trim()));
  const vista = vistas.size === 1 ? [...vistas][0] : '';

  const padres = new Set(miembros.map((w) => w.padre ?? ''));
  const padre = padres.size === 1 ? [...padres][0] || undefined : undefined;

  const contenedor: HmiWidget = {
    id: opciones.id,
    kind: KIND_CONTENEDOR,
    name: opciones.nombre,
    x: minX,
    y: minY,
    width: Math.max(32, maxX - minX),
    height: Math.max(24, maxY - minY),
    text: opciones.nombre,
    style: opciones.style,
    visible: true,
    enabled: true,
    variableId: null,
    vista,
    padre,
    config: opciones.config,
  };

  const iMin = Math.min(
    ...raices.map((id) => widgets.findIndex((w) => w.id === id))
  );
  const conPadre = widgets.map((w) =>
    enGrupo.has(w.id) ? { ...w, padre: opciones.id } : w
  );

  return [...conPadre.slice(0, iMin), contenedor, ...conPadre.slice(iMin)];
}

/**
 * Deshace un grupo: quita el contenedor y deja a sus hijos donde estaban.
 *
 * LOS HIJOS SUBEN AL PADRE DEL CONTENEDOR, no a la raíz. Desagrupar algo que
 * estaba dentro de otro contenedor no debería sacarlo también de ese otro:
 * se deshace UN nivel, el que pediste.
 *
 * Ningún widget cambia de sitio ni de tamaño. Es la operación inversa exacta
 * de `agrupar()` salvo por la caja del contenedor, que desaparece — y eso es
 * lo que se pidió.
 */
export function desagrupar(widgets: HmiWidget[], id: string): HmiWidget[] {
  const c = widgets.find((w) => w.id === id);
  if (!c || !esContenedor(c.kind)) return widgets;
  return widgets
    .map((w) => (w.padre === id ? { ...w, padre: c.padre } : w))
    .filter((w) => w.id !== id);
}
