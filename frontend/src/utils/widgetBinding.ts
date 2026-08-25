// =========================================================================
// widgetBinding.ts
// Compatibilidad entre un widget y la variable del PLC que se le enlaza.
//
// EL PROBLEMA QUE RESUELVE
// Antes cualquier widget aceptaba cualquier variable. Nada impedía enlazar
// un BOOL a una gráfica, que solo dibujaría una línea saltando entre 0 y 1.
//
// LA DECLARACIÓN
// Cada widget declara qué tipos acepta, en uno de dos sitios según su origen:
//
//   * built-in y custom TSX -> campo `accepts` en widgetCatalog.ts
//   * subidos por ZIP       -> campo `accepts` en su widget.json
//
// Los dos terminan en la misma función `aceptaTipo()`, para que la gráfica
// built-in y una gráfica subida por ZIP se comporten igual.
//
// POR QUÉ SE DECLARA Y NO SE DEDUCE
// Un widget ZIP es HTML + CSS + JS. Para "deducir" que espera números habría
// que leer su JavaScript y adivinar qué hace con WIDGET.value. El único que
// lo sabe de verdad es quien escribió el widget.
//
// LO QUE ESTO *NO* RESUELVE
// El RANGO. Que `rSensor` sea `double` no dice que va de 4 a 20 mA. El tipo
// evita enlaces absurdos; el rango hace que los enlaces correctos se dibujen
// bien. Eso vive en la variable, no acá (ver `valueFraction` en format.ts).
// =========================================================================
import { DataType, PlcVariable } from '../models/plc';

/** Los cuatro tipos que maneja el frontend (ver `mapOpcType` en plcAdapter). */
export const TIPOS_VALIDOS: readonly DataType[] = ['bool', 'int', 'double', 'string'];

// Atajos para no repetir arreglos por todo el catálogo.
/** Cualquier magnitud: REAL/LREAL -> double, INT/UINT/DINT -> int. */
export const NUMERICOS: DataType[] = ['int', 'double'];
/** Encendido/apagado. */
export const BOOLEANO: DataType[] = ['bool'];
/** Se puede mostrar cualquier cosa (un texto lo imprime tal cual). */
export const CUALQUIERA: DataType[] = ['bool', 'int', 'double', 'string'];
/** Decorativo: no lee ninguna variable. */
export const NINGUNO: DataType[] = [];

/** Nombre legible de un tipo, para los mensajes. */
const NOMBRE_TIPO: Record<DataType, string> = {
  bool: 'sí/no',
  int: 'número entero',
  double: 'número decimal',
  string: 'texto',
};

export function nombreTipo(t: DataType): string {
  return NOMBRE_TIPO[t] ?? t;
}

/** ¿Es uno de los cuatro tipos conocidos? Se usa al validar el widget.json. */
export function esTipoValido(x: unknown): x is DataType {
  return typeof x === 'string' && (TIPOS_VALIDOS as readonly string[]).includes(x);
}

/**
 * ¿El widget lee alguna variable?
 *
 *   undefined -> sin declarar (widget viejo): se asume que sí, acepta todo.
 *   []        -> declarado como decorativo: no usa variables.
 */
export function usaVariable(accepts: DataType[] | undefined): boolean {
  return accepts === undefined || accepts.length > 0;
}

/**
 * ¿Esta variable calza con lo que el widget declara?
 *
 * `undefined` devuelve `true` a propósito: los widgets ZIP subidos antes de
 * que existiera este campo no tienen `accepts`, y no se les puede romper el
 * enlace de forma retroactiva.
 */
export function aceptaTipo(
  accepts: DataType[] | undefined,
  tipo: DataType
): boolean {
  if (accepts === undefined) return true;
  return accepts.includes(tipo);
}

/** "número entero o decimal", "sí/no", … para las etiquetas de la interfaz. */
export function describirAceptados(accepts: DataType[] | undefined): string {
  if (accepts === undefined) return 'cualquier tipo (sin declarar)';
  if (accepts.length === 0) return 'ninguna variable';
  if (accepts.length === TIPOS_VALIDOS.length) return 'cualquier tipo';

  // Caso frecuente: los dos numéricos juntos se leen mejor como uno solo.
  if (accepts.length === 2 && accepts.includes('int') && accepts.includes('double')) {
    return 'valores numéricos';
  }
  const nombres = accepts.map(nombreTipo);
  if (nombres.length === 1) return nombres[0];
  return `${nombres.slice(0, -1).join(', ')} o ${nombres[nombres.length - 1]}`;
}

/**
 * Aviso para el Inspector cuando el enlace elegido no calza. Devuelve `null`
 * si todo está bien.
 *
 * No bloquea nada: `mapOpcType()` deduce el tipo a partir del nombre que
 * reporta el OPC UA, y ante un nombre raro cae en 'string' por descarte. Si
 * eso bloqueara el enlace, el usuario se quedaría sin poder usar su propia
 * variable y sin entender por qué. Se avisa y se deja decidir.
 */
export function avisoIncompatible(
  accepts: DataType[] | undefined,
  variable: PlcVariable | undefined
): string | null {
  if (!variable) return null;
  if (aceptaTipo(accepts, variable.type)) return null;

  if (accepts && accepts.length === 0) {
    return (
      `Este widget es decorativo y no usa el valor de ninguna variable. ` +
      `Enlazar «${variable.name}» no va a cambiar nada de lo que se ve.`
    );
  }

  const base =
    `«${variable.name}» es ${nombreTipo(variable.type)} y este widget ` +
    `espera ${describirAceptados(accepts)}.`;

  // Pista concreta según en qué consiste el desajuste. Es más útil que
  // repetir "son incompatibles".
  const esperaNumero =
    !!accepts && accepts.some((a) => a === 'int' || a === 'double');
  const esperaBool = !!accepts && accepts.includes('bool');

  let pista = '';
  if (esperaNumero && variable.type === 'bool') {
    pista =
      ' Un sí/no solo vale 0 o 1, así que el widget se va a quedar pegado ' +
      'entre esos dos extremos.';
  } else if (esperaNumero && variable.type === 'string') {
    pista = ' Un texto no se puede dibujar como magnitud: se verá en cero.';
  } else if (esperaBool && (variable.type === 'int' || variable.type === 'double')) {
    pista = ' Se va a interpretar como encendido cuando el valor sea mayor que 0.';
  } else if (esperaBool && variable.type === 'string') {
    pista = ' Un texto no se puede interpretar como encendido/apagado.';
  }

  return `${base}${pista} Puedes usarla igual, pero probablemente no se vea como esperas.`;
}

/**
 * Reparte las variables en las que calzan y las que no, conservando el orden
 * original dentro de cada grupo. Es lo que alimenta los dos `<optgroup>` del
 * Inspector.
 */
export function repartirPorCompatibilidad(
  variables: PlcVariable[],
  accepts: DataType[] | undefined
): { compatibles: PlcVariable[]; otras: PlcVariable[] } {
  const compatibles: PlcVariable[] = [];
  const otras: PlcVariable[] = [];
  for (const v of variables) {
    (aceptaTipo(accepts, v.type) ? compatibles : otras).push(v);
  }
  return { compatibles, otras };
}
