// =========================================================================
// activityApi.ts
// Cliente de todo lo que responde a "¿qué han hecho los demás?".
//
// Junta cuatro endpoints que ya existían pero que solo se podían consultar
// desde /docs o con curl:
//
//   GET /auth/conectados  -> quién está trabajando AHORA
//   GET /locks            -> quién tiene el lápiz de cada pantalla
//   GET /auditoria        -> el histórico: quién hizo qué y cuándo
//   GET /auth/usuarios    -> las cuentas y su último acceso
//
// Los cuatro exigen al menos `Administradores`; `/auditoria` y la gestión de
// cuentas, según la acción, exigen `Supervisor`. El backend lo comprueba: si
// alguien llama sin permiso recibe 403 aunque la pantalla se le muestre.
// =========================================================================
import { fetchAuth } from './authApi';

export interface Conectado {
  usuario: string;
  categoria: string;
}

export interface Bloqueo {
  recurso: string;
  usuario: string;
  categoria: string;
  adquirido: string;
  ultimo_latido: string;
  segundos_restantes: number;
}

export interface EventoAuditoria {
  ts: string;
  usuario: string;
  accion: string;
  recurso: string;
  resultado: string;
  detalle?: Record<string, any>;
}

export interface CuentaUsuario {
  id: number;
  usuario: string;
  email: string;
  categoria: string;
  estado: string;
  creado_en: string;
  ultimo_acceso: string;
}

export async function fetchConectados(): Promise<{
  usuarios: Conectado[];
  num_sesiones: number;
  num_clientes_ws: number;
}> {
  const d = await fetchAuth('/auth/conectados');
  return {
    usuarios: d.usuarios ?? [],
    num_sesiones: d.num_sesiones ?? 0,
    num_clientes_ws: d.num_clientes_ws ?? 0,
  };
}

export async function fetchBloqueos(): Promise<Bloqueo[]> {
  const d = await fetchAuth('/locks');
  return d.locks ?? [];
}

/**
 * Histórico de auditoría, del más reciente al más antiguo.
 *
 * `accion` filtra por PREFIJO: `plc.` devuelve `plc.alta` y `plc.baja`. Es
 * deliberado — las acciones se nombran `familia.verbo` justo para poder
 * filtrar por familia sin listar todos los verbos.
 */
export async function fetchAuditoria(opciones: {
  limite?: number;
  usuario?: string;
  accion?: string;
} = {}): Promise<EventoAuditoria[]> {
  const q = new URLSearchParams();
  q.set('limite', String(opciones.limite ?? 200));
  if (opciones.usuario) q.set('usuario', opciones.usuario);
  if (opciones.accion) q.set('accion', opciones.accion);
  const d = await fetchAuth(`/auditoria?${q.toString()}`);
  return d.eventos ?? [];
}

export async function fetchCuentas(): Promise<CuentaUsuario[]> {
  const d = await fetchAuth('/auth/usuarios');
  return d.usuarios ?? [];
}

/** Activa o desactiva una cuenta. Desactivar cierra sus sesiones al instante. */
export async function cambiarEstadoCuenta(
  usuario: string,
  estado: 'Activo' | 'Inactivo'
): Promise<any> {
  return fetchAuth(`/auth/usuarios/${encodeURIComponent(usuario)}`, {
    method: 'PATCH',
    body: JSON.stringify({ estado }),
  });
}

/** Cambia el rol de una cuenta. Las sesiones abiertas se refrescan solas. */
export async function cambiarRolCuenta(
  usuario: string,
  categoria: string
): Promise<any> {
  return fetchAuth(`/auth/usuarios/${encodeURIComponent(usuario)}`, {
    method: 'PATCH',
    body: JSON.stringify({ categoria }),
  });
}

/** Le quita el lápiz a quien lo tenga. Solo Supervisor. */
export async function forzarBloqueo(recurso: string): Promise<any> {
  return fetchAuth(`/locks/${encodeURIComponent(recurso)}/forzar`, {
    method: 'POST',
  });
}

// ---------------------------------------------------------------------- //
// Presentación
// ---------------------------------------------------------------------- //
/**
 * Traduce el nombre técnico de la acción a algo que se entienda de un vistazo.
 *
 * Las acciones se guardan como `familia.verbo` (estable, filtrable, apto para
 * `grep`), pero un operario no debería tener que descifrar
 * `proyecto.widget_borrado`.
 */
const ETIQUETAS: Record<string, string> = {
  'servicio.arranque': 'Arrancó el servicio',
  'servicio.parada': 'Se detuvo el servicio',
  'plc.alta': 'Agregó un PLC',
  'plc.baja': 'Quitó un PLC',
  'usuario.creado': 'Creó una cuenta',
  'usuario.modificado': 'Modificó una cuenta',
  'lock.adquirido': 'Tomó el control de edición',
  'lock.liberado': 'Soltó el control de edición',
  'lock.forzado': 'Le quitó el control a otro',
  'proyecto.creado': 'Creó una pantalla',
  'proyecto.borrado': 'Borró una pantalla',
  'proyecto.widget_borrado': 'Borró un widget',
};

export function etiquetaAccion(accion: string): string {
  if (ETIQUETAS[accion]) return ETIQUETAS[accion];
  if (accion.startsWith('bd.')) {
    const partes = accion.split('.');
    return `Base de datos · ${partes.slice(1).join(' ')}`;
  }
  return accion;
}

/** Familias para el desplegable de filtro. */
export const FAMILIAS = [
  { valor: '', etiqueta: 'Todo' },
  { valor: 'plc.', etiqueta: 'PLCs' },
  { valor: 'proyecto.', etiqueta: 'Pantallas' },
  { valor: 'usuario.', etiqueta: 'Cuentas' },
  { valor: 'lock.', etiqueta: 'Control de edición' },
  { valor: 'bd.', etiqueta: 'Bases de datos' },
  { valor: 'servicio.', etiqueta: 'Servicio' },
];

/**
 * "hace 3 min", "hace 2 h"… Para una lista de actividad, el tiempo relativo
 * se lee mucho más rápido que una fecha completa.
 *
 * Las marcas llegan en UTC con 'Z'; `new Date` las convierte a la hora local
 * del navegador, así que la cuenta sale bien sin conversiones a mano.
 */
export function haceCuanto(iso: string): string {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return iso;
  const seg = Math.floor((Date.now() - t) / 1000);
  if (seg < 10) return 'ahora mismo';
  if (seg < 60) return `hace ${seg} s`;
  const min = Math.floor(seg / 60);
  if (min < 60) return `hace ${min} min`;
  const hor = Math.floor(min / 60);
  if (hor < 24) return `hace ${hor} h`;
  const dia = Math.floor(hor / 24);
  if (dia < 30) return `hace ${dia} día${dia > 1 ? 's' : ''}`;
  return new Date(iso).toLocaleDateString();
}

/** Fecha y hora local completas, para el tooltip. */
export function fechaLocal(iso: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}
