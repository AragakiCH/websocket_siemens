# -*- coding: utf-8 -*-
"""
plc_driver.py
=============
Interfaz abstracta (ABC) para cualquier driver de PLC.

El objetivo de esta capa es DESACOPLAR el resto de la aplicación (API, WebSocket,
manejo de subscriptions) del protocolo concreto que se use para hablar con el PLC.
Hoy tenemos una implementación OPC UA (`OpcUaDriver`), pero mañana podría añadirse
un driver Modbus, un driver S7 nativo, etc., SIN tocar el resto del código: basta
con implementar esta misma interfaz.

Todos los métodos de I/O son asíncronos (async/await), porque el pipeline completo
—desde la lectura del PLC hasta el envío por WebSocket— es no bloqueante.
"""
from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Awaitable, Callable, Dict, List, Optional


@dataclass
class TagInfo:
    """
    Descripción de un tag descubierto en el PLC.

    Atributos:
        name:      Nombre "amigable" del tag (ej. "temperatura").
        full_name: Nombre calificado incluyendo el DB (ej. "DB_snap7.temperatura").
        node_id:   Identificador del nodo en el protocolo (ej. NodeId OPC UA).
        data_type: Tipo de dato legible (ej. "Real", "Bool", "Int", "String").
        db_name:   Nombre del Data Block al que pertenece.
    """

    name: str
    full_name: str
    node_id: str
    data_type: str
    db_name: str = ""


@dataclass
class TagValue:
    """
    Valor puntual de un tag en un instante dado.

    Se usa tanto para snapshots como para notificaciones de cambio.
    """

    tag: str          # full_name del tag
    value: object     # valor ya convertido a tipo Python nativo / serializable
    data_type: str    # tipo de dato legible
    timestamp: str    # ISO 8601 (UTC) - momento en que el backend recibió el dato
    node_id: str = ""
    # Marca de tiempo de ORIGEN: cuándo cambió realmente el valor en el PLC
    # (SourceTimestamp de OPC UA). Es el "cuándo fue el cambio" más preciso.
    source_ts: str = ""
    # Marca de tiempo del SERVIDOR OPC UA (ServerTimestamp).
    server_ts: str = ""
    # Milisegundos transcurridos desde el cambio anterior de ESTE tag.
    # None en el primer valor (snapshot inicial).
    delta_ms: Optional[float] = None


# Firma del callback que recibe los cambios de valor desde el driver.
# El driver invoca este callback (async) cada vez que el PLC notifica un cambio.
DataChangeCallback = Callable[[TagValue], Awaitable[None]]


class PlcDriver(ABC):
    """
    Contrato que debe cumplir cualquier driver de PLC.

    Implementaciones concretas: OpcUaDriver (OPC UA vía asyncua).
    Futuras: ModbusDriver, S7Driver, etc.
    """

    @abstractmethod
    async def connect(self) -> None:
        """Establece la conexión/sesión con el PLC. Lanza excepción si falla."""
        raise NotImplementedError

    @abstractmethod
    async def disconnect(self) -> None:
        """Cierra limpiamente subscriptions y la sesión con el PLC."""
        raise NotImplementedError

    @abstractmethod
    async def browse_tags(self) -> List[TagInfo]:
        """
        Descubre automáticamente los tags disponibles en el PLC.
        Devuelve una lista de TagInfo. No debe requerir configuración manual.
        """
        raise NotImplementedError

    @abstractmethod
    async def subscribe(
        self,
        tags: List[TagInfo],
        callback: DataChangeCallback,
    ) -> None:
        """
        Crea una subscription en tiempo real sobre los tags indicados.
        Cada cambio de valor debe reenviarse invocando `callback(TagValue)`.
        NO debe usar polling: se apoya en el mecanismo nativo del protocolo.
        """
        raise NotImplementedError

    @abstractmethod
    async def read_tag(self, node_id: str) -> TagValue:
        """Lee de forma puntual (one-shot) el valor actual de un tag."""
        raise NotImplementedError

    @abstractmethod
    def is_connected(self) -> bool:
        """Devuelve True si la conexión con el PLC está activa."""
        raise NotImplementedError
