# -*- mode: python ; coding: utf-8 -*-
# Spec de PyInstaller para el VISOR (ventana de escritorio, sin backend).
# Generar con:  pyinstaller desktop/visor.spec --noconfirm
import os

a = Analysis(
    [os.path.join(SPECPATH, "visor.py")],
    pathex=[],
    binaries=[],
    datas=[],
    hiddenimports=["webview.platforms.edgechromium", "webview.platforms.winforms"],
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
    name="VisorS7",
    debug=False,
    strip=False,
    upx=False,
    console=False,  # app de ventana, sin consola
    icon=None,
)
