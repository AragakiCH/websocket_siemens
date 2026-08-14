import { PlcVariable } from '../models/plc';

export const formatValue = (v: PlcVariable | undefined): string => {
  if (!v) return '—';
  if (v.value === null || v.value === undefined) return '—';
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
  if (v.type === 'bool') return v.value as boolean;
  const num = typeof v.value === 'number' ? v.value : Number(v.value);
  return num > 0;
};