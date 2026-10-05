# -*- coding: utf-8 -*-
"""
runtime_routes.py
=================
El proyecto que ven los VISORES.

  GET /runtime   -> qué proyecto está en pantalla y por qué pantalla arranca
  PUT /runtime   -> publicar otro proyecto            [Administradores, ver abajo]

Cada cambio termina en un broadcast `{"type": "runtime.changed", ...}`: los
visores lo escuchan y cambian de proyecto al instante, sin recargar.

QUIÉN PUEDE PUBLICAR
--------------------
Desde el equipo SERVIDOR, cualquier Administrador (es lo que hace el
Diseñador al abrir un proyecto). Desde otra IP hace falta ser Supervisor: un
Administrador que abra el Diseñador en un visor no debe cambiar lo que ven
los demás puestos solo por mirar otro proyecto. La distinción local/remoto la
hace `app/api/origen.py`, con la IP real del socket, no con cabeceras.
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from app.api.auth_routes import exigir_rol, sesion_actual, usuario_de
from app.api.origen import es_local
from app.core.auth_manager import Sesion, tiene_permiso

logger = logging.getLogger("runtime_routes")

router = APIRouter()


def _ahora_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _runtime(request: Request):
    return request.app.state.runtime_store


def _proyectos(request: Request):
    return request.app.state.proyecto_store


def _pantallas(request: Request):
    return request.app.state.project_store


def describir_runtime(request: Request) -> dict:
    """
    El documento que reciben los visores, tanto por GET como por WebSocket.

    Lleva el nombre del proyecto y sus pantallas para que la vista pueda
    abrir la primera con UNA sola petición: al cambiar de proyecto, diez
    visores a la vez pidiendo `/proyectos` y `/pantallas` por separado es
    justo el pico que no hace falta.
    """
    doc = _runtime(request).obtener()
    pid = doc["proyecto_id"]
    proyecto = _proyectos(request).obtener(pid)
    pantallas = _pantallas(request).listar(pid) if proyecto else []
    return {
        "proyecto_id": pid,
        "nombre": (proyecto or {}).get("nombre", pid),
        "existe": proyecto is not None,
        "pantallas": pantallas,
        "publicado_por": doc.get("publicado_por", ""),
        "publicado_en": doc.get("publicado_en", ""),
    }


async def difundir_runtime(request: Request, por: str = "",
                           motivo: str = "publicado") -> None:
    await request.app.state.manager.broadcast({
        "timestamp": _ahora_iso(),
        "type": "runtime.changed",
        "por": por,
        "motivo": motivo,
        **describir_runtime(request),
    })


class PublicarRuntime(BaseModel):
    proyecto_id: str = Field(..., min_length=1, max_length=64)


@router.get(
    "/runtime",
    tags=["Runtime"],
    summary="Qué proyecto está en pantalla para los visores",
    description="Es lo que abre la vista de un visor nada más entrar. Incluye "
                "las pantallas del proyecto para no tener que pedirlas aparte.",
)
async def obtener_runtime(request: Request) -> dict:
    return {"ok": True, **describir_runtime(request)}


@router.put(
    "/runtime",
    tags=["Runtime"],
    summary="Publicar el proyecto que ven los visores",
    description="Lo llama el Diseñador del servidor al abrir un proyecto. "
                "Desde otra IP exige Supervisor.",
    responses={
        403: {"description": "Desde un visor hace falta ser Supervisor."},
        404: {"description": "No existe ese proyecto."},
    },
)
async def publicar_runtime(
    request: Request,
    cuerpo: PublicarRuntime,
    sesion: Optional[Sesion] = Depends(exigir_rol("Administradores")),
) -> dict:
    if not es_local(request):
        if sesion is None or not tiene_permiso(sesion.categoria, "Supervisor"):
            raise HTTPException(
                403,
                "Cambiar el proyecto que ven los visores desde otro equipo "
                "solo puede hacerlo un Supervisor. Desde el equipo servidor "
                "basta con abrirlo en el Diseñador.",
            )
    if not _proyectos(request).existe(cuerpo.proyecto_id):
        raise HTTPException(404, f"No existe el proyecto '{cuerpo.proyecto_id}'.")

    antes = _runtime(request).proyecto_id
    try:
        doc = await _runtime(request).publicar(cuerpo.proyecto_id,
                                               usuario_de(sesion))
    except ValueError as exc:
        raise HTTPException(400, str(exc))

    cambio = doc["proyecto_id"] != antes
    if cambio:
        aud = getattr(request.app.state, "auditoria", None)
        if aud is not None:
            aud.registrar("runtime.publicado", recurso=doc["proyecto_id"],
                          detalle={"anterior": antes}, sesion=sesion)
        await difundir_runtime(request, usuario_de(sesion))
    return {"ok": True, "cambio": cambio, **describir_runtime(request)}
