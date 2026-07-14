# -*- coding: utf-8 -*-
"""
rest_routes.py
==============
Endpoints REST del servicio. Documentación interactiva en /docs (Swagger UI).

  GET    /health        -> estado de cada PLC, intervalos, nº de tags y clientes WS.
  GET    /plcs          -> lista de ids de PLC gestionados (para el selector).
  POST   /plcs          -> añade un PLC por IP/endpoint escrito por el usuario.
  DELETE /plcs/{id}     -> quita un PLC gestionado.
  POST   /discover      -> re-escanea la red una vez y añade PLCs nuevos.
  GET    /tags?plc=X    -> tags descubiertos (de todos los PLCs o solo de X).
  GET    /browse?plc=X  -> árbol de tags por PLC y Data Block (debug).
"""
from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Body, Request
from pydantic import BaseModel, Field

router = APIRouter()


class NuevoPlc(BaseModel):
    """Cuerpo de POST /plcs: IP, hostname o endpoint opc.tcp:// completo."""

    host: str = Field(
        ...,
        description="IP, hostname o endpoint completo `opc.tcp://host:puerto`.",
        examples=["192.168.50.1"],
    )
    puerto: int = Field(
        default=4840, ge=1, le=65535,
        description="Puerto OPC UA (se ignora si `host` ya es un endpoint completo).",
    )


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
    summary="Agregar un PLC por IP",
    description="Añade un PLC en caliente con la IP (o endpoint `opc.tcp://`) "
                "indicada. Responde de inmediato; la conexión OPC UA se "
                "intenta en segundo plano con reintentos automáticos. Todos "
                "los clientes WebSocket reciben un snapshot actualizado.",
    responses={200: {"content": {"application/json": {"examples": {
        "ok": {"summary": "PLC añadido", "value": {
            "ok": True, "plc_id": "192.168.50.1",
            "endpoint": "opc.tcp://192.168.50.1:4840",
            "mensaje": "PLC 192.168.50.1 añadido; conectando...",
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
    cuerpo: NuevoPlc = Body(..., examples=[{"host": "192.168.50.1", "puerto": 4840}]),
) -> dict:
    return await request.app.state.plc_manager.add_plc_manual(
        cuerpo.host, cuerpo.puerto
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
async def quitar_plc(request: Request, plc_id: str) -> dict:
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
async def redescubrir(request: Request) -> dict:
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
