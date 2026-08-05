# -*- coding: utf-8 -*-
"""
rexroth_driver.py
=================
Implementación del driver de PLC para controladores **Bosch Rexroth ctrlX CORE**
(y ctrlX VirtualControl) sobre OPC UA, usando `asyncua` (async/await).

Diferencias frente al PLC Siemens S7 (`OpcUaDriver`):

  ┌────────────────────┬───────────────────────────┬──────────────────────────┐
  │                    │ Siemens S7-1500           │ Rexroth ctrlX CORE       │
  ├────────────────────┼───────────────────────────┼──────────────────────────┤
  │ Autenticación      │ Anónima (normalmente)     │ Usuario + contraseña     │
  │ Seguridad          │ 'No security'             │ Suele exigir Basic256Sha │
  │                    │                           │ 256 + certificado        │
  │ Ruta de los datos  │ DeviceSet/PLC_x/          │ Datalayer/plc/app/<app>/ │
  │                    │ DataBlocksGlobal/<DB>     │ sym/<programa>           │
  │ Agrupación         │ Data Block                │ Programa (POU)           │
  └────────────────────┴───────────────────────────┴──────────────────────────┘

Puntos clave de esta implementación:

  * **Cascada de seguridad**: se prueban en orden Basic256Sha256/SignAndEncrypt,
    Basic256Sha256/Sign, Basic256/SignAndEncrypt y finalmente None/None. El
    primero que conecte gana. Así funciona tanto con un ctrlX endurecido como
    con uno abierto, sin configurar nada a mano.
  * **Certificado de cliente autogenerado**: si no existe, se crea un par
    cert/key autofirmado (RSA 2048, 10 años) con el SubjectAltName URI que
    exige la especificación OPC UA. Recuerda **confiar en ese certificado**
    desde la web del ctrlX la primera vez (Settings → Certificates & Keys).
  * **Selección de app y programa**: la ruta no está fija. Se navega
    `Objects → Datalayer → plc → app → <app> → sym → <programa>` con los
    valores que llegan de la vista (o del .env).
  * **Subscriptions con fallback automático a polling**: se intenta la
    subscription OPC UA nativa (igual que en Siemens). Si el servidor la
    rechaza, o si no llega ningún `datachange` en el plazo configurado, se
    cierra y se arranca un bucle de polling que emite por el MISMO callback.
    El resto del pipeline (SubscriptionHandler → WebSocket → frontend) no se
    entera de la diferencia.
  * **Nodos 'Value'**: en el Data Layer un símbolo puede exponerse como
    Variable directa o como Object con un hijo `Value`. Se resuelve al vuelo.
"""
from __future__ import annotations

import asyncio
import logging
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Dict, List, Optional, Tuple

from asyncua import Client, Node, ua

from app.config.settings import Settings
from app.drivers.plc_driver import (
    DataChangeCallback,
    PlcDriver,
    TagInfo,
    TagValue,
)

logger = logging.getLogger("rexroth_driver")

# Nombres de nodos internos del Data Layer que NO son datos de proceso.
NODOS_IGNORADOS = {"Icon", "InputArguments", "OutputArguments", "metadata"}

# Cascada de seguridad: se prueban en este orden hasta que una conecte.
CASCADA_SEGURIDAD: List[Tuple[str, str]] = [
    ("Basic256Sha256", "SignAndEncrypt"),
    ("Basic256Sha256", "Sign"),
    ("Basic256", "SignAndEncrypt"),
    ("None", "None"),
]

# Mapa de VariantType OPC UA -> nombre de tipo IEC 61131 (el que usa ctrlX).
TIPOS_IEC = {
    "Boolean": "BOOL", "SByte": "SINT", "Byte": "BYTE", "Int16": "INT",
    "UInt16": "UINT", "Int32": "DINT", "UInt32": "UDINT", "Int64": "LINT",
    "UInt64": "ULINT", "Float": "REAL", "Double": "LREAL", "String": "STRING",
    "DateTime": "DT", "ByteString": "BYTES",
}


def _ahora_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _dt_iso(dt: Optional[datetime]) -> str:
    if dt is None:
        return ""
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.isoformat()


def _a_serializable(valor: object) -> object:
    """Convierte el valor a algo que `json.dumps` acepte."""
    if isinstance(valor, (bool, int, float, str)) or valor is None:
        return valor
    if isinstance(valor, datetime):
        return valor.isoformat()
    if isinstance(valor, (list, tuple)):
        return [_a_serializable(v) for v in valor]
    return str(valor)


# ====================================================================== #
# Certificado de cliente
# ====================================================================== #
def rutas_certificado(settings: Settings) -> Tuple[str, str]:
    """
    Devuelve (ruta_cert, ruta_key). Si no se configuraron por env, se usa una
    carpeta estable en el perfil del usuario para no regenerarlos en cada
    arranque (y para que el ctrlX siga confiando en el mismo certificado).
    """
    if settings.rexroth_cert_path and settings.rexroth_key_path:
        return settings.rexroth_cert_path, settings.rexroth_key_path

    if os.name == "nt":
        base = (
            Path(os.getenv("LOCALAPPDATA", str(Path.home() / "AppData/Local")))
            / "HMI-Studio" / "opcua"
        )
    else:
        base = (
            Path(os.getenv("XDG_DATA_HOME", str(Path.home() / ".local/share")))
            / "hmi-studio" / "opcua"
        )
    base.mkdir(parents=True, exist_ok=True)
    return str(base / "client_cert.pem"), str(base / "client_key.pem")


def asegurar_certificado(cert_path: str, key_path: str, application_uri: str) -> None:
    """
    Crea el par certificado/clave autofirmado si aún no existe.

    El certificado incluye SubjectAltName con el `application_uri`, KeyUsage y
    ExtendedKeyUsage porque los servidores OPC UA estrictos (el ctrlX lo es)
    rechazan certificados sin esas extensiones.
    """
    if os.path.exists(cert_path) and os.path.exists(key_path):
        return

    # Import diferido: `cryptography` solo hace falta para PLCs Rexroth.
    from cryptography import x509
    from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import rsa

    Path(os.path.dirname(cert_path) or ".").mkdir(parents=True, exist_ok=True)
    Path(os.path.dirname(key_path) or ".").mkdir(parents=True, exist_ok=True)

    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    nombre = x509.Name([
        x509.NameAttribute(NameOID.COUNTRY_NAME, "PE"),
        x509.NameAttribute(NameOID.ORGANIZATION_NAME, "PSI"),
        x509.NameAttribute(NameOID.COMMON_NAME, "HMI-Studio"),
    ])
    ahora = datetime.now(timezone.utc)
    cert = (
        x509.CertificateBuilder()
        .subject_name(nombre)
        .issuer_name(nombre)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(ahora - timedelta(days=1))
        .not_valid_after(ahora + timedelta(days=3650))
        .add_extension(
            x509.SubjectAlternativeName([x509.UniformResourceIdentifier(application_uri)]),
            critical=False,
        )
        .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
        .add_extension(
            x509.KeyUsage(
                digital_signature=True, content_commitment=True,
                key_encipherment=True, data_encipherment=True,
                key_agreement=False, key_cert_sign=False, crl_sign=False,
                encipher_only=False, decipher_only=False,
            ),
            critical=True,
        )
        .add_extension(
            x509.ExtendedKeyUsage([
                ExtendedKeyUsageOID.CLIENT_AUTH,
                ExtendedKeyUsageOID.SERVER_AUTH,
            ]),
            critical=False,
        )
        .sign(key, hashes.SHA256())
    )

    with open(key_path, "wb") as fh:
        fh.write(key.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.TraditionalOpenSSL,
            serialization.NoEncryption(),
        ))
    with open(cert_path, "wb") as fh:
        fh.write(cert.public_bytes(serialization.Encoding.PEM))

    logger.info("Certificado de cliente generado en %s", cert_path)


async def conectar_ctrlx(
    endpoint: str,
    usuario: str,
    password: str,
    settings: Settings,
) -> Client:
    """
    Conecta a un ctrlX probando la cascada de seguridad. Devuelve el `Client`
    YA CONECTADO; quien llama es responsable de hacer `disconnect()`.

    Se usa tanto desde el driver como desde los endpoints REST que listan apps
    y programas antes de dar de alta el PLC.
    """
    cert_path, key_path = rutas_certificado(settings)
    app_uri = settings.rexroth_application_uri
    asegurar_certificado(cert_path, key_path, app_uri)

    ultimo_error: Optional[Exception] = None
    for policy, mode in CASCADA_SEGURIDAD:
        cliente = Client(url=endpoint, timeout=settings.rexroth_connect_timeout)
        cliente.application_uri = app_uri
        cliente.name = settings.rexroth_application_name
        try:
            if policy != "None":
                await cliente.set_security_string(
                    f"{policy},{mode},{cert_path},{key_path}"
                )
            if usuario:
                cliente.set_user(usuario)
                cliente.set_password(password or "")

            await cliente.connect()
            logger.info("ctrlX conectado en %s con %s/%s", endpoint, policy, mode)
            return cliente
        except Exception as exc:  # noqa: BLE001
            ultimo_error = exc
            logger.debug("Intento %s/%s falló en %s: %s: %s",
                         policy, mode, endpoint, type(exc).__name__, exc)
            try:
                await cliente.disconnect()
            except Exception:  # noqa: BLE001
                pass

    raise ConnectionError(
        f"No se pudo abrir sesión OPC UA con {endpoint}. "
        f"Último error: {type(ultimo_error).__name__}: {ultimo_error}"
    )


# ====================================================================== #
# Navegación del Data Layer
# ====================================================================== #
async def buscar_hijo(node: Node, nombre: str) -> Optional[Node]:
    """Busca un hijo por BrowseName, ignorando el índice de namespace."""
    try:
        for child in await node.get_children():
            try:
                if (await child.read_browse_name()).Name == nombre:
                    return child
            except Exception:  # noqa: BLE001
                continue
    except Exception as exc:  # noqa: BLE001
        logger.debug("Error buscando hijo '%s': %s", nombre, exc)
    return None


async def navegar(root: Node, *nombres: str) -> Optional[Node]:
    """Navega una ruta de BrowseNames. Devuelve el nodo final o None."""
    actual = root
    for nombre in nombres:
        actual = await buscar_hijo(actual, nombre)
        if actual is None:
            return None
    return actual


async def listar_apps(cliente: Client) -> List[str]:
    """
    Lista las aplicaciones PLC publicadas bajo `Datalayer/plc/app`.
    En un ctrlX típico devuelve ['Application'], pero puede haber varias.
    """
    root = cliente.get_root_node()
    nodo_app = await navegar(root, "Objects", "Datalayer", "plc", "app")
    if nodo_app is None:
        raise RuntimeError(
            "Conectó al ctrlX, pero no se encontró 'Datalayer/plc/app'. "
            "Verifica que la app PLC esté instalada y en marcha."
        )

    apps: List[str] = []
    for child in await nodo_app.get_children():
        try:
            nombre = (await child.read_browse_name()).Name
        except Exception:  # noqa: BLE001
            continue
        if not nombre or nombre in NODOS_IGNORADOS:
            continue
        # Solo interesan las apps que exponen símbolos.
        if await buscar_hijo(child, "sym") is not None:
            apps.append(nombre)

    if not apps:
        raise RuntimeError(
            "No hay ninguna aplicación con símbolos publicados. "
            "Publica el proyecto desde la configuración de símbolos del PLC."
        )
    return apps


async def listar_programas(cliente: Client, app: str) -> List[str]:
    """Lista los programas (POUs) bajo `Datalayer/plc/app/<app>/sym`."""
    root = cliente.get_root_node()
    nodo_sym = await navegar(root, "Objects", "Datalayer", "plc", "app", app, "sym")
    if nodo_sym is None:
        raise RuntimeError(
            f"Conectó al ctrlX, pero no se encontró el nodo 'sym' de la app "
            f"'{app}'. ¿Publicaste el proyecto desde la configuración de símbolos?"
        )

    programas: List[str] = []
    for child in await nodo_sym.get_children():
        try:
            nombre = (await child.read_browse_name()).Name
        except Exception:  # noqa: BLE001
            continue
        if nombre and nombre not in NODOS_IGNORADOS:
            programas.append(nombre)

    if not programas:
        raise RuntimeError(f"La app '{app}' no expone programas en 'sym'.")
    return programas


async def resolver_app_programa(
    cliente: Client,
    app: Optional[str] = None,
    programa: Optional[str] = None,
) -> Tuple[str, str]:
    """
    Resuelve automáticamente la app y el programa de un ctrlX.

    Las variables siempre viven en `plc/app/<app>/sym/<programa>`, y lo normal
    es que haya UNA sola app ('Application') con UN solo programa ('PLC_PRG').
    Por eso no hace falta que el usuario los indique: si no llegan, se
    descubren navegando el Data Layer.

    Reglas:
      * `app` vacío     -> se toma la primera app que exponga símbolos.
      * `programa` vacío-> se toma el primer programa de esa app.
      * Si vienen dados, se respetan tal cual (sin descubrimiento).

    Devuelve (app, programa) y lanza RuntimeError con un mensaje claro si no
    hay nada publicado.
    """
    app = (app or "").strip()
    programa = (programa or "").strip()

    if not app:
        apps = await listar_apps(cliente)          # ya lanza si no hay ninguna
        app = apps[0]
        if len(apps) > 1:
            logger.info("Hay %d apps (%s); se usa la primera: '%s'.",
                        len(apps), ", ".join(apps), app)
        else:
            logger.info("App detectada automáticamente: '%s'.", app)

    if not programa:
        programas = await listar_programas(cliente, app)   # lanza si está vacío
        programa = programas[0]
        if len(programas) > 1:
            logger.info("Hay %d programas (%s); se usa el primero: '%s'.",
                        len(programas), ", ".join(programas), programa)
        else:
            logger.info("Programa detectado automáticamente: '%s'.", programa)

    return app, programa


# ====================================================================== #
# Handler de subscription
# ====================================================================== #
class _SubHandler:
    """
    Handler de asyncua. Idéntico en espíritu al de `opcua_driver`: extrae valor
    y marcas de tiempo reales, calcula el delta respecto al cambio anterior del
    mismo tag y reenvía al callback.
    """

    def __init__(self, driver: "RexrothDriver", callback: DataChangeCallback) -> None:
        self._driver = driver
        self._callback = callback

    async def datachange_notification(self, node: Node, val, data) -> None:
        try:
            node_id = node.nodeid.to_string()
            info = self._driver.tag_por_nodeid.get(node_id)
            if info is None:
                return

            source_dt = None
            server_dt = None
            try:
                dv = data.monitored_item.Value
                source_dt = dv.SourceTimestamp
                server_dt = dv.ServerTimestamp
            except Exception:  # noqa: BLE001
                pass

            # Marca de que la subscription SÍ está entregando datos: desactiva
            # el fallback a polling.
            self._driver.marcar_datos_recibidos()

            await self._driver.emitir(
                info, val, source_dt, server_dt, self._callback
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning("Error procesando datachange: %s", exc)


# ====================================================================== #
# Driver
# ====================================================================== #
class RexrothDriver(PlcDriver):
    """Driver OPC UA para Bosch Rexroth ctrlX CORE / VirtualControl."""

    def __init__(self, settings: Settings) -> None:
        self._settings = settings
        self._client: Optional[Client] = None
        self._subscription = None
        self._handles: List[int] = []
        self._connected: bool = False

        # Modo de lectura activo: 'subscription' | 'polling' | '-'
        self.modo_lectura: str = "-"
        # App/programa realmente usados (tras autodetección en browse_tags).
        self.app_resuelta: str = ""
        self.programa_resuelto: str = ""
        self._tarea_polling: Optional[asyncio.Task] = None
        self._tarea_vigilancia: Optional[asyncio.Task] = None
        self._datos_recibidos: bool = False
        self._callback: Optional[DataChangeCallback] = None

        # Estado compartido con el handler.
        self.tag_por_nodeid: Dict[str, TagInfo] = {}
        self.ultimos_valores: Dict[str, TagValue] = {}
        self.tags_descubiertos: List[TagInfo] = []
        self.ultimo_cambio_ts: Dict[str, datetime] = {}

    # ------------------------------------------------------------------ #
    # Datos de conexión (leídos de settings, ya "personalizados" por PLC)
    # ------------------------------------------------------------------ #
    @property
    def _endpoint(self) -> str:
        return self._settings.opcua_endpoint

    @property
    def _app(self) -> str:
        """App configurada. Vacío = se autodetecta en browse_tags()."""
        return (self._settings.rexroth_app or "").strip()

    @property
    def _programa(self) -> str:
        """Programa configurado. Vacío = se autodetecta en browse_tags()."""
        return (self._settings.rexroth_program or "").strip()

    # ================================================================== #
    # Conexión
    # ================================================================== #
    async def connect(self) -> None:
        if not self._settings.rexroth_username:
            raise ValueError(
                "Un PLC Rexroth necesita usuario y contraseña. "
                "Configura PLC_REXROTH_USERNAME / PLC_REXROTH_PASSWORD o "
                "envíalos al dar de alta el PLC."
            )

        self._client = await conectar_ctrlx(
            self._endpoint,
            self._settings.rexroth_username,
            self._settings.rexroth_password or "",
            self._settings,
        )
        self._connected = True
        logger.info("Conectado al ctrlX en %s (app=%s, programa=%s)",
                    self._endpoint, self._app or "auto", self._programa or "auto")

    async def disconnect(self) -> None:
        await self._detener_lectura()
        if self._client is not None:
            try:
                await self._client.disconnect()
                logger.info("Sesión ctrlX cerrada correctamente.")
            except Exception as exc:  # noqa: BLE001
                logger.warning("Error al desconectar del ctrlX: %s", exc)
        self._connected = False
        self._client = None
        self.modo_lectura = "-"

    def is_connected(self) -> bool:
        return self._connected

    async def check_alive(self) -> bool:
        """Watchdog: el SubscriptionHandler lo llama cada healthcheck_interval."""
        if self._client is None:
            return False
        try:
            await self._client.nodes.server_state.read_value()
            return True
        except Exception:  # noqa: BLE001
            self._connected = False
            return False

    # ================================================================== #
    # Auto-descubrimiento de tags
    # ================================================================== #
    async def browse_tags(self) -> List[TagInfo]:
        """
        Navega hasta el programa seleccionado y registra sus variables.
        `db_name` se rellena con el nombre del programa, de modo que la vista
        (que agrupa por "Data Block") muestre los tags agrupados por POU.
        """
        if self._client is None:
            raise RuntimeError("browse_tags llamado sin conexión activa.")

        # Si el usuario no indicó app/programa, se descubren aquí (una sola vez,
        # reusando la sesión ya abierta: no cuesta una conexión extra).
        app, programa = await resolver_app_programa(
            self._client, self._app, self._programa
        )
        self.app_resuelta = app
        self.programa_resuelto = programa

        root = self._client.get_root_node()
        nodo_prog = await navegar(
            root, "Objects", "Datalayer", "plc", "app", app, "sym", programa
        )
        if nodo_prog is None:
            raise RuntimeError(
                f"No se encontró el programa '{programa}' en la app "
                f"'{app}'. Publica el proyecto desde la configuración de "
                f"símbolos o elige otro programa."
            )

        tags: List[TagInfo] = []
        await self._browse_recursivo(nodo_prog, programa, programa, tags, 0)

        self.tags_descubiertos = tags
        self.tag_por_nodeid = {t.node_id: t for t in tags}
        logger.info("Descubiertos %d tags en %s.%s", len(tags), app, programa)
        return tags

    async def _browse_recursivo(
        self, node: Node, programa: str, prefijo: str,
        acumulador: List[TagInfo], profundidad: int,
    ) -> None:
        """
        Recorre el árbol de símbolos. Un símbolo puede ser:
          * Variable directa            -> se registra.
          * Object con hijo 'Value'     -> se registra el hijo 'Value'.
          * Object sin 'Value' (struct) -> se recorre hacia dentro.
        """
        if profundidad > self._settings.rexroth_browse_depth:
            return

        for child in await node.get_children():
            try:
                nombre = (await child.read_browse_name()).Name
            except Exception:  # noqa: BLE001
                continue
            if not nombre or nombre in NODOS_IGNORADOS:
                continue

            try:
                node_class = await child.read_node_class()
            except Exception:  # noqa: BLE001
                continue

            full_name = f"{prefijo}.{nombre}" if prefijo != nombre else nombre

            if node_class == ua.NodeClass.Variable:
                await self._registrar(child, programa, full_name, nombre, acumulador)
                continue

            if node_class == ua.NodeClass.Object:
                # ¿Es un símbolo envuelto (Object con hijo 'Value')?
                nodo_valor = await buscar_hijo(child, "Value")
                if nodo_valor is not None:
                    await self._registrar(
                        nodo_valor, programa, full_name, nombre, acumulador
                    )
                else:
                    await self._browse_recursivo(
                        child, programa, full_name, acumulador, profundidad + 1
                    )

    async def _registrar(
        self, node: Node, programa: str, full_name: str, nombre: str,
        acumulador: List[TagInfo],
    ) -> None:
        """Convierte un nodo Variable en TagInfo y lo añade al acumulador."""
        try:
            data_type = await self._nombre_tipo_dato(node)
            if data_type in ("ByteString", "BYTES", "Image", "ImagePNG"):
                return
            acumulador.append(TagInfo(
                name=nombre,
                full_name=full_name,
                node_id=node.nodeid.to_string(),
                data_type=data_type,
                db_name=programa,
            ))
        except Exception as exc:  # noqa: BLE001
            logger.debug("Se omite el nodo '%s' durante el browse: %s", full_name, exc)

    async def _nombre_tipo_dato(self, node: Node) -> str:
        """Devuelve el tipo en nomenclatura IEC 61131 (BOOL, REAL, DINT, ...)."""
        try:
            vt = await node.read_data_type_as_variant_type()
            return TIPOS_IEC.get(vt.name, vt.name)
        except Exception:  # noqa: BLE001
            try:
                valor = await node.read_value()
                return type(valor).__name__
            except Exception:  # noqa: BLE001
                return "Unknown"

    # ================================================================== #
    # Lectura en tiempo real: subscription con fallback a polling
    # ================================================================== #
    async def subscribe(self, tags: List[TagInfo], callback: DataChangeCallback) -> None:
        """
        Intenta la subscription OPC UA nativa. Si falla, o si no llega ningún
        cambio en `rexroth_subscription_grace_s`, se conmuta a polling.
        """
        if self._client is None:
            raise RuntimeError("subscribe llamado sin conexión activa.")
        if not tags:
            logger.warning("No hay tags para leer en %s.%s", self._app, self._programa)
            return

        await self._detener_lectura()
        self._callback = callback
        self._datos_recibidos = False

        if self._settings.rexroth_force_polling:
            logger.info("rexroth_force_polling=True: se usa polling directamente.")
            await self._arrancar_polling(tags, callback)
            return

        try:
            handler = _SubHandler(self, callback)
            self._subscription = await self._client.create_subscription(
                period=self._settings.publishing_interval_ms, handler=handler,
            )
            nodos = [self._client.get_node(t.node_id) for t in tags]
            handles = await self._subscription.subscribe_data_change(
                nodos,
                queuesize=self._settings.subscription_queue_size,
                sampling_interval=float(self._settings.rexroth_sampling_interval_ms),
            )
            self._handles = handles if isinstance(handles, list) else [handles]
            self.modo_lectura = "subscription"
            logger.info(
                "ctrlX: subscription creada con %d MonitoredItems "
                "(publish=%dms, sampling=%dms).",
                len(nodos), self._settings.publishing_interval_ms,
                self._settings.rexroth_sampling_interval_ms,
            )
            # Vigilancia: si la subscription no entrega nada, caemos a polling.
            self._tarea_vigilancia = asyncio.create_task(
                self._vigilar_subscription(tags, callback)
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "El ctrlX rechazó la subscription (%s: %s). Se conmuta a polling.",
                type(exc).__name__, exc,
            )
            await self._cerrar_subscription()
            await self._arrancar_polling(tags, callback)

    async def _vigilar_subscription(
        self, tags: List[TagInfo], callback: DataChangeCallback
    ) -> None:
        """Espera la gracia configurada; si no llegó ningún dato, usa polling."""
        try:
            await asyncio.sleep(self._settings.rexroth_subscription_grace_s)
        except asyncio.CancelledError:
            raise
        if self._datos_recibidos or not self._connected:
            return
        logger.warning(
            "La subscription del ctrlX no entregó datos en %.1fs. "
            "Se conmuta a polling cada %d ms.",
            self._settings.rexroth_subscription_grace_s,
            self._settings.rexroth_poll_interval_ms,
        )
        await self._cerrar_subscription()
        await self._arrancar_polling(tags, callback)

    def marcar_datos_recibidos(self) -> None:
        """Lo invoca el handler en el primer datachange."""
        self._datos_recibidos = True

    # ---- Polling -------------------------------------------------------- #
    async def _arrancar_polling(
        self, tags: List[TagInfo], callback: DataChangeCallback
    ) -> None:
        self.modo_lectura = "polling"
        self._tarea_polling = asyncio.create_task(self._bucle_polling(tags, callback))

    async def _bucle_polling(
        self, tags: List[TagInfo], callback: DataChangeCallback
    ) -> None:
        """
        Lee todos los tags en bloque (una sola petición OPC UA) al intervalo
        configurado y emite SOLO los que cambiaron, para que el WebSocket se
        comporte igual que con subscriptions.
        """
        if self._client is None:
            return
        nodos = [self._client.get_node(t.node_id) for t in tags]
        intervalo = max(self._settings.rexroth_poll_interval_ms, 10) / 1000.0
        anteriores: Dict[str, object] = {}

        while self._connected:
            try:
                valores = await self._client.read_values(nodos)
                ahora = datetime.now(timezone.utc)
                for info, valor in zip(tags, valores):
                    serializable = _a_serializable(valor)
                    if info.full_name in anteriores and \
                            anteriores[info.full_name] == serializable:
                        continue  # sin cambio: no se emite
                    anteriores[info.full_name] = serializable
                    await self.emitir(info, valor, ahora, ahora, callback)
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001
                logger.warning("Error en el polling del ctrlX: %s", exc)
                self._connected = False  # el watchdog forzará la reconexión
                return

            try:
                await asyncio.sleep(intervalo)
            except asyncio.CancelledError:
                raise

    # ---- Emisión común (subscription y polling) ------------------------- #
    async def emitir(
        self,
        info: TagInfo,
        valor: object,
        source_dt: Optional[datetime],
        server_dt: Optional[datetime],
        callback: DataChangeCallback,
    ) -> None:
        """Construye el TagValue (con delta_ms) y lo entrega al callback."""
        ahora = datetime.now(timezone.utc)
        ref_dt = source_dt or ahora
        if ref_dt.tzinfo is None:
            ref_dt = ref_dt.replace(tzinfo=timezone.utc)

        delta_ms: Optional[float] = None
        anterior = self.ultimo_cambio_ts.get(info.full_name)
        if anterior is not None:
            delta_ms = (ref_dt - anterior).total_seconds() * 1000.0
        self.ultimo_cambio_ts[info.full_name] = ref_dt

        tag_value = TagValue(
            tag=info.full_name,
            value=_a_serializable(valor),
            data_type=info.data_type,
            timestamp=ahora.isoformat(),
            node_id=info.node_id,
            source_ts=_dt_iso(source_dt),
            server_ts=_dt_iso(server_dt),
            delta_ms=round(delta_ms, 1) if delta_ms is not None else None,
        )
        self.ultimos_valores[info.full_name] = tag_value
        await callback(tag_value)

    # ---- Parada de la lectura ------------------------------------------- #
    async def _detener_lectura(self) -> None:
        for tarea in (self._tarea_vigilancia, self._tarea_polling):
            if tarea is not None:
                tarea.cancel()
                try:
                    await tarea
                except (asyncio.CancelledError, Exception):  # noqa: BLE001
                    pass
        self._tarea_vigilancia = None
        self._tarea_polling = None
        await self._cerrar_subscription()

    async def _cerrar_subscription(self) -> None:
        if self._subscription is not None:
            try:
                await self._subscription.delete()
            except Exception as exc:  # noqa: BLE001
                logger.debug("Error al eliminar la subscription: %s", exc)
        self._subscription = None
        self._handles = []

    # ================================================================== #
    # Lectura puntual
    # ================================================================== #
    async def read_tag(self, node_id: str) -> TagValue:
        if self._client is None:
            raise RuntimeError("read_tag llamado sin conexión activa.")
        node = self._client.get_node(node_id)
        valor = await node.read_value()
        info = self.tag_por_nodeid.get(node_id)
        return TagValue(
            tag=info.full_name if info else node_id,
            value=_a_serializable(valor),
            data_type=info.data_type if info else type(valor).__name__,
            timestamp=_ahora_iso(),
            node_id=node_id,
        )
