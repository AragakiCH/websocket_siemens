# Widgets importados (`.zip`)

Cómo escribir un widget propio que haga lo mismo que uno de los que trae
PsiCore: leer varias variables, animarse con ellas y mandar valores al PLC.

Se importa desde el Diseñador (**Widgets → Arrastre al lienzo → importar**) o
con `PUT /widgets/{kind}`. Queda guardado en el servidor, así que aparece en
el catálogo de todos los equipos de la instalación.

---

## Los cuatro ficheros

| Fichero | ¿Obligatorio? | Qué es |
|---|---|---|
| `widget.json` | sí | quién es el widget y qué variables pide |
| `widget.html` | sí | lo que se dibuja (HTML o SVG) |
| `widget.css`  | no | sus estilos y sus animaciones |
| `widget.js`   | no | su lógica, si necesita alguna |

**Los nombres son libres**: lo que manda es la extensión, así que
`motor.html` vale igual que `widget.html`. Pueden ir en la raíz del ZIP o
dentro de una carpeta — que es lo que sale al comprimir con el botón derecho.
Si hubiera dos ficheros con la misma extensión gana el que se llame
`widget.<ext>`.

---

## `widget.json`

```json
{
  "kind": "motor_rotativo",
  "label": "Motor rotativo",
  "category": "Equipos",
  "defaultWidth": 180,
  "defaultHeight": 170,

  "accepts": ["bool"],

  "variables": [
    { "id": "velocidad", "label": "Velocidad", "accepts": ["double", "int"] },
    { "id": "fallo",     "label": "Fallo",     "accepts": ["bool"] }
  ]
}
```

| Campo | Qué hace |
|---|---|
| `kind` | identificador único. En el diseño se guarda como `custom:<kind>` |
| `label` | el nombre que se lee en la paleta |
| `category` | `Básicos`, `Indicadores`, `Equipos` o `Datos` |
| `defaultWidth` / `defaultHeight` | tamaño al soltarlo (40–800 px) |
| `accepts` | tipos que admite la variable PRINCIPAL: `bool`, `int`, `double`, `string`. `[]` = decorativo, no lee ninguna. Ausente = admite todo |
| `variables` | **las variables ADEMÁS de la principal** |

`variables` es lo que convierte un widget en un equipo. Con una sola no se
puede representar un motor: es marcha, fallo y velocidad **a la vez**, y lo
que el operario lee de un vistazo es la combinación. Cada una se pide en el
Diseñador con su `label` y solo se le ofrecen variables del tipo que dice
`accepts`.

El `id` empieza por una letra y lleva solo letras, números o guion bajo —
acaba siendo el nombre de una variable CSS.

---

## Lo que recibe el widget

Todo llega **sin recargar el iframe**, cada vez que cambia un valor.

### Variables CSS

De la variable principal:

| Variable | Contenido |
|---|---|
| `--w-on` | `1` / `0` — el valor interpretado como sí/no |
| `--w-frac` | `0`–`1` — el valor normalizado, para llenados y velocidades |
| `--w-color`, `--w-bg`, `--w-border-color` | los colores del widget |
| `--w-font-size`, `--w-bold`, `--w-opacity` | su tipografía y opacidad |

Y de **cada variable declarada**, con su `id`:

| Variable | Contenido |
|---|---|
| `--w-<id>-on` | `1` / `0` |
| `--w-<id>-frac` | `0`–`1` |
| `--w-<id>-value` | el valor en crudo |

Con esto se anima **sin escribir una línea de JavaScript**:

```css
#rotor {
  animation: girar calc((2 - var(--w-velocidad-frac, 0)) * 1s) linear infinite;
}
#alarma { opacity: var(--w-fallo-on, 0); }
```

### Textos

| Atributo | Se rellena con |
|---|---|
| `data-w-value` | el valor en crudo de la principal |
| `data-w-label` | el valor ya formateado («23.7 °C») |
| `data-w-name` | el nombre del widget en el lienzo |
| `data-w-var="<id>"` | el valor formateado de esa variable |

```html
<span data-w-var="velocidad">—</span>
```

### JavaScript

```js
window.WIDGET            // { value, on, frac, label, name, color, …, vars }
window.WIDGET.vars.velocidad   // { value, on, frac, label }

window.onWidgetUpdate = function (w) {
  // se llama en CADA cambio de valor
};
```

---

## Escribir en el PLC

```js
escribir(true);              // a la variable PRINCIPAL
escribir(75, 'velocidad');   // a una variable con nombre
```

La respuesta llega aparte:

```js
window.onWidgetEscrito = function (r) {
  // r = { ok: true|false, error: '…', variable: 'velocidad' }
};
```

**El widget no escribe: lo pide.** La orden la manda el anfitrión por el mismo
`POST /escritura` que usa todo lo demás, así que pasa por la **lista blanca**
de tags, sus **límites**, la comprobación de **tipo** y la **auditoría** de
quién escribió qué. Un widget importado es código que viene de fuera; que
pudiera hablar con el autómata por su cuenta sería justo lo que no debe pasar.

En consecuencia:

* un tag que no esté habilitado para escritura será **rechazado por el
  servidor**, por mucho que el widget lo pida;
* **en el Diseñador no se escribe nunca** — allí el puntero sirve para colocar
  el widget;
* el iframe va con `sandbox="allow-scripts"` y **sin** `allow-same-origin`: no
  puede leer la sesión, ni el almacenamiento, ni llamar a la API por su
  cuenta.

---

## Las dinámicas también le afectan

Un widget importado recibe además las **Dinámicas** que se le pongan desde el
Inspector (color, fondo, borde, visibilidad, parpadeo). Una regla que mire
otra variable le cambiará el `--w-color`, lo esconderá o lo hará parpadear sin
que el widget tenga que saber nada.

Es la forma rápida de dar comportamiento a un símbolo que ya funciona, sin
volver a tocar su código.

---

## Ejemplos

### Ventilador — [`ejemplos/widget-ventilador/`](ejemplos/widget-ventilador/)

Listo para importar: [`ejemplos/widget-ventilador.zip`](ejemplos/widget-ventilador.zip).

Cuatro aspas que giran más deprisa cuanto mayor es una variable **analógica**
(`velocidad`) y que arrancan y paran con una **discreta** (`marcha`). Parado se
ve apagado, para distinguirlo de un vistazo. No usa la variable principal
—declara `"accepts": []`—, así que el Diseñador solo pide sus dos variables,
cada una por su nombre.

Es el ejemplo más corto que enseña las dos mitades: lo continuo en CSS (la
duración del giro y la opacidad salen de `calc()` sobre las variables) y lo
discreto en tres líneas de `widget.js` (arrancar o parar la animación).

### Motor — [`ejemplos/widget-motor/`](ejemplos/widget-motor/)

Además de lo anterior, **escribe en el PLC**: un mando discreto (marcha) y uno
analógico (consigna). Un motor que:

* gira más deprisa cuanto mayor es la **velocidad**, en CSS puro;
* arranca y para con la **principal** (marcha), en una línea de `widget.js`
  — encender o apagar una animación es lo único que el CSS no sabe decidir a
  partir de un número;
* enciende un rótulo de alarma con **fallo**;
* y lleva dos mandos: uno discreto (marcha) y uno analógico (consigna 75 %).

Para importar cualquiera de los dos: comprimir su carpeta y soltar el `.zip`
en el Diseñador (o usar el `.zip` ya hecho del ventilador).

---

## Lo que todavía NO hace

* El widget no puede **suscribirse** a variables por su cuenta: usa las que le
  enlace quien diseña la pantalla.
* No hay forma de que declare **acciones** propias para el menú del Inspector.
* Las variables declaradas no se pueden **renombrar** desde el Inspector (son
  del widget, no del usuario); las que añada el usuario a mano, sí.
