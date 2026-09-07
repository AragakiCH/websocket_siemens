# -*- coding: utf-8 -*-
"""
servidor.py
===========
Punto de entrada del SERVIDOR (.exe).

Arranca el backend FastAPI (PLCs -> WebSocket) con uvicorn embebido y sirve
el frontend React compilado. Corre en UNA sola máquina de la planta; los
demás equipos abren el visor apuntando a ella.

POR QUÉ EXISTE ESTE MODO, Y NO SOLO EL DE ESCRITORIO
----------------------------------------------------
`psi_core.py` (el modo escritorio) ata uvicorn a `127.0.0.1`: cada equipo es
un HMI completo y aislado, con su propia carpeta de datos.

Eso es correcto para un puesto único, pero se rompe en cuanto hay un equipo de
trabajo, y se rompe de una forma que confunde: los widgets, las pantallas y
las conexiones que configura una persona **no existen** para las demás, porque
el servidor de cada una es su propio PC. El síntoma no es un error, es un
widget en blanco — parece un fallo del programa y es un fallo de arquitectura.

Con este modo hay UN servidor y UNA carpeta de datos. Quien importa un widget
lo importa para todos.

CONFIGURACIÓN
    servidor_config.ini, junto al .exe. Se crea solo la primera vez.
    Las variables de entorno PSI_HOST y PSI_PUERTO tienen prioridad.

Ejecutar en desarrollo:  python desktop/servidor.py
Empaquetado:             dist/PsiCore_Servidor.exe  (ver build_exe.bat)
"""
from __future__ import annotations

import configparser
import os
import socket
import sys
from typing import List, Tuple

CONFIG_NOMBRE = "servidor_config.ini"

CONFIG_DEFECTO = """; ====================================================================
;  Psi Core · configuración del SERVIDOR
; ====================================================================
;  Este equipo es el que guarda TODO: pantallas, widgets, conexiones,
;  usuarios y el histórico. Los demás se conectan con el visor.
; ====================================================================

[servidor]
; 0.0.0.0 = aceptar conexiones de toda la red local. Es lo que hace falta
; para que los visores de tus compañeros lleguen hasta aquí.
;
; Si lo pones en 127.0.0.1, SOLO este equipo podrá abrirlo: el resto verá
; "no se puede conectar". Es el fallo más común al montar esto.
host = 0.0.0.0
puerto = 8000
"""


def _preparar_entorno() -> None:
    """
    Fija el directorio de trabajo.

    OJO con la distinción, que costó entenderla:

        junto al .exe   ->  CONFIGURACIÓN de la instalación (.env, .ini).
                            Es de solo lectura y se reemplaza al actualizar.
        ProgramData     ->  DATOS del usuario (PLCs, pantallas, widgets).
                            Sobrevive a desinstalar y actualizar.

    Antes todo caía en el primer sitio, así que actualizar de versión borraba
    la configuración de quien usaba el programa. La carpeta de datos la
    resuelve ahora `app/config/rutas.py`; aquí solo se fija el cwd.
    """
    if getattr(sys, "frozen", False):
        os.chdir(os.path.dirname(sys.executable))
    else:
        raiz = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        os.chdir(raiz)
        sys.path.insert(0, raiz)


def _dir_base() -> str:
    if getattr(sys, "frozen", False):
        return os.path.dirname(sys.executable)
    return os.path.dirname(os.path.abspath(__file__))


def _cargar_config() -> Tuple[str, int]:
    """
    Devuelve (host, puerto). Prioridad: entorno -> .ini -> valores por defecto.

    El entorno gana para poder cambiar el puerto sin tocar ficheros — útil
    cuando se arranca como servicio de Windows.
    """
    ruta = os.path.join(_dir_base(), CONFIG_NOMBRE)
    if not os.path.isfile(ruta):
        try:
            with open(ruta, "w", encoding="utf-8") as f:
                f.write(CONFIG_DEFECTO)
        except OSError:
            # Carpeta de solo lectura (Archivos de programa sin permisos):
            # se sigue con los valores por defecto en vez de no arrancar.
            pass

    cfg = configparser.ConfigParser()
    try:
        cfg.read(ruta, encoding="utf-8")
    except configparser.Error:
        pass

    host = os.getenv("PSI_HOST") or cfg.get(
        "servidor", "host", fallback="0.0.0.0").strip()
    try:
        puerto = int(os.getenv("PSI_PUERTO") or cfg.get(
            "servidor", "puerto", fallback="8000"))
    except (ValueError, configparser.Error):
        puerto = 8000
    return host, puerto


def _ips_locales() -> List[str]:
    """
    IPs de este equipo en la red local, para poder decírselas al usuario.

    Sin esto, montar el visor es un ejercicio de adivinación: el mensaje
    genérico "usa la IP de esta máquina" obliga a abrir una consola y
    ejecutar ipconfig, y a elegir bien entre varias interfaces.

    El truco del socket UDP no envía ni un byte: solo pregunta al sistema
    qué interfaz usaría para salir, que es justo la que ven los demás.
    """
    ips: List[str] = []
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
            ip = info[4][0]
            if ip not in ips:
                ips.append(ip)
    except OSError:
        pass

    # Se descartan dos familias que solo generarían confusión:
    #   127.x      -> bucle local; ningún otro equipo llega ahí.
    #   169.254.x  -> "APIPA", la que se autoasigna Windows cuando la tarjeta
    #                 se queda sin DHCP. Parece una IP normal y no encamina a
    #                 ninguna parte: si se la damos a alguien, se pasará la
    #                 tarde revisando el firewall por nada.
    return [ip for ip in ips
            if not ip.startswith("127.") and not ip.startswith("169.254.")]


def _puerto_libre(host: str, puerto: int) -> bool:
    """
    ¿Está el puerto disponible?

    Se comprueba ANTES de arrancar porque, si no, uvicorn falla con una traza
    de Python que no le dice nada a quien está instalando esto en la planta.
    """
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            s.bind(("" if host == "0.0.0.0" else host, puerto))
            return True
        finally:
            s.close()
    except OSError:
        return False


def main() -> None:
    _preparar_entorno()

    import uvicorn

    # Resolver la carpeta de datos ANTES de importar la app: aquí es donde se
    # migra la configuración de una versión anterior, y conviene que esté en
    # su sitio antes de que nadie la lea.
    from app.config.rutas import describir, resolver_carpeta_datos

    host, puerto = _cargar_config()
    datos = resolver_carpeta_datos()
    info = describir(datos)

    print("=" * 68)
    print("  PSI CORE  ·  SERVIDOR")
    print("=" * 68)
    print(f"  Datos:      {datos}")
    print(f"  Escuchando: {host}:{puerto}")
    print()

    if host == "127.0.0.1":
        print("  *** AVISO: host = 127.0.0.1")
        print("      Solo ESTE equipo podrá abrir la aplicación. Los visores")
        print("      de tus compañeros no llegarán.")
        print(f"      Pon  host = 0.0.0.0  en {CONFIG_NOMBRE} y reinicia.")
        print()
    else:
        print("  En este equipo:   http://localhost:%d" % puerto)
        ips = _ips_locales()
        if ips:
            print("  Desde los demás equipos, en su visor_config.ini:")
            for ip in ips:
                print(f"      host = {ip}")
                print(f"      puerto = {puerto}")
        else:
            print("  (no se pudo detectar la IP; míralas con  ipconfig )")
        print()

    if not info["escribible"]:
        # Sin permiso de escritura el servicio arranca igual y pierde todo lo
        # que se haga. Merece un aviso visible, no una línea de log.
        print("  *** AVISO: no se puede ESCRIBIR en la carpeta de datos.")
        print("      Todo lo que configuréis se perderá al cerrar.")
        print("      Ejecuta como administrador, o define PLC_DATOS_DIR")
        print("      apuntando a una carpeta con permisos.")
        print()

    if not _puerto_libre(host, puerto):
        print(f"  *** ERROR: el puerto {puerto} ya está ocupado.")
        print("      Puede que el servidor ya esté arrancado, o que otro")
        print("      programa lo esté usando. Comprobarlo con:")
        print(f"          netstat -ano | findstr :{puerto}")
        print(f"      O cambia 'puerto' en {CONFIG_NOMBRE}.")
        print("=" * 68)
        sys.exit(1)

    print("  Cerrar con Ctrl+C")
    print("=" * 68)

    from app.main import app  # la app ya configurada (React + WebSocket)

    uvicorn.run(app, host=host, port=puerto, log_level="info")


if __name__ == "__main__":
    main()
