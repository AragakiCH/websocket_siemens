// =========================================================================
// zipWidgetLoader.ts
// ===========================================================================
// Carga widgets personalizados desde archivos ZIP que contienen:
//   - un .json  (obligatorio) — metadatos del widget
//   - un .html  (obligatorio) — plantilla visual (HTML/SVG)
//   - un .css   (opcional)    — estilos del widget
//   - un .js    (opcional)    — lógica dinámica del widget
//
// LOS NOMBRES DE ARCHIVO SON LIBRES
// Lo que manda es la EXTENSIÓN, no el nombre: `manometro.html` vale igual que
// `widget.html`. Antes se exigían los cuatro nombres exactos, y un ZIP con
// `index.html` dentro se rechazaba sin que quedara claro por qué — cuando el
// widget era perfectamente válido.
//
// Da igual que estén en la raíz del ZIP o dentro de una carpeta (que es lo
// que pasa cuando se comprime una carpeta con el botón derecho en Windows).
//
// Si hubiera DOS archivos de la misma extensión, gana el que se llame
// `widget.<ext>`; y si no hay ninguno así, se rechaza el ZIP diciendo cuáles
// encontró. Elegir uno al azar sería peor: el widget cargaría con la mitad
// equivocada y el autor no tendría forma de saberlo.
//
// Los widgets cargados se persisten en localStorage y se integran
// automáticamente en el catálogo del Designer.
//
// El HTML recibe datos del PLC mediante CSS custom properties y
// placeholders de texto:
//   CSS vars:  --w-color, --w-bg, --w-on (0|1), --w-frac (0..1)
//   Text:      {{label}}, {{value}}, {{name}}
//
// El JS recibe un objeto global WIDGET con:
//   WIDGET.value  — valor crudo de la variable (bool, number, string)
//   WIDGET.on     — interpretación booleana (true/false)
//   WIDGET.frac   — valor normalizado 0..1
//   WIDGET.label  — valor formateado ("23.7 °C", "true", etc.)
//   WIDGET.name   — nombre del widget en el canvas
//   WIDGET.color  — color primario configurado
//   WIDGET.bg     — color de fondo configurado
//
// TIPOS DE DATO QUE ACEPTA EL WIDGET
// `widget.json` puede declarar `accepts`: qué tipos de variable sabe
// representar. Con eso el Inspector separa las variables compatibles de las
// que no lo son, en vez de ofrecerlas todas revueltas.
//
//   "accepts": ["double", "int"]   -> magnitudes (gráficas, medidores)
//   "accepts": ["bool"]            -> encendido/apagado
//   "accepts": []                  -> decorativo, no lee ninguna variable
//   (campo ausente)                -> sin declarar: acepta todo
//
// Los valores válidos son exactamente: bool, int, double, string. Son los
// del frontend, no los de tu PLC: `plcAdapter.mapOpcType()` convierte REAL y
// LREAL en "double", e INT/UINT/DINT en "int".
//
// Se declara y no se deduce porque para adivinarlo habría que leer el
// widget.js y suponer qué hace con WIDGET.value. Quien escribe el widget es
// el único que lo sabe de verdad.
// =========================================================================
import JSZip from 'jszip';
import { DataType } from '../models/plc';
import { TIPOS_VALIDOS, esTipoValido } from '../utils/widgetBinding';

const STORAGE_KEY = 'hmi.custom-html-widgets';

// ---- Tipos públicos --------------------------------------------------- //

export interface ZipWidgetMeta {
  /** Identificador único (se prefija con "custom:" automáticamente) */
  kind: string;
  /** Nombre visible en el sidebar */
  label: string;
  /** Categoría del sidebar */
  category: 'Básicos' | 'Indicadores' | 'Equipos' | 'Datos';
  /** Tamaño por defecto en píxeles */
  defaultWidth: number;
  defaultHeight: number;
  /**
   * Tipos de variable que el widget sabe representar.
   *
   * `undefined` = el widget.json no lo declaró. Se trata como "acepta todo"
   * para no romper los ZIP subidos antes de que este campo existiera.
   * `[]` = declarado explícitamente como decorativo.
   */
  accepts?: DataType[];
}

export interface ZipWidget {
  meta: ZipWidgetMeta;
  html: string;
  css: string;
  js: string;
}

// ---- Validación del widget.json --------------------------------------- //

const VALID_CATEGORIES = ['Básicos', 'Indicadores', 'Equipos', 'Datos'];

/**
 * Lee y valida `accepts`.
 *
 * Falla RUIDOSAMENTE ante un valor mal escrito, en vez de ignorarlo en
 * silencio: un `"accepts": ["real"]` que se descarte calladamente dejaría al
 * autor creyendo que declaró algo, y el widget aceptaría cualquier variable
 * sin que nadie se entere. Mejor rechazar el ZIP y decir qué está mal.
 *
 * Ausente sí es válido: significa "sin declarar".
 */
function validarAccepts(valor: unknown): DataType[] | undefined {
  if (valor === undefined || valor === null) return undefined;

  if (!Array.isArray(valor)) {
    throw new Error(
      'El .json del widget: "accepts" debe ser una lista, por ejemplo ' +
      '["double", "int"]. Usa [] si el widget es decorativo y no lee ' +
      'ninguna variable.'
    );
  }

  const malos = valor.filter((v) => !esTipoValido(v));
  if (malos.length > 0) {
    throw new Error(
      `El .json del widget: tipo no reconocido en "accepts": ` +
      `${malos.map((m) => JSON.stringify(m)).join(', ')}. ` +
      `Los válidos son: ${TIPOS_VALIDOS.join(', ')}. ` +
      `Ojo: son los tipos del frontend, no los del PLC — REAL y LREAL van ` +
      `como "double", INT/UINT/DINT como "int".`
    );
  }

  // Duplicados fuera: ["int","int"] es lo mismo que ["int"].
  return Array.from(new Set(valor as DataType[]));
}

function validateMeta(raw: unknown): ZipWidgetMeta {
  if (!raw || typeof raw !== 'object') {
    throw new Error('El .json del widget debe ser un objeto JSON válido.');
  }
  const obj = raw as Record<string, unknown>;

  if (typeof obj.kind !== 'string' || !obj.kind.trim()) {
    throw new Error('El .json del widget: falta "kind" (string no vacío).');
  }
  if (typeof obj.label !== 'string' || !obj.label.trim()) {
    throw new Error('El .json del widget: falta "label" (string no vacío).');
  }
  if (!VALID_CATEGORIES.includes(obj.category as string)) {
    throw new Error(
      `El .json del widget: "category" debe ser uno de: ${VALID_CATEGORIES.join(', ')}.`
    );
  }
  const dw = typeof obj.defaultWidth === 'number' ? obj.defaultWidth : 160;
  const dh = typeof obj.defaultHeight === 'number' ? obj.defaultHeight : 120;

  return {
    kind: obj.kind as string,
    label: obj.label as string,
    category: obj.category as ZipWidgetMeta['category'],
    defaultWidth: Math.max(40, Math.min(800, dw)),
    defaultHeight: Math.max(40, Math.min(800, dh)),
    accepts: validarAccepts(obj.accepts),
  };
}

// ---- Parseo del ZIP --------------------------------------------------- //

/** Un archivo del ZIP que sí nos interesa. */
interface ArchivoZip {
  /** Nombre sin la carpeta, tal cual lo escribió el autor. */
  nombre: string;
  obj: JSZip.JSZipObject;
}

/** Extensiones que el cargador entiende. Cualquier otra se ignora. */
const EXTENSIONES = ['json', 'html', 'css', 'js'] as const;
type Extension = (typeof EXTENSIONES)[number];

/**
 * Agrupa el contenido del ZIP por extensión, ignorando la basura.
 *
 * Lo que se descarta y por qué:
 *   - carpetas (`dir`), que no son archivos;
 *   - `__MACOSX/`, que mete macOS al comprimir y duplica cada archivo;
 *   - los que empiezan por punto (`.DS_Store`, `._widget.html`), que son
 *     metadatos del sistema y no del widget.
 *
 * Sin esos filtros, un ZIP hecho en un Mac aparentaría tener dos `.html` y
 * se rechazaría por ambiguo.
 */
function agruparPorExtension(zip: JSZip): Record<Extension, ArchivoZip[]> {
  const grupos = { json: [], html: [], css: [], js: [] } as Record<
    Extension,
    ArchivoZip[]
  >;

  for (const ruta of Object.keys(zip.files)) {
    const obj = zip.files[ruta];
    if (obj.dir) continue;
    if (ruta.startsWith('__MACOSX/') || ruta.includes('/__MACOSX/')) continue;

    const nombre = ruta.split('/').pop() ?? '';
    if (!nombre || nombre.startsWith('.')) continue;

    const punto = nombre.lastIndexOf('.');
    if (punto < 1) continue;
    const ext = nombre.slice(punto + 1).toLowerCase() as Extension;
    if (!(EXTENSIONES as readonly string[]).includes(ext)) continue;

    grupos[ext].push({ nombre, obj });
  }
  return grupos;
}

/**
 * Elige el archivo de una extensión. Lanza con un mensaje útil si no puede.
 *
 * `obligatorio` distingue los dos casos: sin `.json` ni `.html` no hay widget
 * que cargar; sin `.css` ni `.js` sí lo hay, solo que estático.
 */
function elegirArchivo(
  lista: ArchivoZip[],
  ext: Extension,
  obligatorio: boolean
): ArchivoZip | null {
  if (lista.length === 0) {
    if (!obligatorio) return null;
    throw new Error(
      `El ZIP debe contener un archivo .${ext} (el nombre da igual: ` +
      `"widget.${ext}", "mi-widget.${ext}"... lo que manda es la extensión).`
    );
  }
  if (lista.length === 1) return lista[0];

  // Varios candidatos: gana la convención antes que el azar.
  const preferido = lista.find((a) => a.nombre.toLowerCase() === `widget.${ext}`);
  if (preferido) return preferido;

  throw new Error(
    `El ZIP tiene ${lista.length} archivos .${ext} y no se puede adivinar ` +
    `cuál es el bueno: ${lista.map((a) => a.nombre).join(', ')}. ` +
    `Deja solo uno, o llama "widget.${ext}" al que quieras usar.`
  );
}

export async function parseWidgetZip(file: File): Promise<ZipWidget> {
  const zip = await JSZip.loadAsync(file);
  const grupos = agruparPorExtension(zip);

  const jsonFile = elegirArchivo(grupos.json, 'json', true)!;
  const htmlFile = elegirArchivo(grupos.html, 'html', true)!;
  const cssFile = elegirArchivo(grupos.css, 'css', false);
  const jsFile = elegirArchivo(grupos.js, 'js', false);

  // Leer contenidos
  const jsonText = await jsonFile.obj.async('string');
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    throw new Error(
      `"${jsonFile.nombre}" no es JSON válido. Revisa que no le falte una ` +
      `coma o una comilla.`
    );
  }

  const meta = validateMeta(parsed);
  const html = await htmlFile.obj.async('string');
  const css = cssFile ? await cssFile.obj.async('string') : '';
  const js = jsFile ? await jsFile.obj.async('string') : '';

  return { meta, html, css, js };
}

// ---- Persistencia ------------------------------------------------------ //
//
// La fuente de verdad es el SERVIDOR (`/widgets`), no `localStorage`.
//
// Antes vivían solo en `localStorage` y eso se rompía de tres formas:
//   1. Al cerrar la aplicación de escritorio el widget aparecía vacío: el
//      diseño venía del servidor (por eso la caja seguía ahí) pero la
//      definición se había perdido con el almacenamiento del navegador.
//   2. La vista previa abierta en otro navegador salía vacía: otro navegador
//      es otro `localStorage`, y ahí esa definición nunca existió.
//   3. Con varios usuarios, el widget que importaba uno era invisible para
//      los demás.
//
// `localStorage` se conserva como CACHÉ, por dos motivos: el catálogo se lee
// de forma SÍNCRONA en varios sitios (registry, widgetCatalog, sidebar) y
// convertirlos a async sería un refactor grande; y además permite que el
// diseñador siga dibujando si el servidor tarda o se cae un momento.

/** Convierte la respuesta del servidor al formato que usa el frontend. */
function desdeServidor(w: any): ZipWidget {
  return {
    meta: { ...(w.meta ?? {}), kind: w.kind, label: w.nombre ?? w.kind },
    html: w.html ?? '',
    css: w.css ?? '',
    js: w.js ?? '',
  } as ZipWidget;
}

/** Lee la caché local. Síncrono a propósito (ver comentario de arriba). */
export function loadZipWidgets(): ZipWidget[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as ZipWidget[];
  } catch {
    return [];
  }
}

export function saveZipWidgets(widgets: ZipWidget[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(widgets));
  } catch {
    // Cuota llena: no es fatal, el servidor sigue teniendo la verdad.
  }
}

/**
 * Trae los widgets del servidor y refresca la caché.
 *
 * Se llama al arrancar el Diseñador y la Vista previa. Si el servidor no
 * responde se deja la caché como está: es mejor dibujar con lo último
 * conocido que quedarse en blanco.
 */
export async function sincronizarWidgets(): Promise<ZipWidget[]> {
  try {
    const r = await fetch('/widgets?con_contenido=true');
    if (!r.ok) throw new Error(String(r.status));
    const data = await r.json();
    const widgets: ZipWidget[] = (data.widgets ?? []).map(desdeServidor);
    saveZipWidgets(widgets);
    return widgets;
  } catch {
    return loadZipWidgets();
  }
}

/**
 * Guarda un widget importado. Escribe PRIMERO en el servidor: si esa parte
 * falla hay que avisar al usuario, porque si no creería que quedó guardado
 * y volvería a perderlo al cerrar — que es justo el fallo que esto arregla.
 */
export async function addZipWidget(widget: ZipWidget): Promise<ZipWidget[]> {
  const kind = widget.meta.kind;
  const r = await fetch(`/widgets/${encodeURIComponent(kind)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      nombre: widget.meta.label ?? kind,
      html: widget.html,
      css: widget.css ?? '',
      js: widget.js ?? '',
      meta: widget.meta,
    }),
  });

  if (!r.ok) {
    let detalle = `Error ${r.status}`;
    try {
      detalle = (await r.json()).detail ?? detalle;
    } catch {
      /* respuesta sin JSON */
    }
    throw new Error(`No se pudo guardar en el servidor: ${detalle}`);
  }

  const actuales = loadZipWidgets().filter((w) => w.meta.kind !== kind);
  actuales.push(widget);
  saveZipWidgets(actuales);
  return actuales;
}

export async function removeZipWidget(kind: string): Promise<ZipWidget[]> {
  const limpio = kind.replace(/^custom:/, '');
  try {
    await fetch(`/widgets/${encodeURIComponent(limpio)}`, { method: 'DELETE' });
  } catch {
    // Si el servidor no responde se quita igualmente de la caché; la próxima
    // sincronización lo devolverá y quedará claro que no se borró de verdad.
  }
  const actuales = loadZipWidgets().filter(
    (w) => w.meta.kind !== limpio && w.meta.kind !== kind
  );
  saveZipWidgets(actuales);
  return actuales;
}

// ---- Fullkind helper -------------------------------------------------- //

/** Asegura que el kind tenga el prefijo "custom:" */
export function fullKind(kind: string): `custom:${string}` {
  return kind.startsWith('custom:')
    ? (kind as `custom:${string}`)
    : `custom:${kind}`;
}
