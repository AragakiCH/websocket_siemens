// src/components/hmi/custom/registry.ts
import type { CustomWidgetDef } from './types';
import { motorHidraulico } from './motor/MotorTrifasico';
import { sidebarNavegacion } from './navegacion/SidebarNavegacion';
import { pantallaScreen } from './navegacion/PantallaScreen';
import { trendWidget } from './trend/Trend';
import { contenedorGrupo } from './contenedor/Contenedor';
import { valorUnidad } from './lectura/ValorUnidad';
import { loadZipWidgets, fullKind, type ZipWidget } from '../../../services/zipWidgetLoader';
// import { semaforoIndustrial } from './SemaforoIndustrial';

export const customWidgets: CustomWidgetDef[] = [
  motorHidraulico,
  // Navegación: el menú declara las secciones, el contenedor enmarca la vista
  // activa, y cada widget del lienzo dice a cuál pertenece.
  sidebarNavegacion,
  pantallaScreen,
  // Tendencia en vivo: varias variables numéricas contra el tiempo.
  trendWidget,
  // Agrupa widgets para moverlos en bloque. Nada que ver con la
  // navegación: el Panel de Sección enmarca una vista, este solo agrupa.
  contenedorGrupo,
  // Lectura suelta: el número del PLC con la unidad que escribas.
  valorUnidad,
  // semaforoIndustrial,   ← aquí agregas cada widget nuevo, punto
];

export const customByKind = (kind: string): CustomWidgetDef | undefined =>
  customWidgets.find(w => w.kind === kind);

// ---- ZIP (HTML) widgets cargados por el usuario ----------------------- //

/** Devuelve los widgets ZIP del localStorage */
export function getZipWidgets(): ZipWidget[] {
  return loadZipWidgets();
}

/** Busca un ZIP widget por kind */
export function zipByKind(kind: string): ZipWidget | undefined {
  return loadZipWidgets().find(w => fullKind(w.meta.kind) === kind);
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
