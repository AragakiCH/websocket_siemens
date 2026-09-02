@echo off
REM ======================================================================
REM build_exe.bat - Empaqueta Psi Core para instalarlo en otros equipos.
REM
REM   dist\PsiCore\PsiCore.exe        aplicacion de escritorio (carpeta)
REM   dist\PsiCore_portable.zip       version portable, sin instalar
REM   dist\PsiCore_Setup_<version>.exe instalador (si hay Inno Setup)
REM
REM Ejecutar desde la RAIZ del proyecto con el venv activo:
REM   desktop\build_exe.bat
REM ======================================================================
setlocal
cd /d "%~dp0.."

echo.
echo [1/5] Dependencias de empaquetado...
pip install pyinstaller pywebview >nul
if errorlevel 1 goto :error

echo [2/5] Compilando el frontend React...
REM  El 'set' de abajo NO puede ir dentro de un bloque entre parentesis:
REM  cmd.exe expande %errorlevel% al PARSEAR el bloque entero, no al ejecutar
REM  cada linea, asi que guardaria el valor de antes de lanzar npm. Por eso
REM  aqui se usa un salto y no un 'if ... ( ... )'.
if exist frontend\node_modules goto :hay_modules
echo    node_modules no existe: npm install...
pushd frontend
call npm install
set "NPM_ERR=%errorlevel%"
popd
if not "%NPM_ERR%"=="0" (
    echo    *** 'npm install' fallo con codigo %NPM_ERR%.
    goto :error
)
:hay_modules

REM  ATENCION AL 'popd' Y AL 'errorlevel'.
REM
REM  Esto antes era una sola linea encadenada con &&:
REM      pushd frontend ^&^& call npm run build ^&^& popd
REM  y tenia dos fallos que se tapaban entre si. Si npm fallaba, el popd nunca
REM  se ejecutaba (el && corta la cadena), asi que el script seguia dentro de
REM  frontend\ y el mensaje de error posterior apuntaba al sitio equivocado.
REM  Y el codigo de salida de npm no se miraba en ningun momento.
REM
REM  Consecuencia real: un build de React roto no detenia el empaquetado. Se
REM  generaba el .exe con el frontend de la vez ANTERIOR, sin un solo error
REM  visible, y se repartia a los equipos creyendo que llevaba los ultimos
REM  cambios.
pushd frontend
call npm run build
set "NPM_ERR=%errorlevel%"
popd
if not "%NPM_ERR%"=="0" (
    echo.
    echo    *** 'npm run build' fallo con codigo %NPM_ERR%.
    echo    *** SE ABORTA. Si continuara, empaquetaria el frontend de la vez
    echo    *** anterior y repartirias un .exe sin tus ultimos cambios.
    goto :error
)
if not exist frontend\dist\index.html (
    echo    *** El build de React no genero frontend\dist\index.html
    goto :error
)

REM  Segunda red de seguridad: ningun fuente puede ser mas nuevo que el bundle
REM  que se acaba de generar. Si lo es, npm dijo que todo fue bien pero no
REM  emitio esos cambios, y el .exe saldria viejo igualmente.
echo    Comprobando que el bundle incluye todos los fuentes...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$b = (Get-Item 'frontend\dist\index.html').LastWriteTime;" ^
  "$viejos = Get-ChildItem 'frontend\src' -Recurse -File -Include *.ts,*.tsx,*.js,*.jsx,*.css,*.svg -ErrorAction SilentlyContinue | Where-Object { $_.LastWriteTime -gt $b };" ^
  "if ($viejos) { Write-Host ''; Write-Host '   *** Estos fuentes son MAS NUEVOS que el bundle compilado:'; $viejos | ForEach-Object { Write-Host ('       ' + $_.FullName.Substring((Get-Location).Path.Length + 1)) }; exit 1 }; exit 0"
if errorlevel 1 (
    echo.
    echo    *** El bundle NO contiene esos cambios, asi que el .exe tampoco.
    echo    *** Revisa la salida de 'npm run build' mas arriba.
    goto :error
)

echo [3/5] Generando PsiCore.exe...
REM Modo CARPETA, no un solo archivo: un onefile se descomprime entero en
REM %TEMP% en cada arranque (5-15 s) y algunos antivirus lo marcan por eso.
pyinstaller desktop\psi_core.spec --noconfirm --distpath dist --workpath build
if errorlevel 1 goto :error
if not exist dist\PsiCore\PsiCore.exe goto :error

echo [4/5] Empaquetando la version portable (ZIP)...
if exist dist\PsiCore_portable.zip del /q dist\PsiCore_portable.zip
powershell -NoProfile -Command ^
  "Compress-Archive -Path 'dist\PsiCore\*' -DestinationPath 'dist\PsiCore_portable.zip' -Force"
if errorlevel 1 echo    (aviso: no se pudo crear el ZIP, se continua)

echo [5/5] Generando el instalador...
REM Fuente unica de la version: el fichero VERSION de la raiz. Se la pasamos
REM al compilador para que el instalador y la aplicacion no se descuadren.
set "PSI_VERSION=1.1.0"
if exist VERSION set /p PSI_VERSION=<VERSION
set "ISCC=%ProgramFiles(x86)%\Inno Setup 6\ISCC.exe"
if not exist "%ISCC%" set "ISCC=%ProgramFiles%\Inno Setup 6\ISCC.exe"
if exist "%ISCC%" (
    "%ISCC%" /DMiVersion=%PSI_VERSION% desktop\instalador.iss
    if errorlevel 1 goto :error
) else (
    echo.
    echo    Inno Setup 6 no esta instalado: se omite el instalador.
    echo    Descargalo de https://jrsoftware.org/isdl.php y vuelve a
    echo    ejecutar este script. Mientras tanto, usa el ZIP portable.
)

echo.
echo ============================================================
echo  LISTO.
echo.
echo  PARA INSTALAR EN OTRO EQUIPO
echo    dist\PsiCore_Setup_%PSI_VERSION%.exe   -^> doble clic, siguiente-siguiente
echo    dist\PsiCore_portable.zip      -^> descomprimir y ejecutar PsiCore.exe
echo.
echo  QUE NECESITA EL EQUIPO DE DESTINO
echo    Windows 10/11 de 64 bits. Nada mas para arrancar el programa.
echo    Para usar SQL Server hacen falta ademas dos cosas que la propia
echo    aplicacion detecta y explica en la pantalla de acceso:
echo      - ODBC Driver 18 for SQL Server  (unos 5 MB, de Microsoft)
echo      - SQL Server Express             (si la base va en ese mismo PC)
echo.
echo  DONDE QUEDAN LOS DATOS
echo    C:\ProgramData\PsiCore\datos
echo    PLCs, pantallas, conexiones, cuentas, alarmas y recetas.
echo    NO se borra al desinstalar ni al instalar una version nueva.
echo    Copia de seguridad: Configuracion -^> Carpeta de datos -^> Descargar
echo.
echo  SI ALGO FALLA AL ARRANCAR
echo    C:\ProgramData\PsiCore\datos\registro\psi_core.log
echo ============================================================
goto :fin

:error
echo.
echo *** ERROR en el proceso de build. Revisa el mensaje anterior. ***
endlocal
exit /b 1

:fin
endlocal
