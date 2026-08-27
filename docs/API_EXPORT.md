# Exportar a Excel — contrato para el frontend

Cómo sacar los datos de los PLCs a un `.xlsx` ordenado, desde dos fuentes.
Documentación interactiva: **http://localhost:8000/docs** → sección *Exportar a Excel*.

---

## Las dos fuentes

```
   ┌─────────────────────────────────────────────────────────────────┐
   │  EN VIVO                          │  DESDE LA BASE DE DATOS      │
   ├───────────────────────────────────┼──────────────────────────────┤
   │  POST /export/grabaciones         │  GET /export/historico/excel │
   │  (muestrea cada N ms)             │  (lo que guardó el           │
   │           ↓                       │   historizador)              │
   │  GET .../{id}/excel               │           ↓                  │
   │           ↓                       │      descarga directa        │
   │      descarga                     │                              │
   ├───────────────────────────────────┼──────────────────────────────┤
   │  Un ensayo, un arranque,          │  Cualquier periodo pasado,   │
   │  una incidencia concreta          │  incluso de hace meses       │
   │  Vive en memoria (temporal)       │  Permanente                  │
   └───────────────────────────────────┴──────────────────────────────┘
```

**Las dos producen el mismo formato de Excel**, así que quien lo abre no tiene
que aprender dos cosas.

---

## Estructura del fichero generado

| Hoja | Contenido |
|---|---|
| **Información** | Origen, PLCs, variables, rango de fechas, intervalo de muestreo, nº de filas, fecha de generación |
| **Datos** | **Pivotado**: una fila por instante, una columna por variable |
| **Estadísticas** | Mín, máx, media, desviación típica, nº de muestras, primer y último valor de cada variable |
| **Tendencia** | Gráfico de líneas de las variables numéricas |

**Por qué pivotado** y no el formato estrecho de la base de datos: quien abre un
Excel casi siempre quiere graficar o hacer una tabla dinámica, y para eso
necesita una columna por variable. El formato estrecho (`ts, tag, valor`) es
excelente para almacenar y pésimo para analizar a mano.

Detalles del formato:

- Fechas como fecha real de Excel (`yyyy-mm-dd hh:mm:ss`), no texto → se pueden
  usar en gráficos y filtros directamente.
- Booleanos como `ON` / `OFF`, no `TRUE` / `FALSE`.
- Cabecera congelada, autofiltro y bandas alternas.
- Si dos PLCs tienen un tag con el mismo nombre, la columna se prefija
  (`192.168.50.1 | temperatura`) para que no se pisen.

---

## 1. Grabación en vivo

### Paso 1 — `GET /export/tags`

Lista lo que se puede grabar, con la **clave compuesta** ya montada:

```json
{
  "num_tags": 2,
  "tags": [
    { "clave": "192.168.50.1|DB_snap7.temperatura", "plc": "192.168.50.1",
      "tag": "DB_snap7.temperatura", "tipo": "Float", "valor_actual": 53.09 },
    { "clave": "192.168.100.31|PLC_PRG.AI_Sensor_mA", "plc": "192.168.100.31",
      "tag": "PLC_PRG.AI_Sensor_mA", "tipo": "REAL", "valor_actual": 8.09 }
  ]
}
```

El campo `clave` es lo que se manda en el paso 2.

### Paso 2 — `POST /export/grabaciones`

```json
{
  "grabacion_id": "ensayo_arranque",
  "nombre": "Ensayo de arranque",
  "tags": [
    "192.168.50.1|DB_snap7.temperatura",
    "192.168.50.1|DB_snap7.presion",
    "192.168.100.31|PLC_PRG.AI_Sensor_mA"
  ],
  "intervalo_ms": 1000,
  "duracion_s": 60
}
```

| Campo | Obligatorio | Notas |
|---|---|---|
| `grabacion_id` | sí | Identificador de la grabación |
| `tags` | no | Vacío = **todos** los tags disponibles |
| `intervalo_ms` | no (`1000`) | Mínimo **100 ms** |
| `duracion_s` | no (`60`) | **0 = indefinida**, hasta llamar a `/stop` |
| `nombre` | no | Sale en la hoja Información |

Si mandas un tag que no existe, responde igual pero avisa:

```json
{ "ok": true, "grabacion_id": "ensayo_arranque",
  "tags_desconocidos": ["192.168.50.1|DB.noexiste"],
  "mensaje": "Grabación 'ensayo_arranque' en curso. Aviso: 1 tag(s) no existen ahora mismo y saldrán vacíos." }
```

Es deliberado: una errata en la clave produciría un Excel vacío sin explicación.

### Paso 3 — seguir el progreso

`GET /export/grabaciones/{id}` devuelve, entre otros:

```json
{ "estado": "grabando", "segundos_transcurridos": 23.4,
  "segundos_restantes": 36.6, "num_muestras": 23, "descargable": true }
```

Con `segundos_transcurridos` / `duracion_s` sale la barra de progreso.
`estado` es `grabando`, `terminada` o `detenida`.

### Paso 4 — `GET /export/grabaciones/{id}/excel`

Descarga directa. Se puede llamar **con la grabación aún en curso**: exporta lo
capturado hasta ese momento.

```js
const r = await fetch(`/export/grabaciones/${id}/excel`);
if (!r.ok) { /* 404: no existe o no tiene muestras */ }
const blob = await r.blob();
// El nombre real viene en la cabecera (ya expuesta por CORS)
const cd = r.headers.get('Content-Disposition') || '';
const nombre = /filename="([^"]+)"/.exec(cd)?.[1] ?? 'datos.xlsx';
const url = URL.createObjectURL(blob);
Object.assign(document.createElement('a'), { href: url, download: nombre }).click();
URL.revokeObjectURL(url);
```

### Resto de endpoints

| Endpoint | Para qué |
|---|---|
| `GET /export/grabaciones` | Listar todas con su estado |
| `POST /export/grabaciones/{id}/stop` | Parar antes de tiempo (los datos se conservan) |
| `DELETE /export/grabaciones/{id}` | Borrar y **liberar memoria** |

> Conviene borrar la grabación tras descargar el Excel: las muestras viven en
> memoria del servidor. El tope es 200.000 muestras por grabación; al llegar,
> se cierra sola y lo indica en `motivo_fin`.

### ¿Por qué muestreo a intervalo fijo?

Porque es lo que hace que el Excel salga **ordenado**. Si se guardara cada
cambio, cada variable tendría marcas de tiempo distintas y la tabla quedaría
llena de huecos:

```
        MAL (cada cambio)                  BIEN (muestreo a la vez)
   ts        temp   presion            ts        temp   presion
   10:00:01  50.2   —                  10:00:01  50.2   90.1
   10:00:01  —      90.1               10:00:02  50.8   89.9
   10:00:02  50.8   —                  10:00:03  51.1   89.7
```

Muestreando todas a la vez comparten fila, y el gráfico sale limpio.

---

## 2. Exportar desde la base de datos

### `GET /export/historico/excel`

Exporta lo que ya guardó el **historizador** (ver `docs/API_DB.md`, sección 4):

```
GET /export/historico/excel?grupo_id=proceso
GET /export/historico/excel?grupo_id=proceso&tag=DB_snap7.temperatura
    &desde=2026-07-30T00:00:00&hasta=2026-07-30T23:59:59&limite=20000
```

| Parámetro | Obligatorio | Notas |
|---|---|---|
| `grupo_id` | sí | Grupo de historización (de `GET /historian`) |
| `tag` | no | Un tag concreto, **sin** el prefijo del PLC |
| `desde` / `hasta` | no | ISO 8601. Acepta `T` o espacio como separador |
| `limite` | no (`10000`) | Máximo de registros leídos (tope 100.000) |

A diferencia de la grabación (temporal, en memoria), aquí se puede exportar
cualquier periodo pasado.

### `POST /export/consultas/{query_id}/excel`

Exporta el resultado de una consulta guardada. Sirve para dar un botón
"Exportar" a **cualquier** widget de datos:

```json
POST /export/consultas/piezas_por_maquina/excel
{ "desde": "2026-07-01" }
```

Si el resultado tiene columnas `ts` y `tag` se pivota igual que el resto; si es
una tabla cualquiera (ej. "piezas por máquina"), se vuelca tal cual — pivotar
ahí no tendría sentido.

---

## 3. Errores

Las descargas devuelven **404 con JSON** cuando no hay nada que exportar:

| Situación | Respuesta |
|---|---|
| La grabación no existe | `{"ok": false, "mensaje": "No existe la grabación 'x'."}` |
| Grabación sin muestras todavía | `{"ok": false, "mensaje": "La grabación todavía no tiene muestras."}` |
| Grupo de histórico inexistente | `{"ok": false, "mensaje": "No existe el grupo 'x'."}` |
| Rango sin datos | `{"ok": false, "mensaje": "No hay datos historizados en ese rango."}` |
| Fecha mal formada | `{"ok": false, "mensaje": "Fecha 'desde' no válida: 'ayer'. Usa ISO 8601..."}` |

En el frontend conviene comprobar `r.ok` antes de tratar la respuesta como
blob: si es 404, el cuerpo es JSON con el mensaje a mostrar.

---

## 4. Notas de implementación

- **No se abre ninguna conexión extra al PLC.** El grabador se engancha como
  observador del `ConnectionManager`, igual que el historizador: usa el mismo
  flujo que alimenta el WebSocket.
- El fichero se genera **en memoria** y viaja directo al navegador; no queda
  basura en el servidor.
- El intervalo mínimo es 100 ms porque es el mínimo real del servidor OPC UA
  del S7-1500. Pedir menos solo generaría filas repetidas.
- Tope de 500.000 filas por fichero (Excel admite ~1 millón, pero abrirlo sería
  inviable). Si se supera, se conservan las más recientes.
- El gráfico dibuja como mucho 15 series; con más, se indica en la hoja.
- Archivos: `app/export/excel.py` (construcción del .xlsx),
  `app/export/grabador.py` (grabaciones), `app/api/export_routes.py` (endpoints).
- Dependencia: `openpyxl`.
