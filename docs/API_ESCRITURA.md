# Escribir valores en el PLC

Hasta ahora Psi Core solo leía. Esto es lo único de toda la API que **mueve
cosas en la planta**, y por eso está separado en su propio módulo, con sus
propias reglas.

Funciona igual para **Siemens S7-1500** y para **Bosch Rexroth ctrlX**: los dos
hablan OPC UA por debajo, así que la escritura es una sola implementación. Lo
único que cambia entre ellos es el mensaje de diagnóstico cuando el PLC rechaza
la operación, porque hay que mirar en sitios distintos.

---

## Los tres candados

| Candado | Qué impide |
|---|---|
| **Rol** `Administradores` o `Supervisor` | Que un operario fuerce valores por la API |
| **Lista blanca** con rangos | Que se escriba en un tag que nadie autorizó |
| **Auditoría** | Que no se sepa quién cambió qué, y desde qué valor |

Además, el **tipo de dato** se valida antes de salir a la red y el valor se
**relee del PLC** para confirmarlo.

### Por qué hace falta una lista blanca

Un servidor OPC UA declara escribibles muchísimas más variables de las que
tiene sentido tocar desde un HMI. Basta con enlazar un deslizador al tag
equivocado, o con que se cuele un nombre mal escrito en una receta, para mandar
un valor a algo que no debía moverse. Y a diferencia de una lectura mal
enlazada, esto no se descubre mirando la pantalla: se descubre en la máquina.

Así que la regla va al revés de lo habitual: **nada es escribible hasta que
alguien lo habilita a mano**. Habilitar un tag es una decisión de ingeniería,
no un efecto secundario de arrastrar un widget.

---

## Puesta en marcha

### 1. Ver qué se puede habilitar

```
GET /escritura/candidatos?plc_id=siemens_1
```

Devuelve los tags cuyo tipo admite escritura, marcando cuáles están ya
habilitados. Úsalo en vez de teclear el nombre a mano: de ahí salen las erratas
que acaban habilitando el tag equivocado.

### 2. Habilitar uno, con sus límites

```
PUT /escritura/permitidos
{
  "plc_id": "siemens_1",
  "tag": "DB_snap7.setpoint_temp",
  "minimo": 40.0,
  "maximo": 90.0,
  "descripcion": "Consigna de temperatura · Cuba 1"
}
```

Los límites son la segunda red. El tipo ya impide que un `Int16` desborde, pero
que un valor **quepa** en un Int16 no significa que la máquina lo admita: 32000
cabe de sobra en una consigna de temperatura cuyo máximo real son 90 °C.

En tags booleanos o de texto los límites se ignoran.

### 3. Escribir

```
POST /escritura
{
  "escrituras": [
    { "plc_id": "siemens_1", "tag": "DB_snap7.setpoint_temp", "valor": 65 }
  ]
}
```

```json
{
  "ok": true,
  "escrituras": 1,
  "resultados": [{
    "tag": "DB_snap7.setpoint_temp",
    "solicitado": 65,
    "escrito": 65.0,
    "confirmado": 65.0,
    "anterior": 20.0,
    "coincide": true,
    "ok": true
  }],
  "usuario": "hugo"
}
```

**Mira siempre `coincide`.** Es `false` cuando el PLC guardó algo distinto de
lo que se pidió, que pasa más de lo que parece: un `Real` recorta precisión, y
un bloque de función puede pisar la consigna en el mismo ciclo de scan si esa
variable la gobierna el programa. Sin releer, la interfaz diría "escrito" y el
PLC tendría otra cosa.

---

## Varios tags a la vez

Para descargar una receta entera. El orden de las fases importa:

1. **Se valida TODO** antes de tocar el PLC. Si la receta trae ocho valores y
   el séptimo se sale de rango, no puede haber escrito ya los seis primeros: la
   máquina se quedaría a medio configurar, que es peor que no haber empezado.
2. Se **leen** los valores actuales — sin esto no hay a dónde volver.
3. Se **escriben** en orden.
4. Si algo falla, se **restauran en orden INVERSO**. Al revés porque si un
   valor depende de otro (una consigna que solo tiene sentido con un modo ya
   puesto), deshacer en el mismo orden dejaría estados intermedios que el
   programa del PLC no espera.

```json
{ "ok": false, "fallo_en": "DB_snap7.marcha",
  "motivo": "BadNotWritable", "revertidos": ["DB_snap7.presion", "DB_snap7.temp"],
  "sin_revertir": [] }
```

> **Esto no es una transacción, y conviene tenerlo claro.** Un PLC no las
> tiene. Entre la escritura y la vuelta atrás pasan milisegundos en los que el
> programa ya vio el valor nuevo y pudo actuar. La vuelta atrás deja las
> **variables** como estaban, no la **máquina**. Lo que de verdad protege es la
> lista blanca y los rangos: no haber escrito nunca un valor imposible.
>
> `sin_revertir` lista los tags que no se pudieron restaurar. Si aparece algo
> ahí, hay que mirarlo a mano.

---

## Por WebSocket

Para botones y deslizadores, donde abrir una petición HTTP por cada movimiento
se nota. Por la conexión que ya está abierta:

```json
{ "tipo": "write", "id": "b1", "plc_id": "siemens_1",
  "tag": "DB_snap7.marcha", "valor": true }
```

Respuesta:

```json
{ "tipo": "write.result", "id": "b1", "ok": true, "resultados": [ ... ] }
```

El `id` vuelve tal cual para que el frontend case la respuesta con la petición
que la originó. **Siempre hay respuesta**, también en los errores: un botón que
no recibe nada se queda "pulsando" para siempre y quien está delante no sabe si
el valor llegó.

Pasa por **las mismas** comprobaciones que el REST. No hay un camino rápido que
se salte nada — sería el atajo por donde entrarían los fallos.

Una diferencia: por WebSocket **la sesión es obligatoria** aunque
`auth_requerida` esté en `False`. El REST deja pasar sin sesión en modo
arranque, para poder crear la primera cuenta; escribir en un PLC nunca forma
parte de configurar el sistema.

---

## Conversión de tipos

`app/drivers/escritura.py`. Nunca adivina: ante la duda, rechaza.

| Caso | Qué hace | Por qué |
|---|---|---|
| `"false"` → `Boolean` | `False` | En Python `bool("false")` es **True**. Una conversión ingenua arrancaría el motor que se quería parar |
| `7` → `Boolean` | **rechaza** | Solo 0 y 1 son inequívocos |
| `40000` → `Int16` | **rechaza** | Desbordaría a −25536, y según el servidor sin avisar |
| `3.7` → `Int16` | **rechaza** | Truncar a 3 ocultaría el error |
| `5` → `Float` | `5.0` | asyncua es estricto con el Variant |
| `"23,5"` → `Float` | `23.5` | Coma decimal europea |
| `True` → `Int16` | **rechaza** | En Python `True` vale 1; permitirlo escondería un widget mal enlazado |
| estructuras, arrays | **rechaza** | Merecen una implementación pensada, no una conversión por descarte |

---

## Cuando el PLC dice que no

El código OPC UA es el mismo en los dos casos y por sí solo no orienta.

**Siemens** — `BadUserAccessDenied` o `BadNotWritable`: la variable está como
solo lectura en el servidor OPC UA. En TIA Portal, propiedades del DB, hay que
marcarla como accesible y escribible desde OPC UA.

**Rexroth ctrlX** — suele ser una de dos: la variable no está declarada como
accesible desde fuera en el programa PLC, o el usuario con el que se conecta
Psi Core no tiene permiso de escritura en la gestión de accesos del ctrlX.

Un rechazo repetido del PLC se registra en auditoría: es señal de que algo está
mal configurado en el proyecto del autómata, no de que alguien esté insistiendo.

---

## Qué queda registrado

| Acción | Cuándo |
|---|---|
| `plc.escritura` | Escritura correcta, con valor anterior y nuevo de cada tag |
| `plc.escritura.fallida` | Falló a mitad, con qué se revirtió y qué no |
| `plc.escritura.denegada` | El tag no estaba habilitado |
| `plc.escritura.fuera_de_rango` | Se salía de los límites |
| `plc.escritura.rechazada_por_plc` | El PLC lo rechazó |
| `plc.escritura.habilitada` / `.deshabilitada` | Cambios en la lista blanca |

Se guarda el **valor anterior** además del nuevo. Sin él, el registro sirve
para saber quién tocó algo, pero no para deshacerlo.

Consultable en `GET /auditoria`.
