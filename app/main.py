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

import asyncio
import logging
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from app.api import (ai_routes, alarm_routes, auth_routes, crud_routes,
                     db_routes, export_routes, historian_routes, lock_routes,
                     project_routes, rest_routes, sistema_routes,
                     tema_routes,
                     websocket_routes, widget_routes)
from app.config.settings import get_settings
from app.core.alarm_engine import MotorAlarmas
from app.core.connection_manager import ConnectionManager
from app.core.crud_manager import CrudManager
from app.core.db_manager import DbManager
from app.db.historian import Historizador
from app.db.widget_store import WidgetStore
from app.export.grabador import Grabador
from app.ai.agent import Agente
from app.core.auditoria import Auditoria
from app.core.auth_manager import AuthManager
from app.core.lock_manager import LockManager
from app.core.plc_manager import PlcManager
from app.db.project_store import ProjectStore
from app.db.tema_store import TemaStore


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
    crud_manager = CrudManager(db_manager, settings)
    # Widgets personalizados: la definición vive en el servidor, no en
    # el localStorage del navegador (ver app/db/widget_store.py).
    widget_store = WidgetStore()
    # El historizador escucha el MISMO flujo de tags que el WebSocket:
    # no abre una segunda sesión OPC UA ni añade carga al PLC.
    historizador = Historizador(db_manager, db_manager.store)
    # El grabador comparte el mismo flujo de tags: mantiene en memoria el
    # último valor de cada uno y lo muestrea a intervalo fijo.
    grabador = Grabador(plc_manager)
    # MULTIUSUARIO -------------------------------------------------- #
    # El diseño del HMI vive AQUÍ, no en el localStorage de cada
    # navegador: es lo único que permite que dos personas vean la misma
    # pantalla. Va versionado para detectar escrituras simultáneas.
    project_store = ProjectStore()
    # El ASPECTO del HMI —paleta y tipografías— también es del servidor y no
    # del navegador, por el mismo motivo que el diseño: si cada máquina se
    # guardara su tema, dos paneles de la misma línea acabarían con colores
    # distintos y el rojo de alarma dejaría de significar lo mismo en todas.
    tema_store = TemaStore()
    # Identidad: las cuentas están en la tabla SQL `usuarios`, así que
    # este gestor necesita el DbManager para llegar a ellas.
    auth_manager = AuthManager(db_manager, settings)
    # Fase 4: 'el lápiz'. Un solo usuario edita; el resto ve en vivo en
    # modo lectura. Caduca solo a los 30 s sin heartbeat, así que un
    # navegador cerrado no deja la pantalla bloqueada para siempre.
    lock_manager = LockManager(manager)
    # Quién hizo qué. Escribe en un hilo aparte: auditar nunca debe
    # retrasar la operación auditada.
    auditoria = Auditoria()

    # Guardar en el estado de la app para que los routers accedan a ellos.
    app.state.settings = settings
    app.state.manager = manager
    app.state.plc_manager = plc_manager
    app.state.db_manager = db_manager
    app.state.crud_manager = crud_manager
    app.state.widget_store = widget_store
    app.state.historizador = historizador
    app.state.grabador = grabador
    app.state.project_store = project_store
    app.state.tema_store = tema_store
    app.state.auth_manager = auth_manager
    app.state.lock_manager = lock_manager
    app.state.auditoria = auditoria

    logger.info("=== Iniciando servicio OPC UA -> WebSocket (multi-PLC) ===")
    logger.info("Endpoint semilla: %s | discovery=%s | subred=%s",
                settings.opcua_endpoint, settings.discovery_enabled,
                settings.resolve_subnet())
    # El descubrimiento + supervisores corren en segundo plano: la API arranca
    # aunque ningún PLC esté disponible todavía.
    auditoria.start()
    auditoria.registrar("servicio.arranque", "", "",
                        {"auth_requerida": settings.auth_requerida})

    # Barrido de bloqueos abandonados. Hace falta un barrido ACTIVO: si
    # nadie consulta el lock, los demás clientes no se enterarían de que
    # quedó libre y seguirían en modo lectura sin motivo.
    async def _barrer_locks():
        while True:
            await asyncio.sleep(5)
            try:
                await lock_manager.barrer_caducados()
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001
                logger.warning("Error barriendo bloqueos: %s", exc)

    tarea_locks = asyncio.create_task(_barrer_locks())

    await plc_manager.start()
    # Conexiones a BD guardadas: se abren en paralelo. Una BD caída no impide
    # arrancar el servicio (el widget mostrará el error y podrá reintentar).
    await db_manager.start()
    await historizador.start(manager)
    await grabador.start(manager)

    # Motor de alarmas. DESPUÉS de `db_manager.start()`: lo primero que hace
    # es leer las reglas de `alarmas_def`, y sin los pools abiertos arrancaría
    # siempre con cero reglas.
    #
    # Va detrás del historizador a propósito. Los dos escuchan el mismo flujo
    # y los observadores se llaman en orden de registro: así una muestra queda
    # encolada para el histórico ANTES de que su alarma se evalúe, y el valor
    # que disparó la alarma está garantizado en el histórico. Al revés podría
    # existir un evento cuyo valor no aparece en la curva, que es justo lo
    # primero que se va a mirar al investigarlo.
    if settings.alarmas_enabled:
        motor_alarmas = MotorAlarmas(crud_manager, settings)
        app.state.motor_alarmas = motor_alarmas
        await motor_alarmas.start(manager)
    else:
        motor_alarmas = None
        app.state.motor_alarmas = None
        logger.info("Motor de alarmas desactivado (PLC_ALARMAS_ENABLED=false).")

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
        tarea_locks.cancel()
        auditoria.registrar("servicio.parada")
        auditoria.stop()
        await plc_manager.stop()
        # Orden importante: primero el historizador (vuelca su buffer
        # pendiente), y solo después se cierran los pools de la BD.
        await grabador.stop()
        # El motor antes que la BD, por lo mismo: en su cola pueden quedar
        # eventos de los últimos milisegundos, y son precisamente los del
        # momento del apagado.
        if motor_alarmas is not None:
            await motor_alarmas.stop()
        await historizador.stop()
        await db_manager.stop()


def _version_del_proyecto() -> str:
    """
    Versión del proyecto, leída del fichero `VERSION` de la raíz.

    Es la MISMA fuente que usa el instalador (`build_exe.bat` se la pasa a
    Inno Setup). Si cada uno llevara su número escrito a mano, tarde o
    temprano se descuadrarían y la detección de "¿esto es una
    actualización?" del instalador compararía contra un número falso.
    """
    import os
    import sys

    base = getattr(sys, "_MEIPASS", None) or os.path.dirname(
        os.path.dirname(os.path.abspath(__file__)))
    try:
        with open(os.path.join(base, "VERSION"), encoding="utf-8") as f:
            return f.read().strip() or "0.0.0"
    except OSError:
        return "0.0.0"


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
    version=_version_del_proyecto(),
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
app.include_router(auth_routes.router)
app.include_router(project_routes.router)
# Paleta y tipografías del proyecto (el Gestor de Temas).
app.include_router(tema_routes.router)
app.include_router(lock_routes.router)
app.include_router(rest_routes.router, tags=["REST"])
app.include_router(websocket_routes.router, tags=["WebSocket"])
app.include_router(db_routes.router)
app.include_router(crud_routes.router)
app.include_router(widget_routes.router)
app.include_router(historian_routes.router)
app.include_router(alarm_routes.router)
app.include_router(export_routes.router)
app.include_router(ai_routes.router)
app.include_router(sistema_routes.router)

# ------------------------------------------------------------------ #
# Frontend React (frontend/dist generado con `npm run build`).
# Si existe el build, se sirve como app de producción en "/".
# En desarrollo, usar `npm run dev` (Vite, puerto 5173) con proxy.
# ------------------------------------------------------------------ #
_RAIZ_PROYECTO = os.path.dirname(os.path.dirname(__file__))
_FRONTEND_DIST = os.path.join(_RAIZ_PROYECTO, "frontend", "dist")

# Extensiones que identifican un ARCHIVO y no una ruta de React Router.
# Se usan para decidir si una petición fallida merece un 404 honesto.
_EXT_ESTATICAS = (
    ".js", ".mjs", ".css", ".map", ".json", ".webmanifest",
    ".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".ico", ".avif",
    ".woff", ".woff2", ".ttf", ".otf", ".eot",
)


@app.middleware("http")
async def _cabeceras_de_cache(request, call_next):
    """
    Decide qué puede guardar el navegador y qué no.

    ESTO ARREGLA UN FALLO MUY DESCONCERTANTE. Sin cabeceras de caché,
    Chromium —y WebView2, que es Chromium— aplica *caché heurística*: si una
    respuesta trae `Last-Modified` y ningún `Cache-Control`, se la guarda y
    la da por fresca durante un 10% del tiempo transcurrido desde esa fecha.
    Para un `index.html` con fecha de hace un mes, eso son tres días.

    El `index.html` es justo el archivo que NO se puede cachear, porque es el
    que dice qué bundle cargar (`/assets/index-<hash>.js`). Cacheado, la
    aplicación de escritorio arrancaba unas veces con la versión nueva y
    otras con la anterior, según le tocara revalidar o no. Y sobrevivía a la
    reinstalación, porque el perfil de WebView2 vive en
    `datos\navegador`, dentro de la carpeta que el instalador conserva a
    propósito. Actualizar de verdad y seguir viendo lo viejo, alternando.

    Los `/assets/` son el caso contrario: Vite les pone un hash del contenido
    en el nombre, así que un archivo con ese nombre NUNCA cambia. Se marcan
    `immutable` y un año de vida — la nueva versión trae nombres nuevos, y
    los viejos simplemente dejan de pedirse.
    """
    respuesta = await call_next(request)
    if request.url.path.startswith("/assets/"):
        respuesta.headers["Cache-Control"] = "public, max-age=31536000, immutable"
    else:
        respuesta.headers["Cache-Control"] = "no-store, must-revalidate"
    return respuesta

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


def _archivo_del_build(ruta: str) -> str:
    """
    Ruta real de un archivo suelto del build, o "" si no lo es.

    **Por qué hace falta.** Vite copia todo lo que hay en `frontend/public/`
    a la RAÍZ de `frontend/dist/`, no dentro de `assets/`: `logo.png`,
    `favicon.svg`, `icons.svg`. Como aquí solo estaba montado `/assets`,
    esos archivos caían en el fallback de la SPA y el servidor respondía
    `index.html` —HTML, con estado 200— a una petición de imagen.

    El síntoma era de los que cuestan una tarde: en `npm run dev` el logo se
    veía (Vite sí sirve `public/` en la raíz) y en el .exe empaquetado
    aparecía el wordmark de respaldo que dibuja `Login.tsx` en su `onError`.
    Todo parecía correcto —el archivo estaba dentro del paquete, el build era
    reciente— porque el fallo no estaba en el empaquetado sino aquí, y no
    daba ningún error: un 200 con el contenido equivocado.

    Se comprueba que el resultado siga dentro de `dist` antes de servirlo.
    La ruta viene de la URL, y sin esa comprobación un `..%2f..%2f` serviría
    cualquier archivo de la máquina.
    """
    if not ruta or ruta.endswith("/"):
        return ""
    base = os.path.normpath(_FRONTEND_DIST)
    candidato = os.path.normpath(os.path.join(base, ruta))
    if candidato != base and not candidato.startswith(base + os.sep):
        return ""                      # intento de salirse de dist
    return candidato if os.path.isfile(candidato) else ""


@app.get("/{ruta_spa:path}", include_in_schema=False)
async def spa_fallback(ruta_spa: str):
    """
    Lo que no es API: primero un archivo del build, y si no, el index.

    Ese orden importa. Las rutas de React Router (/menu, /designer, /config,
    /preview...) no existen como archivo y tienen que devolver `index.html`
    para que el router del navegador resuelva la vista. Pero `/logo.png` SÍ
    existe, y devolverle el index sería mentirle al navegador.

    Se registra al FINAL, así que /health, /plcs, /ws, /docs, /assets y todo
    lo demás tienen prioridad.
    """
    archivo = _archivo_del_build(ruta_spa)
    if archivo:
        return FileResponse(archivo)

    # Un archivo que se pide y no está tiene que responder 404, NO el index.
    #
    # Devolverle `index.html` a una petición de `/assets/index-VIEJO.js` es
    # lo que convierte "falta un archivo" en "pantalla en blanco": el
    # navegador recibe HTML donde esperaba JavaScript, el `<script type=
    # "module">` revienta al analizarlo y no queda ni un error que explique
    # por qué. Con un 404 el fallo se ve en la pestaña de red a la primera.
    # Una ruta con `..` no la genera React Router jamás. `_archivo_del_build`
    # ya impide servir nada de fuera de `dist`, así que no es un agujero;
    # pero devolverle el index a un intento de traversal es fingir que la
    # petición era normal. Se responde 404, que es lo que era.
    if (ruta_spa.startswith("assets/")
            or ".." in ruta_spa.replace("\\", "/").split("/")
            or ruta_spa.lower().endswith(_EXT_ESTATICAS)):
        return JSONResponse(
            {"error": f"'{ruta_spa}' no existe en este build del frontend. "
                      f"Si el navegador lo pide, está usando un index.html "
                      f"cacheado de una versión anterior: recarga forzando "
                      f"(Ctrl+F5) o borra la caché."},
            status_code=404,
        )

    index_react = os.path.join(_FRONTEND_DIST, "index.html")
    if os.path.isfile(index_react):
        return FileResponse(index_react)
    return JSONResponse({"error": "ruta no encontrada"}, status_code=404)
