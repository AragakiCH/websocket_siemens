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

## Dónde están los datos

`/var/snap/psicore/common/datos/` — el equivalente a `C:\ProgramData\PsiCore\datos`
en Windows: pantallas, widgets, temas, `conexiones.json`, `.clave`,
`psicore.db` (SQLite) y los registros. Sobrevive a actualizaciones del snap.

Por SSH (`rexroot` tiene `sudo`):

```bash
sudo ls /var/snap/psicore/common/datos
sudo snap logs psicore -n 100        # el log del servicio
sudo snap restart psicore            # tras copiar ficheros a mano
```

Para traer un proyecto desde Windows: en Windows, Configuración → Carpeta
de datos → «Descargar copia»; en el ctrlX, la misma pantalla → «Restaurar»
(conserva la conexión SQLite local del ctrlX).

## Bases de datos

- `local` = SQLite en `$SNAP_COMMON/datos/psicore.db`: cuentas, recetas,
  alarmas. Suficiente para la configuración del HMI.
- Historizador: apunta a una base **externa** (MySQL/PostgreSQL en un PC o
  servidor de la red). La flash del ctrlX (2,7 GB en una X3) no es sitio
  para millones de filas.
- SQL Server no está disponible en el snap (necesita el driver ODBC del
  sistema). Si hiciera falta, es un `stage-packages` con `msodbcsql18`
  arm64; no está hecho a propósito.

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
