# -*- coding: utf-8 -*-
"""
proyecto_routes.py
==================
Los PROYECTOS del HMI: el nivel que agrupa pantallas.

  GET    /proyectos          -> lista, con cuántas pantallas tiene cada uno
  POST   /proyectos          -> crear uno (y su primera pantalla) [Administradores]
  PATCH  /proyectos/{id}     -> renombrar                         [Administradores]
  DELETE /proyectos/{id}     -> borrarlo CON SUS PANTALLAS        [Supervisor]
  GET    /proyectos/{id}/exportar  -> un .json con TODO el proyecto
  POST   /proyectos/importar       -> crear un proyecto desde ese .json [Administradores]

**Por qué existe.** Hasta ahora una instalación era un único HMI con varias
pantallas, y para tener dos HMI distintos había que mezclar sus pantallas en la
misma barra de pestañas. Un proyecto es esa separación: sus pantallas, su
numeración empezando por 1, y nada que ver con las del de al lado.

**Qué NO separa, y por qué.** Flujos, alarmas y recetas siguen siendo comunes.
No cuelgan del diseño sino de los tags del PLC: la alarma "temperatura alta"
es la misma mire quien la mire, y duplicarla por proyecto multiplicaría por dos
las reglas que evalúa el motor sin que nadie se lo haya pedido.

**Un proyecto nunca está vacío.** Al crearlo se crea también su primera
pantalla, y la última pantalla de un proyecto no se deja borrar (lo impide
`ProjectStore.borrar`). Un proyecto sin pantallas sería una pestaña en la que
no se puede ni soltar un widget: se ve raro y no se sabe qué hacer con él.

**Nombres.** Aquí `proyecto_id` es el proyecto y `project_id` (así, en inglés)
es una PANTALLA, por como se llamaron las cosas cuando solo había un nivel.
La nota larga está en `app/db/proyecto_store.py`.
"""
from __future__ import annotations

import logging
import re
import unicodedata
from datetime import datetime, timezone
from typing import Any, Callable, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from app.api.auth_routes import exigir_rol, sesion_actual, usuario_de
from app.core.auth_manager import Sesion
from app.db.proyecto_store import PROYECTO_POR_DEFECTO, validar_proyecto_id

logger = logging.getLogger("proyecto_routes")

router = APIRouter()

# ====================================================================== #
# Formato de intercambio
# ====================================================================== #
#: Marca del fichero exportado. Se comprueba al importar para poder decir
#: "esto no es un proyecto" en vez de reventar con un KeyError en la línea 40.
FORMATO = "psicore.proyecto"

#: Versión del formato. Sube cuando cambie de forma incompatible. Un fichero
#: con una versión MAYOR se rechaza con un mensaje que dice qué pasa: leerlo a
#: medias y crear un proyecto incompleto sería mucho peor que no importarlo.
FORMATO_VERSION = 1

#: Tope de pantallas por fichero. No es una limitación del producto: es que un
#: JSON de fuera puede traer cualquier cosa, y crear diez mil pantallas dejaría
#: la carpeta de datos inservible antes de que nadie pudiera cancelar.
MAX_PANTALLAS_IMPORTADAS = 200

#: Claves cuyo valor es el ID DE UNA PANTALLA dentro de la configuración de un
#: widget. Hoy solo la usa el Menú Lateral (`config.secciones[].pantalla`),
#: que guarda a qué pantalla salta cada sección.
#:
#: Importa porque los ids pueden CAMBIAR al importar (si ya hay una pantalla
#: con ese id en este equipo), y un enlace que apunte al id viejo llevaría a
#: la pantalla de otro proyecto —o a ninguna— sin dar ningún error.
CLAVES_DE_PANTALLA = ("pantalla", "project_id")

#: Nombre de la primera pantalla de un proyecto recién creado. Es un marcador
#: de posición: la vista lleva a renombrarla nada más entrar.
PRIMERA_PANTALLA = "Pantalla 1"


def _proyectos(request: Request):
    return request.app.state.proyecto_store


def _pantallas(request: Request):
    """El almacén de pantallas (se llama `project_store` por historia)."""
    return request.app.state.project_store


def _ahora_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _auditar(request: Request, accion: str, sesion: Optional[Sesion],
             recurso: str, detalle: Optional[dict] = None) -> None:
    aud = getattr(request.app.state, "auditoria", None)
    if aud is not None:
        aud.registrar(accion, recurso=recurso, detalle=detalle, sesion=sesion)


async def _difundir(request: Request, tipo: str, proyecto_id: str, por: str,
                    cambio: dict) -> None:
    """
    Avisa a todas las pantallas abiertas de que la lista de proyectos cambió.

    Va por el mismo WebSocket que el resto: quien tenga el Diseñador abierto
    tiene que ver el proyecto nuevo sin recargar, igual que ve una pestaña
    nueva.
    """
    await request.app.state.manager.broadcast({
        "timestamp": _ahora_iso(),
        "type": tipo,
        "proyecto_id": proyecto_id,
        "por": por,
        "cambio": cambio,
    })


def _id_de_pantalla_libre(store, proyecto_id: str) -> str:
    """
    Id para la primera pantalla de un proyecto nuevo.

    Los ids de pantalla son únicos EN TODA la instalación (cada uno es un
    fichero en la misma carpeta), así que se antepone el del proyecto: dos
    proyectos pueden tener su "Pantalla 1" sin chocar, porque el id de una es
    `linea_2_pantalla_1` y el de la otra `horno_pantalla_1`.

    El recorte a 50 deja sitio al sufijo sin pasarse del límite de 64 que
    valida el almacén.
    """
    base = f"{proyecto_id[:50]}_pantalla_1"
    if not store.existe(base):
        return base
    for i in range(2, 100):
        intento = f"{proyecto_id[:46]}_pantalla_1_{i}"
        if not store.existe(intento):
            return intento
    raise HTTPException(
        500, "No se encontró un identificador libre para la primera pantalla."
    )


# ====================================================================== #
# Modelos
# ====================================================================== #
class NuevoProyecto(BaseModel):
    proyecto_id: str = Field(
        ..., description="Id único del proyecto. Solo letras, dígitos, guion "
                         "y guion bajo (máx. 64).",
        examples=["linea_2"],
    )
    nombre: str = Field(default="", max_length=80, examples=["Línea 2"])
    pantalla_nombre: str = Field(
        default=PRIMERA_PANTALLA, max_length=80,
        description="Nombre de la pantalla que se crea con el proyecto. Un "
                    "proyecto nunca nace vacío.",
    )


class RenombrarProyecto(BaseModel):
    nombre: str = Field(
        ..., max_length=80, examples=["Línea 2 · Envasado"],
        description="Etiqueta visible. El `proyecto_id` no cambia nunca: está "
                    "escrito dentro del JSON de cada una de sus pantallas.",
    )


# ====================================================================== #
# Lectura
# ====================================================================== #
@router.get(
    "/proyectos",
    tags=["Proyectos HMI"],
    summary="Listar proyectos",
    description="Cada proyecto con su nombre y cuántas pantallas tiene. Es lo "
                "que pinta el selector del Diseñador.",
    responses={200: {"content": {"application/json": {"example": {
        "ok": True, "proyectos": [{
            "proyecto_id": "principal", "nombre": "Proyecto principal",
            "creado_en": "", "actualizado_en": "2026-09-10T14:03:11Z",
            "actualizado_por": "jmendoza", "num_pantallas": 3,
        }],
    }}}}},
)
async def listar_proyectos(request: Request) -> dict:
    cuenta = _pantallas(request).contar_por_proyecto()
    proyectos = [
        {**p, "num_pantallas": cuenta.get(p["proyecto_id"], 0)}
        for p in _proyectos(request).listar()
    ]
    return {"ok": True, "proyectos": proyectos}


@router.get(
    "/proyectos/{proyecto_id}",
    tags=["Proyectos HMI"],
    summary="Obtener un proyecto",
    description="El proyecto con la lista de sus pantallas (sin los widgets).",
    responses={404: {"description": "No existe ese proyecto."}},
)
async def obtener_proyecto(request: Request, proyecto_id: str) -> dict:
    try:
        doc = _proyectos(request).obtener(proyecto_id)
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    if doc is None:
        raise HTTPException(404, f"No existe el proyecto '{proyecto_id}'.")
    return {"ok": True, **doc,
            "pantallas": _pantallas(request).listar(proyecto_id)}


# ====================================================================== #
# Mutaciones
# ====================================================================== #
@router.post(
    "/proyectos",
    tags=["Proyectos HMI"],
    summary="Crear un proyecto",
    dependencies=[Depends(exigir_rol("Administradores"))],
    description="Crea el proyecto Y su primera pantalla, en ese orden. Si la "
                "pantalla fallara, el proyecto se deshace: es preferible que "
                "no se cree nada a dejar un proyecto vacío que la vista no "
                "sabe pintar.",
    responses={409: {"description": "Ya existe un proyecto con ese id."}},
)
async def crear_proyecto(
    request: Request,
    cuerpo: NuevoProyecto,
    sesion: Optional[Sesion] = Depends(sesion_actual),
) -> dict:
    quien = usuario_de(sesion)
    try:
        doc = await _proyectos(request).crear(
            cuerpo.proyecto_id, cuerpo.nombre, quien
        )
    except ValueError as exc:
        codigo = 409 if "ya existe" in str(exc) else 400
        raise HTTPException(codigo, str(exc))

    pid = doc["proyecto_id"]
    try:
        pantalla = await _pantallas(request).crear(
            _id_de_pantalla_libre(_pantallas(request), pid),
            cuerpo.pantalla_nombre or PRIMERA_PANTALLA,
            quien,
            pid,
        )
    except Exception:
        # Deshacer. Un proyecto sin pantallas no lo sabe pintar nadie, y
        # dejarlo ahí obligaría al usuario a borrarlo a mano para volver a
        # intentarlo.
        await _proyectos(request).borrar(pid)
        raise

    _auditar(request, "proyecto.creado", sesion, pid,
             {"pantalla": pantalla["project_id"]})
    await _difundir(request, "proyecto.updated", pid, quien,
                    {"accion": "proyecto_creado",
                     "pantalla": pantalla["project_id"]})
    return {"ok": True, **doc, "num_pantallas": 1,
            "pantalla": {"project_id": pantalla["project_id"],
                         "nombre": pantalla["nombre"]}}


@router.patch(
    "/proyectos/{proyecto_id}",
    tags=["Proyectos HMI"],
    summary="Renombrar un proyecto",
    dependencies=[Depends(exigir_rol("Administradores"))],
    description="Cambia solo la etiqueta visible.\n\n"
                "A diferencia de renombrar una pantalla, esto NO exige tener "
                "el lápiz: el nombre del proyecto no forma parte de ningún "
                "diseño ni sube ninguna versión, así que no puede provocarle "
                "un 409 a quien esté editando dentro.",
    responses={404: {"description": "No existe ese proyecto."}},
)
async def renombrar_proyecto(
    request: Request,
    proyecto_id: str,
    cuerpo: RenombrarProyecto,
    sesion: Optional[Sesion] = Depends(sesion_actual),
) -> dict:
    try:
        doc = await _proyectos(request).renombrar(
            proyecto_id, cuerpo.nombre, usuario_de(sesion)
        )
    except KeyError:
        raise HTTPException(404, f"No existe el proyecto '{proyecto_id}'.")
    except ValueError as exc:
        raise HTTPException(400, str(exc))

    _auditar(request, "proyecto.renombrado", sesion, proyecto_id,
             {"nombre": doc["nombre"]})
    await _difundir(request, "proyecto.updated", proyecto_id,
                    usuario_de(sesion),
                    {"accion": "proyecto_renombrado", "nombre": doc["nombre"]})
    return {"ok": True, **doc}


@router.delete(
    "/proyectos/{proyecto_id}",
    tags=["Proyectos HMI"],
    summary="Borrar un proyecto y todas sus pantallas",
    dependencies=[Depends(exigir_rol("Supervisor"))],
    description="**Se lleva por delante el diseño de todas sus pantallas.** "
                "El proyecto por defecto no se puede borrar: el Diseñador "
                "necesita siempre uno al que volver.\n\n"
                "El orden importa: primero las pantallas, después el "
                "proyecto. Al revés, un fallo a mitad dejaría pantallas "
                "apuntando a un proyecto que ya no existe.",
    responses={
        400: {"description": "Es el proyecto por defecto."},
        404: {"description": "No existe ese proyecto."},
    },
)
async def borrar_proyecto(
    request: Request,
    proyecto_id: str,
    sesion: Optional[Sesion] = Depends(sesion_actual),
) -> dict:
    try:
        pid = validar_proyecto_id(proyecto_id)
    except ValueError as exc:
        raise HTTPException(400, str(exc))

    if not _proyectos(request).existe(pid):
        raise HTTPException(404, f"No existe el proyecto '{pid}'.")
    if pid == PROYECTO_POR_DEFECTO:
        raise HTTPException(
            400,
            f"El proyecto '{PROYECTO_POR_DEFECTO}' no se puede borrar: el "
            f"Diseñador necesita siempre uno al que volver. Puedes vaciarlo.",
        )

    borradas = await _pantallas(request).borrar_pantallas_de(pid)
    await _proyectos(request).borrar(pid)

    _auditar(request, "proyecto.borrado", sesion, pid,
             {"pantallas": borradas})
    await _difundir(request, "proyecto.removed", pid, usuario_de(sesion),
                    {"accion": "proyecto_borrado", "pantallas": borradas})
    return {"ok": True, "proyecto_id": pid, "pantallas_borradas": borradas,
            "mensaje": f"Proyecto '{pid}' eliminado con "
                       f"{len(borradas)} pantalla(s)."}


# ====================================================================== #
# Exportar / importar
# ====================================================================== #
#
# QUÉ VIAJA EN EL FICHERO, Y POR QUÉ ESO Y NO MÁS
#
# El proyecto, sus pantallas con sus widgets, y la DEFINICIÓN de los widgets
# personalizados que use (el HTML/CSS/JS de los `.zip` importados). Sin lo
# último, abrir el proyecto en otro equipo dejaría cajas vacías donde había
# un widget, sin ningún error que lo explicara: el diseño sabe que ahí va un
# `custom:manometro`, pero ese equipo no tiene ni idea de qué es eso.
#
# NO viajan las alarmas, las recetas, los flujos ni las conexiones a base de
# datos. No cuelgan del diseño sino de los tags del PLC y de la instalación:
# llevárselos escondidos dentro de un proyecto sobrescribiría configuración
# de planta que nadie ha pedido tocar. Para mover una instalación entera
# está la copia de seguridad de Configuración (`/sistema/datos/backup`).
#
# ES UN JSON Y NO UN .ZIP a propósito: se puede abrir con cualquier editor
# para ver qué trae antes de meterlo en un equipo de planta, y se versiona en
# git como cualquier otro fichero de texto.


def _slug(texto: str, maximo: int = 40) -> str:
    """Convierte un nombre de persona en algo que valga como id."""
    base = unicodedata.normalize("NFD", texto or "")
    base = "".join(c for c in base if unicodedata.category(c) != "Mn")
    base = re.sub(r"[^A-Za-z0-9]+", "_", base).strip("_").lower()
    return base[:maximo]


def _id_libre(ocupado: Callable[[str], bool], base: str,
              maximo: int = 64) -> str:
    """
    Primer id de la familia `base`, `base_2`, `base_3`… que esté libre.

    Se prefiere SIEMPRE el original. Importar en un equipo donde ese proyecto
    no existe deja los ids tal cual estaban, y eso vale por dos: los enlaces
    entre pantallas siguen apuntando a donde deben sin tocar nada, y el
    fichero de disco se llama igual en los dos equipos, que es lo que uno
    espera al mover un proyecto de sitio.
    """
    base = (base or "importado")[:maximo]
    if not ocupado(base):
        return base
    for i in range(2, 500):
        sufijo = f"_{i}"
        intento = f"{base[:maximo - len(sufijo)]}{sufijo}"
        if not ocupado(intento):
            return intento
    raise HTTPException(500, f"No se encontró un identificador libre para "
                             f"'{base}'.")


def _kinds_personalizados(pantallas: List[dict]) -> List[str]:
    """
    Los widgets `custom:` que usan estas pantallas, sin repetir.

    Ojo: no todos los `custom:` son importados. Los de navegación
    (`custom:menu-lateral`, `custom:pantalla-screen`…) vienen compilados
    dentro de la aplicación y no están en el almacén, así que el que llama
    tiene que aceptar que alguno no aparezca. No es un error: significa
    "ese ya lo trae el programa".
    """
    kinds: List[str] = []
    for pantalla in pantallas:
        for widget in pantalla.get("widgets", []):
            kind = str(widget.get("kind") or "")
            if not kind.startswith("custom:"):
                continue
            limpio = kind[len("custom:"):]
            if limpio and limpio not in kinds:
                kinds.append(limpio)
    return kinds


def _remapear_pantallas(valor: Any, mapa: Dict[str, str]) -> Any:
    """
    Reescribe los enlaces entre pantallas cuando sus ids han cambiado.

    Recorre la configuración del widget entera porque las secciones del Menú
    Lateral están anidadas dentro de `config`, y mañana puede haber otro
    widget que enlace igual. Solo se tocan las claves de `CLAVES_DE_PANTALLA`
    y solo si su valor es exactamente un id que se ha renombrado: una
    etiqueta que por casualidad diga lo mismo que un id no se toca, porque no
    está bajo una de esas claves.
    """
    if isinstance(valor, dict):
        salida = {}
        for clave, dentro in valor.items():
            if (clave in CLAVES_DE_PANTALLA and isinstance(dentro, str)
                    and dentro in mapa):
                salida[clave] = mapa[dentro]
            else:
                salida[clave] = _remapear_pantallas(dentro, mapa)
        return salida
    if isinstance(valor, list):
        return [_remapear_pantallas(x, mapa) for x in valor]
    return valor


class ProyectoExportado(BaseModel):
    """
    El fichero de intercambio. Es también el cuerpo de `POST /importar`.

    Todo lleva valor por defecto a propósito: un fichero al que le falte un
    campo tiene que fallar con un mensaje escrito por nosotros ("esto no es
    un proyecto exportado"), no con el error de validación de Pydantic, que
    delante de un operario no significa nada.
    """

    formato: str = Field(default="", examples=[FORMATO])
    version: int = Field(default=0, examples=[FORMATO_VERSION])
    proyecto: Dict[str, Any] = Field(default_factory=dict)
    pantallas: List[Dict[str, Any]] = Field(default_factory=list)
    widgets_personalizados: List[Dict[str, Any]] = Field(default_factory=list)


@router.get(
    "/proyectos/{proyecto_id}/exportar",
    tags=["Proyectos HMI"],
    summary="Exportar un proyecto a un fichero",
    description="Devuelve un `.json` con el proyecto, sus pantallas con todos "
                "sus widgets y la definición de los widgets personalizados "
                "que use, para poder llevárselo a otro equipo.\n\n"
                "**No incluye** alarmas, recetas, flujos ni conexiones a base "
                "de datos: esos son de la instalación, no del diseño. Para "
                "mover una instalación entera está "
                "`GET /sistema/datos/backup`.",
    responses={404: {"description": "No existe ese proyecto."}},
)
async def exportar_proyecto(
    request: Request,
    proyecto_id: str,
    sesion: Optional[Sesion] = Depends(sesion_actual),
) -> JSONResponse:
    try:
        proyecto = _proyectos(request).obtener(proyecto_id)
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    if proyecto is None:
        raise HTTPException(404, f"No existe el proyecto '{proyecto_id}'.")

    almacen = _pantallas(request)
    pantallas = []
    for resumen in almacen.listar(proyecto_id):
        doc = almacen.obtener(resumen["project_id"])
        if doc is None:      # se borró entre el listado y esto
            continue
        pantallas.append({
            "project_id": doc["project_id"],
            "nombre": doc["nombre"],
            "canvas": doc.get("canvas", {}),
            "widgets": doc.get("widgets", []),
        })

    widgets_store = getattr(request.app.state, "widget_store", None)
    personalizados = []
    if widgets_store is not None:
        for kind in _kinds_personalizados(pantallas):
            w = widgets_store.obtener(kind)
            if w is None:
                # Un `custom:` que no está en el almacén viene compilado con
                # la aplicación (los de navegación). No hay nada que llevarse.
                continue
            personalizados.append({
                "kind": w.kind, "nombre": w.nombre,
                "html": w.html, "css": w.css, "js": w.js, "meta": w.meta,
            })

    doc = {
        "formato": FORMATO,
        "version": FORMATO_VERSION,
        "exportado_en": _ahora_iso(),
        "exportado_por": usuario_de(sesion),
        "proyecto": {
            "proyecto_id": proyecto["proyecto_id"],
            "nombre": proyecto["nombre"],
        },
        "pantallas": pantallas,
        "widgets_personalizados": personalizados,
    }

    _auditar(request, "proyecto.exportado", sesion, proyecto_id,
             {"pantallas": len(pantallas),
              "widgets_personalizados": len(personalizados)})

    nombre_fichero = f"proyecto-{_slug(proyecto['nombre']) or proyecto_id}.json"
    return JSONResponse(
        content=doc,
        # Para quien llame a la API directamente (curl, el navegador). La
        # vista no lo necesita: pide el JSON con su token y arma la descarga
        # ella misma, porque un enlace normal no lleva la cabecera de sesión.
        headers={
            "Content-Disposition": f'attachment; filename="{nombre_fichero}"'
        },
    )


@router.post(
    "/proyectos/importar",
    tags=["Proyectos HMI"],
    summary="Importar un proyecto desde un fichero exportado",
    dependencies=[Depends(exigir_rol("Administradores"))],
    description="Crea un proyecto NUEVO a partir del `.json` de "
                "`GET /proyectos/{id}/exportar`.\n\n"
                "**Nunca sobrescribe nada.** Si ya hay un proyecto o una "
                "pantalla con ese id, el importado nace con un sufijo "
                "(`linea_2_2`) y los enlaces entre sus pantallas se reescriben "
                "para seguir apuntando a las suyas. Los widgets "
                "personalizados que ya existan en este equipo se dejan como "
                "están: reemplazarlos cambiaría el aspecto de OTROS proyectos "
                "que los usen, y eso nadie lo ha pedido.\n\n"
                "Si algo falla a mitad, se deshace lo creado: mejor no "
                "importar que dejar medio proyecto.",
    responses={
        400: {"description": "El fichero no es un proyecto exportado, o su "
                             "formato es más nuevo que este servidor."},
    },
)
async def importar_proyecto(
    request: Request,
    cuerpo: ProyectoExportado,
    nombre: Optional[str] = Query(
        default=None, max_length=80,
        description="Nombre para el proyecto importado. Si se omite, el que "
                    "traiga el fichero.",
    ),
    sesion: Optional[Sesion] = Depends(sesion_actual),
) -> dict:
    quien = usuario_de(sesion)

    # ── 1. ¿Esto es lo que dice ser? ──────────────────────────────
    if cuerpo.formato != FORMATO:
        raise HTTPException(
            400,
            "Este fichero no es un proyecto exportado desde la aplicación. "
            "Debe ser el .json que genera «Exportar proyecto».",
        )
    if cuerpo.version > FORMATO_VERSION:
        raise HTTPException(
            400,
            f"El fichero se exportó con una versión más nueva del programa "
            f"(formato v{cuerpo.version}; este servidor entiende hasta la "
            f"v{FORMATO_VERSION}). Actualiza este equipo para poder abrirlo.",
        )
    if not cuerpo.pantallas:
        raise HTTPException(
            400, "El fichero no trae ninguna pantalla, así que no hay "
                 "proyecto que crear.")
    if len(cuerpo.pantallas) > MAX_PANTALLAS_IMPORTADAS:
        raise HTTPException(
            400, f"El fichero trae {len(cuerpo.pantallas)} pantallas y el "
                 f"máximo son {MAX_PANTALLAS_IMPORTADAS}.")

    proyectos = _proyectos(request)
    almacen = _pantallas(request)

    # ── 2. Nombre e id del proyecto ───────────────────────────────
    nombre_final = (nombre or cuerpo.proyecto.get("nombre") or "").strip()
    if not nombre_final:
        nombre_final = "Proyecto importado"
    nombre_final = nombre_final[:80]

    # Dos proyectos con el MISMO nombre en la lista son indistinguibles, y el
    # caso normal de importar es "traigo otra vez el que ya tenía". Se marca
    # solo cuando de verdad choca, para no ensuciar el nombre sin motivo.
    if any(p["nombre"] == nombre_final for p in proyectos.listar()):
        nombre_final = f"{nombre_final} (importado)"[:80]

    base_id = _slug(str(cuerpo.proyecto.get("proyecto_id") or ""), 32) \
        or _slug(nombre_final, 32) or "importado"
    proyecto_id = _id_libre(proyectos.existe, base_id, 32)

    # ── 3. Ids de las pantallas, y el mapa de lo que cambió ───────
    #
    # El mapa solo lleva las que CAMBIARON de id. Si el equipo no tenía nada
    # de este proyecto, sale vacío y no se reescribe ni un widget.
    destinos: List[tuple] = []
    mapa: Dict[str, str] = {}
    reservados: set = set()

    def ocupado(pid: str) -> bool:
        return almacen.existe(pid) or pid in reservados

    for i, pantalla in enumerate(cuerpo.pantallas, start=1):
        original = str(pantalla.get("project_id") or "")
        etiqueta = str(pantalla.get("nombre") or "").strip() or f"Pantalla {i}"
        base = _slug(original, 55) or f"{proyecto_id}_{_slug(etiqueta, 30)}" \
            or f"{proyecto_id}_pantalla_{i}"
        nuevo = _id_libre(ocupado, base, 64)
        reservados.add(nuevo)
        if original and original != nuevo:
            mapa[original] = nuevo
        destinos.append((nuevo, etiqueta, pantalla))

    # ── 4. Crear. Si algo falla, se deshace ──────────────────────
    creadas: List[str] = []
    try:
        await proyectos.crear(proyecto_id, nombre_final, quien)
        for nuevo, etiqueta, pantalla in destinos:
            await almacen.crear(nuevo, etiqueta, quien, proyecto_id)
            creadas.append(nuevo)
            widgets = _remapear_pantallas(pantalla.get("widgets", []), mapa)
            await almacen.guardar_todo(
                nuevo, widgets, pantalla.get("canvas") or {},
                None,          # version=None: acaba de nacer, no hay conflicto
                quien,
            )
    except HTTPException:
        await _deshacer_importacion(proyectos, almacen, proyecto_id, creadas)
        raise
    except Exception as exc:  # noqa: BLE001
        await _deshacer_importacion(proyectos, almacen, proyecto_id, creadas)
        logger.exception("Importación fallida de '%s'", proyecto_id)
        raise HTTPException(
            500, f"No se pudo importar el proyecto: {exc}. No se ha creado "
                 f"nada; el equipo se queda como estaba.")

    # ── 5. Widgets personalizados ────────────────────────────────
    #
    # Va DESPUÉS y fuera del deshacer a propósito: si el proyecto ya está
    # creado, no llevarse un widget es un problema pequeño y visible (una
    # caja vacía) mientras que tirar el proyecto entero por eso sería una
    # sorpresa desproporcionada. Se cuenta lo que pasó y se sigue.
    widgets_store = getattr(request.app.state, "widget_store", None)
    importados: List[str] = []
    omitidos: List[str] = []
    fallidos: List[str] = []
    if widgets_store is not None:
        for w in cuerpo.widgets_personalizados:
            kind = str(w.get("kind") or "")
            if not kind:
                continue
            if widgets_store.obtener(kind) is not None:
                omitidos.append(kind)
                continue
            try:
                widgets_store.guardar(
                    kind, str(w.get("nombre") or ""), str(w.get("html") or ""),
                    str(w.get("css") or ""), str(w.get("js") or ""),
                    w.get("meta") or {}, quien,
                )
                importados.append(kind)
            except ValueError as exc:
                logger.warning("Widget '%s' del fichero no se pudo guardar: %s",
                               kind, exc)
                fallidos.append(kind)

    _auditar(request, "proyecto.importado", sesion, proyecto_id,
             {"pantallas": len(creadas), "widgets_nuevos": importados,
              "widgets_ya_existentes": omitidos})
    await _difundir(request, "proyecto.updated", proyecto_id, quien,
                    {"accion": "proyecto_importado",
                     "pantallas": len(creadas)})

    return {
        "ok": True,
        "proyecto_id": proyecto_id,
        "nombre": nombre_final,
        "pantallas": creadas,
        "num_pantallas": len(creadas),
        # Para que la vista pueda decir "se renombraron 2 pantallas porque ya
        # existían" en vez de dejar que el usuario lo descubra solo.
        "renombradas": mapa,
        "widgets_importados": importados,
        "widgets_ya_existentes": omitidos,
        "widgets_con_error": fallidos,
    }


async def _deshacer_importacion(proyectos, almacen, proyecto_id: str,
                                creadas: List[str]) -> None:
    """
    Quita lo que se llegó a crear. Best effort: si falla el deshacer no se
    puede hacer mucho más que dejarlo dicho en el log.
    """
    for pid in creadas:
        try:
            await almacen.borrar(pid, en_cascada=True)
        except Exception:  # noqa: BLE001
            logger.error("No se pudo deshacer la pantalla '%s'.", pid)
    try:
        await proyectos.borrar(proyecto_id)
    except Exception:  # noqa: BLE001
        logger.error("No se pudo deshacer el proyecto '%s'.", proyecto_id)
