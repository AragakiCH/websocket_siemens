// Domain models for the emulated PLC layer.

export type DataType = 'bool' | 'int' | 'double' | 'string';

export interface PlcVariable {
  id: string;
  name: string;
  type: DataType;
  value: boolean | number | string;
  unit?: string;
  selected: boolean;
}

export type UpdateRate = 250 | 500 | 1000 | 2000 | 5000;

export type ThemeMode = 'light' | 'dark' | 'auto';

export type Language = 'es' | 'en';

export interface AppConfig {
  updateRate: UpdateRate;
  theme: ThemeMode;
  language: Language;
}

export const UPDATE_RATE_OPTIONS: {label: string;value: UpdateRate;}[] = [
{ label: '250 ms', value: 250 },
{ label: '500 ms', value: 500 },
{ label: '1 segundo', value: 1000 },
{ label: '2 segundos', value: 2000 },
{ label: '5 segundos', value: 5000 }];