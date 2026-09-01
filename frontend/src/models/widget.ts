// Domain model for HMI canvas widgets.

export type BuiltInWidgetKind =
  'text' |
  'button' |
  'rectangle' |
  'circle' |
  'line' |
  'tank' |
  'led' |
  'gaugeCircular' |
  'gaugeLinear' |
  'progress' |
  'switch' |
  'lamp' |
  'motor' |
  'pump' |
  'valve' |
  'sensor' |
  'chart' |
  'image';

export type CustomWidgetKind = `custom:${string}`;

export type WidgetKind = BuiltInWidgetKind | CustomWidgetKind;

export interface WidgetStyle {
  color: string; // primary / accent color
  background: string;
  borderColor: string;
  borderWidth: number;
  borderRadius: number;
  fontSize: number;
  bold: boolean;
  align: 'left' | 'center' | 'right';
  rotation: number;
  opacity: number;
}

export interface HmiWidget {
  id: string;
  kind: WidgetKind;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  text: string;
  style: WidgetStyle;
  visible: boolean;
  enabled: boolean;
  variableId: string | null;

  /**
   * A qué vista de la navegación pertenece este widget.
   *
   * Vacío o ausente = se ve SIEMPRE, en todas las vistas. Es lo que quieres
   * para el propio menú, un logo o una barra de estado.
   *
   * Con un valor, el widget solo se dibuja cuando esa vista es la activa.
   * El id sale de las secciones que declara el widget "Menú Lateral".
   *
   * Opcional a propósito: los widgets creados antes de que existiera la
   * navegación no lo traen, y sin él se comportan como siempre.
   */
  vista?: string;

  /**
   * Ajustes propios de cada tipo de widget.
   *
   * El resto de campos de `HmiWidget` son comunes a todos (posición, estilo,
   * variable). Esto es para lo que solo entiende un tipo concreto: las
   * secciones del menú, el grupo de navegación de un contenedor...
   *
   * Se guarda con el proyecto como cualquier otro campo, así que viaja al
   * servidor y llega igual a la Vista Previa y al resto de equipos.
   */
  config?: Record<string, any>;

  /**
   * Id del Contenedor que agrupa a este widget, si esta dentro de uno.
   *
   * Las coordenadas siguen siendo ABSOLUTAS respecto al lienzo, no
   * relativas al contenedor. Lo unico que aporta este campo es que al
   * mover el contenedor se mueve tambien lo que lleva dentro; el
   * renderizador y la Vista Previa ni se enteran de que existe.
   *
   * Se pone y se quita arrastrando: entra el widget cuyo centro cae dentro
   * del marco. Ver components/hmi/grupo.ts.
   */
  padre?: string;

  /**
   * Estilo por PARTES del widget (ver components/hmi/partes.ts).
   *
   * Solo guarda lo que NO cabe en `style`: el icono, el botón, el valor. Las
   * partes «caja» y «texto» siguen escribiendo en `style`, que es donde ya
   * vivían, para que no haya dos sitios con el mismo dato.
   *
   * Opcional: un widget sin esto se dibuja exactamente como siempre.
   */
  partes?: Partial<Record<ParteId, EstiloParte>>;
}

/** Sub-elementos que puede tener un widget. */
export type ParteId = 'box' | 'label' | 'icon' | 'boton' | 'valor';

/**
 * Propiedades estilizables de una parte.
 *
 * Todas opcionales: lo que no se declara se hereda del `WidgetStyle` del
 * widget, así una parte recién estrenada se ve como antes hasta que la tocas.
 */
export interface EstiloParte {
  background?: string;
  color?: string;
  borderColor?: string;
  borderWidth?: number;
  borderRadius?: number;
  fontSize?: number;
  bold?: boolean;
  align?: 'left' | 'center' | 'right';
  opacity?: number;
}

export const defaultStyle = (): WidgetStyle => ({
  color: '#009999',
  background: 'transparent',
  borderColor: '#94a3b8',
  borderWidth: 0,
  borderRadius: 8,
  fontSize: 14,
  bold: false,
  align: 'center',
  rotation: 0,
  opacity: 1
});