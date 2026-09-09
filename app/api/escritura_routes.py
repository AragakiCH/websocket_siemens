# -*- coding: utf-8 -*-
"""
escritura_routes.py
===================
Escribir valores en el PLC, y decidir en qué se puede escribir.

    POST   /escritura                    escribir uno o varios tags
    GET    /escritura/permitidos         lista blanca actual
    PUT    /escritura/permitidos         habilitar un tag (o cambiar límites)
    DELETE /escritura/permitidos/{...}   deshabilitarlo
    GET    /escritura/candidatos         tags del PLC que se PODRÍAN habilitar

POR QUÉ LA ESCRITURA VA EN SU PROPIO MÓDULO
-------------------------------------------
Todo lo demás de esta API lee. Esto es lo único que mueve cosas en la planta,
y separarlo hace evidente dónde está el riesgo: al revisar permisos, auditoría
o el registro de un incidente, se mira un fichero y no siete.

TRES CANDADOS, Y NINGUNO SOBRA
------------------------------
1. ROL. Solo `Supervisor` y `Administradores`. Un operario con rol `Usuarios`
   ve la planta y opera la vista, pero no fuerza valores por la API.
2. LISTA BLANCA con rangos. El tag tiene que estar habilitado a mano. Que el
   servidor OPC UA lo declare escribible no basta: declara escribibles muchas
   más variables de las que tiene sentido tocar desde un HMI.
3. AUDITORÍA. Cada escritura queda registrada con quién, qué, valor anterior y
   valor nuevo. Si mañana hay que explicar por qué una línea se paró a las
   03:14, esto es lo que lo responde.

El tipo de dato lo valida `drivers/escritura.py` antes de salir a la red, y el
valor escrito se RELEE del PLC para confirmarlo. Un PLC puede aceptar una
escritura y guardar otra cosa.
"""
from __future__ import annotations

import logging
from typing import Any, List, Optional

from fastapi import APIRouter, Body, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field

from app.api.auth_routes import exigir_rol, usuario_de
from app.core.auth_manager import Sesion
from app.core.escritura_store import ErrorDeRango, TagNoEscribible
from app.drivers.escritura import ErrorDeTipo, es_escribible

logger = logging.getLogger("escritura_routes")

router = APIRouter()
TAG = ["Escritura en el PLC"]

# Los dos roles que pueden mover algo en la planta.
ROL_ESCRITURA = "Administradores"


def _permitidos(request: Request):
    store = getattr(request.app.state, "escritura_store", None)
    if store is None:
        raise HTTPException(503, "El almacén de escritura no está disponible.")
    return store


def _manager(request: Request):
    m = getattr(request.app.state, "plc_manager", None)
    if m is None:
        raise HTTPException(503, "El gestor de PLCs no está disponible.")
    return m


def _auditar(request: Request, accion: str, sesion, recurso: str,
             detalle: dict, resultado: str = "ok") -> None:
    aud = getattr(request.app.state, "auditoria", None)
    if aud is not None:
        aud.registrar(accion, recurso=recurso, detalle=detalle,
                      resultado=resultado, sesion=sesion)


# ====================================================================== #
# Modelos
# ====================================================================== #
class UnaEscritura(BaseModel):
    plc_id: str = Field(..., description="Id del PLC, como en `GET /plcs`.")
    tag: str = Field(
        ...,
        description="Nombre completo del tag (`DB_snap7.setpoint_temp`) o su "
                    "`node_id`. Se aceptan los dos.")
    valor: Any = Field(
        ...,
        description="Valor a escribir. Se convierte al tipo real del tag; si "
                    "no encaja, se rechaza sin tocar el PLC.")


class PeticionEscritura(BaseModel):
    escrituras: List[UnaEscritura] = Field(
        ...,
        description="Uno o varios tags. Si son varios y alguno falla, los ya "
                    "escritos se restauran a su valor anterior.")


class TagPermitido(BaseModel):
    plc_id: str
    tag: str
    minimo: Optional[float] = Field(
        default=None,
        description="Valor mínimo admitido. `null` = sin límite inferior. "
                    "Solo aplica a tags numéricos.")
    maximo: Optional[float] = Field(default=None, description="Valor máximo admitido.")
    descripcion: str = Field(
        default="",
        description="Texto para la interfaz: «Consigna de temperatura de la "
                    "Cuba 1» dice mucho más que «DB_snap7.sp_t1».")


# ====================================================================== #
# Escribir
# ====================================================================== #
@router.post(
    "/escritura",
    tags=TAG,
    summary="Escribir uno o varios tags del PLC",
    description=
    "Escribe valores en el PLC. Funciona igual para Siemens S7-1500 y para "
    "Bosch Rexroth ctrlX: los dos hablan OPC UA por debajo.\n\n"
    "**Antes de escribir nada** se valida TODO el lote: que cada tag exista, "
    "que esté habilitado, que el valor encaje con su tipo y que respete sus "
    "límites. Si algo no cuadra, no se manda ni un paquete al PLC.\n\n"
    "**Si un tag del lote falla a mitad**, los ya escritos se restauran a su "
    "valor anterior, en orden inverso.\n\n"
    "**Cada valor se relee del PLC** después de escribirlo. El campo "
    "`coincide` dice si el PLC guardó exactamente lo que se pidió: puede que "
    "no, si un bloque del programa gobierna esa variable.",
    responses={
        200: {"content": {"application/json": {"example": {
            "ok": True, "escrituras": 1,
            "resultados": [{
                "plc_id": "siemens_1", "tag": "DB_snap7.setpoint_temp",
                "solicitado": 65, "escrito": 65.0, "confirmado": 65.0,
                "data_type": "Float", "anterior": 20.0,
                "coincide": True, "ok": True}],
            "usuario": "hugo", "timestamp": "2026-09-09T10:12:03+00:00"}}}},
        400: {"description": "Tipo de dato incorrecto o valor fuera de rango."},
        403: {"description": "El tag no está habilitado para escritura, o el PLC la rechazó."},
        404: {"description": "No existe ese PLC o ese tag."},
        409: {"description": "El PLC no está conectado."},
    },
)
async def escribir(
    request: Request,
    cuerpo: PeticionEscritura = Body(..., examples=[{
        "escrituras": [
            {"plc_id": "siemens_1", "tag": "DB_snap7.setpoint_temp", "valor": 65.0},
            {"plc_id": "siemens_1", "tag": "DB_snap7.marcha", "valor": True},
        ]}]),
    sesion: Sesion = Depends(exigir_rol(ROL_ESCRITURA)),
) -> dict:
    usuario = usuario_de(sesion)
    peticion = [e.model_dump() for e in cuerpo.escrituras]

    try:
        resultado = await _manager(request).escribir_tags(
            peticion, usuario=usuario, permitidos=_permitidos(request))
    except TagNoEscribible as exc:
        _auditar(request, "plc.escritura.denegada", sesion, "escritura",
                 {"peticion": peticion, "motivo": str(exc)}, resultado="denegado")
        raise HTTPException(403, str(exc))
    except ErrorDeRango as exc:
        _auditar(request, "plc.escritura.fuera_de_rango", sesion, "escritura",
                 {"peticion": peticion, "motivo": str(exc)}, resultado="rechazado")
        raise HTTPException(400, str(exc))
    except ErrorDeTipo as exc:
        raise HTTPException(400, str(exc))
    except KeyError as exc:
        raise HTTPException(404, str(exc).strip("'\""))
    except (ConnectionError, NotImplementedError) as exc:
        raise HTTPException(409, str(exc))
    except PermissionError as exc:
        # El PLC dijo que no. Se audita igual: un rechazo repetido del PLC es
        # una señal de que algo está mal configurado en el proyecto del autómata.
        _auditar(request, "plc.escritura.rechazada_por_plc", sesion, "escritura",
                 {"peticion": peticion, "motivo": str(exc)}, resultado="error")
        raise HTTPException(403, str(exc))
    except ValueError as exc:
        raise HTTPException(400, str(exc))

    # Se audita el ANTES y el DESPUÉS de cada tag. Sin el valor anterior, el
    # registro sirve para saber quién tocó algo, pero no para deshacerlo.
    _auditar(
        request,
        "plc.escritura" if resultado.get("ok") else "plc.escritura.fallida",
        sesion, "escritura",
        {"resultados": resultado.get("resultados"),
         "fallo_en": resultado.get("fallo_en"),
         "revertidos": resultado.get("revertidos"),
         "sin_revertir": resultado.get("sin_revertir")},
        resultado="ok" if resultado.get("ok") else "error",
    )
    return resultado


# ====================================================================== #
# Lista blanca
# ====================================================================== #
@router.get(
    "/escritura/permitidos",
    tags=TAG,
    summary="Tags habilitados para escritura",
    description="Lo único en lo que se puede escribir. Todo lo demás se "
                "rechaza con 403 aunque el PLC lo permita.",
)
async def listar_permitidos(
    request: Request,
    plc_id: str = Query(default="", description="Filtrar por PLC."),
) -> dict:
    store = _permitidos(request)
    return {"tags": store.listar(plc_id), **store.estado()}


@router.put(
    "/escritura/permitidos",
    tags=TAG,
    summary="Habilitar un tag para escritura",
    description=
    "Habilita un tag, o cambia sus límites si ya lo estaba.\n\n"
    "Los límites son la segunda red de seguridad. El tipo ya impide que un "
    "`Int16` desborde, pero que un valor QUEPA en un Int16 no significa que la "
    "máquina lo admita: 32000 cabe de sobra en una consigna de temperatura "
    "cuyo máximo real son 90 °C.\n\n"
    "En tags booleanos o de texto los límites se ignoran.",
    responses={400: {"description": "Tipo no soportado, o mínimo mayor que el máximo."},
               404: {"description": "Ese tag no existe en ese PLC."}},
)
async def habilitar(
    request: Request,
    cuerpo: TagPermitido = Body(..., examples=[{
        "plc_id": "siemens_1", "tag": "DB_snap7.setpoint_temp",
        "minimo": 40.0, "maximo": 90.0,
        "descripcion": "Consigna de temperatura · Cuba 1"}]),
    sesion: Sesion = Depends(exigir_rol(ROL_ESCRITURA)),
) -> dict:
    manager = _manager(request)

    # Se comprueba contra el PLC REAL, no se acepta a ciegas. Habilitar un tag
    # mal escrito crearía una entrada que nunca serviría para nada, y el error
    # solo aparecería el día que alguien intentara usarla.
    handler = manager._handlers.get(cuerpo.plc_id)
    if handler is None:
        raise HTTPException(404, f"No hay ningún PLC con id '{cuerpo.plc_id}'.")
    info = handler.buscar_tag(cuerpo.tag)
    if info is None:
        raise HTTPException(
            404, f"El tag '{cuerpo.tag}' no existe en el PLC "
                 f"'{cuerpo.plc_id}'. Míralos con GET /tags?plc={cuerpo.plc_id}.")

    if not es_escribible(info.data_type):
        raise HTTPException(
            400, f"El tag '{info.full_name}' es de tipo '{info.data_type}', que "
                 f"no se puede escribir (estructuras, arrays y binarios "
                 f"quedan fuera a propósito).")

    if not handler.soporta_escritura():
        raise HTTPException(
            400, f"El PLC '{cuerpo.plc_id}' usa un driver que no sabe escribir.")

    try:
        entrada = _permitidos(request).habilitar(
            plc_id=cuerpo.plc_id, tag=info.full_name, node_id=info.node_id,
            data_type=info.data_type, minimo=cuerpo.minimo, maximo=cuerpo.maximo,
            descripcion=cuerpo.descripcion, usuario=usuario_de(sesion))
    except ValueError as exc:
        raise HTTPException(400, str(exc))

    _auditar(request, "plc.escritura.habilitada", sesion, info.full_name,
             {"plc_id": cuerpo.plc_id, "minimo": cuerpo.minimo,
              "maximo": cuerpo.maximo, "data_type": info.data_type})
    return {"ok": True, "tag": entrada.publico(),
            "mensaje": f"'{info.full_name}' habilitado para escritura."}


@router.delete(
    "/escritura/permitidos/{plc_id}/{tag}",
    tags=TAG,
    summary="Quitar un tag de la lista blanca",
    description="A partir de ese momento escribir en él devuelve 403. No "
                "cambia nada en el PLC: solo deja de estar permitido desde aquí.",
    responses={404: {"description": "Ese tag no estaba habilitado."}},
)
async def deshabilitar(
    request: Request,
    plc_id: str,
    tag: str,
    sesion: Sesion = Depends(exigir_rol(ROL_ESCRITURA)),
) -> dict:
    if not _permitidos(request).deshabilitar(plc_id, tag):
        raise HTTPException(404, f"'{tag}' no estaba habilitado en '{plc_id}'.")
    _auditar(request, "plc.escritura.deshabilitada", sesion, tag, {"plc_id": plc_id})
    return {"ok": True, "mensaje": f"'{tag}' ya no se puede escribir."}


@router.get(
    "/escritura/candidatos",
    tags=TAG,
    summary="Tags que se podrían habilitar",
    description=
    "Los tags del PLC cuyo tipo admite escritura, marcando cuáles están ya "
    "habilitados. Es lo que necesita la pantalla de configuración para "
    "ofrecer una lista en vez de obligar a teclear el nombre exacto — que es "
    "de donde salen las erratas que luego habilitan el tag equivocado.",
)
async def candidatos(
    request: Request,
    plc_id: str = Query(..., description="PLC del que listar los tags."),
    sesion: Sesion = Depends(exigir_rol(ROL_ESCRITURA)),
) -> dict:
    handler = _manager(request)._handlers.get(plc_id)
    if handler is None:
        raise HTTPException(404, f"No hay ningún PLC con id '{plc_id}'.")

    store = _permitidos(request)
    salida = []
    for t in handler._tags:
        if not es_escribible(t.data_type):
            continue
        ya = store.obtener(plc_id, t.full_name)
        salida.append({
            "tag": t.full_name, "node_id": t.node_id, "data_type": t.data_type,
            "db_name": t.db_name, "habilitado": ya is not None,
            "minimo": ya.minimo if ya else None,
            "maximo": ya.maximo if ya else None,
            "descripcion": ya.descripcion if ya else "",
        })
    return {"plc_id": plc_id, "num_candidatos": len(salida),
            "soporta_escritura": handler.soporta_escritura(),
            "candidatos": sorted(salida, key=lambda x: x["tag"])}
