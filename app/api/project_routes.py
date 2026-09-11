# -*- coding: utf-8 -*-
"""
project_routes.py
=================
Las PANTALLAS del HMI: su diseño, compartido entre todos los usuarios.

  GET    /pantallas                       -> lista (filtrable por proyecto)
  POST   /pantallas                       -> crear una nueva    [Administradores]
  GET    /pantallas/{id}                  -> documento completo
  PATCH  /pantallas/{id}                  -> renombrar          [Administradores]
  PUT    /pantallas/{id}                  -> reemplazar todo    [Administradores]
  PATCH  /pantallas/{id}/widgets/{wid}    -> un widget          [Administradores]
  DELETE /pantallas/{id}/widgets/{wid}    -> quitar un widget   [Administradores]
  DELETE /pantallas/{id}                  -> borrar la pantalla [Supervisor]
  GET    /pantallas/{id}/exportar         -> un .json con la pantalla
  POST   /pantallas/importar              -> crearla desde ese .json [Administradores]

**Antes esto era `/proyectos`.** Cuando solo había un nivel, a cada pantalla
se la llamaba proyecto. Ahora `/proyectos` es el nivel de ARRIBA —la carpeta
que agrupa pantallas, en `proyecto_routes.py`— y esto pasó a llamarse por su
nombre. Dentro del código sigue habiendo `project_id`, `project.updated` y
`designer:<project_id>`: renombrarlos habría tocado el lock, el WebSocket y la
caché de cada navegador sin ganar nada. Todos significan PANTALLA.

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

from fastapi import APIRouter, Body, Depends, HTTPException, Query, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from app.api.auth_routes import exigir_rol, sesion_actual, usuario_de
from app.api.intercambio import (
    FORMATO_PANTALLA,
    FORMATO_VERSION,
    id_libre,
    importar_widgets,
    nombre_libre,
    remapear_pantallas,
    slug,
    soltar_enlaces_rotos,
    widgets_para_exportar,
)
from app.core.auth_manager import Sesion
from app.db.project_store import ConflictoDeVersion, validar_id
from app.db.proyecto_store import PROYECTO_POR_DEFECTO as PROYECTO_HMI_POR_DEFECTO

router = APIRouter()


def _store(request: Request):
    """El almacén de PANTALLAS (se llama `project_store` por historia)."""
    return request.app.state.project_store


def _proyectos(request: Request):
    """El almacén de PROYECTOS: la carpeta que agrupa pantallas."""
    return request.app.state.proyecto_store


def recurso_lock(project_id: str) -> str:
    """Nombre del lock de una pantalla. Cada una se bloquea por separado."""
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
        aud.registrar(accion, recurso=recurso, detalle=detalle, sesion=sesion)


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
class NuevaPantalla(BaseModel):
    project_id: str = Field(
        ..., description="Id único EN TODA la instalación; se usa como nombre "
                         "de fichero. Solo letras, dígitos, guion y guion "
                         "bajo.",
        examples=["horno_2"],
    )
    nombre: str = Field(default="", examples=["Horno 2 · Línea A"])
    proyecto: str = Field(
        default=PROYECTO_HMI_POR_DEFECTO,
        description="Proyecto al que pertenece. Si se omite, va al proyecto "
                    "por defecto, que es donde estaban todas antes de que "
                    "existieran los proyectos.",
        examples=["linea_2"],
    )


class RenombrarProyecto(BaseModel):
    """Cuerpo de PATCH /pantallas/{id}."""

    nombre: str = Field(
        ..., max_length=80, examples=["Horno 2 - Linea A"],
        description="Etiqueta visible de la pantalla. El `project_id` no "
                    "cambia nunca: es el nombre del fichero y la clave del "
                    "bloqueo de edicion.",
    )
    version: Optional[int] = Field(default=None)


class ProyectoCompleto(BaseModel):
    """Cuerpo de PUT /pantallas/{id}."""

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
    """Cuerpo de PATCH /pantallas/{id}/widgets/{wid}."""

    widget: Dict[str, Any] = Field(
        ..., description="El widget completo. Debe incluir su `id`."
    )
    version: Optional[int] = Field(default=None)


# ====================================================================== #
# Lectura
# ====================================================================== #
@router.get(
    "/pantallas",
    tags=["Pantallas HMI"],
    summary="Listar pantallas",
    description="Resumen de cada pantalla sin sus widgets (que pesan). Con "
                "`?proyecto=<id>` solo las de ese proyecto, que es lo que "
                "pide la barra de pestañas del Diseñador.",
    responses={200: {"content": {"application/json": {"example": {
        "ok": True, "pantallas": [{
            "project_id": "principal", "nombre": "HMI Principal",
            "proyecto": "principal",
            "version": 42, "actualizado_en": "2026-08-25T14:03:11Z",
            "actualizado_por": "jmendoza", "num_widgets": 12,
        }],
    }}}}},
)
async def listar_pantallas(request: Request,
                           proyecto: Optional[str] = None) -> dict:
    return {"ok": True, "pantallas": _store(request).listar(proyecto)}


@router.get(
    "/pantallas/{project_id}",
    tags=["Pantallas HMI"],
    summary="Obtener una pantalla completa",
    description="Widgets y lienzo, con su `version` actual. Guarda esa versión: "
                "es la que hay que devolver al escribir.",
    responses={404: {"description": "No existe esa pantalla."}},
)
async def obtener_pantalla(request: Request, project_id: str) -> dict:
    try:
        doc = _store(request).obtener(project_id)
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    if doc is None:
        raise HTTPException(404, f"No existe la pantalla '{project_id}'.")
    return {"ok": True, **doc}


# ====================================================================== #
# Mutaciones
# ====================================================================== #
@router.post(
    "/pantallas",
    tags=["Pantallas HMI"],
    summary="Crear una pantalla",
    dependencies=[Depends(exigir_rol("Administradores"))],
    description="Nace dentro de un proyecto. El `project_id` es único en toda "
                "la instalación (es un nombre de fichero); el nombre visible "
                "puede repetirse entre proyectos, y de hecho se repite: cada "
                "proyecto empieza a contar pantallas por 1.",
    responses={
        404: {"description": "No existe el proyecto indicado."},
        409: {"description": "Ya existe una pantalla con ese id."},
    },
)
async def crear_pantalla(
    request: Request,
    cuerpo: NuevaPantalla,
    sesion: Optional[Sesion] = Depends(sesion_actual),
) -> dict:
    # El proyecto tiene que existir ANTES de crear nada. Sin esta comprobación
    # un id mal escrito crearía una pantalla que no sale en ninguna lista: no
    # da error, simplemente no aparece, que es la peor forma de fallar.
    if not _proyectos(request).existe(cuerpo.proyecto):
        raise HTTPException(404, f"No existe el proyecto '{cuerpo.proyecto}'.")

    try:
        doc = await _store(request).crear(
            cuerpo.project_id, cuerpo.nombre, usuario_de(sesion),
            cuerpo.proyecto,
        )
    except ValueError as exc:
        # Id inválido (400) o ya existe (409): se distinguen por el texto.
        codigo = 409 if "ya existe" in str(exc) else 400
        raise HTTPException(codigo, str(exc))

    _auditar(request, "pantalla.creada", sesion, doc["project_id"],
             {"proyecto": doc["proyecto"]})
    await _difundir(request, doc["project_id"], doc, usuario_de(sesion),
                    {"accion": "proyecto_creado",
                     "proyecto": doc["proyecto"]})
    return {"ok": True, **doc}


@router.put(
    "/pantallas/{project_id}",
    tags=["Pantallas HMI"],
    summary="Reemplazar la pantalla completa",
    dependencies=[Depends(exigir_rol("Administradores"))],
    description="Sustituye widgets y lienzo. Es el camino del guardado "
                "explícito; para mover un widget usa el PATCH, que es mucho "
                "más ligero.",
    responses={
        409: {"description": "Otro usuario guardó antes: versión desactualizada."},
        404: {"description": "No existe esa pantalla."},
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
        raise HTTPException(404, f"No existe la pantalla '{project_id}'.")
    except ValueError as exc:
        raise HTTPException(400, str(exc))

    await _difundir(request, project_id, doc, usuario_de(sesion),
                    {"accion": "proyecto_reemplazado",
                     "num_widgets": len(doc["widgets"])})
    return {"ok": True, "version": doc["version"],
            "actualizado_en": doc["actualizado_en"]}


@router.patch(
    "/pantallas/{project_id}",
    tags=["Pantallas HMI"],
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

    _auditar(request, "pantalla.renombrada", sesion, project_id,
             {"nombre": doc["nombre"]})
    await _difundir(request, project_id, doc, usuario_de(sesion),
                    {"accion": "proyecto_renombrado", "nombre": doc["nombre"]})
    return {"ok": True, "project_id": project_id, "nombre": doc["nombre"],
            "version": doc["version"]}


@router.patch(
    "/pantallas/{project_id}/widgets/{widget_id}",
    tags=["Pantallas HMI"],
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
        raise HTTPException(404, f"No existe la pantalla '{project_id}'.")
    except ValueError as exc:
        raise HTTPException(400, str(exc))

    await _difundir(request, project_id, doc, usuario_de(sesion),
                    {"accion": "widget_guardado", "widget": widget_id,
                     "datos": widget})
    return {"ok": True, "version": doc["version"], "widget": widget_id}


@router.delete(
    "/pantallas/{project_id}/widgets/{widget_id}",
    tags=["Pantallas HMI"],
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
        raise HTTPException(404, f"No existe la pantalla '{project_id}'.")

    _auditar(request, "pantalla.widget_borrado", sesion, project_id,
             {"widget": widget_id})
    await _difundir(request, project_id, doc, usuario_de(sesion),
                    {"accion": "widget_borrado", "widget": widget_id})
    return {"ok": True, "version": doc["version"], "widget": widget_id}


@router.delete(
    "/pantallas/{project_id}",
    tags=["Pantallas HMI"],
    summary="Borrar una pantalla",
    dependencies=[Depends(exigir_rol("Supervisor"))],
    description="Dos pantallas no se dejan borrar, y por el mismo motivo: que "
                "la vista tenga siempre adónde ir. La `principal`, que es el "
                "destino de rescate, y la ÚLTIMA de un proyecto (un proyecto "
                "sin pantallas es una pestaña en la que no se puede ni soltar "
                "un widget). Las dos se pueden vaciar; para deshacerse del "
                "proyecto está `DELETE /proyectos/{id}`.",
)
async def borrar_pantalla(
    request: Request,
    project_id: str,
    sesion: Optional[Sesion] = Depends(sesion_actual),
) -> dict:
    try:
        borrado = await _store(request).borrar(project_id)
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    if not borrado:
        raise HTTPException(404, f"No existe la pantalla '{project_id}'.")

    _auditar(request, "pantalla.borrada", sesion, project_id)
    await request.app.state.manager.broadcast({
        "timestamp": _ahora_iso(),
        "type": "project.removed",
        "project_id": project_id,
        "por": usuario_de(sesion),
    })
    return {"ok": True, "project_id": project_id,
            "mensaje": f"Pantalla '{project_id}' eliminada."}


# ====================================================================== #
# Exportar / importar UNA pantalla
# ====================================================================== #
#
# Es el hermano pequeño de exportar un proyecto (`proyecto_routes.py`), y se
# usa para otra cosa: llevarse UNA pantalla —la sinóptica de un equipo, una
# vista de recetas— a otro proyecto o a otro equipo, sin arrastrar el HMI
# entero. Las reglas comunes (ids libres, widgets que viajan) están en
# `app/api/intercambio.py`, para que las dos operaciones no se separen con el
# tiempo.
#
# LA DIFERENCIA QUE IMPORTA: LOS ENLACES A LAS HERMANAS
# Una pantalla puede enlazar a otras del mismo proyecto desde su Menú Lateral.
# Al llevarse una sola, esos destinos NO viajan. Qué hacer con ellos es la
# decisión de fondo de todo esto, y está explicada en `soltar_enlaces_rotos`:
# se vacían y se dice cuáles, porque dejar el id apuntando al vacío —o peor, a
# una pantalla de otro proyecto que por casualidad se llame igual— es un fallo
# que no da ningún error y enseña el HMI equivocado.


class PantallaExportada(BaseModel):
    """
    El fichero de intercambio de una pantalla. Es el cuerpo de `/importar`.

    Todo lleva valor por defecto a propósito: un fichero al que le falte un
    campo tiene que fallar con un mensaje escrito por nosotros ("esto no es
    una pantalla exportada"), no con el error de validación de Pydantic, que
    delante de un operario no significa nada.
    """

    formato: str = Field(default="", examples=[FORMATO_PANTALLA])
    version: int = Field(default=0, examples=[FORMATO_VERSION])
    pantalla: Dict[str, Any] = Field(default_factory=dict)
    widgets_personalizados: List[Dict[str, Any]] = Field(default_factory=list)


@router.get(
    "/pantallas/{project_id}/exportar",
    tags=["Pantallas HMI"],
    summary="Exportar una pantalla a un fichero",
    description="Devuelve un `.json` con la pantalla, sus widgets y la "
                "definición de los widgets personalizados que use.\n\n"
                "Para llevarse el HMI entero está "
                "`GET /proyectos/{id}/exportar`, que además conserva los "
                "enlaces entre pantallas.",
    responses={404: {"description": "No existe esa pantalla."}},
)
async def exportar_pantalla(
    request: Request,
    project_id: str,
    sesion: Optional[Sesion] = Depends(sesion_actual),
) -> JSONResponse:
    try:
        doc = _store(request).obtener(project_id)
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    if doc is None:
        raise HTTPException(404, f"No existe la pantalla '{project_id}'.")

    pantalla = {
        "project_id": doc["project_id"],
        "nombre": doc["nombre"],
        "canvas": doc.get("canvas", {}),
        "widgets": doc.get("widgets", []),
    }

    # De qué proyecto salió. Es informativo —al importar se elige el destino—
    # pero permite decir de dónde viene un fichero que lleva meses en una
    # carpeta de Descargas.
    origen = _proyectos(request).obtener(
        doc.get("proyecto", PROYECTO_HMI_POR_DEFECTO)
    )

    salida = {
        "formato": FORMATO_PANTALLA,
        "version": FORMATO_VERSION,
        "exportado_en": _ahora_iso(),
        "exportado_por": usuario_de(sesion),
        "proyecto_origen": {
            "proyecto_id": origen["proyecto_id"] if origen else "",
            "nombre": origen["nombre"] if origen else "",
        },
        "pantalla": pantalla,
        "widgets_personalizados": widgets_para_exportar(
            getattr(request.app.state, "widget_store", None), [pantalla]
        ),
    }

    _auditar(request, "pantalla.exportada", sesion, project_id,
             {"widgets": len(pantalla["widgets"])})

    nombre_fichero = f"pantalla-{slug(doc['nombre']) or project_id}.json"
    return JSONResponse(
        content=salida,
        headers={
            "Content-Disposition": f'attachment; filename="{nombre_fichero}"'
        },
    )


@router.post(
    "/pantallas/importar",
    tags=["Pantallas HMI"],
    summary="Importar una pantalla desde un fichero exportado",
    dependencies=[Depends(exigir_rol("Administradores"))],
    description="Crea una pantalla NUEVA dentro del proyecto indicado, a "
                "partir del `.json` de `GET /pantallas/{id}/exportar`.\n\n"
                "**Nunca sobrescribe nada.** Si ya hay una pantalla con ese "
                "id, la importada nace con un sufijo. Los widgets "
                "personalizados que ya existan en este equipo se dejan como "
                "están.\n\n"
                "Los enlaces del Menú Lateral que apunten a pantallas que no "
                "están en el proyecto destino se vacían, y se devuelven en "
                "`enlaces_sueltos` para poder avisarlo: dejarlos apuntando a "
                "un id de otro proyecto abriría el HMI equivocado sin dar "
                "ningún error.",
    responses={
        400: {"description": "El fichero no es una pantalla exportada, o su "
                             "formato es más nuevo que este servidor."},
        404: {"description": "No existe el proyecto de destino."},
    },
)
async def importar_pantalla(
    request: Request,
    cuerpo: PantallaExportada,
    proyecto: str = Query(
        default=PROYECTO_HMI_POR_DEFECTO,
        description="Proyecto en el que se crea la pantalla.",
    ),
    nombre: Optional[str] = Query(
        default=None, max_length=80,
        description="Nombre para la pantalla importada. Si se omite, el que "
                    "traiga el fichero.",
    ),
    sesion: Optional[Sesion] = Depends(sesion_actual),
) -> dict:
    quien = usuario_de(sesion)

    # ── 1. ¿Esto es lo que dice ser? ──────────────────────────────
    if cuerpo.formato != FORMATO_PANTALLA:
        raise HTTPException(
            400,
            "Este fichero no es una pantalla exportada desde la aplicación. "
            "Debe ser el .json que genera «Exportar pantalla». (Si lo que "
            "tienes es un proyecto entero, impórtalo desde el selector de "
            "proyectos.)",
        )
    if cuerpo.version > FORMATO_VERSION:
        raise HTTPException(
            400,
            f"El fichero se exportó con una versión más nueva del programa "
            f"(formato v{cuerpo.version}; este servidor entiende hasta la "
            f"v{FORMATO_VERSION}). Actualiza este equipo para poder abrirlo.",
        )
    if not cuerpo.pantalla:
        raise HTTPException(400, "El fichero no trae ninguna pantalla.")

    if not _proyectos(request).existe(proyecto):
        raise HTTPException(404, f"No existe el proyecto '{proyecto}'.")

    almacen = _store(request)

    # ── 2. Nombre e id ───────────────────────────────────────────
    hermanas = almacen.listar(proyecto)
    etiqueta = (nombre or cuerpo.pantalla.get("nombre") or "").strip()
    etiqueta = nombre_libre(
        [p["nombre"] for p in hermanas], etiqueta or "Pantalla importada",
        "(importada)",
    )

    original = str(cuerpo.pantalla.get("project_id") or "")
    base = slug(original, 55) or f"{slug(proyecto, 20)}_{slug(etiqueta, 30)}"
    nuevo_id = id_libre(almacen.existe, base or "pantalla_importada", 64)
    if nuevo_id is None:
        raise HTTPException(
            500, "No se encontró un identificador libre para la pantalla.")

    # ── 3. Los enlaces, en dos pasos ─────────────────────────────
    widgets = cuerpo.pantalla.get("widgets", [])

    # 3a. Lo que apuntaba A ELLA MISMA sigue a la copia. Si el id cambió (ya
    #     había una pantalla con ese nombre interno) y no se hiciera esto, la
    #     copia enlazaría a la ORIGINAL: dos pantallas distintas enseñando lo
    #     mismo, que es justo lo contrario de duplicar.
    if original and original != nuevo_id:
        widgets = remapear_pantallas(widgets, {original: nuevo_id})

    # 3b. Lo que apuntaba a sus HERMANAS solo vale si esas hermanas están en
    #     el proyecto destino. Las que no, se vacían y se cuentan (ver
    #     `soltar_enlaces_rotos`: el id de una pantalla de otro proyecto
    #     abriría el HMI equivocado sin dar ningún error).
    validos = {p["project_id"] for p in hermanas}
    validos.add(nuevo_id)
    widgets, enlaces_sueltos = soltar_enlaces_rotos(widgets, validos)

    # ── 4. Crear. Si algo falla, se deshace ──────────────────────
    try:
        await almacen.crear(nuevo_id, etiqueta, quien, proyecto)
    except ValueError as exc:
        raise HTTPException(400, str(exc))

    try:
        await almacen.guardar_todo(
            nuevo_id, widgets, cuerpo.pantalla.get("canvas") or {},
            None,      # version=None: acaba de nacer, no hay nada que pisar
            quien,
        )
    except Exception as exc:  # noqa: BLE001
        await almacen.borrar(nuevo_id, en_cascada=True)
        raise HTTPException(
            500, f"No se pudo importar la pantalla: {exc}. No se ha creado "
                 f"nada; el equipo se queda como estaba.")

    # ── 5. Widgets personalizados ────────────────────────────────
    importados, omitidos, fallidos = importar_widgets(
        getattr(request.app.state, "widget_store", None),
        cuerpo.widgets_personalizados, quien,
    )

    _auditar(request, "pantalla.importada", sesion, nuevo_id,
             {"proyecto": proyecto, "widgets_nuevos": importados,
              "enlaces_sueltos": enlaces_sueltos})
    # Se difunde como una pantalla creada: es lo que hace que a los demás les
    # aparezca la pestaña sin recargar.
    doc = almacen.obtener(nuevo_id) or {"version": 1}
    await _difundir(request, nuevo_id, doc, quien,
                    {"accion": "proyecto_creado", "proyecto": proyecto})

    return {
        "ok": True,
        "project_id": nuevo_id,
        "nombre": etiqueta,
        "proyecto": proyecto,
        "num_widgets": len(widgets),
        # Para que la vista pueda decir "2 secciones se quedaron sin destino"
        # en vez de dejar que el usuario lo descubra pulsándolas.
        "enlaces_sueltos": enlaces_sueltos,
        "widgets_importados": importados,
        "widgets_ya_existentes": omitidos,
        "widgets_con_error": fallidos,
    }
