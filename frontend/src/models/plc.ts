// Domain models for the PLC layer.

export type DataType = 'bool' | 'int' | 'double' | 'string';

/**
 * Marca del PLC. Determina qué driver usa el backend:
 *  - 'siemens': S7-1500 por OPC UA anónimo, tags bajo DataBlocksGlobal.
 *  - 'rexroth': ctrlX CORE por el Data Layer (HTTPS), requiere
 *               usuario/contraseña y elegir el programa.
 *  - 'allenbradley': Logix (ControlLogix/CompactLogix/Micro800) por
 *               EtherNet/IP. Sin credenciales: solo IP y slot del procesador.
 */
export type PlcVendor = 'siemens' | 'rexroth' | 'allenbradley';

/** Etiqueta legible de cada marca, para listas y cabeceras. */
export const VENDOR_LABEL: Record<string, string> = {
  siemens: 'Siemens S7',
  rexroth: 'Bosch Rexroth ctrlX',
  allenbradley: 'Allen-Bradley Logix',
};

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
  // Solo Allen-Bradley: slot del procesador en el chasis (0 en CompactLogix).
  slot?: number;
}

export interface PlcVariable {
  id: string;
  name: string;
  type: DataType;
  /**
   * Escalar en el caso normal. Un `Array[1..n] of X` del PLC llega como
   * lista (con `type` = el del elemento) y un UDT decodificado como objeto.
   */
  value: boolean | number | string | unknown[] | Record<string, unknown>;
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