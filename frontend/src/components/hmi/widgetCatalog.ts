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
  ImageIcon,
  type LucideIcon } from
'lucide-react';
import { WidgetKind } from '../../models/widget';
import { DataType } from '../../models/plc';
import {
  NUMERICOS,
  BOOLEANO,
  CUALQUIERA,
  NINGUNO,
} from '../../utils/widgetBinding';
import { customWidgets } from './custom/registry';
import { loadZipWidgets, fullKind } from '../../services/zipWidgetLoader';
import { PuzzleIcon } from 'lucide-react';

export interface CatalogItem {
  kind: WidgetKind;
  label: string;
  icon: LucideIcon;
  defaultWidth: number;
  defaultHeight: number;
  category: 'Básicos' | 'Indicadores' | 'Equipos' | 'Datos';
  /**
   * Tipos de variable que este widget sabe representar.
   *
   *   NUMERICOS  -> ['int','double']  magnitudes: tanque, medidor, gráfica
   *   BOOLEANO   -> ['bool']          encendido/apagado: LED, lámpara, motor
   *   CUALQUIERA -> los cuatro        el texto imprime lo que sea
   *   NINGUNO    -> []                decorativo, no lee variables
   *
   * `undefined` significa "sin declarar" y se trata como si aceptara todo.
   * Solo pasa con widgets ZIP subidos antes de que existiera este campo; los
   * del catálogo lo declaran todos.
   */
  accepts?: DataType[];
}

// Widgets built-in del sistema (los 18 originales).
const builtInCatalog: CatalogItem[] = [
{
  kind: 'text',
  label: 'Texto',
  icon: TypeIcon,
  defaultWidth: 140,
  defaultHeight: 40,
  category: 'Básicos',
  // imprime el valor formateado, sea el que sea
  accepts: CUALQUIERA
},
{
  kind: 'button',
  label: 'Botón',
  icon: MousePointerClickIcon,
  defaultWidth: 140,
  defaultHeight: 44,
  category: 'Básicos',
  // acciona un encendido/apagado
  accepts: BOOLEANO
},
{
  kind: 'rectangle',
  label: 'Rectángulo',
  icon: SquareIcon,
  defaultWidth: 160,
  defaultHeight: 100,
  category: 'Básicos',
  // forma decorativa
  accepts: NINGUNO
},
{
  kind: 'circle',
  label: 'Círculo',
  icon: CircleIcon,
  defaultWidth: 100,
  defaultHeight: 100,
  category: 'Básicos',
  // forma decorativa
  accepts: NINGUNO
},
{
  kind: 'line',
  label: 'Línea',
  icon: MinusIcon,
  defaultWidth: 160,
  defaultHeight: 8,
  category: 'Básicos',
  // forma decorativa
  accepts: NINGUNO
},
{
  kind: 'tank',
  label: 'Tanque',
  icon: CylinderIcon,
  defaultWidth: 110,
  defaultHeight: 160,
  category: 'Indicadores',
  // dibuja un nivel de llenado
  accepts: NUMERICOS
},
{
  kind: 'led',
  label: 'Indicador LED',
  icon: RadioIcon,
  defaultWidth: 90,
  defaultHeight: 90,
  category: 'Indicadores',
  // encendido o apagado
  accepts: BOOLEANO
},
{
  kind: 'gaugeCircular',
  label: 'Medidor Circular',
  icon: GaugeIcon,
  defaultWidth: 160,
  defaultHeight: 160,
  category: 'Indicadores',
  // aguja sobre una escala
  accepts: NUMERICOS
},
{
  kind: 'gaugeLinear',
  label: 'Medidor Lineal',
  icon: RulerIcon,
  defaultWidth: 200,
  defaultHeight: 64,
  category: 'Indicadores',
  // aguja sobre una escala
  accepts: NUMERICOS
},
{
  kind: 'progress',
  label: 'Barra de Progreso',
  icon: BarChart3Icon,
  defaultWidth: 200,
  defaultHeight: 44,
  category: 'Indicadores',
  // porcentaje de avance
  accepts: NUMERICOS
},
{
  kind: 'switch',
  label: 'Switch',
  icon: ToggleRightIcon,
  defaultWidth: 90,
  defaultHeight: 48,
  category: 'Indicadores',
  // dos estados
  accepts: BOOLEANO
},
{
  kind: 'lamp',
  label: 'Lámpara',
  icon: LightbulbIcon,
  defaultWidth: 90,
  defaultHeight: 90,
  category: 'Indicadores',
  // encendida o apagada
  accepts: BOOLEANO
},
{
  kind: 'motor',
  label: 'Motor',
  icon: FanIcon,
  defaultWidth: 120,
  defaultHeight: 120,
  category: 'Equipos',
  // en marcha o detenido
  accepts: BOOLEANO
},
{
  kind: 'pump',
  label: 'Bomba',
  icon: DropletsIcon,
  defaultWidth: 120,
  defaultHeight: 120,
  category: 'Equipos',
  // en marcha o detenida
  accepts: BOOLEANO
},
{
  kind: 'valve',
  label: 'Válvula',
  icon: GitCommitVerticalIcon,
  defaultWidth: 120,
  defaultHeight: 100,
  category: 'Equipos',
  // abierta o cerrada
  accepts: BOOLEANO
},
{
  kind: 'sensor',
  label: 'Sensor',
  icon: RadioIcon,
  defaultWidth: 120,
  defaultHeight: 100,
  category: 'Equipos',
  // muestra una lectura
  accepts: NUMERICOS
},
// FUERA DEL CATÁLOGO: el widget 'chart'.
//
// Nunca graficó nada. Dibujaba una onda seno calculada a partir de `frac`
// (ver MiniChart en WidgetRenderer), o sea decoración con pinta de gráfico.
// Lo reemplaza «Tendencia» (custom:trend), que sí dibuja variables reales
// contra el tiempo y admite varias a la vez.
//
// El `case "chart"` del renderizador SE QUEDA a propósito: un diseño guardado
// de antes puede tener uno colocado, y quitarlo dejaría un hueco vacío sin
// explicación. Ya no se puede agregar, pero los que existan se siguen viendo.
{
  kind: 'image',
  label: 'Imagen',
  icon: ImageIcon,
  defaultWidth: 160,
  defaultHeight: 120,
  category: 'Datos',
  // decorativa
  accepts: NINGUNO
}];

/**
 * Widgets escritos en TSX (`custom/registry.ts`), declarados acá a propósito.
 *
 * Podrían llevar el campo dentro de `CustomWidgetDef`, pero entonces habría
 * TRES sitios donde buscar qué acepta un widget. Manteniéndolo acá quedan
 * solo dos: este archivo para todo lo que ya viene con la app, y el
 * widget.json para lo que sube el usuario.
 *
 * Un kind que no aparezca en este mapa queda `undefined` = acepta todo.
 */
const ACCEPTS_TSX: Record<string, DataType[]> = {
  // Un motor se representa en marcha o detenido.
  'custom:motor-hidraulico': BOOLEANO,
  // Los dos de navegación no leen variables del PLC: su estado es qué vista
  // está abierta, no un valor de proceso.
  'custom:sidebar-navegacion': NINGUNO,
  'custom:pantalla-screen': NINGUNO,
  // La Tendencia no usa el campo «Variable asociada»: lleva su propia lista
  // de series en el Inspector, porque necesita varias a la vez.
  'custom:trend': NINGUNO,
  // El Contenedor solo agrupa y mueve. No representa ningún valor, así
  // que ofrecerle «Variable asociada» sería ofrecer algo que no hace nada.
  'custom:contenedor': NINGUNO,
  // Es un display de una magnitud: enteros y decimales. Un bool o un
  // string se pintarían igual, pero «ON km/h» no significa nada.
  'custom:valor-unidad': NUMERICOS,
};

// Catálogo completo = built-in + custom TSX + custom ZIP (HTML).
// Se regenera cada vez que se llama para capturar ZIPs recién cargados.
export function getWidgetCatalog(): CatalogItem[] {
  const zipItems: CatalogItem[] = loadZipWidgets().map((z) => ({
    kind: fullKind(z.meta.kind) as WidgetKind,
    label: z.meta.label,
    icon: PuzzleIcon,
    defaultWidth: z.meta.defaultWidth,
    defaultHeight: z.meta.defaultHeight,
    category: z.meta.category,
    // Viene del widget.json. `undefined` si el ZIP se subió antes de que el
    // campo existiera: se trata como "acepta todo" y no se le rompe nada.
    accepts: z.meta.accepts,
  }));
  return [
    ...builtInCatalog,
    // Los retirados no se ofrecen, pero siguen dibujándose donde ya
    // estaban: ver `oculto` en custom/types.ts.
    ...customWidgets.filter((w) => !w.oculto).map((w) => ({
      kind: w.kind as WidgetKind,
      label: w.label,
      icon: w.icon,
      defaultWidth: w.defaultWidth,
      defaultHeight: w.defaultHeight,
      category: w.category,
      accepts: ACCEPTS_TSX[w.kind],
    })),
    ...zipItems,
  ];
}

/** Compat: referencia estática (sin ZIP dinámicos). Usar getWidgetCatalog() para incluir ZIPs. */
export const widgetCatalog = getWidgetCatalog();

export const catalogByKind = (kind: WidgetKind): CatalogItem | undefined =>
  getWidgetCatalog().find((c) => c.kind === kind);