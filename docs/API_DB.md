# Bases de datos — contrato para los widgets

Cómo un widget del HMI muestra datos de una base de datos.
Documentación interactiva: **http://localhost:8000/docs** → sección *Bases de datos*.

Motores soportados: **PostgreSQL**, **MySQL/MariaDB**, **SQL Server** y **SQLite**
(un solo driver interno vía SQLAlchemy async; añadir MongoDB en el futuro no
cambia nada de este contrato).

---

## Idea central: el widget NUNCA manda SQL

```
   DISEÑADOR (una vez)                      OPERARIO (en producción)
   ────────────────────                     ────────────────────────
   1. POST /db            → conexión        4. POST /db/queries/{id}/run
   2. POST /db/{id}/preview → probar SQL       { "parametros": {...} }
   3. POST /db/queries    → registrar SQL      ↓
      ↓                                      { columnas, filas }
      devuelve query_id                          ↓
      (esto es lo que guarda el widget)       el widget pinta
```

El widget solo guarda **`query_id`** y los valores de sus parámetros. El SQL vive
en el servidor y no viaja al navegador. Esto significa que:

- nadie puede modificar la consulta desde las DevTools del navegador,
- un `DROP TABLE` es imposible aunque alguien manipule la petición,
- si hay que corregir una consulta, se cambia en un sitio y todos los widgets
  que la usan quedan corregidos.

**Diferencia con los PLCs:** un PLC empuja datos por WebSocket; una BD hay que
preguntarle. El refresco lo decide el frontend llamando cada N segundos (no
bajar de ~2 s: cada llamada es una consulta real contra la BD).

---

## 1. Conexiones

### `POST /db` — crear o actualizar

**El cuerpo JSON es el MISMO para los cuatro motores.** Solo cambia el valor de
`motor` (y el `puerto`, que puedes omitir para usar el de cada uno). Hay dos
excepciones, marcadas abajo.

La conexión se **verifica antes de guardarse**: si las credenciales fallan,
responde `ok:false` y no persiste nada.

**PostgreSQL** (y TimescaleDB, que es PostgreSQL con una extensión):

```json
{
  "db_id": "mes_produccion",
  "motor": "postgresql",
  "nombre": "MES Producción",
  "host": "10.0.0.5",
  "puerto": 5432,
  "base_datos": "produccion",
  "usuario": "hmi_ro",
  "password": "secreta"
}
```

**MySQL / MariaDB** — idéntico, solo cambian `motor` y `puerto`:

```json
{
  "db_id": "calidad",
  "motor": "mysql",
  "nombre": "Base de Calidad",
  "host": "192.168.1.20",
  "puerto": 3306,
  "base_datos": "calidad",
  "usuario": "hmi_ro",
  "password": "secreta"
}
```

**SQL Server** — ⚠️ único que necesita `opciones.driver` con el ODBC Driver
instalado en la **máquina servidor** (no en la del usuario):

```json
{
  "db_id": "erp",
  "motor": "mssql",
  "nombre": "ERP Planta",
  "host": "SRV-SQL01",
  "puerto": 1433,
  "base_datos": "ERP",
  "usuario": "hmi_ro",
  "password": "secreta",
  "opciones": { "driver": "ODBC Driver 17 for SQL Server" }
}
```

**SQLite** — ⚠️ sin servidor: **no lleva host, puerto, usuario ni contraseña**.
`base_datos` es la RUTA al fichero:

```json
{
  "db_id": "local",
  "motor": "sqlite",
  "nombre": "Datos locales",
  "base_datos": "C:/datos/planta.db"
}
```

### Resumen por motor

| Motor | `motor` | Puerto | `host`/credenciales | Particularidad | Paquete |
|---|---|---|---|---|---|
| PostgreSQL | `postgresql` | 5432 | Sí | — | `asyncpg` |
| MySQL / MariaDB | `mysql` | 3306 | Sí | — | `aiomysql` |
| SQL Server | `mssql` | 1433 | Sí | Requiere `opciones.driver` | `aioodbc` + ODBC Driver 17/18 |
| SQLite | `sqlite` | — | **No** | `base_datos` = ruta al `.db` | `aiosqlite` (ya incluido) |

### Campos del cuerpo

| Campo | Obligatorio | Notas |
|---|---|---|
| `db_id` | sí | Identificador estable; es lo que referencia la consulta |
| `motor` | sí | `postgresql` · `mysql` · `mssql` · `sqlite` |
| `host` | salvo SQLite | IP o hostname |
| `puerto` | no | Por defecto 5432 / 3306 / 1433 |
| `base_datos` | sí | Nombre de la BD, o la ruta del `.db` en SQLite |
| `usuario` / `password` | salvo SQLite | La contraseña se cifra en disco |
| `opciones` | no | SQL Server: `{"driver": "ODBC Driver 18 for SQL Server"}` |
| `autoconectar` | no (`true`) | Abrir el pool al arrancar el servidor |

Respuesta:

```json
{ "ok": true, "db_id": "mes_produccion", "motor": "postgresql",
  "latencia_ms": 12.4, "mensaje": "Conexión 'mes_produccion' verificada y guardada." }
```

### Resto de endpoints de conexión

| Endpoint | Para qué |
|---|---|
| `GET /db` | Listar conexiones con su estado. **Nunca** devuelve contraseñas |
| `DELETE /db/{db_id}` | Borrar (elimina también **todas** sus consultas) |
| `POST /db/{db_id}/test` | `SELECT 1` + latencia. Reabre el pool si se cayó → sirve de "reconectar" |
| `GET /db/{db_id}/tablas` | Tablas y vistas, para el selector del diseñador |
| `GET /db/{db_id}/columnas?tabla=X` | Columnas con su tipo |

`GET /db` devuelve además `conectado`, `num_consultas` y `ultimo_error` si lo hay
— suficiente para pintar un semáforo por conexión.

---

## 1.b El esquema del HMI

Las tablas (`usuarios`, `plc_prg`, `alarmas`, `recetas`) **no se crean por
API**. Se crean ejecutando un script SQL:

```
sql/esquema_hmi_mssql.sql
sql/esquema_hmi_postgresql.sql
sql/esquema_hmi_mysql.sql
sql/esquema_hmi_sqlite.sql
```

Es deliberado: una aplicación con permisos para alterar la estructura de la
base de datos de producción es una aplicación que puede romperla. El usuario de
BD del HMI solo necesita `db_datareader` + `db_datawriter`.

Los scripts se **generan desde el propio código** con
`python tools/generar_sql.py`, así que no pueden desincronizarse con lo que el
backend espera encontrar.

Guía completa de despliegue: `docs/SERVIDOR_SQL.md`.

## 2. Consultas

### `POST /db/{db_id}/preview` — probar sin guardar (solo Diseñador)

Para que el diseñador vea el resultado antes de registrar nada:

```json
{ "sql": "SELECT maquina, SUM(piezas) AS total FROM produccion GROUP BY maquina",
  "parametros": {}, "limite": 50 }
```

Devuelve el mismo formato que `run` (ver abajo). Pasa por la misma validación de
solo-lectura.

### `POST /db/queries` — registrar

```json
{
  "query_id": "piezas_por_maquina",
  "db_id": "mes_produccion",
  "nombre": "Piezas por máquina",
  "sql": "SELECT maquina, SUM(piezas) AS total FROM produccion WHERE fecha >= :desde GROUP BY maquina ORDER BY total DESC",
  "parametros": { "desde": { "tipo": "string", "defecto": "2026-01-01" } },
  "limite": 500
}
```

Los parámetros se escriben en el SQL como **`:nombre`** y se declaran en
`parametros`. Cada uno puede llevar `defecto`, que se usa cuando el widget no
manda valor.

El SQL se valida **aquí**, al registrar: así el error aparece en el diseñador y
no en la pantalla de un operario.

### `GET /db/queries?db_id=X` — listar

Llena el selector de consulta de un widget. Devuelve `query_id`, `nombre`, `sql`,
`parametros` y `limite`.

### `DELETE /db/queries/{query_id}` — borrar

### Dialecto SQL: lo único que SÍ cambia por motor

El JSON de la consulta es igual para todos, pero **el SQL de dentro no siempre
lo es**. Estas son las diferencias con las que te vas a topar:

| Necesidad | PostgreSQL | MySQL / MariaDB | SQL Server | SQLite |
|---|---|---|---|---|
| Limitar filas | `LIMIT 20` | `LIMIT 20` | `SELECT TOP 20` | `LIMIT 20` |
| Fecha/hora actual | `NOW()` | `NOW()` | `GETDATE()` | `datetime('now')` |
| Truncar a hora | `DATE_TRUNC('hour', ts)` | `DATE_FORMAT(ts,'%Y-%m-%d %H:00')` | `DATEADD(hour, DATEDIFF(hour, 0, ts), 0)` | `strftime('%Y-%m-%d %H:00', ts)` |
| Concatenar | `a \|\| b` | `CONCAT(a, b)` | `a + b` | `a \|\| b` |
| Comillas de identificador | `"col"` | `` `col` `` | `[col]` | `"col"` |

**Lo que funciona igual en los cuatro** (y cubre la mayoría de widgets):
`SELECT`, `WHERE`, `GROUP BY`, `ORDER BY`, `JOIN`, `SUM`, `AVG`, `COUNT`,
`MIN`, `MAX`, `CASE WHEN`, y los parámetros `:nombre`.

> Consejo: si vas a apuntar el mismo widget a motores distintos, quédate en SQL
> estándar y evita `LIMIT`/`TOP` (ya tienes el campo `limite`, que corta las
> filas en el backend sea cual sea el motor).

---

## 3. Ejecutar (lo que llama el widget)

### `POST /db/queries/{query_id}/run`

```json
{ "parametros": { "desde": "2026-07-01" } }
```

Cuerpo vacío `{}` también vale: cada parámetro usará su `defecto`.

**Respuesta — este es el formato que consume el widget:**

```json
{
  "ok": true,
  "query_id": "piezas_por_maquina",
  "db_id": "mes_produccion",
  "parametros": { "desde": "2026-07-01" },
  "columnas": ["maquina", "total"],
  "filas": [
    { "maquina": "Linea A", "total": 263 },
    { "maquina": "Linea B", "total": 95 }
  ],
  "num_filas": 2,
  "truncado": false,
  "ms": 18.7
}
```

| Campo | Uso en el widget |
|---|---|
| `columnas` | Cabeceras de tabla, o ejes de un gráfico (en orden) |
| `filas` | Datos: lista de objetos `{columna: valor}` |
| `num_filas` | Contador a mostrar |
| `truncado` | `true` = se alcanzó el `limite`, hay más datos. Conviene avisar |
| `ms` | Tiempo de la consulta (útil en el diseñador para detectar consultas lentas) |

**Tipos de dato:** las fechas llegan en **ISO 8601** (`new Date(v)` las parsea
directo), los `DECIMAL/NUMERIC` como número, los binarios como marcador de texto.
`null` se mantiene como `null`.

### Errores

Siempre `HTTP 200` con `ok:false` y un `mensaje` listo para mostrar:

```json
{ "ok": false, "query_id": "piezas_por_maquina",
  "mensaje": "Faltan parámetros sin valor por defecto: desde." }
```

| Situación | `mensaje` |
|---|---|
| Falta un parámetro | `Faltan parámetros sin valor por defecto: X.` |
| La BD está caída | `Error ejecutando la consulta: ...` (reintenta sola en la siguiente llamada) |
| Consulta lenta | `La consulta tardó demasiado y se canceló.` (timeout 30 s) |
| SQL no permitido (al registrar) | `Solo se permiten consultas de lectura...` |

Un widget robusto debería: mostrar el `mensaje` en su lugar, mantener los últimos
datos buenos en pantalla, y seguir reintentando en el siguiente ciclo.

---

## 4. Historizador — guardar los tags de los PLCs

Hasta aquí todo era LEER de una BD que ya existe. El historizador hace lo
contrario: **coge los tags de tus PLCs y los va guardando** para que luego los
widgets puedan graficar el histórico.

```
   PLC ──► WebSocket (vista en vivo)
     │
     └───► Historizador ──► buffer ──► INSERT por lotes ──► historico_tags
                                                                  │
                                          widget de tendencia ◄────┘
                                          (SELECT de solo lectura)
```

Escucha el **mismo flujo** que alimenta la vista, así que no abre una segunda
sesión OPC UA ni añade carga al PLC. Y sigue guardando aunque nadie tenga la
pantalla abierta.

### Flujo de configuración

1. `GET /tags` → lista de todos los tags de todos los PLCs (para que el usuario
   marque los que quiere guardar). **No necesita BD.**
2. `POST /db` → conexión donde se guardará (si no la tienes ya).
3. `POST /historian` → crear el grupo con los tags marcados.
4. Los widgets leen con `GET /historian/{grupo_id}/datos` o con una consulta
   registrada sobre la misma tabla.

### `POST /historian` — crear un grupo

```json
{
  "grupo_id": "proceso",
  "db_id": "mes_produccion",
  "nombre": "Variables de proceso",
  "tags": [
    "192.168.50.1|DB_snap7.temperatura",
    "192.168.50.1|DB_snap7.presion",
    "192.168.100.31|PLC_PRG.AI_Sensor_mA"
  ],
  "tabla": "historico_tags",
  "activo": true
}
```

Los tags van en formato **`"<plc_id>|<tag>"`** — la misma clave que usa el
WebSocket, así que el frontend ya la tiene. Se pueden mezclar tags de PLCs
distintos (Siemens y Rexroth juntos) en un mismo grupo.

**Lista de tags vacía = TODOS los tags de todos los PLCs.** Cómodo, pero mira
antes la nota de volumen.

| Campo | Obligatorio | Notas |
|---|---|---|
| `grupo_id` | sí | Identificador del grupo |
| `db_id` | sí | Conexión destino (de `GET /db`) |
| `tags` | no | Vacío = todos. Formato `"plc\|tag"` |
| `tabla` | no (`historico_tags`) | Se crea sola. Solo letras, dígitos y `_` |
| `activo` | no (`true`) | Empezar a capturar ya |
| `banda_muerta` | no (`0`) | Válvula: ignora cambios menores que este valor |
| `intervalo_min_ms` | no (`0`) | Válvula: tiempo mínimo entre muestras del mismo tag |

### Esquema de la tabla (estrecho)

Una fila por lectura. Añadir o quitar tags **nunca** altera la tabla:

| Columna | Contenido |
|---|---|
| `ts` | Marca de tiempo del PLC (`source_ts`), en UTC |
| `plc` | Id del PLC de origen |
| `tag` | Nombre del tag |
| `valor_num` | Valor numérico — los booleanos se guardan como 0/1 |
| `valor_texto` | Valor cuando el tag es de texto |
| `tipo` | Tipo de dato OPC UA original |

Los booleanos van a `valor_num` a propósito: así se pueden graficar y promediar
igual que una señal analógica.

### ⚠️ Volumen: la única trampa

Se guarda **cada cambio**. Un tag que cambia cada 100 ms genera:

| Tags | Filas/día | Filas/mes |
|---|---|---|
| 1 | 864.000 | ~26 millones |
| 10 | 8,6 millones | ~260 millones |

Si te pasa, **no quites tags**: usa las válvulas de seguridad, que conservan
los cambios que importan y tiran el ruido.

```json
{
  "grupo_id": "temperaturas",
  "db_id": "mes_produccion",
  "tags": ["192.168.50.1|DB_snap7.temperatura"],
  "banda_muerta": 0.5,
  "intervalo_min_ms": 1000
}
```

- `banda_muerta: 0.5` → solo guarda si la temperatura varía medio grado.
- `intervalo_min_ms: 1000` → como mucho una muestra por segundo y tag.

En una prueba con señal ruidosa, `banda_muerta: 0.5` redujo 31 filas a 2 sin
perder el salto real de la señal.

Para volúmenes grandes de verdad, considera **TimescaleDB** (es PostgreSQL con
una extensión: la misma conexión `postgresql`, sin cambiar nada del backend).

### Resto de endpoints

| Endpoint | Para qué |
|---|---|
| `GET /historian` | Estado de todos los grupos: filas escritas, buffer, errores |
| `DELETE /historian/{grupo_id}` | Eliminar el grupo. **No borra los datos guardados** |
| `POST /historian/{grupo_id}/start` | Reanudar la captura |
| `POST /historian/{grupo_id}/stop` | Pausar (sin perder configuración) |
| `POST /historian/flush` | Forzar el volcado del buffer (útil para probar) |

En `GET /historian`, si `en_buffer` crece y no baja, la BD no está aceptando las
escrituras — mira `ultimo_error`.

### Leer el histórico

**Atajo** para un widget de tendencia, sin registrar consulta:

```
GET /historian/proceso/datos?tag=DB_snap7.temperatura&desde=2026-07-30T00:00:00&limite=500
```

```json
{
  "ok": true, "grupo_id": "proceso", "tabla": "historico_tags",
  "columnas": ["ts", "plc", "tag", "valor_num", "valor_texto", "tipo", "ts_local"],
  "timezone": "America/Lima",
  "filas": [
    { "ts": "2026-07-30T19:00:24Z",
      "ts_local": "2026-07-30T14:00:24-05:00",
      "plc": "SIM_PLC",
      "tag": "DB1.temperatura", "valor_num": 66.8,
      "valor_texto": null, "tipo": "Float" }
  ],
  "num_filas": 1, "truncado": false, "ms": 4.1
}
```

Ordena por `ts` descendente. Para un gráfico de línea, invierte el array.

### Zonas horarias: leer esto antes de reportar un bug

**Todo se guarda en UTC.** El `SourceTimestamp` de OPC UA es UTC por
especificación, y los dos drivers (Siemens y Rexroth) lo emiten así.

Consecuencia práctica: **si abres la tabla en phpMyAdmin verás la hora UTC**, no
la de Lima. Un dato registrado a las 15:54 hora local aparece como `20:54`. No
es un error — es la hora correcta sin convertir.

La conversión se hace al leer. Cada fila devuelve dos campos:

| Campo | Qué es |
|---|---|
| `ts` | UTC, con `Z` explícita. Es el que se usa para filtrar, ordenar y comparar |
| `ts_local` | ya convertido a `PLC_TIMEZONE`, con su offset. Es el que se pinta |

La zona se configura con `PLC_TIMEZONE` (nombre IANA, por defecto
`America/Lima`). `UTC` desactiva la conversión.

> En Windows puede faltar la base de datos de zonas horarias. Si en el log ves
> *"Zona horaria no disponible; se usa UTC"*, instala `pip install tzdata`.

**Por qué UTC y no hora local en la base**: guardar hora local pierde la
referencia absoluta. Con horario de verano hay una hora que ocurre dos veces al
año y otra que no existe — dos filas con la misma marca y ningún modo de
ordenarlas. Y si mañana comparas dos plantas en países distintos, los datos ya
no son comparables. Perú no tiene horario de verano hoy, pero la tabla dura más
que esa suposición.

#### Detalle de implementación (por si tocas el historizador)

Las marcas **no** se mandan al motor como cadena ISO. Se normalizan antes del
`INSERT` con `ts_para_motor()`, en `app/db/sql_driver.py`:

| Motor | Qué se envía | Por qué |
|---|---|---|
| PostgreSQL | `datetime` aware UTC | `TIMESTAMPTZ` sí guarda la zona |
| MySQL / SQL Server | `datetime` **naive** con la hora UTC | `DATETIME` no guarda zona |
| SQLite | ISO 8601 UTC, formato fijo | la columna es `TEXT`; comparación lexicográfica |

Esto cierra un fallo silencioso: si a MySQL 8.0.19+ se le pasa la cadena
`'2026-08-17T20:54:08+00:00'`, la convierte a la zona **de sesión del servidor**
antes de guardarla en un `DATETIME`. La misma instalación guardaría una hora
distinta según el `time_zone` de cada servidor MySQL, y al leer ya no habría
forma de saber en qué zona está el dato.

Si aún no hay datos devuelve `ok:true` con `filas: []` y un `mensaje` — no un
error, para que el widget pinte "sin datos" sin caso especial.

**Para agregaciones** (medias por hora, máximos por turno), registra una
consulta normal sobre la misma tabla:

```json
{
  "query_id": "media_horaria",
  "db_id": "mes_produccion",
  "sql": "SELECT tag, COUNT(*) AS n, AVG(valor_num) AS media FROM historico_tags WHERE tag = :tag AND ts >= :desde GROUP BY tag",
  "parametros": { "tag": {"tipo": "string"}, "desde": {"tipo": "string"} }
}
```

### Tolerancia a fallos

- **BD caída**: las filas se retienen en el buffer y se reintentan en cada
  ciclo (2 s). Verificado: 10 muestras retenidas durante el corte y escritas
  íntegras al volver.
- **Buffer lleno** (50.000 filas): se descartan las muestras más antiguas, para
  no quedarse sin memoria y tumbar también la vista en vivo.
- **Al apagar el servicio** se vuelca lo pendiente antes de cerrar los pools.
- La tabla se crea sola la primera vez, y se reintenta si la creación falló.

---

## 5. Seguridad

Tres barreras, de fuera hacia dentro:

1. **El widget no manda SQL.** Solo un `query_id` registrado. Manipular la
   petición desde el navegador no permite ejecutar SQL arbitrario.
2. **Validación de solo-lectura** (`validar_sql_lectura`): la sentencia debe
   empezar por `SELECT` o `WITH`, debe ser **una sola** (se rechaza el `;`), y
   se bloquean `INSERT`, `UPDATE`, `DELETE`, `DROP`, `TRUNCATE`, `ALTER`,
   `CREATE`, `GRANT`, `EXEC`… en cualquier posición, incluidas subconsultas.
3. **Parámetros bindeados**: los valores viajan por el mecanismo del motor,
   nunca concatenados en el texto. Mandar `"2026-01-01; DROP TABLE x"` como
   valor lo trata como una cadena literal (verificado).

Además: `limite` corta el número de filas (máx. 10 000) y hay timeout de 30 s.

**Recomendación operativa:** aun con todo esto, crea un usuario de BD **de solo
lectura** (`GRANT SELECT`) para el HMI. Las barreras del código son la segunda
línea de defensa, no la primera.

**Sobre las contraseñas:** se guardan cifradas con Fernet en
`datos/conexiones.json`, con la clave en `datos/.clave` (se genera sola). Esto
protege frente a lecturas casuales del fichero — backups, capturas, un commit
por error. **No** protege frente a alguien con acceso al sistema de ficheros del
servidor, porque la clave está ahí al lado. `datos/` está en `.gitignore`.

> Si copias `conexiones.json` a otra máquina sin su `.clave`, las contraseñas no
> se podrán descifrar y habrá que volver a introducirlas.

---

## 6. Instalación

El motor concreto se instala aparte (SQLAlchemy solo trae el core):

```bash
pip install -r requirements.txt        # incluye SQLAlchemy + SQLite

pip install asyncpg                    # PostgreSQL / TimescaleDB
pip install aiomysql                   # MySQL / MariaDB
pip install aioodbc                    # SQL Server (+ ODBC Driver 17/18 en Windows)
```

Si falta el paquete, el alta de la conexión responde con un mensaje explícito
indicando cuál instalar.

---

## 7. Notas de implementación

- **Un pool por conexión**, no una conexión por consulta. Los pools se abren al
  arrancar (si `autoconectar`) y se reutilizan.
- **Reconexión automática**: si la BD estaba caída al arrancar y luego vuelve, la
  primera consulta reabre el pool sola. No hace falta reiniciar el servidor.
- **Una BD caída no bloquea el arranque** ni afecta a los PLCs ni a las demás
  conexiones.
- Archivos: `app/db/db_driver.py` (contrato), `app/db/sql_driver.py` (motor SQL),
  `app/db/store.py` (persistencia cifrada), `app/core/db_manager.py` (gestor),
  `app/api/db_routes.py` (endpoints de consulta), `app/db/historian.py`
  (historizador) y `app/api/historian_routes.py` (endpoints del historizador).
- El historizador se engancha vía `ConnectionManager.registrar_observador()`:
  un callback síncrono que solo encola, para no retrasar el broadcast.
