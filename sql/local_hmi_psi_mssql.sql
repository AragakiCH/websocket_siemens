-- ==========================================================================
--  HMI · instalación LOCAL completa · SQL Server
-- ==========================================================================
--  GENERADO AUTOMÁTICAMENTE por `python tools/generar_sql.py --local`
--  el 2026-08-27. No lo edites a mano: cambia `ddl_esquema_hmi()` en
--  app/db/sql_driver.py y vuelve a generarlo.
--
--  QUÉ HACE, en orden:
--    1. Diagnóstico del servidor (edición, modo de autenticación, puerto TCP)
--    2. CREATE DATABASE [HMI_PSI] COLLATE Modern_Spanish_CI_AS
--    3. Login SQL [hmi_app]  (a nivel de servidor)
--    4. Usuario [hmi_app] dentro de [HMI_PSI] + db_datareader/db_datawriter
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
--    * Solo toca [HMI_PSI]. Cualquier otra base de datos del servidor queda
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
    WHERE registry_key LIKE '%SuperSocketNetLib\Tcp\IPAll%';
END TRY
BEGIN CATCH
    PRINT 'No se pudo leer el puerto TCP (hace falta permiso VIEW SERVER STATE).';
END CATCH
GO


-- ==========================================================================
--  2 · La base de datos
-- ==========================================================================
IF DB_ID(N'HMI_PSI') IS NULL
BEGIN
    CREATE DATABASE [HMI_PSI] COLLATE Modern_Spanish_CI_AS;
    PRINT 'Base de datos [HMI_PSI] creada con collation Modern_Spanish_CI_AS.';
END
ELSE
    PRINT 'La base de datos [HMI_PSI] ya existia; no se toca.';
GO

-- Aviso si ya existia con OTRA collation. No se corrige sola a proposito:
-- ALTER DATABASE ... COLLATE no cambia las columnas que ya existen, asi que
-- el arreglo de verdad es borrar y rehacer (ver docs/DESPLIEGUE_HMI_PSI.md).
IF EXISTS (SELECT 1 FROM sys.databases
           WHERE name = N'HMI_PSI' AND collation_name <> N'Modern_Spanish_CI_AS')
    PRINT '*** AVISO: [HMI_PSI] NO tiene la collation Modern_Spanish_CI_AS. ***';
GO


-- ==========================================================================
--  3 · Login del servidor
-- ==========================================================================
IF NOT EXISTS (SELECT 1 FROM sys.server_principals WHERE name = N'hmi_app')
BEGIN
    CREATE LOGIN [hmi_app] WITH PASSWORD = N'Hmi_Psi2026!',
        CHECK_POLICY = ON, DEFAULT_DATABASE = [HMI_PSI];
    PRINT 'Login [hmi_app] creado.';
END
ELSE
BEGIN
    ALTER LOGIN [hmi_app] WITH PASSWORD = N'Hmi_Psi2026!';
    PRINT 'Login [hmi_app] ya existia; contrasena actualizada.';
END
GO


-- ==========================================================================
--  4 · Usuario dentro de la base + permisos
-- ==========================================================================
USE [HMI_PSI];
GO

IF NOT EXISTS (SELECT 1 FROM sys.database_principals WHERE name = N'hmi_app')
    CREATE USER [hmi_app] FOR LOGIN [hmi_app];
GO

-- Lectura y escritura de FILAS. Deliberadamente SIN db_ddladmin: el HMI no
-- crea ni altera tablas, eso lo hace este script. Una aplicacion que puede
-- alterar la estructura de la BD de produccion es una que puede romperla.
ALTER ROLE db_datareader ADD MEMBER [hmi_app];
ALTER ROLE db_datawriter ADD MEMBER [hmi_app];
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


-- ---- Tabla: usuarios --------------------------------------------
IF OBJECT_ID('usuarios', 'U') IS NULL CREATE TABLE usuarios (
    id BIGINT IDENTITY(1,1) PRIMARY KEY,
    usuario VARCHAR(80) NOT NULL UNIQUE,
    password_hash VARCHAR(255) NOT NULL,
    algoritmo VARCHAR(30) NOT NULL DEFAULT 'pbkdf2_sha256',
    email VARCHAR(160),
    categoria VARCHAR(40) NOT NULL DEFAULT 'Usuarios',
    estado VARCHAR(20) NOT NULL DEFAULT 'Activo',
    creado_en DATETIME2,
    ultimo_acceso DATETIME2
)

GO

-- ---- Tabla: plc_prg ---------------------------------------------
IF OBJECT_ID('plc_prg', 'U') IS NULL CREATE TABLE plc_prg (
    id BIGINT IDENTITY(1,1) PRIMARY KEY,
    ts DATETIME2 NOT NULL,
    plc_id VARCHAR(120) NOT NULL,
    programa VARCHAR(200),
    tag VARCHAR(400) NOT NULL,
    valor_num FLOAT,
    valor_texto NVARCHAR(MAX),
    tipo VARCHAR(40)
)

GO

-- ---- Tabla: alarmas_def -----------------------------------------
IF OBJECT_ID('alarmas_def', 'U') IS NULL CREATE TABLE alarmas_def (
    id BIGINT IDENTITY(1,1) PRIMARY KEY,
    nombre VARCHAR(120) NOT NULL,
    texto VARCHAR(500) NOT NULL,
    clase VARCHAR(20) NOT NULL DEFAULT 'Error',
    tag VARCHAR(400),
    bit_disparo INT DEFAULT 0,
    comparador VARCHAR(10) NOT NULL DEFAULT 'bit',
    valor_limite FLOAT,
    banda_muerta FLOAT DEFAULT 0,
    tag_reconocimiento VARCHAR(400),
    bit_reconocimiento INT DEFAULT 0,
    area VARCHAR(80),
    activo INT NOT NULL DEFAULT 1,
    creado_en DATETIME2,
    actualizado_en DATETIME2
)

GO

-- ---- Tabla: alarmas ---------------------------------------------
IF OBJECT_ID('alarmas', 'U') IS NULL CREATE TABLE alarmas (
    id BIGINT IDENTITY(1,1) PRIMARY KEY,
    alarma_def_id BIGINT,
    plc_prg_id BIGINT,
    usuario_id BIGINT,
    tipo VARCHAR(20) NOT NULL DEFAULT 'proceso',
    area VARCHAR(80),
    severidad INT NOT NULL DEFAULT 3,
    mensaje VARCHAR(500) NOT NULL,
    tag VARCHAR(400),
    valor_disparo FLOAT,
    estado VARCHAR(20) NOT NULL DEFAULT 'activa',
    ts_activacion DATETIME2 NOT NULL,
    ts_reconocimiento DATETIME2,
    ts_normalizacion DATETIME2,
    CONSTRAINT fk_alarmas_plc FOREIGN KEY (plc_prg_id) REFERENCES plc_prg (id),
    CONSTRAINT fk_alarmas_usuario FOREIGN KEY (usuario_id) REFERENCES usuarios (id),
    CONSTRAINT fk_alarmas_def FOREIGN KEY (alarma_def_id) REFERENCES alarmas_def (id)
)

GO

-- ---- Tabla: recetas ---------------------------------------------
IF OBJECT_ID('recetas', 'U') IS NULL CREATE TABLE recetas (
    id BIGINT IDENTITY(1,1) PRIMARY KEY,
    usuario_id BIGINT,
    nombre VARCHAR(160) NOT NULL,
    nombre_visible VARCHAR(160),
    numero INT,
    version VARCHAR(40),
    ruta VARCHAR(300),
    tipo VARCHAR(20) NOT NULL DEFAULT 'Limited',
    max_registros INT NOT NULL DEFAULT 500,
    tipo_comunicacion VARCHAR(20) NOT NULL DEFAULT 'Tags',
    comprobar_limites INT NOT NULL DEFAULT 1,
    informacion_herramienta VARCHAR(500),
    activo INT NOT NULL DEFAULT 1,
    creado_en DATETIME2,
    actualizado_en DATETIME2,
    CONSTRAINT fk_recetas_usuario FOREIGN KEY (usuario_id) REFERENCES usuarios (id)
)

GO

-- ---- Tabla: receta_elementos ------------------------------------
IF OBJECT_ID('receta_elementos', 'U') IS NULL CREATE TABLE receta_elementos (
    id BIGINT IDENTITY(1,1) PRIMARY KEY,
    receta_id BIGINT NOT NULL,
    plc_prg_id BIGINT,
    nombre VARCHAR(160) NOT NULL,
    nombre_visible VARCHAR(160),
    tag VARCHAR(400),
    tipo_dato VARCHAR(40) NOT NULL DEFAULT 'REAL',
    longitud_dato INT,
    valor_default FLOAT,
    valor_minimo FLOAT,
    valor_maximo FLOAT,
    valor_texto VARCHAR(500),
    lugar_decimal INT NOT NULL DEFAULT 0,
    decimales INT NOT NULL DEFAULT 0,
    unidad VARCHAR(30),
    informacion_herramienta VARCHAR(500),
    orden INT NOT NULL DEFAULT 0,
    activo INT NOT NULL DEFAULT 1,
    creado_en DATETIME2,
    actualizado_en DATETIME2,
    CONSTRAINT fk_receta_elementos_receta FOREIGN KEY (receta_id) REFERENCES recetas (id),
    CONSTRAINT fk_receta_elementos_plc FOREIGN KEY (plc_prg_id) REFERENCES plc_prg (id)
)

GO

-- ---- Tabla: receta_registros ------------------------------------
IF OBJECT_ID('receta_registros', 'U') IS NULL CREATE TABLE receta_registros (
    id BIGINT IDENTITY(1,1) PRIMARY KEY,
    receta_id BIGINT NOT NULL,
    usuario_id BIGINT,
    nombre VARCHAR(160) NOT NULL,
    nombre_visible VARCHAR(160),
    numero INT,
    comentario VARCHAR(500),
    ts_ultima_carga DATETIME2,
    activo INT NOT NULL DEFAULT 1,
    creado_en DATETIME2,
    actualizado_en DATETIME2,
    CONSTRAINT fk_receta_registros_receta FOREIGN KEY (receta_id) REFERENCES recetas (id),
    CONSTRAINT fk_receta_registros_usuario FOREIGN KEY (usuario_id) REFERENCES usuarios (id)
)

GO

-- ---- Tabla: receta_valores --------------------------------------
IF OBJECT_ID('receta_valores', 'U') IS NULL CREATE TABLE receta_valores (
    id BIGINT IDENTITY(1,1) PRIMARY KEY,
    receta_registro_id BIGINT NOT NULL,
    receta_elemento_id BIGINT NOT NULL,
    valor_num FLOAT,
    valor_texto VARCHAR(500),
    CONSTRAINT fk_receta_valores_registro FOREIGN KEY (receta_registro_id) REFERENCES receta_registros (id),
    CONSTRAINT fk_receta_valores_elemento FOREIGN KEY (receta_elemento_id) REFERENCES receta_elementos (id)
)

GO

-- ---- Índice: idx_plc_prg_tag_ts ----------------------------------
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='idx_plc_prg_tag_ts') CREATE INDEX idx_plc_prg_tag_ts ON plc_prg (tag, ts)

GO

-- ---- Índice: idx_plc_prg_plc_ts ----------------------------------
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='idx_plc_prg_plc_ts') CREATE INDEX idx_plc_prg_plc_ts ON plc_prg (plc_id, ts)

GO

-- ---- Índice: idx_alarmas_estado ----------------------------------
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='idx_alarmas_estado') CREATE INDEX idx_alarmas_estado ON alarmas (estado, ts_activacion)

GO

-- ---- Índice: idx_alarmas_tipo ------------------------------------
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='idx_alarmas_tipo') CREATE INDEX idx_alarmas_tipo ON alarmas (tipo, ts_activacion)

GO

-- ---- Índice: idx_alarmas_def_tag ---------------------------------
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='idx_alarmas_def_tag') CREATE INDEX idx_alarmas_def_tag ON alarmas_def (tag)

GO

-- ---- Índice: idx_alarmas_def_activo ------------------------------
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='idx_alarmas_def_activo') CREATE INDEX idx_alarmas_def_activo ON alarmas_def (activo)

GO

-- ---- Índice: idx_recetas_nombre ----------------------------------
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='idx_recetas_nombre') CREATE INDEX idx_recetas_nombre ON recetas (nombre)

GO

-- ---- Índice: idx_receta_elem_receta ------------------------------
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='idx_receta_elem_receta') CREATE INDEX idx_receta_elem_receta ON receta_elementos (receta_id, orden)

GO

-- ---- Índice: idx_receta_elem_tag ---------------------------------
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='idx_receta_elem_tag') CREATE INDEX idx_receta_elem_tag ON receta_elementos (tag)

GO

-- ---- Índice: idx_receta_reg_receta -------------------------------
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='idx_receta_reg_receta') CREATE INDEX idx_receta_reg_receta ON receta_registros (receta_id)

GO

-- ---- Índice: idx_receta_val_registro -----------------------------
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='idx_receta_val_registro') CREATE INDEX idx_receta_val_registro ON receta_valores (receta_registro_id)

GO

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
PRINT '                 base_datos: HMI_PSI';
PRINT '                 usuario: hmi_app';
PRINT '                 driver: ODBC Driver 18 for SQL Server';
PRINT '                 TrustServerCertificate: yes';
PRINT '=========================================================';
GO

-- ==========================================================================
--  NOTAS  (leer si algo del diagnostico del paso 1 salio mal)
-- ==========================================================================
--
--  A · "Windows UNICAMENTE"
--     El login [hmi_app] se crea igual, pero SQL Server le rechazara la
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

