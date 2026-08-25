# Cómo probar el multiusuario

Tres formas, de menos a más esfuerzo. Empieza por la primera.

---

## 1. Automático — 30 segundos

```powershell
python tools/probar_multiusuario.py
```

Levanta un backend aparte con su propia base de datos y su propia carpeta de
datos, ejecuta 40 comprobaciones y borra todo al acabar. **No toca tu `.env`,
ni tu BD, ni tus PLCs, ni tus proyectos** — usa `PLC_DATOS_DIR` para apuntar a
una carpeta temporal.

Salida esperada:

```
1 · Arranque en frío (sin ninguna cuenta)
  ✓ se puede configurar la BD sin cuentas (modo arranque)
2 · Primera cuenta
  ✓ el primer usuario sale Supervisor aunque pida Invitado
...
8 · Fase 4 · el lápiz de edición
  ✓ escribir sin el lápiz -> 423 Locked
  ✓ el Supervisor puede tomar el control
  ✓ a LUIS le llega el aviso al instante
...
Todo correcto.
```

Si algo sale en rojo, ahí está el problema.

---

## 2. Manual con dos navegadores — 5 minutos

Es la prueba que de verdad convence, porque ves los widgets moverse solos.

> ### ⚠️ Lee esto antes, o la prueba no demuestra nada
>
> **1. `PLC_AUTH_REQUERIDA=true` es obligatorio para probar el lápiz.**
> Con la autenticación apagada nadie tiene nombre, así que el backend
> identifica a cada cliente por su IP (`anónimo@127.0.0.1`). Desde el mismo
> equipo, **los dos navegadores son la misma persona**: los dos podrían
> editar y no verías el bloqueo actuar. Con cuentas, cada uno es quien es.
>
> **2. Si trabajas en el puerto 5173 (Vite), reinícialo.**
> Los cambios en `vite.config.js` **no** se recargan solos. Si el Diseñador
> se queda en `Solo lectura` estando tú solo, casi seguro es esto: Vite está
> devolviendo el HTML de la SPA en vez de reenviar `/locks` al backend.
>
> ```powershell
> # Ctrl+C en la terminal de Vite y volver a arrancar
> cd frontend ; npm run dev
> ```
>
> **3. Dos pestañas normales NO valen.** Comparten `localStorage`, o sea el
> mismo token. Usa una ventana normal y otra de incógnito, o dos navegadores
> distintos.

### Preparación

```powershell
# .env
PLC_AUTH_REQUERIDA=true

# Compilar la vista y arrancar (una sola terminal)
cd frontend ; npm install ; npm run build ; cd ..
python -m uvicorn app.main:app --host 0.0.0.0 --port 8000
```

Abre **http://localhost:8000**.

### Paso 1 · Crear las cuentas

Todavía no hay ninguna, así que los endpoints de administración están abiertos
(*modo arranque*). Desde `http://localhost:8000/docs`:

1. `POST /db` con `crear_esquema: true` — crea la tabla `usuarios`.
   ```json
   { "db_id": "local", "motor": "sqlite",
     "base_datos": "C:/datos/planta.db", "crear_esquema": true }
   ```
2. En la pantalla de login, pestaña **Crear cuenta**: `hugo`. Será
   **Supervisor** aunque elijas otra categoría — es a propósito: si no, no
   habría forma de tener un administrador inicial.
3. Ya dentro, crea una segunda cuenta `luis` con categoría **Administradores**.

A partir de aquí la puerta está cerrada: sin token, `POST /plcs` responde 401.

### Paso 2 · Dos navegadores a la vez

Necesitas **dos sesiones separadas**. Una pestaña normal y otra de incógnito, o
Chrome y Firefox. Dos pestañas normales comparten `localStorage`, así que
compartirían el mismo token y verías una sola persona.

| | Ventana A | Ventana B |
|---|---|---|
| 1 | Entra como `hugo` | Entra como `luis` |
| 2 | Ve a **Diseñador** | Ve a **Diseñador** |

### Qué deberías ver

**Presencia.** En la barra superior de las dos: `2 conectados`. Pasa el ratón
por encima y salen los nombres.

**El lápiz (Fase 4).** La ventana A (la primera que entró) muestra `Editando`
en verde. La ventana B muestra `Solo lectura · edita hugo` en ámbar. En B el
lienzo no responde: arrastrar no hace nada. **Eso es lo correcto.**

**Cambios en vivo.** Arrastra un widget en A. En B se mueve solo, sin recargar.

**Toma de control.** En B, `luis` es Administradores, así que **no** ve el botón
"Tomar control" — solo un Supervisor puede. Entra en B como `hugo`… mejor: usa
la ventana A (Supervisor) para probarlo al revés. O desde `/docs`:

```
POST /locks/designer:principal/forzar
```

Al hacerlo, la ventana que tenía el lápiz pasa a `Solo lectura` **al instante**,
con el mensaje *"X tomó el control de edición. Tus cambios guardados se
conservan."*

**Caducidad.** Cierra la ventana que tiene el lápiz sin más. A los ~30 segundos
la otra ventana muestra *"El control quedó libre. Pulsa Tomar control"*. Sin
esto, un navegador cerrado dejaría la pantalla bloqueada para siempre.

**Auditoría.** Desde `/docs`, `GET /auditoria`: aparece quién forzó el control,
quién dio de alta el PLC y quién creó cada cuenta.

---

## 3. A mano con `curl` — para verificar un punto concreto

Sustituye `$TOK` por el token que devuelve el login.

```bash
# Login
curl -X POST http://localhost:8000/auth/login -H "Content-Type: application/json" \
  -d '{"usuario":"hugo","password":"Planta2026!"}'

# Quién soy y qué puedo hacer
curl http://localhost:8000/auth/me -H "Authorization: Bearer $TOK"

# Tomar el lápiz
curl -X POST http://localhost:8000/locks/designer:principal/adquirir \
  -H "Authorization: Bearer $TOK"

# Intentar escribir SIN el lápiz (con otro token) -> 423 Locked
curl -X PATCH http://localhost:8000/proyectos/principal/widgets/w1 \
  -H "Authorization: Bearer $OTRO_TOK" -H "Content-Type: application/json" \
  -d '{"widget":{"id":"w1","x":10},"version":null}'

# Conflicto de versión -> 409
curl -X PATCH http://localhost:8000/proyectos/principal/widgets/w1 \
  -H "Authorization: Bearer $TOK" -H "Content-Type: application/json" \
  -d '{"widget":{"id":"w1","x":10},"version":1}'   # versión vieja

# Quién está conectado
curl http://localhost:8000/auth/conectados -H "Authorization: Bearer $TOK"

# Qué hay bloqueado
curl http://localhost:8000/locks -H "Authorization: Bearer $TOK"

# Auditoría, filtrando por tipo de acción
curl "http://localhost:8000/auditoria?accion=lock." -H "Authorization: Bearer $TOK"
```

---

## Códigos de respuesta que verás, y qué significan

| Código | Cuándo | Qué hacer |
|---|---|---|
| **401** | Sin token, o caducado, o la cuenta fue desactivada | Volver a entrar |
| **403** | Tu categoría no llega para esa acción | Pedírselo a alguien con más permisos |
| **409** | Otro guardó antes: tu versión está desactualizada | Recargar, o repetir con `version: null` para forzar |
| **423** | Otro tiene el lápiz de edición | Esperar 30 s, o que un Supervisor use `/forzar` |
| **503** | No hay BD configurada para las cuentas | Dar de alta la conexión con `crear_esquema: true` |

---

## Problemas frecuentes

**"Veo un solo usuario conectado con dos pestañas abiertas."** Correcto: es
**una** persona. Para simular dos, usa una ventana de incógnito o un navegador
distinto — dos pestañas normales comparten el token del `localStorage`.

**"No puedo crear la primera cuenta: me da 503."** Falta la base de datos donde
vive la tabla `usuarios`. Da de alta la conexión con `crear_esquema: true`.

**"Activé `PLC_AUTH_REQUERIDA=true` y me quedé fuera."** No debería pasar: sin
cuentas, los endpoints de administración quedan abiertos. Si ya creaste una
cuenta y perdiste la contraseña, la salida es SQL:
`DELETE FROM usuarios WHERE usuario='...'` y volver a registrarte.

**"El lienzo no me deja arrastrar."** Mira la barra superior. Si dice
`Solo lectura`, el lápiz lo tiene otro. Si dice `Editando` y aun así no
responde, mira la consola del navegador.

**"Los cambios no llegan a la otra ventana."** Comprueba que el WebSocket está
conectado (pestaña Red del navegador, filtro WS). Si `PLC_AUTH_REQUERIDA=true`
y el socket no lleva token, el backend lo cierra con código 1008.

---

## Un aviso importante sobre el despliegue

El estado vive en la memoria de **un proceso**: sesiones, bloqueos y clientes
WebSocket. El servicio **debe correr con un solo worker**.

```powershell
# BIEN
python -m uvicorn app.main:app --port 8000

# MAL: cada worker tendría sus propias sesiones, sus propios bloqueos
#      y sus propios clientes. Dos personas en workers distintos no se verían.
python -m uvicorn app.main:app --workers 4
```

Para más de un proceso haría falta Redis para el pub/sub y un almacén de
sesiones compartido. Con diez usuarios y un worker no hace falta.
