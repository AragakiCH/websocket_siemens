// Domain models for the PLC layer.

export type DataType = 'bool' | 'int' | 'double' | 'string';

/**
 * Marca del PLC. Determina qué driver usa el backend:
 *  - 'siemens': S7-1500 por OPC UA anónimo, tags bajo DataBlocksGlobal.
 *  - 'rexroth': ctrlX CORE, requiere usuario/contraseña y elegir el programa
 *               dentro de Datalayer/plc/app/<app>/sym/<programa>.
 */
export type PlcVendor = 'siemens' | 'rexroth';

/** Datos que la vista de Login envía al backend para dar de alta un PLC. */
export interface PlcConnection {
  vendor: PlcVendor;
  ip: string;
  puerto?: number;
  // Solo Rexroth:
  usuario?: string;
  password?: string;
  app?: string;
  programa?: string;
}

export interface PlcVariable {
  id: string;
  name: string;
  type: DataType;
  value: boolean | number | string;
  unit?: string;
  selected: boolean;
}

export type UpdateRate = 100 | 250 | 500 | 1000 | 2000 | 5000;

export type ThemeMode = 'light' | 'dark' | 'auto';

export type Language = 'es' | 'en';

export interface AppConfig {
  updateRate: UpdateRate;
  theme: ThemeMode;
  language: Language;
}

export const UPDATE_RATE_OPTIONS: {label: string;value: UpdateRate;}[] = [
{ label: '100 ms', value: 100 },
{ label: '250 ms', value: 250 },
{ label: '500 ms', value: 500 },
{ label: '1 segundo', value: 1000 },
{ label: '2 segundos', value: 2000 },
{ label: '5 segundos', value: 5000 }];