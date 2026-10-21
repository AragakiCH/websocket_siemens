// =========================================================================
// etiquetasTrendApi.ts
// Las etiquetas del widget Tendencia, guardadas en el SERVIDOR
// (`datos/etiquetas_trend.json`, ver app/api/etiquetas_trend_routes.py).
//
// Leer: cualquier usuario con sesión. Crear y borrar: solo Supervisor (lo
// exige el servidor; el widget además apaga los botones).
// =========================================================================
import { fetchAuth } from './authApi';

export interface LecturaGuardada {
  variable?: string;
  nombre: string;
  color?: string;
  valor: number | null;
  unidad?: string;
}

/** Una etiqueta tal como la guarda el servidor. `ts` va en UTC (ISO). */
export interface EtiquetaGuardada {
  id: string;
  widget: string;
  variable: string;
  curva: string;
  color: string;
  nombre: string;
  ts: string;
  valor: number;
  lecturas: LecturaGuardada[];
  autor?: string;
  creado?: string;
}

export type NuevaEtiquetaGuardada = Omit<EtiquetaGuardada, 'id' | 'autor' | 'creado'>;

/** Las etiquetas de un trend con `desde <= ts <= hasta` (ISO; vacío = sin límite). */
export async function listarEtiquetasTrend(
  widget: string,
  desde?: string,
  hasta?: string
): Promise<EtiquetaGuardada[]> {
  const q = new URLSearchParams({ widget });
  if (desde) q.set('desde', desde);
  if (hasta) q.set('hasta', hasta);
  const d = await fetchAuth(`/trend/etiquetas?${q.toString()}`);
  return Array.isArray(d?.etiquetas) ? d.etiquetas : [];
}

export async function crearEtiquetaTrend(e: NuevaEtiquetaGuardada): Promise<EtiquetaGuardada> {
  const d = await fetchAuth('/trend/etiquetas', { method: 'POST', body: JSON.stringify(e) });
  return d.etiqueta;
}

export async function borrarEtiquetaTrend(id: string): Promise<void> {
  await fetchAuth(`/trend/etiquetas/${encodeURIComponent(id)}`, { method: 'DELETE' });
}
