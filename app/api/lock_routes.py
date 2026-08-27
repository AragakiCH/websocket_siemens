# -*- coding: utf-8 -*-
"""
lock_routes.py
==============
El "lápiz" de edición y la auditoría.

  GET    /locks                        -> qué hay bloqueado y por quién
  POST   /locks/{recurso}/adquirir     -> pedir el control
  POST   /locks/{recurso}/renovar      -> heartbeat (cada ~10 s mientras editas)
  POST   /locks/{recurso}/liberar      -> soltarlo (al salir del Diseñador)
  POST   /locks/{recurso}/forzar       -> quitárselo a otro   [Supervisor]

  GET    /auditoria                    -> quién hizo qué       [Administradores]

**Nombre del recurso.** Es una cadena libre, por convención `tipo:id`:
`designer:principal`, `designer:horno_2`. Así cada pantalla se bloquea por
separado: dos personas pueden editar dos proyectos distintos a la vez, que es
lo normal en una planta con varias líneas.
"""
from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field

from app.api.auth_routes import exigir_rol, sesion_actual, usuario_de
from app.core.auth_manager import Sesion

router = APIRouter()

TAG = ["Bloqueos y auditoría"]


def _locks(request: Request):
    return request.app.state.lock_manager


def _audit(request: Request):
    return getattr(request.app.state, "auditoria", None)


def _quien(request: Request, sesion: Optional[Sesion]) -> str:
    """
    Identidad para el bloqueo.

    Si el sistema corre sin autenticación no hay nombre real. En vez de dejar
    a todos como "" (lo que haría que se pisaran entre sí sin poder
    distinguirse), se usa un identificador por conexión: la IP del cliente.
    No es una identidad de verdad, pero permite que el bloqueo funcione en una
    instalación sin cuentas.
    """
    if sesion is not None:
        return sesion.usuario
    cliente = request.client.host if request.client else "desconocido"
    return f"anónimo@{cliente}"


class RecursoBloqueo(BaseModel):
    """Cuerpo opcional; hoy no lleva nada, se deja para crecer."""

    motivo: str = Field(default="", description="Nota libre, para la auditoría.")


# ====================================================================== #
# Consulta
# ====================================================================== #
@router.get(
    "/locks",
    tags=TAG,
    summary="Qué está bloqueado y por quién",
    description="Bloqueos activos. Los caducados (más de 30 s sin heartbeat) "
                "se descartan al consultar, así que esta lista siempre está "
                "al día.",
    responses={200: {"content": {"application/json": {"example": {
        "ok": True, "locks": [{
            "recurso": "designer:principal", "usuario": "jmendoza",
            "categoria": "Administradores",
            "adquirido": "2026-08-25T14:02:00Z",
            "ultimo_latido": "2026-08-25T14:05:12Z",
            "segundos_restantes": 27.4,
        }],
    }}}}},
)
async def listar_locks(request: Request) -> dict:
    return {"ok": True, "locks": _locks(request).listar(),
            "clientes_ws": request.app.state.manager.count()}


# ====================================================================== #
# Mutaciones
# ====================================================================== #
@router.post(
    "/locks/{recurso}/adquirir",
    tags=TAG,
    summary="Pedir el control de edición",
    description="Se llama al ENTRAR al Diseñador.\n\n"
                "Si lo tiene otra persona, responde `concedido: false` con "
                "quién es y cuánto le queda — **no** es un error: la vista "
                "pasa a modo lectura y sigue viendo los cambios en vivo.\n\n"
                "Pedirlo dos veces siendo el mismo usuario (dos pestañas) "
                "cuenta como renovación, no se echa a sí mismo.",
    responses={200: {"content": {"application/json": {"examples": {
        "concedido": {"summary": "Tienes el lápiz", "value": {
            "ok": True, "concedido": True, "recurso": "designer:principal",
            "heartbeat_s": 10.0, "ttl_s": 30.0,
            "mensaje": "Tienes el control de edición.",
        }},
        "ocupado": {"summary": "Lo tiene otro", "value": {
            "ok": False, "concedido": False, "recurso": "designer:principal",
            "titular": {"usuario": "acastro", "segundos_restantes": 24.1},
            "mensaje": "'acastro' está editando ahora mismo. Puedes ver los "
                       "cambios en vivo; para tomar el control, pídeselo o "
                       "espera 24 s a que caduque.",
        }},
    }}}}},
)
async def adquirir(
    request: Request, recurso: str,
    sesion: Optional[Sesion] = Depends(sesion_actual),
) -> dict:
    quien = _quien(request, sesion)
    r = await _locks(request).adquirir(
        recurso, quien, sesion.categoria if sesion else ""
    )
    aud = _audit(request)
    if aud and r.get("concedido"):
        aud.registrar("lock.adquirido", quien, recurso)
    return r


@router.post(
    "/locks/{recurso}/renovar",
    tags=TAG,
    summary="Heartbeat del control de edición",
    description="El cliente lo llama cada ~10 s mientras edita. Si devuelve "
                "`concedido: false`, el lápiz ya no es tuyo (caducó o te lo "
                "quitaron): la vista debe pasar a lectura AHÍ, sin esperar a "
                "fallar al guardar.",
)
async def renovar(
    request: Request, recurso: str,
    sesion: Optional[Sesion] = Depends(sesion_actual),
) -> dict:
    return await _locks(request).renovar(recurso, _quien(request, sesion))


@router.post(
    "/locks/{recurso}/liberar",
    tags=TAG,
    summary="Soltar el control de edición",
    description="Se llama al SALIR del Diseñador. Si el cliente desaparece sin "
                "llamarlo (cierra el portátil, se cae la red), el bloqueo "
                "caduca solo a los 30 s.",
)
async def liberar(
    request: Request, recurso: str,
    sesion: Optional[Sesion] = Depends(sesion_actual),
) -> dict:
    quien = _quien(request, sesion)
    r = await _locks(request).liberar(recurso, quien)
    aud = _audit(request)
    if aud and r.get("ok"):
        aud.registrar("lock.liberado", quien, recurso)
    return r


@router.post(
    "/locks/{recurso}/forzar",
    tags=TAG,
    summary="Tomar el control que tiene otro",
    dependencies=[Depends(exigir_rol("Supervisor"))],
    description="Le quita el lápiz a quien lo tenga. Existe porque la "
                "alternativa real es mirar la pantalla 30 segundos, y en una "
                "parada de planta eso no se acepta.\n\n"
                "Queda **registrado en la auditoría** con quién se lo quitó a "
                "quién, y al afectado le llega un `lock.changed` con "
                "`accion: forzado` para que su vista pase a lectura al "
                "instante.",
)
async def forzar(
    request: Request, recurso: str,
    sesion: Optional[Sesion] = Depends(sesion_actual),
) -> dict:
    quien = _quien(request, sesion)
    r = await _locks(request).forzar(
        recurso, quien, sesion.categoria if sesion else ""
    )
    aud = _audit(request)
    if aud:
        aud.registrar("lock.forzado", quien, recurso,
                      {"se_lo_quito_a": r.get("anterior", "")})
    return r


# ====================================================================== #
# Auditoría
# ====================================================================== #
@router.get(
    "/auditoria",
    tags=TAG,
    summary="Quién hizo qué y cuándo",
    dependencies=[Depends(exigir_rol("Administradores"))],
    description="Últimos eventos registrados, del más reciente al más "
                "antiguo. Se guardan en `datos/auditoria.jsonl`, una línea "
                "JSON por evento.\n\n"
                "Filtros opcionales: `usuario` (exacto) y `accion` (por "
                "prefijo: `plc.` devuelve `plc.alta` y `plc.baja`).",
    responses={200: {"content": {"application/json": {"example": {
        "ok": True, "num": 2, "eventos": [
            {"ts": "2026-08-25T14:31:02Z", "usuario": "jmendoza",
             "accion": "plc.baja", "recurso": "192.168.50.1", "resultado": "ok"},
            {"ts": "2026-08-25T14:02:10Z", "usuario": "acastro",
             "accion": "lock.forzado", "recurso": "designer:principal",
             "resultado": "ok", "detalle": {"se_lo_quito_a": "jmendoza"}},
        ],
    }}}}},
)
async def leer_auditoria(
    request: Request,
    limite: int = Query(default=200, ge=1, le=2000),
    usuario: str = Query(default=""),
    accion: str = Query(default="", description="Prefijo, ej. `plc.`"),
) -> dict:
    aud = _audit(request)
    if aud is None:
        raise HTTPException(503, "La auditoría no está activa.")
    eventos = aud.leer(limite=limite, usuario=usuario, accion=accion)
    return {"ok": True, "num": len(eventos), "eventos": eventos,
            "fichero": str(aud.ruta)}
