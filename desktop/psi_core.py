# -*- coding: utf-8 -*-
"""
psi_core.py
===========
Psi Core como APLICACIÓN DE ESCRITORIO.

Un solo ejecutable que hace las dos cosas a la vez:

    1. arranca el backend (FastAPI + uvicorn) en un hilo, sirviendo el
       frontend React ya compilado;
    2. abre una VENTANA NATIVA de Windows apuntando a ese backend.

Es la diferencia entre "un programa" y "un servidor que además hay que abrir
en el navegador". Para quien lo usa, no hay puertos, ni URL, ni una pestaña
que se pueda cerrar por error dejando el servicio colgado.

POR QUÉ UNA VENTANA Y NO UN NAVEGADOR

    pywebview usa Edge WebView2, que ya viene con Windows 10 y 11. La ventana
    no tiene barra de direcciones ni pestañas: nadie puede navegar a otro
    sitio, ni recargar en la URL equivocada, ni dejar el HMI en segundo plano
    detrás de veinte pestañas. Y al cerrarla se cierra el backend, que es lo
    que uno espera de una aplicación.

    Si WebView2 no estuviera disponible (Windows sin actualizar, o un equipo
    donde alguien lo desinstaló), no se muere: cae al navegador en modo
    aplicación y deja dicho por qué.

EL PUERTO

    8000 si está libre; si no, el primero libre a partir de ahí. Dos motivos:
    en un PC de planta puede haber otra cosa en el 8000, y así se pueden abrir
    dos instalaciones distintas sin que se peleen. El puerto elegido se
    imprime y se usa para la ventana.

DÓNDE QUEDAN LOS DATOS

    En `C:\\ProgramData\\PsiCore\\datos` — lo resuelve `app/config/rutas.py`.
    NO junto al .exe: esa carpeta se reemplaza al actualizar y se borra al
    desinstalar, y con ella se irían los PLCs, las pantallas y las cuentas.

Ejecutar en desarrollo:  python desktop/psi_core.py
Empaquetado:             dist/PsiCore.exe  (ver build_exe.bat)
"""
from __future__ import annotations

import os
import socket
import sys
import threading
import time
import urllib.error
import urllib.request

TITULO = "Psi Core — HMI"
PUERTO_PREFERIDO = 8000
ANCHO, ALTO = 1400, 900


# ====================================================================== #
# Entorno
# ====================================================================== #
def _preparar_entorno() -> None:
    """
    Deja el proceso mirando a la carpeta correcta.

    OJO con la distinción, que costó entenderla:

        junto al .exe   ->  CONFIGURACIÓN de la instalación (.env, YAML).
                            Es de solo lectura y se reemplaza al actualizar.
        ProgramData     ->  DATOS del usuario (PLCs, pantallas, conexiones).
                            Sobrevive a desinstalar y a actualizar.
    """
    if getattr(sys, "frozen", False):
        os.chdir(os.path.dirname(sys.executable))
    else:
        raiz = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        os.chdir(raiz)
        sys.path.insert(0, raiz)


def _avisar_si_el_frontend_esta_viejo() -> None:
    """
    Avisa cuando `frontend/dist` es más viejo que `frontend/src`.

    ESTE AVISO NACIÓ DE UN RATO PERDIDO. La ventana abría una vista de hacía
    seis semanas —otro logo, otro formulario— mientras `npm run dev` en el
    5173 enseñaba la actual, y no había ni un error en ninguna parte: los dos
    servían exactamente lo que les habían dado.

    Y es que son dos cosas distintas, aunque se vean en el mismo navegador:

        npm run dev   compila EN MEMORIA a cada cambio. Siempre al día.
        el backend    sirve `frontend/dist`, una carpeta de archivos que solo
                      cambia cuando alguien ejecuta `npm run build`.

    Sin ese `build`, la ventana de escritorio enseña la última compilación,
    tenga la edad que tenga. Comparar las fechas cuesta unos milisegundos y
    convierte un misterio en una línea.

    Empaquetado no se comprueba: ahí el build viaja dentro del programa y no
    hay `src` con qué compararlo.
    """
    if getattr(sys, "frozen", False):
        return
    from pathlib import Path

    raiz = Path.cwd()
    index = raiz / "frontend" / "dist" / "index.html"
    src = raiz / "frontend" / "src"

    if not index.is_file():
        print("*" * 62)
        print("  NO HAY BUILD DEL FRONTEND (frontend/dist/index.html).")
        print("  La ventana va a enseñar la página de prueba, no Psi Core.")
        print("  Compílalo con:   cd frontend && npm run build")
        print("*" * 62)
        return

    if not src.is_dir():
        return

    try:
        mas_nuevo = max(
            (f.stat().st_mtime for f in src.rglob("*") if f.is_file()),
            default=0.0,
        )
    except Exception:  # noqa: BLE001
        return

    if mas_nuevo > index.stat().st_mtime:
        dias = (mas_nuevo - index.stat().st_mtime) / 86400
        print("*" * 62)
        print("  AVISO: el frontend compilado está DESACTUALIZADO.")
        print(f"  frontend/dist es {dias:.1f} día(s) más viejo que el código.")
        print("  La ventana va a enseñar una versión antigua de la vista,")
        print("  sin ningún error: sirve lo último que se compiló.")
        print("  Compílalo con:   cd frontend && npm run build")
        print("*" * 62)


def _redirigir_salida() -> None:
    """
    Manda `print` y los logs a un archivo cuando no hay consola.

    Esto NO es una comodidad, es evitar un cierre inmediato. Un .exe
    compilado en modo ventana (`console=False`) arranca con
    `sys.stdout is None`: el primer `print` —el de uvicorn, sin ir más
    lejos— revienta con `AttributeError: 'NoneType' object has no attribute
    'write'` y el programa se cierra sin enseñar nada. Con un archivo
    detrás, además, cuando algo falla en el PC de un cliente hay dónde
    mirar en vez de "no abre".

    El registro va a la carpeta de DATOS, no junto al .exe: en Archivos de
    programa un usuario normal no puede escribir.
    """
    if sys.stdout is not None and sys.stderr is not None:
        return
    try:
        from app.config.rutas import resolver_carpeta_datos

        carpeta = resolver_carpeta_datos() / "registro"
        carpeta.mkdir(parents=True, exist_ok=True)
        destino = open(carpeta / "psi_core.log", "a", encoding="utf-8",
                       buffering=1)
    except Exception:  # noqa: BLE001
        # Sin sitio donde escribir, se tira a la basura antes que dejar que
        # un `print` tumbe la aplicación.
        destino = open(os.devnull, "w", encoding="utf-8")
    sys.stdout = destino
    sys.stderr = destino
    print(f"\n=== {time.strftime('%Y-%m-%d %H:%M:%S')} · arranque ===")


def puerto_libre(preferido: int = PUERTO_PREFERIDO, intentos: int = 20) -> int:
    """
    El primer puerto libre a partir del preferido.

    Se comprueba enlazando de verdad: preguntar "¿está ocupado?" y luego
    ocuparlo son dos operaciones distintas y entre medias cabe otra cosa,
    pero para un arranque local esto es de sobra.
    """
    for i in range(intentos):
        candidato = preferido + i
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                s.bind(("127.0.0.1", candidato))
                return candidato
            except OSError:
                continue
    return preferido


def esperar_backend(puerto: int, segundos: float = 40.0) -> bool:
    """
    Espera a que `/health` conteste antes de abrir la ventana.

    Sin esto, la ventana abre sobre un servidor que todavía está importando
    media biblioteca de Python y enseña un «no se puede acceder a este sitio».
    El primer arranque de un .exe de PyInstaller es lento: descomprime todo a
    una carpeta temporal.
    """
    url = f"http://127.0.0.1:{puerto}/health"
    limite = time.time() + segundos
    while time.time() < limite:
        try:
            with urllib.request.urlopen(url, timeout=1.5):
                return True
        except urllib.error.HTTPError:
            return True          # contesta, aunque sea un 4xx: ya está vivo
        except Exception:        # noqa: BLE001
            time.sleep(0.35)
    return False


# ====================================================================== #
# Backend
# ====================================================================== #
def arrancar_backend(puerto: int):
    """
    uvicorn en un hilo daemon.

    Daemon a propósito: al cerrar la ventana el proceso termina y el hilo se
    va con él. Un hilo normal dejaría el .exe en memoria sin ventana — el
    clásico "lo cerré y sigue apareciendo en el Administrador de tareas".

    Escucha SOLO en 127.0.0.1. Esta es la versión de escritorio: un HMI de
    planta no debe quedar publicado en la red del taller porque alguien hizo
    doble clic en un icono. Para varios puestos está el modo servidor
    (`servidor.py`), donde eso es una decisión y no un accidente.
    """
    import uvicorn

    from app.config.rutas import describir, resolver_carpeta_datos

    datos = resolver_carpeta_datos()
    info = describir(datos)
    print("=" * 62)
    print(f"  Psi Core   ·   http://127.0.0.1:{puerto}")
    print(f"  Datos:     {datos}")
    if not info["escribible"]:
        print("  *** AVISO: no se puede ESCRIBIR en esa carpeta.")
        print("      Todo lo que configures se perderá al cerrar.")
    print("=" * 62)

    from app.main import app

    config = uvicorn.Config(app, host="127.0.0.1", port=puerto,
                            log_level="info")
    servidor = uvicorn.Server(config)
    hilo = threading.Thread(target=servidor.run, daemon=True,
                            name="psi-core-backend")
    hilo.start()
    return servidor


# ====================================================================== #
# Ventana
# ====================================================================== #
def abrir_ventana(puerto: int) -> bool:
    """Ventana nativa WebView2. `False` si no se pudo (falta el motor)."""
    try:
        import webview  # pywebview
    except ImportError:
        print("[ventana] pywebview no está instalado (pip install pywebview).")
        return False

    try:
        webview.create_window(
            TITULO,
            f"http://127.0.0.1:{puerto}",
            width=ANCHO,
            height=ALTO,
            min_size=(1024, 700),
            confirm_close=False,
        )
        # `gui=None` deja que pywebview elija el motor del sistema. En Windows
        # es WebView2 (Edge); si no estuviera, lanza y se cae al navegador.
        webview.start()
        return True
    except Exception as exc:  # noqa: BLE001
        print(f"[ventana] No se pudo abrir la ventana nativa: {exc}")
        return False


def abrir_en_navegador(puerto: int) -> None:
    """
    Respaldo: el navegador en modo aplicación (sin barra ni pestañas).

    Se prueba Edge y Chrome con `--app=`, que es lo más parecido a una ventana
    propia. Si tampoco están, se abre el navegador por defecto: feo, pero
    funcionando — que es mejor que un programa que no arranca.
    """
    import subprocess
    import webbrowser

    url = f"http://127.0.0.1:{puerto}"
    candidatos = [
        os.path.expandvars(r"%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"),
        os.path.expandvars(r"%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"),
        os.path.expandvars(r"%ProgramFiles%\Google\Chrome\Application\chrome.exe"),
        os.path.expandvars(r"%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"),
    ]
    for exe in candidatos:
        if os.path.isfile(exe):
            subprocess.Popen([exe, f"--app={url}",
                              f"--window-size={ANCHO},{ALTO}"])
            return
    webbrowser.open(url)


def main() -> None:
    _preparar_entorno()
    _redirigir_salida()
    _avisar_si_el_frontend_esta_viejo()

    puerto = puerto_libre()
    arrancar_backend(puerto)

    if not esperar_backend(puerto):
        print("*** El backend no respondió a tiempo. Se abre igualmente: "
              "puede que solo esté tardando más de lo normal.")

    if not abrir_ventana(puerto):
        print("[ventana] Se abre en el navegador. Cierra ESTA consola para "
              "detener Psi Core.")
        abrir_en_navegador(puerto)
        try:
            while True:
                time.sleep(3600)
        except KeyboardInterrupt:
            pass

    # Cerrar la ventana cierra el programa: el hilo del backend es daemon.
    print("Psi Core cerrado.")


if __name__ == "__main__":
    main()
