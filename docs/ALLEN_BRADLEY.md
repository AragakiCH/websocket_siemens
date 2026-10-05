# Allen-Bradley por EtherNet/IP · 21 sep 2026

> Tercer driver de PLC: ControlLogix, CompactLogix, GuardLogix y Micro800 por
> **EtherNet/IP (CIP explicit messaging, TCP 44818)** con `pycomm3`. Cumple la
> misma interfaz `PlcDriver` que Siemens y Rexroth, así que el resto —
> SubscriptionHandler, WebSocket, widgets, historizador, alarmas, escritura —
> no cambia.

## Cómo se da de alta

Configuración → Agregar PLC → pestaña **Allen-Bradley**: IP y **slot del
procesador** (0 en CompactLogix y Micro800; en ControlLogix, el del módulo
CPU en el chasis). El botón **Identificar** abre una sesión CIP temporal y
dice qué hay ahí: modelo, revisión, nombre del proyecto y posición del
selector. No hay usuario ni contraseña: EtherNet/IP no autentica.

```
POST /allenbradley/identificar  {"host": "192.168.1.10", "slot": 0}
POST /plcs                      {"host": "192.168.1.10", "vendor": "allenbradley", "slot": 0}
```

El endpoint guardado es `enip://192.168.1.10:44818/0` (el `/0` es el slot).

## Qué hace el driver (`app/drivers/ethernetip_driver.py`)

| | |
|---|---|
| Conexión | `LogixDriver("ip/slot")`. pycomm3 es síncrono: cada llamada va al executor con un lock por PLC, para no frenar el bucle que mueve los WebSockets |
| Tags | Upload de la lista del controlador (controller-scoped y `Program:` scoped) y de sus UDT. Las estructuras (UDT, TIMER, COUNTER…) se **aplanan** miembro a miembro (`T1.PRE`, `Motor.Velocidad`) y los arrays elemento a elemento (`Temps[3]`), con topes en `.env`. Fuera los tags del sistema (`__`, `Map:`…), los `External Access = None` y los miembros privados (`CTL`, `ZZZZ…`) |
| `node_id` | El nombre completo de Logix, tal cual lo lee y escribe pycomm3 |
| Tipos | Los de Logix (BOOL, DINT, REAL, LREAL, STRING…) coinciden con el IEC que ya entienden `escritura.convertir` y el frontend |
| Tiempo real | **Polling** en bloque (multi-service packet, `PLC_AB_BULK_MAX` tags por petición) cada `PLC_AB_POLL_INTERVAL_MS`; primera pasada = snapshot, después solo lo que cambia. Tres lecturas fallidas seguidas → se marca desconectado y el handler reconecta |
| Watchdog | `get_plc_info()` (identidad CIP) |
| Escritura | `convertir()` (un `'hola'` en un DINT falla antes de salir) → CIP Write Tag → relectura. Si el PLC rechaza, el mensaje dice lo que suele ser: selector en **RUN** (solo REMOTE RUN/PROGRAM admiten escritura externa) o tag con **External Access = Read Only** |

## Configuración

```ini
PLC_AB_SLOT=0
PLC_AB_MICRO800=false
PLC_AB_CONNECT_TIMEOUT=5.0
PLC_AB_POLL_INTERVAL_MS=250
PLC_AB_BULK_MAX=100
PLC_AB_INCLUIR_PROGRAMAS=true
PLC_AB_BROWSE_DEPTH=3
PLC_AB_MAX_ELEMENTOS_ARRAY=64
PLC_AB_TAGS=                # lista manual: solo esos tags
```

## Probado

Contra un Logix simulado con la forma exacta de `pycomm3.get_tag_list()`:
tags atómicos, `STRING`, `REAL[3]`, un `TIMER` (con su `CTL` privado fuera y
`PRE/ACC/EN/DN` dentro), `Program:Main.Ciclos`, un tag `External Access =
None` y uno `Read Only`. Identificación, browse, snapshot + polling solo con
cambios, lectura en bloque con `None` para el inexistente, escritura con
conversión (`'42'` → DINT 42, `'true'` → BOOL) y rechazo de tipo inválido y de
Read Only. Y de punta a punta con la app: `/allenbradley/identificar`,
`POST /plcs`, `/tags` con los tags aplanados, `/health` conectado, slot
persistido en `plcs.json`.

Falta la prueba con hardware real. Dos cosas a mirar si no conecta: que el
slot sea el del procesador (un slot vacío responde "Path segment error") y
que no haya un firewall en el 44818.

## Ficheros

```
app/drivers/ethernetip_driver.py     NUEVO · el driver + identificar()/probar()
app/config/settings.py               PLC_AB_*
app/core/plc_discovery.py            EndpointPlc.slot
app/core/plc_store.py                persiste slot
app/core/plc_manager.py              vendor 'allenbradley', endpoint enip://
app/api/rest_routes.py               /allenbradley/identificar; slot en POST /plcs
desktop/psi_core.spec                hiddenimports: pycomm3 y los drivers
requirements*.txt                    pycomm3
frontend: models/plc.ts, Configuracion.tsx, i18n
```
