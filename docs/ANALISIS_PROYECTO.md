# Análisis del proyecto `websocket_siemens`

Fecha: 2026-08-20 · Rama de trabajo: PC nueva, `datos/` vacío (solo `.clave`).

---

## 0 · Foto rápida del estado

| Cosa | Estado |
|---|---|
| Backend FastAPI (`app/`) | Completo: 28 endpoints REST + 1 WebSocket |
| Frontend React (`frontend/`) | Consume **12 de 29**. Faltan 17 |
| `venv/` | Python 3.12.9. Solo tiene `SQLAlchemy` + `aiosqlite` |
| Motores de BD instalables hoy | **Solo SQLite**. Faltan `asyncpg`, `aiomysql`, `aioodbc` |
| `datos/conexiones.json` | No existe → cero conexiones guardadas |
| `datos/historicos.json` | No existe → cero grupos de historización |
| `frontend/dist` | No existe → no hay build de producción |
| `.env` | No existe (solo `.env.example`) |

**Conclusión #1 (la más importante):** aunque crees la base de datos en PostgreSQL,
MySQL o SQL Server, el backend **no va a poder conectarse** hasta instalar el
paquete Python de ese motor. Están comentados en `requirements.txt`.

---

## 1 · Inventario de endpoints

### 1.1 Los que YA se usan (12)

| # | Método | Ruta | Quién lo llama |
|---|---|---|---|
| 1 | `GET` | `/health` | `pages/Configuracion.tsx:168` |
| 2 | `GET` | `/plcs` | `context/AppStore.tsx:124`, `Configuracion.tsx:282` |
| 3 | `POST` | `/plcs` | `Configuracion.tsx:282` |
| 4 | `DELETE` | `/plcs/{plc_id}` | `Configuracion.tsx:306` |
| 5 | `GET` | `/tags` | `flows/api.ts` → `cargarTags()` |
| 6 | `POST` | `/rexroth/apps` | `services/rexrothApi.ts:55` |
| 7 | `POST` | `/rexroth/programs` | `services/rexrothApi.ts:80` |
| 8 | `WS` | `/ws` | `hooks/useWebSocket.js`, `RealPLCService.ts` |
| 9 | `GET` | `/db` | `flows/api.ts` → `cargarConexiones()` |
| 10 | `POST` | `/db` | `FlowConfigPanel.tsx:62` (nodo Conexión BD) |
| 11 | `GET` | `/historian` | `flows/api.ts` → `cargarGrupos()` / `useEstadoHistorian` |
| 12 | `POST` | `/historian` + `/historian/{id}/start` + `/{id}/stop` | `FlowConfigPanel.tsx:94,120` |

### 1.2 Los que NO se usan (17)

**Bloque BD — 10 de 12 endpoints sin consumir.** Es el hueco más grande del proyecto.

| Método | Ruta | Para qué sirve | Prioridad |
|---|---|---|---|
| `POST` | `/db/{db_id}/test` | Botón "Probar conexión" / reconectar sin reguardar | 🔥 Alta — 20 min de trabajo |
| `DELETE` | `/db/{db_id}` | Borrar la conexión de verdad (hoy solo se borra el dibujo) | 🔥 Alta |
| `POST` | `/db/{db_id}/esquema` | Crear `usuarios` / `plc_prg` / `alarmas` | Media |
| `GET` | `/db/{db_id}/tablas` | Explorador de tablas en el diseñador | Media |
| `GET` | `/db/{db_id}/columnas` | Explorador de columnas | Media |
| `POST` | `/db/{db_id}/preview` | Probar un SQL sin guardarlo | Media |
| `GET` | `/db/queries` | Listar consultas guardadas | Media |
| `POST` | `/db/queries` | Registrar una consulta | Media |
| `DELETE` | `/db/queries/{id}` | Borrar consulta | Media |
| `POST` | `/db/queries/{id}/run` | **Lo que ejecutaría cada widget de datos** | Media |

**Bloque Historizador — 3 sin consumir.**

| Método | Ruta | Para qué | Prioridad |
|---|---|---|---|
| `GET` | `/historian/{id}/datos` | Ver el histórico sin abrir SSMS. Base del widget de tendencia | 🥇 **La que más valor da hoy** |
| `POST` | `/historian/flush` | Botón "Volcar ahora" — verificar en 2 s que escribe | 🔥 Alta — 10 min |
| `DELETE` | `/historian/{id}` | Borrar el grupo del backend | 🔥 Alta (relacionado con los huérfanos) |

**Bloque PLC — 2 sin consumir.**

| Método | Ruta | Para qué | Prioridad |
|---|---|---|---|
| `POST` | `/discover` | Botón "Escanear red" en Configuración | Baja |
| `GET` | `/browse` | Árbol de tags por Data Block (depuración) | Baja |

---

## 2 · Arreglos del backend

### 2.1 Bloqueantes para lo que vas a hacer ahora

**A. Los drivers de BD no están instalados.**
`requirements.txt` los tiene comentados y el `venv/` solo trae `aiosqlite`.
Sin esto, `POST /db` responde `ok:false` con
`Falta el paquete 'asyncpg' para conectar a PostgreSQL`.

```
asyncpg==0.29.0   # PostgreSQL
aiomysql==0.2.0   # MySQL / MariaDB
aioodbc==0.5.0    # SQL Server (+ ODBC Driver 17/18 del sistema)
```

**B. SQL Server: falta `TrustServerCertificate` / `Encrypt` en la URL.**
`sql_driver.py:320-323` solo lee `opciones["driver"]` y descarta el resto de
`opciones`. Con **ODBC Driver 18** el cifrado viene activado por defecto y un
SQL Server local con certificado autofirmado falla con
`SSL Provider: certificate chain was issued by an authority that is not trusted`.

Arreglo mínimo:

```python
# sql_driver.py, dentro de url()
if self.motor == "mssql":
    extras = {"driver": self.opciones.get("driver", "ODBC Driver 17 for SQL Server")}
    # cualquier otra opción (TrustServerCertificate, Encrypt, Trusted_Connection…)
    for k, v in self.opciones.items():
        if k != "driver":
            extras[k] = v
    url += "?" + "&".join(f"{k}={quote_plus(str(v))}" for k, v in extras.items())
```

Y en `ConnectionForm.tsx` añadir un check "Confiar en el certificado del servidor"
que meta `TrustServerCertificate: "yes"` en `opciones`.

**C. SQL Server: instancia con nombre + puerto se pelean.**
`ConnectionForm.tsx:25` propone `host = 'localhost\SQLEXPRESS'` y a la vez
manda `puerto: 1433`. La URL sale como `SERVER=localhost\SQLEXPRESS,1433`.
ODBC ignora el nombre de instancia cuando hay puerto, y SQL Express por defecto
usa **puerto dinámico** y con **TCP/IP deshabilitado**. Elegir uno de los dos:

- `host = localhost\SQLEXPRESS` **sin** puerto (requiere SQL Browser corriendo), o
- `host = localhost` + puerto fijo `1433` (requiere habilitar TCP/IP y fijar el puerto
  en *SQL Server Configuration Manager*). ← **recomendado, es el que menos falla**

**D. El backend no crea bases de datos** (tu nota es correcta: no hay un solo
`CREATE DATABASE` en el repo). `POST /db` solo **verifica y guarda**. Y
`POST /db/{id}/esquema` crea *tablas*, no la base. Por eso el paso manual es
inevitable — y por eso DBeaver sirve (ver sección 4).

### 2.2 Deuda técnica confirmada

**E. `GET /health` no muestra las bases de datos.**
`rest_routes.py:124` devuelve solo `plc_manager.get_health()`. `DbManager.health()`
existe (`db_manager.py:462`) y no lo llama nadie. Arreglo de una línea:

```python
async def health(request: Request) -> dict:
    salud = request.app.state.plc_manager.get_health()
    salud["bases_datos"] = request.app.state.db_manager.health()
    salud["historizador"] = request.app.state.historizador.estado()
    return salud
```

**F. `spa_fallback` se traga los 404 de la API.**
`main.py:346` — `@app.get("/{ruta_spa:path}")` devuelve `index.html` con **200**
ante cualquier GET desconocido. Un typo tipo `/historain` no da 404, da HTML.
Matiz útil: solo afecta a **GET**; un POST mal escrito sí da 405/404.
Arreglo: prefijar toda la API bajo `/api` (lo más limpio), o excluir a mano los
prefijos conocidos antes del fallback.

**G. `API_BASE` inconsistente.**
`flows/api.ts:6` fija `http://localhost:8000` a pelo, mientras `AppStore.tsx`,
`Configuracion.tsx` y `rexrothApi.ts` usan rutas relativas (`fetch('/plcs')`).
Resultado: en `npm run dev` conviven dos orígenes distintos y por eso hace falta
`allow_origins=["*"]`. Unificar en:

```ts
export const API_BASE = import.meta.env.VITE_API_BASE ?? '';
```

más el proxy de Vite hacia `:8000`. Con eso el CORS abierto deja de hacer falta.

**H. Contraseña de BD en claro en `localStorage`.**
`FlowEditor.tsx:18,29` — todo `node.config` (incluido `config.password`) se
serializa en la clave `srx_flow_editor`. El backend la cifra con Fernet
(`store.py`), el navegador no. Arreglo: borrar `password` del objeto antes de
`JSON.stringify`, y que el campo se muestre vacío al recargar (el backend ya la
tiene guardada; solo hace falta reenviarla si se cambia).

**I. Borrar un nodo no borra nada en el backend.**
- Nodo **Historian**: `ConfirmarBorrado` avisa y como mucho llama a
  `/historian/{id}/stop`. El grupo sigue en `datos/historicos.json`.
  Nadie llama a `DELETE /historian/{id}`.
- Nodo **Conexión BD**: no avisa de nada. La conexión sigue viva con su pool
  abierto. Nadie llama a `DELETE /db/{db_id}`.

**J. Banner de huérfanos (tu nota, confirmada).**
`FlowEditor.tsx:94` solo mira los grupos que tienen nodo dibujado. Si el nodo se
borró antes, el grupo queda invisible. `useEstadoHistorian` ya trae **todos** los
grupos del backend: basta con restar los `grupo_id` del lienzo y pintar la
diferencia.

**K. `crear_esquema` / `prefijo_esquema` nunca se envían.**
`FlowConfigPanel.tsx:64-75` arma el body de `POST /db` sin esos dos campos, y
`POST /db/{id}/esquema` no lo llama nadie. Traducción práctica: las tablas
`usuarios`, `plc_prg` y `alarmas` **hoy no se crean nunca desde la interfaz**.

**L. `plc_prg` duplica `historico_tags` (tu nota, confirmada).**
`sql_driver.py:452` (`ddl_tabla_historico`) y `sql_driver.py:533`
(`ddl_esquema_hmi` → `plc_prg`) generan prácticamente el mismo esquema estrecho.
Recomendación: quedarse con `historico_tags` (es la que el historizador escribe
de verdad) y sacar `plc_prg` del esquema estándar.

**M. Falso positivo en `validar_sql_lectura`.**
`sql_driver.py:94` busca palabras prohibidas en **todo** el texto, incluidos los
literales de cadena. `SELECT * FROM ordenes WHERE estado = 'delete'` se rechaza
sin motivo. Arreglo: quitar los literales entre comillas antes de escanear.

**N. Sin control de acceso (tu nota).** `Login.tsx` solo conecta al PLC. La tabla
`usuarios` del esquema estándar no la usa nadie. Igual con `alarmas`: no hay
motor de alarmas.

---

## 3 · Orden de trabajo propuesto

| Fase | Qué | Por qué en ese orden |
|---|---|---|
| **0** | Instalar drivers Python + crear las BD | Sin esto no se prueba nada más |
| **1** | `GET /historian/{id}/datos` → nodo "Ver datos" | Verifica la fase 0 sin abrir SSMS |
| **2** | `POST /historian/flush` + `DELETE /historian/{id}` + `POST /db/{id}/test` + `DELETE /db/{id}` | 4 botones, ~1 h en total, cierra el ciclo de vida completo |
| **3** | Banner de grupos huérfanos | Ya tienes el dato cargado |
| **4** | Arreglos B, C, E, F, G, H | Higiene: SQL Server, health, 404, CORS, password |
| **5** | Bloque `/db/queries*` (10 endpoints) | KPIs, barras y tablas desde cualquier BD |
| **6** | Login real, motor de alarmas, unificar `plc_prg` | Producto, no infraestructura |

---

## 4 · ¿Sirve DBeaver?

**Sí, y es buena idea — pero ojo con qué hace y qué no hace.**

DBeaver es un **cliente**: se conecta a un servidor que ya existe y ejecuta SQL.
**No instala motores de base de datos.**

| Motor | ¿DBeaver crea la BD? | ¿Hay que instalar servidor antes? |
|---|---|---|
| **SQLite** | ✅ Sí, crea el fichero `.db` entero | ❌ No, no hay servidor |
| **PostgreSQL** | ✅ Sí (`CREATE DATABASE`) | ✅ Sí, PostgreSQL Server |
| **MySQL / MariaDB** | ✅ Sí (`CREATE DATABASE`) | ✅ Sí, MySQL Server |
| **SQL Server** | ✅ Sí (`CREATE DATABASE`) | ✅ Sí, SQL Server Express |

Ventaja real de DBeaver aquí: **un solo programa** para los cuatro motores, en vez
de pgAdmin + MySQL Workbench + SSMS. Y sirve además para verificar a mano que el
historizador está escribiendo, mientras `GET /historian/{id}/datos` no esté
conectado en el frontend.

Aviso de instalación: DBeaver descarga el driver JDBC de cada motor la primera
vez que abres una conexión de ese tipo → **hace falta internet en ese momento**.

---

## 5 · Errores de SQL Server que te vas a encontrar

| Código | Mensaje | Qué significa de verdad |
|---|---|---|
| `4060` | *Cannot open database "X" requested by the login* | **El importante.** O la BD no existe, o el login no tiene `USER` mapeado dentro de ella |
| `18456` | *Login failed for user* | Genérico: contraseña mal, o autenticación SQL deshabilitada (modo "Windows only") |
| `IM002` | *Data source name not found* | El ODBC Driver que pusiste en `opciones.driver` no está instalado en la máquina |
| SSL/TLS | *certificate chain … not trusted* | ODBC Driver 18 + certificado autofirmado → arreglo **B** |
| Timeout | *Login timeout expired* | TCP/IP deshabilitado, o SQL Browser parado con instancia con nombre → arreglo **C** |

Sin `db_ddladmin`, la conexión guarda bien y **el historizador falla en el primer
volcado**, con el error escondido en el `ultimo_error` del grupo
(`GET /historian`). Otra razón más para conectar `POST /historian/flush`: hace
visible ese fallo en 2 segundos en vez de en silencio.
