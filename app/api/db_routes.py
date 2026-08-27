# -*- coding: utf-8 -*-
"""
db_routes.py
============
Endpoints REST de bases de datos, para los widgets de datos del HMI.

Modelo de seguridad (importante entenderlo antes de tocar nada):

  * El SQL vive SOLO en el servidor. Un widget nunca manda SQL: manda el
    `query_id` de una consulta registrada y los valores de sus parámetros.
  * Todo SQL pasa por `validar_sql_lectura()`: solo SELECT/WITH, una sola
    sentencia, sin palabras destructivas. Se valida al REGISTRAR (para que el
    error salga en el diseñador) y de nuevo al ejecutar.
  * Los parámetros van bindeados por el motor, nunca concatenados.
  * Las contraseñas se guardan cifradas y jamás se devuelven por la API.

  GET    /db                    -> conexiones guardadas con su estado.
  POST   /db                    -> alta/actualización de una conexión.
  DELETE /db/{db_id}            -> baja (borra también sus consultas).
  POST   /db/{db_id}/test       -> comprueba que la BD responde.
  GET    /db/{db_id}/tablas     -> tablas y vistas disponibles.
  GET    /db/{db_id}/columnas   -> columnas de una tabla.
  POST   /db/{db_id}/preview    -> ejecuta SQL suelto SIN guardarlo (diseñador).

  GET    /db/queries            -> consultas guardadas (filtrable por ?db_id=).
  POST   /db/queries            -> registra una consulta.
  DELETE /db/queries/{query_id} -> borra una consulta.
  POST   /db/queries/{id}/run   -> EJECUTA la consulta (esto llama el widget).
"""
from __future__ import annotations

import re
from typing import Any, Dict, Optional

from fastapi import APIRouter, Body, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field

from app.api.auth_routes import exigir_rol, sesion_actual, usuario_de
from app.core.auth_manager import Sesion
from app.db.provision import provisionar

router = APIRouter()


# ====================================================================== #
# Modelos de entrada
# ====================================================================== #
class NuevaConexion(BaseModel):
    """Cuerpo de POST /db."""

    db_id: str = Field(
        ...,
        description="Identificador único y estable; es lo que guarda el "
                    "widget. Ej: 'mes_produccion'.",
        examples=["mes_produccion"],
    )
    motor: str = Field(
        ...,
        description="`postgresql` | `mysql` | `mssql` | `sqlite`.",
        examples=["postgresql"],
    )
    nombre: str = Field(default="", description="Etiqueta legible para la vista.")
    host: str = Field(default="", description="IP o hostname (no aplica a SQLite).")
    puerto: Optional[int] = Field(
        default=None,
        description="Puerto. Si se omite: 5432 PostgreSQL, 3306 MySQL, 1433 SQL Server.",
    )
    base_datos: str = Field(
        default="",
        description="Nombre de la base de datos. En SQLite, la RUTA al fichero .db.",
    )
    usuario: str = Field(default="")
    password: str = Field(
        default="",
        description="Se guarda CIFRADA y nunca se devuelve por la API.",
    )
    opciones: Dict[str, str] = Field(
        default_factory=dict,
        description="Extras por motor. SQL Server: "
                    "`{\"driver\": \"ODBC Driver 18 for SQL Server\"}`.",
    )
    autoconectar: bool = Field(
        default=True,
        description="Abrir el pool automáticamente al arrancar el servidor.",
    )


class NuevaConsulta(BaseModel):
    """Cuerpo de POST /db/queries."""

    query_id: str = Field(..., examples=["piezas_por_maquina"])
    db_id: str = Field(..., description="Conexión sobre la que se ejecuta.")
    sql: str = Field(
        ...,
        description="SELECT o WITH, con parámetros nombrados `:nombre`. "
                    "Una sola sentencia; se rechaza cualquier escritura.",
        examples=["SELECT maquina, SUM(piezas) AS total FROM produccion "
                  "WHERE fecha >= :desde GROUP BY maquina"],
    )
    nombre: str = Field(default="", description="Etiqueta legible.")
    parametros: Dict[str, Dict[str, Any]] = Field(
        default_factory=dict,
        description="Parámetros declarados: "
                    "`{\"desde\": {\"tipo\": \"string\", \"defecto\": \"2026-01-01\"}}`. "
                    "Los que el widget no mande toman su `defecto`.",
    )
    limite: int = Field(
        default=1000, ge=1, le=10000,
        description="Máximo de filas devueltas (protege al navegador).",
    )
    descripcion: str = Field(default="")


class EjecutarConsulta(BaseModel):
    """Cuerpo de POST /db/queries/{query_id}/run."""

    parametros: Dict[str, Any] = Field(
        default_factory=dict,
        description="Valores de los parámetros declarados. Los no declarados "
                    "se ignoran; los que falten usan su valor por defecto.",
        examples=[{"desde": "2026-07-01"}],
    )


class PreviewSql(BaseModel):
    """Cuerpo de POST /db/{db_id}/preview (solo para el modo Diseñador)."""

    sql: str = Field(..., examples=["SELECT * FROM produccion"])
    parametros: Dict[str, Any] = Field(default_factory=dict)
    limite: int = Field(default=50, ge=1, le=1000)


def _mgr(request: Request):
    return request.app.state.db_manager


async def _avisar(request: Request, recurso: str, sesion=None,
                  accion: str = "") -> None:
    """
    Difunde `config.updated` para que las demás pantallas se refresquen.

    Antes, estos endpoints escribían en disco y devolvían 200 sin avisar a
    nadie: el usuario 2 no veía la conexión nueva hasta recargar a mano.
    """
    try:
        await request.app.state.manager.difundir_config(
            recurso, usuario_de(sesion), accion)
    except Exception:  # noqa: BLE001
        # Un fallo al avisar no debe invalidar una operación ya hecha.
        pass
    aud = getattr(request.app.state, "auditoria", None)
    if aud is not None:
        aud.registrar(f"bd.{recurso}.{accion or 'cambio'}",
                      usuario_de(sesion), recurso)


# ====================================================================== #
# Conexiones
# ====================================================================== #
@router.get(
    "/db",
    tags=["Bases de datos"],
    summary="Listar conexiones a bases de datos",
    description="Conexiones guardadas con su estado actual. **Nunca** incluye "
                "contraseñas. Es lo que llena el selector de origen de datos "
                "del diseñador.",
    responses={200: {"content": {"application/json": {"example": {
        "conexiones": [{
            "db_id": "mes_produccion", "motor": "postgresql",
            "etiqueta_motor": "PostgreSQL", "nombre": "MES Producción",
            "host": "10.0.0.5", "puerto": 5432, "base_datos": "produccion",
            "usuario": "hmi_ro", "conectado": True, "num_consultas": 3,
            "autoconectar": True,
        }],
    }}}}},
)
async def listar_conexiones(request: Request) -> dict:
    return {"conexiones": _mgr(request).listar_conexiones()}


_RE_ODBC = re.compile(r"^ODBC Driver (\d+) for SQL Server$", re.IGNORECASE)


def _preferencia_driver(nombre: str) -> tuple:
    """
    Clave de orden: cuanto menor, más recomendable.

    (0, -18) ODBC Driver 18   <- el mejor
    (0, -17) ODBC Driver 17
    (1, ...) SQL Server Native Client  <- obsoleto, pero funciona
    (2, ...) "SQL Server"              <- el heredado; último recurso
    """
    m = _RE_ODBC.match(nombre.strip())
    if m:
        return (0, -int(m.group(1)), nombre)
    if "native client" in nombre.lower():
        return (1, 0, nombre)
    return (2, 0, nombre)


@router.get(
    "/db/drivers",
    tags=["Bases de datos"],
    summary="Drivers ODBC instalados en la máquina del servidor",
    description="Los drivers ODBC **no** los trae `pip`: se instalan en el "
                "sistema operativo, y su nombre tiene que coincidir EXACTAMENTE "
                "con el que se manda en `opciones.driver`.\n\n"
                "Sin esta lista, el formulario de conexión ofrece nombres a "
                "ciegas y elegir uno que no está instalado devuelve un "
                "`IM002 · No se encuentra el nombre del origen de datos`, que "
                "no dice en ningún sitio que el problema sea el driver.\n\n"
                "Devuelve los del sistema donde corre **el backend**, que es "
                "quien abre la conexión — no los del PC del navegador.",
    responses={200: {"content": {"application/json": {"example": {
        "ok": True, "drivers": ["ODBC Driver 18 for SQL Server"],
        "mensaje": "",
    }}}}},
)
async def drivers_odbc() -> dict:
    """Nombres de driver ODBC disponibles, filtrando los de SQL Server."""
    try:
        import pyodbc  # llega como dependencia de aioodbc
    except ModuleNotFoundError:
        return {
            "ok": False, "drivers": [], "todos": [],
            "mensaje": "Falta el paquete 'aioodbc' (que trae pyodbc). "
                       "Instálalo con: pip install aioodbc",
        }

    try:
        todos = sorted(pyodbc.drivers())
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "drivers": [], "todos": [], "mensaje": str(exc)}

    # Solo los de SQL Server: son los únicos que sirven para `motor=mssql`.
    #
    # El orden importa porque el primero es el que el formulario elige solo.
    # Un `sorted(reverse=True)` a secas NO sirve: alfabéticamente
    # "SQL Server Native Client 11.0" va por delante de "ODBC Driver 17 for
    # SQL Server", así que se preseleccionaría el Native Client — que Microsoft
    # dejó de mantener y que con SQLAlchemy da problemas de tipos.
    #
    # La preferencia real es: ODBC Driver moderno (el número más alto primero),
    # luego el Native Client, y por último el "SQL Server" heredado que viene
    # con Windows desde hace veinte años.
    #
    # Se deduplica además porque Windows lista el mismo driver una vez por
    # arquitectura (32 y 64 bits).
    sql = sorted(
        {d for d in todos if "sql server" in d.lower()}, key=_preferencia_driver
    )

    mensaje = ""
    if not sql:
        mensaje = (
            "No hay ningún driver ODBC de SQL Server instalado en la máquina "
            "del servidor. Instala el 'Microsoft ODBC Driver 18 for SQL "
            "Server' desde la web de Microsoft y reinicia el backend."
        )
    return {"ok": True, "drivers": sql, "todos": todos, "mensaje": mensaje}


class Provision(BaseModel):
    """
    Datos para crear una base de datos, su esquema y su usuario.

    Las credenciales de administrador **no se guardan en ningún sitio**: viven
    en esta petición y se descartan al terminar.
    """

    motor: str = Field(..., description="`postgresql` | `mysql` | `mssql` | `sqlite`.")
    base_datos: str = Field(
        ...,
        description="Nombre de la base a crear (o la RUTA del .db en SQLite). "
                    "Solo letras, dígitos y guion bajo: va interpolado en el "
                    "DDL porque SQL no permite bindear identificadores.",
    )
    host: str = Field(default="")
    puerto: Optional[int] = Field(default=None)
    admin_usuario: str = Field(
        default="",
        description="Administrador del SERVIDOR: `sa`, `root`, `postgres`... "
                    "No aplica a SQLite. **No se persiste.**",
    )
    admin_password: str = Field(default="", description="**No se persiste.**")
    admin_windows: bool = Field(
        default=False,
        description="Solo SQL Server. Conecta con la identidad de Windows del "
                    "PROCESO del backend (`Trusted_Connection=yes`) en vez de "
                    "usuario y contraseña. Es la mejor opción cuando el "
                    "backend corre en la misma máquina que SQL Server con una "
                    "cuenta que ya es sysadmin: no hay que activar `sa` ni "
                    "hay contraseña privilegiada viajando por la red.\n\n"
                    "Ojo: la identidad es la del backend, **no** la de quien "
                    "está usando el navegador.",
    )
    opciones: Dict[str, str] = Field(default_factory=dict)
    crear_esquema: bool = Field(
        default=True,
        description="Crear las cuatro tablas del HMI (usuarios, plc_prg, "
                    "alarmas, recetas) con el mismo DDL que genera "
                    "`sql/esquema_hmi_*.sql`.",
    )
    usuario_hmi: str = Field(
        default="",
        description="Si se indica, se crea con permisos de lectura y "
                    "escritura de FILAS. Nunca de estructura.",
    )
    password_hmi: str = Field(default="", description="Mínimo 8 caracteres.")
    usuario_verificar: str = Field(
        default="",
        description="Cuenta con la que comprobar el resultado al final: se "
                    "abre una sesión con ELLA (no con la de administrador) y "
                    "se cuentan las tablas. Es la única prueba que representa "
                    "lo que hará el HMI en producción. Vacío = se usa "
                    "`usuario_hmi` si se creó uno.",
    )
    password_verificar: str = Field(default="", description="**No se persiste.**")
    collation: str = Field(
        default="",
        description="Vacío = la recomendada del motor "
                    "(`Modern_Spanish_CI_AS` en SQL Server).",
    )


@router.post(
    "/db/provision",
    tags=["Bases de datos"],
    summary="Crear la base de datos, su esquema y su usuario",
    description="Para la puesta en marcha, **no** para el día a día.\n\n"
                "Crear una base de datos exige privilegios de administrador "
                "del servidor, que el HMI no tiene ni debe tener. Este "
                "endpoint permite **prestarle** esas credenciales para una "
                "operación: se usan y se descartan. No se guardan en "
                "`conexiones.json`, ni en el log, ni en la auditoría.\n\n"
                "El usuario del HMI que crea (`usuario_hmi`) recibe permisos "
                "de leer y escribir FILAS, nunca de alterar la estructura: "
                "una aplicación que puede cambiar el esquema de producción es "
                "una aplicación que puede romperlo.\n\n"
                "Es **idempotente** y nunca hace `DROP` de nada. Los pasos ya "
                "hechos se informan como omitidos, no como error.\n\n"
                "Después de esto, da de alta la conexión normal con "
                "`POST /db` usando el usuario limitado.",
    responses={200: {"content": {"application/json": {"example": {
        "ok": True, "base_datos": "HMI_PSI",
        "mensaje": "'HMI_PSI' lista para usar.",
        "pasos": [
            {"paso": "base", "ok": True,
             "mensaje": "Base 'HMI_PSI' creada con collation Modern_Spanish_CI_AS."},
            {"paso": "esquema", "ok": True,
             "mensaje": "Tablas del HMI creadas (o ya existían)."},
            {"paso": "usuario", "ok": True,
             "mensaje": "Usuario 'hmi_app' creado con permisos de lectura y escritura."},
        ],
    }}}}},
)
async def provision_bd(
    request: Request,
    cuerpo: Provision,
    sesion: Sesion = Depends(exigir_rol("Supervisor")),
) -> dict:
    resultado = await provisionar(
        motor=cuerpo.motor,
        base_datos=cuerpo.base_datos,
        host=cuerpo.host,
        puerto=cuerpo.puerto,
        admin_usuario=cuerpo.admin_usuario,
        admin_password=cuerpo.admin_password,
        admin_windows=cuerpo.admin_windows,
        opciones=cuerpo.opciones,
        crear_esquema=cuerpo.crear_esquema,
        usuario_hmi=cuerpo.usuario_hmi,
        password_hmi=cuerpo.password_hmi,
        usuario_verificar=cuerpo.usuario_verificar,
        password_verificar=cuerpo.password_verificar,
        collation=cuerpo.collation,
    )

    # Queda registrado QUÉ se creó y quién lo pidió. Nunca con qué credenciales:
    # el usuario administrador no entra en la auditoría, que se guarda en claro.
    aud = getattr(request.app.state, "auditoria", None)
    if aud is not None and resultado.get("ok"):
        aud.registrar(
            "bd.provisionada", usuario_de(sesion), cuerpo.base_datos,
            {"motor": cuerpo.motor, "host": cuerpo.host,
             "esquema": cuerpo.crear_esquema,
             "usuario_creado": cuerpo.usuario_hmi or None},
        )
    return resultado


@router.post(
    "/db",
    tags=["Bases de datos"],
    summary="Agregar o actualizar una conexión",
    description="Verifica la conexión ANTES de guardarla: si las credenciales "
                "son incorrectas responde `ok:false` y no persiste nada. La "
                "contraseña se cifra en disco (Fernet).\n\n"
                "Si el `db_id` ya existe, se actualiza y se reabre su pool.\n\n"
                "**El cuerpo JSON es el MISMO para todos los motores**: solo "
                "cambia el valor de `motor` (y el `puerto`, que puede omitirse "
                "para usar el de cada motor). Dos excepciones:\n\n"
                "* **SQLite** no lleva host, puerto, usuario ni contraseña; "
                "`base_datos` es la ruta al fichero `.db`.\n"
                "* **SQL Server** requiere `opciones.driver` con el ODBC Driver "
                "instalado en la máquina servidor.\n\n"
                "Usa el desplegable de ejemplos para ver los cuatro casos.",
    responses={200: {"content": {"application/json": {"examples": {
        "ok": {"summary": "Verificada y guardada", "value": {
            "ok": True, "db_id": "mes_produccion", "motor": "postgresql",
            "latencia_ms": 12.4,
            "mensaje": "Conexión 'mes_produccion' verificada y guardada.",
        }},
        "error": {"summary": "No conecta", "value": {
            "ok": False, "db_id": "mes_produccion",
            "mensaje": "No se pudo conectar: password authentication failed",
        }},
    }}}}},
)
async def agregar_conexion(
    request: Request,
    sesion: Sesion = Depends(exigir_rol("Administradores")),
    cuerpo: NuevaConexion = Body(..., openapi_examples={
        "postgresql": {
            "summary": "PostgreSQL",
            "description": "Puerto por defecto 5432. Sirve igual para "
                           "TimescaleDB (es PostgreSQL con una extensión).",
            "value": {
                "db_id": "mes_produccion",
                "motor": "postgresql",
                "nombre": "MES Producción",
                "host": "10.0.0.5",
                "puerto": 5432,
                "base_datos": "produccion",
                "usuario": "hmi_ro",
                "password": "secreta",
            },
        },
        "mysql": {
            "summary": "MySQL / MariaDB",
            "description": "Puerto por defecto 3306. Mismo cuerpo que "
                           "PostgreSQL: solo cambian `motor` y `puerto`.",
            "value": {
                "db_id": "calidad",
                "motor": "mysql",
                "nombre": "Base de Calidad",
                "host": "192.168.1.20",
                "puerto": 3306,
                "base_datos": "calidad",
                "usuario": "hmi_ro",
                "password": "secreta",
            },
        },
        "mssql": {
            "summary": "SQL Server",
            "description": "Puerto por defecto 1433. ÚNICO motor que necesita "
                           "`opciones.driver` con el ODBC Driver instalado en "
                           "la máquina servidor (17 o 18).",
            "value": {
                "db_id": "erp",
                "motor": "mssql",
                "nombre": "ERP Planta",
                "host": "SRV-SQL01",
                "puerto": 1433,
                "base_datos": "ERP",
                "usuario": "hmi_ro",
                "password": "secreta",
                "opciones": {"driver": "ODBC Driver 17 for SQL Server"},
            },
        },
        "sqlite": {
            "summary": "SQLite (fichero local)",
            "description": "Sin servidor: NO lleva host, puerto, usuario ni "
                           "contraseña. `base_datos` es la RUTA al fichero .db. "
                           "Ideal para probar todo el flujo sin instalar nada.",
            "value": {
                "db_id": "local",
                "motor": "sqlite",
                "nombre": "Datos locales",
                "base_datos": "C:/datos/planta.db",
            },
        },
    }),
) -> dict:
    resultado = await _mgr(request).alta_conexion(
        db_id=cuerpo.db_id, motor=cuerpo.motor, host=cuerpo.host,
        puerto=cuerpo.puerto, base_datos=cuerpo.base_datos,
        usuario=cuerpo.usuario, password=cuerpo.password,
        nombre=cuerpo.nombre, opciones=cuerpo.opciones,
        autoconectar=cuerpo.autoconectar,
    )
    if resultado.get("ok"):
        await _avisar(request, "conexiones", sesion, "alta")
    return resultado


@router.delete(
    "/db/{db_id}",
    tags=["Bases de datos"],
    summary="Quitar una conexión",
    description="Cierra el pool y borra la conexión **y todas sus consultas "
                "asociadas** (los widgets que las usaran dejarán de funcionar).",
    responses={200: {"content": {"application/json": {"example": {
        "ok": True, "db_id": "mes_produccion", "consultas_borradas": 3,
        "mensaje": "Conexión 'mes_produccion' eliminada (3 consulta(s) asociada(s)).",
    }}}}},
)
async def quitar_conexion(
    request: Request, db_id: str,
    sesion: Sesion = Depends(exigir_rol("Administradores")),
) -> dict:
    resultado = await _mgr(request).baja_conexion(db_id)
    if resultado.get("ok"):
        await _avisar(request, "conexiones", sesion, "baja")
    return resultado


@router.post(
    "/db/{db_id}/test",
    tags=["Bases de datos"],
    summary="Probar una conexión",
    description="Ejecuta un `SELECT 1` y devuelve la latencia. Si el pool se "
                "había caído, lo reabre: sirve como 'reconectar'.",
    responses={200: {"content": {"application/json": {"example": {
        "ok": True, "db_id": "mes_produccion", "latencia_ms": 8.2,
        "mensaje": "Conexión OK.",
    }}}}},
)
async def probar_conexion(request: Request, db_id: str) -> dict:
    return await _mgr(request).probar_conexion(db_id)


@router.get(
    "/db/{db_id}/tablas",
    tags=["Bases de datos"],
    summary="Listar tablas y vistas",
    description="Ayuda al diseñador a construir la consulta sin escribir a ciegas.",
    responses={200: {"content": {"application/json": {"example": {
        "ok": True, "db_id": "mes_produccion",
        "tablas": ["produccion", "paradas", "v_oee_diario"],
    }}}}},
)
async def listar_tablas(request: Request, db_id: str) -> dict:
    return await _mgr(request).tablas(db_id)


@router.get(
    "/db/{db_id}/columnas",
    tags=["Bases de datos"],
    summary="Listar columnas de una tabla",
    responses={200: {"content": {"application/json": {"example": {
        "ok": True, "db_id": "mes_produccion", "tabla": "produccion",
        "columnas": [{"nombre": "id", "tipo": "INTEGER"},
                     {"nombre": "maquina", "tipo": "VARCHAR(50)"},
                     {"nombre": "piezas", "tipo": "INTEGER"}],
    }}}}},
)
async def listar_columnas(
    request: Request,
    db_id: str,
    tabla: str = Query(..., description="Nombre de la tabla a inspeccionar."),
) -> dict:
    return await _mgr(request).columnas(db_id, tabla)


@router.post(
    "/db/{db_id}/preview",
    tags=["Bases de datos"],
    summary="Previsualizar un SQL sin guardarlo (Diseñador)",
    description="Ejecuta una consulta suelta para ver el resultado antes de "
                "registrarla. Pasa por la MISMA validación de solo-lectura, "
                "así que tampoco por aquí se puede modificar la BD.\n\n"
                "Pensado para el modo Diseñador; el widget en producción usa "
                "`/db/queries/{query_id}/run`.",
    responses={200: {"content": {"application/json": {"example": {
        "ok": True, "db_id": "mes_produccion",
        "columnas": ["maquina", "total"],
        "filas": [{"maquina": "Linea A", "total": 263}],
        "num_filas": 1, "truncado": False, "ms": 14.2,
    }}}}},
)
async def preview_sql(request: Request, db_id: str, cuerpo: PreviewSql) -> dict:
    return await _mgr(request).probar_sql(
        db_id, cuerpo.sql, cuerpo.parametros, cuerpo.limite
    )


# ====================================================================== #
# Consultas guardadas
# ====================================================================== #
@router.get(
    "/db/queries",
    tags=["Bases de datos"],
    summary="Listar consultas guardadas",
    description="Consultas registradas. Filtrar por conexión con `?db_id=`. "
                "Es lo que llena el selector de consulta de un widget.",
    responses={200: {"content": {"application/json": {"example": {
        "consultas": [{
            "query_id": "piezas_por_maquina", "db_id": "mes_produccion",
            "nombre": "Piezas por máquina",
            "sql": "SELECT maquina, SUM(piezas) AS total FROM produccion "
                   "WHERE fecha >= :desde GROUP BY maquina",
            "parametros": {"desde": {"tipo": "string", "defecto": "2026-01-01"}},
            "limite": 1000, "descripcion": "",
        }],
    }}}}},
)
async def listar_consultas(
    request: Request,
    db_id: Optional[str] = Query(default=None, description="Filtrar por conexión."),
) -> dict:
    return {"consultas": _mgr(request).listar_consultas(db_id)}


@router.post(
    "/db/queries",
    tags=["Bases de datos"],
    summary="Registrar una consulta",
    description="Guarda el SQL en el servidor. A partir de aquí los widgets la "
                "invocan por `query_id` y nunca vuelven a ver el SQL.\n\n"
                "El SQL se valida al registrar: si lleva escrituras, el error "
                "sale aquí (en el diseñador) y no en la pantalla de un operario.\n\n"
                "**Ojo con el dialecto**: el cuerpo JSON es idéntico para todos "
                "los motores, pero el SQL de dentro NO siempre lo es. Lo más "
                "común: `LIMIT n` (PostgreSQL/MySQL/SQLite) frente a "
                "`SELECT TOP n` (SQL Server), y las funciones de fecha. Los "
                "agregados básicos (`SUM`, `AVG`, `GROUP BY`, `WHERE`) "
                "funcionan igual en todos.",
    responses={200: {"content": {"application/json": {"examples": {
        "ok": {"summary": "Guardada", "value": {
            "ok": True, "query_id": "piezas_por_maquina",
            "db_id": "mes_produccion",
            "mensaje": "Consulta 'piezas_por_maquina' guardada.",
        }},
        "sql_invalido": {"summary": "SQL no permitido", "value": {
            "ok": False,
            "mensaje": "Solo se permiten consultas de lectura: la sentencia "
                       "debe empezar por SELECT o WITH.",
        }},
    }}}}},
)
async def agregar_consulta(
    request: Request,
    sesion: Sesion = Depends(exigir_rol("Administradores")),
    cuerpo: NuevaConsulta = Body(..., openapi_examples={
        "agregado": {
            "summary": "Agregado por grupo (estándar, vale en todos)",
            "description": "SQL ANSI: funciona igual en PostgreSQL, MySQL, "
                           "SQL Server y SQLite. Ideal para gráficos de barras.",
            "value": {
                "query_id": "piezas_por_maquina",
                "db_id": "mes_produccion",
                "nombre": "Piezas por máquina",
                "sql": "SELECT maquina, SUM(piezas) AS total FROM produccion "
                       "WHERE fecha >= :desde GROUP BY maquina ORDER BY total DESC",
                "parametros": {
                    "desde": {"tipo": "string", "defecto": "2026-01-01"}
                },
                "limite": 500,
            },
        },
        "kpi": {
            "summary": "KPI de un solo valor",
            "description": "Una fila y una columna: perfecto para un widget de "
                           "texto o un medidor. Estándar en todos los motores.",
            "value": {
                "query_id": "oee_turno",
                "db_id": "mes_produccion",
                "nombre": "OEE del turno",
                "sql": "SELECT AVG(oee) AS valor FROM v_oee "
                       "WHERE turno = :turno",
                "parametros": {"turno": {"tipo": "string", "defecto": "A"}},
                "limite": 1,
            },
        },
        "ultimos_pg_mysql_sqlite": {
            "summary": "Últimos N registros — PostgreSQL / MySQL / SQLite",
            "description": "Estos tres usan `LIMIT`. OJO: SQL Server NO "
                           "entiende LIMIT (ver el siguiente ejemplo).",
            "value": {
                "query_id": "ultimas_paradas",
                "db_id": "mes_produccion",
                "nombre": "Últimas paradas",
                "sql": "SELECT inicio, maquina, motivo, minutos FROM paradas "
                       "WHERE maquina = :maquina ORDER BY inicio DESC LIMIT 20",
                "parametros": {"maquina": {"tipo": "string", "defecto": "Linea A"}},
                "limite": 20,
            },
        },
        "ultimos_mssql": {
            "summary": "Últimos N registros — SQL Server",
            "description": "SQL Server usa `SELECT TOP n` en vez de `LIMIT`. "
                           "Es la diferencia de dialecto más habitual.",
            "value": {
                "query_id": "ultimas_paradas_erp",
                "db_id": "erp",
                "nombre": "Últimas paradas (ERP)",
                "sql": "SELECT TOP 20 inicio, maquina, motivo, minutos "
                       "FROM paradas WHERE maquina = :maquina ORDER BY inicio DESC",
                "parametros": {"maquina": {"tipo": "string", "defecto": "Linea A"}},
                "limite": 20,
            },
        },
        "serie_temporal": {
            "summary": "Serie temporal (para gráficos de línea)",
            "description": "Devuelve fecha + valor. Las fechas salen en ISO "
                           "8601, listas para `new Date(v)` en el frontend. "
                           "La función de fecha cambia por motor: "
                           "PostgreSQL `DATE_TRUNC('hour', ts)`, "
                           "MySQL `DATE_FORMAT(ts,'%Y-%m-%d %H:00')`, "
                           "SQL Server `DATEADD(hour, DATEDIFF(hour, 0, ts), 0)`, "
                           "SQLite `strftime('%Y-%m-%d %H:00', ts)`.",
            "value": {
                "query_id": "produccion_horaria",
                "db_id": "mes_produccion",
                "nombre": "Producción por hora",
                "sql": "SELECT DATE_TRUNC('hour', ts) AS hora, SUM(piezas) AS total "
                       "FROM produccion WHERE ts >= :desde "
                       "GROUP BY 1 ORDER BY 1",
                "parametros": {
                    "desde": {"tipo": "string", "defecto": "2026-07-01 00:00:00"}
                },
                "limite": 1000,
            },
        },
    }),
) -> dict:
    resultado = _mgr(request).alta_consulta(
        query_id=cuerpo.query_id, db_id=cuerpo.db_id, sql=cuerpo.sql,
        nombre=cuerpo.nombre, parametros=cuerpo.parametros,
        limite=cuerpo.limite, descripcion=cuerpo.descripcion,
    )
    if resultado.get("ok"):
        await _avisar(request, "consultas", sesion, "alta")
    return resultado


@router.delete(
    "/db/queries/{query_id}",
    tags=["Bases de datos"],
    summary="Borrar una consulta",
    responses={200: {"content": {"application/json": {"example": {
        "ok": True, "query_id": "piezas_por_maquina",
        "mensaje": "Consulta 'piezas_por_maquina' eliminada.",
    }}}}},
)
async def quitar_consulta(
    request: Request, query_id: str,
    sesion: Sesion = Depends(exigir_rol("Administradores")),
) -> dict:
    resultado = _mgr(request).baja_consulta(query_id)
    if resultado.get("ok"):
        await _avisar(request, "consultas", sesion, "baja")
    return resultado


@router.post(
    "/db/queries/{query_id}/run",
    tags=["Bases de datos"],
    summary="Ejecutar una consulta (lo que llama el widget)",
    description="Ejecuta la consulta guardada y devuelve el resultado ya "
                "normalizado: `columnas` para las cabeceras y `filas` como "
                "lista de objetos. Las fechas vienen en ISO 8601 y los "
                "decimales como número.\n\n"
                "El refresco periódico lo decide el frontend: a diferencia de "
                "los PLCs, una BD no empuja datos. Llamar cada N segundos "
                "según lo que necesite el widget (no menos de ~2 s).",
    responses={200: {"content": {"application/json": {"examples": {
        "ok": {"summary": "Resultado", "value": {
            "ok": True, "query_id": "piezas_por_maquina",
            "db_id": "mes_produccion", "parametros": {"desde": "2026-07-01"},
            "columnas": ["maquina", "total"],
            "filas": [{"maquina": "Linea A", "total": 263},
                      {"maquina": "Linea B", "total": 95}],
            "num_filas": 2, "truncado": False, "ms": 18.7,
        }},
        "falta_parametro": {"summary": "Parámetro sin valor", "value": {
            "ok": False, "query_id": "piezas_por_maquina",
            "mensaje": "Faltan parámetros sin valor por defecto: desde.",
        }},
    }}}}},
)
async def ejecutar_consulta(
    request: Request,
    query_id: str,
    cuerpo: EjecutarConsulta = Body(default=EjecutarConsulta()),
) -> dict:
    return await _mgr(request).ejecutar(query_id, cuerpo.parametros)
