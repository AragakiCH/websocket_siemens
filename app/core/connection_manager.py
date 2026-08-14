# -*- coding: utf-8 -*-
"""
connection_manager.py
=====================
Gestiona el conjunto de clientes WebSocket conectados y hace broadcast de los
mensajes (cambios de tags, snapshots, estados) a todos ellos.

Es agnóstico al origen de los datos: solo sabe de conexiones WebSocket y de
enviar JSON. Un cliente lento o que se desconecta no debe afectar a los demás.
"""
from __future__ import annotations

import asyncio
import logging
from typing import Callable, Dict, List, Optional, Set

from fastapi import WebSocket

logger = logging.getLogger("connection_manager")


class ConnectionManager:
    """Administra las conexiones WebSocket activas y el broadcast."""

    def __init__(self) -> None:
        self._active: Set[WebSocket] = set()
        # Filtro opcional por conexión: websocket -> plc_id (o None = todos).
        self._filtros: Dict[WebSocket, Optional[str]] = {}
        self._lock = asyncio.Lock()
        # Observadores internos del backend (historizador, alarmas futuras...).
        # Reciben TODOS los mensajes, sin filtro de PLC y sin ser clientes WS.
        self._observadores: List[Callable[[dict], None]] = []

    # ------------------------------------------------------------------ #
    # Alta / baja de clientes
    # ------------------------------------------------------------------ #
    async def connect(self, websocket: WebSocket, plc_filter: Optional[str] = None) -> None:
        """
        Acepta una nueva conexión WebSocket y la registra.
        `plc_filter`: si se indica, ese cliente solo recibirá cambios de ese PLC.
        """
        await websocket.accept()
        async with self._lock:
            self._active.add(websocket)
            self._filtros[websocket] = plc_filter
        logger.info("Cliente WS conectado (filtro=%s). Total: %d",
                    plc_filter or "todos", len(self._active))

    async def disconnect(self, websocket: WebSocket) -> None:
        """Da de baja una conexión WebSocket."""
        async with self._lock:
            self._active.discard(websocket)
            self._filtros.pop(websocket, None)
        logger.info("Cliente WS desconectado. Total: %d", len(self._active))

    def count(self) -> int:
        """Número de clientes conectados."""
        return len(self._active)

    # ------------------------------------------------------------------ #
    # Observadores internos (no son clientes WebSocket)
    # ------------------------------------------------------------------ #
    def registrar_observador(self, callback: Callable[[dict], None]) -> None:
        """
        Registra una función que recibirá una COPIA de cada mensaje difundido.

        Lo usa el historizador para escuchar los cambios de tags sin abrir una
        conexión WebSocket ni una segunda sesión OPC UA. El callback debe ser
        SÍNCRONO y muy rápido (encolar y volver): se ejecuta dentro del bucle
        de broadcast, así que si bloquea, retrasa a todos los clientes.
        """
        if callback not in self._observadores:
            self._observadores.append(callback)
            logger.info("Observador interno registrado (total: %d).",
                        len(self._observadores))

    def quitar_observador(self, callback: Callable[[dict], None]) -> None:
        """Da de baja un observador previamente registrado."""
        if callback in self._observadores:
            self._observadores.remove(callback)

    # ------------------------------------------------------------------ #
    # Envío de mensajes
    # ------------------------------------------------------------------ #
    async def send_personal(self, message: dict, websocket: WebSocket) -> None:
        """Envía un mensaje JSON a un cliente concreto (ej. snapshot inicial)."""
        try:
            await websocket.send_json(message)
        except Exception as exc:  # noqa: BLE001
            logger.warning("Fallo enviando mensaje personal, se desconecta: %s", exc)
            await self.disconnect(websocket)

    async def broadcast(self, message: dict) -> None:
        """
        Envía un mensaje JSON a los clientes conectados. Si un cliente definió
        un filtro de PLC, solo recibe mensajes de ese PLC (los mensajes sin
        campo 'plc', como estados globales, llegan a todos).
        Los clientes que fallen se eliminan de la lista.
        """
        # Observadores internos primero: deben ver TODOS los mensajes aunque
        # no haya ningún cliente web conectado (el historizador tiene que
        # seguir guardando aunque nadie esté mirando la pantalla).
        for obs in self._observadores:
            try:
                obs(message)
            except Exception as exc:  # noqa: BLE001
                logger.warning("Observador interno falló: %s", exc)

        plc_msg = message.get("plc")
        # Copia para iterar sin bloquear altas/bajas concurrentes.
        async with self._lock:
            destinatarios = list(self._active)
            filtros = dict(self._filtros)

        caidos: List[WebSocket] = []
        for ws in destinatarios:
            # Respetar el filtro por conexión.
            f = filtros.get(ws)
            if f and plc_msg and f != plc_msg:
                continue
            try:
                await ws.send_json(message)
            except Exception:  # noqa: BLE001
                caidos.append(ws)

        # Limpiar los clientes que fallaron.
        if caidos:
            async with self._lock:
                for ws in caidos:
                    self._active.discard(ws)
            logger.info("Depurados %d clientes WS caídos. Total: %d",
                        len(caidos), len(self._active))
