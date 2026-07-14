# -*- coding: utf-8 -*-
"""
plc_manager.py
==============
Gestor MULTI-PLC. Es el nivel superior que:

  * Ejecuta el descubrimiento de PLCs (escaneo de subred + endpoints manuales).
  * Crea un OpcUaDriver y un SubscriptionHandler por cada PLC encontrado.
  * Arranca todos los handlers (cada uno con su propio supervisor/reconexión).
  * Agrega el estado de todos los PLCs para el snapshot inicial y los endpoints
    REST (/health, /tags, /browse).
  * Opcionalmente re-escanea la red cada cierto tiempo para incorporar PLCs
    nuevos en caliente, sin reiniciar el servicio.

Un PLC caído o inaccesible NO afecta a los demás: cada handler es independiente.
"""
from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timezone
from typing import Dict, List, Optional

from app.config.settings import Settings
from app.core.connection_manager import ConnectionManager
from app.core.plc_discovery import EndpointPlc, descubrir_plcs
from app.drivers.opcua_driver import OpcUaDriver

logger = logging.getLogger("plc_manager")


def _ahora_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _plc_id_desde(ep: EndpointPlc, usados: set) -> str:
    """
    Genera un identificador de PLC estable y único.
    Prioridad: nombre de aplicación saneado -> host. Añade sufijo si colisiona.
    """
    base = ep.nombre.strip() if ep.nombre else ""
    if not base:
        base = ep.host  # ej. 192.168.50.1
    # Saneado: espacios y caracteres problemáticos a '_'.
    base = (
        base.replace(" ", "_")
        .replace(":", "_")
        .replace("/", "_")
        .replace("\\", "_")
        .replace("\"", "")
        .replace("'", "")
    )
    plc_id = base
    i = 2
    while plc_id in usados:
        plc_id = f"{base}_{i}"
        i += 1
    usados.add(plc_id)
    return plc_id


class PlcManager:
    """Administra N PLCs en simultáneo."""

    def __init__(self, manager: ConnectionManager, settings: Settings) -> None:
        self._manager = manager
        self._settings = settings
        # Importación diferida para permitir inyectar otros drivers en el futuro.
        # plc_id -> SubscriptionHandler
        self._handlers: Dict[str, "object"] = {}
        self._ids_usados: set = set()
        self._running = False
        self._rescan_task = None

    # ------------------------------------------------------------------ #
    # Arranque / parada
    # ------------------------------------------------------------------ #
    async def start(self) -> None:
        """Descubre PLCs, crea un handler por cada uno y los arranca."""
        self._running = True

        # Modo manual: arrancar sin PLCs; el usuario los agrega desde la vista.
        if not self._settings.autostart_plcs:
            logger.info("autostart_plcs=False: arranque sin PLCs. "
                        "Agrega PLCs desde la vista (POST /plcs o /discover).")
            return

        endpoints = await descubrir_plcs(self._settings)

        # Lista blanca opcional: conectarse solo a los PLCs elegidos.
        incluir = self._settings.include_plcs
        if incluir:
            incluir_set = {x.strip() for x in incluir if x.strip()}
            antes = len(endpoints)
            endpoints = [ep for ep in endpoints if self._coincide(ep, incluir_set)]
            logger.info("Filtro include_plcs=%s: %d de %d PLCs seleccionados.",
                        incluir_set, len(endpoints), antes)

        if not endpoints:
            logger.warning(
                "No se seleccionó ningún PLC. El servicio queda a la espera; "
                "revisa PLC_STATIC_ENDPOINTS / PLC_DISCOVERY_SUBNET / PLC_INCLUDE_PLCS."
            )

        for ep in endpoints:
            await self._añadir_plc(ep)

        # Re-escaneo periódico opcional para detectar PLCs nuevos en caliente.
        if self._settings.discovery_interval and self._settings.discovery_interval > 0:
            self._rescan_task = asyncio.create_task(self._bucle_reescaneo())

        logger.info("PlcManager iniciado con %d PLC(s).", len(self._handlers))

    async def stop(self) -> None:
        """Detiene el re-escaneo y todos los handlers limpiamente."""
        self._running = False
        if self._rescan_task is not None:
            self._rescan_task.cancel()
            try:
                await self._rescan_task
            except asyncio.CancelledError:
                pass
        # Cerrar todos los handlers en paralelo.
        await asyncio.gather(
            *(h.stop() for h in self._handlers.values()),
            return_exceptions=True,
        )
        logger.info("PlcManager detenido.")

    async def _añadir_plc(self, ep: EndpointPlc) -> str:
        """Crea driver + handler para un endpoint, lo arranca y devuelve su id."""
        # Import local para evitar dependencias circulares y facilitar tests.
        from app.core.subscription_handler import SubscriptionHandler

        plc_id = _plc_id_desde(ep, self._ids_usados)

        # Construye una copia de settings con el endpoint concreto de este PLC.
        # (settings es inmutable-ish; usamos model_copy para no afectar a otros.)
        settings_plc = self._settings.model_copy(update={"opcua_endpoint": ep.endpoint})

        driver = OpcUaDriver(settings_plc)
        handler = SubscriptionHandler(
            driver=driver,
            manager=self._manager,
            settings=settings_plc,
            plc_id=plc_id,
            endpoint=ep.endpoint,
            plc_nombre=ep.nombre,
        )
        self._handlers[plc_id] = handler
        await handler.start()
        logger.info("PLC añadido: id=%s endpoint=%s nombre=%s",
                    plc_id, ep.endpoint, ep.nombre or "-")
        return plc_id

    # ------------------------------------------------------------------ #
    # Gestión en caliente desde la vista (REST)
    # ------------------------------------------------------------------ #
    async def add_plc_manual(self, host: str, puerto: int = 4840) -> dict:
        """
        Añade un PLC escrito por el usuario (IP, host o endpoint completo).
        Devuelve {ok, plc_id, endpoint, mensaje}.
        """
        host = host.strip()
        if not host:
            return {"ok": False, "mensaje": "Indica una IP o endpoint."}
        if host.startswith("opc.tcp://"):
            endpoint = host
            from app.core.plc_discovery import _host_puerto
            host_solo, puerto = _host_puerto(endpoint)
        else:
            host_solo = host
            endpoint = f"opc.tcp://{host}:{puerto}"

        # Evitar duplicados por endpoint.
        for pid, h in self._handlers.items():
            if h.endpoint == endpoint:
                return {"ok": False, "plc_id": pid, "endpoint": endpoint,
                        "mensaje": f"Ese PLC ya está gestionado (id={pid})."}

        ep = EndpointPlc(endpoint=endpoint, host=host_solo, port=puerto,
                         nombre="", origen="manual")
        plc_id = await self._añadir_plc(ep)
        # Refrescar a todos los clientes conectados con un snapshot nuevo.
        await self._manager.broadcast(self.build_snapshot_message())
        return {"ok": True, "plc_id": plc_id, "endpoint": endpoint,
                "mensaje": f"PLC {plc_id} añadido; conectando..."}

    async def remove_plc(self, plc_id: str) -> dict:
        """Detiene y elimina un PLC gestionado."""
        handler = self._handlers.pop(plc_id, None)
        if handler is None:
            return {"ok": False, "mensaje": f"No existe el PLC '{plc_id}'."}
        try:
            await handler.stop()
        except Exception as exc:  # noqa: BLE001
            logger.warning("Error deteniendo handler %s: %s", plc_id, exc)
        self._ids_usados.discard(plc_id)
        # Aviso a los clientes (sin clave 'plc' para que llegue a todos).
        await self._manager.broadcast(
            {"timestamp": _ahora_iso(), "type": "plc_removed",
             "plc_removed": plc_id}
        )
        logger.info("PLC eliminado: id=%s", plc_id)
        return {"ok": True, "plc_id": plc_id, "mensaje": f"PLC {plc_id} eliminado."}

    async def rescan(self) -> dict:
        """Escanea la red una vez y añade los PLCs nuevos que encuentre."""
        endpoints = await descubrir_plcs(self._settings)
        existentes = {h.endpoint for h in self._handlers.values()}
        nuevos: List[str] = []
        for ep in endpoints:
            if ep.endpoint not in existentes:
                nuevos.append(await self._añadir_plc(ep))
        if nuevos:
            await self._manager.broadcast(self.build_snapshot_message())
        return {"ok": True, "encontrados": len(endpoints), "nuevos": nuevos,
                "mensaje": (f"{len(nuevos)} PLC(s) nuevo(s) añadido(s)."
                            if nuevos else "Sin PLCs nuevos en la red.")}

    async def _bucle_reescaneo(self) -> None:
        """Re-escanea la red periódicamente y añade PLCs nuevos."""
        while self._running:
            try:
                await asyncio.sleep(self._settings.discovery_interval)
                if not self._running:
                    break
                endpoints = await descubrir_plcs(self._settings)
                existentes = {h.endpoint for h in self._handlers.values()}
                for ep in endpoints:
                    if ep.endpoint not in existentes:
                        logger.info("Re-escaneo: PLC nuevo detectado %s", ep.endpoint)
                        await self._añadir_plc(ep)
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001
                logger.warning("Error en re-escaneo: %s", exc)

    @staticmethod
    def _coincide(ep: EndpointPlc, incluir: set) -> bool:
        """True si el endpoint coincide con la lista blanca (nombre/host/endpoint)."""
        return bool(
            ep.nombre in incluir
            or ep.host in incluir
            or ep.endpoint in incluir
        )

    def list_plc_ids(self) -> List[str]:
        """Ids de los PLCs gestionados (para el selector del cliente)."""
        return list(self._handlers.keys())

    # ------------------------------------------------------------------ #
    # Agregación para snapshot / REST (con filtro opcional por PLC)
    # ------------------------------------------------------------------ #
    def build_snapshot_message(self, plc: Optional[str] = None) -> dict:
        """
        Snapshot de los PLCs (para clientes WS nuevos). Si se pasa `plc`, solo
        incluye ese PLC. Las claves de tags se prefijan con el plc_id.
        """
        tags: Dict[str, dict] = {}
        plcs: Dict[str, dict] = {}
        for plc_id, h in self._handlers.items():
            if plc and plc_id != plc:
                continue
            tags.update(h.snapshot_entries())
            plcs[plc_id] = {
                "nombre": h.plc_nombre,
                "endpoint": h.endpoint,
                "estado": h.estado_conexion,
                "conectado": h.is_plc_connected(),
                "sampling_interval_ms": self._settings.sampling_interval_ms,
                "publishing_interval_ms": self._settings.publishing_interval_ms,
            }
        return {
            "timestamp": _ahora_iso(),
            "type": "snapshot",
            "plcs": plcs,
            "tags": tags,
        }

    def get_tags(self, plc: Optional[str] = None) -> List[dict]:
        """Tags de todos los PLCs (o solo `plc`) con su último valor."""
        salida: List[dict] = []
        for plc_id, h in self._handlers.items():
            if plc and plc_id != plc:
                continue
            salida.extend(h.get_tags_con_valor())
        return salida

    def get_browse(self, plc: Optional[str] = None) -> dict:
        """Árbol de tags por PLC (o solo `plc`) para debug."""
        return {
            "timestamp": _ahora_iso(),
            "plcs": [h.get_browse_tree() for plc_id, h in self._handlers.items()
                     if not plc or plc_id == plc],
        }

    def get_health(self) -> dict:
        """Estado agregado de todos los PLCs."""
        plcs = [h.health() for h in self._handlers.values()]
        conectados = sum(1 for p in plcs if p["conectado"])
        total_tags = sum(p["num_tags"] for p in plcs)
        return {
            "status": "ok",
            "num_plcs": len(plcs),
            "plcs_conectados": conectados,
            "total_tags": total_tags,
            "clientes_ws": self._manager.count(),
            "plcs": plcs,
        }

    def num_plcs(self) -> int:
        return len(self._handlers)
