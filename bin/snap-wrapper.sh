#!/bin/sh
# =========================================================================
# Arranque de Psi Core dentro del snap (ctrlX CORE).
#
# Hace tres cosas antes de lanzar uvicorn, y las tres son idempotentes:
#   1. Deja los datos en $SNAP_COMMON/datos, que es la única carpeta que
#      sobrevive a las actualizaciones del snap y que se puede leer por SSH
#      (/var/snap/psicore/common/datos). El código no cambia: ya obedece a
#      PLC_DATOS_DIR.
#   2. La PRIMERA vez siembra widgets y temas desde $SNAP/semilla.
#   3. La PRIMERA vez crea la base SQLite «local» con las tablas del HMI y
#      la da de alta en conexiones.json, para que la app arranque directa en
#      «crear la primera cuenta» y no en el asistente de bases de datos.
# =========================================================================
set -eu

RAIZ="$SNAP/psicore"
DATOS="$SNAP_COMMON/datos"
mkdir -p "$DATOS"

# ── 2 · Semilla (solo si no hay nada) ──────────────────────────────────
if [ ! -d "$DATOS/widgets" ] && [ -d "$SNAP/semilla/widgets" ]; then
  cp -r "$SNAP/semilla/widgets" "$DATOS/widgets"
fi
for f in temas.json categorias_widgets.json; do
  if [ ! -f "$DATOS/$f" ] && [ -f "$SNAP/semilla/$f" ]; then
    cp "$SNAP/semilla/$f" "$DATOS/$f"
  fi
done

# ── 3 · Base SQLite local con el esquema del HMI ───────────────────────
BD="$DATOS/psicore.db"
if [ ! -f "$BD" ]; then
  "$SNAP/venv/bin/python" - "$BD" "$RAIZ/sql/esquema_hmi_sqlite.sql" <<'PY'
import sqlite3, sys
bd, esquema = sys.argv[1], sys.argv[2]
con = sqlite3.connect(bd)
try:
    con.executescript(open(esquema, encoding="utf-8").read())
    con.commit()
finally:
    con.close()
print(f"[psicore] Base SQLite creada en {bd}")
PY
fi
if [ ! -f "$DATOS/conexiones.json" ]; then
  cat > "$DATOS/conexiones.json" <<JSON
[
  {
    "db_id": "local",
    "motor": "sqlite",
    "nombre": "Local (SQLite en el ctrlX)",
    "host": "",
    "puerto": null,
    "base_datos": "$BD",
    "usuario": "",
    "password": "",
    "opciones": {},
    "autoconectar": true
  }
]
JSON
  echo "[psicore] conexiones.json inicial con la base SQLite local"
fi

# ── 1 · Entorno ────────────────────────────────────────────────────────
export PLC_DATOS_DIR="$DATOS"
export PLC_API_HOST="${PLC_API_HOST:-0.0.0.0}"
export PLC_API_PORT="${PLC_API_PORT:-8010}"
# Todo lo que algún módulo quiera escribir «en el home» (certificados OPC UA
# del driver Rexroth, cachés) cae también en la carpeta de datos.
export HOME="$SNAP_COMMON"
export XDG_DATA_HOME="$DATOS"
export PYTHONPATH="$RAIZ"
export PYTHONUNBUFFERED=1

cd "$RAIZ"
exec "$SNAP/venv/bin/python" -m uvicorn app.main:app \
  --host "$PLC_API_HOST" \
  --port "$PLC_API_PORT" \
  --log-level "${PLC_LOG_LEVEL:-info}"
