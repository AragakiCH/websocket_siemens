// =========================================================================
// navegacion/referencias.ts
// Qué OTRAS pantallas puede llegar a dibujar una pantalla.
//
// Es la lista que la Vista Previa precalienta nada más pintar la suya (ver
// `precargarPantallas` en PantallaEmbebida.tsx): todo lo que un clic podría
// abrir dentro de un Panel de Sección, una Tarjeta de Acceso, un Navegador
// de Pantallas o un Faceplate. Se lee de la configuración de los widgets,
// que es exactamente lo que esos widgets leen para decidir qué dibujar —si
// un widget nuevo empotra pantallas, se añade aquí y listo.
//
// No importa nada de los widgets para no cerrar ciclos (registry → widget →
// aquí → registry): mira `widget.kind` y `widget.config` a pelo.
// =========================================================================
import type { HmiWidget } from '../../../../models/widget';

const texto = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/**
 * Ids de pantalla a los que apunta algo en `widgets`, sin repetir y sin la
 * propia (`actual`). En orden de «lo más probable primero»: las del menú
 * (lo primero que se pulsa), luego tarjetas, navegadores y faceplates.
 */
export function pantallasReferenciadas(widgets: HmiWidget[], actual = ''): string[] {
  const menu: string[] = [];
  const resto: string[] = [];
  const seccionesConPantalla = new Map<string, string>(); // id sección -> pantalla

  for (const w of widgets) {
    const c = (w.config ?? {}) as Record<string, unknown>;
    switch (w.kind) {
      case 'custom:sidebar-navegacion': {
        const secciones = Array.isArray(c.secciones) ? c.secciones : [];
        for (const s of secciones as Array<Record<string, unknown>>) {
          const p = texto(s?.pantalla);
          if (p) {
            menu.push(p);
            seccionesConPantalla.set(texto(s?.id), p);
          }
        }
        break;
      }
      case 'custom:navegador-panel': {
        const lista = Array.isArray(c.pantallas) ? c.pantallas : [];
        for (const p of lista) if (texto(p)) resto.push(texto(p));
        break;
      }
      case 'custom:faceplate': {
        const t = texto(c.tipo);
        if (t) resto.push(t);
        break;
      }
      default:
        break;
    }
    // Un botón con «Mostrar pantalla en el Panel de Sección».
    const accion = (c.accion ?? {}) as Record<string, unknown>;
    if (accion && texto(accion.tipo) === 'abrir-en-panel' && texto(accion.pantalla)) {
      resto.push(texto(accion.pantalla));
    }
    if (accion && texto(accion.tipo) === 'abrir-faceplate' && texto(accion.faceplate)) {
      resto.push(texto(accion.faceplate));
    }
  }

  // Las Tarjetas de Acceso apuntan a una SECCIÓN; su pantalla es la que esa
  // sección tenga asignada en el menú (ya recogida arriba). Sin pantalla
  // asignada dibujan esta misma, que ya está cargada.
  for (const w of widgets) {
    if (w.kind !== 'custom:acceso-seccion') continue;
    const sec = texto((w.config as Record<string, unknown> | undefined)?.seccion);
    const p = seccionesConPantalla.get(sec);
    if (p) resto.push(p);
  }

  const vistos = new Set<string>([actual]);
  const salida: string[] = [];
  for (const id of [...menu, ...resto]) {
    if (!id || vistos.has(id)) continue;
    vistos.add(id);
    salida.push(id);
  }
  return salida;
}
