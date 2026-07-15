// src/components/hmi/custom/registry.ts
import type { CustomWidgetDef } from './types';
import { motorHidraulico } from './motor/MotorTrifasico';
// import { semaforoIndustrial } from './SemaforoIndustrial';

export const customWidgets: CustomWidgetDef[] = [
  motorHidraulico,
  // semaforoIndustrial,   ← aquí agregas cada widget nuevo, punto
];

export const customByKind = (kind: string): CustomWidgetDef | undefined =>
  customWidgets.find(w => w.kind === kind);