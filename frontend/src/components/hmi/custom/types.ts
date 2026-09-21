// src/components/hmi/custom/types.ts
import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import type { HmiWidget, WidgetStyle } from '../../../models/widget';
import type { PlcVariable } from '../../../models/plc';
import type { ParametroFaceplate } from '../../../utils/designStorage';
import type { DeclaracionEnlace } from '../../../utils/enlaces';

export interface CustomWidgetDef {
  kind: `custom:${string}`;                        // siempre con prefix 'custom:'
  label: string;                                    // lo que sale en el sidebar
  /**
   * La categoría que DECLARA esta definición. Es el defecto, no la última
   * palabra: encima va la asignación del proyecto, que es la que decide en
   * qué sección se pinta (ver `categoriaEfectiva` en `services/categoriasApi`).
   *
   * Era una unión cerrada de cuatro valores. Se abrió a texto porque cada
   * proyecto puede crear sus propias secciones, y un ZIP puede declarar una
   * que aún no existe — antes eso hacía que el ZIP entero se rechazara.
   */
  category: string;
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

  /**
   * Variables ADEMÁS de la principal que este tipo de widget sabe usar.
   *
   * Declararlas hace que el Inspector las pida con su nombre de verdad
   * («Fallo») y ofrezca solo variables del tipo que encajan, en vez de dejar
   * que el usuario invente el nombre y acierte por casualidad.
   *
   * Opcional: casi ningún widget necesita más de una, y los que no la
   * declaran siguen igual — el usuario puede añadir enlaces sueltos a
   * cualquier widget por su cuenta.
   */
  enlaces?: DeclaracionEnlace[];
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

  /**
   * Las variables con nombre del widget, YA RESUELTAS.
   *
   * `enlaces.fallo` es la variable, no su id. La clave existe siempre que el
   * enlace esté declarado en el widget, aunque valga `undefined` por estar sin
   * asignar: así se distingue «hay un hueco y está vacío» de «no hay hueco».
   *
   * Dentro de un faceplate ya vienen traducidas a los tags de esa instancia.
   */
  enlaces?: Record<string, PlcVariable | undefined>;
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