# -*- mode: python ; coding: utf-8 -*-
# Spec de PyInstaller para el SERVIDOR (backend + frontend React embebido).
# Generar con:  pyinstaller desktop/servidor.spec --noconfirm
# (ejecutar desde la RAÍZ del proyecto, con el venv activo)
import os

raiz = os.path.abspath(os.path.join(SPECPATH, ".."))

a = Analysis(
    [os.path.join(SPECPATH, "servidor.py")],
    pathex=[raiz],
    binaries=[],
    datas=[
        # El build de React viaja dentro del .exe
        (os.path.join(raiz, "frontend", "dist"), os.path.join("frontend", "dist")),
    ],
    hiddenimports=[
        "app.main",
        "uvicorn.logging",
        "uvicorn.loops.auto",
        "uvicorn.protocols.http.auto",
        "uvicorn.protocols.websockets.auto",
        "uvicorn.lifespan.on",
    ],
    hookspath=[],
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
)

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name="MonitorS7_Servidor",
    debug=False,
    strip=False,
    upx=False,
    console=True,   # consola visible: ahí se ven los logs OPC UA
    icon=None,
)
