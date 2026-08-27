// =========================================================================
// recetasApi.ts
// Las recetas, traducidas entre la base de datos y la vista.
//
// LOS TRES NIVELES DE TIA, EN CUATRO TABLAS
//
//   Recipes       recetas             el contenedor
//     └ Elements       receta_elementos    las COLUMNAS (los ingredientes)
//     └ Data records   receta_registros    las FILAS (cada fórmula)
//                      receta_valores      el valor de cada celda
//
// La cuarta tabla es la que sorprende. TIA enseña los data records como una
// rejilla ancha —una columna por elemento— pero guardarlo así obligaría a un
// `ALTER TABLE` cada vez que alguien añade un ingrediente. `receta_valores`
// es ESTRECHA: una fila por (registro, elemento). La rejilla se reconstruye
// al leer, y eso es exactamente lo que hace `cargarDetalle()` aquí abajo.
//
// POR QUÉ EXISTE ESTE ARCHIVO Y NO SE LLAMA AL CRUD DIRECTAMENTE
//
//   Las columnas de la base están en español y son las de TIA traducidas
//   (`informacion_herramienta`, `tipo_comunicacion`); la vista usa el
//   vocabulario de TIA en inglés, que es el que aparece en su manual y el que
//   reconoce quien viene de un panel Siemens. Traducir en un solo sitio evita
//   que cada celda de la tabla tenga que saber cómo se llama su columna.
//
//   Y hay dos conversiones que no son cosméticas:
//     * celda vacía -> `null`, nunca `''` (el backend valida por tipo y
//       `float('')` falla);
//     * un valor de celda va a `valor_num` si es un número y a `valor_texto`
//       si no lo es, que es lo que permite que un elemento sea REAL y otro
//       STRING sin una columna por tipo.
// =========================================================================
import {
  crearCrud,
  listarCrud,
  numeroONulo,
  textoDeNumero,
  type FilaCrud,
} from './crudApi';

// ─── Vocabulario de TIA ──────────────────────────────────────────

/** `Limited` reserva memoria fija; `Unlimited` crece según haya espacio. */
export const RECIPE_TYPES = ['Limited', 'Unlimited'] as const;
export type RecipeType = (typeof RECIPE_TYPES)[number];

/**
 * Cómo viajan los valores al PLC.
 *
 *   Tags   un tag por elemento, N escrituras sueltas. Hay un instante en que
 *          el PLC tiene el primer valor nuevo y el último viejo.
 *   Array  todos los elementos en un único tag de tipo array, en UNA sola
 *          escritura. Llegan juntos o no llega ninguno.
 */
export const COMM_TYPES = ['Tags', 'Array'] as const;
export type CommType = (typeof COMM_TYPES)[number];

/** `''` = sin definir, que es como lo deja TIA mientras no haya tag. */
export const DATA_TYPES = [
  '',
  'Bool',
  'Byte',
  'Int',
  'UInt',
  'DInt',
  'UDInt',
  'Real',
  'LReal',
  'String',
] as const;
export type ElementDataType = (typeof DATA_TYPES)[number];

/**
 * Bytes que ocupa cada tipo. Es lo que TIA muestra en "Data length": no se
 * escribe a mano, sale del tipo. Se guarda igualmente en `longitud_dato`
 * porque quien lea la base por su cuenta necesita ese dato para armar el
 * bloque que se manda al PLC.
 */
export const LARGO_TIPO: Record<string, number> = {
  '': 0,
  Bool: 1,
  Byte: 1,
  Int: 2,
  UInt: 2,
  DInt: 4,
  UDInt: 4,
  Real: 4,
  LReal: 8,
  String: 254,
};

// ─── El modelo que pinta la vista ────────────────────────────────
//
// Los `id` son los de la base de datos, no inventados en el navegador: son la
// única forma de volver a apuntar a la misma fila en la siguiente petición.

export interface RecipeElement {
  id: number;
  name: string;
  displayName: string;
  /** Tag del PLC. `''` se muestra como `<None>` y bloquea la columna. */
  tag: string;
  dataType: ElementDataType;
  defaultValue: string;
  minValue: string;
  maxValue: string;
  decimals: string;
  tooltip: string;
  unit: string;
}

export interface RecipeDataRecord {
  id: number;
  name: string;
  displayName: string;
  number: number;
  /**
   * `String(elementId)` -> valor escrito. Se indexa por id, no por nombre:
   * renombrar un elemento no pierde los valores ya cargados.
   *
   * Un elemento AUSENTE de este mapa no es lo mismo que uno con valor vacío:
   * significa que ese registro nunca le dio valor, y la celda enseña el
   * `defaultValue` del elemento como marcador de posición. Es también lo que
   * evita crear filas en `receta_valores` que nadie ha llenado.
   */
  values: Record<string, string>;
  comment: string;
}

export interface Recipe {
  id: number;
  name: string;
  displayName: string;
  number: number;
  /** Marca de la última modificación (`actualizado_en`), en ISO. */
  version: string;
  path: string;
  type: RecipeType;
  maxRecords: string;
  commType: CommType;
  checkLimits: boolean;
  tooltip: string;
  elements: RecipeElement[];
  records: RecipeDataRecord[];
  /** ¿Ya se bajaron sus elementos y registros? Se cargan al seleccionarla. */
  cargada: boolean;
}

/** `receta_valores.id` de cada celda, para poder actualizarla sin recrearla. */
export type MapaValores = Map<string, number>;

export const claveValor = (registroId: number, elementoId: number): string =>
  `${registroId}:${elementoId}`;

// ─── Base de datos -> vista ──────────────────────────────────────

const txt = (v: any): string => (v === null || v === undefined ? '' : String(v));

export function aRecipe(f: FilaCrud): Recipe {
  return {
    id: Number(f.id),
    name: txt(f.nombre),
    displayName: txt(f.nombre_visible),
    number: Number(f.numero ?? 0),
    // La columna `version` de la base guarda la versión de TIA (un texto como
    // "1.0"); lo que la vista llama Version es la fecha del último cambio,
    // que es lo que TIA muestra en esa columna. Por eso sale de
    // `actualizado_en` y no de `version`.
    version: txt(f.actualizado_en || f.creado_en),
    path: txt(f.ruta),
    type: f.tipo === 'Unlimited' ? 'Unlimited' : 'Limited',
    maxRecords: textoDeNumero(f.max_registros),
    commType: f.tipo_comunicacion === 'Array' ? 'Array' : 'Tags',
    checkLimits: Number(f.comprobar_limites ?? 1) !== 0,
    tooltip: txt(f.informacion_herramienta),
    elements: [],
    records: [],
    cargada: false,
  };
}

export function aElemento(f: FilaCrud): RecipeElement {
  const tipo = txt(f.tipo_dato);
  return {
    id: Number(f.id),
    name: txt(f.nombre),
    displayName: txt(f.nombre_visible),
    tag: txt(f.tag),
    dataType: ((DATA_TYPES as readonly string[]).includes(tipo)
      ? tipo
      : '') as ElementDataType,
    defaultValue: textoDeNumero(f.valor_default),
    minValue: textoDeNumero(f.valor_minimo),
    maxValue: textoDeNumero(f.valor_maximo),
    decimals: String(Number(f.decimales ?? 0)),
    tooltip: txt(f.informacion_herramienta),
    unit: txt(f.unidad),
  };
}

export function aRegistro(f: FilaCrud): RecipeDataRecord {
  return {
    id: Number(f.id),
    name: txt(f.nombre),
    displayName: txt(f.nombre_visible),
    number: Number(f.numero ?? 0),
    values: {},
    comment: txt(f.comentario),
  };
}

/** Una celda: prima el texto si lo hay; si no, el número formateado. */
export function aValorCelda(f: FilaCrud): string {
  const t = f.valor_texto;
  if (t !== null && t !== undefined && String(t) !== '') return String(t);
  return textoDeNumero(f.valor_num);
}

// ─── Vista -> base de datos ──────────────────────────────────────

export function patchRecetaADb(p: Partial<Recipe>): FilaCrud {
  const d: FilaCrud = {};
  if (p.name !== undefined) d.nombre = p.name;
  if (p.displayName !== undefined) d.nombre_visible = p.displayName;
  if (p.number !== undefined) d.numero = p.number;
  if (p.path !== undefined) d.ruta = p.path;
  if (p.type !== undefined) d.tipo = p.type;
  // `max_registros` es NOT NULL: una celda vacía no puede viajar como null.
  if (p.maxRecords !== undefined) d.max_registros = numeroONulo(p.maxRecords) ?? 0;
  if (p.commType !== undefined) d.tipo_comunicacion = p.commType;
  if (p.checkLimits !== undefined) d.comprobar_limites = p.checkLimits ? 1 : 0;
  if (p.tooltip !== undefined) d.informacion_herramienta = p.tooltip;
  return d;
}

export function patchElementoADb(p: Partial<RecipeElement>): FilaCrud {
  const d: FilaCrud = {};
  if (p.name !== undefined) d.nombre = p.name;
  if (p.displayName !== undefined) d.nombre_visible = p.displayName;
  if (p.tag !== undefined) d.tag = p.tag;
  if (p.dataType !== undefined) {
    d.tipo_dato = p.dataType;
    // Deriva del tipo, igual que la columna "Data length" de la vista.
    d.longitud_dato = LARGO_TIPO[p.dataType] ?? 0;
  }
  if (p.defaultValue !== undefined) d.valor_default = numeroONulo(p.defaultValue);
  if (p.minValue !== undefined) d.valor_minimo = numeroONulo(p.minValue);
  if (p.maxValue !== undefined) d.valor_maximo = numeroONulo(p.maxValue);
  if (p.decimals !== undefined) {
    const n = numeroONulo(p.decimals);
    d.decimales = n === null ? 0 : Math.trunc(n);
    d.lugar_decimal = d.decimales;
  }
  if (p.tooltip !== undefined) d.informacion_herramienta = p.tooltip;
  if (p.unit !== undefined) d.unidad = p.unit;
  return d;
}

export function patchRegistroADb(p: Partial<RecipeDataRecord>): FilaCrud {
  const d: FilaCrud = {};
  if (p.name !== undefined) d.nombre = p.name;
  if (p.displayName !== undefined) d.nombre_visible = p.displayName;
  if (p.number !== undefined) d.numero = p.number;
  if (p.comment !== undefined) d.comentario = p.comment;
  return d;
}

/**
 * Una celda, repartida entre las dos columnas.
 *
 * Numérico -> `valor_num`; cualquier otra cosa -> `valor_texto`. Nunca las
 * dos: si estuvieran las dos, la pregunta "¿cuál manda?" tendría que
 * responderla cada consumidor, y el que escribe en el PLC se equivocaría el
 * día que no coincidan.
 */
export function valorADb(texto: string): FilaCrud {
  const n = numeroONulo(texto);
  if (n !== null) return { valor_num: n, valor_texto: null };
  const t = (texto ?? '').trim();
  return { valor_num: null, valor_texto: t || null };
}

// ─── Lecturas compuestas ─────────────────────────────────────────

const TOPE = 500;

export async function cargarRecetas(dbId?: string): Promise<Recipe[]> {
  const { filas } = await listarCrud(
    'recetas',
    { orden: 'numero', descendente: false, limite: TOPE },
    dbId
  );
  return filas.map(aRecipe);
}

/**
 * Elementos, registros y valores de UNA receta.
 *
 * Los valores se piden por registro porque `receta_valores` no tiene columna
 * `receta_id` —cuelga del registro y del elemento, no de la receta— y el CRUD
 * es de una sola tabla, sin joins. Van en paralelo: una receta con diez
 * registros son diez peticiones que tardan lo que la más lenta, no la suma.
 */
export async function cargarDetalle(
  recetaId: number,
  dbId?: string
): Promise<{
  elements: RecipeElement[];
  records: RecipeDataRecord[];
  valorIds: MapaValores;
}> {
  const [elementos, registros] = await Promise.all([
    listarCrud(
      'receta_elementos',
      {
        filtros: { receta_id: recetaId },
        orden: 'orden',
        descendente: false,
        limite: TOPE,
      },
      dbId
    ),
    listarCrud(
      'receta_registros',
      {
        filtros: { receta_id: recetaId },
        orden: 'numero',
        descendente: false,
        limite: TOPE,
      },
      dbId
    ),
  ]);

  const elements = elementos.filas.map(aElemento);
  const records = registros.filas.map(aRegistro);
  const valorIds: MapaValores = new Map();

  const lotes = await Promise.all(
    records.map((r) =>
      listarCrud(
        'receta_valores',
        { filtros: { receta_registro_id: r.id }, limite: TOPE },
        dbId
      ).then((x) => ({ registro: r, filas: x.filas }))
    )
  );

  for (const { registro, filas } of lotes) {
    for (const f of filas) {
      const elemId = Number(f.receta_elemento_id);
      registro.values[String(elemId)] = aValorCelda(f);
      valorIds.set(claveValor(registro.id, elemId), Number(f.id));
    }
  }

  return { elements, records, valorIds };
}

// ─── Altas con valores de partida ────────────────────────────────
//
// Lo que TIA pone en una fila recién creada. Va aquí y no en el componente
// para que crear una receta a mano y duplicarla den exactamente lo mismo.

export function nuevaRecetaDb(numero: number): FilaCrud {
  return {
    nombre: `Recipe_${numero}`,
    nombre_visible: `Recipe_${numero}`,
    numero,
    version: '1.0',
    ruta: '\\Flash\\Recipes',
    tipo: 'Limited',
    max_registros: 500,
    tipo_comunicacion: 'Tags',
    comprobar_limites: 1,
    informacion_herramienta: '',
    activo: 1,
  };
}

export function nuevoElementoDb(recetaId: number, orden: number): FilaCrud {
  return {
    receta_id: recetaId,
    nombre: `Recipe_element_${orden + 1}`,
    nombre_visible: `Recipe_element_${orden + 1}`,
    tag: '',
    tipo_dato: '',
    longitud_dato: 0,
    decimales: 0,
    lugar_decimal: 0,
    orden,
    activo: 1,
  };
}

export function nuevoRegistroDb(recetaId: number, numero: number): FilaCrud {
  return {
    receta_id: recetaId,
    nombre: `Recipe_data_record_${numero}`,
    nombre_visible: `Recipe_data_record_${numero}`,
    numero,
    comentario: '',
    activo: 1,
  };
}

/** Crea la celda (registro, elemento) con su valor. Devuelve su id. */
export async function crearValor(
  registroId: number,
  elementoId: number,
  texto: string,
  dbId?: string
): Promise<number> {
  const { id } = await crearCrud(
    'receta_valores',
    {
      receta_registro_id: registroId,
      receta_elemento_id: elementoId,
      ...valorADb(texto),
    },
    dbId
  );
  return id;
}

// ─── Dónde se guardan las recetas ────────────────────────────────
//
// La base de esta pantalla, recordada en ESTE navegador. Es una preferencia
// local, no configuración compartida: en el PC de planta se trabaja contra la
// base local y en el de oficina contra la del servidor, y cada uno debe
// recordar la suya.
//
// Por defecto, la misma con la que se entró al sistema: es lo que espera
// cualquiera que no sepa que esto se puede cambiar.
const CLAVE_BASE_RECETAS = 'hmi.recetas.db';

export function getBaseRecetas(): string {
  try {
    return localStorage.getItem(CLAVE_BASE_RECETAS) ?? '';
  } catch {
    return '';
  }
}

export function setBaseRecetas(dbId: string): void {
  try {
    if (dbId) localStorage.setItem(CLAVE_BASE_RECETAS, dbId);
    else localStorage.removeItem(CLAVE_BASE_RECETAS);
  } catch {
    /* sin storage: se usará la del login en cada arranque */
  }
}
