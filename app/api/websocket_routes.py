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

EL CANAL DEJÓ DE SER DE SOLO LECTURA
------------------------------------
Durante mucho tiempo el bucle `receive_text()` solo drenaba lo que llegara:
todas las mutaciones iban por REST, donde hay validación y permisos. Ese
comentario terminaba diciendo que el día que el HMI escribiera en el PLC habría
que reconsiderarlo, "y ese día la identidad y la auditoría dejan de ser
opcionales".

Ese día llegó. Ahora se acepta UN solo comando, `write`, para que un botón o un
deslizador no tengan que abrir una petición HTTP por cada movimiento. Y se
aceptó la deuda que anunciaba aquel comentario:

  * La escritura por WS pasa por las MISMAS comprobaciones que `POST
    /escritura`: rol, lista blanca, rangos, tipos y auditoría. No hay un camino
    "rápido" que se salte nada — sería el atajo por donde entrarían los fallos.

  * Aquí la sesión es OBLIGATORIA aunque `auth_requerida` sea False. El REST se
    permite pasar sin sesión en modo arranque para poder crear la primera
    cuenta; escribir en un PLC nunca forma parte de configurar el sistema, así
    que esa excepción no aplica.

Cualquier otro mensaje se ignora en silencio, como antes.
"""
from __future__ import annotations

import json
import logging
from typing import Optional

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from app.core.auth_manager import tiene_permiso
from app.core.escritura_store import ErrorDeRango, TagNoEscribible
from app.drivers.escritura import ErrorDeTipo

logger = logging.getLogger("websocket_routes")

router = APIRouter()

# Mismo rol que exige POST /escritura. Si algún día cambia, tiene que cambiar
# en los dos sitios: por eso se importa de allí y no se escribe otra vez.
from app.api.escritura_routes import ROL_ESCRITURA  # noqa: E402


async def _atender_escritura(websocket: WebSocket, msg: dict,
                             datos_usuario: Optional[dict]) -> None:
    """
    Procesa un mensaje `{"tipo": "write", ...}`.

    Responde SIEMPRE al que lo pidió, también cuando falla: un botón que no
    recibe respuesta se queda "pulsando" para siempre, y quien está delante no
    sabe si el valor llegó al PLC o no. Un `id` opcional viaja de vuelta para
    que el frontend case la respuesta con la petición que la originó.
    """
    eco = {"tipo": "write.result", "id": msg.get("id")}

    async def responder(**extra) -> None:
        await websocket.send_text(json.dumps({**eco, **extra}))

    # ---- Identidad: aquí no hay modo arranque que valga ---------------
    if datos_usuario is None:
        await responder(ok=False, error="Necesitas iniciar sesión para "
                                        "escribir en el PLC.")
        return
    if not tiene_permiso(datos_usuario.get("categoria", ""), ROL_ESCRITURA):
        await responder(
            ok=False,
            error=f"Tu categoría ('{datos_usuario.get('categoria')}') no "
                  f"permite escribir en el PLC. Hace falta al menos "
                  f"'{ROL_ESCRITURA}'.")
        return

    # Se admite un tag suelto o una lista, para no obligar al frontend a
    # envolver cada pulsación de botón en un array de uno.
    escrituras = msg.get("escrituras")
    if escrituras is None:
        if msg.get("tag") is None:
            await responder(ok=False, error="Falta 'tag' o 'escrituras'.")
            return
        escrituras = [{"plc_id": msg.get("plc_id"), "tag": msg.get("tag"),
                       "valor": msg.get("valor")}]

    app = websocket.app
    usuario = datos_usuario.get("usuario", "")
    try:
        resultado = await app.state.plc_manager.escribir_tags(
            escrituras, usuario=usuario,
            permitidos=getattr(app.state, "escritura_store", None))
    except (TagNoEscribible, PermissionError) as exc:
        await responder(ok=False, error=str(exc), codigo="denegado")
        _auditar_ws(app, "plc.escritura.denegada", datos_usuario,
                    {"escrituras": escrituras, "motivo": str(exc)}, "denegado")
        return
    except (ErrorDeRango, ErrorDeTipo, ValueError) as exc:
        await responder(ok=False, error=str(exc), codigo="invalido")
        return
    except KeyError as exc:
        await responder(ok=False, error=str(exc).strip("'\""), codigo="no_existe")
        return
    except (ConnectionError, NotImplementedError) as exc:
        await responder(ok=False, error=str(exc), codigo="sin_conexion")
        return
    except Exception as exc:  # noqa: BLE001
        logger.exception("Error inesperado escribiendo por WS")
        await responder(ok=False, error=str(exc), codigo="error")
        return

    _auditar_ws(app, "plc.escritura" if resultado.get("ok") else
                "plc.escritura.fallida", datos_usuario,
                {"resultados": resultado.get("resultados"),
                 "fallo_en": resultado.get("fallo_en"),
                 "revertidos": resultado.get("revertidos"),
                 "via": "websocket"},
                "ok" if resultado.get("ok") else "error")
    await responder(**resultado)


def _auditar_ws(app, accion: str, datos_usuario: Optional[dict],
                detalle: dict, resultado: str) -> None:
    aud = getattr(app.state, "auditoria", None)
    if aud is None:
        return
    aud.registrar(accion, usuario=(datos_usuario or {}).get("usuario", ""),
                  recurso="escritura", detalle=detalle, resultado=resultado)


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
            crudo = await websocket.receive_text()

            # El canal admite UN comando. Todo lo demás se descarta como
            # siempre: un JSON mal formado o un mensaje que no reconocemos no
            # puede tumbar la conexión de datos de un HMI en marcha.
            try:
                msg = json.loads(crudo)
            except (ValueError, TypeError):
                continue
            if not isinstance(msg, dict):
                continue

            if msg.get("tipo") == "write":
                await _atender_escritura(websocket, msg, datos_usuario)
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
