# Siemens S7-1200 (y 300/400) por S7comm · 22 sep 2026

> Por qué un S7-1200 salía «Desconectado» y «Siemens S7-1500», y qué se
> cambió para que conecte y se llame por su nombre.

## Lo que pasaba

El driver Siemens hablaba **solo OPC UA** (puerto 4840). Un S7-1500 lo tiene
siempre; un **S7-1200 solo desde FW 4.4**, y además hay que **activarlo** en
TIA (Propiedades → OPC UA → Servidor) y tener la licencia *SIMATIC OPC UA
S7-1200 Basic*. Un S7-300/400 no lo tiene nunca. Así que el CPU 1214C
respondía al ping (ICMP) pero rechazaba el 4840, y la vista lo mostraba como
«Desconectado» sin decir por qué. Y «S7-1500» era una etiqueta fija de la
vista, no algo leído del PLC.

## Lo que hay ahora

**Identificar** (botón en Agregar PLC → Siemens, `POST /siemens/identificar`).
Pregunta la identidad de la CPU por **S7comm (puerto 102)** —que responde en
cualquier S7 con el puerto abierto, tenga o no OPC UA— y comprueba si hay
algo en el 4840. Devuelve modelo, familia, nombre del proyecto, estado
RUN/STOP y el transporte sugerido, y la vista lo preselecciona:

| Caso | Sugerencia |
|---|---|
| Responde en el 4840 | OPC UA (descubre los DB solo) |
| S7-1200 y el 4840 cerrado | S7comm, con el aviso de FW ≥ 4.4 / activar servidor |
| S7-300/400 | S7comm |

**Driver S7comm** (`app/drivers/s7comm_driver.py`, `python-snap7` ≥ 3, Python
puro). Cumple `PlcDriver` como los demás, así que widgets, historizador,
alarmas y escritura no cambian.

| | |
|---|---|
| Conexión | `ip`, rack/slot (0/1 en 1200 y 1500, 0/2 en 300), puerto 102. Lee el modelo de la CPU (`CPU 1214C DC/DC/Rly`) |
| Tags | S7comm no los descubre (lee bytes por dirección), pero **TIA los exporta**: en el alta se arrastran los ficheros de *Generate source from blocks* (`.db`, `.udt`) y `app/drivers/s7_fuentes.py` calcula el offset de cada variable con las reglas de acceso estándar (BOOL a bit, 1 byte al siguiente byte, ≥2 bytes en byte par, STRING n+2, ARRAY/STRUCT en par y rellenos a par). `POST /siemens/importar` además **sondea el PLC** (qué DB existen y de qué tamaño, por búsqueda binaria sobre `db_read`) y empareja cada bloque con su número: por el nombre (`Data_block_1` → DB1) o por tamaño único. Un DB optimizado sale marcado y no se agrega. Queda un modo «escribir a mano» (`nombre;DB1;offset;TIPO`) para casos raros. Tipos: BOOL, BYTE, CHAR, SINT, USINT, WORD, INT, UINT, DWORD, DINT, UDINT, REAL, TIME, LWORD, LINT, ULINT, LREAL, STRING[n]; DTL/DT/WSTRING se saltan reservando su sitio |
| `node_id` | La dirección absoluta (`DB1.DBD0`, `DB1.DBX4.0`) |
| Lectura | Un `db_read` por DB, del primer al último byte usado, y se decodifica cada tag. **Polling** (S7comm no tiene subscription), solo se emiten cambios |
| Escritura | `convertir()` → `db_write` de los bytes del tag. Un BOOL hace lectura-modificación-escritura de su byte: los bits vecinos no se tocan |
| Diagnóstico | La primera lectura se hace en el alta: si un DB tiene acceso optimizado o PUT/GET está cerrado, el error dice qué marcar en TIA en vez de dejar un PLC «conectado» sin datos |

**En TIA Portal**, imprescindible para S7comm (en un 1200 V3.x el punto 1 no existe: PUT/GET está siempre abierto):
1. CPU → Protección y seguridad → Mecanismos de conexión → ☑ *Permitir acceso vía comunicación PUT/GET*.
2. En cada DB a leer: Propiedades → Atributos → ☐ *Acceso optimizado al bloque* (desmarcado). Sin esto el DB no tiene offsets y el PLC responde «Object does not exist».
3. Compilar y cargar. El offset de cada variable sale de la columna «Offset» del editor del DB.

**La vista** ya no dice «S7-1500» por defecto: el grupo es «Siemens S7», el
panel muestra el **Modelo** leído del PLC (también por OPC UA, desde las
propiedades `Model`/`OrderNumber` del nodo del PLC) y, si está desconectado,
el **último error** del driver. Un fallo al abrir el 4840 en un 1200 ahora
dice que probablemente no hay servidor OPC UA y que se use Identificar.

## Configuración

```ini
PLC_SIEMENS_TRANSPORTE=opcua      # o s7comm
PLC_S7_RACK=0
PLC_S7_SLOT=1
PLC_S7_POLL_INTERVAL_MS=250
PLC_S7_TAGS=...                   # solo para arranque automático; lo normal es la vista
```

Cada PLC guarda su transporte, rack/slot y su lista de tags en `plcs.json`
(endpoint `s7://ip:102/rack/slot`).

## Probado

Contra el servidor snap7 de pruebas: identificación (modelo, familia,
estado), transporte sugerido, parseo de la lista (errores con número de
línea), snapshot, polling solo con cambios, escritura DINT/BOOL (bit vecino
intacto)/STRING, rechazo de tipo inválido, DB inexistente con mensaje de
PUT/GET, y de punta a punta `/siemens/identificar` → `POST /plcs` → `/tags`
→ `/health` con modelo, más la persistencia en `plcs.json`.

## Ficheros

```
app/drivers/s7comm_driver.py       NUEVO · driver + identificar()
app/drivers/opcua_driver.py        modelo por OPC UA; error claro si el 4840 no abre
app/core/subscription_handler.py   health: modelo, ultimo_error
app/api/rest_routes.py             /siemens/identificar; transporte/rack/s7_tags en POST /plcs
app/core/plc_manager.py · plc_discovery.py · plc_store.py · settings.py
frontend: Configuracion.tsx, models/plc.ts, i18n
requirements*.txt, desktop/psi_core.spec   python-snap7
```
