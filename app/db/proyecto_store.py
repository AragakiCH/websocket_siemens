# -*- coding: utf-8 -*-
"""
proyecto_store.py
=================
Los PROYECTOS del HMI: el nivel que agrupa pantallas.

**El lío de nombres, dicho de frente.** Cuando se escribió `project_store.py`
solo existía un nivel, y a cada PANTALLA se la llamó "proyecto" (de ahí
`datos/proyectos/<id>.json`, `project_id`, `designer:<project_id>` y el evento
`project.updated`). Al aparecer un nivel de verdad por encima, renombrar todo
aquello habría tocado el lock, el WebSocket, la caché del navegador y los
ficheros ya guardados de la instalación. Así que se dejó como estaba y la
frontera se puso en la API, que es donde se lee:

    /pantallas          -> una pantalla (lo que antes era `/proyectos`)
    /proyectos          -> un PROYECTO: la carpeta que agrupa pantallas

Dentro del código Python, `project_id` sigue significando "id de pantalla" y
`proyecto` / `proyecto_id` significa siempre el nivel nuevo. Este módulo es el
del nivel nuevo.

**Qué es un proyecto.** Poco más que un nombre: un HMI distinto, con sus
pantallas y su numeración propia. La relación se guarda del lado de la
pantalla (`"proyecto": "<id>"` en su JSON) y no como una lista aquí dentro,
porque así solo hay un sitio donde puede quedar desincronizada: si un fichero
de pantalla se borra a mano, desaparece de su proyecto y ya está, sin listas
que apunten a nada.

**Un solo fichero, no una carpeta.** Al contrario que las pantallas, un
proyecto son cuatro campos. Un `datos/proyectos_hmi.json` con todos dentro se
escribe de una vez, de forma atómica, y se lee entero al arrancar. Una carpeta
con un fichero de doscientos bytes por proyecto no compraría nada.

Formato en disco:

```json
{
  "proyectos": [
    {
      "proyecto_id": "principal",
      "nombre": "Proyecto principal",
      "creado_en": "2026-09-10T14:03:11Z",
      "actualizado_en": "2026-09-10T14:03:11Z",
      "actualizado_por": "jmendoza"
    }
  ]
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
from typing import Dict, List, Optional

from app.db.store import carpeta_datos

logger = logging.getLogger("proyecto_store")

# Mismo criterio que el id de pantalla. Aquí no es el nombre de un fichero,
# pero sí viaja en la URL y se guarda en el JSON de cada pantalla, así que
# mantener una sola regla evita sorpresas al mover cosas de sitio.
_RE_ID = re.compile(r"^[A-Za-z0-9_-]{1,64}$")

#: Proyecto que el backend garantiza que existe. No se puede borrar: cuando
#: cualquier otro desaparece, el Diseñador tiene que tener adónde ir.
PROYECTO_POR_DEFECTO = "principal"

#: Etiqueta del proyecto por defecto la primera vez que se crea.
NOMBRE_POR_DEFECTO = "Proyecto principal"


def _ahora_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def validar_proyecto_id(proyecto_id: str) -> str:
    """Valida el id de un proyecto. Lanza ValueError si no sirve."""
    pid = (proyecto_id or "").strip()
    if not _RE_ID.match(pid):
        raise ValueError(
            f"Id de proyecto inválido: '{proyecto_id}'. Solo letras, dígitos, "
            f"guion y guion bajo (máx. 64 caracteres)."
        )
    return pid


def _orden(doc: dict) -> tuple:
    """
    Orden del selector de proyectos.

    El por defecto primero —es el que se abre cuando cualquier otro
    desaparece, y verlo saltar de sitio según su nombre despista— y el resto
    por fecha de creación, que es como se espera que crezca una lista a la que
    vas añadiendo cosas.
    """
    pid = doc.get("proyecto_id", "")
    return (0 if pid == PROYECTO_POR_DEFECTO else 1,
            doc.get("creado_en", ""),
            pid)


class ProyectoStore:
    """Lee y escribe `datos/proyectos_hmi.json`."""

    def __init__(self, carpeta: Optional[str] = None) -> None:
        self.ruta = carpeta_datos(carpeta) / "proyectos_hmi.json"
        self.ruta.parent.mkdir(parents=True, exist_ok=True)

        self._cache: Dict[str, dict] = {}
        self._lock_hilos = threading.Lock()
        self._lock_async = asyncio.Lock()

        self.cargar()

    # ------------------------------------------------------------------ #
    # Carga
    # ------------------------------------------------------------------ #
    def cargar(self) -> None:
        """
        Lee el fichero. Si no existe o está corrupto se arranca con el
        proyecto por defecto: quedarse sin ninguno dejaría el Diseñador sin
        nada que abrir, que es peor que perder una etiqueta.
        """
        self._cache = {}
        if self.ruta.exists():
            try:
                datos = json.loads(self.ruta.read_text("utf-8"))
                for doc in datos.get("proyectos", []):
                    pid = doc.get("proyecto_id")
                    if not pid:
                        continue
                    self._cache[pid] = self._normalizar(doc, pid)
            except Exception as exc:  # noqa: BLE001
                logger.error("proyectos_hmi.json ilegible (%s); se ignora.", exc)

        if PROYECTO_POR_DEFECTO not in self._cache:
            self._cache[PROYECTO_POR_DEFECTO] = self._nuevo(
                PROYECTO_POR_DEFECTO, NOMBRE_POR_DEFECTO
            )
            # Fecha vacía a propósito: ordena antes que cualquier otra, así
            # que en una instalación que ya venía funcionando el proyecto de
            # siempre se queda el primero.
            self._cache[PROYECTO_POR_DEFECTO]["creado_en"] = ""
            self._escribir()
            logger.info("Creado el proyecto por defecto '%s'.",
                        PROYECTO_POR_DEFECTO)

        logger.info("ProyectoStore cargado: %d proyecto(s).", len(self._cache))

    @staticmethod
    def _nuevo(proyecto_id: str, nombre: str = "", usuario: str = "") -> dict:
        return {
            "proyecto_id": proyecto_id,
            "nombre": nombre or proyecto_id,
            "creado_en": _ahora_iso(),
            "actualizado_en": _ahora_iso(),
            "actualizado_por": usuario,
        }

    @staticmethod
    def _normalizar(doc: dict, pid: str) -> dict:
        doc.setdefault("proyecto_id", pid)
        doc.setdefault("nombre", pid)
        doc.setdefault("creado_en", "")
        doc.setdefault("actualizado_en", _ahora_iso())
        doc.setdefault("actualizado_por", "")
        return doc

    # ------------------------------------------------------------------ #
    # Escritura
    # ------------------------------------------------------------------ #
    def _escribir(self) -> None:
        """Escritura atómica del fichero entero. Asume lock tomado."""
        datos = {"proyectos": sorted(self._cache.values(), key=_orden)}
        tmp = self.ruta.with_suffix(".json.tmp")
        tmp.write_text(
            json.dumps(datos, indent=2, ensure_ascii=False), encoding="utf-8"
        )
        tmp.replace(self.ruta)

    def _escribir_sync(self) -> None:
        with self._lock_hilos:
            self._escribir()

    async def _escribir_async(self) -> None:
        """Escribe fuera del bucle de eventos: no congela los WebSockets."""
        bucle = asyncio.get_running_loop()
        await bucle.run_in_executor(None, self._escribir_sync)

    # ------------------------------------------------------------------ #
    # Lectura
    # ------------------------------------------------------------------ #
    def listar(self) -> List[dict]:
        return [dict(d) for d in sorted(self._cache.values(), key=_orden)]

    def obtener(self, proyecto_id: str) -> Optional[dict]:
        return self._cache.get(validar_proyecto_id(proyecto_id))

    def existe(self, proyecto_id: str) -> bool:
        try:
            return validar_proyecto_id(proyecto_id) in self._cache
        except ValueError:
            return False

    def ids(self) -> List[str]:
        return list(self._cache.keys())

    # ------------------------------------------------------------------ #
    # Mutaciones
    # ------------------------------------------------------------------ #
    async def crear(self, proyecto_id: str, nombre: str = "",
                    usuario: str = "") -> dict:
        """Crea un proyecto vacío. Falla si el id ya existe."""
        pid = validar_proyecto_id(proyecto_id)
        nombre = (nombre or "").strip()
        if len(nombre) > 80:
            raise ValueError("El nombre no puede pasar de 80 caracteres.")
        async with self._lock_async:
            if pid in self._cache:
                raise ValueError(f"El proyecto '{pid}' ya existe.")
            doc = self._nuevo(pid, nombre, usuario)
            self._cache[pid] = doc
            await self._escribir_async()
        logger.info("Proyecto '%s' creado por '%s'.", pid, usuario or "-")
        return doc

    async def renombrar(self, proyecto_id: str, nombre: str,
                        usuario: str = "") -> dict:
        """
        Cambia la etiqueta visible. El `proyecto_id` NO se toca: está escrito
        dentro del JSON de cada una de sus pantallas, y cambiarlo obligaría a
        reescribirlas todas para no dejarlas huérfanas.
        """
        pid = validar_proyecto_id(proyecto_id)
        nombre = (nombre or "").strip()
        if not nombre:
            raise ValueError("El nombre del proyecto no puede estar vacío.")
        if len(nombre) > 80:
            raise ValueError("El nombre no puede pasar de 80 caracteres.")
        async with self._lock_async:
            doc = self._cache.get(pid)
            if doc is None:
                raise KeyError(pid)
            doc["nombre"] = nombre
            doc["actualizado_en"] = _ahora_iso()
            doc["actualizado_por"] = usuario or ""
            await self._escribir_async()
            return doc

    async def borrar(self, proyecto_id: str) -> bool:
        """
        Quita el proyecto del registro. **No borra sus pantallas**: de eso se
        encarga la ruta, que tiene delante los dos almacenes y puede hacerlo
        en el orden correcto (primero las pantallas, después el proyecto; al
        revés, un fallo a mitad dejaría pantallas apuntando a la nada).
        """
        pid = validar_proyecto_id(proyecto_id)
        if pid == PROYECTO_POR_DEFECTO:
            raise ValueError(
                f"El proyecto '{PROYECTO_POR_DEFECTO}' no se puede borrar. "
                f"Puedes vaciarlo, pero debe existir siempre uno."
            )
        async with self._lock_async:
            if pid not in self._cache:
                return False
            self._cache.pop(pid)
            await self._escribir_async()
        logger.info("Proyecto '%s' eliminado.", pid)
        return True
