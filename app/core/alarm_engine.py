# -*- coding: utf-8 -*-
"""
Motor de alarmas: lo que convierte una REGLA en un EVENTO.

QUÉ FALTABA
-----------
`alarmas_def` guardaba desde hace tiempo qué vigilar ("si DB1.temperatura pasa
de 80, es un Error y dice «Temperatura alta»") y `alarmas` tenía sitio para lo
que pasó. Entre las dos no había nadie: ningún proceso leía los valores del
PLC, los comparaba con las reglas y escribía la fila. Este módulo es ese nadie.

POR QUÉ EN EL BACKEND Y NO EN EL NAVEGADOR
------------------------------------------
Evaluar en el frontend habría sido mucho más corto: los valores ya llegan al
navegador por WebSocket. Y habría estado mal por tres motivos, en orden de
gravedad:

  1. Una alarma que solo salta cuando alguien está mirando NO es una alarma.
     El turno de noche cierra el navegador y el reactor se calienta sin que
     quede constancia de nada.
  2. Con tres PCs abiertos, los tres escribirían el mismo evento: el
     histórico tendría cada alarma por triplicado y "cuántas veces saltó" ya
     no se podría responder.
  3. El reloj del evento sería el del PC del operador, no el del servidor.

Aquí hay UN evaluador, en el mismo proceso que ya recibe los valores, y su
salida es la única versión de la verdad.

DE DÓNDE SALEN LOS VALORES
--------------------------
De `ConnectionManager.registrar_observador()`, el mismo gancho que usan el
historizador y el grabador. No abre una segunda sesión OPC UA ni añade una
sola lectura al PLC: se cuelga del flujo que ya existe.

El contrato de ese gancho es estricto y conviene repetirlo: el callback es
SÍNCRONO y se ejecuta dentro del bucle de difusión. Si bloquea, retrasa a
todos los clientes conectados. Por eso `on_mensaje()` aquí solo compara
números en memoria y encola; escribir en la base y difundir lo hace
`_bucle()`, en su propia tarea.

LA MÁQUINA DE ESTADOS
---------------------
Un evento de `alarmas` recorre como mucho tres estados:

    (la regla se cumple)  ─────────────► activa
    (el operador la reconoce) ─────────► reconocida
    (el valor vuelve a lo normal) ─────► normalizada

Las dos últimas transiciones son INDEPENDIENTES y pueden llegar en cualquier
orden. Eso lleva a la parte que más se equivoca la gente al implementar esto:

    UNA ALARMA QUE SE NORMALIZA SOLA NO DESAPARECE.

Si la temperatura sube, dispara y baja mientras nadie mira, el evento se
normaliza pero sigue PENDIENTE hasta que alguien lo reconozca. Es el
comportamiento de TIA y de cualquier HMI serio, y el motivo es evidente en
cuanto se piensa en el turno siguiente: si las alarmas transitorias se
borraran solas, la información de que hubo un problema se perdería justo en
el caso en el que nadie lo vio.

Por eso «pendiente» NO es `estado != 'normalizada'`, sino:

    ts_reconocimiento IS NULL

y `estado` guarda la última transición, que es otra pregunta distinta.

QUÉ NO HACE (todavía)
---------------------
  · Alarmas de comunicación ("se perdió el PLC"). La tabla las contempla
    (`tipo='comunicacion'`) y el sitio natural es `PlcManager`, no aquí.
  · Reconocimiento desde el PLC (`tag_reconocimiento`). La columna existe y
    se lee, pero nada la evalúa: haría falta escribir en el PLC.
  · Retardo de activación (un valor que pasa el límite medio segundo). La
    banda muerta cubre el caso frecuente (oscilación en el límite); un
    retardo temporal es otra cosa y no hay columna para él.
"""
from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

logger = logging.getLogger("alarm_engine")


# ====================================================================== #
# Constantes
# ====================================================================== #

#: Clase de TIA -> severidad numérica de la tabla `alarmas` (1 = más grave).
#: La tabla guarda un número porque ordenar y filtrar por gravedad con texto
#: obligaría a un CASE en cada consulta; la clase se conserva igualmente en
#: `alarmas_def`, así que no se pierde nada.
SEVERIDAD_DE_CLASE: Dict[str, int] = {
    "Critical": 1,
    "Error": 2,
    "Warning": 3,
    "Maintenance": 4,
    "Information": 5,
}
SEVERIDAD_POR_DEFECTO = 3

#: Cada cuánto se vuelca la cola de eventos a la base de datos.
#:
#: Corto a propósito, y mucho más que el del historizador (que agrupa miles de
#: muestras): una alarma que tarda dos segundos en aparecer en pantalla es una
#: alarma que llega tarde. Lo que se agrupa aquí no es volumen, es solo evitar
#: una transacción por evento cuando saltan quince a la vez.
INTERVALO_VOLCADO_S = 0.5

#: Tope de eventos en cola. Si la base está caída se descartan los más
#: ANTIGUOS: ante un desbordamiento, lo último que pasó importa más que lo
#: primero, porque es lo que describe la situación actual de la planta.
MAX_COLA = 2000

#: Cada cuánto se releen las reglas de `alarmas_def` por si alguien las editó.
#:
#: Hay recarga inmediata por API (`POST /alarmas/recargar`, que llama el
#: editor al guardar), así que esto es solo la red de seguridad para cuando
#: la regla se cambió desde otro sitio: SSMS, otra instancia, un script.
INTERVALO_RECARGA_S = 60.0


def _ahora() -> str:
    """Instante actual en ISO 8601 con offset UTC explícito."""
    return datetime.now(timezone.utc).isoformat()


# ====================================================================== #
# Una regla en memoria
# ====================================================================== #
@dataclass
class Regla:
    """
    Una fila de `alarmas_def` preparada para evaluarse muy rápido.

    Se guarda como objeto y no como diccionario porque `on_mensaje()` corre
    dentro del bucle de difusión y se ejecuta una vez por cada valor que llega
    de cada PLC: con veinte reglas y cincuenta tags a 100 ms son mil
    comparaciones por segundo. Los atributos de un dataclass se resuelven sin
    hashing; `fila["comparador"]` no.
    """
    id: int
    nombre: str
    texto: str
    clase: str
    tag: str                      # "<plc>|<tag>", tal cual está en la columna
    comparador: str               # bit | > | >= | < | <= | == | !=
    bit_disparo: int
    valor_limite: Optional[float]
    banda_muerta: float
    area: Optional[str]
    activo: bool

    #: Si la condición se cumplía en la evaluación anterior. Es lo que
    #: convierte una comparación en un FLANCO: sin esta memoria, un valor que
    #: sigue por encima del límite generaría un evento nuevo cada 100 ms.
    disparada: bool = False

    #: id del evento abierto en `alarmas`, si lo hay. Sirve para cerrarlo (o
    #: para no abrir un segundo) cuando la regla sigue disparada.
    evento_id: Optional[int] = None

    @property
    def severidad(self) -> int:
        return SEVERIDAD_DE_CLASE.get(self.clase, SEVERIDAD_POR_DEFECTO)


# ====================================================================== #
# Evaluación
# ====================================================================== #
def _a_numero(valor: Any) -> Optional[float]:
    """
    El valor del tag como número, o None si no se puede comparar.

    Los booleanos cuentan como 0/1 para que un `== 1` sobre un Bool funcione
    igual que sobre un Int: al operador le da lo mismo el tipo OPC, y el que
    configura la alarma no tiene por qué saberlo.
    """
    if isinstance(valor, bool):
        return 1.0 if valor else 0.0
    if isinstance(valor, (int, float)):
        return float(valor)
    if isinstance(valor, str):
        try:
            return float(valor.strip())
        except ValueError:
            return None
    return None


def _bit(valor: Any, indice: int) -> Optional[bool]:
    """
    El bit `indice` del valor, para las alarmas discretas de TIA.

    Un Bool se trata como una palabra de un solo bit: `bit_disparo = 0` es lo
    natural y es el valor por defecto de la columna, así que vigilar un Bool
    no obliga a configurar nada más.
    """
    if isinstance(valor, bool):
        return valor if indice == 0 else False
    if isinstance(valor, int):
        return bool((valor >> indice) & 1)
    if isinstance(valor, float) and valor.is_integer():
        return bool((int(valor) >> indice) & 1)
    return None


def evaluar(regla: Regla, valor: Any) -> Optional[bool]:
    """
    ¿Se cumple la condición de la regla con este valor?

    Devuelve None cuando NO SE PUEDE SABER: el tag trae texto y la regla
    compara números, o el límite está sin configurar. Es distinto de False, y
    la diferencia importa — un `None` deja el estado como estaba, mientras que
    un `False` normalizaría una alarma que quizá sigue activa. Ante la duda,
    no se toca nada.

    LA BANDA MUERTA SOLO SE APLICA PARA APAGAR
    ------------------------------------------
    Es histéresis, no tolerancia. Con `> 80` y banda 2:

        · para DISPARAR hace falta pasar de 80
        · para NORMALIZAR hay que bajar de 78

    Aplicarla también al disparar retrasaría la alarma (no saltaría hasta 82),
    que es justo lo contrario de lo que se quiere. Sin ella, un valor
    oscilando entre 79.9 y 80.1 genera cientos de eventos por minuto y llena
    el histórico de ruido hasta hacerlo inútil.
    """
    if regla.comparador == "bit":
        b = _bit(valor, regla.bit_disparo)
        return b  # None si el valor no es entero ni booleano

    n = _a_numero(valor)
    if n is None or regla.valor_limite is None:
        return None

    limite = float(regla.valor_limite)
    banda = abs(float(regla.banda_muerta or 0.0))
    c = regla.comparador

    # Umbral efectivo: mientras la alarma está disparada, el límite se
    # desplaza en contra para exigir un retorno claro.
    if regla.disparada and banda:
        if c in (">", ">="):
            limite -= banda
        elif c in ("<", "<="):
            limite += banda

    if c == ">":
        return n > limite
    if c == ">=":
        return n >= limite
    if c == "<":
        return n < limite
    if c == "<=":
        return n <= limite
    if c == "==":
        # La igualdad con banda muerta se lee como "dentro de ±banda". Con
        # números en coma flotante un `==` exacto no se cumple casi nunca:
        # un Real que vale 80 llega como 79.99999.
        return abs(n - limite) <= (banda or 1e-9)
    if c == "!=":
        return abs(n - limite) > (banda or 1e-9)
    return None


# ====================================================================== #
# El motor
# ====================================================================== #
@dataclass
class _Pendiente:
    """Un cambio de estado esperando a escribirse en la base."""
    accion: str                    # "abrir" | "normalizar"
    regla_id: int
    ts: str
    datos: Dict[str, Any] = field(default_factory=dict)


class MotorAlarmas:
    """
    Evalúa las reglas contra el flujo de tags y mantiene el estado en memoria.

    El estado vive en RAM y se persiste en `alarmas`. Al arrancar se releen
    los eventos abiertos para no duplicarlos tras un reinicio: sin eso,
    reiniciar el servicio con una alarma activa crearía un segundo evento y el
    primero se quedaría abierto para siempre.
    """

    def __init__(self, crud_manager, settings) -> None:
        self._crud = crud_manager
        self._settings = settings
        self._manager = None                       # ConnectionManager

        self.reglas: Dict[int, Regla] = {}
        #: Índice tag -> reglas. Es lo que hace que `on_mensaje()` no recorra
        #: la lista entera por cada valor: con 200 reglas y 5 que miran ese
        #: tag, se evalúan 5.
        self._por_tag: Dict[str, List[Regla]] = {}

        self._cola: List[_Pendiente] = []
        self._tarea: Optional[asyncio.Task] = None
        self._running = False
        self._loop: Optional[asyncio.AbstractEventLoop] = None

        #: En qué base están las alarmas. None = la de por defecto del CRUD.
        self.db_id: Optional[str] = getattr(settings, "alarmas_db_id", "") or None

        # Diagnóstico, para `GET /alarmas/estado`.
        self.eventos_abiertos = 0
        self.eventos_cerrados = 0
        self.ultimo_error = ""
        self.ultima_recarga = ""
        self.valores_vistos = 0

    # ------------------------------------------------------------------ #
    # Arranque y parada
    # ------------------------------------------------------------------ #
    async def start(self, connection_manager) -> None:
        self._manager = connection_manager
        self._loop = asyncio.get_running_loop()
        self._running = True

        # Se intenta cargar, pero un fallo NO impide arrancar: la base puede
        # estar caída y el servicio tiene que levantar igual. El bucle
        # reintenta cada `INTERVALO_RECARGA_S`.
        try:
            await self.recargar()
        except Exception as exc:  # noqa: BLE001
            self.ultimo_error = str(exc)
            logger.warning("No se pudieron cargar las reglas de alarma al "
                           "arrancar (se reintentará): %s", exc)

        connection_manager.registrar_observador(self.on_mensaje)
        self._tarea = asyncio.create_task(self._bucle())
        logger.info("Motor de alarmas iniciado (%d regla(s) activa(s)).",
                    sum(1 for r in self.reglas.values() if r.activo))

    async def stop(self) -> None:
        self._running = False
        if self._manager is not None:
            self._manager.quitar_observador(self.on_mensaje)
        if self._tarea is not None:
            self._tarea.cancel()
            try:
                await self._tarea
            except asyncio.CancelledError:
                pass
        # Un último volcado: los eventos encolados en el último medio segundo
        # se perderían al apagar, y son justo los del momento del apagado.
        await self._volcar()
        logger.info("Motor de alarmas detenido.")

    # ------------------------------------------------------------------ #
    # Carga de reglas
    # ------------------------------------------------------------------ #
    async def recargar(self) -> dict:
        """
        Relee `alarmas_def` y reconstruye el índice, CONSERVANDO el estado.

        Lo importante está en la última parte: si una alarma está disparada y
        alguien edita su texto, el evento abierto sigue siéndolo. Recargar sin
        conservar `disparada`/`evento_id` cerraría en falso todas las alarmas
        activas cada vez que alguien toca el editor.
        """
        datos = await self._crud.listar(
            "alarmas_def", db_id=self.db_id, orden="id",
            descendente=False, limite=1000,
        )
        antes = {r.id: r for r in self.reglas.values()}

        nuevas: Dict[int, Regla] = {}
        for fila in datos.get("filas", []):
            try:
                rid = int(fila["id"])
            except (KeyError, TypeError, ValueError):
                continue
            tag = (fila.get("tag") or "").strip()
            regla = Regla(
                id=rid,
                nombre=str(fila.get("nombre") or f"Alarma_{rid}"),
                texto=str(fila.get("texto") or ""),
                clase=str(fila.get("clase") or "Error"),
                tag=tag,
                comparador=str(fila.get("comparador") or "bit"),
                bit_disparo=int(fila.get("bit_disparo") or 0),
                valor_limite=(None if fila.get("valor_limite") is None
                              else float(fila["valor_limite"])),
                banda_muerta=float(fila.get("banda_muerta") or 0.0),
                area=fila.get("area"),
                activo=bool(fila.get("activo", 1)),
            )
            viejo = antes.get(rid)
            if viejo is not None:
                regla.disparada = viejo.disparada
                regla.evento_id = viejo.evento_id
            nuevas[rid] = regla

        self.reglas = nuevas
        self._reindexar()
        self.ultima_recarga = _ahora()

        # Reconciliar con lo que hay en la base: eventos abiertos de un
        # arranque anterior. Solo la primera vez (cuando no había nada en
        # memoria), porque en caliente la memoria es más fiable que la tabla.
        if not antes:
            await self._adoptar_eventos_abiertos()

        activas = sum(1 for r in nuevas.values() if r.activo)
        logger.info("Reglas de alarma recargadas: %d (%d activas, %d con tag).",
                    len(nuevas), activas,
                    sum(1 for r in nuevas.values() if r.tag))
        return {"reglas": len(nuevas), "activas": activas}

    def _reindexar(self) -> None:
        idx: Dict[str, List[Regla]] = {}
        for r in self.reglas.values():
            if not r.activo or not r.tag:
                continue
            idx.setdefault(r.tag, []).append(r)
        self._por_tag = idx

    async def _adoptar_eventos_abiertos(self) -> None:
        """
        Recupera los eventos que quedaron abiertos antes de un reinicio.

        Sin esto, reiniciar con una alarma activa deja el evento anterior
        colgado (nunca se normaliza) y crea uno nuevo al primer valor: el
        histórico acaba con una alarma abierta por reinicio.

        Se marca la regla como `disparada = True` A PROPÓSITO, aunque todavía
        no se haya recibido ningún valor: si la condición ya no se cumple, el
        primer valor que llegue la normalizará limpiamente. Al revés —asumir
        que está apagada— el evento viejo no se cerraría nunca.
        """
        try:
            datos = await self._crud.listar(
                "alarmas", db_id=self.db_id,
                filtros={"estado": "activa"},
                orden="id", descendente=True, limite=500,
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning("No se pudieron releer los eventos abiertos: %s", exc)
            return

        adoptados = 0
        for fila in datos.get("filas", []):
            rid = fila.get("alarma_def_id")
            if rid is None:
                continue
            regla = self.reglas.get(int(rid))
            if regla is None or regla.evento_id is not None:
                continue
            regla.evento_id = int(fila["id"])
            regla.disparada = True
            adoptados += 1
        if adoptados:
            logger.info("Se adoptaron %d evento(s) de alarma abiertos de "
                        "antes del reinicio.", adoptados)

    # ------------------------------------------------------------------ #
    # Recepción de valores  ·  SÍNCRONO Y RÁPIDO
    # ------------------------------------------------------------------ #
    def on_mensaje(self, mensaje: dict) -> None:
        """
        Observador del ConnectionManager: evalúa y encola. Nada de I/O.

        Corre dentro del bucle de difusión, así que aquí no se puede escribir
        en la base ni esperar a nada. Lo único que hace es comparar números y
        apuntar el flanco en una lista.
        """
        tag = mensaje.get("tag")
        if not tag:
            return                      # snapshot, status… no traen valor
        reglas = self._por_tag.get(f"{mensaje.get('plc', '')}|{tag}")
        if not reglas:
            return

        self.valores_vistos += 1
        valor = mensaje.get("value")
        # La marca del PLC, no la del backend: es cuándo ocurrió de verdad.
        ts = mensaje.get("source_ts") or mensaje.get("timestamp") or _ahora()

        for regla in reglas:
            resultado = evaluar(regla, valor)
            if resultado is None:
                continue                # no se puede decidir: no se toca nada
            if resultado and not regla.disparada:
                regla.disparada = True
                self._encolar(_Pendiente(
                    "abrir", regla.id, ts,
                    {"valor": _a_numero(valor)},
                ))
            elif not resultado and regla.disparada:
                regla.disparada = False
                self._encolar(_Pendiente(
                    "normalizar", regla.id, ts,
                    {"valor": _a_numero(valor)},
                ))

    def _encolar(self, p: _Pendiente) -> None:
        if len(self._cola) >= MAX_COLA:
            self._cola.pop(0)
        self._cola.append(p)

    # ------------------------------------------------------------------ #
    # Volcado y difusión
    # ------------------------------------------------------------------ #
    async def _bucle(self) -> None:
        ciclos = 0
        while self._running:
            try:
                await asyncio.sleep(INTERVALO_VOLCADO_S)
                await self._volcar()
                ciclos += 1
                # Red de seguridad por si las reglas cambiaron fuera de la
                # aplicación. El editor llama a `recargar()` al guardar, así
                # que en el uso normal esto no llega a notarse.
                if ciclos * INTERVALO_VOLCADO_S >= INTERVALO_RECARGA_S:
                    ciclos = 0
                    try:
                        await self.recargar()
                    except Exception as exc:  # noqa: BLE001
                        self.ultimo_error = str(exc)
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001
                self.ultimo_error = str(exc)
                logger.warning("Error en el bucle del motor de alarmas: %s", exc)

    async def _volcar(self) -> None:
        """
        Escribe los cambios encolados y avisa a los clientes.

        Si la escritura falla, el pendiente se devuelve a la cola: una base
        caída no debe perder alarmas. El estado en memoria (`disparada`) ya
        cambió, así que el flanco no se vuelve a detectar — es justo lo que se
        quiere: el evento se escribirá tarde, pero una sola vez.
        """
        if not self._cola:
            return
        lote, self._cola = self._cola, []

        for p in lote:
            regla = self.reglas.get(p.regla_id)
            if regla is None:
                continue                # la regla se borró mientras tanto
            try:
                if p.accion == "abrir":
                    await self._abrir(regla, p)
                else:
                    await self._normalizar(regla, p)
                self.ultimo_error = ""
            except Exception as exc:  # noqa: BLE001
                self.ultimo_error = str(exc)
                logger.warning("No se pudo registrar el evento de la alarma "
                               "'%s': %s", regla.nombre, exc)
                self._cola.insert(0, p)
                # Se corta el lote: si la base no responde, los siguientes
                # van a fallar igual y cada intento cuesta un timeout.
                break

    async def _abrir(self, regla: Regla, p: _Pendiente) -> None:
        """Crea la fila del evento y la difunde."""
        if regla.evento_id is not None:
            return                      # ya había uno abierto: no se duplica

        fila = {
            "alarma_def_id": regla.id,
            "tipo": "proceso",
            "area": regla.area,
            "severidad": regla.severidad,
            "mensaje": regla.texto or regla.nombre,
            "tag": regla.tag,
            "valor_disparo": p.datos.get("valor"),
            "estado": "activa",
            "ts_activacion": p.ts,
        }
        # `usuario_id` se deja fuera a propósito: no lo dispara una persona.
        # `CrudManager._sellar_autor()` con usuario_id=None quita cualquier
        # valor que viniera, así que la columna queda en NULL, que es la
        # verdad — y no atribuida a quien resultara estar conectado.
        res = await self._crud.crear("alarmas", fila, db_id=self.db_id)
        regla.evento_id = int(res.get("id") or 0) or None
        self.eventos_abiertos += 1

        logger.info("ALARMA [%s] %s · %s = %s",
                    regla.clase, regla.nombre, regla.tag,
                    p.datos.get("valor"))
        await self._difundir("alarma.activada", regla, p.ts,
                             valor=p.datos.get("valor"))

    async def _normalizar(self, regla: Regla, p: _Pendiente) -> None:
        """
        Marca el evento como normalizado. NO lo cierra para el operador.

        Ver la nota de la cabecera: mientras no esté reconocido sigue
        pendiente, y por eso el evento que se difunde lleva `pendiente`.
        """
        if regla.evento_id is None:
            return
        await self._crud.actualizar(
            "alarmas", regla.evento_id,
            {"estado": "normalizada", "ts_normalizacion": p.ts},
            db_id=self.db_id,
        )
        evento_id = regla.evento_id
        regla.evento_id = None
        self.eventos_cerrados += 1

        logger.info("NORMALIZADA %s · %s = %s",
                    regla.nombre, regla.tag, p.datos.get("valor"))
        await self._difundir("alarma.normalizada", regla, p.ts,
                             valor=p.datos.get("valor"), evento_id=evento_id)

    async def _difundir(self, tipo: str, regla: Regla, ts: str,
                        valor: Any = None,
                        evento_id: Optional[int] = None) -> None:
        """
        Avisa a los clientes por el WebSocket que ya tienen abierto.

        Se manda el evento COMPLETO, no un "algo cambió, vuelve a preguntar":
        con veinte alarmas saltando a la vez, veinte clientes pidiendo la
        lista entera son cuatrocientas consultas contra la base en un segundo.
        """
        if self._manager is None:
            return
        try:
            await self._manager.broadcast({
                "type": tipo,
                "alarma": {
                    "id": evento_id if evento_id is not None else regla.evento_id,
                    "def_id": regla.id,
                    "nombre": regla.nombre,
                    "mensaje": regla.texto or regla.nombre,
                    "clase": regla.clase,
                    "severidad": regla.severidad,
                    "area": regla.area,
                    "tag": regla.tag,
                    "valor": valor,
                    "ts": ts,
                },
            })
        except Exception as exc:  # noqa: BLE001
            logger.warning("No se pudo difundir el evento de alarma: %s", exc)

    # ------------------------------------------------------------------ #
    # Consultas y acciones desde la API
    # ------------------------------------------------------------------ #
    async def pendientes(self, limite: int = 200) -> List[dict]:
        """
        Lo que el operador tiene que ver: sin reconocer, lo más grave primero.

        Es una consulta a la BASE y no al estado en memoria, y la diferencia
        es la que hace que esto funcione: en memoria solo están las alarmas
        que siguen disparadas AHORA. Una que saltó de madrugada y se normalizó
        sola no estaría, y es exactamente la que hay que enseñarle al del
        turno de mañana.
        """
        datos = await self._crud.listar(
            "alarmas", db_id=self.db_id,
            orden="ts_activacion", descendente=True, limite=limite,
        )
        filas = [f for f in datos.get("filas", [])
                 if not f.get("ts_reconocimiento")]
        filas.sort(key=lambda f: (int(f.get("severidad") or 9),
                                  str(f.get("ts_activacion") or "")))
        return filas

    async def reconocer(self, evento_id: int,
                        usuario_id: Optional[int] = None) -> dict:
        """
        El operador se da por enterado.

        `usuario_id` NO viene del cliente: lo pone el router desde la sesión,
        igual que en el resto del CRUD. Firmar el reconocimiento de una alarma
        es justo el sitio donde no puede haber dudas de quién fue.
        """
        ts = _ahora()
        # Si sigue disparada se queda en 'activa' con la marca de
        # reconocimiento: decir 'reconocida' de algo que sigue ocurriendo
        # daría a entender que ya pasó.
        actual = await self._crud.obtener("alarmas", evento_id, db_id=self.db_id)
        fila = actual.get("fila") or {}
        sigue_activa = not fila.get("ts_normalizacion")

        await self._crud.actualizar(
            "alarmas", evento_id,
            {"ts_reconocimiento": ts,
             "estado": "activa" if sigue_activa else "reconocida"},
            db_id=self.db_id, usuario_id=usuario_id,
        )
        if self._manager is not None:
            await self._manager.broadcast({
                "type": "alarma.reconocida",
                "alarma": {"id": evento_id, "ts": ts,
                           "usuario_id": usuario_id},
            })
        return {"ok": True, "id": evento_id, "ts_reconocimiento": ts}

    async def reconocer_todas(self,
                              usuario_id: Optional[int] = None) -> dict:
        """Reconoce todo lo pendiente de una vez, tras una parada larga."""
        filas = await self.pendientes(limite=500)
        hechas = 0
        for f in filas:
            try:
                await self.reconocer(int(f["id"]), usuario_id)
                hechas += 1
            except Exception as exc:  # noqa: BLE001
                logger.warning("No se pudo reconocer la alarma %s: %s",
                               f.get("id"), exc)
        return {"ok": True, "reconocidas": hechas}

    def estado(self) -> dict:
        """Diagnóstico del motor, para la pantalla de configuración."""
        activas = [r for r in self.reglas.values() if r.activo]
        return {
            "reglas_total": len(self.reglas),
            "reglas_activas": len(activas),
            "reglas_sin_tag": sum(1 for r in activas if not r.tag),
            "disparadas_ahora": sum(1 for r in activas if r.disparada),
            "tags_vigilados": len(self._por_tag),
            "valores_evaluados": self.valores_vistos,
            "eventos_abiertos": self.eventos_abiertos,
            "eventos_cerrados": self.eventos_cerrados,
            "en_cola": len(self._cola),
            "ultima_recarga": self.ultima_recarga,
            "ultimo_error": self.ultimo_error,
            "db_id": self.db_id or "(la de por defecto)",
        }
