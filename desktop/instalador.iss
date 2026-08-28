; ======================================================================
;  instalador.iss  ·  Instalador de Psi Core para Windows (Inno Setup 6)
;
;  Genera  dist\PsiCore_Setup_<version>.exe : un único archivo que se le
;  pasa a cualquier equipo y se instala con doble clic.
;
;  QUÉ HACE, Y POR QUÉ CADA COSA
;
;    * Instala en Archivos de programa. Es de solo lectura para el usuario,
;      que es lo correcto: ahí va el PROGRAMA.
;
;    * Crea C:\ProgramData\PsiCore\datos con permisos de escritura para
;      todos los usuarios del equipo. Ahí van los DATOS —PLCs, pantallas,
;      conexiones, cuentas— y por eso el desinstalador NO la toca. Sin este
;      paso, en un PC donde el operario no es administrador, el programa
;      arranca y pierde todo lo que se configure.
;
;    * Al desinstalar deja la carpeta de datos intacta y lo dice. Borrarla
;      sería la forma más rápida de perder la configuración de una planta
;      entera por actualizar de versión.
;
;  REQUISITOS PARA COMPILARLO
;    Inno Setup 6:  https://jrsoftware.org/isdl.php
;    Antes, generar el programa:  desktop\build_exe.bat
;
;  Compilar:  "C:\Program Files (x86)\Inno Setup 6\ISCC.exe" desktop\instalador.iss
; ======================================================================

#define MiNombre      "Psi Core"
#define MiVersion     "1.0.0"
#define MiEmpresa     "Psi Core"
#define MiExe         "PsiCore.exe"
#define MiCarpetaDatos "{commonappdata}\PsiCore"

[Setup]
; GUID propio de Psi Core. NO cambiarlo entre versiones: es lo
; que hace que instalar la 1.1 ACTUALICE la 1.0 en vez de dejar
; dos programas distintos en la lista de aplicaciones.
AppId={{8F3C1A94-7B2E-4E6D-9E11-6C2A7D40B913}
AppName={#MiNombre}
AppVersion={#MiVersion}
AppPublisher={#MiEmpresa}
DefaultDirName={autopf}\{#MiNombre}
DefaultGroupName={#MiNombre}
; El desinstalador queda en Configuración -> Aplicaciones, como cualquier
; programa serio. Sin esto, quitarlo es borrar una carpeta a mano.
UninstallDisplayName={#MiNombre} {#MiVersion}
UninstallDisplayIcon={app}\{#MiExe}
OutputDir=..\dist
OutputBaseFilename=PsiCore_Setup_{#MiVersion}
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
; Hace falta administrador para escribir en Archivos de programa y para
; crear la carpeta de datos común con permisos para todos.
PrivilegesRequired=admin
; Psi Core es de 64 bits (Python, WebView2 y el driver ODBC lo son).
ArchitecturesInstallIn64BitMode=x64compatible
ArchitecturesAllowed=x64compatible
DisableProgramGroupPage=yes
LicenseFile=
SetupLogging=yes

[Languages]
Name: "es"; MessagesFile: "compiler:Languages\Spanish.isl"

[Tasks]
Name: "escritorio"; Description: "Crear un acceso directo en el Escritorio"; \
    GroupDescription: "Accesos directos:"; Flags: checkedonce
Name: "inicio"; Description: "Arrancar Psi Core al iniciar sesión en Windows"; \
    GroupDescription: "Opciones:"; Flags: unchecked

[Files]
; Todo lo que produjo PyInstaller en modo carpeta.
Source: "..\dist\PsiCore\*"; DestDir: "{app}"; \
    Flags: ignoreversion recursesubdirs createallsubdirs

; El .env de EJEMPLO, nunca el real: `onlyifdoesntexist` evita pisar la
; configuración de una instalación anterior al actualizar de versión.
Source: "..\.env.example"; DestDir: "{app}"; DestName: ".env"; \
    Flags: onlyifdoesntexist

; Los .sql del esquema, para quien prefiera crear la base desde SSMS.
Source: "..\sql\*.sql"; DestDir: "{app}\sql"; Flags: ignoreversion skipifsourcedoesntexist

[Dirs]
; La carpeta de datos, con escritura para todos los usuarios del equipo.
;
; Es la línea que evita el fallo más silencioso de todos: sin ella, en un PC
; donde quien trabaja no es administrador, Psi Core arranca perfectamente y
; pierde cada cambio al cerrar, sin un solo mensaje de error.
Name: "{#MiCarpetaDatos}"; Permissions: users-modify
Name: "{#MiCarpetaDatos}\datos"; Permissions: users-modify

[Icons]
Name: "{group}\{#MiNombre}"; Filename: "{app}\{#MiExe}"
Name: "{group}\Carpeta de datos"; Filename: "{#MiCarpetaDatos}\datos"
Name: "{group}\Desinstalar {#MiNombre}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#MiNombre}"; Filename: "{app}\{#MiExe}"; Tasks: escritorio
Name: "{userstartup}\{#MiNombre}"; Filename: "{app}\{#MiExe}"; Tasks: inicio

[Run]
Filename: "{app}\{#MiExe}"; Description: "Abrir {#MiNombre} ahora"; \
    Flags: nowait postinstall skipifsilent

[UninstallDelete]
; Solo lo que genera el propio programa DENTRO de Archivos de programa.
; La carpeta de datos NO aparece aquí, y es deliberado.
Type: filesandordirs; Name: "{app}\__pycache__"

[Messages]
es.WelcomeLabel2=Se instalará [name/ver] en este equipo.%n%nLos datos (PLCs, pantallas, conexiones y cuentas) se guardan en C:\ProgramData\PsiCore\datos y NO se borran al desinstalar ni al actualizar.

[Code]
{ Aviso al desinstalar. La pregunta "¿me borra esto la configuración?" tiene
  que responderse ANTES de pulsar, no después. }
function InitializeUninstall(): Boolean;
begin
  MsgBox('Se va a quitar Psi Core de este equipo.' + #13#10 + #13#10 +
         'La carpeta de datos NO se borra:' + #13#10 +
         ExpandConstant('{commonappdata}\PsiCore\datos') + #13#10 + #13#10 +
         'Ahí siguen los PLCs, las pantallas, las conexiones y las cuentas. ' +
         'Si instalas otra versión, los recupera solos. Para eliminarlos ' +
         'del todo, borra esa carpeta a mano.',
         mbInformation, MB_OK);
  Result := True;
end;
