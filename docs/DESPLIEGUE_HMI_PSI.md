# Despliegue de `HMI_PSI` en el servidor — bitácora

> 26 de agosto de 2026 · Servidor `161.132.235.184` · contenedor `hmi_sql` · puerto `1434`

Este documento **complementa** [`SERVIDOR_SQL.md`](SERVIDOR_SQL.md). Allí está el
procedimiento en limpio; aquí está lo que pasó de verdad al ejecutarlo: los tres
errores que salieron, por qué salieron, y la secuencia de comandos que sí
funciona. Si vas a repetir el despliegue en otro servidor, **lee la sección 1 y
salta directamente a los comandos** — no repitas el camino largo.

**¿Solo quieres la base de datos en tu PC?** Salta a
[§5 · Instalación local](#5--instalación-local-sql-server-en-tu-pc): es un único
script de SSMS, sin nada de lo de aquí arriba.

---

## 0 · Estado final

| Cosa | Estado |
|---|---|
| Contenedor `hmi_sql` (SQL Server 2022 Express) | ✅ corriendo, puerto `1434` |
| Base de datos `HMI_PSI` | ✅ creada |
| Collation `Modern_Spanish_CI_AS` | ⚠️ **sin confirmar** — ver §2.4 |
| Login + usuario `hmi_app` | ✅ con `db_datareader` + `db_datawriter` |
| Tablas `alarmas`, `plc_prg`, `recetas`, `usuarios` | ✅ creadas desde `sql/esquema_hmi_mssql.sql` |
| Prueba de acceso como `hmi_app` | ✅ `SELECT COUNT(*) FROM sys.tables` → `4` |
| Puerto 1434 abierto en el firewall | ⏳ pendiente |
| Paquete `aioodbc` + ODBC Driver 18 en el PC del HMI | ⏳ pendiente |
| Conexión dada de alta con `POST /db` | ⏳ pendiente |

---

## 1 · La regla que evita todos los errores de esta sesión

**Nunca pegues SQL multilínea dentro del prompt interactivo de `sqlcmd`.**

Cuando abres `sqlcmd` sin `-Q` y pegas un bloque de varias líneas, el terminal
mezcla el eco de lo que pegas con los prompts `1>`, `2>`, `3>` que va imprimiendo
`sqlcmd`. El resultado es que **lo que ves en pantalla no es lo que recibió el
servidor**: aparecen fragmentos cortados (`SWORD`, `OGIN`, `EMBER`) y se pierde
por completo la trazabilidad de qué se ejecutó.

La forma correcta es **una invocación por sentencia lógica, con `-Q`**. Cada
comando es autónomo, se ve su resultado por separado, y si uno falla no arrastra
a los demás.

### La secuencia definitiva

```bash
# 1 · Crear la base de datos. CREATE DATABASE necesita su propio lote.
docker exec -i hmi_sql /opt/mssql-tools18/bin/sqlcmd -S localhost -U sa -P '<PASSWORD_SA>' -C \
  -Q "CREATE DATABASE HMI_PSI COLLATE Modern_Spanish_CI_AS;"

# 2 · Verificar ANTES de seguir. Si no devuelve una fila, para aquí.
docker exec -i hmi_sql /opt/mssql-tools18/bin/sqlcmd -S localhost -U sa -P '<PASSWORD_SA>' -C \
  -Q "SELECT name, state_desc, collation_name FROM sys.databases WHERE name='HMI_PSI';"

# 3 · Login del servidor (idempotente: sirve tanto si ya existía como si no)
docker exec -i hmi_sql /opt/mssql-tools18/bin/sqlcmd -S localhost -U sa -P '<PASSWORD_SA>' -C \
  -Q "IF NOT EXISTS (SELECT 1 FROM sys.server_principals WHERE name='hmi_app')
        CREATE LOGIN hmi_app WITH PASSWORD='<PASSWORD_HMI_APP>', CHECK_POLICY=ON;
      ELSE
        ALTER LOGIN hmi_app WITH PASSWORD='<PASSWORD_HMI_APP>';"

# 4 · Usuario dentro de HMI_PSI + permisos. SIN db_ddladmin: el HMI no altera tablas.
docker exec -i hmi_sql /opt/mssql-tools18/bin/sqlcmd -S localhost -U sa -P '<PASSWORD_SA>' -C -d HMI_PSI \
  -Q "IF NOT EXISTS (SELECT 1 FROM sys.database_principals WHERE name='hmi_app')
        CREATE USER hmi_app FOR LOGIN hmi_app;
      ALTER ROLE db_datareader ADD MEMBER hmi_app;
      ALTER ROLE db_datawriter ADD MEMBER hmi_app;"

# 5 · Ejecutar el esquema. Por stdin: no deja ficheros dentro del contenedor
#     y se salta el problema de permisos de §2.3.
docker exec -i hmi_sql /opt/mssql-tools18/bin/sqlcmd -S localhost -U sa -P '<PASSWORD_SA>' -C \
  -d HMI_PSI < ~/esquema_hmi_mssql.sql

# 6 · Verificar las tablas
docker exec -i hmi_sql /opt/mssql-tools18/bin/sqlcmd -S localhost -U sa -P '<PASSWORD_SA>' -C -d HMI_PSI \
  -Q "SELECT name FROM sys.tables ORDER BY name;"
# -> alarmas, plc_prg, recetas, usuarios

# 7 · LA prueba que importa: que entre el usuario de la aplicación, no sa
docker exec -i hmi_sql /opt/mssql-tools18/bin/sqlcmd -S localhost -U hmi_app -P '<PASSWORD_HMI_APP>' -C -d HMI_PSI \
  -Q "SELECT COUNT(*) AS tablas FROM sys.tables;"
# -> 4
```

El paso 7 es el que valida el despliegue de verdad. Si devuelve `4`, la base de
datos está bien y **cualquier fallo posterior es de red, de firewall o de driver
ODBC** — no de SQL Server. Eso acota muchísimo el diagnóstico.

> Nota sobre `-i` vs `<`: los dos ejecutan un `.sql`. Se prefiere `<` (stdin)
> porque no requiere `docker cp` ni tocar permisos dentro del contenedor. Si
> usas `-i`, lee §2.3.

---

## 2 · Los errores que salieron, y qué significaban

| # | Síntoma | Causa real |
|---|---|---|
| 2.1 | `Msg 102 · Incorrect syntax near 'SWORD'` | Pegado multilínea desordenado en el prompt interactivo |
| 2.2 | `Msg 911 · Database 'HMI_PSI' does not exist` | Consecuencia de 2.1: el `CREATE DATABASE` nunca llegó a ejecutarse |
| 2.3 | `Error code 0x80070005` al leer `/tmp/esquema_hmi_mssql.sql` | Permiso denegado: `docker cp` deja el fichero como `root`, `sqlcmd` corre como `mssql` |
| 2.4 | `collation_name` devolvió `NULL` | La base aún no estaba `ONLINE` al preguntar — **falta confirmar** |

### 2.1 · `Incorrect syntax near 'SWORD'`

Lo que se veía en pantalla:

```
1> CREATE DATABASE HMI_PSI COLLATE Modern_Spanish_CI_AS;
2>
3> USE master;
4> SWORD = 'Saipem2026', CHECK_POLICY = ON;
5> GO
Msg 102, Level 15, State 1, Line 4
Incorrect syntax near 'SWORD'.
```

`SWORD` es el final de `...WITH PASSWORD`: el principio de esa línea se perdió en
el eco del terminal. Ver §1.

**Lo importante de este error no es el error, sino su alcance.** En SQL Server
todo lo que va antes de un `GO` es **un solo lote**, y un error de sintaxis se
detecta al compilar el lote, así que **no se ejecuta ni una de sus sentencias** —
ni siquiera las que estaban bien escritas y venían antes del fallo.

Por eso el `CREATE DATABASE` de la línea 1 tampoco corrió, aunque su sintaxis era
correcta y aparecía tres líneas antes del error.

### 2.2 · `Database 'HMI_PSI' does not exist`

```
Msg 911, Level 16, State 1, Line 3
Database 'HMI_PSI' does not exist. Make sure that the name is entered correctly.
```

No es un error nuevo: es **la consecuencia** de 2.1. Como el lote entero se
descartó, la base nunca se creó, y el `USE HMI_PSI` de un intento posterior no
tenía a dónde ir.

**Regla que sale de aquí:** después de un `CREATE DATABASE`, verifica que existe
antes de seguir (paso 2 de §1). Cuesta un comando y evita perseguir un error que
en realidad ocurrió tres pasos antes.

### 2.3 · `Error code 0x80070005` al leer el `.sql`

```
Sqlcmd: Error: Error occurred while opening or operating on file
/tmp/esquema_hmi_mssql.sql (Reason: Error code 0x80070005).
```

`0x80070005` es `E_ACCESSDENIED`. El fichero **sí estaba** dentro del contenedor
(`docker cp` había dicho `Successfully copied`), pero no se podía leer:

- `docker cp` escribe el fichero como **`root`**, conservando los permisos del
  origen.
- El proceso `sqlcmd` dentro del contenedor corre como el usuario **`mssql`**
  (uid 10001), no como root.

Resultado: el fichero está ahí y es ilegible para quien tiene que leerlo.

Dos soluciones, en orden de preferencia:

```bash
# A · Mejor: mandarlo por stdin, sin copiar nada dentro del contenedor
docker exec -i hmi_sql /opt/mssql-tools18/bin/sqlcmd -S localhost -U sa -P '<PASSWORD_SA>' -C \
  -d HMI_PSI < ~/esquema_hmi_mssql.sql

# B · Si prefieres -i, arregla el permiso primero
docker exec -u root hmi_sql chmod 644 /tmp/esquema_hmi_mssql.sql
docker exec -i hmi_sql /opt/mssql-tools18/bin/sqlcmd -S localhost -U sa -P '<PASSWORD_SA>' -C \
  -d HMI_PSI -i /tmp/esquema_hmi_mssql.sql
```

> **Falsa alarma que confunde:** `docker cp` reportó `7.17kB` pero
> `sql/esquema_hmi_mssql.sql` pesa `5218` bytes. No hay corrupción: `docker cp`
> informa del tamaño del **tar** que usa para transferir (cabecera de 512 bytes,
> relleno a bloques de 512, y 1024 bytes de cierre). 5218 → 7168 = 7.17 kB. El
> fichero llegó íntegro.

### 2.4 · `collation_name` devolvió `NULL` — ⚠️ pendiente

```
name       collation_name
--------   --------------
HMI_PSI    NULL
```

En `sys.databases`, `collation_name` es `NULL` cuando la base **no está
`ONLINE`** en el momento de la consulta. La explicación más probable es de
tiempos: la consulta se lanzó inmediatamente después del `CREATE DATABASE`,
mientras la base todavía terminaba de montarse. Todo lo que vino después
funcionó, así que ahora está `ONLINE`.

**Pero hay que confirmarlo, y conviene hacerlo ya:**

```bash
docker exec -i hmi_sql /opt/mssql-tools18/bin/sqlcmd -S localhost -U sa -P '<PASSWORD_SA>' -C \
  -Q "SELECT name, state_desc, collation_name FROM sys.databases WHERE name='HMI_PSI';"
```

| Resultado | Qué hacer |
|---|---|
| `ONLINE` + `Modern_Spanish_CI_AS` | Nada, está correcto |
| `ONLINE` + otra collation (p. ej. `SQL_Latin1_General_CP1_CI_AS`) | Recrear la base — ver abajo |

**Por qué no basta con `ALTER DATABASE ... COLLATE`:** ese comando cambia la
collation por defecto de la base, pero **no toca las columnas que ya existen**.
Las `varchar` de `usuarios`, `plc_prg`, `alarmas` y `recetas` se quedarían con la
collation con la que nacieron. Habría que reescribir columna por columna.

Como las tablas están **vacías**, lo barato y limpio es rehacerla:

```bash
docker exec -i hmi_sql /opt/mssql-tools18/bin/sqlcmd -S localhost -U sa -P '<PASSWORD_SA>' -C \
  -Q "ALTER DATABASE HMI_PSI SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE HMI_PSI;"
# y repetir los pasos 1, 4, 5 y 6 de §1  (el login del paso 3 sobrevive: vive en master)
```

**Por qué importa la collation:** `Modern_Spanish_CI_AS` es *case-insensitive*
y *accent-sensitive* con reglas del español. Con la collation de fábrica,
buscar `'valvula'` no encontraría `'Válvula'`, y la `ñ` no ordena donde debe.
Es el tipo de detalle que no molesta hasta que hay 200.000 filas dentro.

---

## 3 · Cambios en el repositorio

### 3.1 · `requirements.txt` — `aioodbc` activado

`aioodbc` estaba comentado en el bloque de motores opcionales. Al quedar SQL
Server como la base de datos del proyecto, pasa a ser una dependencia real y se
instala con el resto:

```
aioodbc==0.5.0               # SQL Server (requiere ODBC Driver 17/18 en el sistema)
```

`asyncpg` y `aiomysql` siguen comentados: solo hacen falta si algún día se apunta
a PostgreSQL o MySQL.

> `aioodbc` arrastra `pyodbc`, que es un binding nativo: **necesita el ODBC
> Driver instalado en el sistema operativo**. `pip install` no lo trae. En
> Windows se instala aparte, desde Microsoft.

### 3.2 · `tools/generar_sql.py` — nueva opción `--local`

Genera `sql/local_hmi_psi_mssql.sql`, el script todo-en-uno para instalar el
HMI en un SQL Server local (ver §5). Sale del mismo `ddl_esquema_hmi()` que los
otros cuatro scripts, así que el DDL de las tablas es literalmente el mismo
texto — no una copia que pueda quedarse atrás.

Se verificó que el refactor no cambió nada: `sql/esquema_hmi_mssql.sql`
regenerado es **byte a byte idéntico** al anterior.

### 3.3 · `sql_driver.py` — las `opciones` de SQL Server ya llegan

Arreglado el punto **B** de [`ANALISIS_PROYECTO.md`](ANALISIS_PROYECTO.md).
`url()` leía solo `opciones["driver"]` y **descartaba el resto**, así que
`TrustServerCertificate` nunca entraba en la cadena de conexión.

Rompía el caso más común: con el **ODBC Driver 18** el cifrado viene activado
de fábrica, y un SQL Server con certificado autofirmado —el de un contenedor, o
el de una instancia local recién instalada— rechaza la conexión con
`SSL Provider: certificate chain ... not trusted`.

El síntoma engañaba especialmente bien: la opción estaba puesta en el `POST
/db`, se guardaba en `conexiones.json`, `GET /db` la devolvía… y la conexión
seguía fallando como si no existiera.

Ahora se pasa todo lo que haya en `opciones` (`TrustServerCertificate`,
`Encrypt`, `Trusted_Connection`, `MARS_Connection`…). El driver ignora lo que
no conoce.

```
mssql+aioodbc://hmi_app:***@localhost:1433/HMI_PRUEBAS
    ?driver=ODBC+Driver+18+for+SQL+Server&TrustServerCertificate=yes
```

### 3.4 · Pendiente: corregir `SERVIDOR_SQL.md`

Los pasos 2 y 3 de esa guía muestran un `sqlcmd` interactivo con bloques SQL
pegados. Es exactamente lo que produjo los errores 2.1 y 2.2. Conviene
reescribirlos con `-Q`, como en §1 de este documento.

---

## 4 · Lo que falta para que el HMI conecte

### 4.1 · Abrir el puerto en el servidor

```bash
sudo firewall-cmd --permanent --add-port=1434/tcp && sudo firewall-cmd --reload
```

⚠️ **`161.132.235.184` es una IP pública.** Abrir el 1434 a todo internet expone
el motor a barridos automáticos de credenciales. Si el HMI conecta siempre desde
la misma red, conviene restringir el origen:

```bash
sudo firewall-cmd --permanent --add-rich-rule='rule family="ipv4" source address="TU.IP.PUBLICA/32" port port="1434" protocol="tcp" accept'
sudo firewall-cmd --reload
```

Y revisar que la contraseña de `sa` sea fuerte de verdad (mayúsculas, minúsculas,
dígitos **y símbolo**), porque `sa` controla el motor entero, no solo `HMI_PSI`.

### 4.2 · En el PC del HMI

```powershell
.\venv\Scripts\Activate.ps1
pip install -r requirements.txt          # ahora ya trae aioodbc

# Comprobar que el driver del sistema está instalado
Get-OdbcDriver | Where-Object Name -like "*SQL Server*" | Select Name

# Comprobar que se llega al puerto
Test-NetConnection 161.132.235.184 -Port 1434
```

Si `Get-OdbcDriver` no lista *ODBC Driver 18 for SQL Server*, hay que instalarlo
antes de nada: sin él `POST /db` responde `Data source name not found`.

### 4.3 · Dar de alta la conexión

En Swagger (`http://localhost:8000/docs` → *Bases de datos* → `POST /db`):

```json
{
  "db_id": "psi",
  "motor": "mssql",
  "nombre": "HMI PSI (servidor)",
  "host": "161.132.235.184",
  "puerto": 1434,
  "base_datos": "HMI_PSI",
  "usuario": "hmi_app",
  "password": "<PASSWORD_HMI_APP>",
  "opciones": {
    "driver": "ODBC Driver 18 for SQL Server",
    "TrustServerCertificate": "yes"
  }
}
```

`TrustServerCertificate` es obligatorio con el Driver 18: exige cifrado por
defecto y el certificado del contenedor es autofirmado.

> ⚠️ **Aviso conocido del backend:** hoy `sql_driver.py` (línea ~322) solo lee
> `opciones["driver"]` y **descarta el resto de `opciones`**, así que
> `TrustServerCertificate` no llegaría a la cadena de conexión. Está registrado
> como el punto **B** de [`ANALISIS_PROYECTO.md`](ANALISIS_PROYECTO.md) y hay que
> arreglarlo antes de que este `POST /db` funcione con el Driver 18. Con el
> Driver 17 el problema no aparece.

### 4.4 · Después

```ini
# .env — para que el login del HMI use esta base de datos
PLC_AUTH_DB_ID=psi
```

Y arrancar la historización sobre `plc_prg`:

```json
POST /historian
{ "grupo_id": "proceso", "db_id": "psi", "tabla": "plc_prg", "tags": [], "activo": true }
```

---

## 5 · Instalación LOCAL (SQL Server en tu PC)

Mismo esquema, misma collation, mismo usuario — pero en el SQL Server de tu
equipo en vez del contenedor del servidor. Sirve para desarrollar sin depender
de la red, y para probar cambios sin tocar la base de producción.

**No hace falta repetir nada de §1.** Aquí no hay SSH ni `docker exec`: se
ejecuta un único script desde SSMS.

### 5.1 · El script

```
sql/local_hmi_psi_mssql.sql
```

Hace las cinco cosas de una pasada, en el orden correcto:

| Paso | Qué hace |
|---|---|
| 1 | **Diagnóstico**: edición, modo de autenticación y puerto TCP de la instancia |
| 2 | `CREATE DATABASE HMI_PSI COLLATE Modern_Spanish_CI_AS` |
| 3 | Login SQL `hmi_app` a nivel de servidor |
| 4 | Usuario `hmi_app` dentro de `HMI_PSI` + `db_datareader` / `db_datawriter` |
| 5 | Las cuatro tablas: `usuarios`, `plc_prg`, `alarmas`, `recetas` |
| 6 | Verificación final: lista las tablas creadas |

Es **idempotente** (ejecutarlo dos veces no falla ni pierde datos) y **solo
toca `HMI_PSI`**: cualquier otra base del servidor — `SistemaclientePSI`, por
ejemplo — queda intacta.

### 5.2 · Cómo se ejecuta

1. Abrir **SSMS** conectado a la instancia local con una cuenta *sysadmin*
   (la de Windows con la que administras el equipo sirve).
2. `File > Open > File…` → `sql\local_hmi_psi_mssql.sql`.
3. **Execute (F5).** No hace falta seleccionar base de datos antes: el script
   hace su propio `USE`.
4. Leer la pestaña **Messages** y el resultado del último `SELECT`: deben salir
   las cuatro tablas.

### 5.3 · El script se genera, no se escribe

Igual que los `esquema_hmi_*.sql`, sale de `ddl_esquema_hmi()` en
`app/db/sql_driver.py`, así que **no puede desincronizarse con el backend**:

```bash
python tools/generar_sql.py --local
```

Opciones, por si el entorno local es distinto:

```bash
python tools/generar_sql.py --local --password 'OtraPasswordFuerte2026!'
python tools/generar_sql.py --local --bd HMI_PRUEBAS --usuario hmi_test
python tools/generar_sql.py --local --collation SQL_Latin1_General_CP1_CI_AS
```

La contraseña por defecto es `Hmi_Psi2026!`. **Cámbiala regenerando el script,
no editándolo a mano** — un `.sql` generado que alguien ha editado deja de ser
fiable, y la siguiente regeneración pisaría el cambio en silencio.

### 5.4 · Los dos ajustes de Windows que casi siempre hacen falta

El paso 1 del script los diagnostica. Existen porque **SSMS y el backend del
HMI no se conectan igual**: SSMS usa memoria compartida y autenticación de
Windows; el backend usa TCP/IP y manda usuario y contraseña. Que SSMS funcione
no demuestra que el HMI vaya a conectar.

**A · Modo de autenticación mixto.** Si el diagnóstico dice
*"Windows UNICAMENTE"*, el login `hmi_app` se crea igual pero SQL Server le
rechazará la conexión con `Login failed for user 'hmi_app'`.

> SSMS → clic derecho en el servidor → *Properties* → *Security* →
> **SQL Server and Windows Authentication mode** → OK → **reiniciar el
> servicio** (`services.msc` → *SQL Server (MSSQLSERVER)* → *Restart*).
> Sin el reinicio no aplica.

**B · TCP/IP habilitado en el 1433.** Si el diagnóstico no devuelve puerto o
`TcpPort` sale vacío, el backend fallará con `Login timeout expired`.

> *SQL Server Configuration Manager* → *SQL Server Network Configuration* →
> *Protocols* → **TCP/IP = Enabled** → doble clic → pestaña *IP Addresses* →
> **IPAll**: `TCP Port = 1433`, `TCP Dynamic Ports` **vacío** → reiniciar el
> servicio.

`TCP Dynamic Ports` con valor es lo típico de SQL Server **Express**: usa un
puerto que cambia en cada arranque, y una cadena de conexión con puerto fijo
nunca lo encuentra. Fijarlo en 1433 es lo que menos falla.

### 5.5 · Dar de alta la conexión local en el HMI

```json
{
  "db_id": "local",
  "motor": "mssql",
  "nombre": "HMI PSI (local)",
  "host": "localhost",
  "puerto": 1433,
  "base_datos": "HMI_PSI",
  "usuario": "hmi_app",
  "password": "<PASSWORD_HMI_APP>",
  "opciones": {
    "driver": "ODBC Driver 18 for SQL Server",
    "TrustServerCertificate": "yes"
  }
}
```

Aplica el mismo aviso de §4.3: hasta que se arregle el punto **B** de
`ANALISIS_PROYECTO.md`, el backend descarta `TrustServerCertificate` y el
Driver 18 rechazará el certificado autofirmado de la instancia local.

Con `db_id` distintos (`local` y `psi`) puedes tener **las dos conexiones dadas
de alta a la vez** y apuntar cada grupo de historización a la que quieras.

> **Nota sobre el host:** usa `localhost`, no `localhost\SQLEXPRESS` junto con
> `puerto`. ODBC ignora el nombre de instancia cuando hay puerto, y la mezcla
> de los dos es el punto **C** de `ANALISIS_PROYECTO.md`. Instancia con nombre
> **o** puerto fijo, nunca los dos.

---

## 6 · Credenciales

**En este documento van como marcadores (`<PASSWORD_SA>`, `<PASSWORD_HMI_APP>`)
a propósito.** `docs/` sí se versiona en git, y el repositorio está en GitHub:
una contraseña escrita aquí queda en el historial para siempre, aunque se borre
después en un commit posterior.

Dónde viven las de verdad:

| Credencial | Dónde |
|---|---|
| `sa` del contenedor | Solo en la variable `MSSQL_SA_PASSWORD` del `docker run`. No se usa desde el HMI |
| `hmi_app` | Se manda una vez en `POST /db`; el backend la cifra con Fernet en `datos/conexiones.json`, con la clave en `datos/.clave`. `datos/` está en `.gitignore` |

Si copias `conexiones.json` a otra máquina **sin** su `.clave`, las contraseñas
no se podrán descifrar y habrá que volver a introducirlas.

---

## 7 · El login, conectado a las cuentas

Fecha: 26 ago 2026. Lo que sigue documenta el estado real de la pantalla de
acceso tras revisarla de punta a punta.

### 7.1 · Ya estaba conectada (el comentario mentía)

`Login.tsx` llevaba una cabecera que decía **"⚠️ SOLO DISEÑO. Todavía NO habla
con el backend"**, y un aviso ámbar en el pie con el mismo mensaje. Las dos
cosas eran falsas: el `enviar()` de esa misma pantalla ya llamaba a
`registro()` y `login()` de `services/authApi.ts`, que pegan a
`/auth/registro` y `/auth/login`, guardan el token y navegan a `/menu`.

Los dos avisos se eliminaron. Un cartel que dice "esto no es real" sobre una
sesión que **sí** lo es no es prudencia: hace dudar de un login que funciona, y
tapa el trabajo pendiente de verdad.

Solo queda la advertencia de `ATAJO_DEV`, que se muestra **únicamente cuando
está activo** — eso sí es peligroso mientras lo esté.

### 7.2 · La pantalla ahora pregunta antes de pedir datos

Al montarse llama a `GET /auth/estado` (público, sin sesión) y decide qué
pintar. Antes rellenabas el formulario entero para descubrir al pulsar el botón
que no había base de datos.

| Estado | Qué se muestra |
|---|---|
| Backend caído | Aviso rojo; no se pide nada |
| Sin base de datos | El motivo exacto que redacta el backend, no un texto genérico |
| Sin ninguna cuenta | Abre en **Crear cuenta**, avisa de que será Supervisor |
| Ya hay cuentas | Solo **Entrar**; la pestaña de registro desaparece |

**La primera cuenta.** El backend la fuerza a `Supervisor` pida lo que pida
—hace falta un administrador inicial—, así que el desplegable de categoría se
bloquea en `Supervisor` y se dice por qué. Antes dejaba elegir "Usuarios" y
devolvía un Supervisor: la elección era decorativa.

**A partir de la segunda**, `/auth/registro` exige rol Supervisor. La pestaña
"Crear cuenta" y el enlace del pie se ocultan, y en su lugar aparece una nota
que explica que las cuentas las da de alta un Supervisor. Es preferible a
dejar que alguien rellene el formulario y choque contra un 403.

### 7.3 · Elegir base de datos al entrar (opción **B**)

El login tiene un **desplegable de base de datos**, arriba del todo, antes de
usuario y contraseña. Se pobla desde `GET /auth/estado`, que ahora devuelve el
catálogo de conexiones dadas de alta.

**Por qué arriba y no escondido en la configuración.** Cada base tiene su
**propia tabla `usuarios`**: una cuenta creada en la local no existe en la del
servidor. Entrar con la opción equivocada devuelve *"usuario o contraseña
incorrectos"* aunque la contraseña sea correcta — un error que miente. La
pantalla hace tres cosas para que eso no sorprenda:

1. La elección va **antes** de las credenciales, no después.
2. Las bases que no responden se marcan `(sin conexión)` en la propia opción,
   y sale un aviso rojo si eliges una: no se deja intentar a ciegas.
3. Se recuerda **la última con la que se entró de verdad** (`hmi.auth.db`, por
   navegador), no la última que se seleccionó.

Con **una sola** conexión dada de alta el desplegable no aparece: no hay nada
que decidir, y queda el badge informativo de siempre.

#### El agujero que abre B, y cómo se cierra

Poder elegir base introduce una escalada de privilegios que no existía, y vale
la pena entenderla porque no es evidente:

> El alta de la **primera** cuenta es anónima a propósito —sin eso el sistema
> no se puede poner en marcha— y esa primera cuenta se crea como
> **Supervisor**. Si "la primera" se midiera **por base**, con dos bases
> registradas y una vacía, cualquiera podría darse de alta como Supervisor en
> la vacía, entrar con ella... y ser Supervisor de **todo el backend**: los
> permisos que concede la sesión no son por base, son del proceso entero.

Se cierra con `AuthManager.contar_en_todas()`: el conteo que abre o cierra la
puerta de arranque suma **todas** las bases. En cuanto existe una cuenta en
cualquier sitio, crear la siguiente exige un Supervisor — también para estrenar
una base nueva.

> **Las bases que no responden se ignoran en ese conteo**, con un WARNING en el
> log que las nombra. Es una concesión deliberada, y conviene entender los dos
> lados:
>
> Contarlas como "desconocido → bloquea" parece más seguro, pero deja el
> sistema en un estado sin salida: una sola conexión vieja e inservible impide
> crear la PRIMERA cuenta en una base que funciona — justo cuando todavía no
> hay nadie que pueda entrar a borrar la conexión rota. Pasó de verdad: tres
> SQLite de pruebas apuntando a rutas de Linux devolvían 503 al registrarse en
> un SQL Server perfectamente sano, y el mensaje de error hablaba de SQLite,
> que no era la base donde se estaba registrando.
>
> El riesgo que queda es estrecho: alguien crearía un Supervisor en una base
> vacía **solo si** todas las alcanzables están vacías Y una inalcanzable tiene
> cuentas Y `PLC_AUTH_REQUERIDA=true`. Y queda registrado en el log.

#### La sesión recuerda contra qué base se autenticó

`Sesion` guarda un `db_id`, y `GET /auth/usuarios` y
`PATCH /auth/usuarios/{u}` usan **el de la sesión**, no el de por defecto.

Sin eso, un Supervisor que entró en local y pulsa "desactivar a jmendoza"
estaría desactivando al `jmendoza` **del servidor**, que es otra persona: el
`id` 3 de una base y el `id` 3 de la otra no tienen nada que ver.

El alta de cuenta queda en la auditoría **con la base de destino**. "Se creó la
cuenta" sin decir dónde no responde la única pregunta que uno se hace cuando
esa cuenta luego no aparece.

#### Lo que cambió

| Sitio | Cambio |
|---|---|
| `AuthManager._db_id(explicito)` | La base pedida gana sobre `PLC_AUTH_DB_ID`, y se **valida** que exista: un `db_id` inventado desde el navegador da 404 con la lista de las que sí hay |
| `AuthManager.bases_disponibles()` | Catálogo público para el desplegable. Sin host ni credenciales |
| `contar`, `registrar`, `login`, `listar`, `cambiar_*` | Aceptan `db_id` |
| `contar_en_todas()` | Cierra el agujero de arriba |
| `Sesion.db_id` | Contra qué base se autenticó |
| `GET /auth/estado?db_id=` | `hay_usuarios` y `bd_disponible` **de esa base** |
| `POST /auth/login` · `/auth/registro` | Aceptan `db_id` opcional |

`PLC_AUTH_DB_ID` no desaparece: sigue decidiendo cuál sale **preseleccionada**
(`por_defecto` en el catálogo) y cuál se usa cuando nadie manda `db_id`.

### 7.4 · "Recordarme" ahora hace algo

El check existía y no controlaba nada: el token iba **siempre** a
`localStorage`. Ahora elige el almacén:

| Marcado | Almacén | Consecuencia |
|---|---|---|
| Sí | `localStorage` | La sesión sobrevive a cerrar el navegador |
| No | `sessionStorage` | Muere al cerrar la pestaña |

`setToken()` escribe en **uno** y limpia el otro. Si quedaran los dos, cerrar
la pestaña no cerraría la sesión y el check volvería a no hacer nada. En un PC
de planta compartido esto no es un detalle: dejar la sesión abierta significa
que el siguiente turno entra con tu nombre y tus permisos.

Esto **no** cambia la duración de la sesión en el servidor, que sigue siendo de
12 h. Solo decide cuánto vive la copia que guarda el navegador.

### 7.5 · "¿Olvidaste tu contraseña?" ya no es un botón muerto

No hay restablecimiento por correo, y no se añadió: en un HMI de planta esa vía
es una puerta de entrada más, y exigiría un servidor de correo que hoy no
existe. El botón despliega la explicación de la vía real — pedirle a un
Supervisor que asigne una nueva con `PATCH /auth/usuarios/{usuario}`, que
además cierra todas las sesiones de esa cuenta.

### 7.6 · Configurar la base sin salir de la aplicación

Hasta aquí, dar de alta una conexión exigía PowerShell o Swagger. Eso deja
fuera a cualquiera que no sea técnico — y peor: crea una paradoja.

#### La paradoja del arranque

Para entrar hace falta una base de datos: es donde vive la tabla `usuarios`.
Pero el formulario para dar de alta esa base vivía dentro del editor de flujos,
**que está detrás del login**. Sin una terminal a mano, un usuario nuevo se
quedaba encerrado fuera de su propia aplicación.

El backend ya tenía la solución y nadie la usaba: mientras `contar_en_todas()`
devuelve 0 —o sea, mientras no exista ninguna cuenta en ninguna base—
`exigir_rol()` deja pasar los endpoints de administración. Es la misma ventana
que tiene un router recién sacado de la caja, y se cierra sola en cuanto se
crea la primera cuenta.

**`components/auth/AsistenteArranque.tsx`** usa esa ventana. Cuando
`bd_disponible` es false, el login ya no muestra un cartel rojo que deja
tirado a quien lo lee: muestra el formulario de conexión con *Probar y guardar*.

No inventa ningún permiso: si ya hay cuentas, `POST /db` responde 401 y el
asistente enseña ese mensaje tal cual, que es la respuesta correcta.

**Lo que el asistente NO hace:** crear la base de datos ni sus tablas. Eso
sigue siendo un `.sql` que ejecutas tú, por el mismo motivo de siempre — una
aplicación con permisos para alterar la estructura de la base de producción es
una aplicación que puede romperla. La pantalla lo dice, para que
`Cannot open database` no parezca un fallo del asistente.

**El encadenado.** Al guardar no navega a ningún sitio: le devuelve al login
el `db_id` de la conexión creada y este **se cambia a ella**. Con la base
conectada, `bd_disponible` pasa a true y `hay_usuarios` a false, así que el
login abre solo la pestaña "Crear cuenta" con la categoría fija en Supervisor.
Dos pantallas y estás dentro.

> **Devolver el `db_id` no es un detalle.** En la primera versión el asistente
> solo avisaba "ya está", y el login recargaba el estado de la base que tuviera
> **seleccionada** — que era justamente la rota, por eso se estaba viendo el
> asistente. Resultado: el `POST /db` respondía 200, la conexión quedaba
> guardada, y la pantalla volvía a pintar el formulario **en blanco**. Guardar
> parecía no haber hecho nada.
>
> La conexión creada se guarda además como base preferida del navegador en ese
> mismo momento. Sin eso, al recargar la página el login volvería a elegir la
> primera conexión de la lista y el asistente reaparecería sobre una base que
> acabas de configurar bien.

#### Gestión de bases en Configuración

**`components/bd/PanelBasesDatos.tsx`** cierra el ciclo de vida completo:
listar, añadir, probar y borrar. Los cuatro endpoints existían y **no los
llamaba nadie** — estaban en la lista de "17 sin consumir" de
[`ANALISIS_PROYECTO.md`](ANALISIS_PROYECTO.md).

| Endpoint | Qué aporta en la vista |
|---|---|
| `GET /db` | La lista con el estado del pool en vivo |
| `POST /db` | Alta. **Verifica antes de guardar**: si falla, no persiste nada |
| `POST /db/{id}/test` | `SELECT 1` + latencia, y **reabre el pool si se cayó** |
| `DELETE /db/{id}` | Baja. Borra también sus consultas guardadas |

Dos detalles que se notan al usarlo:

- **"Probar" no es cosmético.** Reabre el pool, así que sirve de *reconectar*
  para una base que estaba apagada cuando arrancó el servicio. Antes, la única
  forma de recuperarla era reiniciar el backend entero.
- **Borrar confirma en dos pasos, en el sitio**, sin diálogo del navegador.
  `DELETE /db/{id}` se lleva por delante todas las consultas guardadas de esa
  conexión y no se puede deshacer. Los datos de la base no se tocan, y la
  confirmación lo dice para que nadie lo dude.

Aquí es donde se da de alta la **segunda** base —la de la nube, la de
pruebas—, porque el asistente del login solo aparece cuando no hay ninguna.

#### El selector, plegado

Con más de una base, el login ya no enseña el desplegable siempre. Muestra una
línea con la base actual y un *Cambiar*. Se despliega solo en los dos casos en
que la elección importa de verdad:

1. **La base elegida no responde.** Insistir con las credenciales no va a
   servir: el problema está una capa más arriba.
2. **El último intento de entrar falló.** *"Usuario o contraseña incorrectos"*
   es exactamente lo que se ve al equivocarse de base, y esa posibilidad tiene
   que estar delante de los ojos en vez de dejar a alguien reescribiendo una
   contraseña que era correcta.

Fuera de esos dos casos se queda plegado: quien entra todos los días a la misma
base no debería mirar un control que no va a tocar.

#### Las tres trampas de `ConnectionForm`

Ese formulario ahora lo ve gente que no es técnica, así que había que quitarle
lo que hacía fallar la primera prueba:

| Antes | Ahora | Por qué |
|---|---|---|
| `host = localhost\SQLEXPRESS` **y** `puerto = 1433` | `host = localhost`, puerto 1433 | ODBC ignora el nombre de instancia si hay puerto. Es el punto **C** de `ANALISIS_PROYECTO.md`. Además avisa si escribes una instancia teniendo puerto |
| Driver ODBC 17 por defecto | **Driver 18** | Es el que instala Microsoft hoy |
| Sin `TrustServerCertificate` | Casilla, marcada de salida | El Driver 18 cifra por defecto y rechaza el certificado autofirmado de un contenedor o de una instancia local |

#### Un arreglo que venía de propina

`flows/api.ts` no adjuntaba el token de sesión. En cuanto se active
`PLC_AUTH_REQUERIDA=true`, **todos** los formularios del editor de flujos
habrían empezado a recibir 401 con una sesión abierta y perfectamente válida.
Ahora `pedir()` manda `Authorization: Bearer` como el resto de la aplicación.

### 7.7 · Lo que sigue pendiente

- **Rutas sin proteger.** `/menu`, `/config`, `/designer` y `/preview` se abren
  escribiendo la URL, sin sesión. El backend sí aplica los permisos endpoint
  por endpoint, así que no hay fuga de datos — pero la vista entra y luego
  falla por dentro, que es peor experiencia que no dejar entrar.
- **El `.env` no activa nada.** Faltan `PLC_AUTH_REQUERIDA=true` y
  `PLC_AUTH_DB_ID`. Sin lo primero la sesión es opcional y el lápiz del
  diseñador no bloquea a nadie.
- **Gestión de usuarios en la vista.** `GET /auth/usuarios` y
  `PATCH /auth/usuarios/{u}` existen y no los llama nadie: hoy un Supervisor no
  puede crear la segunda cuenta ni cambiar un rol desde la interfaz. Es el
  hueco más visible que queda del bloque de identidad.

---

## 8 · Diagnóstico de conexiones

Los tres errores de §2 y los cuatro de §7 tienen algo en común: **el error del
driver nunca dice qué hacer**, y a veces ni siquiera dice dónde está el
problema. La secuencia real de esta puesta en marcha fue:

```
IM002 · No se encuentra el nombre del origen de datos   -> faltaba el driver ODBC
10061 · el equipo de destino denegó la conexión          -> TCP/IP deshabilitado
18456 · Login failed for user 'hmi_app'                  -> modo "solo Windows"
```

Cada uno costó una vuelta entera de prueba y error, y ninguno mencionaba la
causa. Pero la información **sí estaba** en el error: el código lo identifica
sin ambigüedad. Solo faltaba traducirlo.

`app/db/diagnostico.py` lo hace. Devuelve `{codigo, titulo, mensaje,
sugerencia, detalle}` y lo usan tanto `POST /db` como `POST /db/{id}/test`.

### 8.1 · Los códigos, y por qué cada uno es distinto

| `codigo` | Qué pasó | Códigos que lo delatan |
|---|---|---|
| `falta_paquete` | Falta la librería Python del motor | `ModuleNotFoundError` |
| `falta_driver` | Falta el driver ODBC del **sistema** | `IM002` |
| `sin_servidor` | Nada escucha en `host:puerto` | `10061` · `2003` · connection refused |
| `host_desconocido` | El nombre no resuelve | `getaddrinfo failed` · `2005` |
| `timeout` | Ni acepta ni rechaza (firewall silencioso) | `HYT00` · `Login timeout expired` |
| `tls` | Certificado autofirmado rechazado | `SSL Provider` · `certificate chain` |
| `base_no_existe` | Conecta y autentica, pero no hay esa base | `4060` · `1049` · `3D000` |
| `credenciales` | El servidor rechaza usuario/contraseña | `18456` · `1045` · `28P01` |
| `sin_permisos` | Entra, pero no puede operar | `229` · `1044` · `42501` |
| `ruta_no_existe` | SQLite: la carpeta no existe | `unable to open database file` |

Los cuatro motores están cubiertos. Tres casos llevan además la explicación que
costó descubrir a mano:

- **`sin_servidor` en SQL Server** menciona que TCP/IP viene deshabilitado de
  fábrica y que **SSMS conecta igual** porque usa memoria compartida — el
  detalle que hace que el problema parezca imposible.
- **`credenciales` en SQL Server** menciona el modo "solo Windows": el login
  existe, la contraseña es correcta, y aun así no entra.
- **`ruta_no_existe`** avisa de mezclar rutas de sistemas distintos, que es lo
  que dejó tres conexiones SQLite apuntando a `/tmp` en una máquina Windows.

### 8.2 · El empate que el texto no puede resolver

SQL Server manda **`18456` y `4060` a la vez** —"Login failed" y "Cannot open
database"— en dos situaciones distintas:

* el login no existe, o la contraseña está mal;
* el login es correcto, pero la base no existe (o no tiene acceso a ella).

Leyendo el texto es imposible separarlas, y equivocarse tiene consecuencias:
ofrecer *"¿creo la base?"* cuando el problema es un usuario mal escrito manda a
la persona a crear algo que ya existe.

Se resuelve como lo haría un DBA: **probando esas mismas credenciales contra
`master`**, que existe siempre.

```
conecta a master  ->  las credenciales valen  ->  falta la base
no conecta        ->  el problema son las credenciales
```

Está en `provision.afinar_diagnostico()`, y solo se paga esa conexión de más
cuando el diagnóstico quedó marcado como `ambiguo`. El resultado lleva una
**nota** diciendo cómo se supo — un diagnóstico que afirma más de lo que dice
el error tiene que enseñar en qué se basa:

> *Comprobado: con este usuario tampoco se puede entrar a 'master', así que el
> problema son las credenciales y no la base de datos.*

Mientras la sonda no se ha ejecutado, gana el diagnóstico que **no promete de
más**: un fallo de credenciales no invita a crear nada.

### 8.3 · Lo que deliberadamente NO hace

**No dice si un motor está instalado.** No se puede saber, y prometerlo sería
mentir. Lo único observable es si algo responde en `host:puerto`, y eso tiene
cuatro causas: no instalado, instalado pero parado, escuchando en otro puerto,
o tapado por un firewall.

Esta instalación es la prueba: SQL Server estaba instalado, corriendo y con la
base creada — y no respondía porque TCP/IP estaba apagado. Un mensaje
diciendo *"no tienes SQL Server instalado"* habría mandado a alguien a
descargar un instalador que no necesitaba.

Por eso `sin_servidor` describe lo observado y enumera las causas en el orden
en que conviene comprobarlas, en vez de elegir una.

### 8.4 · El error original nunca se pierde

`detalle` lleva siempre el texto literal del driver, incluida la excepción
original que SQLAlchemy envuelve en `.orig` — que es donde vive el código
concreto. En la vista aparece plegado bajo *"Detalle técnico"*.

Es intencionado: un diagnóstico que se equivoque **y además** esconda el error
real deja a la persona sin nada. El texto crudo es feo, pero es lo que se puede
buscar en Google.

### 8.5 · Cómo se ve

`components/bd/PanelDiagnostico.tsx` lo pinta en tres capas —qué pasó, qué
hacer, y el detalle plegado— con un icono por familia de problema. El icono no
es adorno: una llave y un enchufe roto separan de un vistazo "revisa la
contraseña" de "ni llegaste al servidor", que son justo los dos que más se
confunden.

Lo usan el asistente de primer arranque y la gestión de bases de Configuración.

---

## 9 · Crear la base de datos desde la aplicación

El diagnóstico de §8 dejó un código con un significado muy concreto:
**`base_no_existe` = el servidor respondió, aceptó las credenciales, y lo único
que falta es la base**. Ese es el único momento en que ofrecer crearla ayuda en
vez de despistar — ante un fallo de red o de contraseña sería mandar a alguien
por el camino equivocado.

`POST /db/provision` + `components/bd/CrearBaseDatos.tsx` cubren ese hueco.

### 9.1 · El principio no se rompe: son dos actos distintos

Este proyecto repite en tres documentos que el backend no crea ni altera
estructura. Eso **sigue siendo cierto**, porque aquí hay dos cosas diferentes:

| | Quién | Con qué credenciales | Cuándo |
|---|---|---|---|
| **Operar** | El HMI, siempre | `hmi_app`, solo filas | Continuamente |
| **Provisionar** | Una persona, una vez | `sa` / `root` / `postgres` | Al instalar |

Lo que hace este endpoint es dejar que la aplicación **pida prestada** una
credencial de administrador para una operación, la use y la olvide. No entra en
`conexiones.json`, ni en el log, ni en la auditoría — que se guarda en claro.

Lo que se persiste después, por la vía normal de `POST /db`, es la conexión con
el usuario limitado. Exactamente como antes.

### 9.2 · Qué hace, en orden

```
1. CREATE DATABASE            si no existe
2. Las cuatro tablas + índices  opcional · ddl_esquema_hmi(), el MISMO del .sql
3. Usuario del HMI + GRANT      opcional · solo filas, nunca estructura
4. VERIFICAR entrando como ese usuario
```

Devuelve el parte paso a paso, y la vista lo pinta tal cual: lo que se creó con
un tic verde, lo que ya estaba con un guion gris. Es **idempotente**: reintentar
tras arreglar un fallo de un paso posterior no rompe los anteriores.

**El paso 4 no es adorno.** Abre una sesión con la cuenta del HMI —no con la de
administrador— y cuenta las tablas. Es lo mismo que hace un DBA al final de una
instalación, y por el mismo motivo: los tres pasos anteriores pueden salir bien
y aun así la aplicación no poder entrar, porque un `GRANT` no se aplicó, un
usuario quedó sin mapear o un rol se asignó mal. Que `sa` pueda conectarse no
demuestra nada sobre si `hmi_app` puede.

Es exactamente el paso 7 de §1, el que en el despliegue del servidor fue "la
prueba que importa".

### 9.3 · Comparado con hacerlo a mano

Frente a la instalación manual de §1 y §5:

| Paso manual | ¿Lo hace el endpoint? |
|---|---|
| `CREATE DATABASE ... COLLATE Modern_Spanish_CI_AS` | ✅ misma collation por defecto |
| `CREATE LOGIN` | ✅ |
| `CREATE USER` + `db_datareader` / `db_datawriter` | ✅ |
| Las 4 tablas y los 6 índices | ✅ mismo `ddl_esquema_hmi()` |
| Verificar entrando como `hmi_app` | ✅ paso 4 |
| **Activar TCP/IP y fijar el puerto** | ❌ **no puede** |
| **Cambiar a autenticación mixta** | ❌ **no puede** |
| **Abrir el puerto en el firewall** | ❌ **no puede** |

Los tres últimos son **configuración del servidor, no de la base de datos**:
viven en el registro de Windows, solo se leen al arrancar el servicio, y
aplicarlos exige **reiniciar SQL Server** — lo que cortaría también
`SistemaclientePSI` y cualquier otra base de ese motor. Eso lo decide una
persona, no un formulario.

Pero hay una simetría que lo salva: esos tres son **precondiciones**. Si TCP/IP
está apagado o el servidor está en modo "solo Windows", la petición de
aprovisionamiento **no llega siquiera al servidor**, así que falla antes con un
`sin_servidor` o un `credenciales`… que son justo los dos diagnósticos de §8
que explican qué tocar y por qué. Lo que no se puede automatizar, se explica.

### 9.4 · El usuario de la base lo eliges tú

`hmi_app` es solo el nombre que usa esta instalación. Cada despliegue puede
llamarlo como quiera —`operador_planta`, `usr2026`, lo que sea— y el
aprovisionamiento lo crea con ese nombre.

Por eso el panel aparece **también** ante un diagnóstico de `credenciales`, no
solo cuando falta la base: si escribes un usuario que todavía no existe, lo
razonable es ofrecer crearlo, no obligarte a abrir SSMS. En ese caso el titular
cambia a *"¿El usuario «X» todavía no existe?"* y la casilla de crearlo viene
marcada, porque es justo lo que has venido a hacer.

**Si el usuario ya existe, no se le cambia la contraseña.** Solo se le
(re)aplican los permisos, que es idempotente y arregla el caso de una cuenta
creada a mano a la que se le olvidó el `GRANT`. Alguien que se equivoca al
teclear su contraseña y pulsa "crear usuario" espera que le digan que ya
existe, no que le reescriban la credencial de una cuenta en uso.

El parte lo dice tal cual, sin un "creado" genérico que mienta:

```
+ usuario  El login 'hmi_app' ya existía (no se toca su contraseña).
           Permisos de lectura y escritura de filas aplicados.
```

**Límite del nombre:** solo letras, dígitos y guion bajo, empezando por letra.
`mi-usuario` o `1usr` se rechazan antes de tocar el servidor. Es la lista
blanca de §9.5: los identificadores no se pueden bindear, así que la única
defensa es no dejar pasar nada raro.

### 9.5 · Sin tocar `sa`: autenticación de Windows

`sa` es la cuenta que todo el mundo prueba primero, y en una instalación
normal **no funciona**: cuando SQL Server se instala en modo "solo Windows"
—lo habitual— el instalador deja `sa` **deshabilitada**, y activar después el
modo mixto **no la reactiva**. Queda un servidor que sí acepta autenticación
SQL y un `sa` que sigue sin poder entrar, así que uno prueba contraseñas que
nunca van a servir.

El diagnóstico ahora lo dice cuando el usuario rechazado es exactamente `sa`,
con la consulta para comprobarlo:

```sql
SELECT name, is_disabled FROM sys.server_principals WHERE name = 'sa';
```

Pero la mejor salida es **no usar `sa`**. El panel trae marcada, en SQL Server,
la casilla *"Usar la autenticación de Windows del servidor"*: el driver ODBC
conecta con `Trusted_Connection=yes`, es decir con la identidad de Windows del
**proceso del backend**. Si esa cuenta ya es sysadmin —lo normal cuando el
backend corre en la misma máquina— no hay nada que activar, ninguna contraseña
privilegiada que escribir, y ninguna que pueda filtrarse.

> **El matiz que hay que entender:** la identidad es la del backend, **no** la
> de quien está mirando el navegador. Si el servicio corre en otra máquina o
> bajo otra cuenta de servicio, entrará como esa otra cuenta — y probablemente
> sin permisos. En ese caso sí hacen falta credenciales SQL, y cualquier login
> `sysadmin` sirve: no tiene por qué ser `sa`.

### 9.6 · Lo que nunca hace

- **`DROP` de nada.** Ni bases, ni tablas, ni usuarios.
- **Tocar una tabla existente.** Todo el DDL es `IF NOT EXISTS`.
- **Dar permisos de estructura al usuario del HMI.** Ni `db_ddladmin` en SQL
  Server, ni `CREATE`/`ALTER`/`DROP` en MySQL, ni `OWNER` en PostgreSQL.

### 9.7 · Los detalles que hacen que funcione de verdad

**`AUTOCOMMIT` obligatorio.** `CREATE DATABASE` no puede ejecutarse dentro de
una transacción ni en SQL Server ni en PostgreSQL, y SQLAlchemy 2.0 abre una
por defecto. Sin `isolation_level="AUTOCOMMIT"` el paso falla con un error que
habla de transacciones y no de lo que se estaba intentando.

**Una base de mantenimiento para crear otra.** No se puede crear una base
estando conectado a ella: se entra por `master` (SQL Server), `postgres`
(PostgreSQL) o sin base seleccionada (MySQL).

**Identificadores con lista blanca.** Los nombres de base y usuario **no se
pueden bindear** —SQL no lo permite para identificadores—, así que van
interpolados. La única defensa es no dejar pasar nada que no sea letras,
dígitos y guion bajo. Verificado: `HMI; DROP DATABASE x`, `1base`, `hmi-prod` y
un nombre de 70 caracteres se rechazan antes de tocar el servidor.

**Contraseñas escapadas.** `CREATE LOGIN ... WITH PASSWORD = :p` tampoco es SQL
válido en ningún motor. Se duplican las comillas simples y, en MySQL, también
las barras invertidas — ahí sí son carácter de escape.

**PostgreSQL: `ALTER DEFAULT PRIVILEGES`.** Sin eso, una tabla creada mañana
nacería sin permisos para el HMI y el fallo aparecería semanas después, cuando
nadie recuerda haber tocado nada.

**SQLite es otro caso.** No hay servidor ni usuarios: "crear la base" es crear
la carpeta —el motor crea el fichero solo, pero no el directorio— y ejecutar el
DDL. Es justo el fallo de las tres conexiones fantasma de esta instalación.

### 9.8 · Verificado

El ciclo completo, con SQLite, sobre una ruta cuya carpeta no existía:

```
1 · Primer intento    -> ruta_no_existe · "No se puede abrir el fichero"
2 · El usuario acepta -> + carpeta creada
                         + base disponible
                         + tablas creadas
                         · SQLite no tiene usuarios
3 · Reintento         -> conecta · alarmas, plc_prg, recetas, usuarios
```

Y la segunda pasada informa los tres primeros pasos como omitidos, sin error.

Para SQL Server, MySQL y PostgreSQL el código está escrito contra la
documentación de cada motor, pero **solo SQLite se ha probado de extremo a
extremo** — no había un servidor de los otros tres a mano en el entorno donde
se construyó.

---

## 10 · El nodo "Conexión BD" apunta, no duplica

En el editor de flujos, ese nodo pedía otra vez host, puerto, base, usuario y
contraseña — datos que el backend **ya tenía**. Eso creaba tres problemas:

- **Dos sitios donde editar lo mismo.** Cambiar el puerto en Configuración
  dejaba el nodo mintiendo, y viceversa.
- **Una contraseña de más.** Viajaba en el `POST` y se guardaba en el diseño
  del lienzo (`localStorage`), que es el punto **H** de
  [`ANALISIS_PROYECTO.md`](ANALISIS_PROYECTO.md).
- **Trabajo repetido** para declarar algo que ya existía.

Ahora el nodo arranca en modo **"usar una existente"**: un desplegable con las
conexiones de `GET /db`, y debajo sus datos **en solo lectura**. Mostrarlos
editables sería mentir — cambiarlos ahí no cambiaría nada en el backend.

El nodo guarda únicamente el `db_id`. **La contraseña no se copia** (`GET /db`
nunca la devuelve) y tampoco hace falta.

### Guardar ya no significa lo mismo

| Modo del nodo | Qué hace "Guardar" |
|---|---|
| Usar una existente | `POST /db/{db_id}/test` — comprueba que responde |
| Declarar una nueva | `POST /db` — la da de alta, como siempre |

El primero es importante: reenviar un `POST /db` con la contraseña vacía haría
que el backend rechazara por credenciales una conexión que estaba
perfectamente. Y comprobar tiene un efecto útil de propina — reabre el pool si
se había caído.

Si no hay ninguna conexión dada de alta, el formulario cae solo en el modo de
crear: no se ofrece elegir de una lista vacía.

`ConnectionForm` recibe `permitirExistente` solo desde el editor de flujos. En
el asistente de primer arranque y en el alta de Configuración se está creando
una nueva por definición, así que ahí va apagado.

---

## 11 · Dónde viven los datos en la aplicación instalada

Al empaquetar como `.exe`, la carpeta `datos/` no puede seguir estando donde
estaba. Dos motivos, y el segundo es el grave:

* `Program Files` es de solo lectura para un usuario normal;
* y si se escribiera junto al `.exe`, **desinstalar o actualizar la versión se
  llevaría por delante los PLCs, las pantallas y las conexiones**.

### 11.1 · Por qué NO es «Documentos»

Es lo primero que uno pide, porque se encuentra fácil. Pero **esto es un
servidor, no una aplicación personal**: los PLCs dados de alta, las pantallas
del diseñador y las conexiones pertenecen a la INSTALACIÓN, no a quien tenga la
sesión de Windows abierta.

Con los datos en `Documentos` o en `%APPDATA%`, el turno de noche que entra con
otra cuenta se encuentra el HMI **vacío**. Y el día que el servidor corra como
servicio de Windows —lo razonable en planta— correría con una cuenta de sistema
que tampoco vería nada.

Motivo secundario pero real: ahí dentro está `.clave`, que descifra todas las
contraseñas de base de datos. `Documentos` suele estar sincronizado con
OneDrive, y esa clave no debería acabar en la nube sin que nadie lo decida.

```
C:\ProgramData\PsiCore\datos      <- la elegida
```

En Linux, `/var/lib/psicore/datos` si se puede escribir; si no,
`~/.local/share/psicore/datos`.

**En desarrollo no cambia nada**: sigue siendo `<raíz>/datos`. La carpeta del
sistema solo se usa cuando corre empaquetado (`sys.frozen`).

### 11.2 · Migración: nadie pierde su configuración al actualizar

Al arrancar, si la carpeta nueva está vacía y hay datos en una antigua (junto
al `.exe`, o en la carpeta del proyecto), se **copian**.

Se copia y no se mueve a propósito: si algo fallara a mitad, el original sigue
intacto. Y en el origen queda un `_MIGRADO_A.txt` diciendo a dónde se fueron,
para que nadie edite la copia equivocada dentro de seis meses.

**Nunca sobrescribe.** Si el destino ya tiene datos, no se toca nada: una
migración que pisa lo actual con lo viejo es peor que no migrar.

Un detalle que importa: `.clave` sola no cuenta como "tiene datos". Se crea
vacía en cuanto alguien arranca el servicio, así que si contara, la carpeta
nueva parecería ocupada y la migración no llegaría a ocurrir.

Verificado en cuatro escenarios: migración limpia, segunda pasada sin pisar lo
nuevo, origen con solo `.clave`, y la marca en el origen.

### 11.3 · La pantalla: Configuración → Carpeta de datos

| Acción | Para qué |
|---|---|
| Ver la ruta | Quita la duda de "¿dónde están mis datos?" |
| **Abrir carpeta** | La abre en el explorador **del servidor** — en la app de escritorio es la misma máquina; con backend remoto lo dice en vez de fingir |
| **Descargar copia** | Todo en un `.zip`: llevarlo a otro equipo, o guardarlo antes de actualizar |
| **Restaurar** | Sube ese `.zip` y recupera la configuración |

Un aviso en rojo si la carpeta **no es escribible**. No es un detalle menor:
el servicio arranca igual y pierde todo lo que se haga en él. Mejor verlo antes
de trabajar dos horas.

La copia en `.zip` es la respuesta honesta a "quiero verlo en Documentos": la
carpeta de trabajo vive donde debe, y el respaldo se guarda donde uno quiera.

**El `.zip` incluye `.clave`** — es imprescindible, sin ella el respaldo
restaurado no podría leer sus propias contraseñas. Pero eso lo convierte en un
fichero sensible, y el `_LEEME.txt` de dentro lo dice.

### 11.4 · Restaurar exige reiniciar, y lo dice

No se recarga en caliente. Los pools de base de datos, las sesiones abiertas y
los PLCs conectados viven en memoria; cambiarles el disco por debajo dejaría el
proceso a medio camino entre dos configuraciones. Es más honesto pedir un
reinicio que fingir que no hace falta.

Dos protecciones antes de escribir nada:

- **Respaldo automático** de lo que hay ahora en `datos_antes_de_restaurar_<fecha>`.
  Si el `.zip` resulta ser el equivocado, no se ha perdido nada.
- **Validación de rutas**: un `.zip` puede contener `../../windows/system32/...`.
  Se comprueban TODAS las entradas antes de extraer una sola — comprobar a
  mitad de la extracción ya sería tarde. Verificado con un zip malicioso.

### 11.5 · Lo que cambió en el empaquetado

`desktop/servidor.py` seguía haciendo `chdir` al directorio del `.exe` y
dejando ahí los datos. Ahora se distingue:

```
junto al .exe   ->  CONFIGURACIÓN de la instalación (.env, YAML).
                    Solo lectura, se reemplaza al actualizar.
ProgramData     ->  DATOS del usuario. Sobreviven a todo.
```

Además imprime la ruta al arrancar y avisa en pantalla si no puede escribir en
ella. `build_exe.bat` lo documenta en su mensaje final.

**Nueva dependencia:** `python-multipart`, que hace falta para recibir el `.zip`
de la restauración. FastAPI no lo trae de serie, y sin él ese endpoint falla al
definirse — o sea, **no arranca la aplicación entera**. Está en
`requirements.txt`.

---

## 12 · Alarmas: definición y evento son dos cosas

El CRUD decía «alarmas y recetas» pero solo tenía ejemplos de recetas, y el
editor de alarmas de la vista llevaba desde el principio con un cartel de
`⚠️ SOLO VISTA`. Mirando por qué, apareció algo más de fondo que un ejemplo
que faltaba.

### 12.1 · El desajuste

La tabla `alarmas` guardaba **eventos**: `ts_activacion`,
`ts_reconocimiento`, `estado`, `usuario_id`. Es un historial.

El editor de la vista —y la tabla *Discrete alarms* de TIA Portal— editan otra
cosa: **definiciones**. Name, Alarm text, Alarm class, Trigger tag. La
configuración de qué vigilar.

No había dónde guardar eso. Por eso el editor no podía dejar de ser una maqueta:
no le faltaba un endpoint, le faltaba una tabla.

### 12.2 · Dos tablas

```
alarmas_def   QUÉ vigilar.  "Si DB1.temperatura pasa de 80, es un Error y
              dice «Temperatura alta»."  Se configura una vez.

alarmas       QUÉ PASÓ.  "El 26/08 a las 14:32 saltó con valor 83.4; Ana la
              reconoció a las 14:35."  Una fila por evento, crecen sin parar.
```

Meterlo todo en una tabla obliga a repetir el texto y la clase en cada evento,
y hace imposible responder *"¿qué alarmas tengo configuradas?"* sin que hayan
saltado al menos una vez. Es la separación que hacen TIA y WinCC, por lo mismo.

`alarmas` gana una FK `alarma_def_id`, **NULLable a propósito**: una alarma de
sistema ("se perdió la conexión con el PLC") no viene de ninguna regla
configurada y el evento debe poder existir igual.

### 12.3 · Los campos, calcados de TIA

Para que migrar una configuración existente sea copiar columnas y no traducir:

| TIA Portal | `alarmas_def` |
|---|---|
| Name | `nombre` |
| Alarm text | `texto` |
| Alarm class | `clase` — Critical · Error · Warning · Maintenance · Information |
| Trigger tag | `tag` (formato `"<plc>\|<tag>"`, el mismo del WebSocket) |
| Trigger bit | `bit_disparo` |
| HMI acknowledgment tag | `tag_reconocimiento` + `bit_reconocimiento` |

Y tres que TIA resuelve en una tabla aparte para alarmas analógicas, y que aquí
caben en la misma porque lo único que cambia es la comparación:

- `comparador` — `bit` (discreta) · `>` `>=` `<` `<=` `==` `!=` (analógicas)
- `valor_limite` — el umbral
- `banda_muerta` — **histéresis**. Sin ella, un valor oscilando en el límite
  genera cientos de eventos por minuto. Es el campo que separa un sistema de
  alarmas usable de uno que nadie mira.

### 12.4 · El CRUD

`alarmas_def` entra en el catálogo cerrado, así que hereda todo lo que ya
tenían los otros recursos: filtros, paginación, columnas en lista blanca y
valores bindeados.

Tres validaciones propias, y ninguna es cosmética:

| Se rechaza | Por qué |
|---|---|
| `clase` fuera de las cinco | Una clase inventada no la pinta el editor y la alarma se vuelve invisible |
| `comparador` fuera de los siete | Igual: nada sabría evaluarla |
| Analógica sin `valor_limite` | **Una regla que parece configurada y no puede dispararse nunca.** El peor fallo posible en un sistema de alarmas: silencio que parece calma |

Y Swagger deja de mentir: hay ejemplos de definición discreta, definición
analógica y evento, más dos de `PATCH` (silenciar una definición durante un
mantenimiento, subir un umbral).

### 12.5 · Para una base que YA existe

`CREATE TABLE IF NOT EXISTS` crea `alarmas_def` sola al volver a ejecutar el
esquema, pero **no añade la columna nueva a una `alarmas` que ya está creada**.
En SQL Server:

```sql
ALTER TABLE alarmas ADD alarma_def_id BIGINT NULL;
ALTER TABLE alarmas ADD CONSTRAINT fk_alarmas_def
    FOREIGN KEY (alarma_def_id) REFERENCES alarmas_def (id) ON DELETE SET NULL;
```

En una instalación nueva no hace falta: sale ya con todo.

### 12.6 · Lo que sigue faltando

**El motor de alarmas.** Ahora hay dónde guardar las reglas y dónde guardar los
eventos, pero **nada evalúa las reglas todavía**: nadie mira los cambios de tag
del WebSocket y decide si una definición se cumple.

Es el paso siguiente, y ahora sí es un paso pequeño: engancharse a
`ConnectionManager.registrar_observador()` —igual que el historizador y el
grabador— y, por cada cambio, comprobar las definiciones activas de ese tag.
La parte difícil, que era decidir qué se guarda y dónde, ya está.

---

## 13 · Recetas: tres niveles, cuatro tablas

La tabla `recetas` guardaba **solo el nivel del medio** de lo que TIA llama
recetas, con el nombre de la receta como texto suelto repetido en cada fila.

TIA tiene tres niveles, y hacen falta los tres:

```
Recipes         Recipe_1, Recipe_2       la receta      Name · Number · Version · Path
  Elements      limon, azucar, pisco     las columnas   Tag · Data type · Min · Max
  Data records  "Mezcla del lunes"       los valores    una fila = una mezcla concreta
```

Sin el tercero una receta no sirve de nada: **los data records son las mezclas
que se cargan al PLC**. Sin el primero, `comprobar_limites`, `numero` y
`version` no tienen dónde vivir.

### 13.1 · El reparto

| Tabla | Qué guarda |
|---|---|
| `recetas` | Recipe_1 · nombre, numero, version, ruta, tipo, max_registros, tipo_comunicacion, **comprobar_limites** |
| `receta_elementos` | limon, azucar, pisco · tag, tipo_dato, min, max, decimales, unidad, orden |
| `receta_registros` | Recipe_data_record_1 · nombre, numero, comentario, ts_ultima_carga |
| `receta_valores` | 30 ml, 20 g, 60 ml · una fila por (registro, elemento) |

`recetas` pasa a significar lo que dice. Lo que había antes es ahora
`receta_elementos`, colgando de una FK de verdad en vez de repetir el nombre de
la receta como texto en cada fila.

### 13.2 · Por qué la cuarta tabla es estrecha

Es la decisión que menos se espera. TIA **enseña** los data records como una
rejilla ancha —una columna por elemento— pero guardarlo así significaría una
columna REAL por ingrediente:

- añadir "hielo" a la receta obligaría a un `ALTER TABLE`;
- y la tabla se llenaría de `NULL`, porque cada receta tiene elementos
  distintos y todas comparten la misma tabla.

Con `receta_valores` estrecha, añadir un ingrediente no toca nunca la
estructura. **Verificado**: se añadió un cuarto elemento a una receta con un
data record ya cargado, sin tocar el esquema.

Es el mismo razonamiento por el que `plc_prg` es estrecha, ya escrito en
`SERVIDOR_SQL.md`. La rejilla ancha se reconstruye al leer, con un pivote —
trabajo de la vista, no de la base.

Regalo de propina: `valor_num` + `valor_texto` permiten que un elemento sea
`REAL` y otro `STRING` sin inventar una columna por tipo.

### 13.3 · Borrados en cascada, y uno que no

| FK | Regla | Por qué |
|---|---|---|
| `receta_elementos.receta_id` | **CASCADE** | Un elemento sin receta no significa nada |
| `receta_registros.receta_id` | **CASCADE** | Igual |
| `receta_valores.*` | **CASCADE** | Un valor sin registro ni elemento es basura |
| `*.usuario_id` | **SET NULL** | Borrar a quien creó la receta no debe llevarse la receta |

Verificado: borrar la receta deja las tres tablas hijas a cero.

### 13.4 · `comprobar_limites` deja de ser decorativo

Ese check de TIA ahora tiene dónde guardarse, y con él el backend puede validar
cada valor contra el `valor_minimo`/`valor_maximo` de su elemento **antes** de
escribirlo en la máquina.

La validación del CRUD ya lo hace al guardar el elemento —rango invertido y
default fuera de rango se rechazan— pero lo importante llega al cargar un data
record al PLC: ahí es donde un 900 donde el máximo son 90 deja de ser un dato y
pasa a ser una máquina rota.

### 13.5 · Para una base que YA existe

Las cuatro tablas se crean solas al reejecutar el esquema, pero la vieja
`recetas` **sigue ahí con la estructura antigua** y las nuevas no se crearán
porque el nombre ya está ocupado. En una instalación en marcha:

```sql
-- Con la tabla vacía (el caso de una puesta en marcha):
DROP TABLE recetas;
-- y reejecutar el esquema, que las crea las cuatro.
```

Si ya hubiera datos, hay que renombrarla a `receta_elementos`, crear la
cabecera y rellenar `receta_id` a partir del antiguo `nombre_receta`.

### 13.6 · Lo que sigue faltando

Lo mismo que en alarmas, y por el mismo motivo: **escribir al PLC**. El editor
de recetas de la vista lo dice en su propio pie —*"todavía no existe «escribir
en el PLC» ni «leer del PLC», que es lo que hace que una receta sirva de algo"*.

Ahora hay dónde guardar las tres capas; lo que falta es el paso de cargar un
`receta_registro` en los tags de sus elementos. Y ese paso, el día que exista,
necesita identidad y auditoría obligatorias: es la primera vez que el HMI
escribiría en una máquina.

---

## 14 · Borrar la base y que la vista se entere

Al recrear `HMI_PRUEBAS` para estrenar el esquema de 8 tablas salieron tres
cosas a la vez. Las tres eran reales, y las tres están arregladas.

### 14.1 · La vista seguía enseñando una base que ya no existía

El desplegable del login mostraba `HMI local1 — HMI_PRUEBAS (sin conexión)`
después de haberla borrado en SQL Server.

**Por qué.** `GET /db` devolvía `conectado` mirando `self._drivers`, que es el
diccionario de *pools abiertos*. Un pool dice si NOSOTROS tenemos una conexión,
no si la base sigue estando ahí. Son dos preguntas distintas y la vista
enseñaba la respuesta a la que no había hecho nadie.

Y no es solo un matiz cosmético: `sin conexión` a secas junta tres problemas
que se arreglan de tres formas distintas —el servidor está apagado, la
contraseña ya no vale, o **la base fue borrada**— y solo el último se puede
resolver desde la propia pantalla.

**El arreglo.** `DbManager` gana una revisión *contra el servidor*:

| Método | Qué hace |
|---|---|
| `revisar_conexion(db_id, espera)` | Prueba esa conexión y guarda el veredicto con su código de diagnóstico. Con timeout: un servidor apagado responde "no contesta" en segundos, no en minutos. |
| `revisar_conexiones()` | Todas a la vez (`asyncio.gather`): una caída no frena a las demás. |
| `estado_cacheado(db_id)` | La última respuesta conocida, sin tocar la red. |

El veredicto se guarda en `self._estados` y `listar_conexiones()` lo aplica
**por encima** del pool: si el servidor dijo que la base no existe, `conectado`
pasa a `false` aunque nos quedara un pool abierto. Además, cuando una prueba
falla ahora se cierra el pool muerto en vez de dejarlo en el diccionario
diciendo que está vivo.

Se pide explícitamente, porque cuesta una conexión por base:

```
GET /db?revisar=true
GET /auth/estado?revisar=true
```

El login lo pide **al abrirse** y después de configurar una conexión, no cada
vez que se cambia de base en el desplegable: al cambiar de base, si esa falla,
el backend ya diagnostica esa sola. Con un servidor remoto apagado, la
diferencia es una pantalla de acceso que tarda seis segundos frente a una que
tarda seis por cada base dada de alta.

Ahora el `<option>` dice **qué** pasa, no solo que algo pasa:

```
HMI local1 — HMI_PRUEBAS  (ya no existe)
HMI PSI    — HMI_PSI      (servidor no responde)
```

Y debajo, para `base_no_existe`: *"Esa base ya no está en el servidor: la
conexión sigue guardada, pero la base fue borrada o nunca llegó a crearse.
Puedes volver a crearla desde aquí."*

> **La conexión guardada no se borra sola.** Es deliberado: `conexiones.json`
> es tu configuración, no un reflejo del servidor. Que la base no esté hoy no
> significa que no vuelva mañana —una restauración, un servidor que arranca
> tarde—, y borrarte la conexión (con su usuario, su driver y sus opciones)
> por un fallo temporal sería peor que enseñarla en rojo.

### 14.2 · Dos mensajes que se contradecían en la misma pantalla

En una sola pasada del formulario de creación salía esto:

```
✓ La base 'HMI_PRUEBAS' ya existía; no se toca.
✗ La base se creó, pero el esquema falló. No se pudo conectar.
```

Las dos no pueden ser verdad. **Era un bug de redacción, no de lógica**: el
paso 1 distingue bien entre crear y encontrar, pero los mensajes de error de
los pasos 2, 3 y 4 estaban escritos como si la base siempre se acabara de
crear. `provisionar()` guarda ahora lo que pasó de verdad:

```python
hecho_base = (f"La base '{base}' ya existía"
              if existe else f"La base '{base}' se creó")
```

…y los tres pasos siguientes lo citan. El mensaje pasa a ser
`La base 'HMI_PRUEBAS' ya existía, pero el esquema falló. …`, que sí se puede
leer junto al paso 1 sin tener que decidir a cuál de los dos creer.

### 14.3 · `DROP DATABASE` borra el USER, no el LOGIN

El diagnóstico decía `El servidor rechazó el usuario 'hmi_ls'`. Dos cosas:

1. **`hmi_ls` es un error al teclear `hmi_app`.** Ese login no existe.
2. Aun escribiéndolo bien, después de borrar la base **hacía falta rehacer el
   usuario**. En SQL Server son dos objetos distintos:

   * el **LOGIN** vive en el servidor (`master.sys.server_principals`) y
     **sobrevive** al `DROP DATABASE`;
   * el **USER** vive dentro de cada base (`sys.database_principals`) y se va
     con ella, junto con sus `GRANT`.

   Por eso `hmi_app` puede seguir conectando a `master` y aun así no poder
   entrar en la base recreada: el login está, el usuario no. Es también la
   razón por la que el diagnóstico ambiguo `18456 + 4060` se resuelve
   probando `master` (§8).

**Qué hacer:** en el formulario de creación, dejar marcado *"crear el usuario
de la aplicación"* con el mismo nombre y la misma contraseña de siempre. El
paso 3 detecta que el login ya existe, no le toca la contraseña, y solo
re-mapea el USER dentro de la base nueva con sus `GRANT`. El paso 4 lo verifica
entrando **como ese usuario**.

### 14.4 · De paso: conexiones duplicadas

En las capturas había `local` y `local1` apuntando casi a lo mismo. No es un
fallo —cada `db_id` es una conexión distinta a propósito— pero un desplegable
con dos entradas casi idénticas es una forma segura de entrar en la base
equivocada y ver "usuario o contraseña incorrectos" con la contraseña buena.
Se borran desde **Configuración → Bases de datos**, con la papelera de la fila.

---

## 15 · El esquema que SQL Server no dejaba crear (Msg 1785)

El síntoma: la base `HMI_PRUEBAS2` **se creaba bien** —aparece en el Object
Explorer— y acto seguido el panel decía

```
✓ Base 'HMI_PRUEBAS2' creada con collation Modern_Spanish_CI_AS.
✗ La base 'HMI_PRUEBAS2' se creó, pero el esquema falló. No se pudo conectar.
```

**No era un problema de permisos ni de conexión.** El paso 1 acababa de entrar
con las mismas credenciales y crear una base entera; si no pudiera conectar, no
habría base. Lo que falló fue una sentencia `CREATE TABLE`, y el mensaje mentía
por dos motivos que se arreglan aparte.

### 15.1 · La causa: dos caminos en cascada hacia la misma tabla

SQL Server prohíbe que una tabla sea alcanzable por **más de un camino en
cascada** desde la misma tabla padre, y cuenta como cascada tanto
`ON DELETE CASCADE` como `ON DELETE SET NULL`. Al crear la clave foránea que
cierra el segundo camino, aborta con:

```
Msg 1785 · Introducing FOREIGN KEY constraint 'fk_receta_valores_elemento'
on table 'receta_valores' may cause cycles or multiple cascade paths.
```

El esquema de recetas de §13 tiene dos de esos cruces:

```
recetas ──CASCADE──▶ receta_registros ──CASCADE──▶ receta_valores
recetas ──CASCADE──▶ receta_elementos ──CASCADE──▶ receta_valores

usuarios ─SET NULL─▶ recetas ──CASCADE──▶ receta_registros
usuarios ─SET NULL──────────────────────▶ receta_registros
```

Y **no son un error de modelado**. Un valor de receta depende de dos cosas a la
vez (de qué registro es y de qué elemento es); una alarma, de quién la
reconoció y de qué la disparó. El modelo está bien; lo que no cabe es delegar
el borrado en el motor.

Que el fallo apareciera ahora y no antes tiene explicación: hasta §13 el
esquema eran 4 tablas sin ese cruce. El `local_hmi_psi_mssql.sql` regenerado
traía el mismo problema, así que ejecutarlo a mano en SSMS habría fallado
igual — no era la aplicación.

### 15.2 · El arreglo: ninguna FK lleva `ON DELETE`

Las claves foráneas siguen ahí —la integridad referencial no se toca—, pero sin
acción de borrado. Lo que hacía el motor lo hace ahora `CrudManager.borrar()`,
con un mapa explícito:

```python
DEPENDENCIAS = {
    "usuarios": (            # se pierde el "quién", nunca el registro
        "UPDATE {alarmas} SET usuario_id = NULL WHERE usuario_id = :id",
        "UPDATE {recetas} SET usuario_id = NULL WHERE usuario_id = :id",
        "UPDATE {receta_registros} SET usuario_id = NULL WHERE usuario_id = :id",
    ),
    "alarmas_def": (         # quitar la regla no borra los eventos que provocó
        "UPDATE {alarmas} SET alarma_def_id = NULL WHERE alarma_def_id = :id",
    ),
    "recetas": (             # de abajo arriba: valores, registros, elementos
        ...
    ),
}
```

Tres cosas se ganan con esto:

| | Antes | Ahora |
|---|---|---|
| SQL Server | no podía crear el esquema | lo crea |
| Los cuatro motores | DDL distinto de hecho | DDL idéntico |
| Borrado en cascada | implícito en el motor | escrito en el código, y auditable |

Los nombres de tabla se sustituyen desde `_tablas_hmi()`, que aplica el prefijo
del esquema y valida el identificador; del cliente solo llega `:id`, bindeado.
La limpieza no va en una transacción única a propósito: si se corta a medias
queda una fila padre con menos hijos y repetir el borrado lo termina — el orden
inverso (padre borrada, hijos huérfanos) no puede ocurrir, porque la padre se
borra la última.

### 15.3 · Y que el mensaje diga la verdad

`diagnosticar()` sabe leer errores de **conexión**. Un `Msg 1785` no lo entiende
y caía en el cajón de "No se pudo conectar" — justo lo contrario de lo que
pasaba, porque estábamos dentro de la base.

Ahora el paso 2 separa las dos cosas:

* **falla `connect()`** → "…pero no se pudo entrar en ella para crear las
  tablas", con el diagnóstico de conexión de siempre;
* **falla una sentencia** → `Falló la creación de 'receta_registros'`, con el
  nombre del objeto concreto y el **detalle técnico** del motor desplegable
  debajo, que es lo único que se puede buscar.

Sin ese detalle a la vista, este fallo era indistinguible de un problema de
permisos — que es exactamente lo que parecía.

### 15.4 · Qué hacer con una base ya creada a medias

`HMI_PRUEBAS2` quedó con las primeras tablas creadas y las últimas no. El DDL
es idempotente, así que reintentar la crea el resto; pero las tablas que ya
existen conservan las cascadas viejas y el esquema queda mezclado. Como está
vacía, sale más limpio borrarla y volver a crearla:

```sql
USE master;
ALTER DATABASE HMI_PRUEBAS2 SET SINGLE_USER WITH ROLLBACK IMMEDIATE;
DROP DATABASE HMI_PRUEBAS2;
```

(El `SINGLE_USER` es lo que evita el `Msg 3702 · cannot drop database because
it is currently in use` cuando el backend aún tiene el pool abierto.)

---

## 16 · Recetas conectadas de verdad

Hasta aquí el editor de recetas era una maqueta honesta: decía en su propio pie
que se guardaba **en el navegador**. Ya no. Las tres capas consumen el CRUD y
viven en la base de datos con la que se entró al sistema.

### 16.1 · Lo que faltaba en el backend: el `id` de lo recién creado

`POST /crud/{recurso}` respondía `"Receta creado."` y nada más. Con eso no se
puede construir nada jerárquico: tras crear una receta hace falta su `id` para
crear sus elementos con `receta_id = <ese id>`, y la vista no lo tenía. La
alternativa —volver a listar y quedarse con la última— es adivinar, y con dos
pestañas abiertas adivina mal.

`SqlDriver.insertar()` hace el INSERT y devuelve el id:

| Motor | Cómo |
|---|---|
| SQL Server | `INSERT ... OUTPUT INSERTED.id VALUES (...)` — en la misma sentencia |
| PostgreSQL | `INSERT ... RETURNING id` — en la misma sentencia |
| MySQL | `SELECT LAST_INSERT_ID()` — misma conexión, mismo `begin()` |
| SQLite | `SELECT last_insert_rowid()` — igual |

**Por qué SQL Server no usa `SCOPE_IDENTITY()`, que es lo que enseña cualquier
manual.** La primera versión lo hacía, en una segunda sentencia dentro del
mismo `begin()`. Devolvía **NULL siempre**. Las filas se creaban —se veían en
SSMS, con sus ids 1 y 2— pero la vista recibía `id = 0`, y a partir de ahí todo
lo que colgaba de esa fila fallaba con mensajes que no señalaban al culpable:

```
Faltan campos obligatorios: receta_id.      ← al añadir un elemento
No existe recetas con id 0.                 ← al borrar la receta
```

El motivo: **pyodbc manda las consultas con parámetros a través de
`sp_executesql`**, que abre un ámbito propio. `SCOPE_IDENTITY()` devuelve la
identidad *del ámbito actual*, así que preguntada en la sentencia siguiente
—otro ámbito— no ve nada. El manual no miente; lo que no dice es que el driver
mete un ámbito por el medio.

`@@IDENTITY` sí lo vería (es de la sesión, no del ámbito), pero devuelve la
identidad del último insert de la sesión **incluido el que haga un trigger**:
es justo la trampa que hay que evitar. `OUTPUT INSERTED.id` resuelve las dos
cosas — va en la misma sentencia, así que no hay ámbito que perder, y devuelve
la fila que se acaba de insertar y no la que insertara otra cosa. Su única
limitación es una tabla con un trigger `INSTEAD OF`; el esquema del HMI no
tiene triggers.

**Y un id 0 ya no viaja.** Ni el backend ni el cliente lo aceptan: `crear()`
responde 500 con *"la fila se creó pero el servidor no devolvió su
identificador"*, y `crudApi.crearCrud()` lanza antes de construir el objeto.
Un fallo que se nota tres pasos después, disfrazado de otro, cuesta mucho más
de encontrar que uno que se nota donde ocurre.

Y `crear()` devuelve además la **fila completa**: la tabla tiene columnas con
valor por defecto (`activo`, `tipo`, `max_registros`, las marcas de tiempo) que
quien la crea no conoce. Sin eso la vista pinta una fila a medias y se corrige
sola en el siguiente refresco — ese parpadeo se nota.

### 16.2 · Dos archivos nuevos en el frontend

```
services/crudApi.ts      cliente genérico de /crud/*  (sirve para alarmas también)
services/recetasApi.ts   traduce columnas <-> modelo de la vista, y compone las lecturas
```

`crudApi` manda **siempre** `db_id`: el de la base con la que se entró
(`hmi.auth.db`). Sin eso el backend usaría la primera conexión de la lista y,
con una base local y otra en el servidor dadas de alta, las recetas se
guardarían en una y se leerían de la otra. El síntoma habría sido "se borran
solas".

Dos conversiones de `recetasApi` que no son cosméticas:

* **Celda vacía → `null`, nunca `''`.** El backend valida por tipo y
  `float('')` revienta con *"el campo 'valor_minimo' esperaba un valor de tipo
  numero y llegó ''"*, que no le dice nada a quien solo borró una celda.
* **Un valor va a `valor_num` si es número y a `valor_texto` si no.** Nunca a
  las dos: si estuvieran las dos, "¿cuál manda?" tendría que responderla cada
  consumidor, y el que escriba en el PLC se equivocaría el día que no
  coincidan.

### 16.3 · Cómo se guarda

Sin botón de guardar, con un indicador en la barra superior — *Guardando… /
Guardado / No se pudo guardar*. Un guardado automático sin señal visible es
indistinguible de uno roto.

* **Texto**: se agrupa en una cola indexada por `recurso:id` y se manda tras
  600 ms de pausa. Escribir "azucar" es **un** PATCH, no seis. La vista se
  actualiza al instante; lo que se agrupa es la escritura.
* **Altas y bajas**: van al momento, porque hasta que el servidor no
  responde no hay `id` con el que seguir trabajando.
* **Al salir de la pantalla** se vacía la cola pendiente. Un cambio escrito y
  no guardado por cambiar de pestaña es la peor forma de perder trabajo.
* **Si el servidor rechaza un cambio** —por ejemplo un mínimo mayor que el
  máximo, que el backend valida porque esos números acaban en una máquina
  real— se enseña el mensaje y **se vuelve a leer la receta**, para que lo
  que se ve sea lo que hay y no un valor que solo existe en el navegador.

### 16.4 · Dos decisiones que se notan al usarlo

**El detalle se carga al seleccionar la receta, no con la lista.** Con veinte
recetas serían decenas de consultas para pintar una tabla de la que se mira una
fila.

**Las celdas se materializan al escribirlas.** Un registro nuevo no crea una
fila en `receta_valores` por cada elemento: la rejilla enseña el
`valor por defecto` del elemento como marcador —igual que TIA— y la fila
aparece cuando alguien teclea algo. Un registro con quince elementos de los que
se llenan tres son tres filas, no quince.

Hay un detalle fino ahí: teclear rápido en una celda virgen podría lanzar dos
`POST` y dejar **dos filas para la misma celda**, con una de las dos invisible
para siempre. Un candado por celda (`creandoValor`) lo impide, y lo que se
tecleó mientras el alta iba en camino se manda después, para no perder las
últimas letras.

### 16.5 · La trampa del proxy de Vite (HTTP 404 que no es del backend)

Con todo escrito, la vista devolvía esto:

```
POST http://localhost:5173/crud/recetas?db_id=local  404 (Not Found)
```

Fíjate en el puerto: **5173**, no 8000. La petición nunca salió del servidor de
desarrollo. `vite.config.js` reenvía al backend solo los prefijos que están en
su lista, y `/crud` no estaba; para todo lo demás Vite responde el `index.html`
de la SPA, que como no es lo que se pidió llega como un 404. El backend ni se
enteró — su log no tiene ninguna línea de `/crud`, y eso es lo que lo delata.

Faltaban cuatro prefijos, no uno. Ya están:

```js
'/crud': BACKEND,      // alarmas, definiciones y los cuatro niveles de recetas
'/sistema': BACKEND,   // carpeta de datos y copia zip (§11)
'/export': BACKEND,    // exportaciones CSV/XLSX
'/ai': BACKEND,        // asistente
```

> **Regla para la próxima vez.** Cada router nuevo del backend necesita su
> línea en el proxy. Comprobar que la lista está completa es un comando:
>
> ```bash
> grep -rhoP '@router\.\w+\(\s*"\K/[a-z_]+' app/api/ | sort -u
> ```
>
> Y el síntoma siempre es el mismo: un 404 **del 5173**. Si el puerto del
> error es el de Vite, el problema está aquí, no en el backend.

**Hay que reiniciar `npm run dev`.** `vite.config.js` se lee al arrancar; el
HMR no lo recarga.

### 16.6 · De paso: el log del historizador ya no se inunda

En el mismo arranque salía esto cada dos segundos, para siempre:

```
[WARNING] historian: No se pudo escribir el histórico de 'g1':
          (sqlite3.OperationalError) unable to open database file
```

El grupo `g1` apunta a la conexión `e2e`, un SQLite en `/tmp/e2e.db` que quedó
de las pruebas y que en Windows no existe. El error es legítimo; repetirlo
1.800 veces por hora no: tapa cualquier otra cosa que pase, que es justo lo que
hay que mirar cuando algo va mal.

Ahora un fallo **idéntico** se avisa la primera vez y luego cada 30 intentos,
con la cuenta (`lleva 300 intentos fallidos seguidos`), y se registra también
la recuperación. Un error *distinto* siempre se avisa: puede ser otra cosa. El
contador va además en `GET /historian`, en `fallos_seguidos`.

Las conexiones de prueba (`prod`, `hist`, `e2e`, todas a `/tmp/*.db`) se pueden
borrar desde **Configuración → Bases de datos**; el grupo `g1` que las usa,
desde el editor de flujos.

### 16.7 · Elegir el tag, y poder escribir el valor

Dos cosas que faltaban para que la pantalla se pueda usar de verdad.

**El tag de un elemento se elige, no se recuerda.** La celda *Tag* ahora ofrece
las variables de los PLCs (`GET /tags`, los tags descubiertos por browse OPC
UA), filtrando mientras escribes por PLC y por nombre a la vez. De cada uno se
ve el Data Block —o el POU, en Rexroth—, el tipo OPC y el **último valor
recibido**, que es lo que confirma que es el tag correcto cuando hay varios con
nombres parecidos.

Sigue siendo un campo de **texto libre**, no un desplegable cerrado, y es
deliberado: la lista solo existe tras un browse correcto, así que un
desplegable haría imposible configurar las recetas en la oficina con la máquina
apagada. Cuando no hay nada que ofrecer, la lista dice cuál de los dos motivos
es —no hay PLCs dados de alta, o los hay y ninguno ha conectado—, porque se
arreglan de forma distinta.

El formato que se guarda es `plc_id|tag`, el mismo del WebSocket, el
historizador y `plc_prg`; lo arma `claveTag()`, igual que el backend en
`on_mensaje()`. Sin el prefijo del PLC, dos equipos con un `Temperatura` cada
uno serían indistinguibles.

Al elegir de la lista se rellena además **Data type** a partir del tipo OPC
(`Float → Real`, `Boolean → Bool`, `Int32 → DInt`…), pero **solo si el elemento
no tenía tipo**: una elección hecha a mano manda sobre lo que diga el servidor
OPC, y un tipo inventado decide cuántos bytes se le mandan a una máquina.

**La columna rosada ya no bloquea.** TIA bloquea los valores de un elemento sin
tag, y eso copiamos. Pero el orden real de trabajo es el contrario: primero se
conoce la fórmula —30 de limón, 20 de azúcar— y después se cablea a qué tag va
cada ingrediente. Bloquear obliga a hacerlo al revés.

Ahora la celda se escribe siempre y el aviso se queda como aviso: un borde
ámbar, el ⚠ en la cabecera de la columna, el contador «N sin tag» en la barra,
y el tooltip diciendo lo único que importa —*el valor se guarda, pero hasta que
ese elemento tenga tag no hay dónde escribirlo en el PLC*—. Es la diferencia
entre una advertencia y un muro.

### 16.8 · Elegir en qué base se guardan las recetas

La pantalla tiene ahora un **«Guardar en»** en la barra superior con las
conexiones dadas de alta: la local del PC de planta, la del servidor, la que
sea. Al cambiarla, todo lo que se lea y se escriba a partir de ese momento va a
esa base — las cuatro tablas, no solo la cabecera.

**Por qué no está en la columna `Path`, que es donde se pidió.** `Path` es el
campo de TIA que dice en qué carpeta **del panel** quedan los ficheros
(`\Flash\Recipes`), y hay una razón de fondo para no reutilizarlo: una receta
no puede *apuntar* a una base de datos, porque esa fila **ya está guardada en
una**. Si `Path` dijera «servidor» mientras la fila vive en la base local,
serían dos afirmaciones contradictorias sobre el mismo dato — exactamente el
problema de §14.2, en otra forma.

La base es de la **pantalla**, no de cada receta. Así que el selector va arriba,
donde ya estaba la píldora que decía en cuál se estaba trabajando, y ahora
además deja cambiarla. La columna `Path` se queda como en TIA, con un tooltip
que aclara la diferencia.

**Cómo está hecho.** El `db_id` viaja **explícito** en cada llamada
(`listarCrud(recurso, opciones, dbId)`, `crearCrud(recurso, datos, dbId)`…) y
no en una variable global del módulo. Con una global, elegir la base en recetas
cambiaría también dónde escriben las alarmas: un efecto a distancia imposible
de ver leyendo el código de ninguna de las dos pantallas.

Dentro del editor se lee de un `ref`, no del estado. Las funciones que guardan
se crean una vez, y leyendo el estado capturarían el valor viejo: un cambio de
base podría mandar una escritura a la base anterior.

**Y el orden importa en un punto.** Al cambiar de base, lo PRIMERO es vaciar la
cola de guardado diferido: lo que está pendiente pertenece a la base anterior,
y mandarlo después del cambio lo escribiría en la nueva, sobre una fila que
allí es otra cosa —o no existe—. Es el único sitio de todo esto donde una
carrera tendría consecuencias de verdad.

La elección se recuerda por navegador (`hmi.recetas.db`) y arranca en la base
del login. Si la base recordada ya no está dada de alta, se cae sola a la del
login en vez de seguir escribiendo contra algo que no existe.

**Y no es un `<select>` nativo, por un motivo concreto.** La primera versión sí
lo era y en modo oscuro salía un panel blanco con el texto casi ilegible: esa
lista la dibuja el sistema operativo con SU tema, y no hay CSS que la alcance.
El control propio cuesta unas cincuenta líneas, se ve igual en los dos temas, y
de paso cabe lo que un `<option>` no admite — el punto de estado de la
conexión, el motor y el nombre de la base en una segunda línea. Con una base
local y otra en el servidor, "¿cuál es cuál?" se responde de un vistazo en vez
de leyendo `db_id`.

### 16.9 · Lo que sigue faltando

Lo mismo que en alarmas, y es lo importante: **escribir en el PLC**. Ya hay
dónde guardar las tres capas y con qué identificarlas; falta cargar un
`receta_registro` en los tags de sus elementos. Ese paso, el día que exista,
necesita identidad y auditoría obligatorias: es la primera vez que el HMI
escribiría en una máquina.

---

## 17 · Resumen en siete líneas

1. `sqlcmd` interactivo + pegar SQL = errores fantasma. Usa siempre `-Q`.
2. Un error de sintaxis descarta **el lote entero**, incluidas las sentencias correctas que iban antes.
3. `docker cp` + `sqlcmd -i` chocan por permisos: manda el `.sql` por stdin con `<`.
4. Verifica con el usuario de la aplicación (`hmi_app`), no con `sa`: es la prueba que representa lo que hará el HMI.
5. Un pool abierto no demuestra que la base exista. Para saberlo hay que preguntar: `GET /db?revisar=true`.
6. SQL Server rechaza dos caminos en cascada hacia la misma tabla (Msg 1785): ninguna FK del esquema lleva `ON DELETE`, el orden lo pone la aplicación.
7. Un `INSERT` que no devuelve el `id` no sirve para construir jerarquías: hay que preguntarlo en la MISMA conexión y transacción.
