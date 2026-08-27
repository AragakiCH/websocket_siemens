# -*- coding: utf-8 -*-
"""
project_routes.py
=================
El diseño del HMI, compartido entre todos los usuarios.

  GET    /proyectos                       -> lista de proyectos
  POST   /proyectos                       -> crear uno nuevo    [Administradores]
  GET    /proyectos/{id}                  -> documento completo
  PATCH  /proyectos/{id}                  -> renombrar          [Administradores]
  PUT    /proyectos/{id}                  -> reemplazar todo    [Administradores]
  PATCH  /proyectos/{id}/widgets/{wid}    -> un widget          [Administradores]
  DELETE /proyectos/{id}/widgets/{wid}    -> quitar un widget   [Administradores]
  DELETE /proyectos/{id}                  -> borrar proyecto    [Supervisor]

**Optimistic locking.** Toda mutación acepta `version`: la versión sobre la que
el cliente editó. Si el servidor va por una más alta, responde **409** con la
versión actual, en vez de pisar el trabajo del otro. Mandar `version: null`
fuerza la escritura, y es lo que usa el frontend cuando el usuario ve el
conflicto y decide quedarse con lo suyo.

**Por qué existe el PATCH además del PUT.** Arrastrar un widget genera decenas
de eventos por segundo. Reenviar el documento entero (con cincuenta widgets,
decenas de KB) en cada uno saturaría la red y el disco. El PATCH manda solo el
widget que cambió.

**Difusión.** Cada mutación termina con `broadcast({"type": "project.updated"})`
para que las demás pantallas se enteren sin recargar. El evento lleva `por`
(quién lo hizo) y `cambio` (qué), de modo que el cliente que originó el cambio
pueda ignorar su propio eco y no repintar de más.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Body, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from app.api.auth_routes import exigir_rol, sesion_actual, usuario_de
from app.core.auth_manager import Sesion
from app.db.project_store import ConflictoDeVersion, validar_id

router = APIRouter()


def _store(request: Request):
    return request.app.state.project_store


def recurso_lock(project_id: str) -> str:
    """Nombre del lock de un proyecto. Cada pantalla se bloquea por separado."""
    return f"designer:{project_id}"


def _quien(request: Request, sesion: Optional[Sesion]) -> str:
    if sesion is not None:
        return sesion.usuario
    cliente = request.client.host if request.client else "desconocido"
    return f"anónimo@{cliente}"


def _exigir_lapiz(request: Request, project_id: str,
                  sesion: Optional[Sesion]) -> None:
    """
    Comprueba que quien escribe tiene el control de edición.

    Es la barrera de la Fase 4. El control de versiones (409) evita PERDER
    trabajo; esto evita la confusión de no saber quién manda sobre la pantalla.

    Si nadie tiene el lápiz, se deja pasar: el bloqueo es cooperativo, no una
    barrera de seguridad (esa la ponen los roles). Así una instalación sin
    identidad sigue funcionando igual que antes.
    """
    locks = getattr(request.app.state, "lock_manager", None)
    if locks is None:
        return
    recurso = recurso_lock(project_id)
    quien = _quien(request, sesion)
    if locks.puede_editar(recurso, quien):
        return
    titular = locks.titular(recurso)
    raise HTTPException(
        423,  # 423 Locked: existe justo para esto
        {
            "error": f"'{titular.usuario}' tiene el control de edición.",
            "titular": titular.publico() if titular else None,
            "que_hacer": "Espera a que lo suelte (caduca solo a los 30 s sin "
                         "actividad) o pide a un Supervisor que use "
                         "POST /locks/{recurso}/forzar.",
        },
    )


def _auditar(request: Request, accion: str, sesion: Optional[Sesion],
             recurso: str, detalle: Optional[dict] = None) -> None:
    aud = getattr(request.app.state, "auditoria", None)
    if aud is not None:
        aud.registrar(accion, usuario_de(sesion), recurso, detalle)


def _ahora_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


async def _difundir(request: Request, project_id: str, doc: dict,
                    por: str, cambio: dict) -> None:
    """
    Avisa a todas las pantallas de que el proyecto cambió.

    Se manda el CAMBIO, no el documento: con cincuenta widgets, difundir el
    proyecto entero en cada arrastre sería enviar decenas de KB por evento a
    cada cliente conectado.
    """
    await request.app.state.manager.broadcast({
        "timestamp": _ahora_iso(),
        "type": "project.updated",
        "project_id": project_id,
        "version": doc["version"],
        "por": por,
        "cambio": cambio,
    })


def _conflicto(exc: ConflictoDeVersion) -> HTTPException:
    """Traduce el conflicto a un 409 con los datos para que el cliente decida."""
    return HTTPException(
        409,
        {
            "error": str(exc),
            "version_esperada": exc.esperada,
            "version_actual": exc.actual,
            "que_hacer": "Vuelve a pedir el proyecto (GET) y reaplica tu "
                         "cambio, o repite el envío con version=null para "
                         "forzar y quedarte con tu versión.",
        },
    )


# ====================================================================== #
# Modelos
# ====================================================================== #
class NuevoProyecto(BaseModel):
    project_id: str = Field(
        ..., description="Id único; se usa como nombre de fichero. Solo "
                         "letras, dígitos, guion y guion bajo.",
        examples=["horno_2"],
    )
    nombre: str = Field(default="", examples=["Horno 2 · Línea A"])


class RenombrarProyecto(BaseModel):
    """Cuerpo de PATCH /proyectos/{id}."""

    nombre: str = Field(
        ..., max_length=80, examples=["Horno 2 - Linea A"],
        description="Etiqueta visible de la pantalla. El `project_id` no "
                    "cambia nunca: es el nombre del fichero y la clave del "
                    "bloqueo de edicion.",
    )
    version: Optional[int] = Field(default=None)


class ProyectoCompleto(BaseModel):
    """Cuerpo de PUT /proyectos/{id}."""

    widgets: List[Dict[str, Any]] = Field(default_factory=list)
    canvas: Optional[Dict[str, Any]] = Field(
        default=None, description="Medidas del lienzo. Si se omite, no se toca."
    )
    version: Optional[int] = Field(
        default=None,
        description="Versión sobre la que editaste. `null` fuerza la "
                    "escritura sin comprobar conflictos.",
    )


class WidgetUnico(BaseModel):
    """Cuerpo de PATCH /proyectos/{id}/widgets/{wid}."""

    widget: Dict[str, Any] = Field(
        ..., description="El widget completo. Debe incluir su `id`."
    )
    version: Optional[int] = Field(default=None)


# ====================================================================== #
# Lectura
# ====================================================================== #
@router.get(
    "/proyectos",
    tags=["Proyecto HMI"],
    summary="Listar proyectos",
    description="Resumen de cada proyecto sin sus widgets (que pesan). Útil "
                "para el selector de pantallas.",
    responses={200: {"content": {"application/json": {"example": {
        "ok": True, "proyectos": [{
            "project_id": "principal", "nombre": "HMI Principal",
            "version": 42, "actualizado_en": "2026-08-25T14:03:11Z",
            "actualizado_por": "jmendoza", "num_widgets": 12,
        }],
    }}}}},
)
async def listar_proyectos(request: Request) -> dict:
    return {"ok": True, "proyectos": _store(request).listar()}


@router.get(
    "/proyectos/{project_id}",
    tags=["Proyecto HMI"],
    summary="Obtener un proyecto completo",
    description="Widgets y lienzo, con su `version` actual. Guarda esa versión: "
                "es la que hay que devolver al escribir.",
    responses={404: {"description": "No existe ese proyecto."}},
)
async def obtener_proyecto(request: Request, project_id: str) -> dict:
    try:
        doc = _store(request).obtener(project_id)
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    if doc is None:
        raise HTTPException(404, f"No existe el proyecto '{project_id}'.")
    return {"ok": True, **doc}


# ====================================================================== #
# Mutaciones
# ====================================================================== #
@router.post(
    "/proyectos",
    tags=["Proyecto HMI"],
    summary="Crear un proyecto",
    dependencies=[Depends(exigir_rol("Administradores"))],
    responses={409: {"description": "Ya existe un proyecto con ese id."}},
)
async def crear_proyecto(
    request: Request,
    cuerpo: NuevoProyecto,
    sesion: Optional[Sesion] = Depends(sesion_actual),
) -> dict:
    try:
        doc = await _store(request).crear(
            cuerpo.project_id, cuerpo.nombre, usuario_de(sesion)
        )
    except ValueError as exc:
        # Id inválido (400) o ya existe (409): se distinguen por el texto.
        codigo = 409 if "ya existe" in str(exc) else 400
        raise HTTPException(codigo, str(exc))

    _auditar(request, "proyecto.creado", sesion, doc["project_id"])
    await _difundir(request, doc["project_id"], doc, usuario_de(sesion),
                    {"accion": "proyecto_creado"})
    return {"ok": True, **doc}


@router.put(
    "/proyectos/{project_id}",
    tags=["Proyecto HMI"],
    summary="Reemplazar el proyecto completo",
    dependencies=[Depends(exigir_rol("Administradores"))],
    description="Sustituye widgets y lienzo. Es el camino del guardado "
                "explícito; para mover un widget usa el PATCH, que es mucho "
                "más ligero.",
    responses={
        409: {"description": "Otro usuario guardó antes: versión desactualizada."},
        404: {"description": "No existe ese proyecto."},
    },
)
async def guardar_proyecto(
    request: Request,
    project_id: str,
    cuerpo: ProyectoCompleto,
    sesion: Optional[Sesion] = Depends(sesion_actual),
) -> dict:
    _exigir_lapiz(request, project_id, sesion)
    try:
        doc = await _store(request).guardar_todo(
            project_id, cuerpo.widgets, cuerpo.canvas,
            cuerpo.version, usuario_de(sesion),
        )
    except ConflictoDeVersion as exc:
        raise _conflicto(exc)
    except KeyError:
        raise HTTPException(404, f"No existe el proyecto '{project_id}'.")
    except ValueError as exc:
        raise HTTPException(400, str(exc))

    await _difundir(request, project_id, doc, usuario_de(sesion),
                    {"accion": "proyecto_reemplazado",
                     "num_widgets": len(doc["widgets"])})
    return {"ok": True, "version": doc["version"],
            "actualizado_en": doc["actualizado_en"]}


@router.patch(
    "/proyectos/{project_id}",
    tags=["Proyecto HMI"],
    summary="Renombrar una pantalla",
    dependencies=[Depends(exigir_rol("Administradores"))],
    description="Cambia solo la etiqueta visible.\n\n"
                "Exige tener el control de edicion de ESA pantalla, igual que "
                "cualquier otra escritura: renombrar sube la version, y si lo "
                "hiciera alguien de fuera, quien esta editando recibiria un "
                "409 al guardar sin haber tocado nada.",
    responses={
        404: {"description": "No existe esa pantalla."},
        423: {"description": "Otra persona tiene el control de edicion."},
    },
)
async def renombrar_proyecto(
    request: Request,
    project_id: str,
    cuerpo: RenombrarProyecto,
    sesion: Optional[Sesion] = Depends(sesion_actual),
) -> dict:
    _exigir_lapiz(request, project_id, sesion)
    try:
        doc = await _store(request).renombrar(
            project_id, cuerpo.nombre, usuario_de(sesion)
        )
    except KeyError:
        raise HTTPException(404, f"No existe la pantalla '{project_id}'.")
    except ValueError as exc:
        raise HTTPException(400, str(exc))

    _auditar(request, "proyecto.renombrado", sesion, project_id,
             {"nombre": doc["nombre"]})
    await _difundir(request, project_id, doc, usuario_de(sesion),
                    {"accion": "proyecto_renombrado", "nombre": doc["nombre"]})
    return {"ok": True, "project_id": project_id, "nombre": doc["nombre"],
            "version": doc["version"]}


@router.patch(
    "/proyectos/{project_id}/widgets/{widget_id}",
    tags=["Proyecto HMI"],
    summary="Crear o actualizar UN widget",
    dependencies=[Depends(exigir_rol("Administradores"))],
    description="El camino rápido del arrastre. Manda solo el widget que "
                "cambió.\n\n"
                "En el frontend conviene enviarlo con *debounce* de ~250 ms "
                "mientras se arrastra, y un envío firme al soltar: si no, un "
                "arrastre de dos segundos genera decenas de escrituras.",
    responses={409: {"description": "Versión desactualizada."}},
)
async def guardar_widget(
    request: Request,
    project_id: str,
    widget_id: str,
    cuerpo: WidgetUnico,
    sesion: Optional[Sesion] = Depends(sesion_actual),
) -> dict:
    widget = dict(cuerpo.widget or {})
    # El id de la URL manda: evita que el cuerpo y la ruta discrepen.
    widget["id"] = widget_id

    _exigir_lapiz(request, project_id, sesion)
    try:
        doc = await _store(request).guardar_widget(
            project_id, widget, cuerpo.version, usuario_de(sesion)
        )
    except ConflictoDeVersion as exc:
        raise _conflicto(exc)
    except KeyError:
        raise HTTPException(404, f"No existe el proyecto '{project_id}'.")
    except ValueError as exc:
        raise HTTPException(400, str(exc))

    await _difundir(request, project_id, doc, usuario_de(sesion),
                    {"accion": "widget_guardado", "widget": widget_id,
                     "datos": widget})
    return {"ok": True, "version": doc["version"], "widget": widget_id}


@router.delete(
    "/proyectos/{project_id}/widgets/{widget_id}",
    tags=["Proyecto HMI"],
    summary="Quitar un widget",
    dependencies=[Depends(exigir_rol("Administradores"))],
)
async def borrar_widget(
    request: Request,
    project_id: str,
    widget_id: str,
    version: Optional[int] = None,
    sesion: Optional[Sesion] = Depends(sesion_actual),
) -> dict:
    _exigir_lapiz(request, project_id, sesion)
    try:
        doc = await _store(request).borrar_widget(
            project_id, widget_id, version, usuario_de(sesion)
        )
    except ConflictoDeVersion as exc:
        raise _conflicto(exc)
    except KeyError as exc:
        if str(exc).strip("'").startswith("widget:"):
            raise HTTPException(404, f"No existe el widget '{widget_id}'.")
        raise HTTPException(404, f"No existe el proyecto '{project_id}'.")

    _auditar(request, "proyecto.widget_borrado", sesion, project_id,
             {"widget": widget_id})
    await _difundir(request, project_id, doc, usuario_de(sesion),
                    {"accion": "widget_borrado", "widget": widget_id})
    return {"ok": True, "version": doc["version"], "widget": widget_id}


@router.delete(
    "/proyectos/{project_id}",
    tags=["Proyecto HMI"],
    summary="Borrar un proyecto entero",
    dependencies=[Depends(exigir_rol("Supervisor"))],
    description="El proyecto `principal` no se puede borrar: la vista siempre "
                "necesita al menos uno que abrir. Se puede vaciar.",
)
async def borrar_proyecto(
    request: Request,
    project_id: str,
    sesion: Optional[Sesion] = Depends(sesion_actual),
) -> dict:
    try:
        borrado = await _store(request).borrar(project_id)
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    if not borrado:
        raise HTTPException(404, f"No existe el proyecto '{project_id}'.")

    _auditar(request, "proyecto.borrado", sesion, project_id)
    await request.app.state.manager.broadcast({
        "timestamp": _ahora_iso(),
        "type": "project.removed",
        "project_id": project_id,
        "por": usuario_de(sesion),
    })
    return {"ok": True, "project_id": project_id,
            "mensaje": f"Proyecto '{project_id}' eliminado."}
