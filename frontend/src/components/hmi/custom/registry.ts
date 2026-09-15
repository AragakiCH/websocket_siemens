// src/components/hmi/custom/registry.ts
import type { CustomWidgetDef } from './types';
import { motorHidraulico } from './motor/MotorTrifasico';
import { sidebarNavegacion } from './navegacion/SidebarNavegacion';
import { pantallaScreen } from './navegacion/PantallaScreen';
import { accesoSeccion } from './navegacion/AccesoSeccion';
import { faceplate } from './faceplate/Faceplate';
import { trendWidget } from './trend/Trend';
import { contenedorGrupo } from './contenedor/Contenedor';
import { valorUnidad } from './lectura/ValorUnidad';
import { alarmasWidget } from './alarmas/Alarmas';
import { simbolo } from './simbolos/Simbolo';
// El catálogo de ZIP pasó a resolverse por un índice (`zipWidgetPorKind`) en
// vez de recorriendo la lista, y `catalogoListo` dice si ya llegó del
// servidor — eso es lo que distingue «aún cargando» de «ese widget no está».
import {
  loadZipWidgets,
  zipWidgetPorKind,
  catalogoListo,
  type ZipWidget,
} from '../../../services/zipWidgetLoader';
// import { semaforoIndustrial } from './SemaforoIndustrial';

export const customWidgets: CustomWidgetDef[] = [
  motorHidraulico,
  // Navegación: el menú declara las secciones, el contenedor enmarca la vista
  // activa, y cada widget del lienzo dice a cuál pertenece.
  sidebarNavegacion,
  pantallaScreen,
  accesoSeccion,
  // Instancia de un tipo de faceplate: se define una vez, se coloca muchas.
  faceplate,
  // Tendencia en vivo: varias variables numéricas contra el tiempo.
  trendWidget,
  // Agrupa widgets para moverlos en bloque. Nada que ver con la
  // navegación: el Panel de Sección enmarca una vista, este solo agrupa.
  contenedorGrupo,
  // Lectura suelta: el número del PLC con la unidad que escribas.
  valorUnidad,
  // Las alarmas pendientes dentro del lienzo, filtrables por área, tag y
  // gravedad. Consume lo mismo que la franja y la pantalla de Alarmas.
  alarmasWidget,
  // Biblioteca de símbolos de proceso: válvulas, y lo que se vaya añadiendo.
  simbolo,
  // semaforoIndustrial,   ← aquí agregas cada widget nuevo, punto
];

export const customByKind = (kind: string): CustomWidgetDef | undefined =>
  customWidgets.find(w => w.kind === kind);

// ---- ZIP (HTML) widgets cargados por el usuario ----------------------- //

/** Devuelve los widgets ZIP del catálogo en memoria. */
export function getZipWidgets(): ZipWidget[] {
  return loadZipWidgets();
}

/**
 * Busca un ZIP widget por kind. O(1): es un `Map` en memoria.
 *
 * Antes esto era `loadZipWidgets().find(...)`, y `loadZipWidgets` hacía
 * `JSON.parse` del catálogo ENTERO desde `localStorage`. Se llamaba en cada
 * render de cada widget: con 50 widgets y datos del PLC llegando varias
 * veces por segundo, eran megas parseados cientos de veces por segundo.
 */
export function zipByKind(kind: string): ZipWidget | undefined {
  return zipWidgetPorKind(kind);
}

/**
 * ¿Ya se sabe qué widgets ZIP existen?
 *
 * `false` durante los primeros milisegundos tras abrir la aplicación: la
 * caché y el servidor todavía no han contestado. Un `custom:` sin definición
 * en ese momento está CARGANDO, no roto, y el lienzo lo pinta distinto.
 */
export function zipCatalogoListo(): boolean {
  return catalogoListo();
}

/**
 * Los `custom:` de una lista de widgets que NO se van a poder dibujar.
 *
 * Se pregunta a las dos fuentes que sabe resolver el lienzo: los que vienen
 * compilados con la aplicación (`customByKind`: menú lateral, panel de
 * sección, tendencia...) y los importados desde un `.zip` (`zipByKind`). Lo
 * que no esté en ninguna de las dos saldrá como una caja vacía.
 *
 * Lo usan exportar/importar para avisarlo por su nombre en vez de dejar
 * huecos sin explicación. Vive aquí y no en cada llamador porque la pregunta
 * «¿sé dibujar esto?» la contesta el registry, y duplicarla era la forma
 * segura de que una copia se quedara atrás.
 */
export function kindsSinDefinicion(widgets: { kind?: string }[]): string[] {
  const faltan = new Set<string>();
  for (const w of widgets ?? []) {
    const kind = String(w?.kind ?? '');
    if (!kind.startsWith('custom:')) continue;
    if (customByKind(kind) || zipByKind(kind)) continue;
    faltan.add(kind.replace('custom:', ''));
  }
  return [...faltan];
}
