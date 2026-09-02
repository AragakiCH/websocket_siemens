# -*- mode: python ; coding: utf-8 -*-
# Spec de PyInstaller para PSI CORE (aplicación de escritorio).
#
#   dist/PsiCore/PsiCore.exe   backend + React + ventana nativa, en una carpeta
#
# Se genera en modo CARPETA (`onefile=False`) a propósito. Un solo .exe se
# descomprime entero en %TEMP% en cada arranque: tarda entre cinco y quince
# segundos, y algunos antivirus lo tratan como sospechoso justamente por eso.
# En carpeta arranca en un segundo, y como igualmente se distribuye con un
# instalador, que sean cien archivos en vez de uno no lo nota nadie.
#
# Generar con:  pyinstaller desktop/psi_core.spec --noconfirm
# (desde la RAÍZ del proyecto, con el venv activo)
import os

raiz = os.path.abspath(os.path.join(SPECPATH, ".."))
icono = os.path.join(SPECPATH, "psi_core.ico")

a = Analysis(
    [os.path.join(SPECPATH, "psi_core.py")],
    pathex=[raiz],
    binaries=[],
    datas=[
        # El build de React viaja dentro del programa.
        (os.path.join(raiz, "frontend", "dist"), os.path.join("frontend", "dist")),
        # Los .sql del esquema: sirven para crear la base a mano si alguien
        # prefiere hacerlo desde SSMS en vez de desde la aplicación.
        (os.path.join(raiz, "sql"), "sql"),
        # La versión: la lee app/main.py y debe coincidir con la que
        # el instalador escribió en el registro.
        (os.path.join(raiz, "VERSION"), "."),
        # La documentación: NO es decorativa aquí. El asistente de IA la
        # indexa al arrancar (RAG) para responder sobre el propio proyecto.
        # Sin ella, en el .exe el asistente arranca con 0 fragmentos y
        # responde de memoria, que es justo lo que el RAG existe para evitar.
        (os.path.join(raiz, "docs"), "docs"),
        (os.path.join(raiz, "README.md"), "."),
    ],
    hiddenimports=[
        "app.main",
        # uvicorn resuelve estos por nombre en tiempo de ejecución, así que
        # PyInstaller no los ve al analizar los imports.
        "uvicorn.logging",
        "uvicorn.loops.auto",
        "uvicorn.protocols.http.auto",
        "uvicorn.protocols.websockets.auto",
        "uvicorn.lifespan.on",
        # Conectores de base de datos: se importan por cadena según el motor
        # elegido, nunca con un `import` literal.
        "aioodbc",
        "pyodbc",
        "aiosqlite",
        "aiomysql",
        "asyncpg",
        # Zona horaria en Windows: sin esto `ZoneInfo("America/Lima")` falla.
        "tzdata",
    ],
    hookspath=[],
    runtime_hooks=[],
    excludes=["tkinter", "matplotlib", "PyQt5", "PySide6"],
    noarchive=False,
)

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="PsiCore",
    debug=False,
    strip=False,
    upx=False,
    # Sin consola: es una aplicación, no un servicio. Los mensajes van al
    # archivo de registro de la carpeta de datos (ver `_redirigir_salida()`).
    console=False,
    icon=icono if os.path.isfile(icono) else None,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    name="PsiCore",
)
