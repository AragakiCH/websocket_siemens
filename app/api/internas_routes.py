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


async def _difundir_snapshot(request: Request) -> None:
    """
    Reenvía a todas las vistas la lista COMPLETA de tags (PLCs + internas).

    POR QUÉ ADEMÁS DEL VALOR. `_difundir_valor` manda el cambio de UNA
    variable como si fuera un tag de PLC, y con eso una interna nueva aparece
    en las vistas abiertas. Pero hay dos casos que un mensaje de valor no
    puede cubrir:

      * BORRAR: no hay valor que mandar, y la vista no quita tags por un
        `config.updated`. La interna borrada seguía en los desplegables
        hasta cerrar y abrir el programa.
      * RENOMBRAR: el nombre ES la clave del tag (`interno|<nombre>`). El
        mensaje de valor crea la clave nueva, pero la vieja se queda: dos
        entradas para la misma variable.

    El snapshot reemplaza la lista entera en la vista, así que deja
    exactamente lo que hay. Es el mismo mensaje que se manda al conectar el
    WebSocket; solo se adelanta al momento en que hace falta.
    """
    try:
        pm = getattr(request.app.state, "plc_manager", None)
        if pm is not None:
            await request.app.state.manager.broadcast(pm.build_snapshot_message())
    except Exception as exc:  # noqa: BLE001
        logger.warning("No se pudo difundir el snapshot de internas: %s", exc)


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


async def _reenlazar(request: Request, antes: str, ahora: str,
                     usuario: str) -> Dict[str, Any]:
    """
    Tras renombrar una variable, lleva el nombre nuevo a todo lo que la usaba.

    Sin esto, renombrar `repo1` a `repo` dejaba cada widget enlazado apuntando
    a `interno|repo1`, que ya no existe: el widget se quedaba sin valor y en el
    inspector aparecía sin variable asociada, sin ningún error que lo dijera.

    Cubre las PANTALLAS (cualquier widget, del catálogo o subido en ZIP) y los
    grupos del HISTORIZADOR. No cubre lo que vive en SQL (reglas de alarma,
    elementos de receta): eso es otra base y otro cambio.

    Nunca lanza. El renombrado ya está hecho cuando se llega aquí; si algo
    falla, la respuesta lo cuenta en `errores` en vez de devolver un 500 que
    haría creer que la variable no se renombró.
    """
    vieja, nueva = f"interno|{antes}", f"interno|{ahora}"
    salida: Dict[str, Any] = {"widgets": 0, "pantallas": [],
                              "historicos": [], "errores": []}

    # --- Pantallas ---------------------------------------------------- #
    proyectos = getattr(request.app.state, "project_store", None)
    if proyectos is not None:
        try:
            tocadas = await proyectos.reemplazar_referencia(vieja, nueva, usuario)
        except Exception as exc:  # noqa: BLE001
            logger.exception("No se pudieron reenlazar las pantallas")
            salida["errores"].append(f"pantallas: {exc}")
            tocadas = []
        # Import tardío: project_routes es un módulo grande y esto solo hace
        # falta al renombrar; así no se acoplan los dos routers al arrancar.
        from app.api.project_routes import _difundir, diff_de_widgets
        for t in tocadas:
            salida["widgets"] += t["widgets_tocados"]
            salida["pantallas"].append(t["nombre"])
            doc = t["doc"]
            cambio: Dict[str, Any] = {
                "accion": "proyecto_reemplazado",
                "num_widgets": len(doc["widgets"]),
                "motivo": "variable_renombrada",
            }
            diff = diff_de_widgets(t["widgets_antes"], doc["widgets"],
                                   doc.get("canvas"), doc.get("canvas"))
            if diff is not None:
                cambio["diff"] = diff
            try:
                # `por` vacío A PROPÓSITO. El frontend ignora los avisos cuyo
                # autor es él mismo («ya lo tengo pintado»), y aquí eso es
                # falso: quien renombra desde la pestaña Variables tiene el
                # Diseñador abierto con la clave VIEJA en memoria, y su
                # siguiente autoguardado la volvería a escribir encima.
                await _difundir(request, t["project_id"], doc, "", cambio)
            except Exception as exc:  # noqa: BLE001
                logger.warning("No se pudo avisar del reenlace de %s: %s",
                               t["project_id"], exc)

    # --- Historizador -------------------------------------------------- #
    try:
        historizador = getattr(request.app.state, "historizador", None)
        # Los grupos en marcha: sin esto seguirían filtrando por la clave
        # vieja hasta el siguiente reinicio y dejarían de guardar la variable.
        for g in (getattr(historizador, "grupos", None) or {}).values():
            if vieja in g.tags:
                g.tags = [nueva if x == vieja else x for x in g.tags]
        db = getattr(request.app.state, "db_manager", None)
        almacen = getattr(db, "store", None)
        if almacen is not None:
            for gid, d in almacen.historicos.items():
                tags = d.get("tags") or []
                if vieja in tags:
                    d["tags"] = [nueva if x == vieja else x for x in tags]
                    salida["historicos"].append(gid)
            if salida["historicos"]:
                await almacen.guardar_async()
    except Exception as exc:  # noqa: BLE001
        logger.exception("No se pudo reenlazar el historizador")
        salida["errores"].append(f"historizador: {exc}")

    return salida


def _mensaje_renombrado(ahora: str, enlaces: Dict[str, Any]) -> str:
    """El texto del aviso: qué se actualizó, con números, no un «hecho»."""
    partes = [f"Renombrada a '{ahora}'."]
    n, pantallas = enlaces["widgets"], enlaces["pantallas"]
    if n:
        partes.append(
            f"Se {'actualizó' if n == 1 else 'actualizaron'} {n} "
            f"widget{'' if n == 1 else 's'} en {len(pantallas)} "
            f"pantalla{'' if len(pantallas) == 1 else 's'}: "
            f"{', '.join(pantallas)}.")
    else:
        partes.append("Ningún widget la tenía enlazada.")
    if enlaces["historicos"]:
        partes.append(
            f"También en el historizador ({', '.join(enlaces['historicos'])}).")
    if enlaces["errores"]:
        partes.append(
            "OJO: no se pudo actualizar todo ("
            + "; ".join(enlaces["errores"])
            + "). Revisa los widgets que la usaban.")
    return " ".join(partes)


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
    await _difundir_snapshot(request)
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
                "**Renombrar conserva los enlaces**: la clave es el nombre, "
                "así que al cambiarlo el servidor actualiza `interno|viejo` "
                "por `interno|nuevo` en todas las pantallas y en los grupos "
                "del historizador. La respuesta dice cuántos widgets tocó "
                "(`enlaces`). Las reglas de alarma y las recetas, que viven "
                "en SQL, NO se actualizan.\n\n"
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
    # El snapshot ANTES que el reenlace: así, cuando a un panel le llega el
    # widget con la clave nueva, la variable nueva ya está en su lista y no
    # hay un instante en el que el widget apunte a algo que aún no conoce.
    await _difundir_snapshot(request)

    enlaces: Optional[Dict[str, Any]] = None
    if v.nombre != antes:
        enlaces = await _reenlazar(request, antes, v.nombre,
                                   usuario_de(sesion))

    detalle: Dict[str, Any] = {"nombre": v.nombre}
    if enlaces is not None:
        detalle.update({"antes": antes,
                        "widgets_reenlazados": enlaces["widgets"],
                        "pantallas": enlaces["pantallas"]})
    _auditar(request, "editada", sesion, detalle)
    try:
        await request.app.state.manager.difundir_config(
            "internas", usuario_de(sesion), "editada")
    except Exception:  # noqa: BLE001
        pass

    salida = {"ok": True, "variable": v.como_fila(),
              "clave": f"interno|{v.nombre}",
              "mensaje": f"Variable '{v.nombre}' actualizada."}
    if enlaces is not None:
        salida["renombrada"] = {"antes": antes, "ahora": v.nombre}
        salida["enlaces"] = enlaces
        salida["mensaje"] = _mensaje_renombrado(v.nombre, enlaces)
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
    # Sin esto la variable borrada seguía en los desplegables de los widgets
    # hasta reabrir el programa: ver `_difundir_snapshot`.
    await _difundir_snapshot(request)
    try:
        await request.app.state.manager.difundir_config(
            "internas", usuario_de(sesion), "borrada")
    except Exception:  # noqa: BLE001
        pass
    return {"ok": True, "mensaje": f"Variable interna '{nombre}' eliminada."}
