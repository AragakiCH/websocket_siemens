# Modo función: Python en los widgets · 15 oct 2026

## Lo que se pidió

Que el bloque «Expresión» del modal «Configurar modo función» acepte
**código Python**, reconozca las variables del modal (tags de entrada,
variables internas, la salida) y permita definir funciones.

## Cómo queda

En el modal, el bloque 3 es Python:

```python
# Las entradas y las internas son variables; asigna la salida.
def escala(x):
    return round(x * 100 / 4095, 1)

if temperatura is not None and temperatura > 80:
    varPrincipal = 3
else:
    contador = contador + 1
    varPrincipal = escala(nivel)
```

- La salida (`varPrincipal`, `var1`…) se **asigna**, o el código termina en
  una expresión y ese es el valor (`(a + b) / 2`).
- Hay `if/elif/else`, `for`, `while`, `def`, `lambda`, `try`, `math`, y los
  builtins normales (`abs`, `round`, `min`, `max`, `int`, `float`, `str`,
  `len`, `range`, `sum`…). `print()` se ve en «Valores de prueba».
- Las **variables internas conservan su valor** entre evaluaciones: un
  `contador = contador + 1` cuenta de verdad. Arrancan en el defecto de su
  tipo (False / 0 / 0.0 / "").
- Una entrada cuyo tag no se lee vale `None`.

Encima del editor salen **chips** con la salida, las entradas y las
internas: encendidos si el código los usa, y con un clic se insertan donde
esté el cursor. Mientras se escribe, el servidor valida la sintaxis (la
línea con error se marca en rojo) y avisa de nombres que no existen en el
modal y de si la salida no recibe valor. **Valores de prueba y resultado**
ejecuta el código de verdad con los valores que se pongan (las entradas
arrancan con su lectura actual) y enseña el resultado, las internas después,
lo impreso y el error con su línea.

En vivo, en el Diseñador y en la Vista Previa, el widget calcula su salida
con los tags reales (`components/hmi/funcion/enVivo.ts`): como mucho cuatro
veces por segundo, y solo cuando cambia alguna entrada.

## Dónde corre y por qué es razonablemente seguro

El Python corre en el **servidor** (`app/core/funciones_py.py`), no en el
navegador. Antes de ejecutar se analiza el árbol: no se admiten `import`,
`class`, `with`, nada `async`, ni atributos que empiecen por `_`; los
builtins son una lista cerrada (sin `open`, `eval`, `exec`, `__import__`,
`getattr`…); y hay un **límite de 500 ms** por evaluación que corta
cualquier bucle sin fin inyectando una excepción en el hilo
(`PyThreadState_SetAsyncExc`, que no depende de eventos de línea — la traza
no alcanzaba a `while True: pass` en una línea).

No es una sandbox contra un atacante con permisos de Administrador del
Diseñador —ese ya puede escribir en el PLC—; es para que un error honesto no
tumbe el servicio ni toque el disco.

## Una evaluación por cambio, no por visor

El servidor recuerda, por widget y salida, con qué entradas y código calculó
la última vez (`Evaluador`). Si llega lo mismo, responde sin ejecutar. Así
diez visores del mismo widget no hacen que un contador cuente diez veces.
El estado vive en memoria y se pierde al reiniciar; `DELETE
/funciones/estado/{widget_id}` lo reinicia a mano.

## API

| Método | Ruta | Rol | Para qué |
|---|---|---|---|
| `POST` | `/funciones/validar` | Administradores | sintaxis, nombres leídos/asignados/desconocidos |
| `POST` | `/funciones/probar` | Administradores | ejecutar con valores de prueba (sin memoria) |
| `POST` | `/funciones/evaluar` | sesión | ejecutar con los tags reales (con memoria) |
| `DELETE` | `/funciones/estado/{widget_id}` | Administradores | olvidar las internas de un widget |

## Probado

Unitario (`ejecutar_sync`, `validar`, `Evaluador`): expresión suelta,
if/else con interna persistente, `def` + `math` + `print`, sin valor en la
salida, `import`/`open`/`__class__`/`class`/`with` rechazados, bucle sin fin
en una y en dos líneas cortado a 500 ms (Python 3.10 y 3.13), `NameError`
con línea, sintaxis con línea, `None` en entrada, caché por entradas. Los
cuatro endpoints con `TestClient`.

## Ficheros

| Fichero | Qué hace |
|---|---|
| `app/core/funciones_py.py` | Análisis, ejecución acotada, evaluador con memoria. |
| `app/api/funciones_routes.py` | Los endpoints. |
| `app/main.py` | Alta del router. |
| `frontend/vite.config.js` | Proxy de `/funciones`. |
| `frontend/src/services/funcionesApi.ts` | Cliente HTTP + detección de identificadores en el editor. |
| `frontend/src/components/hmi/funcion/ModalFuncion.tsx` | Editor Python, chips, validación, pruebas. |
| `frontend/src/components/hmi/funcion/enVivo.ts` | El cálculo en vivo. |
| `frontend/src/components/hmi/WidgetRenderer.tsx` | Sustituye la variable leída por la calculada. |
