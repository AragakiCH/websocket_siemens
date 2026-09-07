# -*- coding: utf-8 -*-
"""
rest_routes.py
==============
Endpoints REST del servicio. Documentación interactiva en /docs (Swagger UI).

  GET    /health          -> estado de cada PLC, intervalos, nº de tags y clientes WS.
  GET    /plcs            -> lista de ids de PLC gestionados (para el selector).
  POST   /plcs            -> añade un PLC por IP/endpoint (Siemens o Rexroth).
  DELETE /plcs/{id}       -> quita un PLC gestionado.
  POST   /discover        -> re-escanea la red una vez y añade PLCs nuevos.
  GET    /tags?plc=X      -> tags descubiertos (de todos los PLCs o solo de X).
  GET    /browse?plc=X    -> árbol de tags por PLC y Data Block / programa.

Específicos de Bosch Rexroth ctrlX. Son OPCIONALES: solo hacen falta si el
ctrlX tiene varias apps/programas y quieres elegir cuál leer. En el caso normal
(una app 'Application' con un programa 'PLC_PRG') basta con `POST /plcs`
mandando host + usuario + password: el driver los descubre solo.

  POST   /rexroth/apps     -> apps PLC publicadas en Datalayer/plc/app.
  POST   /rexroth/programs -> programas (POUs) de una app, bajo su nodo `sym`.
"""
from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Body, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from app.api.auth_routes import exigir_rol, usuario_de
from app.core.auth_manager import Sesion

router = APIRouter()


def _auditar(request: Request, accion: str, sesion, recurso: str,
             detalle: dict | None = None) -> None:
    """Registra la acción. Un PLC de produccion borrado sin saber por quien
    es exactamente lo que la auditoria existe para evitar."""
    aud = getattr(request.app.state, "auditoria", None)
    if aud is not None:
        aud.registrar(accion, recurso=recurso, detalle=detalle, sesion=sesion)


class NuevoPlc(BaseModel):
    """
    Cuerpo de POST /plcs.

    Siemens: basta `host` (la sesión OPC UA es anónima).
    Rexroth: además son obligatorios `usuario` y `password`. `app` y `programa`
    son opcionales: si no llegan, se autodetectan al conectar.
    """

    host: str = Field(
        ...,
        description="IP, hostname o endpoint completo `opc.tcp://host:puerto`.",
        examples=["192.168.50.1"],
    )
    puerto: int = Field(
        default=4840, ge=1, le=65535,
        description="Puerto OPC UA (se ignora si `host` ya es un endpoint completo).",
    )
    vendor: str = Field(
        default="siemens",
        description="Marca del PLC: `siemens` (S7-1500) o `rexroth` (ctrlX CORE).",
        examples=["siemens", "rexroth"],
    )
    usuario: str = Field(
        default="", description="Solo Rexroth: usuario del ctrlX.")
    password: str = Field(
        default="", description="Solo Rexroth: contraseña del ctrlX.")
    app: str = Field(
        default="",
        description="Solo Rexroth (OPCIONAL): aplicación bajo "
                    "`Datalayer/plc/app`. Vacío = se autodetecta.")
    programa: str = Field(
        default="",
        description="Solo Rexroth (OPCIONAL): programa (POU) bajo el nodo "
                    "`sym`. Vacío = se autodetecta.")


class CredencialesRexroth(BaseModel):
    """Credenciales para explorar un ctrlX antes de darlo de alta."""

    host: str = Field(
        ...,
        description="IP, hostname o endpoint completo del ctrlX.",
        examples=["192.168.1.1"],
    )
    puerto: int = Field(default=4840, ge=1, le=65535)
    usuario: str = Field(..., examples=["boschrexroth"])
    password: str = Field(...)


class ProgramasRexroth(CredencialesRexroth):
    """Igual que CredencialesRexroth, más la app cuyos programas se listan."""

    app: str = Field(
        default="",
        description="Aplicación devuelta por `POST /rexroth/apps`. "
                    "Vacío = se autodetecta la primera con símbolos.",
    )


def _endpoint_desde(host: str, puerto: int) -> str:
    """Normaliza IP/hostname/endpoint a un endpoint `opc.tcp://host:puerto`."""
    host = (host or "").strip()
    if not host:
        raise HTTPException(400, "Indica la IP del PLC.")
    if host.startswith("opc.tcp://"):
        return host
    return f"opc.tcp://{host}:{puerto}"


@router.get(
    "/health",
    summary="Estado general del servicio",
    description="Salud agregada: cuántos PLCs hay, cuáles están conectados, "
                "número de tags y de clientes WebSocket.",
    responses={200: {"content": {"application/json": {"example": {
        "status": "ok",
        "num_plcs": 1,
        "plcs_conectados": 1,
        "total_tags": 12,
        "clientes_ws": 3,
        "plcs": [{
            "plc_id": "PLC_2",
            "endpoint": "opc.tcp://192.168.50.1:4840",
            "conectado": True,
            "estado_conexion": "conectado",
            "num_tags": 12,
        }],
    }}}}},
)
async def health(request: Request) -> dict:
    return request.app.state.plc_manager.get_health()


@router.get(
    "/plcs",
    summary="Listar PLCs gestionados",
    description="Ids de los PLCs actualmente monitoreados. Úsalos en `?plc=` "
                "de /tags, /browse y del WebSocket `/ws?plc=<id>`.",
    responses={200: {"content": {"application/json": {"example": {
        "plcs": ["PLC_2", "192.168.50.3"],
    }}}}},
)
async def plcs(request: Request) -> dict:
    return {"plcs": request.app.state.plc_manager.list_plc_ids()}


@router.post(
    "/plcs",
    summary="Agregar un PLC por IP (Siemens o Rexroth)",
    description="Añade un PLC en caliente con la IP (o endpoint `opc.tcp://`) "
                "indicada. Responde de inmediato; la conexión OPC UA se "
                "intenta en segundo plano con reintentos automáticos. Todos "
                "los clientes WebSocket reciben un snapshot actualizado.\n\n"
                "Con `vendor=rexroth` hay que mandar además `usuario` y "
                "`password`. Los campos `app` y `programa` son OPCIONALES: si "
                "se omiten, el driver navega `plc/app/<app>/sym/<programa>` y "
                "toma la primera app con símbolos y su primer programa. Solo "
                "hace falta indicarlos si el ctrlX tiene varios y quieres uno "
                "concreto (consúltalos con `/rexroth/apps` y "
                "`/rexroth/programs`).",
    responses={200: {"content": {"application/json": {"examples": {
        "siemens": {"summary": "S7-1500 añadido", "value": {
            "ok": True, "plc_id": "192.168.50.1",
            "endpoint": "opc.tcp://192.168.50.1:4840", "vendor": "siemens",
            "mensaje": "PLC 192.168.50.1 (siemens) añadido; conectando...",
        }},
        "rexroth": {"summary": "ctrlX CORE añadido", "value": {
            "ok": True, "plc_id": "192.168.1.1",
            "endpoint": "opc.tcp://192.168.1.1:4840", "vendor": "rexroth",
            "mensaje": "PLC 192.168.1.1 (rexroth) añadido; conectando...",
        }},
        "duplicado": {"summary": "Ya existía", "value": {
            "ok": False, "plc_id": "192.168.50.1",
            "endpoint": "opc.tcp://192.168.50.1:4840",
            "mensaje": "Ese PLC ya está gestionado (id=192.168.50.1).",
        }},
    }}}}},
)
async def agregar_plc(
    request: Request,
    sesion: Sesion = Depends(exigir_rol("Administradores")),
    cuerpo: NuevoPlc = Body(..., examples=[
        {"host": "192.168.50.1", "puerto": 4840, "vendor": "siemens"},
        {"host": "192.168.1.1", "puerto": 4840, "vendor": "rexroth",
         "usuario": "boschrexroth", "password": "boschrexroth"},
        {"host": "192.168.1.1", "puerto": 4840, "vendor": "rexroth",
         "usuario": "boschrexroth", "password": "boschrexroth",
         "app": "Application", "programa": "PLC_PRG"},
    ]),
) -> dict:
    _auditar(request, "plc.alta", sesion, cuerpo.host,
             {"vendor": cuerpo.vendor})
    return await request.app.state.plc_manager.add_plc_manual(
        host=cuerpo.host,
        puerto=cuerpo.puerto,
        vendor=cuerpo.vendor,
        usuario=cuerpo.usuario,
        password=cuerpo.password,
        app=cuerpo.app,
        programa=cuerpo.programa,
    )


@router.delete(
    "/plcs/{plc_id}",
    summary="Quitar un PLC",
    description="Detiene la conexión OPC UA de ese PLC y lo elimina del "
                "monitoreo. Los clientes WebSocket reciben `type: plc_removed`.",
    responses={200: {"content": {"application/json": {"examples": {
        "ok": {"summary": "Eliminado", "value": {
            "ok": True, "plc_id": "192.168.50.1",
            "mensaje": "PLC 192.168.50.1 eliminado.",
        }},
        "no_existe": {"summary": "Id desconocido", "value": {
            "ok": False, "mensaje": "No existe el PLC 'foo'.",
        }},
    }}}}},
)
async def quitar_plc(
    request: Request, plc_id: str,
    sesion: Sesion = Depends(exigir_rol("Administradores")),
) -> dict:
    _auditar(request, "plc.baja", sesion, plc_id)
    return await request.app.state.plc_manager.remove_plc(plc_id)


@router.post(
    "/discover",
    summary="Escanear la red buscando PLCs",
    description="Escanea la subred configurada (PLC_DISCOVERY_SUBNET, o la "
                "derivada del endpoint semilla) en el puerto 4840 y añade los "
                "PLCs nuevos que respondan como servidores OPC UA. Puede "
                "tardar varios segundos.",
    responses={200: {"content": {"application/json": {"example": {
        "ok": True, "encontrados": 2, "nuevos": ["PLC_2"],
        "mensaje": "1 PLC(s) nuevo(s) añadido(s).",
    }}}}},
)
async def redescubrir(
    request: Request,
    sesion: Sesion = Depends(exigir_rol("Administradores")),
) -> dict:
    return await request.app.state.plc_manager.rescan()


@router.get(
    "/tags",
    summary="Tags con su último valor",
    description="Todos los tags descubiertos (browse de Data Blocks) con el "
                "último valor recibido. Filtra con `?plc=<id>`.",
    responses={200: {"content": {"application/json": {"example": {
        "plc": None,
        "tags": [{
            "plc": "PLC_2", "tag": "DB_Datos.Temperatura", "name": "Temperatura",
            "db": "DB_Datos", "node_id": "ns=3;s=\"DB_Datos\".\"Temperatura\"",
            "type": "Float", "value": 23.7,
            "timestamp": "2026-07-14T07:30:00+00:00",
            "source_ts": "2026-07-14T07:29:59.900+00:00", "delta_ms": 512,
        }],
    }}}}},
)
async def tags(request: Request, plc: Optional[str] = None) -> dict:
    return {"plc": plc, "tags": request.app.state.plc_manager.get_tags(plc)}


@router.get(
    "/browse",
    summary="Árbol de tags por Data Block",
    description="Estructura descubierta por browse OPC UA, agrupada por PLC "
                "y Data Block (útil para depuración).",
    responses={200: {"content": {"application/json": {"example": {
        "timestamp": "2026-07-14T07:30:00+00:00",
        "plcs": [{
            "plc": "PLC_2",
            "datablocks": {"DB_Datos": [{
                "name": "Temperatura", "full_name": "DB_Datos.Temperatura",
                "node_id": "ns=3;s=\"DB_Datos\".\"Temperatura\"", "type": "Float",
            }]},
        }],
    }}}}},
)
async def browse(request: Request, plc: Optional[str] = None) -> dict:
    return request.app.state.plc_manager.get_browse(plc)


# ====================================================================== #
# Bosch Rexroth ctrlX: exploración previa al alta del PLC
# ====================================================================== #
async def _explorar_ctrlx(cuerpo: CredencialesRexroth, listar, *args):
    """
    Abre una sesión temporal contra el ctrlX, ejecuta `listar` y cierra.

    Se conecta y desconecta en cada llamada a propósito: esto ocurre en la
    pantalla de login, antes de que el PLC exista como tal, así que no hay
    ningún driver ni sesión persistente que reutilizar.
    """
    # Import local: `cryptography` solo se necesita para PLCs Rexroth.
    from app.config.settings import get_settings
    from app.drivers.rexroth_driver import conectar_ctrlx

    endpoint = _endpoint_desde(cuerpo.host, cuerpo.puerto)
    if not cuerpo.usuario or not cuerpo.password:
        raise HTTPException(400, "El ctrlX necesita usuario y contraseña.")

    try:
        cliente = await conectar_ctrlx(
            endpoint, cuerpo.usuario, cuerpo.password, get_settings()
        )
    except Exception as exc:  # noqa: BLE001
        # 401: credenciales/seguridad. Es el caso más común y conviene
        # distinguirlo de "conecté pero no encontré nada".
        raise HTTPException(
            401,
            f"No se pudo abrir sesión con {endpoint}. Revisa usuario, "
            f"contraseña y que el certificado del cliente esté aceptado en el "
            f"ctrlX. Detalle: {exc}",
        )

    try:
        return await listar(cliente, *args)
    except RuntimeError as exc:
        # Conectó, pero el árbol esperado no está (proyecto sin publicar).
        raise HTTPException(404, str(exc))
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(502, f"{type(exc).__name__}: {exc}")
    finally:
        try:
            await cliente.disconnect()
        except Exception:  # noqa: BLE001
            pass


@router.post(
    "/rexroth/apps",
    summary="Listar aplicaciones PLC de un ctrlX",
    description="Abre una sesión temporal con el ctrlX y devuelve las "
                "aplicaciones publicadas bajo `Datalayer/plc/app` que exponen "
                "símbolos. Normalmente hay una sola: `Application`.",
    responses={
        200: {"content": {"application/json": {"example": {
            "ok": True, "endpoint": "opc.tcp://192.168.1.1:4840",
            "apps": ["Application"],
        }}}},
        401: {"description": "Credenciales inválidas o certificado no aceptado."},
        404: {"description": "Conectó, pero no hay símbolos publicados."},
    },
)
async def rexroth_apps(
    cuerpo: CredencialesRexroth = Body(..., examples=[{
        "host": "192.168.1.1", "puerto": 4840,
        "usuario": "boschrexroth", "password": "boschrexroth",
    }]),
) -> dict:
    from app.drivers.rexroth_driver import listar_apps

    apps = await _explorar_ctrlx(cuerpo, listar_apps)
    return {
        "ok": True,
        "endpoint": _endpoint_desde(cuerpo.host, cuerpo.puerto),
        "apps": apps,
    }


@router.post(
    "/rexroth/programs",
    summary="Listar programas (POUs) de una aplicación del ctrlX",
    description="Devuelve los hijos del nodo `sym` de la aplicación indicada, "
                "es decir los programas cuyos símbolos se pueden leer. Si sale "
                "vacío, publica el proyecto desde la configuración de símbolos "
                "del PLC.",
    responses={
        200: {"content": {"application/json": {"example": {
            "ok": True, "endpoint": "opc.tcp://192.168.1.1:4840",
            "app": "Application", "programas": ["PLC_PRG", "MotionProg"],
        }}}},
        401: {"description": "Credenciales inválidas o certificado no aceptado."},
        404: {"description": "La app no expone programas en `sym`."},
    },
)
async def rexroth_programas(
    cuerpo: ProgramasRexroth = Body(..., examples=[{
        "host": "192.168.1.1", "puerto": 4840,
        "usuario": "boschrexroth", "password": "boschrexroth",
    }]),
) -> dict:
    from app.drivers.rexroth_driver import listar_apps, listar_programas

    async def _listar(cliente):
        # Si no llega `app`, se toma la primera que exponga símbolos.
        app_sel = (cuerpo.app or "").strip()
        if not app_sel:
            app_sel = (await listar_apps(cliente))[0]
        return app_sel, await listar_programas(cliente, app_sel)

    app_sel, programas = await _explorar_ctrlx(cuerpo, _listar)
    return {
        "ok": True,
        "endpoint": _endpoint_desde(cuerpo.host, cuerpo.puerto),
        "app": app_sel,
        "programas": programas,
    }
