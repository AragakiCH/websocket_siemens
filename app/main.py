# -*- coding: utf-8 -*-
"""
main.py
=======
Punto de entrada de la aplicación FastAPI.

Responsabilidades:
  * Configurar logging.
  * Construir el driver OPC UA, el ConnectionManager y el SubscriptionHandler.
  * Arrancar el supervisor de conexión al iniciar (lifespan startup) y cerrarlo
    limpiamente al apagar (lifespan shutdown).
  * Registrar los routers REST y WebSocket.
  * Servir el frontend React (frontend/dist) o el cliente de prueba en "/".

Arrancar con:
    uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
"""
from __future__ import annotations

import logging
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from app.api import (ai_routes, db_routes, export_routes,
                     historian_routes, rest_routes, websocket_routes)
from app.config.settings import get_settings
from app.core.connection_manager import ConnectionManager
from app.core.db_manager import DbManager
from app.db.historian import Historizador
from app.export.grabador import Grabador
from app.ai.agent import Agente
from app.core.plc_manager import PlcManager


def _configurar_logging(nivel: str) -> None:
    """
    Configura el logging estándar en español.

    Las librerías OPC UA (`asyncua`) son MUY verbosas en INFO: imprimen cada
    PublishResult, es decir varias líneas por segundo y por PLC, que tapan por
    completo los mensajes del servicio. Se suben a WARNING salvo que se pida
    DEBUG explícitamente (PLC_LOG_LEVEL=DEBUG).
    """
    logging.basicConfig(
        level=getattr(logging, nivel.upper(), logging.INFO),
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )

    nivel_libs = logging.DEBUG if nivel.upper() == "DEBUG" else logging.WARNING
    for nombre in ("asyncua", "asyncua.client", "asyncua.common.subscription",
                   "asyncua.client.ua_client", "asyncua.uaprotocol"):
        logging.getLogger(nombre).setLevel(nivel_libs)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """
    Ciclo de vida de la aplicación.
    startup: crea componentes y arranca el supervisor de conexión al PLC.
    shutdown: detiene el supervisor y cierra subscriptions y sesión OPC UA.
    """
    settings = get_settings()
    _configurar_logging(settings.log_level)
    logger = logging.getLogger("main")

    # Construcción de componentes (inyección de dependencias sencilla).
    manager = ConnectionManager()
    plc_manager = PlcManager(manager, settings)
    db_manager = DbManager()
    # El historizador escucha el MISMO flujo de tags que el WebSocket:
    # no abre una segunda sesión OPC UA ni añade carga al PLC.
    historizador = Historizador(db_manager, db_manager.store)
    # El grabador comparte el mismo flujo de tags: mantiene en memoria el
    # último valor de cada uno y lo muestrea a intervalo fijo.
    grabador = Grabador(plc_manager)

    # Guardar en el estado de la app para que los routers accedan a ellos.
    app.state.settings = settings
    app.state.manager = manager
    app.state.plc_manager = plc_manager
    app.state.db_manager = db_manager
    app.state.historizador = historizador
    app.state.grabador = grabador

    logger.info("=== Iniciando servicio OPC UA -> WebSocket (multi-PLC) ===")
    logger.info("Endpoint semilla: %s | discovery=%s | subred=%s",
                settings.opcua_endpoint, settings.discovery_enabled,
                settings.resolve_subnet())
    # El descubrimiento + supervisores corren en segundo plano: la API arranca
    # aunque ningún PLC esté disponible todavía.
    await plc_manager.start()
    # Conexiones a BD guardadas: se abren en paralelo. Una BD caída no impide
    # arrancar el servicio (el widget mostrará el error y podrá reintentar).
    await db_manager.start()
    await historizador.start(manager)
    await grabador.start(manager)

    # El asistente de IA se monta al final: su catálogo de herramientas se
    # deriva del OpenAPI, y el RAG lee el estado del resto de componentes.
    if settings.ai_enabled:
        agente = Agente(app, settings)
        app.state.agente = agente
        agente.iniciar()
    else:
        app.state.agente = None
        logger.info("Asistente de IA desactivado (PLC_AI_ENABLED=false).")

    try:
        yield
    finally:
        logger.info("=== Apagando servicio: cierre limpio ===")
        await plc_manager.stop()
        # Orden importante: primero el historizador (vuelca su buffer
        # pendiente), y solo después se cierran los pools de la BD.
        await grabador.stop()
        await historizador.stop()
        await db_manager.stop()


_DESCRIPCION_API = """
Descubre tags de PLCs **Siemens S7-1500** y **Bosch Rexroth ctrlX CORE** por
OPC UA y los transmite en tiempo real vía WebSocket.

---

## Flujo de uso

| Paso | Qué hacer | Endpoint |
|:---:|---|---|
| 1 | Dar de alta el PLC | `POST /plcs` |
| 2 | Escuchar los datos en vivo | `ws://<host>:8000/ws` |
| 3 | Consultar estado y tags | `GET /health` · `GET /tags` |

---

## Alta de un PLC — `POST /plcs`

Un S7-1500 y un ctrlX CORE pueden estar conectados **a la vez**: cada PLC lleva
su propio driver, credenciales y reconexión. La marca se elige con `vendor`.

#### Siemens S7-1500

Conexión anónima, no necesita más campos:

```json
{
  "host": "192.168.50.1",
  "puerto": 4840,
  "vendor": "siemens"
}
```

#### Rexroth ctrlX CORE

Siempre requiere credenciales, aplicación y programa:

```json
{
  "host": "192.168.1.1",
  "puerto": 4840,
  "vendor": "rexroth",
  "usuario": "boschrexroth",
  "password": "boschrexroth",
  "app": "Application",
  "programa": "PLC_PRG"
}
```

Para conocer `app` y `programa` antes del alta, llamar en orden a
`POST /rexroth/apps` y `POST /rexroth/programs`. Abren una sesión temporal y no
registran nada.

**Nota:** la primera vez hay que confiar el certificado del cliente desde la web
del ctrlX (*Settings → Certificates & Keys*), o `/rexroth/apps` devolverá `401`.

---

## WebSocket `/ws`

Canal de **solo lectura**: el cliente nunca envía nada, las acciones van por
REST. Swagger no puede probar WebSockets, así que aquí quedan documentados los
cuatro mensajes que envía el servidor.

Conectarse desde la consola del navegador (F12):

```js
const ws = new WebSocket("ws://localhost:8000/ws");
ws.onmessage = (e) => console.log(JSON.parse(e.data));
```

Para recibir un solo PLC: `ws://localhost:8000/ws?plc=<plc_id>`

### 1 · `snapshot`

Al conectarte, y cada vez que se agrega un PLC:

```json
{
  "type": "snapshot",
  "timestamp": "2026-07-16T04:14:11+00:00",
  "plcs": {
    "PLC_2": {
      "nombre": "PLC_2",
      "endpoint": "opc.tcp://192.168.50.1:4840",
      "estado": "conectado",
      "conectado": true,
      "sampling_interval_ms": 100,
      "publishing_interval_ms": 100
    }
  },
  "tags": {
    "PLC_2|DB_snap7.temperatura": {
      "plc": "PLC_2",
      "tag": "DB_snap7.temperatura",
      "value": 53.09,
      "type": "Float",
      "timestamp": "2026-07-16T04:14:11+00:00",
      "delta_ms": 512
    }
  }
}
```

La clave de `tags` es `"<plc_id>|<tag>"`, para que no colisionen tags con el
mismo nombre en PLCs distintos.

### 2 · Cambio de valor

Llega cada vez que un tag cambia en el PLC:

```json
{
  "timestamp": "2026-07-16T04:14:12+00:00",
  "plc": "PLC_2",
  "tag": "DB_snap7.temperatura",
  "value": 49.36,
  "type": "Float",
  "source_ts": "2026-07-16T04:14:11.900+00:00",
  "server_ts": "2026-07-16T04:14:11.900+00:00",
  "delta_ms": 480
}
```

**Ojo:** aquí `type` es el **tipo de dato** (`Float`, `Boolean`, `String`...),
no el tipo de mensaje. Para distinguirlos: si el mensaje trae `tag`, es un
cambio de valor; si no, es de control.

### 3 · `status`

Cambió el estado de conexión de un PLC (`conectado` o `reconectando`):

```json
{
  "type": "status",
  "plc": "PLC_2",
  "status": "conectado",
  "timestamp": "2026-07-16T04:14:11+00:00"
}
```

### 4 · `plc_removed`

Alguien quitó un PLC desde cualquier cliente. Hay que limpiar ese PLC y sus
tags del estado local:

```json
{
  "type": "plc_removed",
  "plc_removed": "PLC_2",
  "timestamp": "2026-07-16T04:14:11+00:00"
}
```

---

## Bases de datos y historizador

Además de los PLCs, el servicio conecta con bases de datos SQL
(**PostgreSQL**, **MySQL/MariaDB**, **SQL Server**, **SQLite**) para dos cosas:

| Sección en esta página | Para qué |
|---|---|
| **Bases de datos** | Los widgets LEEN datos de una BD (tablas, KPIs, gráficos) |
| **Historizador (PLC → BD)** | GUARDAR los tags de los PLCs para ver su histórico |

**Los widgets nunca mandan SQL**: el diseñador registra la consulta una vez con
`POST /db/queries` y el widget la ejecuta por su `query_id`. Todo el SQL de los
widgets pasa por una validación de solo-lectura.

La **escritura** es un camino aparte y controlado: solo el historizador escribe,
con sentencias que genera el propio backend.

Contrato completo para el frontend: `docs/API_DB.md`.

---

## Exportar a Excel

Los datos de los PLCs se pueden sacar a un `.xlsx` ordenado desde dos fuentes:

| Fuente | Endpoint | Para qué |
|---|---|---|
| **En vivo** | `POST /export/grabaciones` | Muestrea los tags cada N ms durante un periodo (un ensayo, un arranque) |
| **Base de datos** | `GET /export/historico/excel` | Cualquier periodo pasado ya historizado |

Las dos generan el mismo fichero, con cuatro hojas: **Información**
(metadatos), **Datos** (pivotado: una fila por instante, una columna por
variable), **Estadísticas** (mín/máx/media/desviación) y **Tendencia**
(gráfico de líneas).

El muestreo a intervalo fijo es lo que hace que la tabla salga sin huecos:
todas las variables comparten fila.

Contrato completo: `docs/API_EXPORT.md`.

---

## Asistente de IA

Un agente integrado que **entiende el proyecto, consulta el estado real y
ejecuta acciones**. Comparte proceso, herramientas y datos con el resto del
servicio.

- `POST /ai/chat` — preguntar (respuesta completa, con traza y citas).
- `WS /ai/ws` — respuesta en streaming, con aviso de qué herramienta usa.
- `GET /ai/estado?comprobar=true` — verificar API key y modelo.

Tres cosas que conviene saber:

1. **Sus herramientas se derivan de esta misma página.** El agente lee el
   OpenAPI en runtime: cuando añades un endpoint, lo sabe usar sin tocar
   código. Documentar bien un endpoint es enseñárselo al agente.
2. **RAG sobre la documentación del proyecto**, para que responda con lo que
   está escrito y cite fichero y sección.
3. **Por defecto solo lee.** Las acciones que modifican requieren activar
   `PLC_AI_PERMITIR_ESCRITURA`, y algunas (borrar un PLC, crear esquemas)
   están prohibidas siempre.

Configuración en el `.env`: `PLC_AI_API_KEY`, `PLC_AI_MODEL`.
Contrato completo: `docs/API_AI.md`.

---

## Notas

- El refresco mínimo real es **~100 ms** (límite del servidor OPC UA del
  S7-1500, no del backend).
- El backend mantiene **una sola sesión OPC UA por PLC**, sin importar cuántos
  clientes web estén conectados.
- Contrato completo para el frontend: `docs/API.md`.
"""

app = FastAPI(
    title="Backend OPC UA -> WebSocket (Siemens S7-1500)",
    description=_DESCRIPCION_API,
    version="1.1.0",
    lifespan=lifespan,
)

# CORS — necesario para desarrollo con Vite (localhost:5173 → localhost:8000).
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Routers.
app.include_router(rest_routes.router, tags=["REST"])
app.include_router(websocket_routes.router, tags=["WebSocket"])
app.include_router(db_routes.router)
app.include_router(historian_routes.router)
app.include_router(export_routes.router)
app.include_router(ai_routes.router)

# ------------------------------------------------------------------ #
# Frontend React (frontend/dist generado con `npm run build`).
# Si existe el build, se sirve como app de producción en "/".
# En desarrollo, usar `npm run dev` (Vite, puerto 5173) con proxy.
# ------------------------------------------------------------------ #
_RAIZ_PROYECTO = os.path.dirname(os.path.dirname(__file__))
_FRONTEND_DIST = os.path.join(_RAIZ_PROYECTO, "frontend", "dist")

if os.path.isdir(os.path.join(_FRONTEND_DIST, "assets")):
    app.mount(
        "/assets",
        StaticFiles(directory=os.path.join(_FRONTEND_DIST, "assets")),
        name="assets",
    )


@app.get("/", include_in_schema=False)
async def root():
    """Sirve el frontend React compilado; si no existe, el cliente de prueba."""
    index_react = os.path.join(_FRONTEND_DIST, "index.html")
    if os.path.isfile(index_react):
        return FileResponse(index_react)
    html_path = os.path.join(_RAIZ_PROYECTO, "test_client.html")
    if os.path.isfile(html_path):
        return FileResponse(html_path)
    return JSONResponse(
        {"mensaje": "Servicio activo. Endpoints: /health, /tags, /browse, /ws"}
    )


@app.get("/{ruta_spa:path}", include_in_schema=False)
async def spa_fallback(ruta_spa: str):
    """
    Fallback para React Router (SPA): cualquier ruta no-API (/menu, /designer,
    /config, /preview...) devuelve el index.html del frontend para que el
    router del navegador resuelva la vista. Se registra al FINAL, así que
    /health, /plcs, /ws, /docs, /assets, etc. tienen prioridad.
    """
    index_react = os.path.join(_FRONTEND_DIST, "index.html")
    if os.path.isfile(index_react):
        return FileResponse(index_react)
    return JSONResponse({"error": "ruta no encontrada"}, status_code=404)
