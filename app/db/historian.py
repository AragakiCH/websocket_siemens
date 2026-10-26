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
nunca el usuario. Y el historizador NO crea tablas: la tabla destino debe
existir ya (se crea con `sql/esquema_hmi_*.sql`). Este servicio escribe
datos, no altera la estructura de la base de datos. Los widgets no tienen forma de llegar a este camino: sus
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

from app.db.sql_driver import a_utc, tipos_motor, ts_local_para_motor, ts_para_motor

logger = logging.getLogger("historian")

# Límite duro del buffer en memoria. Si la BD está caída y el buffer se llena,
# se descartan las muestras MÁS ANTIGUAS: es preferible perder histórico viejo
# a que el servicio se quede sin memoria y tumbe también la vista en vivo.
MAX_BUFFER = 50_000

# Tope de tags en el filtro de `leer()`.
#
# No es una preferencia: cada tag es un parámetro bindeado, y los motores
# tienen un techo. SQL Server admite 2.100 parámetros por sentencia, y ahí
# entran también las fechas; pasarse no da un error que mencione los tags,
# da un fallo de driver que no orienta nada. Doscientas series en una sola
# consulta ya son un gráfico que nadie puede leer, así que este tope corta
# muy por debajo del problema — y cuando corta, se dice en la respuesta.
MAX_TAGS_FILTRO = 200

# Cada cuántos fallos IDÉNTICOS seguidos se vuelve a avisar.
#
# Un grupo que no puede escribir falla en cada ciclo, y a dos segundos por
# ciclo son 1.800 líneas por hora diciendo exactamente lo mismo. El log deja
# de servir: tapa cualquier otra cosa que esté pasando, que es justo lo que se
# necesita mirar cuando algo va mal. Se avisa la primera vez y luego cada N
# intentos, con la cuenta — que es el dato que de verdad falta en la línea
# repetida.
RECORDATORIO_FALLOS = 30

# Modos de captura de un grupo (ver GrupoHistorizacion.__init__).
MODO_MUESTREO = "muestreo"
MODO_CAMBIOS = "cambios"
# Periodo de muestreo por defecto y mínimo. Por debajo de 100 ms el PLC no
# publica más deprisa (publishing interval del servidor OPC UA), así que
# solo saldrían filas repetidas con la misma lectura.
PERIODO_MS_DEFECTO = 1000
PERIODO_MS_MINIMO = 100


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
        modo: str = MODO_MUESTREO,
        periodo_ms: int = PERIODO_MS_DEFECTO,
    ) -> None:
        self.grupo_id = grupo_id
        self.db_id = db_id
        # Claves "plc|tag" (el mismo formato que usa el WebSocket).
        self.tags = list(tags)
        self.tabla = tabla
        self.nombre = nombre or grupo_id
        self.activo = activo
        # --- Cómo se captura ----------------------------------------------
        # `muestreo` (por defecto): cada `periodo_ms` se guarda el valor
        #   ACTUAL de todos los tags del grupo, cambien o no. Es lo que da un
        #   histórico continuo: una consigna que lleva una hora quieta tiene
        #   una fila por periodo, igual que la temperatura que se mueve.
        # `cambios`: el comportamiento antiguo. Solo cuando el PLC publica un
        #   cambio. Ahorra filas, pero un tag estático se guarda UNA vez (su
        #   valor inicial) y después desaparece del histórico, que es justo
        #   lo que hacía pensar que se perdían datos.
        self.modo = modo if modo in (MODO_MUESTREO, MODO_CAMBIOS) else MODO_MUESTREO
        self.periodo_ms = max(PERIODO_MS_MINIMO, int(periodo_ms or PERIODO_MS_DEFECTO))
        # Cuándo se detuvo por última vez (ISO), para que la vista lo diga.
        self.detenido_en: str = ""
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
        # Fallos idénticos seguidos, para no repetir el mismo aviso en el log
        # y para poder decir "lleva 300 intentos" en vez de solo "falló".
        self.fallos_seguidos: int = 0
        self._error_reportado: str = ""
        self._tabla_lista = False
        # Mapa campo->columna real, resuelto al preparar la tabla.
        self._mapa: Dict[str, str] = {}

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
            "modo": self.modo,
            "periodo_ms": self.periodo_ms,
            "detenido_en": self.detenido_en,
            "filas_escritas": self.filas_escritas,
            "filas_descartadas": self.filas_descartadas,
            "ultima_escritura": self.ultima_escritura,
            "ultimo_error": self.ultimo_error,
            "fallos_seguidos": self.fallos_seguidos,
        }


class Historizador:
    """Motor que escucha los tags y los vuelca a la BD por lotes."""

    def __init__(
        self,
        db_manager,
        store,
        intervalo_flush_s: float = 2.0,
        max_lote: int = 500,
        plc_manager=None,
    ) -> None:
        self._db = db_manager
        self._store = store
        # De aquí sale el valor ACTUAL de cada tag para el modo `muestreo`
        # (`build_snapshot_message`). Sin él solo funciona el modo `cambios`.
        self._plc = plc_manager
        self.intervalo_flush_s = intervalo_flush_s
        self.max_lote = max_lote

        self.grupos: Dict[str, GrupoHistorizacion] = {}
        # grupo_id -> filas pendientes de escribir
        self._buffer: Dict[str, List[dict]] = {}
        # grupo_id -> tarea que lo muestrea (solo en modo `muestreo`)
        self._muestreadores: Dict[str, asyncio.Task] = {}
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
        for grupo in self.grupos.values():
            self._ajustar_muestreo(grupo)
        logger.info("Historizador iniciado con %d grupo(s).", len(self.grupos))

    async def stop(self) -> None:
        """Vuelca lo que quede en el buffer y se detiene."""
        self._running = False
        for grupo_id in list(self._muestreadores):
            self._parar_muestreo(grupo_id)
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
            # En modo `muestreo` las filas las pone el muestreador a su ritmo;
            # guardar además cada cambio duplicaría la señal.
            if grupo.modo == MODO_MUESTREO:
                continue
            if not grupo.debe_guardar(clave, valor, ahora):
                grupo.filas_descartadas += 1
                continue
            self._encolar(grupo, self._fila(mensaje, plc, tag, valor))

    def _encolar(self, grupo: GrupoHistorizacion, fila: dict) -> None:
        buf = self._buffer.setdefault(grupo.grupo_id, [])
        if len(buf) >= MAX_BUFFER:
            # Buffer lleno (BD caída): se tira la muestra más antigua.
            buf.pop(0)
            grupo.filas_descartadas += 1
        buf.append(fila)

    # ================================================================== #
    # Muestreo a periodo fijo (modo `muestreo`)
    # ================================================================== #
    def _ajustar_muestreo(self, grupo: GrupoHistorizacion) -> None:
        """
        Arranca o para el muestreador de un grupo según toque: corriendo,
        activo y en modo `muestreo` -> tarea; cualquier otra cosa -> sin tarea.
        Idempotente: se llama al crear, al activar/parar y al arrancar.
        """
        debe = (self._running and grupo.activo
                and grupo.modo == MODO_MUESTREO and self._plc is not None)
        tiene = grupo.grupo_id in self._muestreadores
        if debe and not tiene:
            self._muestreadores[grupo.grupo_id] = asyncio.create_task(
                self._bucle_muestreo(grupo.grupo_id))
        elif not debe and tiene:
            self._parar_muestreo(grupo.grupo_id)
        if grupo.activo and grupo.modo == MODO_MUESTREO and self._plc is None:
            logger.warning("Grupo '%s' en modo muestreo pero el historizador "
                           "no tiene PlcManager: no se muestreará nada.",
                           grupo.grupo_id)

    def _parar_muestreo(self, grupo_id: str) -> None:
        tarea = self._muestreadores.pop(grupo_id, None)
        if tarea is not None:
            tarea.cancel()

    async def _bucle_muestreo(self, grupo_id: str) -> None:
        """
        Una foto del grupo cada `periodo_ms`, alineada al periodo.

        Se mira `self.grupos` en cada vuelta y no se guarda el objeto: si
        alguien vuelve a guardar el grupo (POST /historian) el objeto cambia,
        y este bucle tiene que seguir al nuevo. Y comprueba `activo` en cada
        vuelta: un Stop lo cancela, pero si por lo que sea no llegara la
        cancelación, el bucle se apaga solo en la siguiente vuelta.
        """
        loop = asyncio.get_running_loop()
        siguiente = loop.time()
        try:
            while self._running:
                grupo = self.grupos.get(grupo_id)
                if grupo is None or not grupo.activo or grupo.modo != MODO_MUESTREO:
                    break
                try:
                    self._muestrear(grupo)
                except Exception as exc:  # noqa: BLE001
                    logger.warning("Grupo '%s': fallo al muestrear: %s",
                                   grupo_id, exc)
                periodo = grupo.periodo_ms / 1000.0
                siguiente += periodo
                espera = siguiente - loop.time()
                if espera < 0:
                    # Se quedó atrás (BD lenta, máquina ocupada): se realinea
                    # al siguiente periodo en vez de disparar varias seguidas.
                    siguiente = loop.time()
                    espera = 0.0
                await asyncio.sleep(espera)
        except asyncio.CancelledError:
            raise
        finally:
            if self._muestreadores.get(grupo_id) is asyncio.current_task():
                self._muestreadores.pop(grupo_id, None)

    def _muestrear(self, grupo: GrupoHistorizacion) -> int:
        """
        Toma el valor actual de cada tag del grupo y lo encola con la MISMA
        marca de tiempo: la del instante de la muestra, no la del último
        cambio del PLC (si no, las filas de un tag quieto saldrían todas con
        la misma hora y no servirían como serie temporal).

        Un tag sin valor (PLC desconectado, tag que aún no publicó) no genera
        fila: un NULL cada segundo no es un dato, es ruido; cuando el PLC
        vuelva, las muestras vuelven con él.
        """
        if self._plc is None:
            return 0
        snapshot = self._plc.build_snapshot_message()
        ts = _ahora_iso()
        n = 0
        for clave, entrada in (snapshot.get("tags") or {}).items():
            if not grupo.interesa(clave):
                continue
            valor = entrada.get("value")
            if valor is None:
                continue
            plc = entrada.get("plc") or clave.partition("|")[0]
            tag = entrada.get("tag") or clave.partition("|")[2]
            fila = self._fila(entrada, plc, tag, valor)
            fila["ts"] = ts
            self._encolar(grupo, fila)
            n += 1
        return n

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
            #
            # Se guarda tal cual (ISO 8601 con offset). La conversión al tipo
            # concreto de cada motor se hace justo antes del INSERT, en
            # `_volcar()`, porque solo allí se sabe qué motor hay detrás.
            "ts": mensaje.get("source_ts") or mensaje.get("timestamp") or _ahora_iso(),
            "plc": plc[:120],
            "tag": tag[:400],
            "valor_num": valor_num,
            "valor_texto": valor_texto,
            "tipo": (mensaje.get("type") or "")[:40],
            # Solo se escribe si la tabla destino tiene la columna (ver _mapa).
            # En Siemens es el Data Block; en Rexroth, el POU.
            "programa": (tag.split(".")[0] if "." in tag else "")[:200],
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

    async def _volcar(self, grupo_id: str, todo: bool = False) -> int:
        """
        Escribe las filas pendientes de un grupo en su tabla. Devuelve
        cuántas escribió (0 si falló).

        Si la escritura falla (BD caída), las filas se devuelven al buffer para
        reintentarlas en el siguiente ciclo: no se pierden datos por un corte
        momentáneo de red.

        `todo=True` ignora `max_lote` y escribe TODO lo pendiente de una vez:
        es lo que usa el Stop para que la tabla quede cerrada en el acto.
        """
        grupo = self.grupos.get(grupo_id)
        buf = self._buffer.get(grupo_id)
        if grupo is None or not buf:
            return 0

        corte = len(buf) if todo else self.max_lote
        lote, self._buffer[grupo_id] = buf[:corte], buf[corte:]

        try:
            driver = await self._db._driver_de(grupo.db_id)

            # La tabla NO se crea aquí: debe existir ya, creada con
            # `sql/esquema_hmi_*.sql`. Este servicio escribe datos, no altera
            # la estructura de la base de datos.
            if not grupo._tabla_lista:
                # Se leen las columnas REALES de la tabla destino, porque hay
                # dos válidas con nombres distintos: `historico_tags` (la que
                # crea el propio historizador, columna `plc`) y `plc_prg` (la
                # del esquema del HMI, columna `plc_id` y con `programa`).
                # Sin esto, apuntar el historizador a `plc_prg` fallaría en
                # cada volcado con "Invalid column name 'plc'".
                try:
                    columnas = [c["nombre"]
                                for c in await driver.listar_columnas(grupo.tabla)]
                except Exception as exc:  # noqa: BLE001
                    raise RuntimeError(
                        f"La tabla '{grupo.tabla}' no existe o no es "
                        f"accesible en la conexión '{grupo.db_id}'. Créala "
                        f"ejecutando sql/esquema_hmi_<motor>.sql en tu base "
                        f"de datos. Detalle: {exc}"
                    ) from exc

                if not columnas:
                    raise RuntimeError(
                        f"La tabla '{grupo.tabla}' no tiene columnas legibles. "
                        f"Comprueba que existe y que el usuario tiene permiso "
                        f"de lectura sobre ella.")

                grupo._mapa = driver.mapa_insert_historico(columnas)
                # Sin la columna del tag no hay nada que escribir.
                faltan = [c for c in ("ts", "tag") if c not in grupo._mapa]
                if faltan:
                    raise RuntimeError(
                        f"La tabla '{grupo.tabla}' no sirve como destino de "
                        f"histórico: le faltan las columnas {', '.join(faltan)}. "
                        f"Usa la tabla `plc_prg` del esquema del HMI.")
                grupo._tabla_lista = True
                logger.info("Tabla '%s' lista en '%s' (columnas: %s).",
                            grupo.tabla, grupo.db_id,
                            ", ".join(grupo._mapa.values()))

            # Normalizar las marcas de tiempo al tipo del motor, en la hora
            # del ALMACÉN (`PLC_HISTORICO_HORA`: la de la planta por defecto).
            # Se convierte aquí y no en el motor: MySQL reinterpretaría el
            # offset de la cadena ISO según el `time_zone` de su sesión.
            # `ts_local` solo se rellena si la tabla la tiene (esquemas
            # nuevos); con `ts` ya en hora local dice lo mismo.
            from app.config.settings import get_settings
            zona = get_settings().zona_horaria()
            for fila in lote:
                if "ts_local" in grupo._mapa:
                    fila["ts_local"] = ts_local_para_motor(fila["ts"], driver.motor, zona)
                fila["ts"] = ts_para_motor(fila["ts"], driver.motor)

            # Ajustar cada fila al mapa: se descartan los campos que la tabla
            # no tenga y se añaden los que espere y no vengan.
            lote_ajustado = [
                {campo: fila.get(campo) for campo in grupo._mapa}
                for fila in lote
            ]
            await driver._ejecutar_interno(
                driver.sql_insert_historico(grupo.tabla, grupo._mapa),
                lote_ajustado,
            )
            grupo.filas_escritas += len(lote)
            grupo.ultima_escritura = _ahora_iso()
            grupo.ultimo_error = ""
            if grupo.fallos_seguidos:
                logger.info("El histórico de '%s' volvió a escribir tras %d "
                            "intento(s) fallido(s).",
                            grupo_id, grupo.fallos_seguidos)
                grupo.fallos_seguidos = 0
                grupo._error_reportado = ""
            return len(lote)

        except Exception as exc:  # noqa: BLE001
            texto = str(exc)
            grupo.ultimo_error = texto
            grupo._tabla_lista = False
            # Devolver el lote al principio del buffer para reintentar.
            pendientes = lote + self._buffer.get(grupo_id, [])
            self._buffer[grupo_id] = pendientes[-MAX_BUFFER:]

            if texto != grupo._error_reportado:
                # Un error NUEVO siempre se cuenta: puede ser otra cosa.
                grupo.fallos_seguidos = 1
                grupo._error_reportado = texto
                logger.warning("No se pudo escribir el histórico de '%s': %s",
                               grupo_id, texto)
            else:
                grupo.fallos_seguidos += 1
                if grupo.fallos_seguidos % RECORDATORIO_FALLOS == 0:
                    logger.warning(
                        "El histórico de '%s' lleva %d intentos fallidos "
                        "seguidos con el mismo error: %s",
                        grupo_id, grupo.fallos_seguidos, texto)
            return 0

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
        modo: str = MODO_MUESTREO,
        periodo_ms: int = PERIODO_MS_DEFECTO,
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
            intervalo_min_ms=intervalo_min_ms, modo=modo, periodo_ms=periodo_ms,
        )
        # Conservar los contadores si el grupo ya existía.
        anterior = self.grupos.get(grupo_id)
        if anterior is not None:
            grupo.filas_escritas = anterior.filas_escritas
            grupo.filas_descartadas = anterior.filas_descartadas
            grupo.detenido_en = anterior.detenido_en

        self.grupos[grupo_id] = grupo
        self._buffer.setdefault(grupo_id, [])
        self._store.guardar_grupo_historico(self._serializar(grupo))
        # El muestreador sigue al grupo nuevo (lee `self.grupos` en cada
        # vuelta); si cambió el modo o el estado, se arranca o se para aquí.
        self._ajustar_muestreo(grupo)

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
        self._parar_muestreo(grupo_id)
        await self._volcar(grupo_id)
        del self.grupos[grupo_id]
        self._buffer.pop(grupo_id, None)
        self._store.borrar_grupo_historico(grupo_id)
        return {"ok": True, "grupo_id": grupo_id,
                "mensaje": f"Grupo '{grupo_id}' eliminado. "
                           f"Los datos ya guardados NO se borran."}

    async def activar(self, grupo_id: str, activo: bool) -> dict:
        """
        Arranca o detiene la captura de un grupo, sin borrarlo.

        AL PARAR, PARA DE VERDAD Y AHORA. Antes `activo = False` solo dejaba
        de ENCOLAR; lo que ya estaba en el buffer seguía escribiéndose a
        razón de un lote por ciclo (2 s), y con una base de datos lenta o un
        buffer grande eso eran filas apareciendo en la tabla durante minutos
        después del Stop. Ahora se cancela el muestreador, se vuelca de golpe
        TODO lo pendiente (sin límite de lote) y se contesta diciendo cuántas
        filas eran. Lo que no se pueda escribir en ese intento se descarta y
        se dice: un Stop que deja filas «para luego» no es un Stop.
        """
        grupo = self.grupos.get(grupo_id)
        if grupo is None:
            return {"ok": False, "mensaje": f"No existe el grupo '{grupo_id}'."}
        grupo.activo = activo
        if activo:
            grupo.detenido_en = ""
            self._store.guardar_grupo_historico(self._serializar(grupo))
            self._ajustar_muestreo(grupo)
            return {"ok": True, "grupo_id": grupo_id, "activo": True,
                    "modo": grupo.modo,
                    "mensaje": f"Grupo '{grupo_id}' activado "
                               f"({'cada ' + str(grupo.periodo_ms) + ' ms' if grupo.modo == MODO_MUESTREO else 'por cambios'})."}

        self._parar_muestreo(grupo_id)
        grupo.detenido_en = _ahora_iso()
        self._store.guardar_grupo_historico(self._serializar(grupo))
        pendientes = len(self._buffer.get(grupo_id) or [])
        escritas = 0
        if pendientes:
            escritas = await self._volcar(grupo_id, todo=True)
            sobrantes = len(self._buffer.get(grupo_id) or [])
            if sobrantes:
                grupo.filas_descartadas += sobrantes
                self._buffer[grupo_id] = []
        return {"ok": True, "grupo_id": grupo_id, "activo": False,
                "pendientes": pendientes, "escritas": escritas,
                "mensaje": f"Grupo '{grupo_id}' detenido. "
                           + (f"{escritas} fila(s) pendientes volcadas; "
                              if pendientes else "Sin filas pendientes; ")
                           + "no se guardará nada más hasta un Start."}

    @staticmethod
    def _serializar(grupo: GrupoHistorizacion) -> dict:
        """Campos que se persisten en disco (sin el estado en memoria)."""
        return {
            "grupo_id": grupo.grupo_id, "db_id": grupo.db_id,
            "tags": grupo.tags, "tabla": grupo.tabla, "nombre": grupo.nombre,
            "activo": grupo.activo, "banda_muerta": grupo.banda_muerta,
            "intervalo_min_ms": grupo.intervalo_min_ms,
            "modo": grupo.modo, "periodo_ms": grupo.periodo_ms,
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
        tags: Optional[List[str]] = None,
    ) -> dict:
        """
        Lee el histórico de un grupo sin tener que registrar una consulta.

        Es un atajo para el widget de tendencia: como el esquema de la tabla lo
        controla el backend, se puede generar el SELECT de forma segura (los
        filtros van bindeados; el nombre de tabla se valida por lista blanca).

        `tag` Y `tags` SON EL MISMO FILTRO CON DOS FORMAS
        ------------------------------------------------
        `tag` (uno) es el de siempre y no cambia. `tags` (varios) se añadió
        para la exportación a Excel del widget de tendencia, que necesita
        pedir EXACTAMENTE las series que dibuja.

        Sin él solo había dos caminos, y ninguno servía: mandar un tag —y
        exportar una línea de las cuatro que se ven— o no mandar ninguno —y
        exportar los veinte del grupo, con la mitad de las columnas hablando
        de otra cosa—.

        `tags` va el ÚLTIMO en la firma a propósito: las dos llamadas que ya
        existen pasan los cinco primeros POR POSICIÓN, así que colocarlo en
        medio habría cambiado en silencio el significado de `limite`.

        Si llegan los dos se unen, sin repetir y conservando el orden. Que
        `tag` siga existiendo no es deuda: es el caso frecuente, y un `=` es
        más barato que un `IN` de un solo elemento en cualquier motor.
        """
        grupo = self.grupos.get(grupo_id)
        if grupo is None:
            return {"ok": False, "mensaje": f"No existe el grupo '{grupo_id}'."}

        try:
            driver = await self._db._driver_de(grupo.db_id)
        except Exception as exc:  # noqa: BLE001
            return {"ok": False, "mensaje": f"Error leyendo el histórico: {exc}"}

        condiciones = []
        parametros: Dict[str, Any] = {}

        # Los dos filtros se unifican ANTES de tocar el SQL, para que de aquí
        # abajo dé igual por cuál vinieron. Se tiran los vacíos —una serie a
        # medio configurar en el widget llega como cadena vacía, y filtraría
        # por '' en vez de por nada— y los repetidos.
        pedidos: List[str] = [t for t in (tags or []) if t]
        if tag:
            pedidos.append(tag)
        vistos = set()
        filtro: List[str] = []
        for t in pedidos:
            if t not in vistos:
                vistos.add(t)
                filtro.append(t)
        recortado = len(filtro) > MAX_TAGS_FILTRO
        filtro = filtro[:MAX_TAGS_FILTRO]

        if len(filtro) == 1:
            condiciones.append("tag = :tag")
            parametros["tag"] = filtro[0]
        elif filtro:
            # CADA VALOR VA BINDEADO, uno por marca. Lo único que se arma con
            # texto son las marcas `:tag0, :tag1…`, que las genera este bucle
            # y no vienen de fuera. Meter los nombres en el SQL —aunque «solo
            # sean tags»— sería inyección directa: el widget los saca de la
            # configuración de la pantalla, y esa se puede importar de un
            # fichero que escribió cualquiera.
            marcas = []
            for i, t in enumerate(filtro):
                clave = f"tag{i}"
                marcas.append(f":{clave}")
                parametros[clave] = t
            condiciones.append(f"tag IN ({', '.join(marcas)})")

        # Los filtros de fecha se normalizan con la MISMA función que se usa al
        # escribir. Sin esto, en SQLite (donde `ts` es TEXT y la comparación es
        # lexicográfica) un filtro '2026-07-30T10:00' nunca casaría con un valor
        # guardado como '2026-07-30 10:00:00.000+00:00': el separador 'T' es
        # mayor que el espacio y el WHERE descartaría TODAS las filas.
        if desde:
            convertido = ts_para_motor(desde, driver.motor)
            if convertido is None:
                return {"ok": False,
                        "mensaje": f"Fecha 'desde' no válida: '{desde}'. "
                                   f"Usa ISO 8601, ej. 2026-07-30T10:00:00."}
            condiciones.append("ts >= :desde")
            parametros["desde"] = convertido
        if hasta:
            convertido = ts_para_motor(hasta, driver.motor)
            if convertido is None:
                return {"ok": False,
                        "mensaje": f"Fecha 'hasta' no válida: '{hasta}'. "
                                   f"Usa ISO 8601, ej. 2026-07-30T23:59:59."}
            condiciones.append("ts <= :hasta")
            parametros["hasta"] = convertido

        where = (" WHERE " + " AND ".join(condiciones)) if condiciones else ""

        # Las columnas se resuelven contra la tabla REAL, por el mismo motivo
        # que en la escritura: `historico_tags` usa `plc` y `plc_prg` usa
        # `plc_id`. Se emite siempre un alias `plc` para que el consumidor
        # (widget de tendencia, exportación a Excel) reciba el mismo formato
        # venga de la tabla que venga.
        if not grupo._mapa:
            try:
                columnas_reales = [
                    c["nombre"] for c in await driver.listar_columnas(grupo.tabla)]
                grupo._mapa = driver.mapa_insert_historico(columnas_reales)
            except Exception:  # noqa: BLE001
                grupo._mapa = driver.mapa_insert_historico()

        seleccion = []
        for campo in ("ts", "plc", "tag", "valor_num", "valor_texto", "tipo"):
            columna = grupo._mapa.get(campo)
            if columna is None:
                continue
            seleccion.append(columna if columna == campo
                             else f"{columna} AS {campo}")

        sql = (
            f"SELECT {', '.join(seleccion)} "
            f"FROM {grupo.tabla}{where} ORDER BY ts DESC"
        )
        try:
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
        # Por qué tags se filtró: lo pinta la hoja «Información» del Excel, y
        # sirve para explicar un resultado corto sin abrir el log.
        salida["tags_filtrados"] = list(filtro)
        if recortado:
            salida["aviso"] = (
                f"Se pidieron más de {MAX_TAGS_FILTRO} variables; se usaron "
                f"las {MAX_TAGS_FILTRO} primeras.")
        salida.update(resultado.to_dict())
        self._añadir_hora_local(salida)
        return salida

    # ------------------------------------------------------------------ #
    # Zona horaria de visualización
    # ------------------------------------------------------------------ #
    def _añadir_hora_local(self, salida: dict) -> None:
        """
        Añade `ts_local` a cada fila, convertido a la zona de `PLC_TIMEZONE`.

        `ts` se deja intacto y normalizado a UTC con 'Z' final, para que quede
        explícito en qué zona está: el problema clásico es una marca sin zona
        que cada quien interpreta como quiere.

        Los datos NO se tocan en la base: la conversión es solo de presentación.
        """
        from app.config.settings import get_settings

        zona = get_settings().zona_horaria()
        filas = salida.get("filas") or []
        for fila in filas:
            dt = a_utc(fila.get("ts"))
            if dt is None:
                fila["ts_local"] = None
                continue
            fila["ts"] = dt.isoformat().replace("+00:00", "Z")
            fila["ts_local"] = dt.astimezone(zona).isoformat()

        if filas and "ts_local" not in (salida.get("columnas") or []):
            salida.setdefault("columnas", []).append("ts_local")
        salida["timezone"] = str(zona)
