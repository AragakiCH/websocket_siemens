import { PlcVariable } from '../models/plc';

/** Cuántos elementos de un array se enseñan antes del «…». */
const MAX_ELEMENTOS_VISIBLES = 6;

/** Un elemento suelto de un array, con el tipo del array. */
const formatElemento = (x: unknown, tipo: PlcVariable['type']): string => {
  if (x === null || x === undefined) return '—';
  if (tipo === 'bool') return x ? '1' : '0';
  if (typeof x === 'number') return tipo === 'double' ? x.toFixed(1) : String(x);
  if (typeof x === 'object') return '{…}';
  return String(x);
};

/**
 * Un array del PLC (`Array[1..20] of Bool`), compacto: «[20] 1 0 1 1 0 0 …».
 *
 * Antes el backend lo mandaba como texto ("[True, False, ...]") y la tabla
 * lo pintaba entero; con un DB de pruebas de veinte booleanos y treinta
 * reales la columna ocupaba media pantalla. Aquí se enseña el tamaño y
 * los primeros elementos; el valor completo va en el `title` de la celda.
 */
export const formatArray = (arr: unknown[], tipo: PlcVariable['type']): string => {
  const vistos = arr.slice(0, MAX_ELEMENTOS_VISIBLES).map((x) => formatElemento(x, tipo));
  const resto = arr.length > MAX_ELEMENTOS_VISIBLES ? ' …' : '';
  return `[${arr.length}] ${vistos.join(' ')}${resto}`;
};

/** El valor completo, para un tooltip: arrays y structs en JSON legible. */
export const formatValueFull = (v: PlcVariable | undefined): string => {
  if (!v || v.value === null || v.value === undefined) return '—';
  if (Array.isArray(v.value) || typeof v.value === 'object') {
    try {
      return JSON.stringify(v.value);
    } catch {
      return String(v.value);
    }
  }
  return formatValue(v);
};

export const formatValue = (v: PlcVariable | undefined): string => {
  if (!v) return '—';
  if (v.value === null || v.value === undefined) return '—';
  // Arrays y structs ANTES del tipo: un `Array of Bool` tiene type 'bool',
  // y tratarlo como un booleano suelto daría «ON» para cualquier lista.
  if (Array.isArray(v.value)) return formatArray(v.value as unknown[], v.type);
  if (typeof v.value === 'object') {
    const claves = Object.keys(v.value as object);
    return `{${claves.length} campos}`;
  }
  if (v.type === 'bool') return v.value as boolean ? 'ON' : 'OFF';
  // Strings (u otros valores no numéricos): mostrarlos tal cual, sin Number()
  if (v.type === 'string') return String(v.value);
  const num = typeof v.value === 'number' ? v.value : Number(v.value);
  if (Number.isNaN(num)) return String(v.value);
  const val = v.type === 'double' ? num.toFixed(1) : String(num);
  return v.unit ? `${val} ${v.unit}` : val;
};

// Normalises a variable value to a 0..1 fraction for gauges / tanks.
export const valueFraction = (v: PlcVariable | undefined): number => {
  if (!v) return 0;
  if (Array.isArray(v.value) || (v.value && typeof v.value === 'object')) return 0;
  if (v.type === 'bool') return v.value as boolean ? 1 : 0;
  const num = typeof v.value === 'number' ? v.value : Number(v.value);
  if (Number.isNaN(num)) return 0;
  // heuristics: treat <=100 as percentage, otherwise scale by magnitude
  if (num <= 100) return Math.max(0, Math.min(1, num / 100));
  if (num <= 3000) return Math.max(0, Math.min(1, num / 3000));
  return Math.max(0, Math.min(1, num / 10000));
};

export const isTruthy = (v: PlcVariable | undefined): boolean => {
  if (!v) return false;
  if (Array.isArray(v.value)) return (v.value as unknown[]).some(Boolean);
  if (v.type === 'bool') return v.value as boolean;
  const num = typeof v.value === 'number' ? v.value : Number(v.value);
  return num > 0;
};