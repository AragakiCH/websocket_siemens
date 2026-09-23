// Domain models for the PLC layer.

export type DataType = 'bool' | 'int' | 'double' | 'string';

/**
 * Marca del PLC. Determina qué driver usa el backend:
 *  - 'siemens': S7-1500 por OPC UA anónimo, tags bajo DataBlocksGlobal.
 *  - 'rexroth': ctrlX CORE, requiere usuario/contraseña y elegir el programa
 *               dentro de Datalayer/plc/app/<app>/sym/<programa>.
 */
export type PlcVendor = 'siemens' | 'rexroth';

/**
 * Un PLC tal como lo describe el backend.
 *
 * DE DÓNDE SALE, Y POR QUÉ NO ESTABA
 * El snapshot del WebSocket trae DOS cosas: `tags` (el valor de cada
 * variable) y `plcs` (quién es cada autómata). `RealPLCService` se quedaba
 * solo con la primera y tiraba la segunda, así que el navegador recibía la
 * marca de cada PLC en cada snapshot y la descartaba sin usarla.
 *
 * Eso dejaba las listas de variables diciendo `PLC_PRG.rVar1` a secas: el
 * `plc_id` estaba dentro del id (`"192.168.1.4|PLC_PRG.rVar1"`) pero la MARCA
 * no estaba en ninguna parte del cliente. Y con un Siemens y un ctrlX
 * conectados a la vez, saber cuál es cuál no es un adorno: los tipos de dato,
 * la forma de los nombres y lo que se puede escribir cambian entre los dos.
 *
 * Los mismos campos los sirven `GET /plcs` y `GET /health`, para las vistas
 * que no están escuchando el WebSocket.
 */
export interface InfoPlc {
  /** El `plc_id`: la primera mitad de `"<plc>|<tag>"`. Suele ser la IP. */
  id: string;
  /** Etiqueta del autómata, si la publica. Puede venir vacía. */
  nombre: string;
  vendor: PlcVendor;
  endpoint: string;
  /** conectado | conectando | reconectando | desconectado */
  estado: string;
  conectado: boolean;
  /** Las variables internas del HMI, que se hacen pasar por un PLC. */
  interno: boolean;
}

/**
 * Cómo se escribe una marca en la interfaz.
 *
 * Un `switch` y no un diccionario para que TypeScript avise si algún día se
 * añade una marca al tipo `PlcVendor` y se olvida aquí. Una marca que no se
 * reconozca se enseña tal cual en vez de desaparecer: es más útil ver
 * «omron» que no ver nada.
 */
export function etiquetaVendor(vendor: string): string {
  switch (vendor) {
    case 'siemens':
      return 'Siemens';
    case 'rexroth':
      return 'Rexroth';
    default:
      return vendor || '';
  }
}

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