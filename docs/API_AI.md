# Asistente de IA — arquitectura y contrato

Un agente integrado en el backend que **entiende el proyecto, consulta el
estado real y ejecuta acciones**. No es un chatbot pegado al lado: comparte el
mismo proceso, las mismas herramientas y los mismos datos.

Documentación interactiva: **http://localhost:8000/docs** → *Asistente de IA*.

---

## Cómo funciona

```
  pregunta del usuario
        │
        ├─► RAG: recupera la documentación relevante (BM25)
        ├─► Estado vivo: PLCs, tags, conexiones, historización
        ├─► Esquema real: tablas y columnas de las BD conectadas
        ▼
   system prompt segmentado (8 bloques)
        │
        ▼
   ┌──────────────────────────────────────────┐
   │  modelo (Ollama Cloud)                    │
   │   ¿necesita una herramienta?              │
   │     sí → se ejecuta → observación ────────┼──┐  máx. 8 pasos
   │     no → respuesta final                  │  │
   └──────────────────────────────────────────┘  │
                      ▲                           │
                      └───────────────────────────┘
```

---

## 1. Las tres piezas

### Herramientas derivadas del OpenAPI

**El agente no tiene una lista de herramientas escrita a mano.** Lee
`app.openapi()` al arrancar y convierte cada endpoint en una herramienta,
usando el `summary` y la `description` que ya escribiste para Swagger.

Consecuencia práctica: **añades un endpoint y el agente sabe usarlo**, sin
tocar el módulo de IA. Basta con llamar a `POST /ai/recargar` (o reiniciar).

> Verificado: se añadió un endpoint en caliente y el catálogo pasó de 34 a 35
> herramientas, con su dominio y su riesgo bien clasificados.

Esto invierte el incentivo de forma útil: **documentar bien un endpoint es,
literalmente, enseñárselo al agente.**

### RAG sobre la documentación

Corpus: `docs/*.md` + `README.md`, troceados **por sección** (no cada N
caracteres: cortar a ciegas parte tablas y ejemplos, y el modelo recibe
fragmentos inservibles). Hoy son 96 fragmentos y ~1.800 términos.

Recuperación: **BM25**, el algoritmo léxico clásico. Elegido a propósito frente
a embeddings porque aquí funciona mejor: los términos son muy específicos
(`banda_muerta`, `ctrlX`, `plc_prg`, `historizador`) y el usuario pregunta con
las mismas palabras que están en los documentos. Además: cero dependencias,
cero latencia, cero coste, y funciona sin conexión.

`POST /ai/buscar` permite ver qué recuperaría el RAG **sin llamar al modelo** —
si el asistente responde mal, mira primero si el contexto era el correcto.

### Contexto vivo + esquema real

En cada pregunta se le inyecta:

- **Estado actual**: PLCs y su conexión, tags con su valor, conexiones a BD,
  grupos de historización, grabaciones en curso.
- **Esquema real**: las tablas y columnas que existen de verdad en las BD
  conectadas. Sin esto el agente escribiría SQL inventado; con esto escribe
  contra tus columnas.

---

## 2. Seguridad: qué puede y qué no

Cada herramienta se clasifica automáticamente:

| Riesgo | Qué incluye | Comportamiento |
|---|---|---|
| **Lectura** | Todos los `GET`, y los `POST` que solo consultan (`/db/queries/{id}/run`, `/db/{id}/preview`, `/rexroth/*`) | Se ejecuta sin preguntar |
| **Escritura** ⚠️ | `POST`/`PUT`/`DELETE` que modifican estado | Bloqueado salvo `PLC_AI_PERMITIR_ESCRITURA=true` |
| **Prohibida** | `DELETE /plcs/{id}`, `DELETE /db/{id}`, `POST /db/{id}/esquema` | **Nunca**, ni con la escritura activada |

Con la escritura desactivada (por defecto), si el agente intenta una acción que
modifica recibe:

> `'post_plcs' modifica el sistema y la escritura está desactivada. Explica al
> usuario qué harías y con qué parámetros, y que lo confirme él.`

…y el prompt le instruye para que explique el endpoint y el JSON exactos en vez
de fingir que lo hizo.

**Por qué las prohibidas están fuera incluso con permiso**: borrar un PLC deja
la planta sin monitorizar, y crear un esquema escribe estructura en una BD que
puede ser el ERP de la empresa. Eso lo hace una persona, mirando.

**Trazabilidad**: cada respuesta incluye `traza` (qué herramientas se usaron,
con qué argumentos, cuánto tardaron) y `citas` (qué documentación se citó). En
un entorno industrial, un dato sin trazabilidad no vale.

---

## 3. Configuración

En el `.env` (**nunca en el código, nunca en git**):

```ini
PLC_AI_ENABLED=true
PLC_AI_API_KEY=tu_api_key_aqui
PLC_AI_MODEL=gpt-oss:120b-cloud

# Para un Ollama local en vez de cloud:
# PLC_AI_BASE_URL=http://localhost:11434

# Permitir acciones que modifican (por defecto solo lee):
# PLC_AI_PERMITIR_ESCRITURA=false
```

La API key se crea en https://ollama.com/settings/keys

| Variable | Defecto | Para qué |
|---|---|---|
| `PLC_AI_ENABLED` | `true` | Desactiva todo el módulo |
| `PLC_AI_BASE_URL` | `https://ollama.com` | Cualquier API compatible con OpenAI |
| `PLC_AI_MODEL` | `gpt-oss:120b-cloud` | Modelo por defecto |
| `PLC_AI_MAX_PASOS` | `8` | Ciclos herramienta→observación por pregunta |
| `PLC_AI_PERMITIR_ESCRITURA` | `false` | Habilita las herramientas ⚠️ |
| `PLC_AI_RAG_FRAGMENTOS` | `6` | Fragmentos de documentación por pregunta |
| `PLC_AI_TEMPERATURE` | `0.2` | Baja a propósito: precisión, no creatividad |

> **Los modelos cloud rotan.** Si uno devuelve 410, fue retirado: consulta
> https://ollama.com/search?c=cloud y actualiza `PLC_AI_MODEL`. El cliente
> traduce ese error a un mensaje que lo explica.

---

## 4. Endpoints

### `POST /ai/chat` — preguntar

```json
{ "mensaje": "¿Qué PLCs hay conectados y cómo están?" }
```

```json
{
  "ok": true,
  "sesion_id": "a1b2c3d4e5f6",
  "respuesta": "Hay 2 PLCs conectados: …",
  "modelo": "gpt-oss:120b-cloud",
  "pasos": 2,
  "traza": [
    { "herramienta": "get_health", "argumentos": {}, "ok": true, "ms": 12.4 }
  ],
  "citas": [
    { "titulo": "API.md › 3. Consultas", "fuente": "API.md", "relevancia": 8.4 }
  ],
  "ms": 3421.8
}
```

Reutiliza `sesion_id` para continuar la conversación (historial acotado a 20
mensajes, configurable).

### `WS /ai/ws` — respuesta en streaming

Enviar `{"mensaje": "...", "sesion_id": "..."}` y recibir eventos:

| Evento | Contenido |
|---|---|
| `inicio` | `sesion_id`, `modelo` |
| `citas` | Fragmentos de documentación recuperados |
| `herramienta` | `estado: ejecutando \| hecho`, nombre, `ok`, `ms` |
| `texto` | Trozo de la respuesta (token a token) |
| `fin` | `respuesta` completa, `traza`, `ms` |
| `error` | `mensaje` legible |

```js
const ws = new WebSocket(`ws://${location.host}/ai/ws`);
ws.onopen = () => ws.send(JSON.stringify({ mensaje: "analiza la temperatura" }));
ws.onmessage = (e) => {
  const ev = JSON.parse(e.data);
  if (ev.tipo === "texto")       añadirTexto(ev.texto);
  if (ev.tipo === "herramienta") mostrarEstado(`Consultando ${ev.herramienta}…`);
  if (ev.tipo === "fin")         mostrarTraza(ev.traza, ev.citas);
};
```

Mostrar los eventos `herramienta` mientras el modelo trabaja es lo que
diferencia una espera muda de una en la que se ve qué está pasando.

### Resto

| Endpoint | Para qué |
|---|---|
| `GET /ai/estado` | Diagnóstico. Con `?comprobar=true` llama al modelo para validar API key y modelo |
| `GET /ai/herramientas` | Catálogo que el agente ve ahora mismo, con su riesgo |
| `POST /ai/recargar` | Re-lee OpenAPI y docs **sin reiniciar** |
| `POST /ai/buscar` | Probar el RAG **sin gastar tokens** |
| `GET /ai/sugerencias` | Preguntas de ejemplo para botones en la vista |
| `GET /ai/sesiones` · `DELETE /ai/sesiones/{id}` | Gestión de conversaciones |

---

## 5. El prompt, bloque a bloque

~13.600 caracteres, montados en cada pregunta:

| # | Bloque | Fijo / dinámico |
|---|---|---|
| 1 | **Identidad** — quién es y para quién trabaja | Fijo |
| 2 | **El sistema** — arquitectura y convenciones (`plc\|tag`, UTC, 100 ms) | Fijo |
| 3 | **Estado actual** — qué hay conectado ahora | Dinámico |
| 4 | **Esquema de datos** — tablas y columnas reales | Dinámico |
| 5 | **Herramientas** — catálogo por área + permisos | Dinámico |
| 6 | **Documentación** — fragmentos del RAG para *esta* pregunta | Dinámico |
| 7 | **Reglas** — verificar antes de afirmar, no inventar, encadenar | Fijo |
| 8 | **Formato** — cómo responder | Fijo |

Los bloques 3 y 4 se omiten si están vacíos (sin PLCs o sin BD), para no
gastar contexto en secciones sin contenido.

---

## 6. Qué está probado y qué no

**Verificado** (con un LLM simulado, sin conexión a Ollama):

- Derivación de 34 herramientas desde el OpenAPI y clasificación de riesgo.
- Descubrimiento automático de un endpoint añadido en caliente (34 → 35).
- Bucle completo: 2 herramientas encadenadas + respuesta final con traza.
- Bloqueo de escritura, herramienta inexistente y JSON de argumentos corrupto
  — los tres devuelven al modelo un mensaje que le permite corregir.
- Memoria de sesión y streaming por WebSocket.
- RAG: 96 fragmentos, acierto en todas las preguntas de prueba.
- Inyección del esquema real de la BD en el prompt.

**Pendiente de probar contra Ollama real** (no había salida a internet en el
entorno donde se construyó):

- Que el modelo elegido soporte *tool calling* correctamente.
- El reensamblado de `tool_calls` troceadas en modo streaming.
- Latencias y consumo de tokens reales.

Primer paso al desplegar: `GET /ai/estado?comprobar=true`. Si responde
`ok: true`, la conexión y el modelo funcionan.

---

## 7. Notas de implementación

- Las herramientas se ejecutan **en proceso** (`httpx.ASGITransport`): sin
  salto de red ni puerto extra, funciona igual empaquetado en el `.exe`.
- Los resultados se recortan a 6.000 caracteres: un `GET /tags` con 500 tags
  reventaría la ventana de contexto y dispararía el coste.
- Los errores de herramienta **se devuelven al modelo**, no se lanzan: un
  agente que ve el error puede corregir; uno al que se lo ocultas, no.
- Los endpoints `/ai/*` se excluyen del catálogo: si el agente pudiera
  llamarse a sí mismo, entraría en bucle.
- Los endpoints binarios (Excel) devuelven al modelo la URL de descarga, no
  el contenido — no puede leer un `.xlsx`.
- Archivos: `app/ai/llm_client.py` (proveedor), `tools.py` (catálogo),
  `rag.py` (recuperación), `prompts.py` (prompt), `agent.py` (bucle),
  `app/api/ai_routes.py` (endpoints).
- Dependencia: `httpx` (ya estaba en el proyecto vía FastAPI).
