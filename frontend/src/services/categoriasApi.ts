// =========================================================================
// categoriasApi.ts
// Las secciones de la paleta de widgets, y en cuál cae cada widget.
//
// LA REGLA, QUE ES UNA SOLA
//
//     categoría efectiva = asignaciones[kind]  ->  la que declara  ->  'basicos'
//
// Un widget dice de qué categoría es en su definición: los built-in en
// `widgetCatalog.ts`, los custom TSX en su fichero, los ZIP en su
// `widget.json`. Eso es el DEFECTO — la opinión de quien lo hizo. Encima va la
// asignación, que es la decisión de quien monta esta instalación.
//
// No compiten, una es el respaldo de la otra. Por eso resubir un ZIP corregido
// no deshace la organización, y quitar la asignación devuelve el widget a
// donde su autor lo puso — que NO es lo mismo que mandarlo a Básicos.
//
// POR PROYECTO
// Las secciones de una envasadora no le sirven a quien monta un tablero de
// bombeo. El catálogo de widgets sí es global (un ZIP subido está en todas
// partes); cómo se ORDENA es de cada proyecto.
//
// POR QUÉ HAY CACHÉ Y UN EVENTO
// `getWidgetCatalog()` es SÍNCRONA y la llama todo el que pinta la paleta. Si
// la categoría efectiva hubiera que pedirla por red, habría que volver async
// media vista. Así que se pide una vez, se guarda aquí, y quien la lea la lee
// de memoria. Al cambiar algo se tira la caché y se avisa por `window` — el
// mismo patrón que `escrituraApi` usa con la lista blanca, y por el mismo
// motivo: hay más de un sitio leyendo lo mismo y uno de ellos lo cambia.
// =========================================================================
import { fetchAuth } from './authApi';
import { getUltimoProyecto } from '../utils/proyectoStorage';

export interface Categoria {
  id: string;
  nombre: string;
  /** Una de las cuatro de fábrica: se puede renombrar, no borrar. */
  fija: boolean;
}

export interface DocCategorias {
  categorias: Categoria[];
  /** `{ kind: id de categoría }`. Solo los widgets movidos a mano. */
  asignaciones: Record<string, string>;
}

/** Donde cae un widget cuya categoría no se reconoce. Nunca se pierde de vista. */
export const CATEGORIA_REFUGIO = 'basicos';

/**
 * Las cuatro de siempre, también aquí.
 *
 * Es una copia de la del servidor a propósito, igual que `index.css` lleva una
 * copia del tema PSI: si el backend no contesta, la paleta se ve como siempre
 * en vez de quedarse en blanco. Los 28 widgets del código declaran una de
 * estas cuatro, así que sin ellas no habría dónde pintarlos.
 */
export const CATEGORIAS_BASE: Categoria[] = [
  { id: 'basicos', nombre: 'Básicos', fija: true },
  { id: 'indicadores', nombre: 'Indicadores', fija: true },
  { id: 'equipos', nombre: 'Equipos', fija: true },
  { id: 'datos', nombre: 'Datos', fija: true },
];

/** Sube cuando la paleta cambia. Lo escuchan la barra lateral y el catálogo. */
export const EVENTO_CATEGORIAS = 'hmi:categorias';

/**
 * El `id` estable de una categoría a partir de su nombre.
 *
 * ESPEJO EXACTO de `slug()` en `app/db/categorias_store.py`. Tiene que dar lo
 * mismo en los dos lados: aquí se usa para saber en qué sección cae un widget
 * que declara «Paneles» en su `widget.json`, y allí para no crear dos
 * secciones casi iguales. Si divergieran, un widget se vería en una sección en
 * el Diseñador y el servidor lo contaría en otra al borrarla.
 */
export function idCategoria(nombre: string): string {
  return (nombre ?? '')
    .trim()
    .normalize('NFKD')
    // Los diacríticos combinantes que deja NFKD: «á» -> «a» + tilde suelta.
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

// ─── La caché ────────────────────────────────────────────────────

const cache = new Map<string, DocCategorias>();
const enVuelo = new Map<string, Promise<DocCategorias>>();

const proyectoDe = (proyectoId?: string): string =>
  proyectoId || getUltimoProyecto();

const vacio = (): DocCategorias => ({
  categorias: [...CATEGORIAS_BASE],
  asignaciones: {},
});

function avisar(): void {
  try {
    window.dispatchEvent(new CustomEvent(EVENTO_CATEGORIAS));
  } catch {
    /* sin `window` (pruebas): la caché ya está al día, que es lo que importa */
  }
}

/**
 * Tira la caché de un proyecto —o de todos— y avisa a quien la esté usando.
 *
 * Sin esto, crear una categoría dejaba la barra lateral enseñando la lista
 * vieja hasta que alguien recargaba, y el fallo parecía del backend, que era
 * justo el único que estaba bien.
 */
export function olvidarCategorias(proyectoId?: string): void {
  if (proyectoId) {
    cache.delete(proyectoId);
    enVuelo.delete(proyectoId);
  } else {
    cache.clear();
    enVuelo.clear();
  }
  avisar();
}

/** La petición pelada, sin tocar la caché. */
async function pedir(pid: string): Promise<DocCategorias> {
  const d: any = await fetchAuth(`/categorias/${encodeURIComponent(pid)}`);
  return {
    categorias: Array.isArray(d?.categorias) && d.categorias.length
      ? d.categorias
      : [...CATEGORIAS_BASE],
    asignaciones: d?.asignaciones ?? {},
  };
}

/**
 * Pide la paleta del proyecto y la deja en caché.
 *
 * Si el servidor no contesta se devuelven las cuatro de fábrica SIN cachear:
 * así el siguiente intento vuelve a preguntar en vez de quedarse con una
 * paleta capada durante toda la sesión.
 */
export async function cargarCategorias(
  proyectoId?: string
): Promise<DocCategorias> {
  const pid = proyectoDe(proyectoId);
  const ya = cache.get(pid);
  if (ya) return ya;

  const volando = enVuelo.get(pid);
  if (volando) return volando;

  const peticion = pedir(pid)
    .then((doc) => {
      cache.set(pid, doc);
      avisar();
      return doc;
    })
    .catch(() => vacio())
    .finally(() => {
      enVuelo.delete(pid);
    });

  enVuelo.set(pid, peticion);
  return peticion;
}

/**
 * Vuelve a pedir la paleta y la cambia de golpe.
 *
 * PRIMERO se pide y DESPUÉS se reemplaza, nunca al revés. Vaciar la caché y
 * avisar —que es lo que hacía este módulo al principio— dejaba a quien
 * escuchaba leyendo una caché vacía: las categorías creadas desaparecían de la
 * barra durante el viaje de ida y vuelta y reaparecían solas. Un parpadeo que
 * se lee como «se borró lo que acabo de hacer».
 *
 * Y si la recarga falla, la caché se queda con lo que había: mejor una paleta
 * un segundo vieja que una paleta en blanco.
 */
async function recargar(pid: string): Promise<void> {
  const fresco = await pedir(pid);
  enVuelo.delete(pid);
  cache.set(pid, fresco);
  avisar();
}

/** Las secciones del proyecto, de memoria. Las cuatro de fábrica si aún no llegó nada. */
export function categoriasDe(proyectoId?: string): Categoria[] {
  return cache.get(proyectoDe(proyectoId))?.categorias ?? [...CATEGORIAS_BASE];
}

/** Los widgets movidos a mano, de memoria. */
export function asignacionesDe(proyectoId?: string): Record<string, string> {
  return cache.get(proyectoDe(proyectoId))?.asignaciones ?? {};
}

/** El nombre visible de una categoría, o su id si no se conoce. */
export function nombreDeCategoria(id: string, proyectoId?: string): string {
  return categoriasDe(proyectoId).find((c) => c.id === id)?.nombre ?? id;
}

/**
 * En qué sección cae este widget, aquí y ahora.
 *
 * `declarada` es lo que dice su definición (`'Equipos'`, `'Paneles'`…). Se
 * pasa como texto y no como id porque eso es lo que hay escrito en el catálogo
 * y en los `widget.json`; la conversión a id se hace aquí, una vez.
 *
 * Una categoría declarada que este proyecto no tiene cae al refugio en vez de
 * desaparecer: un widget que no sale en la paleta es, para quien lo busca, un
 * widget roto.
 */
export function categoriaEfectiva(
  kind: string,
  declarada?: string,
  proyectoId?: string
): string {
  const pid = proyectoDe(proyectoId);
  const asignada = asignacionesDe(pid)[kind];
  if (asignada) return asignada;

  const propia = idCategoria(declarada ?? '');
  if (propia && categoriasDe(pid).some((c) => c.id === propia)) return propia;
  return CATEGORIA_REFUGIO;
}

// ─── Cambiarla ───────────────────────────────────────────────────
//
// Los cuatro escriben en el SERVIDOR primero y solo después tiran la caché. Si
// se hiciera al revés, un fallo de red dejaría la barra lateral enseñando una
// categoría que no existe en ninguna parte — y al recargar desaparecería sola,
// que es de los fallos que nadie sabe contar para reproducirlo.

export async function crearCategoria(
  nombre: string,
  proyectoId?: string
): Promise<Categoria> {
  const pid = proyectoDe(proyectoId);
  const r = await fetchAuth(`/categorias/${encodeURIComponent(pid)}`, {
    method: 'POST',
    body: JSON.stringify({ nombre }),
  });
  await recargar(pid);
  return r.categoria as Categoria;
}

export async function renombrarCategoria(
  catId: string,
  nombre: string,
  proyectoId?: string
): Promise<Categoria> {
  const pid = proyectoDe(proyectoId);
  const r = await fetchAuth(
    `/categorias/${encodeURIComponent(pid)}/${encodeURIComponent(catId)}`,
    { method: 'PATCH', body: JSON.stringify({ nombre }) }
  );
  await recargar(pid);
  return r.categoria as Categoria;
}

/**
 * Cambia el orden en que se pintan las secciones.
 *
 * Se manda la lista ENTERA de ids, no «mueve el de la posición 3 a la 1». Con
 * dos pestañas abiertas, un índice significa cosas distintas en cada una; una
 * lista de ids dice el resultado que se quiere y el servidor lo aplica sobre
 * lo que él tenga, ignorando lo que no reconozca.
 */
export async function reordenarCategorias(
  orden: string[],
  proyectoId?: string
): Promise<void> {
  const pid = proyectoDe(proyectoId);
  await fetchAuth(`/categorias/${encodeURIComponent(pid)}/orden`, {
    method: 'PUT',
    body: JSON.stringify({ orden }),
  });
  await recargar(pid);
}

/** Borra una sección VACÍA. El servidor devuelve 409 si le queda algo dentro. */
export async function borrarCategoria(
  catId: string,
  proyectoId?: string
): Promise<void> {
  const pid = proyectoDe(proyectoId);
  await fetchAuth(
    `/categorias/${encodeURIComponent(pid)}/${encodeURIComponent(catId)}`,
    { method: 'DELETE' }
  );
  await recargar(pid);
}

/**
 * Mueve uno o varios widgets. `categoria: null` los devuelve a la del autor.
 *
 * Varios de golpe porque arrastrar una selección entera es un solo gesto del
 * usuario: mandar una petición por widget dejaría la paleta a medio mover si
 * la tercera falla.
 */
export async function moverWidgets(
  asignaciones: { kind: string; categoria: string | null }[],
  proyectoId?: string
): Promise<Record<string, string>> {
  const pid = proyectoDe(proyectoId);
  const r = await fetchAuth(
    `/categorias/${encodeURIComponent(pid)}/asignaciones`,
    { method: 'PUT', body: JSON.stringify({ asignaciones }) }
  );
  await recargar(pid);
  return (r.asignaciones ?? {}) as Record<string, string>;
}
