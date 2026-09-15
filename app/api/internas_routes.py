# -*- coding: utf-8 -*-
"""
internas_routes.py
==================
Variables internas: las que viven en el servidor y no en ningún PLC.

    GET    /internas              listar
    POST   /internas              crear
    PATCH  /internas/{nombre}     cambiar nombre, tipo, rango, descripción
    PUT    /internas/{nombre}/valor   forzar el valor          <- el del día a día
    DELETE /internas/{nombre}     borrar

POR QUÉ EL VALOR TIENE SU PROPIO ENDPOINT
-----------------------------------------
Cambiar el valor y cambiar la definición son dos actos distintos, y mezclarlos
en un solo PATCH obligaría a darle a un operario el permiso de reescribir el
tipo de la variable para que pudiera mover un interruptor. Separados, forzar
un valor exige `Usuarios` y tocar la definición exige `Administradores`.

QUÉ PASA AL CAMBIAR UN VALOR
----------------------------
Se difunde por el MISMO WebSocket y con el MISMO formato de mensaje que un
cambio venido de un PLC. Por eso un widget enlazado a `interno|nivel` se
actualiza solo, en todos los paneles a la vez, sin que nadie haya escrito una
línea para ello: para el widget no hay diferencia entre esto y una lectura de
un S7-1500.
"""
from __future__ import annotations

import logging
from typing import Any, Dict, Optional

from fastapi import APIRouter, Body, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from app.api.auth_routes import exigir_rol, usuario_de
from app.core.auth_manager import Sesion
from app.core.internas_store import TIPOS, ErrorInterna

logger = logging.getLogger("internas_routes")

router = APIRouter()
TAG = ["Variables internas"]


def _store(request: Request):
    store = getattr(request.app.state, "internas_store", None)
    if store is None:
        raise HTTPException(503, "Las variables internas no están disponibles.")
    return store


def _error(exc: ErrorInterna) -> HTTPException:
    return HTTPException(exc.codigo, exc.mensaje)


async def _difundir_valor(request: Request, variable) -> None:
    """
    Publica el cambio como si viniera de un PLC.

    Un fallo aquí NO puede tumbar la petición: el valor ya está guardado, y
    que un panel tarde en enterarse es mucho menos grave que devolver un
    error por algo que sí se hizo.
    """
    try:
        await request.app.state.manager.broadcast(variable.como_mensaje())
    except Exception as exc:  # noqa: BLE001
        logger.warning("No se pudo difundir %s: %s", variable.nombre, exc)


def _auditar(request: Request, accion: str, sesion, detalle: dict) -> None:
    aud = getattr(request.app.state, "auditoria", None)
    if aud is not None:
        aud.registrar(f"internas.{accion}", recurso="internas",
                      detalle=detalle, sesion=sesion)


# ====================================================================== #
class NuevaInterna(BaseModel):
    nombre: str = Field(
        ...,
        description="Se normaliza solo: «Nivel Depósito 1» queda "
                    "`nivel_deposito_1`. Es lo que va después de `interno|`.",
        examples=["modo_manual"],
    )
    tipo: str = Field(
        default="bool",
        description=" | ".join(f"`{k}` ({v['etiqueta']})" for k, v in TIPOS.items()),
        examples=["bool"],
    )
    descripcion: str = Field(default="", examples=["Para qué sirve"])
    unidad: str = Field(default="", description="Solo numéricas.", examples=["°C"])
    minimo: Optional[float] = Field(default=None, description="Solo numéricas.")
    maximo: Optional[float] = Field(default=None, description="Solo numéricas.")
    valor_inicial: Any = Field(
        default=None,
        description="Con qué arranca. Si no se indica, el valor vacío del tipo.")
    retentiva: bool = Field(
        default=True,
        description="`true` = el valor sobrevive al reiniciar el servicio. "
                    "`false` = vuelve al inicial. Ponlo en `false` para "
                    "estados que dejan de ser ciertos si algo se reinició, "
                    "como «modo mantenimiento».")


class CambioInterna(BaseModel):
    """Todo opcional: se cambia solo lo que se manda."""

    model_config = {"extra": "forbid"}

    nombre: Optional[str] = None
    tipo: Optional[str] = None
    descripcion: Optional[str] = None
    unidad: Optional[str] = None
    minimo: Optional[float] = None
    maximo: Optional[float] = None
    valor_inicial: Any = None
    retentiva: Optional[bool] = None


# ====================================================================== #
@router.get(
    "/internas",
    tags=TAG,
    summary="Listar las variables internas",
    description="Devuelve también `tipos`, con la etiqueta de cada tipo, para "
                "que la vista construya el desplegable sin tenerlos escritos "
                "a mano.",
    responses={200: {"content": {"application/json": {"example": {
        "ok": True, "total": 2,
        "variables": [{
            "nombre": "modo_manual", "tipo": "bool",
            "descripcion": "Bloquea los automatismos", "unidad": "",
            "minimo": None, "maximo": None, "valor": False,
            "valor_inicial": False, "retentiva": False,
            "creado_en": "2026-09-14T10:00:00+00:00",
            "actualizado_en": "2026-09-14T10:21:00+00:00",
        }],
        "tipos": {"bool": "Sí / no", "int": "Entero",
                  "double": "Decimal", "string": "Texto"},
    }}}}},
)
async def listar(request: Request) -> dict:
    store = _store(request)
    variables = store.listar()
    return {
        "ok": True,
        "total": len(variables),
        "variables": variables,
        "tipos": {k: v["etiqueta"] for k, v in TIPOS.items()},
    }


@router.post(
    "/internas",
    tags=TAG,
    summary="Crear una variable interna",
    description="El nombre se normaliza: se pasa a minúsculas, se quitan los "
                "acentos y los espacios pasan a guiones bajos. La respuesta "
                "trae el nombre definitivo y la `clave` con la que se enlaza "
                "a un widget.",
    responses={
        409: {"description": "Ya existe una variable con ese nombre."},
        400: {"description": "Nombre o tipo no válidos."},
    },
)
async def crear(
    request: Request,
    cuerpo: NuevaInterna,
    sesion: Sesion = Depends(exigir_rol("Administradores")),
) -> dict:
    store = _store(request)
    try:
        v = store.crear(cuerpo.model_dump(exclude_unset=True))
    except ErrorInterna as exc:
        raise _error(exc)

    await _difundir_valor(request, v)
    _auditar(request, "creada", sesion, {"nombre": v.nombre, "tipo": v.tipo})
    try:
        await request.app.state.manager.difundir_config(
            "internas", usuario_de(sesion), "creada")
    except Exception:  # noqa: BLE001
        pass
    # OJO con lo que se devuelve: `como_fila()`, NUNCA `como_tag()`.
    #
    # Quien llama aqui es la pantalla de configuracion, que habla de `nombre`
    # y `tipo`. `como_tag()` es la MISMA variable vista como un tag de PLC
    # (`plc`, `tag`, `type`, `value`) y se publica por /tags y por el
    # WebSocket. Devolver una donde se espera la otra no da un error de
    # servidor: da un 200 con las claves equivocadas, y quien lo recibe se
    # rompe al leer un campo que no esta. Ya paso una vez, y el sintoma fue
    # la pantalla en negro justo despues de crear la variable.
    return {"ok": True, "variable": v.como_fila(),
            "clave": f"interno|{v.nombre}",
            "mensaje": f"Variable interna '{v.nombre}' creada."}


@router.patch(
    "/internas/{nombre}",
    tags=TAG,
    summary="Cambiar la definición de una variable",
    description="Para mover el VALOR usa `PUT /internas/{nombre}/valor`.\n\n"
                "**Renombrar rompe los enlaces existentes**: un widget "
                "apuntando a `interno|viejo` se queda sin variable, porque la "
                "clave es el nombre. La respuesta lo avisa cuando ocurre.\n\n"
                "**Cambiar el tipo reinterpreta el valor.** Si no se puede "
                "(de Texto a Decimal con «hola» dentro), se cae al valor "
                "vacío del tipo nuevo en vez de fallar.",
    responses={404: {"description": "No existe."}},
)
async def actualizar(
    request: Request,
    nombre: str,
    cuerpo: CambioInterna,
    sesion: Sesion = Depends(exigir_rol("Administradores")),
) -> dict:
    store = _store(request)
    antes = nombre
    try:
        v = store.actualizar(nombre, cuerpo.model_dump(exclude_unset=True))
    except ErrorInterna as exc:
        raise _error(exc)

    await _difundir_valor(request, v)
    _auditar(request, "editada", sesion, {"nombre": v.nombre})
    try:
        await request.app.state.manager.difundir_config(
            "internas", usuario_de(sesion), "editada")
    except Exception:  # noqa: BLE001
        pass

    salida = {"ok": True, "variable": v.como_fila(),
              "clave": f"interno|{v.nombre}",
              "mensaje": f"Variable '{v.nombre}' actualizada."}
    if v.nombre != antes:
        salida["renombrada"] = {"antes": antes, "ahora": v.nombre}
        salida["mensaje"] = (
            f"Renombrada a '{v.nombre}'. Los widgets que apuntaban a "
            f"`interno|{antes}` hay que volver a enlazarlos.")
    return salida


@router.put(
    "/internas/{nombre}/valor",
    tags=TAG,
    summary="Forzar el valor de una variable",
    description="La operación del día a día: mover un interruptor, teclear "
                "una consigna.\n\n"
                "El cambio se difunde por WebSocket con el mismo formato que "
                "un cambio venido de un PLC, así que cualquier widget "
                "enlazado se actualiza solo en todos los paneles.",
    responses={
        400: {"description": "El valor no encaja con el tipo de la variable."},
        404: {"description": "No existe."},
    },
)
async def fijar_valor(
    request: Request,
    nombre: str,
    cuerpo: Dict[str, Any] = Body(
        ..., openapi_examples={
            "encender": {"summary": "Un sí/no", "value": {"valor": True}},
            "consigna": {"summary": "Un decimal", "value": {"valor": 72.5}},
            "texto": {"summary": "Un texto", "value": {"valor": "Turno B"}},
        }),
    sesion: Sesion = Depends(exigir_rol("Usuarios")),
) -> dict:
    store = _store(request)
    if "valor" not in cuerpo:
        raise HTTPException(400, "Falta el campo 'valor'.")
    try:
        v = store.fijar_valor(nombre, cuerpo["valor"])
    except ErrorInterna as exc:
        raise _error(exc)

    await _difundir_valor(request, v)
    # A la auditoría también: forzar un valor desde el HMI es una acción sobre
    # el proceso, aunque no salga del servidor. El día que una interna mande
    # un enclavamiento, esto es lo que dice quién lo movió.
    _auditar(request, "valor", sesion,
             {"nombre": v.nombre, "valor": v.valor})
    return {"ok": True, "variable": v.como_fila(), "valor": v.valor}


@router.delete(
    "/internas/{nombre}",
    tags=TAG,
    summary="Borrar una variable interna",
    description="Los widgets enlazados a ella se quedan sin variable. No se "
                "buscan ni se avisan uno a uno a propósito: están repartidos "
                "por proyectos y pantallas que pueden no estar cargados, y "
                "una lista incompleta daría más confianza de la que merece.",
    responses={404: {"description": "No existe."}},
)
async def borrar(
    request: Request,
    nombre: str,
    sesion: Sesion = Depends(exigir_rol("Administradores")),
) -> dict:
    store = _store(request)
    try:
        store.borrar(nombre)
    except ErrorInterna as exc:
        raise _error(exc)

    _auditar(request, "borrada", sesion, {"nombre": nombre})
    try:
        await request.app.state.manager.difundir_config(
            "internas", usuario_de(sesion), "borrada")
    except Exception:  # noqa: BLE001
        pass
    return {"ok": True, "mensaje": f"Variable interna '{nombre}' eliminada."}
