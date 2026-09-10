# -*- coding: utf-8 -*-
"""
project_store.py
================
Persistencia del DISEÑO del HMI (widgets + lienzo), versionado y compartido.

**Por qué existe.** Hasta ahora el diseño vivía en `localStorage['hmi.design']`
de cada navegador. `localStorage` es privado del navegador por definición: no
hay API que lo haga viajar. Mientras el diseño estuviera ahí, el usuario 2
jamás podría ver los widgets del usuario 1, por muy bueno que fuera el
WebSocket. Este módulo mueve esa fuente de verdad al servidor.

**OJO CON EL NOMBRE: aquí "proyecto" significa PANTALLA.** Este módulo se
escribió cuando solo había un nivel, y a cada pantalla se la llamó proyecto.
Al aparecer un nivel de verdad por encima (`app/db/proyecto_store.py`) se
decidió no renombrar esto: `project_id` está escrito en el lock
(`designer:<project_id>`), en el evento `project.updated` del WebSocket, en la
caché de cada navegador y en los ficheros ya guardados de la instalación. La
frontera se puso en la API, que es lo que se lee de verdad:

    /pantallas   -> lo que gestiona ESTE módulo (antes `/proyectos`)
    /proyectos   -> el nivel de arriba, en `proyecto_store.py`

Cada pantalla guarda a qué proyecto pertenece en su campo `proyecto`. Una
pantalla sin ese campo es de antes de que existieran los proyectos y se
adopta al por defecto al cargar.

**Un fichero por pantalla desde el principio.** Se guarda en
`datos/proyectos/<id>.json`, un fichero por proyecto, no un `proyecto.json`
único. Cambiar esto más adelante obligaría a migrar el store, las rutas, el
frontend y los datos ya guardados; hacerlo ahora es gratis. Al arrancar se crea
un proyecto `principal` para que el comportamiento sea idéntico al de un HMI
único mientras no se use más de uno.

**Control de versiones (optimistic locking).** Cada proyecto lleva un entero
`version` que sube en cada mutación. Quien escribe manda la versión sobre la
que editó; si el servidor va por una más alta, la escritura se rechaza en vez
de pisar el trabajo del otro. Es lo que evita el clásico "guardé y se borró lo
que había hecho mi compañero".

Formato en disco:

```json
{
  "project_id": "principal",
  "nombre": "HMI Principal",
  "version": 42,
  "actualizado_en": "2026-08-25T14:03:11Z",
  "actualizado_por": "jmendoza",
  "canvas": { "width": 1920, "height": 1080 },
  "widgets": [ { "id": "w_1", ... }, ... ]
}
```
"""
from __future__ import annotations

import asyncio
import json
import logging
import re
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

from app.db.proyecto_store import PROYECTO_POR_DEFECTO as PROYECTO_HMI_POR_DEFECTO
from app.db.store import carpeta_datos

logger = logging.getLogger("project_store")

# Id de proyecto: mismo criterio de lista blanca que los nombres de tabla.
# Es parte de un NOMBRE DE FICHERO, así que un id con '../' o '/' permitiría
# escribir fuera de la carpeta. Por eso se valida, no se sanea.
_RE_ID = re.compile(r"^[A-Za-z0-9_-]{1,64}$")

#: Pantalla que el backend garantiza que existe dentro del proyecto por
#: defecto. Es el destino al que se salta cuando cualquier otra desaparece.
PANTALLA_POR_DEFECTO = "principal"

#: Alias histórico. Aquí "proyecto" quería decir "pantalla"; se conserva para
#: no romper importaciones antiguas, pero el nombre bueno es el de arriba.
PROYECTO_POR_DEFECTO = PANTALLA_POR_DEFECTO


def _ahora_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def validar_id(project_id: str) -> str:
    """Valida el id de proyecto. Lanza ValueError si no es seguro."""
    pid = (project_id or "").strip()
    if not _RE_ID.match(pid):
        raise ValueError(
            f"Id de proyecto inválido: '{project_id}'. Solo letras, dígitos, "
            f"guion y guion bajo (máx. 64 caracteres)."
        )
    return pid


def _orden_pantalla(doc: dict) -> tuple:
    """
    Orden de las pestanas del Disenador.

    Tres criterios, en este orden:

      1. `principal` SIEMPRE primero. Es la pantalla que el backend garantiza
         que existe y la que se abre cuando cualquier otra desaparece, asi que
         moverla de sitio segun su nombre alfabetico solo despista.
      2. Despues, por fecha de creacion: las nuevas se anaden a la DERECHA,
         que es como se comporta cualquier barra de pestanas.
      3. El id como desempate, para que el orden sea estable si dos pantallas
         se crearon en el mismo milisegundo.

    Antes esto ordenaba solo por `project_id`, de modo que crear "alarmas"
    la colocaba delante de "principal".
    """
    pid = doc.get("project_id", "")
    return (0 if pid == PANTALLA_POR_DEFECTO else 1,
            doc.get("creado_en", ""),
            pid)


class ConflictoDeVersion(Exception):
    """
    La versión sobre la que se editó ya no es la actual.

    Lleva la versión del servidor para que el cliente pueda recargar y decidir
    qué hacer, en vez de solo saber que falló.
    """

    def __init__(self, esperada: int, actual: int) -> None:
        super().__init__(
            f"Conflicto de versión: editaste sobre la v{esperada} pero el "
            f"proyecto va por la v{actual}. Otro usuario guardó antes."
        )
        self.esperada = esperada
        self.actual = actual


class ProjectStore:
    """Lee y escribe los proyectos del HMI en `datos/proyectos/`."""

    def __init__(self, carpeta: Optional[str] = None) -> None:
        self.carpeta = carpeta_datos(carpeta) / "proyectos"
        self.carpeta.mkdir(parents=True, exist_ok=True)

        # Caché en memoria: project_id -> documento. Evita leer el disco en
        # cada GET, que con diez clientes y polling sería constante.
        self._cache: Dict[str, dict] = {}
        self._lock_hilos = threading.Lock()
        self._lock_async = asyncio.Lock()

        self.cargar()

    # ------------------------------------------------------------------ #
    # Carga
    # ------------------------------------------------------------------ #
    def cargar(self) -> None:
        """
        Lee todos los proyectos de la carpeta. Un fichero corrupto se ignora
        con un aviso: no debe impedir abrir los demás proyectos.
        """
        self._cache = {}
        # Pantallas que había que completar al vuelo (les faltaba `proyecto`
        # porque son de antes de que existieran). Se reescriben al final:
        # dejarlo solo en memoria funcionaría, pero el fichero seguiría sin
        # decir a qué proyecto pertenece, y eso es justo lo que mira alguien
        # que abre `datos/proyectos/` para entender qué hay ahí.
        migradas: List[str] = []
        for ruta in sorted(self.carpeta.glob("*.json")):
            if ruta.name.endswith(".tmp"):
                continue
            try:
                doc = json.loads(ruta.read_text("utf-8"))
                pid = doc.get("project_id") or ruta.stem
                sin_proyecto = not doc.get("proyecto")
                self._cache[pid] = self._normalizar(doc, pid)
                if sin_proyecto:
                    migradas.append(pid)
            except Exception as exc:  # noqa: BLE001
                logger.error("Pantalla '%s' ilegible (%s); se ignora.",
                             ruta.name, exc)

        if not self._cache:
            # Primera ejecución: se crea el proyecto por defecto para que la
            # vista tenga siempre algo que abrir.
            self._cache[PANTALLA_POR_DEFECTO] = self._nuevo(
                PANTALLA_POR_DEFECTO, "HMI Principal"
            )
            self._escribir(PANTALLA_POR_DEFECTO)
            logger.info("Creada la pantalla por defecto '%s'.",
                        PANTALLA_POR_DEFECTO)

        for pid in migradas:
            try:
                self._escribir(pid)
            except OSError as exc:
                # No es crítico: en memoria ya está adoptada y se volverá a
                # intentar en el siguiente arranque.
                logger.warning("No se pudo migrar '%s' al proyecto por "
                               "defecto en disco: %s", pid, exc)
        if migradas:
            logger.info("%d pantalla(s) adoptadas por el proyecto '%s'.",
                        len(migradas), PROYECTO_HMI_POR_DEFECTO)

        logger.info("ProjectStore cargado: %d pantalla(s).", len(self._cache))

    @staticmethod
    def _nuevo(project_id: str, nombre: str = "",
               proyecto: str = PROYECTO_HMI_POR_DEFECTO) -> dict:
        return {
            "project_id": project_id,
            "nombre": nombre or project_id,
            # A qué proyecto pertenece esta pantalla. Ver la nota de nombres
            # de la cabecera: `project_id` es la PANTALLA, `proyecto` es la
            # carpeta que la contiene.
            "proyecto": proyecto or PROYECTO_HMI_POR_DEFECTO,
            "version": 1,
            # Momento de creacion. Es lo unico que permite ordenar las
            # pantallas como se crearon: `actualizado_en` cambia en cada
            # guardado, asi que ordenar por el barajaria las pestanas cada vez
            # que alguien mueve un widget.
            "creado_en": _ahora_iso(),
            "actualizado_en": _ahora_iso(),
            "actualizado_por": "",
            "canvas": {},
            "widgets": [],
        }

    @staticmethod
    def _normalizar(doc: dict, pid: str) -> dict:
        """Rellena los campos que falten en un fichero escrito a mano."""
        doc.setdefault("project_id", pid)
        doc.setdefault("nombre", pid)
        # Una pantalla sin `proyecto` es de antes de que existieran: la adopta
        # el proyecto por defecto, que es exactamente donde estaba.
        if not doc.get("proyecto"):
            doc["proyecto"] = PROYECTO_HMI_POR_DEFECTO
        doc.setdefault("version", 1)
        # Los proyectos creados antes de que existiera este campo se quedan
        # con "" a proposito: ordena antes que cualquier fecha, asi que las
        # pantallas de siempre siguen apareciendo antes que las nuevas.
        doc.setdefault("creado_en", "")
        doc.setdefault("actualizado_en", _ahora_iso())
        doc.setdefault("actualizado_por", "")
        doc.setdefault("canvas", {})
        widgets = doc.get("widgets")
        doc["widgets"] = widgets if isinstance(widgets, list) else []
        return doc

    # ------------------------------------------------------------------ #
    # Escritura
    # ------------------------------------------------------------------ #
    def _escribir(self, project_id: str) -> None:
        """Escritura atómica de UN proyecto. Asume lock tomado."""
        doc = self._cache[project_id]
        ruta = self.carpeta / f"{project_id}.json"
        tmp = ruta.with_suffix(".json.tmp")
        tmp.write_text(
            json.dumps(doc, indent=2, ensure_ascii=False), encoding="utf-8"
        )
        tmp.replace(ruta)

    async def _escribir_async(self, project_id: str) -> None:
        """Escribe fuera del bucle de eventos: no congela los WebSockets."""
        bucle = asyncio.get_running_loop()
        await bucle.run_in_executor(None, self._escribir_sync, project_id)

    def _escribir_sync(self, project_id: str) -> None:
        with self._lock_hilos:
            self._escribir(project_id)

    # ------------------------------------------------------------------ #
    # Lectura
    # ------------------------------------------------------------------ #
    def listar(self, proyecto: Optional[str] = None) -> List[dict]:
        """
        Resumen de las pantallas (sin los widgets, que pesan).

        Con `proyecto` se devuelven solo las de ese proyecto, que es lo que
        pide la barra de pestañas del Diseñador: enseñar las de otro sería
        justo lo que se quiso separar. Sin él salen todas, que es lo que
        necesitan la Vista Previa y el borrado en cascada.
        """
        return [
            {
                "project_id": d["project_id"],
                "nombre": d["nombre"],
                "proyecto": d.get("proyecto", PROYECTO_HMI_POR_DEFECTO),
                "version": d["version"],
                "creado_en": d.get("creado_en", ""),
                "actualizado_en": d["actualizado_en"],
                "actualizado_por": d["actualizado_por"],
                "num_widgets": len(d["widgets"]),
            }
            for d in sorted(self._cache.values(), key=_orden_pantalla)
            if proyecto is None
            or d.get("proyecto", PROYECTO_HMI_POR_DEFECTO) == proyecto
        ]

    def pantallas_de(self, proyecto: str) -> List[str]:
        """Ids de las pantallas de un proyecto. Para el borrado en cascada."""
        return [
            d["project_id"]
            for d in sorted(self._cache.values(), key=_orden_pantalla)
            if d.get("proyecto", PROYECTO_HMI_POR_DEFECTO) == proyecto
        ]

    def contar_por_proyecto(self) -> Dict[str, int]:
        """Cuántas pantallas tiene cada proyecto, para el selector."""
        cuenta: Dict[str, int] = {}
        for d in self._cache.values():
            pid = d.get("proyecto", PROYECTO_HMI_POR_DEFECTO)
            cuenta[pid] = cuenta.get(pid, 0) + 1
        return cuenta

    def obtener(self, project_id: str) -> Optional[dict]:
        """Documento completo de un proyecto, o None si no existe."""
        return self._cache.get(validar_id(project_id))

    def existe(self, project_id: str) -> bool:
        return validar_id(project_id) in self._cache

    # ------------------------------------------------------------------ #
    # Mutaciones
    # ------------------------------------------------------------------ #
    def _verificar_version(self, doc: dict, version: Optional[int]) -> None:
        """
        Optimistic locking. `version=None` fuerza la escritura (sobrescribe).

        Se permite forzar a propósito: el frontend lo usa tras recibir un 409 y
        que el usuario decida quedarse con su versión.
        """
        if version is None:
            return
        if int(version) != int(doc["version"]):
            raise ConflictoDeVersion(int(version), int(doc["version"]))

    async def crear(self, project_id: str, nombre: str = "",
                    usuario: str = "",
                    proyecto: str = PROYECTO_HMI_POR_DEFECTO) -> dict:
        """
        Crea una pantalla vacía dentro de un proyecto. Falla si el id existe.

        Los ids de pantalla son ÚNICOS EN TODA LA INSTALACIÓN, no por
        proyecto, porque cada uno es el nombre de un fichero en la misma
        carpeta. Quien crea desde la vista antepone el id del proyecto para
        que dos "Pantalla 1" de proyectos distintos no choquen; el nombre
        visible sí puede repetirse, y de hecho se repite: cada proyecto
        empieza a contar por 1.
        """
        pid = validar_id(project_id)
        async with self._lock_async:
            if pid in self._cache:
                raise ValueError(f"La pantalla '{pid}' ya existe.")
            doc = self._nuevo(pid, nombre, proyecto)
            doc["actualizado_por"] = usuario
            self._cache[pid] = doc
            await self._escribir_async(pid)
        logger.info("Pantalla '%s' creada en '%s' por '%s'.", pid,
                    doc["proyecto"], usuario or "-")
        return doc

    async def renombrar(self, project_id: str, nombre: str,
                        usuario: str = "") -> dict:
        """
        Cambia la etiqueta visible de una pantalla. NO toca el `project_id`.

        El id es el nombre del fichero en disco y la clave del lock de edicion,
        asi que cambiarlo obligaria a mover ficheros y dejaria sin lapiz a
        quien estuviera editando. El nombre visible, en cambio, es solo una
        etiqueta: se puede cambiar en caliente sin que nadie pierda nada.
        """
        pid = validar_id(project_id)
        nombre = (nombre or "").strip()
        if not nombre:
            raise ValueError("El nombre de la pantalla no puede estar vacio.")
        if len(nombre) > 80:
            raise ValueError("El nombre no puede pasar de 80 caracteres.")
        async with self._lock_async:
            doc = self._cache.get(pid)
            if doc is None:
                raise KeyError(pid)
            doc["nombre"] = nombre
            self._sellar(doc, usuario)
            await self._escribir_async(pid)
            return doc

    async def guardar_todo(self, project_id: str, widgets: List[dict],
                           canvas: Optional[dict] = None,
                           version: Optional[int] = None,
                           usuario: str = "") -> dict:
        """Reemplaza widgets y lienzo completos (el PUT)."""
        pid = validar_id(project_id)
        async with self._lock_async:
            doc = self._cache.get(pid)
            if doc is None:
                raise KeyError(pid)
            self._verificar_version(doc, version)

            doc["widgets"] = list(widgets or [])
            if canvas is not None:
                doc["canvas"] = canvas
            self._sellar(doc, usuario)
            await self._escribir_async(pid)
            return doc

    async def guardar_widget(self, project_id: str, widget: dict,
                             version: Optional[int] = None,
                             usuario: str = "") -> dict:
        """
        Inserta o actualiza UN widget (el PATCH).

        Es el camino rápido del arrastre: mover un widget no debe reenviar el
        documento entero, que con cincuenta widgets serían decenas de KB por
        cada evento de ratón.
        """
        pid = validar_id(project_id)
        wid = str(widget.get("id") or "").strip()
        if not wid:
            raise ValueError("El widget no trae 'id'.")

        async with self._lock_async:
            doc = self._cache.get(pid)
            if doc is None:
                raise KeyError(pid)
            self._verificar_version(doc, version)

            for i, w in enumerate(doc["widgets"]):
                if str(w.get("id")) == wid:
                    doc["widgets"][i] = widget
                    break
            else:
                doc["widgets"].append(widget)

            self._sellar(doc, usuario)
            await self._escribir_async(pid)
            return doc

    async def borrar_widget(self, project_id: str, widget_id: str,
                            version: Optional[int] = None,
                            usuario: str = "") -> dict:
        """Quita un widget del proyecto."""
        pid = validar_id(project_id)
        async with self._lock_async:
            doc = self._cache.get(pid)
            if doc is None:
                raise KeyError(pid)
            self._verificar_version(doc, version)

            antes = len(doc["widgets"])
            doc["widgets"] = [
                w for w in doc["widgets"] if str(w.get("id")) != str(widget_id)
            ]
            if len(doc["widgets"]) == antes:
                raise KeyError(f"widget:{widget_id}")

            self._sellar(doc, usuario)
            await self._escribir_async(pid)
            return doc

    async def borrar(self, project_id: str, en_cascada: bool = False) -> bool:
        """
        Elimina una pantalla entera.

        Dos cosas no se dejan borrar, y por el mismo motivo —que la vista
        siempre tenga adónde ir—, pero a distinto nivel:

          * la pantalla `principal`, que es el destino de rescate global;
          * la ÚLTIMA pantalla de un proyecto. Un proyecto sin pantallas es
            una pestaña vacía en la que no se puede ni soltar un widget; si
            lo que se quiere es deshacerse de él, se borra el proyecto.

        `en_cascada=True` se salta las dos comprobaciones. Lo usa el borrado
        de un proyecto entero, donde quedarse sin pantallas es justo el
        objetivo y el propio proyecto desaparece detrás.
        """
        pid = validar_id(project_id)
        if not en_cascada:
            if pid == PANTALLA_POR_DEFECTO:
                raise ValueError(
                    f"La pantalla '{PANTALLA_POR_DEFECTO}' no se puede borrar. "
                    f"Puedes vaciarla, pero debe existir siempre una."
                )
            doc = self._cache.get(pid)
            if doc is not None:
                hermanas = self.pantallas_de(
                    doc.get("proyecto", PROYECTO_HMI_POR_DEFECTO)
                )
                if len(hermanas) <= 1:
                    raise ValueError(
                        "No se puede borrar la única pantalla de un proyecto. "
                        "Vacíala, o borra el proyecto entero."
                    )

        async with self._lock_async:
            if pid not in self._cache:
                return False
            self._cache.pop(pid)
            try:
                (self.carpeta / f"{pid}.json").unlink(missing_ok=True)
            except OSError as exc:
                logger.error("No se pudo borrar el fichero de '%s': %s", pid, exc)
        logger.info("Pantalla '%s' eliminada.", pid)
        return True

    async def borrar_pantallas_de(self, proyecto: str) -> List[str]:
        """
        Borra TODAS las pantallas de un proyecto. Devuelve las que quitó.

        Va aquí y no en la ruta porque el bucle tiene que ver el mismo caché
        que el resto de mutaciones. La ruta se encarga del orden: primero
        esto, después el proyecto.
        """
        borradas: List[str] = []
        for pid in self.pantallas_de(proyecto):
            if await self.borrar(pid, en_cascada=True):
                borradas.append(pid)
        return borradas

    async def adoptar_huerfanas(self, proyectos_validos: List[str]) -> List[str]:
        """
        Manda al proyecto por defecto las pantallas cuyo proyecto ya no existe.

        Pasa si alguien borra `proyectos_hmi.json` a mano, o restaura una
        copia de `datos/proyectos/` de otra instalación. Sin esto, esas
        pantallas quedarían invisibles: no salen en la lista de ningún
        proyecto, pero siguen ocupando su id y su fichero.
        """
        validos = set(proyectos_validos)
        adoptadas: List[str] = []
        for doc in list(self._cache.values()):
            if doc.get("proyecto", PROYECTO_HMI_POR_DEFECTO) not in validos:
                doc["proyecto"] = PROYECTO_HMI_POR_DEFECTO
                adoptadas.append(doc["project_id"])
                await self._escribir_async(doc["project_id"])
        if adoptadas:
            logger.warning(
                "%d pantalla(s) apuntaban a un proyecto inexistente; ahora son "
                "de '%s': %s", len(adoptadas), PROYECTO_HMI_POR_DEFECTO,
                ", ".join(adoptadas),
            )
        return adoptadas

    @staticmethod
    def _sellar(doc: dict, usuario: str) -> None:
        """Sube la versión y anota quién y cuándo. Asume lock tomado."""
        doc["version"] = int(doc["version"]) + 1
        doc["actualizado_en"] = _ahora_iso()
        doc["actualizado_por"] = usuario or ""
