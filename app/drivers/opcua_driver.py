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

import asyncio
import logging
import math
from datetime import datetime, timezone
from typing import Dict, List, Optional

from asyncua import Client, Node, ua

from app.config.settings import Settings
from app.drivers.escritura import convertir
from app.drivers.plc_driver import (
    DataChangeCallback,
    PlcDriver,
    TagInfo,
    TagValue,
)

logger = logging.getLogger("opcua_driver")

# Nodos por petición `Read` en `read_tags`. Muy por debajo del límite
# habitual del S7-1500 (MaxNodesPerRead ≈ 1000) para no rozarlo nunca.
LOTE_LECTURA = 250

# MonitoredItems por petición CreateMonitoredItems. Un S7-1500 acepta
# cientos por petición; trocear evita un único request enorme que el servidor
# rechace entero, y deja ver POR TROZO cuáles aceptó y cuáles no.
LOTE_SUSCRIPCION = 500

# Confirmación de una escritura: el servidor OPC UA del S7-1500 contesta a un
# Read con el valor de su CACHÉ, que refresca cada «minimum sampling
# interval» (100 ms de fábrica). Releer en el mismo milisegundo que se
# escribió devuelve el valor VIEJO, y entonces la aplicación guardaba en su
# snapshot el 0 que había, no el 777 que acababa de escribir, y encima decía
# «el PLC no guardó ese valor». Se relee hasta que coincida o se agote el
# plazo (8 x 75 ms = 600 ms): si tras eso sigue distinto, es que el programa
# del PLC lo pisó de verdad, y ESO sí hay que decirlo.
CONFIRMACION_INTENTOS = 8
CONFIRMACION_ESPERA_S = 0.075


def _coincide(leido: object, escrito: object) -> bool:
    """Igualdad con tolerancia para decimales (un REAL de 32 bits recorta)."""
    if isinstance(leido, bool) or isinstance(escrito, bool):
        return leido == escrito
    if isinstance(leido, float) or isinstance(escrito, float):
        try:
            return math.isclose(float(leido), float(escrito), rel_tol=1e-6, abs_tol=1e-9)
        except (TypeError, ValueError):
            return False
    return leido == escrito

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
    """
    Convierte el valor a algo que `json.dumps` acepte.

    Los ARRAYS del PLC (`Array[1..20] of Bool`) llegan como lista y se dejan
    como lista: antes se pasaban por `str()` y el frontend recibía
    "[True, False, ...]" como si fuera un texto. Un UDT ya decodificado por
    asyncua (`load_data_type_definitions`) llega como objeto con atributos y
    se convierte en dict. Un ExtensionObject SIN decodificar (los bytes del
    struct, el `Body=b'\\x00...'` de la captura) no sirve para nada en un
    widget: se devuelve None.
    """
    if isinstance(valor, (bool, int, float, str)) or valor is None:
        return valor
    if isinstance(valor, datetime):
        return valor.isoformat()
    if isinstance(valor, (bytes, bytearray)):
        return None
    if isinstance(valor, (list, tuple)):
        return [_a_serializable(v) for v in valor]
    if isinstance(valor, dict):
        return {str(k): _a_serializable(v) for k, v in valor.items()}
    if isinstance(valor, ua.ExtensionObject):
        return None
    # Struct decodificado por asyncua: un objeto plano con sus campos.
    campos = getattr(valor, "__dict__", None)
    if isinstance(campos, dict) and campos:
        return {k: _a_serializable(v) for k, v in campos.items()
                if not k.startswith("_")}
    return str(valor)


def _es_struct_crudo(valor: object) -> bool:
    """¿Es un UDT que no se ha podido decodificar (o una lista de ellos)?"""
    if isinstance(valor, ua.ExtensionObject):
        return True
    if isinstance(valor, (list, tuple)) and valor:
        return isinstance(valor[0], ua.ExtensionObject)
    return False


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

    def status_change_notification(self, status) -> None:
        """
        El servidor avisa de que la subscription cambió de estado. En la
        práctica llega UNA vez, cuando la da por caducada (`BadTimeout`: el
        cliente no envió Publish a tiempo, p. ej. tras una pausa del equipo)
        o la cierra por su cuenta. La SESIÓN sigue viva, así que el watchdog
        de sesión no ve nada raro; sin esto, el PLC quedaba "conectado" y sin
        entregar un solo cambio hasta reiniciar el programa. Se marca aquí y
        el SubscriptionHandler la recrea en su siguiente vuelta.
        """
        logger.warning("La subscription cambió de estado: %s. Se recreará.",
                       status)
        self._driver.subscription_caida = True


class OpcUaDriver(PlcDriver):
    """Driver OPC UA basado en asyncua."""

    def __init__(self, settings: Settings) -> None:
        self._settings = settings
        # Modelo de la CPU leído del servidor, para la vista. "" si no se pudo.
        self.modelo: str = ""
        self._client: Optional[Client] = None
        self._subscription = None
        self._handles: List[int] = []
        self._connected: bool = False
        self._ns_index: Optional[int] = None

        # La subscription dejó de valer (StatusChangeNotification del
        # servidor). La lee `subscription_viva()`; la limpia `subscribe()`.
        self.subscription_caida: bool = False
        # Tags cuyo MonitoredItem el servidor RECHAZÓ al suscribir (p. ej.
        # BadTooManyMonitoredItems: cada CPU tiene un tope, y 3.000 tags lo
        # pasan en muchas). Esos no reciben notificaciones: solo los pone al
        # día la lectura de contraste del SubscriptionHandler. Se guarda para
        # decirlo en el estado y en el log, en vez de fingir que todo va.
        self.sin_monitorizar: Dict[str, str] = {}
        self._aviso_lectura: bool = False

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

        try:
            await self._client.connect()
        except Exception as exc:  # noqa: BLE001
            # Un S7-1200 sin servidor OPC UA (FW < 4.4, o sin activar) cae
            # aquí con un "Connection refused" que no orienta a nadie. Se
            # dice lo que casi siempre es.
            raise ConnectionError(
                f"No se pudo abrir sesión OPC UA en {self._settings.opcua_endpoint}: "
                f"{exc}. Si es un S7-1200, su servidor OPC UA solo existe desde "
                f"FW 4.4 y hay que activarlo (Propiedades → OPC UA → Servidor); "
                f"si no, conecta por S7comm (puerto 102). Usa 'Identificar' para "
                f"ver el modelo."
            ) from exc
        self._connected = True
        await self._leer_modelo()

        # Definiciones de los UDT del PLC. Con esto, un `Array of
        # "UDT_Analog_REAL"` llega decodificado (campo a campo) en vez de como
        # un ExtensionObject opaco. El S7-1500 las publica desde FW 2.5; si
        # no están, no pasa nada: los structs con miembros se expanden igual
        # en el browse, y los que no se puedan decodificar se omiten.
        try:
            await self._client.load_data_type_definitions()
            logger.info("Definiciones de tipos (UDT) cargadas del servidor.")
        except Exception as exc:  # noqa: BLE001
            logger.debug("Sin definiciones de UDT del servidor: %s", exc)

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

    async def _leer_modelo(self) -> None:
        """
        Modelo de la CPU ("CPU 1516-3 PN/DP") desde las propiedades DI del
        nodo del PLC (`DeviceSet/PLC_x/Model` u `OrderNumber`). Solo para
        enseñarlo: si no está, no pasa nada.
        """
        self.modelo = ""
        try:
            ds = await self._buscar_hijo_por_nombre(
                self._client.nodes.objects, self._settings.browse_device_set)
            if ds is None:
                return
            plc = await self._buscar_hijo_por_nombre(ds, self._settings.browse_plc_name)
            if plc is None:
                hijos = await ds.get_children()
                plc = hijos[0] if hijos else None
            if plc is None:
                return
            for prop in ("Model", "OrderNumber", "DeviceModel"):
                n = await self._buscar_hijo_por_nombre(plc, prop)
                if n is None:
                    continue
                v = await n.read_value()
                v = getattr(v, "Text", v)
                if v:
                    self.modelo = str(v)
                    return
        except Exception as exc:  # noqa: BLE001
            logger.debug("Sin modelo de CPU por OPC UA: %s", exc)

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
                # Un STRUCT / UDT del DB es una Variable (su valor es el
                # struct entero como ExtensionObject) que ADEMÁS tiene como
                # hijos sus miembros, uno por campo marcado "accesible desde
                # OPC UA". Antes se registraba solo el padre y el frontend
                # enseñaba los bytes crudos del struct (`Body=b'\\x00...'`).
                # Si tiene hijos, se entra: lo que se quiere son los campos.
                hijos = await self._hijos_variables(child)
                if hijos:
                    await self._browse_recursivo(
                        child, db_name, f"{prefijo}.{nombre}", acumulador)
                    continue
                await self._registrar_variable(child, db_name, prefijo, nombre, acumulador)
            elif node_class == ua.NodeClass.Object:
                await self._browse_recursivo(child, db_name, f"{prefijo}.{nombre}", acumulador)

    async def _hijos_variables(self, node: Node) -> List[Node]:
        """Hijos de clase Variable de un nodo (los miembros de un struct)."""
        try:
            hijos = await node.get_children()
        except Exception:  # noqa: BLE001
            return []
        salida: List[Node] = []
        for h in hijos:
            try:
                if await h.read_node_class() == ua.NodeClass.Variable:
                    salida.append(h)
            except Exception:  # noqa: BLE001
                continue
        return salida

    async def _registrar_variable(self, child, db_name, prefijo, nombre, acumulador) -> None:
        try:
            data_type = await self._nombre_tipo_dato(child)
            if data_type in ("ByteString", "Image", "ImagePNG"):
                return
            node_id = child.nodeid.to_string()
            full_name = f"{prefijo}.{nombre}" if prefijo != nombre else nombre

            # ¿Es un array? El ValueRank lo dice sin leer el valor. Se anota
            # en el tipo ("Boolean[20]") para que la vista sepa que lo que
            # llega es una lista y no lo pinte como un ON/OFF suelto.
            try:
                rank = await child.read_attribute(ua.AttributeIds.ValueRank)
                rank = rank.Value.Value
            except Exception:  # noqa: BLE001
                rank = -1
            if isinstance(rank, int) and rank >= 1:
                try:
                    dims = await child.read_attribute(ua.AttributeIds.ArrayDimensions)
                    dims = list(dims.Value.Value or [])
                except Exception:  # noqa: BLE001
                    dims = []
                data_type = f"{data_type}[{'x'.join(str(d) for d in dims) if dims else ''}]"

            # Un struct SIN miembros expuestos (o un array de UDT que el
            # servidor no sabe describir) es un ExtensionObject opaco: no
            # hay forma de enlazarlo a un widget. Se omite y se dice por qué,
            # que es mejor que enseñar sus bytes como si fueran un texto.
            try:
                valor = await child.read_value()
            except Exception:  # noqa: BLE001
                valor = None
            if _es_struct_crudo(valor):
                logger.warning(
                    "Se omite '%s' (%s): es una estructura que el servidor no "
                    "expone campo a campo. En TIA Portal, marca sus miembros "
                    "como 'Accesible desde OPC UA' o publica las definiciones "
                    "de tipo (FW >= 2.5).", full_name, data_type)
                return

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
        self.subscription_caida = False

        handler = _SubHandler(self, callback)
        # period = intervalo de publicación (cada cuánto el server envía lotes).
        self._subscription = await self._client.create_subscription(
            period=self._settings.publishing_interval_ms, handler=handler,
        )
        nodos = [self._client.get_node(t.node_id) for t in tags]

        # sampling_interval = cada cuánto el server MUESTREA cada tag (ms).
        muestreo = float(self._settings.sampling_interval_ms)
        self._handles = []
        self.sin_monitorizar = {}

        # POR TROZOS, Y MIRANDO LA RESPUESTA DE CADA UNO.
        #
        # `subscribe_data_change` con una lista NO lanza si el servidor
        # rechaza parte de los items: devuelve un `ua.StatusCode` en la
        # posición de cada rechazado y un handle en las demás. Antes se
        # guardaba esa lista tal cual y se anunciaba «3226 MonitoredItems»
        # aunque la CPU hubiera aceptado 1000: los tags del final del browse
        # se quedaban sin notificaciones y nadie lo sabía — «escribo en TIA y
        # aquí nunca cambia». Ahora cada rechazo se cuenta, se nombra y se
        # recuerda (`sin_monitorizar`), y el SubscriptionHandler los cubre con
        # su lectura de contraste.
        for i in range(0, len(nodos), LOTE_SUSCRIPCION):
            trozo_nodos = nodos[i:i + LOTE_SUSCRIPCION]
            trozo_tags = tags[i:i + LOTE_SUSCRIPCION]
            try:
                handles = await self._subscription.subscribe_data_change(
                    trozo_nodos,
                    queuesize=self._settings.subscription_queue_size,
                    sampling_interval=muestreo,
                )
            except Exception as exc:  # noqa: BLE001
                logger.warning("Suscripción del trozo %d-%d falló (%s). "
                               "Suscribo uno a uno.", i, i + len(trozo_nodos), exc)
                for nodo, info in zip(trozo_nodos, trozo_tags):
                    try:
                        h = await self._subscription.subscribe_data_change(
                            nodo, queuesize=self._settings.subscription_queue_size,
                            sampling_interval=muestreo,
                        )
                        self._handles.append(h if not isinstance(h, list) else h[0])
                    except Exception as e2:  # noqa: BLE001
                        self.sin_monitorizar[info.full_name] = str(e2)
                continue
            if not isinstance(handles, list):
                handles = [handles]
            for h, info in zip(handles, trozo_tags):
                if isinstance(h, ua.StatusCode):
                    self.sin_monitorizar[info.full_name] = h.name
                else:
                    self._handles.append(h)

        aceptados = len(self._handles)
        if self.sin_monitorizar:
            motivos: Dict[str, int] = {}
            for m in self.sin_monitorizar.values():
                motivos[m] = motivos.get(m, 0) + 1
            ejemplos = ", ".join(list(self.sin_monitorizar)[:5])
            logger.warning(
                "Subscription: el servidor aceptó %d de %d MonitoredItems y "
                "RECHAZÓ %d (%s). Esos tags no reciben cambios en tiempo real "
                "—la CPU tiene un tope de items monitorizados—; se actualizan "
                "con la lectura de contraste del watchdog. Primeros: %s",
                aceptados, len(nodos), len(self.sin_monitorizar),
                ", ".join(f"{k}: {v}" for k, v in motivos.items()), ejemplos)
        else:
            logger.info("Subscription: %d MonitoredItems (publish=%dms, sampling=%dms).",
                        aceptados, self._settings.publishing_interval_ms,
                        self._settings.sampling_interval_ms)

    def subscription_viva(self) -> bool:
        return not self.subscription_caida

    # ==================================================================== #
    # Lectura puntual
    # ==================================================================== #
    async def read_tags(self, node_ids: List[str]) -> List[Optional[TagValue]]:
        """
        Lee varios tags con UNA petición `Read` por lote (el S7-1500 admite
        cientos de nodos por petición; se trocea por si el programa es
        grande). Si un lote entero falla, sus posiciones quedan en `None` y
        se sigue con el siguiente: una lectura de contraste no puede tumbar
        la conexión.
        """
        if self._client is None:
            raise RuntimeError("read_tags llamado sin conexión activa.")
        salida: List[Optional[TagValue]] = []
        ahora = _ahora_iso()
        for i in range(0, len(node_ids), LOTE_LECTURA):
            lote = node_ids[i:i + LOTE_LECTURA]
            try:
                # `read_attributes` y no `read_values`: trae el StatusCode de
                # CADA item. Un tag que el servidor no puede leer (un STRUCT,
                # un tipo raro) no debe convertirse en un `None` que luego
                # parezca «el PLC lo puso a nada», ni tumbar el lote entero.
                datos = await self._client.read_attributes(
                    [self._client.get_node(n) for n in lote],
                    attr=ua.AttributeIds.Value,
                )
            except Exception as exc:  # noqa: BLE001
                if not self._aviso_lectura:
                    self._aviso_lectura = True
                    logger.warning("Lectura en bloque fallida (%d nodos): %s. "
                                   "La lectura de contraste no funciona para "
                                   "ese tramo (se avisa una vez).",
                                   len(lote), exc)
                salida.extend([None] * len(lote))
                continue
            for node_id, dv in zip(lote, datos):
                sc = getattr(dv, "StatusCode", None)
                if dv is None or dv.Value is None or (sc is not None and not sc.is_good()):
                    salida.append(None)
                    continue
                valor = dv.Value.Value
                info = self.tag_por_nodeid.get(node_id)
                salida.append(TagValue(
                    tag=info.full_name if info else node_id,
                    value=_a_serializable(valor),
                    data_type=info.data_type if info else type(valor).__name__,
                    timestamp=ahora,
                    node_id=node_id,
                    source_ts=_dt_iso(getattr(dv, "SourceTimestamp", None)),
                    server_ts=_dt_iso(getattr(dv, "ServerTimestamp", None)),
                ))
        return salida

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

    async def write_tag(self, node_id: str, valor: object) -> TagValue:
        """
        Escribe en un tag del S7-1500 y devuelve el valor RELEÍDO.

        El tipo se pregunta al servidor con `read_data_type_as_variant_type()`
        en vez de deducirlo del `data_type` que guardamos al hacer el browse.
        Son dos fuentes distintas y la del servidor es la que manda: nuestro
        catálogo pudo quedarse viejo si alguien recargó el programa del PLC, y
        escribir con un Variant equivocado es justo lo que hay que evitar.

        La relectura posterior no es opcional en un HMI: en un S7 es normal que
        el programa sobrescriba una consigna en el mismo ciclo de scan si esa
        variable la gobierna un bloque. Sin releer, la interfaz diría "escrito"
        y el PLC tendría otra cosa.
        """
        if self._client is None:
            raise RuntimeError("write_tag llamado sin conexión activa.")

        node = self._client.get_node(node_id)
        info = self.tag_por_nodeid.get(node_id)

        try:
            tipo_variante = await node.read_data_type_as_variant_type()
        except Exception as exc:  # noqa: BLE001
            raise RuntimeError(
                f"No se pudo leer el tipo de dato de '{node_id}' en el PLC: {exc}"
            ) from exc

        # El nombre del tipo sale del propio servidor (Boolean, Int16, Float…),
        # que es el mismo vocabulario que entiende `escritura.convertir`.
        nombre_tipo = tipo_variante.name
        valor_convertido = convertir(valor, nombre_tipo)

        try:
            await node.write_value(
                ua.DataValue(ua.Variant(valor_convertido, tipo_variante))
            )
        except ua.UaStatusCodeError as exc:
            # El caso más común con diferencia: la variable existe y se puede
            # leer, pero el servidor OPC UA del S7 la expone como de solo
            # lectura. Merece un mensaje que diga qué hacer en TIA Portal.
            raise PermissionError(
                f"El PLC rechazó la escritura en '{info.full_name if info else node_id}': "
                f"{exc}. Si el código es BadUserAccessDenied o BadNotWritable, la "
                f"variable está como solo lectura en el servidor OPC UA: en TIA "
                f"Portal, propiedades del DB, hay que marcarla como accesible y "
                f"escribible desde OPC UA."
            ) from exc

        logger.info("Escrito %s = %r en %s",
                    info.full_name if info else node_id, valor_convertido,
                    self._settings.opcua_endpoint)

        # Releer HASTA que el servidor refleje lo escrito (ver
        # CONFIRMACION_INTENTOS). La primera lectura suele traer todavía el
        # valor de la caché anterior.
        tv = await self.read_tag(node_id)
        intentos = 1
        while not _coincide(tv.value, valor_convertido) and intentos < CONFIRMACION_INTENTOS:
            await asyncio.sleep(CONFIRMACION_ESPERA_S)
            tv = await self.read_tag(node_id)
            intentos += 1
        if not _coincide(tv.value, valor_convertido):
            logger.warning("Tras escribir %s = %r, el PLC devuelve %r "
                           "(%d relecturas en %.0f ms): el programa lo pisa "
                           "o el servidor no lo refresca.",
                           info.full_name if info else node_id, valor_convertido,
                           tv.value, intentos,
                           intentos * CONFIRMACION_ESPERA_S * 1000)
        elif intentos > 1:
            logger.debug("Escritura de %s confirmada a la relectura %d.",
                         info.full_name if info else node_id, intentos)
        return tv

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
