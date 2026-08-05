# Contrato de API — para el frontend

Referencia rápida de todo lo que el frontend puede pedirle al backend.
Documentación interactiva (probar en vivo): **http://localhost:8000/docs**

- **Base URL**: en desarrollo las rutas son relativas (el proxy de Vite reenvía
  al puerto 8000); en producción las sirve el propio FastAPI. Usar siempre
  rutas relativas: `fetch('/plcs')`, no `http://localhost:8000/plcs`.
- Todos los `POST` llevan `Content-Type: application/json`.
- Regla general: **las acciones son REST, los datos en vivo llegan por WebSocket.**

---

## 1. Alta de PLCs

### `POST /plcs` — agregar un PLC

Da de alta un PLC en caliente. Responde de inmediato; la conexión se intenta en
segundo plano con reintentos. Todos los clientes WebSocket reciben un snapshot
actualizado.

**Siemens S7-1500** (anónimo):

```json
{ "host": "192.168.50.1", "puerto": 4840, "vendor": "siemens" }
```

**Rexroth ctrlX CORE** (siempre con credenciales):

```json
{
  "host": "192.168.100.31",
  "puerto": 4840,
  "vendor": "rexroth",
  "usuario": "boschrexroth",
  "password": "boschrexroth",
  "programa": "PLC_PRG"
}
```

`app` no se manda: se autodetecta. `programa` es el que el usuario eligió en
`POST /rexroth/programs` (ver sección 2).

| Campo | Tipo | Obligatorio | Notas |
|---|---|---|---|
| `host` | string | sí | IP, hostname o endpoint `opc.tcp://host:puerto` completo |
| `puerto` | number | no (4840) | Se ignora si `host` ya es un endpoint completo |
| `vendor` | `"siemens"` \| `"rexroth"` | no (`siemens`) | Determina el driver |
| `usuario` / `password` | string | solo Rexroth | El ctrlX no admite sesiones anónimas |
| `app` | string | **no** | Vacío = se autodetecta (lo normal) |
| `programa` | string | recomendado | El que eligió el usuario en `/rexroth/programs`. Vacío = toma el primero |

**Respuesta**

```json
{ "ok": true, "plc_id": "192.168.50.1",
  "endpoint": "opc.tcp://192.168.50.1:4840",
  "mensaje": "PLC 192.168.50.1 añadido; conectando..." }
```

Si ya existía: `ok: false` con el `plc_id` del que ya está gestionado. Conviene
mostrar siempre `mensaje` al usuario.

### `DELETE /plcs/{plc_id}` — quitar un PLC

Detiene su conexión y lo elimina. No hace falta refrescar a mano: llega un
mensaje `plc_removed` por WebSocket.

```json
{ "ok": true, "plc_id": "192.168.50.1", "mensaje": "PLC 192.168.50.1 eliminado." }
```

### `POST /discover` — escanear la red

Sin cuerpo. Escanea la subred configurada y añade los PLCs Siemens nuevos que
respondan. Puede tardar varios segundos → conviene un estado de "cargando".

```json
{ "ok": true, "encontrados": 2, "nuevos": ["PLC_2"],
  "mensaje": "1 PLC(s) nuevo(s) añadido(s)." }
```

---

## 2. Descubrimiento de un ctrlX (solo Rexroth)

Flujo de **dos pasos**: primero se listan los programas para que el usuario
elija, luego se da de alta el PLC con el elegido.

La **app se resuelve sola** (`Datalayer/plc/app/<app>`): casi siempre hay una
única `Application`, así que no se pide al usuario. El **programa sí se elige**,
porque bajo `sym` puede haber varios.

### Paso 1 — `POST /rexroth/programs`

Solo credenciales; **no** hace falta mandar `app`:

```json
{
  "host": "192.168.100.31",
  "puerto": 4840,
  "usuario": "boschrexroth",
  "password": "boschrexroth"
}
```

Respuesta — con esto se llena el desplegable:

```json
{
  "ok": true,
  "endpoint": "opc.tcp://192.168.100.31:4840",
  "app": "Application",
  "programas": ["PLC_PRG", "MotionProg"]
}
```

Abre una sesión temporal y la cierra: no registra el PLC.

### Paso 2 — `POST /plcs` con el programa elegido

```json
{
  "host": "192.168.100.31",
  "vendor": "rexroth",
  "usuario": "boschrexroth",
  "password": "boschrexroth",
  "programa": "PLC_PRG"
}
```

`app` sigue sin mandarse: se autodetecta al conectar.

### `POST /rexroth/apps` (opcional)

Solo si el ctrlX tuviera varias apps y quisieras mostrarlas. Mismo cuerpo que
el paso 1 → `{ "ok": true, "apps": ["Application"] }`. En el flujo normal **no
se usa**: llamarlo de más solo añade otro handshake OPC UA (lento).

**Errores a manejar en la UI:**

| Código | Significado | Qué mostrar |
|---|---|---|
| 401 | Credenciales inválidas **o certificado no aceptado** | "Revisa usuario/contraseña y confía el certificado en la web del ctrlX (Settings → Certificates & Keys)" |
| 404 | Conectó, pero no hay símbolos publicados | "Publica el proyecto desde la configuración de símbolos en ctrlX WORKS" |

> **Rendimiento:** cada llamada a `/rexroth/*` abre una sesión OPC UA nueva y
> prueba la cascada de seguridad, lo que puede tardar varios segundos. Por eso
> el flujo es de dos pasos y no de tres: conviene mostrar un *loading* y no
> encadenar llamadas innecesarias.

---

## 3. Consultas

| Endpoint | Devuelve |
|---|---|
| `GET /plcs` | `{ "plcs": ["PLC_2", "192.168.1.1"] }` — ids gestionados |
| `GET /health` | Estado de cada PLC: `conectado`, `estado_conexion`, `num_tags`, `clientes_ws` |
| `GET /tags?plc=<id>` | Tags con su último valor (`plc` es opcional) |
| `GET /browse?plc=<id>` | Árbol de tags agrupado por Data Block / programa |

El `plc_id` que devuelve `GET /plcs` es la clave para `?plc=` en todos lados,
incluido el WebSocket.

---

## 4. WebSocket `/ws` — datos en vivo

```ts
const proto = location.protocol === 'https:' ? 'wss' : 'ws';
const ws = new WebSocket(`${proto}://${location.host}/ws`);
// filtrado por PLC:  .../ws?plc=192.168.50.1
ws.onmessage = (e) => procesar(JSON.parse(e.data));
```

Es un canal de **solo lectura**: el cliente no envía nada (las acciones van por
REST). Conviene reconectar solo cada ~3 s si se cierra.

### Mensajes que envía el servidor

**1. `snapshot`** — al conectarte, y cada vez que se agrega un PLC:

```json
{ "type": "snapshot", "timestamp": "2026-07-16T04:14:11+00:00",
  "plcs": { "PLC_2": { "nombre": "PLC_2", "endpoint": "opc.tcp://192.168.50.1:4840",
                       "estado": "conectado", "conectado": true,
                       "sampling_interval_ms": 100, "publishing_interval_ms": 100 } },
  "tags": { "PLC_2|DB_snap7.temperatura": { "plc": "PLC_2", "tag": "DB_snap7.temperatura",
            "value": 53.09, "type": "Float", "timestamp": "...", "delta_ms": 512 } } }
```

La clave de `tags` es **`"<plc_id>|<tag>"`** — así no colisionan tags con el
mismo nombre en PLCs distintos.

**2. Cambio de valor** (sin campo `type` de mensaje; aquí `type` es el TIPO DE DATO):

```json
{ "timestamp": "...", "plc": "PLC_2", "tag": "DB_snap7.temperatura",
  "value": 49.36, "type": "Float",
  "source_ts": "...", "server_ts": "...", "delta_ms": 480 }
```

> Distinguir así: si el mensaje trae `tag`, es un cambio de valor; si trae
> `type` con valor `"snapshot"`, `"status"` o `"plc_removed"`, es de control.

**3. `status`** — cambió el estado de conexión de un PLC:

```json
{ "type": "status", "plc": "PLC_2", "status": "conectado", "timestamp": "..." }
```

`status`: `"conectado"` | `"reconectando"`.

**4. `plc_removed`** — alguien quitó un PLC (desde cualquier cliente):

```json
{ "type": "plc_removed", "plc_removed": "PLC_2", "timestamp": "..." }
```

Hay que limpiar ese PLC y sus tags del estado local.

### Tipos de dato (`type`) y su equivalente en el frontend

| OPC UA | Frontend | Ojo |
|---|---|---|
| `Boolean` | `bool` | |
| `Float`, `Double`, `Real`, `LReal` | `double` | |
| `Int16`, `Int32`, `UInt16`, `Byte`, `Word`, `SInt` | `int` | |
| `String` | `string` | **No pasar por `Number()`** → daría `NaN` |

---

## 5. Notas de rendimiento

- El mínimo real de refresco por OPC UA es **~100 ms** (límite del servidor del
  S7-1500, no del backend). Pedir 1–10 ms no es posible por este protocolo.
- La frecuencia que elige el usuario en la vista es un **throttle de
  re-render**, no la velocidad de adquisición: los datos llegan cuando el PLC
  los publica.
- El backend mantiene **una sola sesión OPC UA por PLC** sin importar cuántos
  clientes web haya conectados.
