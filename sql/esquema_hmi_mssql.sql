-- ==========================================================================
--  Esquema del HMI · SQL Server
-- ==========================================================================
--  GENERADO AUTOMÁTICAMENTE por tools/generar_sql.py el 2026-08-27.
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
--  Ninguna FK lleva ON DELETE. No es un olvido: SQL Server rechaza el
--  esquema entero (Msg 1785, "may cause cycles or multiple cascade paths")
--  en cuanto una tabla es alcanzable por dos caminos en cascada, y aquí lo
--  es por diseño — un receta_valores depende del registro Y del elemento.
--  El borrado en orden lo hace la aplicación (CrudManager.borrar): pone a
--  NULL las referencias de auditoría y borra las hijas antes que la padre.
--  Borrar un usuario sigue sin llevarse su historial de alarmas: se pierde
--  el "quién", no el evento.
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

-- Fin del esquema.
