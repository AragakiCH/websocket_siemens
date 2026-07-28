import { Language } from '../models/plc';
import { WidgetKind } from '../models/widget';

// Central translation dictionary. Every user-visible string in the app is
// keyed here so the ES/EN toggle in Configuración switches the whole UI.

type Dict = Record<string, string>;

const es: Dict = {
  // Login
  'login.subtitle': 'Conéctese a su controlador para comenzar',
  'login.ip': 'Dirección IP del PLC',
  'login.user': 'Usuario',
  'login.password': 'Contraseña',
  'login.connect': 'Conectar',
  'login.connecting': 'Conectando…',
  'login.emulated': 'Entorno emulado · Sin comunicación real con PLC',

  // Main menu
  'menu.connectedTo': 'Conectado a',
  'menu.logout': 'Salir',
  'menu.title': '¿Qué desea hacer?',
  'menu.subtitle': 'Seleccione un módulo para continuar',
  'menu.configTitle': 'Configuración',
  'menu.configDesc':
  'Prepare las variables del PLC y ajustes generales del sistema.',
  'menu.mainTitle': 'Vista Principal',
  'menu.mainDesc': 'Diseñe su pantalla HMI con widgets y datos en tiempo real.',
  'menu.open': 'Abrir',

  // Config
  'config.title': 'Configuración',
  'config.subtitle':
  'Prepare las variables que estarán disponibles en el diseñador',
  'config.save': 'Guardar Configuración',
  'config.variables': 'Variables del PLC',
  'config.selected': 'seleccionadas',
  'config.colName': 'Nombre',
  'config.colType': 'Tipo',
  'config.colValue': 'Valor',
  'config.general': 'Configuración general',
  'config.updateRate': 'Frecuencia de actualización',
  'config.theme': 'Tema',
  'config.themeLight': 'Claro',
  'config.themeDark': 'Oscuro',
  'config.themeAuto': 'Automático',
  'config.language': 'Idioma',
  'config.langEs': 'Español',
  'config.langEn': 'Inglés',
  'config.onlySelected':
  'Solo las variables seleccionadas estarán disponibles en la',
  'config.mainView': 'Vista Principal',
  'config.saved': 'Configuración guardada correctamente',
  'config.selectVar': 'Seleccionar',
  'config.plcConnection': 'Conexión PLC',
  'config.noPlc': 'Sin PLCs conectados — agregue uno desde el backend',
  'config.plcOnline': 'Conectado',
  'config.plcOffline': 'Desconectado',

  // Rate options
  'rate.1000': '1 segundo',
  'rate.2000': '2 segundos',
  'rate.5000': '5 segundos',

  // Designer
  'designer.title': 'Diseñador HMI',
  'designer.mainView': 'Vista Principal',
  'designer.live': 'En vivo',
  'designer.widgets': 'widgets',
  'designer.clear': 'Limpiar',
  'designer.dragHere': 'Arrastre widgets aquí',
  'designer.designHint': 'Diseñe su pantalla HMI',

  // Sidebar
  'sidebar.title': 'Widgets',
  'sidebar.hint': 'Arrastre al lienzo',
  'sidebar.uploadZip': 'Cargar widget (.zip)',
  'sidebar.removeWidget': 'Eliminar widget',
  'cat.Básicos': 'Básicos',
  'cat.Indicadores': 'Indicadores',
  'cat.Equipos': 'Equipos',
  'cat.Datos': 'Datos',

  // Inspector
  'insp.title': 'Propiedades',
  'insp.delete': 'Eliminar',
  'insp.identity': 'Identidad',
  'insp.name': 'Nombre',
  'insp.text': 'Texto',
  'insp.binding': 'Vínculo de datos',
  'insp.associatedVar': 'Variable asociada',
  'insp.none': '— Ninguna —',
  'insp.varsAvailable': 'variables disponibles',
  'insp.geometry': 'Geometría',
  'insp.posX': 'Posición X',
  'insp.posY': 'Posición Y',
  'insp.width': 'Ancho',
  'insp.height': 'Alto',
  'insp.rotation': 'Rotación',
  'insp.appearance': 'Apariencia',
  'insp.color': 'Color',
  'insp.bgColor': 'Color de fondo',
  'insp.noBg': 'Sin fondo',
  'insp.borderColor': 'Color de borde',
  'insp.borderRadius': 'Radio de borde',
  'insp.borderWidth': 'Grosor de borde',
  'insp.opacity': 'Opacidad',
  'insp.textSize': 'Tamaño de texto',
  'insp.bold': 'Negrita',
  'insp.align': 'Alineación',
  'insp.alignLeft': 'Izquierda',
  'insp.alignCenter': 'Centro',
  'insp.alignRight': 'Derecha',
  'insp.state': 'Estado',
  'insp.visible': 'Visible',
  'insp.enabled': 'Habilitado',
  'insp.noSelection': 'Sin selección',
  'insp.noSelectionHint':
  'Seleccione un widget del lienzo para editar sus propiedades.'
};

const en: Dict = {
  'login.subtitle': 'Connect to your controller to get started',
  'login.ip': 'PLC IP Address',
  'login.user': 'Username',
  'login.password': 'Password',
  'login.connect': 'Connect',
  'login.connecting': 'Connecting…',
  'login.emulated': 'Emulated environment · No real PLC communication',

  'menu.connectedTo': 'Connected to',
  'menu.logout': 'Log out',
  'menu.title': 'What would you like to do?',
  'menu.subtitle': 'Select a module to continue',
  'menu.configTitle': 'Settings',
  'menu.configDesc': 'Prepare PLC variables and general system settings.',
  'menu.mainTitle': 'Main View',
  'menu.mainDesc': 'Design your HMI screen with widgets and live data.',
  'menu.open': 'Open',

  'config.title': 'Settings',
  'config.subtitle':
  'Prepare the variables that will be available in the designer',
  'config.save': 'Save Settings',
  'config.variables': 'PLC Variables',
  'config.selected': 'selected',
  'config.colName': 'Name',
  'config.colType': 'Type',
  'config.colValue': 'Value',
  'config.general': 'General settings',
  'config.updateRate': 'Update rate',
  'config.theme': 'Theme',
  'config.themeLight': 'Light',
  'config.themeDark': 'Dark',
  'config.themeAuto': 'System',
  'config.language': 'Language',
  'config.langEs': 'Spanish',
  'config.langEn': 'English',
  'config.onlySelected': 'Only selected variables will be available in the',
  'config.mainView': 'Main View',
  'config.saved': 'Settings saved successfully',
  'config.selectVar': 'Select',
  'config.plcConnection': 'PLC Connection',
  'config.noPlc': 'No PLCs connected — add one from the backend',
  'config.plcOnline': 'Online',
  'config.plcOffline': 'Offline',

  'rate.1000': '1 second',
  'rate.2000': '2 seconds',
  'rate.5000': '5 seconds',

  'designer.title': 'HMI Designer',
  'designer.mainView': 'Main View',
  'designer.live': 'Live',
  'designer.widgets': 'widgets',
  'designer.clear': 'Clear',
  'designer.dragHere': 'Drag widgets here',
  'designer.designHint': 'Design your HMI screen',

  'sidebar.title': 'Widgets',
  'sidebar.hint': 'Drag onto the canvas',
  'sidebar.uploadZip': 'Upload widget (.zip)',
  'sidebar.removeWidget': 'Remove widget',
  'cat.Básicos': 'Basic',
  'cat.Indicadores': 'Indicators',
  'cat.Equipos': 'Equipment',
  'cat.Datos': 'Data',

  'insp.title': 'Properties',
  'insp.delete': 'Delete',
  'insp.identity': 'Identity',
  'insp.name': 'Name',
  'insp.text': 'Text',
  'insp.binding': 'Data binding',
  'insp.associatedVar': 'Associated variable',
  'insp.none': '— None —',
  'insp.varsAvailable': 'variables available',
  'insp.geometry': 'Geometry',
  'insp.posX': 'Position X',
  'insp.posY': 'Position Y',
  'insp.width': 'Width',
  'insp.height': 'Height',
  'insp.rotation': 'Rotation',
  'insp.appearance': 'Appearance',
  'insp.color': 'Color',
  'insp.bgColor': 'Background color',
  'insp.noBg': 'No background',
  'insp.borderColor': 'Border color',
  'insp.borderRadius': 'Border radius',
  'insp.borderWidth': 'Border width',
  'insp.opacity': 'Opacity',
  'insp.textSize': 'Text size',
  'insp.bold': 'Bold',
  'insp.align': 'Alignment',
  'insp.alignLeft': 'Left',
  'insp.alignCenter': 'Center',
  'insp.alignRight': 'Right',
  'insp.state': 'State',
  'insp.visible': 'Visible',
  'insp.enabled': 'Enabled',
  'insp.noSelection': 'No selection',
  'insp.noSelectionHint':
  'Select a widget on the canvas to edit its properties.'
};

const dictionaries: Record<Language, Dict> = { es, en };

// Widget display labels per language (stored widget names are not translated).
const widgetLabels: Record<Language, Record<WidgetKind, string>> = {
  es: {
    text: 'Texto',
    button: 'Botón',
    rectangle: 'Rectángulo',
    circle: 'Círculo',
    line: 'Línea',
    tank: 'Tanque',
    led: 'Indicador LED',
    gaugeCircular: 'Medidor Circular',
    gaugeLinear: 'Medidor Lineal',
    progress: 'Barra de Progreso',
    switch: 'Switch',
    lamp: 'Lámpara',
    motor: 'Motor',
    pump: 'Bomba',
    valve: 'Válvula',
    sensor: 'Sensor',
    chart: 'Gráfico',
    image: 'Imagen'
  },
  en: {
    text: 'Text',
    button: 'Button',
    rectangle: 'Rectangle',
    circle: 'Circle',
    line: 'Line',
    tank: 'Tank',
    led: 'LED Indicator',
    gaugeCircular: 'Circular Gauge',
    gaugeLinear: 'Linear Gauge',
    progress: 'Progress Bar',
    switch: 'Switch',
    lamp: 'Lamp',
    motor: 'Motor',
    pump: 'Pump',
    valve: 'Valve',
    sensor: 'Sensor',
    chart: 'Chart',
    image: 'Image'
  }
};

export type TFn = (key: string) => string;

export const createTranslator =
(lang: Language): TFn =>
(key: string) =>
dictionaries[lang][key] ?? dictionaries.es[key] ?? key;

export const widgetLabel = (lang: Language, kind: WidgetKind): string =>
widgetLabels[lang][kind];