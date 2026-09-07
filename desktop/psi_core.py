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

LOS TRES MODOS

    Un mismo .exe se comporta de tres formas según `psi_core.ini` (que
    escribe el instalador) o según un argumento de la línea de órdenes:

        autonomo   Backend en 127.0.0.1 + ventana. Un puesto aislado. Es el
                   comportamiento de siempre y el valor por defecto.
        servidor   Backend en 0.0.0.0 + ventana. El equipo que guarda las
                   pantallas, los widgets, las conexiones y el histórico DE
                   TODOS. Sigue siendo un puesto usable.
        visor      Solo la ventana, apuntando al servidor. No arranca backend
                   ni habla con los PLCs.

    POR QUÉ HACE FALTA ESTA DISTINCIÓN. En modo autónomo cada equipo levanta
    su propio backend y guarda en su propio ProgramData. Eso está bien para un
    puesto único, pero con varias personas produce un fallo desconcertante:
    los widgets y las pantallas que configura una NO existen para las demás,
    porque el servidor de cada una es su propio PC. Y no se manifiesta como un
    error, sino como un widget en blanco — parece un fallo del programa y es
    una consecuencia de la arquitectura.

Ejecutar en desarrollo:  python desktop/psi_core.py [--servidor|--visor HOST]
Empaquetado:             dist/PsiCore.exe  (ver build_exe.bat)
"""
from __future__ import annotations

import configparser
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

CONFIG_NOMBRE = "psi_core.ini"
MODOS = ("autonomo", "servidor", "visor")

CONFIG_DEFECTO = """; ====================================================================
;  Psi Core · modo de funcionamiento de ESTE equipo
; ====================================================================
;  autonomo  Este equipo es un HMI completo y aislado. Guarda sus propias
;            pantallas y widgets, y no los comparte con nadie.
;
;  servidor  Este equipo GUARDA TODO y sirve a los demás. Es el único que
;            debe estar en este modo.
;
;  visor     Este equipo solo muestra lo que hay en el servidor. Rellena
;            'host' con la IP que el servidor enseña al arrancar.
; ====================================================================

[psi]
modo = autonomo

[servidor]
; Solo se usa en modo 'visor': dónde está el servidor.
host = 127.0.0.1
puerto = 8000
"""


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
# Modo de funcionamiento
# ====================================================================== #
def _ruta_config() -> str:
    """El .ini vive junto al .exe: es configuración de la INSTALACIÓN."""
    if getattr(sys, "frozen", False):
        base = os.path.dirname(sys.executable)
    else:
        base = os.path.dirname(os.path.abspath(__file__))
    return os.path.join(base, CONFIG_NOMBRE)


def _ips_locales():
    """
    IPs de este equipo en la red local, para dictárselas a quien monta un
    visor. Sin esto, el mensaje "usa la IP de esta máquina" obliga a abrir una
    consola, ejecutar ipconfig y acertar entre varias interfaces.

    El truco del socket UDP no envía ni un byte: solo pregunta al sistema qué
    interfaz usaría para salir, que es la que ven los demás equipos.

    (Está duplicado en `servidor.py` a propósito: ese script es un punto de
    entrada independiente que no importa nada de aquí, y compartir veinte
    líneas no compensa acoplarlos.)
    """
    ips = []
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            s.connect(("8.8.8.8", 80))
            ips.append(s.getsockname()[0])
        finally:
            s.close()
    except OSError:
        pass
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None,
                                       socket.AF_INET):
            if info[4][0] not in ips:
                ips.append(info[4][0])
    except OSError:
        pass
    # 127.x no lo alcanza nadie más; 169.254.x es la que se autoasigna Windows
    # cuando la tarjeta se queda sin DHCP: parece válida y no encamina.
    return [ip for ip in ips
            if not ip.startswith("127.") and not ip.startswith("169.254.")]


def resolver_modo(argv=None):
    """
    Decide el modo y, si es 'visor', a dónde apuntar.

    Prioridad: línea de órdenes -> variables de entorno -> psi_core.ini ->
    'autonomo'. La línea de órdenes va primero para poder probar los tres
    modos en un mismo equipo sin editar ficheros, que es justo lo que hace
    falta al montar esto por primera vez.

    Devuelve (modo, host_remoto, puerto_remoto).
    """
    argv = list(sys.argv[1:] if argv is None else argv)

    ruta = _ruta_config()
    if not os.path.isfile(ruta):
        try:
            with open(ruta, "w", encoding="utf-8") as f:
                f.write(CONFIG_DEFECTO)
        except OSError:
            # Instalado en Archivos de programa sin permisos: se sigue con
            # los valores por defecto en vez de no arrancar.
            pass

    cfg = configparser.ConfigParser()
    try:
        cfg.read(ruta, encoding="utf-8")
    except configparser.Error:
        pass

    modo = (cfg.get("psi", "modo", fallback="autonomo") or "").strip().lower()
    host = cfg.get("servidor", "host", fallback="127.0.0.1").strip()
    try:
        puerto = cfg.getint("servidor", "puerto", fallback=PUERTO_PREFERIDO)
    except (ValueError, configparser.Error):
        puerto = PUERTO_PREFERIDO

    entorno = (os.getenv("PSI_MODO") or "").strip().lower()
    if entorno in MODOS:
        modo = entorno
    destino = (os.getenv("PSI_SERVIDOR") or "").strip()

    for i, arg in enumerate(argv):
        a = arg.strip().lower()
        if a in ("--servidor", "-s"):
            modo = "servidor"
        elif a in ("--autonomo", "-a"):
            modo = "autonomo"
        elif a in ("--visor", "-v"):
            modo = "visor"
            # Acepta  --visor 192.168.1.50:8000  y  --visor=192.168.1.50
            if i + 1 < len(argv) and not argv[i + 1].startswith("-"):
                destino = argv[i + 1].strip()
        elif a.startswith("--visor="):
            modo, destino = "visor", arg.split("=", 1)[1].strip()

    if destino:
        if ":" in destino:
            h, _, p = destino.rpartition(":")
            host = h.strip() or host
            try:
                puerto = int(p)
            except ValueError:
                pass
        else:
            host = destino

    if modo not in MODOS:
        modo = "autonomo"
    return modo, host, puerto


# ====================================================================== #
# Backend
# ====================================================================== #
def arrancar_backend(puerto: int, host: str = "127.0.0.1"):
    """
    uvicorn en un hilo daemon.

    Daemon a propósito: al cerrar la ventana el proceso termina y el hilo se
    va con él. Un hilo normal dejaría el .exe en memoria sin ventana — el
    clásico "lo cerré y sigue apareciendo en el Administrador de tareas".

    Por defecto escucha SOLO en 127.0.0.1, y es deliberado: un HMI de planta
    no debe quedar publicado en la red del taller porque alguien hizo doble
    clic en un icono. Publicarlo (`host="0.0.0.0"`, modo servidor) tiene que
    ser una decisión explícita y no un accidente.
    """
    import uvicorn

    from app.config.rutas import describir, resolver_carpeta_datos

    datos = resolver_carpeta_datos()
    info = describir(datos)
    print("=" * 62)
    if host == "0.0.0.0":
        print("  Psi Core   ·   MODO SERVIDOR")
        print(f"  Aquí:      http://127.0.0.1:{puerto}")
        for ip in _ips_locales():
            print(f"  Visores:   host = {ip}   puerto = {puerto}")
        print("  Si los visores no conectan, abre el puerto en el firewall:")
        print(f'    netsh advfirewall firewall add rule name="Psi Core" '
              f"dir=in action=allow protocol=TCP localport={puerto}")
    else:
        print(f"  Psi Core   ·   http://127.0.0.1:{puerto}")
    print(f"  Datos:     {datos}")
    if not info["escribible"]:
        print("  *** AVISO: no se puede ESCRIBIR en esa carpeta.")
        print("      Todo lo que configures se perderá al cerrar.")
    print("=" * 62)

    from app.main import app

    config = uvicorn.Config(app, host=host, port=puerto,
                            log_level="info")
    servidor = uvicorn.Server(config)
    hilo = threading.Thread(target=servidor.run, daemon=True,
                            name="psi-core-backend")
    hilo.start()
    return servidor


# ====================================================================== #
# Ventana
# ====================================================================== #
def abrir_ventana(puerto: int, url: str = "", titulo: str = "",
                  html: str = "") -> bool:
    """
    Ventana nativa WebView2. `False` si no se pudo (falta el motor).

    `url`  apunta a OTRO equipo (modo visor); si falta, al backend local.
    `html` muestra contenido propio sin servidor ninguno — es como se enseña
           el diagnóstico cuando el visor no encuentra al servidor.

    El HTML va por el parámetro `html` de pywebview y NO como una URL
    `data:text/html,...`, que sería lo natural: Chromium —y por tanto
    WebView2— BLOQUEA la navegación de nivel superior a URLs `data:` desde
    2017, como defensa contra el phishing. Por esa vía la ventana saldría en
    blanco, que es exactamente el fallo que este diagnóstico viene a evitar.
    """
    try:
        import webview  # pywebview
    except ImportError:
        print("[ventana] pywebview no está instalado (pip install pywebview).")
        return False

    try:
        destino = ({"html": html} if html
                   else {"url": url or f"http://127.0.0.1:{puerto}"})
        webview.create_window(
            titulo or TITULO,
            **destino,
            width=ANCHO,
            height=ALTO,
            min_size=(1024, 700),
            confirm_close=False,
        )
        # ── private_mode=False: ESTO NO ES OPCIONAL ──────────────────────
        # pywebview arranca en modo privado POR DEFECTO, y eso significa que
        # WebView2 tira todo el almacenamiento del navegador al cerrar la
        # ventana: localStorage, sessionStorage, cookies. Con el valor por
        # defecto, cada arranque de la aplicación empieza en blanco.
        #
        # Se notaba en cosas como un widget importado de un ZIP que aparecía
        # vacío al reabrir: el diseño venía del servidor (y por eso seguía la
        # caja en su sitio), pero la definición del widget vivía solo en
        # localStorage y se había borrado.
        #
        # `storage_path` fija DÓNDE se guarda: en la carpeta de datos de la
        # aplicación, junto al resto de la configuración del usuario. Así se
        # respalda y se borra con todo lo demás, en vez de quedar suelto en un
        # temporal del sistema.
        try:
            from app.config.rutas import resolver_carpeta_datos
            perfil = resolver_carpeta_datos() / "navegador"
            perfil.mkdir(parents=True, exist_ok=True)
            almacen = str(perfil)
        except Exception:  # noqa: BLE001
            almacen = None    # pywebview usará su ruta por defecto

        # `gui=None` deja que pywebview elija el motor del sistema. En Windows
        # es WebView2 (Edge); si no estuviera, lanza y se cae al navegador.
        webview.start(private_mode=False, storage_path=almacen)
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


def _pagina_sin_servidor(host: str, puerto: int) -> str:
    """
    Diagnóstico para el modo visor cuando el servidor no responde.

    Sin esto, WebView2 enseña su propia página de error —en inglés, hablando
    de DNS y de proxies— y quien está delante concluye que "el programa no
    carga". El problema real casi siempre es uno de estos tres.
    """
    return f"""<!DOCTYPE html><html lang="es"><head><meta charset="utf-8">
<style>
 body{{font-family:"Segoe UI",system-ui,sans-serif;background:#0f172a;
      color:#e2e8f0;margin:0;padding:48px;line-height:1.6}}
 h1{{font-size:22px;margin:0 0 4px;color:#f8fafc}}
 .sub{{color:#94a3b8;margin-bottom:28px}}
 .caja{{background:#1e293b;border-left:3px solid #38bdf8;padding:16px 20px;
       border-radius:6px;margin-bottom:20px}}
 code{{background:#334155;padding:2px 7px;border-radius:4px;font-size:13px;
      color:#7dd3fc}}
 li{{margin-bottom:14px}}
</style></head><body>
<h1>No se puede contactar con el servidor</h1>
<div class="sub">Se intentó conectar con <code>{host}:{puerto}</code></div>
<div class="caja">Este equipo está en modo <strong>visor</strong>: no guarda
nada por sí mismo. Las pantallas, los widgets y los datos están en el equipo
servidor.</div>
<p><strong>Las tres causas, por orden de frecuencia:</strong></p>
<ol>
<li><strong>El servidor no está arrancado.</strong> Ábrelo en el equipo que
    hace de servidor y déjalo abierto.</li>
<li><strong>La dirección es incorrecta.</strong> El servidor muestra su IP al
    arrancar. Corrígela en <code>{_ruta_config()}</code></li>
<li><strong>El firewall bloquea el puerto.</strong> En el servidor, como
    administrador:<br><code>netsh advfirewall firewall add rule
    name="Psi Core" dir=in action=allow protocol=TCP localport={puerto}</code></li>
</ol>
</body></html>"""


def _hay_alguien(host: str, puerto: int, espera: float = 4.0) -> bool:
    """¿Responde el servidor? Se comprueba antes de abrir la ventana."""
    try:
        with socket.create_connection((host, puerto), timeout=espera):
            return True
    except OSError:
        return False


def main() -> None:
    _preparar_entorno()
    _redirigir_salida()

    modo, host_remoto, puerto_remoto = resolver_modo()

    # ---------------------------------------------------------------- #
    # VISOR: no se arranca backend. Solo la ventana, apuntando a otro
    # equipo. Ni siquiera se toca la carpeta de datos local.
    # ---------------------------------------------------------------- #
    if modo == "visor":
        print(f"Psi Core · MODO VISOR -> {host_remoto}:{puerto_remoto}")
        vivo = _hay_alguien(host_remoto, puerto_remoto)
        url = f"http://{host_remoto}:{puerto_remoto}/" if vivo else ""
        diagnostico = "" if vivo else _pagina_sin_servidor(
            host_remoto, puerto_remoto)
        if not vivo:
            print("*** El servidor no responde. Se abre el diagnóstico.")

        if not abrir_ventana(0, url=url, html=diagnostico,
                             titulo=f"{TITULO} (visor)"):
            # Sin WebView2: si el servidor está vivo se abre en el navegador;
            # si no, no hay nada que abrir y el motivo ya está impreso arriba.
            if vivo:
                import webbrowser
                webbrowser.open(url)
                try:
                    while True:
                        time.sleep(3600)
                except KeyboardInterrupt:
                    pass
        print("Psi Core cerrado.")
        return

    # ---------------------------------------------------------------- #
    # AUTÓNOMO y SERVIDOR: backend local. La única diferencia es a qué
    # interfaz se ata, y por tanto quién puede llegar.
    # ---------------------------------------------------------------- #
    _avisar_si_el_frontend_esta_viejo()

    host_escucha = "0.0.0.0" if modo == "servidor" else "127.0.0.1"
    puerto = puerto_libre()
    arrancar_backend(puerto, host=host_escucha)

    if not esperar_backend(puerto):
        print("*** El backend no respondió a tiempo. Se abre igualmente: "
              "puede que solo esté tardando más de lo normal.")

    titulo = TITULO + (" (servidor)" if modo == "servidor" else "")
    if not abrir_ventana(puerto, titulo=titulo):
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
