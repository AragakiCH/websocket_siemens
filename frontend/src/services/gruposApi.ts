// =========================================================================
// gruposApi.ts
// Los GRUPOS de la barra de pestañas del Diseñador, y en cuál cae cada
// pantalla.
//
// LA REGLA, QUE ES UNA SOLA
//
//     grupo de una pantalla = asignaciones[project_id]  ->  ninguno
//
// No hay «grupo declarado» ni grupo refugio, y ahí está la diferencia con
// `categoriasApi.ts`: un widget sin categoría desaparece de la paleta, así que
// allí hacía falta un sitio donde caer siempre. Una pantalla sin grupo se ve
// perfectamente — suelta en la barra, que es como están todas hoy.
//
// POR QUÉ NO VIVE EN EL DOCUMENTO DE LA PANTALLA
// Porque arrastrar una pestaña no puede pedir el lápiz. Un `PATCH` sobre la
// pantalla sube su versión y el backend exige el lock: arrastrarla devolvería
// 423 en cuanto otra persona la tuviera abierta. Ver la cabecera de
// `app/db/grupos_store.py`.
//
// POR QUÉ HAY CACHÉ Y UN EVENTO
// Mismo motivo que en `categoriasApi`: la barra pinta en cada render y no
// puede pedir esto por red cada vez. Se pide una vez, se guarda aquí, y al
// cambiar algo se recarga y se avisa por `window`.
// =========================================================================
import { fetchAuth } from './authApi';
import { getUltimoProyecto } from '../utils/proyectoStorage';

export interface Grupo {
  id: string;
  nombre: string;
}

export interface DocGrupos {
  grupos: Grupo[];
  /** `{ project_id de la pantalla: id del grupo }`. Lo que no esté, va suelto. */
  asignaciones: Record<string, string>;
}

/** Sube cuando los grupos cambian. Lo escucha la barra de pestañas. */
export const EVENTO_GRUPOS = 'hmi:grupos';

/** Tope de pantallas que se pueden crear de una tacada. Ver `PantallasBar`. */
export const MAX_DE_GOLPE = 20;

/**
 * El `id` estable de un grupo a partir de su nombre.
 *
 * ESPEJO EXACTO de `slug()` en `app/db/grupos_store.py`. Si divergieran, el
 * cliente creería que una pantalla está en un grupo y el servidor la contaría
 * en otro al borrarlo.
 */
export function idGrupo(nombre: string): string {
  return (nombre ?? '')
    .trim()
    .normalize('NFKD')
    // Los diacríticos combinantes que deja NFKD: «í» -> «i» + tilde suelta.
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

// ─── La caché ────────────────────────────────────────────────────

const cache = new Map<string, DocGrupos>();
const enVuelo = new Map<string, Promise<DocGrupos>>();

const proyectoDe = (proyectoId?: string): string =>
  proyectoId || getUltimoProyecto();

const vacio = (): DocGrupos => ({ grupos: [], asignaciones: {} });

function avisar(): void {
  try {
    window.dispatchEvent(new CustomEvent(EVENTO_GRUPOS));
  } catch {
    /* sin `window` (pruebas): la caché ya está al día, que es lo que importa */
  }
}

/** La petición pelada, sin tocar la caché. */
async function pedir(pid: string): Promise<DocGrupos> {
  const d: any = await fetchAuth(`/grupos/${encodeURIComponent(pid)}`);
  return {
    grupos: Array.isArray(d?.grupos) ? (d.grupos as Grupo[]) : [],
    asignaciones: d?.asignaciones ?? {},
  };
}

/**
 * Pide los grupos del proyecto y los deja en caché.
 *
 * Si el servidor no contesta se devuelve vacío SIN cachear: la barra se ve
 * como siempre —todas las pantallas sueltas, ninguna perdida— y el siguiente
 * intento vuelve a preguntar en vez de quedarse sin grupos toda la sesión.
 */
export async function cargarGrupos(proyectoId?: string): Promise<DocGrupos> {
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
 * Vuelve a pedirlos y los cambia de golpe.
 *
 * PRIMERO se pide y DESPUÉS se reemplaza, nunca al revés. Vaciar la caché y
 * avisar deja a quien escucha leyendo el vacío: el grupo recién creado
 * desaparece durante el viaje de ida y vuelta y reaparece solo. Un parpadeo
 * que se lee como «se borró lo que acabo de hacer» — es exactamente el bug que
 * tuvo `categoriasApi` en su primera versión.
 *
 * Y si la recarga falla, la caché se queda con lo que había: mejor una barra
 * un segundo vieja que una barra sin grupos.
 */
async function recargar(pid: string): Promise<void> {
  const fresco = await pedir(pid);
  enVuelo.delete(pid);
  cache.set(pid, fresco);
  avisar();
}

/** Tira la caché —de un proyecto o de todos— y avisa. */
export function olvidarGrupos(proyectoId?: string): void {
  if (proyectoId) {
    cache.delete(proyectoId);
    enVuelo.delete(proyectoId);
  } else {
    cache.clear();
    enVuelo.clear();
  }
  avisar();
}

/** Los grupos del proyecto, de memoria. */
export function gruposDe(proyectoId?: string): Grupo[] {
  return cache.get(proyectoDe(proyectoId))?.grupos ?? [];
}

/** `{ pantalla: grupo }`, de memoria. */
export function asignacionesDe(proyectoId?: string): Record<string, string> {
  return cache.get(proyectoDe(proyectoId))?.asignaciones ?? {};
}

/** En qué grupo está esta pantalla, o `''` si está suelta. */
export function grupoDePantalla(projectId: string, proyectoId?: string): string {
  return asignacionesDe(proyectoId)[projectId] ?? '';
}

/** El nombre visible de un grupo, o su id si no se conoce. */
export function nombreDeGrupo(id: string, proyectoId?: string): string {
  return gruposDe(proyectoId).find((g) => g.id === id)?.nombre ?? id;
}

// ─── Cambiarlos ──────────────────────────────────────────────────
//
// Todos escriben en el SERVIDOR primero y solo después recargan. Si se hiciera
// al revés, un fallo de red dejaría la barra enseñando un grupo que no existe
// en ninguna parte — y al recargar desaparecería solo, que es de los fallos
// que nadie sabe contar para reproducirlo.

export async function crearGrupo(
  nombre: string,
  proyectoId?: string
): Promise<Grupo> {
  const pid = proyectoDe(proyectoId);
  const r = await fetchAuth(`/grupos/${encodeURIComponent(pid)}`, {
    method: 'POST',
    body: JSON.stringify({ nombre }),
  });
  await recargar(pid);
  return r.grupo as Grupo;
}

export async function renombrarGrupo(
  grupoId: string,
  nombre: string,
  proyectoId?: string
): Promise<Grupo> {
  const pid = proyectoDe(proyectoId);
  const r = await fetchAuth(
    `/grupos/${encodeURIComponent(pid)}/${encodeURIComponent(grupoId)}`,
    { method: 'PATCH', body: JSON.stringify({ nombre }) }
  );
  await recargar(pid);
  return r.grupo as Grupo;
}

/** Borra un grupo VACÍO. El servidor devuelve 409 si le queda algo dentro. */
export async function borrarGrupo(
  grupoId: string,
  proyectoId?: string
): Promise<void> {
  const pid = proyectoDe(proyectoId);
  await fetchAuth(
    `/grupos/${encodeURIComponent(pid)}/${encodeURIComponent(grupoId)}`,
    { method: 'DELETE' }
  );
  await recargar(pid);
}

/**
 * Cambia el orden de las fichas de grupo.
 *
 * Se manda la lista ENTERA de ids, no «mueve el de la posición 3 a la 1». Con
 * dos pestañas del navegador abiertas, un índice significa cosas distintas en
 * cada una; una lista de ids dice el resultado que se quiere.
 */
export async function reordenarGrupos(
  orden: string[],
  proyectoId?: string
): Promise<void> {
  const pid = proyectoDe(proyectoId);
  await fetchAuth(`/grupos/${encodeURIComponent(pid)}/orden`, {
    method: 'PUT',
    body: JSON.stringify({ orden }),
  });
  await recargar(pid);
}

/**
 * Mete o saca pantallas. `grupo: null` las deja sueltas en la barra.
 *
 * Varias de golpe porque crear N pantallas dentro de un grupo es un solo gesto
 * del usuario: una petición por pantalla dejaría la mitad dentro y la mitad
 * fuera si la tercera falla.
 */
export async function moverPantallas(
  asignaciones: { pantalla: string; grupo: string | null }[],
  proyectoId?: string
): Promise<Record<string, string>> {
  const pid = proyectoDe(proyectoId);
  const r = await fetchAuth(
    `/grupos/${encodeURIComponent(pid)}/asignaciones`,
    { method: 'PUT', body: JSON.stringify({ asignaciones }) }
  );
  await recargar(pid);
  return (r.asignaciones ?? {}) as Record<string, string>;
}
