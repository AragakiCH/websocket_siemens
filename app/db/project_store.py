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

**Varios proyectos desde el principio.** Se guarda en
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

from app.db.store import carpeta_datos

logger = logging.getLogger("project_store")

# Id de proyecto: mismo criterio de lista blanca que los nombres de tabla.
# Es parte de un NOMBRE DE FICHERO, así que un id con '../' o '/' permitiría
# escribir fuera de la carpeta. Por eso se valida, no se sanea.
_RE_ID = re.compile(r"^[A-Za-z0-9_-]{1,64}$")

PROYECTO_POR_DEFECTO = "principal"


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
        for ruta in sorted(self.carpeta.glob("*.json")):
            if ruta.name.endswith(".tmp"):
                continue
            try:
                doc = json.loads(ruta.read_text("utf-8"))
                pid = doc.get("project_id") or ruta.stem
                self._cache[pid] = self._normalizar(doc, pid)
            except Exception as exc:  # noqa: BLE001
                logger.error("Proyecto '%s' ilegible (%s); se ignora.",
                             ruta.name, exc)

        if not self._cache:
            # Primera ejecución: se crea el proyecto por defecto para que la
            # vista tenga siempre algo que abrir.
            self._cache[PROYECTO_POR_DEFECTO] = self._nuevo(
                PROYECTO_POR_DEFECTO, "HMI Principal"
            )
            self._escribir(PROYECTO_POR_DEFECTO)
            logger.info("Creado el proyecto por defecto '%s'.",
                        PROYECTO_POR_DEFECTO)

        logger.info("ProjectStore cargado: %d proyecto(s).", len(self._cache))

    @staticmethod
    def _nuevo(project_id: str, nombre: str = "") -> dict:
        return {
            "project_id": project_id,
            "nombre": nombre or project_id,
            "version": 1,
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
        doc.setdefault("version", 1)
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
    def listar(self) -> List[dict]:
        """Resumen de todos los proyectos (sin los widgets, que pesan)."""
        return [
            {
                "project_id": d["project_id"],
                "nombre": d["nombre"],
                "version": d["version"],
                "actualizado_en": d["actualizado_en"],
                "actualizado_por": d["actualizado_por"],
                "num_widgets": len(d["widgets"]),
            }
            for d in sorted(self._cache.values(), key=lambda x: x["project_id"])
        ]

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
                    usuario: str = "") -> dict:
        """Crea un proyecto vacío. Falla si el id ya existe."""
        pid = validar_id(project_id)
        async with self._lock_async:
            if pid in self._cache:
                raise ValueError(f"El proyecto '{pid}' ya existe.")
            doc = self._nuevo(pid, nombre)
            doc["actualizado_por"] = usuario
            self._cache[pid] = doc
            await self._escribir_async(pid)
        logger.info("Proyecto '%s' creado por '%s'.", pid, usuario or "-")
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

    async def borrar(self, project_id: str) -> bool:
        """
        Elimina un proyecto entero. El proyecto por defecto no se borra: la
        vista siempre necesita al menos uno que abrir.
        """
        pid = validar_id(project_id)
        if pid == PROYECTO_POR_DEFECTO:
            raise ValueError(
                f"El proyecto '{PROYECTO_POR_DEFECTO}' no se puede borrar. "
                f"Puedes vaciarlo, pero debe existir siempre uno."
            )
        async with self._lock_async:
            if pid not in self._cache:
                return False
            self._cache.pop(pid)
            try:
                (self.carpeta / f"{pid}.json").unlink(missing_ok=True)
            except OSError as exc:
                logger.error("No se pudo borrar el fichero de '%s': %s", pid, exc)
        logger.info("Proyecto '%s' eliminado.", pid)
        return True

    @staticmethod
    def _sellar(doc: dict, usuario: str) -> None:
        """Sube la versión y anota quién y cuándo. Asume lock tomado."""
        doc["version"] = int(doc["version"]) + 1
        doc["actualizado_en"] = _ahora_iso()
        doc["actualizado_por"] = usuario or ""
