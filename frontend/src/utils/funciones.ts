// =========================================================================
// funciones.ts
// «Modo función» de los widgets ZIP: el valor de una salida (la variable
// principal o una variable con nombre) se calculará con una expresión que
// lee unos tags de entrada.
//
// QUÉ HAY Y QUÉ NO
//
//   Por ahora solo se CONFIGURA y se guarda con el diseño: tags de entrada,
//   variables internas y el texto de la expresión. Todavía no se evalúa: el
//   widget sigue leyendo su variable de siempre. El cálculo en vivo es la
//   siguiente fase, y por eso esto ya guarda todo lo que hará falta.
//
// UNA FUNCIÓN POR SALIDA
//
//   Cada salida (varPrincipal, var1, var2…) tiene la suya, independiente.
//   La llave es el nombre de la variable con nombre; la principal usa
//   `SALIDA_PRINCIPAL`, que lleva «@» para que nunca choque con un nombre
//   de enlace (esos solo admiten letras, números y guion bajo).
//
//   Vive en el diseño del widget (`widget.funciones`). No toca SQL.
// =========================================================================
import type { HmiWidget } from '../models/widget';

export const SALIDA_PRINCIPAL = '@principal';
/** Cómo se llama la variable principal dentro de la expresión. */
export const NOMBRE_PRINCIPAL = 'varPrincipal';

export type TipoInterna = 'bool' | 'entero' | 'decimal' | 'texto';

export const TIPOS_INTERNA: { valor: TipoInterna; label: string }[] = [
  { valor: 'bool', label: 'Sí / no' },
  { valor: 'entero', label: 'Entero' },
  { valor: 'decimal', label: 'Decimal' },
  { valor: 'texto', label: 'Texto' },
];

export interface EntradaFuncion {
  /** Cómo se llama dentro de la expresión. */
  nombre: string;
  /** El tag que lee (mismo formato que `variableId`). Vacío = sin asignar. */
  variableId: string;
}

export interface InternaFuncion {
  nombre: string;
  tipo: TipoInterna;
}

export interface FuncionSalida {
  entradas: EntradaFuncion[];
  internas: InternaFuncion[];
  expresion: string;
}

export interface ConfigFunciones {
  /** El switch «Modo función» del Inspector. */
  activo: boolean;
  /** Llave = salida (`SALIDA_PRINCIPAL` o el nombre de la variable con nombre). */
  porSalida: Record<string, FuncionSalida>;
}

export const funcionVacia = (): FuncionSalida => ({ entradas: [], internas: [], expresion: '' });

const esTipo = (t: unknown): t is TipoInterna =>
  t === 'bool' || t === 'entero' || t === 'decimal' || t === 'texto';

const texto = (v: unknown): string => (typeof v === 'string' ? v : '');

/**
 * Lo que trae el widget, saneado. Viene de un fichero de proyecto que se
 * puede haber editado a mano: lo raro se descarta aquí y no revienta en el
 * modal.
 */
export function leerFunciones(widget: HmiWidget | null | undefined): ConfigFunciones {
  const crudo = (widget as { funciones?: unknown } | null | undefined)?.funciones as
    | { activo?: unknown; porSalida?: unknown }
    | undefined;
  const porSalida: Record<string, FuncionSalida> = {};
  const fuente =
    crudo && typeof crudo.porSalida === 'object' && crudo.porSalida
      ? (crudo.porSalida as Record<string, any>)
      : {};
  for (const [clave, f] of Object.entries(fuente)) {
    if (!f || typeof f !== 'object') continue;
    porSalida[clave] = {
      entradas: Array.isArray(f.entradas)
        ? f.entradas.map((e: any) => ({ nombre: texto(e?.nombre), variableId: texto(e?.variableId) }))
        : [],
      internas: Array.isArray(f.internas)
        ? f.internas.map((i: any) => ({
            nombre: texto(i?.nombre),
            tipo: esTipo(i?.tipo) ? i.tipo : 'bool',
          }))
        : [],
      expresion: texto(f.expresion),
    };
  }
  return { activo: crudo?.activo === true, porSalida };
}

/** ¿Hay algo configurado en esa función? (para pintar el botón ƒx) */
export function tieneContenido(f: FuncionSalida | undefined): boolean {
  return !!f && (f.entradas.length > 0 || f.internas.length > 0 || f.expresion.trim() !== '');
}

/** Se renombró una variable con nombre: su función la sigue. */
export function renombrarSalida(cfg: ConfigFunciones, viejo: string, nuevo: string): ConfigFunciones {
  if (!(viejo in cfg.porSalida) || viejo === nuevo) return cfg;
  const porSalida: Record<string, FuncionSalida> = {};
  for (const [k, v] of Object.entries(cfg.porSalida)) porSalida[k === viejo ? nuevo : k] = v;
  return { ...cfg, porSalida };
}

/** Se quitó una variable con nombre: su función se va con ella. */
export function quitarSalida(cfg: ConfigFunciones, clave: string): ConfigFunciones {
  if (!(clave in cfg.porSalida)) return cfg;
  const { [clave]: _fuera, ...resto } = cfg.porSalida;
  return { ...cfg, porSalida: resto };
}

const RE_NOMBRE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * El primer problema de una función, o `''` si está bien.
 *
 * Por ahora solo los nombres: que estén, que sean identificadores (la
 * expresión los va a usar tal cual) y que no se repitan, tampoco con el de
 * la propia salida. Validar la EXPRESIÓN («No existe la entrada…») llega con
 * el cálculo.
 */
export function errorDeFuncion(f: FuncionSalida, nombreSalida: string): string {
  const nombres = [...f.entradas.map((e) => e.nombre.trim()), ...f.internas.map((i) => i.nombre.trim())];
  if (nombres.some((n) => n === '')) return 'Cada nombre debe ser único y no estar vacío.';
  const malo = nombres.find((n) => !RE_NOMBRE.test(n));
  if (malo) return `«${malo}» no es un nombre válido: empieza por una letra y usa solo letras, números o guion bajo.`;
  const vistos = new Set<string>();
  for (const n of nombres) {
    if (vistos.has(n.toLowerCase())) return 'Cada nombre debe ser único y no estar vacío.';
    vistos.add(n.toLowerCase());
  }
  if (vistos.has(nombreSalida.toLowerCase())) {
    return `«${nombreSalida}» es el nombre de la salida: usa otro para la entrada o la variable.`;
  }
  return '';
}
