import {
  TypeIcon,
  MousePointerClickIcon,
  SquareIcon,
  CircleIcon,
  MinusIcon,
  CylinderIcon,
  LightbulbIcon,
  GaugeIcon,
  RulerIcon,
  BarChart3Icon,
  ToggleRightIcon,
  FanIcon,
  DropletsIcon,
  GitCommitVerticalIcon,
  RadioIcon,
  LineChartIcon,
  ImageIcon,
  type LucideIcon } from
'lucide-react';
import { WidgetKind } from '../../models/widget';
import { customWidgets } from './custom/registry';

export interface CatalogItem {
  kind: WidgetKind;
  label: string;
  icon: LucideIcon;
  defaultWidth: number;
  defaultHeight: number;
  category: 'Básicos' | 'Indicadores' | 'Equipos' | 'Datos';
}

// Widgets built-in del sistema (los 18 originales).
const builtInCatalog: CatalogItem[] = [
{
  kind: 'text',
  label: 'Texto',
  icon: TypeIcon,
  defaultWidth: 140,
  defaultHeight: 40,
  category: 'Básicos'
},
{
  kind: 'button',
  label: 'Botón',
  icon: MousePointerClickIcon,
  defaultWidth: 140,
  defaultHeight: 44,
  category: 'Básicos'
},
{
  kind: 'rectangle',
  label: 'Rectángulo',
  icon: SquareIcon,
  defaultWidth: 160,
  defaultHeight: 100,
  category: 'Básicos'
},
{
  kind: 'circle',
  label: 'Círculo',
  icon: CircleIcon,
  defaultWidth: 100,
  defaultHeight: 100,
  category: 'Básicos'
},
{
  kind: 'line',
  label: 'Línea',
  icon: MinusIcon,
  defaultWidth: 160,
  defaultHeight: 8,
  category: 'Básicos'
},
{
  kind: 'tank',
  label: 'Tanque',
  icon: CylinderIcon,
  defaultWidth: 110,
  defaultHeight: 160,
  category: 'Indicadores'
},
{
  kind: 'led',
  label: 'Indicador LED',
  icon: RadioIcon,
  defaultWidth: 90,
  defaultHeight: 90,
  category: 'Indicadores'
},
{
  kind: 'gaugeCircular',
  label: 'Medidor Circular',
  icon: GaugeIcon,
  defaultWidth: 160,
  defaultHeight: 160,
  category: 'Indicadores'
},
{
  kind: 'gaugeLinear',
  label: 'Medidor Lineal',
  icon: RulerIcon,
  defaultWidth: 200,
  defaultHeight: 64,
  category: 'Indicadores'
},
{
  kind: 'progress',
  label: 'Barra de Progreso',
  icon: BarChart3Icon,
  defaultWidth: 200,
  defaultHeight: 44,
  category: 'Indicadores'
},
{
  kind: 'switch',
  label: 'Switch',
  icon: ToggleRightIcon,
  defaultWidth: 90,
  defaultHeight: 48,
  category: 'Indicadores'
},
{
  kind: 'lamp',
  label: 'Lámpara',
  icon: LightbulbIcon,
  defaultWidth: 90,
  defaultHeight: 90,
  category: 'Indicadores'
},
{
  kind: 'motor',
  label: 'Motor',
  icon: FanIcon,
  defaultWidth: 120,
  defaultHeight: 120,
  category: 'Equipos'
},
{
  kind: 'pump',
  label: 'Bomba',
  icon: DropletsIcon,
  defaultWidth: 120,
  defaultHeight: 120,
  category: 'Equipos'
},
{
  kind: 'valve',
  label: 'Válvula',
  icon: GitCommitVerticalIcon,
  defaultWidth: 120,
  defaultHeight: 100,
  category: 'Equipos'
},
{
  kind: 'sensor',
  label: 'Sensor',
  icon: RadioIcon,
  defaultWidth: 120,
  defaultHeight: 100,
  category: 'Equipos'
},
{
  kind: 'chart',
  label: 'Gráfico',
  icon: LineChartIcon,
  defaultWidth: 240,
  defaultHeight: 160,
  category: 'Datos'
},
{
  kind: 'image',
  label: 'Imagen',
  icon: ImageIcon,
  defaultWidth: 160,
  defaultHeight: 120,
  category: 'Datos'
}];

// Catálogo completo = built-in + los custom del registry.
// Los customs se agregan solitos aquí porque el registry los expone;
// no toques este archivo cuando agregues un widget nuevo.
export const widgetCatalog: CatalogItem[] = [
  ...builtInCatalog,
  ...customWidgets.map((w) => ({
    kind: w.kind,
    label: w.label,
    icon: w.icon,
    defaultWidth: w.defaultWidth,
    defaultHeight: w.defaultHeight,
    category: w.category
  }))
];

export const catalogByKind = (kind: WidgetKind): CatalogItem | undefined =>
  widgetCatalog.find((c) => c.kind === kind);