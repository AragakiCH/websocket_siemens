# -*- coding: utf-8 -*-
"""
diagnostico.py
==============
Traduce el error crudo de un driver de base de datos a algo accionable.

POR QUÉ EXISTE ESTE MÓDULO
--------------------------
Configurar una conexión falla por seis motivos distintos, y los drivers los
reportan todos igual de mal. Una sesión real de puesta en marcha produjo, en
este orden:

    IM002 · No se encuentra el nombre del origen de datos      -> faltaba el driver ODBC
    10061 · el equipo de destino denegó expresamente...         -> TCP/IP deshabilitado
    18456 · Login failed for user 'hmi_app'                     -> autenticación en modo Windows

Ninguno de los tres dice qué hacer, y el segundo ni siquiera menciona que el
problema esté en la configuración de red del servidor. Cada uno costó una
vuelta entera de prueba y error.

La información SÍ está en el error: el código concreto lo identifica sin
ambigüedad. Lo único que faltaba era traducirlo.

LO QUE ESTE MÓDULO NO HACE
--------------------------
**No adivina si un motor está instalado.** No se puede, y prometerlo sería
mentir. Lo único observable es si algo responde en `host:puerto`, y eso tiene
al menos cuatro causas: no instalado, instalado pero parado, escuchando en otro
puerto, o tapado por un firewall.

El caso de arriba lo demuestra: SQL Server estaba instalado, corriendo y con la
base creada — y no respondía porque TCP/IP estaba apagado. Un mensaje que
dijera "no tienes SQL Server instalado" habría mandado a esa persona a
descargar un instalador que no necesitaba.

Por eso los mensajes de `sin_servidor` describen lo observado ("nada responde
en X") y enumeran las causas, en vez de elegir una.

TAMPOCO OCULTA EL ERROR ORIGINAL
--------------------------------
`detalle` siempre lleva el texto crudo del driver. Un diagnóstico que se
equivoque no debe dejar a nadie sin la información real: cuando la traducción
falla, el texto original es lo único que permite buscar en Google.
"""
from __future__ import annotations

import re
from typing import Any, Dict, Optional

# Códigos posibles. El frontend puede actuar sobre ellos (por ejemplo, ofrecer
# "crear la base de datos" solo ante `base_no_existe`).
FALTA_PAQUETE = "falta_paquete"
FALTA_DRIVER = "falta_driver"
SIN_SERVIDOR = "sin_servidor"
HOST_DESCONOCIDO = "host_desconocido"
CREDENCIALES = "credenciales"
BASE_NO_EXISTE = "base_no_existe"
SIN_PERMISOS = "sin_permisos"
RUTA_NO_EXISTE = "ruta_no_existe"
TLS = "tls"
TIMEOUT = "timeout"
DESCONOCIDO = "desconocido"

_LOCALES = {"localhost", "127.0.0.1", "::1", ".", "(local)", ""}

_ETIQUETA = {
    "postgresql": "PostgreSQL",
    "mysql": "MySQL / MariaDB",
    "mssql": "SQL Server",
    "sqlite": "SQLite",
}

_PAQUETE = {
    "postgresql": "asyncpg",
    "mysql": "aiomysql",
    "mssql": "aioodbc",
    "sqlite": "aiosqlite",
}

# Servicio a comprobar cuando el motor está en la máquina local.
_SERVICIO_LOCAL = {
    "postgresql": "postgresql",
    "mysql": "mysql (o mariadb)",
    "mssql": "SQL Server (MSSQLSERVER)",
}


def _texto(exc: BaseException) -> str:
    """
    Todo el texto disponible del error, incluida la excepción original.

    SQLAlchemy envuelve el error del driver en `DBAPIError` y guarda el
    original en `.orig`. El código concreto (1049, 18456, IM002...) suele estar
    solo ahí, así que mirar únicamente `str(exc)` pierde justo el dato que
    identifica el problema.
    """
    partes = []
    visto = set()
    actual: Optional[BaseException] = exc
    while actual is not None and id(actual) not in visto:
        visto.add(id(actual))
        partes.append(f"{type(actual).__name__}: {actual}")
        orig = getattr(actual, "orig", None)
        actual = orig if orig is not None else actual.__cause__
    return "\n".join(partes)


def _destino(host: str, puerto: Optional[int]) -> str:
    if not host:
        return "el servidor"
    return f"{host}:{puerto}" if puerto else host


def _es_local(host: str) -> bool:
    return (host or "").strip().lower() in _LOCALES


def _pista_servidor(motor: str, host: str, puerto: Optional[int]) -> str:
    """Qué mirar cuando nada responde. Cambia si el motor es local o remoto."""
    etiqueta = _ETIQUETA.get(motor, motor)
    if _es_local(host):
        servicio = _SERVICIO_LOCAL.get(motor, etiqueta)
        base = (
            f"No se puede saber desde aquí si {etiqueta} está instalado; solo "
            f"que nada contesta. Comprueba, en este orden: que el servicio "
            f"'{servicio}' esté iniciado, que escuche por TCP/IP, y que lo "
            f"haga en el puerto {puerto or 'configurado'}."
        )
        if motor == "mssql":
            # Merece mención propia: es el fallo más común y el menos evidente,
            # porque SSMS entra por memoria compartida y funciona igual.
            base += (
                " En SQL Server, TCP/IP viene DESHABILITADO de fábrica en "
                "muchas instalaciones: SSMS conecta igual (usa memoria "
                "compartida) pero ninguna aplicación externa puede. Se activa "
                "en SQL Server Configuration Manager y exige reiniciar el "
                "servicio."
            )
        return base
    return (
        f"Nada responde en {_destino(host, puerto)}. Comprueba que la máquina "
        f"esté encendida, que {etiqueta} esté corriendo, que acepte conexiones "
        f"remotas y que el puerto esté abierto en el firewall."
    )


def diagnosticar(
    exc: BaseException,
    *,
    motor: str,
    host: str = "",
    puerto: Optional[int] = None,
    base_datos: str = "",
    opciones: Optional[Dict[str, str]] = None,
    forzar: str = "",
    nota: str = "",
) -> Dict[str, Any]:
    """
    Clasifica el fallo de una conexión.

    Devuelve `{codigo, titulo, mensaje, sugerencia, detalle}`. `codigo` es
    estable y pensado para que el frontend actúe (ofrecer crear la base,
    resaltar el campo de contraseña...). `detalle` es SIEMPRE el error crudo.

    `forzar` existe porque hay un error AMBIGUO que el texto no puede resolver:
    SQL Server manda `18456` ("login failed") y `4060` ("cannot open database")
    **a la vez**, tanto si falta la base como si falta el login. Quien sí puede
    distinguirlos es una segunda conexión contra `master`, y su conclusión
    entra por aquí — ver `provision.afinar_diagnostico()`.

    `nota` explica CÓMO se supo, y se antepone a la sugerencia: un diagnóstico
    que afirma más de lo que dice el error debe enseñar en qué se basa.
    """
    texto = _texto(exc)
    bajo = texto.lower()
    etiqueta = _ETIQUETA.get(motor, motor)
    destino = _destino(host, puerto)
    opciones = opciones or {}

    def r(codigo: str, titulo: str, mensaje: str, sugerencia: str) -> Dict[str, Any]:
        return {"codigo": codigo, "titulo": titulo, "mensaje": mensaje,
                "sugerencia": f"{nota} {sugerencia}".strip(),
                "detalle": texto, "motor": motor}

    # ---- Las dos ramas ambiguas, extraídas para poder forzarlas -------
    def dx_base_no_existe() -> Dict[str, Any]:
        return r(
            BASE_NO_EXISTE,
            f"La base de datos '{base_datos}' no existe",
            f"El servidor de {etiqueta} respondió y aceptó las credenciales, "
            f"pero no encuentra una base llamada '{base_datos}'.",
            "Comprueba que esté bien escrita (en algunos motores distingue "
            "mayúsculas), o créala. En SQL Server este error aparece también "
            "cuando la base existe pero el login no tiene un USER mapeado "
            "dentro de ella.",
        )

    def dx_credenciales() -> Dict[str, Any]:
        quien = usuario_de(texto)
        titulo = (f"El servidor rechazó el usuario '{quien}'" if quien
                  else "El servidor rechazó las credenciales")
        extra = ""
        if motor == "mssql" and quien.lower() == "sa":
            # `sa` merece su propio mensaje. Cuando SQL Server se instala en
            # modo "solo Windows" —lo habitual— el instalador deja la cuenta
            # `sa` DESHABILITADA y sin contraseña conocida. Activar después el
            # modo mixto NO la reactiva, así que se queda un servidor que sí
            # acepta autenticación SQL y un `sa` que sigue sin poder entrar.
            # Sin decirlo, uno prueba contraseñas que nunca van a funcionar.
            extra = (
                " Ojo con 'sa' en particular: si SQL Server se instaló en modo "
                "'solo Windows', esa cuenta quedó DESHABILITADA y activar "
                "después el modo mixto no la reactiva. Compruébalo con "
                "SELECT name, is_disabled FROM sys.server_principals WHERE "
                "name = 'sa'; y actívala con ALTER LOGIN sa ENABLE; ALTER "
                "LOGIN sa WITH PASSWORD = '...'; — o mejor, usa otra cuenta "
                "sysadmin, o la autenticación de Windows del servidor."
            )
        elif motor == "mssql":
            extra = (
                " En SQL Server esto ocurre también cuando el servidor está en "
                "modo 'solo Windows': el login existe y la contraseña es "
                "correcta, pero no se aceptan sesiones con usuario y "
                "contraseña. Se cambia a modo mixto y se reinicia el servicio."
            )
        return r(
            CREDENCIALES,
            titulo,
            f"Se llegó al servidor de {etiqueta} y contestó, pero no aceptó "
            f"estas credenciales.",
            "Revisa que el usuario exista y que la contraseña sea correcta, y "
            "que la cuenta esté activa." + extra,
        )

    if forzar == BASE_NO_EXISTE:
        return dx_base_no_existe()
    if forzar == CREDENCIALES:
        return dx_credenciales()

    # ---- 1 · Falta la librería de Python -----------------------------
    # Va primero porque sin ella no se llega ni a intentar la conexión:
    # cualquier otro diagnóstico sería inventado.
    if isinstance(exc, ModuleNotFoundError) or "no module named" in bajo:
        paquete = _PAQUETE.get(motor, "")
        return r(
            FALTA_PAQUETE,
            f"Falta el conector de Python para {etiqueta}",
            f"El backend no tiene instalada la librería que habla con "
            f"{etiqueta}, así que no puede ni intentar la conexión.",
            f"En la máquina del backend, con el entorno virtual activo: "
            f"pip install {paquete}   (y reinicia el servicio).",
        )

    # ---- 2 · SQLite: el fichero o su carpeta ---------------------------
    if motor == "sqlite":
        if "unable to open database file" in bajo:
            return r(
                RUTA_NO_EXISTE,
                "No se puede abrir el fichero de la base",
                f"SQLite crea el fichero solo si su CARPETA ya existe. La ruta "
                f"indicada ('{base_datos}') apunta a un directorio que no "
                f"existe en la máquina del backend, o sobre el que no tiene "
                f"permiso de escritura.",
                "Revisa la ruta y usa una absoluta de esa máquina. Ojo con "
                "mezclar sistemas: una ruta de Linux como /tmp/datos.db no "
                "existe en Windows, y al revés.",
            )
        if "readonly database" in bajo or "attempt to write a readonly" in bajo:
            return r(
                SIN_PERMISOS,
                "El fichero es de solo lectura",
                f"El backend puede leer '{base_datos}' pero no escribir en él.",
                "Revisa los permisos del fichero y de su carpeta para el "
                "usuario con el que corre el backend.",
            )

    # ---- 3 · Falta el driver ODBC del sistema (solo SQL Server) --------
    if "im002" in bajo or "data source name not found" in bajo or \
       "no se encuentra el nombre del origen de datos" in bajo:
        pedido = opciones.get("driver", "")
        return r(
            FALTA_DRIVER,
            "Falta el driver ODBC en el sistema",
            f"Windows no tiene instalado el driver "
            f"{'«' + pedido + '»' if pedido else 'ODBC indicado'}. El driver "
            f"ODBC es un componente del sistema operativo, no un paquete de "
            f"Python: pip no lo instala.",
            "Mira GET /db/drivers para ver los que SÍ están instalados y elige "
            "uno de esa lista, o instala el 'Microsoft ODBC Driver 18 for SQL "
            "Server' desde la web de Microsoft.",
        )

    # ---- 4 · El nombre del host no resuelve ----------------------------
    if ("getaddrinfo failed" in bajo or "name or service not known" in bajo
            or "unknown mysql server host" in bajo
            or "nodename nor servname" in bajo
            or "temporary failure in name resolution" in bajo):
        return r(
            HOST_DESCONOCIDO,
            "No se encuentra ese nombre de servidor",
            f"'{host}' no se puede traducir a una dirección de red desde la "
            f"máquina del backend.",
            "Comprueba que esté bien escrito. Si es un nombre de red interna, "
            "prueba con su dirección IP directamente.",
        )

    # ---- 5 · Nadie escucha ahí -----------------------------------------
    # Los tres motores lo dicen de forma distinta, y ninguno de forma clara.
    patrones_sin_servidor = (
        "10061", "connection refused", "connect call failed",
        "actively refused", "deneg", "econnrefused",
        "can't connect to mysql server", "could not connect to server",
        "could not open a connection to sql server",
        "no se puede establecer una conexi",
    )
    if any(p in bajo for p in patrones_sin_servidor):
        return r(
            SIN_SERVIDOR,
            f"Nada responde en {destino}",
            f"Se llegó hasta la máquina, pero no hay ningún servicio "
            f"escuchando en el puerto indicado.",
            _pista_servidor(motor, host, puerto),
        )

    # ---- 6 · Se agotó el tiempo ----------------------------------------
    if ("login timeout expired" in bajo or "hyt00" in bajo
            or "timeout expired" in bajo or "timed out" in bajo
            or isinstance(exc, TimeoutError)):
        return r(
            TIMEOUT,
            f"Se agotó el tiempo esperando a {destino}",
            "La máquina no contestó ni para aceptar ni para rechazar. Suele "
            "ser un firewall que descarta los paquetes en silencio, o un "
            "servidor apagado.",
            _pista_servidor(motor, host, puerto),
        )

    # ---- 7 · Cifrado / certificado -------------------------------------
    if ("certificate chain" in bajo or "ssl provider" in bajo
            or "certificate verify failed" in bajo
            or "self signed certificate" in bajo
            or "self-signed certificate" in bajo):
        return r(
            TLS,
            "El certificado del servidor no es de confianza",
            "El servidor presenta un certificado autofirmado —lo normal en un "
            "contenedor o en una instancia local— y el driver lo rechaza. El "
            "ODBC Driver 18 exige cifrado de fábrica, por eso aparece con él y "
            "no con el 17.",
            'Marca "Confiar en el certificado del servidor" '
            '(TrustServerCertificate), o usa un certificado emitido por una '
            'autoridad en la que el equipo confíe.',
        )

    # ---- 8 · La base de datos no existe --------------------------------
    # Es el caso que habilita "¿quieres crearla?" en la interfaz, así que se
    # distingue con cuidado de un problema de permisos, que se parece mucho.
    patrones_base = (
        "4060", "cannot open database", "unknown database", "1049",
        "3d000", "does not exist", "no existe la base de datos",
        "invalidcatalogname",
    )
    hay_base = any(p in bajo for p in patrones_base)

    # ---- 9 · Credenciales ------------------------------------------------
    patrones_credenciales = (
        "18456", "login failed for user", "access denied for user", "1045",
        "28p01", "28000", "password authentication failed",
        "authentication failed", "invalidpassword",
    )
    hay_credenciales = any(p in bajo for p in patrones_credenciales)

    # SQL Server manda LOS DOS códigos a la vez —"Login failed (18456)" y
    # "Cannot open database ... (4060)"— tanto si falta la base como si falta
    # el login. Leyendo el texto no se pueden distinguir.
    #
    # Ante el empate gana el diagnóstico que NO promete de más: un fallo de
    # credenciales no invita a crear nada, mientras que afirmar "la base no
    # existe" sobre una base que sí existe llevaría a ofrecer crearla encima.
    #
    # `provision.afinar_diagnostico()` deshace el empate de verdad, probando
    # esas mismas credenciales contra la base de mantenimiento.
    if hay_base and hay_credenciales:
        d = dx_credenciales()
        d["ambiguo"] = True
        d["sugerencia"] += (
            f" Si el usuario y la contraseña son correctos, la otra causa "
            f"posible es que '{base_datos}' no exista o que ese login no tenga "
            f"acceso a ella: el servidor manda los dos errores juntos."
        )
        return d
    if hay_base:
        return dx_base_no_existe()
    if hay_credenciales:
        return dx_credenciales()

    # ---- 10 · Permisos ---------------------------------------------------
    patrones_permisos = (
        "permission was denied", "permission denied", "42501",
        "1044", "insufficientprivilege", "the server principal",
        "no tiene permiso",
    )
    if any(p in bajo for p in patrones_permisos):
        return r(
            SIN_PERMISOS,
            "El usuario entra, pero no tiene permisos suficientes",
            f"Las credenciales son válidas y el servidor las aceptó, pero esa "
            f"cuenta no puede operar sobre '{base_datos}'.",
            "El HMI necesita leer y escribir filas. En SQL Server, añade el "
            "usuario a db_datareader y db_datawriter dentro de esa base; en "
            "MySQL y PostgreSQL, concédele SELECT/INSERT/UPDATE/DELETE.",
        )

    # ---- 11 · Sin clasificar --------------------------------------------
    # Preferible a inventarse una causa: se devuelve el error tal cual, que es
    # lo que permite buscarlo.
    return r(
        DESCONOCIDO,
        "No se pudo conectar",
        f"El intento de conexión a {etiqueta} en {destino} falló por un motivo "
        f"que no se ha podido clasificar.",
        "El detalle técnico de abajo es el mensaje literal del driver.",
    )


# Cada driver cita el usuario a su manera: pyodbc y pymysql con comillas
# simples, asyncpg con dobles.
_RE_USUARIO = re.compile(r"""user\s+['"]([^'"]+)['"]""", re.IGNORECASE)


def usuario_de(texto: str) -> str:
    """Nombre de usuario mencionado en el error, si el driver lo incluye."""
    m = _RE_USUARIO.search(texto or "")
    return m.group(1) if m else ""
