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

    OJO con la distinción, que costó entenderla:

        junto al .exe   ->  CONFIGURACIÓN de la instalación (.env, YAML).
                            Es de solo lectura y se reemplaza al actualizar.
        ProgramData     ->  DATOS del usuario (PLCs, pantallas, conexiones).
                            Sobrevive a desinstalar y actualizar.

    Antes todo caía en el primer sitio, así que actualizar de versión borraba
    la configuración de quien usaba el programa. La carpeta de datos la
    resuelve ahora `app/config/rutas.py`; aquí solo se fija el cwd.
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

    # Resolver la carpeta de datos ANTES de importar la app: aquí es donde se
    # migra la configuración de una versión anterior, y conviene que esté en
    # su sitio antes de que nadie la lea.
    from app.config.rutas import describir, resolver_carpeta_datos

    datos = resolver_carpeta_datos()
    info = describir(datos)

    print("=" * 60)
    print("  Monitor S7-1500 - SERVIDOR")
    print("  Vista web:  http://localhost:8000")
    print("  Visores:    http://<IP-de-esta-maquina>:8000")
    print(f"  Datos:      {datos}")
    if not info["escribible"]:
        # Sin permiso de escritura el servicio arranca igual y pierde todo lo
        # que se haga. Merece un aviso visible, no una línea de log.
        print("  *** AVISO: no se puede ESCRIBIR en esa carpeta.")
        print("      Todo lo que configures se perderá al cerrar.")
        print("      Ejecuta como administrador, o define PLC_DATOS_DIR")
        print("      apuntando a una carpeta con permisos.")
    print("  Cerrar con Ctrl+C")
    print("=" * 60)

    from app.main import app  # importa la app ya configurada (React + WS)

    uvicorn.run(app, host="0.0.0.0", port=8000, log_level="info")


if __name__ == "__main__":
    main()
