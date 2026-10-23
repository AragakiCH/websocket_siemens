# -*- coding: utf-8 -*-
"""
constantes_routes.py
====================
Las constantes de los faceplates, por HTTP. Qué son y por qué se publican
como tags está en `app/core/constantes_store.py`.

  GET    /constantes?faceplate=<id>     las de un tipo de faceplate (o todas)
  POST   /constantes                    crear una            [Administradores]
  PATCH  /constantes/{id}               cambiar nombre/valor [Administradores]
  DELETE /constantes/{id}               borrar               [Administradores]
  GET    /constantes/{id}/usos          dónde está asignada (para avisar al borrar)

Crear y editar es de Administradores, como diseñar pantallas: una constante
es parte del diseño del faceplate, no del manejo de la planta.
"""
from __future__ import annotations

import logging
from typing import Any, Dict, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field

from app.api.auth_routes import exigir_rol, usuario_de
from app.core.auth_manager import Sesion
from app.core.constantes_store import ErrorConstante

logger = logging.getLogger("constantes_routes")

router = APIRouter()
TAG = ["Constantes de faceplate"]


def _store(request: Request):
    store = getattr(request.app.state, "constantes_store", None)
    if store is None:
        raise HTTPException(503, "Las constantes no están disponibles.")
    return store


def _error(exc: ErrorConstante) -> HTTPException:
    return HTTPException(exc.codigo, exc.mensaje)


async def _difundir(request: Request, constante=None, accion: str = "",
                    sesion: Optional[Sesion] = None) -> None:
    """
    Avisa a las vistas abiertas. Nunca lanza: lo guardado ya está guardado.

      * el VALOR, como si viniera de un PLC (los faceplates abiertos se
        actualizan al instante);
      * el SNAPSHOT completo, para que una constante BORRADA desaparezca (un
        mensaje de valor no puede quitar un tag);
      * `config.updated` · `constantes`, para que los desplegables del
        Inspector vuelvan a pedir la lista.
    """
    manager = request.app.state.manager
    try:
        if constante is not None:
            await manager.broadcast(constante.como_mensaje())
        pm = getattr(request.app.state, "plc_manager", None)
        if pm is not None:
            await manager.broadcast(pm.build_snapshot_message())
    except Exception as exc:  # noqa: BLE001
        logger.warning("No se pudo difundir la constante: %s", exc)
    try:
        await manager.difundir_config("constantes", usuario_de(sesion), accion)
    except Exception:  # noqa: BLE001
        pass


def _auditar(request: Request, accion: str, sesion, detalle: dict) -> None:
    aud = getattr(request.app.state, "auditoria", None)
    if aud is not None:
        aud.registrar(f"constantes.{accion}", recurso="constantes",
                      detalle=detalle, sesion=sesion)


class NuevaConstante(BaseModel):
    faceplate: str = Field(..., min_length=1, max_length=200,
                           description="`project_id` del tipo de faceplate.")
    nombre: str = Field(..., min_length=1, max_length=60,
                        examples=["Velocidad nominal"])
    tipo: str = Field(..., description="`bool` | `int` | `double` | `string`",
                      examples=["double"])
    valor: Any = Field(default=None, examples=[1450])


class CambioConstante(BaseModel):
    model_config = {"extra": "forbid"}
    nombre: Optional[str] = Field(default=None, max_length=60)
    valor: Any = None


@router.get("/constantes", tags=TAG, summary="Listar las constantes")
async def listar(
    request: Request,
    faceplate: Optional[str] = Query(default=None,
                                     description="Solo las de este tipo de faceplate."),
    _sesion: Optional[Sesion] = Depends(exigir_rol("Invitado")),
) -> dict:
    lista = _store(request).listar(faceplate)
    return {"ok": True, "total": len(lista), "constantes": lista}


@router.post("/constantes", tags=TAG, summary="Crear una constante")
async def crear(
    request: Request,
    cuerpo: NuevaConstante,
    sesion: Sesion = Depends(exigir_rol("Administradores")),
) -> dict:
    try:
        c = _store(request).crear(cuerpo.model_dump())
    except ErrorConstante as exc:
        raise _error(exc)
    await _difundir(request, c, "creada", sesion)
    _auditar(request, "creada", sesion,
             {"id": c.id, "nombre": c.nombre, "tipo": c.tipo, "valor": c.valor,
              "faceplate": c.faceplate})
    return {"ok": True, "constante": c.como_fila()}


@router.patch("/constantes/{id_}", tags=TAG, summary="Cambiar nombre o valor")
async def actualizar(
    request: Request,
    id_: str,
    cuerpo: CambioConstante,
    sesion: Sesion = Depends(exigir_rol("Administradores")),
) -> dict:
    store = _store(request)
    try:
        antes = store.obtener(id_).como_fila()
        c = store.actualizar(id_, cuerpo.model_dump(exclude_unset=True))
    except ErrorConstante as exc:
        raise _error(exc)
    await _difundir(request, c, "actualizada", sesion)
    _auditar(request, "actualizada", sesion,
             {"id": c.id, "antes": {"nombre": antes["nombre"], "valor": antes["valor"]},
              "ahora": {"nombre": c.nombre, "valor": c.valor}})
    return {"ok": True, "constante": c.como_fila()}


@router.get("/constantes/{id_}/usos", tags=TAG,
            summary="Dónde está asignada una constante")
async def usos(
    request: Request,
    id_: str,
    _sesion: Optional[Sesion] = Depends(exigir_rol("Invitado")),
) -> dict:
    try:
        c = _store(request).obtener(id_)
    except ErrorConstante as exc:
        raise _error(exc)
    proyectos = getattr(request.app.state, "project_store", None)
    lista = []
    if proyectos is not None:
        try:
            lista = await proyectos.buscar_referencia(c.clave)
        except Exception as exc:  # noqa: BLE001
            logger.warning("No se pudieron buscar los usos de %s: %s", id_, exc)
    return {
        "ok": True,
        "widgets": sum(x["widgets"] for x in lista),
        "pantallas": [x["nombre"] for x in lista],
    }


@router.delete("/constantes/{id_}", tags=TAG, summary="Borrar una constante")
async def borrar(
    request: Request,
    id_: str,
    sesion: Sesion = Depends(exigir_rol("Administradores")),
) -> Dict[str, Any]:
    try:
        c = _store(request).borrar(id_)
    except ErrorConstante as exc:
        raise _error(exc)
    await _difundir(request, None, "borrada", sesion)
    _auditar(request, "borrada", sesion,
             {"id": c.id, "nombre": c.nombre, "faceplate": c.faceplate})
    return {"ok": True}
