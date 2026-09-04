// =========================================================================
// exportApi.ts
// Cliente de la exportación a Excel (`/export/*`).
//
// El backend expone nueve endpoints y hasta ahora NINGUNO se llamaba desde la
// aplicación: solo se podían probar desde /docs o con curl. Aquí se cubren
// los siete de la GRABACIÓN EN VIVO, que son los que alimentan la pestaña
// «Exportar»:
//
//   GET    /export/tags                    -> qué se puede grabar
//   POST   /export/grabaciones             -> arrancar
//   GET    /export/grabaciones             -> listar con su estado
//   GET    /export/grabaciones/{id}        -> estado de una
//   POST   /export/grabaciones/{id}/stop   -> parar antes de tiempo
//   DELETE /export/grabaciones/{id}        -> borrar y liberar memoria
//   GET    /export/grabaciones/{id}/excel  -> DESCARGAR el .xlsx
//
// Los dos que exportan desde la BASE DE DATOS (`/export/historico/excel` y
// `/export/consultas/{id}/excel`) todavía no se llaman desde aquí: su parte
// de la vista está montada pero sin conectar.
//
// POR QUÉ NO REUTILIZA `components/flows/api.ts`
// Ese `apiGet`/`apiPost` hace exactamente lo que hace falta para JSON, pero
// vive dentro de `components/`, y un servicio no debería depender de un
// componente. Lo que sí se copia es su criterio, que está bien pensado: leer
// el texto ANTES de parsear (el fallback de la SPA devuelve HTML con estado
// 200 ante una ruta mal escrita) y tratar `{"ok": false}` con HTTP 200 como
// el error que es, porque así reporta el backend casi todo.
// =========================================================================
import { getToken } from './authApi';

/**
 * Origen del backend. Vacío = rutas relativas, que es lo normal:
 * en desarrollo las atiende el proxy de Vite y en producción el mismo
 * FastAPI que sirve el frontend. `VITE_API_BASE` es la escotilla de escape
 * para apuntar a otra máquina.
 */
const API_BASE = import.meta.env.VITE_API_BASE ?? '';

// ─── Tipos ───────────────────────────────────────────────────────

/** Una fila de `GET /export/tags`. */
export interface TagGrabable {
  /** `"<plc_id>|<tag>"`, ya montada. Es lo que espera el POST. */
  clave: string;
  plc: string;
  tag: string;
  tipo: string;
  valor_actual: any;
}

export type EstadoGrabacion = 'grabando' | 'terminada' | 'detenida';

/** Una grabación tal como la devuelve el backend. */
export interface Grabacion {
  grabacion_id: string;
  nombre: string;
  estado: EstadoGrabacion;
  tags: string[];
  todos_los_tags: boolean;
  num_tags: number;
  intervalo_ms: number;
  /** 0 = indefinida, hasta que se pare a mano. */
  duracion_s: number;
  inicio: string;
  fin: string | null;
  segundos_transcurridos: number;
  segundos_restantes: number;
  num_muestras: number;
  motivo_fin: string;
  descargable: boolean;
}

export interface ResumenGrabaciones {
  grabaciones: Grabacion[];
  num_grabaciones: number;
  en_curso: number;
  tags_en_cache: number;
}

/** Cuerpo de `POST /export/grabaciones`. */
export interface NuevaGrabacion {
  grabacion_id: string;
  /** Vacío = TODOS los tags disponibles. */
  tags: string[];
  intervalo_ms: number;
  duracion_s: number;
  nombre: string;
}

export interface RespuestaInicio {
  ok: boolean;
  grabacion_id: string;
  mensaje: string;
  /** Tags que no existen ahora mismo. Es un aviso, no un fallo. */
  tags_desconocidos?: string[];
}

// ─── Transporte ──────────────────────────────────────────────────

async function pedir<T = any>(ruta: string, init?: RequestInit): Promise<T> {
  const token = getToken();
  const cabeceras: Record<string, string> = {
    ...((init?.headers as Record<string, string>) ?? {}),
  };
  if (token) cabeceras.Authorization = `Bearer ${token}`;

  let resp: Response;
  try {
    resp = await fetch(`${API_BASE}${ruta}`, { ...init, headers: cabeceras });
  } catch {
    throw new Error(
      'No se pudo contactar al backend. Revisa que uvicorn esté corriendo.'
    );
  }

  // Texto primero: ante una ruta mal escrita el fallback de la SPA devuelve
  // HTML con estado 200, y un `resp.json()` directo reventaría con un error
  // que no dice nada.
  const raw = await resp.text();
  let data: any = null;
  try {
    data = raw ? JSON.parse(raw) : null;
  } catch {
    data = null;
  }

  if (!resp.ok) {
    throw new Error(
      data?.mensaje || data?.detail || `HTTP ${resp.status} ${resp.statusText}`
    );
  }
  return data as T;
}

// ─── Endpoints ───────────────────────────────────────────────────

/**
 * Tags que se pueden grabar, con su valor actual.
 *
 * Viene VACÍO si ningún PLC ha conectado todavía: la lista se llena tras el
 * browse OPC UA. No es un error, es que no hay nada que ofrecer.
 */
export async function fetchTagsGrabables(): Promise<TagGrabable[]> {
  const d = await pedir<{ num_tags: number; tags: TagGrabable[] }>('/export/tags');
  return Array.isArray(d?.tags) ? d.tags : [];
}

/**
 * Arranca una grabación.
 *
 * NO lanza cuando el backend responde `ok: false` — el caso típico es «ese id
 * ya está grabando», que la vista tiene que poder enseñar junto al formulario
 * en vez de como un error genérico. Sí lanza si el backend no responde.
 */
export function iniciarGrabacion(cuerpo: NuevaGrabacion): Promise<RespuestaInicio> {
  return pedir<RespuestaInicio>('/export/grabaciones', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(cuerpo),
  });
}

export async function listarGrabaciones(): Promise<ResumenGrabaciones> {
  const d = await pedir<ResumenGrabaciones>('/export/grabaciones');
  return {
    grabaciones: Array.isArray(d?.grabaciones) ? d.grabaciones : [],
    num_grabaciones: d?.num_grabaciones ?? 0,
    en_curso: d?.en_curso ?? 0,
    tags_en_cache: d?.tags_en_cache ?? 0,
  };
}

export function pararGrabacion(id: string): Promise<{ ok: boolean; mensaje: string }> {
  return pedir(`/export/grabaciones/${encodeURIComponent(id)}/stop`, {
    method: 'POST',
  });
}

export function borrarGrabacion(id: string): Promise<{ ok: boolean; mensaje: string }> {
  return pedir(`/export/grabaciones/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
}

// ─── Descarga del .xlsx ──────────────────────────────────────────

/**
 * Nombre del fichero que manda el servidor.
 *
 * Viaja en `Content-Disposition`, que el backend ya expone por CORS. Se
 * intenta primero `filename*=UTF-8''...` (la forma que admite acentos) y
 * después el `filename=` de toda la vida.
 */
function nombreDeCabecera(cd: string | null): string {
  if (!cd) return '';
  const utf8 = /filename\*=UTF-8''([^;]+)/i.exec(cd);
  if (utf8?.[1]) {
    try {
      return decodeURIComponent(utf8[1].trim());
    } catch {
      /* cabecera mal formada: se cae al otro formato */
    }
  }
  const simple = /filename="?([^";]+)"?/i.exec(cd);
  return simple?.[1]?.trim() ?? '';
}

/**
 * Pide un `.xlsx` a una ruta y se lo entrega al navegador.
 *
 * POR QUÉ `fetch` + blob Y NO UN `<a href>` DIRECTO
 * Los endpoints van autenticados, y un enlace normal no lleva la cabecera
 * `Authorization`: en cuanto `PLC_AUTH_REQUERIDA` esté activo devolvería 401
 * y el usuario vería una pestaña en blanco. Con `fetch` el token viaja, y de
 * paso se puede leer el nombre real del fichero y enseñar el mensaje del
 * backend cuando falla.
 *
 * Devuelve el nombre del fichero que se guardó.
 */
async function descargarXlsx(ruta: string, respaldo: string): Promise<string> {
  const token = getToken();
  const cabeceras: Record<string, string> = {};
  if (token) cabeceras.Authorization = `Bearer ${token}`;

  let resp: Response;
  try {
    resp = await fetch(`${API_BASE}${ruta}`, { headers: cabeceras });
  } catch {
    throw new Error('No se pudo contactar al backend para descargar el Excel.');
  }

  // Los 404 de aquí vienen con cuerpo JSON y NO son fallos técnicos: son
  // «no hay datos en ese rango» o «la grabación todavía no tiene muestras».
  // El mensaje del backend ya está escrito para leerse, así que se pasa tal
  // cual en vez de traducirlo a un «HTTP 404» que no le dice nada a nadie.
  if (!resp.ok) {
    const raw = await resp.text().catch(() => '');
    let mensaje = '';
    try {
      mensaje = JSON.parse(raw)?.mensaje ?? '';
    } catch {
      /* no era JSON */
    }
    throw new Error(mensaje || `No se pudo descargar (HTTP ${resp.status}).`);
  }

  const blob = await resp.blob();
  const nombre = nombreDeCabecera(resp.headers.get('Content-Disposition')) || respaldo;

  // El objeto URL se revoca SIEMPRE, aunque el clic falle: cada blob sin
  // revocar se queda en memoria hasta que se recargue la pestaña, y un Excel
  // de una grabación larga no son cuatro bytes.
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = nombre;
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    URL.revokeObjectURL(url);
  }

  return nombre;
}

/** El Excel de una grabación en vivo. */
export function descargarExcelGrabacion(id: string): Promise<string> {
  return descargarXlsx(
    `/export/grabaciones/${encodeURIComponent(id)}/excel`,
    `${id}.xlsx`
  );
}

/** Filtros de `GET /export/historico/excel`. */
export interface FiltroHistorico {
  grupoId: string;
  /** Tag SIN el prefijo del PLC. Vacío = todos los del grupo. */
  tag?: string;
  /** ISO 8601. Vacío = sin límite por ese lado. */
  desde?: string;
  hasta?: string;
  limite?: number;
}

/**
 * El Excel del histórico que ya guardó el historizador.
 *
 * Los filtros van como parámetros de consulta y solo se mandan los que
 * tienen algo: el backend trata «ausente» y «vacío» distinto, y un `desde=`
 * en blanco no es lo mismo que no filtrar por fecha.
 *
 * OJO CON LAS FECHAS: se mandan tal como las escribe el usuario, sin zona.
 * El backend interpreta una marca sin zona como UTC. Cuadrar eso con la hora
 * de planta es un tema aparte, todavía pendiente.
 */
export function descargarExcelHistorico(f: FiltroHistorico): Promise<string> {
  const q = new URLSearchParams({ grupo_id: f.grupoId });
  if (f.tag?.trim()) q.set('tag', f.tag.trim());
  if (f.desde?.trim()) q.set('desde', f.desde.trim());
  if (f.hasta?.trim()) q.set('hasta', f.hasta.trim());
  if (f.limite && f.limite > 0) q.set('limite', String(f.limite));

  return descargarXlsx(
    `/export/historico/excel?${q.toString()}`,
    `historico_${f.grupoId}.xlsx`
  );
}

// ─── Utilidades de presentación ──────────────────────────────────

/** `90` -> `"1 min 30 s"`. Para las duraciones, que se leen mal en segundos. */
export function duracionLegible(segundos: number): string {
  if (segundos <= 0) return 'Indefinida';
  if (segundos < 60) return `${Math.round(segundos)} s`;
  const min = Math.floor(segundos / 60);
  const seg = Math.round(segundos % 60);
  if (min < 60) return seg ? `${min} min ${seg} s` : `${min} min`;
  const h = Math.floor(min / 60);
  return `${h} h ${min % 60} min`;
}

/**
 * Cuánto lleva hecho, de 0 a 1.
 *
 * Una grabación indefinida no tiene porcentaje: no hay final contra el que
 * medir. Se devuelve `null` y la vista enseña una barra indeterminada en vez
 * de inventarse un número.
 */
export function progresoDe(g: Grabacion): number | null {
  if (g.estado !== 'grabando') return 1;
  if (!g.duracion_s) return null;
  return Math.min(1, g.segundos_transcurridos / g.duracion_s);
}
