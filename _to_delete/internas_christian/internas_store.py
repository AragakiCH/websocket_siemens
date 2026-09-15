# -*- coding: utf-8 -*-
"""
internas_store.py
=================
Variables INTERNAS: las que existen solo en el HMI, sin autómata detrás.

QUÉ SON Y PARA QUÉ
------------------
Un modo de trabajo, una consigna que el PLC no necesita conocer, un contador
de turno, un interruptor de «mostrar detalles» que enciende media pantalla.
Todo SCADA las tiene —TIA las llama variables internas del HMI; WebIQ, ítems
locales— porque no todo lo que gobierna una pantalla vive en el autómata.

Y sirven para algo más, que en la práctica es lo primero que se usa: PROBAR.
Con una variable interna se fuerza un valor a mano y se ve la animación
moverse, el faceplate cambiar y las dinámicas dispararse sin tener un PLC
delante.

NO CONFUNDIR CON `app/core/variables_store.py`
----------------------------------------------
Aquel crea variables DEL PLC reclamando huecos reservados en un DB: son
reales, el programa del autómata puede leerlas y actuar sobre ellas. Estas de
aquí no existen para el PLC y nunca existirán. Son las dos mitades de «crear
una variable», y hay que saber cuál se quiere:

    ¿la tiene que ver el programa del autómata?   -> variables_store
    ¿es solo cosa de la pantalla?                 -> esto

SON DE LA INSTALACIÓN, NO DEL NAVEGADOR
---------------------------------------
Viven en el servidor y se difunden por WebSocket, así que los veinte paneles
de la planta ven el mismo valor en el mismo instante y sobreviven a recargar.
Guardarlas en el navegador habría sido más barato y habría convertido cada
equipo en una isla: el operario de la sala cambia el modo y el de la nave no
se entera.

EL NOMBRE ES LA IDENTIDAD, Y POR ESO NO SE PUEDE CAMBIAR
-------------------------------------------------------
Un widget guarda `interno|modo`. Renombrar la variable dejaría huérfanos, en
silencio, todos los widgets enlazados a ella: seguirían pidiendo un tag que
ya no existe y se quedarían en «—» sin decir por qué. Se crea otra y se
borra esta, que obliga a pasar por el Diseñador y a ver qué se rompe.
"""
from __future__ import annotations

import asyncio
import json
import logging
import re
import threading
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from app.db.store import carpeta_datos

logger = logging.getLogger("internas_store")

FICHERO = "internas.json"

#: Los cuatro tipos que entiende la vista. Son los mismos que reparte
#: `plcAdapter.mapOpcType()` en el frontend, así que una variable interna se
#: comporta igual que una del PLC en todos los desplegables.
TIPOS = ("bool", "int", "double", "string")

#: De nuestro tipo corto al vocabulario OPC UA que habla el resto del sistema.
#: El frontend deduce el tipo con `mapOpcType()`, que espera estos nombres; si
#: aquí se pusiera "bool" a secas, acabaría clasificada como texto.
OPC = {"bool": "Boolean", "int": "Int32", "double": "Double", "string": "String"}

POR_DEFECTO: Dict[str, Any] = {
    "bool": False, "int": 0, "double": 0.0, "string": "",
}

#: El nombre acaba siendo un tag (`interno|<nombre>`) y viaja en JSON y en
#: URLs. Misma regla que los parámetros de faceplate y las variables con
#: nombre de un widget, por coherencia.
_RE_NOMBRE = re.compile(r"^[a-zA-Z][a-zA-Z0-9_]{0,63}$")


def _ahora_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


class ErrorInterna(ValueError):
    """Algo que el usuario puede corregir: nombre repetido, tipo inválido…"""


def convertir_valor(valor: Any, tipo: str) -> Any:
    """
    Deja el valor en el tipo de la variable, o falla diciendo por qué.

    No adivina: un «7» para un booleano se rechaza en vez de darlo por
    verdadero. Es el mismo criterio que `app/drivers/escritura.py` usa con los
    tags del PLC, y por el mismo motivo — una comodidad aquí es un arranque
    inesperado allí.
    """
    if tipo == "bool":
        if isinstance(valor, bool):
            return valor
        if isinstance(valor, (int, float)) and valor in (0, 1):
            return bool(valor)
        if isinstance(valor, str) and valor.strip().lower() in ("true", "false"):
            return valor.strip().lower() == "true"
        raise ErrorInterna(
            f"'{valor}' no es un sí/no. Se admite true, false, 0 o 1.")

    if tipo == "int":
        if isinstance(valor, bool):
            raise ErrorInterna("Un sí/no no es un entero.")
        try:
            n = int(valor)
        except (TypeError, ValueError):
            raise ErrorInterna(f"'{valor}' no es un número entero.")
        return n

    if tipo == "double":
        if isinstance(valor, bool):
            raise ErrorInterna("Un sí/no no es un número.")
        try:
            return float(valor)
        except (TypeError, ValueError):
            raise ErrorInterna(f"'{valor}' no es un número.")

    return "" if valor is None else str(valor)


def _normalizar_una(bruto: Any) -> Optional[dict]:
    """Una variable del fichero, saneada. `None` si no hay nada que salvar."""
    if not isinstance(bruto, dict):
        return None
    nombre = str(bruto.get("nombre") or "").strip()
    tipo = str(bruto.get("tipo") or "").strip()
    if not _RE_NOMBRE.match(nombre) or tipo not in TIPOS:
        logger.warning("Variable interna descartada al cargar: %r", bruto)
        return None
    try:
        valor = convertir_valor(bruto.get("valor", POR_DEFECTO[tipo]), tipo)
    except ErrorInterna:
        # El valor guardado ya no encaja con el tipo (alguien editó el fichero
        # a mano). Se pierde el valor, no la variable: es lo menos malo.
        valor = POR_DEFECTO[tipo]
    return {
        "nombre": nombre,
        "tipo": tipo,
        "valor": valor,
        "descripcion": str(bruto.get("descripcion") or "")[:200],
        "creado_en": str(bruto.get("creado_en") or _ahora_iso()),
        "creado_por": str(bruto.get("creado_por") or ""),
        "actualizado_en": str(bruto.get("actualizado_en") or ""),
        "actualizado_por": str(bruto.get("actualizado_por") or ""),
    }


class InternasStore:
    """Lee y escribe `datos/internas.json`."""

    def __init__(self, carpeta: Optional[str] = None) -> None:
        self.ruta = carpeta_datos(carpeta) / FICHERO
        self._vars: Dict[str, dict] = {}
        self._lock_hilos = threading.Lock()
        self._lock_async = asyncio.Lock()
        self.cargar()

    # ------------------------------------------------------------------ #
    # Disco
    # ------------------------------------------------------------------ #
    def cargar(self) -> None:
        if not self.ruta.exists():
            self._vars = {}
            self._escribir()
            logger.info("Creado %s (sin variables internas todavía).", FICHERO)
            return
        try:
            bruto = json.loads(self.ruta.read_text("utf-8"))
            lista = bruto.get("variables") if isinstance(bruto, dict) else None
            self._vars = {}
            for v in lista or []:
                limpia = _normalizar_una(v)
                if limpia:
                    self._vars[limpia["nombre"]] = limpia
            logger.info("InternasStore cargado: %d variable(s).", len(self._vars))
        except Exception as exc:  # noqa: BLE001
            # Mismo criterio que el resto de almacenes: si el fichero está
            # corrupto NO se pisa. Es la única copia de lo que alguien definió.
            logger.error(
                "%s ilegible (%s). Se sigue sin variables internas; el fichero "
                "NO se sobrescribe.", FICHERO, exc)
            self._vars = {}

    def _escribir(self) -> None:
        """Escritura atómica. Asume lock tomado."""
        doc = {
            "actualizado_en": _ahora_iso(),
            "variables": list(self._vars.values()),
        }
        tmp = self.ruta.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(doc, indent=2, ensure_ascii=False), encoding="utf-8")
        tmp.replace(self.ruta)

    def _guardar(self) -> None:
        with self._lock_hilos:
            self._escribir()

    # ------------------------------------------------------------------ #
    # Lectura
    # ------------------------------------------------------------------ #
    def listar(self) -> List[dict]:
        return [dict(v) for v in self._vars.values()]

    def obtener(self, nombre: str) -> Optional[dict]:
        v = self._vars.get(nombre)
        return dict(v) if v else None

    def existe(self, nombre: str) -> bool:
        return nombre in self._vars

    # ------------------------------------------------------------------ #
    # Mutaciones
    # ------------------------------------------------------------------ #
    def crear(self, nombre: str, tipo: str, valor: Any = None,
              descripcion: str = "", usuario: str = "") -> dict:
        nombre = (nombre or "").strip()
        if not _RE_NOMBRE.match(nombre):
            raise ErrorInterna(
                f"'{nombre}' no vale como nombre. Empieza por una letra y usa "
                "solo letras, números o guion bajo (hasta 64).")
        if nombre in self._vars:
            raise ErrorInterna(f"Ya existe una variable interna '{nombre}'.")
        if tipo not in TIPOS:
            raise ErrorInterna(
                f"Tipo '{tipo}' desconocido. Los válidos son: {', '.join(TIPOS)}.")

        v = {
            "nombre": nombre,
            "tipo": tipo,
            "valor": convertir_valor(
                POR_DEFECTO[tipo] if valor is None else valor, tipo),
            "descripcion": str(descripcion or "")[:200],
            "creado_en": _ahora_iso(),
            "creado_por": usuario,
            "actualizado_en": _ahora_iso(),
            "actualizado_por": usuario,
        }
        self._vars[nombre] = v
        self._guardar()
        return dict(v)

    def describir(self, nombre: str, descripcion: str, usuario: str = "") -> dict:
        """
        Cambia la descripción. NI el nombre NI el tipo: ver la cabecera.

        El tipo tampoco, porque decide qué widgets la aceptan: pasarla de
        `bool` a `double` dejaría enlazado un interruptor a un número y el
        enlace seguiría pareciendo correcto en el Inspector.
        """
        v = self._vars.get(nombre)
        if v is None:
            raise KeyError(nombre)
        v["descripcion"] = str(descripcion or "")[:200]
        v["actualizado_en"] = _ahora_iso()
        v["actualizado_por"] = usuario
        self._guardar()
        return dict(v)

    def borrar(self, nombre: str) -> None:
        if nombre not in self._vars:
            raise KeyError(nombre)
        del self._vars[nombre]
        self._guardar()

    def poner_valor(self, nombre: str, valor: Any, usuario: str = "") -> Any:
        """
        Fuerza el valor. Devuelve el valor ya convertido al tipo.

        Solo toca el disco si el valor CAMBIÓ. Un widget que reescriba lo
        mismo veinte veces por segundo —que los hay— no tiene por qué estar
        machacando el fichero.
        """
        v = self._vars.get(nombre)
        if v is None:
            raise KeyError(nombre)
        nuevo = convertir_valor(valor, v["tipo"])
        if v["valor"] == nuevo and type(v["valor"]) is type(nuevo):
            return nuevo
        v["valor"] = nuevo
        v["actualizado_en"] = _ahora_iso()
        v["actualizado_por"] = usuario
        self._guardar()
        return nuevo
