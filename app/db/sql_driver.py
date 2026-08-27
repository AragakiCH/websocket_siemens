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
        from urllib.parse import quote_plus

        cfg = MOTORES[self.motor]
        prefijo = cfg["prefijo"]

        # SQLite no tiene host ni credenciales: base_datos es la ruta al fichero.
        if self.motor == "sqlite":
            return f"{prefijo}:///{self.base_datos}"

        pwd = "***" if ocultar_password else quote_plus(self._password)
        usuario = quote_plus(self.usuario) if self.usuario else ""
        credenciales = f"{usuario}:{pwd}@" if usuario else ""
        url = f"{prefijo}://{credenciales}{self.host}:{self.puerto}/{self.base_datos}"

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
        if self.motor == "mssql":
            extras = dict(self.opciones or {})
            extras.setdefault("driver", "ODBC Driver 17 for SQL Server")
            url += "?" + "&".join(
                f"{k}={quote_plus(str(v))}" for k, v in extras.items()
            )

        return url

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
        `ON DELETE SET NULL` evita que borrar un usuario borre su historial
        de alarmas: se pierde el "quién", no el evento.

        Todas las sentencias son IDEMPOTENTES: ejecutarlas sobre una BD que
        ya tiene el esquema no falla ni borra datos.
        """
        p = _prefijo_seguro(prefijo)
        t_usuarios = f"{p}usuarios"
        t_plc = f"{p}plc_prg"
        t_alarmas = f"{p}alarmas"
        t_recetas = f"{p}recetas"

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
        # alarmas
        # ---------------------------------------------------------------- #
        # PK simple + FKs simples (no una PK compuesta de los tres campos):
        # con una PK compuesta no podrías tener dos alarmas distintas del
        # mismo PLC y el mismo usuario, que es justo lo normal.
        fk_plc = (
            f"CONSTRAINT fk_{p}alarmas_plc FOREIGN KEY (plc_prg_id) "
            f"REFERENCES {t_plc} (id) ON DELETE SET NULL"
        )
        fk_usr = (
            f"CONSTRAINT fk_{p}alarmas_usuario FOREIGN KEY (usuario_id) "
            f"REFERENCES {t_usuarios} (id) ON DELETE SET NULL"
        )
        alarmas = (
            f"CREATE TABLE {t_alarmas} ("
            f"id {pk}, "
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
            f"{fk_plc}, {fk_usr})"
        )

        # ---------------------------------------------------------------- #
        # recetas
        # ---------------------------------------------------------------- #
        # Una receta es la DEFINICIÓN de un parámetro configurable del proceso:
        # qué tag es, de qué tipo, entre qué límites puede moverse y con qué
        # valor arranca. Es la tabla que permite que un operario cambie una
        # consigna sin tocar el PLC, y que el HMI valide el rango ANTES de
        # escribirla.
        #
        # `valor_minimo` / `valor_maximo` no son decorativos: son la última
        # barrera antes de mandar un valor a una máquina real. Si alguien teclea
        # 900 °C donde el máximo son 90, se rechaza en el servidor.
        #
        # FKs con ON DELETE SET NULL, igual que en alarmas: borrar un usuario
        # no debe llevarse por delante las recetas que creó.
        fk_rec_plc = (
            f"CONSTRAINT fk_{p}recetas_plc FOREIGN KEY (plc_prg_id) "
            f"REFERENCES {t_plc} (id) ON DELETE SET NULL"
        )
        fk_rec_usr = (
            f"CONSTRAINT fk_{p}recetas_usuario FOREIGN KEY (usuario_id) "
            f"REFERENCES {t_usuarios} (id) ON DELETE SET NULL"
        )
        recetas = (
            f"CREATE TABLE {t_recetas} ("
            f"id {pk}, "
            f"plc_prg_id {fk_tipo}, "
            f"usuario_id {fk_tipo}, "
            # Nombre del parámetro y nombre de la receta a la que pertenece.
            # Una receta ("Producto A") agrupa varios parámetros.
            f"nombre VARCHAR(160) NOT NULL, "
            f"nombre_receta VARCHAR(160) NOT NULL, "
            # Tag del PLC al que se escribe. Mismo formato que en plc_prg.
            f"tag VARCHAR(400) NOT NULL, "
            # BOOL | INT | DINT | REAL | LREAL | STRING...
            f"tipo_dato VARCHAR(40) NOT NULL DEFAULT 'REAL', "
            # Longitud para los STRING; ignorado en los numéricos.
            f"longitud_dato {entero}, "
            f"valor_default {real}, "
            f"valor_minimo {real}, "
            f"valor_maximo {real}, "
            # Valor por defecto cuando el dato es de texto.
            f"valor_texto VARCHAR(500), "
            # Formato de presentación: cuántos decimales se muestran y cuántos
            # se conservan al guardar. Van separados porque no siempre coinciden.
            f"lugar_decimal {entero} NOT NULL DEFAULT 0, "
            f"decimales {entero} NOT NULL DEFAULT 0, "
            # Unidad de ingeniería (°C, bar, rpm) y ayuda para el operario.
            f"unidad VARCHAR(30), "
            f"informacion_herramienta VARCHAR(500), "
            f"activo {entero} NOT NULL DEFAULT 1, "
            f"creado_en {ts}, "
            f"actualizado_en {ts}, "
            f"{fk_rec_plc}, {fk_rec_usr})"
        )

        tablas = [
            (t_usuarios, usuarios),
            (t_plc, plc),
            (t_alarmas, alarmas),
            (t_recetas, recetas),
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
            # recetas -> "dame los parámetros de esta receta"
            (f"idx_{p}recetas_nombre", t_recetas, "(nombre_receta)"),
            (f"idx_{p}recetas_tag", t_recetas, "(tag)"),
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
        return [f"{p}usuarios", f"{p}plc_prg", f"{p}alarmas"]

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
