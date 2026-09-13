# -*- coding: utf-8 -*-
"""
internas_routes.py
==================
Dar de alta y de baja variables INTERNAS del HMI.

    GET    /internas             -> las que hay, con su valor de ahora
    POST   /internas             -> crear una                [Administradores]
    PATCH  /internas/{nombre}    -> cambiar su descripción    [Administradores]
    DELETE /internas/{nombre}    -> quitarla                  [Administradores]

QUÉ NO ESTÁ AQUÍ, Y A PROPÓSITO: FORZAR EL VALOR
------------------------------------------------
Eso va por `POST /escritura`, con `plc_id: "interno"`, que es el mismo sitio
por donde se escribe en un PLC. No es una rareza: es lo que hace que un botón,
un campo E/A o un widget importado puedan mover una variable interna sin una
línea de código nueva. Un endpoint aparte habría significado que el widget
tuviera que saber a cuál de los dos llamar, y el día que alguien lo olvidara
funcionaría con los tags del PLC y no con los internos.

De la escritura se ocupa `PlcManager.escribir_tags`, así que las internas
heredan la conversión de tipo, la auditoría de quién cambió qué y el rol de
escritura. Lo único que NO se les aplica es la lista blanca: ver la nota en
`plc_manager.py`.

ALTA Y BAJA PIDEN ADMINISTRADOR; FORZAR, NO
-------------------------------------------
Son dos cosas distintas. Crear una variable es tocar la estructura del
proyecto —como añadir una pantalla—, y quien lo haga tiene que saber que hay
widgets colgando de ese nombre. Forzar un valor es operar, y lo hace quien
opera.
"""
from __future__ import annotations

import logging
from typing import Any, Optional

from fastapi import APIRouter, Body, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from app.api.auth_routes import exigir_rol, usuario_de
from app.core.auth_manager import Sesion
from app.db.internas_store import TIPOS, ErrorInterna

logger = logging.getLogger("internas_routes")

router = APIRouter(tags=["Variables internas"])

TAG = ["Variables internas"]


def _store(request: Request):
    store = getattr(request.app.state, "internas_store", None)
    if store is None:
        raise HTTPException(503, "El almacén de variables internas no está listo.")
    return store


def _handler(request: Request):
    return getattr(request.app.state, "internas_handler", None)


async def _avisar(request: Request) -> None:
    """
    Difunde el catálogo nuevo.

    Al crear o borrar hay que mandar el snapshot ENTERO: los navegadores
    arman su lista de variables con él, así que una recién creada no
    existiría para ellos —y una borrada seguiría existiendo— hasta que
    alguien recargara la página.
    """
    h = _handler(request)
    pm = getattr(request.app.state, "plc_manager", None)
    if h is not None and pm is not None:
        await h.avisar_catalogo(pm)


def _auditar(request: Request, accion: str, sesion, detalle: dict) -> None:
    # Misma firma que en el resto de rutas (ver escritura_routes): el auditor
    # saca el usuario de la sesión, no se le pasa aparte.
    aud = getattr(request.app.state, "auditoria", None)
    if aud is not None:
        aud.registrar(accion, recurso="internas", detalle=detalle, sesion=sesion)


class NuevaInterna(BaseModel):
    nombre: str = Field(
        ..., examples=["modo_manual"],
        description="Empieza por letra; letras, dígitos y guion bajo. Es la "
                    "identidad de la variable y NO se puede cambiar después: "
                    "los widgets la guardan como `interno|<nombre>`.")
    tipo: str = Field(
        ..., examples=["bool"],
        description=f"Uno de: {', '.join(TIPOS)}.")
    valor: Optional[Any] = Field(
        default=None,
        description="Valor inicial. Si se omite: false, 0, 0.0 o cadena vacía.")
    descripcion: str = Field(default="", examples=["Modo manual de la línea 1"])


class CambioInterna(BaseModel):
    descripcion: str = Field(default="")


# ====================================================================== #
@router.get(
    "/internas",
    tags=TAG,
    summary="Listar las variables internas",
    description="Con su valor actual. No pide sesión: es la misma información "
                "que ya viaja por el WebSocket a cualquier panel abierto.",
)
async def listar(request: Request) -> dict:
    variables = _store(request).listar()
    return {"ok": True, "variables": variables, "num": len(variables)}


@router.post(
    "/internas",
    tags=TAG,
    summary="Crear una variable interna",
    dependencies=[Depends(exigir_rol("Administradores"))],
    responses={
        400: {"description": "Nombre inválido, tipo desconocido o valor que no encaja."},
        409: {"description": "Ya existe una variable con ese nombre."},
    },
)
async def crear(
    request: Request,
    cuerpo: NuevaInterna = Body(..., examples=[{
        "nombre": "modo_manual", "tipo": "bool", "valor": False,
        "descripcion": "Modo manual de la línea 1"}]),
    sesion: Optional[Sesion] = Depends(exigir_rol("Administradores")),
) -> dict:
    try:
        v = _store(request).crear(
            cuerpo.nombre, cuerpo.tipo, cuerpo.valor,
            cuerpo.descripcion, usuario_de(sesion))
    except ErrorInterna as exc:
        # "Ya existe" es un conflicto, no una petición mal formada: la
        # diferencia le importa a quien automatice esto contra la API.
        codigo = 409 if "Ya existe" in str(exc) else 400
        raise HTTPException(codigo, str(exc))

    _auditar(request, "interna.creada", sesion,
             {"nombre": v["nombre"], "tipo": v["tipo"]})
    await _avisar(request)
    return {"ok": True, "variable": v}


@router.patch(
    "/internas/{nombre}",
    tags=TAG,
    summary="Cambiar la descripción",
    dependencies=[Depends(exigir_rol("Administradores"))],
    description="Solo la descripción. El NOMBRE y el TIPO no se tocan: el "
                "nombre es la identidad (los widgets guardan `interno|<x>`) y "
                "el tipo decide qué widgets la aceptan. Para cambiar "
                "cualquiera de los dos hay que crear otra y borrar esta, que "
                "obliga a repasar qué queda enlazado.",
    responses={404: {"description": "No existe esa variable."}},
)
async def describir(
    request: Request,
    nombre: str,
    cuerpo: CambioInterna,
    sesion: Optional[Sesion] = Depends(exigir_rol("Administradores")),
) -> dict:
    try:
        v = _store(request).describir(nombre, cuerpo.descripcion, usuario_de(sesion))
    except KeyError:
        raise HTTPException(404, f"No existe la variable interna '{nombre}'.")
    _auditar(request, "interna.descrita", sesion, {"nombre": nombre})
    return {"ok": True, "variable": v}


@router.delete(
    "/internas/{nombre}",
    tags=TAG,
    summary="Quitar una variable interna",
    dependencies=[Depends(exigir_rol("Administradores"))],
    description="Los widgets que la tuvieran enlazada se quedan sin lectura y "
                "pintarán «—». No se comprueba quién la usa: el diseño vive "
                "en otro sitio y recorrerlo entero a cada borrado sería caro "
                "y, aun así, no cubriría los proyectos exportados.",
    responses={404: {"description": "No existe esa variable."}},
)
async def borrar(
    request: Request,
    nombre: str,
    sesion: Optional[Sesion] = Depends(exigir_rol("Administradores")),
) -> dict:
    try:
        _store(request).borrar(nombre)
    except KeyError:
        raise HTTPException(404, f"No existe la variable interna '{nombre}'.")
    _auditar(request, "interna.borrada", sesion, {"nombre": nombre})
    await _avisar(request)
    return {"ok": True, "mensaje": f"Variable interna '{nombre}' eliminada."}
