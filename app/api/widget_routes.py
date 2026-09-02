# -*- coding: utf-8 -*-
"""
widget_routes.py
================
Widgets personalizados importados desde `.zip`.

  GET    /widgets            -> catálogo (sin contenido, para el selector).
  GET    /widgets/{kind}     -> el widget completo (html + css + js).
  PUT    /widgets/{kind}     -> crear o actualizar (lo llama la importación).
  DELETE /widgets/{kind}     -> quitarlo del catálogo.

**Por qué existen estos endpoints.** Antes la definición del widget vivía solo
en `localStorage`, y eso se rompía de tres formas: al cerrar la aplicación de
escritorio, al abrir la vista previa en otro navegador, y en cuanto había más
de un usuario. `localStorage` es privado del navegador por definición; la
fuente de verdad tiene que estar en el servidor.
"""
from __future__ import annotations

import logging
from typing import Any, Dict, Optional

from fastapi import APIRouter, Body, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field

from app.api.auth_routes import exigir_rol, usuario_de
from app.core.auth_manager import Sesion

logger = logging.getLogger("widget_routes")

router = APIRouter()
TAG = ["Widgets personalizados"]


def _store(request: Request):
    store = getattr(request.app.state, "widget_store", None)
    if store is None:
        raise HTTPException(503, "El almacén de widgets no está disponible.")
    return store


class WidgetEntrada(BaseModel):
    """Cuerpo de PUT /widgets/{kind}."""

    nombre: str = Field(
        default="", description="Nombre legible que se ve en el catálogo.")
    html: str = Field(
        ...,
        description="Contenido de `widget.html`. Obligatorio: sin HTML no hay "
                    "nada que dibujar.")
    css: str = Field(default="", description="Contenido de `widget.css`.")
    js: str = Field(default="", description="Contenido de `widget.js`.")
    meta: Dict[str, Any] = Field(
        default_factory=dict,
        description="Lo que venga en `widget.json`: categoría, tipo de dato "
                    "esperado, variables declaradas…")


@router.get(
    "/widgets",
    tags=TAG,
    summary="Listar widgets personalizados",
    description="Catálogo de los widgets importados desde `.zip`.\n\n"
                "Por defecto **no incluye el contenido** (HTML/CSS/JS): con "
                "varios widgets serían megas en cada carga del diseñador. "
                "Usa `?con_contenido=true` cuando de verdad haga falta todo, "
                "o pide uno concreto con `GET /widgets/{kind}`.",
    responses={200: {"content": {"application/json": {"example": {
        "num_widgets": 1,
        "widgets": [{
            "kind": "transportador-rodillos",
            "nombre": "Transportador de Rodillos",
            "meta": {"categoria": "EQUIPOS", "tipo_dato": "bool"},
            "bytes": 4820,
            "creado_en": "2026-09-01T18:40:11+00:00",
            "actualizado_en": "2026-09-01T18:40:11+00:00",
            "creado_por": "admin",
        }],
    }}}}},
)
async def listar(
    request: Request,
    con_contenido: bool = Query(
        default=False,
        description="Incluir html/css/js de cada widget."),
) -> dict:
    store = _store(request)
    return {
        "num_widgets": len(store.widgets),
        "widgets": store.listar(con_contenido=con_contenido),
    }


@router.get(
    "/widgets/{kind}",
    tags=TAG,
    summary="Obtener un widget completo",
    description="Devuelve el widget con su HTML, CSS y JS. Es lo que carga el "
                "renderizador para dibujarlo, tanto en el diseñador como en "
                "la vista previa.",
    responses={404: {"description": "No existe ese widget."}},
)
async def obtener(request: Request, kind: str) -> dict:
    widget = _store(request).obtener(kind)
    if widget is None:
        raise HTTPException(404, f"No existe el widget '{kind}'.")
    return {"ok": True, "widget": widget.publico()}


@router.put(
    "/widgets/{kind}",
    tags=TAG,
    summary="Crear o actualizar un widget",
    description="Guarda la definición en el servidor. Lo llama el diseñador "
                "al importar un `.zip`.\n\n"
                "Si el `kind` ya existe se actualiza, conservando la fecha de "
                "creación y quién lo importó. Así reimportar una versión "
                "corregida del mismo widget no duplica nada.",
    responses={
        200: {"content": {"application/json": {"example": {
            "ok": True, "kind": "transportador-rodillos", "bytes": 4820,
            "mensaje": "Widget 'transportador-rodillos' guardado."}}}},
        400: {"description": "Identificador inválido, sin HTML, o demasiado grande."},
    },
)
async def guardar(
    request: Request,
    kind: str,
    sesion: Sesion = Depends(exigir_rol("Administradores")),
    cuerpo: WidgetEntrada = Body(..., examples=[{
        "nombre": "Transportador de Rodillos",
        "html": "<svg viewBox='0 0 200 80'>…</svg>",
        "css": ".rodillo { fill: var(--color-principal); }",
        "js": "",
        "meta": {"categoria": "EQUIPOS", "tipo_dato": "bool"},
    }]),
) -> dict:
    try:
        widget = _store(request).guardar(
            kind=kind, nombre=cuerpo.nombre, html=cuerpo.html,
            css=cuerpo.css, js=cuerpo.js, meta=cuerpo.meta,
            usuario=usuario_de(sesion),
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc))

    await _avisar(request, sesion, "guardado")
    return {"ok": True, "kind": widget.kind, "bytes": widget.tamano(),
            "mensaje": f"Widget '{widget.kind}' guardado."}


@router.delete(
    "/widgets/{kind}",
    tags=TAG,
    summary="Borrar un widget",
    description="Lo quita del catálogo.\n\n"
                "**No toca los diseños que lo usen**: sus cajas se quedan en "
                "el lienzo pero sin definición. Es deliberado — borrar de "
                "golpe widgets de pantallas en producción sería mucho más "
                "destructivo que dejar un hueco visible que se puede "
                "corregir.",
    responses={404: {"description": "No existe ese widget."}},
)
async def borrar(
    request: Request,
    kind: str,
    sesion: Sesion = Depends(exigir_rol("Administradores")),
) -> dict:
    if not _store(request).borrar(kind):
        raise HTTPException(404, f"No existe el widget '{kind}'.")
    await _avisar(request, sesion, "borrado")
    return {"ok": True, "kind": kind, "mensaje": f"Widget '{kind}' eliminado."}


async def _avisar(request: Request, sesion, accion: str) -> None:
    """
    Difunde `config.updated` para que las demás pantallas recarguen el
    catálogo. Sin esto, quien tuviera el diseñador abierto seguiría sin ver
    el widget que otro acaba de importar.
    """
    try:
        await request.app.state.manager.difundir_config(
            "widgets", usuario_de(sesion), accion)
    except Exception:  # noqa: BLE001
        pass
