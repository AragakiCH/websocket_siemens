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
 * @param sinConexion Dice si un PLC está caído. Sus variables se conservan
 *                (siguen listadas y enlazadas a sus widgets) pero SIN valor:
 *                la vista pinta «—» en vez de un dato viejo que parezca
 *                actual.
 */
// La última `PlcVariable` entregada por cada id. Ver la nota de abajo.
const anteriores = new Map<string, PlcVariable>();

/** ¿Mismo valor? Los escalares por `===`; un array o un UDT, por contenido. */
function mismoValor(a: PlcVariable['value'], b: PlcVariable['value']): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

/**
 * De los tags crudos del WebSocket a `PlcVariable[]`.
 *
 * CON IDENTIDAD ESTABLE, y esto es lo que importa para el rendimiento: si
 * una variable no cambió (mismo valor, tipo, unidad y selección), se
 * devuelve EL MISMO OBJETO que la vez anterior. Antes se fabricaba un objeto
 * nuevo por variable en cada lectura, y como React y los `useMemo` comparan
 * por identidad, cada lectura de UN tag redibujaba TODOS los widgets de la
 * pantalla —y de las pantallas empotradas— aunque su valor fuera el mismo.
 * Con objetos estables, un widget cuya variable no cambió no hace nada.
 *
 * La lista sí es nueva cada vez (es lo que avisa a React de que hubo
 * lectura); lo que se conserva es cada elemento.
 */
export function toPlcVariables(
  tags: Record<string, any>,
  selection: Map<string, boolean>,
  sinConexion?: (plcId: string) => boolean
): PlcVariable[] {
  const vistos = new Set<string>();
  const salida = Object.entries(tags).map(([key, t]) => {
    vistos.add(key);
    const name: string = t.tag ?? key;
    // selected: si el usuario ya decidió algo, se respeta; si es un tag nuevo,
    // por defecto TRUE (visible). Cambia a `false` si prefieres lo contrario.
    const selected = selection.has(key) ? (selection.get(key) as boolean) : true;
    const type = mapOpcType(t.type);
    const value = sinConexion && sinConexion(String(t.plc ?? '')) ? null : t.value;
    const unit = inferUnit(name);

    const previa = anteriores.get(key);
    if (
      previa &&
      previa.name === name &&
      previa.type === type &&
      previa.unit === unit &&
      previa.selected === selected &&
      mismoValor(previa.value, value)
    ) {
      return previa;
    }
    const nueva: PlcVariable = { id: key, name, type, value, unit, selected };
    anteriores.set(key, nueva);
    return nueva;
  });
  // Un tag que desapareció (se quitó su PLC) no debe quedarse en memoria.
  if (anteriores.size > vistos.size) {
    for (const k of Array.from(anteriores.keys())) if (!vistos.has(k)) anteriores.delete(k);
  }
  return salida;
}
