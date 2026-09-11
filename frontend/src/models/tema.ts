// =========================================================================
// tema.ts
// Los TEMAS del proyecto: paleta (modo claro y oscuro) y tipografías.
//
// LA IDEA, EN UNA LÍNEA
// Un tema no pinta nada: define VARIABLES CSS en la raíz del documento. Quien
// pinta es el widget, que en vez de guardar `#009999` guarda
// `var(--psi-primary)`. El navegador resuelve la variable al dibujar.
//
// POR QUÉ ASÍ Y NO RESOLVIENDO LOS COLORES EN JAVASCRIPT
// Porque todos los widgets se pintan con estilos EN LÍNEA, y un estilo en
// línea acepta `var(...)` igual que cualquier otro valor. Resolver el token
// en JavaScript obligaría a pasar el tema por todo el árbol de render, a
// repintar cada widget al cambiarlo, y a acordarse de hacerlo en cada widget
// nuevo. Dejándoselo al navegador, el tema cambia y se repinta TODO —lienzo
// del Diseñador incluido— sin que el código de render se entere de que los
// temas existen.
//
// Y es lo que permite lo que promete WebIQ: «cambiar todos los botones a azul
// de golpe pudiendo seguir estilando botones concretos». El que quiera un
// color propio guarda su literal y se queda fuera del tema, a propósito.
//
// EL CATÁLOGO VIVE AQUÍ Y SOLO AQUÍ
// El servidor (`app/db/tema_store.py`) valida el FORMATO de un color, no la
// lista de roles. Así añadir un rol es tocar un fichero, no dos, y el botón
// «Añadir color» puede crear roles que ningún catálogo previó. Lo que llegue
// y no esté aquí se agrupa bajo «Otros»: se ve y se edita igual.
// =========================================================================

export type ModoColor = 'light' | 'dark';
export type ModoPorDefecto = ModoColor | 'auto';

/** Un rol tipográfico. Lista cerrada: cada uno tiene un consumidor escrito. */
export type RolFuente = 'cuerpo' | 'titulo' | 'dato' | 'mono';

export interface Fuente {
  familia: string;
  tamano: number;
  peso: number;
  interlineado: number;
  espaciado: number;
}

export interface Tema {
  id: string;
  nombre: string;
  modo_por_defecto: ModoPorDefecto;
  colores: Record<ModoColor, Record<string, string>>;
  fuentes: Record<RolFuente, Fuente>;
  /** Colores creados con «Añadir color»: guardan su etiqueta visible. */
  extras: { id: string; nombre: string }[];
  /** Los de serie. No se borran, para no dejar la instalación sin ninguno. */
  bloqueado?: boolean;
}

export interface DocumentoTemas {
  version: number;
  actualizado_en: string;
  actualizado_por: string;
  activo: string;
  temas: Tema[];
}

// ─── Nombres de variable ─────────────────────────────────────────
//
// `onPrimaryContainer` -> `--psi-on-primary-container`. El prefijo evita
// chocar con las variables que ya hay en index.css (`--siemens-petrol`) y con
// las de cualquier widget ZIP que alguien cargue.

export const PREFIJO = '--psi-';

export const varDeRol = (rol: string): string =>
  PREFIJO + rol.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();

export const tokenDeRol = (rol: string): string => `var(${varDeRol(rol)})`;

/** ¿Este valor guardado es un token del tema, o un color literal? */
export const esToken = (valor: string | undefined): boolean =>
  typeof valor === 'string' && valor.trim().startsWith(`var(${PREFIJO}`);

/**
 * El rol al que apunta un token, o null si es un literal.
 *
 * Deshace el kebab: `var(--psi-on-primary-container)` -> `onPrimaryContainer`.
 */
export function rolDeToken(valor: string | undefined): string | null {
  if (!esToken(valor)) return null;
  const m = /^var\(\s*--psi-([a-z0-9-]+)\s*(?:,[^)]*)?\)$/.exec(
    (valor as string).trim()
  );
  if (!m) return null;
  return m[1].replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

// ─── Catálogo de roles de color ──────────────────────────────────
//
// Los grupos y los nombres salen de Material Design 3, que es lo que usa el
// Theme Manager de WebIQ y lo que se ve en la captura de referencia. Se
// conservan los nombres técnicos (visibles en cada fila como `--psi-...`)
// porque son los que hay que escribir en un widget, y se añade la etiqueta en
// castellano porque es lo que se lee al elegir.

export interface DefRol {
  id: string;
  label: string;
  /** Qué es, para el `title` de la fila. Solo donde no es evidente. */
  ayuda?: string;
}

export interface GrupoColor {
  id: string;
  label: string;
  descripcion: string;
  roles: DefRol[];
}

/** Los ocho roles que MD3 define para cada color principal. */
const familia = (base: string, etiqueta: string): DefRol[] => [
  { id: base, label: etiqueta },
  {
    id: `on${cap(base)}`,
    label: `Sobre ${etiqueta.toLowerCase()}`,
    ayuda: `Texto e iconos que van ENCIMA de «${etiqueta}».`,
  },
  {
    id: `${base}Container`,
    label: `Contenedor ${etiqueta.toLowerCase()}`,
    ayuda: 'Fondo suave de la misma familia: tarjetas, avisos, chips.',
  },
  {
    id: `on${cap(base)}Container`,
    label: `Sobre contenedor`,
    ayuda: 'Texto encima del contenedor.',
  },
  {
    id: `${base}Fixed`,
    label: `${etiqueta} fijo`,
    ayuda:
      'NO cambia entre claro y oscuro. Para elementos que tienen que ' +
      'reconocerse igual en los dos modos.',
  },
  { id: `on${cap(base)}Fixed`, label: 'Sobre fijo' },
  {
    id: `${base}FixedDim`,
    label: `${etiqueta} fijo atenuado`,
    ayuda: 'La variante apagada del fijo.',
  },
  {
    id: `on${cap(base)}FixedVariant`,
    label: 'Sobre fijo, variante',
    ayuda: 'Texto secundario encima del fijo.',
  },
];

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export const GRUPOS_COLOR: GrupoColor[] = [
  {
    id: 'primary',
    label: 'Primario',
    descripcion:
      'El color de marca. Es el que llevan los botones de acción, los ' +
      'valores en vivo y todo lo que el operario tiene que mirar primero.',
    roles: familia('primary', 'Primario'),
  },
  {
    id: 'secondary',
    label: 'Secundario',
    descripcion:
      'Acompaña al primario sin competir con él: filtros, pestañas, ' +
      'elementos activos que no son la acción principal.',
    roles: familia('secondary', 'Secundario'),
  },
  {
    id: 'tertiary',
    label: 'Terciario',
    descripcion:
      'El contrapunto. Sirve para separar visualmente una zona del ' +
      'sinóptico sin recurrir a los colores de estado.',
    roles: familia('tertiary', 'Terciario'),
  },
  {
    id: 'estado',
    label: 'Estado del proceso',
    descripcion:
      'Alarma, aviso y normalidad. ESTOS TRES NO SON DECORACIÓN: un ' +
      'operario los lee de lejos y de reojo. Cambiarlos por gusto —un rojo ' +
      'apagado, un verde y un ámbar que se parezcan— es lo único de esta ' +
      'pantalla que puede provocar un error de operación.',
    roles: [
      { id: 'error', label: 'Alarma' },
      { id: 'onError', label: 'Sobre alarma' },
      { id: 'errorContainer', label: 'Fondo de alarma' },
      { id: 'onErrorContainer', label: 'Sobre fondo de alarma' },
      { id: 'warning', label: 'Aviso' },
      { id: 'onWarning', label: 'Sobre aviso' },
      { id: 'warningContainer', label: 'Fondo de aviso' },
      { id: 'onWarningContainer', label: 'Sobre fondo de aviso' },
      { id: 'success', label: 'Normal' },
      { id: 'onSuccess', label: 'Sobre normal' },
      { id: 'successContainer', label: 'Fondo normal' },
      { id: 'onSuccessContainer', label: 'Sobre fondo normal' },
    ],
  },
  {
    id: 'superficie',
    label: 'Superficies y bordes',
    descripcion:
      'El papel sobre el que se dibuja todo lo demás, y las líneas que ' +
      'separan unas zonas de otras.',
    roles: [
      { id: 'background', label: 'Fondo general' },
      { id: 'onBackground', label: 'Texto sobre el fondo' },
      { id: 'surface', label: 'Superficie', ayuda: 'Tarjetas, paneles, barras.' },
      { id: 'onSurface', label: 'Texto sobre superficie' },
      { id: 'surfaceVariant', label: 'Superficie alterna' },
      { id: 'onSurfaceVariant', label: 'Texto sobre alterna' },
      { id: 'outline', label: 'Borde' },
      { id: 'outlineVariant', label: 'Borde suave' },
    ],
  },
];

/** Todos los roles del catálogo, sin agrupar. */
export const ROLES_CATALOGO: string[] = GRUPOS_COLOR.flatMap((g) =>
  g.roles.map((r) => r.id)
);

const ETIQUETAS = new Map<string, DefRol>(
  GRUPOS_COLOR.flatMap((g) => g.roles.map((r) => [r.id, r] as const))
);

export const defDeRol = (rol: string): DefRol =>
  ETIQUETAS.get(rol) ?? { id: rol, label: rol };

// ─── Catálogo tipográfico ────────────────────────────────────────

export const ROLES_FUENTE: { id: RolFuente; label: string; ayuda: string }[] = [
  {
    id: 'cuerpo',
    label: 'Texto general',
    ayuda: 'Todo lo que no sea otra cosa. Es la fuente que hereda el HMI.',
  },
  {
    id: 'titulo',
    label: 'Títulos',
    ayuda: 'Cabeceras de pantalla y de panel.',
  },
  {
    id: 'dato',
    label: 'Valores de proceso',
    ayuda:
      'Las lecturas numéricas. Conviene una fuente de cifras de ancho fijo: ' +
      'si el 1 es más estrecho que el 8, la columna baila cada vez que el ' +
      'valor cambia.',
  },
  {
    id: 'mono',
    label: 'Monoespaciada',
    ayuda: 'Rutas de variables, trazas, identificadores.',
  },
];

/**
 * Familias que se ofrecen.
 *
 * TODAS son o bien la que ya viene empaquetada (Inter) o bien fuentes que
 * Windows y Linux traen de serie. Nada que haya que descargar.
 *
 * No es purismo: un panel de planta suele estar en una red sin salida a
 * internet. Una lista de fuentes de Google se vería preciosa en la máquina
 * del programador y se caería al primer respaldo genérico en la máquina que
 * importa. Quien tenga una fuente corporativa instalada puede escribirla a
 * mano en «Personalizada».
 */
export const FAMILIAS_FUENTE: { label: string; valor: string }[] = [
  { label: 'Inter (la de la aplicación)', valor: 'Inter, system-ui, sans-serif' },
  { label: 'Segoe UI', valor: "'Segoe UI', system-ui, sans-serif" },
  { label: 'Roboto', valor: 'Roboto, system-ui, sans-serif' },
  { label: 'Arial', valor: 'Arial, Helvetica, sans-serif' },
  { label: 'Verdana', valor: 'Verdana, Geneva, sans-serif' },
  { label: 'Tahoma', valor: 'Tahoma, Verdana, sans-serif' },
  { label: 'Georgia (serif)', valor: "Georgia, 'Times New Roman', serif" },
  { label: 'Consolas (monoespaciada)', valor: "Consolas, 'Courier New', monospace" },
  { label: 'Del sistema', valor: 'system-ui, sans-serif' },
];

// ─── Aplicar un tema al documento ────────────────────────────────

const varFuente = (rol: RolFuente, prop: string) =>
  `${PREFIJO}fuente-${rol}${prop ? '-' + prop : ''}`;

/**
 * Escribe el tema como variables CSS en `<html>`.
 *
 * Se usa `setProperty`, que es la API del CSSOM: valida el valor y descarta
 * el que no entienda. No se construye una hoja de estilos concatenando texto,
 * que es por donde se cuela un valor hostil de un tema importado.
 *
 * Devuelve los nombres escritos para poder limpiarlos al cambiar de tema: sin
 * eso, un tema con un color que el siguiente no define dejaría el valor del
 * anterior colgando, y el widget que lo usara se quedaría con un color de un
 * tema que ya nadie tiene seleccionado.
 */
export function aplicarTema(
  tema: Tema | null,
  modo: ModoColor,
  escritasAntes: string[] = []
): string[] {
  if (typeof document === 'undefined') return [];
  const raiz = document.documentElement;
  const escritas: string[] = [];

  if (!tema) {
    escritasAntes.forEach((v) => raiz.style.removeProperty(v));
    return [];
  }

  // Los colores del modo pedido, con los del otro modo como red de
  // seguridad: un tema a medio hacer, con solo la paleta clara rellenada, es
  // mejor que se vea algo raro en oscuro a que se vea negro sobre negro.
  const paleta = { ...(tema.colores.light ?? {}), ...(tema.colores[modo] ?? {}) };
  for (const [rol, valor] of Object.entries(paleta)) {
    const nombre = varDeRol(rol);
    raiz.style.setProperty(nombre, valor);
    escritas.push(nombre);
  }

  for (const rol of ['cuerpo', 'titulo', 'dato', 'mono'] as RolFuente[]) {
    const f = tema.fuentes?.[rol];
    if (!f) continue;
    const pares: [string, string][] = [
      [varFuente(rol, ''), f.familia],
      [varFuente(rol, 'tamano'), `${f.tamano}px`],
      [varFuente(rol, 'peso'), String(f.peso)],
      [varFuente(rol, 'interlineado'), String(f.interlineado)],
      [varFuente(rol, 'espaciado'), `${f.espaciado ?? 0}px`],
    ];
    for (const [nombre, valor] of pares) {
      raiz.style.setProperty(nombre, valor);
      escritas.push(nombre);
    }
  }

  // Limpiar lo que el tema anterior escribía y éste no.
  const ahora = new Set(escritas);
  escritasAntes.filter((v) => !ahora.has(v)).forEach((v) =>
    raiz.style.removeProperty(v)
  );

  return escritas;
}

// ─── Utilidades ──────────────────────────────────────────────────

/** Copia profunda de un tema. Para duplicar y para editar sin tocar el original. */
export const clonarTema = (t: Tema): Tema => JSON.parse(JSON.stringify(t));

/** Id a partir de un nombre escrito por una persona. */
export function idDesdeNombre(nombre: string, ocupados: string[]): string {
  const base =
    nombre
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'tema';
  if (!ocupados.includes(base)) return base;
  for (let i = 2; i < 500; i++) {
    if (!ocupados.includes(`${base}-${i}`)) return `${base}-${i}`;
  }
  return `${base}-${Date.now()}`;
}

/**
 * El color de un rol, resuelto para enseñarlo en un selector de color.
 *
 * `<input type="color">` solo entiende `#rrggbb`: no sabe qué hacer con
 * `transparent`, ni con `rgba()`, ni con un rol que el tema no define. En vez
 * de dejarlo mostrar un valor que no es el real —el error que ya se corrigió
 * en el fondo de los widgets—, esto devuelve `null` y la interfaz dibuja otra
 * cosa.
 */
export function hexDeRol(tema: Tema, modo: ModoColor, rol: string): string | null {
  const v = tema.colores?.[modo]?.[rol];
  if (typeof v !== 'string') return null;
  return /^#[0-9a-fA-F]{6}$/.test(v) ? v : null;
}
