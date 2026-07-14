# -*- coding: utf-8 -*-
"""
websocket_routes.py
===================
Endpoint WebSocket `/ws`.

Selección de PLC: el cliente puede conectarse a `/ws?plc=<id>` para recibir SOLO
los cambios de ese PLC (y su snapshot). Sin el parámetro, recibe todos los PLCs.

Al conectarse un cliente:
  1) Se registra en el ConnectionManager (con su filtro de PLC si lo indicó).
  2) Se le envía un SNAPSHOT (completo o del PLC elegido).
  3) A partir de ahí recibe, en tiempo real, los cambios difundidos por los
     handlers, ya filtrados por su PLC si corresponde.
"""
from __future__ import annotations

import logging
from typing import Optional

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

logger = logging.getLogger("websocket_routes")

router = APIRouter()


@router.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket, plc: Optional[str] = None) -> None:
    manager = websocket.app.state.manager
    plc_manager = websocket.app.state.plc_manager

    # Registrar con filtro de PLC (None = todos).
    await manager.connect(websocket, plc_filter=plc)
    try:
        # Snapshot inicial (completo o solo del PLC elegido).
        await manager.send_personal(
            plc_manager.build_snapshot_message(plc), websocket
        )
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        await manager.disconnect(websocket)
    except Exception as exc:  # noqa: BLE001
        logger.warning("Error en la conexión WS: %s", exc)
        await manager.disconnect(websocket)
