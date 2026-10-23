// =========================================================================
// services/constantesApi.ts
// Las constantes de los parámetros de faceplate (datos/variables_constantes.json).
//
// Qué son y por qué se publican como tags está en
// app/core/constantes_store.py. Lo esencial para la vista:
//
//   * Cada constante es de UN tipo de faceplate (`faceplate` = su project_id).
//   * Se enlaza con la clave `constante|<id>` —el id, no el nombre—, así que
//     renombrarla no rompe ningún enlace.
//   * Llega por el WebSocket como un tag más, así que un faceplate la pinta
//     sin saber que es una constante. Solo los desplegables de parámetros de
//     faceplate la OFRECEN; el resto de selectores la esconden.
// =========================================================================
import { fetchAuth } from './authApi';

/** El «PLC» con el que se publican. */
export const PLC_CONSTANTE = 'constante';
export const PREFIJO_CONSTANTE = `${PLC_CONSTANTE}|`;

export type TipoConstante = 'bool' | 'int' | 'double' | 'string';

export interface Constante {
  id: string;
  faceplate: string;
  nombre: string;
  tipo: TipoConstante;
  valor: boolean | number | string;
  /** `constante|<id>`: lo que se guarda en el parámetro. */
  clave: string;
  creado_en?: string;
  actualizado_en?: string;
}

export const esClaveConstante = (v: string | null | undefined): boolean =>
  typeof v === 'string' && v.startsWith(PREFIJO_CONSTANTE);

export const idDeClave = (clave: string): string =>
  clave.startsWith(PREFIJO_CONSTANTE) ? clave.slice(PREFIJO_CONSTANTE.length) : clave;

/** El valor como se lee en el desplegable: «1450», «Sí», «"Auto"». */
export function fmtValorConstante(c: Pick<Constante, 'tipo' | 'valor'>): string {
  if (c.tipo === 'bool') return c.valor ? 'Sí (true)' : 'No (false)';
  if (c.tipo === 'string') return `"${String(c.valor ?? '')}"`;
  return String(c.valor ?? '');
}

export async function listarConstantes(faceplate: string): Promise<Constante[]> {
  const q = new URLSearchParams({ faceplate });
  const d = await fetchAuth(`/constantes?${q.toString()}`);
  return Array.isArray(d?.constantes) ? d.constantes : [];
}

export async function crearConstante(c: {
  faceplate: string;
  nombre: string;
  tipo: TipoConstante;
  valor: unknown;
}): Promise<Constante> {
  const d = await fetchAuth('/constantes', { method: 'POST', body: JSON.stringify(c) });
  return d.constante;
}

export async function editarConstante(
  id: string,
  cambio: { nombre?: string; valor?: unknown }
): Promise<Constante> {
  const d = await fetchAuth(`/constantes/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(cambio),
  });
  return d.constante;
}

export async function borrarConstante(id: string): Promise<void> {
  await fetchAuth(`/constantes/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

/** Dónde está asignada (pantallas guardadas). Para avisar antes de borrar. */
export async function usosConstante(
  id: string
): Promise<{ widgets: number; pantallas: string[] }> {
  const d = await fetchAuth(`/constantes/${encodeURIComponent(id)}/usos`);
  return { widgets: Number(d?.widgets) || 0, pantallas: Array.isArray(d?.pantallas) ? d.pantallas : [] };
}
