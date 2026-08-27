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
        # MULTIUSUARIO: quién está detrás de cada socket. Va al lado del filtro,
        # con la misma vida: se pone al conectar y se quita al desconectar.
        # De aquí sale la presencia ("3 conectados: Ana, José, Marta").
        self._usuarios: Dict[WebSocket, dict] = {}
        self._lock = asyncio.Lock()
        # Observadores internos del backend (historizador, alarmas futuras...).
        # Reciben TODOS los mensajes, sin filtro de PLC y sin ser clientes WS.
        self._observadores: List[Callable[[dict], None]] = []

    # ------------------------------------------------------------------ #
    # Alta / baja de clientes
    # ------------------------------------------------------------------ #
    async def connect(
        self,
        websocket: WebSocket,
        plc_filter: Optional[str] = None,
        usuario: Optional[dict] = None,
    ) -> None:
        """
        Acepta una nueva conexión WebSocket y la registra.

        `plc_filter`: si se indica, ese cliente solo recibirá cambios de ese PLC.
        `usuario`: {"usuario": ..., "categoria": ...} si la conexión venía
                   autenticada. None para conexiones anónimas.
        """
        await websocket.accept()
        async with self._lock:
            self._active.add(websocket)
            self._filtros[websocket] = plc_filter
            if usuario:
                self._usuarios[websocket] = usuario
        logger.info("Cliente WS conectado (usuario=%s, filtro=%s). Total: %d",
                    (usuario or {}).get("usuario", "anónimo"),
                    plc_filter or "todos", len(self._active))

    async def disconnect(self, websocket: WebSocket) -> None:
        """Da de baja una conexión WebSocket."""
        async with self._lock:
            self._active.discard(websocket)
            self._filtros.pop(websocket, None)
            self._usuarios.pop(websocket, None)
        logger.info("Cliente WS desconectado. Total: %d", len(self._active))

    def count(self) -> int:
        """Número de clientes conectados."""
        return len(self._active)

    # ------------------------------------------------------------------ #
    # Presencia
    # ------------------------------------------------------------------ #
    def presentes(self) -> List[dict]:
        """
        Quién está mirando ahora mismo, deduplicado por persona.

        Alguien con el Diseñador y la Vista previa en dos pestañas son DOS
        sockets pero UNA persona; la barra de presencia debe decir "1
        conectado", no "2".
        """
        vistos: Dict[str, dict] = {}
        anonimos = 0
        for u in self._usuarios.values():
            nombre = u.get("usuario")
            if not nombre:
                anonimos += 1
                continue
            if nombre not in vistos:
                vistos[nombre] = {"usuario": nombre,
                                  "categoria": u.get("categoria", "")}
        # Sockets sin identificar (auth desactivada o conexión anónima).
        anonimos += len(self._active) - len(self._usuarios)

        salida = sorted(vistos.values(), key=lambda x: x["usuario"])
        if anonimos > 0:
            salida.append({"usuario": f"{anonimos} anónimo(s)", "categoria": ""})
        return salida

    async def difundir_config(self, recurso: str, por: str = "",
                              accion: str = "") -> None:
        """
        Avisa de que cambió algo de la CONFIGURACIÓN compartida.

        Es deliberadamente tonto: dice QUÉ cambió, no CÓMO. El cliente que lo
        recibe vuelve a pedir la lista correspondiente. Difundir el contenido
        obligaría a mantener sincronizados dos formatos (el del GET y el del
        evento) y a filtrar permisos en el broadcast, que es justo donde no
        se quiere lógica.

        `recurso`: "conexiones" | "consultas" | "historicos" | "esquema"
        """
        from datetime import datetime, timezone

        await self.broadcast({
            "timestamp": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            "type": "config.updated",
            "recurso": recurso,
            "accion": accion,
            "por": por,
        })

    async def difundir_presencia(self) -> None:
        """Manda a todos la lista de quién está conectado."""
        from datetime import datetime, timezone

        await self.broadcast({
            "timestamp": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            "type": "presence",
            "usuarios": self.presentes(),
            "num_clientes": len(self._active),
        })

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

        # Destinatarios que pasan el filtro.
        objetivo = [
            ws for ws in destinatarios
            if not (filtros.get(ws) and plc_msg and filtros.get(ws) != plc_msg)
        ]
        if not objetivo:
            return

        # MULTIUSUARIO: envío CONCURRENTE.
        #
        # Antes era un `for` secuencial con `await` dentro: un cliente lento
        # (por VPN, o con la pestaña en segundo plano) retrasaba a todos los
        # que iban detrás en la lista. Con `gather` todos los envíos se lanzan
        # a la vez y el lento solo se retrasa a sí mismo.
        resultados = await asyncio.gather(
            *(ws.send_json(message) for ws in objetivo),
            return_exceptions=True,
        )

        # Limpiar los clientes que fallaron.
        caidos: List[WebSocket] = [
            ws for ws, r in zip(objetivo, resultados) if isinstance(r, Exception)
        ]
        if caidos:
            async with self._lock:
                for ws in caidos:
                    self._active.discard(ws)
                    self._filtros.pop(ws, None)
                    self._usuarios.pop(ws, None)
            logger.info("Depurados %d clientes WS caídos. Total: %d",
                        len(caidos), len(self._active))
