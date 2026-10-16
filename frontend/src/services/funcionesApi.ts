// =========================================================================
// funcionesApi.ts
// El «modo función» de los widgets, por HTTP: validar, probar y evaluar el
// código Python en el servidor (app/api/funciones_routes.py).
//
// POR QUÉ EL CÓDIGO SE EJECUTA EN EL SERVIDOR Y NO AQUÍ
//
//   Porque es Python. Meter un intérprete de Python en el navegador (Pyodide)
//   son 10 MB por pestaña y varios segundos de arranque en un panel de
//   planta. El servidor ya tiene Python, ya tiene los tags, y además es el
//   único sitio donde un `contador` puede contar UNA vez por evento aunque
//   diez visores miren el mismo widget: él recuerda las internas por widget
//   y solo ejecuta cuando cambian las entradas.
// =========================================================================
import { apiPost, apiDelete } from '../components/flows/api';
import type { InternaFuncion } from '../utils/funciones';

export interface Validacion {
  ok: boolean;
  vacio: boolean;
  /** Nombres que el código LEE (sin contar los que define él mismo). */
  leidos: string[];
  /** Nombres a los que el código asigna. */
  asignados: string[];
  /** Leídos que no son entrada, interna, builtin ni `math`: probables errores. */
  desconocidos: string[];
  /** ¿Deja valor en la salida (la asigna o termina en una expresión)? */
  asigna_salida: boolean;
  error: string;
  linea: number | null;
}

export interface ResultadoFuncion {
  exito: boolean;
  valor: unknown;
  /** Las internas DESPUÉS del código. */
  internas: Record<string, unknown>;
  impreso: string[];
  error: string;
  linea: number | null;
  ms: number;
  /** Solo en `evaluar`: se devolvió lo último sin ejecutar. */
  cacheado?: boolean;
}

export function validarFuncion(codigo: string, nombres: string[], salida: string) {
  return apiPost<Validacion>('/funciones/validar', { codigo, nombres, salida });
}

export function probarFuncion(
  codigo: string,
  salida: string,
  entradas: Record<string, unknown>,
  internas: (InternaFuncion & { valor?: unknown })[]
) {
  return apiPost<ResultadoFuncion & { ok: boolean }>('/funciones/probar', {
    codigo,
    salida,
    entradas,
    internas,
  });
}

export function evaluarFuncion(cuerpo: {
  widget_id: string;
  salida_clave: string;
  salida: string;
  codigo: string;
  entradas: Record<string, unknown>;
  internas: InternaFuncion[];
}) {
  return apiPost<ResultadoFuncion & { ok: boolean }>('/funciones/evaluar', cuerpo);
}

/** Las internas de ese widget vuelven a su valor inicial. */
export function olvidarEstadoFuncion(widgetId: string) {
  return apiDelete<{ ok: boolean; olvidadas: number }>(
    `/funciones/estado/${encodeURIComponent(widgetId)}`
  );
}

// ─── Detección de nombres en el propio editor ────────────────────
//
// Un tokenizado sencillo, SIN pedir nada al servidor: es lo que pinta al
// instante los chips de «esta entrada se usa / esta no». La validación de
// verdad (sintaxis, nombres desconocidos con rigor) la hace el servidor con
// `validarFuncion`, con retardo. Dos niveles a propósito: el primero es
// inmediato y aproximado; el segundo, lento y exacto.

const PALABRAS_PYTHON = new Set([
  'False', 'None', 'True', 'and', 'as', 'assert', 'async', 'await', 'break',
  'class', 'continue', 'def', 'del', 'elif', 'else', 'except', 'finally',
  'for', 'from', 'global', 'if', 'import', 'in', 'is', 'lambda', 'nonlocal',
  'not', 'or', 'pass', 'raise', 'return', 'try', 'while', 'with', 'yield',
]);

/**
 * Identificadores que aparecen en el código, fuera de cadenas y comentarios
 * y que no van detrás de un punto (`math.sqrt` cuenta `math`, no `sqrt`).
 */
export function identificadoresEn(codigo: string): Set<string> {
  const salida = new Set<string>();
  // Fuera cadenas (simples, dobles, triples) y comentarios.
  const limpio = codigo
    .replace(/'''[\s\S]*?'''|"""[\s\S]*?"""/g, ' ')
    .replace(/'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"/g, ' ')
    .replace(/#[^\n]*/g, ' ');
  const re = /(^|[^.\w])([A-Za-z_][A-Za-z0-9_]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(limpio)) !== null) {
    const id = m[2];
    if (!PALABRAS_PYTHON.has(id)) salida.add(id);
  }
  return salida;
}
