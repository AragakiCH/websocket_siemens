# -*- mode: python ; coding: utf-8 -*-
# Spec de PyInstaller para PSI CORE.
#
#   dist/PsiCore/PsiCore.exe   backend + React + ventana nativa, en una carpeta
#
# UN SOLO EJECUTABLE CON TRES MODOS, no tres ejecutables. El modo se lee de
# `psi_core.ini` (lo escribe el instalador) o de la línea de órdenes:
#
#   autonomo   backend en 127.0.0.1 + ventana. Un puesto que no comparte nada.
#   servidor   backend en 0.0.0.0 + ventana. El equipo que guarda las
#              pantallas, los widgets y el histórico de todos.
#   visor      solo la ventana, apuntando al servidor. No arranca backend.
#
# Se hizo así, y no con un .exe por modo, por dos razones. La primera es de
# tamaño: Python, las librerías y el build de React pesan igual en los tres,
# y en specs separados se duplicarían (unos 300 MB en vez de 100). La segunda
# importa más: con un único artefacto es imposible que el servidor y un visor
# acaben con versiones distintas del frontend, que es un fallo silencioso y
# muy difícil de ver desde fuera.
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
        # El diagnóstico de SQL Server. Viaja porque el equipo donde falla la
        # conexión es justo el equipo donde NO está el proyecto: allí solo hay
        # un .exe instalado, y sin este script no queda forma de averiguar si
        # el problema es el servicio parado, TCP/IP apagado, el SQL Browser o
        # una instancia con nombre. Pesa 8 KB.
        (os.path.join(raiz, "tools", "revisar_sqlserver.ps1"), "tools"),
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
        # ---------------------------------------------------------------- #
        #  python-multipart: el que rompe el arranque entero si falta
        # ---------------------------------------------------------------- #
        #  `app/api/sistema_routes.py` declara `archivo: UploadFile = File(...)`
        #  para restaurar una copia de seguridad. FastAPI comprueba que
        #  python-multipart esté disponible importándolo POR NOMBRE dentro de
        #  un try/except, así que PyInstaller puede no verlo y dejarlo fuera.
        #
        #  Y el fallo no es "la restauración no funciona": FastAPI hace esa
        #  comprobación al DECLARAR la ruta, es decir al importar el router.
        #  Sin el paquete, `app.main` lanza al importarse y el .exe no arranca
        #  —ni siquiera llega a la pantalla de acceso— por una función que
        #  quizá no se use nunca.
        #
        #  Se declaran los dos nombres a propósito: python-multipart instala
        #  `multipart` (el histórico) y `python_multipart` (el actual), y qué
        #  nombre busca FastAPI depende de su versión. Pedir los dos cuesta
        #  nada y sobrevive a una actualización de cualquiera de los dos.
        "multipart",
        "python_multipart",
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
