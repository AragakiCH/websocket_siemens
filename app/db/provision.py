# -*- coding: utf-8 -*-
"""
provision.py
============
Crear la base de datos, su esquema y el usuario del HMI — una sola vez, con
credenciales de administrador que NO se guardan.

EL PRINCIPIO QUE NO SE ROMPE
----------------------------
Este proyecto repite en tres documentos que el backend no crea ni altera
estructura, y por eso `hmi_app` tiene `db_datareader` + `db_datawriter` y nada
más. Ese principio sigue intacto, porque aquí hay **dos actos distintos con
privilegios distintos**:

    OPERAR        el HMI, siempre     con `hmi_app`, solo filas
    PROVISIONAR   una persona, una vez  con `sa` / `root` / `postgres`

Lo que hace este módulo es dejar que la aplicación **pida prestada** una
credencial de administrador para una operación concreta, la use y la olvide.

Nada de lo que llega aquí se persiste: las credenciales de administrador viven
en memoria durante una petición y no entran en `conexiones.json`, ni en el log,
ni en la auditoría. Lo que se guarda después —si el usuario decide guardarlo—
es la conexión del HMI, con su usuario limitado, por la vía normal de
`POST /db`.

LO QUE NUNCA HACE
-----------------
* `DROP` de nada. Ni bases, ni tablas, ni usuarios.
* Tocar una tabla que ya existe. Todo el DDL es `IF NOT EXISTS`.
* Dar permisos de estructura al usuario del HMI. Solo lectura y escritura de
  filas, que es lo que necesita para funcionar.

DE DÓNDE SALE EL ESQUEMA
------------------------
De `SqlDriver.ddl_esquema_hmi()`, el MISMO generador que produce
`sql/esquema_hmi_*.sql`. No hay una segunda copia del DDL que pueda quedarse
atrás: si mañana cambia una columna, cambian los dos a la vez.
"""
from __future__ import annotations

import logging
import os
import re
from typing import Any, Dict, List, Optional

from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine

from app.db.diagnostico import diagnosticar
from app.db.sql_driver import MOTORES, SqlDriver

logger = logging.getLogger("provision")

# Base a la que hay que conectarse para poder crear OTRA base. No se puede
# crear una base estando conectado a ella, así que hace falta una de servicio.
BASE_MANTENIMIENTO = {
    "mssql": "master",
    "postgresql": "postgres",
    "mysql": "",          # MySQL admite conectarse sin base seleccionada
}

# Collation por defecto. En español importa: con la de fábrica, buscar
# "valvula" no encuentra "Válvula" y la ñ no ordena donde debe.
COLLATION_DEFECTO = {
    "mssql": "Modern_Spanish_CI_AS",
    "mysql": "utf8mb4_unicode_ci",
    "postgresql": "",     # se hereda de la plantilla del cluster
}

_RE_IDENT = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,62}$")
_RE_COLLATION = re.compile(r"^[A-Za-z0-9_]{1,64}$")


def _ident(nombre: str, que: str) -> str:
    """
    Valida un identificador con lista blanca.

    Los nombres de base y de usuario NO se pueden pasar como parámetros
    bindeados —SQL no lo permite para identificadores—, así que van
    interpolados en el texto. La única defensa posible es no dejar pasar
    nada que no sea letras, dígitos y guion bajo.
    """
    nombre = (nombre or "").strip()
    if not _RE_IDENT.match(nombre):
        raise ValueError(
            f"{que} inválido: '{nombre}'. Solo letras, dígitos y guion bajo, "
            f"empezando por letra, hasta 63 caracteres."
        )
    return nombre


def _literal(valor: str, motor: str) -> str:
    """
    Escapa una contraseña para meterla en un literal SQL.

    Tampoco se puede bindear: `CREATE LOGIN ... WITH PASSWORD = :p` no es SQL
    válido en ningún motor. Se duplican las comillas simples y, en MySQL,
    también las barras invertidas, que ahí sí son carácter de escape.
    """
    v = (valor or "").replace("'", "''")
    if motor == "mysql":
        v = v.replace("\\", "\\\\")
    return v


def _url(
    motor: str, host: str, puerto: Optional[int], base: str,
    usuario: str, password: str, opciones: Optional[Dict[str, str]],
) -> str:
    """URL SQLAlchemy, reutilizando la construcción que ya sabe hacer SqlDriver."""
    return SqlDriver(
        motor=motor, host=host, puerto=puerto, base_datos=base,
        usuario=usuario, password=password, opciones=opciones or {},
    ).url()


def _motor_autocommit(url: str):
    """
    Engine en AUTOCOMMIT.

    `CREATE DATABASE` **no puede ejecutarse dentro de una transacción** ni en
    SQL Server ni en PostgreSQL, y SQLAlchemy 2.0 abre una por defecto. Sin
    esto el paso falla con un error que habla de transacciones y no de lo que
    de verdad se estaba intentando.
    """
    return create_async_engine(url, future=True).execution_options(
        isolation_level="AUTOCOMMIT"
    )


class Pasos:
    """Parte de lo ocurrido, paso a paso, para que la vista lo enseñe tal cual."""

    def __init__(self) -> None:
        self.items: List[Dict[str, Any]] = []

    def ok(self, paso: str, mensaje: str) -> None:
        self.items.append({"paso": paso, "ok": True, "mensaje": mensaje})
        logger.info("provision · %s: %s", paso, mensaje)

    def info(self, paso: str, mensaje: str) -> None:
        self.items.append({"paso": paso, "ok": True, "mensaje": mensaje,
                           "omitido": True})
        logger.info("provision · %s: %s", paso, mensaje)


# ====================================================================== #
# Deshacer el empate 18456 + 4060
# ====================================================================== #
async def afinar_diagnostico(
    diag: Dict[str, Any],
    *,
    motor: str,
    host: str,
    puerto: Optional[int],
    base_datos: str,
    usuario: str,
    password: str,
    opciones: Optional[Dict[str, str]] = None,
) -> Dict[str, Any]:
    """
    Convierte un diagnóstico ambiguo en uno cierto, preguntándole al servidor.

    SQL Server manda `Login failed (18456)` y `Cannot open database (4060)`
    **a la vez** en dos situaciones distintas:

        * el login no existe o la contraseña está mal
        * el login es correcto, pero la base no existe (o no tiene acceso)

    Leyendo el texto no se pueden separar, y equivocarse tiene consecuencias:
    ofrecer "¿creo la base?" cuando el problema es una contraseña manda a la
    persona a crear algo que ya existe.

    La forma de saberlo es la que usaría cualquier DBA: **probar esas mismas
    credenciales contra `master`**, que existe siempre.

        conecta a master  -> las credenciales valen  -> el problema es la base
        no conecta        -> las credenciales no valen

    Cuesta una conexión de más, y solo se paga cuando el diagnóstico quedó
    marcado como ambiguo. El resultado lleva una `nota` explicando cómo se
    supo: un diagnóstico que afirma más de lo que dice el error tiene que
    enseñar en qué se basa.
    """
    if motor == "sqlite" or not diag.get("ambiguo"):
        return diag

    mantenimiento = BASE_MANTENIMIENTO.get(motor, "")
    sonda = SqlDriver(
        motor=motor, host=host, puerto=puerto, base_datos=mantenimiento,
        usuario=usuario, password=password, opciones=opciones or {},
    )
    try:
        await sonda.connect()
        credenciales_ok = True
    except Exception:  # noqa: BLE001
        credenciales_ok = False
    finally:
        try:
            await sonda.disconnect()
        except Exception:  # noqa: BLE001
            pass

    etiqueta = mantenimiento or "el servidor"
    estado_bd = ""
    if credenciales_ok:
        # Las credenciales valen. Queda una tercera posibilidad que el `4060`
        # tampoco distingue: que la base EXISTA pero no se pueda abrir
        # —OFFLINE, RESTORING, SUSPECT, SINGLE_USER...—. Ofrecer "¿la creo?"
        # ahí sería absurdo: está delante, solo que no operativa.
        estado_bd = await _estado_base(
            motor, host, puerto, usuario, password, opciones or {}, base_datos)

        if estado_bd and estado_bd.upper() != "ONLINE":
            nota = (f"Comprobado: la base existe pero su estado es "
                    f"{estado_bd}.")
            forzar = "base_no_accesible"
        elif estado_bd == "ONLINE":
            # Existe, está sana y las credenciales valen: entonces lo que
            # falta es un USER mapeado dentro de ella o sus permisos.
            nota = (f"Comprobado: la base existe y está en línea, y este "
                    f"usuario entra en '{etiqueta}'.")
            forzar = "sin_permisos"
        else:
            nota = (f"Comprobado: con este usuario sí se puede entrar a "
                    f"'{etiqueta}', y esa base no aparece en el servidor.")
            forzar = "base_no_existe"
    else:
        nota = (f"Comprobado: con este usuario tampoco se puede entrar a "
                f"'{etiqueta}', así que el problema son las credenciales y no "
                f"la base de datos.")
        forzar = "credenciales"

    # Se reconstruye desde el MISMO texto de error, para no duplicar mensajes.
    class _Envuelto(Exception):
        pass

    return diagnosticar(
        _Envuelto(diag.get("detalle", "")),
        motor=motor, host=host, puerto=puerto,
        base_datos=base_datos,
        opciones=opciones or {}, forzar=forzar, nota=nota,
        estado_bd=estado_bd,
    )


async def _estado_base(
    motor: str, host: str, puerto: Optional[int], usuario: str,
    password: str, opciones: Dict[str, str], base_datos: str,
) -> str:
    """
    Estado de una base vista desde fuera, sin abrirla.

    Devuelve `"ONLINE"`, el estado real (`OFFLINE`, `RESTORING`, `SUSPECT`,
    `SINGLE_USER`…) o `""` si no existe. Cadena vacía también si no se pudo
    averiguar: es mejor no afirmar nada que afirmar de más.

    Solo SQL Server distingue estos estados; en MySQL y PostgreSQL una base o
    está o no está, así que ahí basta con comprobar la existencia.
    """
    mantenimiento = BASE_MANTENIMIENTO.get(motor, "")
    try:
        eng = _motor_autocommit(
            _url(motor, host, puerto, mantenimiento, usuario, password, opciones))
        try:
            async with eng.connect() as conn:
                if motor == "mssql":
                    q = text(
                        "SELECT state_desc, user_access_desc FROM sys.databases "
                        "WHERE name = :n")
                    fila = (await conn.execute(q, {"n": base_datos})).first()
                    if fila is None:
                        return ""
                    estado, acceso = str(fila[0] or ""), str(fila[1] or "")
                    # Una base ONLINE pero en SINGLE_USER/RESTRICTED_USER
                    # tampoco se puede abrir: para quien lo sufre es el mismo
                    # problema, así que el acceso manda sobre el estado.
                    if acceso.upper() not in ("MULTI_USER", ""):
                        return acceso
                    return estado
                return "ONLINE" if await _existe_base(conn, motor, base_datos) else ""
        finally:
            await eng.dispose()
    except Exception:  # noqa: BLE001
        return ""


# ====================================================================== #
# SQLite: no hay servidor, "crear la base" es crear un fichero
# ====================================================================== #
async def _provisionar_sqlite(ruta: str, crear_esquema: bool) -> Dict[str, Any]:
    pasos = Pasos()
    ruta = (ruta or "").strip()
    if not ruta:
        return {"ok": False, "mensaje": "Indica la ruta del fichero .db.",
                "pasos": pasos.items}

    carpeta = os.path.dirname(os.path.abspath(ruta))
    if carpeta and not os.path.isdir(carpeta):
        # ESTE es el fallo real de SQLite: el motor crea el fichero solo, pero
        # no la carpeta que lo contiene.
        os.makedirs(carpeta, exist_ok=True)
        pasos.ok("carpeta", f"Carpeta creada: {carpeta}")
    else:
        pasos.info("carpeta", "La carpeta ya existía.")

    driver = SqlDriver(motor="sqlite", base_datos=ruta)
    await driver.connect()          # crea el fichero si no estaba
    pasos.ok("base", f"Base de datos disponible en {ruta}")
    try:
        if crear_esquema:
            for nombre, sentencia in driver.ddl_esquema_hmi():
                await driver._ejecutar_interno(sentencia)
            pasos.ok("esquema", "Tablas del HMI creadas (o ya existían).")
        pasos.info("usuario", "SQLite no tiene usuarios: no hay nada que crear.")
        n = await _contar_tablas(driver, "sqlite")
        pasos.ok("verificacion",
                 f"El fichero se abre y contiene {n} tabla(s).")
    finally:
        await driver.disconnect()

    return {"ok": True, "pasos": pasos.items,
            "mensaje": "Base SQLite lista."}


# ====================================================================== #
# Motores con servidor
# ====================================================================== #
async def provisionar(
    *,
    motor: str,
    base_datos: str,
    host: str = "",
    puerto: Optional[int] = None,
    admin_usuario: str = "",
    admin_password: str = "",
    admin_windows: bool = False,
    opciones: Optional[Dict[str, str]] = None,
    crear_esquema: bool = True,
    usuario_hmi: str = "",
    password_hmi: str = "",
    usuario_verificar: str = "",
    password_verificar: str = "",
    collation: str = "",
) -> Dict[str, Any]:
    """
    Crea lo que falte, en orden, y devuelve el parte de cada paso.

        1. CREATE DATABASE (si no existe)
        2. Las tablas del HMI              (opcional)
        3. Usuario del HMI + permisos      (opcional)
        4. VERIFICAR entrando como ese usuario

    El paso 4 no es adorno: es la diferencia entre "se ejecutó el DDL" y "el
    HMI puede trabajar". Reproduce lo que un DBA hace a mano al final de una
    instalación —entrar con la cuenta de la aplicación, no con la de
    administrador, y contar las tablas— porque los tres pasos anteriores
    pueden salir bien y aun así la aplicación no poder entrar: un GRANT que no
    se aplicó, un usuario sin mapear, un rol mal asignado.

    Es IDEMPOTENTE: ejecutarlo dos veces no falla ni pisa nada. Los pasos ya
    hechos se informan como omitidos, no como error — que es lo correcto
    cuando alguien reintenta tras arreglar un fallo de un paso posterior.
    """
    motor = (motor or "").strip().lower()
    if motor not in MOTORES:
        return {"ok": False, "mensaje": f"Motor '{motor}' no soportado."}

    if motor == "sqlite":
        return await _provisionar_sqlite(base_datos, crear_esquema)

    try:
        base = _ident(base_datos, "Nombre de base de datos")
        usuario_hmi = _ident(usuario_hmi, "Usuario del HMI") if usuario_hmi else ""
    except ValueError as exc:
        return {"ok": False, "mensaje": str(exc)}

    if admin_windows and motor != "mssql":
        return {"ok": False,
                "mensaje": "La autenticación de Windows solo existe en SQL "
                           "Server."}

    if not admin_usuario and not admin_windows:
        return {"ok": False,
                "mensaje": "Hacen falta credenciales de administrador del "
                           "servidor (sa, root, postgres...) para crear una "
                           "base de datos."}

    if usuario_hmi and len(password_hmi or "") < 8:
        return {"ok": False,
                "mensaje": "La contraseña del usuario del HMI debe tener al "
                           "menos 8 caracteres."}

    coll = (collation or COLLATION_DEFECTO.get(motor, "")).strip()
    if coll and not _RE_COLLATION.match(coll):
        return {"ok": False, "mensaje": f"Collation inválida: '{coll}'."}

    pasos = Pasos()
    opciones = dict(opciones or {})
    mantenimiento = BASE_MANTENIMIENTO.get(motor, "")

    # Autenticación de Windows: en vez de usuario y contraseña, el driver ODBC
    # usa la identidad del PROCESO que abre la conexión, o sea la del backend.
    #
    # Es la mejor opción cuando el backend corre en la misma máquina que SQL
    # Server con una cuenta que ya es sysadmin: no hay que activar `sa`, no
    # hay contraseña de administrador viajando por la red, y no queda ninguna
    # credencial privilegiada que pueda filtrarse.
    #
    # El matiz importante: la identidad es la del BACKEND, no la de quien está
    # mirando el navegador. Si el servicio corre en otra máquina o con otra
    # cuenta, entrará como esa otra cuenta.
    if admin_windows:
        opciones["Trusted_Connection"] = "yes"
        admin_usuario, admin_password = "", ""

    url_admin = _url(motor, host, puerto, mantenimiento,
                     admin_usuario, admin_password, opciones)

    # ---------------- 1 · La base de datos ----------------------------
    try:
        eng = _motor_autocommit(url_admin)
        try:
            async with eng.connect() as conn:
                existe = await _existe_base(conn, motor, base)
                if existe:
                    pasos.info("base", f"La base '{base}' ya existía; no se toca.")
                else:
                    await conn.execute(text(_sql_crear_base(motor, base, coll)))
                    pasos.ok("base", f"Base '{base}' creada"
                                     + (f" con collation {coll}." if coll else "."))
        finally:
            await eng.dispose()
    except Exception as exc:  # noqa: BLE001
        diag = diagnosticar(exc, motor=motor, host=host, puerto=puerto,
                            base_datos=mantenimiento, opciones=opciones)
        return {"ok": False, "pasos": pasos.items, "diagnostico": diag,
                "mensaje": f"{diag['titulo']}. {diag['sugerencia']}"}

    # ---------------- 2 · Las tablas ----------------------------------
    if crear_esquema:
        try:
            driver = SqlDriver(motor=motor, host=host, puerto=puerto,
                               base_datos=base, usuario=admin_usuario,
                               password=admin_password, opciones=opciones)
            await driver.connect()
            try:
                for _, sentencia in driver.ddl_esquema_hmi():
                    await driver._ejecutar_interno(sentencia)
            finally:
                await driver.disconnect()
            pasos.ok("esquema", "Tablas del HMI creadas (o ya existían): "
                                "usuarios, plc_prg, alarmas, recetas.")
        except Exception as exc:  # noqa: BLE001
            diag = diagnosticar(exc, motor=motor, host=host, puerto=puerto,
                                base_datos=base, opciones=opciones)
            return {"ok": False, "pasos": pasos.items, "diagnostico": diag,
                    "mensaje": f"La base se creó, pero el esquema falló. "
                               f"{diag['titulo']}."}
    else:
        pasos.info("esquema", "No se pidió crear las tablas.")

    # ---------------- 3 · El usuario del HMI --------------------------
    if usuario_hmi:
        try:
            notas = await _crear_usuario(motor, host, puerto, base,
                                         admin_usuario, admin_password,
                                         opciones, usuario_hmi, password_hmi)
            pasos.ok("usuario", " ".join(notas))
        except Exception as exc:  # noqa: BLE001
            diag = diagnosticar(exc, motor=motor, host=host, puerto=puerto,
                                base_datos=base, opciones=opciones)
            return {"ok": False, "pasos": pasos.items, "diagnostico": diag,
                    "mensaje": f"La base y las tablas están, pero no se pudo "
                               f"crear el usuario: {diag['titulo']}."}
    else:
        pasos.info("usuario", "No se pidió crear usuario; se usará uno que ya "
                              "exista.")

    # ---------------- 4 · Verificación con la cuenta de la aplicación ---
    # Con la cuenta del HMI, NO con la de administrador. Es la única prueba
    # que representa lo que va a pasar en producción: sa entra siempre, y eso
    # no demuestra nada sobre si `hmi_app` puede.
    usuario_prueba = usuario_verificar or usuario_hmi
    password_prueba = password_verificar or password_hmi
    if usuario_prueba and password_prueba:
        try:
            comprobante = SqlDriver(
                motor=motor, host=host, puerto=puerto, base_datos=base,
                usuario=usuario_prueba, password=password_prueba,
                opciones=opciones,
            )
            await comprobante.connect()
            try:
                n = await _contar_tablas(comprobante, motor)
            finally:
                await comprobante.disconnect()
            pasos.ok(
                "verificacion",
                f"'{usuario_prueba}' entra en '{base}' y ve {n} tabla(s). "
                f"La conexión del HMI va a funcionar.",
            )
        except Exception as exc:  # noqa: BLE001
            diag = diagnosticar(exc, motor=motor, host=host, puerto=puerto,
                                base_datos=base, opciones=opciones)
            return {
                "ok": False, "pasos": pasos.items, "diagnostico": diag,
                "mensaje": (
                    f"La base y las tablas están creadas, pero "
                    f"'{usuario_prueba}' todavía no puede entrar: "
                    f"{diag['titulo']}."
                ),
            }
    else:
        pasos.info("verificacion",
                   "Sin credenciales del HMI que probar; se verificará al "
                   "guardar la conexión.")

    return {"ok": True, "pasos": pasos.items, "base_datos": base,
            "mensaje": f"'{base}' lista para usar."}


async def _contar_tablas(driver: SqlDriver, motor: str) -> int:
    """Cuántas tablas ve ese usuario. Equivale al SELECT final de un DBA."""
    if motor == "mssql":
        sql = "SELECT COUNT(*) AS n FROM sys.tables"
    elif motor == "mysql":
        sql = ("SELECT COUNT(*) AS n FROM information_schema.tables "
               "WHERE table_schema = DATABASE()")
    elif motor == "postgresql":
        sql = ("SELECT COUNT(*) AS n FROM information_schema.tables "
               "WHERE table_schema = 'public'")
    else:
        sql = ("SELECT COUNT(*) AS n FROM sqlite_master "
               "WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    r = await driver.query(sql, limite=1)
    return int(r.filas[0]["n"]) if r.filas else 0


# ---------------------------------------------------------------------- #
# SQL por motor
# ---------------------------------------------------------------------- #
async def _existe_base(conn, motor: str, base: str) -> bool:
    if motor == "mssql":
        q = text("SELECT 1 FROM sys.databases WHERE name = :n")
    elif motor == "postgresql":
        q = text("SELECT 1 FROM pg_database WHERE datname = :n")
    else:  # mysql
        q = text("SELECT 1 FROM information_schema.schemata "
                 "WHERE schema_name = :n")
    r = await conn.execute(q, {"n": base})
    return r.first() is not None


def _sql_crear_base(motor: str, base: str, coll: str) -> str:
    if motor == "mssql":
        # `base` y `coll` están validados con lista blanca: ver _ident().
        return f"CREATE DATABASE [{base}]" + (f" COLLATE {coll}" if coll else "")
    if motor == "mysql":
        cs = "utf8mb4"
        return (f"CREATE DATABASE IF NOT EXISTS `{base}` "
                f"CHARACTER SET {cs}" + (f" COLLATE {coll}" if coll else ""))
    # PostgreSQL: no tiene IF NOT EXISTS, por eso se comprueba antes.
    #
    # Sin LC_COLLATE a propósito: en PostgreSQL la collation se hereda de la
    # plantilla del cluster, y forzar otra distinta exige que exista una
    # plantilla compatible — si no, falla con "new collation is incompatible".
    # Heredar es lo que funciona en el 99 % de las instalaciones.
    return f'CREATE DATABASE "{base}"' 


async def _crear_usuario(
    motor: str, host: str, puerto: Optional[int], base: str,
    admin_usuario: str, admin_password: str, opciones: Dict[str, str],
    usuario: str, password: str,
) -> List[str]:
    """
    Crea el usuario del HMI y le da lectura/escritura de FILAS sobre `base`.

    Deliberadamente **sin** permisos de estructura: ni `db_ddladmin` en SQL
    Server, ni `CREATE`/`ALTER`/`DROP` en MySQL, ni `OWNER` en PostgreSQL. El
    HMI escribe datos; las tablas ya están hechas cuando llega aquí.

    **Si el usuario ya existe NO se le cambia la contraseña.** Es una decisión
    a propósito: alguien que se equivoca al teclear su contraseña y pulsa
    "crear usuario" esperaría que le dijeran que ya existe, no que le
    reescribieran la credencial de una cuenta en uso. Lo que sí se hace es
    (re)aplicar los permisos, que es idempotente y arregla el caso de un
    usuario creado a mano al que se le olvidó el GRANT.

    Devuelve la lista de lo que ocurrió, para que el parte diga la verdad en
    vez de un "creado" genérico.
    """
    pwd = _literal(password, motor)
    notas: List[str] = []

    if motor == "mssql":
        # El login vive en el servidor (master) y el usuario dentro de la base:
        # son dos objetos distintos y hacen falta los dos.
        eng = _motor_autocommit(
            _url(motor, host, puerto, "master", admin_usuario,
                 admin_password, opciones))
        try:
            async with eng.connect() as conn:
                existe = await conn.execute(
                    text("SELECT 1 FROM sys.server_principals WHERE name = :n"),
                    {"n": usuario})
                if existe.first() is None:
                    await conn.execute(text(
                        f"CREATE LOGIN [{usuario}] WITH PASSWORD = N'{pwd}', "
                        f"DEFAULT_DATABASE = [{base}]"))
                    notas.append(f"Login '{usuario}' creado.")
                else:
                    notas.append(f"El login '{usuario}' ya existía "
                                 f"(no se toca su contraseña).")
        finally:
            await eng.dispose()

        eng = _motor_autocommit(
            _url(motor, host, puerto, base, admin_usuario,
                 admin_password, opciones))
        try:
            async with eng.connect() as conn:
                existe = await conn.execute(
                    text("SELECT 1 FROM sys.database_principals WHERE name = :n"),
                    {"n": usuario})
                if existe.first() is None:
                    await conn.execute(text(
                        f"CREATE USER [{usuario}] FOR LOGIN [{usuario}]"))
                    notas.append(f"Usuario '{usuario}' mapeado dentro de "
                                 f"'{base}'.")
                await conn.execute(text(
                    f"ALTER ROLE db_datareader ADD MEMBER [{usuario}]"))
                await conn.execute(text(
                    f"ALTER ROLE db_datawriter ADD MEMBER [{usuario}]"))
                notas.append("Permisos de lectura y escritura de filas "
                             "aplicados (sin permisos de estructura).")
        finally:
            await eng.dispose()
        return notas

    if motor == "mysql":
        eng = _motor_autocommit(
            _url(motor, host, puerto, "", admin_usuario,
                 admin_password, opciones))
        try:
            async with eng.connect() as conn:
                # '%' = desde cualquier host. El backend puede estar en otra
                # máquina que la base, que es lo normal en planta.
                existe = await conn.execute(
                    text("SELECT 1 FROM mysql.user WHERE user = :n"),
                    {"n": usuario})
                if existe.first() is None:
                    await conn.execute(text(
                        f"CREATE USER '{usuario}'@'%' IDENTIFIED BY '{pwd}'"))
                    notas.append(f"Usuario '{usuario}' creado.")
                else:
                    notas.append(f"El usuario '{usuario}' ya existía "
                                 f"(no se toca su contraseña).")
                await conn.execute(text(
                    f"GRANT SELECT, INSERT, UPDATE, DELETE "
                    f"ON `{base}`.* TO '{usuario}'@'%'"))
                await conn.execute(text("FLUSH PRIVILEGES"))
                notas.append(f"Permisos de lectura y escritura sobre "
                             f"'{base}' aplicados.")
        finally:
            await eng.dispose()
        return notas

    # PostgreSQL: el rol es del cluster; los permisos, de la base.
    eng = _motor_autocommit(
        _url(motor, host, puerto, "postgres", admin_usuario,
             admin_password, opciones))
    try:
        async with eng.connect() as conn:
            existe = await conn.execute(
                text("SELECT 1 FROM pg_roles WHERE rolname = :n"),
                {"n": usuario})
            if existe.first() is None:
                await conn.execute(text(
                    f"CREATE ROLE \"{usuario}\" LOGIN PASSWORD '{pwd}'"))
                notas.append(f"Rol '{usuario}' creado.")
            else:
                notas.append(f"El rol '{usuario}' ya existía "
                             f"(no se toca su contraseña).")
            await conn.execute(text(
                f'GRANT CONNECT ON DATABASE "{base}" TO "{usuario}"'))
    finally:
        await eng.dispose()

    eng = _motor_autocommit(
        _url(motor, host, puerto, base, admin_usuario,
             admin_password, opciones))
    try:
        async with eng.connect() as conn:
            await conn.execute(text(
                f'GRANT USAGE ON SCHEMA public TO "{usuario}"'))
            await conn.execute(text(
                f"GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES "
                f'IN SCHEMA public TO "{usuario}"'))
            # Para las tablas que se creen DESPUÉS: sin esto, añadir una tabla
            # mañana dejaría al HMI sin acceso a ella y el fallo aparecería
            # semanas más tarde.
            await conn.execute(text(
                f"ALTER DEFAULT PRIVILEGES IN SCHEMA public "
                f"GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES "
                f'TO "{usuario}"'))
            notas.append(f"Permisos de lectura y escritura sobre '{base}' "
                         f"aplicados, incluidas las tablas futuras.")
    finally:
        await eng.dispose()
    return notas
