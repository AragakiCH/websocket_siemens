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
}

export interface Permisos {
  ver: boolean;
  editar_diseño: boolean;
  gestionar_plcs: boolean;
  gestionar_bd: boolean;
  gestionar_usuarios: boolean;
}

export interface EstadoAuth {
  hay_usuarios: boolean;
  num_usuarios: number;
  auth_requerida: boolean;
  bd_disponible: boolean;
  roles: string[];
  estados: string[];
  mensaje: string;
}

// ---- Token ----------------------------------------------------------- //
export function getToken(): string {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? '';
  } catch {
    return '';
  }
}

export function setToken(token: string): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* modo incógnito o storage lleno: la sesión durará lo que la pestaña */
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
/** Estado del sistema de cuentas. Público: no necesita sesión. */
export async function fetchEstadoAuth(): Promise<EstadoAuth> {
  const r = await fetch('/auth/estado');
  return r.json();
}

export async function login(
  usuario: string,
  password: string
): Promise<{ usuario: UsuarioSesion; token: string }> {
  const data = await fetchAuth('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ usuario, password }),
  });
  setToken(data.token);
  return data;
}

export async function registro(datos: {
  usuario: string;
  password: string;
  email?: string;
  categoria?: string;
  estado?: string;
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
