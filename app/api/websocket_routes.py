# -*- coding: utf-8 -*-
"""
websocket_routes.py
===================
Endpoint WebSocket `/ws`. Es el ÚNICO canal de bajada del sistema.

Selección de PLC: el cliente puede conectarse a `/ws?plc=<id>` para recibir SOLO
los cambios de ese PLC (y su snapshot). Sin el parámetro, recibe todos los PLCs.

Identidad: `/ws?token=<token>` identifica la conexión. El token se obtiene de
`POST /auth/login`. Va en el query string y no en una cabecera porque la API de
WebSocket del navegador no permite cabeceras personalizadas al conectar.

Al conectarse un cliente:
  1) Se resuelve su sesión (si mandó token) y se registra en el
     ConnectionManager con su filtro de PLC.
  2) Se le envía un SNAPSHOT (completo o del PLC elegido).
  3) Se difunde la PRESENCIA actualizada a todos, para que las demás pantallas
     vean quién acaba de entrar.
  4) A partir de ahí recibe en tiempo real:
       - datos      : `snapshot`, `status`, y los cambios de tag sueltos
       - proyecto   : `project.updated`, `project.removed`
       - config     : `config.updated`
       - presencia  : `presence`

El bucle `receive_text()` solo drena lo que llegue: el canal es de SOLO LECTURA
a propósito. Las mutaciones van por REST, donde hay validación y control de
permisos. Cuando el HMI escriba valores al PLC habrá que reconsiderarlo, y ese
día la identidad y la auditoría dejan de ser opcionales.
"""
from __future__ import annotations

import logging
from typing import Optional

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

logger = logging.getLogger("websocket_routes")

router = APIRouter()


@router.websocket("/ws")
async def websocket_endpoint(
    websocket: WebSocket,
    plc: Optional[str] = None,
    token: Optional[str] = None,
) -> None:
    manager = websocket.app.state.manager
    plc_manager = websocket.app.state.plc_manager
    auth = getattr(websocket.app.state, "auth_manager", None)
    settings = websocket.app.state.settings

    # ---- Identidad de la conexión ---------------------------------- #
    datos_usuario = None
    if auth is not None and token:
        sesion = auth.sesion_de(token)
        if sesion is not None:
            datos_usuario = {"usuario": sesion.usuario,
                             "categoria": sesion.categoria}

    # Si se exige autenticación, un socket sin sesión válida se rechaza.
    # 1008 = "policy violation" en el protocolo WebSocket.
    #
    # Excepción: mientras el sistema no tenga NINGUNA cuenta se deja pasar.
    # Si no, la pantalla de "crear la primera cuenta" no podría ni conectarse
    # para mostrar el estado del servicio.
    if settings.auth_requerida and datos_usuario is None:
        sin_cuentas = True
        if auth is not None:
            try:
                sin_cuentas = await auth.contar() == 0
            except Exception:  # noqa: BLE001
                sin_cuentas = True
        if not sin_cuentas:
            logger.warning("WS rechazado: sin token válido y auth_requerida=True.")
            await websocket.close(code=1008, reason="Sesión requerida")
            return

    await manager.connect(websocket, plc_filter=plc, usuario=datos_usuario)
    try:
        # Snapshot inicial (completo o solo del PLC elegido).
        await manager.send_personal(
            plc_manager.build_snapshot_message(plc), websocket
        )
        # Avisar a TODOS de que hay alguien nuevo mirando.
        await manager.difundir_presencia()

        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        await manager.disconnect(websocket)
        await manager.difundir_presencia()
    except Exception as exc:  # noqa: BLE001
        logger.warning("Error en la conexión WS: %s", exc)
        await manager.disconnect(websocket)
        try:
            await manager.difundir_presencia()
        except Exception:  # noqa: BLE001
            pass
