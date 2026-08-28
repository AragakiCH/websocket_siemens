@echo off
REM ======================================================================
REM build_exe.bat - Empaqueta Psi Core para instalarlo en otros equipos.
REM
REM   dist\PsiCore\PsiCore.exe        aplicacion de escritorio (carpeta)
REM   dist\PsiCore_portable.zip       version portable, sin instalar
REM   dist\PsiCore_Setup_1.0.0.exe    instalador (si hay Inno Setup)
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
if not exist frontend\node_modules (
    echo    node_modules no existe: npm install...
    pushd frontend && call npm install && popd
)
pushd frontend && call npm run build && popd
if not exist frontend\dist\index.html (
    echo    *** El build de React no genero frontend\dist\index.html
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
set "ISCC=%ProgramFiles(x86)%\Inno Setup 6\ISCC.exe"
if not exist "%ISCC%" set "ISCC=%ProgramFiles%\Inno Setup 6\ISCC.exe"
if exist "%ISCC%" (
    "%ISCC%" desktop\instalador.iss
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
echo    dist\PsiCore_Setup_1.0.0.exe   -^> doble clic, siguiente-siguiente
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
