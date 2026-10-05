# El visor abre directo el runtime · 15 sep 2026

> Qué ve un puesto VISOR al entrar, cómo sigue al supervisor en vivo, y qué se
> cambió para que aguante diez visores sin despeinarse.

---

## Lo que se pidió

Un visor (el `PsiCore_Visor.exe` de cada puesto) entraba y veía el menú de
cuatro tarjetas —Configuración, Vista Principal, Temas, Alarmas— igual que la
ventana del servidor. No tiene sentido: un puesto de operación no configura ni
diseña nada. Lo que tiene que hacer es **abrir el runtime del proyecto que el
supervisor tiene en pantalla en el servidor**, y si el supervisor cambia algo
—un widget, o el proyecto entero— verlo al instante sin recargar.

## Cómo queda

```
VISOR                                   SERVIDOR
─────                                   ────────
abre el .exe  ─── GET /auth/me ──────►  "es_visor": true  (por la IP)
                                        
login  ───────────────────────────────►  sesión
  └─► navigate('/preview')              (nunca /menu)

/preview ──── GET /runtime ──────────►  { proyecto_id, nombre, pantallas[] }
  └─► abre pantallas[0]

                                        El supervisor abre otro proyecto en
                                        el Diseñador  ──► PUT /runtime
  ◄──── ws: runtime.changed ─────────   (trae las pantallas dentro)
  └─► salta a la primera pantalla
      del proyecto nuevo, sin recargar

                                        El supervisor mueve un widget
  ◄──── ws: project.updated ─────────   cambio.diff = { widgets: [el que se
  └─► lo aplica en sitio                movió], borrados: [], orden: [...] }
      (sin ningún GET)
```

### Quién es visor

Lo decide el **servidor** por la IP real del socket (`app/api/origen.py`): la
ventana del propio servidor entra por `127.0.0.1`; cualquier otro equipo es
visor. Ya se usaba para esconder la configuración de la base de datos; ahora
`GET /auth/me` también lo devuelve (`es_visor`) y el frontend lo guarda en
`AppStore.esVisor`.

No hay dos builds ni ninguna marca en la URL: el visor carga el mismo HTML que
el servidor. Por eso la decisión no puede estar en el cliente.

### Qué ve cada uno

| Quién | Al entrar | `/menu`, `/config`, `/designer`, … |
|---|---|---|
| Ventana del **servidor**, cualquier rol | `/menu` (como siempre) | como siempre |
| **Visor** con rol `Usuarios` o `Invitado` | `/preview` | rebotan a `/preview` |
| **Visor** con rol `Administradores` o `Supervisor` | `/preview` | accesibles escribiendo la ruta |

La última fila es a propósito: un supervisor con un portátil en planta tiene
que poder tomar el control o mirar la actividad sin ir al servidor. En el
`.exe` del visor no hay barra de direcciones, así que en la práctica el visor
es solo runtime.

Un visor que ya tenía sesión (WebView2 la guarda entre arranques) no vuelve a
pasar por el login: abrir el .exe es abrir el runtime. El único control que
tiene es el botón **Salir** de la barra, para cambiar de cuenta.

### El proyecto publicado

`datos/runtime.json`:

```json
{ "proyecto_id": "linea_2", "publicado_por": "hugo",
  "publicado_en": "2026-09-15T19:40:11Z" }
```

| | |
|---|---|
| `GET /runtime` | qué proyecto está en pantalla + su nombre + sus pantallas en orden |
| `PUT /runtime {proyecto_id}` | publicar otro. `Administradores` desde el servidor; desde otra IP, `Supervisor` |
| `runtime.changed` (WS) | mismo cuerpo que el GET, más `por` y `motivo` |

**Lo publica el Diseñador solo**, al abrir un proyecto en el equipo servidor
(`Designer.tsx`, efecto sobre `proyectoId`). Sin botón: "lo que el supervisor
tiene delante" es exactamente lo que se quiere publicar. Publicar el mismo
proyecto dos veces no escribe nada ni difunde nada.

Si se borra el proyecto publicado, el backend vuelve a `principal` y avisa
(`motivo: "proyecto_borrado"`): ningún visor se queda mirando un HMI que ya no
existe.

La pantalla por la que se entra sigue siendo **la primera del proyecto**, y de
ahí se navega con el menú lateral del HMI, como antes. El visor NO sigue la
pestaña que el supervisor tenga abierta en el Diseñador: el operador navega
por su cuenta.

### Cambios en vivo, sin recargar y sin pedir la pantalla

Antes, cada guardado del Diseñador (uno cada 400 ms mientras se arrastra)
hacía que **todos** los clientes conectados pidieran `GET /pantallas/<id>`
entero. Con diez visores: diez descargas de la pantalla por cada movimiento
del ratón. Ahora el evento trae lo que cambió y se aplica en sitio:

| Acción | Lo que viaja en `project.updated` |
|---|---|
| `widget_guardado` (PATCH) | `cambio.datos` — el widget |
| `widget_borrado` (DELETE) | `cambio.widget` — su id |
| `proyecto_reemplazado` (PUT) | `cambio.diff = { widgets: [los que cambiaron], borrados: [ids], orden: [ids], canvas? }` |

`frontend/src/utils/aplicarCambio.ts` lo aplica en la Vista Previa, en los
paneles empotrados (`PantallaEmbebida`) y en el Diseñador de quien mira en
solo lectura. Se aplica **solo si la versión del evento es la siguiente a la
que se tiene**; con un hueco (el socket estuvo caído) se recarga entero, que
es lo único que garantiza no quedarse a medias. Si el diff pasa de 200 KB
(un widget con una imagen grande en data-URI) el backend no lo manda y los
clientes recargan por HTTP, como antes.

Al **reconectar** el WebSocket, la vista vuelve a pedir `/runtime` y la
pantalla: mientras estuvo caído pudo cambiar cualquiera de las dos cosas y el
snapshot de reconexión solo trae valores de tags.

### Para diez visores

- **Broadcast**: el JSON se serializa **una vez** y se manda como texto
  (`send_json` hacía un `json.dumps` por cliente). Cada envío tiene un
  **timeout de 5 s**: un socket con el búfer lleno (portátil dormido, VPN
  caída sin FIN) ya no congela a los demás; se le cierra y su
  `RealPLCService` reconecta solo a los 3 s.
- `runtime.changed` trae las pantallas dentro: al cambiar de proyecto, diez
  visores no hacen diez `GET /pantallas` a la vez.
- Publicar el mismo proyecto no difunde nada.

### Un bug que salió por el camino

`RealPLCService.ts` solo reenviaba **cuatro** tipos de mensaje WS al resto de
la aplicación (`project.updated`, `project.removed`, `config.updated`,
`presence`). Todo lo demás se tiraba en silencio: `lock.changed` (el lápiz),
`tema.updated`, `proyecto.updated` / `proyecto.removed`, `alarma.*`… con
código escuchándolos en `useLock`, `TemaProvider`, `AppStore` y el widget de
alarmas que nunca llegaba a enterarse. Ahora se reenvía todo lo que traiga
`type` y no sea un dato de PLC.

## Probarlo

```powershell
python tools/probar_multiusuario.py      # sección "8b · Runtime"
```

A mano: dos equipos (o el servidor y un navegador desde otra IP).

1. En el servidor, Diseñador, crea «Línea 2» y ábrela.
2. En el visor, entra como `Usuarios`: sale el runtime de «Línea 2», sin menú.
3. En el servidor cambia al proyecto principal: el visor salta solo.
4. Mueve un widget: en el visor se mueve; en la pestaña Red del navegador no
   hay ningún `GET /pantallas/...` por cada movimiento.
5. Corta la red del visor medio minuto, mueve cosas, reconecta: se pone al día.

## Ficheros

```
app/db/runtime_store.py          NUEVO  datos/runtime.json
app/api/runtime_routes.py        NUEVO  GET/PUT /runtime + runtime.changed
app/api/project_routes.py        diff dentro de project.updated (PUT)
app/api/proyecto_routes.py       borrar el publicado -> vuelve a principal
app/api/auth_routes.py           es_visor en /auth/me
app/core/connection_manager.py   serializar una vez + timeout por cliente
app/main.py                      registra el store y el router

frontend/src/services/runtimeApi.ts        NUEVO
frontend/src/utils/aplicarCambio.ts        NUEVO
frontend/src/services/RealPLCService.ts    reenvía todos los tipos
frontend/src/context/AppStore.tsx          esVisor; aplica diffs
frontend/src/components/auth/RutaProtegida.tsx  visor -> /preview
frontend/src/pages/Login.tsx               visor -> /preview
frontend/src/pages/Designer.tsx            publica el proyecto abierto
frontend/src/pages/Preview.tsx             sigue /runtime; diffs; resync; Salir
frontend/src/components/hmi/custom/navegacion/PantallaEmbebida.tsx  diffs
tools/probar_multiusuario.py               sección 8b
```
