// src/components/hmi/custom/types.ts
import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import type { HmiWidget, WidgetStyle } from '../../../models/widget';
import type { PlcVariable } from '../../../models/plc';
import type { ParametroFaceplate } from '../../../utils/designStorage';

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

  /**
   * Fuera de la paleta, pero se sigue dibujando.
   *
   * Para un widget retirado: no se puede agregar uno nuevo, y los que ya
   * estén colocados en un diseño guardado se siguen viendo igual. Quitarlo
   * del registry de golpe dejaría un hueco vacío sin explicación en cada
   * proyecto que lo tuviera. Es el mismo criterio con el que se retiró el
   * widget «chart» del catálogo.
   */
  oculto?: boolean;

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
  /**
   * Los parámetros que declara LA PANTALLA QUE SE ESTÁ EDITANDO, si es un
   * tipo de faceplate. Vacío en una pantalla normal.
   *
   * Lo necesita el panel de acciones: un botón dentro de un tipo puede abrir
   * otro faceplate pasándole los parámetros de éste (`param:motor`), y para
   * ofrecerlos hay que saber cuáles son. El Inspector ya los tiene calculados
   * para el selector de variable, así que se pasan en vez de volver a
   * pedirlos.
   */
  paramsPantalla?: ParametroFaceplate[];
}

export interface RenderCtx {
  widget: HmiWidget;
  variable?: PlcVariable;
  style: WidgetStyle;
  on: boolean;         // ya calculado con isTruthy(variable)
  frac: number;        // ya calculado con valueFraction(variable) — 0..1
  label: string;       // ya formateado

  /**
   * ¿Se está OPERANDO el widget, o editando?
   *
   *   true   Vista previa: es lo que ve el operador. El widget puede escuchar
   *          gestos (el trend usa el arrastre para moverse en el tiempo).
   *   false  Lienzo del Diseñador. Ahí el arrastre sirve para COLOCAR el
   *          widget: si el contenido se quedara con el puntero, no habría
   *          forma de moverlo ni de estirarlo.
   *
   * Ausente = false. Los widgets que no escuchan nada pueden ignorarlo.
   */
  interactivo?: boolean;
}