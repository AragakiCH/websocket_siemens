// =========================================================================
// utils/enlaces.ts
// Las variables CON NOMBRE de un widget.
//
// EL LÍMITE QUE LEVANTA
// Hasta ahora un widget veía UNA variable: `widget.variableId`. Con una sola
// no se puede pintar un equipo de verdad. Una bomba tiene marcha, fallo,
// modo manual y velocidad, y lo que el operario necesita ver de un vistazo es
// justo la COMBINACIÓN: verde si marcha, roja si fallo, parpadeando si está
// en manual, girando según la velocidad.
//
// Aquí cada variable extra tiene un nombre —`fallo`, `velocidad`— y el widget
// (o, más adelante, una dinámica) la pide por él.
//
// LA PRINCIPAL SE QUEDA DONDE ESTABA
// `variableId` no se toca. Sigue siendo la variable del widget, la que se
// pinta y la que decide `on`, `frac` y la etiqueta. Estos enlaces son
// ADICIONALES. Esa decisión es la que hace que no haya migración: un diseño
// guardado no trae `enlaces`, se lee como vacío y se comporta exactamente
// igual que antes. Convertir `variableId` en el primer elemento de una lista
// habría sido más bonito y habría obligado a tocar los 19 widgets de fábrica,
// el Inspector, el guardado, los faceplates y todos los proyectos guardados,
// a cambio de nada que el usuario note.
//
// VALEN LOS PARÁMETROS DE UN FACEPLATE
// Un enlace puede guardar `param:motor` igual que `variableId`. No hay nada
// especial que hacer: quien resuelve es el `resolver` que se le pasa, que es
// el mismo que ya traduce la variable principal dentro de una instancia.
// =========================================================================
import type { HmiWidget } from '../models/widget';
import type { DataType, PlcVariable } from '../models/plc';

/** `{ fallo: 'plc1|DB.fault', velocidad: 'param:rpm' }`. */
export type Enlaces = Record<string, string>;

/**
 * Una variable extra que un TIPO de widget sabe usar.
 *
 * La declara el widget, no el usuario: un medidor de bomba sabe que quiere un
 * `fallo` booleano, y el Inspector puede pedirlo con su nombre de verdad y
 * ofrecer solo variables del tipo que encaja.
 *
 * Los widgets que no declaran ninguna siguen funcionando igual; el usuario
 * puede añadir enlaces sueltos por su cuenta, que es lo que hará falta para
 * las dinámicas (un rectángulo que cambia de color no «declara» nada).
 */
export interface DeclaracionEnlace {
  id: string;
  label: string;
  /** Tipos admitidos. Ausente = cualquiera. */
  accepts?: DataType[];
  ayuda?: string;
}

/**
 * Un nombre de enlace válido.
 *
 * La misma regla que los parámetros de faceplate, y por el mismo motivo: son
 * llaves de un objeto que viaja en JSON y que algún día se escribirá en una
 * expresión (`fallo && !manual`). Un nombre con espacios, acentos o puntos
 * obligaría a citarlo en todas partes.
 */
export const RE_NOMBRE_ENLACE = /^[a-zA-Z][a-zA-Z0-9_]{0,39}$/;

/**
 * Comprueba un nombre. Devuelve el motivo del rechazo, o `''` si vale.
 *
 * Devuelve el texto y no un booleano a propósito: quien lo llama es un
 * formulario, y «no vale» sin decir por qué obliga al usuario a adivinar.
 */
export function validarNombreEnlace(
  nombre: string,
  yaUsados: string[] = []
): string {
  const n = nombre.trim();
  if (!n) return 'Ponle un nombre.';
  if (!RE_NOMBRE_ENLACE.test(n)) {
    return 'Empieza por una letra y usa solo letras, números o guion bajo.';
  }
  if (yaUsados.includes(n)) return `Ya hay una variable llamada «${n}».`;
  return '';
}

/**
 * Los enlaces del widget, saneados.
 *
 * Se filtra lo que no sea texto→texto y los nombres inválidos: esto viene de
 * un fichero de proyecto que se puede haber editado a mano o importado de
 * otra instalación, y un nombre raro reventaría más adelante, lejos de aquí.
 */
export function leerEnlaces(widget: HmiWidget | null | undefined): Enlaces {
  const bruto = (widget as any)?.enlaces;
  const r: Enlaces = {};
  if (bruto && typeof bruto === 'object' && !Array.isArray(bruto)) {
    for (const [k, v] of Object.entries(bruto)) {
      if (typeof v === 'string' && RE_NOMBRE_ENLACE.test(k)) r[k] = v;
    }
  }
  return r;
}

/**
 * De los nombres a las variables de verdad.
 *
 * `resolver` es el mismo que traduce la variable principal en cada sitio: en
 * la Vista Previa busca por id; dentro de un faceplate, además, cambia
 * `param:x` por el tag de esa instancia. Pasándolo en vez de importarlo, este
 * módulo no tiene que saber nada de faceplates ni de dónde salen los valores.
 *
 * Un enlace sin asignar, o que apunta a una variable que ya no está, queda en
 * `undefined`. NO se omite la clave: el widget puede así distinguir «este
 * enlace existe pero no lee nada» de «este enlace no existe», que es la
 * diferencia entre avisar de un hueco y no pintar nada.
 */
export function resolverEnlaces(
  widget: HmiWidget | null | undefined,
  resolver: (variableId: string | null | undefined) => PlcVariable | undefined
): Record<string, PlcVariable | undefined> {
  const enlaces = leerEnlaces(widget);
  const r: Record<string, PlcVariable | undefined> = {};
  for (const [nombre, id] of Object.entries(enlaces)) {
    r[nombre] = id ? resolver(id) : undefined;
  }
  return r;
}

/** Los enlaces del widget con uno puesto o cambiado. */
export function conEnlace(
  widget: HmiWidget,
  nombre: string,
  variableId: string
): Enlaces {
  return { ...leerEnlaces(widget), [nombre]: variableId };
}

/** Los enlaces del widget sin ese. */
export function sinEnlace(widget: HmiWidget, nombre: string): Enlaces {
  const { [nombre]: _, ...resto } = leerEnlaces(widget);
  return resto;
}

/**
 * Cambia el nombre de un enlace conservando su sitio.
 *
 * El orden importa porque es el que ve el usuario en el Inspector, y en
 * JavaScript el orden de las claves de un objeto es el de inserción: sin
 * reconstruirlo, renombrar mandaría la fila al final de la lista de golpe.
 */
export function renombrarEnlace(
  widget: HmiWidget,
  viejo: string,
  nuevo: string
): Enlaces {
  const actuales = leerEnlaces(widget);
  const r: Enlaces = {};
  for (const [k, v] of Object.entries(actuales)) {
    r[k === viejo ? nuevo : k] = v;
  }
  return r;
}

/** Un nombre que no choque: `var1`, `var2`… */
export function nombreLibre(enlaces: Enlaces, base = 'var'): string {
  for (let i = 1; i < 200; i++) {
    const n = `${base}${i}`;
    if (!(n in enlaces)) return n;
  }
  return `${base}${Date.now()}`;
}
