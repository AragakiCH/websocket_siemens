# -*- coding: utf-8 -*-
"""
visor.py
========
VISOR de escritorio (.exe) para cada usuario.

Abre una ventana nativa (pywebview / Edge WebView2) apuntando al servidor
central. No habla con los PLCs: solo muestra la vista React y recibe los
datos por WebSocket. La IP del servidor se lee de `visor_config.ini`
ubicado junto al .exe (se crea solo la primera vez).

Ejecutar en desarrollo:  python desktop/visor.py
Empaquetado:             dist/VisorS7.exe (ver build_exe.bat)
"""
from __future__ import annotations

import configparser
import os
import sys

CONFIG_NOMBRE = "visor_config.ini"
CONFIG_DEFECTO = """[servidor]
; IP o nombre de la máquina donde corre MonitorS7_Servidor.exe
host = 127.0.0.1
puerto = 8000

[ventana]
titulo = Monitor S7-1500
ancho = 1200
alto = 800
"""


def _dir_base() -> str:
    """Carpeta del .exe (congelado) o de este script (desarrollo)."""
    if getattr(sys, "frozen", False):
        return os.path.dirname(sys.executable)
    return os.path.dirname(os.path.abspath(__file__))


def _cargar_config() -> configparser.ConfigParser:
    """Lee visor_config.ini; si no existe, lo crea con valores por defecto."""
    ruta = os.path.join(_dir_base(), CONFIG_NOMBRE)
    if not os.path.isfile(ruta):
        with open(ruta, "w", encoding="utf-8") as f:
            f.write(CONFIG_DEFECTO)
    cfg = configparser.ConfigParser()
    cfg.read(ruta, encoding="utf-8")
    return cfg


def main() -> None:
    import webview  # pywebview

    cfg = _cargar_config()
    host = cfg.get("servidor", "host", fallback="127.0.0.1").strip()
    puerto = cfg.getint("servidor", "puerto", fallback=8000)
    titulo = cfg.get("ventana", "titulo", fallback="Monitor S7-1500")
    ancho = cfg.getint("ventana", "ancho", fallback=1200)
    alto = cfg.getint("ventana", "alto", fallback=800)

    url = f"http://{host}:{puerto}/"

    webview.create_window(titulo, url, width=ancho, height=alto)
    webview.start()


if __name__ == "__main__":
    main()
