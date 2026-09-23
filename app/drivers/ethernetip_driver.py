# -*- coding: utf-8 -*-
"""
ethernetip_driver.py
====================
Driver de PLC para **Allen-Bradley / Rockwell** (ControlLogix, CompactLogix,
GuardLogix, Micro800) por **EtherNet/IP** (CIP explicit messaging, puerto
44818), usando `pycomm3` (pura Python, sin DLLs de Rockwell).

  ┌────────────────────┬───────────────────────────────────────────────────┐
  │ Transporte         │ EtherNet/IP · CIP · TCP 44818                     │
  │ Ruta               │ <ip>/<slot>  (slot del procesador en el chasis;   │
  │                    │ 0 en la mayoría de CompactLogix; Micro800 sin slot│
  │ Autenticación      │ No existe en CIP: el PLC acepta a quien llegue.   │
  │                    │ La única barrera es la red y el modo del selector │
  │                    │ (REMOTE RUN permite escribir; RUN no).            │
  │ Descubrir tags     │ Upload de la lista de tags del controlador        │
  │                    │ (controller-scoped + program-scoped) y de sus UDT │
  │ Lectura            │ Multi-service packet: pycomm3 empaqueta varios    │
  │                    │ tags por petición hasta llenar el conexión CIP    │
  │ Tiempo real        │ NO hay subscription en explicit messaging: es     │
  │                    │ POLLING en bloque, con detección de cambios       │
  │ Escritura          │ CIP Write Tag, con el tipo del tag                │
  └────────────────────┴───────────────────────────────────────────────────┘

LO QUE HAY QUE SABER
  * `pycomm3` es SÍNCRONO. Cada llamada va a un hilo del executor para no
    frenar el bucle de eventos (que es el que mueve los WebSockets de los
    diez visores). Un solo `LogixDriver` por PLC, con su propio lock.
  * Los tags de un Logix pueden ser estructuras (UDT, TIMER, COUNTER...) y
    arrays. Se APLANAN: `Motor1.Velocidad`, `Temps[3]`, hasta la profundidad
    y el número de elementos configurados. Sin tope, un `DINT[10000]` daría
    diez mil tags.
  * El `node_id` de cada tag es su NOMBRE completo de Logix
    (`Program:Main.Contador`, `Tanque.Nivel`, `Alarmas[2]`): es lo que lee y
    escribe pycomm3 tal cual.
  * Los tipos salen con el nombre Logix (BOOL, SINT, INT, DINT, LINT, REAL,
    LREAL, STRING, USINT, UINT, UDINT, ULINT), que coincide con el IEC que ya
    entienden `escritura.convertir` y el frontend.
  * Micro800: `pycomm3` los soporta con `micro800=True` (sin slot). El
    upload de tags funciona en firmware reciente; si no, hay que dar la lista
    a mano en `PLC_AB_TAGS`.

CÓMO SE DA DE ALTA
  POST /plcs  {"host": "192.168.1.10", "vendor": "allenbradley", "slot": 0}
"""
from __future__ import annotations

import asyncio
import logging
import re
import threading
import time
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

from app.config.settings import Settings
from app.drivers.escritura import convertir
from app.drivers.plc_driver import (
    DataChangeCallback,
    PlcDriver,
    TagInfo,
    TagValue,
)

logger = logging.getLogger("ethernetip_driver")

#: Puerto EtherNet/IP.
PUERTO_ENIP = 44818

#: Tipos atómicos de Logix que se exponen como tag escalar.
TIPOS_ATOMICOS = {
    "BOOL", "SINT", "INT", "DINT", "LINT", "USINT", "UINT", "UDINT", "ULINT",
    "REAL", "LREAL", "STRING", "BIT", "BYTE", "WORD", "DWORD", "LWORD",
    "CHAR",
}

#: Miembros internos de UDT/estructuras del sistema que no son datos de
#: proceso (bits de estado de TIMER/COUNTER sí se dejan: son útiles).
MIEMBROS_IGNORADOS = {"ZZZZZZZZZZ", "LEN"}  # LEN de STRING se lee con el STRING

#: Prefijos de tags del sistema que no interesan.
PREFIJOS_IGNORADOS = ("__", "Program:__", "Map:", "Task:", "Routine:",
                      "Module:", "Cxn:")


def _ahora_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _serializable(valor: object) -> object:
    if isinstance(valor, (bool, int, float, str)) or valor is None:
        return valor
    if isinstance(valor, bytes):
        return valor.decode("latin-1", "replace")
    if isinstance(valor, (list, tuple)):
        return [_serializable(v) for v in valor]
    if isinstance(valor, dict):
        return {str(k): _serializable(v) for k, v in valor.items()}
    return str(valor)


def host_de(valor: str) -> str:
    """'enip://192.168.1.10:44818/1' -> '192.168.1.10'; también IP pelada."""
    v = (valor or "").strip()
    if "://" in v:
        v = v.split("://", 1)[1]
    v = v.split("/", 1)[0]
    return v.split(":", 1)[0].strip()


def slot_de(valor: str, por_defecto: int = 0) -> int:
    """Slot del endpoint `enip://host:puerto/<slot>`, o el defecto."""
    v = (valor or "").strip()
    if "://" in v:
        v = v.split("://", 1)[1]
    if "/" in v:
        try:
            return int(v.split("/", 1)[1].strip("/"))
        except ValueError:
            pass
    return por_defecto


def endpoint_enip(host: str, slot: int = 0, puerto: int = PUERTO_ENIP) -> str:
    return f"enip://{host_de(host)}:{puerto}/{int(slot)}"


def _tipo_iec(tipo_logix: str) -> str:
    t = (tipo_logix or "").upper()
    return {"BIT": "BOOL", "CHAR": "SINT"}.get(t, t or "UNKNOWN")


# ====================================================================== #
# Exploración previa (sin driver): ¿responde? ¿qué es?
# ====================================================================== #
def _cargar_logix():
    """
    Importa `LogixDriver` de pycomm3 —solo cuando hay un PLC Allen-Bradley—
    y, si el paquete no está, lo dice con nombre y apellidos.

    El error crudo (`ModuleNotFoundError: No module named 'pycomm3'`) es lo
    que se vio en la ventana de escritorio: el .exe se había generado desde
    un venv sin pycomm3 instalado, y PyInstaller no puede empaquetar lo que
    no encuentra (deja un aviso en build/psi_core/warn-psi_core.txt y sigue).
    Con este mensaje quien lo lee sabe que NO es la red ni el PLC, sino la
    instalación, y qué hacer.
    """
    try:
        from pycomm3 import LogixDriver
    except ImportError as exc:
        raise RuntimeError(
            "Esta instalación no incluye el cliente EtherNet/IP (paquete "
            "'pycomm3'), así que no puede hablar con PLCs Allen-Bradley. "
            "En desarrollo: pip install -r requirements.txt. En el .exe: "
            "instalar pycomm3 en el venv con el que se compila "
            "(pip install -r requirements-desktop.txt) y volver a generar "
            "con desktop\\build_exe.bat."
        ) from exc
    return LogixDriver


def _identificar_sync(host: str, slot: int, timeout: float) -> dict:
    LogixDriver = _cargar_logix()  # import local: solo con PLCs AB
    ruta = f"{host}/{slot}"
    plc = LogixDriver(ruta, init_tags=False, init_program_tags=False)
    plc.socket_timeout = timeout
    with plc:
        info = dict(plc.info or {})
    return {
        "nombre": info.get("name", ""),
        "producto": info.get("product_name", ""),
        "revision": info.get("revision", {}),
        "serial": info.get("serial", ""),
        "modo": info.get("keyswitch", ""),
        "vendor": info.get("vendor", ""),
    }


async def identificar(host: str, slot: int = 0, timeout: float = 5.0) -> dict:
    """
    Identidad CIP del controlador (nombre del proyecto, modelo, revisión,
    posición del selector). Lanza si no responde.
    """
    bucle = asyncio.get_running_loop()
    return await bucle.run_in_executor(
        None, _identificar_sync, host_de(host), int(slot), float(timeout))


async def probar(host: str, slot: int = 0, timeout: float = 5.0) -> Tuple[str, dict]:
    """
    ('OK' | 'DOWN' | 'SIN_DRIVER', info). No hay AUTH_INVALID: CIP no
    autentica. `SIN_DRIVER` es "falta pycomm3 en esta instalación": no es un
    problema de red y no hay IP ni slot que revisar, así que se distingue
    para que la vista no mande a mirar el cable.
    """
    try:
        return "OK", await identificar(host, slot, timeout)
    except RuntimeError as exc:
        if "pycomm3" in str(exc):
            return "SIN_DRIVER", {"error": str(exc)}
        return "DOWN", {"error": f"{type(exc).__name__}: {exc}"}
    except Exception as exc:  # noqa: BLE001
        return "DOWN", {"error": f"{type(exc).__name__}: {exc}"}


# ====================================================================== #
# El driver
# ====================================================================== #
class EthernetIpDriver(PlcDriver):
    """Allen-Bradley Logix por EtherNet/IP (pycomm3), polling en bloque."""

    def __init__(self, settings: Settings) -> None:
        self._settings = settings
        self._plc: Any = None                  # pycomm3.LogixDriver
        self._lock = threading.Lock()          # pycomm3 no es thread-safe
        self._connected = False
        self._callback: Optional[DataChangeCallback] = None
        self._tarea_polling: Optional[asyncio.Task] = None
        self.modo_lectura: str = "-"
        self.info_plc: dict = {}

        self.tag_por_nodeid: Dict[str, TagInfo] = {}
        self.ultimos_valores: Dict[str, TagValue] = {}
        self.tags_descubiertos: List[TagInfo] = []
        self.ultimo_cambio_ts: Dict[str, datetime] = {}

    # ---- datos de conexión ---------------------------------------------- #
    @property
    def _host(self) -> str:
        return host_de(self._settings.opcua_endpoint)

    @property
    def _slot(self) -> int:
        return slot_de(self._settings.opcua_endpoint,
                       int(getattr(self._settings, "ab_slot", 0)))

    def _ruta_cip(self) -> str:
        """`ip/slot` para Logix con chasis; solo la IP en un Micro800."""
        if bool(getattr(self._settings, "ab_micro800", False)):
            return self._host
        return f"{self._host}/{self._slot}"

    async def _en_hilo(self, fn, *args):
        """Ejecuta una llamada síncrona de pycomm3 fuera del bucle async."""
        bucle = asyncio.get_running_loop()

        def con_lock():
            with self._lock:
                return fn(*args)
        return await bucle.run_in_executor(None, con_lock)

    # ================================================================== #
    # Conexión
    # ================================================================== #
    async def connect(self) -> None:
        LogixDriver = _cargar_logix()

        timeout = float(getattr(self._settings, "ab_connect_timeout", 5.0))
        ruta = self._ruta_cip()

        def abrir():
            # `init_tags=False`: la lista se sube en browse_tags(), donde se
            # puede acotar (programas, lista manual) y donde un fallo se
            # explica. pycomm3 detecta solo si es un Micro800.
            plc = LogixDriver(ruta, init_tags=False, init_program_tags=False)
            plc.socket_timeout = timeout
            plc.open()
            return plc

        self._plc = await self._en_hilo(abrir)
        self._connected = True
        self.info_plc = dict(getattr(self._plc, "info", {}) or {})
        logger.info("EtherNet/IP conectado a %s: %s (%s, rev %s, %s)",
                    ruta, self.info_plc.get("name", "?"),
                    self.info_plc.get("product_name", "?"),
                    self.info_plc.get("revision", "?"),
                    self.info_plc.get("keyswitch", "?"))

    async def disconnect(self) -> None:
        await self._detener_lectura()
        if self._plc is not None:
            try:
                await self._en_hilo(self._plc.close)
            except Exception as exc:  # noqa: BLE001
                logger.debug("Error al cerrar la sesión CIP: %s", exc)
        self._plc = None
        self._connected = False
        self.modo_lectura = "-"

    def is_connected(self) -> bool:
        return self._connected and self._plc is not None

    async def check_alive(self) -> bool:
        """Watchdog: un Get Attributes de identidad, barato."""
        if self._plc is None:
            return False
        try:
            def leer_identidad():
                if hasattr(self._plc, "get_plc_info"):
                    return self._plc.get_plc_info()
                return self._plc.info
            info = await self._en_hilo(leer_identidad)
            if isinstance(info, dict):
                self.info_plc = dict(info)
            return True
        except Exception:  # noqa: BLE001
            self._connected = False
            return False

    # ================================================================== #
    # Descubrimiento de tags
    # ================================================================== #
    async def browse_tags(self) -> List[TagInfo]:
        if self._plc is None:
            raise RuntimeError("browse_tags llamado sin conexión activa.")

        # pycomm3 necesita la definición de los tags (tipos, UDTs) para poder
        # leer y escribir, así que la lista se sube SIEMPRE; la manual solo
        # decide cuáles de ellos se exponen.
        incluir_programas = bool(getattr(self._settings, "ab_incluir_programas", True))

        def subir():
            return self._plc.get_tag_list(program="*" if incluir_programas else None)
        try:
            lista = await self._en_hilo(subir)
        except Exception as exc:  # noqa: BLE001
            raise RuntimeError(
                f"No se pudo descargar la lista de tags de {self._host}: {exc}. "
                f"Revisa que el slot sea el del procesador y que el proyecto "
                f"esté descargado."
            ) from exc

        manuales = self._tags_manuales()
        if manuales:
            catalogo = await self._catalogo_manual(manuales)
        else:
            catalogo = self._aplanar(lista or [])

        if not catalogo:
            raise RuntimeError(
                f"El controlador {self._host} no expone ningún tag legible. "
                f"¿Hay un proyecto descargado y tags con External Access "
                f"distinto de None?"
            )

        self.tag_por_nodeid.clear()
        self.tags_descubiertos = []
        for nombre, tipo, programa in catalogo:
            info = TagInfo(
                name=nombre.split(":", 1)[-1].split(".", 1)[-1]
                if nombre.startswith("Program:") else nombre,
                full_name=nombre,
                node_id=nombre,
                data_type=_tipo_iec(tipo),
                db_name=programa or "Controller",
            )
            self.tag_por_nodeid[nombre] = info
            self.tags_descubiertos.append(info)

        logger.info("Allen-Bradley %s: %d tags (%s).", self._host,
                    len(self.tags_descubiertos),
                    "lista manual" if manuales else "upload del controlador")
        return list(self.tags_descubiertos)

    def _tags_manuales(self) -> List[str]:
        crudo = (getattr(self._settings, "ab_tags", "") or "").strip()
        return [t.strip() for t in re.split(r"[,\n;]+", crudo) if t.strip()]

    async def _catalogo_manual(self, nombres: List[str]) -> List[Tuple[str, str, str]]:
        """Tags dados a mano: se leen una vez para conocer su tipo."""
        def leer():
            return self._plc.read(*nombres)
        resultados = await self._en_hilo(leer)
        if not isinstance(resultados, list):
            resultados = [resultados]
        salida = []
        for r in resultados:
            if getattr(r, "error", None):
                logger.warning("Tag manual '%s' no se pudo leer: %s", r.tag, r.error)
                continue
            programa = r.tag.split(":", 1)[1].split(".", 1)[0] if r.tag.startswith("Program:") else ""
            salida.append((r.tag, str(r.type or ""), programa))
        return salida

    def _aplanar(self, lista: List[dict]) -> List[Tuple[str, str, str]]:
        """
        De la lista cruda de pycomm3 a (nombre_completo, tipo, programa).

        Forma de cada entrada de `get_tag_list()`:
            tag_name, tag_type ('atomic'|'struct'), data_type (str o dict),
            data_type_name, dim, dimensions [d1,d2,d3], external_access, alias
        y de un struct: data_type = {name, internal_tags: {miembro: {data_type,
        data_type_name, tag_type, array, bit?, offset}}, attributes, string?}.

        Las estructuras (UDT, TIMER, COUNTER...) se expanden miembro a
        miembro y los arrays elemento a elemento, con los topes de settings.
        """
        prof_max = int(getattr(self._settings, "ab_browse_depth", 3))
        max_elem = int(getattr(self._settings, "ab_max_elementos_array", 64))
        salida: List[Tuple[str, str, str]] = []

        def expandir(nombre: str, tipo: Any, tipo_nombre: str, dims: List[int],
                     programa: str, nivel: int) -> None:
            dims = [int(d or 0) for d in (dims or [])]
            if dims and dims[0] > 0:
                # Arrays multidimensionales se aplanan por la primera
                # dimensión; las siguientes quedan como [i][j] al recursar.
                n = min(dims[0], max_elem)
                if dims[0] > max_elem:
                    logger.debug("Array %s[%d] recortado a %d elementos.",
                                 nombre, dims[0], max_elem)
                resto = dims[1:]
                for i in range(n):
                    expandir(f"{nombre}[{i}]", tipo, tipo_nombre, resto, programa, nivel)
                return

            if isinstance(tipo, dict):
                if tipo.get("string") or str(tipo.get("name", "")).upper().startswith("STRING"):
                    salida.append((nombre, "STRING", programa))
                    return
                if nivel >= prof_max:
                    return
                miembros = tipo.get("internal_tags") or {}
                # `attributes` es la lista de miembros PÚBLICOS que ya filtra
                # pycomm3 (fuera los ZZZZ, los __privados y el CTL/Control
                # de los tipos predefinidos). Si no viene, se miran todos.
                publicos = tipo.get("attributes") or list(miembros.keys())
                for m_nombre in publicos:
                    m = miembros.get(m_nombre)
                    if not isinstance(m, dict):
                        continue
                    if (m_nombre.startswith("ZZZZ") or m_nombre.startswith("__")
                            or m_nombre in MIEMBROS_IGNORADOS):
                        continue
                    m_dims = [int(m.get("array") or 0)]
                    expandir(f"{nombre}.{m_nombre}", m.get("data_type"),
                             str(m.get("data_type_name") or ""), m_dims,
                             programa, nivel + 1)
                return

            t = (tipo_nombre or str(tipo or "")).upper()
            if t.startswith("STRING"):
                salida.append((nombre, "STRING", programa))
            elif t in TIPOS_ATOMICOS:
                salida.append((nombre, t, programa))
            # Tipos raros (DWORD de bits ocultos, punteros) se ignoran.

        for tag in lista:
            nombre = str(tag.get("tag_name", "") or "")
            if not nombre or nombre.startswith(PREFIJOS_IGNORADOS):
                continue
            if str(tag.get("external_access", "") or "").lower() == "none":
                continue
            programa = (nombre.split(":", 1)[1].split(".", 1)[0]
                        if nombre.startswith("Program:") else "")
            expandir(nombre, tag.get("data_type"),
                     str(tag.get("data_type_name") or ""),
                     list(tag.get("dimensions") or [])[: int(tag.get("dim") or 0)],
                     programa, 0)
        return salida

    # ================================================================== #
    # Tiempo real: polling en bloque
    # ================================================================== #
    async def subscribe(self, tags: List[TagInfo], callback: DataChangeCallback) -> None:
        """
        EtherNet/IP explicit messaging no tiene subscription: se lee en
        bloque cada `ab_poll_interval_ms` y se emite solo lo que cambia. La
        primera pasada emite todo (snapshot inicial para el handler).
        """
        if self._plc is None:
            raise RuntimeError("subscribe llamado sin conexión activa.")
        await self._detener_lectura()
        self._callback = callback
        await self._leer_y_emitir(tags, solo_cambios=False)
        self.modo_lectura = "polling"
        self._tarea_polling = asyncio.create_task(self._bucle_polling(tags))

    async def _bucle_polling(self, tags: List[TagInfo]) -> None:
        intervalo = max(50, int(getattr(self._settings, "ab_poll_interval_ms", 250)))
        fallos = 0
        try:
            while self._connected:
                t0 = time.monotonic()
                try:
                    await self._leer_y_emitir(tags, solo_cambios=True)
                    fallos = 0
                except Exception as exc:  # noqa: BLE001
                    fallos += 1
                    logger.warning("Allen-Bradley %s: fallo de lectura (%d): %s",
                                   self._host, fallos, exc)
                    if fallos >= 3:
                        # Tres seguidos: la sesión CIP está muerta. El
                        # handler verá is_connected()=False y reconectará.
                        self._connected = False
                        return
                resto = intervalo / 1000.0 - (time.monotonic() - t0)
                await asyncio.sleep(resto if resto > 0 else 0.01)
        except asyncio.CancelledError:
            pass

    async def _leer_bloque(self, nombres: List[str]) -> Dict[str, Tuple[str, object, str]]:
        """{nombre: (tipo, valor, error)}. pycomm3 empaqueta en multi-service."""
        if not nombres:
            return {}
        max_lote = int(getattr(self._settings, "ab_bulk_max", 100))
        salida: Dict[str, Tuple[str, object, str]] = {}
        for i in range(0, len(nombres), max_lote):
            lote = nombres[i:i + max_lote]

            def leer(l=lote):
                return self._plc.read(*l)
            resultados = await self._en_hilo(leer)
            # OJO: `Tag` es un namedtuple, o sea una tupla. Solo una LISTA
            # significa "varios resultados"; un Tag suelto se envuelve.
            if not isinstance(resultados, list):
                resultados = [resultados]
            for nombre, r in zip(lote, resultados):
                salida[nombre] = (str(getattr(r, "type", "") or ""),
                                  getattr(r, "value", None),
                                  str(getattr(r, "error", "") or ""))
        return salida

    async def _leer_y_emitir(self, tags: List[TagInfo], solo_cambios: bool) -> None:
        if not self._callback:
            return
        leidos = await self._leer_bloque([t.node_id for t in tags])
        for info in tags:
            tipo, valor, error = leidos.get(info.node_id, ("", None, "sin respuesta"))
            if error:
                continue
            valor_s = _serializable(valor)
            if solo_cambios:
                ant = self.ultimos_valores.get(info.full_name)
                if ant is not None and ant.value == valor_s:
                    continue
            await self._emitir(info, valor_s)

    async def _emitir(self, info: TagInfo, valor: object) -> None:
        if not self._callback:
            return
        ahora = datetime.now(timezone.utc)
        delta_ms: Optional[float] = None
        anterior = self.ultimo_cambio_ts.get(info.full_name)
        if anterior is not None:
            delta_ms = (ahora - anterior).total_seconds() * 1000.0
        self.ultimo_cambio_ts[info.full_name] = ahora
        tv = TagValue(
            tag=info.full_name, value=valor, data_type=info.data_type,
            timestamp=ahora.isoformat(), node_id=info.node_id,
            source_ts=ahora.isoformat(),
            delta_ms=round(delta_ms, 1) if delta_ms is not None else None,
        )
        self.ultimos_valores[info.full_name] = tv
        await self._callback(tv)

    async def _detener_lectura(self) -> None:
        if self._tarea_polling is not None:
            self._tarea_polling.cancel()
            try:
                await self._tarea_polling
            except (asyncio.CancelledError, Exception):  # noqa: BLE001
                pass
        self._tarea_polling = None

    # ================================================================== #
    # Lectura puntual y escritura
    # ================================================================== #
    async def read_tags(self, node_ids: List[str]) -> List[Optional[TagValue]]:
        if self._plc is None:
            raise RuntimeError("read_tags llamado sin conexión activa.")
        try:
            leidos = await self._leer_bloque(node_ids)
        except Exception as exc:  # noqa: BLE001
            logger.debug("Lectura en bloque fallida (%d tags): %s", len(node_ids), exc)
            return [None] * len(node_ids)
        ahora = _ahora_iso()
        salida: List[Optional[TagValue]] = []
        for n in node_ids:
            tipo, valor, error = leidos.get(n, ("", None, "sin respuesta"))
            if error:
                salida.append(None)
                continue
            info = self.tag_por_nodeid.get(n)
            salida.append(TagValue(
                tag=info.full_name if info else n, value=_serializable(valor),
                data_type=info.data_type if info else _tipo_iec(tipo),
                timestamp=ahora, node_id=n,
            ))
        return salida

    async def read_tag(self, node_id: str) -> TagValue:
        if self._plc is None:
            raise RuntimeError("read_tag llamado sin conexión activa.")
        leidos = await self._leer_bloque([node_id])
        tipo, valor, error = leidos.get(node_id, ("", None, "sin respuesta"))
        if error:
            raise KeyError(f"No se pudo leer '{node_id}': {error}")
        info = self.tag_por_nodeid.get(node_id)
        return TagValue(
            tag=info.full_name if info else node_id, value=_serializable(valor),
            data_type=info.data_type if info else _tipo_iec(tipo),
            timestamp=_ahora_iso(), node_id=node_id,
        )

    async def write_tag(self, node_id: str, valor: object) -> TagValue:
        """
        CIP Write Tag y relectura. La conversión es la de siempre
        (`escritura.convertir`): un 'hola' en un DINT falla antes de salir.

        Si el PLC rechaza la escritura, lo normal en un Logix es una de dos:
        el selector está en RUN (solo REMOTE RUN / PROGRAM admiten escritura
        externa) o el tag tiene External Access = Read Only. Se dice.
        """
        if self._plc is None:
            raise RuntimeError("write_tag llamado sin conexión activa.")
        info = self.tag_por_nodeid.get(node_id)
        if info is None:
            raise KeyError(f"El tag '{node_id}' no existe en este PLC.")
        convertido = convertir(valor, info.data_type)

        def escribir():
            return self._plc.write((node_id, convertido))
        r = await self._en_hilo(escribir)
        if isinstance(r, list):
            r = r[0]
        error = getattr(r, "error", None)
        if error:
            raise PermissionError(
                f"El PLC rechazó la escritura de '{node_id}': {error}. Revisa "
                f"que el selector esté en REMOTE RUN (no en RUN) y que el tag "
                f"tenga External Access = Read/Write."
            )
        return await self.read_tag(node_id)
