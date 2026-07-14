# -*- coding: utf-8 -*-
"""
subscription_handler.py
=======================
Orquesta el ciclo de vida de la conexión con UN PLC y el puente hacia los
clientes WebSocket. Es el "cerebro" por-PLC del servicio:

  * Conecta el driver, hace el browse de tags y crea la subscription.
  * Recibe los cambios de valor del driver (callback) y los reenvía por
    broadcast a los clientes WebSocket, etiquetados con el PLC de origen.
  * Mantiene un snapshot en memoria (último valor de cada tag) para servir a
    clientes nuevos y a los endpoints REST.
  * Supervisa la conexión (watchdog) y, ante caídas, reconecta con backoff
    exponencial recreando la subscription automáticamente.

En modo MULTI-PLC hay una instancia de esta clase por cada PLC; el PlcManager
las agrega. Cada handler etiqueta sus mensajes con `plc_id`, de modo que un PLC
caído no afecta a los demás.

Trabaja contra la interfaz abstracta PlcDriver, no contra OPC UA directamente,
de modo que soportar otro protocolo en el futuro no requiere tocar esta clase.
"""
from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timezone
from typing import Dict, List, Optional

from app.config.settings import Settings
from app.core.connection_manager import ConnectionManager
from app.drivers.plc_driver import PlcDriver, TagInfo, TagValue

logger = logging.getLogger("subscription_handler")


def _ahora_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


class SubscriptionHandler:
    """Puente de UN PLC hacia el WebSocket, con reconexión automática."""

    def __init__(
        self,
        driver: PlcDriver,
        manager: ConnectionManager,
        settings: Settings,
        plc_id: str,
        endpoint: str = "",
        plc_nombre: str = "",
    ) -> None:
        self._driver = driver
        self._manager = manager
        self._settings = settings

        # Identidad del PLC (para etiquetar mensajes y agregación multi-PLC).
        self.plc_id = plc_id
        self.endpoint = endpoint
        self.plc_nombre = plc_nombre

        # Snapshot en memoria: full_name -> TagValue (último valor conocido).
        self._snapshot: Dict[str, TagValue] = {}
        # Tags descubiertos en el último browse.
        self._tags: List[TagInfo] = []

        # Estado del supervisor.
        self._running: bool = False
        self._supervisor_task: Optional[asyncio.Task] = None
        # Estado de conexión legible para /health.
        self.estado_conexion: str = "desconectado"

    # Prefijo del logger para distinguir PLCs en los logs.
    def _log(self, nivel: int, msg: str, *args) -> None:
        logger.log(nivel, f"[{self.plc_id}] " + msg, *args)

    # ------------------------------------------------------------------ #
    # Arranque / parada
    # ------------------------------------------------------------------ #
    async def start(self) -> None:
        """Lanza el supervisor en segundo plano (no bloquea el arranque)."""
        self._running = True
        self._supervisor_task = asyncio.create_task(self._supervisor())
        self._log(logging.INFO, "Handler iniciado (endpoint=%s).", self.endpoint)

    async def stop(self) -> None:
        """Detiene el supervisor y cierra limpiamente la conexión con el PLC."""
        self._running = False
        if self._supervisor_task is not None:
            self._supervisor_task.cancel()
            try:
                await self._supervisor_task
            except asyncio.CancelledError:
                pass
        try:
            await self._driver.disconnect()
        except Exception as exc:  # noqa: BLE001
            self._log(logging.WARNING, "Error al cerrar el driver: %s", exc)
        self.estado_conexion = "desconectado"
        self._log(logging.INFO, "Handler detenido.")

    # ------------------------------------------------------------------ #
    # Callback de cambios de valor (lo invoca el driver)
    # ------------------------------------------------------------------ #
    async def on_data_change(self, tag_value: TagValue) -> None:
        """
        Recibe un cambio de valor desde el driver, actualiza el snapshot y hace
        broadcast a los clientes WebSocket, etiquetando el PLC de origen.
        """
        self._snapshot[tag_value.tag] = tag_value
        mensaje = {
            "timestamp": tag_value.timestamp,     # recepción en el backend
            "plc": self.plc_id,
            "tag": tag_value.tag,
            "value": tag_value.value,
            "type": tag_value.data_type,
            "source_ts": tag_value.source_ts,     # cuándo cambió en el PLC
            "server_ts": tag_value.server_ts,     # marca del servidor OPC UA
            "delta_ms": tag_value.delta_ms,       # ms desde el cambio anterior
        }
        await self._manager.broadcast(mensaje)

    # ------------------------------------------------------------------ #
    # Estado expuesto para agregación (lo consume el PlcManager)
    # ------------------------------------------------------------------ #
    def snapshot_entries(self) -> Dict[str, dict]:
        """
        Devuelve las entradas de snapshot de este PLC con clave compuesta
        '<plc_id>|<tag>' para evitar colisiones entre PLCs.
        """
        salida: Dict[str, dict] = {}
        for fv in self._snapshot.values():
            clave = f"{self.plc_id}|{fv.tag}"
            salida[clave] = {
                "plc": self.plc_id,
                "tag": fv.tag,
                "value": fv.value,
                "type": fv.data_type,
                "timestamp": fv.timestamp,
                "source_ts": fv.source_ts,
                "server_ts": fv.server_ts,
                "delta_ms": fv.delta_ms,
            }
        return salida

    def get_tags_con_valor(self) -> List[dict]:
        """Lista de tags de este PLC con su último valor (para GET /tags)."""
        salida: List[dict] = []
        for info in self._tags:
            fv = self._snapshot.get(info.full_name)
            salida.append(
                {
                    "plc": self.plc_id,
                    "tag": info.full_name,
                    "name": info.name,
                    "db": info.db_name,
                    "node_id": info.node_id,
                    "type": info.data_type,
                    "value": fv.value if fv else None,
                    "timestamp": fv.timestamp if fv else None,
                    "source_ts": fv.source_ts if fv else None,
                    "delta_ms": fv.delta_ms if fv else None,
                }
            )
        return salida

    def get_browse_tree(self) -> dict:
        """Árbol de tags de este PLC agrupados por Data Block (para GET /browse)."""
        arbol: Dict[str, List[dict]] = {}
        for info in self._tags:
            arbol.setdefault(info.db_name, []).append(
                {
                    "name": info.name,
                    "full_name": info.full_name,
                    "node_id": info.node_id,
                    "type": info.data_type,
                }
            )
        return {
            "plc": self.plc_id,
            "nombre": self.plc_nombre,
            "endpoint": self.endpoint,
            "data_blocks": arbol,
        }

    def health(self) -> dict:
        """Estado de este PLC (para GET /health)."""
        return {
            "plc": self.plc_id,
            "nombre": self.plc_nombre,
            "endpoint": self.endpoint,
            "conectado": self._driver.is_connected(),
            "estado_conexion": self.estado_conexion,
            "num_tags": len(self._tags),
            # Intervalos configurados: cada cuánto se muestrea y se publica.
            "sampling_interval_ms": self._settings.sampling_interval_ms,
            "publishing_interval_ms": self._settings.publishing_interval_ms,
        }

    def num_tags(self) -> int:
        return len(self._tags)

    def is_plc_connected(self) -> bool:
        return self._driver.is_connected()

    # ------------------------------------------------------------------ #
    # Supervisor: conexión + reconexión con backoff exponencial
    # ------------------------------------------------------------------ #
    async def _supervisor(self) -> None:
        """
        Bucle principal: intenta conectar; una vez conectado, vigila la sesión.
        Si la conexión cae, reintenta con backoff exponencial y recrea todo.
        """
        delay = self._settings.reconnect_initial_delay
        while self._running:
            try:
                self.estado_conexion = "conectando"
                self._log(logging.INFO, "Intentando conectar con el PLC...")
                await self._conectar_y_suscribir()

                # Conexión OK: reiniciar el backoff y pasar a vigilancia.
                delay = self._settings.reconnect_initial_delay
                self.estado_conexion = "conectado"
                self._log(logging.INFO, "PLC conectado y suscripciones activas.")

                # Watchdog: comprobar periódicamente que la sesión sigue viva.
                await self._vigilar_conexion()

            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001
                self.estado_conexion = "reconectando"
                self._log(logging.ERROR, "Fallo de conexión con el PLC: %s", exc)

            if not self._running:
                break

            # Backoff exponencial acotado por reconnect_max_delay.
            self._log(logging.INFO, "Reintentando en %.1f s...", delay)
            try:
                await asyncio.sleep(delay)
            except asyncio.CancelledError:
                raise
            delay = min(
                delay * self._settings.reconnect_backoff_factor,
                self._settings.reconnect_max_delay,
            )

    async def _conectar_y_suscribir(self) -> None:
        """Secuencia completa: conectar -> browse -> subscribe -> snapshot inicial."""
        # Asegurar estado limpio antes de (re)conectar.
        try:
            await self._driver.disconnect()
        except Exception:  # noqa: BLE001
            pass

        await self._driver.connect()

        # Auto-descubrimiento de tags.
        self._tags = await self._driver.browse_tags()
        self._log(logging.INFO, "Browse completo: %d tags.", len(self._tags))

        # Crear la subscription en tiempo real.
        await self._driver.subscribe(self._tags, self.on_data_change)

        # Cargar un snapshot inicial leyendo el valor actual de cada tag.
        await self._cargar_snapshot_inicial()

        # Notificar a los clientes WS que este PLC está conectado.
        await self._manager.broadcast(
            {"timestamp": _ahora_iso(), "type": "status",
             "plc": self.plc_id, "status": "conectado"}
        )

    async def _cargar_snapshot_inicial(self) -> None:
        """
        Lee una vez el valor de cada tag para tener un snapshot inmediato,
        sin esperar al primer cambio. Un tag que falle no rompe el proceso.
        """
        for info in self._tags:
            try:
                tv = await self._driver.read_tag(info.node_id)
                self._snapshot[info.full_name] = tv
            except Exception as exc:  # noqa: BLE001
                self._log(logging.DEBUG, "No se pudo leer snapshot de %s: %s",
                          info.full_name, exc)

    async def _vigilar_conexion(self) -> None:
        """
        Watchdog: mientras el servicio corra, comprueba la vida de la sesión.
        Al detectar una caída, sale del bucle para que el supervisor reconecte.
        """
        while self._running:
            await asyncio.sleep(self._settings.healthcheck_interval)

            # Si el driver expone check_alive (OPC UA), lo usamos; si no, is_connected.
            alive = True
            check = getattr(self._driver, "check_alive", None)
            if check is not None:
                alive = await check()
            else:
                alive = self._driver.is_connected()

            if not alive:
                self.estado_conexion = "reconectando"
                self._log(logging.WARNING,
                          "Watchdog: conexión perdida, se forzará reconexión.")
                await self._manager.broadcast(
                    {"timestamp": _ahora_iso(), "type": "status",
                     "plc": self.plc_id, "status": "reconectando"}
                )
                return  # sale del watchdog -> el supervisor reintentará
