-- ==========================================================================
--  Esquema del HMI · SQL Server
-- ==========================================================================
--  GENERADO AUTOMÁTICAMENTE por tools/generar_sql.py el 2026-08-26.
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

-- ---- Tabla: alarmas ---------------------------------------------
IF OBJECT_ID('alarmas', 'U') IS NULL CREATE TABLE alarmas (
    id BIGINT IDENTITY(1,1) PRIMARY KEY,
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
    CONSTRAINT fk_alarmas_plc FOREIGN KEY (plc_prg_id) REFERENCES plc_prg (id) ON DELETE SET NULL,
    CONSTRAINT fk_alarmas_usuario FOREIGN KEY (usuario_id) REFERENCES usuarios (id) ON DELETE SET NULL
)

GO

-- ---- Tabla: recetas ---------------------------------------------
IF OBJECT_ID('recetas', 'U') IS NULL CREATE TABLE recetas (
    id BIGINT IDENTITY(1,1) PRIMARY KEY,
    plc_prg_id BIGINT,
    usuario_id BIGINT,
    nombre VARCHAR(160) NOT NULL,
    nombre_receta VARCHAR(160) NOT NULL,
    tag VARCHAR(400) NOT NULL,
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
    activo INT NOT NULL DEFAULT 1,
    creado_en DATETIME2,
    actualizado_en DATETIME2,
    CONSTRAINT fk_recetas_plc FOREIGN KEY (plc_prg_id) REFERENCES plc_prg (id) ON DELETE SET NULL,
    CONSTRAINT fk_recetas_usuario FOREIGN KEY (usuario_id) REFERENCES usuarios (id) ON DELETE SET NULL
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

-- ---- Índice: idx_recetas_nombre ----------------------------------
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='idx_recetas_nombre') CREATE INDEX idx_recetas_nombre ON recetas (nombre_receta)

GO

-- ---- Índice: idx_recetas_tag -------------------------------------
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='idx_recetas_tag') CREATE INDEX idx_recetas_tag ON recetas (tag)

GO

-- Fin del esquema.
