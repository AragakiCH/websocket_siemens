# -*- coding: utf-8 -*-
"""
generar_sql.py
==============
Genera los scripts `.sql` del esquema del HMI a partir del MISMO código que
usa el backend para hablar con la base de datos.

**Por qué existe.** El servicio ya no crea tablas: eso lo hace un DBA
ejecutando un `.sql`. Pero si ese `.sql` se escribiera a mano, se
desincronizaría con el backend en cuanto alguien renombrara una columna, y el
CRUD empezaría a fallar con "Invalid column name" en producción.

Generándolo desde `SqlDriver.ddl_esquema_hmi()`, el script y el código no
pueden separarse: son la misma definición.

Uso:
    python tools/generar_sql.py              # los cuatro motores
    python tools/generar_sql.py --motor mssql
"""
from __future__ import annotations

import argparse
import os
import sys
from datetime import date

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.db.sql_driver import MOTORES, SqlDriver  # noqa: E402

# Separador de lotes: solo T-SQL lo necesita.
SEPARADOR = {"mssql": "GO", "postgresql": "", "mysql": "", "sqlite": ""}

CABECERA = """\
-- ==========================================================================
--  Esquema del HMI · {etiqueta}
-- ==========================================================================
--  GENERADO AUTOMÁTICAMENTE por tools/generar_sql.py el {fecha}.
--  No lo edites a mano: cambia `ddl_esquema_hmi()` en app/db/sql_driver.py
--  y vuelve a generarlo. Así el script y el backend nunca se desincronizan.
--
--  Crea cuatro tablas:
--
--    usuarios   Cuentas del HMI. Guarda el HASH de la contraseña, nunca la
--               contraseña. La escribe /auth.
--    plc_prg    Lecturas del PLC. Esquema estrecho: una fila por (ts, tag),
--               así añadir variables nunca requiere un ALTER TABLE.
--               La escribe el historizador, por lotes.
--    alarmas    Eventos con su ciclo de vida: activa -> reconocida ->
--               normalizada. La escribe /crud/alarmas.
--    recetas    Parámetros configurables del proceso, con sus límites de
--               seguridad. La escribe /crud/recetas.
--
--  Las FK usan ON DELETE SET NULL: borrar un usuario no se lleva por delante
--  su historial de alarmas. Se pierde el "quién", no el evento.
--
--  Es IDEMPOTENTE: ejecutarlo sobre una base de datos que ya lo tiene no
--  falla ni toca los datos existentes.
-- ==========================================================================

"""


def _bloques_tablas(motor: str, prefijo: str = "") -> list:
    """
    Devuelve las líneas del DDL de las cuatro tablas, ya formateadas y con el
    separador de lotes del motor.

    Se extrajo de `generar()` porque el script local (`--local`) necesita
    exactamente estas mismas sentencias, y duplicarlas reabriría justo el
    problema que este generador existe para evitar.
    """
    driver = SqlDriver(motor=motor, base_datos="plantilla")
    sentencias = driver.ddl_esquema_hmi(prefijo)
    sep = SEPARADOR.get(motor, "")

    partes = []
    for nombre, sql in sentencias:
        tipo = "Tabla" if "CREATE TABLE" in sql else "Índice"
        partes.append(f"-- ---- {tipo}: {nombre} " + "-" * (52 - len(nombre)))
        partes.append(_formatear(sql))
        partes.append(";" if motor != "mssql" else "")
        if sep:
            partes.append(sep)
        partes.append("")
    return partes


def generar(motor: str, prefijo: str = "") -> str:
    """Devuelve el script completo para un motor."""
    partes = [CABECERA.format(
        etiqueta=MOTORES[motor]["etiqueta"], fecha=date.today().isoformat())]
    partes.extend(_bloques_tablas(motor, prefijo))
    partes.append("-- Fin del esquema.")
    return "\n".join(partes) + "\n"


def _formatear(sql: str) -> str:
    """Parte el CREATE TABLE en una columna por línea, para poder leerlo."""
    if "CREATE TABLE" not in sql:
        return sql
    # El paréntesis de las columnas es el que sigue a CREATE TABLE <nombre>,
    # no el primero del texto: en T-SQL la sentencia empieza por
    # `IF OBJECT_ID('tabla', 'U') IS NULL`, y partir por ahí la rompería.
    abre = sql.find("(", sql.index("CREATE TABLE"))
    cierra = sql.rfind(")")
    if abre == -1 or cierra == -1:
        return sql

    cabeza, cuerpo, cola = sql[:abre + 1], sql[abre + 1:cierra], sql[cierra:]

    # Cortar por comas que estén fuera de paréntesis (los tipos llevan comas:
    # DATETIME(3), VARCHAR(80), IDENTITY(1,1)...).
    partes, actual, nivel = [], [], 0
    for ch in cuerpo:
        if ch == "(":
            nivel += 1
        elif ch == ")":
            nivel -= 1
        if ch == "," and nivel == 0:
            partes.append("".join(actual).strip())
            actual = []
        else:
            actual.append(ch)
    if actual:
        partes.append("".join(actual).strip())

    return cabeza + "\n    " + ",\n    ".join(partes) + "\n" + cola


# ====================================================================== #
# Script "todo en uno" para una instalación LOCAL de SQL Server
# ====================================================================== #
# El .sql del esquema crea TABLAS, pero da por hecho que la base de datos, el
# login y el usuario ya existen: en el servidor eso se hizo a mano por SSH.
# En una máquina local con SSMS no hay SSH ni sqlcmd de por medio, así que
# este script lo hace todo de una pasada: base -> login -> usuario -> tablas,
# y termina verificando. Se abre en SSMS y se pulsa Execute.
#
# Sigue siendo IDEMPOTENTE y NO toca ninguna otra base de datos del servidor.

CABECERA_LOCAL = """\
-- ==========================================================================
--  HMI · instalación LOCAL completa · SQL Server
-- ==========================================================================
--  GENERADO AUTOMÁTICAMENTE por `python tools/generar_sql.py --local`
--  el {fecha}. No lo edites a mano: cambia `ddl_esquema_hmi()` en
--  app/db/sql_driver.py y vuelve a generarlo.
--
--  QUÉ HACE, en orden:
--    1. Diagnóstico del servidor (edición, modo de autenticación, puerto TCP)
--    2. CREATE DATABASE [{bd}] COLLATE {collation}
--    3. Login SQL [{usuario}]  (a nivel de servidor)
--    4. Usuario [{usuario}] dentro de [{bd}] + db_datareader/db_datawriter
--    5. Las cuatro tablas: usuarios, plc_prg, alarmas, recetas
--    6. Verificación final
--
--  CÓMO SE USA
--    SSMS -> File > Open > File... -> este .sql -> Execute (F5).
--    Conéctate con una cuenta sysadmin (la de Windows con la que administras
--    el equipo sirve). No hace falta seleccionar base de datos antes: el
--    script hace su propio USE.
--
--  SEGURO POR CONSTRUCCIÓN
--    * Es IDEMPOTENTE: ejecutarlo dos veces no falla ni pierde datos.
--    * Solo toca [{bd}]. Cualquier otra base de datos del servidor queda
--      intacta.
--
--  ⚠ LA CONTRASEÑA del login va escrita en el paso 3 (dos veces). Para
--    cambiarla, regenera el script en vez de editarlo a mano:
--        python tools/generar_sql.py --local --password 'TuPasswordFuerte!'
-- ==========================================================================


-- ==========================================================================
--  1 · Diagnóstico  (no modifica nada; lee el resultado antes de seguir)
-- ==========================================================================
SELECT
    @@SERVERNAME                                        AS servidor,
    CAST(SERVERPROPERTY('Edition')      AS NVARCHAR(80)) AS edicion,
    CAST(SERVERPROPERTY('ProductVersion') AS NVARCHAR(40)) AS version,
    CASE WHEN SERVERPROPERTY('IsIntegratedSecurityOnly') = 1
         THEN 'Windows UNICAMENTE -> el login SQL no podra conectarse (ver nota A)'
         ELSE 'Mixto (SQL + Windows) -> correcto'
    END                                                 AS modo_autenticacion;
GO

-- Puerto TCP de la instancia. El backend del HMI se conecta por TCP/IP, no
-- por memoria compartida como SSMS, asi que esto tiene que estar habilitado.
-- Si no devuelve filas o TcpPort sale vacio, ver nota B.
BEGIN TRY
    SELECT value_name, value_data
    FROM sys.dm_server_registry
    WHERE registry_key LIKE '%SuperSocketNetLib\\Tcp\\IPAll%';
END TRY
BEGIN CATCH
    PRINT 'No se pudo leer el puerto TCP (hace falta permiso VIEW SERVER STATE).';
END CATCH
GO


-- ==========================================================================
--  2 · La base de datos
-- ==========================================================================
IF DB_ID(N'{bd}') IS NULL
BEGIN
    CREATE DATABASE [{bd}] COLLATE {collation};
    PRINT 'Base de datos [{bd}] creada con collation {collation}.';
END
ELSE
    PRINT 'La base de datos [{bd}] ya existia; no se toca.';
GO

-- Aviso si ya existia con OTRA collation. No se corrige sola a proposito:
-- ALTER DATABASE ... COLLATE no cambia las columnas que ya existen, asi que
-- el arreglo de verdad es borrar y rehacer (ver docs/DESPLIEGUE_HMI_PSI.md).
IF EXISTS (SELECT 1 FROM sys.databases
           WHERE name = N'{bd}' AND collation_name <> N'{collation}')
    PRINT '*** AVISO: [{bd}] NO tiene la collation {collation}. ***';
GO


-- ==========================================================================
--  3 · Login del servidor
-- ==========================================================================
IF NOT EXISTS (SELECT 1 FROM sys.server_principals WHERE name = N'{usuario}')
BEGIN
    CREATE LOGIN [{usuario}] WITH PASSWORD = N'{password}',
        CHECK_POLICY = ON, DEFAULT_DATABASE = [{bd}];
    PRINT 'Login [{usuario}] creado.';
END
ELSE
BEGIN
    ALTER LOGIN [{usuario}] WITH PASSWORD = N'{password}';
    PRINT 'Login [{usuario}] ya existia; contrasena actualizada.';
END
GO


-- ==========================================================================
--  4 · Usuario dentro de la base + permisos
-- ==========================================================================
USE [{bd}];
GO

IF NOT EXISTS (SELECT 1 FROM sys.database_principals WHERE name = N'{usuario}')
    CREATE USER [{usuario}] FOR LOGIN [{usuario}];
GO

-- Lectura y escritura de FILAS. Deliberadamente SIN db_ddladmin: el HMI no
-- crea ni altera tablas, eso lo hace este script. Una aplicacion que puede
-- alterar la estructura de la BD de produccion es una que puede romperla.
ALTER ROLE db_datareader ADD MEMBER [{usuario}];
ALTER ROLE db_datawriter ADD MEMBER [{usuario}];
GO


-- ==========================================================================
--  5 · Las tablas del HMI
-- ==========================================================================
--    usuarios   Cuentas del HMI. Guarda el HASH, nunca la contrasena.
--    plc_prg    Lecturas del PLC. Esquema estrecho: una fila por (ts, tag),
--               asi anadir variables nunca requiere un ALTER TABLE.
--    alarmas    Eventos: activa -> reconocida -> normalizada.
--    recetas    Parametros del proceso con sus limites.
-- ==========================================================================

"""

PIE_LOCAL = """\
-- ==========================================================================
--  6 · Verificación final
-- ==========================================================================
SELECT
    DB_NAME()                                                  AS base_datos,
    (SELECT collation_name FROM sys.databases WHERE name = DB_NAME()) AS collation,
    (SELECT COUNT(*) FROM sys.tables)                          AS num_tablas;

SELECT name AS tabla FROM sys.tables ORDER BY name;
GO

PRINT '';
PRINT '=========================================================';
PRINT ' Listo. Deben aparecer 4 tablas: alarmas, plc_prg,';
PRINT ' recetas, usuarios.';
PRINT '';
PRINT ' Siguiente paso: dar de alta la conexion en el HMI con';
PRINT '   POST /db  ->  host: localhost   puerto: 1433';
PRINT '                 base_datos: {bd}';
PRINT '                 usuario: {usuario}';
PRINT '                 driver: ODBC Driver 18 for SQL Server';
PRINT '                 TrustServerCertificate: yes';
PRINT '=========================================================';
GO

-- ==========================================================================
--  NOTAS  (leer si algo del diagnostico del paso 1 salio mal)
-- ==========================================================================
--
--  A · "Windows UNICAMENTE"
--     El login [{usuario}] se crea igual, pero SQL Server le rechazara la
--     conexion con "Login failed". El HMI necesita autenticacion SQL porque
--     manda usuario y contrasena, no un token de Windows.
--     Arreglo: SSMS -> boton derecho sobre el servidor -> Properties ->
--     Security -> "SQL Server and Windows Authentication mode" -> OK, y
--     REINICIAR el servicio (Configuration Manager, o services.msc ->
--     SQL Server (MSSQLSERVER) -> Restart). Sin el reinicio no aplica.
--
--  B · Sin puerto TCP / TCP deshabilitado
--     SSMS se conecta por memoria compartida, asi que funciona aunque TCP/IP
--     este apagado. El backend del HMI NO: usa TCP y fallaria con "Login
--     timeout expired".
--     Arreglo: SQL Server Configuration Manager -> SQL Server Network
--     Configuration -> Protocols -> TCP/IP = Enabled. Doble clic -> pestana
--     IP Addresses -> IPAll -> TCP Port = 1433, TCP Dynamic Ports = vacio.
--     Reiniciar el servicio.
--
--  C · La contrasena es rechazada
--     CHECK_POLICY = ON aplica la politica de Windows: minimo 8 caracteres y
--     tres de estas cuatro familias: mayusculas, minusculas, digitos,
--     simbolos. Y no puede contener el nombre de login.
--
-- ==========================================================================
-- Fin del script.
"""


def generar_local(bd: str, usuario: str, password: str, collation: str,
                  prefijo: str = "") -> str:
    """Script T-SQL completo para instalar el HMI en un SQL Server local."""
    ctx = dict(bd=bd, usuario=usuario, password=password,
               collation=collation, fecha=date.today().isoformat())
    partes = [CABECERA_LOCAL.format(**ctx)]
    partes.extend(_bloques_tablas("mssql", prefijo))
    partes.append(PIE_LOCAL.format(**ctx))
    return "\n".join(partes) + "\n"


def main() -> None:
    ap = argparse.ArgumentParser(description="Genera los .sql del esquema")
    ap.add_argument("--motor", choices=sorted(MOTORES),
                    help="Solo este motor. Por defecto, todos.")
    ap.add_argument("--prefijo", default="",
                    help="Prefijo de tabla (planta1 -> planta1_usuarios).")
    ap.add_argument("--salida", default="sql", help="Carpeta destino.")
    ap.add_argument("--local", action="store_true",
                    help="Genera ADEMAS el script todo-en-uno para un SQL "
                         "Server local (base + login + usuario + tablas).")
    ap.add_argument("--bd", default="HMI_PSI", help="Base de datos (--local).")
    ap.add_argument("--usuario", default="hmi_app", help="Login SQL (--local).")
    ap.add_argument("--password", default="Hmi_Psi2026!",
                    help="Contrasena del login (--local). CAMBIALA.")
    ap.add_argument("--collation", default="Modern_Spanish_CI_AS",
                    help="Collation de la base (--local).")
    args = ap.parse_args()

    os.makedirs(args.salida, exist_ok=True)

    if args.local:
        contenido = generar_local(args.bd, args.usuario, args.password,
                                  args.collation, args.prefijo)
        ruta = os.path.join(args.salida, "local_hmi_psi_mssql.sql")
        with open(ruta, "w", encoding="utf-8") as f:
            f.write(contenido)
        print(f"  {ruta:<34} base {args.bd}, login {args.usuario}, "
              f"{contenido.count('CREATE TABLE')} tablas")
        if not args.motor:
            return

    motores = [args.motor] if args.motor else sorted(MOTORES)

    for motor in motores:
        contenido = generar(motor, args.prefijo)
        ruta = os.path.join(args.salida, f"esquema_hmi_{motor}.sql")
        with open(ruta, "w", encoding="utf-8") as f:
            f.write(contenido)
        n_tablas = contenido.count("CREATE TABLE")
        n_indices = contenido.count("CREATE INDEX")
        print(f"  {ruta:<34} {n_tablas} tablas, {n_indices} índices")


if __name__ == "__main__":
    main()
