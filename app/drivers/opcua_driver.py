# -*- coding: utf-8 -*-
"""
opcua_driver.py
===============
Implementación concreta del driver de PLC sobre OPC UA usando la librería
`asyncua` (async/await). Cubre:

  * Conexión al endpoint (con hook de seguridad para el futuro).
  * Auto-descubrimiento recursivo de tags navegando DataBlocksGlobal.
  * Subscriptions en TIEMPO REAL (MonitoredItems + datachange_notification).
    NO se hace polling: el servidor OPC UA notifica los cambios.
  * Tiempos precisos: SourceTimestamp (cuándo cambió en el PLC), ServerTimestamp
    y delta_ms (tiempo transcurrido desde el cambio anterior de ese tag).
  * Lectura puntual de un tag (read_tag).
  * Cierre limpio de subscription y sesión.
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Dict, List, Optional

from asyncua import Client, Node, ua

from app.config.settings import Settings
from app.drivers.plc_driver import (
    DataChangeCallback,
    PlcDriver,
    TagInfo,
    TagValue,
)

logger = logging.getLogger("opcua_driver")

# Nombres de nodos internos / metadata que NO son variables de datos reales.
NODOS_IGNORADOS = {"Icon", "InputArguments", "OutputArguments"}


def _ahora_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _dt_iso(dt: Optional[datetime]) -> str:
    """Convierte un datetime OPC UA a ISO 8601, o '' si es None."""
    if dt is None:
        return ""
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.isoformat()


def _a_serializable(valor: object) -> object:
    if isinstance(valor, (bool, int, float, str)) or valor is None:
        return valor
    if isinstance(valor, datetime):
        return valor.isoformat()
    return str(valor)


class _SubHandler:
    """
    Handler interno de asyncua para las subscriptions.

    En cada `datachange_notification` extrae el valor y las marcas de tiempo
    reales (SourceTimestamp/ServerTimestamp) del DataValue, calcula el intervalo
    respecto al cambio anterior del mismo tag (delta_ms) y reenvía al callback.
    """

    def __init__(self, driver: "OpcUaDriver", callback: DataChangeCallback) -> None:
        self._driver = driver
        self._callback = callback

    async def datachange_notification(self, node: Node, val, data) -> None:
        try:
            node_id = node.nodeid.to_string()
            info = self._driver.tag_por_nodeid.get(node_id)
            if info is None:
                return

            # Extraer las marcas de tiempo reales del DataValue.
            source_dt = None
            server_dt = None
            try:
                dv = data.monitored_item.Value
                source_dt = dv.SourceTimestamp
                server_dt = dv.ServerTimestamp
            except Exception:  # noqa: BLE001
                pass

            ahora = datetime.now(timezone.utc)
            # Referencia para el delta: preferimos SourceTimestamp (momento real
            # del cambio en el PLC); si no hay, usamos la hora de recepción.
            ref_dt = source_dt or ahora
            if ref_dt.tzinfo is None:
                ref_dt = ref_dt.replace(tzinfo=timezone.utc)

            # delta_ms = tiempo desde el cambio anterior de este mismo tag.
            delta_ms: Optional[float] = None
            anterior = self._driver.ultimo_cambio_ts.get(info.full_name)
            if anterior is not None:
                delta_ms = (ref_dt - anterior).total_seconds() * 1000.0
            self._driver.ultimo_cambio_ts[info.full_name] = ref_dt

            tag_value = TagValue(
                tag=info.full_name,
                value=_a_serializable(val),
                data_type=info.data_type,
                timestamp=ahora.isoformat(),
                node_id=node_id,
                source_ts=_dt_iso(source_dt),
                server_ts=_dt_iso(server_dt),
                delta_ms=round(delta_ms, 1) if delta_ms is not None else None,
            )
            self._driver.ultimos_valores[info.full_name] = tag_value
            await self._callback(tag_value)
        except Exception as exc:  # noqa: BLE001
            logger.warning("Error procesando datachange: %s", exc)


class OpcUaDriver(PlcDriver):
    """Driver OPC UA basado en asyncua."""

    def __init__(self, settings: Settings) -> None:
        self._settings = settings
        self._client: Optional[Client] = None
        self._subscription = None
        self._handles: List[int] = []
        self._connected: bool = False
        self._ns_index: Optional[int] = None

        # Estado compartido con el handler.
        self.tag_por_nodeid: Dict[str, TagInfo] = {}
        self.ultimos_valores: Dict[str, TagValue] = {}
        self.tags_descubiertos: List[TagInfo] = []
        # Momento del último cambio por tag, para calcular delta_ms.
        self.ultimo_cambio_ts: Dict[str, datetime] = {}

    # ==================================================================== #
    # Conexión
    # ==================================================================== #
    async def connect(self) -> None:
        self._client = Client(url=self._settings.opcua_endpoint)

        # HOOK DE SEGURIDAD (hoy 'No security'; listo para el futuro).
        if self._settings.security_policy and self._settings.security_mode:
            try:
                cadena = (
                    f"{self._settings.security_policy},"
                    f"{self._settings.security_mode},"
                    f"{self._settings.client_cert_path},"
                    f"{self._settings.client_private_key_path}"
                )
                if self._settings.server_cert_path:
                    cadena += f",{self._settings.server_cert_path}"
                await self._client.set_security_string(cadena)
                logger.info("Seguridad OPC UA aplicada.")
            except Exception as exc:  # noqa: BLE001
                logger.error("No se pudo aplicar seguridad: %s", exc)

        if self._settings.opcua_username:
            self._client.set_user(self._settings.opcua_username)
            if self._settings.opcua_password:
                self._client.set_password(self._settings.opcua_password)

        await self._client.connect()
        self._connected = True

        try:
            self._ns_index = await self._client.get_namespace_index(
                self._settings.opcua_namespace_uri
            )
            logger.info("Namespace resuelto a ns=%s", self._ns_index)
        except Exception:
            self._ns_index = 3
            logger.warning("No se pudo resolver el namespace por URI; uso ns=3.")

        logger.info("Conectado a OPC UA en %s", self._settings.opcua_endpoint)

    async def disconnect(self) -> None:
        await self._cerrar_subscription()
        if self._client is not None:
            try:
                await self._client.disconnect()
                logger.info("Sesión OPC UA cerrada correctamente.")
            except Exception as exc:  # noqa: BLE001
                logger.warning("Error al desconectar OPC UA: %s", exc)
        self._connected = False
        self._client = None

    async def _cerrar_subscription(self) -> None:
        if self._subscription is not None:
            try:
                await self._subscription.delete()
                logger.info("Subscription eliminada.")
            except Exception as exc:  # noqa: BLE001
                logger.warning("Error al eliminar subscription: %s", exc)
        self._subscription = None
        self._handles = []

    def is_connected(self) -> bool:
        return self._connected

    # ==================================================================== #
    # Auto-descubrimiento (browse)
    # ==================================================================== #
    async def browse_tags(self) -> List[TagInfo]:
        if self._client is None:
            raise RuntimeError("browse_tags llamado sin conexión activa.")

        objects = self._client.nodes.objects

        # Navegación robusta: la ruta cruza VARIOS namespaces
        # (DeviceSet=ns2, PLC_x/DataBlocksGlobal=ns3). Buscamos por BrowseName.
        deviceset = await self._buscar_hijo_por_nombre(
            objects, self._settings.browse_device_set
        )
        if deviceset is None:
            raise RuntimeError(
                f"No se encontró '{self._settings.browse_device_set}' bajo Objects."
            )

        plc = await self._buscar_hijo_por_nombre(
            deviceset, self._settings.browse_plc_name
        )
        dbs_node = None
        if plc is not None:
            dbs_node = await self._buscar_hijo_por_nombre(
                plc, self._settings.browse_datablocks_node
            )

        if dbs_node is None:
            logger.warning("Ruta configurada no encontrada; buscando bajo DeviceSet.")
            for hijo in await deviceset.get_children():
                candidato = await self._buscar_hijo_por_nombre(
                    hijo, self._settings.browse_datablocks_node
                )
                if candidato is not None:
                    dbs_node = candidato
                    plc_name = (await hijo.read_browse_name()).Name
                    logger.info("DataBlocksGlobal encontrado bajo '%s'.", plc_name)
                    break

        if dbs_node is None:
            raise RuntimeError(
                "No se pudo localizar 'DataBlocksGlobal' en el servidor OPC UA."
            )

        filtro_dbs = self._settings.load_db_filter()
        if filtro_dbs:
            logger.info("Filtro de DBs activo: %s", filtro_dbs)

        tags: List[TagInfo] = []
        for db_node in await dbs_node.get_children():
            db_name = (await db_node.read_browse_name()).Name
            if db_name in NODOS_IGNORADOS:
                continue
            if filtro_dbs and db_name not in filtro_dbs:
                continue
            await self._browse_recursivo(db_node, db_name, db_name, tags)

        self.tags_descubiertos = tags
        self.tag_por_nodeid = {t.node_id: t for t in tags}
        logger.info("Descubiertos %d tags en %d Data Blocks.",
                    len(tags), len({t.db_name for t in tags}))
        return tags

    async def _buscar_hijo_por_nombre(self, node: Node, nombre: str) -> Optional[Node]:
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

    async def _browse_recursivo(self, node, db_name, prefijo, acumulador) -> None:
        for child in await node.get_children():
            try:
                nombre = (await child.read_browse_name()).Name
            except Exception:  # noqa: BLE001
                continue
            if nombre in NODOS_IGNORADOS:
                continue
            try:
                node_class = await child.read_node_class()
            except Exception:  # noqa: BLE001
                continue
            if node_class == ua.NodeClass.Variable:
                await self._registrar_variable(child, db_name, prefijo, nombre, acumulador)
            elif node_class == ua.NodeClass.Object:
                await self._browse_recursivo(child, db_name, f"{prefijo}.{nombre}", acumulador)

    async def _registrar_variable(self, child, db_name, prefijo, nombre, acumulador) -> None:
        try:
            data_type = await self._nombre_tipo_dato(child)
            if data_type in ("ByteString", "Image", "ImagePNG"):
                return
            node_id = child.nodeid.to_string()
            full_name = f"{prefijo}.{nombre}" if prefijo != nombre else nombre
            acumulador.append(TagInfo(
                name=nombre, full_name=full_name, node_id=node_id,
                data_type=data_type, db_name=db_name,
            ))
        except Exception as exc:  # noqa: BLE001
            logger.debug("Se omite un nodo durante el browse: %s", exc)

    async def _nombre_tipo_dato(self, node: Node) -> str:
        try:
            dt_node = await node.read_data_type()
            if dt_node.NamespaceIndex == 0 and isinstance(dt_node.Identifier, int):
                nombre = ua.ObjectIdNames.get(dt_node.Identifier)
                if nombre:
                    return nombre
            dt_obj = self._client.get_node(dt_node)
            return (await dt_obj.read_browse_name()).Name
        except Exception:  # noqa: BLE001
            try:
                v = await node.read_value()
                return type(v).__name__
            except Exception:  # noqa: BLE001
                return "Unknown"

    # ==================================================================== #
    # Subscriptions en tiempo real
    # ==================================================================== #
    async def subscribe(self, tags: List[TagInfo], callback: DataChangeCallback) -> None:
        if self._client is None:
            raise RuntimeError("subscribe llamado sin conexión activa.")
        if not tags:
            logger.warning("No hay tags para suscribir.")
            return

        await self._cerrar_subscription()

        handler = _SubHandler(self, callback)
        # period = intervalo de publicación (cada cuánto el server envía lotes).
        self._subscription = await self._client.create_subscription(
            period=self._settings.publishing_interval_ms, handler=handler,
        )
        nodos = [self._client.get_node(t.node_id) for t in tags]

        # sampling_interval = cada cuánto el server MUESTREA cada tag (ms).
        muestreo = float(self._settings.sampling_interval_ms)
        try:
            handles = await self._subscription.subscribe_data_change(
                nodos,
                queuesize=self._settings.subscription_queue_size,
                sampling_interval=muestreo,
            )
            self._handles = handles if isinstance(handles, list) else [handles]
            logger.info("Subscription: %d MonitoredItems (publish=%dms, sampling=%dms).",
                        len(nodos), self._settings.publishing_interval_ms,
                        self._settings.sampling_interval_ms)
        except Exception as exc:  # noqa: BLE001
            logger.warning("Suscripción en lote falló (%s). Suscribo uno a uno.", exc)
            self._handles = []
            for nodo, info in zip(nodos, tags):
                try:
                    h = await self._subscription.subscribe_data_change(
                        nodo, queuesize=self._settings.subscription_queue_size,
                        sampling_interval=muestreo,
                    )
                    self._handles.append(h if not isinstance(h, list) else h[0])
                except Exception as e2:  # noqa: BLE001
                    logger.warning("No se pudo suscribir %s: %s", info.full_name, e2)

    # ==================================================================== #
    # Lectura puntual
    # ==================================================================== #
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

    # ==================================================================== #
    # Watchdog
    # ==================================================================== #
    async def check_alive(self) -> bool:
        if self._client is None:
            return False
        try:
            await self._client.nodes.server_state.read_value()
            return True
        except Exception:  # noqa: BLE001
            self._connected = False
            return False
