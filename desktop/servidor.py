# -*- coding: utf-8 -*-
"""
servidor.py
===========
Punto de entrada del SERVIDOR de escritorio (.exe).

Arranca el backend FastAPI (OPC UA -> WebSocket) con uvicorn embebido y
sirve el frontend React compilado en el puerto 8000. Corre en UNA sola
máquina; los visores se conectan a ella por la red local.

Ejecutar en desarrollo:  python desktop/servidor.py
Empaquetado:             dist/MonitorS7_Servidor.exe (ver build_exe.bat)
"""
from __future__ import annotations

import os
import sys


def _preparar_entorno() -> None:
    """
    Si corre como .exe congelado (PyInstaller), usa la carpeta del .exe como
    cwd para que el backend encuentre el archivo .env y tags_filter.yaml
    colocados junto al ejecutable.
    """
    if getattr(sys, "frozen", False):
        os.chdir(os.path.dirname(sys.executable))
    else:
        # En desarrollo: raíz del proyecto (padre de desktop/).
        raiz = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        os.chdir(raiz)
        sys.path.insert(0, raiz)


def main() -> None:
    _preparar_entorno()

    import uvicorn
    from app.main import app  # importa la app ya configurada (React + WS)

    print("=" * 60)
    print("  Monitor S7-1500 - SERVIDOR")
    print("  Vista web:  http://localhost:8000")
    print("  Visores:    http://<IP-de-esta-maquina>:8000")
    print("  Cerrar con Ctrl+C")
    print("=" * 60)

    uvicorn.run(app, host="0.0.0.0", port=8000, log_level="info")


if __name__ == "__main__":
    main()
