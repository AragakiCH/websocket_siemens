# -*- coding: utf-8 -*-
"""
settings.py
===========
Configuración centralizada del servicio. Todos los parámetros se leen desde
variables de entorno (o un archivo .env) usando pydantic-settings, de modo que
NADA queda hardcodeado en la lógica de negocio.

Ejemplo de variables de entorno soportadas (prefijo PLC_):
    PLC_OPCUA_ENDPOINT=opc.tcp://192.168.50.1:4840
    PLC_PUBLISHING_INTERVAL_MS=500
    PLC_SAMPLING_INTERVAL_MS=1000
    PLC_RECONNECT_MAX_DELAY=30

El filtro opcional de Data Blocks se puede definir por env (lista separada por
comas) o mediante un archivo YAML (app/config/tags_filter.yaml).
"""
from __future__ import annotations

import os
from functools import lru_cache
from typing import List, Optional

import yaml
from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Modelo de configuración de la aplicación."""

    # ------------------------------------------------------------------ #
    # Proveedor del PLC (marca)
    # ------------------------------------------------------------------ #
    # 'siemens' -> OpcUaDriver  (S7-1500, DataBlocksGlobal, anónimo)
    # 'rexroth' -> RexrothDriver (ctrlX CORE, Datalayer/plc/app, user+pass)
    # Es el valor por DEFECTO; cada PLC puede traer el suyo al darse de alta.
    vendor: str = Field(
        default="siemens",
        description="Marca del PLC por defecto: 'siemens' o 'rexroth'.",
    )

    # ------------------------------------------------------------------ #
    # Conexión OPC UA
    # ------------------------------------------------------------------ #
    opcua_endpoint: str = Field(
        default="opc.tcp://192.168.50.1:4840",
        description="Endpoint del servidor OPC UA del PLC.",
    )
    # Namespace donde viven los datos de usuario del S7-1500.
    # (http://www.siemens.com/simatic-s7-opcua -> normalmente ns=3)
    opcua_namespace_uri: str = Field(
        default="http://www.siemens.com/simatic-s7-opcua",
        description="URI del namespace de datos de usuario Siemens.",
    )
    # Ruta de navegación hacia los Data Blocks globales.
    # Se expresa como lista de BrowseNames relativos a 'Objects'.
    # OJO: el índice de namespace (3:) se resuelve dinámicamente en runtime.
    browse_device_set: str = Field(default="DeviceSet")
    browse_plc_name: str = Field(default="PLC_2")
    browse_datablocks_node: str = Field(default="DataBlocksGlobal")

    # ------------------------------------------------------------------ #
    # Seguridad (hoy "No security" + anónimo). Hooks para el futuro.
    # ------------------------------------------------------------------ #
    security_policy: Optional[str] = Field(
        default=None,
        description="Ej: 'Basic256Sha256'. None = sin seguridad.",
    )
    security_mode: Optional[str] = Field(
        default=None,
        description="Ej: 'SignAndEncrypt'. None = sin seguridad.",
    )
    client_cert_path: Optional[str] = Field(default=None)
    client_private_key_path: Optional[str] = Field(default=None)
    server_cert_path: Optional[str] = Field(default=None)
    opcua_username: Optional[str] = Field(default=None)
    opcua_password: Optional[str] = Field(default=None)

    # ------------------------------------------------------------------ #
    # Siemens sin OPC UA: S7comm (snap7) por el puerto 102
    # ------------------------------------------------------------------ #
    # 'opcua'  -> OpcUaDriver (S7-1500; S7-1200 con FW >= 4.4 + servidor OPC
    #             UA activado y licenciado). Descubre los DB solo.
    # 's7comm' -> S7CommDriver: S7-1200 (cualquier FW), S7-300/400, ET 200SP.
    #             Sin descubrimiento: la lista de tags la da el usuario.
    #             Exige PUT/GET permitido y DBs sin acceso optimizado.
    siemens_transporte: str = Field(default="opcua")
    s7_rack: int = Field(default=0)
    s7_slot: int = Field(default=1, description="1 en S7-1200/1500, 2 en S7-300.")
    s7_connect_timeout: float = Field(default=5.0)
    s7_poll_interval_ms: int = Field(default=250)
    # Lista de tags (una por línea): nombre;DB1;offset;TIPO
    s7_tags: str = Field(default="")

    # ------------------------------------------------------------------ #
    # Bosch Rexroth ctrlX CORE (solo aplica si vendor='rexroth')
    # ------------------------------------------------------------------ #
    # CÓMO se habla con el ctrlX:
    #   'datalayer' -> CtrlxDatalayerDriver: API REST del Data Layer por HTTPS
    #                  (JWT del identity-manager, bulk-read, eventos SSE).
    #                  Sin OPC UA, sin certificado de cliente. ES EL DEFECTO.
    #   'opcua'     -> RexrothDriver: el camino OPC UA de antes (asyncua,
    #                  cascada de seguridad, certificado autofirmado).
    rexroth_transporte: str = Field(
        default="datalayer",
        description="Transporte con el ctrlX: 'datalayer' (REST/HTTPS) u 'opcua'.")
    # Puerto HTTPS del ctrlX: 443 en hardware, 8443 en un COREvirtual con
    # port-forwarding. Solo aplica al transporte 'datalayer'.
    rexroth_https_port: int = Field(default=443)
    # El ctrlX trae un certificado autofirmado; por defecto se acepta. Con
    # PKI propia en planta, ponlo en true.
    rexroth_verify_ssl: bool = Field(default=False)
    # Cuántos nodos por petición de bulk-read.
    rexroth_bulk_max: int = Field(default=200)

    # El ctrlX SIEMPRE pide usuario y contraseña (no admite anónimo).
    rexroth_username: Optional[str] = Field(
        default=None, description="Usuario del ctrlX (ej. 'boschrexroth').")
    rexroth_password: Optional[str] = Field(
        default=None, description="Contraseña del ctrlX.")

    # Ruta de los datos: Datalayer/plc/app/<app>/sym/<programa>
    # Vacío = AUTODETECTAR navegando el Data Layer (lo habitual: hay una sola
    # app 'Application' con un solo programa 'PLC_PRG'). Rellenar solo si el
    # ctrlX tiene varias y quieres forzar una concreta.
    rexroth_app: str = Field(
        default="",
        description="Aplicación PLC dentro del Data Layer. Vacío = autodetectar.")
    rexroth_program: str = Field(
        default="",
        description="Programa (POU) cuyos símbolos se leen. Vacío = autodetectar.")

    # Profundidad máxima al recorrer estructuras anidadas dentro del programa.
    rexroth_browse_depth: int = Field(default=4)

    # Certificado de cliente. Si se dejan vacíos se genera uno automáticamente
    # en el perfil del usuario y se reutiliza en cada arranque.
    rexroth_cert_path: Optional[str] = Field(default=None)
    rexroth_key_path: Optional[str] = Field(default=None)
    rexroth_application_uri: str = Field(default="urn:psi:hmi-studio")
    rexroth_application_name: str = Field(default="HMI Studio")
    rexroth_connect_timeout: float = Field(default=8.0)

    # Muestreo de la subscription en el ctrlX (no tiene el mínimo de 1000 ms
    # del S7-1500, así que puede bajar bastante más).
    rexroth_sampling_interval_ms: int = Field(default=100)

    # Fallback a polling: si la subscription no entrega ningún dato en estos
    # segundos, se cierra y se lee por polling al intervalo indicado.
    rexroth_subscription_grace_s: float = Field(default=5.0)
    rexroth_poll_interval_ms: int = Field(default=100)
    # Saltarse el intento de subscription e ir directo a polling.
    rexroth_force_polling: bool = Field(default=False)

    # ------------------------------------------------------------------ #
    # Allen-Bradley / Rockwell Logix por EtherNet/IP (vendor='allenbradley')
    # ------------------------------------------------------------------ #
    # No hay usuario ni contraseña: CIP no autentica. La ruta es <ip>/<slot>.
    ab_slot: int = Field(default=0, description="Slot del procesador en el chasis (0 en CompactLogix).")
    ab_micro800: bool = Field(default=False, description="Micro800: sin slot y CIP simplificado.")
    ab_connect_timeout: float = Field(default=5.0)
    # EtherNet/IP explícito NO tiene subscription: siempre es polling.
    ab_poll_interval_ms: int = Field(default=250)
    ab_bulk_max: int = Field(default=100, description="Tags por lectura multi-service.")
    # Upload de tags: incluir los de programa (Program:Main.x) además de los
    # del controlador; profundidad al aplanar UDTs y tope de elementos por array.
    ab_incluir_programas: bool = Field(default=True)
    ab_browse_depth: int = Field(default=3)
    ab_max_elementos_array: int = Field(default=64)
    # Lista manual (coma, ; o salto de línea). Si se indica, NO se sube la
    # lista del controlador: útil en Micro800 antiguos o para acotar.
    ab_tags: str = Field(default="")

    # ------------------------------------------------------------------ #
    # Parámetros de las subscriptions (tiempo real, sin polling)
    # ------------------------------------------------------------------ #
    publishing_interval_ms: int = Field(
        default=500,
        description="Intervalo de publicación de la subscription (ms).",
    )
    sampling_interval_ms: int = Field(
        default=1000,
        description="Intervalo de muestreo por MonitoredItem (ms). El server "
        "S7-1500 tiene un mínimo de 1000ms.",
    )
    subscription_queue_size: int = Field(default=10)

    # ------------------------------------------------------------------ #
    # Reconexión automática (backoff exponencial)
    # ------------------------------------------------------------------ #
    reconnect_initial_delay: float = Field(default=2.0)
    reconnect_max_delay: float = Field(default=30.0)
    reconnect_backoff_factor: float = Field(default=2.0)
    # Cada cuánto el watchdog verifica que la sesión sigue viva (segundos).
    healthcheck_interval: float = Field(default=5.0)

    # ------------------------------------------------------------------ #
    # Filtro opcional de Data Blocks (default: todos)
    # ------------------------------------------------------------------ #
    # Lista de nombres de DB a incluir. Vacío/None => descubrir todos.
    tags_filter_dbs: Optional[List[str]] = Field(default=None)
    tags_filter_yaml_path: str = Field(
        default=os.path.join(os.path.dirname(__file__), "tags_filter.yaml")
    )

    # ------------------------------------------------------------------ #
    # Servidor web
    # ------------------------------------------------------------------ #
    api_host: str = Field(default="0.0.0.0")
    api_port: int = Field(default=8000)
    log_level: str = Field(default="INFO")

    # ------------------------------------------------------------------ #
    # Identidad de usuario (multiusuario)
    # ------------------------------------------------------------------ #
    # Si False, los endpoints no exigen sesión: cualquiera que abra la URL
    # puede hacer todo. Es el comportamiento histórico y sirve para trabajar en
    # local, pero NO debe quedarse así en planta: con diez personas, cualquiera
    # podría borrar un PLC de producción.
    auth_requerida: bool = Field(
        default=False,
        description="Exigir inicio de sesión en los endpoints que modifican "
                    "algo. Ponlo en true en producción.",
    )
    # Conexión donde vive la tabla `usuarios`. Vacío = la primera dada de alta.
    auth_db_id: Optional[str] = Field(default=None)
    # Prefijo de la tabla, si se creó el esquema con uno.
    auth_tabla_prefijo: str = Field(default="")

    # ------------------------------------------------------------------ #
    # Motor de alarmas
    # ------------------------------------------------------------------ #
    # Evalúa las reglas de `alarmas_def` contra los valores que llegan del
    # PLC y escribe los eventos en `alarmas`. Se cuelga del mismo flujo que
    # el historizador: no abre una segunda sesión OPC UA.
    alarmas_enabled: bool = Field(
        default=True,
        description="Activar el motor de alarmas. Ponlo en false para "
                    "silenciar la evaluación sin borrar ninguna regla: las "
                    "definiciones se conservan y se siguen pudiendo editar.",
    )
    # Conexión donde viven `alarmas_def` y `alarmas`. Vacío = la de por
    # defecto del CRUD, que es lo correcto en una instalación con una sola
    # base. Se separa por si el histórico y las alarmas van a servidores
    # distintos, cosa que pasa cuando el histórico es muy grande.
    alarmas_db_id: Optional[str] = Field(default=None)

    # ------------------------------------------------------------------ #
    # Zona horaria de VISUALIZACIÓN
    # ------------------------------------------------------------------ #
    # Los datos SIEMPRE se guardan en UTC (el SourceTimestamp de OPC UA es UTC
    # por especificación). Esta zona solo se usa para convertir al mostrar:
    # las lecturas del histórico devuelven `ts` (UTC) y `ts_local` ya
    # convertido a esta zona.
    #
    # Nombre IANA: America/Lima, America/Bogota, Europe/Madrid...
    # 'UTC' desactiva la conversión (ts_local == ts).
    timezone: str = Field(
        default="America/Lima",
        description="Zona horaria de la planta (nombre IANA). Es la hora que "
                    "se muestra y, con PLC_HISTORICO_HORA=local, la que se "
                    "guarda en la base de datos.",
    )
    # EN QUÉ HORA SE ESCRIBE `ts` EN LA BASE DE DATOS.
    #   'local' -> la de PLC_TIMEZONE. Es lo que una persona espera ver al
    #              abrir la tabla en SSMS o en Excel: la hora del reloj de la
    #              pared. (Defecto.)
    #   'utc'   -> UTC, como se hacía antes. Solo si la base la comparten
    #              plantas en zonas distintas.
    # Se aplica a TODO lo que se escribe (histórico, alarmas, recetas,
    # último acceso) y a todo lo que se lee: una columna sin zona se
    # interpreta siempre en esta misma hora, así que no se desplaza dos veces.
    historico_hora: str = Field(default="local")

    # ------------------------------------------------------------------ #
    # Descubrimiento de PLCs y modo multi-PLC
    # ------------------------------------------------------------------ #
    # Endpoints fijos que SIEMPRE se intentan (si ya conoces las IPs).
    # Env: PLC_STATIC_ENDPOINTS=opc.tcp://192.168.50.1:4840,opc.tcp://192.168.50.2:4840
    static_endpoints: Optional[List[str]] = Field(default=None)
    # Si True, además del/los endpoints fijos, escanea la subred buscando PLCs.
    discovery_enabled: bool = Field(default=True)
    # Subred a escanear en formato CIDR. Si None, se deriva del opcua_endpoint
    # (ej. 192.168.50.1 -> 192.168.50.0/24).
    discovery_subnet: Optional[str] = Field(default=None)
    discovery_port: int = Field(default=4840)
    # Timeout del sondeo TCP por host (s). Bajo = escaneo rápido.
    discovery_tcp_timeout: float = Field(default=0.8)
    # Timeout de la validación OPC UA (FindServers/GetEndpoints) por host (s).
    discovery_opcua_timeout: float = Field(default=4.0)
    # Nº de hosts sondeados en paralelo.
    discovery_concurrency: int = Field(default=64)
    # Re-escaneo periódico para detectar PLCs nuevos (s). 0 = solo al arrancar.
    discovery_interval: float = Field(default=0.0)
    # Lista blanca de PLCs a los que conectarse (por id/nombre/host/endpoint).
    # Vacío/None => conectarse a TODOS los descubiertos.
    # Env: PLC_INCLUDE_PLCS=PLC_2,192.168.50.3
    include_plcs: Optional[List[str]] = Field(default=None)

    # Si False, el servicio arranca SIN PLCs: no usa el endpoint semilla ni
    # escanea la red al inicio. Los PLCs se agregan desde la vista web
    # (POST /plcs o boton "Escanear red"). Env: PLC_AUTOSTART_PLCS=false
    autostart_plcs: bool = Field(default=True)

    # ------------------------------------------------------------------ #
    # Asistente de IA (Ollama Cloud o cualquier API compatible con OpenAI)
    # ------------------------------------------------------------------ #
    ai_enabled: bool = Field(
        default=True,
        description="Activa los endpoints /ai. Ponlo a false para desplegar "
                    "sin asistente.")
    ai_base_url: str = Field(
        default="https://ollama.com",
        description="Proveedor. Para un Ollama local: http://localhost:11434")
    ai_api_key: str = Field(
        default="",
        description="API key. NUNCA en el código: va en el .env "
                    "(PLC_AI_API_KEY). Un Ollama local no la necesita.")
    ai_model: str = Field(
        default="gpt-oss:120b-cloud",
        description="Modelo por defecto. Los modelos cloud rotan: si da 410, "
                    "consulta https://ollama.com/search?c=cloud")
    ai_models: List[str] = Field(
        default_factory=lambda: [
            "gpt-oss:120b-cloud", "gpt-oss:20b-cloud", "qwen3.5:122b-cloud",
            "deepseek-v4-pro:cloud", "deepseek-v4-flash:cloud",
            "glm-5.2:cloud", "kimi-k2.7-code:cloud", "minimax-m3:cloud",
        ],
        description="Modelos que ofrece el desplegable de la vista.")
    ai_max_tokens: int = Field(default=8192)
    ai_temperature: float = Field(
        default=0.2,
        description="Baja a propósito: en un HMI industrial se quiere "
                    "precisión, no creatividad.")
    ai_timeout_s: float = Field(default=180.0)

    # --- Comportamiento del agente ------------------------------------- #
    ai_max_pasos: int = Field(
        default=8,
        description="Máximo de ciclos herramienta→observación por pregunta. "
                    "Evita bucles infinitos y facturas sorpresa.")
    ai_permitir_escritura: bool = Field(
        default=False,
        description="Si False, el agente NUNCA ejecuta acciones que modifican "
                    "(dar de alta un PLC, borrar, historizar): las propone y "
                    "pide confirmación. Recomendado dejarlo en False.")
    ai_rag_fragmentos: int = Field(
        default=6,
        description="Cuántos fragmentos de documentación se inyectan como "
                    "contexto en cada pregunta.")
    ai_historial_max: int = Field(
        default=20,
        description="Mensajes de conversación que se conservan por sesión.")

    # Configuración de pydantic-settings: prefijo PLC_ y archivo .env
    model_config = SettingsConfigDict(
        env_prefix="PLC_",
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # ------------------------------------------------------------------ #
    # Utilidades
    # ------------------------------------------------------------------ #
    def load_db_filter(self) -> Optional[List[str]]:
        """
        Devuelve la lista de DBs a incluir.
        Prioridad: variable de entorno > archivo YAML > None (todos).
        """
        # 1) Si vino por env, se usa directamente.
        if self.tags_filter_dbs:
            return [d.strip() for d in self.tags_filter_dbs if d.strip()]

        # 2) Si existe el YAML, se intenta leer la clave 'include_dbs'.
        path = self.tags_filter_yaml_path
        if path and os.path.isfile(path):
            try:
                with open(path, "r", encoding="utf-8") as fh:
                    data = yaml.safe_load(fh) or {}
                dbs = data.get("include_dbs")
                if dbs:
                    return [str(d).strip() for d in dbs if str(d).strip()]
            except Exception:
                # Un YAML mal formado no debe tumbar el arranque.
                pass

        # 3) Sin filtro: se descubren todos los DBs.
        return None

    # ------------------------------------------------------------------ #
    # Helpers de descubrimiento / multi-PLC
    # ------------------------------------------------------------------ #
    def zona_horaria(self):
        """
        Devuelve el objeto de zona horaria configurado (`ZoneInfo`).

        Si el nombre no existe o falta la base de datos de zonas horarias (en
        Windows hace falta el paquete `tzdata`), se cae a UTC con un aviso en
        vez de tumbar el servicio: una zona mal escrita no debe impedir
        historizar.
        """
        from datetime import datetime as _dt, timezone as _tz

        nombre = (self.timezone or "").strip()
        if nombre.upper() == "UTC":
            return _tz.utc
        if nombre:
            try:
                from zoneinfo import ZoneInfo

                return ZoneInfo(nombre)
            except Exception:  # noqa: BLE001
                import logging

                logging.getLogger("settings").warning(
                    "Zona horaria '%s' no disponible (en Windows suele faltar "
                    "el paquete 'tzdata': pip install tzdata). Se usa la zona "
                    "del sistema operativo.", nombre,
                )
        # SIN tzdata (o sin nombre): la zona del propio equipo. Antes aquí se
        # caía a UTC, y el resultado era un Excel y un SQL cinco horas por
        # delante del reloj de la pared, sin ningún error a la vista. La hora
        # del sistema es lo que ve quien está delante: es la respuesta
        # correcta cuando no hay otra.
        local = _dt.now().astimezone().tzinfo
        return local or _tz.utc

    def load_static_endpoints(self) -> List[str]:
        """
        Lista de endpoints fijos (manuales). Incluye `static_endpoints` y, por
        compatibilidad, el `opcua_endpoint` clásico. Sin duplicados.
        """
        endpoints: List[str] = []
        if self.static_endpoints:
            for e in self.static_endpoints:
                e = e.strip()
                if e and e not in endpoints:
                    endpoints.append(e)
        # Semilla: el endpoint clásico (si está definido y no repetido).
        if self.opcua_endpoint and self.opcua_endpoint not in endpoints:
            endpoints.append(self.opcua_endpoint)
        return endpoints

    def resolve_subnet(self) -> Optional[str]:
        """
        Devuelve la subred CIDR a escanear. Si no se configuró, la deriva de la
        IP del `opcua_endpoint` asumiendo /24 (ej. 192.168.50.1 -> .0/24).
        """
        if self.discovery_subnet:
            return self.discovery_subnet
        try:
            # opc.tcp://192.168.50.1:4840 -> host 192.168.50.1
            host = self.opcua_endpoint.split("//", 1)[1].split(":", 1)[0]
            partes = host.split(".")
            if len(partes) == 4:
                return f"{partes[0]}.{partes[1]}.{partes[2]}.0/24"
        except Exception:
            pass
        return None


@lru_cache
def get_settings() -> Settings:
    """Devuelve una instancia única (cacheada) de Settings."""
    return Settings()
