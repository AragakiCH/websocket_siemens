# -*- coding: utf-8 -*-
"""
variables_routes.py
===================
Crear variables desde la vista, sobre huecos reservados en el PLC.

    GET    /variables              las creadas hasta ahora
    POST   /variables              crear una (reclama un hueco libre)
    PATCH  /variables/{id}         renombrar, cambiar unidad o límites
    DELETE /variables/{id}         liberar el hueco
    GET    /variables/huecos       cuántos quedan libres, por tipo

CÓMO FUNCIONA, EN UNA FRASE
---------------------------
No se crea nada dentro del PLC —eso exige recompilar y descargar—: se RECLAMA
uno de los huecos que ya reservaste en TIA Portal y se le pone nombre. Ver
`app/core/variables_store.py` para el porqué largo.

LO QUE HAY QUE PREPARAR UNA VEZ EN EL PLC
-----------------------------------------
Un DB con variables sueltas (NO un array; el módulo explica por qué):

    DB_HMI.spare_real_00 .. spare_real_49     REAL
    DB_HMI.spare_bool_00 .. spare_bool_99     BOOL
    DB_HMI.spare_int_00  .. spare_int_49      INT

Marcadas como accesibles y escribibles desde OPC UA. Una descarga, y ya no hace
falta volver a compilar por añadir variables.

QUÉ PASA AL CREAR UNA
---------------------
Además de guardar el nombre, la variable se HABILITA para escritura con sus
límites, en la misma operación. Si no, crear una consigna dejaría algo que se
ve pero no se puede tocar, y habría que ir a otra pantalla a completar el
trabajo — un paso que se olvida siempre.
"""
from __future__ import annotations

import logging
import re
from typing import List, Optional

from fastapi import APIRouter, Body, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field

from app.api.auth_routes import exigir_rol, usuario_de
from app.core.auth_manager import Sesion
from app.core.variables_store import (HuecoOcupado, VariableHmi,
                                      detectar_array)
from app.drivers.escritura import es_escribible

logger = logging.getLogger("variables_routes")

router = APIRouter()
TAG = ["Variables del HMI"]
ROL = "Administradores"

# Prefijos que se buscan para cada tipo. Se comparan en minúsculas y por
# «contiene», no por igualdad: el nombre completo del tag trae el DB delante
# (`DB_HMI.spare_real_07`) y el usuario puede haber llamado al suyo `HMI_SPARE`
# o `Reserva_Real`. Mejor reconocer de más y dejar elegir, que no encontrar
# nada y obligar a teclear el nombre exacto.
PATRONES = {
    "real": ["spare_real", "reserva_real", "hmi_real", "libre_real"],
    "bool": ["spare_bool", "reserva_bool", "hmi_bool", "libre_bool"],
    "int": ["spare_int", "reserva_int", "hmi_int", "libre_int"],
}

# Tipos OPC UA que cuentan como cada familia.
FAMILIA = {
    "real": {"Float", "Double"},
    "bool": {"Boolean"},
    "int": {"SByte", "Byte", "Int16", "UInt16", "Int32", "UInt32",
            "Int64", "UInt64"},
}


def _store(request: Request):
    s = getattr(request.app.state, "variables_store", None)
    if s is None:
        raise HTTPException(503, "El almacén de variables no está disponible.")
    return s


def _permitidos(request: Request):
    return getattr(request.app.state, "escritura_store", None)


def _handler(request: Request, plc_id: str):
    m = getattr(request.app.state, "plc_manager", None)
    if m is None:
        raise HTTPException(503, "El gestor de PLCs no está disponible.")
    h = m._handlers.get(plc_id)
    if h is None:
        raise HTTPException(404, f"No hay ningún PLC con id '{plc_id}'.")
    return h


def _auditar(request: Request, accion: str, sesion, recurso: str, detalle: dict) -> None:
    aud = getattr(request.app.state, "auditoria", None)
    if aud is not None:
        aud.registrar(accion, recurso=recurso, detalle=detalle, sesion=sesion)


def _familia_de(data_type: str) -> str:
    for fam, tipos in FAMILIA.items():
        if data_type in tipos:
            return fam
    return ""


def _huecos(request: Request, plc_id: str, familia: str = "") -> dict:
    """
    Busca en los tags del PLC los que parecen huecos de reserva.

    Devuelve libres y ocupados por separado, más los avisos de lo que se ha
    encontrado y no sirve (arrays, tipos no escribibles).
    """
    handler = _handler(request, plc_id)
    store = _store(request)
    ocupados_por = {v.tag: v for v in store.variables.values() if v.plc_id == plc_id}

    libres: List[dict] = []
    ocupados: List[dict] = []
    avisos: List[str] = []

    for t in getattr(handler, "_tags", []):
        nombre = t.full_name.lower()
        fam = next((f for f, pats in PATRONES.items()
                    if any(p in nombre for p in pats)), "")
        if not fam:
            continue
        if familia and fam != familia:
            continue

        # Un array declarado donde debería haber variables sueltas. Se avisa
        # una sola vez por familia: repetirlo cincuenta veces no ayuda.
        if detectar_array(t.data_type):
            msg = (f"'{t.full_name}' parece un ARRAY. Los huecos tienen que "
                   f"ser variables sueltas (spare_real_00, spare_real_01…): "
                   f"un array no se puede escribir elemento a elemento por "
                   f"esta vía.")
            if msg not in avisos:
                avisos.append(msg)
            continue

        # El tipo declarado tiene que coincidir con la familia del nombre. Un
        # `spare_real_03` declarado como INT es un error de tecleo en TIA que
        # aquí se ve, y en planta se vería como un valor que no cuadra.
        fam_real = _familia_de(t.data_type)
        if fam_real and fam_real != fam:
            avisos.append(
                f"'{t.full_name}' se llama como un hueco de tipo '{fam}' pero "
                f"está declarado como '{t.data_type}'. Revisa el DB en TIA.")
            continue
        if not es_escribible(t.data_type):
            continue

        entrada = {"tag": t.full_name, "node_id": t.node_id,
                   "data_type": t.data_type, "familia": fam}
        if t.full_name in ocupados_por:
            v = ocupados_por[t.full_name]
            ocupados.append({**entrada, "variable_id": v.id, "nombre": v.nombre})
        else:
            libres.append(entrada)

    orden = lambda x: x["tag"]  # noqa: E731
    return {"libres": sorted(libres, key=orden),
            "ocupados": sorted(ocupados, key=orden), "avisos": avisos}


# ====================================================================== #
class NuevaVariable(BaseModel):
    nombre: str = Field(..., description="Lo que verá quien la use: "
                                         "«Consigna de temperatura · Cuba 3».")
    plc_id: str = Field(..., description="PLC donde reservar el hueco.")
    tipo: str = Field(default="real",
                      description="`real`, `bool` o `int`. Determina de qué "
                                  "montón de huecos se coge.")
    tag: str = Field(default="",
                     description="Hueco concreto. Si se deja vacío se coge el "
                                 "primero libre de ese tipo, que es lo normal.")
    unidad: str = Field(default="", description="°C, bar, m³/h…")
    minimo: Optional[float] = Field(default=None, description="Límite inferior.")
    maximo: Optional[float] = Field(default=None, description="Límite superior.")
    descripcion: str = Field(default="")


class CambioVariable(BaseModel):
    nombre: Optional[str] = None
    unidad: Optional[str] = None
    minimo: Optional[float] = None
    maximo: Optional[float] = None
    descripcion: Optional[str] = None


@router.get("/variables", tags=TAG, summary="Variables creadas desde la vista",
            description="Cada una es un hueco del PLC con nombre. `tag` es "
                        "dónde vive de verdad.")
async def listar(request: Request,
                 plc_id: str = Query(default="", description="Filtrar por PLC.")) -> dict:
    store = _store(request)
    return {"variables": store.listar(plc_id), **store.estado()}


@router.get(
    "/variables/huecos", tags=TAG,
    summary="Huecos de reserva libres en el PLC",
    description="Cuántos quedan por tipo. Si sale 0 en todos, o no hay ningún "
                "DB de reserva creado en TIA Portal, o los nombres no encajan "
                "con los patrones que se buscan (`spare_real_00`, "
                "`reserva_real_00`…).\n\n"
                "En `avisos` aparece lo que se encontró y NO sirve: arrays "
                "donde debería haber variables sueltas, o un hueco cuyo tipo "
                "no coincide con su nombre.",
)
async def huecos(request: Request,
                 plc_id: str = Query(..., description="PLC a inspeccionar."),
                 tipo: str = Query(default="", description="real | bool | int")) -> dict:
    d = _huecos(request, plc_id, tipo.strip().lower())
    resumen = {}
    for f in PATRONES:
        resumen[f] = {
            "libres": sum(1 for x in d["libres"] if x["familia"] == f),
            "ocupados": sum(1 for x in d["ocupados"] if x["familia"] == f),
        }
    return {"plc_id": plc_id, "resumen": resumen, **d}


@router.post(
    "/variables", tags=TAG,
    summary="Crear una variable",
    description="Reclama un hueco libre del PLC y le pone nombre.\n\n"
                "**No crea nada dentro del PLC**: eso exigiría recompilar y "
                "descargar el programa. Usa uno de los huecos que ya "
                "reservaste en TIA Portal.\n\n"
                "La variable queda además **habilitada para escritura** con "
                "los límites indicados, en la misma operación.",
    responses={
        409: {"description": "Ese hueco ya está ocupado."},
        410: {"description": "No quedan huecos libres de ese tipo."},
    },
)
async def crear(
    request: Request,
    cuerpo: NuevaVariable = Body(..., examples=[{
        "nombre": "Consigna de temperatura · Cuba 3",
        "plc_id": "siemens_1", "tipo": "real",
        "unidad": "°C", "minimo": 40, "maximo": 90}]),
    sesion: Sesion = Depends(exigir_rol(ROL)),
) -> dict:
    tipo = (cuerpo.tipo or "real").strip().lower()
    if tipo not in PATRONES:
        raise HTTPException(400, f"Tipo '{tipo}' desconocido. Usa: "
                                 f"{', '.join(PATRONES)}.")

    d = _huecos(request, cuerpo.plc_id, tipo)

    if cuerpo.tag:
        elegido = next((h for h in d["libres"] if h["tag"] == cuerpo.tag), None)
        if elegido is None:
            ocupado = next((h for h in d["ocupados"] if h["tag"] == cuerpo.tag), None)
            if ocupado:
                raise HTTPException(
                    409, f"El hueco '{cuerpo.tag}' ya lo usa la variable "
                         f"«{ocupado['nombre']}».")
            raise HTTPException(
                404, f"'{cuerpo.tag}' no es un hueco de reserva de tipo "
                     f"'{tipo}' en el PLC '{cuerpo.plc_id}'.")
    else:
        if not d["libres"]:
            detalle = (f"No quedan huecos '{tipo}' libres en "
                       f"'{cuerpo.plc_id}'. Hay que ampliar el DB de reserva "
                       f"en TIA Portal y volver a descargar el programa.")
            if d["avisos"]:
                detalle += " Además: " + " ".join(d["avisos"])
            raise HTTPException(410, detalle)
        elegido = d["libres"][0]

    try:
        v: VariableHmi = _store(request).crear(
            nombre=cuerpo.nombre, plc_id=cuerpo.plc_id, tag=elegido["tag"],
            node_id=elegido["node_id"], data_type=elegido["data_type"],
            unidad=cuerpo.unidad, minimo=cuerpo.minimo, maximo=cuerpo.maximo,
            descripcion=cuerpo.descripcion, usuario=usuario_de(sesion))
    except HuecoOcupado as exc:
        raise HTTPException(409, str(exc))
    except ValueError as exc:
        raise HTTPException(400, str(exc))

    # Habilitar la escritura aquí y no en otra pantalla: crear una consigna
    # que no se puede tocar es dejar el trabajo a medias.
    permitidos = _permitidos(request)
    if permitidos is not None:
        try:
            permitidos.habilitar(
                plc_id=v.plc_id, tag=v.tag, node_id=v.node_id,
                data_type=v.data_type, minimo=v.minimo, maximo=v.maximo,
                descripcion=v.nombre, usuario=usuario_de(sesion))
        except ValueError as exc:
            logger.warning("Variable creada pero no habilitada para "
                           "escritura: %s", exc)

    _auditar(request, "variable.creada", sesion, v.nombre,
             {"plc_id": v.plc_id, "tag": v.tag, "tipo": tipo,
              "minimo": v.minimo, "maximo": v.maximo})
    return {"ok": True, "variable": v.publico(),
            "huecos_libres_restantes": len(d["libres"]) - 1,
            "mensaje": f"«{v.nombre}» creada sobre {v.tag}."}


@router.patch("/variables/{var_id}", tags=TAG,
              summary="Cambiar nombre, unidad o límites",
              description="No cambia el hueco físico: los widgets y recetas "
                          "que apunten a esta variable siguen funcionando.",
              responses={404: {"description": "No existe."}})
async def actualizar(
    request: Request, var_id: str,
    cuerpo: CambioVariable = Body(...),
    sesion: Sesion = Depends(exigir_rol(ROL)),
) -> dict:
    try:
        v = _store(request).actualizar(var_id, **cuerpo.model_dump(exclude_unset=True))
    except KeyError as exc:
        raise HTTPException(404, str(exc).strip("'\""))
    except ValueError as exc:
        raise HTTPException(400, str(exc))

    # Los límites viven en dos sitios: aquí y en la lista blanca de escritura.
    # Si solo se cambiaran aquí, el rango que de verdad se aplica al escribir
    # seguiría siendo el viejo — y nadie lo notaría hasta que un valor
    # legítimo fuera rechazado.
    permitidos = _permitidos(request)
    if permitidos is not None and permitidos.obtener(v.plc_id, v.tag):
        permitidos.habilitar(plc_id=v.plc_id, tag=v.tag, node_id=v.node_id,
                             data_type=v.data_type, minimo=v.minimo,
                             maximo=v.maximo, descripcion=v.nombre,
                             usuario=usuario_de(sesion))

    _auditar(request, "variable.modificada", sesion, v.nombre,
             {"plc_id": v.plc_id, "tag": v.tag,
              "minimo": v.minimo, "maximo": v.maximo})
    return {"ok": True, "variable": v.publico()}


@router.delete("/variables/{var_id}", tags=TAG,
               summary="Liberar la variable y su hueco",
               description="El hueco vuelve a estar disponible.\n\n"
                           "**No se pone a cero el valor en el PLC**: escribir "
                           "en una variable de proceso como efecto secundario "
                           "de borrar una etiqueta sería una sorpresa "
                           "peligrosa. Queda como estaba; lo que desaparece es "
                           "el nombre.",
               responses={404: {"description": "No existe."}})
async def liberar(request: Request, var_id: str,
                  sesion: Sesion = Depends(exigir_rol(ROL))) -> dict:
    v = _store(request).liberar(var_id)
    if v is None:
        raise HTTPException(404, f"No existe la variable '{var_id}'.")

    # Al soltar el hueco se quita también el permiso de escritura: si no,
    # quedaría un tag escribible sin nada que lo explique, y el siguiente que
    # reclame ese hueco heredaría los límites de la variable anterior.
    permitidos = _permitidos(request)
    if permitidos is not None:
        permitidos.deshabilitar(v.plc_id, v.tag)

    _auditar(request, "variable.liberada", sesion, v.nombre,
             {"plc_id": v.plc_id, "tag": v.tag})
    return {"ok": True, "variable": v.publico(),
            "mensaje": f"«{v.nombre}» liberada; {v.tag} vuelve a estar libre."}
