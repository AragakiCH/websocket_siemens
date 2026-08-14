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
from datetime import date, datetime, time as dtime
from decimal import Decimal
from typing import Any, Dict, List, Optional
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

        # SQL Server necesita que se indique el driver ODBC instalado.
        if self.motor == "mssql":
            driver = self.opciones.get("driver", "ODBC Driver 17 for SQL Server")
            url += f"?driver={quote_plus(driver)}"

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

    def sql_insert_historico(self, tabla: str) -> str:
        """INSERT parametrizado del histórico (se usa con executemany)."""
        tabla = _nombre_seguro(tabla)
        return (
            f"INSERT INTO {tabla} (ts, plc, tag, valor_num, valor_texto, tipo) "
            f"VALUES (:ts, :plc, :tag, :valor_num, :valor_texto, :tipo)"
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
