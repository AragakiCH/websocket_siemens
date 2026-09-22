# -*- coding: utf-8 -*-
"""
grupo_routes.py
===============
Los grupos de la barra de pestañas del Diseñador, por proyecto.

    GET    /grupos/{proyecto_id}                 lista + asignaciones
    POST   /grupos/{proyecto_id}                 crear un grupo
    PATCH  /grupos/{proyecto_id}/{grupo_id}      renombrarlo
    DELETE /grupos/{proyecto_id}/{grupo_id}      borrarlo (solo si está vacío)
    PUT    /grupos/{proyecto_id}/orden           reordenar las fichas
    PUT    /grupos/{proyecto_id}/asignaciones    meter/sacar pantallas

QUÉ DECIDE ESTO Y QUÉ NO
------------------------
Decide CÓMO se agrupan las pestañas, no qué pantallas hay. Ninguna ruta de
aquí crea, borra ni modifica una pantalla: lo peor que puede pasar es que la
barra se vea desordenada.

Y sobre todo: **nada de esto toca la versión ni el lápiz de una pantalla**. Ese
es el motivo entero de que los grupos vivan en su propio almacén — meter una
pestaña en un grupo con un `PATCH /pantallas/{id}` habría exigido el lock y
devuelto 423 en cuanto otra persona tuviera esa pantalla abierta. Ver la
cabecera de `app/db/grupos_store.py`.

POR QUÉ EL GET NO PIDE SESIÓN
-----------------------------
Mismo motivo que `/categorias` y `/temas`: la barra tiene que poder pintarse.
Son nombres de carpetas, no hay nada sensible. Lo que sí pide rol es
cambiarlos: `Administradores`, el mismo que ya exige crear una pantalla — que
es la acción de la que esto es vecino directo.

POR QUÉ BORRAR EXIGE ESTAR VACÍO
--------------------------------
Es lo que se pidió, y además es lo correcto: un «borra el grupo y suéltalas
todas» deja quince pestañas sueltas en la barra que hay que volver a repartir,
y para entonces ya no te acuerdas de cuáles estaban dentro.
"""
from __future__ import annotations

import logging
from typing import Dict, List, Optional

from fastapi import APIRouter, Body, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from app.api.auth_routes import exigir_rol, usuario_de
from app.core.auth_manager import Sesion
from app.db.grupos_store import GrupoEnUso, slug

logger = logging.getLogger("grupo_routes")

router = APIRouter()
TAG = ["Grupos de pantallas"]

#: El mismo que ya exige crear una pantalla. Organizar las pestañas y crearlas
#: son la misma clase de decisión, así que van al mismo nivel.
ROL_GRUPOS = "Administradores"


def _store(request: Request):
    store = getattr(request.app.state, "grupos_store", None)
    if store is None:
        raise HTTPException(503, "El almacén de grupos no está disponible.")
    return store


def _pantallas_vivas(request: Request, proyecto_id: str) -> Optional[List[str]]:
    """
    Los `project_id` que siguen existiendo en ese proyecto.

    Hace falta para saber si un grupo está vacío DE VERDAD. Sin esto, una
    pantalla borrada hace tres días seguiría contando como ocupante y el grupo
    no se podría borrar nunca: el usuario vería «todavía tiene 1 pantalla
    dentro» con el desplegable vacío delante, y no habría manera de salir de
    ahí.

    Si el almacén de pantallas no estuviera disponible se devuelve `None`, NO
    una lista vacía. La lista vacía diría que todos los grupos están vacíos y
    dejaría borrarlos todos de golpe; con `None` el store no filtra y el
    borrado se rechaza, que es el lado seguro del error.
    """
    store = getattr(request.app.state, "project_store", None)
    if store is None:
        return None
    return [str(p.get("project_id") or "")
            for p in (store.listar(proyecto_id) or [])]


def _auditar(request: Request, accion: str, sesion, recurso: str,
             detalle: dict) -> None:
    aud = getattr(request.app.state, "auditoria", None)
    if aud is not None:
        aud.registrar(accion, recurso=recurso, detalle=detalle,
                      resultado="ok", sesion=sesion)


async def _avisar(request: Request, sesion, accion: str) -> None:
    """
    Difunde `config.updated` para que las demás pestañas recarguen la barra.

    Sin esto, quien tuviera el Diseñador abierto seguiría sin ver el grupo que
    otro acaba de crear. Es el mismo canal que usan `/categorias` y
    `PUT /widgets/{kind}`.
    """
    try:
        await request.app.state.manager.difundir_config(
            "grupos", usuario_de(sesion), accion)
    except Exception:  # noqa: BLE001
        pass


# ====================================================================== #
# Modelos
# ====================================================================== #
class NombreGrupo(BaseModel):
    nombre: str = Field(
        ...,
        description="Etiqueta visible, p. ej. «Línea 1». Se compara sin "
                    "tildes ni mayúsculas para no crear dos casi iguales.")


class Asignacion(BaseModel):
    pantalla: str = Field(
        ...,
        description="El `project_id` de la pantalla, el mismo que usa "
                    "`/pantallas/{project_id}`.")
    grupo: Optional[str] = Field(
        default=None,
        description="Id del grupo destino. `null` o vacío SACA la pantalla del "
                    "grupo y la deja suelta en la barra.")


class Asignaciones(BaseModel):
    asignaciones: list[Asignacion] = Field(
        ...,
        description="Varias de golpe, que es lo que hace falta al crear N "
                    "pantallas dentro de un grupo. Se aplican en orden; si una "
                    "falla, las anteriores quedan hechas.")


class Orden(BaseModel):
    orden: list[str] = Field(
        ...,
        description="Los ids de los grupos, en el orden en que deben pintarse. "
                    "Lo que falte se queda al final; lo que sobre se ignora.")


# ====================================================================== #
# Leer
# ====================================================================== #
@router.get(
    "/grupos/{proyecto_id}",
    tags=TAG,
    summary="Grupos de pantallas de un proyecto",
    description="Las fichas de grupo de la barra de pestañas y qué pantalla "
                "está dentro de cuál.\n\n"
                "Un proyecto en el que nunca se creó un grupo devuelve las dos "
                "listas vacías. **No se crea nada en disco al consultar**.\n\n"
                "Una pantalla que no aparezca en `asignaciones` está suelta en "
                "la barra — que es lo normal y no es un error.",
    responses={200: {"content": {"application/json": {"example": {
        "ok": True, "proyecto_id": "principal",
        "grupos": [{"id": "linea-1", "nombre": "Línea 1"}],
        "asignaciones": {"principal_pantalla_2": "linea-1"}}}}}},
)
async def listar(request: Request, proyecto_id: str) -> dict:
    doc = _store(request).documento(proyecto_id)
    return {"ok": True, "proyecto_id": proyecto_id,
            "grupos": doc["grupos"],
            "asignaciones": doc["asignaciones"],
            "actualizado_en": doc.get("actualizado_en", ""),
            "actualizado_por": doc.get("actualizado_por", "")}


# ====================================================================== #
# Crear / renombrar / borrar
# ====================================================================== #
@router.post(
    "/grupos/{proyecto_id}",
    tags=TAG,
    summary="Crear un grupo",
    description="Añade una ficha de grupo, vacía, a la barra de ESE proyecto. "
                "El `id` sale del nombre (sin tildes, en minúsculas) y ya no "
                "cambia: así renombrarlo después no saca a ninguna pantalla.",
    responses={400: {"description": "Nombre vacío, duplicado, o se llegó al tope."}},
)
async def crear(
    request: Request,
    proyecto_id: str,
    cuerpo: NombreGrupo = Body(..., examples=[{"nombre": "Línea 1"}]),
    sesion: Sesion = Depends(exigir_rol(ROL_GRUPOS)),
) -> dict:
    try:
        entrada = _store(request).crear(
            proyecto_id, cuerpo.nombre, usuario_de(sesion))
    except ValueError as exc:
        raise HTTPException(400, str(exc))

    _auditar(request, "pantallas.grupo.creado", sesion, entrada["id"],
             {"proyecto_id": proyecto_id, "nombre": entrada["nombre"]})
    await _avisar(request, sesion, "grupo_creado")
    return {"ok": True, "grupo": entrada,
            "mensaje": f"Grupo '{entrada['nombre']}' creado."}


@router.patch(
    "/grupos/{proyecto_id}/{grupo_id}",
    tags=TAG,
    summary="Renombrar un grupo",
    description="Cambia solo la etiqueta. **El `id` no cambia**, y por eso las "
                "pantallas que estaban dentro siguen dentro.\n\n"
                "No toca ninguna pantalla: no sube su versión ni pide el "
                "lápiz, así que se puede renombrar con gente editando dentro.",
    responses={400: {"description": "Nombre vacío o ya usado por otro."},
               404: {"description": "No existe ese grupo."}},
)
async def renombrar(
    request: Request,
    proyecto_id: str,
    grupo_id: str,
    cuerpo: NombreGrupo = Body(..., examples=[{"nombre": "Línea A"}]),
    sesion: Sesion = Depends(exigir_rol(ROL_GRUPOS)),
) -> dict:
    try:
        entrada = _store(request).renombrar(
            proyecto_id, slug(grupo_id), cuerpo.nombre, usuario_de(sesion))
    except KeyError as exc:
        raise HTTPException(404, str(exc).strip("'\""))
    except ValueError as exc:
        raise HTTPException(400, str(exc))

    _auditar(request, "pantallas.grupo.renombrado", sesion, entrada["id"],
             {"proyecto_id": proyecto_id, "nombre": entrada["nombre"]})
    await _avisar(request, sesion, "grupo_renombrado")
    return {"ok": True, "grupo": entrada}


@router.delete(
    "/grupos/{proyecto_id}/{grupo_id}",
    tags=TAG,
    summary="Borrar un grupo vacío",
    description="**Solo si no le queda ninguna pantalla dentro.** Las "
                "pantallas que ya no existen no cuentan como ocupantes: si no, "
                "un grupo con una pantalla borrada dentro no se podría "
                "eliminar nunca.\n\n"
                "Borrar el grupo NO borra pantallas — solo deshace la "
                "agrupación. Para borrar una pantalla está "
                "`DELETE /pantallas/{project_id}`.",
    responses={404: {"description": "No existe ese grupo."},
               409: {"description": "Todavía tiene pantallas dentro."}},
)
async def borrar(
    request: Request,
    proyecto_id: str,
    grupo_id: str,
    sesion: Sesion = Depends(exigir_rol(ROL_GRUPOS)),
) -> dict:
    gid = slug(grupo_id)
    try:
        _store(request).borrar(
            proyecto_id, gid, _pantallas_vivas(request, proyecto_id),
            usuario_de(sesion))
    except KeyError as exc:
        raise HTTPException(404, str(exc).strip("'\""))
    except GrupoEnUso as exc:
        raise HTTPException(409, str(exc))

    _auditar(request, "pantallas.grupo.borrado", sesion, gid,
             {"proyecto_id": proyecto_id})
    await _avisar(request, sesion, "grupo_borrado")
    return {"ok": True, "grupo_id": gid, "mensaje": f"Grupo '{gid}' eliminado."}


@router.put(
    "/grupos/{proyecto_id}/orden",
    tags=TAG,
    summary="Reordenar las fichas de grupo",
    description="El orden en que se pintan de izquierda a derecha. Las fichas "
                "van SIEMPRE antes que las pantallas sueltas, así que esto "
                "ordena solo entre ellas.",
)
async def reordenar(
    request: Request,
    proyecto_id: str,
    cuerpo: Orden = Body(..., examples=[{"orden": ["linea-2", "linea-1"]}]),
    sesion: Sesion = Depends(exigir_rol(ROL_GRUPOS)),
) -> dict:
    grupos = _store(request).reordenar(
        proyecto_id, cuerpo.orden, usuario_de(sesion))
    await _avisar(request, sesion, "orden")
    return {"ok": True, "proyecto_id": proyecto_id, "grupos": grupos}


# ====================================================================== #
# Meter y sacar pantallas
# ====================================================================== #
@router.put(
    "/grupos/{proyecto_id}/asignaciones",
    tags=TAG,
    summary="Meter o sacar pantallas de un grupo",
    description="Coloca una o varias pantallas dentro de un grupo de ESTE "
                "proyecto. **No toca el documento de la pantalla**: su "
                "`version` no sube y no hace falta tener el lápiz.\n\n"
                "`grupo: null` la saca y la deja suelta en la barra.\n\n"
                "Una pantalla está en un grupo como mucho: mandarla a otro la "
                "mueve, no la duplica.",
    responses={404: {"description": "No existe el grupo destino."},
               400: {"description": "Falta el `project_id` de la pantalla."}},
)
async def asignar(
    request: Request,
    proyecto_id: str,
    cuerpo: Asignaciones = Body(..., examples=[{
        "asignaciones": [
            {"pantalla": "principal_pantalla_2", "grupo": "linea-1"},
            {"pantalla": "principal_pantalla_3", "grupo": "linea-1"},
            {"pantalla": "principal_pantalla_4", "grupo": None}]}]),
    sesion: Sesion = Depends(exigir_rol(ROL_GRUPOS)),
) -> dict:
    store = _store(request)
    usuario = usuario_de(sesion)
    resultado: Dict[str, str] = {}
    try:
        for a in cuerpo.asignaciones:
            resultado = store.asignar(proyecto_id, a.pantalla, a.grupo, usuario)
    except KeyError as exc:
        raise HTTPException(404, str(exc).strip("'\""))
    except ValueError as exc:
        raise HTTPException(400, str(exc))

    _auditar(request, "pantallas.grupo.movidas", sesion, proyecto_id,
             {"asignaciones": [a.model_dump() for a in cuerpo.asignaciones]})
    await _avisar(request, sesion, "asignaciones")
    return {"ok": True, "proyecto_id": proyecto_id, "asignaciones": resultado}
