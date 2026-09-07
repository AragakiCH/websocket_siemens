# -*- coding: utf-8 -*-
"""
visor.py
========
VISOR de escritorio (.exe) para cada puesto.

Abre una ventana nativa (pywebview / Edge WebView2) apuntando al SERVIDOR
central. No habla con los PLCs ni guarda nada: solo muestra la vista React y
recibe los datos por WebSocket. Todo —pantallas, widgets, conexiones,
usuarios, histórico— vive en el servidor.

Es deliberadamente un cliente FINO, y no importa nada de `app/`: así el .exe
del visor pesa una fracción y actualizar la lógica del HMI no obliga a
reinstalar en todos los puestos, solo en el servidor.

CONFIGURACIÓN
    visor_config.ini, junto al .exe. Se crea solo la primera vez.
    La variable de entorno PSI_SERVIDOR (formato  host:puerto ) tiene
    prioridad, para poder repartir el visor ya apuntado desde el instalador.

Ejecutar en desarrollo:  python desktop/visor.py
Empaquetado:             dist/PsiCore_Visor.exe  (ver build_exe.bat)
"""
from __future__ import annotations

import configparser
import os
import socket
import sys
from typing import Optional, Tuple

CONFIG_NOMBRE = "visor_config.ini"

CONFIG_DEFECTO = """; ====================================================================
;  Psi Core · configuración del VISOR
; ====================================================================
;  Este equipo NO guarda nada: todo está en el servidor. Aquí solo se
;  indica dónde encontrarlo.
;
;  El servidor muestra su IP al arrancar, en la línea que dice
;  "Desde los demás equipos". Cópiala aquí tal cual.
; ====================================================================

[servidor]
host = 127.0.0.1
puerto = 8000

[ventana]
titulo = Psi Core
ancho = 1280
alto = 800
"""

TIEMPO_ESPERA = 4.0        # segundos para decidir que el servidor no responde


def _dir_base() -> str:
    """Carpeta del .exe (congelado) o de este script (desarrollo)."""
    if getattr(sys, "frozen", False):
        return os.path.dirname(sys.executable)
    return os.path.dirname(os.path.abspath(__file__))


def _carpeta_perfil() -> Optional[str]:
    """
    Dónde guarda WebView2 su almacenamiento (localStorage, sesión, caché).

    Va en LOCALAPPDATA y no en ProgramData a propósito: es el perfil del
    NAVEGADOR de esta persona en este equipo, no un dato compartido. Los datos
    de verdad están en el servidor.
    """
    raiz = (os.getenv("LOCALAPPDATA") or os.path.expanduser("~/.local/share"))
    try:
        ruta = os.path.join(raiz, "PsiCore", "visor", "navegador")
        os.makedirs(ruta, exist_ok=True)
        return ruta
    except OSError:
        return None


def _cargar_config() -> Tuple[str, int, str, int, int]:
    """Lee visor_config.ini; si no existe, lo crea con valores por defecto."""
    ruta = os.path.join(_dir_base(), CONFIG_NOMBRE)
    if not os.path.isfile(ruta):
        try:
            with open(ruta, "w", encoding="utf-8") as f:
                f.write(CONFIG_DEFECTO)
        except OSError:
            pass

    cfg = configparser.ConfigParser()
    try:
        cfg.read(ruta, encoding="utf-8")
    except configparser.Error:
        pass

    host = cfg.get("servidor", "host", fallback="127.0.0.1").strip()
    try:
        puerto = cfg.getint("servidor", "puerto", fallback=8000)
    except (ValueError, configparser.Error):
        puerto = 8000

    # El entorno gana: permite que el instalador reparta el visor ya apuntado
    # al servidor sin tener que editar el .ini en cada puesto.
    entorno = (os.getenv("PSI_SERVIDOR") or "").strip()
    if entorno:
        if ":" in entorno:
            h, _, p = entorno.rpartition(":")
            host = h.strip() or host
            try:
                puerto = int(p)
            except ValueError:
                pass
        else:
            host = entorno

    titulo = cfg.get("ventana", "titulo", fallback="Psi Core")
    try:
        ancho = cfg.getint("ventana", "ancho", fallback=1280)
        alto = cfg.getint("ventana", "alto", fallback=800)
    except (ValueError, configparser.Error):
        ancho, alto = 1280, 800

    return host, puerto, titulo, ancho, alto


def _servidor_responde(host: str, puerto: int) -> bool:
    """
    ¿Hay alguien escuchando?

    Se comprueba ANTES de abrir la ventana. Sin esto, WebView2 muestra su
    propia página de error —en inglés, hablando de DNS y de proxies— y la
    persona que está delante concluye que "el programa no carga". El problema
    real casi siempre es uno de tres: el servidor no está arrancado, la IP del
    .ini está mal, o el firewall de Windows bloquea el puerto.
    """
    try:
        with socket.create_connection((host, puerto), timeout=TIEMPO_ESPERA):
            return True
    except OSError:
        return False


def _pagina_error(host: str, puerto: int) -> str:
    """
    Página de diagnóstico, en el idioma de quien la va a leer y con los
    tres motivos reales ordenados por frecuencia.
    """
    ruta_ini = os.path.join(_dir_base(), CONFIG_NOMBRE)
    return f"""<!DOCTYPE html>
<html lang="es"><head><meta charset="utf-8">
<style>
  body {{ font-family: "Segoe UI", system-ui, sans-serif; background:#0f172a;
         color:#e2e8f0; margin:0; padding:48px; line-height:1.6; }}
  h1 {{ font-size:22px; margin:0 0 4px; color:#f8fafc; }}
  .sub {{ color:#94a3b8; margin-bottom:28px; }}
  .caja {{ background:#1e293b; border-left:3px solid #38bdf8;
           padding:16px 20px; border-radius:6px; margin-bottom:20px; }}
  code {{ background:#334155; padding:2px 7px; border-radius:4px;
          font-size:13px; color:#7dd3fc; }}
  ol {{ padding-left:20px; }} li {{ margin-bottom:14px; }}
  .pie {{ color:#64748b; font-size:13px; margin-top:32px;
          border-top:1px solid #334155; padding-top:16px; }}
</style></head><body>
  <h1>No se puede contactar con el servidor</h1>
  <div class="sub">Se intentó conectar con <code>{host}:{puerto}</code></div>

  <div class="caja">
    Este visor no guarda nada por sí mismo: las pantallas, los widgets y los
    datos están en el equipo servidor. Sin conexión con él no hay nada que
    mostrar.
  </div>

  <p><strong>Las tres causas, por orden de frecuencia:</strong></p>
  <ol>
    <li><strong>El servidor no está arrancado.</strong> En el equipo que hace
        de servidor, abre <code>PsiCore_Servidor.exe</code> y déjalo abierto.</li>
    <li><strong>La dirección es incorrecta.</strong> El servidor muestra su IP
        al arrancar, bajo <em>"Desde los demás equipos"</em>. Cópiala en:<br>
        <code>{ruta_ini}</code></li>
    <li><strong>El firewall de Windows bloquea el puerto.</strong> En el
        servidor, como administrador:<br>
        <code>netsh advfirewall firewall add rule name="Psi Core"
        dir=in action=allow protocol=TCP localport={puerto}</code></li>
  </ol>

  <div class="pie">
    Cierra esta ventana y vuelve a abrir el visor cuando lo hayas corregido.
  </div>
</body></html>"""


def main() -> None:
    import webview  # pywebview

    host, puerto, titulo, ancho, alto = _cargar_config()

    if _servidor_responde(host, puerto):
        destino = {"url": f"http://{host}:{puerto}/"}
    else:
        # Ventana igualmente, pero con el diagnóstico dentro. Cerrar el .exe
        # sin explicar nada sería lo peor: no deja ni pista de qué revisar.
        destino = {"html": _pagina_error(host, puerto)}

    webview.create_window(titulo, width=ancho, height=alto, **destino)

    # ── private_mode=False: ESTO NO ES OPCIONAL ───────────────────────────
    # Por defecto pywebview abre WebView2 en modo privado, y WebView2 borra
    # TODO el almacenamiento del navegador al cerrar la ventana. Eso se lleva
    # por delante la sesión iniciada y las preferencias locales de la vista,
    # así que cada arranque pedía login otra vez.
    #
    # `storage_path` fija DÓNDE se guarda. Sin él, pywebview elige una carpeta
    # temporal que Windows puede limpiar, y el problema vuelve de forma
    # intermitente — que es mucho peor de diagnosticar que si fallara siempre.
    perfil = _carpeta_perfil()
    if perfil:
        webview.start(private_mode=False, storage_path=perfil)
    else:
        webview.start(private_mode=False)


if __name__ == "__main__":
    main()
