# Análisis de arquitectura — `websocket_siemens` (Psi Core / HMI Studio)

Fecha del análisis: 2026-09-07 · Rama `main` con cambios sin commitear (`git status` marca casi todo `app/`, `frontend/` y `docs/` como modificado).
Alcance: lectura del código real de backend (`app/`, ~19.400 líneas Python) y frontend (`frontend/src/`, ~27.000 líneas TS/TSX), no solo de los nombres de archivo.

---

## 1 · Resumen general del proyecto

Es un **HMI/SCADA web completo**, no un demo. Hace cuatro cosas y las hace en el mismo proceso:

1. **Adquisición**: se conecta por OPC UA a N PLCs a la vez (Siemens S7-1500 y Bosch Rexroth ctrlX CORE), descubre sus tags por *browse* y se suscribe a los cambios (sin polling).
2. **Distribución en tiempo real**: reenvía cada cambio de valor a todos los navegadores conectados por un único WebSocket `/ws`.
3. **Persistencia**: historiza tags en SQL (PostgreSQL / MySQL / SQL Server / SQLite), guarda el diseño del HMI, las conexiones, las recetas, las alarmas y la auditoría; exporta a Excel.
4. **Diseño y operación**: un editor visual (Diseñador) donde se arrastran widgets sobre un lienzo, y una vista de operación (Preview) que los pinta con datos en vivo. Multipantalla, multiusuario, con bloqueo de edición y roles.

Encima hay dos capas extra: un **asistente de IA** que deriva sus herramientas del propio OpenAPI, y un **empaquetado de escritorio** (PyInstaller + pywebview) que convierte todo en un `.exe` con ventana nativa.

Tres decisiones de diseño explican casi todo lo demás:

- **Una sola sesión OPC UA por PLC**, independientemente de cuántos navegadores miren. El PLC no paga por cada usuario.
- **El estado compartido vive en el servidor**, no en el `localStorage` del navegador. Es lo que permite que dos personas vean la misma pantalla.
- **Todo el proceso es un único worker de uvicorn**. Sesiones, bloqueos, presencia, grabaciones y buffers viven en memoria del proceso.

---

## 2 · Tecnologías utilizadas

### Backend (`requirements.txt`)

| Pieza | Qué aporta |
|---|---|
| `fastapi 0.115.12` + `uvicorn[standard] 0.34.0` | REST + WebSocket, ASGI, OpenAPI/Swagger en `/docs` |
| `asyncua 1.1.5` | Cliente OPC UA asíncrono (Siemens y Rexroth) |
| `pydantic 2.10.6` + `pydantic-settings 2.8.1` | Modelos de request y configuración por entorno (prefijo `PLC_`) |
| `SQLAlchemy[asyncio] 2.0.51` | Core async: un solo driver para los cuatro motores |
| `aiosqlite`, `aioodbc` (activos) · `asyncpg`, `aiomysql` (comentados) | Drivers por motor. **SQL Server exige además el ODBC Driver 17/18 del sistema** |
| `cryptography` | Fernet para cifrar contraseñas en disco + certificado cliente del ctrlX |
| `openpyxl 3.1.5` | Generación de `.xlsx` con hojas, formato y gráfico de líneas |
| `httpx` | Cliente del LLM y ejecución en proceso de las herramientas del agente |
| `PyYAML`, `python-multipart`, `tzdata` | Filtro de DBs, subida del zip de restauración, zonas horarias en Windows |
| `pywebview 5.3.2`, `pyinstaller 6.11.1` (`requirements-desktop.txt`) | Ventana nativa y empaquetado `.exe` |

### Frontend (`frontend/package.json`)

React 18.3 + TypeScript 5.9 (`strict`) + Vite 5.4 · `react-router-dom` 6.30 · Tailwind 3.4 (`darkMode: 'class'`, paleta `siemens`/`navy`/`state`) · `framer-motion` 11 · `lucide-react` · `jszip` (widgets ZIP) · `oxlint`.

**Sin librería de estado** (nada de Redux/Zustand): un `Context` (`AppStore`) más un par de stores propios fuera de React (`useSyncExternalStore`). **Sin cliente HTTP**: `fetch` envuelto a mano.

### Base de datos

Cuatro motores soportados por el mismo `SqlDriver`. El despliegue actual es **SQL Server** (contenedor `hmi_sql`, base `HMI_PSI`, ver `docs/DESPLIEGUE_HMI_PSI.md`). Los esquemas se generan en `sql/esquema_hmi_{mssql,mysql,postgresql,sqlite}.sql` desde el **mismo generador** que usa el backend (`SqlDriver.ddl_esquema_hmi()`), así que no hay dos copias del DDL.

---

## 3 · Puntos de entrada y cómo se ejecuta cada parte

### Backend

- **Punto de entrada**: `app/main.py` → objeto `app = FastAPI(..., lifespan=lifespan)`.
- **Arranque en desarrollo**: `uvicorn app.main:app --reload --host 0.0.0.0 --port 8000`.
- **Arranque de todo el entorno**: `python tools/dev.py` levanta uvicorn (8000) **y** Vite (5173) en una sola consola, con salida prefijada y Ctrl+C limpio. Se abre `http://localhost:5173`, no el 8000.
- **Producción sin escritorio**: `npm run build` una vez y luego uvicorn; `main.py` monta `frontend/dist/assets` en `/assets` y sirve `index.html` en `/` y en el catch-all SPA.
- **Escritorio**: `desktop/psi_core.py` (backend en un hilo + ventana WebView2, puerto 8000 o el primero libre), `desktop/servidor.py` (solo servidor) y `desktop/visor.py` (solo ventana apuntando a otra máquina, configurada en `visor_config.ini`). Se empaqueta con `desktop/build_exe.bat` + `instalador.iss`.

### Frontend

- **Punto de entrada**: `frontend/index.html` → `src/index.tsx` → `<App/>` (`src/App.tsx`).
- `App.tsx` monta `AppStoreProvider` → `BrowserRouter` → `Routes`. Seis rutas: `/` (Login), `/menu`, `/config`, `/designer`, `/actividad`, `/preview`, y `*` redirige a `/`.
- **Dev**: `npm run dev` (Vite 5173) con proxy hacia el 8000.

### Configuración

| Dónde | Qué |
|---|---|
| `.env` (plantilla en `.env.example`) | Todas las variables con prefijo **`PLC_`**. Se cargan en `app/config/settings.py` (`Settings`, `pydantic-settings`, `@lru_cache` en `get_settings()`) |
| `app/config/tags_filter.yaml` | Lista blanca opcional de Data Blocks a descubrir |
| `frontend/vite.config.js` | Puerto 5173 y **proxy por prefijo** hacia el backend (`BACKEND_PORT` sobreescribible) |
| `app/config/rutas.py` | Dónde vive `datos/`: en desarrollo `<raíz>/datos`; empaquetado, `C:\ProgramData\PsiCore\datos`. Con migración automática desde instalaciones anteriores y `PLC_DATOS_DIR` como override |
| `datos/.clave` | Clave Fernet compartida por `conexiones.json` y `plcs.json`. **Sin ella las contraseñas guardadas no se pueden descifrar** |

Variables que más cambian el comportamiento: `PLC_AUTH_REQUERIDA` (login obligatorio, **por defecto `false`**), `PLC_AUTOSTART_PLCS`, `PLC_DISCOVERY_SUBNET`, `PLC_AUTH_DB_ID`, `PLC_TIMEZONE`, `PLC_AI_ENABLED`, `PLC_AI_PERMITIR_ESCRITURA`.

---

## 4 · Arquitectura del backend

### 4.1 Capas

```
app/
├── main.py            arranque, lifespan, DI manual, routers, estáticos
├── api/               capa HTTP: validación, permisos, auditoría, difusión
├── core/              lógica de dominio en memoria (managers)
├── drivers/           protocolo con el PLC (interfaz + 2 implementaciones)
├── db/                persistencia (interfaz + SqlDriver + stores JSON)
├── export/            grabaciones en vivo y generación de Excel
├── config/            settings y resolución de rutas de datos
└── ai/                agente, herramientas, RAG, cliente LLM
```

La regla es consistente: **`api/` nunca habla con un motor concreto**. Habla con un manager de `core/`, que habla con una interfaz abstracta (`PlcDriver`, `DbDriver`), que tiene implementaciones intercambiables.

### 4.2 Inyección de dependencias

No hay contenedor DI. En `lifespan()` se construyen los once componentes a mano y se cuelgan de `app.state`:

```python
app.state.settings / manager / plc_manager / db_manager / crud_manager
          historizador / grabador / project_store / auth_manager
          lock_manager / auditoria / agente
```

Los routers los recuperan con `request.app.state.<x>`. **Consecuencia**: todo endpoint depende de `app.state`; cambiar un nombre ahí rompe silenciosamente varios routers a la vez.

Orden de arranque (importa): `auditoria.start()` → tarea de barrido de locks (cada 5 s) → `plc_manager.start()` → `db_manager.start()` → `historizador.start(manager)` → `grabador.start(manager)` → `Agente` al final (necesita el OpenAPI ya construido).
Orden de apagado (importa más): cancelar locks → parar auditoría → `plc_manager.stop()` → `grabador.stop()` → **`historizador.stop()` (vuelca su buffer) → `db_manager.stop()`**. Invertir los dos últimos perdería las muestras pendientes.

### 4.3 Cadena de adquisición (por PLC)

```
PlcManager
  └── por cada PLC: SubscriptionHandler
                      ├── driver (OpcUaDriver | RexrothDriver)
                      └── ConnectionManager.broadcast()
```

- **`PlcManager`** (`core/plc_manager.py`): descubre PLCs (`plc_discovery.descubrir_plcs`: sondeo TCP del 4840 sobre la subred + validación OPC UA con `connect_and_get_server_endpoints`), genera un `plc_id` estable (nombre de aplicación saneado, si no el host, con sufijo ante colisión), crea el driver según `vendor`, arranca un handler por PLC y **persiste la lista en `datos/plcs.json`** (contraseñas Rexroth cifradas). Agrega el estado de todos para `/health`, `/tags`, `/browse` y el snapshot del WS.
- **`SubscriptionHandler`** (`core/subscription_handler.py`): es el "cerebro por PLC". Bucle supervisor con **backoff exponencial** (`reconnect_initial_delay` → `reconnect_max_delay`) y **watchdog** cada `healthcheck_interval` que llama a `driver.check_alive()`. Secuencia de conexión: `disconnect` defensivo → `connect` → `browse_tags` → `subscribe` → snapshot inicial leyendo cada tag → broadcast de `status: conectado`. Mantiene en memoria `_snapshot: {full_name → TagValue}`.
- **`OpcUaDriver`** (`drivers/opcua_driver.py`): resuelve el namespace por URI (fallback `ns=3`), navega `Objects → DeviceSet → <PLC> → DataBlocksGlobal` **buscando por BrowseName** (la ruta cruza namespaces), recorre recursivamente, descarta `ByteString/Image`, crea la subscription con `publishing_interval_ms` y `sampling_interval_ms` (con fallback a suscripción uno a uno si la de lote falla), y en cada `datachange_notification` extrae `SourceTimestamp`/`ServerTimestamp` y calcula `delta_ms` respecto al cambio anterior de ese mismo tag.
- **`RexrothDriver`** (822 líneas): ctrlX CORE. Sesión con usuario/contraseña obligatorios y certificado de cliente autogenerado, navegación `Datalayer/plc/app/<app>/sym/<programa>`, autodetección de app y programa, y **fallback automático a polling** si la subscription no entrega datos en `rexroth_subscription_grace_s`.

### 4.4 Distribución: `ConnectionManager`

Un solo objeto (`core/connection_manager.py`) mantiene:

- `_active`: sockets conectados; `_filtros`: `ws → plc_id | None`; `_usuarios`: `ws → {usuario, categoria}`.
- `_observadores`: callbacks **síncronos** internos. Es el mecanismo clave: el **historizador** y el **grabador** se enganchan aquí y reciben una copia de cada mensaje **sin abrir un segundo WebSocket ni una segunda sesión OPC UA**, y siguen funcionando aunque no haya ningún navegador conectado.
- `broadcast()`: primero notifica a los observadores, luego filtra destinatarios por `plc` y envía **en paralelo con `asyncio.gather`** (antes era secuencial y un cliente lento retrasaba a todos), depurando los sockets que fallan.
- `presentes()`: deduplica por persona (dos pestañas = un conectado) y cuenta anónimos aparte.

### 4.5 Identidad y permisos

`core/auth_manager.py` + `api/auth_routes.py`.

- Las cuentas viven en la **tabla SQL `usuarios`**, no en un JSON. La conexión se elige con `PLC_AUTH_DB_ID`, o la que mande el login (`db_id`), o la primera dada de alta.
- Contraseñas: `pbkdf2_sha256$260000$<salt>$<hash>`, verificación con `hmac.compare_digest`, **re-hash automático al entrar** si la cuenta es antigua.
- Sesiones: token opaco de 32 bytes **en memoria del proceso**, 12 h de inactividad. No JWT, a propósito: se quiere poder revocar al instante.
- Roles, de más a menos: `Supervisor > Administradores > Usuarios > Invitado`. `tiene_permiso()` compara índices; un rol desconocido cae al mínimo.
- **Modo arranque**: mientras `contar_en_todas() == 0` (todas las bases, no solo la activa) los endpoints de administración quedan abiertos aunque `auth_requerida=true`, porque si no sería imposible dar de alta la BD donde viven los usuarios. El primer usuario se fuerza a `Supervisor` y la puerta se cierra sola.
- La dependencia `exigir_rol("X")` es lo que aplica el permiso **en el backend**; el frontend solo esconde botones.

### 4.6 Bloqueo de edición ("el lápiz")

`core/lock_manager.py`. Un titular por recurso (`designer:<project_id>`, `alarmas`, …), TTL 30 s, heartbeat sugerido 10 s, `forzar()` solo para Supervisor, `liberar_todos_de()` al cerrar sesión. Barrido activo cada 5 s desde `lifespan` (no basta la limpieza perezosa: si nadie pregunta, los demás clientes no se enteran de que quedó libre). Cada cambio se difunde como `lock.changed`.

### 4.7 Persistencia del diseño

`db/project_store.py`. Un fichero por pantalla en `datos/proyectos/<id>.json`, con **escritura atómica** (`.tmp` + `replace`), caché en memoria, id validado contra `^[A-Za-z0-9_-]{1,64}$` (es un nombre de fichero: un `../` sería escritura fuera de la carpeta) y **optimistic locking**: cada mutación sube `version`; si el cliente manda una versión vieja se lanza `ConflictoDeVersion` → HTTP **409**. `version: null` fuerza la escritura.

### 4.8 Capa de datos SQL

- **`SqlDriver`** (`db/sql_driver.py`, 1.196 líneas) implementa `DbDriver` para los cuatro motores. Construye la URL SQLAlchemy por motor (y para `mssql` vuelca **todas** las `opciones` a la cadena ODBC — `TrustServerCertificate`, `Encrypt`…, que es lo que hacía fallar el ODBC 18 con certificado autofirmado), abre engine con `pool_pre_ping` y `pool_recycle`.
- **Dos caminos separados, a propósito**:
  - `query()` → **solo lectura**. Pasa siempre por `validar_sql_lectura()`: una sola sentencia (rechaza `;`), tiene que empezar por `SELECT`/`WITH`, y ninguna palabra de `PALABRAS_PROHIBIDAS` en ninguna posición. Parámetros siempre bindeados (`:nombre`). Límite de filas (pide `limite+1` para saber si hay más → `truncado`). Timeout.
  - `_ejecutar_interno()` / `insertar()` → **escritura**, saltan la validación, **no están expuestos en `DbDriver` ni en ningún endpoint**. Los usan solo el historizador, el `AuthManager` y el `CrudManager`, con SQL generado por el backend.
- `insertar()` resuelve el id nuevo por motor: `RETURNING id` (PostgreSQL), `OUTPUT INSERTED.id` (SQL Server — `SCOPE_IDENTITY()` devuelve NULL porque pyodbc mete un ámbito con `sp_executesql`), `LAST_INSERT_ID()` / `last_insert_rowid()` dentro del mismo `begin()`.
- **`DbManager`** (`core/db_manager.py`): un pool por conexión, alta que **verifica antes de persistir**, reapertura perezosa en `_driver_de()` (una BD caída al arrancar se reconecta sola en la primera consulta), y dos nociones distintas de "conectado": el pool (`_drivers`) y **lo que dijo el servidor la última vez** (`_estados`, vía `revisar_conexion()`), porque un pool abierto puede seguir diciendo "conectada" sobre una base que alguien borró.
- **`diagnostico.py`** traduce el error crudo del driver a un código estable (`sin_servidor`, `credenciales`, `base_no_existe`, `falta_driver`, `tls`, `timeout`…) con título y sugerencia; **`provision.py`** afina el caso de SQL Server (18456 vs 4060) sondeando `master`, y permite crear base + esquema + usuario con credenciales de administrador **que no se persisten en ningún sitio**; **`entorno.py`** responde *antes* de intentar conectar qué falta instalar en la máquina (paquete Python, driver ODBC, instancia de SQL Server, puerto abierto).

### 4.9 Historizador y grabador

Los dos escuchan el mismo flujo de tags como observadores del `ConnectionManager`, y hacen cosas distintas:

| | Historizador (`db/historian.py`) | Grabador (`export/grabador.py`) |
|---|---|---|
| Cuándo | Siempre, en segundo plano | Solo mientras dura la grabación |
| Qué captura | **Cada cambio** que llega del PLC | El **último valor conocido cada N ms** |
| Dónde va | Tabla SQL (`plc_prg` o `historico_tags`) | Memoria → Excel |
| Para qué | Histórico permanente | Un ensayo, un arranque, una incidencia |

Del historizador conviene saber:
- `on_mensaje()` es **síncrono y solo encola** (corre dentro del bucle de broadcast: si bloquea, retrasa a todos los clientes).
- Válvulas por grupo: `banda_muerta` (ignora variaciones pequeñas) e `intervalo_min_ms` (limita la frecuencia).
- Volcado por lotes cada 2 s con `executemany`; si falla, **el lote vuelve al buffer** para reintentar; buffer tope `MAX_BUFFER = 50.000` y, si se llena, se descartan las muestras **más antiguas**.
- **No crea tablas.** Lee las columnas reales de la tabla destino y construye un mapa (`historico_tags` usa `plc`; `plc_prg` usa `plc_id` y `programa`). Sin ese mapa, apuntar a `plc_prg` fallaba con *"Invalid column name 'plc'"*.
- Los timestamps se guardan **siempre en UTC** (`ts_para_motor()` normaliza al tipo del motor); la conversión a `PLC_TIMEZONE` es solo de presentación (`ts_local`) y se añade al leer.

### 4.10 CRUD del esquema del HMI

`core/crud_manager.py` + `api/crud_routes.py`. Es un CRUD genérico **sin superficie de inyección**: la tabla sale de un diccionario cerrado (`RECURSOS`), las columnas de la definición del recurso (lo que no esté declarado se descarta en silencio), los valores van bindeados y el orden solo puede ser por columna declarada. Recursos expuestos: `alarmas_def`, `alarmas`, `recetas`, `receta_elementos`, `receta_registros`, `receta_valores` y `plc_prg` (**solo lectura**: la escribe el historizador). `usuarios` **no** está: se administra por `/auth`, porque crear un usuario no es un INSERT.
`DEPENDENCIAS` reimplementa a mano lo que harían los `ON DELETE` (que el esquema no lleva porque SQL Server rechaza cascadas por dos caminos, Msg 1785).

### 4.11 Asistente de IA

`app/ai/`. `CatalogoHerramientas` **deriva las herramientas del `app.openapi()` en runtime**: cada endpoint documentado se convierte en herramienta, clasificada en LECTURA / ESCRITURA / PROHIBIDA. Se ejecutan **en proceso** con `httpx.ASGITransport` (sin salto de red). El RAG (`rag.py`) es BM25 en Python puro sobre tres fuentes: documentación (`docs/*.md`, `README.md` troceados por sección), estado vivo (PLCs, tags, conexiones, grupos) y esquema real de las BDs conectadas. `llm_client.py` habla la API compatible con OpenAI de Ollama Cloud (o un Ollama local).

### 4.12 Manejo de errores (patrón real del backend)

Hay **tres convenciones conviviendo**, y conviene tenerlas claras antes de tocar nada:

1. **`{"ok": false, "mensaje": "..."}` con HTTP 200** — es la más común. La usan `PlcManager`, `DbManager`, `Historizador`, `Grabador`. El frontend la trata como error en `pedir()` (`flows/api.ts`) y en `exportApi`.
2. **`HTTPException`** con `detail` string o dict — permisos (401/403), validación de rutas, conflicto de versión (**409** con `version_actual`), bloqueo (**423** con `titular` y `que_hacer`), Rexroth (401/404/502).
3. **Excepciones propias traducidas en la frontera**: `ErrorAuth(mensaje, codigo)`, `ErrorCrud(mensaje, codigo)`, `ConflictoDeVersion` → cada router las convierte a `HTTPException`.

Y un principio transversal, repetido en todo el código: **un fallo aislado nunca tumba el servicio**. Un PLC caído no afecta a los demás; una BD caída no impide arrancar; un `plcs.json` corrupto arranca sin PLCs; un proyecto ilegible se ignora con aviso; una zona horaria inválida cae a UTC; la auditoría descarta eventos antes que frenar la operación auditada.

### 4.13 Qué ocurre desde que llega una petición hasta que se devuelve la respuesta

Ejemplo real, `POST /plcs` (alta de un PLC):

1. **Uvicorn/Starlette** recibe la petición y pasa por el middleware CORS.
2. **Enrutado**: `rest_routes.agregar_plc`. FastAPI valida el cuerpo contra `NuevoPlc` (Pydantic) → si falla, 422 automático.
3. **Dependencia `Depends(exigir_rol("Administradores"))`**: extrae el token de `Authorization: Bearer` o de `?token=`, resuelve la sesión en memoria; si no hay sesión y `auth_requerida=true` y ya existen cuentas → 401; si hay sesión pero el rol no alcanza → 403.
4. **Auditoría**: `_auditar(request, "plc.alta", sesion, host, {...})` encola el evento en una cola; lo escribe un **hilo aparte** (auditar no retrasa la operación).
5. **Dominio**: `plc_manager.add_plc_manual()` normaliza el endpoint, valida la marca, exige usuario/contraseña si es Rexroth, comprueba duplicados por endpoint, crea `EndpointPlc` → `_añadir_plc()` → construye `Settings` propios del PLC (`model_copy`), instancia el driver, crea el `SubscriptionHandler` y **lanza `handler.start()` en segundo plano** (no espera a que el PLC conteste).
6. **Persistencia**: `_persistir()` vuelca `datos/plcs.json` cifrando contraseñas.
7. **Difusión**: `manager.broadcast(build_snapshot_message())` → todos los observadores internos y todos los navegadores reciben un snapshot nuevo.
8. **Respuesta**: `{"ok": true, "plc_id", "endpoint", "vendor", "mensaje"}` en HTTP 200. La conexión OPC UA real sigue intentándose en segundo plano con reintentos; el navegador se entera por los mensajes `status` del WebSocket.

Para una lectura de BD (`POST /db/queries/{query_id}/run`) el camino es: router → `DbManager.ejecutar()` → resuelve parámetros **solo entre los declarados** (los no declarados se ignoran; los que faltan toman su defecto; si falta uno sin defecto, `ok:false`) → `_driver_de()` reabre el pool si hace falta → `SqlDriver.query()` valida solo-lectura, ejecuta con timeout, normaliza tipos (fechas a ISO, `Decimal` a float) → `ResultadoConsulta.to_dict()`.

---

## 5 · Arquitectura del frontend

### 5.1 Estructura

```
frontend/src/
├── index.tsx / App.tsx        arranque y rutas
├── context/AppStore.tsx       ÚNICO estado global (Context)
├── pages/                     Login · MainMenu · Configuracion · Designer · Preview · Actividad
├── components/
│   ├── hmi/                   sistema de widgets (catálogo, renderer, inspector, partes, grupos)
│   │   └── custom/            widgets TSX propios: motor, navegación, trend, contenedor, lectura
│   ├── flows/                 editor de nodos (conexión BD ↔ grupo historizador) + api.ts
│   ├── alarms/ recipes/       editores de alarmas y recetas (sobre /crud)
│   ├── bd/ sistema/ export/   paneles de configuración y exportación
│   ├── auth/                  AsistenteArranque
│   └── ui/                    Field, TableBits (primitivas)
├── services/                  clientes HTTP y del WebSocket
├── hooks/                     useLock · useWebSocket (huérfano)
├── models/                    plc.ts · widget.ts
├── utils/                     designStorage · widgetBinding · format
└── i18n/                      traductor propio es/en
```

### 5.2 Rutas y navegación

`react-router-dom` v6 con `AnimatePresence` de framer-motion para el fundido entre páginas. **No hay guardas de ruta**: `/actividad` y `/config` se pueden abrir sin sesión; lo que protege de verdad es el backend en cada endpoint. `MainMenu` esconde la tarjeta de Actividad según `permisos`, y lo dice explícitamente en un comentario: *"esto es comodidad, no seguridad"*.

Dentro de `/preview` y `/designer` hay una **segunda navegación**, la del HMI: el widget "Menú Lateral" publica secciones y cada widget declara a cuál pertenece (`HmiWidget.vista`).

### 5.3 Estado

Tres niveles claramente separados:

1. **Global de aplicación** — `AppStore` (Context). Contiene: `connected`/`plcIp`/`plcVendor`, `variables` y `selectedVariables`, `config` (updateRate/theme/language), `sesion`+`permisos`, `presentes`, `projectId`/`projectVersion`/`pantallaCargada`/`pantallas`, y `widgets` + `setWidgets`.
2. **Stores fuera de React** — singletons que sobreviven al árbol de componentes:
   - `RealPLCService` (el WebSocket y los tags crudos),
   - `components/hmi/custom/navegacion/store.ts` (vista activa y secciones, con `useSyncExternalStore`; la clave real es `pantalla + grupo`, no solo el grupo — si no, tres pantallas del mismo HMI compartirían una única navegación).
3. **Local de cada página** — `useState` en `Designer`, `Configuracion`, `Login`, etc.

Persistencia en el navegador (`localStorage`/`sessionStorage`), toda ella **preferencia local o caché, nunca fuente de verdad**:

| Clave | Qué |
|---|---|
| `hmi.auth.token` | Token de sesión (`localStorage` si "Recordarme", `sessionStorage` si no) |
| `hmi.auth.db` | Última base elegida en el login |
| `hmi.design.<pantalla>` | Caché del diseño (la verdad está en `/proyectos/<id>`) |
| `hmi.design.ultima` | Última pantalla abierta |
| `hmi.plc.selection` | Qué variables tiene marcadas el usuario |
| widgets ZIP y lienzo del Flow Editor | **Solo local**: no viajan al servidor |

### 5.4 Servicios

| Archivo | Responsabilidad |
|---|---|
| `services/authApi.ts` | Token (dos almacenes), `fetchAuth()` (adjunta `Bearer`, traduce errores, **limpia el token y emite `hmi:sesion-caducada` ante un 401**), `tokenParaWs()`, endpoints `/auth/*` |
| `services/RealPLCService.ts` | **El único WebSocket de la app.** Mantiene `tags` crudos, throttlea el re-render (`updateRate`), reconecta cada 3 s, y **reemite los mensajes que no son de datos (`project.*`, `config.updated`, `presence`, `lock.changed`) como evento del navegador `hmi:ws`** para no abrir un segundo socket |
| `services/plcAdapter.ts` | Traduce `{plc, tag, value, type}` del backend a `PlcVariable` (`mapOpcType`, `inferUnit`) |
| `utils/designStorage.ts` | Proyectos: listar/cargar/crear/renombrar/duplicar/borrar y guardar (PUT / PATCH widget / DELETE widget), con caché local |
| `services/lockApi.ts` + `hooks/useLock.ts` | El lápiz: adquirir, heartbeat 10 s, liberar, forzar, y `sendBeacon` en `beforeunload` |
| `services/crudApi.ts` | CRUD genérico; **manda siempre `db_id`** (si no, el backend usaría la primera conexión y las recetas se guardarían en una base y se leerían de otra) |
| `services/recetasApi.ts` | Traduce entre las 4 tablas de recetas y el vocabulario TIA de la vista; reconstruye la rejilla desde la tabla estrecha `receta_valores` |
| `services/exportApi.ts` | Grabaciones en vivo y descarga de `.xlsx` (blob → `URL.createObjectURL`) |
| `services/activityApi.ts` | `/auth/conectados`, `/locks`, `/auditoria`, `/auth/usuarios` |
| `services/rexrothApi.ts` | `/rexroth/apps` y `/rexroth/programs` desde el Login/Configuración |
| `components/flows/api.ts` | `apiGet/Post/Patch/Delete` genéricos + tipos `Diagnostico`, `ConexionRemota`, `GrupoRemoto`, `TagRemoto` |
| `services/zipWidgetLoader.ts` | Carga widgets HTML desde ZIP (json+html+css+js), los valida y los guarda en `localStorage` |

### 5.5 Sistema de widgets (el corazón del Diseñador)

Tres orígenes, un solo renderizador:

1. **Built-in** (18): `widgetCatalog.ts` declara `kind`, etiqueta, icono, tamaño por defecto, categoría y **`accepts`** (qué tipos de variable admite). Se dibujan en el `switch` de `WidgetRenderer.tsx`.
2. **Custom TSX**: `components/hmi/custom/registry.ts` (motor trifásico, menú lateral de navegación, panel de sección, tendencia, contenedor, valor+unidad). Cada uno expone `render({widget, variable, style, on, frac, label})`.
3. **ZIP del usuario**: `zipWidgetLoader` + `HtmlWidgetRenderer`, que los monta en un **iframe con `sandbox="allow-scripts"`** (sin `allow-same-origin`) y les pasa los datos por `postMessage`, CSS custom properties (`--w-on`, `--w-frac`, …) y un objeto global `WIDGET`. El `srcDoc` se genera una sola vez para evitar parpadeo.

Alrededor: `PropertyInspector` (propiedades y enlace a variable, con aviso de incompatibilidad de `widgetBinding.ts` que **no bloquea**, solo advierte), `partes.ts` (estilo por sub-elemento: caja/etiqueta/icono/botón/valor), `grupo.ts` (contenedores: quién está dentro de quién, mover en bloque, z-order), `PantallasBar` (pestañas de pantallas: crear, renombrar, duplicar, borrar).

### 5.6 Formularios

No hay librería de formularios. Todo es estado local controlado + validación a mano:
- `Login.tsx` (1.505 líneas): dos pestañas (Entrar / Crear cuenta), medidor de fuerza de contraseña, selector de base de datos con diagnóstico en vivo, y cuatro estados de arranque distintos según `GET /auth/estado`.
- `Configuracion.tsx` (1.508): maestro-detalle en tres columnas (PLCs → variables → ficha), modal de alta de PLC con exploración Rexroth (`/rexroth/programs`), y paneles embebidos de BD y carpeta de datos.
- `RecipesEditor.tsx` (1.626) y `AlarmsEditor.tsx`: rejillas editables sobre `/crud`.
- `FlowConfigPanel.tsx`: el formulario de cada nodo del editor de flujos.
- Primitivas compartidas: `components/ui/Field.tsx` y `TableBits.tsx`.

### 5.7 Qué ocurre desde que el usuario hace algo hasta que vuelve la respuesta

**Caso A — mover un widget en el Diseñador (escritura):**

1. `CanvasWidget` procesa el arrastre y llama a `setWidgets` (estado local del `AppStore`). **La UI se actualiza al instante**, sin esperar a nadie.
2. Un efecto de `Designer.tsx` calcula `firmaActual = JSON.stringify({widgets, canvas})` y la compara con `firmaGuardada`. Si son iguales, no manda nada (evita subir la versión sin cambios).
3. Tres guardas antes de escribir: `listo` (los widgets **y** el lienzo ya son de esta pantalla), `permisos.editar_diseño`, y `lock.puedeEditar`.
4. **Debounce de 400 ms** → `guardarProyecto()` → `PUT /proyectos/<id>` con `{widgets, canvas, version}` y `Authorization: Bearer`.
5. Backend: `exigir_rol("Administradores")` → `_exigir_lapiz()` (si otro tiene el lápiz → **423**) → `ProjectStore.guardar_todo()` verifica versión (si no coincide → **409**) → escritura atómica en `datos/proyectos/<id>.json` **en un executor** (no congela los WebSockets) → auditoría → `broadcast({type:"project.updated", version, por, cambio})`.
6. Respuesta: `{version}` → el Diseñador guarda `firmaGuardada` y `setProjectVersion(v)`. Ante 409 muestra *"Otro usuario guardó cambios, recarga"*; ante cualquier otro error, el mensaje del backend.
7. **En los demás navegadores**: el mensaje llega por el WS → `RealPLCService` lo reemite como `hmi:ws` → el efecto de `AppStore` ignora el eco propio (compara `msg.por` con el usuario), y si no es suyo aplica el cambio (quirúrgico si es `widget_guardado`/`widget_borrado`, recarga completa si es un PUT). `Preview.tsx` escucha el mismo evento y recarga la pantalla.

**Caso B — dar de alta un PLC (Login o Configuración):**
`connect()` en `AppStore` (o el modal de `Configuracion`) → `POST /plcs` → el backend responde de inmediato → el `SubscriptionHandler` conecta en segundo plano → llegan por el WS un `snapshot`, luego `status: conectado`, luego los cambios de tag → `RealPLCService` actualiza `this.tags` → flush throttleado → `toPlcVariables()` → `setVariables` → se repintan todos los widgets enlazados.

---

## 6 · Comunicación frontend ↔ backend

### 6.1 Los dos canales

- **REST** para todo lo que cambia algo o se pide bajo demanda. Rutas **relativas**: en desarrollo las atiende el proxy de Vite; en producción, el mismo FastAPI que sirve el frontend. `VITE_API_BASE` es la escotilla para apuntar a otra máquina.
- **WebSocket `/ws`**, un solo socket por pestaña, **de solo lectura**: el cliente nunca envía nada (el bucle `receive_text()` solo drena). Todas las mutaciones van por REST, donde hay validación y permisos.

### 6.2 Mapa de endpoints ↔ quién los consume

| Método · Ruta | Consumidor en el frontend | Rol exigido |
|---|---|---|
| `GET /health` | `Configuracion.tsx` (lista de PLCs y estado) | — |
| `GET /plcs` · `POST /plcs` · `DELETE /plcs/{id}` | `AppStore.connect()`, `Configuracion.tsx` | Administradores (POST/DELETE) |
| `POST /discover` | *(no se usa desde la vista)* | Administradores |
| `GET /tags` | `flows/api.ts → cargarTags()` (selector de tags del historizador) | — |
| `GET /browse` | *(no se usa)* | — |
| `POST /rexroth/apps` · `/rexroth/programs` | `rexrothApi.ts` (Login y modal de Configuración) | — |
| `WS /ws?token=` | `RealPLCService.ts` | token opcional; obligatorio si `auth_requerida` |
| `GET /auth/estado` | `Login.tsx` (decide qué pintar) | público |
| `POST /auth/registro` · `/login` · `/logout` · `GET /auth/me` | `authApi.ts` / `AppStore` | — |
| `GET /auth/usuarios` · `PATCH /auth/usuarios/{u}` · `GET /auth/conectados` | `activityApi.ts` → `Actividad.tsx` | Administradores / Supervisor |
| `GET /proyectos` · `GET/PUT/PATCH/DELETE /proyectos/{id}` · widgets | `designStorage.ts` → Designer, Preview, PantallasBar | Administradores (Supervisor para borrar) |
| `GET /locks` · `POST /locks/{r}/{adquirir,renovar,liberar,forzar}` | `lockApi.ts` / `useLock` | forzar = Supervisor |
| `GET /auditoria` | `activityApi.ts` | Administradores |
| `GET /db` · `POST /db` · `DELETE /db/{id}` · `POST /db/{id}/test` · `GET /db/drivers` · `GET /db/entorno` · `POST /db/provision` | `flows/api.ts`, `components/bd/*` | Administradores / Supervisor (provision) |
| `GET /db/{id}/tablas` · `/columnas` · `POST /db/{id}/preview` | **no se usan** | **sin rol** |
| `GET/POST /db/queries` · `DELETE` · `POST /db/queries/{id}/run` | **no se usan** | Administradores (alta/baja); **run sin rol** |
| `GET /historian` · `POST /historian` · `/{id}/start` · `/{id}/stop` | `flows/api.ts`, `FlowConfigPanel`, `useEstadoHistorian` | Administradores (POST/start/stop) |
| `DELETE /historian/{id}` · `POST /historian/flush` · `GET /historian/{id}/datos` | no se usan desde la vista | Administradores / **datos sin rol** |
| `GET /export/tags` · grabaciones (crear, listar, estado, stop, borrar, excel) | `exportApi.ts` → `PanelExportar.tsx` | **sin rol** |
| `GET /export/historico/excel` · `POST /export/consultas/{id}/excel` | preparado en `exportApi`, **sin conectar en la vista** | **sin rol** |
| `GET /crud` · `/{recurso}` · `POST/PATCH/DELETE /crud/{recurso}` | `crudApi.ts` → `recetasApi`, `AlarmsEditor`, `RecipesEditor` | leer sin rol · crear/editar `Usuarios` · borrar `Administradores` |
| `GET /sistema/datos` · `/abrir` · `/backup` · `/restaurar` | `PanelCarpetaDatos.tsx` | Administradores / Supervisor |
| `POST /ai/chat` · `WS /ai/ws` · `GET /ai/*` | **ningún consumidor en el frontend** | — |

### 6.3 Contrato del WebSocket

El servidor emite ocho tipos de mensaje por el mismo socket:

| Tipo | Cuándo | Quién lo consume |
|---|---|---|
| `snapshot` | al conectar y al agregar/quitar un PLC | `RealPLCService` (reemplaza `tags`) |
| *(cambio de tag: trae `tag`, sin `type` de control)* | cada cambio en el PLC | `RealPLCService` (marca `dirty`, flush throttleado) + historizador + grabador |
| `status` | el PLC pasa a `conectado`/`reconectando` | `useWebSocket.js` (huérfano); `RealPLCService` lo ignora |
| `plc_removed` | alguien borra un PLC | `RealPLCService` limpia sus tags |
| `project.updated` / `project.removed` | cualquier mutación del diseño | reemitidos como `hmi:ws` → `AppStore`, `Preview` |
| `config.updated` | cambió una conexión, consulta, grupo o esquema | reemitido como `hmi:ws` |
| `presence` | alguien entra o sale | `AppStore` → `presentes` |
| `lock.changed` | se toma, suelta, fuerza o caduca un lápiz | `useLock` |

Detalle importante: la clave de un tag es **`"<plc_id>|<tag>"`** en todas partes — snapshot del WS, `claveTag()` del frontend, `on_mensaje()` del historizador y la selección de tags de un grupo. Es el identificador que enlaza widget ↔ tag ↔ histórico.

Y una trampa del protocolo: en un mensaje de cambio de valor, **`type` es el tipo de DATO** (`Float`, `Boolean`…), no el tipo de mensaje. La forma de distinguirlos es: si trae `tag`, es un dato; si no, es de control.

### 6.4 Manejo de errores y estados de carga en el cliente

- **Tres capas HTTP distintas**, con criterios distintos (ver §10):
  - `fetchAuth()` (`authApi.ts`): manda token, **gestiona el 401** (limpia token + evento `hmi:sesion-caducada`), lanza `Error` con `status` y `data`.
  - `pedir()` (`flows/api.ts`): manda token, lee el cuerpo **como texto antes de parsear** (el catch-all SPA devuelve HTML con 200 ante una ruta mal escrita), y trata `{"ok": false}` con HTTP 200 como error, adjuntando `diagnostico` y `data` al `Error`.
  - `fetch` crudo en varios sitios: **sin token** (ver riesgo R1).
- **Estados de carga**: `useState` booleanos por pantalla (`cargando`, `saving`, `adding`, `searching`) + `Loader2Icon` girando. No hay caché de peticiones ni deduplicación: cada pantalla pide lo suyo al montar.
- **Degradación**: si `/proyectos/<id>` falla, `cargarProyecto()` cae a la caché local (mejor el último diseño conocido que una pantalla en blanco delante de un operario); si `/proyectos` falla, la barra de pestañas conserva lo último que sabía.

---

## 7 · Base de datos y almacenamiento

### 7.1 Dos almacenes, y la línea entre ellos

| | Ficheros JSON en `datos/` | Base de datos SQL |
|---|---|---|
| Qué guarda | Configuración de la instalación | Datos de operación y cuentas |
| Contenido | `conexiones.json`, `consultas.json`, `historicos.json`, `plcs.json`, `proyectos/<id>.json`, `auditoria.jsonl`, `.clave` | `usuarios`, `plc_prg`, `alarmas_def`, `alarmas`, `recetas`, `receta_elementos`, `receta_registros`, `receta_valores` |
| Quién escribe | `DbStore`, `PlcStore`, `ProjectStore`, `Auditoria` | `Historizador`, `AuthManager`, `CrudManager`, `provision.py` |
| Dónde vive | `<raíz>/datos` en desarrollo, `C:\ProgramData\PsiCore\datos` empaquetado | Servidor SQL externo (hoy SQL Server, base `HMI_PSI`) |

Todas las escrituras de JSON son **atómicas** (`.tmp` + `replace`) y tolerantes a fichero corrupto. Las contraseñas (de BD y de PLCs Rexroth) van cifradas con **Fernet** usando `datos/.clave`; copiar los JSON sin la clave deja las contraseñas irrecuperables.

### 7.2 Modelo relacional (`sql/esquema_hmi_*.sql`)

```
usuarios ─┬─< alarmas.usuario_id
          ├─< recetas.usuario_id
          └─< receta_registros.usuario_id

plc_prg ──┬─< alarmas.plc_prg_id
          └─< receta_elementos.plc_prg_id

alarmas_def ──< alarmas.alarma_def_id

recetas ──┬─< receta_elementos ──< receta_valores.receta_elemento_id
          └─< receta_registros ──< receta_valores.receta_registro_id
```

- **`usuarios`** — cuentas: `usuario` (UNIQUE), `password_hash`, `algoritmo`, `email`, `categoria` (rol), `estado`, `creado_en`, `ultimo_acceso`.
- **`plc_prg`** — el **histórico de tags**, en formato estrecho: `ts` (UTC), `plc_id`, `programa` (Data Block en Siemens, POU en Rexroth), `tag`, `valor_num`, `valor_texto`, `tipo`. Índices `(tag, ts)` y `(plc_id, ts)`. Una fila por lectura: añadir o quitar tags **nunca requiere tocar la tabla**. Los booleanos se guardan como 0/1 en `valor_num` para poder graficarlos igual que una analógica.
- **`alarmas_def`** — la configuración: qué se vigila (equivalente a "Discrete alarms" de TIA). **`alarmas`** — los eventos: qué pasó, cuándo, quién lo reconoció.
- **Recetas en cuatro tablas**: `recetas` (contenedor) → `receta_elementos` (las columnas/ingredientes) → `receta_registros` (las filas/fórmulas) → `receta_valores` (el valor de cada celda, tabla **estrecha**: sin ella, añadir un ingrediente exigiría un `ALTER TABLE`). La rejilla ancha que ve el usuario se reconstruye al leer, en `recetasApi.cargarDetalle()`.
- **Ninguna FK lleva `ON DELETE`**: SQL Server rechaza el esquema entero (Msg 1785) en cuanto una tabla es alcanzable por dos caminos en cascada, y `receta_valores` lo es por diseño. Lo que el motor no hace lo hace `DEPENDENCIAS` en `crud_manager.py`, en orden y para los cuatro motores.
- El esquema es **idempotente** (`IF NOT EXISTS` / `IF OBJECT_ID(...) IS NULL`): ejecutarlo sobre una base que ya lo tiene no falla ni toca datos.

### 7.3 Quién toca qué

| Tabla | Escribe | Lee |
|---|---|---|
| `usuarios` | `AuthManager` (registro, login → `ultimo_acceso`, PATCH de rol/estado/clave) | `AuthManager`, `Actividad.tsx` |
| `plc_prg` | **solo `Historizador`** (`_ejecutar_interno` + `executemany`) | `historian.leer()` (widget de tendencia), `/export/historico/excel`, `/crud/plc_prg` (solo lectura) |
| `alarmas*`, `receta*` | `CrudManager` (`/crud/*`) | `AlarmsEditor`, `RecipesEditor` vía `crudApi`/`recetasApi` |
| Tablas de terceros | nadie | `DbManager.ejecutar()` (consultas guardadas) y `probar_sql()` (preview) — **siempre solo lectura** |

### 7.4 Cómo llegan esos datos al frontend

Tres caminos, ninguno mezclado con otro:
1. **Tiempo real** → WebSocket → `RealPLCService` → `PlcVariable[]` → widgets.
2. **Histórico / negocio** → REST (`/historian/{id}/datos`, `/crud/*`, `/db/queries/{id}/run`) → JSON plano `{columnas, filas, num_filas, truncado, ms}` → tablas y editores.
3. **Excel** → REST → blob → descarga en el navegador.

---

## 8 · Flujo completo de datos (cadena paso a paso)

### 8.1 PLC → pantalla (lectura en vivo)

```
S7-1500 / ctrlX
   │  (subscription OPC UA; el servidor notifica, no hay polling)
   ▼
OpcUaDriver._SubHandler.datachange_notification()
   │  extrae valor + SourceTimestamp + ServerTimestamp, calcula delta_ms
   ▼
SubscriptionHandler.on_data_change(TagValue)
   │  actualiza _snapshot[tag] y arma el mensaje {plc, tag, value, type, ...}
   ▼
ConnectionManager.broadcast(mensaje)
   ├──► observadores internos (SÍNCRONOS, solo encolan)
   │       ├── Historizador.on_mensaje() → buffer → cada 2 s executemany → tabla plc_prg
   │       └── Grabador.on_mensaje()     → último valor en memoria → muestreo cada N ms
   └──► clientes WebSocket (envío concurrente con gather, filtrado por ?plc=)
           ▼
     RealPLCService.onmessage  → this.tags["<plc>|<tag>"] = msg ; dirty = true
           ▼  (flush cada `updateRate` ms)
     toPlcVariables() → PlcVariable[] → listeners
           ▼
     AppStore.setVariables → useAppStore().variables
           ▼
     Designer / Preview: widget.variableId → variables.find(v => v.id === variableId)
           ▼
     WidgetRenderer → built-in (switch) | custom TSX (registry) | ZIP (iframe + postMessage)
```

### 8.2 Usuario → backend → base de datos → usuario (escritura de diseño)

```
Usuario arrastra un widget
   ▼ CanvasWidget (onMouseMove) → setWidgets (AppStore)  ── UI actualizada YA
   ▼ Designer: firma cambia → guardas (listo · permisos.editar_diseño · lock.puedeEditar)
   ▼ debounce 400 ms → designStorage.guardarProyecto()
   ▼ fetchAuth PUT /proyectos/<id>  { widgets, canvas, version }  + Bearer
   ▼ FastAPI: exigir_rol("Administradores") → _exigir_lapiz() [423] 
   ▼ ProjectStore.guardar_todo() → _verificar_version() [409] → _sellar() (version+1)
   ▼ escritura atómica en executor → datos/proyectos/<id>.json
   ▼ Auditoria.registrar("proyecto.guardado")   (cola → hilo aparte)
   ▼ ConnectionManager.broadcast({type:"project.updated", version, por, cambio})
   │        └──► resto de navegadores → RealPLCService → evento `hmi:ws`
   │                  ├── AppStore: ignora su propio eco; aplica el cambio ajeno
   │                  └── Preview: recarga la pantalla afectada
   ▼ respuesta { version } → Designer: firmaGuardada = firmaActual, setProjectVersion
```

### 8.3 Tag → base de datos → widget de tendencia

```
cambio de tag ──► Historizador.on_mensaje (filtro por grupo: interesa() + debe_guardar())
   ▼  banda_muerta / intervalo_min_ms descartan lo que sobra
   ▼  buffer por grupo (tope 50.000; si se llena, se tira lo más antiguo)
   ▼  cada 2 s: resolver columnas reales de la tabla → normalizar ts al motor (UTC)
   ▼  _ejecutar_interno(INSERT ..., lote)   ← executemany, un viaje por lote
   ▼  tabla plc_prg
   ▲
   │  GET /historian/{grupo}/datos?tag=&desde=&hasta=
   │     SELECT generado por el backend (nombre de tabla validado, filtros bindeados)
   │     + alias de columnas (plc_id AS plc) + ts_local por PLC_TIMEZONE
   ▼
   frontend (widget de tendencia / exportación a Excel)
```

Si la BD está caída, el lote **vuelve al buffer** y se reintenta; el log avisa la primera vez y luego cada 30 intentos con el contador, para no tapar el resto del log.

---

## 9 · Componentes y módulos principales (mapa de referencia)

### Backend

| Módulo | Responsabilidad única |
|---|---|
| `main.py` | Construir y cablear todo; servir el SPA |
| `config/settings.py` | Configuración tipada desde `.env` (prefijo `PLC_`) |
| `config/rutas.py` | Dónde vive `datos/` + migración desde instalaciones anteriores |
| `core/plc_manager.py` | Alta/baja de PLCs, agregación de estado, persistencia |
| `core/subscription_handler.py` | Ciclo de vida de UN PLC: conectar, browse, suscribir, reconectar |
| `core/connection_manager.py` | Clientes WS, filtros, presencia, broadcast, observadores |
| `core/plc_discovery.py` | Escaneo de subred + validación OPC UA |
| `core/auth_manager.py` | Cuentas, hash, sesiones, roles |
| `core/lock_manager.py` | El lápiz de edición |
| `core/auditoria.py` | JSONL append-only en hilo aparte, con rotación a 20 MB |
| `core/crud_manager.py` | CRUD cerrado sobre las tablas del HMI |
| `core/db_manager.py` | Pools por conexión, consultas guardadas, diagnóstico de estado |
| `drivers/plc_driver.py` | **Contrato** `PlcDriver` + `TagInfo` + `TagValue` |
| `drivers/opcua_driver.py` · `rexroth_driver.py` | Implementaciones Siemens / Rexroth |
| `db/db_driver.py` | **Contrato** `DbDriver` + `ResultadoConsulta` |
| `db/sql_driver.py` | Un driver para 4 motores + DDL + validación solo-lectura |
| `db/store.py` | `DbStore`: conexiones, consultas, grupos; cifrado Fernet |
| `db/project_store.py` | Diseño del HMI versionado |
| `db/historian.py` | Grupos, buffer, volcado por lotes, lectura del histórico |
| `db/provision.py` · `diagnostico.py` · `entorno.py` | Crear base/esquema/usuario · traducir errores · detectar qué falta instalar |
| `export/grabador.py` · `excel.py` | Grabaciones en vivo · `.xlsx` de 4 hojas con gráfico |
| `ai/agent.py` · `tools.py` · `rag.py` · `llm_client.py` | Agente, herramientas desde OpenAPI, BM25, cliente LLM |

### Frontend

| Módulo | Responsabilidad única |
|---|---|
| `context/AppStore.tsx` | El estado global y la sincronización con el WS |
| `services/RealPLCService.ts` | El WebSocket y el throttle de re-render |
| `utils/designStorage.ts` | Todo el ciclo de vida de un proyecto/pantalla |
| `hooks/useLock.ts` | El lápiz visto desde la vista |
| `pages/Designer.tsx` | Lienzo, autosave, pestañas del editor (diseñador/flujos/alarmas/recetas/exportar) |
| `pages/Preview.tsx` | Vista de operación, multipantalla, recarga en vivo |
| `pages/Configuracion.tsx` | PLCs, variables, bases de datos, sistema |
| `pages/Login.tsx` | Acceso, alta de la primera cuenta, elección de base |
| `pages/Actividad.tsx` | Presencia, bloqueos, auditoría, cuentas |
| `components/hmi/*` | Catálogo, renderizado, inspector, partes, grupos, pestañas |
| `components/hmi/custom/navegacion/store.ts` | Navegación interna del HMI (`pantalla + grupo`) |
| `components/flows/*` | Editor de nodos BD ↔ historizador |
| `components/recipes/*` · `alarms/*` | Editores sobre `/crud` |
| `components/export/PanelExportar.tsx` | Grabaciones y descarga de Excel |

---

## 10 · Dependencias importantes y acoplamientos

### 10.1 Backend

1. **Todo cuelga de `app.state`.** `main.py` es el único sitio donde se construyen los componentes; los routers los buscan por nombre. Renombrar `app.state.plc_manager` rompe `rest_routes`, `export_routes` y `ai/rag.py` a la vez.
2. **`ConnectionManager` es el bus.** Historizador y grabador dependen de que `broadcast()` siga llamando a los observadores **antes** de enviar a los clientes. Si alguien mete un `return` temprano cuando no hay clientes conectados, **el histórico deja de grabar sin que nadie se entere**.
3. **`SqlDriver` es el cuello de botella de datos.** Lo usan `DbManager`, `AuthManager`, `CrudManager`, `Historizador` y `provision.py`. Tocar `validar_sql_lectura`, `ts_para_motor`, `_nombre_seguro` o `_ejecutar_interno` afecta a los cinco.
4. **`DbStore` y `PlcStore` comparten `datos/.clave`** (`cargar_o_crear_clave`). Un cambio en el esquema de cifrado invalida las contraseñas de BD **y** las de los PLCs Rexroth.
5. **El agente depende del OpenAPI.** Cambiar el `summary`/`description` de un endpoint cambia cómo lo usa el modelo; añadir un endpoint le da una herramienta nueva sin tocar `ai/tools.py`.
6. **`sql/esquema_hmi_*.sql` se generan desde `SqlDriver.ddl_esquema_hmi()`** (`tools/generar_sql.py`). Editar el `.sql` a mano deja los dos desincronizados: hay que cambiar el generador y regenerar.
7. **El orden de apagado en `lifespan`**: historizador antes que `db_manager`, o se pierde el buffer.

### 10.2 Frontend

1. **`RealPLCService` es el único socket.** Todo lo que no son datos de PLC (`project.*`, `presence`, `lock.changed`, `config.updated`) llega a la aplicación **solo porque este servicio lo reemite** como evento `hmi:ws`. Si se filtra ese reenvío, dejan de funcionar a la vez: la sincronización del diseño, la presencia, el lápiz y la recarga del Preview.
2. **`AppStore` es el único Context.** Todas las páginas llaman a `useAppStore()`; añadir un campo re-renderiza toda la aplicación (no hay selectores).
3. **`designStorage` es la única puerta a `/proyectos`.** Designer, Preview y PantallasBar pasan por ahí.
4. **`fetchAuth` (`authApi.ts`) centraliza el token y el 401.** Todo lo que no pase por ahí (o por `pedir()` de `flows/api.ts`) se queda sin sesión.
5. **La clave `"<plc>|<tag>"`** enlaza `PlcVariable.id` ↔ `widget.variableId` ↔ tags del historizador ↔ `/export/tags`. Cambiar el formato rompe los cuatro.
6. **`vite.config.js` lista los prefijos del proxy uno a uno.** Un endpoint nuevo con un prefijo nuevo **no funciona en desarrollo** hasta añadirlo ahí, y el síntoma engaña: Vite devuelve el `index.html` de la SPA con HTTP 200 y parece que el backend no tiene ese endpoint.
7. **`navegacion/store.ts` se llavea por `pantalla + grupo`.** `setPantalla()` se llama en `useLayoutEffect` en Designer y Preview; moverlo a `useEffect` hace visible un estado intermedio con la navegación de la pantalla anterior.

---

## 11 · Puntos críticos y riesgos

Ordenados por lo que más probablemente muerda.

### R1 · `fetch` crudo sin token (rompe en cuanto se active el login)

Tres sitios llaman al backend **sin `Authorization`**:

| Archivo | Llamada |
|---|---|
| `context/AppStore.tsx` (`connect`) | `POST /plcs` |
| `pages/Configuracion.tsx` | `GET /health`, `POST /plcs`, `DELETE /plcs/{id}` |
| `components/flows/FlowConfigPanel.tsx` | `POST /db`, `POST /historian`, `POST /historian/{id}/{start,stop}` |

Hoy funcionan porque `PLC_AUTH_REQUERIDA=false`. En cuanto se ponga a `true` (que es lo que el propio `.env.example` recomienda para planta) **devolverán 401**: no se podrán dar de alta PLCs ni guardar conexiones ni grupos desde el editor de flujos. Arreglo: enrutarlos por `fetchAuth()` o por `pedir()` de `flows/api.ts`.

### R2 · Endpoints sin control de rol

No declaran `exigir_rol` y por tanto son accesibles por cualquiera que llegue al puerto, incluso con `auth_requerida=true`:

- **`POST /db/{db_id}/preview`** — ejecuta SQL arbitrario (de lectura) contra cualquier conexión dada de alta. Es el más sensible de la lista.
- `POST /db/queries/{query_id}/run`, `GET /db/{id}/tablas`, `GET /db/{id}/columnas`, `GET /db`, `POST /db/{id}/test`.
- **Todo `/export/*`** — incluida la descarga del histórico completo en Excel.
- `GET /crud` y `GET /crud/{recurso}` (lectura de alarmas y recetas), `GET /historian`, `GET /historian/{id}/datos`.
- `GET /sistema/datos` (revela la ruta de datos y el listado de ficheros).

Con `auth_requerida=false` (el valor por defecto) **todo el API está abierto**, incluido borrar un PLC de producción. El propio código lo dice en `settings.py`; conviene tratarlo como decisión consciente de despliegue, no como estado normal.

### R3 · CORS `allow_origins=["*"]` con `allow_credentials=True`

En `main.py`. La combinación es contradictoria (los navegadores rechazan credenciales con comodín) y, dado que la autenticación es por cabecera `Bearer`, deja el API abierto a peticiones desde cualquier origen. Cuando el frontend se sirve desde el mismo FastAPI, **CORS no hace falta en absoluto**; en desarrollo bastaría con `http://localhost:5173`.

### R4 · Estado en memoria = un solo worker de uvicorn

Sesiones, bloqueos, presencia, snapshots de PLC, grabaciones y buffers del historizador viven en el proceso. Arrancar con `--workers 2` (o detrás de dos réplicas) produce fallos difíciles de diagnosticar: sesión válida en un worker e inválida en otro, dos personas con el lápiz de la misma pantalla, presencia parcial, snapshots distintos. **El código lo asume, pero nada lo impide.** Si algún día hace falta escalar, el punto de extensión es sustituir `ConnectionManager`, `LockManager` y el almacén de sesiones por Redis.

### R5 · `validar_sql_lectura()` es una lista negra

Bloquea 25 palabras en cualquier posición del SQL. Eso genera **falsos positivos** perfectamente razonables: una columna llamada `create_ts`, `updated_by`, `delete_flag` o un alias `merge` hacen rebotar la consulta. Y como toda lista negra, no es una garantía. El propio docstring lo dice: *"es una segunda barrera; la primera debería ser un usuario de BD con permisos de solo lectura"*. Asegurarse de que `hmi_app` tiene solo `db_datareader`/`db_datawriter` es lo que de verdad protege.

### R6 · El `plc_id` no es estable

`_plc_id_desde()` deriva el id del `ApplicationName` OPC UA y, si no lo hay, del host. Un PLC al que se le cambia el nombre en TIA, o que se da de baja y se vuelve a agregar en otro orden, **puede recibir otro id**. Y el id forma parte de la clave `"<plc>|<tag>"` que usan los widgets enlazados y los grupos del historizador → **los enlaces se rompen en silencio**: el widget deja de recibir datos y el grupo deja de grabar ese tag, sin ningún error visible. Es el fallo más difícil de diagnosticar de toda la lista.

### R7 · El lienzo del Flow Editor vive solo en `localStorage`

`FlowEditor.tsx` guarda nodos y conexiones en el navegador, pero **lo que esos nodos crean (conexiones a BD, grupos de historización) es global y compartido**. Consecuencias: otro usuario no ve el diagrama; borrar un nodo no borra el grupo; y un grupo creado desde otro equipo no aparece en el lienzo. `useEstadoHistorian` mitiga a medias consultando `GET /historian`, pero la desincronización sigue ahí.

### R8 · Código muerto y duplicado

| Qué | Estado |
|---|---|
| `hooks/useWebSocket.js` (111 líneas) | **Huérfano**: nadie lo importa. Es un segundo cliente WS con su propio parseo del protocolo, que ya diverge del real (no maneja `presence`, `project.*` ni `lock.changed`) |
| `services/MockPLCService.ts` (239 líneas) | **Huérfano**: `AppStore` importa `RealPLCService as MockPLCService`, así que el archivo real no se usa |
| `designStorage.guardarWidget()` | Definida y con endpoint en el backend (`PATCH /proyectos/{id}/widgets/{wid}`), pero **nadie la llama**: el Designer guarda siempre con `PUT` completo. El camino "rápido" del arrastre existe en los dos extremos y no se usa |
| Tres capas HTTP (`fetchAuth`, `pedir`, `fetch` crudo) | Criterios distintos para token, errores y 401 |
| `AppStore`: `connected`, `plcIp`, `disconnect`, `saveConfig` | Vestigios del login simulado (`connected` arranca en `true`, `saveConfig` es un no-op) |
| `MainMenu.tsx` → botón **Salir** | Llama solo a `disconnect()` (que pone `connected=false`) y navega a `/`. **No llama a `cerrarSesion()`**, así que no hace `POST /auth/logout`, no borra el token del navegador y no libera el lápiz de edición: la sesión sigue abierta en el servidor y el siguiente que abra la URL entra como el anterior |
| `frontend/vite.config.js.timestamp-*.mjs` (3 ficheros) | Basura de Vite que debería estar en `.gitignore` |

### R9 · El asistente de IA está desconectado y con la puerta abierta

`PLC_AI_ENABLED` es **`true` por defecto**, así que el agente se monta en cada arranque aunque **ningún componente del frontend consuma `/ai/*`**. Además, `CatalogoHerramientas.ejecutar()` llama a la app ASGI **sin cabecera `Authorization`**: con `auth_requerida=true` sus herramientas de escritura recibirán 401 (no es escalada de privilegios, pero sí un fallo silencioso), y con `auth_requerida=false` puede ejecutar cualquier endpoint no prohibido si se activa `PLC_AI_PERMITIR_ESCRITURA`. Recomendación: `PLC_AI_ENABLED=false` mientras no haya vista que lo use.

### R10 · Ruta widget → base de datos, sin conectar

Todo el camino de "el widget lee de una consulta guardada" existe en el backend (`POST /db/queries` + `POST /db/queries/{id}/run`, con validación y parámetros declarados) y está documentado en `docs/API_DB.md`, pero **el frontend no llama a ninguno de los dos**. Los widgets de datos todavía no consumen SQL. Lo mismo con `GET /export/historico/excel` y `POST /export/consultas/{id}/excel`: `exportApi` los tiene escritos, la vista no los invoca.

### R11 · Detalles operativos que muerden en planta

- **Descubrimiento de red**: `discovery_enabled` es `true` por defecto y escanea un `/24` completo con 64 conexiones en paralelo. En una red industrial eso puede activar alertas. `.env.example` lo neutraliza con `PLC_AUTOSTART_PLCS=false`, pero el valor por defecto del código es el agresivo.
- **`datos/.clave`**: sin ese fichero, `conexiones.json` y `plcs.json` son inservibles. Debe entrar en la copia de seguridad (el `.zip` de `/sistema/datos/backup` lo incluye) y no debería salir de la máquina.
- **SQL Server necesita el ODBC Driver 17/18 instalado en el SO**; `pip` no lo trae. `GET /db/entorno` existe justo para decirlo antes de fallar.
- **`asyncpg` y `aiomysql` están comentados** en `requirements.txt`: PostgreSQL y MySQL no funcionan hasta instalarlos, aunque la vista los ofrezca.
- **Buffer del historizador**: 50.000 muestras. Con una BD caída y muchos tags cambiando rápido, se llena en minutos y empieza a descartar lo más antiguo.
- **Catch-all SPA**: cualquier ruta no registrada devuelve `index.html` con HTTP 200. Un endpoint mal escrito nunca da 404, da HTML — de ahí que los clientes lean el cuerpo como texto antes de parsear.

### R12 · Archivos que no deberían tocarse sin revisar sus dependencias

| Archivo | Por qué |
|---|---|
| `app/main.py` (lifespan) | Orden de arranque/apagado y nombres de `app.state` |
| `app/core/connection_manager.py` (`broadcast`) | De él dependen historizador, grabador y todos los clientes |
| `app/db/sql_driver.py` | Lo comparten cinco módulos; contiene la validación de seguridad y el DDL |
| `app/core/auth_manager.py` | Formato del hash y modo arranque; un cambio puede dejar a todos fuera |
| `app/db/project_store.py` | Formato en disco del diseño **y** el contrato de versiones con el frontend |
| `sql/esquema_hmi_*.sql` | Generados; editar el generador, no el fichero |
| `frontend/vite.config.js` | Cada prefijo nuevo del API tiene que estar listado |
| `frontend/src/services/RealPLCService.ts` | Único socket; su reenvío `hmi:ws` sostiene cuatro funcionalidades |
| `frontend/src/context/AppStore.tsx` | Lo consume toda la aplicación |
| `datos/.clave` | Borrarlo o reemplazarlo invalida todas las contraseñas guardadas |

---

## 12 · Diagrama de arquitectura (texto)

```
┌──────────────────────────────── PLANTA ────────────────────────────────┐
│   S7-1500 (OPC UA, anónimo)          ctrlX CORE (OPC UA, user+pass)    │
└───────────┬────────────────────────────────────┬───────────────────────┘
            │ subscription (sin polling)          │ subscription o polling
┌───────────▼────────────────────────────────────▼───────────────────────┐
│  BACKEND — FastAPI + uvicorn (UN proceso, UN worker)                    │
│                                                                        │
│  drivers/    OpcUaDriver          RexrothDriver     ← interfaz PlcDriver│
│                  │                     │                               │
│  core/       SubscriptionHandler (uno por PLC: supervisor + watchdog)   │
│                  └──────────► PlcManager  (alta/baja, discovery, plcs.json)
│                                    │                                   │
│                       ┌────────────▼─────────────┐                     │
│                       │   ConnectionManager      │  ← el bus del sistema│
│                       │   broadcast + observadores│                    │
│                       └──┬──────────────────┬────┘                     │
│            observadores  │                  │  clientes WebSocket      │
│         ┌────────────────▼───┐   ┌──────────▼──────────┐               │
│         │   Historizador     │   │      /ws            │───────────────┼──►
│         │ buffer→executemany │   └─────────────────────┘               │
│         └─────────┬──────────┘                                         │
│                   │            ┌── AuthManager (usuarios, sesiones, roles)
│         ┌─────────▼──────────┐ ├── LockManager (el lápiz, TTL 30 s)     │
│  db/    │ DbManager + SqlDriver├── ProjectStore (datos/proyectos/*.json)│
│         │ pools · solo lectura│ ├── CrudManager (alarmas, recetas)      │
│         └─────────┬──────────┘ ├── Grabador + Excel (openpyxl)          │
│                   │            └── Auditoria (JSONL, hilo aparte)       │
│  api/    /health /plcs /tags /browse /discover /rexroth/*               │
│          /auth/* /proyectos/* /locks/* /auditoria                       │
│          /db/* /crud/* /historian/* /export/* /sistema/* /ai/*  + /ws   │
└───────────┬─────────────────────────────────────┬──────────────────────┘
            │ SQL (SQLAlchemy async)              │ ficheros locales
┌───────────▼───────────────────┐   ┌─────────────▼──────────────────────┐
│ SQL Server / PostgreSQL /     │   │ datos/                             │
│ MySQL / SQLite                │   │  conexiones.json  consultas.json   │
│  usuarios · plc_prg           │   │  historicos.json  plcs.json        │
│  alarmas_def · alarmas        │   │  proyectos/<id>.json               │
│  recetas · receta_elementos   │   │  auditoria.jsonl   .clave (Fernet) │
│  receta_registros · valores   │   └────────────────────────────────────┘
└───────────────────────────────┘

            ▲ REST (fetch relativo)          ▲ WebSocket (un socket por pestaña)
┌───────────┴────────────────────────────────┴───────────────────────────┐
│  FRONTEND — React 18 + Vite + TS + Tailwind                            │
│                                                                        │
│  services/  RealPLCService ──► evento `hmi:ws` ──► AppStore · useLock · │
│             authApi (token, 401)   designStorage   crudApi/recetasApi   │
│             lockApi · exportApi · activityApi · flows/api               │
│                          │                                             │
│  context/   AppStore (Context único: sesión, permisos, variables,       │
│             widgets, pantallas, presencia, tema, idioma)                │
│                          │                                             │
│  pages/     Login ─► MainMenu ─┬─► Configuracion (PLCs · BD · Sistema)  │
│                                ├─► Designer (lienzo · flujos · alarmas  │
│                                │            · recetas · exportar)       │
│                                ├─► Actividad (presencia · locks · audit)│
│                                └─► Preview (operación, datos en vivo)   │
│                          │                                             │
│  components/hmi/  WidgetRenderer ─┬─ built-in (18, switch)              │
│                                   ├─ custom TSX (registry)              │
│                                   └─ ZIP → iframe sandbox + postMessage │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 13 · Conclusión: cómo funciona TODO el sistema

Psi Core es **un solo proceso Python que hace de puente entre la planta y el navegador**, y un frontend React que trata a ese proceso como su única fuente de verdad.

El backend arranca en `app/main.py`: construye once componentes a mano, los deja en `app.state` y lanza en segundo plano los supervisores. Por cada PLC hay un `SubscriptionHandler` que se conecta por OPC UA, descubre los tags navegando el árbol del servidor, se suscribe a los cambios y reconecta solo con backoff exponencial si se cae. Cada cambio de valor entra por un callback del driver, actualiza un snapshot en memoria y se publica en el `ConnectionManager`, que es **el bus del sistema**: primero se lo entrega a los observadores internos —el historizador, que lo acumula en un buffer y lo vuelca por lotes a SQL, y el grabador, que muestrea a intervalo fijo para exportarlo a Excel—, y después lo difunde a todos los navegadores conectados por un único WebSocket.

En el navegador, ese socket lo abre **un solo servicio**, `RealPLCService`. Los mensajes de datos se acumulan y se emiten a React con un throttle configurable; los que no son datos —cambios de diseño, presencia, bloqueos, cambios de configuración— se reemiten como un evento del navegador, `hmi:ws`, del que cuelgan la sincronización del diseño, la barra de presencia, el lápiz de edición y la recarga automática de la vista de operación. Todo el estado global vive en un único Context, `AppStore`.

El diseño del HMI —widgets, lienzo, pantallas— **no vive en el navegador**: vive en `datos/proyectos/<id>.json`, versionado. El Diseñador pinta al instante desde una caché local, reconcilia contra el servidor y guarda con debounce, pero solo si tiene el rol, tiene el lápiz y la pantalla cargada coincide con la pantalla abierta. El servidor responde 423 si otro está editando y 409 si alguien guardó primero; cada guardado exitoso se difunde y las demás pantallas se actualizan sin recargar. Ese trío —**roles + lápiz + versión**— es lo que hace que diez personas puedan trabajar sobre el mismo HMI sin pisarse: el rol dice si *puedes*, el lápiz si *te toca ahora*, y la versión evita perder trabajo si aun así coinciden.

Los datos de negocio siguen un camino distinto y deliberadamente separado del tiempo real: un `SqlDriver` único cubre cuatro motores, y hay **dos puertas con permisos opuestos**. La de lectura (`query()`) valida que el SQL sea una sola sentencia `SELECT`/`WITH`, bindea los parámetros, limita las filas y pone timeout; es por donde pasan las consultas guardadas y el preview del diseñador. La de escritura (`_ejecutar_interno`) salta esa validación a propósito, no está expuesta en ningún endpoint y solo la usan el historizador, el gestor de cuentas y el CRUD cerrado, siempre con SQL generado por el propio backend. La identidad se apoya en la tabla `usuarios` de esa misma base, con PBKDF2 y sesiones en memoria; los permisos se aplican endpoint por endpoint, y esconder un botón en la vista nunca se considera seguridad.

Por encima, la configuración de la instalación (conexiones, PLCs, grupos de historización, proyectos, auditoría) se guarda en ficheros JSON atómicos y cifrados donde hace falta, en una carpeta que sobrevive a desinstalar y actualizar la aplicación. Y todo el conjunto se puede empaquetar como un `.exe` con ventana nativa, sin que el operador vea nunca un puerto ni una URL.

**Lo que hay que respetar al modificar**: las dos interfaces abstractas (`PlcDriver`, `DbDriver`) son el mecanismo de extensión —un protocolo nuevo o un motor nuevo se añaden implementándolas, sin tocar nada más—; `ConnectionManager.broadcast()` debe seguir notificando a los observadores aunque no haya clientes; la clave `"<plc_id>|<tag>"` es el identificador que enlaza widgets, historización y exportación; toda mutación del diseño pasa por rol → lápiz → versión → difusión; y todo endpoint nuevo necesita, además de su `exigir_rol`, una línea en el proxy de `vite.config.js` y una llamada que use `fetchAuth` o `pedir`, nunca un `fetch` crudo.
