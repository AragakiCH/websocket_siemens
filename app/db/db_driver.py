# -*- coding: utf-8 -*-
"""
db_driver.py
============
Contrato ABSTRACTO de un driver de base de datos, análogo a `PlcDriver`.

La idea es la misma que con los PLCs: todo lo que está por encima (DbManager,
endpoints REST, widgets del frontend) habla SOLO con esta interfaz, nunca con
un motor concreto. Añadir MongoDB en el futuro es escribir otra clase que
implemente estos métodos, sin tocar nada más.

Motores cubiertos hoy por `SqlDriver` (todos vía SQLAlchemy async):

  ┌──────────────┬───────────────────────┬──────────────────────────────────┐
  │ Motor        │ Paquete necesario     │ URL de conexión                  │
  ├──────────────┼───────────────────────┼──────────────────────────────────┤
  │ PostgreSQL   │ asyncpg               │ postgresql+asyncpg://...         │
  │ MySQL/Maria  │ aiomysql              │ mysql+aiomysql://...             │
  │ SQL Server   │ aioodbc (+ ODBC 17/18)│ mssql+aioodbc://...              │
  │ SQLite       │ aiosqlite             │ sqlite+aiosqlite:///ruta.db      │
  └──────────────┴───────────────────────┴──────────────────────────────────┘
"""
from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional


@dataclass
class ResultadoConsulta:
    """
    Resultado normalizado de una consulta, listo para que lo pinte un widget.

    El formato es DELIBERADAMENTE plano y agnóstico del motor: el frontend
    dibuja una tabla o un gráfico sin saber si detrás hay PostgreSQL o Mongo.

    Attributes:
        columnas: nombres de columna, en orden (para cabeceras de tabla).
        filas:    lista de dicts {columna: valor}. Valores ya serializables
                  a JSON (fechas -> ISO 8601, Decimal -> float).
        num_filas: cantidad devuelta (tras aplicar el límite).
        truncado: True si se alcanzó el límite y hay más datos en la BD.
        ms:       tiempo de ejecución en milisegundos (para diagnóstico).
    """

    columnas: List[str] = field(default_factory=list)
    filas: List[Dict[str, Any]] = field(default_factory=list)
    num_filas: int = 0
    truncado: bool = False
    ms: float = 0.0

    def to_dict(self) -> dict:
        return {
            "columnas": self.columnas,
            "filas": self.filas,
            "num_filas": self.num_filas,
            "truncado": self.truncado,
            "ms": round(self.ms, 1),
        }


@dataclass
class InfoConexion:
    """Datos de conexión de una BD (sin la contraseña en claro)."""

    db_id: str
    motor: str                 # postgresql | mysql | mssql | sqlite
    host: str = ""
    puerto: Optional[int] = None
    base_datos: str = ""
    usuario: str = ""
    nombre: str = ""           # etiqueta legible para la vista
    conectado: bool = False
    ultimo_error: str = ""


class DbDriver(ABC):
    """Interfaz que debe implementar todo driver de base de datos."""

    @abstractmethod
    async def connect(self) -> None:
        """Abre el pool de conexiones. Lanza excepción si no puede."""

    @abstractmethod
    async def disconnect(self) -> None:
        """Cierra el pool limpiamente. No debe lanzar."""

    @abstractmethod
    async def test(self) -> float:
        """
        Comprueba que la BD responde (SELECT 1 o equivalente).
        Devuelve la latencia en milisegundos. Lanza excepción si falla.
        """

    @abstractmethod
    async def query(
        self,
        sql: str,
        parametros: Optional[Dict[str, Any]] = None,
        limite: int = 1000,
    ) -> ResultadoConsulta:
        """
        Ejecuta una consulta de LECTURA con parámetros nombrados (:nombre).

        Los parámetros NUNCA se interpolan en el texto del SQL: van por el
        mecanismo de bind del motor, que es lo que evita la inyección SQL.
        """

    @abstractmethod
    async def listar_tablas(self) -> List[str]:
        """Nombres de tablas/vistas disponibles (para ayudar al diseñador)."""

    @abstractmethod
    async def listar_columnas(self, tabla: str) -> List[Dict[str, str]]:
        """Columnas de una tabla: [{'nombre': ..., 'tipo': ...}, ...]."""

    @abstractmethod
    def is_connected(self) -> bool:
        """True si el pool está abierto."""
