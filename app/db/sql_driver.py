# -*- coding: utf-8 -*-
"""
sql_driver.py
=============
Driver único para todas las bases de datos SQL, usando **SQLAlchemy 2.x async**.

Un solo driver cubre PostgreSQL, MySQL/MariaDB, SQL Server y SQLite: lo único
que cambia entre motores es la URL de conexión y el paquete instalado. Por eso
no hace falta una clase por motor.

Seguridad (importante, esto es un HMI que usa gente de planta):

  * **Solo lectura**: `validar_sql_lectura()` rechaza cualquier sentencia que
    no sea SELECT/WITH, y bloquea palabras destructivas (DROP, DELETE,
    UPDATE, INSERT, TRUNCATE, ALTER, GRANT...). Es una segunda barrera: la
    primera debería ser un usuario de BD con permisos de solo lectura.
  * **Parámetros bindeados**: los valores viajan por el mecanismo del motor
    (`:nombre`), nunca concatenados en el texto del SQL. Esto es lo que
    realmente impide la inyección.
  * **Límite de filas**: toda consulta se corta (LIMIT por defecto 1000) para
    que un `SELECT *` sobre una tabla de millones no tumbe el servidor ni el
    navegador.
  * **Timeout**: una consulta lenta no puede bloquear el resto del servicio.
"""
from __future__ import annotations

import asyncio
import logging
import re
import time
from datetime import date, datetime, time as dtime, timezone
from decimal import Decimal
from typing import Any, Dict, List, Optional, Tuple
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.engine import URL
from sqlalchemy.ext.asyncio import AsyncEngine, create_async_engine

from app.db.db_driver import DbDriver, ResultadoConsulta

logger = logging.getLogger("sql_driver")


# ====================================================================== #
# Motores soportados
# ====================================================================== #
# motor -> (prefijo de URL SQLAlchemy, puerto por defecto, paquete requerido)
MOTORES: Dict[str, Dict[str, Any]] = {
    "postgresql": {
        "prefijo": "postgresql+asyncpg",
        "puerto": 5432,
        "paquete": "asyncpg",
        "etiqueta": "PostgreSQL",
    },
    "mysql": {
        "prefijo": "mysql+aiomysql",
        "puerto": 3306,
        "paquete": "aiomysql",
        "etiqueta": "MySQL / MariaDB",
    },
    "mssql": {
        "prefijo": "mssql+aioodbc",
        "puerto": 1433,
        "paquete": "aioodbc",
        "etiqueta": "SQL Server",
    },
    "sqlite": {
        "prefijo": "sqlite+aiosqlite",
        "puerto": None,
        "paquete": "aiosqlite",
        "etiqueta": "SQLite",
    },
}


# ====================================================================== #
# Validación de SQL de solo lectura
# ====================================================================== #
# Sentencias que modifican datos o estructura: prohibidas en los widgets.
PALABRAS_PROHIBIDAS = {
    "insert", "update", "delete", "drop", "truncate", "alter", "create",
    "grant", "revoke", "exec", "execute", "call", "merge", "replace",
    "attach", "detach", "vacuum", "pragma", "shutdown", "backup", "restore",
}

_COMENTARIOS = re.compile(r"(--[^\n]*)|(/\*.*?\*/)", re.DOTALL)


def limpiar_sql(sql: str) -> str:
    """Quita comentarios y espacios sobrantes (para analizar la sentencia)."""
    return _COMENTARIOS.sub(" ", sql or "").strip().rstrip(";").strip()


def validar_sql_lectura(sql: str) -> None:
    """
    Valida que `sql` sea UNA sola sentencia de lectura.

    Lanza ValueError con un mensaje claro si no lo es. Esta función es la
    barrera de seguridad del backend: se llama siempre antes de ejecutar,
    tanto en consultas guardadas como en pruebas desde el diseñador.
    """
    limpio = limpiar_sql(sql)
    if not limpio:
        raise ValueError("La consulta está vacía.")

    # Una sola sentencia: nada de "SELECT 1; DROP TABLE x".
    if ";" in limpio:
        raise ValueError(
            "Solo se permite UNA sentencia por consulta (se encontró ';')."
        )

    bajo = limpio.lower()
    if not (bajo.startswith("select") or bajo.startswith("with")):
        raise ValueError(
            "Solo se permiten consultas de lectura: la sentencia debe empezar "
            "por SELECT o WITH."
        )

    # Palabras destructivas en cualquier posición (subconsultas incluidas).
    palabras = set(re.findall(r"[a-zA-Z_]+", bajo))
    encontradas = palabras & PALABRAS_PROHIBIDAS
    if encontradas:
        raise ValueError(
            "La consulta contiene sentencias no permitidas: "
            f"{', '.join(sorted(encontradas)).upper()}. Los widgets solo "
            "pueden leer datos."
        )


# ====================================================================== #
# Identificadores (nombres de tabla)
# ====================================================================== #
_RE_IDENT = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,62}$")


def _nombre_seguro(nombre: str) -> str:
    """
    Valida un nombre de tabla. Los identificadores NO se pueden bindear como
    parámetros, así que la única defensa es una lista blanca de caracteres:
    letras, dígitos y guion bajo, empezando por letra.
    """
    nombre = (nombre or "").strip()
    if not _RE_IDENT.match(nombre):
        raise ValueError(
            f"Nombre de tabla inválido: '{nombre}'. Solo letras, dígitos y "
            f"guion bajo, empezando por letra (máx. 63 caracteres)."
        )
    return nombre


_RE_PREFIJO = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,20}$")


def _prefijo_seguro(prefijo: str) -> str:
    """
    Valida el prefijo opcional de las tablas del esquema estándar.

    Sirve para que dos instalaciones puedan convivir en la misma base de datos
    (`planta1_usuarios`, `planta2_usuarios`). Vacío = sin prefijo. Como es un
    identificador, se valida con lista blanca igual que los nombres de tabla.
    """
    prefijo = (prefijo or "").strip()
    if not prefijo:
        return ""
    if not _RE_PREFIJO.match(prefijo):
        raise ValueError(
            f"Prefijo inválido: '{prefijo}'. Solo letras, dígitos y guion "
            f"bajo, empezando por letra (máx. 21 caracteres)."
        )
    return prefijo if prefijo.endswith("_") else f"{prefijo}_"


# ====================================================================== #
# SQL Server: instancias con nombre y driver ODBC
# ====================================================================== #
def _host_e_instancia(host: str) -> Tuple[str, str]:
    """
    Separa `HOST\\INSTANCIA` en sus dos partes.

    Acepta las tres formas en las que la gente lo escribe de verdad:
    `localhost\\SQLEXPRESS`, `localhost\\\\SQLEXPRESS` (pegado desde una cadena
    de conexión con la barra escapada) y `localhost/SQLEXPRESS` (por costumbre
    de escribir rutas con barra normal).

    Devuelve `(host, "")` si no hay instancia.
    """
    h = (host or "").strip()
    if not h:
        return "", ""
    # Normaliza la barra doble y la barra normal a una sola invertida.
    normal = h.replace("\\\\", "\\").replace("/", "\\")
    if "\\" not in normal:
        return h, ""
    base, _, inst = normal.partition("\\")
    return base.strip(), inst.strip()


def _quiere_puerto_fijo(opciones: Optional[Dict[str, Any]]) -> bool:
    """
    True si el usuario fijó un puerto estático a su instancia con nombre.

    Por defecto NO se manda el puerto junto a la instancia, porque lo habitual
    es el puerto dinámico. Quien haya seguido el consejo de fijar el 1433 puede
    activarlo con `opciones = {"puerto_fijo": "si"}`.
    """
    if not opciones:
        return False
    v = str(opciones.get("puerto_fijo", "")).strip().lower()
    return v in ("1", "si", "sí", "true", "yes", "on")


def drivers_odbc_instalados() -> List[str]:
    """
    Drivers ODBC de SQL Server presentes en el sistema, del mejor al peor.

    Se apoya en `pyodbc`, que es lo que ve de verdad el driver por debajo. Si
    `pyodbc` no está (Linux sin ODBC, por ejemplo), devuelve lista vacía y el
    llamador cae a un valor razonable.
    """
    try:
        import pyodbc  # noqa: PLC0415
        todos = list(pyodbc.drivers())
    except Exception:  # noqa: BLE001
        return []

    def preferencia(nombre: str) -> tuple:
        # ODBC Driver N (mayor N primero) > Native Client > "SQL Server".
        m = re.match(r"^ODBC Driver (\d+) for SQL Server$", nombre.strip(), re.I)
        if m:
            return (0, -int(m.group(1)), nombre)
        if "native client" in nombre.lower():
            return (1, 0, nombre)
        return (2, 0, nombre)

    return sorted(
        {d for d in todos if "sql server" in d.lower()}, key=preferencia
    )


def driver_odbc_por_defecto() -> str:
    """
    El mejor driver ODBC instalado, o el 17 como último recurso.

    El 17 sigue siendo el fallback porque es el más extendido, pero solo se usa
    cuando NO se pudo mirar qué hay instalado. Antes era el valor fijo, y en un
    equipo con otro driver la conexión moría con un error que no señalaba al
    driver por ningún lado.
    """
    instalados = drivers_odbc_instalados()
    return instalados[0] if instalados else "ODBC Driver 17 for SQL Server"


# ====================================================================== #
# Marcas de tiempo: todo se guarda en UTC, de forma determinista
# ====================================================================== #
def a_utc(valor: Any) -> Optional[datetime]:
    """
    Convierte cualquier marca de tiempo a un `datetime` **aware en UTC**.

    Acepta cadenas ISO 8601 (con o sin offset, con 'Z' o con '+00:00'),
    `datetime` (aware o naive) y None. Una marca naive se asume UTC, que es lo
    que emiten los dos drivers de PLC (`SourceTimestamp` de OPC UA es UTC por
    especificación).
    """
    if valor is None:
        return None
    if isinstance(valor, datetime):
        dt = valor
    else:
        texto = str(valor).strip()
        if not texto:
            return None
        # `fromisoformat` de Python <3.11 no entiende la 'Z' final.
        if texto.endswith("Z"):
            texto = texto[:-1] + "+00:00"
        try:
            dt = datetime.fromisoformat(texto)
        except ValueError:
            return None
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def ts_para_motor(valor: Any, motor: str) -> Any:
    """
    Adapta una marca de tiempo al tipo que espera cada motor, SIEMPRE en UTC.

    Esto existe por un problema real y silencioso: si se le pasa a MySQL la
    cadena ISO `'2026-08-17T20:54:08+00:00'`, MySQL 8.0.19+ la convierte a la
    zona horaria **de sesión del servidor** antes de guardarla en un `DATETIME`
    (que no almacena zona). Resultado: la misma instalación guarda una hora
    distinta según el `time_zone` del servidor, y al leer ya no hay forma de
    saber en qué zona está el dato.

    La solución es no delegar nunca esa conversión en el motor:

      * PostgreSQL (`TIMESTAMPTZ`) -> datetime AWARE en UTC. La columna sí
        guarda la zona, así que se aprovecha.
      * MySQL / SQL Server (`DATETIME`, `DATETIME2`) -> datetime NAIVE que ya
        contiene la hora UTC. Sin offset que el motor pueda reinterpretar.
      * SQLite (`TEXT`) -> cadena ISO 8601 en UTC con formato fijo, para que
        las comparaciones `ts >= :desde` (que son lexicográficas) funcionen.
    """
    dt = a_utc(valor)
    if dt is None:
        return None
    if motor == "postgresql":
        return dt
    if motor == "sqlite":
        # Formato fijo y ordenable. Se conserva el '+00:00' para que quede
        # explícito en la tabla que el dato está en UTC.
        return dt.isoformat(sep=" ", timespec="milliseconds")
    # MySQL y SQL Server: naive, con la hora UTC ya aplicada.
    return dt.replace(tzinfo=None)


# ====================================================================== #
# Serialización de valores a JSON
# ====================================================================== #
def _serializable(valor: Any) -> Any:
    """
    Convierte tipos de BD a algo que `json.dumps` acepte.

    Las fechas se emiten en ISO 8601 para que el frontend las parsee con
    `new Date(...)` sin ambigüedad de formato.
    """
    if valor is None or isinstance(valor, (str, int, float, bool)):
        return valor
    if isinstance(valor, Decimal):
        return float(valor)
    if isinstance(valor, (datetime, date, dtime)):
        return valor.isoformat()
    if isinstance(valor, UUID):
        return str(valor)
    if isinstance(valor, (bytes, bytearray, memoryview)):
        return f"<binario {len(bytes(valor))} bytes>"
    return str(valor)


# ====================================================================== #
# Driver
# ====================================================================== #
class SqlDriver(DbDriver):
    """Driver SQL genérico basado en SQLAlchemy async."""

    def __init__(
        self,
        motor: str,
        host: str = "",
        puerto: Optional[int] = None,
        base_datos: str = "",
        usuario: str = "",
        password: str = "",
        opciones: Optional[Dict[str, str]] = None,
        pool_size: int = 5,
        timeout_s: float = 30.0,
    ) -> None:
        motor = (motor or "").strip().lower()
        if motor not in MOTORES:
            raise ValueError(
                f"Motor '{motor}' no soportado. Opciones: "
                f"{', '.join(sorted(MOTORES))}."
            )
        self.motor = motor
        self.host = (host or "").strip()
        self.puerto = puerto or MOTORES[motor]["puerto"]
        self.base_datos = (base_datos or "").strip()
        self.usuario = usuario or ""
        self._password = password or ""
        self.opciones = opciones or {}
        self.pool_size = pool_size
        self.timeout_s = timeout_s
        self._engine: Optional[AsyncEngine] = None

    # ------------------------------------------------------------------ #
    # URL de conexión
    # ------------------------------------------------------------------ #
    def url(self, ocultar_password: bool = False) -> str:
        """
        Construye la URL SQLAlchemy del motor.

        Con `ocultar_password=True` sustituye la contraseña por '***': se usa
        para logs y para devolverla por la API sin filtrar credenciales.
        """
        cfg = MOTORES[self.motor]
        prefijo = cfg["prefijo"]

        # SQLite no tiene host ni credenciales: base_datos es la ruta al fichero.
        if self.motor == "sqlite":
            return f"{prefijo}:///{self.base_datos}"

        # ---- Host, con soporte de INSTANCIAS CON NOMBRE ---------------- #
        #
        # Un SQL Server puede tener varias instancias en la misma máquina:
        # `SQLEXPRESS`, `WINCC`, `TEW_SQLEXPRESS`... y se escriben
        # `HOST\INSTANCIA`. Es el caso normal en un PC de planta, donde otro
        # producto (WinCC, por ejemplo) ya instaló la suya.
        #
        # Dos cosas que hay que hacer bien, y que antes no se hacían:
        #
        #  1. **La barra invertida hay que codificarla** (`%5C`). Sin eso la URL
        #     queda mal formada y el error que sale no menciona la barra por
        #     ningún lado.
        #
        #  2. **No se le pone puerto.** Las instancias con nombre NO escuchan
        #     en el 1433: al arrancar toman un puerto DINÁMICO que cambia cada
        #     vez. El cliente lo averigua preguntándole a SQL Browser por UDP
        #     1434, y para eso hay que pasarle el nombre de instancia SIN
        #     puerto. Si se manda `host\instancia:1433`, el driver intenta ese
        #     puerto literal y falla aunque la instancia esté perfectamente
        #     levantada.
        #
        # Si alguien fijó un puerto estático a su instancia (que es lo que
        # recomienda la pantalla de diagnóstico), puede forzarlo poniendo
        # `opciones["puerto_fijo"] = "si"`: entonces sí se manda el puerto.
        # Se construye con `URL.create`, NO concatenando texto. El motivo es
        # concreto: si la barra se codifica a mano como `%5C`, SQLAlchemy la
        # deja literal al releer la cadena y el driver acaba buscando un
        # servidor llamado `localhost%5CTEW_SQLEXPRESS`. `URL.create` la
        # escapa y la desescapa de forma coherente, y de paso resuelve las
        # contraseñas con `@`, `#` o `/`, que también rompían la URL escrita a
        # mano.
        host_limpio, instancia = _host_e_instancia(self.host)
        servidor = f"{host_limpio}\\{instancia}" if instancia else host_limpio

        # Puerto: se omite con instancia con nombre (lo resuelve SQL Browser)
        # salvo que se haya fijado uno estático.
        puerto: Optional[int] = self.puerto
        if instancia and not _quiere_puerto_fijo(self.opciones):
            puerto = None

        # SQL Server necesita que se indique el driver ODBC instalado, y
        # ADEMAS cualquier otra opcion de la cadena ODBC.
        #
        # Antes aqui solo se leia `opciones["driver"]` y se descartaba el
        # resto. Eso rompia el caso mas comun de todos: con el **ODBC Driver
        # 18** el cifrado viene activado de fabrica, asi que un SQL Server con
        # certificado autofirmado (el de un contenedor, o el de una instancia
        # local recien instalada) rechaza la conexion con
        #
        #     SSL Provider: certificate chain was issued by an authority
        #     that is not trusted
        #
        # ...y `"TrustServerCertificate": "yes"` no servia de nada porque no
        # llegaba a la URL. El sintoma enganaba: la opcion estaba puesta, se
        # guardaba en conexiones.json, se devolvia por GET /db, y aun asi la
        # conexion fallaba como si no existiera.
        #
        # Se pasa TODO lo que haya en `opciones`: TrustServerCertificate,
        # Encrypt, Trusted_Connection, TrustedConnection, MARS_Connection,
        # ApplicationIntent... son parametros de la cadena ODBC y el driver
        # ignora los que no conoce.
        extras: Dict[str, str] = {}
        if self.motor == "mssql":
            extras = {k: str(v) for k, v in (self.opciones or {}).items()}
            # `puerto_fijo` es una marca NUESTRA para decidir si se manda el
            # puerto junto a una instancia con nombre. No es un parámetro ODBC,
            # así que no debe viajar en la cadena de conexión.
            extras.pop("puerto_fijo", None)
            # El driver por defecto es el MEJOR QUE HAYA INSTALADO, no uno
            # fijo. Antes se asumía "ODBC Driver 17": en un equipo con solo el
            # 13 (o solo el 18) la conexión fallaba con "Data source name not
            # found", que no da ninguna pista de que el problema sea el driver.
            extras.setdefault("driver", driver_odbc_por_defecto())

        u = URL.create(
            prefijo,
            username=self.usuario or None,
            password=self._password or None,
            host=servidor or None,
            port=puerto,
            database=self.base_datos or None,
            query=extras,
        )
        return u.render_as_string(hide_password=ocultar_password)

    # ------------------------------------------------------------------ #
    # Ciclo de vida
    # ------------------------------------------------------------------ #
    async def connect(self) -> None:
        """Crea el engine (pool perezoso) y verifica que la BD responde."""
        cfg = MOTORES[self.motor]
        try:
            if self.motor == "sqlite":
                # SQLite no admite pool_size.
                self._engine = create_async_engine(self.url(), future=True)
            else:
                self._engine = create_async_engine(
                    self.url(),
                    pool_size=self.pool_size,
                    max_overflow=2,
                    pool_pre_ping=True,   # descarta conexiones muertas
                    pool_recycle=3600,
                    future=True,
                )
        except ModuleNotFoundError as exc:
            raise RuntimeError(
                f"Falta el paquete '{cfg['paquete']}' para conectar a "
                f"{cfg['etiqueta']}. Instálalo con: pip install {cfg['paquete']}"
            ) from exc

        # Verificación real: si las credenciales están mal, falla aquí.
        await self.test()
        logger.info("Conectado a %s (%s)", cfg["etiqueta"], self.url(True))

    async def disconnect(self) -> None:
        if self._engine is not None:
            try:
                await self._engine.dispose()
                logger.info("Pool cerrado (%s).", self.url(True))
            except Exception as exc:  # noqa: BLE001
                logger.warning("Error cerrando el pool: %s", exc)
        self._engine = None

    def is_connected(self) -> bool:
        return self._engine is not None

    async def test(self) -> float:
        """SELECT 1 con timeout. Devuelve la latencia en ms."""
        if self._engine is None:
            raise RuntimeError("test() llamado sin conexión.")
        inicio = time.perf_counter()
        async with self._engine.connect() as conn:
            await asyncio.wait_for(
                conn.execute(text("SELECT 1")), timeout=self.timeout_s
            )
        return (time.perf_counter() - inicio) * 1000.0

    # ------------------------------------------------------------------ #
    # Consultas
    # ------------------------------------------------------------------ #
    async def query(
        self,
        sql: str,
        parametros: Optional[Dict[str, Any]] = None,
        limite: int = 1000,
    ) -> ResultadoConsulta:
        """
        Ejecuta una consulta de lectura y normaliza el resultado.

        Se pide una fila de más que el límite para saber si hay datos
        pendientes y poder avisar al usuario con `truncado`.
        """
        if self._engine is None:
            raise RuntimeError("query() llamado sin conexión.")

        validar_sql_lectura(sql)
        limpio = limpiar_sql(sql)
        limite = max(1, min(int(limite), 10000))

        inicio = time.perf_counter()
        async with self._engine.connect() as conn:
            resultado = await asyncio.wait_for(
                conn.execute(text(limpio), parametros or {}),
                timeout=self.timeout_s,
            )
            columnas = list(resultado.keys())
            crudas = resultado.fetchmany(limite + 1)

        truncado = len(crudas) > limite
        crudas = crudas[:limite]
        filas = [
            {col: _serializable(v) for col, v in zip(columnas, fila)}
            for fila in crudas
        ]

        return ResultadoConsulta(
            columnas=columnas,
            filas=filas,
            num_filas=len(filas),
            truncado=truncado,
            ms=(time.perf_counter() - inicio) * 1000.0,
        )

    # ------------------------------------------------------------------ #
    # ESCRITURA INTERNA — solo para el historizador
    # ------------------------------------------------------------------ #
    # ⚠️ Estos métodos SALTAN la validación de solo-lectura a propósito, y por
    # eso NO están expuestos en `DbDriver` ni en ningún endpoint REST. El SQL
    # que ejecutan lo genera el propio backend (nunca el usuario), y los
    # valores van bindeados. Un widget no tiene forma de llegar hasta aquí.
    # ------------------------------------------------------------------ #
    async def _ejecutar_interno(
        self, sql: str, parametros: Optional[Any] = None
    ) -> int:
        """
        Ejecuta una sentencia de ESCRITURA generada por el backend.

        Si `parametros` es una lista de dicts, SQLAlchemy hace `executemany`,
        que es lo que permite insertar cientos de filas en un solo viaje.
        Devuelve el número de filas afectadas.
        """
        if self._engine is None:
            raise RuntimeError("_ejecutar_interno() llamado sin conexión.")
        async with self._engine.begin() as conn:      # begin() = con COMMIT
            resultado = await asyncio.wait_for(
                conn.execute(text(sql), parametros or {}),
                timeout=self.timeout_s,
            )
            return resultado.rowcount or 0

    async def insertar(self, tabla: str, valores: Dict[str, Any]) -> int:
        """
        INSERT que devuelve el `id` de la fila creada.

        Existe porque sin el id no se puede construir nada jerárquico: al
        crear una receta hay que crear después sus elementos con
        `receta_id = <ese id>`, y la vista se quedaba sin saberlo. Antes
        `crear()` devolvía "creado" y nada más, así que el frontend tenía que
        volver a listar y adivinar cuál era la nueva fila — que con dos
        pestañas abiertas es exactamente eso, adivinar.

        Cada motor lo dice a su manera, y las tres que preguntan aparte
        necesitan lo mismo: que la pregunta viaje por la MISMA conexión y
        dentro de la MISMA transacción que el INSERT. Por eso hay un solo
        `begin()` para las dos sentencias.

        SQL SERVER ES DISTINTO, Y ESTO COSTÓ ENCONTRARLO
        ------------------------------------------------
        La primera versión usaba `SELECT SCOPE_IDENTITY()` en una segunda
        sentencia, que es lo que enseña cualquier manual. Devolvía **NULL
        siempre**: las filas se creaban —se veían en SSMS— pero la vista
        recibía `id = 0`, y a partir de ahí todo lo que colgaba de esa fila
        fallaba con "Faltan campos obligatorios: receta_id" o "No existe
        recetas con id 0".

        El motivo es que pyodbc manda las consultas con parámetros a través
        de `sp_executesql`. Eso abre un ÁMBITO propio, y `SCOPE_IDENTITY()`
        devuelve la identidad del ámbito actual: consultado en la sentencia
        siguiente —otro ámbito— no ve nada. El manual no miente; lo que no
        dice es que el driver mete un ámbito por el medio.

        `@@IDENTITY` sí lo vería (es de la sesión, no del ámbito) pero
        devuelve la identidad del ÚLTIMO insert de la sesión, incluido el que
        haga un trigger: es exactamente la trampa que hay que evitar. Así que
        se usa `OUTPUT INSERTED.id`, que resuelve las dos cosas a la vez: va
        en la MISMA sentencia (no hay ámbito que perder) y devuelve la fila
        que se acaba de insertar, no la que insertara otra cosa.

        La única limitación de `OUTPUT` es una tabla con un trigger `INSTEAD
        OF`, que obliga a `OUTPUT ... INTO`. El esquema del HMI no tiene
        triggers; el día que alguno los añada, esto hay que revisarlo.
        """
        if self._engine is None:
            raise RuntimeError("insertar() llamado sin conexión.")
        campos = list(valores)
        columnas = ", ".join(campos)
        marcadores = ", ".join(":" + c for c in campos)
        sql = f"INSERT INTO {tabla} ({columnas}) VALUES ({marcadores})"

        async with self._engine.begin() as conn:
            # Los dos motores que lo devuelven en la PROPIA sentencia. Es la
            # forma fiable: no hay una segunda consulta que pueda caer en
            # otro ámbito o en otra conexión.
            if self.motor in ("postgresql", "mssql"):
                if self.motor == "postgresql":
                    devuelve = sql + " RETURNING id"
                else:
                    devuelve = (
                        f"INSERT INTO {tabla} ({columnas}) "
                        f"OUTPUT INSERTED.id VALUES ({marcadores})"
                    )
                r = await asyncio.wait_for(
                    conn.execute(text(devuelve), valores),
                    timeout=self.timeout_s)
                fila = r.first()
                return int(fila[0]) if fila and fila[0] is not None else 0

            # MySQL y SQLite: la función es de la CONEXIÓN, no del ámbito, y
            # aquí la conexión es la misma. Sí sería incorrecta si se pidiera
            # fuera de este `begin()`.
            await asyncio.wait_for(conn.execute(text(sql), valores),
                                   timeout=self.timeout_s)
            consulta_id = ("SELECT LAST_INSERT_ID()" if self.motor == "mysql"
                           else "SELECT last_insert_rowid()")
            r = await asyncio.wait_for(conn.execute(text(consulta_id)),
                                       timeout=self.timeout_s)
            fila = r.first()
            return int(fila[0]) if fila and fila[0] is not None else 0

    def ddl_tabla_historico(self, tabla: str) -> List[str]:
        """
        Sentencias CREATE TABLE/INDEX del histórico, adaptadas al motor.

        Esquema ESTRECHO: una fila por lectura. Añadir o quitar tags desde la
        vista no requiere tocar la tabla nunca.

            ts           marca de tiempo de la lectura (UTC)
            plc          id del PLC de origen
            tag          nombre del tag
            valor_num    valor numérico (NULL si el tag es texto)
            valor_texto  valor textual (NULL si el tag es numérico)
            tipo         tipo de dato OPC UA original (Float, Boolean...)

        Los booleanos se guardan en `valor_num` como 0/1 para que se puedan
        graficar y agregar igual que cualquier otra señal.
        """
        tabla = _nombre_seguro(tabla)
        if self.motor == "postgresql":
            col_id = "id BIGSERIAL PRIMARY KEY"
            col_ts = "ts TIMESTAMPTZ NOT NULL"
            col_txt = "valor_texto TEXT"
        elif self.motor == "mysql":
            col_id = "id BIGINT AUTO_INCREMENT PRIMARY KEY"
            col_ts = "ts DATETIME(3) NOT NULL"
            col_txt = "valor_texto VARCHAR(1000)"
        elif self.motor == "mssql":
            col_id = "id BIGINT IDENTITY(1,1) PRIMARY KEY"
            col_ts = "ts DATETIME2 NOT NULL"
            col_txt = "valor_texto NVARCHAR(1000)"
        else:  # sqlite
            col_id = "id INTEGER PRIMARY KEY AUTOINCREMENT"
            col_ts = "ts TEXT NOT NULL"
            col_txt = "valor_texto TEXT"

        crear = (
            f"CREATE TABLE {tabla} ("
            f"{col_id}, {col_ts}, "
            f"plc VARCHAR(120) NOT NULL, "
            f"tag VARCHAR(400) NOT NULL, "
            f"valor_num DOUBLE PRECISION, "
            f"{col_txt}, "
            f"tipo VARCHAR(40))"
        )
        # SQL Server no admite DOUBLE PRECISION en todas las versiones.
        if self.motor == "mssql":
            crear = crear.replace("DOUBLE PRECISION", "FLOAT")

        # "IF NOT EXISTS" no es estándar: SQL Server necesita otra forma.
        if self.motor == "mssql":
            crear = (
                f"IF OBJECT_ID('{tabla}', 'U') IS NULL "
                + crear.replace(f"CREATE TABLE {tabla}", f"CREATE TABLE {tabla}")
            )
        else:
            crear = crear.replace("CREATE TABLE ", "CREATE TABLE IF NOT EXISTS ")

        # Índice por (tag, ts): es el patrón de consulta de un gráfico de
        # tendencia ("dame este tag entre estas dos fechas").
        idx = f"idx_{tabla}_tag_ts"
        if self.motor == "mssql":
            indice = (
                f"IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='{idx}') "
                f"CREATE INDEX {idx} ON {tabla} (tag, ts)"
            )
        else:
            indice = f"CREATE INDEX IF NOT EXISTS {idx} ON {tabla} (tag, ts)"

        return [crear, indice]

    # Columnas que produce el historizador -> posibles nombres en destino.
    # Existe porque hay DOS tablas válidas de destino con nombres distintos:
    #   * `historico_tags` (la que crea el propio historizador) usa `plc`.
    #   * `plc_prg` (la del esquema del HMI, del diagrama E-R) usa `plc_id`
    #     y añade `programa`.
    # Sin esta traducción, apuntar el historizador a `plc_prg` fallaría con
    # "Invalid column name 'plc'" en cada volcado.
    ALIAS_HISTORICO = {
        "ts": ("ts",),
        "plc": ("plc", "plc_id"),
        "tag": ("tag",),
        "valor_num": ("valor_num",),
        "valor_texto": ("valor_texto",),
        "tipo": ("tipo",),
        "programa": ("programa",),
    }

    def mapa_insert_historico(
        self, columnas_reales: Optional[List[str]] = None
    ) -> Dict[str, str]:
        """
        Traduce los campos del historizador a las columnas REALES de la tabla.

        Devuelve {campo_del_historizador: columna_en_la_tabla}. Los campos que
        la tabla no tenga se omiten: así `programa` se rellena solo si la tabla
        destino lo soporta.
        """
        if not columnas_reales:
            # Sin introspección: se asume la tabla propia del historizador.
            return {c: c for c in
                    ("ts", "plc", "tag", "valor_num", "valor_texto", "tipo")}

        disponibles = {c.lower(): c for c in columnas_reales}
        mapa: Dict[str, str] = {}
        for campo, candidatos in self.ALIAS_HISTORICO.items():
            for candidato in candidatos:
                if candidato.lower() in disponibles:
                    mapa[campo] = disponibles[candidato.lower()]
                    break
        return mapa

    def sql_insert_historico(
        self, tabla: str, mapa: Optional[Dict[str, str]] = None
    ) -> str:
        """
        INSERT parametrizado del histórico (se usa con executemany).

        `mapa` viene de `mapa_insert_historico()`: permite escribir en tablas
        cuyas columnas se llamen distinto (ver ALIAS_HISTORICO).
        """
        tabla = _nombre_seguro(tabla)
        mapa = mapa or self.mapa_insert_historico()
        campos = list(mapa)
        columnas = ", ".join(mapa[c] for c in campos)
        binds = ", ".join(f":{c}" for c in campos)
        return f"INSERT INTO {tabla} ({columnas}) VALUES ({binds})"

    # ------------------------------------------------------------------ #
    # Esquema estándar del HMI (usuarios / plc_prg / alarmas)
    # ------------------------------------------------------------------ #
    def ddl_esquema_hmi(self, prefijo: str = "") -> List[Tuple[str, str]]:
        """
        Sentencias DDL del esquema estándar del HMI, adaptadas al motor.

        Devuelve una lista de tuplas `(nombre_objeto, sentencia)` EN ORDEN:
        `usuarios` y `plc_prg` van antes que `alarmas`, porque esta última
        las referencia con claves foráneas.

        ┌────────────┬───────────────────────────────────────────────────────┐
        │ usuarios   │ Quién opera el HMI. La contraseña se guarda HASHEADA. │
        │ plc_prg    │ Lecturas del PLC. Esquema ESTRECHO: una fila por      │
        │            │ (ts, tag). Agregar o quitar tags NO cambia la tabla.  │
        │ alarmas    │ Eventos de alarma, con su ciclo de vida completo:     │
        │            │ activación -> reconocimiento -> normalización.        │
        └────────────┴───────────────────────────────────────────────────────┘

        Relaciones:
            alarmas.plc_prg_id -> plc_prg.id   (la lectura que la disparó)
            alarmas.usuario_id -> usuarios.id  (quién la reconoció)

        Ambas son NULLables a propósito: una alarma existe desde que salta,
        aunque todavía nadie la haya reconocido, y puede venir de una
        condición del sistema que no corresponde a una lectura concreta.
Borrar un usuario NO borra su historial de alarmas: `CrudManager.borrar()`
        pone `usuario_id` a NULL antes de borrarlo. Se pierde el "quién", no
        el evento. Ninguna FK de este esquema lleva `ON DELETE` — ver la nota
        más abajo, en la definición de las claves foráneas.

        Todas las sentencias son IDEMPOTENTES: ejecutarlas sobre una BD que
        ya tiene el esquema no falla ni borra datos.
        """
        p = _prefijo_seguro(prefijo)
        t_usuarios = f"{p}usuarios"
        t_plc = f"{p}plc_prg"
        t_alarmas = f"{p}alarmas"
        t_alarmas_def = f"{p}alarmas_def"
        t_recetas = f"{p}recetas"
        t_rec_elem = f"{p}receta_elementos"
        t_rec_reg = f"{p}receta_registros"
        t_rec_val = f"{p}receta_valores"

        m = self.motor
        # --- Tipos que cambian entre motores ---------------------------- #
        if m == "postgresql":
            pk = "BIGSERIAL PRIMARY KEY"
            fk_tipo = "BIGINT"
            ts = "TIMESTAMPTZ"
            texto = "TEXT"
            real = "DOUBLE PRECISION"
            entero = "INTEGER"
        elif m == "mysql":
            pk = "BIGINT AUTO_INCREMENT PRIMARY KEY"
            fk_tipo = "BIGINT"
            ts = "DATETIME(3)"
            texto = "TEXT"
            real = "DOUBLE PRECISION"
            entero = "INT"
        elif m == "mssql":
            pk = "BIGINT IDENTITY(1,1) PRIMARY KEY"
            fk_tipo = "BIGINT"
            ts = "DATETIME2"
            texto = "NVARCHAR(MAX)"
            real = "FLOAT"
            entero = "INT"
        else:  # sqlite
            pk = "INTEGER PRIMARY KEY AUTOINCREMENT"
            fk_tipo = "INTEGER"
            ts = "TEXT"
            texto = "TEXT"
            real = "DOUBLE PRECISION"
            entero = "INTEGER"

        # ---------------------------------------------------------------- #
        # usuarios
        # ---------------------------------------------------------------- #
        # OJO: `password_hash`, NO la contraseña. El backend guarda el hash
        # (PBKDF2/bcrypt) y `algoritmo` permite migrar de algoritmo sin
        # invalidar las contraseñas existentes.
        usuarios = (
            f"CREATE TABLE {t_usuarios} ("
            f"id {pk}, "
            f"usuario VARCHAR(80) NOT NULL UNIQUE, "
            f"password_hash VARCHAR(255) NOT NULL, "
            f"algoritmo VARCHAR(30) NOT NULL DEFAULT 'pbkdf2_sha256', "
            f"email VARCHAR(160), "
            # Rol, de MÁS a MENOS permisos. Los valores son exactamente los
            # que ofrece el desplegable de Login.tsx y se guardan tal cual:
            #   Supervisor > Administradores > Usuarios > Invitado
            f"categoria VARCHAR(40) NOT NULL DEFAULT 'Usuarios', "
            # Activo | Inactivo. Un usuario Inactivo no puede iniciar sesión.
            f"estado VARCHAR(20) NOT NULL DEFAULT 'Activo', "
            f"creado_en {ts}, "
            f"ultimo_acceso {ts})"
        )

        # ---------------------------------------------------------------- #
        # plc_prg  (lecturas del PLC, esquema estrecho)
        # ---------------------------------------------------------------- #
        # Es el MISMO formato que escribe el historizador, así que los
        # widgets de tendencia consultan esta tabla sin adaptaciones.
        #   - `plc_id`   distingue el mismo tag en dos PLCs distintos.
        #   - `programa` es el POU en Rexroth o el Data Block en Siemens.
        #   - los booleanos van en `valor_num` como 0/1, para poder graficarlos.
        plc = (
            f"CREATE TABLE {t_plc} ("
            f"id {pk}, "
            f"ts {ts} NOT NULL, "
            f"plc_id VARCHAR(120) NOT NULL, "
            f"programa VARCHAR(200), "
            f"tag VARCHAR(400) NOT NULL, "
            f"valor_num {real}, "
            f"valor_texto {texto}, "
            f"tipo VARCHAR(40))"
        )

        # ---------------------------------------------------------------- #
        # alarmas_def  ·  DEFINICIÓN de las alarmas (la configuración)
        # ---------------------------------------------------------------- #
        # Son DOS tablas y no una, y la distinción es la que hace que un
        # sistema de alarmas funcione:
        #
        #   alarmas_def  QUÉ vigilar. "Si DB1.temperatura pasa de 80, es un
        #                Error y dice «Temperatura alta en el reactor»."
        #                Se configura una vez y no cambia en meses.
        #
        #   alarmas      QUÉ PASÓ. "El 26/08 a las 14:32 saltó, con valor
        #                83.4; Ana la reconoció a las 14:35; se normalizó a
        #                las 14:41." Una fila por evento, y crecen sin parar.
        #
        # Meterlo todo en una tabla obliga a repetir el texto y la clase en
        # cada evento, y hace imposible responder "¿qué alarmas tengo
        # configuradas?" sin que hayan saltado al menos una vez. Es la misma
        # separación que hacen TIA Portal y WinCC, y por el mismo motivo.
        #
        # Los campos siguen los de la tabla "Discrete alarms" de TIA para que
        # migrar una configuración existente sea copiar columnas, no traducir:
        #   Name -> nombre · Alarm text -> texto · Alarm class -> clase
        #   Trigger tag -> tag · Trigger bit -> bit_disparo
        #   HMI acknowledgment tag -> tag_reconocimiento
        alarmas_def = (
            f"CREATE TABLE {t_alarmas_def} ("
            f"id {pk}, "
            f"nombre VARCHAR(120) NOT NULL, "
            f"texto VARCHAR(500) NOT NULL, "
            # Critical | Error | Warning | Maintenance | Information
            # (las cinco clases de TIA; son las que ya ofrece el editor).
            f"clase VARCHAR(20) NOT NULL DEFAULT 'Error', "
            # Tag que la dispara, en el formato del WebSocket: "<plc>|<tag>".
            f"tag VARCHAR(400), "
            # Alarma discreta: qué bit del tag se vigila.
            f"bit_disparo {entero} DEFAULT 0, "
            # Cómo se evalúa. 'bit' = discreta (la de TIA); el resto son
            # alarmas ANALÓGICAS, que TIA trata aparte y aquí caben en la
            # misma tabla porque solo cambia la comparación.
            #   bit | > | >= | < | <= | == | !=
            f"comparador VARCHAR(10) NOT NULL DEFAULT 'bit', "
            f"valor_limite {real}, "
            # Histéresis: cuánto tiene que volver el valor para considerarla
            # normalizada. Sin esto, un valor oscilando en el límite genera
            # cientos de eventos por minuto.
            f"banda_muerta {real} DEFAULT 0, "
            # HMI acknowledgment tag: el PLC puede reconocerla por su cuenta.
            f"tag_reconocimiento VARCHAR(400), "
            f"bit_reconocimiento {entero} DEFAULT 0, "
            f"area VARCHAR(80), "
            f"activo {entero} NOT NULL DEFAULT 1, "
            f"creado_en {ts}, "
            f"actualizado_en {ts})"
        )

        # ---------------------------------------------------------------- #
        # alarmas  ·  EVENTOS (el historial)
        # ---------------------------------------------------------------- #
        # PK simple + FKs simples (no una PK compuesta de los tres campos):
        # con una PK compuesta no podrías tener dos alarmas distintas del
        # mismo PLC y el mismo usuario, que es justo lo normal.
        # ---------------------------------------------------------------- #
        # POR QUÉ NINGUNA CLAVE FORÁNEA LLEVA `ON DELETE`
        #
        # SQL Server prohíbe que una tabla sea alcanzable por MÁS DE UN camino
        # en cascada desde la misma tabla padre, y cuenta como cascada tanto
        # `ON DELETE CASCADE` como `ON DELETE SET NULL`. Al crear la
        # constraint que cierra el segundo camino, aborta con:
        #
        #     Msg 1785 · Introducing FOREIGN KEY constraint '...' on table
        #     '...' may cause cycles or multiple cascade paths.
        #
        # Este esquema tiene dos de esos cruces, y no por un error de
        # modelado:
        #
        #   recetas ─CASCADE→ receta_registros ─CASCADE→ receta_valores
        #   recetas ─CASCADE→ receta_elementos ─CASCADE→ receta_valores
        #
        #   usuarios ─SET NULL→ recetas ─CASCADE→ receta_registros
        #   usuarios ─SET NULL──────────────────→ receta_registros
        #
        # Un valor de receta depende de DOS cosas a la vez (de qué registro
        # es y de qué elemento es); una alarma, de quién la reconoció Y de qué
        # la disparó. El modelo es correcto; lo que no cabe es delegar el
        # borrado en el motor.
        #
        # Así que el borrado en orden lo hace la aplicación, en
        # `CrudManager.borrar()` (ver `DEPENDENCIAS` allí): pone a NULL las
        # referencias de auditoría y borra las filas hijas antes que la padre.
        # Se gana además que el esquema es IDÉNTICO en los cuatro motores
        # —SQL Server era el único que no podía crearlo— y que ningún borrado
        # en cascada ocurre por sorpresa: está escrito en el código.
        # ---------------------------------------------------------------- #
        fk_plc = (
            f"CONSTRAINT fk_{p}alarmas_plc FOREIGN KEY (plc_prg_id) "
            f"REFERENCES {t_plc} (id)"
        )
        fk_usr = (
            f"CONSTRAINT fk_{p}alarmas_usuario FOREIGN KEY (usuario_id) "
            f"REFERENCES {t_usuarios} (id)"
        )
        fk_def = (
            f"CONSTRAINT fk_{p}alarmas_def FOREIGN KEY (alarma_def_id) "
            f"REFERENCES {t_alarmas_def} (id)"
        )
        alarmas = (
            f"CREATE TABLE {t_alarmas} ("
            f"id {pk}, "
            # Qué definición lo produjo. NULLable a propósito: una alarma de
            # sistema ("se perdió la conexión con el PLC") no viene de ninguna
            # regla configurada, y el evento debe poder existir igual.
            f"alarma_def_id {fk_tipo}, "
            f"plc_prg_id {fk_tipo}, "
            f"usuario_id {fk_tipo}, "
            # proceso | equipo | comunicacion | sistema
            f"tipo VARCHAR(20) NOT NULL DEFAULT 'proceso', "
            f"area VARCHAR(80), "
            # 1 = crítica ... 5 = informativa
            f"severidad {entero} NOT NULL DEFAULT 3, "
            f"mensaje VARCHAR(500) NOT NULL, "
            # Qué tag y con qué valor se disparó (para poder auditarla).
            f"tag VARCHAR(400), "
            f"valor_disparo {real}, "
            # activa | reconocida | normalizada
            f"estado VARCHAR(20) NOT NULL DEFAULT 'activa', "
            f"ts_activacion {ts} NOT NULL, "
            f"ts_reconocimiento {ts}, "
            f"ts_normalizacion {ts}, "
            f"{fk_plc}, {fk_usr}, {fk_def})"
        )

        # ---------------------------------------------------------------- #
        # ---------------------------------------------------------------- #
        # RECETAS · cuatro tablas, como en TIA Portal
        # ---------------------------------------------------------------- #
        # TIA organiza las recetas en tres niveles, y hacen falta los tres:
        #
        #   Recipes       "Recipe_1"              -> recetas
        #   Elements      limon, azucar, pisco    -> receta_elementos
        #   Data records  "Mezcla del lunes"      -> receta_registros
        #                                            + receta_valores
        #
        # La cuarta tabla es la que sorprende. TIA ENSEÑA los data records como
        # una rejilla ancha —una columna por elemento— pero guardarlo así
        # significaría una columna REAL por ingrediente: añadir "hielo" a la
        # receta obligaría a un ALTER TABLE, y la tabla se llenaría de NULL
        # porque cada receta tiene elementos distintos.
        #
        # Con `receta_valores` estrecha —una fila por (registro, elemento)—
        # añadir un ingrediente no toca nunca la estructura. Es el mismo
        # razonamiento por el que `plc_prg` es estrecha. La rejilla ancha se
        # reconstruye al leer, con un pivote: es trabajo de la vista.
        #
        # Y da algo gratis: `valor_num` + `valor_texto` permiten que un
        # elemento sea REAL y otro STRING sin inventar una columna por tipo.
        # ---------------------------------------------------------------- #
        fk_rec_usr = (
            f"CONSTRAINT fk_{p}recetas_usuario FOREIGN KEY (usuario_id) "
            f"REFERENCES {t_usuarios} (id)"
        )
        recetas = (
            f"CREATE TABLE {t_recetas} ("
            f"id {pk}, "
            f"usuario_id {fk_tipo}, "
            f"nombre VARCHAR(160) NOT NULL, "
            f"nombre_visible VARCHAR(160), "
            # Número de receta de TIA: el PLC la selecciona por número, no por
            # nombre, así que es el campo por el que se busca de verdad.
            f"numero {entero}, "
            f"version VARCHAR(40), "
            # Dónde las guarda el panel (\Flash\Recipes en TIA). Aquí es
            # informativo: los datos viven en estas tablas.
            f"ruta VARCHAR(300), "
            # Limited = tope de registros; Unlimited = sin tope.
            f"tipo VARCHAR(20) NOT NULL DEFAULT 'Limited', "
            f"max_registros {entero} NOT NULL DEFAULT 500, "
            # Tags | DataBlock: cómo se transfiere al PLC.
            f"tipo_comunicacion VARCHAR(20) NOT NULL DEFAULT 'Tags', "
            # El "Check limits" de TIA. NO es decorativo: con él activo, el
            # backend valida cada valor contra el min/max de su elemento ANTES
            # de escribirlo en la máquina.
            f"comprobar_limites {entero} NOT NULL DEFAULT 1, "
            f"informacion_herramienta VARCHAR(500), "
            f"activo {entero} NOT NULL DEFAULT 1, "
            f"creado_en {ts}, "
            f"actualizado_en {ts}, "
            f"{fk_rec_usr})"
        )

        # --- Elements: las COLUMNAS de la receta ------------------------- #
        # Lo que antes era la tabla `recetas` entera. Ahora cuelga de una
        # receta con una FK de verdad, en vez de repetir su nombre como texto.
        #
        # Un elemento sin receta no significa nada, así que borrar la receta
        # se lleva sus elementos — pero lo hace `CrudManager.borrar()`, en
        # orden y a la vista, no un `ON DELETE CASCADE` del motor. Borrar a
        # quien la creó, en cambio, solo pone `usuario_id` a NULL.
        fk_ele_rec = (
            f"CONSTRAINT fk_{p}receta_elementos_receta FOREIGN KEY (receta_id) "
            f"REFERENCES {t_recetas} (id)"
        )
        fk_ele_plc = (
            f"CONSTRAINT fk_{p}receta_elementos_plc FOREIGN KEY (plc_prg_id) "
            f"REFERENCES {t_plc} (id)"
        )
        receta_elementos = (
            f"CREATE TABLE {t_rec_elem} ("
            f"id {pk}, "
            f"receta_id {fk_tipo} NOT NULL, "
            f"plc_prg_id {fk_tipo}, "
            f"nombre VARCHAR(160) NOT NULL, "
            f"nombre_visible VARCHAR(160), "
            # Tag del PLC al que se escribe. Mismo formato que en plc_prg.
            f"tag VARCHAR(400), "
            # BOOL | INT | DINT | REAL | LREAL | STRING...
            f"tipo_dato VARCHAR(40) NOT NULL DEFAULT 'REAL', "
            # Longitud para los STRING; ignorado en los numéricos.
            f"longitud_dato {entero}, "
            f"valor_default {real}, "
            # `valor_minimo` / `valor_maximo` son la última barrera antes de
            # mandar un valor a una máquina real. Si alguien teclea 900 °C
            # donde el máximo son 90, se rechaza en el servidor.
            f"valor_minimo {real}, "
            f"valor_maximo {real}, "
            f"valor_texto VARCHAR(500), "
            # Formato de presentación: cuántos decimales se muestran y cuántos
            # se conservan al guardar. Van separados porque no siempre coinciden.
            f"lugar_decimal {entero} NOT NULL DEFAULT 0, "
            f"decimales {entero} NOT NULL DEFAULT 0, "
            f"unidad VARCHAR(30), "
            f"informacion_herramienta VARCHAR(500), "
            # En qué orden se pintan las columnas de la rejilla.
            f"orden {entero} NOT NULL DEFAULT 0, "
            f"activo {entero} NOT NULL DEFAULT 1, "
            f"creado_en {ts}, "
            f"actualizado_en {ts}, "
            f"{fk_ele_rec}, {fk_ele_plc})"
        )

        # --- Data records: la CABECERA de cada mezcla concreta ----------- #
        fk_reg_rec = (
            f"CONSTRAINT fk_{p}receta_registros_receta FOREIGN KEY (receta_id) "
            f"REFERENCES {t_recetas} (id)"
        )
        fk_reg_usr = (
            f"CONSTRAINT fk_{p}receta_registros_usuario FOREIGN KEY (usuario_id) "
            f"REFERENCES {t_usuarios} (id)"
        )
        receta_registros = (
            f"CREATE TABLE {t_rec_reg} ("
            f"id {pk}, "
            f"receta_id {fk_tipo} NOT NULL, "
            f"usuario_id {fk_tipo}, "
            f"nombre VARCHAR(160) NOT NULL, "
            f"nombre_visible VARCHAR(160), "
            f"numero {entero}, "
            f"comentario VARCHAR(500), "
            # Cuándo se cargó por última vez al PLC. Es la pregunta que se
            # hace siempre después de un lote que salió mal.
            f"ts_ultima_carga {ts}, "
            f"activo {entero} NOT NULL DEFAULT 1, "
            f"creado_en {ts}, "
            f"actualizado_en {ts}, "
            f"{fk_reg_rec}, {fk_reg_usr})"
        )

        # --- Los VALORES, en formato estrecho ---------------------------- #
        fk_val_reg = (
            f"CONSTRAINT fk_{p}receta_valores_registro "
            f"FOREIGN KEY (receta_registro_id) "
            f"REFERENCES {t_rec_reg} (id)"
        )
        fk_val_ele = (
            f"CONSTRAINT fk_{p}receta_valores_elemento "
            f"FOREIGN KEY (receta_elemento_id) "
            f"REFERENCES {t_rec_elem} (id)"
        )
        receta_valores = (
            f"CREATE TABLE {t_rec_val} ("
            f"id {pk}, "
            f"receta_registro_id {fk_tipo} NOT NULL, "
            f"receta_elemento_id {fk_tipo} NOT NULL, "
            f"valor_num {real}, "
            f"valor_texto VARCHAR(500), "
            f"{fk_val_reg}, {fk_val_ele})"
        )

        tablas = [
            (t_usuarios, usuarios),
            (t_plc, plc),
            # alarmas_def va antes: `alarmas` la referencia con una FK.
            (t_alarmas_def, alarmas_def),
            (t_alarmas, alarmas),
            (t_recetas, recetas),
            (t_rec_elem, receta_elementos),
            (t_rec_reg, receta_registros),
            (t_rec_val, receta_valores),
        ]

        # --- Idempotencia: "IF NOT EXISTS" no es estándar ---------------- #
        sentencias: List[Tuple[str, str]] = []
        for nombre, crear in tablas:
            if m == "mssql":
                crear = f"IF OBJECT_ID('{nombre}', 'U') IS NULL {crear}"
            else:
                crear = crear.replace("CREATE TABLE ", "CREATE TABLE IF NOT EXISTS ", 1)
            sentencias.append((nombre, crear))

        # --- Índices ----------------------------------------------------- #
        # Pensados para las consultas reales del HMI:
        #   plc_prg   -> "este tag entre dos fechas" (gráfico de tendencia)
        #   alarmas   -> "las alarmas activas, más recientes primero"
        indices = [
            (f"idx_{p}plc_prg_tag_ts", t_plc, "(tag, ts)"),
            (f"idx_{p}plc_prg_plc_ts", t_plc, "(plc_id, ts)"),
            (f"idx_{p}alarmas_estado", t_alarmas, "(estado, ts_activacion)"),
            (f"idx_{p}alarmas_tipo", t_alarmas, "(tipo, ts_activacion)"),
            # alarmas_def -> "qué reglas vigilan este tag" (lo que preguntará
            # el motor de alarmas en cada cambio de valor).
            (f"idx_{p}alarmas_def_tag", t_alarmas_def, "(tag)"),
            (f"idx_{p}alarmas_def_activo", t_alarmas_def, "(activo)"),
            # recetas -> "dame los parámetros de esta receta"
            (f"idx_{p}recetas_nombre", t_recetas, "(nombre)"),
            (f"idx_{p}receta_elem_receta", t_rec_elem, "(receta_id, orden)"),
            (f"idx_{p}receta_elem_tag", t_rec_elem, "(tag)"),
            (f"idx_{p}receta_reg_receta", t_rec_reg, "(receta_id)"),
            # El índice que hace barato el pivote: "dame todos los valores de
            # este registro" es la consulta que arma la rejilla.
            (f"idx_{p}receta_val_registro", t_rec_val, "(receta_registro_id)"),
        ]
        for idx, tabla, cols in indices:
            if m == "mssql":
                sent = (
                    f"IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='{idx}') "
                    f"CREATE INDEX {idx} ON {tabla} {cols}"
                )
            elif m == "mysql":
                # MySQL no soporta CREATE INDEX IF NOT EXISTS: se crea el
                # índice dentro de un procedimiento condicional sería
                # excesivo, así que se marca como opcional y el DbManager
                # ignora el error de "índice duplicado".
                sent = f"CREATE INDEX {idx} ON {tabla} {cols}"
            else:
                sent = f"CREATE INDEX IF NOT EXISTS {idx} ON {tabla} {cols}"
            sentencias.append((idx, sent))

        return sentencias

    def tablas_esquema_hmi(self, prefijo: str = "") -> List[str]:
        """Nombres de las tablas del esquema estándar, en orden de creación."""
        p = _prefijo_seguro(prefijo)
        return [f"{p}usuarios", f"{p}plc_prg", f"{p}alarmas_def",
                f"{p}alarmas", f"{p}recetas", f"{p}receta_elementos",
                f"{p}receta_registros", f"{p}receta_valores"]

    def sql_insert_lectura(self, prefijo: str = "") -> str:
        """INSERT parametrizado para la tabla `plc_prg` del esquema estándar."""
        p = _prefijo_seguro(prefijo)
        return (
            f"INSERT INTO {p}plc_prg "
            f"(ts, plc_id, programa, tag, valor_num, valor_texto, tipo) "
            f"VALUES (:ts, :plc_id, :programa, :tag, :valor_num, "
            f":valor_texto, :tipo)"
        )

    # ------------------------------------------------------------------ #
    # Introspección (para el diseñador de widgets)
    # ------------------------------------------------------------------ #
    async def listar_tablas(self) -> List[str]:
        """Tablas y vistas del esquema por defecto."""
        if self._engine is None:
            raise RuntimeError("listar_tablas() llamado sin conexión.")
        from sqlalchemy import inspect

        def _inspeccionar(conn_sync):
            insp = inspect(conn_sync)
            return sorted(insp.get_table_names() + insp.get_view_names())

        async with self._engine.connect() as conn:
            return await conn.run_sync(_inspeccionar)

    async def listar_columnas(self, tabla: str) -> List[Dict[str, str]]:
        """Columnas de `tabla` con su tipo, para construir consultas."""
        if self._engine is None:
            raise RuntimeError("listar_columnas() llamado sin conexión.")
        from sqlalchemy import inspect

        # El nombre de tabla NO se interpola en SQL: se lo pasamos al
        # inspector, que lo maneja de forma segura.
        def _inspeccionar(conn_sync):
            insp = inspect(conn_sync)
            return [
                {"nombre": c["name"], "tipo": str(c["type"])}
                for c in insp.get_columns(tabla)
            ]

        async with self._engine.connect() as conn:
            return await conn.run_sync(_inspeccionar)
