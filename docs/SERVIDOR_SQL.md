# Desplegar la base de datos del HMI en un contenedor propio

Guía para levantar un **SQL Server nuevo** en tu servidor (`161.132.235.184`),
dedicado solo al HMI, y conectar el backend contra él.

> **`Servidor_PSI_SQL` no se toca.** Ese contenedor es de otra aplicación
> (`api_psi_container`). Aquí se crea uno aparte, en otro puerto y con su
> propio volumen, para que un problema en uno no afecte al otro.

**El backend no crea tablas.** Las crea un `.sql` que ejecutas tú. Es
deliberado: una aplicación con permisos para alterar la estructura de la base
de datos de producción es una aplicación que puede romperla. El HMI se conecta
a un esquema que ya existe, y escribe datos.

---

## Resumen

| Paso | Dónde | Qué se hace |
|---|---|---|
| 1 | Servidor (SSH) | Levantar el contenedor `hmi_sql` |
| 2 | Servidor (sqlcmd) | Crear la base de datos y el usuario |
| 3 | Servidor (sqlcmd) | Ejecutar `sql/esquema_hmi_mssql.sql` |
| 4 | HMI (Swagger) | `POST /db` — dar de alta la conexión |
| 5 | HMI | Verificar y arrancar la historización |

---

## Paso 1 · Contenedor nuevo

```bash
ssh Christian@161.132.235.184
```

El 1433 ya lo ocupa `Servidor_PSI_SQL`, así que el nuevo va en el **1434**:

```bash
# Volumen propio: los datos sobreviven a borrar o actualizar el contenedor.
docker volume create hmi_sql_data

docker run -d \
  --name hmi_sql \
  --restart unless-stopped \
  -e "ACCEPT_EULA=Y" \
  -e "MSSQL_SA_PASSWORD=Saipem2026" \
  -e "MSSQL_PID=Express" \
  -p 1434:1433 \
  -v hmi_sql_data:/var/opt/mssql \
  mcr.microsoft.com/mssql/server:2022-latest
```

Notas de lo anterior:

- **`MSSQL_PID=Express`** — edición gratuita, hasta 10 GB por base de datos.
  Para el histórico de un HMI suele sobrar; si lo llenas, se cambia a
  `Developer` (gratis pero solo para desarrollo) o a una licencia.
- **`--restart unless-stopped`** — vuelve solo tras un reinicio del servidor.
- **`-v hmi_sql_data:/var/opt/mssql`** — sin esto, borrar el contenedor
  borraría la base de datos.
- La contraseña de `sa` debe tener mayúsculas, minúsculas, dígitos y un
  símbolo, o el contenedor arranca y se cierra solo.

Comprobar que levantó:

```bash
docker ps --filter name=hmi_sql
docker logs hmi_sql | tail -20     # debe decir "SQL Server is now ready"
```

Y abrir el puerto en el firewall del servidor:

```bash
sudo firewall-cmd --permanent --add-port=1434/tcp && sudo firewall-cmd --reload
# o, si usa ufw:
sudo ufw allow 1434/tcp
```

---

## Paso 2 · Base de datos y usuario

```bash
docker exec -it hmi_sql /opt/mssql-tools18/bin/sqlcmd \
  -S localhost -U sa -P 'Saipem2026' -C
```

> Si `mssql-tools18` no existe en la imagen, prueba
> `/opt/mssql-tools/bin/sqlcmd` y quita el `-C` (ese flag acepta el
> certificado autofirmado, y solo existe en la v18).

```sql
CREATE DATABASE HMI_PSI COLLATE Modern_Spanish_CI_AS;
GO
```

La *collation* importa: con `Modern_Spanish_CI_AS` las comparaciones ignoran
mayúsculas y tratan bien acentos y `ñ`. Sin eso, buscar `"Válvula"` no
encontraría `"valvula"`.

**No uses `sa` para la aplicación.** Si esas credenciales se filtran, quien las
tenga controla todo el motor, no solo esta base de datos:

```sql
USE master;
CREATE LOGIN hmi_app WITH PASSWORD = 'Saipem2026', CHECK_POLICY = ON;
GO

USE HMI_PSI;
CREATE USER hmi_app FOR LOGIN hmi_app;
ALTER ROLE db_datareader ADD MEMBER hmi_app;
ALTER ROLE db_datawriter ADD MEMBER hmi_app;
GO
```

Fíjate en que **no** lleva `db_ddladmin`: el HMI solo lee y escribe filas, no
crea ni altera tablas. Ese es todo el permiso que necesita.

---

## Paso 3 · Crear las tablas

El script está en el repo: `sql/esquema_hmi_mssql.sql`. Cópialo al servidor y
ejecútalo:

```bash
# Desde tu PC
scp sql/esquema_hmi_mssql.sql Christian@161.132.235.184:~/

# En el servidor
docker cp ~/esquema_hmi_mssql.sql hmi_sql:/tmp/
docker exec -it hmi_sql /opt/mssql-tools18/bin/sqlcmd \
  -S localhost -U sa -P 'Saipem2026' -C \
  -d HMI_PSI -i /tmp/esquema_hmi_mssql.sql
```

Es **idempotente**: volver a ejecutarlo sobre una base de datos que ya lo tiene
no falla ni toca los datos.

Comprobar:

```sql
USE HMI_PSI;
SELECT name FROM sys.tables ORDER BY name;
GO
-- alarmas, plc_prg, recetas, usuarios
```

> El `.sql` **se genera desde el propio código** del backend
> (`python tools/generar_sql.py`). Así el script y el servicio no pueden
> desincronizarse: si mañana cambia una columna, se regenera y ambos siguen
> hablando el mismo idioma. Hay versión para los cuatro motores.

---

## Paso 4 · Conectar el HMI

El servidor del HMI necesita el **ODBC Driver 17 o 18** y el paquete Python:

```powershell
pip install aioodbc
Get-OdbcDriver | Where-Object Name -like "*SQL Server*" | Select Name
```

En **Swagger** (`http://localhost:8000/docs` → *Bases de datos* → `POST /db`):

```json
{
  "db_id": "psi",
  "motor": "mssql",
  "nombre": "HMI PSI (servidor)",
  "host": "161.132.235.184",
  "puerto": 1434,
  "base_datos": "HMI_PSI",
  "usuario": "hmi_app",
  "password": "OtraPasswordFuerte_2026!",
  "opciones": {
    "driver": "ODBC Driver 18 for SQL Server",
    "TrustServerCertificate": "yes"
  }
}
```

`TrustServerCertificate` hace falta con el Driver 18 porque el certificado del
contenedor es autofirmado. Con el Driver 17 puedes omitirlo.

Respuesta esperada:

```json
{ "ok": true, "db_id": "psi", "motor": "mssql", "latencia_ms": 34.2,
  "mensaje": "Conexión 'psi' verificada y guardada." }
```

La conexión **se verifica antes de guardarse**: si responde `ok: false`, las
credenciales o la red fallan y no se ha persistido nada. La contraseña se
guarda cifrada (Fernet) en `datos/conexiones.json`, con la clave en
`datos/.clave` — si copias el JSON sin su clave, no se podrá descifrar.

Y en el `.env`, para que el login use esta base de datos:

```ini
PLC_AUTH_DB_ID=psi
```

---

## Paso 5 · Verificar y arrancar

```
GET /db/psi/tablas
→ { "tablas": ["alarmas", "plc_prg", "recetas", "usuarios"] }

GET /crud
→ catálogo de recursos y campos
```

Prueba de escritura real:

```
POST /crud/recetas
{
  "nombre_receta": "Producto A",
  "nombre": "Temperatura de consigna",
  "tag": "192.168.50.1|DB_snap7.setpoint_temp",
  "tipo_dato": "REAL",
  "valor_default": 65.0,
  "valor_minimo": 40.0,
  "valor_maximo": 90.0,
  "unidad": "°C"
}
```

Y arrancar la historización sobre la tabla `plc_prg`:

```
POST /historian
{
  "grupo_id": "proceso",
  "db_id": "psi",
  "tabla": "plc_prg",
  "tags": [],
  "activo": true
}
```

Si la tabla no existiera, el historizador **no la crea**: responde con un error
que dice exactamente qué ejecutar. Se ve en `GET /historian` → `ultimo_error`.

---

## Las cuatro tablas

| Tabla | Qué guarda | Quién la escribe |
|---|---|---|
| `usuarios` | Cuentas del HMI. **El hash de la contraseña, nunca la contraseña** | `/auth` |
| `plc_prg` | Lecturas del PLC (una fila por `ts`+`tag`) | El historizador, por lotes |
| `alarmas` | Eventos: activa → reconocida → normalizada | `/crud/alarmas` |
| `recetas` | Parámetros del proceso con sus límites | `/crud/recetas` |

`alarmas` y `recetas` referencian a `usuarios` y `plc_prg` con
`ON DELETE SET NULL`: borrar un usuario no borra su historial de alarmas — se
pierde el "quién", no el evento.

### Dos diferencias con tu diagrama, y por qué

**Claves primarias simples.** Tu diagrama pone `PK,FK2 usuario_id` y
`PK,FK2 plc_prg_id` en `Recetas` y `Alarmas`. Con una PK compuesta de esos tres
campos no podrías tener **dos alarmas distintas del mismo PLC y el mismo
usuario**, que es lo normal en producción. Se usa `id` como PK, y los otros
como FKs sin más.

**`plc_prg` es estrecha.** Tu diagrama la dibuja con `temperaturas`,
`presiones`, `velocidades`, `estados de motores`, `consumos`. El problema:
añadir una variable obligaría a un `ALTER TABLE`, y la tabla se llenaría de
`NULL` porque cada lectura solo trae una magnitud. Con `ts, plc_id, tag,
valor_num, valor_texto, tipo`, añadir o quitar tags desde la vista nunca toca
la estructura. Es el modelo de cualquier historiador industrial.

El historizador **detecta solo** las columnas de la tabla destino, así que
funciona tanto con `plc_prg` (columna `plc_id`, con `programa`) como con su
tabla propia `historico_tags` (columna `plc`). Al leer emite un alias para que
el widget de tendencia y la exportación a Excel reciban siempre el mismo
formato.

---

## Los endpoints clave

| Necesidad | Endpoint |
|---|---|
| Conectarme a la base de datos | `POST /db` |
| Guardar los datos del PLC | `POST /historian` |
| Leer el histórico | `GET /historian/{grupo}/datos` · `GET /crud/plc_prg` |
| CRUD de alarmas y recetas | `GET/POST/PATCH/DELETE /crud/{recurso}` |
| Usuarios | `/auth/*` (no en `/crud`: hay que hashear contraseñas) |
| Crear las tablas | **No es un endpoint**: `sql/esquema_hmi_mssql.sql` |

---

## SQL Server en Windows con instancias CON NOMBRE

Lo anterior asume un SQL Server en contenedor, que siempre es la instancia por
defecto en el 1433. En un **PC de planta con Windows** la situación normal es
otra: ya hay una o varias instancias **con nombre** que instaló otro producto
(`SQLEXPRESS`, `WINCC`, `TEW_SQLEXPRESS`…).

Se reconocen porque se escriben `HOST\INSTANCIA`, y se comportan distinto:

> **Una instancia con nombre NO escucha en el 1433.** Al arrancar toma un
> puerto **dinámico**, que cambia en cada reinicio del servicio. El cliente lo
> averigua preguntándole a **SQL Server Browser** por UDP 1434.

Por eso "nada responde en localhost:1433" puede salir con el servicio
perfectamente levantado.

### Dos formas de conectar, y cuándo usar cada una

**(a) Por nombre de instancia — la recomendada**

En el campo *Host* escribe `localhost\TEW_SQLEXPRESS` y **deja el puerto como
está**: se ignora. Requisitos:

- El servicio **SQL Server Browser** debe estar iniciado (viene parado de
  fábrica; se arranca desde `services.msc`).
- TCP/IP habilitado en esa instancia.

Es la mejor opción cuando hay **varias instancias**, porque el 1433 solo lo
puede ocupar una.

**(b) Fijando un puerto estático**

En SQL Server Configuration Manager → Configuración de red → Protocolos de
`<instancia>` → TCP/IP → pestaña *Direcciones IP* → baja hasta **IPAll**:

1. **Vacía «Puertos TCP dinámicos»** (déjalo en blanco). ← *el paso que casi
   todo el mundo se salta; sin esto sigue sin escuchar en el 1433*
2. Pon **«Puerto TCP» = 1433**.
3. Reinicia el servicio `SQL Server (<instancia>)`.

Después, en el HMI, marca la opción `puerto_fijo` para que se mande el puerto
junto al nombre de instancia:

```json
{ "host": "localhost\\TEW_SQLEXPRESS", "puerto": 1433,
  "opciones": { "puerto_fijo": "si", "TrustServerCertificate": "yes" } }
```

### No reconfigures una instancia que no es tuya

Si la instancia se llama `WINCC` o `TEW_SQLEXPRESS`, casi seguro pertenece a
**WinCC / TIA de Siemens**. Cambiarle la configuración de red puede afectar a
ese sistema, que probablemente esté en producción. El diagnóstico avisa cuando
lo detecta.

Lo correcto en ese caso es **instalar una instancia propia** para Psi Core
(SQL Server Express es gratuito) en vez de tocar la ajena.

### El driver ODBC

El HMI usa el **mejor driver instalado**, no uno fijo. Si solo tienes el
*ODBC Driver 13*, funciona; pero es de 2016 y tiene limitaciones con TLS
moderno. Merece la pena instalar el **18** (o el 17): son 5 MB y los instala
Microsoft.

---

## Errores frecuentes

| Error | Causa | Solución |
|---|---|---|
| El contenedor arranca y se cierra | Contraseña de `sa` débil | Mayúsculas, minúsculas, dígitos y símbolo; mínimo 8 |
| `Falta el paquete 'aioodbc'` | Falta la librería Python | `pip install aioodbc` |
| `Data source name not found` | No hay ODBC Driver instalado | Instalar ODBC Driver 17/18 en la máquina del HMI |
| `SSL Provider: certificate chain... not trusted` | Driver 18 exige cifrado | `"TrustServerCertificate": "yes"` en `opciones` |
| `Login failed for user` | El login no existe en esa BD | Repetir el paso 2 dentro de `USE HMI_PSI` |
| `Cannot open database "HMI_PSI"` | La BD no existe | Paso 2: falta el `CREATE DATABASE` |
| `Invalid object name 'plc_prg'` | Falta el esquema | Paso 3: ejecutar el `.sql` |
| Conexión agota el tiempo | Puerto 1434 cerrado | Abrirlo en el firewall del servidor |
| `Nada responde en localhost:1433` **y la instancia tiene nombre** | Las instancias con nombre usan puerto dinámico | Usar `HOST\INSTANCIA` sin puerto + SQL Server Browser, o fijar puerto estático (ver arriba) |
| No aparece el servicio `SQL Server (MSSQLSERVER)` | Es una instancia con nombre | El servicio se llama `SQL Server (<INSTANCIA>)` |

Diagnóstico rápido desde el propio contenedor:

```bash
docker exec -it hmi_sql /opt/mssql-tools18/bin/sqlcmd \
  -S localhost -U hmi_app -P 'OtraPasswordFuerte_2026!' -C \
  -d HMI_PSI -Q "SELECT COUNT(*) AS tablas FROM sys.tables"
```

Si eso funciona y el HMI no conecta, el problema es de red o de driver ODBC,
no de la base de datos.
