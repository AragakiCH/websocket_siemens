# Backend OPC UA → WebSocket (Siemens S7-1500)

Servicio backend en Python que se conecta a un PLC Siemens S7-1500 vía **OPC UA**,
**descubre automáticamente** los tags de los Data Blocks (browse recursivo) y
transmite sus valores en **tiempo real** a clientes vía **WebSocket**, usando
**subscriptions OPC UA** (MonitoredItems) — sin polling.

La arquitectura está diseñada para escalar: un driver abstracto (`PlcDriver`)
permite añadir otros PLCs/protocolos en el futuro sin refactorizar el resto.

---

## Características

- **Descubrimiento dinámico de PLCs**: escanea la subred en el puerto OPC UA (4840)
  y valida cada servidor con `FindServers`. También admite endpoints manuales si ya
  conoces la IP.
- **Multi-PLC en simultáneo**: un driver + handler independiente por cada PLC. Los
  tags se etiquetan con su PLC de origen; un PLC caído no afecta a los demás.
- **Auto-descubrimiento** de tags navegando `DataBlocksGlobal` (sin configurar tags a mano).
- **Tiempo real** mediante subscriptions OPC UA; el servidor notifica los cambios.
- **Reconexión automática** con backoff exponencial y recreación de subscriptions.
- **FastAPI + WebSocket** con broadcast a todos los clientes y snapshot inicial.
- **Endpoints REST**: `/health`, `/tags`, `/browse`.
- **Cliente de prueba** (`test_client.html`) en JS vanilla con tabla en vivo (columna PLC).
- **Manejo de errores robusto**: un tag que falla no tumba el servicio.
- **Configuración por entorno / `settings.py`** (nada hardcodeado).

---

## Estructura del proyecto

```
/app
  /drivers
    plc_driver.py         # Interfaz abstracta (ABC) PlcDriver + dataclasses TagInfo/TagValue
    opcua_driver.py       # Implementación OPC UA con asyncua (browse + subscriptions)
  /core
    connection_manager.py # Gestión de clientes WebSocket + broadcast
    subscription_handler.py # Orquestador por-PLC: conexión, reconexión, snapshot, WS
    plc_discovery.py      # Descubrimiento: escaneo de subred + validación OPC UA
    plc_manager.py        # Gestor MULTI-PLC: 1 driver/handler por PLC + agregación
  /config
    settings.py           # Configuración (env vars / .env)
    tags_filter.yaml      # Filtro opcional de Data Blocks (default: todos)
  /api
    websocket_routes.py   # Endpoint /ws
    rest_routes.py        # Endpoints /health, /tags, /browse
  main.py                 # App FastAPI + lifespan (startup/shutdown)
requirements.txt
test_client.html          # Cliente WebSocket de prueba (tabla en vivo)
```

---

## Requisitos

- **Python 3.11** (funciona también en 3.10).
- PLC / S7-PLCSIM Advanced con servidor OPC UA activo en
  `opc.tcp://192.168.50.1:4840` (No security + acceso anónimo).

---

## Instalación y arranque

### 1) Activar el entorno virtual (venv) en Windows

```powershell
# Crear el venv (si no existe)
python -m venv venv

# Activar (PowerShell)
.\venv\Scripts\Activate.ps1

# o en CMD:
venv\Scripts\activate.bat
```

### 2) Instalar dependencias

```powershell
pip install -r requirements.txt
```

### 3) Arrancar el servidor

```powershell
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

### 4) Abrir el cliente de prueba

Abrir en el navegador: **http://localhost:8000/**

La página sirve `test_client.html`, que se conecta al WebSocket `/ws` y muestra
una tabla con **nombre | valor | tipo | timestamp** actualizándose en vivo, con
indicador de estado de conexión.

---

## Endpoints

| Método | Ruta            | Descripción                                                        |
|--------|-----------------|--------------------------------------------------------------------|
| WS     | `/ws`           | Stream de cambios. `?plc=<id>` para recibir solo ese PLC.          |
| GET    | `/health`       | Estado de cada PLC, intervalos, nº de tags y clientes WS.          |
| GET    | `/plcs`         | Lista de ids de PLC gestionados (para elegir cuál ver).           |
| GET    | `/tags`         | Tags con su último valor. `?plc=<id>` para filtrar por un PLC.     |
| GET    | `/browse`       | Árbol de tags por PLC y Data Block. `?plc=<id>` para filtrar.      |
| GET    | `/`             | Sirve el cliente de prueba `test_client.html`.                     |

### Elegir qué PLC ver

- **Cliente HTML**: hay un desplegable "Ver PLC" que reconecta el WebSocket al PLC
  elegido (o "Todos").
- **WebSocket**: conéctate a `/ws?plc=PLC_2` para recibir solo ese PLC.
- **REST**: `GET /tags?plc=PLC_2`, `GET /browse?plc=PLC_2`. `GET /plcs` lista los ids.
- **Backend (whitelist)**: `PLC_INCLUDE_PLCS=PLC_2,192.168.50.3` conecta solo a esos.

### Formato de mensajes WebSocket

**Snapshot inicial** (al conectar un cliente nuevo). Las claves de `tags` son
`"<plc>|<tag>"` para no colisionar entre PLCs; `plcs` resume el estado de cada uno:

```json
{
  "timestamp": "2026-07-09T12:00:00+00:00",
  "type": "snapshot",
  "plcs": {
    "PLC_2": { "nombre": "PLC_2", "endpoint": "opc.tcp://192.168.50.1:4840",
               "estado": "conectado", "conectado": true,
               "sampling_interval_ms": 1000, "publishing_interval_ms": 500 }
  },
  "tags": {
    "PLC_2|DB_snap7.temperatura": {
      "plc": "PLC_2", "tag": "DB_snap7.temperatura", "value": 23.5, "type": "Float",
      "timestamp": "...", "source_ts": "...", "server_ts": "...", "delta_ms": null }
  }
}
```

**Cambio individual** (broadcast en tiempo real, con tiempos):

```json
{
  "timestamp": "2026-07-09T12:00:01.240+00:00",   // recepción en el backend
  "plc": "PLC_2",
  "tag": "DB_snap7.temperatura",
  "value": 24.1,
  "type": "Float",
  "source_ts": "2026-07-09T12:00:01.180+00:00",   // cuándo cambió en el PLC
  "server_ts": "2026-07-09T12:00:01.181+00:00",   // marca del servidor OPC UA
  "delta_ms": 601.4                                // ms desde el cambio anterior de ese tag
}
```

**Sobre los tiempos:**
- `source_ts` es el `SourceTimestamp` de OPC UA: el momento real en que el valor
  cambió en el PLC (lo más preciso para "cuándo fue el cambio").
- `delta_ms` es el intervalo real observado entre este cambio y el anterior de ese
  mismo tag. Es `null` en el primer valor.
- Los intervalos *configurados* (`sampling_interval_ms` = cada cuánto el servidor
  muestrea, `publishing_interval_ms` = cada cuánto publica lotes) aparecen por PLC en
  el snapshot y en `/health`.

**Estado de un PLC** (conexión/reconexión):

```json
{ "timestamp": "...", "type": "status", "plc": "PLC_2", "status": "reconectando" }
```

---

## Configuración

Todos los parámetros se leen desde variables de entorno (prefijo `PLC_`) o un
archivo `.env` en la raíz. Valores por defecto en `app/config/settings.py`.

| Variable                       | Default                            | Descripción                                   |
|--------------------------------|------------------------------------|-----------------------------------------------|
| `PLC_OPCUA_ENDPOINT`           | `opc.tcp://192.168.50.1:4840`      | Endpoint OPC UA del PLC.                       |
| `PLC_OPCUA_NAMESPACE_URI`      | `http://www.siemens.com/simatic-s7-opcua` | Namespace de datos de usuario (ns=3).  |
| `PLC_PUBLISHING_INTERVAL_MS`   | `500`                              | Intervalo de publicación de la subscription.  |
| `PLC_SAMPLING_INTERVAL_MS`     | `1000`                             | Muestreo por MonitoredItem (mín. S7 = 1000ms).|
| `PLC_RECONNECT_INITIAL_DELAY`  | `2.0`                              | Retardo inicial de reconexión (s).            |
| `PLC_RECONNECT_MAX_DELAY`      | `30.0`                             | Retardo máximo de backoff (s).                |
| `PLC_HEALTHCHECK_INTERVAL`     | `5.0`                              | Periodo del watchdog de conexión (s).         |
| `PLC_TAGS_FILTER_DBS`          | *(vacío = todos)*                  | Lista de DBs a incluir, separada por comas.   |
| `PLC_STATIC_ENDPOINTS`         | *(vacío)*                          | Endpoints fijos si ya sabes la IP, separados por comas. |
| `PLC_DISCOVERY_ENABLED`        | `true`                             | Escanear la subred buscando PLCs.             |
| `PLC_DISCOVERY_SUBNET`         | *(deriva del endpoint)*            | Subred CIDR a escanear (ej. `192.168.50.0/24`). |
| `PLC_DISCOVERY_PORT`           | `4840`                             | Puerto OPC UA a sondear.                       |
| `PLC_DISCOVERY_TCP_TIMEOUT`    | `0.8`                              | Timeout del sondeo TCP por host (s).          |
| `PLC_DISCOVERY_OPCUA_TIMEOUT`  | `4.0`                              | Timeout de validación OPC UA por host (s).    |
| `PLC_DISCOVERY_CONCURRENCY`    | `64`                               | Hosts sondeados en paralelo.                   |
| `PLC_DISCOVERY_INTERVAL`       | `0`                                | Re-escaneo periódico (s). 0 = solo al arrancar.|
| `PLC_INCLUDE_PLCS`             | *(vacío = todos)*                  | Lista blanca de PLCs (id/nombre/host), separada por comas. |
| `PLC_SAMPLING_INTERVAL_MS`     | `1000`                             | Cada cuánto el servidor muestrea cada tag (mín. S7 = 1000). |
| `PLC_PUBLISHING_INTERVAL_MS`   | `500`                              | Cada cuánto el servidor publica lotes de cambios. |
| `PLC_API_PORT`                 | `8000`                             | Puerto del servidor.                           |
| `PLC_LOG_LEVEL`                | `INFO`                             | Nivel de logging.                              |

**Filtro de Data Blocks:** por defecto se descubren *todos*. Para limitar, define
`PLC_TAGS_FILTER_DBS=DB_snap7,DB_produccion` o edita `app/config/tags_filter.yaml`.

### Descubrimiento de PLCs y modo multi-PLC

Al arrancar, el servicio construye la lista de PLCs combinando:

1. Los **endpoints fijos** de `PLC_STATIC_ENDPOINTS` (y el `PLC_OPCUA_ENDPOINT` clásico).
2. Los PLCs hallados por **escaneo de la subred** (si `PLC_DISCOVERY_ENABLED=true`):
   sondea el puerto 4840 en cada host y valida con OPC UA `FindServers`.

Por cada PLC se crea un driver + supervisor independiente. Los mensajes y el
snapshot etiquetan cada tag con su `plc` (id derivado del nombre de aplicación o
la IP), con claves `"<plc>|<tag>"` para evitar colisiones. Si un PLC se cae, los
demás siguen transmitiendo; el caído se reintenta con backoff por separado.

- **Solo IPs que ya conoces** (sin escanear): `PLC_DISCOVERY_ENABLED=false` y
  `PLC_STATIC_ENDPOINTS=opc.tcp://192.168.50.1:4840,opc.tcp://192.168.50.2:4840`.
- **Detectar PLCs nuevos en caliente**: `PLC_DISCOVERY_INTERVAL=60` re-escanea cada 60s.

Ejemplo de `.env` (escaneo automático + un PLC forzado):

```env
PLC_DISCOVERY_ENABLED=true
PLC_DISCOVERY_SUBNET=192.168.50.0/24
PLC_STATIC_ENDPOINTS=opc.tcp://192.168.50.1:4840
PLC_PUBLISHING_INTERVAL_MS=500
PLC_LOG_LEVEL=INFO
```

**Nota:** TIA Portal no publica las IPs de los PLCs por red; el descubrimiento se
hace sondeando servidores OPC UA reales, no leyendo el proyecto TIA.

---

## Seguridad (hoy y a futuro)

El entorno de pruebas usa **No security + anónimo**. El driver ya incluye el
*hook* para activar seguridad con certificados sin refactor: basta definir en
settings/`.env`:

```env
PLC_SECURITY_POLICY=Basic256Sha256
PLC_SECURITY_MODE=SignAndEncrypt
PLC_CLIENT_CERT_PATH=/ruta/cert.der
PLC_CLIENT_PRIVATE_KEY_PATH=/ruta/key.pem
PLC_SERVER_CERT_PATH=/ruta/server_cert.der
```

También soporta usuario/contraseña con `PLC_OPCUA_USERNAME` / `PLC_OPCUA_PASSWORD`.

---

## Extender a otros PLCs / protocolos

Para añadir soporte, por ejemplo, a Modbus o S7 nativo:

1. Crear `app/drivers/modbus_driver.py` con una clase que herede de `PlcDriver`
   e implemente `connect`, `disconnect`, `browse_tags`, `subscribe`,
   `read_tag`, `is_connected`.
2. Cambiar la construcción del driver en `app/main.py` (o hacerla seleccionable
   por configuración). El resto del sistema (core + API + cliente) no cambia.

---

## Notas técnicas

- Todo el pipeline OPC UA es **async/await** (librería `asyncua`).
- Las notificaciones llegan por `datachange_notification`; **no hay polling**.
- El servidor S7-1500 soporta hasta 15 sesiones, 750 subscriptions y un sampling
  mínimo de 1000 ms — la configuración por defecto respeta esos límites.
- El servicio arranca aunque el PLC no esté disponible: el supervisor reintentará
  conectarse en segundo plano con backoff exponencial.

---

## 🚀 Instalación y ejecución (guía rápida)

### Requisitos

| Herramienta | Versión | Para qué |
|---|---|---|
| Python | 3.10 – 3.11 | Backend FastAPI + OPC UA |
| Node.js | 18+ | Compilar el frontend React (solo si vas a tocar la vista) |
| Git | — | Clonar el repositorio |

### 1. Clonar y preparar el backend

```bash
git clone https://github.com/<tu-usuario>/websocket_siemens.git
cd websocket_siemens

# Entorno virtual
python -m venv venv
venv\Scripts\activate        # Windows
# source venv/bin/activate   # Linux/Mac

pip install -r requirements.txt

# Configuración: copiar la plantilla y ajustar a tu red
copy .env.example .env       # Windows  (cp en Linux/Mac)
```

### 2. Compilar el frontend React

```bash
cd frontend
npm install
npm run build     # genera frontend/dist (lo sirve FastAPI)
cd ..
```

### 3. Correr el servidor

```bash
python desktop\servidor.py
# o equivalente: uvicorn app.main:app --host 0.0.0.0 --port 8000
```

Abrir **http://localhost:8000** → vista web para agregar PLCs por IP o
escanear la red. Documentación interactiva de la API en **http://localhost:8000/docs**.

### Modo desarrollo (hot-reload de la vista)

```bash
# Terminal 1: backend
uvicorn app.main:app --reload --port 8000

# Terminal 2: frontend con Vite
cd frontend && npm run dev
```

Abrir http://localhost:5173 (el proxy redirige `/ws` y los REST al 8000).

### Generar los ejecutables de escritorio (Windows)

```bash
desktop\build_exe.bat
```

Produce en `dist/`:

- `MonitorS7_Servidor.exe` — backend + vista, para UNA máquina (junto a su `.env`).
- `VisorS7.exe` — visor liviano para cada escritorio; al primer arranque crea
  `visor_config.ini` donde se pone la IP del servidor.

Abrir el puerto 8000 en el firewall de la máquina servidor:

```bash
netsh advfirewall firewall add rule name="MonitorS7" dir=in action=allow protocol=TCP localport=8000
```

### Requisitos del lado del PLC (TIA Portal)

- Servidor OPC UA **activado** en las propiedades de la CPU.
- Política de seguridad que permita la conexión (None, o configurar credenciales).
- Licencia runtime OPC UA seleccionada en las propiedades.
