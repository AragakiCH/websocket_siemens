// =========================================================================
// inspectores/index.ts
// Panel propio del Inspector para los widgets QUE VIENEN CON LA APP.
//
// POR QUÉ HACE FALTA ESTO
// Hasta ahora solo los widgets custom (los TSX del registry) podían traer un
// panel propio: se declara en `CustomWidgetDef.inspector`. Los built-in — el
// rectángulo, el botón, la imagen — no tienen dónde declararlo, porque no son
// entradas del registry sino ramas de un `switch`.
//
// La Imagen es el primero que lo necesita de verdad: sin panel no hay manera
// de decirle QUÉ imagen mostrar. Así que se hace lo mismo que con los tipos de
// dato aceptados: un mapa aparte, y el Inspector lo consulta cuando el widget
// no es custom.
//
// Se mantiene deliberadamente pequeño. Si mañana media docena de built-in
// necesitan panel, lo suyo sería que dejaran de ser un `switch` y pasaran a
// ser entradas del registry como los demás; hasta entonces, un mapa de dos
// líneas es menos código que esa migración.
// =========================================================================
import type { ReactNode } from 'react';
import type { InspectorCtx } from '../custom/types';
import { InspectorImagen } from './imagen';

/** Título de la sección + panel, por tipo de widget built-in. */
interface PanelBuiltIn {
  titulo: string;
  render: (ctx: InspectorCtx) => ReactNode;
}

const PANELES: Record<string, PanelBuiltIn> = {
  image: { titulo: 'Imagen', render: InspectorImagen },
};

/** Panel del Inspector de un built-in, o undefined si no tiene. */
export function panelBuiltIn(kind: string): PanelBuiltIn | undefined {
  return PANELES[kind];
}

export { InspectorImagen, leerConfigImagen } from './imagen';
export type { ConfigImagen } from './imagen';
