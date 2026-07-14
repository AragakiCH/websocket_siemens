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
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from app.api import rest_routes, websocket_routes
from app.config.settings import get_settings
from app.core.connection_manager import ConnectionManager
from app.core.plc_manager import PlcManager


def _configurar_logging(nivel: str) -> None:
    """Configura el logging estándar en español."""
    logging.basicConfig(
        level=getattr(logging, nivel.upper(), logging.INFO),
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )


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

    # Guardar en el estado de la app para que los routers accedan a ellos.
    app.state.settings = settings
    app.state.manager = manager
    app.state.plc_manager = plc_manager

    logger.info("=== Iniciando servicio OPC UA -> WebSocket (multi-PLC) ===")
    logger.info("Endpoint semilla: %s | discovery=%s | subred=%s",
                settings.opcua_endpoint, settings.discovery_enabled,
                settings.resolve_subnet())
    # El descubrimiento + supervisores corren en segundo plano: la API arranca
    # aunque ningún PLC esté disponible todavía.
    await plc_manager.start()

    try:
        yield
    finally:
        logger.info("=== Apagando servicio: cierre limpio ===")
        await plc_manager.stop()


_DESCRIPCION_API = """
Descubre tags de PLCs Siemens S7-1500 por browse OPC UA y los transmite en
tiempo real vía WebSocket.

## Cómo se usa

1. **Agregar PLCs**: `POST /plcs` con la IP, o `POST /discover` para escanear
   la subred. (También desde la vista web en `/`.)
2. **Recibir datos**: conectarse al WebSocket `ws://<host>:8000/ws`
   (o `/ws?plc=<id>` para un solo PLC).
3. **Consultar**: `GET /health`, `/plcs`, `/tags`, `/browse`.

## WebSocket `/ws` — protocolo de mensajes

Swagger no puede probar WebSockets; estos son los mensajes que envía el servidor:

**1. Snapshot** (al conectarte, y cuando se agrega un PLC):
```json
{"type": "snapshot", "timestamp": "2026-07-14T07:30:00+00:00",
 "plcs": {"PLC_2": {"nombre": "PLC_2", "endpoint": "opc.tcp://192.168.50.1:4840",
                     "estado": "conectado", "conectado": true,
                     "sampling_interval_ms": 1000, "publishing_interval_ms": 500}},
 "tags": {"PLC_2|DB_Datos.Temperatura": {"plc": "PLC_2", "tag": "DB_Datos.Temperatura",
           "value": 23.7, "type": "Float", "timestamp": "...", "delta_ms": 512}}}
```

**2. Cambio de valor de un tag** (en tiempo real; aquí `type` es el TIPO DE DATO):
```json
{"timestamp": "2026-07-14T07:30:01+00:00", "plc": "PLC_2",
 "tag": "DB_Datos.Temperatura", "value": 24.1, "type": "Float",
 "source_ts": "2026-07-14T07:30:00.900+00:00", "server_ts": "...", "delta_ms": 480}
```

**3. Estado de conexión de un PLC**:
```json
{"type": "status", "plc": "PLC_2", "status": "conectado",
 "timestamp": "2026-07-14T07:30:00+00:00"}
```
(`status` puede ser `conectado` o `reconectando`)

**4. PLC eliminado**:
```json
{"type": "plc_removed", "plc_removed": "PLC_2",
 "timestamp": "2026-07-14T07:30:00+00:00"}
```

El cliente no necesita enviar nada por el WebSocket: es un canal de solo
lectura (las acciones se hacen por REST).

Probar el WebSocket desde la consola del navegador (F12):
```js
const ws = new WebSocket("ws://localhost:8000/ws");
ws.onmessage = (e) => console.log(JSON.parse(e.data));
```
"""

app = FastAPI(
    title="Backend OPC UA -> WebSocket (Siemens S7-1500)",
    description=_DESCRIPCION_API,
    version="1.1.0",
    lifespan=lifespan,
)

# Routers.
app.include_router(rest_routes.router, tags=["REST"])
app.include_router(websocket_routes.router, tags=["WebSocket"])

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
