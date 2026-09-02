; ======================================================================
;  instalador.iss  ·  Instalador de Psi Core para Windows (Inno Setup 6)
;
;  Genera  dist\PsiCore_Setup_<version>.exe : un único archivo que se le
;  pasa a cualquier equipo y se instala con doble clic.
;
;  ACTUALIZAR SIN PERDER NADA
;
;    Este instalador distingue cuatro situaciones y actúa distinto en cada
;    una. La lógica está en la sección [Code], al final:
;
;      NUEVA          No había nada. Instalación normal.
;      ACTUALIZACIÓN  Hay una versión anterior -> se respalda la carpeta de
;                     datos, se cierra el programa si está abierto, se
;                     limpian los ficheros de la versión vieja y se instala
;                     la nueva. Los datos NO se tocan.
;      REINSTALACIÓN  Misma versión. Se avisa y se repara la instalación.
;      DOWNGRADE      Se intenta instalar una versión MÁS ANTIGUA que la
;                     instalada. Se avisa y se pide confirmación: los datos
;                     de una versión nueva pueden tener un formato que la
;                     vieja no entienda.
;
;  QUÉ SE CONSERVA SIEMPRE, PASE LO QUE PASE
;
;    C:\ProgramData\PsiCore\datos  ->  PLCs, pantallas, widgets, conexiones,
;    cuentas, alarmas, recetas, auditoría y el .clave del cifrado.
;
;    Esa carpeta no aparece en [Files] ni en [UninstallDelete]. El instalador
;    solo la CREA si no existe y le pone permisos. Nunca la sobrescribe.
;
;    El `.env` va con `onlyifdoesntexist`: se pone el de ejemplo en una
;    instalación nueva, y en una actualización se respeta el que ya hay
;    (que tiene la API key y la cadena de conexión del cliente).
;
;  REQUISITOS PARA COMPILARLO
;    Inno Setup 6:  https://jrsoftware.org/isdl.php
;    Antes, generar el programa:  desktop\build_exe.bat
;
;  Compilar:  "C:\Program Files (x86)\Inno Setup 6\ISCC.exe" desktop\instalador.iss
; ======================================================================

#define MiNombre      "Psi Core"

; La versión la pasa build_exe.bat desde el fichero VERSION de la raíz:
;     ISCC.exe /DMiVersion=1.2.0 desktop\instalador.iss
; Así el instalador, el .exe y la API no pueden decir versiones distintas —
; y si se descuadraran, la detección de "¿es actualización?" mentiría.
; El valor de abajo es solo el respaldo para compilar el .iss suelto.
#ifndef MiVersion
  #define MiVersion   "1.1.0"
#endif
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

; --- Actualización segura -------------------------------------------------
; Windows escribe estos datos en las propiedades del .exe. Sirven para que
; el propio Windows compare versiones y para que el usuario vea qué está
; ejecutando antes de abrirlo.
VersionInfoVersion={#MiVersion}
VersionInfoCompany={#MiEmpresa}
VersionInfoProductName={#MiNombre}
VersionInfoDescription=Instalador de {#MiNombre}

; Si Psi Core está abierto, sus ficheros están BLOQUEADOS por Windows y la
; actualización dejaría una instalación a medias: unos ficheros nuevos y
; otros viejos. Con esto, el instalador detecta el programa en marcha, pide
; cerrarlo y lo vuelve a abrir al terminar.
CloseApplications=yes
CloseApplicationsFilter=*.exe,*.dll,*.pyd
RestartApplications=yes

; Al desinstalar antes de reinstalar, no preguntar de nuevo por la carpeta.
UsePreviousAppDir=yes
UsePreviousGroup=yes
UsePreviousTasks=yes

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
;
; `uninsneveruninstall` lo deja explícito: ni el desinstalador ni una
; actualización tocan estas carpetas.
Name: "{#MiCarpetaDatos}"; Permissions: users-modify; Flags: uninsneveruninstall
Name: "{#MiCarpetaDatos}\datos"; Permissions: users-modify; Flags: uninsneveruninstall
Name: "{#MiCarpetaDatos}\copias"; Permissions: users-modify; Flags: uninsneveruninstall

[Icons]
Name: "{group}\{#MiNombre}"; Filename: "{app}\{#MiExe}"
Name: "{group}\Carpeta de datos"; Filename: "{#MiCarpetaDatos}\datos"
Name: "{group}\Copias de seguridad"; Filename: "{#MiCarpetaDatos}\copias"
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
Type: filesandordirs; Name: "{app}\_internal"

[Messages]
es.WelcomeLabel2=Se instalará [name/ver] en este equipo.%n%nLos datos (PLCs, pantallas, widgets, conexiones y cuentas) se guardan en C:\ProgramData\PsiCore\datos y NO se borran al desinstalar ni al actualizar.

; ======================================================================
;  Lógica de actualización
; ======================================================================
[Code]

var
  VersionAnterior: String;   { '' si es una instalación nueva }
  EsActualizacion: Boolean;
  CarpetaAnterior: String;

  { Páginas para elegir el papel de este equipo. Ver ConfigurarPaginas(). }
  PaginaModo: TInputOptionWizardPage;
  PaginaServidor: TInputQueryWizardPage;

{ ---------------------------------------------------------------------
  Lee del registro los datos de una instalación previa.
  Inno guarda cada programa bajo su AppId + '_is1'. Se mira en las dos
  vistas del registro (64 y 32 bits) porque una instalación antigua pudo
  hacerse con un instalador de 32 bits.
  --------------------------------------------------------------------- }
function LeerInstalacionPrevia(var Version, Carpeta: String): Boolean;
var
  Clave: String;
begin
  Clave := 'SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\' +
           '{8F3C1A94-7B2E-4E6D-9E11-6C2A7D40B913}_is1';

  Result := RegQueryStringValue(HKLM64, Clave, 'DisplayVersion', Version);
  if Result then
    RegQueryStringValue(HKLM64, Clave, 'InstallLocation', Carpeta)
  else
  begin
    Result := RegQueryStringValue(HKLM32, Clave, 'DisplayVersion', Version);
    if Result then
      RegQueryStringValue(HKLM32, Clave, 'InstallLocation', Carpeta);
  end;
end;

{ Compara '1.2.3' con '1.10.0' NUMÉRICAMENTE.
  Comparar versiones como texto es un error clásico: '1.9' saldría mayor
  que '1.10' porque '9' > '1'. Devuelve <0, 0 o >0. }
function CompararVersiones(A, B: String): Integer;
var
  NumA, NumB: Integer;
  ParteA, ParteB: String;
  P: Integer;
begin
  Result := 0;
  while (Result = 0) and ((A <> '') or (B <> '')) do
  begin
    P := Pos('.', A);
    if P > 0 then begin ParteA := Copy(A, 1, P - 1); A := Copy(A, P + 1, Length(A)); end
    else begin ParteA := A; A := ''; end;

    P := Pos('.', B);
    if P > 0 then begin ParteB := Copy(B, 1, P - 1); B := Copy(B, P + 1, Length(B)); end
    else begin ParteB := B; B := ''; end;

    NumA := StrToIntDef(ParteA, 0);
    NumB := StrToIntDef(ParteB, 0);
    if NumA > NumB then Result := 1
    else if NumA < NumB then Result := -1;
  end;
end;

{ ---------------------------------------------------------------------
  Antes de tocar nada: detectar qué hay y explicárselo al usuario.
  --------------------------------------------------------------------- }
function InitializeSetup(): Boolean;
var
  Comparacion: Integer;
  Mensaje: String;
begin
  Result := True;
  EsActualizacion := False;
  VersionAnterior := '';
  CarpetaAnterior := '';

  if not LeerInstalacionPrevia(VersionAnterior, CarpetaAnterior) then
    Exit;   { instalación nueva: nada que avisar }

  EsActualizacion := True;
  Comparacion := CompararVersiones('{#MiVersion}', VersionAnterior);

  if Comparacion > 0 then
  begin
    { --- ACTUALIZACIÓN normal --- }
    Mensaje := 'Psi Core ' + VersionAnterior + ' ya está instalado en este equipo.' + #13#10 + #13#10 +
               'Se actualizará a la versión {#MiVersion}.' + #13#10 + #13#10 +
               'SE CONSERVA todo lo que hay configurado:' + #13#10 +
               '   - PLCs dados de alta' + #13#10 +
               '   - Pantallas del diseñador y widgets importados' + #13#10 +
               '   - Conexiones a base de datos y cuentas de usuario' + #13#10 +
               '   - Alarmas, recetas y auditoría' + #13#10 +
               '   - El archivo .env con la configuración' + #13#10 + #13#10 +
               'Antes de empezar se guardará una copia de seguridad en:' + #13#10 +
               ExpandConstant('{commonappdata}\PsiCore\copias') + #13#10 + #13#10 +
               '¿Continuar?';
    Result := MsgBox(Mensaje, mbConfirmation, MB_YESNO) = IDYES;
  end
  else if Comparacion = 0 then
  begin
    { --- REINSTALACIÓN de la misma versión --- }
    Mensaje := 'La versión {#MiVersion} ya está instalada.' + #13#10 + #13#10 +
               'Al continuar se repararán los archivos del programa. ' +
               'Los datos y la configuración no se tocan.' + #13#10 + #13#10 +
               '¿Continuar?';
    Result := MsgBox(Mensaje, mbConfirmation, MB_YESNO) = IDYES;
  end
  else
  begin
    { --- DOWNGRADE: instalar una versión MÁS VIEJA ---
      Esto sí es peligroso y hay que decirlo claro. Los datos escritos por
      una versión nueva pueden tener campos que la vieja no entienda. }
    Mensaje := 'ATENCIÓN: en este equipo está instalada la versión ' +
               VersionAnterior + ', que es MÁS NUEVA que la ' +
               '{#MiVersion} que intentas instalar.' + #13#10 + #13#10 +
               'Volver a una versión anterior puede dar problemas: los ' +
               'datos guardados por la versión nueva pueden tener un ' +
               'formato que la antigua no sepa leer.' + #13#10 + #13#10 +
               'Se hará una copia de seguridad igualmente, pero solo ' +
               'deberías continuar si sabes lo que haces.' + #13#10 + #13#10 +
               '¿Instalar la versión antigua de todas formas?';
    Result := MsgBox(Mensaje, mbError, MB_YESNO or MB_DEFBUTTON2) = IDYES;
  end;
end;

{ ---------------------------------------------------------------------
  Copia de seguridad de la carpeta de datos.
  Se hace ANTES de copiar un solo fichero nuevo. Si la actualización sale
  mal, la configuración de la planta sigue estando.
  --------------------------------------------------------------------- }
procedure RespaldarDatos();
var
  Origen, Destino, Sello: String;
  Codigo: Integer;
begin
  Origen := ExpandConstant('{commonappdata}\PsiCore\datos');
  if not DirExists(Origen) then Exit;

  Sello := GetDateTimeString('yyyymmdd_hhnnss', '-', '-');
  Destino := ExpandConstant('{commonappdata}\PsiCore\copias\datos_' +
                            VersionAnterior + '_' + Sello);

  { robocopy /E copia el árbol entero. Se usa en vez de xcopy porque
    maneja bien rutas largas y no pregunta nada.
    Sus códigos de salida NO siguen la convención: 0-7 son éxito, 8+ error. }
  ForceDirectories(Destino);
  Exec(ExpandConstant('{cmd}'),
       '/C robocopy "' + Origen + '" "' + Destino + '" /E /R:1 /W:1 /NFL /NDL /NJH /NJS',
       '', SW_HIDE, ewWaitUntilTerminated, Codigo);

  if Codigo >= 8 then
    Log('AVISO: la copia de seguridad devolvió el código ' + IntToStr(Codigo))
  else
    Log('Copia de seguridad creada en ' + Destino);
end;

{ ---------------------------------------------------------------------
  Limpieza de la versión anterior.

  PyInstaller en modo carpeta mete todo en `_internal`. Al actualizar,
  Inno COPIA los ficheros nuevos pero NO borra los que ya no existen: si
  la versión vieja traía un .pyd o una DLL que la nueva ya no usa, se
  queda ahí para siempre. Además de ocupar sitio, puede hacer que Python
  cargue un módulo viejo en lugar del nuevo y provoque fallos rarísimos.

  Se borra SOLO `_internal` y los `__pycache__` — nunca el `.env`, ni la
  carpeta `sql`, ni por supuesto los datos.
  --------------------------------------------------------------------- }
procedure LimpiarVersionAnterior();
var
  Carpeta: String;
begin
  Carpeta := ExpandConstant('{app}');
  if not DirExists(Carpeta) then Exit;

  if DirExists(Carpeta + '\_internal') then
  begin
    Log('Limpiando _internal de la versión anterior');
    DelTree(Carpeta + '\_internal', True, True, True);
  end;
  if DirExists(Carpeta + '\__pycache__') then
    DelTree(Carpeta + '\__pycache__', True, True, True);
end;

{ =====================================================================
   EL PAPEL DE ESTE EQUIPO

   Psi Core es un único .exe con tres modos. La elección se guarda en
   psi_core.ini, junto al programa, y la lee desktop/psi_core.py.

   Preguntarlo AQUÍ y no dentro del programa es deliberado. Si cada
   equipo arranca en modo autónomo por defecto, cada uno se convierte en
   su propio servidor con su propia carpeta de datos, y los widgets y
   pantallas que configura una persona no aparecen para las demás. Eso
   no da ningún error: da un widget en blanco, que parece un fallo del
   programa y es una consecuencia de no haber decidido la topología.
   ===================================================================== }

{ Lee el modo de una instalación anterior para no perder la elección al
  actualizar. Devuelve '' si no hay nada que leer. }
function LeerModoAnterior(): String;
var
  Lineas: TArrayOfString;
  I: Integer;
  L: String;
begin
  Result := '';
  if CarpetaAnterior = '' then
    Exit;
  { LoadStringsFromFile parte el fichero en líneas por sí solo. Inno no tiene
    una función de split de cadenas, así que hacerlo a mano sobre el
    contenido completo sería reimplementarla sin necesidad. }
  if not LoadStringsFromFile(CarpetaAnterior + '\psi_core.ini', Lineas) then
    Exit;

  for I := 0 to GetArrayLength(Lineas) - 1 do
  begin
    L := Trim(Lineas[I]);
    { Se ignoran los comentarios: el .ini que se genera lleva la palabra
      'modo' dentro de su cabecera explicativa, y sin este filtro la
      primera coincidencia sería un comentario y no el valor real. }
    if (L <> '') and (L[1] <> ';') and (Pos('modo', Lowercase(L)) = 1) then
    begin
      Result := Trim(Copy(L, Pos('=', L) + 1, Length(L)));
      Exit;
    end;
  end;
end;

procedure ConfigurarPaginas();
var
  Anterior: String;
begin
  PaginaModo := CreateInputOptionPage(wpSelectTasks,
    'Papel de este equipo',
    '¿Cómo se va a usar Psi Core en este ordenador?',
    'Si sois varias personas, solo UN equipo debe ser el servidor: es el ' +
    'que guarda las pantallas, los widgets, las conexiones y el histórico. ' +
    'Los demás serán visores y verán exactamente lo mismo que él. Si este ' +
    'ordenador va a trabajar solo, elige "Equipo único".',
    True, False);

  { Las etiquetas van en UNA línea a propósito: los controles de esta página
    no ajustan el texto, y una descripción larga se cortaría a media frase.
    La explicación va arriba, en el subtítulo. }
  PaginaModo.Add('Equipo único — trabaja solo, no comparte nada');
  PaginaModo.Add('Servidor — guarda los datos y se los sirve a los demás');
  PaginaModo.Add('Visor — solo muestra lo que hay en el servidor');

  PaginaServidor := CreateInputQueryPage(PaginaModo.ID,
    'Dirección del servidor',
    '¿Dónde está el equipo que hace de servidor?',
    'El servidor muestra su dirección al arrancar, en la línea que dice ' +
    '"Visores". Cópiala aquí tal cual. Si te equivocas, se puede corregir ' +
    'después en psi_core.ini sin reinstalar.');
  PaginaServidor.Add('Dirección IP o nombre del equipo:', False);
  PaginaServidor.Add('Puerto:', False);
  PaginaServidor.Values[0] := '192.168.1.100';
  PaginaServidor.Values[1] := '8000';

  { Al actualizar se respeta lo que ya había: cambiar de modo por accidente
    en una actualización dejaría a ese equipo sin ver los datos del grupo. }
  Anterior := Lowercase(LeerModoAnterior());
  if Anterior = 'servidor' then
    PaginaModo.SelectedValueIndex := 1
  else if Anterior = 'visor' then
    PaginaModo.SelectedValueIndex := 2
  else
    PaginaModo.SelectedValueIndex := 0;
end;

procedure InitializeWizard();
begin
  ConfigurarPaginas();
end;

{ La página de la dirección solo tiene sentido en modo visor. }
function ShouldSkipPage(PageID: Integer): Boolean;
begin
  Result := False;
  if PageID = PaginaServidor.ID then
    Result := (PaginaModo.SelectedValueIndex <> 2);
end;

{ Escribe psi_core.ini con lo elegido. }
procedure GuardarModo();
var
  Ruta, Modo, Texto: String;
begin
  case PaginaModo.SelectedValueIndex of
    1: Modo := 'servidor';
    2: Modo := 'visor';
  else
    Modo := 'autonomo';
  end;

  Ruta := ExpandConstant('{app}\psi_core.ini');
  Texto :=
    '; Generado por el instalador de Psi Core {#MiVersion}.' + #13#10 +
    '; Se puede editar a mano; los cambios se aplican al reiniciar.' + #13#10 +
    '; Valores de modo:  autonomo | servidor | visor' + #13#10 +
    #13#10 +
    '[psi]' + #13#10 +
    'modo = ' + Modo + #13#10 +
    #13#10 +
    '[servidor]' + #13#10 +
    '; Solo se usa en modo visor: donde esta el servidor.' + #13#10 +
    'host = ' + Trim(PaginaServidor.Values[0]) + #13#10 +
    'puerto = ' + Trim(PaginaServidor.Values[1]) + #13#10;

  if not SaveStringToFile(Ruta, Texto, False) then
    MsgBox('No se pudo escribir ' + Ruta + '.' + #13#10 +
           'Psi Core arrancara en modo "equipo unico". Para cambiarlo, ' +
           'crea ese fichero a mano.', mbError, MB_OK);
end;

{ Punto de enganche: se ejecuta justo antes de copiar los ficheros. }
procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssInstall then
  begin
    if EsActualizacion then
    begin
      WizardForm.StatusLabel.Caption := 'Guardando copia de seguridad de los datos...';
      RespaldarDatos();
      WizardForm.StatusLabel.Caption := 'Limpiando la versión anterior...';
      LimpiarVersionAnterior();
    end;
  end;

  { Después de copiar: si se escribiera antes, [Files] lo sobrescribiría. }
  if CurStep = ssPostInstall then
    GuardarModo();
end;

{ ---------------------------------------------------------------------
  Mensaje final: distinto según haya sido instalación o actualización.
  --------------------------------------------------------------------- }
function NextButtonClick(CurPageID: Integer): Boolean;
var
  P: Integer;
begin
  Result := True;

  { Un visor sin dirección de servidor es un programa que no puede hacer
    nada. Se comprueba aquí y no al arrancar: corregirlo ahora son dos
    segundos, y descubrirlo mañana en la planta es una llamada de teléfono. }
  if CurPageID = PaginaServidor.ID then
  begin
    if Trim(PaginaServidor.Values[0]) = '' then
    begin
      MsgBox('Falta la dirección del servidor.' + #13#10 + #13#10 +
             'La muestra el propio servidor al arrancar, en la línea que ' +
             'empieza por "Visores".', mbError, MB_OK);
      Result := False;
      Exit;
    end;

    P := StrToIntDef(Trim(PaginaServidor.Values[1]), -1);
    if (P < 1) or (P > 65535) then
    begin
      MsgBox('El puerto debe ser un número entre 1 y 65535.' + #13#10 +
             'Si no lo has cambiado en el servidor, es 8000.',
             mbError, MB_OK);
      Result := False;
      Exit;
    end;
  end;

  if CurPageID = wpFinished then
  begin
    if EsActualizacion then
      MsgBox('Psi Core se ha actualizado a la versión {#MiVersion}.' + #13#10 + #13#10 +
             'Tu configuración sigue intacta. Si algo no fuera bien, hay ' +
             'una copia de los datos anteriores en:' + #13#10 +
             ExpandConstant('{commonappdata}\PsiCore\copias'),
             mbInformation, MB_OK);
  end;
end;

{ ---------------------------------------------------------------------
  Aviso al desinstalar. La pregunta "¿me borra esto la configuración?"
  tiene que responderse ANTES de pulsar, no después.
  --------------------------------------------------------------------- }
function InitializeUninstall(): Boolean;
begin
  MsgBox('Se va a quitar Psi Core de este equipo.' + #13#10 + #13#10 +
         'La carpeta de datos NO se borra:' + #13#10 +
         ExpandConstant('{commonappdata}\PsiCore\datos') + #13#10 + #13#10 +
         'Ahí siguen los PLCs, las pantallas, los widgets, las conexiones ' +
         'y las cuentas. Si instalas otra versión, los recupera solos. ' +
         'Para eliminarlos del todo, borra esa carpeta a mano.',
         mbInformation, MB_OK);
  Result := True;
end;
