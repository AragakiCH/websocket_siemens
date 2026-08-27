@echo off
REM ======================================================================
REM build_exe.bat - Genera los dos ejecutables de escritorio:
REM   dist\MonitorS7_Servidor.exe  (backend + React, para 1 maquina)
REM   dist\VisorS7.exe             (visor liviano, para cada escritorio)
REM
REM Ejecutar desde la RAIZ del proyecto con el venv activo:
REM   desktop\build_exe.bat
REM ======================================================================
cd /d "%~dp0.."

echo [1/4] Instalando dependencias de empaquetado...
pip install pyinstaller pywebview
if errorlevel 1 goto :error

echo [2/4] Compilando frontend React...
if not exist frontend\node_modules (
    echo   node_modules no existe: ejecutando npm install...
    cd frontend && call npm install && cd ..
)
cd frontend && call npm run build && cd ..
if not exist frontend\dist\index.html goto :error

echo [3/4] Generando SERVIDOR (MonitorS7_Servidor.exe)...
pyinstaller desktop\servidor.spec --noconfirm --distpath dist --workpath build
if errorlevel 1 goto :error

echo [4/4] Generando VISOR (VisorS7.exe)...
pyinstaller desktop\visor.spec --noconfirm --distpath dist --workpath build
if errorlevel 1 goto :error

echo.
echo ============================================================
echo  LISTO. Ejecutables en la carpeta dist\ :
echo    dist\MonitorS7_Servidor.exe  -^> maquina servidor (+ .env)
echo    dist\VisorS7.exe             -^> cada escritorio
echo         (junto al visor se crea visor_config.ini: poner ahi
echo          la IP del servidor)
echo.
echo  DONDE QUEDAN LOS DATOS
echo    C:\ProgramData\PsiCore\datos
echo.
echo    Ahi van PLCs, pantallas, conexiones y usuarios. Esa carpeta
echo    NO se borra al desinstalar ni al instalar una version nueva,
echo    y la comparten todos los usuarios de Windows del equipo.
echo    Junto al .exe solo va la CONFIGURACION de la instalacion
echo    (.env), que si se reemplaza al actualizar.
echo.
echo    Para cambiarla: PLC_DATOS_DIR en el .env
echo    Para respaldarla: Configuracion -^> Carpeta de datos -^> Descargar
echo ============================================================
goto :eof

:error
echo.
echo *** ERROR en el proceso de build. Revisa el mensaje anterior. ***
exit /b 1
