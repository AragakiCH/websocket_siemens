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

  // Login - selección de marca (Siemens / Rexroth)
  'login.vendor': 'Marca del PLC',
  'login.vendorSiemens': 'Siemens',
  'login.vendorRexroth': 'Rexroth',
  'login.vendorSiemensHint': 'S7-1500 · OPC UA anónimo · Data Blocks',
  'login.vendorRexrothHint': 'ctrlX CORE · Requiere usuario y contraseña',
  'login.app': 'Aplicación',
  'login.program': 'Programa',
  'login.search': 'Buscar',
  'login.searching': 'Buscando…',
  'login.selectApp': 'Seleccione una aplicación…',
  'login.selectProgram': 'Seleccione un programa…',
  'login.appsFound': 'aplicación(es) encontrada(s)',
  'login.programsFound': 'programa(s) encontrado(s)',
  'login.needCreds': 'Ingrese IP, usuario y contraseña para buscar.',
  'login.needProgram': 'Seleccione un programa antes de conectar.',
  'login.searchHint': 'Pulse Buscar para listar lo publicado en el PLC.',
  'login.connectError': 'No se pudo agregar el PLC.',

  // ── Acceso a Psi Core (pantalla Login / Registro) ────────────
  'auth.brandTagline':
  'Supervisión, historización y diseño de pantallas para tus PLC, en un solo lugar.',
  'auth.feat1Title': 'Datos en vivo',
  'auth.feat1Desc': 'Lectura por OPC UA y difusión por WebSocket, sin recargar.',
  'auth.feat2Title': 'Historización',
  'auth.feat2Desc': 'Guarda cada cambio en MySQL, PostgreSQL o SQL Server.',
  'auth.feat3Title': 'Multimarca',
  'auth.feat3Desc': 'Siemens S7-1500 y Bosch Rexroth ctrlX CORE a la vez.',

  'auth.tabsLabel': 'Acceder o crear cuenta',
  'auth.tabLogin': 'Entrar',
  'auth.tabSignup': 'Crear cuenta',
  'auth.loginTitle': 'Bienvenido de vuelta',
  'auth.loginSubtitle': 'Ingresa tus credenciales para continuar.',
  'auth.signupTitle': 'Crear una cuenta',
  'auth.signupSubtitle': 'Completa los datos del nuevo usuario.',

  'auth.user': 'Usuario',
  'auth.userPlaceholder': 'operador01',
  'auth.email': 'Correo electrónico',
  'auth.emailHint': 'Opcional. Se usa para recuperar la contraseña.',
  'auth.password': 'Contraseña',
  'auth.confirm': 'Confirmar contraseña',
  'auth.category': 'Categoría',
  'auth.status': 'Estado',
  'auth.accessLegend': 'Permisos de la cuenta',
  'auth.algoNote':
  'El algoritmo de hash lo elige el servidor al guardar. La contraseña nunca se almacena en claro.',

  'auth.showPass': 'Mostrar contraseña',
  'auth.hidePass': 'Ocultar contraseña',
  'auth.remember': 'Mantener la sesión iniciada',
  'auth.forgot': '¿Olvidaste tu contraseña?',
  'auth.enterBtn': 'Entrar',
  'auth.entering': 'Entrando…',
  'auth.createBtn': 'Crear cuenta',
  'auth.creating': 'Creando…',
  'auth.noAccount': '¿No tienes cuenta?',
  'auth.haveAccount': '¿Ya tienes cuenta?',

  'auth.strength0': 'Contraseña débil',
  'auth.strength1': 'Contraseña aceptable',
  'auth.strength2': 'Contraseña buena',
  'auth.strength3': 'Contraseña fuerte',

  'auth.errUserRequired': 'Escribe tu usuario.',
  'auth.errUserShort': 'El usuario necesita al menos 3 caracteres.',
  'auth.errUserLong': 'El usuario no puede pasar de 80 caracteres.',
  'auth.errPassRequired': 'Escribe tu contraseña.',
  'auth.errPassShort': 'La contraseña necesita al menos 8 caracteres.',
  'auth.errConfirmRequired': 'Repite la contraseña.',
  'auth.errConfirmMismatch': 'Las contraseñas no coinciden.',
  'auth.errMailInvalid': 'Ese correo no tiene un formato válido.',
  'auth.errMailLong': 'El correo no puede pasar de 160 caracteres.',

  // ── Estado real del sistema de cuentas ──────────────────────
  'auth.checking': 'Comprobando el estado del sistema…',
  'auth.noBackend':
  'No se puede contactar con el servidor. Comprueba que el backend esté en marcha.',
  'auth.noDbTitle': 'No hay base de datos de cuentas',
  'auth.noDbBody':
  'Las cuentas viven en la tabla «usuarios» de una base de datos, y todavía no hay ninguna conectada. Da de alta la conexión y ejecuta el script del esquema antes de crear el primer acceso.',
  'auth.firstAccountTitle': 'Primera cuenta del sistema',
  'auth.firstAccountBody':
  'Todavía no existe ninguna cuenta. Esta se creará como Supervisor —hace falta un administrador inicial— y a partir de ahí solo un Supervisor podrá dar de alta a los demás.',
  'auth.categoryLocked': 'La primera cuenta es siempre Supervisor.',
  'auth.signupClosedTitle': 'El registro está cerrado',
  'auth.signupClosedBody':
  'Ya existe al menos una cuenta. Las nuevas las crea un Supervisor desde la gestión de usuarios; así nadie se da de alta solo con permisos que no le corresponden.',

  // ── Selector y badge de base de datos ───────────────────────
  'auth.dbPicker': 'Base de datos',
  'auth.dbPickerHint':
  'Cada base tiene sus propias cuentas: una creada aquí no existe en las demás. Se recuerda la última con la que entraste.',
  'auth.dbPickerOffline':
  'Esa base no responde ahora mismo. Entrar fallará hasta que vuelva.',
  'auth.dbLabel': 'Cuentas en',
  'auth.dbChange': 'Cambiar',
  'auth.dbOnline': 'conectada',
  'auth.dbOffline': 'sin conexión',
  'auth.dbNotFixed':
  'No hay PLC_AUTH_DB_ID en el .env: se está usando la primera conexión de la lista. Fíjala para que no cambie sola al agregar otra base.',
  'auth.dbUnknown': 'sin determinar',

  // ── Contraseña olvidada ─────────────────────────────────────
  'auth.forgotTitle': 'Recuperar el acceso',
  'auth.forgotBody':
  'No hay restablecimiento por correo: en un HMI de planta esa vía es un camino de entrada más. Pídele a un Supervisor que te asigne una contraseña nueva; al hacerlo se cierran todas tus sesiones abiertas.',
  'auth.forgotClose': 'Entendido',

  'auth.rememberHint':
  'Sin marcar, la sesión se cierra al cerrar la pestaña. Déjalo sin marcar en equipos compartidos.',

  'auth.devShortcut':
  'Atajo de desarrollo activo: el botón entra directo sin validar nada. Ponlo en false en ATAJO_DEV (Login.tsx) para probar el formulario.',

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
  'config.noPlc': 'Sin PLCs conectados — pulse el botón para agregar uno',
  'config.plcOnline': 'Conectado',
  'config.plcOffline': 'Desconectado',
  'config.addPlc': 'Agregar PLC',
  'config.removePlc': 'Eliminar PLC',
  'config.status': 'Estado',
  'config.readMode': 'Modo lectura',

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
  'insp.varsCompatible': 'Compatibles',
  'insp.varsOther': 'No recomendadas para este widget',
  'insp.varsCompatibleCount': 'variables compatibles',
  'insp.widgetAccepts': 'Este widget espera',
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

  // Login - vendor selection (Siemens / Rexroth)
  'login.vendor': 'PLC brand',
  'login.vendorSiemens': 'Siemens',
  'login.vendorRexroth': 'Rexroth',
  'login.vendorSiemensHint': 'S7-1500 · Anonymous OPC UA · Data Blocks',
  'login.vendorRexrothHint': 'ctrlX CORE · Username and password required',
  'login.app': 'Application',
  'login.program': 'Program',
  'login.search': 'Search',
  'login.searching': 'Searching…',
  'login.selectApp': 'Select an application…',
  'login.selectProgram': 'Select a program…',
  'login.appsFound': 'application(s) found',
  'login.programsFound': 'program(s) found',
  'login.needCreds': 'Enter IP, username and password to search.',
  'login.needProgram': 'Select a program before connecting.',
  'login.searchHint': 'Press Search to list what is published on the PLC.',
  'login.connectError': 'Could not add the PLC.',

  // ── Psi Core access (Login / Sign-up screen) ─────────────────
  'auth.brandTagline':
  'Monitoring, historization and screen design for your PLCs, all in one place.',
  'auth.feat1Title': 'Live data',
  'auth.feat1Desc': 'OPC UA polling broadcast over WebSocket, no page reloads.',
  'auth.feat2Title': 'Historization',
  'auth.feat2Desc': 'Store every change in MySQL, PostgreSQL or SQL Server.',
  'auth.feat3Title': 'Multi-vendor',
  'auth.feat3Desc': 'Siemens S7-1500 and Bosch Rexroth ctrlX CORE side by side.',

  'auth.tabsLabel': 'Sign in or create an account',
  'auth.tabLogin': 'Sign in',
  'auth.tabSignup': 'Create account',
  'auth.loginTitle': 'Welcome back',
  'auth.loginSubtitle': 'Enter your credentials to continue.',
  'auth.signupTitle': 'Create an account',
  'auth.signupSubtitle': 'Fill in the details for the new user.',

  'auth.user': 'Username',
  'auth.userPlaceholder': 'operator01',
  'auth.email': 'Email',
  'auth.emailHint': 'Optional. Used for password recovery.',
  'auth.password': 'Password',
  'auth.confirm': 'Confirm password',
  'auth.category': 'Category',
  'auth.status': 'Status',
  'auth.accessLegend': 'Account permissions',
  'auth.algoNote':
  'The hashing algorithm is chosen by the server on save. Passwords are never stored in plain text.',

  'auth.showPass': 'Show password',
  'auth.hidePass': 'Hide password',
  'auth.remember': 'Keep me signed in',
  'auth.forgot': 'Forgot your password?',
  'auth.enterBtn': 'Sign in',
  'auth.entering': 'Signing in…',
  'auth.createBtn': 'Create account',
  'auth.creating': 'Creating…',
  'auth.noAccount': "Don't have an account?",
  'auth.haveAccount': 'Already have an account?',

  'auth.strength0': 'Weak password',
  'auth.strength1': 'Fair password',
  'auth.strength2': 'Good password',
  'auth.strength3': 'Strong password',

  'auth.errUserRequired': 'Enter your username.',
  'auth.errUserShort': 'Username needs at least 3 characters.',
  'auth.errUserLong': 'Username cannot exceed 80 characters.',
  'auth.errPassRequired': 'Enter your password.',
  'auth.errPassShort': 'Password needs at least 8 characters.',
  'auth.errConfirmRequired': 'Repeat the password.',
  'auth.errConfirmMismatch': 'Passwords do not match.',
  'auth.errMailInvalid': 'That email address is not valid.',
  'auth.errMailLong': 'Email cannot exceed 160 characters.',

  'auth.checking': 'Checking system status…',
  'auth.noBackend':
  'Cannot reach the server. Check that the backend is running.',
  'auth.noDbTitle': 'No accounts database',
  'auth.noDbBody':
  'Accounts live in the "usuarios" table of a database, and none is connected yet. Register the connection and run the schema script before creating the first account.',
  'auth.firstAccountTitle': 'First account on the system',
  'auth.firstAccountBody':
  'No account exists yet. This one is created as Supervisor — an initial administrator is required — and from then on only a Supervisor can create the rest.',
  'auth.categoryLocked': 'The first account is always Supervisor.',
  'auth.signupClosedTitle': 'Sign-up is closed',
  'auth.signupClosedBody':
  'At least one account already exists. New ones are created by a Supervisor from user management, so nobody signs themselves up with permissions they should not have.',

  'auth.dbPicker': 'Database',
  'auth.dbPickerHint':
  'Each database has its own accounts: one created here does not exist in the others. The last one you signed in with is remembered.',
  'auth.dbPickerOffline':
  'That database is not responding right now. Signing in will fail until it is back.',
  'auth.dbLabel': 'Accounts in',
  'auth.dbChange': 'Change',
  'auth.dbOnline': 'connected',
  'auth.dbOffline': 'offline',
  'auth.dbNotFixed':
  'PLC_AUTH_DB_ID is not set in .env: the first connection in the list is being used. Pin it so it cannot change when another database is added.',
  'auth.dbUnknown': 'undetermined',

  'auth.forgotTitle': 'Recover access',
  'auth.forgotBody':
  'There is no email reset: on a plant HMI that path is one more way in. Ask a Supervisor to set a new password for you; doing so closes all your open sessions.',
  'auth.forgotClose': 'Got it',

  'auth.rememberHint':
  'Unchecked, the session ends when you close the tab. Leave it unchecked on shared machines.',

  'auth.devShortcut':
  'Dev shortcut enabled: the button goes straight through without validating anything. Set ATAJO_DEV to false in Login.tsx to test the form.',

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
  'config.noPlc': 'No PLCs connected — click the button to add one',
  'config.plcOnline': 'Online',
  'config.plcOffline': 'Offline',
  'config.addPlc': 'Add PLC',
  'config.removePlc': 'Remove PLC',
  'config.status': 'Status',
  'config.readMode': 'Read mode',

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
  'insp.varsCompatible': 'Compatible',
  'insp.varsOther': 'Not recommended for this widget',
  'insp.varsCompatibleCount': 'compatible variables',
  'insp.widgetAccepts': 'This widget expects',
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