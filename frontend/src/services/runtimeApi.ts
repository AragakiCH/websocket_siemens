// =========================================================================
// runtimeApi.ts
// El proyecto que están viendo los VISORES (`/runtime`).
//
// Un visor no diseña: entra y tiene que abrir el runtime del proyecto que el
// supervisor tiene en pantalla en el servidor. Ese dato vive en el servidor
// (`datos/runtime.json`), lo publica el Diseñador del equipo servidor al
// abrir un proyecto, y llega a los visores por el WebSocket como
// `runtime.changed` para que cambien sin recargar.
// =========================================================================
import { fetchAuth } from './authApi';
import type { ResumenPantalla } from '../utils/designStorage';

export interface Runtime {
  proyecto_id: string;
  nombre: string;
  /** `false` si el proyecto publicado ya no existe (no debería pasar). */
  existe: boolean;
  /** Las pantallas del proyecto, en orden. La primera es por la que arranca. */
  pantallas: ResumenPantalla[];
  publicado_por: string;
  publicado_en: string;
}

/** Qué proyecto está en pantalla, con sus pantallas. */
export async function fetchRuntime(): Promise<Runtime> {
  const d = await fetchAuth('/runtime');
  return {
    proyecto_id: d.proyecto_id,
    nombre: d.nombre ?? d.proyecto_id,
    existe: d.existe !== false,
    pantallas: d.pantallas ?? [],
    publicado_por: d.publicado_por ?? '',
    publicado_en: d.publicado_en ?? '',
  };
}

/**
 * Publica el proyecto que verán los visores.
 *
 * Lo llama el Diseñador solo, al abrir un proyecto en el equipo servidor.
 * Desde otra IP el backend exige Supervisor (403 si no).
 */
export async function publicarRuntime(
  proyectoId: string
): Promise<Runtime & { cambio: boolean }> {
  const d = await fetchAuth('/runtime', {
    method: 'PUT',
    body: JSON.stringify({ proyecto_id: proyectoId }),
  });
  return {
    cambio: d.cambio === true,
    proyecto_id: d.proyecto_id,
    nombre: d.nombre ?? d.proyecto_id,
    existe: d.existe !== false,
    pantallas: d.pantallas ?? [],
    publicado_por: d.publicado_por ?? '',
    publicado_en: d.publicado_en ?? '',
  };
}

/** Un mensaje `runtime.changed` tal y como llega por el WebSocket. */
export interface RuntimeChanged extends Runtime {
  type: 'runtime.changed';
  por: string;
  motivo: string;
}
