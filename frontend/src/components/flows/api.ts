// ─── Acceso al backend desde el Flow Editor ────────────────────
//
// Un solo lugar donde vive la URL del backend y la interpretación de sus
// respuestas, para no repetir el mismo parseo en cada formulario.

export const API_BASE = 'http://localhost:8000';

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
  let resp: Response;
  try {
    resp = await fetch(`${API_BASE}${ruta}`, init);
  } catch {
    throw new Error(
      `No se pudo contactar al backend en ${API_BASE}. ` +
      `Revisa que uvicorn esté corriendo.`
    );
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
    throw new Error(extraerMensaje(data) || 'El servidor rechazó la petición.');
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

// ─── GET /db ───────────────────────────────────────────────────

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
