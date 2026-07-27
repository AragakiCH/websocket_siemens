// src/components/hmi/custom/registry.ts
import type { CustomWidgetDef } from './types';
import { motorHidraulico } from './motor/MotorTrifasico';
import { loadZipWidgets, fullKind, type ZipWidget } from '../../../services/zipWidgetLoader';
// import { semaforoIndustrial } from './SemaforoIndustrial';

export const customWidgets: CustomWidgetDef[] = [
  motorHidraulico,
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