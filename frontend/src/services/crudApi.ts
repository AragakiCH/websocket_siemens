// =========================================================================
// crudApi.ts
// Cliente del CRUD genérico del backend (`/crud/*`).
//
// El backend expone UNA sola API para todas las tablas del esquema del HMI
// —alarmas, definiciones de alarma, recetas y sus tres niveles— con la tabla
// resuelta desde un diccionario cerrado del servidor, nunca desde el cliente.
// Aquí no hay nada específico de recetas: eso vive en `recetasApi.ts`, que
// traduce entre las columnas de la base y el modelo que pinta la vista.
//
// LA BASE DE DATOS
//
//   Todas las llamadas viajan con `db_id`. Sin eso el backend usaría la
//   primera conexión de la lista: con una base local y otra en el servidor
//   dadas de alta, las recetas se guardarían en una y se leerían de la otra,
//   y el síntoma sería "se borran solas".
//
//   Cada función acepta un `dbId` explícito y, si no se le pasa ninguno, usa
//   la base con la que se entró al sistema (`hmi.auth.db`). Se pasa EXPLÍCITO
//   y no por una variable global de módulo a propósito: la pantalla de
//   recetas puede estar trabajando contra una base distinta de la del login,
//   y una variable compartida haría que elegirla ahí cambiara también dónde
//   escriben las alarmas — un efecto a distancia imposible de ver leyendo el
//   código de cualquiera de las dos.
//
// PERMISOS
//
//   Leer es público; crear y modificar exigen `Usuarios`; borrar exige
//   `Administradores`. El token va en cada petición (lo pone `pedir()` en
//   flows/api.ts). Con `PLC_AUTH_REQUERIDA=false` el backend deja pasar todo,
//   así que esto funciona igual antes y después de activar el login.
// =========================================================================
import { apiDelete, apiGet, apiPatch, apiPost } from '../components/flows/api';
import { getBasePreferida } from './authApi';

/** Una fila tal cual la devuelve el backend: nombres de columna reales. */
export type FilaCrud = Record<string, any>;

/** Tablas que expone el CRUD. Coincide con `RECURSOS` en el backend. */
export type RecursoCrud =
  | 'alarmas_def'
  | 'alarmas'
  | 'recetas'
  | 'receta_elementos'
  | 'receta_registros'
  | 'receta_valores'
  | 'plc_prg';

export interface OpcionesLista {
  /** Filtros por columna declarada. Los no declarados el backend los ignora. */
  filtros?: Record<string, string | number | undefined | null>;
  orden?: string;
  /** Por defecto ASC: en recetas el orden natural es ascendente, no el último primero. */
  descendente?: boolean;
  limite?: number;
  offset?: number;
}

function consulta(extra: Record<string, any> = {}, dbId?: string): string {
  const p = new URLSearchParams();
  const db = (dbId ?? '').trim() || getBasePreferida();
  if (db) p.set('db_id', db);
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined || v === null || v === '') continue;
    p.set(k, String(v));
  }
  const s = p.toString();
  return s ? `?${s}` : '';
}

export async function listarCrud(
  recurso: RecursoCrud,
  opciones: OpcionesLista = {},
  dbId?: string
): Promise<{ filas: FilaCrud[]; total: number; truncado: boolean }> {
  const { filtros = {}, orden, descendente = false, limite = 500, offset = 0 } =
    opciones;
  const r = await apiGet<{ filas?: FilaCrud[]; total?: number; truncado?: boolean }>(
    `/crud/${recurso}${consulta(
      {
        ...filtros,
        orden,
        descendente: descendente ? 'true' : 'false',
        limite,
        offset,
      },
      dbId
    )}`
  );
  return {
    filas: Array.isArray(r?.filas) ? r.filas : [],
    total: typeof r?.total === 'number' ? r.total : 0,
    truncado: !!r?.truncado,
  };
}

/**
 * Crea una fila y devuelve la fila COMPLETA, con su `id`.
 *
 * Que devuelva el id es lo que hace posible construir la jerarquía: sin él,
 * tras crear una receta no habría con qué crear sus elementos.
 */
export async function crearCrud(
  recurso: RecursoCrud,
  datos: FilaCrud,
  dbId?: string
): Promise<{ id: number; fila: FilaCrud }> {
  const r = await apiPost<{ id?: number; fila?: FilaCrud }>(
    `/crud/${recurso}${consulta({}, dbId)}`,
    datos
  );
  const id = Number(r?.id ?? r?.fila?.id ?? 0);
  // Un id 0 o NaN no es un id. Aceptarlo aquí construiría un objeto que
  // apunta a la nada, y el fallo saldría tres pasos después disfrazado de
  // otra cosa: "Faltan campos obligatorios: receta_id" al añadirle un hijo,
  // o "No existe recetas con id 0" al borrarlo. Se corta en el origen.
  if (!Number.isFinite(id) || id <= 0) {
    throw new Error(
      `El servidor creó la fila en '${recurso}' pero no devolvió su ` +
        `identificador. Actualiza la vista para verla.`
    );
  }
  return { id, fila: { ...(r?.fila ?? {}), id } };
}

/** PATCH parcial: solo se mandan los campos que cambiaron. */
export async function actualizarCrud(
  recurso: RecursoCrud,
  id: number,
  datos: FilaCrud,
  dbId?: string
): Promise<void> {
  await apiPatch(`/crud/${recurso}/${id}${consulta({}, dbId)}`, datos);
}

export async function borrarCrud(
  recurso: RecursoCrud,
  id: number,
  dbId?: string
): Promise<void> {
  await apiDelete(`/crud/${recurso}/${id}${consulta({}, dbId)}`);
}

// ─── Conversión de valores ───────────────────────────────────────
//
// El backend valida por tipo declarado y `float('')` revienta: una celda
// vacía TIENE que viajar como `null`, no como cadena vacía. Esto pasó de
// verdad — el error que devolvía era "el campo 'valor_minimo' esperaba un
// valor de tipo numero y llegó ''", que no le dice nada a quien solo borró
// una celda.

/** Texto de celda → número, o `null` si está vacía o no es un número. */
export function numeroONulo(v: string | number | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  const t = String(v).trim().replace(',', '.');
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** Igual, pero entero y con un valor de respaldo para columnas NOT NULL. */
export function enteroODefecto(
  v: string | number | null | undefined,
  defecto: number
): number {
  const n = numeroONulo(v);
  return n === null ? defecto : Math.trunc(n);
}

/** Número de la base → texto para una celda. `null` se muestra vacío. */
export function textoDeNumero(v: any): string {
  if (v === null || v === undefined || v === '') return '';
  const n = Number(v);
  return Number.isFinite(n) ? String(n) : String(v);
}
