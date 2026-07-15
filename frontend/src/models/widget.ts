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