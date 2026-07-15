// src/components/hmi/custom/types.ts
import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import type { HmiWidget, WidgetStyle } from '../../../models/widget';
import type { PlcVariable } from '../../../models/plc';

export interface CustomWidgetDef {
  kind: `custom:${string}`;                        // siempre con prefix 'custom:'
  label: string;                                    // lo que sale en el sidebar
  category: 'Básicos' | 'Indicadores' | 'Equipos' | 'Datos';
  icon: LucideIcon;
  defaultWidth: number;
  defaultHeight: number;
  render: (ctx: RenderCtx) => ReactNode;
}

export interface RenderCtx {
  widget: HmiWidget;
  variable?: PlcVariable;
  style: WidgetStyle;
  on: boolean;         // ya calculado con isTruthy(variable)
  frac: number;        // ya calculado con valueFraction(variable) — 0..1
  label: string;       // ya formateado
}