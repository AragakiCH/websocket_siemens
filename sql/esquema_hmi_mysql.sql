-- ==========================================================================
--  Esquema del HMI · MySQL / MariaDB
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
CREATE TABLE IF NOT EXISTS usuarios (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    usuario VARCHAR(80) NOT NULL UNIQUE,
    password_hash VARCHAR(255) NOT NULL,
    algoritmo VARCHAR(30) NOT NULL DEFAULT 'pbkdf2_sha256',
    email VARCHAR(160),
    categoria VARCHAR(40) NOT NULL DEFAULT 'Usuarios',
    estado VARCHAR(20) NOT NULL DEFAULT 'Activo',
    creado_en DATETIME(3),
    ultimo_acceso DATETIME(3)
)
;

-- ---- Tabla: plc_prg ---------------------------------------------
CREATE TABLE IF NOT EXISTS plc_prg (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    ts DATETIME(3) NOT NULL,
    plc_id VARCHAR(120) NOT NULL,
    programa VARCHAR(200),
    tag VARCHAR(400) NOT NULL,
    valor_num DOUBLE PRECISION,
    valor_texto TEXT,
    tipo VARCHAR(40)
)
;

-- ---- Tabla: alarmas ---------------------------------------------
CREATE TABLE IF NOT EXISTS alarmas (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    plc_prg_id BIGINT,
    usuario_id BIGINT,
    tipo VARCHAR(20) NOT NULL DEFAULT 'proceso',
    area VARCHAR(80),
    severidad INT NOT NULL DEFAULT 3,
    mensaje VARCHAR(500) NOT NULL,
    tag VARCHAR(400),
    valor_disparo DOUBLE PRECISION,
    estado VARCHAR(20) NOT NULL DEFAULT 'activa',
    ts_activacion DATETIME(3) NOT NULL,
    ts_reconocimiento DATETIME(3),
    ts_normalizacion DATETIME(3),
    CONSTRAINT fk_alarmas_plc FOREIGN KEY (plc_prg_id) REFERENCES plc_prg (id) ON DELETE SET NULL,
    CONSTRAINT fk_alarmas_usuario FOREIGN KEY (usuario_id) REFERENCES usuarios (id) ON DELETE SET NULL
)
;

-- ---- Tabla: recetas ---------------------------------------------
CREATE TABLE IF NOT EXISTS recetas (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    plc_prg_id BIGINT,
    usuario_id BIGINT,
    nombre VARCHAR(160) NOT NULL,
    nombre_receta VARCHAR(160) NOT NULL,
    tag VARCHAR(400) NOT NULL,
    tipo_dato VARCHAR(40) NOT NULL DEFAULT 'REAL',
    longitud_dato INT,
    valor_default DOUBLE PRECISION,
    valor_minimo DOUBLE PRECISION,
    valor_maximo DOUBLE PRECISION,
    valor_texto VARCHAR(500),
    lugar_decimal INT NOT NULL DEFAULT 0,
    decimales INT NOT NULL DEFAULT 0,
    unidad VARCHAR(30),
    informacion_herramienta VARCHAR(500),
    activo INT NOT NULL DEFAULT 1,
    creado_en DATETIME(3),
    actualizado_en DATETIME(3),
    CONSTRAINT fk_recetas_plc FOREIGN KEY (plc_prg_id) REFERENCES plc_prg (id) ON DELETE SET NULL,
    CONSTRAINT fk_recetas_usuario FOREIGN KEY (usuario_id) REFERENCES usuarios (id) ON DELETE SET NULL
)
;

-- ---- Índice: idx_plc_prg_tag_ts ----------------------------------
CREATE INDEX idx_plc_prg_tag_ts ON plc_prg (tag, ts)
;

-- ---- Índice: idx_plc_prg_plc_ts ----------------------------------
CREATE INDEX idx_plc_prg_plc_ts ON plc_prg (plc_id, ts)
;

-- ---- Índice: idx_alarmas_estado ----------------------------------
CREATE INDEX idx_alarmas_estado ON alarmas (estado, ts_activacion)
;

-- ---- Índice: idx_alarmas_tipo ------------------------------------
CREATE INDEX idx_alarmas_tipo ON alarmas (tipo, ts_activacion)
;

-- ---- Índice: idx_recetas_nombre ----------------------------------
CREATE INDEX idx_recetas_nombre ON recetas (nombre_receta)
;

-- ---- Índice: idx_recetas_tag -------------------------------------
CREATE INDEX idx_recetas_tag ON recetas (tag)
;

-- Fin del esquema.
