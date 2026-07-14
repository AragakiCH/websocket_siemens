# -*- coding: utf-8 -*-
"""
plc_discovery.py
================
Descubrimiento dinámico de PLCs (servidores OPC UA) en la red.

Estrategia recomendada y usada aquí:
  1) SONDEO TCP rápido: se recorre la subred (CIDR) intentando abrir el puerto
     OPC UA (4840 por defecto). Es rápido y no requiere nada especial en el PLC.
  2) VALIDACIÓN OPC UA: a cada host que responde el puerto se le pide la lista
     de endpoints (canal seguro, SIN sesión) para confirmar que es realmente un
     servidor OPC UA y obtener su nombre de aplicación (ej. "PLC_2").

Se combina con los endpoints FIJOS de la configuración (por si ya conoces la IP
y quieres forzarla, aunque el escaneo no la encuentre).

Nota: TIA Portal no expone las IPs de los PLCs por una API de red; por eso el
descubrimiento se hace sobre la red real vía OPC UA, no leyendo el proyecto TIA.
"""
from __future__ import annotations

import asyncio
import ipaddress
import logging
from dataclasses import dataclass
from typing import List, Optional

from asyncua import Client

from app.config.settings import Settings

logger = logging.getLogger("plc_discovery")


@dataclass
class EndpointPlc:
    """Un PLC/endpoint OPC UA detectado o configurado."""

    endpoint: str          # opc.tcp://host:puerto
    host: str
    port: int
    nombre: str = ""       # ApplicationName del servidor (si se pudo leer)
    origen: str = "scan"   # 'scan' | 'manual'


def _host_puerto(endpoint: str) -> tuple[str, int]:
    """Extrae (host, puerto) de un endpoint opc.tcp://host:puerto."""
    resto = endpoint.split("//", 1)[1]
    host, _, puerto = resto.partition(":")
    puerto = puerto.split("/", 1)[0]  # por si hay path
    return host, int(puerto) if puerto else 4840


async def _tcp_abierto(host: str, port: int, timeout: float) -> bool:
    """Comprueba si el puerto TCP está abierto (sondeo rápido)."""
    try:
        fut = asyncio.open_connection(host, port)
        reader, writer = await asyncio.wait_for(fut, timeout=timeout)
        writer.close()
        try:
            await writer.wait_closed()
        except Exception:  # noqa: BLE001
            pass
        return True
    except Exception:  # noqa: BLE001
        return False


async def _validar_opcua(endpoint: str, timeout: float) -> Optional[str]:
    """
    Valida que el endpoint sea un servidor OPC UA y devuelve su nombre de
    aplicación. Usa el canal seguro sin abrir sesión (ligero). None si falla.
    """
    client = Client(url=endpoint, timeout=timeout)
    try:
        endpoints = await client.connect_and_get_server_endpoints()
        nombre = ""
        if endpoints:
            try:
                nombre = endpoints[0].Server.ApplicationName.Text or ""
            except Exception:  # noqa: BLE001
                nombre = ""
        return nombre
    except Exception:  # noqa: BLE001
        return None
    finally:
        # connect_and_get_server_endpoints cierra el socket internamente, pero
        # nos aseguramos de no dejar recursos colgando.
        try:
            await client.disconnect()
        except Exception:  # noqa: BLE001
            pass


async def _sondear_host(
    host: str, port: int, settings: Settings, sem: asyncio.Semaphore
) -> Optional[EndpointPlc]:
    """Sondea un host: TCP -> validación OPC UA. Devuelve EndpointPlc o None."""
    async with sem:
        if not await _tcp_abierto(host, port, settings.discovery_tcp_timeout):
            return None
        endpoint = f"opc.tcp://{host}:{port}"
        nombre = await _validar_opcua(endpoint, settings.discovery_opcua_timeout)
        if nombre is None:
            # Puerto abierto pero no responde como OPC UA: se descarta.
            logger.debug("Puerto abierto pero no es OPC UA: %s", endpoint)
            return None
        logger.info("PLC OPC UA detectado: %s (%s)", endpoint, nombre or "sin nombre")
        return EndpointPlc(endpoint=endpoint, host=host, port=port,
                           nombre=nombre, origen="scan")


async def descubrir_plcs(settings: Settings) -> List[EndpointPlc]:
    """
    Devuelve la lista de PLCs a usar: endpoints FIJOS (manuales) + los hallados
    por escaneo de la subred (si discovery_enabled). Sin duplicados por host.
    """
    resultados: dict[str, EndpointPlc] = {}  # clave: host:port

    # 1) Endpoints manuales (siempre incluidos). Se validan para leer su nombre,
    #    pero se conservan aunque la validación falle (el supervisor reintentará).
    for ep in settings.load_static_endpoints():
        try:
            host, port = _host_puerto(ep)
        except Exception:  # noqa: BLE001
            logger.warning("Endpoint manual mal formado, se ignora: %s", ep)
            continue
        clave = f"{host}:{port}"
        nombre = await _validar_opcua(ep, settings.discovery_opcua_timeout) or ""
        resultados[clave] = EndpointPlc(endpoint=ep, host=host, port=port,
                                        nombre=nombre, origen="manual")

    # 2) Escaneo de la subred (opcional).
    if settings.discovery_enabled:
        subred = settings.resolve_subnet()
        if subred:
            logger.info("Escaneando subred %s en puerto %d...",
                        subred, settings.discovery_port)
            try:
                red = ipaddress.ip_network(subred, strict=False)
            except Exception as exc:  # noqa: BLE001
                logger.error("Subred inválida '%s': %s", subred, exc)
                red = None

            if red is not None:
                sem = asyncio.Semaphore(settings.discovery_concurrency)
                tareas = [
                    _sondear_host(str(ip), settings.discovery_port, settings, sem)
                    for ip in red.hosts()
                ]
                hallados = await asyncio.gather(*tareas, return_exceptions=True)
                for h in hallados:
                    if isinstance(h, EndpointPlc):
                        clave = f"{h.host}:{h.port}"
                        # No pisar un endpoint manual con uno de escaneo.
                        if clave not in resultados:
                            resultados[clave] = h
        else:
            logger.warning("No hay subred para escanear (define PLC_DISCOVERY_SUBNET).")

    lista = list(resultados.values())
    logger.info("Descubrimiento finalizado: %d PLC(s).", len(lista))
    return lista
