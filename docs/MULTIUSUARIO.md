# Multiusuario en tiempo real — análisis y plan

> Análisis de `websocket_siemens` · 24 ago 2026
> Objetivo: que 2, 5 o 10 personas trabajen a la vez sobre el mismo HMI y vean
> los cambios de los demás en el momento en que ocurren.

---

## ✅ ESTADO: Fases 0 a 4 IMPLEMENTADAS · 25 ago 2026

Lo que sigue en este documento es el análisis original. **Todo el plan está
hecho** salvo lo que se marca como pendiente al final. Para probarlo, ver
[PROBAR_MULTIUSUARIO.md](PROBAR_MULTIUSUARIO.md) o ejecutar:

```powershell
python tools/probar_multiusuario.py
```

Resumen de lo que existe hoy:

| Fase | Estado | Qué se hizo |
|---|---|---|
| 0 · Cerrar fugas | ✅ | Lock + escritura fuera del bucle async en `DbStore`; broadcast en `_bucle_reescaneo()`; PLCs persistidos en `datos/plcs.json` (contraseñas cifradas) |
| 1 · Diseño al servidor | ✅ | `app/db/project_store.py` + `app/api/project_routes.py`. **Varios proyectos** en `datos/proyectos/<id>.json`, versionados, con 409 ante conflicto |
| 2 · Avisar cambios | ✅ | `config.updated` tras cada mutación de BD, consultas e historizador |
| 3 · Identidad | ✅ | Cuentas en la tabla SQL `usuarios`, PBKDF2-SHA256, sesiones, 4 roles aplicados **en el backend**, y presencia en vivo |
| 4 · Bloqueo del diseñador | ✅ | **Opción A**: un usuario tiene "el lápiz", el resto ve en vivo en modo lectura. Heartbeat cada 10 s, caduca a los 30 s, toma de control por Supervisor. Escribir sin él da **423** |
| 5 · Escalar >10 | 🟡 | Broadcast ya es concurrente (`asyncio.gather`). Redis sigue sin hacer falta: **un solo worker** |

### Archivos nuevos

```
app/core/auth_manager.py      Cuentas, hash, sesiones, roles
app/core/lock_manager.py      El "lápiz" de edición (Fase 4)
app/core/auditoria.py         Quién hizo qué (datos/auditoria.jsonl)
app/core/plc_store.py         Persistencia de PLCs (cifrada)
app/api/auth_routes.py        /auth/* y las dependencias de rol
app/api/project_routes.py     /proyectos/*
app/api/lock_routes.py        /locks/* y /auditoria
app/db/project_store.py       Proyectos versionados
frontend/src/services/authApi.ts     Cliente de sesión (token, fetchAuth)
frontend/src/services/lockApi.ts     Cliente del lápiz
frontend/src/hooks/useLock.ts        Ciclo completo del lápiz en la vista
tools/probar_multiusuario.py         Prueba automática de todo lo anterior
```

### El lápiz de edición (Fase 4)

```
Al ENTRAR al Diseñador   ->  POST /locks/designer:<id>/adquirir
Mientras se edita        ->  POST /locks/designer:<id>/renovar   (cada 10 s)
Al SALIR                 ->  POST /locks/designer:<id>/liberar
Si el navegador muere    ->  caduca solo a los 30 s
Un Supervisor puede      ->  POST /locks/designer:<id>/forzar
```

Quien no lo tiene ve **`Solo lectura · edita <nombre>`** en la barra superior y
el lienzo no responde. Sigue recibiendo los cambios en vivo. Escribir sin el
lápiz devuelve **423 Locked** con quién lo tiene y qué hacer.

El lock es **por proyecto** (`designer:principal`, `designer:horno_2`), así que
dos personas pueden editar dos pantallas distintas a la vez.

### Cómo se pone en marcha

```bash
# 1) En .env
PLC_AUTH_REQUERIDA=true

# 2) Arrancar. Mientras NO haya cuentas, los endpoints de administración
#    quedan abiertos (modo arranque): sin eso sería imposible configurar la
#    BD donde viven los usuarios. Da de alta la BD y crea el esquema:
POST /db  { "db_id": "local", "motor": "sqlite",
            "base_datos": "C:/datos/planta.db", "crear_esquema": true }

# 3) Crear la primera cuenta. Será SUPERVISOR pida lo que pida, y a partir
#    de ahí la puerta se cierra sola.
POST /auth/registro  { "usuario": "hugo", "password": "Planta2026!" }
```

### Roles (de más a menos permisos)

Son exactamente los strings del desplegable de `Login.tsx`, y se guardan tal
cual en `usuarios.categoria`:

| Rol | Puede |
|---|---|
| `Supervisor` | Todo, incluida la gestión de usuarios |
| `Administradores` | Editar el diseño, dar de alta PLCs y conexiones a BD |
| `Usuarios` | Ver la configuración, no modificarla |
| `Invitado` | Solo la vista de operación |

Los permisos se aplican **en el backend**, en cada endpoint. Esconder un botón
en la vista no es seguridad: cualquiera puede llamar al endpoint con `curl`.

### Lo que sigue pendiente

- **Preferencias personales en el servidor.** Tema e idioma siguen perdiéndose
  al recargar (`saveConfig()` sigue siendo no-op). Es deliberado: son
  preferencias del navegador, no configuración compartida. Si se quiere que
  sigan a la persona entre equipos, el sitio es una tabla `preferencias`
  con FK a `usuarios`.
- **Selector de proyectos en la vista.** El backend ya soporta varios
  (`datos/proyectos/<id>.json`, `GET /proyectos`), pero el frontend abre
  siempre `principal`. Añadir el desplegable es media hora.
- **Edición colaborativa real** (CRDT, opción C de la Fase 4). Solo se
  justifica si varias personas construyen pantallas a la vez como trabajo
  habitual. Con el lápiz, el caso real está cubierto.
- **Varios workers / varias máquinas.** Sesiones, bloqueos y clientes WS viven
  en la memoria de un proceso. Hasta que haga falta escalar, **un solo
  worker**.

### Nueva variable de entorno

`PLC_DATOS_DIR` — carpeta donde se persiste el estado (conexiones, proyectos,
PLCs, auditoría). Por defecto `<raíz>/datos`. Se añadió porque el script de
pruebas levanta un backend real y, sin esto, escribiría en la carpeta de datos
de la instalación de verdad. También sirve para el ejecutable de escritorio,
que corre desde una ruta de solo lectura.

---

## Resumen

**Sí es viable, y ya estás a mitad de camino.**

La arquitectura actual es la correcta: hay **un solo backend** que mantiene **una
sola sesión OPC UA por PLC** sin importar cuántos navegadores estén mirando, y ya
existe un `ConnectionManager` que difunde a todos los clientes conectados.

El problema no es que falte tiempo real: es que **parte del estado que quieres
compartir no vive en el servidor**. Los valores de los PLCs sí se comparten hoy.
El diseño del HMI vive en el `localStorage` de cada navegador, así que el usuario 2
nunca podrá ver los widgets del usuario 1 hasta que ese estado se mude al servidor.

---

## 1 · Cómo se mueve el estado hoy

El backend es un único proceso FastAPI. En `lifespan()` se construyen cuatro objetos
que viven en `app.state` y son compartidos por todas las peticiones y todos los
sockets: `ConnectionManager`, `PlcManager`, `DbManager` e `Historizador`. No hay
estado por usuario en el backend, porque no hay usuarios.

Dos direcciones bien separadas:

- **Bajada (servidor → navegador):** el WebSocket `/ws`. Es de solo lectura; el
  `while True: await websocket.receive_text()` de `websocket_routes.py` solo drena
  lo que llegue, nunca lo procesa.
- **Subida (navegador → servidor):** REST. Todas las mutaciones son `POST`/`DELETE`.

**Hallazgo clave: ese patrón ya es multiusuario para los PLCs.** Cuando alguien llama
a `POST /plcs`, `PlcManager.add_plc_manual()` termina con
`broadcast(build_snapshot_message())` a todos los sockets. Al borrar un PLC sale un
`{"type": "plc_removed"}`. Y `RealPLCService.ts` del frontend ya sabe interpretar
ambos mensajes y rehacer su tabla de tags.

> **Compruébalo en dos minutos:** abre la aplicación en dos navegadores distintos y
> agrega un PLC desde uno. El otro debería empezar a recibir sus tags sin recargar.

---

## 2 · Qué se comparte y qué no

| Estado | Dónde vive hoy | ¿Compartido? | Qué pasa con 2 usuarios |
|---|---|---|---|
| Valores de tags en vivo | `SubscriptionHandler._snapshot` (memoria servidor) | **Sí** | Los dos ven el mismo valor en el mismo instante |
| Alta / baja de PLC | `PlcManager._handlers` (memoria servidor) | **Sí** | Ya hace broadcast de `snapshot` y `plc_removed` |
| Estado de conexión de un PLC | `SubscriptionHandler` | **Sí** | Se difunde `{"type":"status"}`, el frontend hoy lo ignora |
| PLCs de re-escaneo automático | `_bucle_reescaneo()` | *A medias* | Los agrega pero **no difunde snapshot**, a diferencia de `rescan()` |
| Conexiones BD, consultas, historizador | `datos/*.json` vía `DbStore` | *A medias* | Persisten y son de todos, pero **sin aviso**: hay que recargar |
| **Diseño del HMI** (widgets, lienzo) | `localStorage['hmi.design']` | **No** | Cada navegador tiene su propio HMI ← *bloqueador principal* |
| Selección de variables | `localStorage['hmi.plc.selection']` | **No** | Cada uno marca sus casillas |
| Tema, idioma, tasa de refresco | Estado React; `saveConfig()` es no-op | **No** | Se pierde al recargar |
| Lista de PLCs tras reiniciar | Solo memoria + `.env` | **No** | Se pierde el trabajo de todos a la vez |
| Identidad de usuario | No existe | **No** | `Login.tsx` está comentado en `App.tsx`, y es login *al PLC*, no de persona |

De las diez filas: tres ya funcionan, dos a medias y cinco no existen. Y de esas
cinco, **una sola** —el diseño del HMI— es la que realmente pediste.

---

## 3 · Los cuatro problemas reales

### 1. El diseño vive en el cliente

`designStorage.ts` guarda y lee de `localStorage`. Fue la decisión correcta para un
solo usuario (permitía que la pestaña de *Vista previa*, con su `AppStore` nuevo y
vacío, leyera el diseño del *Diseñador*). Pero `localStorage` es privado del
navegador por definición: no hay API que lo haga viajar. Mientras el diseño esté ahí,
ni el mejor WebSocket lo arregla.

### 2. Las mutaciones no avisan a nadie

Los endpoints de `db_routes.py` e `historian_routes.py` escriben en disco y devuelven
`200`. Ninguno toca `app.state.manager`. `Configuracion.tsx` lo compensa con polling
de `/health` cada 5 s, pero eso solo cubre PLCs: las consultas y conexiones de BD no
se refrescan nunca.

### 3. Se escribe a disco sin control de concurrencia

`DbStore.guardar()` vuelca los tres JSON completos en cada operación. La escritura es
atómica a nivel de fichero (`.tmp` + `replace`), pero no hay ningún lock por encima.
Dos peticiones concurrentes hacen leer-modificar-escribir sobre el mismo diccionario
y la última gana. Además es I/O bloqueante dentro del bucle async.

### 4. No hay identidad

Hoy cualquiera que abra la URL puede borrar un PLC de producción. Con un usuario es
aceptable; con diez es un problema operativo. Cuando llegue el día de **escribir**
valores al PLC, la trazabilidad deja de ser opcional.

### Dos límites duros que conviene saber ahora

- `ConnectionManager.broadcast()` recorre los clientes en un `for` secuencial con
  `await ws.send_json()`. Un cliente lento retrasa a todos los que van detrás. Con 10
  clientes en LAN industrial no se nota; por VPN sí.
- El estado vive en `app.state`, o sea **en la memoria de un proceso**. El servicio
  **debe correr con un solo worker de uvicorn**. Con `--workers 4` cada worker tendría
  sus propios PLCs y sus propios clientes.

---

## 4 · La arquitectura propuesta

**Principio:** si dos personas tienen que verlo igual, vive en el servidor. Si es
preferencia personal (tema, idioma, qué variables marqué), se queda en el navegador.

**Transporte:** reutilizar el `/ws` que ya existe en vez de abrir un segundo socket.
El frontend ya discrimina por `msg.type` y el `ConnectionManager` ya sabe difundir.

```jsonc
// Canal de DATOS (ya existe, alta frecuencia)
{ "type": "snapshot",  ... }
{ "type": "status",    ... }
{ "tag": "...", "value": 24.1, ... }

// Canal de PROYECTO (nuevo, baja frecuencia)
{ "type": "project.updated", "version": 42,
  "por": "jmendoza", "cambio": { "widget": "w_173..." } }
{ "type": "config.updated",  "recurso": "consultas" }
{ "type": "presence",        "usuarios": ["jmendoza", "acastro"] }
{ "type": "lock.changed",    "recurso": "designer", "por": "jmendoza" }
```

Dos decisiones a tomar desde el principio:

- **Difunde el cambio, no el documento.** Al arrastrar un widget se generan decenas de
  eventos por segundo. Manda el widget que cambió, con debounce de ~250 ms mientras se
  arrastra y un envío firme al soltar.
- **Numera las versiones.** Cada guardado incrementa un `version` entero. El cliente
  manda la versión sobre la que editó; si el servidor va por una más alta, responde
  `409` y el cliente recarga.

---

## 5 · Plan por fases

Cada fase deja el sistema utilizable. Puedes parar después de la 2 y ya tendrías lo
que pediste; de la 3 en adelante es lo que hace falta para una planta real.

### Fase 0 — Cerrar las fugas actuales · ~1 día

- `plc_manager.py`: `_bucle_reescaneo()` debe difundir el snapshot igual que `rescan()`.
- `store.py`: envolver `guardar()` en un `asyncio.Lock` y sacar la escritura del bucle
  con `run_in_executor`.
- Persistir la lista de PLCs en `datos/plcs.json` y recargarla en `lifespan()`.

### Fase 1 — El diseño del HMI al servidor · ~3–5 días

**El cambio central. Sin esto, nada de lo que pediste funciona.**

*Backend*

- Nuevo `app/db/project_store.py`, calcado de `DbStore`: escritura atómica, carga
  tolerante a fichero corrupto, contador `version`. Persiste en `datos/proyecto.json`.
- Nuevo `app/api/project_routes.py`:
  - `GET /proyecto` → `{ version, widgets, canvas }`
  - `PUT /proyecto` → reemplaza todo; exige `version`, responde `409` si desactualizada
  - `PATCH /proyecto/widgets/{id}` → un widget; el camino rápido del arrastre
  - `DELETE /proyecto/widgets/{id}`
- Cada mutación termina con `broadcast({"type": "project.updated", ...})`.

*Frontend*

- `designStorage.ts` deja de ser la fuente de verdad y pasa a ser cliente HTTP.
  **Conservar el `localStorage` como caché**: pinta al instante lo último conocido y
  luego reconcilia con el servidor.
- `AppStore.tsx`: `widgets` se hidrata desde `GET /proyecto` y se actualiza al recibir
  `project.updated`. Ignora los eventos cuya `version` sea la que tú acabas de escribir.
- `Designer.tsx`: el `useEffect` que hoy llama a `saveDesign` pasa a mandar el `PATCH`
  con debounce.
- `Preview.tsx` se simplifica: ya no lee `localStorage`.

**Resultado:** el usuario 1 arrastra un widget y el usuario 2 lo ve moverse.

### Fase 2 — Avisar de los cambios de configuración · ~1–2 días

Cada mutación de `db_routes.py` e `historian_routes.py` difunde
`{"type":"config.updated","recurso":"conexiones"|"consultas"|"historicos"}`. El
frontend, al recibirlo, vuelve a pedir la lista correspondiente.

Es deliberadamente tonto: se avisa *qué* cambió, no *cómo*. Con esto se puede quitar
el polling de `/health` cada 5 s, o bajarlo a 30 s como red de seguridad.

### Fase 3 — Identidad y presencia · ~4–6 días

Tres niveles, no hace falta comprarlos todos de golpe:

| Nivel | Qué da | Qué cuesta |
|---|---|---|
| Solo presencia | Cada uno escribe su nombre al entrar. Barra «3 conectados». Eventos con `por: "nombre"` | Medio día |
| Cuentas | `datos/usuarios.json` con hash bcrypt/argon2, cookie o JWT, token en el query string del WS | 2–3 días. Reactivar y renombrar `Login.tsx` |
| Roles | *Visor* (solo `/preview`), *Operador* (+ ver config), *Ingeniero* (+ editar diseño, PLCs, BD). Aplicado en el backend, no solo escondiendo botones | +2 días |

El `ConnectionManager` ya tiene la estructura: guarda un `Dict[WebSocket, filtro]`; se
le agrega un `Dict[WebSocket, usuario]` al lado y la presencia sale casi sola.

### Fase 4 — Concurrencia en el diseñador

| Opción | Qué es | Coste |
|---|---|---|
| **A · Bloqueo de edición** | Un usuario tiene «el lápiz»; el resto lo ve en vivo en modo lectura. Se toma al entrar al Diseñador, se renueva con heartbeat y caduca a los ~30 s de silencio | ~1 día sobre la Fase 1 |
| **B · Último que guarda gana, por widget** | Sin bloqueo. Cada widget lleva su versión; los conflictos reales son raros | Casi gratis si la Fase 1 ya numera versiones |
| **C · Edición colaborativa real** | CRDT (Yjs), cursores de los demás, mezcla automática. Lo que hace Figma | 2–3 semanas + dependencia grande |

**Recomendación: empieza por A.** En un HMI industrial la ambigüedad sobre quién
controla la pantalla no es una molestia de producto, es un riesgo operativo. Que el
sistema diga «Ana está editando» y todos vean el resultado en vivo cubre el 100 % del
caso real, se explica en una frase, y cuesta un día. **C** solo se justifica si varias
personas construyen pantallas al mismo tiempo como trabajo habitual.

### Fase 5 — Escalar más allá de diez · a demanda

- **Broadcast concurrente:** cambiar el `for` secuencial por `asyncio.gather`, o dar a
  cada cliente su cola con descarte de mensajes viejos.
- **Varios procesos:** el día que uvicorn corra con más de un worker, o haya dos
  máquinas, `app.state` deja de servir y hace falta Redis pub/sub. **Hasta entonces,
  un solo worker.**
- **Auditoría:** `datos/auditoria.jsonl` con quién hizo qué y cuándo. Obligatorio el
  día que el HMI escriba valores al PLC.

---

## 6 · Qué archivos se tocan

| Archivo | Qué cambia | Fase |
|---|---|---|
| `app/core/plc_manager.py` | Broadcast en `_bucle_reescaneo()`; persistir PLCs | 0 |
| `app/db/store.py` | `asyncio.Lock` + escritura fuera del bucle async | 0 |
| `app/db/project_store.py` | **Nuevo.** Diseño del HMI versionado en disco | 1 |
| `app/api/project_routes.py` | **Nuevo.** `GET/PUT/PATCH /proyecto` | 1 |
| `app/main.py` | Registrar el router y el store en `lifespan()` | 1 |
| `frontend/src/utils/designStorage.ts` | De `localStorage` a cliente HTTP con caché local | 1 |
| `frontend/src/context/AppStore.tsx` | Hidratar el proyecto; escuchar `project.updated` | 1 |
| `frontend/src/pages/Designer.tsx` | `PATCH` con debounce en vez de `saveDesign` | 1 |
| `frontend/src/services/RealPLCService.ts` | Enrutar los tipos nuevos hacia el store del proyecto | 1 |
| `app/api/db_routes.py` · `historian_routes.py` | Broadcast `config.updated` tras cada mutación | 2 |
| `frontend/src/pages/Configuracion.tsx` | Refrescar por evento en vez de por polling | 2 |
| `app/core/connection_manager.py` | Usuario por socket; presencia; envío concurrente | 3 · 5 |
| `app/api/auth_routes.py` | **Nuevo.** Login, sesión, roles | 3 |
| `frontend/src/pages/Login.tsx` · `App.tsx` | Reactivar como login de usuario; ruta protegida | 3 |

Nada de esto es un rediseño: la mayor parte es un archivo nuevo que copia el patrón de
otro que ya existe, y un puñado de `broadcast()` añadidos donde hoy falta uno.

---

## 7 · Lo que NO hace falta

- **Redis, Kafka o una cola de mensajes.** Con un proceso y diez clientes, el broadcast
  en memoria sobra.
- **Socket.IO o una librería de tiempo real.** El WebSocket nativo hace todo lo que
  hace falta, y la reconexión con reintento ya está en `RealPLCService.ts`.
- **PostgreSQL para el estado de la aplicación.** Los JSON en `datos/` con escritura
  atómica son adecuados a este volumen.
- **CRDT / edición colaborativa.** Ver Fase 4.
- **Cambiar de framework.** FastAPI con un worker, WebSocket y estado en `app.state`
  es sólido para diez usuarios concurrentes.

---

## 8 · Riesgos y decisiones abiertas

1. **¿Un solo HMI o varios?** El plan asume un proyecto compartido. Si distintas áreas
   necesitan pantallas distintas, `datos/proyecto.json` debe ser
   `datos/proyectos/<id>.json` desde el primer día. Cambiarlo después cuesta mucho más.
2. **¿Qué es preferencia y qué es configuración?** Tema e idioma son personales. La
   selección de variables es ambigua: si es «qué me interesa mirar», es personal; si es
   «qué se historiza», es global.
3. **Punto único de fallo.** Un backend caído deja a los diez usuarios sin nada. Vale
   la pena un servicio de Windows con reinicio automático.
4. **Escritura al PLC.** El `/ws` es de solo lectura hoy y eso simplifica mucho. Cuando
   el HMI escriba valores, multiusuario pasa a exigir identidad, permisos y auditoría
   obligatorias.
5. **Secretos.** `datos/.clave` protege contraseñas de BD frente a lecturas casuales.
   Con cuentas aparecen hashes y tokens de sesión, que son otro tipo de secreto y no
   deberían compartir fichero ni ciclo de vida.

---

**En una frase:** tu backend ya es multiusuario, tu frontend todavía no. La Fase 1
—mover el diseño del HMI de `localStorage` al servidor— es el 80 % del valor de lo que
pediste.
