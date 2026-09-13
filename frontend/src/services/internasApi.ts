// =========================================================================
// internasApi.ts
// Alta y baja de las variables INTERNAS del HMI.
//
// LO QUE NO ESTÁ AQUÍ: FORZAR EL VALOR
// Eso se hace con `escribir()` de `escrituraApi`, con `plc_id: 'interno'`,
// que es el mismo camino por el que se escribe en un PLC. No es una
// casualidad: gracias a eso, un botón, un campo E/A o un widget importado
// mueven una variable interna sin una línea de código nueva.
//
// Y LEERLAS TAMPOCO
// Los valores llegan por el WebSocket como cualquier otro tag, así que están
// en `useAppStore().variables` con el id `interno|<nombre>`. Este módulo solo
// sirve para DEFINIRLAS.
// =========================================================================
import { fetchAuth } from './authApi';

/** El «PLC» de mentira bajo el que viven. Ver app/core/internas_handler.py. */
export const PLC_INTERNO = 'interno';

export type TipoInterna = 'bool' | 'int' | 'double' | 'string';

export interface VariableInterna {
  nombre: string;
  tipo: TipoInterna;
  valor: boolean | number | string;
  descripcion: string;
  creado_en?: string;
  creado_por?: string;
  actualizado_en?: string;
  actualizado_por?: string;
}

export const TIPOS: { valor: TipoInterna; label: string }[] = [
  { valor: 'bool', label: 'Sí / no' },
  { valor: 'int', label: 'Entero' },
  { valor: 'double', label: 'Decimal' },
  { valor: 'string', label: 'Texto' },
];

/** El id con el que la conocen los widgets. */
export const idDeInterna = (nombre: string) => `${PLC_INTERNO}|${nombre}`;

export async function listarInternas(): Promise<VariableInterna[]> {
  const d = await fetchAuth('/internas');
  return d.variables ?? [];
}

export async function crearInterna(
  nombre: string,
  tipo: TipoInterna,
  valor?: unknown,
  descripcion = ''
): Promise<VariableInterna> {
  const d = await fetchAuth('/internas', {
    method: 'POST',
    body: JSON.stringify({ nombre, tipo, valor, descripcion }),
  });
  return d.variable;
}

export async function describirInterna(
  nombre: string,
  descripcion: string
): Promise<VariableInterna> {
  const d = await fetchAuth(`/internas/${encodeURIComponent(nombre)}`, {
    method: 'PATCH',
    body: JSON.stringify({ descripcion }),
  });
  return d.variable;
}

export async function borrarInterna(nombre: string): Promise<void> {
  await fetchAuth(`/internas/${encodeURIComponent(nombre)}`, { method: 'DELETE' });
}
