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
/** Lista de proyectos disponibles, para el selector de pantallas. */
export async function listarProyectos(): Promise<any[]> {
  const d = await fetchAuth('/proyectos');
  return d.proyectos ?? [];
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
