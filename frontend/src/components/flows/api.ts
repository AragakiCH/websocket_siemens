import { getToken } from '../../services/authApi';

// ─── Acceso al backend desde el Flow Editor ────────────────────
//
// Un solo lugar donde vive la URL del backend y la interpretación de sus
// respuestas, para no repetir el mismo parseo en cada formulario.

/**
 * Origen del backend.
 *
 * Vacío = rutas RELATIVAS, que es lo que queremos casi siempre:
 *   * en `npm run dev` las atiende el proxy de Vite (vite.config.js →
 *     server.proxy), que las reenvía a uvicorn en el 8000;
 *   * en producción las atiende el mismo FastAPI que sirve el frontend.
 *
 * En los dos casos hay UN SOLO origen, así que no hace falta CORS. Antes esto
 * era 'http://localhost:8000' a pelo: convivían dos orígenes en desarrollo y
 * por eso el backend necesita todavía `allow_origins=["*"]`.
 *
 * `VITE_API_BASE` es la escotilla de escape para apuntar a otra máquina
 * (backend en un PC distinto al del navegador). Se define en un `.env` dentro
 * de `frontend/`:  VITE_API_BASE=http://192.168.1.50:8000
 */
export const API_BASE = import.meta.env.VITE_API_BASE ?? '';

/**
 * Mensaje para cuando `fetch` ni siquiera consigue respuesta.
 *
 * Con API_BASE vacío la causa más probable NO es que uvicorn esté apagado,
 * sino que la ruta no esté listada en el proxy de Vite: entonces Vite responde
 * el index.html de la SPA y el error se ve rarísimo. Por eso el texto lo dice.
 */
export const ERROR_SIN_BACKEND = API_BASE
  ? `No se pudo contactar al backend en ${API_BASE}. Revisa que esté accesible.`
  : 'No se pudo contactar al backend. Revisa que uvicorn esté corriendo y que ' +
    'esta ruta esté en el proxy de Vite (vite.config.js → server.proxy).';

/**
 * Extrae un mensaje legible de la respuesta del backend.
 *
 * Hay tres formatos posibles y conviene cubrirlos todos:
 *   1. Error de negocio    -> HTTP 200 + {"ok": false, "mensaje": "..."}
 *   2. HTTPException       -> HTTP 4xx/5xx + {"detail": "..."}
 *   3. Validación Pydantic -> HTTP 422 + {"detail": [{loc, msg, type}, ...]}
 */
export function extraerMensaje(data: any): string {
  if (!data || typeof data !== 'object') return '';

  if (typeof data.mensaje === 'string' && data.mensaje.trim()) {
    return data.mensaje.trim();
  }

  const detalle = data.detail;
  if (typeof detalle === 'string' && detalle.trim()) {
    return detalle.trim();
  }
  if (Array.isArray(detalle)) {
    // Pydantic: loc = ["body", "campo"] -> mostramos solo el campo.
    return detalle
      .map((e: any) => {
        const campo = Array.isArray(e?.loc) ? e.loc.slice(1).join('.') : '';
        return campo ? `${campo}: ${e?.msg ?? ''}` : String(e?.msg ?? '');
      })
      .filter(Boolean)
      .join(' · ');
  }

  return '';
}

/**
 * GET a la API devolviendo el JSON ya parseado.
 *
 * Lanza con un mensaje entendible en los tres casos que fallan de verdad:
 * backend apagado, HTTP de error, y `{"ok": false}` con HTTP 200 (que es como
 * el backend reporta casi todos sus errores de negocio).
 */
async function pedir<T = any>(ruta: string, init?: RequestInit): Promise<T> {
  // El token va en TODAS las peticiones. Sin esto, en cuanto se active
  // `PLC_AUTH_REQUERIDA=true` cada formulario del editor empezaría a recibir
  // 401 aunque el usuario tenga una sesión abierta y perfectamente válida.
  const token = getToken();
  const cabeceras: Record<string, string> = {
    ...((init?.headers as Record<string, string>) ?? {}),
  };
  if (token) cabeceras.Authorization = `Bearer ${token}`;

  let resp: Response;
  try {
    resp = await fetch(`${API_BASE}${ruta}`, { ...init, headers: cabeceras });
  } catch {
    throw new Error(ERROR_SIN_BACKEND);
  }

  // Texto primero: el fallback de la SPA devuelve HTML con status 200 ante una
  // ruta mal escrita, y un resp.json() directo reventaría con un error inútil.
  const raw = await resp.text();
  let data: any = null;
  try {
    data = raw ? JSON.parse(raw) : null;
  } catch {
    data = null;
  }

  if (!resp.ok) {
    throw new Error(
      extraerMensaje(data) || raw.slice(0, 300) || `HTTP ${resp.status} ${resp.statusText}`
    );
  }
  if (data && data.ok === false) {
    // El diagnóstico estructurado viaja PEGADO al error. Sin esto se perdería
    // al convertir la respuesta en `Error`, y la vista solo podría enseñar una
    // línea de texto en lugar de qué pasó, qué hacer y el detalle técnico.
    const err = new Error(
      extraerMensaje(data) || 'El servidor rechazó la petición.'
    ) as Error & { diagnostico?: Diagnostico; data?: any };
    if (data.diagnostico) err.diagnostico = data.diagnostico as Diagnostico;
    // El cuerpo entero también: un aprovisionamiento que falla a mitad trae
    // los `pasos` que SÍ se completaron, y esos hay que enseñarlos.
    err.data = data;
    throw err;
  }

  return data as T;
}

export function apiGet<T = any>(ruta: string): Promise<T> {
  return pedir<T>(ruta);
}

export function apiPost<T = any>(ruta: string, cuerpo?: any): Promise<T> {
  return pedir<T>(ruta, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(cuerpo ?? {}),
  });
}

export function apiDelete<T = any>(ruta: string): Promise<T> {
  return pedir<T>(ruta, { method: 'DELETE' });
}

// ─── GET /db ───────────────────────────────────────────────────

/**
 * Diagnóstico de un fallo de conexión, ya traducido por el backend.
 *
 * `codigo` es estable y sirve para decidir qué ofrecer: por ejemplo, un
 * `base_no_existe` es el único caso en el que tiene sentido proponer crear la
 * base de datos.
 */
export interface Diagnostico {
  codigo:
    | 'falta_paquete'
    | 'falta_driver'
    | 'sin_servidor'
    | 'host_desconocido'
    | 'credenciales'
    | 'base_no_existe'
    // Existe pero no se puede abrir (OFFLINE, RESTORING, SINGLE_USER...).
    // A propósito NO ofrece crearla: está ahí, solo que no operativa.
    | 'base_no_accesible'
    | 'sin_permisos'
    | 'ruta_no_existe'
    | 'tls'
    | 'timeout'
    | 'desconocido';
  titulo: string;
  mensaje: string;
  sugerencia: string;
  /** El texto literal del driver. Nunca se oculta: es lo que se puede buscar. */
  detalle: string;
  motor?: string;
}

/** Una conexión de `GET /db`. Nunca incluye la contraseña. */
export interface ConexionRemota {
  db_id: string;
  motor: string;
  etiqueta_motor?: string;
  nombre: string;
  host?: string;
  puerto?: number | null;
  base_datos?: string;
  usuario?: string;
  conectado: boolean;
  num_consultas?: number;
  autoconectar?: boolean;
  ultimo_error?: string;
}

/** Conexiones guardadas en el backend, con su estado de pool en vivo. */
export async function cargarConexiones(): Promise<ConexionRemota[]> {
  const data = await apiGet<{ conexiones: ConexionRemota[] }>('/db');
  return Array.isArray(data?.conexiones) ? data.conexiones : [];
}

/**
 * Da de alta o actualiza una conexión.
 *
 * El backend la **verifica antes de guardar**: si responde ok, la conexión
 * funciona de verdad, no solo está bien escrita. Por eso este mismo endpoint
 * hace de "probar" en un formulario nuevo — no hay que inventar otro.
 */
export function guardarConexion(cfg: Record<string, any>): Promise<any> {
  return apiPost('/db', cfg);
}

/**
 * `SELECT 1` contra una conexión ya guardada, con su latencia.
 *
 * Reabre el pool si se había caído, así que sirve de "reconectar" para una
 * base que estaba apagada cuando arrancó el servicio.
 */
export function probarConexion(dbId: string): Promise<any> {
  return apiPost(`/db/${encodeURIComponent(dbId)}/test`);
}

/**
 * Drivers ODBC instalados en la máquina del BACKEND (no en la del navegador).
 *
 * Nunca lanza: si no se puede averiguar, devuelve la lista vacía y el motivo.
 * Un formulario que no puede consultar los drivers tiene que seguir siendo
 * usable con los nombres de siempre, no quedarse en blanco.
 */
export async function cargarDriversOdbc(): Promise<{
  drivers: string[];
  mensaje: string;
}> {
  try {
    const d = await apiGet<{ drivers?: string[]; mensaje?: string }>(
      '/db/drivers'
    );
    return {
      drivers: Array.isArray(d?.drivers) ? d.drivers : [],
      mensaje: d?.mensaje ?? '',
    };
  } catch (e: any) {
    return { drivers: [], mensaje: e?.message ?? '' };
  }
}

/** Un paso del aprovisionamiento, tal y como lo cuenta el backend. */
export interface PasoProvision {
  paso: string;
  ok: boolean;
  mensaje: string;
  /** true = ya estaba hecho. No es un fallo. */
  omitido?: boolean;
}

/**
 * Crea la base de datos, su esquema y su usuario.
 *
 * Las credenciales de administrador que van en `cfg` **no se guardan**: el
 * backend las usa para esta operación y las descarta. Lo que se persiste
 * después, si el usuario acepta, es la conexión normal con el usuario
 * limitado, por la vía de `guardarConexion()`.
 */
export function provisionarBase(cfg: Record<string, any>): Promise<{
  ok: boolean;
  mensaje: string;
  pasos?: PasoProvision[];
  base_datos?: string;
}> {
  return apiPost('/db/provision', cfg);
}

/** Borra la conexión Y todas sus consultas guardadas. */
export function borrarConexion(dbId: string): Promise<any> {
  return apiDelete(`/db/${encodeURIComponent(dbId)}`);
}

// ─── GET /historian ────────────────────────────────────────────

/** Un grupo de historización de `GET /historian`, con sus estadísticas. */
export interface GrupoRemoto {
  grupo_id: string;
  nombre: string;
  db_id: string;
  tabla: string;
  activo: boolean;
  num_tags: number;
  tags: string[];
  todos_los_tags: boolean;
  banda_muerta: number;
  intervalo_min_ms: number;
  filas_escritas: number;
  filas_descartadas: number;
  ultima_escritura: string;
  ultimo_error: string;
  en_buffer: number;
}

/** Grupos configurados en el historizador, con sus contadores en vivo. */
export async function cargarGrupos(): Promise<GrupoRemoto[]> {
  const data = await apiGet<{ grupos: GrupoRemoto[] }>('/historian');
  return Array.isArray(data?.grupos) ? data.grupos : [];
}

/** Pausa la captura de un grupo. Idempotente: parar lo parado no falla. */
export function detenerGrupo(grupoId: string): Promise<any> {
  return apiPost(`/historian/${encodeURIComponent(grupoId)}/stop`);
}

// ─── GET /tags ─────────────────────────────────────────────────

/** Una fila de `GET /tags`. */
export interface TagRemoto {
  plc: string;
  tag: string;        // full_name, ej. "DB_snap7.temperatura"
  name: string;       // nombre corto, ej. "temperatura"
  db: string;         // Data Block (Siemens) o programa/POU (Rexroth)
  node_id: string;
  type: string | null;
  value: any;
  timestamp: string | null;
}

/**
 * Clave que espera el historizador: "<plc_id>|<tag>".
 *
 * Es EXACTAMENTE la misma que arma el backend en `on_mensaje()`
 * (`clave = f"{plc}|{tag}"`), porque tanto `GET /tags` como el broadcast usan
 * `info.full_name` como nombre de tag. Por eso no hay que tocarla a mano.
 */
export function claveTag(t: { plc: string; tag: string }): string {
  return `${t.plc}|${t.tag}`;
}

/**
 * Descarga los tags descubiertos en todos los PLCs.
 *
 * OJO: viene VACÍO si ningún PLC ha conectado todavía — la lista se llena
 * recién tras un browse OPC UA exitoso. No es un error, es que no hay nada
 * que ofrecer.
 */
export async function cargarTags(): Promise<TagRemoto[]> {
  const data = await apiGet<{ plc: string | null; tags: TagRemoto[] }>('/tags');
  return Array.isArray(data?.tags) ? data.tags : [];
}
