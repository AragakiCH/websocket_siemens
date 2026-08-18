# -*- coding: utf-8 -*-
"""
dev.py
======
Arranca el ENTORNO DE DESARROLLO COMPLETO desde UNA SOLA terminal:

  * Backend  -> uvicorn app.main:app --reload      (puerto 8000)
  * Frontend -> vite (npm run dev)                 (puerto 5173)

Ambos procesos comparten esta consola: la salida de cada uno sale prefijada y
coloreada para distinguirlos. Con Ctrl+C se cierran los dos limpiamente
(incluidos los procesos hijos que lanza npm, que en Windows no mueren solos).

Uso:
    python tools/dev.py                 # backend + frontend
    python tools/dev.py --solo-backend  # solo uvicorn (si ya hiciste build)
    python tools/dev.py --puerto 8080   # cambiar el puerto del backend

Luego abre  http://localhost:5173  (NO el 8000): es Vite quien sirve la vista
con hot-reload, y su proxy reenvía /ws, /plcs, /rexroth, /health, /tags... al
backend. El 8000 sigue sirviendo /docs y la API.

Para PRODUCCIÓN no hace falta este script: basta `npm run build` una vez y
arrancar uvicorn, que ya sirve `frontend/dist` en el 8000.
"""
from __future__ import annotations

import argparse
import os
import shutil
import signal
import subprocess
import sys
import threading
from pathlib import Path
from typing import List, Optional

RAIZ = Path(__file__).resolve().parent.parent
FRONTEND = RAIZ / "frontend"

ES_WINDOWS = os.name == "nt"

# Colores ANSI. La consola de Windows 10+ los entiende; si no, se ven como
# texto plano sin romper nada.
AZUL = "\033[94m"
VERDE = "\033[92m"
ROJO = "\033[91m"
AMARILLO = "\033[93m"
GRIS = "\033[90m"
FIN = "\033[0m"


def _log(msg: str, color: str = "") -> None:
    print(f"{color}{msg}{FIN}", flush=True)


def buscar_npm() -> Optional[str]:
    """Localiza el ejecutable de npm (en Windows es `npm.cmd`)."""
    for nombre in ("npm.cmd", "npm"):
        ruta = shutil.which(nombre)
        if ruta:
            return ruta
    return None


def bombear_salida(proceso: subprocess.Popen, etiqueta: str, color: str) -> None:
    """
    Lee la salida del proceso línea a línea y la reimprime con su prefijo.
    Corre en un hilo daemon, uno por proceso.
    """
    assert proceso.stdout is not None
    for linea in iter(proceso.stdout.readline, ""):
        if not linea:
            break
        print(f"{color}[{etiqueta}]{FIN} {linea.rstrip()}", flush=True)


def lanzar(
    comando: List[str], cwd: Path, etiqueta: str, color: str,
    entorno: Optional[dict] = None,
) -> subprocess.Popen:
    """Arranca un subproceso con su salida redirigida a esta consola."""
    creationflags = 0
    if ES_WINDOWS:
        # Grupo de procesos propio: permite matar el árbol completo después.
        creationflags = subprocess.CREATE_NEW_PROCESS_GROUP

    proceso = subprocess.Popen(
        comando,
        cwd=str(cwd),
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
        encoding="utf-8",
        errors="replace",
        creationflags=creationflags,
        env=entorno,
    )
    hilo = threading.Thread(
        target=bombear_salida, args=(proceso, etiqueta, color), daemon=True
    )
    hilo.start()
    return proceso


def matar(proceso: Optional[subprocess.Popen], etiqueta: str) -> None:
    """
    Cierra un proceso y TODOS sus hijos.

    En Windows `npm` lanza `node` como proceso hijo: si solo se termina npm,
    Vite queda huérfano ocupando el puerto 5173. Por eso se usa
    `taskkill /T` (árbol completo).
    """
    if proceso is None or proceso.poll() is not None:
        return
    _log(f"Deteniendo {etiqueta}...", GRIS)
    try:
        if ES_WINDOWS:
            subprocess.run(
                ["taskkill", "/F", "/T", "/PID", str(proceso.pid)],
                capture_output=True,
            )
        else:
            proceso.terminate()
        proceso.wait(timeout=10)
    except Exception:
        try:
            proceso.kill()
        except Exception:
            pass


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Arranca backend y frontend juntos en una sola terminal."
    )
    parser.add_argument("--puerto", type=int, default=8000,
                        help="Puerto del backend (por defecto 8000).")
    parser.add_argument("--host", default="0.0.0.0",
                        help="Host del backend (por defecto 0.0.0.0).")
    parser.add_argument("--solo-backend", action="store_true",
                        help="No arrancar Vite (úsalo si ya hiciste npm run build).")
    args = parser.parse_args()

    procesos: List[tuple[subprocess.Popen, str]] = []

    # ---------------- Backend ---------------- #
    _log("=" * 62, GRIS)
    _log(" Entorno de desarrollo — backend + frontend en una terminal", AMARILLO)
    _log("=" * 62, GRIS)

    backend = lanzar(
        [sys.executable, "-m", "uvicorn", "app.main:app", "--reload",
         "--host", args.host, "--port", str(args.puerto)],
        cwd=RAIZ, etiqueta="backend", color=AZUL,
    )
    procesos.append((backend, "backend"))

    # ---------------- Frontend ---------------- #
    if not args.solo_backend:
        npm = buscar_npm()
        if npm is None:
            _log("No se encontró npm en el PATH. ¿Está instalado Node.js 18+?", ROJO)
            _log("Arrancando solo el backend.", AMARILLO)
        elif not (FRONTEND / "node_modules").is_dir():
            _log("Falta frontend/node_modules. Ejecuta primero:", ROJO)
            _log("    cd frontend && npm install", ROJO)
            _log("Arrancando solo el backend.", AMARILLO)
        else:
            # El proxy de vite.config.js lee BACKEND_PORT: así, si arrancas el
            # backend en otro puerto con --puerto, el proxy lo sigue.
            entorno = os.environ.copy()
            entorno["BACKEND_PORT"] = str(args.puerto)
            frontend = lanzar([npm, "run", "dev"], cwd=FRONTEND,
                              etiqueta="frontend", color=VERDE, entorno=entorno)
            procesos.append((frontend, "frontend"))
            _log("", "")
            _log(f"  Vista (hot-reload) -> http://localhost:5173", VERDE)
            _log(f"  API y /docs        -> http://localhost:{args.puerto}/docs", AZUL)
            _log("  Ctrl+C para detener ambos.", GRIS)
            _log("", "")

    # ---------------- Espera / cierre ---------------- #
    try:
        # Si CUALQUIERA de los dos muere, se cierra todo: así no te quedas con
        # un frontend apuntando a un backend caído (o al revés).
        while True:
            for proceso, etiqueta in procesos:
                codigo = proceso.poll()
                if codigo is not None:
                    _log(f"El proceso '{etiqueta}' terminó (código {codigo}).", ROJO)
                    raise KeyboardInterrupt
            try:
                backend.wait(timeout=1)
            except subprocess.TimeoutExpired:
                pass
    except KeyboardInterrupt:
        _log("", "")
        _log("Cerrando...", AMARILLO)
    finally:
        for proceso, etiqueta in reversed(procesos):
            matar(proceso, etiqueta)
        _log("Listo.", GRIS)

    return 0


if __name__ == "__main__":
    # Ignorar el Ctrl+C del grupo para que lo maneje el bloque try/except de
    # main() y no un traceback feo de Python.
    if not ES_WINDOWS:
        signal.signal(signal.SIGINT, signal.default_int_handler)
    sys.exit(main())
