# -*- coding: utf-8 -*-
"""
runtime_store.py
================
QUÉ PROYECTO ESTÁ "EN PANTALLA" PARA LOS VISORES.

PARA QUÉ EXISTE
---------------
Un visor (el .exe de cada puesto) no diseña nada: entra y tiene que ver el
runtime del proyecto que el supervisor tiene abierto en el servidor. Hasta
ahora eso no se podía saber: la Vista Previa leía el proyecto de la
preferencia local (`hmi.proyecto.ultimo`) de CADA navegador, así que un visor
recién instalado abría siempre `principal`, y un cambio de proyecto en el
Diseñador no se enteraba nadie.

Este almacén guarda ese único dato —el proyecto publicado— en el servidor,
que es el único sitio desde el que lo pueden leer todos. Es deliberadamente
pequeño: UN proyecto, quién lo puso y cuándo. La pantalla por la que arranca
la decide la propia vista (la primera del proyecto), igual que siempre.

QUIÉN LO CAMBIA
---------------
El Diseñador, al abrir un proyecto en el equipo servidor. Lo hace solo, sin
botón: "lo que el supervisor tiene en pantalla" es exactamente lo que se
quiere publicar, y un botón aparte sería un paso que alguien olvidaría.

Persiste en `datos/runtime.json` para que un reinicio del servidor no
devuelva a los diez visores al proyecto por defecto.
"""
from __future__ import annotations

import asyncio
import json
import logging
import threading
from datetime import datetime, timezone
from typing import Dict, Optional

from app.db.proyecto_store import PROYECTO_POR_DEFECTO, validar_proyecto_id
from app.db.store import carpeta_datos

logger = logging.getLogger("runtime_store")


def _ahora_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


class RuntimeStore:
    """Lee y escribe `datos/runtime.json`."""

    def __init__(self, carpeta: Optional[str] = None) -> None:
        self.ruta = carpeta_datos(carpeta) / "runtime.json"
        self.ruta.parent.mkdir(parents=True, exist_ok=True)
        self._doc: Dict[str, str] = self._por_defecto()
        self._lock_hilos = threading.Lock()
        self._lock_async = asyncio.Lock()
        self.cargar()

    @staticmethod
    def _por_defecto() -> Dict[str, str]:
        return {
            "proyecto_id": PROYECTO_POR_DEFECTO,
            "publicado_por": "",
            "publicado_en": "",
        }

    # ------------------------------------------------------------------ #
    # Carga / escritura
    # ------------------------------------------------------------------ #
    def cargar(self) -> None:
        """Si el fichero no existe o está roto, se arranca por `principal`."""
        self._doc = self._por_defecto()
        if not self.ruta.exists():
            return
        try:
            datos = json.loads(self.ruta.read_text("utf-8"))
            pid = validar_proyecto_id(str(datos.get("proyecto_id") or ""))
            self._doc = {
                "proyecto_id": pid,
                "publicado_por": str(datos.get("publicado_por") or ""),
                "publicado_en": str(datos.get("publicado_en") or ""),
            }
        except Exception as exc:  # noqa: BLE001
            logger.error("runtime.json ilegible (%s); se usa '%s'.",
                         exc, PROYECTO_POR_DEFECTO)
        logger.info("RuntimeStore: proyecto publicado '%s'.",
                    self._doc["proyecto_id"])

    def _escribir(self) -> None:
        tmp = self.ruta.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(self._doc, indent=2, ensure_ascii=False),
                       encoding="utf-8")
        tmp.replace(self.ruta)

    def _escribir_sync(self) -> None:
        with self._lock_hilos:
            self._escribir()

    async def _escribir_async(self) -> None:
        bucle = asyncio.get_running_loop()
        await bucle.run_in_executor(None, self._escribir_sync)

    # ------------------------------------------------------------------ #
    # API
    # ------------------------------------------------------------------ #
    def obtener(self) -> Dict[str, str]:
        return dict(self._doc)

    @property
    def proyecto_id(self) -> str:
        return self._doc["proyecto_id"]

    async def publicar(self, proyecto_id: str, usuario: str = "") -> Dict[str, str]:
        """
        Fija el proyecto en pantalla. Devuelve el documento nuevo.

        Es idempotente: publicar el que ya estaba no reescribe el fichero ni
        cambia la fecha, y la ruta usa eso para no difundir un evento vacío a
        diez visores cada vez que el Diseñador se monta.
        """
        pid = validar_proyecto_id(proyecto_id)
        async with self._lock_async:
            if self._doc["proyecto_id"] == pid:
                return dict(self._doc)
            self._doc = {
                "proyecto_id": pid,
                "publicado_por": usuario or "",
                "publicado_en": _ahora_iso(),
            }
            await self._escribir_async()
        logger.info("Runtime: ahora se publica '%s' (por '%s').",
                    pid, usuario or "-")
        return dict(self._doc)
