# -*- coding: utf-8 -*-
"""
categoria_routes.py
===================
Las secciones de la paleta de widgets, por proyecto.

    GET    /categorias/{proyecto_id}                lista + asignaciones
    POST   /categorias/{proyecto_id}                crear una categoría
    PATCH  /categorias/{proyecto_id}/{cat_id}       renombrarla
    DELETE /categorias/{proyecto_id}/{cat_id}       borrarla (solo si está vacía)
    PUT    /categorias/{proyecto_id}/asignaciones   mover widgets

QUÉ DECIDE ESTO Y QUÉ NO
------------------------
Decide CÓMO se ordena la paleta, no QUÉ widgets hay. El catálogo es global —un
ZIP subido está disponible en todos los proyectos—; la organización es de cada
proyecto, porque las secciones de una envasadora no le sirven a quien monta un
tablero de bombeo.

Mover un widget NO toca su definición. La categoría que trae un `widget.json`
es la del autor y se queda como está; lo que se guarda aquí es la decisión de
quien monta la instalación. Así resubir un ZIP corregido no deshace la
organización, y quitar la asignación devuelve el widget a donde su autor lo
puso. Ver la cabecera de `app/db/categorias_store.py`.

POR QUÉ EL GET NO PIDE SESIÓN
-----------------------------
Mismo motivo que `/temas`: un panel tiene que poder pintarse. La paleta no
contiene nada sensible —son nombres de secciones— y exigir sesión para leerla
dejaría el Diseñador en blanco antes de que nadie entre. Lo que SÍ pide rol es
cambiarla: `Administradores`, el mismo que ya exige `PUT /widgets/{kind}`, para
que organizar la paleta y subir widgets estén al mismo nivel.

POR QUÉ BORRAR EXIGE ESTAR VACÍA
--------------------------------
Se rechazó a propósito el «al borrar, muévelos todos a Básicos»: eso convierte
una sección organizada en un montón que hay que volver a repartir, y para
entonces ya nadie se acuerda de cuáles eran. Vaciar primero obliga a mirar
widget por widget dónde va cada uno, que es el trabajo que de verdad hay que
hacer.
"""
from __future__ import annotations

import logging
from typing import Dict, Optional

from fastapi import APIRouter, Body, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from app.api.auth_routes import exigir_rol, usuario_de
from app.core.auth_manager import Sesion
from app.db.categorias_store import (CategoriaEnUso, CategoriaFija,
                                     CATEGORIA_REFUGIO, slug)

logger = logging.getLogger("categoria_routes")

router = APIRouter()
TAG = ["Categorías de la paleta"]

#: El mismo que ya exige subir un widget. Organizar la paleta y decidir qué
#: widgets hay son la misma clase de decisión, así que van al mismo nivel.
ROL_CATEGORIAS = "Administradores"


def _store(request: Request):
    store = getattr(request.app.state, "categorias_store", None)
    if store is None:
        raise HTTPException(503, "El almacén de categorías no está disponible.")
    return store


def _declaradas(request: Request) -> Dict[str, str]:
    """
    `{kind: categoría que declara}` de los widgets subidos por ZIP.

    Hace falta para saber si una categoría está VACÍA de verdad. El store solo
    conoce los widgets movidos a mano; un ZIP que declara «Paneles» en su
    `widget.json` y nunca se ha tocado también está dentro, aunque no aparezca
    en las asignaciones. Sin esto se dejaría borrar esa categoría y el widget
    reaparecería en Básicos acto seguido, moviéndose solo a ojos del usuario.

    Los built-in y los custom TSX no hacen falta: solo declaran las cuatro de
    fábrica, y esas no se pueden borrar.
    """
    store = getattr(request.app.state, "widget_store", None)
    if store is None:
        return {}
    fuera: Dict[str, str] = {}
    for w in store.listar():
        meta = w.get("meta") or {}
        categoria = meta.get("category") or meta.get("categoria") or ""
        if categoria:
            fuera[f"custom:{w['kind']}"] = str(categoria)
    return fuera


def _auditar(request: Request, accion: str, sesion, recurso: str,
             detalle: dict) -> None:
    aud = getattr(request.app.state, "auditoria", None)
    if aud is not None:
        aud.registrar(accion, recurso=recurso, detalle=detalle,
                      resultado="ok", sesion=sesion)


async def _avisar(request: Request, sesion, accion: str) -> None:
    """
    Difunde `config.updated` para que las demás pantallas recarguen la paleta.

    Sin esto, quien tuviera el Diseñador abierto seguiría sin ver la categoría
    que otro acaba de crear. Es el mismo canal que usa `PUT /widgets/{kind}`.
    """
    try:
        await request.app.state.manager.difundir_config(
            "categorias", usuario_de(sesion), accion)
    except Exception:  # noqa: BLE001
        pass


# ====================================================================== #
# Modelos
# ====================================================================== #
class NombreCategoria(BaseModel):
    nombre: str = Field(
        ...,
        description="Etiqueta visible, p. ej. «Paneles». Se compara sin "
                    "tildes ni mayúsculas para no crear dos casi iguales.")


class Asignacion(BaseModel):
    kind: str = Field(
        ...,
        description="El `kind` del widget tal como lo usa la vista: `tank`, "
                    "`custom:valor-unidad`, `custom:mi-panel`.")
    categoria: Optional[str] = Field(
        default=None,
        description="Id de la categoría destino. `null` o vacío QUITA la "
                    "asignación y el widget vuelve a la categoría que declara "
                    "su definición — no es lo mismo que mandarlo a Básicos.")


class Orden(BaseModel):
    orden: list[str] = Field(
        ...,
        description="Los ids de las categorías, en el orden en que deben "
                    "pintarse. Lo que falte se queda al final; lo que sobre se "
                    "ignora.")


class Asignaciones(BaseModel):
    asignaciones: list[Asignacion] = Field(
        ...,
        description="Varias de golpe. Se aplican en orden; si una falla, las "
                    "anteriores quedan hechas.")


# ====================================================================== #
# Leer
# ====================================================================== #
@router.get(
    "/categorias/{proyecto_id}",
    tags=TAG,
    summary="Categorías de la paleta de un proyecto",
    description="Las secciones de la barra de widgets y qué widget se movió a "
                "cuál.\n\n"
                "Un proyecto del que nunca se tocó nada devuelve las cuatro de "
                "fábrica y ninguna asignación. **No se crea nada en disco al "
                "consultar**: un GET no debe dejar rastro.\n\n"
                "La categoría efectiva de un widget es "
                "`asignaciones[kind] ?? la que declara ?? 'basicos'`.",
    responses={200: {"content": {"application/json": {"example": {
        "ok": True, "proyecto_id": "principal",
        "categorias": [
            {"id": "basicos", "nombre": "Básicos", "fija": True},
            {"id": "paneles", "nombre": "Paneles", "fija": False}],
        "asignaciones": {"tank": "paneles"},
        "refugio": "basicos"}}}}},
)
async def listar(request: Request, proyecto_id: str) -> dict:
    doc = _store(request).documento(proyecto_id)
    return {"ok": True, "proyecto_id": proyecto_id,
            "categorias": doc["categorias"],
            "asignaciones": doc["asignaciones"],
            "refugio": CATEGORIA_REFUGIO,
            "actualizado_en": doc.get("actualizado_en", ""),
            "actualizado_por": doc.get("actualizado_por", "")}


# ====================================================================== #
# Crear / renombrar / borrar
# ====================================================================== #
@router.post(
    "/categorias/{proyecto_id}",
    tags=TAG,
    summary="Crear una categoría",
    description="Añade una sección a la paleta de ESE proyecto. El `id` sale "
                "del nombre (sin tildes, en minúsculas) y ya no cambia: así "
                "renombrarla después no deja huérfano a ningún widget.",
    responses={400: {"description": "Nombre vacío, duplicado, o se llegó al tope."}},
)
async def crear(
    request: Request,
    proyecto_id: str,
    cuerpo: NombreCategoria = Body(..., examples=[{"nombre": "Paneles"}]),
    sesion: Sesion = Depends(exigir_rol(ROL_CATEGORIAS)),
) -> dict:
    try:
        entrada = _store(request).crear(
            proyecto_id, cuerpo.nombre, usuario_de(sesion))
    except ValueError as exc:
        raise HTTPException(400, str(exc))

    _auditar(request, "paleta.categoria.creada", sesion, entrada["id"],
             {"proyecto_id": proyecto_id, "nombre": entrada["nombre"]})
    await _avisar(request, sesion, "categoria_creada")
    return {"ok": True, "categoria": entrada,
            "mensaje": f"Categoría '{entrada['nombre']}' creada."}


@router.patch(
    "/categorias/{proyecto_id}/{cat_id}",
    tags=TAG,
    summary="Renombrar una categoría",
    description="Cambia solo la etiqueta. **El `id` no cambia**, y por eso los "
                "widgets que estaban dentro siguen dentro.\n\n"
                "Las cuatro de fábrica también se pueden renombrar: «Datos» "
                "puede pasar a llamarse «Lecturas» sin romper nada.",
    responses={400: {"description": "Nombre vacío o ya usado por otra."},
               404: {"description": "No existe esa categoría."}},
)
async def renombrar(
    request: Request,
    proyecto_id: str,
    cat_id: str,
    cuerpo: NombreCategoria = Body(..., examples=[{"nombre": "Pantallas HMI"}]),
    sesion: Sesion = Depends(exigir_rol(ROL_CATEGORIAS)),
) -> dict:
    try:
        entrada = _store(request).renombrar(
            proyecto_id, slug(cat_id), cuerpo.nombre, usuario_de(sesion))
    except KeyError as exc:
        raise HTTPException(404, str(exc).strip("'\""))
    except ValueError as exc:
        raise HTTPException(400, str(exc))

    _auditar(request, "paleta.categoria.renombrada", sesion, entrada["id"],
             {"proyecto_id": proyecto_id, "nombre": entrada["nombre"]})
    await _avisar(request, sesion, "categoria_renombrada")
    return {"ok": True, "categoria": entrada}


@router.delete(
    "/categorias/{proyecto_id}/{cat_id}",
    tags=TAG,
    summary="Borrar una categoría vacía",
    description="**Solo si no le queda ningún widget dentro.** Cuenta tanto "
                "lo que se movió a mano como lo que la declara en su "
                "`widget.json` sin haberse tocado.\n\n"
                "No se ofrece mover los widgets a otra parte al borrar: eso "
                "convierte una sección organizada en un montón que hay que "
                "volver a repartir. Vaciar primero obliga a decidir dónde va "
                "cada uno, que es el trabajo de verdad.\n\n"
                "Las cuatro de fábrica no se borran: hay widgets del programa "
                "que las declaran como suyas.",
    responses={
        400: {"description": "Es una de fábrica."},
        404: {"description": "No existe esa categoría."},
        409: {"description": "Todavía tiene widgets dentro."},
    },
)
async def borrar(
    request: Request,
    proyecto_id: str,
    cat_id: str,
    sesion: Sesion = Depends(exigir_rol(ROL_CATEGORIAS)),
) -> dict:
    cid = slug(cat_id)
    try:
        _store(request).borrar(
            proyecto_id, cid, _declaradas(request), usuario_de(sesion))
    except KeyError as exc:
        raise HTTPException(404, str(exc).strip("'\""))
    except CategoriaFija as exc:
        raise HTTPException(400, str(exc))
    except CategoriaEnUso as exc:
        raise HTTPException(409, str(exc))

    _auditar(request, "paleta.categoria.borrada", sesion, cid,
             {"proyecto_id": proyecto_id})
    await _avisar(request, sesion, "categoria_borrada")
    return {"ok": True, "categoria_id": cid,
            "mensaje": f"Categoría '{cid}' eliminada."}


@router.put(
    "/categorias/{proyecto_id}/orden",
    tags=TAG,
    summary="Reordenar las secciones de la paleta",
    description="El orden en que se pintan de arriba abajo. Es cosmético pero "
                "no es un capricho: en una paleta de ocho secciones, tener "
                "arriba la de la máquina en la que se está trabajando ahorra "
                "un scroll por cada widget que se coloca.\n\n"
                "Las cuatro de fábrica también se pueden mover.",
)
async def reordenar(
    request: Request,
    proyecto_id: str,
    cuerpo: Orden = Body(..., examples=[{
        "orden": ["paneles", "equipos", "basicos", "indicadores", "datos"]}]),
    sesion: Sesion = Depends(exigir_rol(ROL_CATEGORIAS)),
) -> dict:
    categorias = _store(request).reordenar(
        proyecto_id, cuerpo.orden, usuario_de(sesion))
    await _avisar(request, sesion, "orden")
    return {"ok": True, "proyecto_id": proyecto_id, "categorias": categorias}


# ====================================================================== #
# Mover widgets
# ====================================================================== #
@router.put(
    "/categorias/{proyecto_id}/asignaciones",
    tags=TAG,
    summary="Mover widgets de categoría",
    description="Coloca uno o varios widgets en una categoría de ESTE "
                "proyecto. No toca la definición del widget: su `widget.json` "
                "se queda como estaba y sigue valiendo para los demás "
                "proyectos.\n\n"
                "`categoria: null` quita la asignación y el widget vuelve a la "
                "que declara su autor.",
    responses={404: {"description": "No existe la categoría destino."},
               400: {"description": "Falta el `kind`."}},
)
async def asignar(
    request: Request,
    proyecto_id: str,
    cuerpo: Asignaciones = Body(..., examples=[{
        "asignaciones": [
            {"kind": "tank", "categoria": "paneles"},
            {"kind": "custom:mi-panel", "categoria": "paneles"},
            {"kind": "led", "categoria": None}]}]),
    sesion: Sesion = Depends(exigir_rol(ROL_CATEGORIAS)),
) -> dict:
    store = _store(request)
    usuario = usuario_de(sesion)
    resultado: Dict[str, str] = {}
    try:
        for a in cuerpo.asignaciones:
            resultado = store.asignar(proyecto_id, a.kind, a.categoria, usuario)
    except KeyError as exc:
        raise HTTPException(404, str(exc).strip("'\""))
    except ValueError as exc:
        raise HTTPException(400, str(exc))

    _auditar(request, "paleta.widgets.movidos", sesion, proyecto_id,
             {"asignaciones": [a.model_dump() for a in cuerpo.asignaciones]})
    await _avisar(request, sesion, "asignaciones")
    return {"ok": True, "proyecto_id": proyecto_id, "asignaciones": resultado}
