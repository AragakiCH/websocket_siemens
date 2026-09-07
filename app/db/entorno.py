# -*- coding: utf-8 -*-
"""
entorno.py
==========
Qué hace falta INSTALAR en esta máquina para poder usar un motor de base de
datos, y qué falta ahora mismo.

EL PROBLEMA QUE RESUELVE

    El diagnóstico de `diagnostico.py` mira un error de conexión y dice qué
    significa. Pero llega tarde: para tener un error hay que haber intentado
    conectar, y para intentarlo hay que haber rellenado un formulario con
    host, usuario y contraseña de algo que quizá ni siquiera está instalado.

    Alguien que estrena el HMI en un PC nuevo no tiene un problema de
    credenciales: no tiene SQL Server. Y "no se pudo conectar a
    localhost:1433" no se lo dice — parece que hizo algo mal.

    Esto se pregunta ANTES, sin datos y sin intentar nada:

        ¿está el paquete de Python?      -> lo trae el propio programa
        ¿está el driver ODBC?            -> lo instala Microsoft, 5 MB
        ¿está el motor en esta máquina?  -> SQL Server Express, ~700 MB
        ¿responde su puerto?             -> puede estar apagado o sin TCP/IP

    Y con eso se puede decir la frase que de verdad hace falta: *"te falta
    SQL Server; se descarga de aquí y se instala así"*.

LO QUE **NO** HACE

    No descarga ni instala nada. Es deliberado: instalar SQL Server son cientos
    de megas, exige administrador y, si se corta a la mitad, deja la máquina en
    un estado que esta aplicación no sabría arreglar. Aquí se detecta y se
    explica; instalar lo decide una persona.

CÓMO SE DETECTA CADA COSA (y por qué así)

    Instancias de SQL Server -> el REGISTRO, no los servicios. La clave
        HKLM\\SOFTWARE\\Microsoft\\Microsoft SQL Server\\Instance Names\\SQL
        lista las instancias instaladas, se lee sin permisos de administrador
        y no depende de que el servicio esté arrancado ahora mismo. Mirar
        servicios confundiría "instalado pero parado" con "no instalado", que
        son dos consejos opuestos.

    Drivers ODBC -> `pyodbc.drivers()`, que es lo que ve de verdad el driver
        que usará la conexión. La lista del Administrador de orígenes de datos
        de Windows puede diferir por la separación 32/64 bits.

    El puerto -> un socket a `localhost` con timeout corto. Un motor instalado
        cuyo puerto no contesta es el caso clásico de SQL Server con TCP/IP
        deshabilitado (viene así de fábrica), y merece su propio consejo.
"""
from __future__ import annotations

import os
import socket
import sys
from typing import Any, Dict, List, Optional

from app.db.sql_driver import MOTORES

# Enlaces oficiales. Sin versión en la URL a propósito: Microsoft mantiene
# estas páginas y una URL con número de versión caduca sola.
DESCARGAS = {
    "sqlserver": "https://www.microsoft.com/es-es/sql-server/sql-server-downloads",
    "odbc": "https://learn.microsoft.com/sql/connect/odbc/download-odbc-driver-for-sql-server",
    "ssms": "https://learn.microsoft.com/sql/ssms/download-sql-server-management-studio-ssms",
    "mysql": "https://dev.mysql.com/downloads/installer/",
    "postgresql": "https://www.postgresql.org/download/windows/",
}

# Qué driver ODBC vale para cada motor. Se busca por subcadena, en minúsculas.
_ODBC_ESPERADO = {
    "mssql": ("sql server",),
    "mysql": ("mysql",),
    "postgresql": ("postgresql", "postgres"),
}


def es_windows() -> bool:
    return sys.platform.startswith("win")


# ====================================================================== #
# Sondas
# ====================================================================== #
def paquete_disponible(nombre: str) -> bool:
    """¿Está el paquete de Python del motor? Se importa de verdad."""
    if not nombre:
        return True
    try:
        __import__(nombre)
        return True
    except Exception:  # noqa: BLE001
        return False


def drivers_odbc() -> List[str]:
    """Drivers ODBC visibles para pyodbc. Lista vacía si no está instalado."""
    try:
        import pyodbc  # noqa: WPS433
        return sorted(pyodbc.drivers())
    except Exception:  # noqa: BLE001
        return []


def instancias_sql_server() -> List[str]:
    """
    Instancias de SQL Server instaladas en esta máquina.

    Se lee del registro porque es el único sitio que responde a la pregunta
    correcta: "¿está instalado?", no "¿está arrancado ahora?". `MSSQLSERVER`
    es la instancia por defecto (la que responde en `localhost` a secas); las
    demás son con nombre y se alcanzan como `localhost\\NOMBRE`.
    """
    if not es_windows():
        return []
    try:
        import winreg  # noqa: WPS433

        clave = r"SOFTWARE\Microsoft\Microsoft SQL Server\Instance Names\SQL"
        with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, clave) as k:
            total = winreg.QueryInfoKey(k)[1]
            return [winreg.EnumValue(k, i)[0] for i in range(total)]
    except FileNotFoundError:
        return []
    except Exception:  # noqa: BLE001
        return []


def puerto_abierto(host: str, puerto: int, espera: float = 0.8) -> bool:
    """¿Contesta algo en ese puerto? Timeout corto: esto bloquea una pantalla."""
    if not puerto:
        return False
    try:
        with socket.create_connection((host, puerto), timeout=espera):
            return True
    except Exception:  # noqa: BLE001
        return False


# ====================================================================== #
# Diagnóstico del entorno
# ====================================================================== #
def _falta(que: str, por_que: str, como: str, enlace: str = "",
           critico: bool = True) -> Dict[str, Any]:
    return {"que": que, "por_que": por_que, "como": como,
            "enlace": enlace, "critico": critico}


def revisar(motor: str = "mssql", host: str = "localhost",
            puerto: Optional[int] = None) -> Dict[str, Any]:
    """
    Qué hay y qué falta para usar `motor` en ESTA máquina.

    Devuelve siempre la misma forma:

        listo       -> True si se puede intentar conectar con sentido
        instalado   -> lo que se encontró, para poder enseñarlo tal cual
        faltantes   -> lista ordenada de lo que hay que resolver, cada una
                       con qué es, por qué hace falta, cómo se instala y el
                       enlace oficial

    El orden de `faltantes` importa: es el orden en el que hay que hacerlo.
    Instalar el driver ODBC sin tener SQL Server no arregla nada.
    """
    motor = (motor or "mssql").strip().lower()
    cfg = MOTORES.get(motor)
    if cfg is None:
        return {"ok": False, "motor": motor, "listo": False,
                "mensaje": f"Motor '{motor}' no soportado.",
                "instalado": {}, "faltantes": []}

    puerto = int(puerto or cfg["puerto"] or 0)
    etiqueta = cfg["etiqueta"]
    faltantes: List[Dict[str, Any]] = []

    # ---- SQLite: no hay nada que instalar ---------------------------
    if motor == "sqlite":
        hay = paquete_disponible(cfg["paquete"])
        return {
            "ok": True, "motor": motor, "etiqueta": etiqueta,
            "listo": hay, "sistema": sys.platform, "es_windows": es_windows(),
            "instalado": {"paquete": hay},
            "faltantes": [] if hay else [_falta(
                "El paquete aiosqlite",
                "SQLite va dentro del propio programa; solo falta su conector.",
                "pip install aiosqlite",
            )],
            "mensaje": ("SQLite no necesita instalar ningún servidor: la base "
                        "es un archivo en el disco."),
        }

    # ---- 1 · El conector de Python (lo trae el programa) -------------
    hay_paquete = paquete_disponible(cfg["paquete"])
    if not hay_paquete:
        faltantes.append(_falta(
            f"El paquete de Python «{cfg['paquete']}»",
            f"Es el conector que usa el servidor para hablar con {etiqueta}. "
            f"Sin él la conexión no se puede ni intentar.",
            f"pip install {cfg['paquete']}  (o reinstalar Psi Core, que ya lo "
            f"trae).",
        ))

    # ---- 2 · El driver ODBC (componente del sistema) -----------------
    #
    # Esta es la confusión más común y la que más tiempo hace perder: el
    # driver ODBC NO es un paquete de pip. Es un componente de Windows que
    # instala Microsoft aparte, y `pip install` no lo va a poner nunca.
    lista_odbc = drivers_odbc()
    esperados = _ODBC_ESPERADO.get(motor, ())
    compatibles = [d for d in lista_odbc
                   if any(p in d.lower() for p in esperados)]

    if motor == "mssql" and not compatibles:
        faltantes.append(_falta(
            "El ODBC Driver for SQL Server",
            "Es el componente de Windows que traduce entre el programa y SQL "
            "Server. No es un paquete de Python: `pip install` no lo instala.",
            "Descarga «ODBC Driver 18 for SQL Server» (x64), siguiente-"
            "siguiente. Son unos 5 MB y no pide reiniciar.",
            DESCARGAS["odbc"],
        ))

    # ---- 3 · El motor en esta máquina --------------------------------
    instancias = instancias_sql_server() if motor == "mssql" else []
    abierto = puerto_abierto(host, puerto) if puerto else False

    if motor == "mssql":
        if not instancias and not abierto:
            # Ni instalado aquí ni respondiendo: es el caso "PC recién
            # estrenado". Se dice lo que hay que bajar y cómo configurarlo,
            # porque las dos casillas que hacen falta no vienen marcadas.
            faltantes.append(_falta(
                "SQL Server (edición Express, gratuita)",
                "No hay ninguna instancia de SQL Server instalada en este "
                "equipo, y nada responde en el puerto "
                f"{puerto}. Es donde vivirán las cuentas, las alarmas y las "
                "recetas.",
                "Descarga SQL Server Express e instálalo con la opción "
                "«Básica». Después, en el instalador o con SQL Server "
                "Configuration Manager, activa DOS cosas que NO vienen "
                "activadas de fábrica: (1) el protocolo TCP/IP de la "
                "instancia, y (2) el modo de autenticación mixto, si vas a "
                "entrar con usuario y contraseña en vez de con tu cuenta de "
                "Windows. Reinicia el servicio al terminar.",
                DESCARGAS["sqlserver"],
            ))
        elif instancias and not abierto:
            # Instalado pero sin responder. Hay DOS causas muy distintas, y
            # confundirlas hace perder una tarde entera:
            #
            #   (a) El host apunta a la instancia POR DEFECTO (`localhost` a
            #       secas) pero en el equipo solo hay instancias CON NOMBRE.
            #       Entonces no falta encender nada: falta escribir bien el
            #       host. Es el caso más común en un PC de planta, donde otro
            #       producto (WinCC, TIA) ya instaló las suyas.
            #
            #   (b) El host es correcto pero TCP/IP está apagado.
            #
            # Antes se daba siempre el consejo (b), que en el caso (a) manda a
            # la gente a reconfigurar la red de una instancia ajena para
            # arreglar un problema que no tenía.
            pide_instancia_defecto = "\\" not in (host or "") and "/" not in (host or "")

            if pide_instancia_defecto:
                lista = ", ".join(f"{host}\\{i}" for i in instancias)
                faltantes.append(_falta(
                    "Indicar la instancia de SQL Server en el campo «Host»",
                    f"En este equipo NO hay instancia por defecto: solo hay "
                    f"instancias CON NOMBRE ({', '.join(instancias)}). Por eso "
                    f"nada responde en {host}:{puerto} — ese puerto es el de la "
                    f"instancia por defecto, que aquí no existe. Una instancia "
                    f"con nombre usa un puerto distinto en cada arranque, y el "
                    f"servicio «SQL Server Browser» es quien le dice al cliente "
                    f"cuál es.",
                    f"En el campo «Host» escribe la instancia completa, por "
                    f"ejemplo: {lista}. El campo «Puerto» se ignora en ese "
                    f"caso. Comprueba además que el servicio «SQL Server "
                    f"Browser» esté iniciado y que la instancia tenga TCP/IP "
                    f"habilitado (Configuration Manager → Protocolos de "
                    f"<instancia> → TCP/IP → Habilitado = Sí).",
                    "",
                ))
            else:
                instancia = (host or "").replace("/", "\\").partition("\\")[2]
                faltantes.append(_falta(
                    f"Encender el acceso por red de la instancia «{instancia}»",
                    f"La instancia existe, pero no acepta conexiones por red. "
                    f"De fábrica SQL Server viene con el protocolo TCP/IP "
                    f"desactivado y solo admite conexiones locales por memoria "
                    f"compartida — por eso SSMS entra y esta aplicación no.",
                    f"Abre «SQL Server Configuration Manager» → Configuración "
                    f"de red de SQL Server → Protocolos de {instancia} → TCP/IP "
                    f"→ Habilitado = Sí. Reinicia el servicio «SQL Server "
                    f"({instancia})». Con el nombre de instancia en el host NO "
                    f"hace falta fijar ningún puerto: lo resuelve SQL Server "
                    f"Browser. Si el equipo tiene cortafuegos, abre el puerto "
                    f"UDP 1434 (el de Browser).",
                    "",
                ))
    else:
        if not abierto:
            enlace = DESCARGAS.get("mysql" if motor == "mysql" else "postgresql", "")
            faltantes.append(_falta(
                f"{etiqueta} en esta máquina",
                f"Nada responde en {host}:{puerto}. O no está instalado, o el "
                f"servicio está parado, o escucha en otro puerto.",
                f"Si no lo tienes, descárgalo e instálalo. Si ya lo tienes, "
                f"comprueba que el servicio esté arrancado y que el puerto sea "
                f"{puerto}.",
                enlace,
            ))

    # ---- 4 · Recomendación, no requisito ------------------------------
    # SSMS no hace falta para nada: el HMI crea la base solo. Se menciona
    # aparte, marcado como NO crítico, para que nadie crea que sin él no
    # puede seguir.
    if motor == "mssql" and es_windows() and instancias:
        faltantes.append(_falta(
            "SQL Server Management Studio (opcional)",
            "No hace falta para usar Psi Core: la base y las tablas las crea "
            "esta misma pantalla. Es útil para mirar los datos por tu cuenta.",
            "Instálalo solo si quieres inspeccionar la base a mano.",
            DESCARGAS["ssms"],
            critico=False,
        ))

    criticos = [f for f in faltantes if f["critico"]]
    return {
        "ok": True,
        "motor": motor,
        "etiqueta": etiqueta,
        "listo": not criticos,
        "sistema": sys.platform,
        "es_windows": es_windows(),
        "instalado": {
            "paquete": hay_paquete,
            "drivers_odbc": lista_odbc,
            "drivers_compatibles": compatibles,
            "instancias": instancias,
            "puerto": puerto,
            "puerto_abierto": abierto,
            "host": host,
        },
        "faltantes": faltantes,
        "mensaje": _resumen(etiqueta, criticos, instancias, abierto),
    }


def _resumen(etiqueta: str, criticos: List[Dict[str, Any]],
             instancias: List[str], abierto: bool) -> str:
    """Una frase. La que se lee cuando nadie quiere leer la lista entera."""
    if not criticos:
        if instancias:
            return (f"{etiqueta} está instalado y responde. Ya puedes crear la "
                    f"base de datos desde aquí.")
        return f"Todo lo necesario para {etiqueta} está en su sitio."
    if len(criticos) == 1:
        return f"Falta una cosa: {criticos[0]['que'].lower()}."
    return (f"Faltan {len(criticos)} cosas para poder usar {etiqueta}. "
            f"Están en orden: la primera es la que desbloquea el resto.")
