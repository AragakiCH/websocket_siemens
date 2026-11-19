# Alarmas

Cómo se configura una alarma, qué pasa cuando salta y dónde la ve el operador.

---

## 1. Las dos tablas

Es lo primero que hay que tener claro, porque todo lo demás sale de aquí.

| Tabla | Qué guarda | Quién la escribe |
|---|---|---|
| `alarmas_def` | La **regla**: qué vigilar. *«Si `DB1.temp` pasa de 80, es un Error y dice “Temperatura alta”»* | Una persona, desde el editor |
| `alarmas` | El **evento**: qué pasó. *«El 7/9 a las 14:32 saltó con 83.4; Ana la reconoció a las 14:35»* | El motor, nunca una persona |

Una regla se escribe una vez y no cambia en meses. Los eventos crecen sin parar.

Meterlo todo en una tabla obligaría a repetir el texto y la clase en cada evento, y haría imposible responder *«¿qué alarmas tengo configuradas?»* sin que hayan saltado al menos una vez. Es la misma separación que hacen TIA Portal y WinCC, por el mismo motivo.

---

## 2. Configurar una alarma

**Diseñador → Alarmas.** Las columnas:

| Columna | Para qué |
|---|---|
| **ID** | El número de la alarma. Lo da la base de datos y no cambia: es el que luego se ve en el runtime cuando salta |
| **Name** | Nombre corto. Solo para reconocerla en la lista |
| **Alarm text** | Lo que ve el operador cuando salta. Es lo que importa |
| **Alarm class** | `Critical` · `Error` · `Warning` · `Maintenance` · `Information` |
| **Trigger tag** | **La variable del PLC.** Se elige de la lista |
| **Condición** | Cómo se evalúa: un bit (activo o inactivo), o una comparación contra un límite |
| **Banda** | Histéresis. Solo en analógicas |
| **On** | Silenciarla sin eliminarla |
| *(acciones)* | Duplicar y **eliminar** (el tachito). Siempre a la vista, pegadas al borde derecho |

### El Trigger tag

El desplegable trae **las variables reales de todos los PLCs conectados**, descubiertas por browse OPC UA. Cada línea muestra el nombre del tag, el PLC y el Data Block (o el POU en Rexroth), y **el último valor recibido** — que es lo que confirma que es el tag correcto cuando hay varios con nombres parecidos.

Se guarda en formato `plc_id|tag`, el mismo que usan el WebSocket y el historizador. Con dos PLCs, cada uno con un `Temperatura`, no hay ambigüedad posible.

**También se puede teclear a mano.** La lista solo existe tras un browse correcto, y configurar alarmas desde la oficina con la máquina apagada tiene que ser posible. Si el tag que escribes no está entre los descubiertos, el campo te lo dice sin tratarlo como un error.

> **El fallo silencioso de esta pantalla.** Una alarma sin Trigger tag se ve **exactamente igual** que una que funciona: tiene nombre, texto y clase. El motor la ignora por completo. El pie de la tabla cuenta cuántas hay en ese estado (el dato también está en `GET /alarmas/estado`, `reglas_sin_tag`). Lo mismo con una comparación a la que aún no se le ha puesto límite: su celda se marca en ámbar y el pie la cuenta.

### La condición

Ocho opciones, en este orden. La primera es la de arranque: una alarma nueva nace en `Bit activo`.

| Condición | Salta cuando… |
|---|---|
| `Bit activo (TRUE / 1)` | el bit está a 1. La discreta de TIA |
| `Bit inactivo (FALSE / 0)` | el bit está a 0. La alarma de *«falta la señal»*: el permisivo que se cae, la marcha que no llega |
| `Mayor que` · `Mayor o igual` · `Menor que` · `Menor o igual` · `Igual a` · `Distinto de` | el valor cumple la comparación contra el **límite** |

**Lo que se ofrece depende del tipo del Trigger tag:**

| El tag es… | Condiciones | ¿Se elige el bit? |
|---|---|---|
| **Bool** | Solo `Bit activo` y `Bit inactivo` | No: un Bool es un solo bit. La casilla sale deshabilitada |
| **Entero** (Int, DInt, Word…) | Las ocho | Sí, pero solo con `Bit activo` / `Bit inactivo`. Con una comparación, en su lugar va el límite |
| **Decimal** (Real, LReal) | Solo las seis comparaciones | No: un decimal no tiene bits |
| *No se sabe* (tag escrito a mano, PLC apagado) | Las ocho | Sí |

Al **elegir el tag de la lista**, si la condición que había no existe para su tipo, pasa sola a la primera que sí se ofrece (`Mayor que` al poner un decimal, `Bit activo` al poner un Bool). Mientras se **teclea** el tag no se toca nada: si al terminar la condición no encaja con el tipo, la celda se marca en ámbar para que se corrija a mano.

Cambiar la condición es **un** cambio: el límite de una comparación se escribe después, en su celda. Mientras falte, la alarma no se evalúa.

### Eliminar y restaurar

El tachito **no borra** la alarma: la manda a la tabla **«Alarmas eliminadas»**, debajo de la principal.

- El motor deja de vigilarla al momento. Si tenía una alarma **activa**, ese evento se cierra (normalizado), porque ya nadie iba a normalizarlo; sigue pendiente de reconocer si nadie lo había visto.
- **Restaurar** la devuelve a la tabla tal como estaba: mismo ID, mismo tag, misma condición.
- Los eventos que ya provocó conservan su número de alarma.
- **Borrar para siempre** se hace desde esa tabla y pide confirmación. Ahí sí se va la fila: sus eventos siguen en el histórico, pero sin número de alarma.

En la base es una fecha, `alarmas_def.eliminado_en` (`NULL` = en uso). Una base creada antes de que existiera la columna la recibe sola la primera vez que se elimina una alarma. «Exportar proyecto» no se lleva las eliminadas; «Migrar datos de la base» sí, y llegan eliminadas.

Hace falta categoría `Administradores`, igual que para borrar.

### La banda muerta

Con `Mayor que 80` y banda `2`:

```
    dispara al pasar de ......... 80
    NO se normaliza hasta bajar de 78
```

**Solo se aplica para apagar, nunca para disparar.** Es histéresis, no tolerancia: aplicarla también al disparar retrasaría la alarma hasta 82, que es lo contrario de lo que se quiere.

Sin banda muerta, un valor oscilando entre 79.9 y 80.1 genera **cientos de eventos por minuto** y llena el histórico de ruido hasta hacerlo inútil. Si el tag es una medida analógica ruidosa, pon banda.

---

## 3. Qué pasa cuando salta

El motor vive **en el backend**, en el mismo proceso que ya recibe los valores de los PLCs. Se cuelga del flujo existente (`ConnectionManager.registrar_observador`): no abre una segunda sesión OPC UA ni añade una sola lectura al autómata.

```
  PLC ──OPC UA──► backend ──┬──► historizador   (guarda la curva)
                            ├──► motor alarmas  (compara con las reglas)
                            └──► WebSocket      (los navegadores)
                                     │
      cuando una regla se cumple:    │
        1. INSERT en `alarmas`       │
        2. broadcast ────────────────┘──► banner + pantalla, sin recargar
```

### Por qué en el backend y no en el navegador

Evaluar en el frontend habría sido mucho más corto: los valores ya llegan allí. Y habría estado mal, en orden de gravedad:

1. **Una alarma que solo salta cuando alguien mira no es una alarma.** El turno de noche cierra el navegador y el reactor se calienta sin que quede constancia.
2. **Con tres PCs abiertos, los tres escribirían el mismo evento.** El histórico tendría cada alarma por triplicado y *«¿cuántas veces saltó?»* dejaría de tener respuesta.
3. El reloj del evento sería el del PC del operador, no el del servidor.

### Flancos

El evento se crea en el **flanco**, no mientras la condición se cumple. Un valor que lleva media hora por encima del límite genera **un** evento, no uno cada 100 ms.

### Reinicio del servicio

Al arrancar, el motor relee los eventos que quedaron **abiertos** y los adopta. Sin eso, reiniciar con una alarma activa dejaría el evento anterior colgado para siempre y crearía uno nuevo al primer valor.

---

## 4. Dónde la ve el operador

### El banner

Una franja fija arriba con la alarma **más grave sin reconocer**, el contador de las demás y el botón de reconocer. Aparece sobre cualquier pantalla —menú, Diseñador, Vista Previa— y **empuja** el contenido hacia abajo en vez de taparlo.

No se monta cuando no hay nada pendiente: un hueco reservado «por si acaso» movería toda la interfaz justo el día que salte algo.

Solo parpadean `Critical` y `Error`. Si todo parpadeara, el parpadeo dejaría de significar *mira esto ahora*.

### El widget de alarmas

En la paleta del Diseñador, **Datos → Alarmas**. Es la lista de pendientes *dentro* de la pantalla del HMI, filtrable por gravedad, por área y por texto del tag.

Cada fila enseña, en este orden: **símbolo e ID** de la alarma · **fecha** · **hora** · **mensaje** · **usuario** (quién la reconoció) · y el **✓** para reconocerla. Con menos de 440 px de ancho las columnas no caben y cada alarma pasa a dos líneas, con los mismos datos. Qué columnas salen se elige en el panel del widget.

En la cabecera, el botón **«Ver todas»** abre la pantalla `/alarmas`. Reconocer y «Ver todas» solo actúan en la vista previa, no en el lienzo del Diseñador.

### La pantalla `/alarmas`

Dos pestañas:

- **Pendientes** — la lista de trabajo, la más grave primero.
- **Histórico** — todo, con filtros por clase y estado.

Las dos con las mismas columnas:

| Clase | ID | Fecha y hora | Mensaje | Tag y valor | Situación | Usuario | Acción / Reconocida |
|---|---|---|---|---|---|---|---|

- **ID** es el número de la **alarma** (el de la tabla de configuración), no el del evento: la misma alarma lleva el mismo número cada vez que salta.
- **Usuario** es quién la reconoció. En *Pendientes* va vacío por definición —pendiente es que nadie la ha reconocido—; en el *Histórico* aparece el nombre.
- La última columna es lo único que cambia: el botón **Reconocer** en Pendientes, y **cuándo** se reconoció en el Histórico.

Arriba, el **diagnóstico del motor**: reglas activas, tags vigilados, disparadas ahora y eventos escritos.

La **flecha de volver** devuelve a la pantalla desde la que se entró —al HMI, en la misma sección, si se vino del runtime—, no al menú.

### Reconocer

Deja constancia de que alguien la vio. Queda firmado con el nombre de la sesión — el `usuario_id` lo pone el servidor desde el token, nunca el cliente.

Hace falta categoría `Usuarios` o superior. Consultar no pide nada: en una planta, el estado de las alarmas es lo primero que cualquiera tiene que poder ver.

---

## 5. «Pendiente» no es «sigue activa»

Es la parte que más se equivoca la gente, y la que más importa.

> **Una alarma que se normaliza sola NO desaparece.**

Si la temperatura sube, dispara y baja mientras nadie mira, el evento se normaliza **pero sigue pendiente** hasta que alguien lo reconozca. En la lista aparece como **«Normalizada»**.

El motivo se ve pensando en el turno siguiente: si las alarmas transitorias se borraran solas, la información de que hubo un problema se perdería **justo en el caso en que nadie lo vio** — que es precisamente cuando hace falta.

Por eso el filtro es `ts_reconocimiento IS NULL` y no `estado != 'normalizada'`. La columna `estado` guarda la última transición, que es otra pregunta:

| Situación | `estado` | `ts_normalizacion` | `ts_reconocimiento` | ¿Pendiente? |
|---|---|---|---|---|
| Saltó y sigue | `activa` | — | — | **Sí** |
| Sigue, pero la vieron | `activa` | — | ✓ | No |
| Se arregló sola, nadie la vio | `normalizada` | ✓ | — | **Sí** ← |
| Cerrada del todo | `reconocida` | ✓ | ✓ | No |

---

## 6. Probarlo

### Sin PLC

```bash
python tools/probar_alarmas.py
```

Más de 60 comprobaciones contra una SQLite real: flancos, banda muerta, pendientes, reinicio sin duplicar y recarga sin cerrar en falso; y además cambiar la condición campo a campo, `Bit inactivo`, la papelera (eliminar, restaurar, una base antigua sin la columna), silenciar con la alarma activa y el nombre de quien reconoce. No toca tu configuración.

### Con PLC

1. **Diseñador → Alarmas → Agregar alarma.**
2. Elige un `Bool` cualquiera en **Trigger tag** (el desplegable muestra su valor actual).
3. Deja la condición en `Bit activo (TRUE / 1)`.
4. Fuerza ese bit a `true` desde el PLC.

Debe aparecer el banner **en menos de un segundo**, en todas las pantallas abiertas a la vez.

### Si no salta

Mira primero el pie del editor de alarmas: avisa de las que no tienen Trigger tag y de las comparaciones sin límite, que no se evalúan nunca.

Después, el diagnóstico del motor. En `/alarmas` están los cuatro datos de operación; el resto se pide con `GET /alarmas/estado`:

| Dato | Qué significa si está mal |
|---|---|
| `valores_evaluados` **= 0** | No llega nada del PLC. El problema es la conexión, no la alarma |
| `reglas_sin_tag` **> 0** | Alguna regla no tiene Trigger tag. No se evalúa nunca |
| `Tags vigilados` **= 0** | Ninguna regla activa tiene tag |
| `Último error` | Falla la escritura en la base de datos |

Si todo eso está bien y sigue sin saltar, casi siempre es el **bit de disparo**: la palabra de estado sí cambia, pero el bit que vigilas no es el que se activa.

---

## 7. Ajustes

| Variable | Por defecto | Para qué |
|---|---|---|
| `PLC_ALARMAS_ENABLED` | `true` | `false` silencia la evaluación **sin borrar ninguna regla** |
| `PLC_ALARMAS_DB_ID` | *(la de por defecto)* | Si las alarmas van en otra base que el histórico |

Al guardar en el editor se llama a `POST /alarmas/recargar`, así que un cambio se aplica al momento. El motor además relee las reglas cada minuto por si alguien las cambió desde SSMS o desde otra instancia. Recargar **conserva el estado**: editar el texto de una alarma no cierra las que están activas.

---

## 8. Endpoints

| | |
|---|---|
| `GET /alarmas/pendientes` | Lo que hay que atender, la más grave primero |
| `GET /alarmas/historico` | Todo, con filtros |
| `GET /alarmas/estado` | Diagnóstico del motor |
| `POST /alarmas/{id}/reconocer` | Darse por enterado — `Usuarios` |
| `POST /alarmas/reconocer-todas` | En bloque, tras una parada — `Usuarios` |
| `POST /alarmas/recargar` | Releer las reglas — `Administradores` |
| `POST /alarmas/definiciones/{id}/eliminar` | Mandar una regla a la papelera — `Administradores` |
| `POST /alarmas/definiciones/{id}/restaurar` | Sacarla de la papelera — `Administradores` |

`/pendientes` y `/historico` devuelven en cada evento `alarma_def_id` (el número de la alarma) y `usuario` (el **nombre** de quien la reconoció, además de su `usuario_id`).

Por WebSocket llegan `alarma.activada`, `alarma.normalizada` y `alarma.reconocida`, con el evento **completo** — no un «algo cambió, vuelve a preguntar». Con veinte alarmas saltando a la vez y veinte clientes, eso serían cuatrocientas consultas contra la base en un segundo.

---

## 9. Lo que todavía no hace

- **Alarmas de comunicación** (*«se perdió el PLC»*). La tabla las contempla (`tipo='comunicacion'`); el sitio natural es `PlcManager`, no el motor.
- **Reconocimiento desde el PLC** (`tag_reconocimiento`). La columna existe; haría falta escribir en el autómata.
- **Retardo de activación** — un valor que cruza el límite medio segundo. La banda muerta cubre la oscilación, que es el caso frecuente; un retardo temporal es otra cosa y no hay columna para él.
- **Agrupación por áreas.** La columna `area` existe y se guarda, pero no hay dónde editarla.

---

## 10. Ficheros

| | |
|---|---|
| `app/core/alarm_engine.py` | El motor: evaluación, flancos, eventos, difusión |
| `app/api/alarm_routes.py` | Los endpoints |
| `frontend/src/components/alarms/AlarmsEditor.tsx` | Configurar las reglas |
| `frontend/src/components/alarms/BannerAlarmas.tsx` | La franja |
| `frontend/src/components/hmi/custom/alarmas/Alarmas.tsx` | El widget de alarmas del lienzo |
| `frontend/src/pages/Alarmas.tsx` | Pendientes e histórico |
| `frontend/src/services/alarmasApi.ts` | Las reglas |
| `frontend/src/services/alarmasRuntimeApi.ts` | Los eventos |
| `tools/probar_alarmas.py` | La prueba |
