# Crear variables desde la vista

## Primero, lo que no se puede hacer

**No se puede crear una variable dentro de un PLC en marcha.** Ni en Siemens ni
en el programa IEC del ctrlX.

Las variables de un DB se reservan **al compilar**: TIA Portal calcula el mapa
de memoria y lo descarga. Añadir una implica editar el proyecto, recompilar y
hacer descarga. No hay camino en caliente.

OPC UA tiene un servicio `AddNodes`, y `asyncua` lo expone, pero el servidor del
S7-1500 no lo implementa. Y aunque lo hiciera, crearías un nodo **en el servidor
OPC UA**, no en la memoria del programa: una variable que existe para quien mira
por OPC UA y no existe para el autómata, que no podría leerla ni actuar sobre
ella. Sería peor que no tenerla, porque parecería funcionar.

## Lo que sí se hace: reserva previa

Es el patrón que se usa en la industria justo para esto. Reservas los huecos
**una vez**, y a partir de ahí crear una variable desde la vista es **reclamar
un hueco libre y ponerle nombre**.

Para quien lo usa, acaba de crear *Consigna Cuba 3*. Por debajo es
`DB_HMI.spare_real_07`. Y es una variable **real del PLC**: el programa puede
leerla y actuar sobre ella.

---

## Paso 1 · El DB de reserva (una sola vez)

En TIA Portal, un DB nuevo con variables **sueltas**:

```
DB_HMI
    spare_real_00 : Real;
    spare_real_01 : Real;
    ...
    spare_real_49 : Real;

    spare_bool_00 : Bool;
    ...
    spare_bool_99 : Bool;

    spare_int_00  : Int;
    ...
    spare_int_49  : Int;
```

En las propiedades del DB, marcar **Accesible desde OPC UA** y **Escribible
desde OPC UA**. Desmarcar *Acceso optimizado al bloque* si tu versión lo exige
para publicar símbolos.

Una descarga, y ya no hace falta volver a compilar por añadir variables.

> ### Sueltas, no un array
>
> `ARRAY[0..49] OF REAL` es lo natural de escribir en TIA, pero no sirve aquí:
>
> - El browse de Psi Core no lee `ValueRank` ni `ArrayDimensions`, así que un
>   array llega como un escalar cuyo valor es una lista y acaba convertido a
>   texto.
> - `Node.write_value()` de asyncua no acepta `IndexRange`: escribir **un**
>   elemento exigiría bajar a `write_attribute` a mano.
> - El historizador, las alarmas y los widgets tratan cada tag como un escalar
>   con nombre propio.
>
> Si declaras un array, `GET /variables/huecos` lo detecta y te lo dice en
> `avisos`. Sin ese aviso el síntoma sería una variable que se ve como texto
> raro, y eso no orienta a nada.

**En Rexroth ctrlX** es lo mismo: variables declaradas en el programa PLC,
marcadas como accesibles desde fuera. Los nombres pueden ser idénticos.

Se reconocen estos prefijos, en minúsculas y por «contiene»:

| Tipo | Prefijos aceptados |
|---|---|
| real | `spare_real`, `reserva_real`, `hmi_real`, `libre_real` |
| bool | `spare_bool`, `reserva_bool`, `hmi_bool`, `libre_bool` |
| int | `spare_int`, `reserva_int`, `hmi_int`, `libre_int` |

---

## Paso 2 · Ver qué hay

```
GET /variables/huecos?plc_id=siemens_1
```

```json
{
  "resumen": {
    "real": { "libres": 50, "ocupados": 0 },
    "bool": { "libres": 100, "ocupados": 0 },
    "int":  { "libres": 50, "ocupados": 0 }
  },
  "libres": [ { "tag": "DB_HMI.spare_real_00", "data_type": "Float", ... } ],
  "avisos": []
}
```

Si sale 0 en todo: o no hay DB de reserva, o los nombres no encajan con los
prefijos de arriba.

---

## Paso 3 · Crear

```
POST /variables
{
  "nombre": "Consigna de temperatura · Cuba 3",
  "plc_id": "siemens_1",
  "tipo": "real",
  "unidad": "°C",
  "minimo": 40,
  "maximo": 90
}
```

```json
{ "ok": true,
  "variable": { "id": "consigna_de_temperatura_cuba_3",
                "tag": "DB_HMI.spare_real_07", "data_type": "Float" },
  "huecos_libres_restantes": 49 }
```

Coge el primer hueco libre. Se puede pedir uno concreto con `"tag"`.

**Queda habilitada para escritura en la misma operación**, con esos límites. Si
no, crear una consigna dejaría algo que se ve pero no se puede tocar, y habría
que ir a otra pantalla a terminar el trabajo — un paso que se olvida siempre.

Ya se puede escribir en ella:

```
POST /escritura
{ "escrituras": [ { "plc_id": "siemens_1",
                    "tag": "DB_HMI.spare_real_07", "valor": 65 } ] }
```

---

## Cambiar y liberar

```
PATCH  /variables/{id}     nombre, unidad, límites, descripción
DELETE /variables/{id}     libera el hueco
```

**Renombrar no mueve el hueco.** El `id` se deriva del nombre al crearla y ya
no se recalcula: es lo que guardan los widgets y las recetas, y recalcularlo al
renombrar dejaría huérfano todo lo que apuntara a él.

**Cambiar los límites los actualiza también en la lista blanca de escritura.**
Viven en dos sitios; si solo se cambiaran aquí, el rango que de verdad se aplica
al escribir seguiría siendo el viejo, y nadie lo notaría hasta que un valor
legítimo fuera rechazado.

**Al liberar no se pone a cero el valor en el PLC.** Escribir en una variable de
proceso como efecto secundario de borrar una etiqueta sería una sorpresa
peligrosa. El hueco queda como estaba; lo que desaparece es el nombre. También
se le quita el permiso de escritura, para que el siguiente que reclame ese hueco
no herede los límites de la variable anterior.

---

## Cuando se acaban los huecos

```json
{ "detail": "No quedan huecos 'real' libres en 'siemens_1'. Hay que ampliar el
             DB de reserva en TIA Portal y volver a descargar el programa." }
```

Es el único momento en que hace falta volver a TIA. Por eso conviene reservar
de sobra desde el principio: 50 reales sin usar ocupan 200 bytes.

---

## Qué queda registrado

| Acción | Cuándo |
|---|---|
| `variable.creada` | Con el hueco asignado, tipo y límites |
| `variable.modificada` | Cambios de nombre o límites |
| `variable.liberada` | Con qué hueco vuelve a estar libre |

Rol necesario: `Administradores`.
