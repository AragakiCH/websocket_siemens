# Rendimiento del runtime con muchos widgets · 15 oct 2026

## El síntoma

Al abrir una sección por primera vez la pantalla se quedaba en blanco un
buen rato y los clics no respondían; al rato, o al volver, salía al
instante. Con los PLC «Sin señal» (sin lecturas llegando), así que el coste
no era de datos: era de **montaje**.

## Las causas, por orden de peso

1. **Cada widget ZIP es un `<iframe>`** (documento + CSS + JS + nuestro
   puente). Treinta en una pantalla se construían de golpe en el hilo
   principal: nada se pinta hasta que terminan todos.
2. **Las Tarjetas de Acceso montaban pantallas completas** —con sus ZIP,
   tendencias (que piden histórico) y listas de alarmas— solo para enseñar
   una miniatura. Nueve tarjetas = nueve pantallas a la vez al abrir la
   vista general.
3. **Cambiar de sección desmontaba la pantalla empotrada** (`key`) y volver
   la reconstruía entera, iframes incluidos.
4. **Cada lectura del PLC fabricaba objetos nuevos para todas las
   variables** (`toPlcVariables`), y los widgets buscaban las suyas con
   `find` sobre la lista entera: todo se redibujaba aunque nada suyo
   hubiera cambiado.
5. La primera vez, además, había que **pedir cada pantalla al servidor** y
   descargar el chunk de símbolos (~450 KB).

## Lo que se hizo (`frontend/src/components/hmi/rendimiento.ts` y alrededor)

| Causa | Medida |
|---|---|
| 1 | **Cola de montaje** (`usarTurno`): los iframes ZIP se montan de dos en dos en los ratos libres del navegador. Lo ligero de la pantalla aparece ya; los ZIP van llegando sin bloquear. |
| 2 | **Miniaturas ligeras** (`ContextoMiniatura`): dentro de una Tarjeta de Acceso, los ZIP, tendencias, alarmas y recetas se dibujan como una caja con su nombre. Y las tarjetas también se montan por turnos. |
| 3 | **Pantallas vivas en el Panel de Sección**: las últimas 4 visitadas siguen montadas (ocultas con `display:none`). Volver es instantáneo y los iframes conservan su estado. |
| 4 | **Identidad estable** en `toPlcVariables` (misma variable → mismo objeto si no cambió), **índice** id→variable (`indiceDe`) en lugar de `find`, y **`React.memo` en `WidgetRenderer`** con un comparador que mira solo el diseño, la variable principal y las variables que ese widget usa (enlaces, tag de la acción, entradas de funciones). Un widget cuya variable no cambió no se redibuja. |
| 5 | **Precalentado**: al pintar su pantalla, la Vista Previa pide en segundo plano las pantallas referenciadas y luego el resto del proyecto, y carga el módulo de símbolos (`precargarPantallas`, `precargarModulos`). |

## Qué esperar

- Al entrar a una sección: el marco y los widgets nativos salen de
  inmediato; los ZIP aparecen en cascada durante unas décimas de segundo
  en lugar de todo a la vez tras un parón.
- La vista general con tarjetas: las tarjetas van llenándose una tras
  otra; sus miniaturas no llevan ZIP ni gráficas de verdad.
- Ir y volver entre secciones recientes: inmediato.
- Con lecturas llegando: solo se redibujan los widgets afectados.

## Ficheros

| Fichero | Qué cambió |
|---|---|
| `components/hmi/rendimiento.ts` | Cola de montaje, contexto de miniatura, índice de variables. |
| `services/plcAdapter.ts` | `toPlcVariables` con identidad estable. |
| `components/hmi/WidgetRenderer.tsx` | `React.memo` con comparador por dependencias; marcadores en miniatura. |
| `components/hmi/HtmlWidgetRenderer.tsx` | El iframe espera turno; en miniatura no se monta. |
| `components/hmi/custom/navegacion/AccesoSeccion.tsx` | Miniatura por turnos y en `ContextoMiniatura`. |
| `components/hmi/custom/navegacion/PantallaScreen.tsx` | Pantallas visitadas se quedan montadas. |
| `components/hmi/custom/navegacion/PantallaEmbebida.tsx` | Precarga, resolutor memoizado e indexado. |
| `components/hmi/custom/navegacion/referencias.ts` | Qué pantallas referencia una pantalla. |
| `pages/Preview.tsx` | Dispara la precarga; resolutor indexado. |
