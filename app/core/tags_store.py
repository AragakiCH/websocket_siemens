# -*- coding: utf-8 -*-
"""
tags_store.py
=============
Catálogo de tags de cada PLC, guardado en disco.

**Por qué existe.** La lista de tags de un PLC salía solo del *browse* que se
hace al conectar y vivía en la memoria del proceso. Con el PLC apagado —o
tras reiniciar el servicio sin PLC a la vista— no había lista: Configuración
enseñaba "sin variables", y el inspector de un widget mostraba "Ninguna"
aunque el widget SÍ conservaba su enlace (el enlace vive en el proyecto, no
aquí). Parecía que se había perdido el trabajo.

Con este catálogo, lo último que se vio en cada PLC sigue disponible mientras
está desconectado: las variables se listan, se pueden asignar y los widgets
enseñan a qué están enlazados. Lo que NO se guarda son los VALORES: un valor
viejo en una pantalla de planta es peor que ninguno, así que sin conexión se
manda `None` y la vista pinta «—».

**Cuándo cambia.** Cada browse correcto REEMPLAZA el catálogo de ese PLC por
lo que el PLC tiene ahora: una variable borrada del programa deja de
aparecer, una nueva aparece. Un browse que falla no toca nada.

Se guarda en `datos/tags_plc.json`, con el mismo patrón que `PlcStore`
(escritura atómica, tolerante a fichero corrupto).
"""
from __future__ import annotations

import json
import logging
import threading
from typing import Dict, List, Optional

from app.db.store import carpeta_datos
from app.drivers.plc_driver import TagInfo

logger = logging.getLogger("tags_store")

CAMPOS = ("name", "full_name", "node_id", "data_type", "db_name")


class TagsStore:
    """Lee y escribe `datos/tags_plc.json`: plc_id -> lista de tags."""

    def __init__(self, carpeta: Optional[str] = None) -> None:
        self.carpeta = carpeta_datos(carpeta)
        self.ruta = self.carpeta / "tags_plc.json"
        self._lock = threading.Lock()
        self._datos: Dict[str, List[dict]] = self._leer()

    def _leer(self) -> Dict[str, List[dict]]:
        if not self.ruta.is_file():
            return {}
        try:
            crudo = json.loads(self.ruta.read_text("utf-8"))
            if not isinstance(crudo, dict):
                raise ValueError("se esperaba un objeto plc_id -> tags")
        except Exception as exc:  # noqa: BLE001
            # Un catálogo roto no impide arrancar: se reconstruye solo en
            # cuanto cada PLC conecte.
            logger.error("tags_plc.json ilegible (%s); se ignora.", exc)
            return {}
        return {str(k): v for k, v in crudo.items() if isinstance(v, list)}

    def cargar(self, plc_id: str) -> List[TagInfo]:
        """Tags guardados de un PLC. Lista vacía si nunca conectó."""
        salida: List[TagInfo] = []
        for d in self._datos.get(plc_id, []):
            try:
                salida.append(TagInfo(
                    name=str(d["name"]),
                    full_name=str(d["full_name"]),
                    node_id=str(d["node_id"]),
                    data_type=str(d.get("data_type") or ""),
                    db_name=str(d.get("db_name") or ""),
                ))
            except Exception as exc:  # noqa: BLE001
                # Una entrada mala no invalida las demás.
                logger.warning("Tag ilegible en el catálogo de %s: %s",
                               plc_id, exc)
        return salida

    def guardar(self, plc_id: str, tags: List[TagInfo]) -> None:
        """Reemplaza el catálogo de un PLC. No escribe si no cambió nada."""
        nuevo = [{c: getattr(t, c, "") for c in CAMPOS} for t in tags]
        with self._lock:
            if self._datos.get(plc_id) == nuevo:
                return
            self._datos[plc_id] = nuevo
            self._volcar()

    def borrar(self, plc_id: str) -> None:
        """Olvida el catálogo de un PLC (al eliminarlo)."""
        with self._lock:
            if self._datos.pop(plc_id, None) is not None:
                self._volcar()

    def _volcar(self) -> None:
        try:
            tmp = self.ruta.with_suffix(".json.tmp")
            tmp.write_text(
                json.dumps(self._datos, ensure_ascii=False),
                encoding="utf-8",
            )
            tmp.replace(self.ruta)
        except Exception as exc:  # noqa: BLE001
            # No poder guardar no debe tumbar la conexión con el PLC: en
            # memoria sigue todo bien, solo se pierde tras un reinicio.
            logger.error("No se pudo guardar tags_plc.json: %s", exc)
