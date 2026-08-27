# -*- coding: utf-8 -*-
"""
auditoria.py
============
Registro de quién hizo qué y cuándo.

**Por qué.** Con un usuario, saber quién borró un PLC es trivial: fuiste tú.
Con diez, deja de serlo. Y el día que el HMI **escriba** valores al PLC —que es
hacia donde va esto— la trazabilidad deja de ser una comodidad y pasa a ser un
requisito: alguien va a preguntar quién cambió una consigna a las 3 de la
mañana, y "no lo sé" no es una respuesta aceptable en una planta.

**Formato: JSONL** (`datos/auditoria.jsonl`), una línea JSON por evento.
Se eligió frente a un JSON normal por tres motivos:

  * Se escribe con `append`: no hay que releer ni reescribir el fichero entero
    en cada evento, así que el coste no crece con el histórico.
  * Un corte de luz a media escritura corrompe UNA línea, no todo el archivo.
  * Se lee con `tail`, `grep` o Excel sin herramientas especiales.

**No bloquea.** La escritura va a un hilo aparte a través de una cola. Auditar
NUNCA debe retrasar la operación auditada: si el disco va lento, que se retrase
el log, no el borrado del PLC.

**Rotación.** Al pasar de `MAX_MB` el fichero se renombra a `.1` y se empieza
uno nuevo. Se conserva una sola generación: es un registro operativo, no un
archivo legal. Si hace falta guardarlo años, el sitio es una tabla de la BD.
"""
from __future__ import annotations

import json
import logging
import queue
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

from app.db.store import carpeta_datos

logger = logging.getLogger("auditoria")

MAX_MB = 20
MAX_COLA = 5000


def _ahora_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


class Auditoria:
    """Escribe eventos de auditoría a `datos/auditoria.jsonl`."""

    def __init__(self, carpeta: Optional[str] = None) -> None:
        self.ruta = carpeta_datos(carpeta) / "auditoria.jsonl"
        self._cola: "queue.Queue[dict]" = queue.Queue(maxsize=MAX_COLA)
        self._hilo: Optional[threading.Thread] = None
        self._parar = threading.Event()

    # ------------------------------------------------------------------ #
    # Ciclo de vida
    # ------------------------------------------------------------------ #
    def start(self) -> None:
        if self._hilo and self._hilo.is_alive():
            return
        self._parar.clear()
        self._hilo = threading.Thread(target=self._bucle, daemon=True,
                                      name="auditoria")
        self._hilo.start()
        logger.info("Auditoría activa en %s", self.ruta)

    def stop(self) -> None:
        """Vuelca lo pendiente y para el hilo."""
        self._parar.set()
        if self._hilo and self._hilo.is_alive():
            # Empujón para que el hilo salga del `get()` bloqueante.
            try:
                self._cola.put_nowait({"__fin__": True})
            except queue.Full:
                pass
            self._hilo.join(timeout=5)

    # ------------------------------------------------------------------ #
    # Registro
    # ------------------------------------------------------------------ #
    def registrar(
        self,
        accion: str,
        usuario: str = "",
        recurso: str = "",
        detalle: Optional[Dict[str, Any]] = None,
        resultado: str = "ok",
    ) -> None:
        """
        Encola un evento. NUNCA lanza ni bloquea.

        `accion`: verbo corto y estable ("plc.alta", "proyecto.widget_borrado",
                  "usuario.desactivado", "lock.forzado").
        `usuario`: quién. Cadena vacía = sesión anónima (auth desactivada).
        `recurso`: sobre qué (id del PLC, del proyecto, nombre de usuario...).
        """
        evento = {
            "ts": _ahora_iso(),
            "usuario": usuario or "anónimo",
            "accion": accion,
            "recurso": recurso,
            "resultado": resultado,
        }
        if detalle:
            # Se recortan los valores largos: la auditoría dice QUÉ pasó, no
            # guarda una copia del documento.
            evento["detalle"] = {
                k: (v if not isinstance(v, str) or len(v) <= 300
                    else v[:300] + "…")
                for k, v in detalle.items()
            }
        try:
            self._cola.put_nowait(evento)
        except queue.Full:
            # Cola llena: se pierde el evento antes que frenar la operación.
            logger.warning("Cola de auditoría llena; se descarta un evento.")

    # ------------------------------------------------------------------ #
    # Hilo escritor
    # ------------------------------------------------------------------ #
    def _bucle(self) -> None:
        while not self._parar.is_set() or not self._cola.empty():
            try:
                evento = self._cola.get(timeout=0.5)
            except queue.Empty:
                continue
            if evento.get("__fin__"):
                continue
            try:
                self._rotar_si_toca()
                with open(self.ruta, "a", encoding="utf-8") as fh:
                    fh.write(json.dumps(evento, ensure_ascii=False) + "\n")
            except Exception as exc:  # noqa: BLE001
                logger.warning("No se pudo escribir en la auditoría: %s", exc)

    def _rotar_si_toca(self) -> None:
        try:
            if self.ruta.is_file() and self.ruta.stat().st_size > MAX_MB * 1024 * 1024:
                anterior = self.ruta.with_suffix(".jsonl.1")
                anterior.unlink(missing_ok=True)
                self.ruta.rename(anterior)
                logger.info("Auditoría rotada (>%d MB).", MAX_MB)
        except OSError as exc:
            logger.warning("No se pudo rotar la auditoría: %s", exc)

    # ------------------------------------------------------------------ #
    # Lectura
    # ------------------------------------------------------------------ #
    def leer(self, limite: int = 200, usuario: str = "",
             accion: str = "") -> List[dict]:
        """
        Últimos eventos, del más reciente al más antiguo.

        Lee el fichero entero y filtra en memoria. Con el tope de 20 MB eso son
        como mucho unos cientos de miles de líneas: aceptable para una consulta
        puntual desde una pantalla de administración. Si algún día hace falta
        consultarlo en serio, el sitio es una tabla de la BD.
        """
        if not self.ruta.is_file():
            return []
        salida: List[dict] = []
        try:
            with open(self.ruta, "r", encoding="utf-8") as fh:
                for linea in fh:
                    linea = linea.strip()
                    if not linea:
                        continue
                    try:
                        ev = json.loads(linea)
                    except json.JSONDecodeError:
                        # Línea truncada por un corte: se salta, las demás
                        # siguen siendo válidas. Justo por esto se usa JSONL.
                        continue
                    if usuario and ev.get("usuario") != usuario:
                        continue
                    if accion and not str(ev.get("accion", "")).startswith(accion):
                        continue
                    salida.append(ev)
        except Exception as exc:  # noqa: BLE001
            logger.warning("No se pudo leer la auditoría: %s", exc)
            return []
        return list(reversed(salida))[:limite]
