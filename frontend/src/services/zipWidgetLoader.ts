// =========================================================================
// zipWidgetLoader.ts
// ===========================================================================
// Carga widgets personalizados desde archivos ZIP que contienen:
//   - widget.json  (obligatorio) — metadatos del widget
//   - widget.html  (obligatorio) — plantilla visual (HTML/SVG)
//   - widget.css   (opcional)    — estilos del widget
//   - widget.js    (opcional)    — lógica dinámica del widget
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
// =========================================================================
import JSZip from 'jszip';

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
}

export interface ZipWidget {
  meta: ZipWidgetMeta;
  html: string;
  css: string;
  js: string;
}

// ---- Validación del widget.json --------------------------------------- //

const VALID_CATEGORIES = ['Básicos', 'Indicadores', 'Equipos', 'Datos'];

function validateMeta(raw: unknown): ZipWidgetMeta {
  if (!raw || typeof raw !== 'object') {
    throw new Error('widget.json debe ser un objeto JSON válido.');
  }
  const obj = raw as Record<string, unknown>;

  if (typeof obj.kind !== 'string' || !obj.kind.trim()) {
    throw new Error('widget.json: falta "kind" (string no vacío).');
  }
  if (typeof obj.label !== 'string' || !obj.label.trim()) {
    throw new Error('widget.json: falta "label" (string no vacío).');
  }
  if (!VALID_CATEGORIES.includes(obj.category as string)) {
    throw new Error(
      `widget.json: "category" debe ser uno de: ${VALID_CATEGORIES.join(', ')}.`
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
  };
}

// ---- Parseo del ZIP --------------------------------------------------- //

export async function parseWidgetZip(file: File): Promise<ZipWidget> {
  const zip = await JSZip.loadAsync(file);

  // Buscar archivos (pueden estar en la raíz o dentro de una carpeta)
  const findFile = (name: string): JSZip.JSZipObject | null => {
    // Busca exacto en la raíz
    if (zip.files[name]) return zip.files[name];
    // Busca dentro de subcarpetas (solo un nivel)
    for (const path of Object.keys(zip.files)) {
      if (path.endsWith('/' + name) && !zip.files[path].dir) {
        return zip.files[path];
      }
    }
    return null;
  };

  const jsonFile = findFile('widget.json');
  if (!jsonFile) {
    throw new Error('El ZIP debe contener un archivo "widget.json".');
  }

  const htmlFile = findFile('widget.html');
  if (!htmlFile) {
    throw new Error('El ZIP debe contener un archivo "widget.html".');
  }

  const cssFile = findFile('widget.css');
  const jsFile = findFile('widget.js');

  // Leer contenidos
  const jsonText = await jsonFile.async('string');
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    throw new Error('widget.json no es JSON válido.');
  }

  const meta = validateMeta(parsed);
  const html = await htmlFile.async('string');
  const css = cssFile ? await cssFile.async('string') : '';
  const js = jsFile ? await jsFile.async('string') : '';

  return { meta, html, css, js };
}

// ---- Persistencia en localStorage ------------------------------------- //

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
  localStorage.setItem(STORAGE_KEY, JSON.stringify(widgets));
}

export function addZipWidget(widget: ZipWidget): ZipWidget[] {
  const existing = loadZipWidgets();
  // Si ya existe uno con el mismo kind, lo reemplaza (actualización)
  const filtered = existing.filter(
    (w) => w.meta.kind !== widget.meta.kind
  );
  filtered.push(widget);
  saveZipWidgets(filtered);
  return filtered;
}

export function removeZipWidget(kind: string): ZipWidget[] {
  const existing = loadZipWidgets();
  const filtered = existing.filter((w) => w.meta.kind !== kind);
  saveZipWidgets(filtered);
  return filtered;
}

// ---- Fullkind helper -------------------------------------------------- //

/** Asegura que el kind tenga el prefijo "custom:" */
export function fullKind(kind: string): `custom:${string}` {
  return kind.startsWith('custom:')
    ? (kind as `custom:${string}`)
    : `custom:${kind}`;
}
