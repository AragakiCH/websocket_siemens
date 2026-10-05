# Rexroth ctrlX por el Data Layer (sin OPC UA) · 21 sep 2026

> Port a `websocket_siemens` de la conexión que ya funcionaba en
> `WebSocket_RX` (`datalayer/auth.py`, `client.py`, `reader.py`,
> `plc/discovery.probe_auth`). Ahora un PLC `vendor=rexroth` habla con el
> ctrlX CORE por su **API REST del Data Layer (HTTPS)**, no por OPC UA.

## Qué cambia para quien lo usa

| Antes (OPC UA) | Ahora (Data Layer) |
|---|---|
| Puerto 4840 | Puerto **443** (8443 en COREvirtual con port-forwarding) |
| Había que **aceptar el certificado** del cliente en el ctrlX (Settings → Certificates & Keys) o daba 401 | Nada que aceptar: login con usuario/contraseña → **JWT** |
| Cascada de políticas de seguridad al conectar | Un POST al identity-manager |
| `node_id` = NodeId OPC UA (cambiaba entre reinicios) | `node_id` = **ruta del Data Layer** (`plc/app/Application/sym/PLC_PRG/temperatura`), estable |
| Subscription OPC UA → polling | **SSE** (`/automation/api/v2/events`) → polling en bloque |

La pantalla de alta, los widgets, el historizador, las alarmas y la
escritura no cambian: el driver cumple la misma interfaz `PlcDriver`.

## Lo que se trajo de WebSocket_RX

`app/drivers/ctrlx_datalayer_driver.py`, todo async sobre `httpx`:

- **`SesionCtrlx`** ← `DatalayerAuth`: `POST /identity-manager/api/v2/auth/token`
  `{name, password}`; refresco con `refresh_token` 30 s antes de caducar y,
  si el refresh falla, login limpio. Distingue **credenciales malas**
  (`ErrorCredenciales`, 400/401/403) de **equipo caído** (`ConnectionError`).
- **`ClienteDatalayer`** ← `DatalayerClient`: browse (`?type=browse`),
  lectura en bloque `PUT /automation/api/v2/bulk?type=read` probando las
  variantes de body que aceptan los distintos firmwares (`list_address`,
  `list_node`, `dict_nodes`…) y recordando la que funcione; si ninguna,
  lecturas individuales en paralelo. Respeta el `result` de cada elemento
  (`DL_OK` / `DL_PERMISSION_DENIED` / `DL_INVALID_ADDRESS`).
- **`CtrlxDatalayerDriver`** ← `DatalayerReader`: autodetección de app y
  programa (`plc/app/<app>/sym/<programa>`), snapshot inicial, **SSE** con
  parseo de `event: error` / `keepalive`, eventos en lista, `node` con barra
  inicial y `value` anidado; **fallback a polling** si el SSE no entrega
  nada en `PLC_REXROTH_SUBSCRIPTION_GRACE_S` o el firmware responde 404;
  reintento con backoff si el stream se corta. El polling solo emite cambios.
- **`probar_credenciales()`** ← `probe_auth`: `OK | AUTH_INVALID | DOWN`.
- Mapas de tipos `bool8→BOOL`, `double→LREAL`… y la inversa para escribir.

Lo que NO se trajo: el discovery por barrido de subred (ARP + /24 + gateways)
y el buffer/Excel propios de RX, porque aquí ya existen sus equivalentes.

## Configuración

```ini
# .env
PLC_REXROTH_TRANSPORTE=datalayer   # defecto. 'opcua' vuelve al driver anterior
PLC_REXROTH_HTTPS_PORT=443         # 8443 en COREvirtual
PLC_REXROTH_VERIFY_SSL=false       # el ctrlX trae certificado autofirmado
PLC_REXROTH_BULK_MAX=200
PLC_REXROTH_SAMPLING_INTERVAL_MS=100   # publishIntervalMs del SSE
PLC_REXROTH_SUBSCRIPTION_GRACE_S=5.0   # sin datos en este tiempo -> polling
PLC_REXROTH_POLL_INTERVAL_MS=100
PLC_REXROTH_FORCE_POLLING=false
```

El driver OPC UA (`rexroth_driver.py`) sigue en el repositorio y se activa con
`PLC_REXROTH_TRANSPORTE=opcua`. Un PLC dado de alta antes con
`opc.tcp://host:4840` sigue funcionando: el driver nuevo ignora el 4840 y usa
`PLC_REXROTH_HTTPS_PORT`.

## API

- `POST /rexroth/apps` y `POST /rexroth/programs`: mismos cuerpos que antes;
  ahora responden `"transporte": "datalayer"` y `"endpoint": "https://…:443"`.
  **401** = usuario/contraseña incorrectos; **502** = el ctrlX no responde;
  **404** = conectó pero no hay símbolos publicados.
- `POST /plcs` con `vendor=rexroth`: el endpoint guardado es `https://host:443`.

## Escritura

`write_tag` convierte con `escritura.convertir` (misma regla que Siemens:
nunca adivina) y hace `PUT /automation/api/v2/nodes/<ruta>` con
`{type: <tipo DL>, value}`, luego relee. Un 401/403 del ctrlX se traduce a
"el usuario no tiene permiso de escritura en la gestión de accesos del ctrlX".

## Probado

Contra un ctrlX simulado (identity-manager, browse, bulk con y sin soporte de
`list_address`, SSE con keepalive/error/lista, PUT): login y refresco,
autodetección de app/programa, snapshot + SSE, caída a polling con 404,
lectura en bloque con `None` para nodos inexistentes, escritura con
conversión de tipos y rechazo de tipos inválidos, y las rutas
`/rexroth/apps`, `/rexroth/programs` y `POST /plcs` de punta a punta
(`/tags` publica `PLC_PRG.*`, `/health` marca el PLC conectado).

## Ficheros

```
app/drivers/ctrlx_datalayer_driver.py   NUEVO · el driver
app/config/settings.py                  rexroth_transporte, _https_port, _verify_ssl, _bulk_max
app/core/plc_manager.py                 elige driver por transporte; endpoint https://
app/api/rest_routes.py                  /rexroth/apps y /programs por Data Layer
frontend: PlcConnect.tsx, Configuracion.tsx, rexrothApi.ts, i18n  puerto 443
.env.example                            documentación de las variables
```
