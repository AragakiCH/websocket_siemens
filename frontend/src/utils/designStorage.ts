// =========================================================================
// designStorage.ts
// Guarda / lee el diseño del canvas (widgets + medidas) en localStorage.
// Esto permite que la pestaña de "Vista previa" (que es un contexto nuevo,
// con su propio AppStore vacío) pueda leer el diseño hecho en el Designer.
// =========================================================================
import { HmiWidget } from '../models/widget';

export interface SavedDesign {
  widgets: HmiWidget[];
  canvas: { width: number; height: number };
}

export const DESIGN_KEY = 'hmi.design';

export function saveDesign(design: SavedDesign): void {
  try {
    localStorage.setItem(DESIGN_KEY, JSON.stringify(design));
  } catch {
    /* ignore quota / disabled storage */
  }
}

export function loadDesign(): SavedDesign | null {
  try {
    const raw = localStorage.getItem(DESIGN_KEY);
    return raw ? (JSON.parse(raw) as SavedDesign) : null;
  } catch {
    return null;
  }
}
