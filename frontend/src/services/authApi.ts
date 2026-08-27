// =========================================================================
// authApi.ts
// Cliente de los endpoints de identidad (`/auth/*`).
//
// El token de sesión se guarda en `localStorage` y se adjunta a TODAS las
// peticiones mediante `fetchAuth()`. Aquí `localStorage` sí es lo correcto:
// la sesión es de este navegador, no algo que deba compartirse.
//
// Para el WebSocket el token no puede ir en una cabecera (la API del navegador
// no lo permite al conectar), así que viaja en el query string: `/ws?token=…`.
// Por eso existe `tokenParaWs()`.
// =========================================================================

const TOKEN_KEY = 'hmi.auth.token';

export type Rol = 'Supervisor' | 'Administradores' | 'Usuarios' | 'Invitado';

export interface UsuarioSesion {
  usuario: string;
  categoria: Rol;
  usuario_id?: number;
  /** Base contra la que se autenticó esta sesión. */
  db_id?: string;
}

/** Una base entre las que se puede elegir al entrar. */
export interface BaseDatos {
  db_id: string;
  nombre: string;
  motor: string;
  etiqueta_motor: string;
  base_datos: string;
  conectado: boolean;
  por_defecto: boolean;
}

export interface Permisos {
  ver: boolean;
  editar_diseño: boolean;
  gestionar_plcs: boolean;
  gestionar_bd: boolean;
  gestionar_usuarios: boolean;
}

/**
 * Base de datos donde vive la tabla `usuarios`.
 *
 * `fijada` distingue una decisión de una casualidad: `true` = la eligió
 * `PLC_AUTH_DB_ID` en el `.env`; `false` = se tomó la primera conexión de la
 * lista porque nadie la fijó. La vista avisa en el segundo caso.
 */
export interface InfoBd {
  configurada: boolean;
  fijada: boolean;
  db_id?: string;
  nombre?: string;
  motor?: string;
  etiqueta_motor?: string;
  base_datos?: string;
  conectado?: boolean;
  tabla?: string;
  mensaje?: string;
}

export interface EstadoAuth {
  hay_usuarios: boolean;
  num_usuarios: number;
  auth_requerida: boolean;
  bd_disponible: boolean;
  bd?: InfoBd;
  /** Catálogo para el desplegable. Vacío si no hay conexiones dadas de alta. */
  bases?: BaseDatos[];
  roles: string[];
  estados: string[];
  mensaje: string;
}

/**
 * Última base elegida en el login, recordada en este navegador.
 *
 * Es una preferencia local, no configuración compartida: cada equipo trabaja
 * habitualmente contra la misma base, y volver a elegirla en cada arranque
 * sería el tipo de fricción que acaba en entrar sin mirar y preguntarse por
 * qué "no existe" la cuenta.
 */
const BASE_KEY = 'hmi.auth.db';

export function getBasePreferida(): string {
  try {
    return localStorage.getItem(BASE_KEY) ?? '';
  } catch {
    return '';
  }
}

export function setBasePreferida(dbId: string): void {
  try {
    if (dbId) localStorage.setItem(BASE_KEY, dbId);
    else localStorage.removeItem(BASE_KEY);
  } catch {
    /* sin storage: se usará la base por defecto del servidor */
  }
}

// ---- Token ----------------------------------------------------------- //
//
// DOS almacenes, y la diferencia es justo lo que hace "Mantener la sesión
// iniciada":
//
//   localStorage   -> sobrevive a cerrar el navegador. Marcado = recordarme.
//   sessionStorage -> muere al cerrar la pestaña. Sin marcar.
//
// Es la distinción que espera cualquiera que use un equipo compartido: en un
// PC de planta, dejar la sesión abierta en localStorage significa que el
// siguiente turno entra como tú. Antes el check no hacía nada y SIEMPRE se
// guardaba en localStorage.
//
// El token NO caduca por esto: la sesión sigue durando 12 h en el servidor.
// Esto solo decide cuánto vive la COPIA que guarda el navegador.
export function getToken(): string {
  try {
    return (
      sessionStorage.getItem(TOKEN_KEY) ??
      localStorage.getItem(TOKEN_KEY) ??
      ''
    );
  } catch {
    return '';
  }
}

/**
 * Guarda el token. `recordar` elige el almacén; si se omite, se conserva el
 * que ya se estaba usando (importante al refrescar un token existente: no
 * queremos ascender una sesión de pestaña a permanente sin querer).
 */
export function setToken(token: string, recordar?: boolean): void {
  try {
    if (!token) {
      localStorage.removeItem(TOKEN_KEY);
      sessionStorage.removeItem(TOKEN_KEY);
      return;
    }
    const permanente =
      recordar ?? localStorage.getItem(TOKEN_KEY) !== null;

    // Escribir siempre en UNO y limpiar el otro: si quedaran los dos, cerrar
    // la pestaña no cerraría la sesión y "Recordarme" volvería a no hacer nada.
    if (permanente) {
      localStorage.setItem(TOKEN_KEY, token);
      sessionStorage.removeItem(TOKEN_KEY);
    } else {
      sessionStorage.setItem(TOKEN_KEY, token);
      localStorage.removeItem(TOKEN_KEY);
    }
  } catch {
    /* modo incógnito o storage lleno: la sesión durará lo que viva la página */
  }
}

/** Sufijo `?token=…` (o `&token=…`) para la URL del WebSocket. */
export function tokenParaWs(url: string): string {
  const t = getToken();
  if (!t) return url;
  return url + (url.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(t);
}

// ---- fetch con sesión ------------------------------------------------ //
/**
 * `fetch` que adjunta el token y traduce los errores del backend.
 *
 * Un 401 significa que la sesión caducó o fue cerrada (por ejemplo, porque un
 * supervisor desactivó la cuenta): se limpia el token y se avisa a la
 * aplicación con un evento, para que vuelva al login sin recargar la página.
 */
export async function fetchAuth(
  url: string,
  init: RequestInit = {}
): Promise<any> {
  const token = getToken();
  const headers: Record<string, string> = {
    ...((init.headers as Record<string, string>) ?? {}),
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (init.body && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }

  const r = await fetch(url, { ...init, headers });
  const data = await r.json().catch(() => null);

  if (r.status === 401 && token) {
    setToken('');
    window.dispatchEvent(new CustomEvent('hmi:sesion-caducada'));
  }

  if (!r.ok) {
    const detalle =
      typeof data?.detail === 'string'
        ? data.detail
        : data?.detail
          ? JSON.stringify(data.detail)
          : `HTTP ${r.status}`;
    const err = new Error(detalle) as Error & { status?: number; data?: any };
    err.status = r.status;
    err.data = data;
    throw err;
  }
  return data;
}

// ---- Endpoints ------------------------------------------------------- //
/**
 * Estado del sistema de cuentas. Público: no necesita sesión.
 *
 * Lanza si el backend no responde. El login lo trata como "no puedo saber en
 * qué estado estoy" y lo dice, en vez de pintar un formulario que va a fallar.
 */
export async function fetchEstadoAuth(dbId?: string): Promise<EstadoAuth> {
  // `hay_usuarios` depende de la BASE, no del sistema: cada una tiene su
  // propia tabla `usuarios`. Por eso al cambiar de opción hay que volver a
  // preguntar, o el login diría "crea la primera cuenta" sobre una base que
  // ya tiene diez.
  const q = dbId ? `?db_id=${encodeURIComponent(dbId)}` : '';
  const r = await fetch(`/auth/estado${q}`);
  if (!r.ok) throw new Error(`El servidor respondió ${r.status}.`);
  return r.json();
}

export async function login(
  usuario: string,
  password: string,
  recordar = true,
  dbId?: string
): Promise<{ usuario: UsuarioSesion; token: string; db_id?: string }> {
  const data = await fetchAuth('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ usuario, password, db_id: dbId || undefined }),
  });
  setToken(data.token, recordar);
  // Se recuerda la base con la que SÍ se pudo entrar, no la que se pidió.
  if (data.db_id) setBasePreferida(data.db_id);
  return data;
}

export async function registro(datos: {
  usuario: string;
  password: string;
  email?: string;
  categoria?: string;
  estado?: string;
  db_id?: string;
}): Promise<any> {
  return fetchAuth('/auth/registro', {
    method: 'POST',
    body: JSON.stringify(datos),
  });
}

export async function logout(): Promise<void> {
  try {
    await fetchAuth('/auth/logout', { method: 'POST' });
  } catch {
    /* si el servidor no responde, la sesión local se cierra igual */
  }
  setToken('');
}

export async function me(): Promise<{
  autenticado: boolean;
  sesion?: UsuarioSesion;
  permisos?: Permisos;
  auth_requerida?: boolean;
}> {
  return fetchAuth('/auth/me');
}

export async function listarUsuarios(): Promise<any[]> {
  const d = await fetchAuth('/auth/usuarios');
  return d.usuarios ?? [];
}

export async function conectados(): Promise<any[]> {
  const d = await fetchAuth('/auth/conectados');
  return d.usuarios ?? [];
}
