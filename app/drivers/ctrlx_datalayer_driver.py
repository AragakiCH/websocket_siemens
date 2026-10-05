# -*- coding: utf-8 -*-
"""
ctrlx_datalayer_driver.py
=========================
Driver de PLC para **Bosch Rexroth ctrlX CORE / VirtualControl** hablando
DIRECTAMENTE con el ctrlX Data Layer por su API REST (HTTPS), sin OPC UA.

Es el port a `websocket_siemens` de lo que ya funciona en `WebSocket_RX`
(`datalayer/auth.py`, `datalayer/client.py`, `datalayer/reader.py`,
`plc/discovery.probe_auth`), adaptado a la interfaz `PlcDriver` para que el
resto del pipeline (SubscriptionHandler → ConnectionManager → WebSocket →
frontend) no note ninguna diferencia respecto al driver OPC UA.

  ┌────────────────────┬───────────────────────────────────────────────────┐
  │ Autenticación      │ POST /identity-manager/api/v2/auth/token          │
  │                    │ {name, password} -> JWT (access + refresh).       │
  │                    │ Se refresca solo antes de caducar (margen 30 s) y │
  │                    │ si el refresh falla se hace login limpio.         │
  │ Símbolos           │ plc/app/<app>/sym/<programa>/<variable>           │
  │ Browse             │ GET /automation/api/v2/nodes/<ruta>?type=browse   │
  │ Lectura en bloque  │ PUT /automation/api/v2/bulk?type=read             │
  │                    │ (el formato del body cambia entre firmwares: se   │
  │                    │ prueban las variantes conocidas y se recuerda la  │
  │                    │ que acepte; si ninguna, GET individuales)         │
  │ Tiempo real        │ GET /automation/api/v2/events?nodes=..  (SSE)     │
  │                    │ con fallback a polling en bloque si el SSE no     │
  │                    │ entrega nada en `rexroth_subscription_grace_s`    │
  │ Escritura          │ PUT /automation/api/v2/nodes/<ruta> {type,value}  │
  └────────────────────┴───────────────────────────────────────────────────┘

QUÉ CAMBIA RESPECTO AL DRIVER OPC UA (`rexroth_driver.py`)
  * No hay certificado de cliente que aceptar en el ctrlX: el JWT basta.
    Adiós al "401 hasta que confíes el certificado en Settings → Certificates".
  * El puerto es el HTTPS del ctrlX (443; 8443 en un COREvirtual con
    port-forwarding), no el 4840.
  * El `node_id` de cada tag es su RUTA en el Data Layer
    (`plc/app/Application/sym/PLC_PRG/temperatura`), que es estable entre
    reinicios — un NodeId OPC UA numérico no lo era.
  * El certificado autofirmado del ctrlX se acepta por defecto
    (`rexroth_verify_ssl=False`), igual que hacía WebSocket_RX. En una planta
    con PKI propia se puede exigir verificación.

Todo es async sobre `httpx` (ya era dependencia del proyecto): ni un hilo,
ni `requests`.
"""
from __future__ import annotations

import asyncio
import json
import logging
import time
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

import httpx

from app.config.settings import Settings
from app.drivers.escritura import convertir
from app.drivers.plc_driver import (
    DataChangeCallback,
    PlcDriver,
    TagInfo,
    TagValue,
)

logger = logging.getLogger("ctrlx_datalayer")

#: Raíz de las aplicaciones PLC en el Data Layer.
RAIZ_APPS = "plc/app"

#: Margen, en segundos, con el que se renueva el JWT antes de que caduque.
MARGEN_REFRESCO_S = 30.0

#: Tipo Data Layer -> tipo IEC 61131 (el que enseña el frontend).
DL_A_IEC: Dict[str, str] = {
    "bool8": "BOOL", "int8": "SINT", "uint8": "BYTE", "int16": "INT",
    "uint16": "UINT", "int32": "DINT", "uint32": "UDINT", "int64": "LINT",
    "uint64": "ULINT", "float": "REAL", "float32": "REAL", "double": "LREAL",
    "float64": "LREAL", "string": "STRING",
}

#: Tipo IEC -> tipo Data Layer, para escribir.
IEC_A_DL: Dict[str, str] = {
    "BOOL": "bool8", "SINT": "int8", "BYTE": "uint8", "INT": "int16",
    "UINT": "uint16", "DINT": "int32", "UDINT": "uint32", "LINT": "int64",
    "ULINT": "uint64", "REAL": "float", "LREAL": "double", "STRING": "string",
    # Por si el tipo llega en vocabulario OPC UA (escritura.normalizar_tipo).
    "BOOLEAN": "bool8", "INT16": "int16", "INT32": "int32", "INT64": "int64",
    "UINT16": "uint16", "UINT32": "uint32", "UINT64": "uint64",
    "FLOAT": "float", "DOUBLE": "double",
}

#: Variantes conocidas del body de bulk-read. `list_address` va primero: es
#: el formato que documenta Bosch y el que pide el firmware actual.
_FORMAS_BULK = {
    "list_address":  lambda rutas: [{"address": r} for r in rutas],
    "list_node":     lambda rutas: [{"node": r} for r in rutas],
    "list_nodePath": lambda rutas: [{"nodePath": r} for r in rutas],
    "dict_nodes":    lambda rutas: {"nodes": [{"node": r} for r in rutas]},
    "list_str":      lambda rutas: list(rutas),
}


# ====================================================================== #
# Utilidades
# ====================================================================== #
def tipo_iec(dl_type: str) -> str:
    """'float64' -> 'LREAL'. Los arrays (arrayOfBool8, ...) salen como ARRAY."""
    t = (dl_type or "").strip()
    if not t:
        return "UNKNOWN"
    if t.startswith("arrayOf"):
        return "ARRAY"
    return DL_A_IEC.get(t.lower(), t.upper())


def tipo_dl(iec: str, valor: object) -> str:
    """Tipo Data Layer para escribir: por el tipo del tag y, si no, por el valor."""
    t = IEC_A_DL.get((iec or "").strip().upper())
    if t:
        return t
    if isinstance(valor, bool):
        return "bool8"
    if isinstance(valor, int):
        return "int32"
    if isinstance(valor, float):
        return "double"
    return "string"


def host_de(valor: str) -> str:
    """
    Host pelado a partir de cualquier cosa:
        'https://192.168.1.1:443' -> '192.168.1.1'
        'opc.tcp://ctrlx:4840'    -> 'ctrlx'
        '192.168.1.1:8443'        -> '192.168.1.1'
    """
    v = (valor or "").strip()
    if "://" in v:
        v = v.split("://", 1)[1]
    v = v.split("/", 1)[0]
    return v.split(":", 1)[0].strip()


def puerto_de(valor: str, por_defecto: int = 443) -> int:
    """Puerto explícito de 'host:puerto' / 'https://host:puerto', o el defecto."""
    v = (valor or "").strip()
    if "://" in v:
        v = v.split("://", 1)[1]
    v = v.split("/", 1)[0]
    if ":" in v:
        try:
            return int(v.rsplit(":", 1)[1])
        except ValueError:
            pass
    return por_defecto


def _ahora_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _serializable(valor: object) -> object:
    if isinstance(valor, (bool, int, float, str)) or valor is None:
        return valor
    if isinstance(valor, (list, tuple)):
        return [_serializable(v) for v in valor]
    if isinstance(valor, dict):
        return {str(k): _serializable(v) for k, v in valor.items()}
    return str(valor)


class ErrorCredenciales(Exception):
    """El ctrlX respondió, pero rechazó usuario/contraseña (400/401/403)."""


# ====================================================================== #
# Sesión HTTP con el ctrlX (login + refresco del JWT)
# ====================================================================== #
class SesionCtrlx:
    """
    Una sesión = un host + un usuario. Port de `DatalayerAuth` a httpx async.

    Todas las llamadas al Data Layer pasan por `get`/`put`, que ponen el
    `Authorization: Bearer` con un token válido (renovado si toca).
    """

    def __init__(self, host: str, puerto: int, usuario: str, password: str,
                 verify_ssl: bool = False, timeout: float = 8.0) -> None:
        self.host = host
        self.puerto = puerto
        self.usuario = usuario
        self.password = password
        self.timeout = timeout
        self.base_url = f"https://{host}:{puerto}"
        self._client = httpx.AsyncClient(
            base_url=self.base_url, verify=verify_ssl,
            timeout=httpx.Timeout(timeout),
        )
        self._lock = asyncio.Lock()
        self.access_token: Optional[str] = None
        self.refresh_token: Optional[str] = None
        self.expira_en: float = 0.0

    # ---- token ---------------------------------------------------------- #
    async def login(self) -> str:
        async with self._lock:
            return await self._login_sin_lock()

    async def _login_sin_lock(self) -> str:
        try:
            r = await self._client.post(
                "/identity-manager/api/v2/auth/token",
                json={"name": self.usuario, "password": self.password},
            )
        except httpx.HTTPError as exc:
            raise ConnectionError(
                f"No se pudo contactar con el ctrlX en {self.base_url}: {exc}"
            ) from exc
        if r.status_code in (400, 401, 403):
            raise ErrorCredenciales(
                f"El ctrlX {self.host} rechazó las credenciales de "
                f"'{self.usuario}' (HTTP {r.status_code})."
            )
        r.raise_for_status()
        self._guardar_token(r.json())
        return self.access_token or ""

    async def _refrescar(self) -> str:
        async with self._lock:
            if self.refresh_token:
                try:
                    r = await self._client.post(
                        "/identity-manager/api/v2/auth/token",
                        json={"grant_type": "refresh_token",
                              "refresh_token": self.refresh_token},
                    )
                    r.raise_for_status()
                    self._guardar_token(r.json())
                    return self.access_token or ""
                except Exception as exc:  # noqa: BLE001
                    logger.debug("Refresh del token falló (%s); login limpio.", exc)
            return await self._login_sin_lock()

    def _guardar_token(self, datos: dict) -> None:
        self.access_token = datos.get("access_token")
        self.refresh_token = datos.get("refresh_token")
        expires_in = float(datos.get("expires_in") or 3600)
        self.expira_en = time.time() + expires_in - MARGEN_REFRESCO_S

    async def token_valido(self) -> str:
        if not self.access_token:
            return await self.login()
        if time.time() >= self.expira_en:
            return await self._refrescar()
        return self.access_token

    async def cabeceras(self) -> Dict[str, str]:
        return {"Authorization": f"Bearer {await self.token_valido()}"}

    # ---- HTTP ----------------------------------------------------------- #
    async def get(self, ruta: str, **kw) -> httpx.Response:
        return await self._client.get(ruta, headers=await self.cabeceras(), **kw)

    async def put(self, ruta: str, cuerpo: Any, **kw) -> httpx.Response:
        return await self._client.put(ruta, headers=await self.cabeceras(),
                                      json=cuerpo, **kw)

    def stream(self, metodo: str, ruta: str, **kw):
        """Para el SSE. Las cabeceras las pone quien llama (necesita await)."""
        return self._client.stream(metodo, ruta, **kw)

    async def close(self) -> None:
        try:
            await self._client.aclose()
        except Exception:  # noqa: BLE001
            pass


# ====================================================================== #
# Cliente del Data Layer (browse / read / bulk / write / SSE)
# ====================================================================== #
class ClienteDatalayer:
    """Port de `DatalayerClient`. Rutas SIN barra inicial."""

    def __init__(self, sesion: SesionCtrlx) -> None:
        self.sesion = sesion
        # None = sin probar · str = formato que funcionó · False = ninguno
        self._forma_bulk: Any = None

    # ---- lectura / escritura de un nodo --------------------------------- #
    async def leer_nodo(self, ruta: str) -> dict:
        r = await self.sesion.get(f"/automation/api/v2/nodes/{ruta}")
        r.raise_for_status()
        return r.json()

    async def escribir_nodo(self, ruta: str, valor: object, dl_type: str) -> dict:
        r = await self.sesion.put(f"/automation/api/v2/nodes/{ruta}",
                                  {"type": dl_type, "value": valor})
        if r.status_code in (401, 403):
            raise PermissionError(
                f"El ctrlX no permite escribir '{ruta}' con el usuario "
                f"'{self.sesion.usuario}' (HTTP {r.status_code}). Revisa los "
                f"permisos del usuario en la gestión de accesos del ctrlX."
            )
        r.raise_for_status()
        return r.json() if r.content else {}

    # ---- browse ---------------------------------------------------------- #
    async def hijos(self, ruta: str) -> List[str]:
        """Nombres de los hijos directos de `ruta`. [] si no existe/no tiene."""
        r = await self.sesion.get(f"/automation/api/v2/nodes/{ruta}",
                                  params={"type": "browse"})
        if r.status_code == 404:
            return []
        r.raise_for_status()
        datos = r.json()
        crudo = datos
        if isinstance(datos, dict):
            for clave in ("value", "nodes", "references"):
                if isinstance(datos.get(clave), list):
                    crudo = datos[clave]
                    break
        nombres: List[str] = []
        if isinstance(crudo, list):
            for item in crudo:
                if isinstance(item, str):
                    nombres.append(item.rsplit("/", 1)[-1])
                elif isinstance(item, dict):
                    n = item.get("name") or item.get("node") or item.get("nodeId")
                    if n:
                        nombres.append(str(n).rsplit("/", 1)[-1])
        return nombres

    async def listar_apps(self) -> List[str]:
        """Apps bajo plc/app que exponen un nodo `sym`."""
        apps = await self.hijos(RAIZ_APPS)
        con_sym = []
        for a in apps:
            if await self.hijos(f"{RAIZ_APPS}/{a}/sym"):
                con_sym.append(a)
        return con_sym or apps

    async def listar_programas(self, app: str) -> List[str]:
        return await self.hijos(f"{RAIZ_APPS}/{app}/sym")

    # ---- lectura en bloque ------------------------------------------------ #
    async def _bulk(self, forma: str, rutas: List[str]) -> Any:
        r = await self.sesion.put("/automation/api/v2/bulk?type=read",
                                  _FORMAS_BULK[forma](rutas))
        r.raise_for_status()
        return r.json()

    async def leer_bloque(self, rutas: List[str]) -> Dict[str, Tuple[str, object]]:
        """
        {ruta: (dl_type, valor)} para varias rutas en UNA llamada.

        El bulk devuelve 200 aunque un nodo individual falle: el estado real
        de cada elemento viene en `result` (DL_OK, DL_PERMISSION_DENIED,
        DL_INVALID_ADDRESS...). Un nodo que no está DL_OK sale con tipo ""
        y valor None, nunca como un valor válido.
        """
        if not rutas:
            return {}
        if self._forma_bulk is False:
            return await self._leer_uno_a_uno(rutas)

        formas = ([self._forma_bulk] if isinstance(self._forma_bulk, str)
                  else list(_FORMAS_BULK))
        items: Any = None
        ultimo_error: Optional[Exception] = None
        for forma in formas:
            try:
                datos = await self._bulk(forma, rutas)
            except Exception as exc:  # noqa: BLE001
                ultimo_error = exc
                continue
            if self._forma_bulk != forma:
                logger.info("bulk-read: el firmware acepta el formato '%s'.", forma)
                self._forma_bulk = forma
            if isinstance(datos, dict):
                for clave in ("value", "nodes", "results"):
                    if isinstance(datos.get(clave), list):
                        items = datos[clave]
                        break
                else:
                    items = [datos]
            else:
                items = datos if isinstance(datos, list) else []
            break

        if items is None:
            self._forma_bulk = False
            logger.warning("bulk-read no soportado por este firmware (%s). "
                           "Se leerá nodo a nodo.", ultimo_error)
            return await self._leer_uno_a_uno(rutas)

        salida: Dict[str, Tuple[str, object]] = {}
        for i, item in enumerate(items):
            ruta = rutas[i] if i < len(rutas) else None
            if not isinstance(item, dict):
                if ruta:
                    salida[ruta] = ("", item)
                continue
            ruta = (item.get("address") or item.get("node")
                    or item.get("path") or ruta)
            if isinstance(ruta, str):
                ruta = ruta.lstrip("/")
            if not ruta:
                continue
            resultado = item.get("result")
            if resultado and resultado != "DL_OK":
                logger.debug("bulk-read %s -> %s", ruta, resultado)
                salida[ruta] = ("", None)
                continue
            valor = item.get("value", item)
            dl_type = item.get("type", "")
            if isinstance(valor, dict) and "value" in valor:
                dl_type = valor.get("type", dl_type)
                valor = valor["value"]
            salida[ruta] = (dl_type, valor)
        return salida

    async def _leer_uno_a_uno(self, rutas: List[str]) -> Dict[str, Tuple[str, object]]:
        async def uno(r: str):
            try:
                d = await self.leer_nodo(r)
                if isinstance(d, dict):
                    return r, (d.get("type", ""), d.get("value"))
                return r, ("", d)
            except Exception:  # noqa: BLE001
                return r, ("", None)

        sem = asyncio.Semaphore(16)

        async def con_limite(r: str):
            async with sem:
                return await uno(r)

        return dict(await asyncio.gather(*(con_limite(r) for r in rutas)))

    async def close(self) -> None:
        await self.sesion.close()


# ====================================================================== #
# Exploración previa al alta (lo que usan /rexroth/apps y /rexroth/programs)
# ====================================================================== #
async def abrir_sesion(host: str, puerto: int, usuario: str, password: str,
                       settings: Optional[Settings] = None) -> ClienteDatalayer:
    """Login y cliente listo. Lanza ErrorCredenciales o ConnectionError."""
    verify = bool(getattr(settings, "rexroth_verify_ssl", False))
    timeout = float(getattr(settings, "rexroth_connect_timeout", 8.0))
    sesion = SesionCtrlx(host_de(host), puerto, usuario, password,
                         verify_ssl=verify, timeout=timeout)
    try:
        await sesion.login()
    except Exception:
        await sesion.close()
        raise
    return ClienteDatalayer(sesion)


async def probar_credenciales(host: str, puerto: int, usuario: str,
                              password: str, timeout: float = 5.0) -> Tuple[str, str]:
    """
    ('OK' | 'AUTH_INVALID' | 'DOWN', detalle). Es lo que distingue
    "usuario o contraseña incorrectos" de "ese equipo no responde".
    """
    sesion = SesionCtrlx(host_de(host), puerto, usuario, password, timeout=timeout)
    try:
        await sesion.login()
        return "OK", ""
    except ErrorCredenciales as exc:
        return "AUTH_INVALID", str(exc)
    except Exception as exc:  # noqa: BLE001
        return "DOWN", f"{type(exc).__name__}: {exc}"
    finally:
        await sesion.close()


# ====================================================================== #
# El driver
# ====================================================================== #
class CtrlxDatalayerDriver(PlcDriver):
    """Driver Rexroth ctrlX sobre el Data Layer REST (HTTPS + SSE)."""

    def __init__(self, settings: Settings) -> None:
        self._settings = settings
        self._cliente: Optional[ClienteDatalayer] = None
        self._connected = False
        self._callback: Optional[DataChangeCallback] = None
        self._tarea_sse: Optional[asyncio.Task] = None
        self._tarea_polling: Optional[asyncio.Task] = None
        self._tarea_vigilancia: Optional[asyncio.Task] = None
        self._datos_recibidos = False
        self._sse_vivo = True

        # Modo de lectura activo: 'sse' | 'polling' | '-'
        self.modo_lectura: str = "-"
        self.app_resuelta: str = ""
        self.programa_resuelto: str = ""

        # Estado compartido con el handler (mismos nombres que el driver OPC UA).
        self.tag_por_nodeid: Dict[str, TagInfo] = {}
        self.ultimos_valores: Dict[str, TagValue] = {}
        self.tags_descubiertos: List[TagInfo] = []
        self.ultimo_cambio_ts: Dict[str, datetime] = {}

    # ---- datos de conexión ---------------------------------------------- #
    @property
    def _host(self) -> str:
        return host_de(self._settings.opcua_endpoint)

    @property
    def _puerto(self) -> int:
        """
        El puerto HTTPS del ctrlX. El endpoint que guarda el PlcManager puede
        venir como `https://host:443` (nuevo) o como `opc.tcp://host:4840`
        (dado de alta con el driver OPC UA): el 4840 no sirve aquí, así que
        se cae al puerto HTTPS configurado.
        """
        ep = self._settings.opcua_endpoint
        p = puerto_de(ep, 0)
        if ep.startswith("opc.tcp://") or p in (0, 4840):
            return int(getattr(self._settings, "rexroth_https_port", 443))
        return p

    @property
    def _app(self) -> str:
        return (self._settings.rexroth_app or "").strip()

    @property
    def _programa(self) -> str:
        return (self._settings.rexroth_program or "").strip()

    def _sym(self) -> str:
        return f"{RAIZ_APPS}/{self.app_resuelta}/sym/{self.programa_resuelto}"

    # ================================================================== #
    # Conexión
    # ================================================================== #
    async def connect(self) -> None:
        if not self._settings.rexroth_username:
            raise ValueError(
                "Un PLC Rexroth necesita usuario y contraseña. Configura "
                "PLC_REXROTH_USERNAME / PLC_REXROTH_PASSWORD o envíalos al "
                "dar de alta el PLC."
            )
        self._cliente = await abrir_sesion(
            self._host, self._puerto, self._settings.rexroth_username,
            self._settings.rexroth_password or "", self._settings,
        )
        self._connected = True
        logger.info("Sesión Data Layer abierta con %s:%d (usuario=%s, app=%s, "
                    "programa=%s)", self._host, self._puerto,
                    self._settings.rexroth_username, self._app or "auto",
                    self._programa or "auto")

    async def disconnect(self) -> None:
        await self._detener_lectura()
        if self._cliente is not None:
            await self._cliente.close()
        self._cliente = None
        self._connected = False
        self.modo_lectura = "-"

    def is_connected(self) -> bool:
        return self._connected

    async def check_alive(self) -> bool:
        """Watchdog del SubscriptionHandler: un GET barato con el token."""
        if self._cliente is None:
            return False
        try:
            ruta = self._sym() if self.programa_resuelto else RAIZ_APPS
            r = await self._cliente.sesion.get(f"/automation/api/v2/nodes/{ruta}",
                                               params={"type": "browse"})
            if r.status_code in (401, 403):
                # Token revocado o usuario deshabilitado: reconectar.
                self._connected = False
                return False
            return True
        except Exception:  # noqa: BLE001
            self._connected = False
            return False

    def subscription_viva(self) -> bool:
        return self._sse_vivo

    # ================================================================== #
    # Descubrimiento de tags
    # ================================================================== #
    async def _resolver_app_y_programa(self) -> None:
        assert self._cliente is not None
        app = self._app
        if not app:
            apps = await self._cliente.listar_apps()
            if not apps:
                raise RuntimeError(
                    f"El ctrlX {self._host} no publica ninguna aplicación PLC "
                    f"bajo '{RAIZ_APPS}'. ¿Está cargado y en RUN el proyecto?"
                )
            app = "Application" if "Application" in apps else apps[0]
        programa = self._programa
        if not programa:
            programas = await self._cliente.listar_programas(app)
            if not programas:
                raise RuntimeError(
                    f"'{RAIZ_APPS}/{app}/sym' no tiene programas. Publica los "
                    f"símbolos del proyecto (Symbol Configuration) en el ctrlX."
                )
            programa = "PLC_PRG" if "PLC_PRG" in programas else programas[0]
        self.app_resuelta, self.programa_resuelto = app, programa

    async def browse_tags(self) -> List[TagInfo]:
        if self._cliente is None:
            raise RuntimeError("browse_tags llamado sin conexión activa.")
        await self._resolver_app_y_programa()
        raiz = self._sym()
        nombres = await self._cliente.hijos(raiz)
        if not nombres:
            raise RuntimeError(
                f"'{raiz}' no tiene variables. Publica el proyecto desde la "
                f"configuración de símbolos del ctrlX."
            )

        self.tag_por_nodeid.clear()
        self.tags_descubiertos = []
        await self._registrar_nivel(raiz, nombres, prefijo="", nivel=0)

        logger.info("ctrlX %s: %d variables en %s.", self._host,
                    len(self.tags_descubiertos), raiz)
        return list(self.tags_descubiertos)

    async def _registrar_nivel(self, ruta_base: str, nombres: List[str],
                               prefijo: str, nivel: int) -> None:
        """
        Da de alta las variables de un nivel. Lo que no se pueda leer como
        valor escalar (una estructura, un FB) se intenta expandir un nivel
        más, hasta `rexroth_browse_depth`, igual que hacía el driver OPC UA.
        """
        assert self._cliente is not None
        rutas = [f"{ruta_base}/{n}" for n in nombres]
        leidos = await self._cliente.leer_bloque(rutas)
        profundidad_max = int(getattr(self._settings, "rexroth_browse_depth", 4))

        for nombre, ruta in zip(nombres, rutas):
            dl_type, valor = leidos.get(ruta, ("", None))
            if dl_type:
                info = TagInfo(
                    name=f"{prefijo}{nombre}",
                    full_name=f"{self.programa_resuelto}.{prefijo}{nombre}",
                    node_id=ruta,
                    data_type=tipo_iec(dl_type),
                    db_name=self.programa_resuelto,
                )
                self.tag_por_nodeid[ruta] = info
                self.tags_descubiertos.append(info)
                continue
            # Sin tipo: puede ser un nodo contenedor (STRUCT / FB).
            if nivel + 1 >= profundidad_max:
                continue
            try:
                hijos = await self._cliente.hijos(ruta)
            except Exception:  # noqa: BLE001
                hijos = []
            if hijos:
                await self._registrar_nivel(ruta, hijos, f"{prefijo}{nombre}.",
                                            nivel + 1)

    # ================================================================== #
    # Tiempo real: SSE con fallback a polling
    # ================================================================== #
    async def subscribe(self, tags: List[TagInfo], callback: DataChangeCallback) -> None:
        if self._cliente is None:
            raise RuntimeError("subscribe llamado sin conexión activa.")
        await self._detener_lectura()
        self._callback = callback
        self._datos_recibidos = False
        self._sse_vivo = True

        # Snapshot inicial: el handler necesita un valor por tag desde el
        # principio, y el SSE solo manda lo que cambia.
        await self._emitir_lectura_completa(tags, solo_cambios=False)

        if getattr(self._settings, "rexroth_force_polling", False):
            await self._arrancar_polling(tags)
            return

        self._tarea_sse = asyncio.create_task(self._bucle_sse(tags))
        self.modo_lectura = "sse"
        gracia = float(getattr(self._settings, "rexroth_subscription_grace_s", 5.0))
        self._tarea_vigilancia = asyncio.create_task(self._vigilar_sse(tags, gracia))

    async def _vigilar_sse(self, tags: List[TagInfo], gracia: float) -> None:
        """
        Si el SSE no entrega NADA en `gracia` segundos (ni un keepalive con
        datos), se cae a polling. En una planta es preferible leer a 100 ms
        por bloque que quedarse con un stream mudo.
        """
        try:
            await asyncio.sleep(gracia)
            if self._datos_recibidos:
                return
            logger.warning("ctrlX %s: el SSE no entregó datos en %.0fs; se pasa "
                           "a polling.", self._host, gracia)
            if self._tarea_sse is not None:
                self._tarea_sse.cancel()
                self._tarea_sse = None
            await self._arrancar_polling(tags)
        except asyncio.CancelledError:
            pass

    async def _bucle_sse(self, tags: List[TagInfo]) -> None:
        """
        GET /automation/api/v2/events?nodes=a,b,c&publishIntervalMs=100

        Cada `data:` es un evento por NODO ({node, type, value}). Se entrega
        al callback tal cual llega: el SubscriptionHandler ya coalesce.
        Si el stream se corta, se reintenta con backoff; si el ctrlX lo
        rechaza (404/405: firmware sin eventos), se pasa a polling.
        """
        assert self._cliente is not None
        rutas = [t.node_id for t in tags]
        intervalo = int(getattr(self._settings, "rexroth_sampling_interval_ms", 100))
        params = {"nodes": ",".join(rutas), "publishIntervalMs": str(intervalo)}
        backoff = 1.0
        while True:
            try:
                cab = await self._cliente.sesion.cabeceras()
                cab["Accept"] = "text/event-stream"
                timeout = httpx.Timeout(self._cliente.sesion.timeout, read=None)
                async with self._cliente.sesion.stream(
                    "GET", "/automation/api/v2/events", params=params,
                    headers=cab, timeout=timeout,
                ) as resp:
                    if resp.status_code in (404, 405, 501):
                        logger.warning("ctrlX %s: este firmware no ofrece SSE "
                                       "(HTTP %d); se pasa a polling.",
                                       self._host, resp.status_code)
                        self._sse_vivo = False
                        await self._arrancar_polling(tags)
                        return
                    resp.raise_for_status()
                    backoff = 1.0
                    await self._consumir_sse(resp)
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001
                if not self._connected:
                    return
                logger.warning("ctrlX %s: SSE cortado (%s); reintento en %.0fs.",
                               self._host, exc, backoff)
                await asyncio.sleep(backoff)
                backoff = min(backoff * 2, 30.0)

    async def _consumir_sse(self, resp: httpx.Response) -> None:
        nombre_evento: Optional[str] = None
        lineas_datos: List[str] = []
        async for linea in resp.aiter_lines():
            linea = (linea or "").strip()
            if linea == "":
                if lineas_datos:
                    carga = "\n".join(lineas_datos)
                    lineas_datos = []
                    nombre, nombre_evento = nombre_evento, None
                    if nombre == "error":
                        logger.warning("ctrlX SSE error: %s", carga[:300])
                        continue
                    if nombre == "keepalive":
                        continue
                    try:
                        obj = json.loads(carga)
                    except ValueError:
                        continue
                    for item in (obj if isinstance(obj, list) else [obj]):
                        if isinstance(item, dict):
                            await self._aplicar_evento(item)
                continue
            if linea.startswith(":"):
                continue
            if linea.startswith("event:"):
                nombre_evento = linea[6:].strip()
            elif linea.startswith("data:"):
                lineas_datos.append(linea[5:].lstrip())

    async def _aplicar_evento(self, evt: dict) -> None:
        nodo = evt.get("node") or evt.get("path") or evt.get("id")
        if not nodo:
            return
        nodo = str(nodo).lstrip("/")
        valor = evt.get("value", evt.get("data"))
        if isinstance(valor, dict) and "value" in valor:
            valor = valor["value"]
        info = self.tag_por_nodeid.get(nodo)
        if info is None:
            return
        self._datos_recibidos = True
        # Marca de tiempo de origen si el ctrlX la manda (nanosegundos desde
        # 1601 en algunos firmwares, epoch ms en otros): se deja al handler.
        await self._emitir(info, valor)

    # ---- polling ----------------------------------------------------------- #
    async def _arrancar_polling(self, tags: List[TagInfo]) -> None:
        if self._tarea_polling is not None:
            return
        self.modo_lectura = "polling"
        self._tarea_polling = asyncio.create_task(self._bucle_polling(tags))

    async def _bucle_polling(self, tags: List[TagInfo]) -> None:
        intervalo = max(50, int(getattr(self._settings, "rexroth_poll_interval_ms", 100)))
        try:
            while self._connected:
                t0 = time.monotonic()
                try:
                    await self._emitir_lectura_completa(tags, solo_cambios=True)
                except Exception as exc:  # noqa: BLE001
                    logger.warning("ctrlX %s: fallo en polling: %s", self._host, exc)
                resto = intervalo / 1000.0 - (time.monotonic() - t0)
                await asyncio.sleep(resto if resto > 0 else 0.01)
        except asyncio.CancelledError:
            pass

    async def _emitir_lectura_completa(self, tags: List[TagInfo],
                                       solo_cambios: bool) -> None:
        assert self._cliente is not None
        if not self._callback:
            return
        max_lote = int(getattr(self._settings, "rexroth_bulk_max", 200))
        for i in range(0, len(tags), max_lote):
            lote = tags[i:i + max_lote]
            leidos = await self._cliente.leer_bloque([t.node_id for t in lote])
            for info in lote:
                dl_type, valor = leidos.get(info.node_id, ("", None))
                if not dl_type and valor is None:
                    continue
                if solo_cambios:
                    ant = self.ultimos_valores.get(info.full_name)
                    if ant is not None and ant.value == _serializable(valor):
                        continue
                self._datos_recibidos = True
                await self._emitir(info, valor)

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
            tag=info.full_name,
            value=_serializable(valor),
            data_type=info.data_type,
            timestamp=ahora.isoformat(),
            node_id=info.node_id,
            source_ts=ahora.isoformat(),
            delta_ms=round(delta_ms, 1) if delta_ms is not None else None,
        )
        self.ultimos_valores[info.full_name] = tv
        await self._callback(tv)

    async def _detener_lectura(self) -> None:
        for tarea in (self._tarea_vigilancia, self._tarea_sse, self._tarea_polling):
            if tarea is not None:
                tarea.cancel()
                try:
                    await tarea
                except (asyncio.CancelledError, Exception):  # noqa: BLE001
                    pass
        self._tarea_vigilancia = self._tarea_sse = self._tarea_polling = None

    # ================================================================== #
    # Lectura puntual y escritura
    # ================================================================== #
    async def read_tags(self, node_ids: List[str]) -> List[Optional[TagValue]]:
        if self._cliente is None:
            raise RuntimeError("read_tags llamado sin conexión activa.")
        salida: List[Optional[TagValue]] = []
        ahora = _ahora_iso()
        max_lote = int(getattr(self._settings, "rexroth_bulk_max", 200))
        for i in range(0, len(node_ids), max_lote):
            lote = node_ids[i:i + max_lote]
            try:
                leidos = await self._cliente.leer_bloque(lote)
            except Exception as exc:  # noqa: BLE001
                logger.debug("bulk-read fallido (%d nodos): %s", len(lote), exc)
                salida.extend([None] * len(lote))
                continue
            for ruta in lote:
                dl_type, valor = leidos.get(ruta, ("", None))
                if not dl_type and valor is None:
                    salida.append(None)
                    continue
                info = self.tag_por_nodeid.get(ruta)
                salida.append(TagValue(
                    tag=info.full_name if info else ruta,
                    value=_serializable(valor),
                    data_type=info.data_type if info else tipo_iec(dl_type),
                    timestamp=ahora, node_id=ruta,
                ))
        return salida

    async def read_tag(self, node_id: str) -> TagValue:
        if self._cliente is None:
            raise RuntimeError("read_tag llamado sin conexión activa.")
        d = await self._cliente.leer_nodo(node_id)
        valor = d.get("value") if isinstance(d, dict) else d
        info = self.tag_por_nodeid.get(node_id)
        return TagValue(
            tag=info.full_name if info else node_id,
            value=_serializable(valor),
            data_type=info.data_type if info else tipo_iec(
                d.get("type", "") if isinstance(d, dict) else ""),
            timestamp=_ahora_iso(), node_id=node_id,
        )

    async def write_tag(self, node_id: str, valor: object) -> TagValue:
        """
        PUT del valor con su tipo Data Layer y relectura. La conversión de
        tipos es la misma que en los demás drivers (`escritura.convertir`):
        nunca se adivina, y un 'true' en un REAL falla antes de salir.
        """
        if self._cliente is None:
            raise RuntimeError("write_tag llamado sin conexión activa.")
        info = self.tag_por_nodeid.get(node_id)
        if info is None:
            raise KeyError(f"El tag '{node_id}' no existe en este ctrlX.")
        convertido = convertir(valor, info.data_type)
        await self._cliente.escribir_nodo(node_id, convertido,
                                          tipo_dl(info.data_type, convertido))
        return await self.read_tag(node_id)
