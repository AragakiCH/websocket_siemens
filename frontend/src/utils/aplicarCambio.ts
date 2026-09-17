// =========================================================================
// aplicarCambio.ts
// Aplica un `project.updated` a un diseño que ya se tiene en memoria, SIN
// volver a pedir la pantalla al servidor.
//
// POR QUÉ
// Cada guardado del Diseñador (uno cada 400 ms mientras se arrastra) llega
// a todos los clientes como `project.updated`. Antes, la Vista Previa y los
// paneles empotrados reaccionaban pidiendo `GET /pantallas/<id>` entero:
// con diez visores eran diez descargas de la pantalla por cada movimiento
// del ratón, y el arrastre se veía a saltos en los puestos.
//
// Ahora el backend manda dentro del evento lo que cambió:
//
//   widget_guardado      -> `cambio.datos`  (el widget)              [PATCH]
//   widget_borrado       -> `cambio.widget` (su id)                  [DELETE]
//   proyecto_reemplazado -> `cambio.diff`   { widgets, borrados,
//                                             orden, canvas? }       [PUT]
//
// y esto lo aplica en sitio. Devuelve `null` cuando NO puede: el evento no
// trae datos (diff demasiado grande, backend antiguo) o la versión no es la
// siguiente a la que se tiene (se perdió un evento por el camino). En ese
// caso quien llama recarga por HTTP, que es el camino de siempre.
// =========================================================================
import type { HmiWidget } from '../models/widget';
import type { SavedDesign } from './designStorage';

export interface CambioProyecto {
  accion?: string;
  datos?: HmiWidget;
  widget?: string;
  diff?: {
    widgets?: HmiWidget[];
    borrados?: string[];
    orden?: string[];
    canvas?: SavedDesign['canvas'];
  };
}

export interface MensajeProjectUpdated {
  type: 'project.updated';
  project_id: string;
  version: number;
  por?: string;
  cambio?: CambioProyecto;
}

/**
 * ¿Este evento se puede aplicar encima de la versión que tengo?
 *
 * `versionLocal` 0 = desconocida (se pintó desde la caché): no se puede
 * afirmar nada, así que se recarga. Si el evento es justo la siguiente, se
 * aplica. Si hay un hueco, se perdió alguno (socket caído un instante) y
 * aplicar solo el último dejaría la pantalla a medias: se recarga.
 */
export function versionEncaja(versionLocal: number, versionEvento: number): boolean {
  if (!versionLocal || !versionEvento) return false;
  return versionEvento === versionLocal + 1;
}

/**
 * Aplica el cambio y devuelve el diseño nuevo, o `null` si hay que recargar.
 *
 * Nunca muta `design`: devuelve copias, que es lo que React necesita para
 * repintar.
 */
export function aplicarCambio(
  design: SavedDesign | null,
  msg: MensajeProjectUpdated
): SavedDesign | null {
  if (!design) return null;
  const cambio = msg.cambio ?? {};

  if (cambio.accion === 'widget_guardado' && cambio.datos?.id) {
    const nuevo = cambio.datos;
    const i = design.widgets.findIndex((w) => w.id === nuevo.id);
    const widgets =
      i < 0
        ? [...design.widgets, nuevo]
        : design.widgets.map((w, k) => (k === i ? nuevo : w));
    return { ...design, widgets };
  }

  if (cambio.accion === 'widget_borrado' && cambio.widget) {
    return {
      ...design,
      widgets: design.widgets.filter((w) => w.id !== cambio.widget),
    };
  }

  if (cambio.accion === 'proyecto_reemplazado' && cambio.diff) {
    const d = cambio.diff;
    const cambiados = new Map((d.widgets ?? []).map((w) => [w.id, w]));
    const borrados = new Set(d.borrados ?? []);
    const actuales = new Map(
      design.widgets
        .filter((w) => !borrados.has(w.id))
        .map((w) => [w.id, cambiados.get(w.id) ?? w])
    );
    // Los nuevos (no estaban) entran también.
    for (const [id, w] of cambiados) if (!actuales.has(id)) actuales.set(id, w);

    // El orden manda: es el z-order del lienzo. Si por lo que sea no viene,
    // se conserva el que había y los nuevos van al final.
    let widgets: HmiWidget[];
    if (d.orden && d.orden.length === actuales.size) {
      widgets = [];
      for (const id of d.orden) {
        const w = actuales.get(id);
        if (w) widgets.push(w);
      }
      if (widgets.length !== actuales.size) return null; // orden inconsistente
    } else {
      widgets = [...actuales.values()];
    }

    return {
      widgets,
      canvas: d.canvas ?? design.canvas,
    };
  }

  // `proyecto_creado`, `proyecto_renombrado`, backend sin diff... no hay
  // nada que aplicar en el lienzo.
  return null;
}
