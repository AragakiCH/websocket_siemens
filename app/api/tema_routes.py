# -*- coding: utf-8 -*-
"""
tema_routes.py
==============
El Gestor de Temas: paleta de colores y tipografías del proyecto.

  GET  /temas/proyecto    -> los temas y cuál está activo
  PUT  /temas/proyecto    -> reemplaza la lista entera   [Administradores]
  POST /temas/restaurar   -> vuelve a los temas de serie [Administradores]

**Por qué `/temas/proyecto` y no `/temas` a secas.** Porque `/temas` es
TAMBIÉN la dirección de la página del Gestor de Temas en el navegador, y el
servidor sirve la aplicación de React desde la misma raíz. Con la API en la
ruta desnuda, recargar esa página —F5, un marcador, pegar el enlace— devolvía
el JSON en crudo en lugar del gestor. Es la misma razón por la que el router
de alarmas expone `/alarmas/activas` y deja `/alarmas` libre para la página.

**Por qué el GET no pide sesión.** Un tema es el aspecto de la pantalla, no un
dato de proceso: si el runtime de un panel de planta no pudiera leerlo, se
pintaría con los colores de fábrica y el operario vería una interfaz distinta
a la que se diseñó. Escribir sí pide rol, el mismo que el Diseñador.

**Control de versiones.** Igual que los proyectos: el cliente manda la versión
sobre la que editó y un 409 avisa de que alguien guardó antes, en vez de pisar
su trabajo. Aquí importa más de lo que parece —los temas son un único
documento compartido, así que dos administradores editándolos a la vez chocan
siempre, no solo cuando tocan la misma pantalla.

**Difusión.** Tras guardar se emite `tema.updated` por el WebSocket. Es lo que
hace que cambiar el color corporativo se vea AL MOMENTO en los paneles de
planta, sin que nadie vaya máquina por máquina a recargar.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from app.api.auth_routes import exigir_rol, sesion_actual, usuario_de
from app.core.auth_manager import Sesion
from app.db.tema_store import ConflictoDeVersion

router = APIRouter(prefix="/temas", tags=["Temas"])


def _store(request: Request):
    store = getattr(request.app.state, "tema_store", None)
    if store is None:
        raise HTTPException(503, "El almacén de temas no está disponible.")
    return store


def _ahora_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


class GuardarTemas(BaseModel):
    """
    Cuerpo del PUT.

    `temas` es obligatorio y sin valor por defecto A PROPÓSITO. La lección ya
    la dio el PUT de proyectos: un campo opcional con `[]` por defecto
    convierte cualquier cuerpo mal formado —un `{}` de una prueba, un cliente
    viejo— en un borrado silencioso de todo. Si falta, Pydantic responde 422 y
    no se toca nada.
    """

    temas: List[Any] = Field(..., description="Lista completa de temas.")
    activo: str = Field(..., description="Id del tema que queda activo.")
    version: Optional[int] = Field(
        default=None,
        description="Versión sobre la que se editó. `null` fuerza la escritura.",
    )
    forzar: bool = Field(
        default=False,
        description="Confirma explícitamente una escritura sin `version`.",
    )


@router.get("/proyecto")
async def leer_temas(request: Request):
    """Los temas y el activo. Sin sesión: es el aspecto, no los datos."""
    return _store(request).obtener()


@router.put(
    "/proyecto",
    dependencies=[Depends(exigir_rol("Administradores"))],
)
async def guardar_temas(
    cuerpo: GuardarTemas,
    request: Request,
    sesion: Optional[Sesion] = Depends(sesion_actual),
):
    """Reemplaza la lista entera de temas."""
    # Sin `version` esto pisa lo que haya. Se permite —el cliente lo necesita
    # tras resolver un 409— pero hay que pedirlo a la cara.
    if cuerpo.version is None and not cuerpo.forzar:
        raise HTTPException(
            400,
            "Falta 'version'. Manda la versión sobre la que editaste, o "
            "añade 'forzar': true si de verdad quieres sobrescribir lo que "
            "haya guardado otro.",
        )

    store = _store(request)
    try:
        doc = await store.guardar(
            cuerpo.temas, cuerpo.activo, cuerpo.version, usuario_de(sesion)
        )
    except ConflictoDeVersion as exc:
        raise HTTPException(
            409,
            {
                "mensaje": str(exc),
                "version_esperada": exc.esperada,
                "version_actual": exc.actual,
            },
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc))

    aud = getattr(request.app.state, "auditoria", None)
    if aud is not None:
        aud.registrar(
            "temas.guardados",
            recurso="temas",
            detalle={"activo": doc["activo"], "num": len(doc["temas"])},
            sesion=sesion,
        )

    await _difundir(request, doc, usuario_de(sesion))
    return {"ok": True, **doc}


@router.post(
    "/restaurar",
    dependencies=[Depends(exigir_rol("Administradores"))],
)
async def restaurar_temas(
    request: Request,
    sesion: Optional[Sesion] = Depends(sesion_actual),
):
    """Vuelve a los temas de fábrica. Los personalizados se pierden."""
    doc = await _store(request).restaurar(usuario_de(sesion))
    aud = getattr(request.app.state, "auditoria", None)
    if aud is not None:
        aud.registrar("temas.restaurados", recurso="temas", sesion=sesion)
    await _difundir(request, doc, usuario_de(sesion))
    return {"ok": True, **doc}


async def _difundir(request: Request, doc: dict, por: str) -> None:
    """
    Avisa a todas las pantallas de que el tema cambió.

    Aquí SÍ se manda el documento entero, al revés que con los proyectos. Son
    dos casos distintos: un proyecto se difunde en cada arrastre del ratón y
    pesa decenas de KB, mientras que los temas se guardan de tanto en tanto y
    ocupan unos pocos KB. Mandarlo completo evita que cada cliente conectado
    dispare un GET al recibir el aviso, que es justo el tropel de peticiones
    que se quiere evitar cuando hay veinte paneles en planta.
    """
    manager = getattr(request.app.state, "manager", None)
    if manager is None:
        return
    await manager.broadcast({
        "timestamp": _ahora_iso(),
        "type": "tema.updated",
        "version": doc["version"],
        "por": por,
        "documento": doc,
    })
