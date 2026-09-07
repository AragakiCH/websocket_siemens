// =========================================================================
// usuariosApi.ts
// CRUD de la pantalla de gestión de usuarios.
//
//   GET    /auth/usuarios/buscar   listado con filtros, orden y paginación
//   GET    /auth/usuarios/{u}      leer una cuenta
//   POST   /auth/usuarios          crear
//   PATCH  /auth/usuarios/{u}      editar (todo opcional)
//   DELETE /auth/usuarios/{u}      borrar
//
// Los tipos salen de la tabla `usuarios`, columna a columna. Lo que NUNCA
// aparece aquí es `password_hash`: el backend no lo devuelve jamás, y la
// contraseña solo viaja en una dirección (al crear o al cambiarla).
//
// Permisos: listar y leer exigen `Administradores`; crear, editar y borrar
// exigen `Supervisor`. El backend lo aplica de verdad — esconder un botón en
// la vista no es seguridad.
// =========================================================================
import { fetchAuth, Rol } from './authApi';

export type EstadoCuenta = 'Activo' | 'Inactivo';

/** Una fila de `usuarios`, tal y como la devuelve la API. Sin el hash. */
export interface Usuario {
  id: number;
  usuario: string;
  email: string;
  categoria: Rol;
  estado: EstadoCuenta;
  creado_en: string;
  ultimo_acceso: string;
  /** Solo en `leerUsuario`: si tiene sesión abierta ahora mismo. */
  conectado?: boolean;
}

export interface FiltrosUsuarios {
  /** Busca a la vez en nombre y correo. */
  texto?: string;
  categoria?: Rol | '';
  estado?: EstadoCuenta | '';
  /** `usuario` | `categoria` | `estado` | `creado_en` | `ultimo_acceso` | `id` */
  orden?: string;
  descendente?: boolean;
  limite?: number;
  desplazamiento?: number;
}

export interface PaginaUsuarios {
  usuarios: Usuario[];
  /** Total de la BÚSQUEDA, sin paginar: sirve para "20 de 137". */
  total: number;
  limite: number;
  desplazamiento: number;
  roles: string[];
  estados: string[];
  db_id: string;
}

export interface NuevoUsuario {
  usuario: string;
  password: string;
  email?: string;
  categoria?: Rol;
  estado?: EstadoCuenta;
}

/**
 * Cambios sobre una cuenta. Lo que se omite NO se toca.
 *
 * Ojo con la diferencia entre omitir y vaciar: si `email` no se manda, se
 * deja como estaba; si se manda `''`, se borra el correo.
 */
export interface CambiosUsuario {
  nuevo_usuario?: string;
  email?: string;
  categoria?: Rol;
  estado?: EstadoCuenta;
  password?: string;
}

export interface ResultadoCambio {
  ok: boolean;
  usuario: string;
  /** Nombre anterior, si hubo renombrado. */
  anterior?: string;
  /** Lista legible de lo que cambió, para un aviso al usuario. */
  cambios: string[];
  mensaje: string;
}

// ===================================================================== //
// Lectura
// ===================================================================== //
export async function buscarUsuarios(
  f: FiltrosUsuarios = {}
): Promise<PaginaUsuarios> {
  const q = new URLSearchParams();
  if (f.texto) q.set('texto', f.texto);
  if (f.categoria) q.set('categoria', f.categoria);
  if (f.estado) q.set('estado', f.estado);
  if (f.orden) q.set('orden', f.orden);
  if (f.descendente) q.set('descendente', 'true');
  q.set('limite', String(f.limite ?? 50));
  q.set('desplazamiento', String(f.desplazamiento ?? 0));

  const d = await fetchAuth(`/auth/usuarios/buscar?${q.toString()}`);
  return {
    usuarios: d.usuarios ?? [],
    total: d.total ?? 0,
    limite: d.limite ?? 50,
    desplazamiento: d.desplazamiento ?? 0,
    roles: d.roles ?? [],
    estados: d.estados ?? [],
    db_id: d.db_id ?? '',
  };
}

export async function leerUsuario(usuario: string): Promise<Usuario> {
  const d = await fetchAuth(`/auth/usuarios/${encodeURIComponent(usuario)}`);
  return d.usuario;
}

// ===================================================================== //
// Escritura
// ===================================================================== //
export async function crearUsuario(datos: NuevoUsuario): Promise<Usuario> {
  const d = await fetchAuth('/auth/usuarios', {
    method: 'POST',
    body: JSON.stringify(datos),
  });
  return d.usuario;
}

export async function editarUsuario(
  usuario: string,
  cambios: CambiosUsuario
): Promise<ResultadoCambio> {
  return fetchAuth(`/auth/usuarios/${encodeURIComponent(usuario)}`, {
    method: 'PATCH',
    body: JSON.stringify(cambios),
  });
}

export async function borrarUsuario(usuario: string): Promise<any> {
  return fetchAuth(`/auth/usuarios/${encodeURIComponent(usuario)}`, {
    method: 'DELETE',
  });
}

// Atajos para las acciones de un clic en la tabla.
export const activarUsuario = (u: string) =>
  editarUsuario(u, { estado: 'Activo' });

export const desactivarUsuario = (u: string) =>
  editarUsuario(u, { estado: 'Inactivo' });

export const cambiarRol = (u: string, categoria: Rol) =>
  editarUsuario(u, { categoria });

export const resetearPassword = (u: string, password: string) =>
  editarUsuario(u, { password });

// ===================================================================== //
// Ayudas para la vista
// ===================================================================== //
/**
 * Traduce los errores del backend a algo accionable.
 *
 * El **409** es el que más importa: no significa "ha fallado", significa "esto
 * te dejaría sin acceso al sistema". El mensaje del backend ya explica cuál de
 * los tres casos es (tú mismo, último Supervisor, nombre repetido), así que se
 * pasa tal cual en vez de sustituirlo por uno genérico.
 */
export function mensajeError(e: any): string {
  const msg = e?.message ?? 'No se pudo completar la operación.';
  if (e?.status === 403) {
    return 'Tu categoría no permite esta acción. Hace falta ser Supervisor.';
  }
  if (e?.status === 401) {
    return 'Tu sesión caducó. Vuelve a entrar.';
  }
  return msg;
}

/**
 * Reglas de la vista: qué NO se debe ofrecer sobre una cuenta.
 *
 * Duplica a propósito parte de lo que valida el backend, pero con otro fin:
 * el backend IMPIDE, esto solo evita ofrecer un botón que va a devolver 409.
 * Que la comprobación esté en los dos lados no es redundancia — es que una es
 * seguridad y la otra es cortesía.
 */
export function puedeBorrar(u: Usuario, yo: string,
                            supervisoresActivos: number): {ok: boolean;motivo: string;} {
  if (u.usuario === yo) {
    return { ok: false, motivo: 'No puedes borrar tu propia cuenta.' };
  }
  if (u.categoria === 'Supervisor' && u.estado === 'Activo' &&
      supervisoresActivos <= 1) {
    return {
      ok: false,
      motivo: 'Es el único Supervisor activo. Crea otro antes de borrarlo.',
    };
  }
  return { ok: true, motivo: '' };
}

export function puedeDesactivar(u: Usuario, yo: string,
                                supervisoresActivos: number): {ok: boolean;motivo: string;} {
  if (u.usuario === yo) {
    return {
      ok: false,
      motivo: 'No puedes desactivar tu propia cuenta: te cerraría la sesión.',
    };
  }
  if (u.categoria === 'Supervisor' && u.estado === 'Activo' &&
      supervisoresActivos <= 1) {
    return {
      ok: false,
      motivo: 'Es el único Supervisor activo. Nadie podría gestionar cuentas.',
    };
  }
  return { ok: true, motivo: '' };
}

/** Cuántos Supervisores activos hay en la lista cargada. */
export function contarSupervisoresActivos(lista: Usuario[]): number {
  return lista.filter(
    (u) => u.categoria === 'Supervisor' && u.estado === 'Activo'
  ).length;
}
