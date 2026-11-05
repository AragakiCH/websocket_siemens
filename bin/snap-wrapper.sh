#!/bin/sh
# =========================================================================
# Arranque de Psi Core dentro del snap (ctrlX CORE).
#
# Hace cuatro cosas antes de lanzar uvicorn, y las cuatro son idempotentes:
#   0. Elige DÓNDE viven los datos (ver abajo): en el almacén de Solutions
#      del ctrlX si la interfaz `active-solution` está conectada, y si no
#      en $SNAP_COMMON/datos. El código no cambia: obedece a PLC_DATOS_DIR.
#   1. Siembra widgets y temas desde $SNAP/semilla la PRIMERA vez.
#   2. Crea la base SQLite «local» con las tablas del HMI la PRIMERA vez y
#      la da de alta en conexiones.json, para que la app arranque directa
#      en «crear la primera cuenta» y no en el asistente de bases de datos.
#   3. Exporta el entorno y arranca.
#
# DÓNDE VIVEN LOS DATOS, Y POR QUÉ
# ---------------------------------
# $SNAP_COMMON/datos sobrevive a ACTUALIZAR el snap, pero `snap remove` lo
# borra: desinstalar Psi Core era perder cuentas, pantallas y la base.
#
# El ctrlX tiene un sitio pensado para esto: el almacén de la app Solutions,
# que se monta en $SNAP_COMMON/solutions por la interfaz `active-solution`
# (ver snapcraft.yaml). Lo que una app guarda en
# $SNAP_COMMON/solutions/activeConfiguration/<app> es del ctrlX, no de la
# app: NO se borra al desinstalarla, y forma parte de la «configuración»
# que el ctrlX guarda, descarga y carga desde su web (Settings → Manage
# app data), sin SSH. Con `copyOnLoad` en package-manifest.json, el propio
# ctrlX copia la carpeta al guardar y al cargar.
#
# Si la interfaz no está conectada (un snap instalado «a mano» puede
# arrancar antes de que lo esté, o no estarlo nunca), se espera un rato y,
# si no llega, se usa $SNAP_COMMON/datos como hasta ahora; en cuanto se
# conecte, el siguiente arranque MIGRA lo que haya allí al almacén.
# =========================================================================
set -eu

RAIZ="$SNAP/psicore"
NOMBRE_APP="psicore"
DATOS_LOCAL="$SNAP_COMMON/datos"
SOLUCION="$SNAP_COMMON/solutions/activeConfiguration"

# ── 0 · Dónde viven los datos ──────────────────────────────────────────
conectada() {
  snapctl is-connected active-solution 2>/dev/null
}
espera=0
while ! conectada && [ "$espera" -lt 30 ]; do
  [ "$espera" -eq 0 ] && echo "[psicore] esperando a la interfaz active-solution (almacén de Solutions del ctrlX)..."
  sleep 2
  espera=$((espera + 2))
done

if conectada && [ -d "$SOLUCION" ]; then
  DATOS="$SOLUCION/$NOMBRE_APP"
  if [ ! -d "$DATOS" ] || [ -z "$(ls -A "$DATOS" 2>/dev/null)" ]; then
    mkdir -p "$DATOS"
    if [ -d "$DATOS_LOCAL" ] && [ -n "$(ls -A "$DATOS_LOCAL" 2>/dev/null)" ]; then
      # Primera vez con la interfaz: lo que había en common/datos pasa al
      # almacén. Se COPIA, no se mueve: si algo fallara a medias, lo de
      # antes sigue intacto. La copia vieja se renombra para que quede
      # claro que ya no se usa (y se pueda borrar por SSH cuando se quiera).
      echo "[psicore] migrando los datos de $DATOS_LOCAL a $DATOS"
      cp -a "$DATOS_LOCAL/." "$DATOS/"
      mv "$DATOS_LOCAL" "${DATOS_LOCAL}_migrado_a_solutions" 2>/dev/null || true
    fi
  fi
  echo "[psicore] datos en el almacén de Solutions del ctrlX: $DATOS"
else
  DATOS="$DATOS_LOCAL"
  mkdir -p "$DATOS"
  echo "[psicore] AVISO: la interfaz active-solution no está conectada; los datos van a $DATOS y se PERDERÁN si se desinstala el snap. Conéctala con: snap connect psicore:active-solution rexroth-solutions:active-solution"
fi

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
else
  # Si los datos cambiaron de carpeta (migración al almacén de Solutions, o
  # una copia traída de otro ctrlX), la base SQLite «local» sigue apuntando
  # a la ruta vieja. Se reescribe para que apunte al psicore.db de AQUÍ.
  "$SNAP/venv/bin/python" - "$DATOS/conexiones.json" "$DATOS" <<'PYRUTA'
import json, os, sys
ruta, datos = sys.argv[1], sys.argv[2]
try:
    lista = json.load(open(ruta, encoding="utf-8"))
except Exception:
    sys.exit(0)
cambiado = False
for c in lista if isinstance(lista, list) else []:
    if not isinstance(c, dict) or c.get("motor") != "sqlite":
        continue
    bd = str(c.get("base_datos") or "")
    if not bd or bd.startswith(datos + os.sep):
        continue
    nueva = os.path.join(datos, os.path.basename(bd))
    if os.path.isfile(nueva):
        c["base_datos"] = nueva
        cambiado = True
        print(f"[psicore] conexión '{c.get('db_id')}': {bd} -> {nueva}")
if cambiado:
    tmp = ruta + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(lista, f, ensure_ascii=False, indent=2)
    os.replace(tmp, ruta)
PYRUTA
fi

# ── 1 · Entorno ────────────────────────────────────────────────────────
export PLC_DATOS_DIR="$DATOS"

# ── 1b · ODBC (SQL Server) ─────────────────────────────────────────────
# El driver de Microsoft y FreeTDS viajan dentro del snap (stage-packages),
# pero unixODBC los busca en /etc/odbcinst.ini, que aquí es de solo lectura
# y no los conoce. Se escribe un odbcinst.ini propio con las rutas reales de
# dentro del snap y se apunta ODBCSYSINI a él. Y como las .so del snap no
# están en las rutas del sistema, LD_LIBRARY_PATH.
case "${SNAP_ARCH:-}" in
  arm64) TRIPLETE="aarch64-linux-gnu" ;;
  amd64) TRIPLETE="x86_64-linux-gnu" ;;
  armhf) TRIPLETE="arm-linux-gnueabihf" ;;
  *)     TRIPLETE="$(uname -m)-linux-gnu" ;;
esac
export LD_LIBRARY_PATH="$SNAP/usr/lib/$TRIPLETE:$SNAP/lib/$TRIPLETE:$SNAP/usr/lib:$SNAP/lib:$SNAP/opt/microsoft/msodbcsql18/lib64${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
ODBC_DIR="$SNAP_COMMON/odbc"
mkdir -p "$ODBC_DIR"
: > "$ODBC_DIR/odbcinst.ini"
MS_SO="$(ls "$SNAP"/opt/microsoft/msodbcsql18/lib64/libmsodbcsql-18*.so* 2>/dev/null | head -n 1 || true)"
if [ -n "$MS_SO" ]; then
  cat >> "$ODBC_DIR/odbcinst.ini" <<INI
[ODBC Driver 18 for SQL Server]
Description=Microsoft ODBC Driver 18 for SQL Server
Driver=$MS_SO
UsageCount=1

INI
  echo "[psicore] ODBC: Microsoft ODBC Driver 18 for SQL Server ($MS_SO)"
else
  echo "[psicore] AVISO: el snap no trae msodbcsql18; SQL Server solo por FreeTDS si está."
fi
TDS_SO="$(ls "$SNAP"/usr/lib/"$TRIPLETE"/odbc/libtdsodbc.so* 2>/dev/null | head -n 1 || true)"
if [ -n "$TDS_SO" ]; then
  cat >> "$ODBC_DIR/odbcinst.ini" <<INI
[FreeTDS SQL Server]
Description=FreeTDS (alternativa al driver de Microsoft)
Driver=$TDS_SO
UsageCount=1

INI
  echo "[psicore] ODBC: FreeTDS SQL Server ($TDS_SO)"
fi
# odbc.ini vacío: no se usan DSN, la app monta la cadena de conexión entera.
[ -f "$ODBC_DIR/odbc.ini" ] || : > "$ODBC_DIR/odbc.ini"
export ODBCSYSINI="$ODBC_DIR"
export ODBCINI="$ODBC_DIR/odbc.ini"
export PLC_API_HOST="${PLC_API_HOST:-0.0.0.0}"
export PLC_API_PORT="${PLC_API_PORT:-8010}"
# Las cuentas viven en la base SQLite local (db_id "local" en conexiones.json);
# fijarlo evita el aviso «no hay PLC_AUTH_DB_ID» y que cambie al añadir otra base.
export PLC_AUTH_DB_ID="${PLC_AUTH_DB_ID:-local}"
# El ctrlX no tiene pantalla: nadie entra por 127.0.0.1. Con «auto», los PCs
# de la misma LAN que el ctrlX cuentan como «equipo servidor» (primera cuenta,
# configurar la base, restaurar datos). Para una lista fija: 192.168.17.0/24
export PLC_REDES_SERVIDOR="${PLC_REDES_SERVIDOR:-auto}"
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
