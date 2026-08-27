// =========================================================================
// designStorage.ts
// El diseño del HMI: widgets + medidas del lienzo.
//
// ANTES: la fuente de verdad era `localStorage`. Funcionaba con un solo
// usuario, pero `localStorage` es privado del navegador por definición — no
// hay API que lo haga viajar. Mientras el diseño viviera ahí, el usuario 2
// jamás vería los widgets del usuario 1.
//
// AHORA: la fuente de verdad es el SERVIDOR (`/proyectos/<id>`), y
// `localStorage` se conserva como CACHÉ. Eso da lo mejor de los dos mundos:
//
//   * Al abrir, se pinta al instante lo último conocido (sin pantalla en
//     blanco esperando la red) y en paralelo se pide el servidor.
//   * Si el backend está caído, se sigue viendo el último diseño en vez de
//     una pantalla vacía.
//
// Control de versiones: cada proyecto lleva un entero `version`. Se manda al
// escribir; si el servidor va por una más alta, responde 409 y quien escribe
// decide si recargar o forzar. Es lo que evita que un guardado pise el trabajo
// que otro acaba de hacer.
// =========================================================================
import { HmiWidget } from '../models/widget';
import { fetchAuth } from '../services/authApi';

export interface SavedDesign {
  widgets: HmiWidget[];
  canvas: { width: number; height: number };
}

export interface Proyecto extends SavedDesign {
  project_id: string;
  nombre: string;
  version: number;
  actualizado_en: string;
  actualizado_por: string;
}

/** Clave de la caché local. Se mantiene el nombre histórico. */
export const DESIGN_KEY = 'hmi.design';

/** Proyecto por defecto; coincide con el que crea el backend al arrancar. */
export const PROYECTO_POR_DEFECTO = 'principal';

/**
 * Una pantalla en el selector, tal y como la resume `GET /proyectos`.
 *
 * Deliberadamente SIN los widgets: la lista se pide cada vez que alguien crea
 * o borra una pantalla, y con diez pantallas de cincuenta widgets eso serian
 * cientos de KB por refresco para pintar unas pestanas.
 */
export interface ResumenPantalla {
  project_id: string;
  nombre: string;
  version: number;
  /** Cuándo se creó. Es lo que da el orden de las pestañas. */
  creado_en?: string;
  actualizado_en: string;
  actualizado_por: string;
  num_widgets: number;
}

/**
 * Ultima pantalla abierta, recordada en ESTE navegador.
 *
 * Es una preferencia local, no configuracion compartida: dos personas pueden
 * estar trabajando en pantallas distintas del mismo proyecto, y al recargar
 * cada una debe volver a la suya. Por eso no vive en el servidor.
 */
const PANTALLA_KEY = 'hmi.design.ultima';

export function getUltimaPantalla(): string {
  try {
    return localStorage.getItem(PANTALLA_KEY) ?? PROYECTO_POR_DEFECTO;
  } catch {
    return PROYECTO_POR_DEFECTO;
  }
}

export function setUltimaPantalla(projectId: string): void {
  try {
    if (projectId) localStorage.setItem(PANTALLA_KEY, projectId);
  } catch {
    /* sin storage: se abrira la pantalla por defecto */
  }
}

/**
 * Convierte un nombre escrito por una persona en un `project_id` valido.
 *
 * El backend valida contra `^[A-Za-z0-9_-]{1,64}$` porque el id ES el nombre
 * del fichero en disco: un id con `../` o `/` permitiria escribir fuera de la
 * carpeta. Aqui se sanea antes de mandarlo para que "Horno 2 - Linea A" no
 * rebote con un 400 que el usuario no puede interpretar.
 */
export function idDesdeNombre(nombre: string): string {
  const base = (nombre || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')   // quita acentos
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64);
  return base || `pantalla_${Date.now().toString(36)}`;
}

// ===================================================================== //
// Caché local (ya NO es la fuente de verdad)
// ===================================================================== //
function claveCache(projectId: string): string {
  return `${DESIGN_KEY}.${projectId}`;
}

export function saveDesign(
  design: SavedDesign,
  projectId: string = PROYECTO_POR_DEFECTO
): void {
  try {
    localStorage.setItem(claveCache(projectId), JSON.stringify(design));
  } catch {
    /* cuota llena o storage deshabilitado: no es crítico, es solo caché */
  }
}

export function loadDesign(
  projectId: string = PROYECTO_POR_DEFECTO
): SavedDesign | null {
  try {
    const raw =
      localStorage.getItem(claveCache(projectId)) ??
      // Compatibilidad: diseños guardados antes de que hubiera proyectos.
      (projectId === PROYECTO_POR_DEFECTO
        ? localStorage.getItem(DESIGN_KEY)
        : null);
    return raw ? (JSON.parse(raw) as SavedDesign) : null;
  } catch {
    return null;
  }
}

// ===================================================================== //
// Servidor (fuente de verdad)
// ===================================================================== //
/** Lista de pantallas disponibles, para el selector del Disenador. */
export async function listarProyectos(): Promise<ResumenPantalla[]> {
  const d = await fetchAuth('/proyectos');
  return d.proyectos ?? [];
}

/**
 * Crea una pantalla vacia. Devuelve su `project_id` real.
 *
 * El id se deriva del nombre, pero si ya existe se le anade un sufijo en vez
 * de fallar: crear dos pantallas llamadas "Horno" es algo perfectamente
 * razonable, y que la segunda rebote con "ya existe" seria hacerle pagar al
 * usuario un detalle de implementacion que no eligio.
 */
export async function crearPantalla(nombre: string): Promise<ResumenPantalla> {
  const base = idDesdeNombre(nombre);
  let intento = base;
  for (let i = 2; i <= 50; i++) {
    try {
      const d = await fetchAuth('/proyectos', {
        method: 'POST',
        body: JSON.stringify({ project_id: intento, nombre }),
      });
      return {
        project_id: d.project_id,
        nombre: d.nombre,
        version: d.version,
        actualizado_en: d.actualizado_en,
        actualizado_por: d.actualizado_por,
        num_widgets: 0,
      };
    } catch (e: any) {
      // 409 = id repetido. Cualquier otro error (403, 503...) se propaga:
      // reintentar con otro nombre no lo arreglaria y solo haria 50 llamadas.
      if (e?.status !== 409) throw e;
      intento = `${base}_${i}`.slice(0, 64);
    }
  }
  throw new Error('No se pudo encontrar un identificador libre para la pantalla.');
}

/** Cambia la etiqueta visible. Exige tener el lapiz de esa pantalla. */
export async function renombrarPantalla(
  projectId: string,
  nombre: string
): Promise<number> {
  const d = await fetchAuth(`/proyectos/${encodeURIComponent(projectId)}`, {
    method: 'PATCH',
    body: JSON.stringify({ nombre }),
  });
  return d.version;
}

/** Borra una pantalla del servidor. Exige rol Supervisor. */
export async function borrarPantalla(projectId: string): Promise<void> {
  await fetchAuth(`/proyectos/${encodeURIComponent(projectId)}`, {
    method: 'DELETE',
  });
  try {
    localStorage.removeItem(claveCache(projectId));
  } catch {
    /* la cache local es prescindible */
  }
}

/**
 * Copia una pantalla entera con otro nombre.
 *
 * Se hace en dos pasos (crear + PUT) porque el backend no tiene un endpoint de
 * duplicado, y no hace falta: crear una pantalla vacia y volcarle los widgets
 * es exactamente lo mismo, y de paso reutiliza la validacion que ya existe.
 *
 * Los widgets conservan su `id` a proposito: son unicos DENTRO de una
 * pantalla, no entre pantallas, y mantenerlos hace que el diseno copiado sea
 * identico bit a bit.
 */
export async function duplicarPantalla(
  origen: string,
  nombre: string
): Promise<ResumenPantalla> {
  const doc = await cargarProyecto(origen);
  const nueva = await crearPantalla(nombre);
  if (doc && (doc.widgets.length > 0 || doc.canvas.width > 0)) {
    // version null = forzar: la pantalla acaba de nacer, no hay nada que pisar.
    await guardarProyecto(
      { widgets: doc.widgets, canvas: doc.canvas },
      null,
      nueva.project_id
    );
  }
  return { ...nueva, num_widgets: doc?.widgets.length ?? 0 };
}

/**
 * Descarga un proyecto y refresca la caché local.
 *
 * Si el servidor no responde, se cae a la caché: es preferible mostrar el
 * último diseño conocido que una pantalla vacía delante de un operario.
 */
export async function cargarProyecto(
  projectId: string = PROYECTO_POR_DEFECTO
): Promise<Proyecto | null> {
  try {
    const d = await fetchAuth(`/proyectos/${projectId}`);
    const proyecto: Proyecto = {
      project_id: d.project_id,
      nombre: d.nombre,
      version: d.version,
      actualizado_en: d.actualizado_en,
      actualizado_por: d.actualizado_por,
      widgets: d.widgets ?? [],
      canvas: d.canvas ?? { width: 0, height: 0 },
    };
    saveDesign(
      { widgets: proyecto.widgets, canvas: proyecto.canvas },
      projectId
    );
    return proyecto;
  } catch (e) {
    console.warn('[proyecto] no se pudo cargar del servidor:', e);
    const local = loadDesign(projectId);
    return local
      ? {
          project_id: projectId,
          nombre: projectId,
          version: 0, // 0 = desconocida; al guardar habrá que refrescar
          actualizado_en: '',
          actualizado_por: '',
          ...local,
        }
      : null;
  }
}

/**
 * Guarda UN widget (crear o mover). Es el camino rápido del arrastre.
 *
 * Devuelve la versión nueva. Si hay conflicto lanza un error con
 * `status === 409` y `data.detail.version_actual`, para que la vista pueda
 * ofrecer "recargar" o "forzar".
 */
export async function guardarWidget(
  widget: HmiWidget,
  version: number | null,
  projectId: string = PROYECTO_POR_DEFECTO
): Promise<number> {
  const d = await fetchAuth(
    `/proyectos/${projectId}/widgets/${encodeURIComponent(widget.id)}`,
    {
      method: 'PATCH',
      body: JSON.stringify({ widget, version }),
    }
  );
  return d.version;
}

/** Quita un widget del proyecto compartido. */
export async function borrarWidget(
  widgetId: string,
  version: number | null,
  projectId: string = PROYECTO_POR_DEFECTO
): Promise<number> {
  const q = version === null ? '' : `?version=${version}`;
  const d = await fetchAuth(
    `/proyectos/${projectId}/widgets/${encodeURIComponent(widgetId)}${q}`,
    { method: 'DELETE' }
  );
  return d.version;
}

/**
 * Reemplaza el proyecto completo (guardado explícito, o "Limpiar lienzo").
 *
 * Para mover un solo widget usa `guardarWidget`: mandar el documento entero en
 * cada evento de arrastre serían decenas de KB por movimiento.
 */
export async function guardarProyecto(
  design: SavedDesign,
  version: number | null,
  projectId: string = PROYECTO_POR_DEFECTO
): Promise<number> {
  const d = await fetchAuth(`/proyectos/${projectId}`, {
    method: 'PUT',
    body: JSON.stringify({
      widgets: design.widgets,
      canvas: design.canvas,
      version,
    }),
  });
  saveDesign(design, projectId);
  return d.version;
}
