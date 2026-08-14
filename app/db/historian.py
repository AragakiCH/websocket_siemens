# -*- coding: utf-8 -*-
"""
historian.py
============
Historizador: guarda en base de datos los valores de los tags de los PLCs.

Es el camino de ESCRITURA del sistema, y va deliberadamente separado del de
los widgets:

    PLC ──► SubscriptionHandler ──► ConnectionManager.broadcast()
                                          │
                        ┌─────────────────┴─────────────────┐
                        ▼                                   ▼
                 clientes WebSocket                  Historizador
                 (la vista en vivo)             (buffer → INSERT por lotes)
                                                            │
                                                            ▼
                                                    tabla historico_tags
                                                            │
                                    widgets ◄── SELECT (solo lectura) ◄──┘

El historizador se engancha como *observador* del ConnectionManager: escucha
el mismo flujo que alimenta la vista, así que **no abre una segunda sesión OPC
UA** ni añade carga al PLC. Y sigue guardando aunque no haya nadie mirando la
pantalla.

Seguridad: el SQL de inserción lo genera el backend (`sql_insert_historico`),
nunca el usuario. Los widgets no tienen forma de llegar a este camino: sus
consultas siguen pasando por `validar_sql_lectura()`.

Rendimiento: los cambios NO se escriben uno a uno. Se acumulan en un buffer en
memoria y se vuelcan por lotes (`executemany`), que es la diferencia entre
cientos de viajes a la BD por segundo y uno cada pocos segundos.
"""
from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

logger = logging.getLogger("historian")

# Límite duro del buffer en memoria. Si la BD está caída y el buffer se llena,
# se descartan las muestras MÁS ANTIGUAS: es preferible perder histórico viejo
# a que el servicio se quede sin memoria y tumbe también la vista en vivo.
MAX_BUFFER = 50_000


def _ahora_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


class GrupoHistorizacion:
    """
    Un conjunto de tags que se guardan juntos en una tabla.

    Permite tener, por ejemplo, un grupo "proceso" que guarda temperaturas cada
    cambio en la BD del MES, y otro "calidad" con otras variables en otra BD.
    """

    def __init__(
        self,
        grupo_id: str,
        db_id: str,
        tags: List[str],
        tabla: str = "historico_tags",
        nombre: str = "",
        activo: bool = True,
        banda_muerta: float = 0.0,
        intervalo_min_ms: int = 0,
    ) -> None:
        self.grupo_id = grupo_id
        self.db_id = db_id
        # Claves "plc|tag" (el mismo formato que usa el WebSocket).
        self.tags = list(tags)
        self.tabla = tabla
        self.nombre = nombre or grupo_id
        self.activo = activo
        # --- Válvulas de seguridad (0 = desactivadas) --------------------
        # banda_muerta: ignora cambios numéricos menores que este valor.
        #   Útil si una señal ruidosa genera miles de filas por minuto.
        self.banda_muerta = float(banda_muerta)
        # intervalo_min_ms: descarta muestras del mismo tag si llegan antes de
        #   este tiempo desde la anterior (limita la frecuencia máxima).
        self.intervalo_min_ms = int(intervalo_min_ms)

        # Estado en memoria (no se persiste).
        self.ultimo_valor: Dict[str, Any] = {}
        self.ultimo_ts: Dict[str, float] = {}
        self.filas_escritas: int = 0
        self.filas_descartadas: int = 0
        self.ultimo_error: str = ""
        self.ultima_escritura: str = ""
        self._tabla_lista = False

    # ------------------------------------------------------------------ #
    def interesa(self, clave: str) -> bool:
        """True si este grupo guarda ese tag. Lista vacía = TODOS los tags."""
        return not self.tags or clave in self.tags

    def debe_guardar(self, clave: str, valor: Any, ahora: float) -> bool:
        """
        Aplica las válvulas de seguridad. Con la configuración por defecto
        (ambas a 0) devuelve siempre True: se guarda cada cambio.
        """
        if self.intervalo_min_ms > 0:
            anterior = self.ultimo_ts.get(clave)
            if anterior is not None:
                if (ahora - anterior) * 1000.0 < self.intervalo_min_ms:
                    return False

        if self.banda_muerta > 0 and isinstance(valor, (int, float)) \
                and not isinstance(valor, bool):
            previo = self.ultimo_valor.get(clave)
            if isinstance(previo, (int, float)) and not isinstance(previo, bool):
                if abs(float(valor) - float(previo)) < self.banda_muerta:
                    return False

        self.ultimo_valor[clave] = valor
        self.ultimo_ts[clave] = ahora
        return True

    def estado(self) -> dict:
        """Estado del grupo, para GET /historian."""
        return {
            "grupo_id": self.grupo_id,
            "nombre": self.nombre,
            "db_id": self.db_id,
            "tabla": self.tabla,
            "activo": self.activo,
            "num_tags": len(self.tags),
            "tags": self.tags,
            "todos_los_tags": not self.tags,
            "banda_muerta": self.banda_muerta,
            "intervalo_min_ms": self.intervalo_min_ms,
            "filas_escritas": self.filas_escritas,
            "filas_descartadas": self.filas_descartadas,
            "ultima_escritura": self.ultima_escritura,
            "ultimo_error": self.ultimo_error,
        }


class Historizador:
    """Motor que escucha los tags y los vuelca a la BD por lotes."""

    def __init__(
        self,
        db_manager,
        store,
        intervalo_flush_s: float = 2.0,
        max_lote: int = 500,
    ) -> None:
        self._db = db_manager
        self._store = store
        self.intervalo_flush_s = intervalo_flush_s
        self.max_lote = max_lote

        self.grupos: Dict[str, GrupoHistorizacion] = {}
        # grupo_id -> filas pendientes de escribir
        self._buffer: Dict[str, List[dict]] = {}
        self._tarea: Optional[asyncio.Task] = None
        self._running = False
        self._loop: Optional[asyncio.AbstractEventLoop] = None

    # ================================================================== #
    # Ciclo de vida
    # ================================================================== #
    async def start(self, connection_manager) -> None:
        """Carga los grupos guardados y se engancha al flujo de tags."""
        self._loop = asyncio.get_running_loop()
        self._running = True

        for d in self._store.grupos_historicos():
            grupo = GrupoHistorizacion(**d)
            self.grupos[grupo.grupo_id] = grupo
            self._buffer[grupo.grupo_id] = []

        connection_manager.registrar_observador(self.on_mensaje)
        self._tarea = asyncio.create_task(self._bucle_flush())
        logger.info("Historizador iniciado con %d grupo(s).", len(self.grupos))

    async def stop(self) -> None:
        """Vuelca lo que quede en el buffer y se detiene."""
        self._running = False
        if self._tarea is not None:
            self._tarea.cancel()
            try:
                await self._tarea
            except asyncio.CancelledError:
                pass
        await self._volcar_todo()
        logger.info("Historizador detenido.")

    # ================================================================== #
    # Recepción de tags (se llama desde el broadcast: debe ser RÁPIDO)
    # ================================================================== #
    def on_mensaje(self, mensaje: dict) -> None:
        """
        Observador del ConnectionManager. Encola y vuelve: nada de I/O aquí.

        Solo interesan los mensajes de cambio de valor, que son los que traen
        el campo `tag` (los de control -snapshot, status- se ignoran).
        """
        tag = mensaje.get("tag")
        if not tag:
            return

        plc = mensaje.get("plc", "")
        clave = f"{plc}|{tag}"
        valor = mensaje.get("value")
        ahora = self._loop.time() if self._loop else 0.0

        for grupo in self.grupos.values():
            if not grupo.activo or not grupo.interesa(clave):
                continue
            if not grupo.debe_guardar(clave, valor, ahora):
                grupo.filas_descartadas += 1
                continue

            buf = self._buffer.setdefault(grupo.grupo_id, [])
            if len(buf) >= MAX_BUFFER:
                # Buffer lleno (BD caída): se tira la muestra más antigua.
                buf.pop(0)
                grupo.filas_descartadas += 1
            buf.append(self._fila(mensaje, plc, tag, valor))

    @staticmethod
    def _fila(mensaje: dict, plc: str, tag: str, valor: Any) -> dict:
        """
        Convierte un mensaje del WebSocket en una fila del histórico.

        Los booleanos van a `valor_num` como 0/1 para poder graficarlos y
        agregarlos igual que cualquier señal analógica.
        """
        valor_num: Optional[float] = None
        valor_texto: Optional[str] = None

        if isinstance(valor, bool):
            valor_num = 1.0 if valor else 0.0
        elif isinstance(valor, (int, float)):
            valor_num = float(valor)
        elif valor is not None:
            valor_texto = str(valor)[:1000]

        return {
            # Se prefiere la marca del PLC (source_ts): es cuándo ocurrió de
            # verdad, no cuándo lo recibió el backend.
            "ts": mensaje.get("source_ts") or mensaje.get("timestamp") or _ahora_iso(),
            "plc": plc[:120],
            "tag": tag[:400],
            "valor_num": valor_num,
            "valor_texto": valor_texto,
            "tipo": (mensaje.get("type") or "")[:40],
        }

    # ================================================================== #
    # Volcado por lotes
    # ================================================================== #
    async def _bucle_flush(self) -> None:
        """Vuelca el buffer cada `intervalo_flush_s` mientras el servicio corra."""
        while self._running:
            try:
                await asyncio.sleep(self.intervalo_flush_s)
                await self._volcar_todo()
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001
                logger.warning("Error en el bucle de volcado: %s", exc)

    async def _volcar_todo(self) -> None:
        for grupo_id in list(self._buffer.keys()):
            await self._volcar(grupo_id)

    async def _volcar(self, grupo_id: str) -> None:
        """
        Escribe las filas pendientes de un grupo en su tabla.

        Si la escritura falla (BD caída), las filas se devuelven al buffer para
        reintentarlas en el siguiente ciclo: no se pierden datos por un corte
        momentáneo de red.
        """
        grupo = self.grupos.get(grupo_id)
        buf = self._buffer.get(grupo_id)
        if grupo is None or not buf:
            return

        lote, self._buffer[grupo_id] = buf[:self.max_lote], buf[self.max_lote:]

        try:
            driver = await self._db._driver_de(grupo.db_id)

            # La tabla se crea sola la primera vez (y tras un fallo).
            if not grupo._tabla_lista:
                for ddl in driver.ddl_tabla_historico(grupo.tabla):
                    await driver._ejecutar_interno(ddl)
                grupo._tabla_lista = True
                logger.info("Tabla '%s' lista en '%s'.", grupo.tabla, grupo.db_id)

            await driver._ejecutar_interno(
                driver.sql_insert_historico(grupo.tabla), lote
            )
            grupo.filas_escritas += len(lote)
            grupo.ultima_escritura = _ahora_iso()
            grupo.ultimo_error = ""

        except Exception as exc:  # noqa: BLE001
            grupo.ultimo_error = str(exc)
            grupo._tabla_lista = False
            # Devolver el lote al principio del buffer para reintentar.
            pendientes = lote + self._buffer.get(grupo_id, [])
            self._buffer[grupo_id] = pendientes[-MAX_BUFFER:]
            logger.warning("No se pudo escribir el histórico de '%s': %s",
                           grupo_id, exc)

    # ================================================================== #
    # Gestión de grupos
    # ================================================================== #
    def alta_grupo(
        self,
        grupo_id: str,
        db_id: str,
        tags: List[str],
        tabla: str = "historico_tags",
        nombre: str = "",
        activo: bool = True,
        banda_muerta: float = 0.0,
        intervalo_min_ms: int = 0,
    ) -> dict:
        """Crea o actualiza un grupo de historización."""
        from app.db.sql_driver import _nombre_seguro

        grupo_id = (grupo_id or "").strip()
        if not grupo_id:
            return {"ok": False, "mensaje": "Indica un identificador (grupo_id)."}
        if db_id not in self._store.conexiones:
            return {"ok": False,
                    "mensaje": f"No existe la conexión '{db_id}'. Créala primero."}
        try:
            tabla = _nombre_seguro(tabla or "historico_tags")
        except ValueError as exc:
            return {"ok": False, "mensaje": str(exc)}

        grupo = GrupoHistorizacion(
            grupo_id=grupo_id, db_id=db_id, tags=tags or [], tabla=tabla,
            nombre=nombre, activo=activo, banda_muerta=banda_muerta,
            intervalo_min_ms=intervalo_min_ms,
        )
        # Conservar los contadores si el grupo ya existía.
        anterior = self.grupos.get(grupo_id)
        if anterior is not None:
            grupo.filas_escritas = anterior.filas_escritas
            grupo.filas_descartadas = anterior.filas_descartadas

        self.grupos[grupo_id] = grupo
        self._buffer.setdefault(grupo_id, [])
        self._store.guardar_grupo_historico(self._serializar(grupo))

        logger.info("Grupo de historización '%s' guardado (%d tag(s), tabla %s).",
                    grupo_id, len(grupo.tags), tabla)
        return {"ok": True, "grupo_id": grupo_id, "db_id": db_id, "tabla": tabla,
                "num_tags": len(grupo.tags),
                "mensaje": f"Grupo '{grupo_id}' guardado y "
                           f"{'activo' if activo else 'detenido'}."}

    async def baja_grupo(self, grupo_id: str) -> dict:
        """Vuelca lo pendiente y elimina el grupo (no borra la tabla)."""
        if grupo_id not in self.grupos:
            return {"ok": False, "mensaje": f"No existe el grupo '{grupo_id}'."}
        await self._volcar(grupo_id)
        del self.grupos[grupo_id]
        self._buffer.pop(grupo_id, None)
        self._store.borrar_grupo_historico(grupo_id)
        return {"ok": True, "grupo_id": grupo_id,
                "mensaje": f"Grupo '{grupo_id}' eliminado. "
                           f"Los datos ya guardados NO se borran."}

    def activar(self, grupo_id: str, activo: bool) -> dict:
        """Arranca o detiene la captura de un grupo, sin borrarlo."""
        grupo = self.grupos.get(grupo_id)
        if grupo is None:
            return {"ok": False, "mensaje": f"No existe el grupo '{grupo_id}'."}
        grupo.activo = activo
        self._store.guardar_grupo_historico(self._serializar(grupo))
        return {"ok": True, "grupo_id": grupo_id, "activo": activo,
                "mensaje": f"Grupo '{grupo_id}' "
                           f"{'activado' if activo else 'detenido'}."}

    @staticmethod
    def _serializar(grupo: GrupoHistorizacion) -> dict:
        """Campos que se persisten en disco (sin el estado en memoria)."""
        return {
            "grupo_id": grupo.grupo_id, "db_id": grupo.db_id,
            "tags": grupo.tags, "tabla": grupo.tabla, "nombre": grupo.nombre,
            "activo": grupo.activo, "banda_muerta": grupo.banda_muerta,
            "intervalo_min_ms": grupo.intervalo_min_ms,
        }

    def estado(self) -> dict:
        """Estado global, para GET /historian."""
        grupos = []
        for g in self.grupos.values():
            d = g.estado()
            d["en_buffer"] = len(self._buffer.get(g.grupo_id, []))
            grupos.append(d)
        return {
            "num_grupos": len(grupos),
            "activos": sum(1 for g in grupos if g["activo"]),
            "filas_escritas_total": sum(g["filas_escritas"] for g in grupos),
            "en_buffer_total": sum(g["en_buffer"] for g in grupos),
            "intervalo_flush_s": self.intervalo_flush_s,
            "grupos": grupos,
        }

    async def flush_ahora(self) -> dict:
        """Fuerza el volcado inmediato (útil para probar desde Swagger)."""
        antes = sum(len(b) for b in self._buffer.values())
        await self._volcar_todo()
        despues = sum(len(b) for b in self._buffer.values())
        return {"ok": True, "escritas": antes - despues, "pendientes": despues,
                "mensaje": f"{antes - despues} fila(s) volcada(s)."}

    # ================================================================== #
    # Lectura del histórico (atajo para los widgets de tendencia)
    # ================================================================== #
    async def leer(
        self,
        grupo_id: str,
        tag: Optional[str] = None,
        desde: Optional[str] = None,
        hasta: Optional[str] = None,
        limite: int = 1000,
    ) -> dict:
        """
        Lee el histórico de un grupo sin tener que registrar una consulta.

        Es un atajo para el widget de tendencia: como el esquema de la tabla lo
        controla el backend, se puede generar el SELECT de forma segura (los
        filtros van bindeados; el nombre de tabla se valida por lista blanca).
        """
        grupo = self.grupos.get(grupo_id)
        if grupo is None:
            return {"ok": False, "mensaje": f"No existe el grupo '{grupo_id}'."}

        condiciones = []
        parametros: Dict[str, Any] = {}
        if tag:
            condiciones.append("tag = :tag")
            parametros["tag"] = tag
        if desde:
            condiciones.append("ts >= :desde")
            parametros["desde"] = desde
        if hasta:
            condiciones.append("ts <= :hasta")
            parametros["hasta"] = hasta
        where = (" WHERE " + " AND ".join(condiciones)) if condiciones else ""

        sql = (
            f"SELECT ts, plc, tag, valor_num, valor_texto, tipo "
            f"FROM {grupo.tabla}{where} ORDER BY ts DESC"
        )
        try:
            driver = await self._db._driver_de(grupo.db_id)
            resultado = await driver.query(sql, parametros, limite)
        except Exception as exc:  # noqa: BLE001
            # Caso normal al empezar: la tabla aún no existe porque todavía no
            # se ha escrito nada. Se devuelve vacío en vez de un error feo,
            # así el widget pinta "sin datos" y no un mensaje de SQL.
            texto = str(exc).lower()
            if "no such table" in texto or "doesn't exist" in texto \
                    or "does not exist" in texto or "invalid object name" in texto:
                return {
                    "ok": True, "grupo_id": grupo_id, "tabla": grupo.tabla,
                    "columnas": ["ts", "plc", "tag", "valor_num",
                                 "valor_texto", "tipo"],
                    "filas": [], "num_filas": 0, "truncado": False, "ms": 0.0,
                    "mensaje": "Todavía no hay datos historizados en este grupo.",
                }
            return {"ok": False, "mensaje": f"Error leyendo el histórico: {exc}"}

        salida = {"ok": True, "grupo_id": grupo_id, "tabla": grupo.tabla}
        salida.update(resultado.to_dict())
        return salida
