// =========================================================================
// plcAdapter.ts
// Traduce los datos que manda el backend (OPC UA -> WebSocket) al modelo
// PlcVariable que consumen las vistas. Es el "traductor" entre ambos mundos.
//
// Backend (cada tag):  { plc, tag, value, type, timestamp, source_ts, ... }
//   - la CLAVE del objeto tags es  "<plc>|<tag>"  (ej. "PLC_2|DB_snap7.temp")
//   - `type` es el tipo de dato OPC UA legible: "Boolean" | "Float" |
//     "Double" | "Int16" | "Int32" | "Byte" | "UInt16" | "String" | ...
//
// Frontend (PlcVariable): { id, name, type: bool|int|double|string, value,
//                           unit?, selected }
// =========================================================================
import { PlcVariable, DataType } from '../models/plc';

/** Mapea el nombre de tipo OPC UA (Siemens) al DataType del frontend. */
export function mapOpcType(t: string | undefined): DataType {
  const s = (t ?? '').toLowerCase();
  if (s.includes('bool')) return 'bool';
  // Real -> Float, LReal -> Double, y cualquier cosa con "real"/"float"/"double"
  if (s.includes('float') || s.includes('double') || s.includes('real')) {
    return 'double';
  }
  // Int16/Int32/UInt16/DInt/SInt/Byte/Word/DWord -> entero
  if (
    s.includes('int') ||
    s.includes('byte') ||
    s.includes('word') ||
    s.includes('sint')
  ) {
    return 'int';
  }
  return 'string';
}

/**
 * Heurística MUY simple para adivinar la unidad a partir del nombre del tag.
 * El OPC UA no transmite unidades, así que esto es solo cosmético. Si no
 * calza nada, devuelve undefined y la vista no muestra unidad.
 * Puedes ampliar/quitar reglas a gusto.
 */
export function inferUnit(name: string): string | undefined {
  const n = name.toLowerCase();
  if (n.includes('temp')) return '°C';
  if (n.includes('pres')) return 'bar';
  if (n.includes('nivel') || n.includes('level')) return '%';
  if (n.includes('caudal') || n.includes('flow')) return 'l/min';
  if (n.includes('rpm') || n.includes('velocidad') || n.includes('speed')) return 'RPM';
  if (n.includes('voltaje') || n.includes('voltage') || n.includes('tension')) return 'V';
  if (n.includes('corriente') || n.includes('current')) return 'A';
  if (n.includes('energia') || n.includes('energy') || n.includes('kwh')) return 'kWh';
  return undefined;
}

/**
 * Convierte el objeto `tags` del WebSocket a un arreglo de PlcVariable.
 * @param tags    { "PLC_2|DB_snap7.temp": { plc, tag, value, type, ... }, ... }
 * @param prevSel Set con los ids que el usuario tiene "seleccionados" (persistido).
 *                Un tag nuevo que NO esté en el set se marca como seleccionado
 *                por defecto (para que aparezca de una en el Designer).
 */
export function toPlcVariables(
  tags: Record<string, any>,
  selection: Map<string, boolean>
): PlcVariable[] {
  return Object.entries(tags).map(([key, t]) => {
    const name: string = t.tag ?? key;
    // selected: si el usuario ya decidió algo, se respeta; si es un tag nuevo,
    // por defecto TRUE (visible). Cambia a `false` si prefieres lo contrario.
    const selected = selection.has(key) ? (selection.get(key) as boolean) : true;
    return {
      id: key,
      name,
      type: mapOpcType(t.type),
      value: t.value,
      unit: inferUnit(name),
      selected,
    };
  });
}
