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

  /**
   * Panel propio en el Inspector, para los ajustes que solo entiende este
   * widget (las secciones de un menú, por ejemplo).
   *
   * Opcional: la mayoría de widgets se configuran de sobra con el color, el
   * tamaño y la variable asociada, y no necesitan nada de esto.
   */
  inspector?: (ctx: InspectorCtx) => ReactNode;

  /** Valores de `config` con los que nace el widget al soltarlo. */
  defaultConfig?: Record<string, any>;
}

/** Lo que recibe el panel del Inspector de un widget custom. */
export interface InspectorCtx {
  widget: HmiWidget;
  /** `widget.config`, ya con `{}` en vez de undefined. */
  config: Record<string, any>;
  /** Reemplaza la config entera. Se guarda como cualquier otro cambio. */
  setConfig: (config: Record<string, any>) => void;
}

export interface RenderCtx {
  widget: HmiWidget;
  variable?: PlcVariable;
  style: WidgetStyle;
  on: boolean;         // ya calculado con isTruthy(variable)
  frac: number;        // ya calculado con valueFraction(variable) — 0..1
  label: string;       // ya formateado
}