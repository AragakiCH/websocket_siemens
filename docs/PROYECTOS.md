# Proyectos y pantallas

## Qué cambió

Antes una instalación era **un solo HMI** con varias pantallas: la barra de
pestañas del Diseñador las enseñaba todas juntas, y para montar un segundo HMI
había que mezclar sus pantallas con las del primero.

Ahora hay dos niveles:

```
Proyecto "Planta Norte"        Proyecto "Línea 2"
├── Pantalla 1                 ├── Pantalla 1     <- vuelve a empezar por 1
├── Pantalla 2                 └── Pantalla 2
└── Pantalla 3
```

Cada proyecto tiene sus pantallas, su numeración empezando por 1 y su propia
memoria de "dónde estabas". Se cambia de proyecto con el selector de la
cabecera del Diseñador, junto al título.

## Qué NO se separa, y por qué

**Flujos, alarmas y recetas siguen siendo comunes.** No cuelgan del diseño sino
de los tags del PLC: la alarma "temperatura alta" es la misma mire quien la
mire, y duplicarla por proyecto multiplicaría las reglas que evalúa el motor
sin que nadie lo haya pedido. Si algún día hace falta separarlas, el sitio es
la tabla de cada una, no este nivel.

## El lío de nombres, dicho de frente

Cuando solo había un nivel, a cada **pantalla** se la llamó "proyecto". De ahí
vienen `project_id`, `datos/proyectos/<id>.json`, el lock `designer:<id>` y el
evento `project.updated`. Renombrar todo aquello habría tocado el bloqueo de
edición, el WebSocket, la caché de cada navegador y los ficheros ya guardados
de la instalación, así que **la frontera se puso en la API**, que es lo que se
lee de verdad:

| Concepto | HTTP | Backend | Frontend |
|---|---|---|---|
| **Proyecto** (agrupa pantallas) | `/proyectos` | `app/db/proyecto_store.py`, `app/api/proyecto_routes.py` | `utils/proyectoStorage.ts`, `proyectoId` |
| **Pantalla** (un diseño) | `/pantallas` | `app/db/project_store.py`, `app/api/project_routes.py` | `utils/designStorage.ts`, `projectId` |

Dentro del código Python y TypeScript, `project_id` / `projectId` (en inglés)
significa siempre **pantalla**; `proyecto` / `proyectoId` significa siempre el
nivel de arriba.

> `/pantallas` **es** el antiguo `/proyectos`, renombrado. No hay alias: la
> instalación sirve backend y frontend juntos, y mantener dos nombres para lo
> mismo habría dejado el lío para siempre.

## API

```
GET    /proyectos              lista, con num_pantallas de cada uno
GET    /proyectos/{id}         el proyecto + la lista de sus pantallas
POST   /proyectos              crear (crea también su primera pantalla)  [Administradores]
PATCH  /proyectos/{id}         renombrar                                 [Administradores]
DELETE /proyectos/{id}         borrar CON TODAS SUS PANTALLAS            [Supervisor]
GET    /proyectos/{id}/exportar   el proyecto entero en un .json
POST   /proyectos/importar        crear uno desde ese .json                 [Administradores]

GET    /pantallas?proyecto=<id>   las de un proyecto (sin el filtro, todas)
POST   /pantallas                 {project_id, nombre, proyecto}
...el resto igual que antes, con /pantallas en vez de /proyectos
```

Los cambios se difunden por el mismo WebSocket que el resto:
`proyecto.updated` y `proyecto.removed`, con `proyecto_id`.

## Llevarse un proyecto a otro equipo

En el selector, cada proyecto tiene un botón de **exportar** (baja un `.json`
que se guarda donde uno quiera) y abajo hay **Importar**, que crea un proyecto
a partir de ese fichero.

### Qué viaja en el fichero

El proyecto, sus pantallas con todos sus widgets, y **la definición de los
widgets personalizados que use** (el HTML/CSS/JS de los `.zip` importados).
Sin lo último, abrir el proyecto en otro equipo dejaría cajas vacías donde
había un widget, sin ningún error que lo explicara: el diseño sabe que ahí va
un `custom:manometro`, pero ese equipo no tiene ni idea de qué es eso.

**No viajan** alarmas, recetas, flujos ni conexiones a base de datos. No
cuelgan del diseño sino de los tags del PLC y de la instalación; llevárselos
escondidos dentro de un proyecto sobrescribiría configuración de planta que
nadie ha pedido tocar. Para mover una instalación entera está la copia de
seguridad de Configuración (`GET /sistema/datos/backup`).

Es un `.json` y no un `.zip` a propósito: se puede abrir con cualquier editor
para ver qué trae antes de meterlo en un equipo de planta, y se versiona en git
como cualquier otro fichero de texto.

```json
{
  "formato": "psicore.proyecto",
  "version": 1,
  "exportado_en": "2026-09-10T20:14:03Z",
  "proyecto":  { "proyecto_id": "linea_2", "nombre": "Línea 2" },
  "pantallas": [ { "project_id": "...", "nombre": "...", "canvas": {}, "widgets": [] } ],
  "widgets_personalizados": [ { "kind": "manometro", "html": "...", "css": "...", "js": "..." } ]
}
```

### Importar no sobrescribe NADA

Es la regla de la que cuelga todo lo demás. Importar siempre crea un proyecto
**nuevo**; reimportar el mismo fichero deja los dos, no pisa el primero.

* Si el `proyecto_id` del fichero está libre, se conserva; si no, el importado
  nace con sufijo (`linea_2_2`) y su nombre se marca como *(importado)* solo
  cuando choca con el de otro.
* Igual con los ids de las pantallas. **Y si alguno cambia, los enlaces entre
  pantallas se reescriben**: un Menú Lateral cuya sección apuntaba a
  `linea_2_detalle` pasa a apuntar a `linea_2_detalle_2`, es decir, a la copia
  del proyecto importado y no a la del original. Sin esto, importar dos veces
  dejaría el segundo proyecto navegando a las pantallas del primero, y ese
  fallo no da ningún error: simplemente se abre la pantalla equivocada.
* Los widgets personalizados que **ya existan** en el equipo se dejan como
  están. Reemplazarlos cambiaría el aspecto de otros proyectos que los usen.
* Si algo falla a mitad, se deshace lo creado. Mejor no importar que dejar
  medio proyecto.

Se conservan los ids originales siempre que se pueda porque eso hace que el
caso normal —llevar el proyecto a un equipo que no lo tiene— no toque
absolutamente nada: mismos ficheros, mismos enlaces.

### Rechazos, y por qué se leen

| Situación | Respuesta |
|---|---|
| No es un `.json` válido | Se detecta en el navegador, sin subir nada |
| `formato` distinto de `psicore.proyecto` | «Este fichero no es un proyecto exportado desde la aplicación» |
| `version` mayor que la del servidor | «Se exportó con una versión más nueva del programa. Actualiza este equipo» |
| Sin pantallas, o más de 200 | 400 con el motivo |

Lo de la versión importa: leer a medias un formato que no se entiende y crear
un proyecto incompleto es mucho peor que no importarlo.

## Reglas que impone el servidor

* **Un proyecto nunca está vacío.** Al crearlo se crea su primera pantalla, y
  no se deja borrar la última que le quede: un proyecto sin pantallas es una
  pestaña en la que no se puede ni soltar un widget.
* **El proyecto `principal` no se borra.** Es el destino al que vuelve el
  Diseñador cuando cualquier otro desaparece. Se puede vaciar.
* **La pantalla `principal` tampoco.** Mismo motivo, un nivel más abajo.
* **Los ids de pantalla son únicos en toda la instalación**, porque cada uno es
  un fichero en la misma carpeta. Por eso la vista antepone el id del proyecto:
  `linea_2_pantalla_1` y `horno_pantalla_1` pueden llamarse las dos
  "Pantalla 1" de cara al usuario. Los **nombres** sí se repiten, a propósito.
* **El `proyecto_id` no cambia nunca** al renombrar: está escrito dentro del
  JSON de cada una de sus pantallas.

## Migración de una instalación que ya existía

No hay que hacer nada. Al arrancar:

1. `proyecto_store` crea `datos/proyectos_hmi.json` con el proyecto
   `principal` si no existe;
2. toda pantalla sin campo `proyecto` lo recibe apuntando a `principal` —es
   exactamente donde estaba— y **se reescribe en disco**, para que el fichero
   diga a qué proyecto pertenece y no solo la memoria;
3. si alguna pantalla apunta a un proyecto que no existe (se restauró una copia
   a medias, alguien borró el JSON a mano), la adopta `principal`. Sin eso
   quedaría invisible: no sale en ninguna lista pero sigue ocupando su id.

Es decir: quien ya tenía tres pantallas se encuentra un proyecto "Proyecto
principal" con esas mismas tres, en el mismo orden.

## Dónde vive cada cosa

```
datos/
├── proyectos_hmi.json        <- los PROYECTOS (un solo fichero: son 4 campos)
└── proyectos/                <- las PANTALLAS (un fichero por pantalla)
    ├── principal.json            { "proyecto": "principal", widgets... }
    └── linea_2_pantalla_1.json   { "proyecto": "linea_2",   widgets... }
```

Un fichero único para los proyectos y una carpeta para las pantallas no es una
incoherencia: un proyecto son cuatro campos y se escribe entero de una vez; una
pantalla son decenas de KB de widgets que se guardan en cada arrastre.

## En el navegador

| Clave de `localStorage` | Para qué |
|---|---|
| `hmi.proyecto.ultimo` | En qué proyecto estabas |
| `hmi.design.ultima.<proyecto>` | Qué pantalla mirabas **en ese proyecto** |
| `hmi.design.<pantalla>` | Caché del diseño (la verdad está en el servidor) |

La última pantalla se recuerda **por proyecto** a propósito: con una sola
memoria, volver al proyecto A te dejaría en una pantalla del B que ni siquiera
está en sus pestañas.
