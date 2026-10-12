# Botones del Panel de Sección · 12 oct 2026

## Lo que se pidió

Dentro del **Panel de Sección**, botones a los que se les asigna una pantalla:
al pulsar uno, el panel enseña esa pantalla **ahí mismo**, sin salir de la
sección ni mover el menú. Y poder **volver** a lo que el panel enseñaba antes
—y volver a ir— las veces que haga falta.

## Cómo queda

El panel tiene ahora tres «capas», de abajo arriba:

1. **La sección, por sí sola** (lo de siempre): el marco de fondo y los
   widgets vecinos con esa sección en «Vista».
2. **La pantalla que la sección tenga asignada** en el Menú Lateral (lo de
   siempre también).
3. **Lo que el operador abra con un botón** — nuevo. Va por encima de las dos
   anteriores y se deshace con las flechas, la casita, o el primer botón de
   la barra.

Las dos primeras son el **origen** del panel. La tercera es un **historial**,
como el de un navegador: atrás, adelante, y a casa sin perder lo recorrido.
El mando es el widget Navegador de Pantallas; el panel no lleva flechas.
Cambiar de sección en el menú lo vacía.

### El widget «Navegador de Pantallas» (`NavegadorPanel.tsx`)

Son las flechas **◀ ▶ ⌂** como widget suelto de la paleta (sección Básicos):
se arrastra, se estira y se estiliza como cualquier otro, y se coloca donde
el diseño lo pida — incluso dentro de la pantalla que se empotra. En
Propiedades se le da la **lista ordenada de pantallas** por las que se mueve:

- **▶** abre la siguiente de la lista; desde el origen, la primera.
- **◀** vuelve a la anterior; desde la primera, al origen de la sección. Si
  el panel enseña algo que no está en la lista (lo abrió otro mando), deshace
  un paso del historial.
- **⌂** directo al origen, sin perder el recorrido (se puede ocultar).
- Opcional: el **nombre** de lo que se está viendo entre las flechas.
- Partes **Caja**, **Flechas** (color) y **Nombre**.

Las flechas se ven apagadas cuando no hay a dónde ir.

### En Propiedades del Panel de Sección

- Sin mandos propios: el panel solo obedece. La cabecera enseña la ruta: `Detalles › Pantalla 2` mientras hay una
  pantalla abierta, y solo `Detalles` en el origen.

(La primera versión llevaba una lista de botones y una «posición de la
barra» en el propio panel, la segunda un botón suelto por pantalla, y hubo flechas
en la cabecera del panel; todo eso se retiró. Si un diseño guardado trae esos campos, se ignoran.)

### Dos acciones para cualquier otro botón (`acciones.ts`)

| Acción | Qué hace |
|---|---|
| **Mostrar pantalla en el Panel de Sección** | El panel del grupo pasa a enseñar esa pantalla. Mismo historial. |
| **Volver en el Panel de Sección** | Un paso atrás; con «Directo al origen», a casa. |

Son para widgets que no son el navegador (un botón normal, un ZIP, un
símbolo); ojo a la regla de abajo, porque esos sí se esconden.

## Una regla que conviene saber

Mientras el panel enseña una pantalla abierta así, la **Vista Previa oculta
los widgets de la sección actual** (los que llevan su id en «Vista»): son
vecinos del panel, no están dentro, y quedarían dibujados encima. Al volver
reaparecen. Los de «En todas» se quedan.

**El Navegador de Pantallas es la excepción**: se queda a la vista aunque sea de
la sección (`sigueConPanelAbierto()` en `store.ts`), porque es con lo que se
vuelve. Cualquier OTRO widget con la acción «Mostrar pantalla…» debe ir en
«En todas», o desaparecerá al pulsarlo.

Todo esto funciona igual en el lienzo del Diseñador: pulsar una flecha del
navegador navega (además de seleccionarlo), y los widgets de la sección se
atenúan —u ocultan con «Solo esta»— mientras el panel enseña otra pantalla.

## Compatibilidad

Nada que migrar. Un Panel de Sección guardado antes se ve igual que siempre;
lo único nuevo en él es la ruta «Sección › Pantalla» de la cabecera.

El estado del historial no se persiste: es de operación, no de diseño. El
Diseñador lo cierra al montarse (`cerrarPaneles()`), así el lienzo enseña
siempre el origen.

## Ficheros

| Fichero | Qué cambió |
|---|---|
| `frontend/src/components/hmi/custom/navegacion/store.ts` | Historial por `pantalla + grupo`: `abrirEnPanel`, `volverPanel`, `avanzarPanel`, `irAlOrigenPanel`, `usePanel`, `cerrarPaneles`. `setVistaActiva` lo vacía. |
| `frontend/src/components/hmi/custom/navegacion/NavegadorPanel.tsx` | **Nuevo widget** «Navegador de Pantallas»: ◀ ▶ ⌂ con su lista de pantallas. |
| `frontend/src/components/hmi/custom/navegacion/PantallaScreen.tsx` | Enseña lo abierto por encima de la sección; ruta y flechas en la cabecera. |
| `frontend/src/components/hmi/custom/registry.ts` | Alta del widget en la paleta. |
| `frontend/src/components/hmi/acciones.ts` | Acciones `abrir-en-panel` y `volver-panel`. |
| `frontend/src/components/hmi/inspectores/accion.tsx` | Sus campos en el panel «Acción». |
| `frontend/src/components/hmi/partes.ts` | Partes Caja, Flechas y Nombre del navegador. |
| `frontend/src/pages/Preview.tsx` | Oculta los widgets de la sección mientras el panel enseña otra pantalla (salvo el navegador). |
| `frontend/src/pages/Designer.tsx` | Lo mismo, atenuando; y `cerrarPaneles()` al montar. |
