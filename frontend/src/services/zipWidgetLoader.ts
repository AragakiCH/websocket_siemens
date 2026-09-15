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
// Los widgets cargados viven en el SERVIDOR; en esta pestaña se leen de
// MEMORIA y se cachean en IndexedDB entre arranques (ver «Persistencia», más
// abajo). Se integran automáticamente en el catálogo del Designer.
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
import { RE_NOMBRE_ENLACE, type DeclaracionEnlace } from '../utils/enlaces';
import { getToken } from './authApi';

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

  /**
   * Variables ADEMÁS de la principal, cada una con su nombre.
   *
   * Es lo que permite que un widget importado represente un EQUIPO y no un
   * dato suelto: un motor necesita marcha, fallo y velocidad a la vez, y con
   * una sola variable no se puede girar a la velocidad de una mientras se
   * pinta de rojo por otra.
   *
   * Llegan al widget como `WIDGET.vars.<id>` y como variables CSS
   * `--w-<id>-on`, `--w-<id>-frac` y `--w-<id>-value`.
   *
   * Ausente = el widget solo usa la principal, como siempre.
   */
  variables?: DeclaracionEnlace[];
}

export interface ZipWidget {
  meta: ZipWidgetMeta;
  html: string;
  css: string;
  js: string;
  /**
   * Sello del servidor (`actualizado_en` del fichero JSON). Sirve para saber,
   * al arrancar, si la copia en caché sigue siendo la buena sin bajarse el
   * HTML otra vez. `undefined` en un widget recién importado desde aquí o
   * venido de la caché antigua: se tratará como «hay que refrescarlo».
   */
  actualizado_en?: string;
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

/**
 * Lee y valida `variables`.
 *
 * Falla ruidosamente, igual que `accepts`: un widget que declara mal sus
 * variables se quedaría sin los huecos en el Inspector y su autor estaría
 * media tarde buscando por qué su motor no gira.
 */
function validarVariables(valor: unknown): DeclaracionEnlace[] | undefined {
  if (valor === undefined || valor === null) return undefined;
  if (!Array.isArray(valor)) {
    throw new Error(
      'El .json del widget: "variables" debe ser una lista, por ejemplo ' +
      '[{ "id": "velocidad", "label": "Velocidad", "accepts": ["double"] }].'
    );
  }

  const vistos = new Set<string>();
  const r: DeclaracionEnlace[] = [];
  for (const x of valor as any[]) {
    if (!x || typeof x !== 'object') {
      throw new Error('El .json del widget: cada entrada de "variables" es un objeto.');
    }
    const id = String(x.id ?? '').trim();
    if (!RE_NOMBRE_ENLACE.test(id)) {
      throw new Error(
        `El .json del widget: "${id}" no vale como id de variable. Empieza ` +
        'por una letra y usa solo letras, números o guion bajo.'
      );
    }
    if (vistos.has(id)) {
      throw new Error(`El .json del widget: la variable "${id}" está repetida.`);
    }
    vistos.add(id);
    r.push({
      id,
      label: typeof x.label === 'string' && x.label.trim() ? x.label : id,
      accepts: validarAccepts(x.accepts),
      ayuda: typeof x.ayuda === 'string' ? x.ayuda : undefined,
    });
  }
  return r;
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
    variables: validarVariables(obj.variables),
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
// La fuente de verdad es el SERVIDOR (`/widgets`). En esta pestaña, la copia
// que se lee es la MEMORIA (`catalogo`). Y la caché entre arranques es
// IndexedDB. `localStorage` YA NO SE USA para esto.
//
// POR QUÉ SE FUE DE localStorage — LOS «WIDGETS TRANSPARENTES»
//
// Aquí vivía el catálogo entero en UNA clave de `localStorage`:
// `JSON.stringify(todos los widgets)`. Con dos o tres widgets, nada. Con 50
// widgets (cada uno con su HTML, su CSS, su JS, sus SVG en línea...) más las
// copias de las pantallas que también se guardan ahí, esa clave pasaba de
// los ~5 MB que Chromium/WebView2 concede a TODO el origen. Y entonces
// `setItem` lanzaba `QuotaExceededError`... dentro de un `catch {}` vacío.
//
// El efecto era exactamente el que se veía en planta: se cerraba la
// aplicación de escritorio, se volvía a abrir, y los widgets salían
// TRANSPARENTES. La caja seguía en su sitio (el diseño viene del servidor),
// pero al arrancar `sincronizarWidgets()` no conseguía guardar el catálogo,
// `loadZipWidgets()` leía una clave vacía o vieja, `zipByKind()` no
// encontraba la definición y `WidgetRenderer` pintaba `null`: un hueco con el
// fondo del widget, que casi siempre es transparente. Ni un error en ningún
// sitio. Con 5 widgets no pasaba nunca y con 50 pasaba siempre, que es la
// firma de una cuota.
//
// Encima, cada lectura (`zipByKind` en CADA render de CADA widget) hacía
// `JSON.parse` del catálogo entero. Con 50 widgets y valores del PLC
// llegando varias veces por segundo, eran cientos de parseos de megas por
// segundo: por eso el Diseñador iba cada vez más a tirones al crecer.
//
// LO QUE HAY AHORA, POR CAPAS
//
//   MEMORIA    `catalogo: Map<kind, ZipWidget>`. Es lo que leen el registry,
//              el catálogo del panel y el lienzo, de forma SÍNCRONA y en
//              O(1). No hay cuota ni parseo.
//   IndexedDB  Caché entre arranques. Su cuota se mide en cientos de MB, no
//              en 5. Sirve para PINTAR AL INSTANTE al abrir (antes de que el
//              servidor conteste) y para seguir dibujando si el servidor se
//              cae un momento. Si falla (navegador raro, disco lleno), no
//              pasa nada: el servidor sigue teniendo la verdad.
//   SERVIDOR   Manda siempre. Al arrancar se pide el resumen (sin contenido,
//              unos bytes por widget), se compara con la caché por
//              `actualizado_en`, y solo se descargan los que cambiaron. Con
//              100 widgets y ninguno cambiado, el arranque no mueve ni un KB
//              de HTML por la red.
//
// Y si al final no hay definición para un `custom:` que está en el diseño,
// `WidgetRenderer` ya no pinta `null`: pinta un marcador que dice cuál falta.
// Un fallo que se ve se arregla; uno transparente se sufre.

/** Base de datos y almacén de IndexedDB. Un solo registro con todo. */
const IDB_NOMBRE = 'psi-core';
const IDB_ALMACEN = 'widgets-zip';
const IDB_CLAVE = 'catalogo';

/**
 * La clave de `localStorage` de ANTES. Solo se lee una vez, para migrar lo
 * que hubiera, y se borra: liberar esos megas es parte del arreglo, porque
 * la cuota es de todo el origen y esa clave se la comía.
 */
const STORAGE_KEY_ANTIGUA = 'hmi.custom-html-widgets';

/** Sin prefijo `custom:`. Es la llave del mapa y del fichero en el servidor. */
function kindLimpio(kind: string): string {
  return (kind || '').replace(/^custom:/, '');
}

// ---- Memoria ------------------------------------------------------------ //

let catalogo = new Map<string, ZipWidget>();

/**
 * `true` cuando ya se sabe lo que hay: contestó el servidor, o se leyó la
 * caché, o las dos cosas fallaron y no hay más de dónde tirar. Mientras es
 * `false`, un `custom:` sin definición está CARGANDO, no perdido — y el
 * lienzo lo pinta distinto.
 */
let listo = false;

/** Lee el catálogo en memoria. Síncrono y barato: es un `Map`. */
export function loadZipWidgets(): ZipWidget[] {
  return Array.from(catalogo.values());
}

/** Busca uno por `kind`, con o sin prefijo `custom:`. O(1). */
export function zipWidgetPorKind(kind: string): ZipWidget | undefined {
  return catalogo.get(kindLimpio(kind));
}

/** ¿Ya se sabe qué widgets hay? Ver `listo`. */
export function catalogoListo(): boolean {
  return listo;
}

/**
 * Evento que se emite cada vez que cambia el catálogo de widgets
 * personalizados.
 *
 * POR QUÉ HACE FALTA
 * El catálogo se lee de MEMORIA de forma SÍNCRONA (`loadZipWidgets`) desde
 * el registry, el catálogo del panel y el lienzo. Eso es lo que permite
 * dibujar un widget importado sin esperas... y también lo que hace que React
 * no se entere solo cuando el catálogo cambia a media sesión: un `Map` de
 * módulo no es estado de React.
 *
 * Lo escuchan el AppStore (que sube `widgetsVersion` y con eso se repinta el
 * lienzo entero) y el panel de widgets. Se dispara al llegar la caché, al
 * contestar el servidor, al importar un `.zip`, al borrar uno y al importar
 * un proyecto que trae los suyos.
 */
export const EVENTO_WIDGETS = 'hmi:widgets-personalizados';

function avisar(): void {
  try {
    window.dispatchEvent(new CustomEvent(EVENTO_WIDGETS));
  } catch {
    /* sin `window` (pruebas, SSR): no hay a quién avisar */
  }
}

function fijarCatalogo(widgets: ZipWidget[]): void {
  const nuevo = new Map<string, ZipWidget>();
  for (const w of widgets) {
    const k = kindLimpio(w?.meta?.kind);
    if (k) nuevo.set(k, w);
  }
  catalogo = nuevo;
  listo = true;
  avisar();
}

// ---- IndexedDB ----------------------------------------------------------- //

function abrirIdb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') return resolve(null);
      const req = indexedDB.open(IDB_NOMBRE, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(IDB_ALMACEN)) {
          db.createObjectStore(IDB_ALMACEN);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

async function leerCache(): Promise<ZipWidget[] | null> {
  const db = await abrirIdb();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(IDB_ALMACEN, 'readonly');
      const req = tx.objectStore(IDB_ALMACEN).get(IDB_CLAVE);
      req.onsuccess = () => {
        const v = req.result;
        resolve(Array.isArray(v) ? (v as ZipWidget[]) : null);
      };
      req.onerror = () => resolve(null);
      tx.oncomplete = () => db.close();
    } catch {
      resolve(null);
    }
  });
}

async function escribirCache(widgets: ZipWidget[]): Promise<void> {
  const db = await abrirIdb();
  if (!db) return;
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(IDB_ALMACEN, 'readwrite');
      tx.objectStore(IDB_ALMACEN).put(widgets, IDB_CLAVE);
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch {
      resolve();
    }
  });
}

/**
 * Lo que hubiera en `localStorage` de la versión anterior. Se lee UNA vez y
 * se borra la clave (ver `STORAGE_KEY_ANTIGUA`).
 */
function migrarCacheAntigua(): ZipWidget[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_ANTIGUA);
    if (!raw) return [];
    let lista: ZipWidget[] = [];
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) lista = parsed as ZipWidget[];
    } catch {
      /* JSON roto: se descarta, la caché nueva se rellenará del servidor */
    }
    localStorage.removeItem(STORAGE_KEY_ANTIGUA);
    return lista;
  } catch {
    return [];
  }
}

/**
 * Guarda el catálogo: memoria ahora, IndexedDB después. Avisa al resto de la
 * aplicación (ver `EVENTO_WIDGETS`) aunque la caché fallara: lo que se acaba
 * de recibir YA está en memoria, que es lo que se pinta.
 */
export function saveZipWidgets(widgets: ZipWidget[]): void {
  fijarCatalogo(widgets);
  void escribirCache(widgets);
}

// ---- Servidor ------------------------------------------------------------ //

/**
 * Cabeceras con el token de sesión, si lo hay.
 *
 * ANTES ESTAS PETICIONES IBAN SIN TOKEN. `GET /widgets` es público y no se
 * notaba, pero `PUT` y `DELETE` exigen Administrador: en cuanto había cuentas
 * creadas, importar un `.zip` devolvía «Necesitas iniciar sesión» aunque la
 * sesión estuviera abierta. No se usa `fetchAuth` directamente porque ese
 * helper convierte cualquier 401 en un cierre de sesión global, y un `GET`
 * público que rebote no debería tumbar la sesión de nadie.
 */
function cabeceras(extra: Record<string, string> = {}): Record<string, string> {
  const token = getToken();
  const h: Record<string, string> = { ...extra };
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

async function pedirJson(url: string, init: RequestInit = {}): Promise<any> {
  const r = await fetch(url, {
    ...init,
    headers: cabeceras((init.headers as Record<string, string>) ?? {}),
  });
  if (!r.ok) {
    let detalle = `Error ${r.status}`;
    try {
      detalle = (await r.json()).detail ?? detalle;
    } catch {
      /* respuesta sin JSON */
    }
    const err = new Error(detalle) as Error & { status?: number };
    err.status = r.status;
    throw err;
  }
  return r.json();
}

/** Convierte la respuesta del servidor al formato que usa el frontend. */
function desdeServidor(w: any): ZipWidget {
  return {
    meta: { ...(w.meta ?? {}), kind: w.kind, label: w.nombre ?? w.kind },
    html: w.html ?? '',
    css: w.css ?? '',
    js: w.js ?? '',
    actualizado_en: w.actualizado_en || undefined,
  } as ZipWidget;
}

/**
 * Cuántos widgets cambiados justifican pedirlos uno a uno. A partir de aquí
 * (primer arranque, caché vacía, reinstalación) sale más a cuenta UNA
 * petición con todo que cien pequeñas.
 */
const MAX_PETICIONES_SUELTAS = 12;

/** Descargas en paralelo al pedir widgets sueltos. */
const PARALELO = 6;

/**
 * Trae del servidor SOLO lo que no esté ya igual en memoria.
 *
 *   1. `GET /widgets` (resumen, sin contenido): kind + `actualizado_en`.
 *   2. Lo que coincide con la memoria se reutiliza tal cual.
 *   3. Lo demás se pide con `GET /widgets/{kind}`, unos cuantos a la vez; o
 *      todo de golpe con `?con_contenido=true` si son muchos.
 *
 * Devuelve el catálogo completo tal y como debe quedar.
 */
async function traerDelServidor(): Promise<ZipWidget[]> {
  const resumen = await pedirJson('/widgets');
  const lista: any[] = resumen.widgets ?? [];

  const resultado: ZipWidget[] = [];
  const pendientes: string[] = [];
  for (const r of lista) {
    const k = kindLimpio(r.kind);
    const enMemoria = catalogo.get(k);
    if (
      enMemoria &&
      enMemoria.actualizado_en &&
      r.actualizado_en &&
      enMemoria.actualizado_en === r.actualizado_en
    ) {
      resultado.push(enMemoria);
    } else {
      pendientes.push(k);
    }
  }

  if (pendientes.length === 0) return resultado;

  if (pendientes.length > MAX_PETICIONES_SUELTAS) {
    const todo = await pedirJson('/widgets?con_contenido=true');
    return (todo.widgets ?? []).map(desdeServidor);
  }

  // Pocos: se piden sueltos, de `PARALELO` en `PARALELO`.
  const cola = [...pendientes];
  const traidos: ZipWidget[] = [];
  await Promise.all(
    Array.from({ length: Math.min(PARALELO, cola.length) }, async () => {
      while (cola.length > 0) {
        const k = cola.shift()!;
        try {
          const d = await pedirJson(`/widgets/${encodeURIComponent(k)}`);
          if (d?.widget) traidos.push(desdeServidor(d.widget));
        } catch (e) {
          // Un 404 aquí es que lo borraron entre el resumen y ahora: fuera.
          // Cualquier otra cosa: se conserva lo que hubiera en memoria antes
          // que dejar un hueco.
          const st = (e as { status?: number })?.status;
          const previo = catalogo.get(k);
          if (st !== 404 && previo) traidos.push(previo);
        }
      }
    })
  );
  return [...resultado, ...traidos];
}

let hidratacion: Promise<void> | null = null;
let sincronizacion: Promise<ZipWidget[]> | null = null;
let escuchandoCambios = false;

/**
 * Primera carga desde la caché (IndexedDB, o el `localStorage` antiguo si es
 * la primera vez tras actualizar). Solo tiene efecto una vez, y solo si el
 * servidor no ha contestado ya: lo suyo es pintar al instante lo último
 * conocido y dejar que el servidor lo corrija, no al revés.
 */
function hidratarDesdeCache(): Promise<void> {
  if (!hidratacion) {
    hidratacion = (async () => {
      const antigua = migrarCacheAntigua();
      let lista = await leerCache();
      if ((!lista || lista.length === 0) && antigua.length > 0) {
        lista = antigua;
        void escribirCache(antigua);
      }
      // Si el servidor ya contestó mientras se leía el disco, manda él.
      if (listo) return;
      if (lista && lista.length > 0) fijarCatalogo(lista);
    })();
  }
  return hidratacion;
}

/**
 * Cuando OTRO cliente importa o borra un widget, el servidor difunde
 * `config.updated` con `recurso: "widgets"` por el WebSocket (ver
 * `widget_routes._avisar`). Sin esto, el diseñador de al lado seguiría con
 * el catálogo viejo hasta recargar.
 */
function escucharCambiosRemotos(): void {
  if (escuchandoCambios || typeof window === 'undefined') return;
  escuchandoCambios = true;
  window.addEventListener('hmi:ws', ((ev: CustomEvent) => {
    const msg = ev.detail;
    if (msg?.type === 'config.updated' && msg.recurso === 'widgets') {
      void sincronizarWidgets();
    }
  }) as EventListener);
}

/**
 * Pone el catálogo al día con el servidor.
 *
 * Se llama al arrancar (AppStore), al cambiar de proyecto y al importar uno.
 * Varias llamadas a la vez comparten UNA petición. Si el servidor no
 * responde se deja lo que haya (caché o memoria): es mejor dibujar con lo
 * último conocido que quedarse en blanco — y si tampoco hay caché, se marca
 * `listo` igualmente para que el lienzo deje de decir «cargando» y diga la
 * verdad: que no hay definición.
 */
export async function sincronizarWidgets(): Promise<ZipWidget[]> {
  escucharCambiosRemotos();
  if (sincronizacion) return sincronizacion;

  sincronizacion = (async () => {
    // Primero lo que hay en disco, para pintar ya. Es rápido (una lectura
    // local) y no bloquea la petición al servidor más que unos milisegundos.
    await hidratarDesdeCache();
    try {
      const widgets = await traerDelServidor();
      saveZipWidgets(widgets);
      return widgets;
    } catch {
      if (!listo) {
        listo = true;
        avisar();
      }
      return loadZipWidgets();
    } finally {
      sincronizacion = null;
    }
  })();
  return sincronizacion;
}

/**
 * Guarda un widget importado. Escribe PRIMERO en el servidor: si esa parte
 * falla hay que avisar al usuario, porque si no creería que quedó guardado
 * y volvería a perderlo al cerrar — que es justo el fallo que esto arregla.
 */
export async function addZipWidget(widget: ZipWidget): Promise<ZipWidget[]> {
  const kind = kindLimpio(widget.meta.kind);
  const r = await fetch(`/widgets/${encodeURIComponent(kind)}`, {
    method: 'PUT',
    headers: cabeceras({ 'Content-Type': 'application/json' }),
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

  // Sin `actualizado_en` a propósito: la próxima sincronización lo verá como
  // «distinto» y lo traerá del servidor con su fecha real. Es una petición
  // de más, una vez, a cambio de no inventarse una fecha.
  const actuales = loadZipWidgets().filter((w) => kindLimpio(w.meta.kind) !== kind);
  actuales.push({ ...widget, actualizado_en: undefined });
  saveZipWidgets(actuales);
  return actuales;
}

export async function removeZipWidget(kind: string): Promise<ZipWidget[]> {
  const limpio = kindLimpio(kind);
  try {
    await fetch(`/widgets/${encodeURIComponent(limpio)}`, {
      method: 'DELETE',
      headers: cabeceras(),
    });
  } catch {
    // Si el servidor no responde se quita igualmente de la caché; la próxima
    // sincronización lo devolverá y quedará claro que no se borró de verdad.
  }
  const actuales = loadZipWidgets().filter((w) => kindLimpio(w.meta.kind) !== limpio);
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
