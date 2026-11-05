# Psi Core en ctrlX CORE (snap)

El mismo código que el instalador de Windows, empaquetado como snap de
confinamiento estricto para **Ubuntu Core 22** (ctrlX OS 2.x), en `amd64`
(ctrlX COREvirtual) y `arm64` (ctrlX CORE X3 / X5 / X7).

## Qué contiene

| Fichero | Para qué |
|---|---|
| `snap/snapcraft.yaml` | Receta del snap: copia `app/`, `frontend/dist/`, `sql/`, `docs/`, crea el venv con `requirements.snap.txt`, siembra widgets y temas. |
| `bin/snap-wrapper.sh` | Arranque: datos en `$SNAP_COMMON/datos`, SQLite local la primera vez, uvicorn en el puerto 8010. |
| `requirements.snap.txt` | `requirements.txt` sin `pyodbc/aioodbc` (SQL Server) y con `aiomysql`/`asyncpg`. |
| `package-assets/` + `meta/gui/` | Entrada «Psi Core» en el menú lateral del ctrlX (abre `http://<ctrlx>:8010/` en pestaña nueva). |
| `.github/workflows/snap.yml` | Compila el frontend y construye el snap en amd64 y arm64; deja el `.snap` como artefacto. |

## Construir

En GitHub Actions: cada push a `main`/`master` (o «Run workflow» a mano)
deja dos artefactos, `psicore-amd64` y `psicore-arm64`, con el `.snap`.

A mano, en un Ubuntu 22.04 (no en Windows):

```bash
cd frontend && npm ci && npm run build && cd ..
sudo snap install snapcraft --classic
sudo snapcraft --destructive-mode
```

## Instalar en el ctrlX

1. Settings → Apps → activar «Allow installation from file» si está apagado.
2. «Install from file» → elegir `psicore_<versión>_arm64.snap` (X3/X5/X7) o
   `_amd64.snap` (COREvirtual).
3. Por SSH es lo mismo: `sudo snap install --dangerous psicore_<versión>_arm64.snap`.

Aparece «Psi Core» en el menú lateral; abre `http://<ip-del-ctrlx>:8010/`.
La primera vez pide crear la primera cuenta (la base SQLite ya está creada).

## Dónde están los datos (y cómo sobreviven a desinstalar)

Psi Core guarda sus datos en el **almacén de Solutions del ctrlX**:

    /var/snap/rexroth-solutions/common/solutions/DefaultSolution/configurations/appdata/psicore
    (dentro del snap se ve como $SNAP_COMMON/solutions/activeConfiguration/psicore)

Esa carpeta es del ctrlX, no de la app: **desinstalar Psi Core no la borra**,
y al reinstalar (la versión que sea) la encuentra tal cual: cuentas,
pantallas, PLC, variables, `.clave` y la base SQLite `psicore.db`.

Además forma parte de la *configuración* del ctrlX, así que desde su web,
**sin SSH**: *Settings → Manage app data* → **Save** crea un archivo con
todo (y se puede **descargar**); **Load** lo vuelve a poner (o lo carga en
otro ctrlX). `copyOnLoad` está activado en `package-manifest.json`, así que
el propio ctrlX copia la carpeta en el guardado y en la carga. Tras un
**Load**, reinicia la app (*Apps → Psi Core → Restart*, o `sudo snap restart
psicore`) para que lea la copia nueva.

Para que esto funcione, la interfaz `active-solution` tiene que estar
conectada. Normalmente lo está al instalar; se comprueba por SSH con
`snap connections psicore`, y si sale desconectada:

    sudo snap connect psicore:active-solution rexroth-solutions:active-solution
    sudo snap restart psicore

Mientras no lo esté, el arranque lo avisa en `snap logs psicore` y usa
`/var/snap/psicore/common/datos` como antes (que sí se pierde al
desinstalar). En cuanto se conecta, el siguiente arranque **migra** solo lo
que hubiera allí al almacén y renombra la carpeta vieja a
`datos_migrado_a_solutions` (se puede borrar).

Lo que no es configuración (`traza_rendimiento.log`, `auditoria.jsonl`…)
vive en la misma carpeta pero no entra en las copias.

Dentro de la app: *Configuración → Carpeta de datos* dice la ruta en uso,
baja una copia `.zip` de la configuración y la restaura. Es la vía para
llevarse la configuración de un PC Windows al ctrlX y viceversa.

## Bases de datos

La conexión «local» es **SQLite** (`psicore.db` en la carpeta de datos): sin
servidor ni driver. Es donde viven cuentas, alarmas y recetas por defecto.

Para bases **externas** desde el PLC van dentro del snap:

| Motor | Cómo | Notas |
|---|---|---|
| SQL Server | aioodbc/pyodbc + **ODBC Driver 18 for SQL Server** de Microsoft (`msodbcsql18`, stage-package) | El workflow añade el repositorio de Microsoft al runner antes de `snapcraft`. `bin/snap-wrapper.sh` escribe `odbcinst.ini` en `$SNAP_COMMON/odbc` con la ruta real del driver y pone `ODBCSYSINI`. Hay también un segundo driver, «FreeTDS SQL Server», por si el de Microsoft fallara con alguna versión. |
| MySQL / MariaDB | aiomysql | Python puro. |
| PostgreSQL | asyncpg | Rueda binaria para aarch64. |

Ojo con las conexiones **importadas** de un PC Windows: `localhost` en el
ctrlX es el propio ctrlX. Cambia el servidor a la **IP del PC** donde corre
SQL Server (y que ese SQL Server acepte TCP en el 1433 desde la red, como
se configuró para los visores). Con el driver 18, `TrustServerCertificate=yes`
en opciones si el servidor no tiene certificado válido.

En `snap logs psicore` se ve al arrancar qué drivers ODBC quedaron
registrados («ODBC: Microsoft ODBC Driver 18 for SQL Server (...)»).

## Primera cuenta y «equipo servidor»

Psi Core solo deja crear la primera cuenta, configurar la base o restaurar
datos desde el **equipo servidor**, que en un PC es la ventana que entra por
`127.0.0.1`. El ctrlX no tiene pantalla, así que el snap arranca con
`PLC_REDES_SERVIDOR=auto`: los PCs de la misma LAN que el ctrlX cuentan como
servidor. Si se quiere acotar a una red concreta, se cambia por una lista
(`192.168.17.0/24,10.0.0.5`) en `bin/snap-wrapper.sh` o en el `environment`
de `snap/snapcraft.yaml` y se reconstruye.

## Puertos

8010 (HTTP + WebSocket). El 8000 lo usa `api-sysid` si está instalado en el
mismo ctrlX. Para cambiarlo: `PLC_API_PORT` en `snapcraft.yaml` y el enlace
en `package-assets/package-manifest.json` y `open.html`.
