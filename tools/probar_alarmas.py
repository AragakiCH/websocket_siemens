#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Prueba el motor de alarmas de punta a punta, contra una base SQLite de verdad.

    python tools/probar_alarmas.py

QUÉ COMPRUEBA
-------------
No la lógica de comparar números —eso son cuatro `if` y se ve leyéndolos—
sino las cinco cosas que de verdad rompen un motor de alarmas:

  1. FLANCOS.        Un valor que sigue por encima del límite genera UN evento,
                     no uno cada 100 ms. Es el fallo que llena la tabla con
                     cien mil filas en una tarde.
  2. BANDA MUERTA.   Un valor oscilando en el umbral no puede generar un
                     evento por oscilación.
  3. PENDIENTES.     Una alarma que se normaliza sola NO desaparece de la
                     lista hasta que alguien la reconoce.
  4. REINICIO.       Al arrancar con un evento abierto en la tabla, se adopta
                     en vez de crear un segundo.
  5. RECARGA.        Editar una regla no cierra en falso las alarmas activas.

Y lo que se añadió con las observaciones de planta sobre las alarmas:

  6. CONDICIÓN.      Cambiar la condición es un PATCH con ese único campo, y
                     tiene que aceptarse aunque el límite aún esté vacío. (El
                     editor se quedaba siempre en «Bit activo» por esto.)
  7. BIT INACTIVO.   La alarma que salta cuando el bit está a 0.
  8. PAPELERA.       Eliminar no borra: marca la fila, el motor deja de
                     vigilarla, su alarma activa se cierra y se puede
                     restaurar. Y una base de antes, sin esa columna, la
                     estrena sola al eliminar la primera.
  9. SILENCIAR.      Con la alarma activa, el evento no se queda colgado.
 10. QUIÉN.          El id de quien reconoció se traduce a su nombre.

POR QUÉ NO LEVANTA UVICORN
--------------------------
Los otros scripts de `tools/` arrancan el servidor y hablan por HTTP, porque
prueban ENDPOINTS. Aquí lo que se prueba es el motor, y el motor se alimenta
del flujo interno de tags: para meterle un valor por HTTP haría falta un PLC
de verdad o un endpoint falso que no debería existir en producción. En
proceso, `on_mensaje()` se llama directamente, que es exactamente lo que hace
el ConnectionManager.

NO TOCA NADA TUYO
-----------------
Base SQLite en una carpeta temporal y `PLC_DATOS_DIR` propio. Ni tu .env, ni
tus conexiones, ni tus PLCs.
"""
from __future__ import annotations

import asyncio
import os
import sys
import tempfile
from pathlib import Path

RAIZ = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(RAIZ))

TMP = Path(tempfile.mkdtemp(prefix="alarmas_"))
os.environ["PLC_DATOS_DIR"] = str(TMP / "datos")
# Sin esto, la carpeta temporal (vacia) dispara la migracion automatica
# de rutas.py y se trae aqui la configuracion de produccion entera:
# conexiones, contrasenas cifradas y la clave. "Aislado" tiene que
# significar aislado.
os.environ["PLC_MIGRAR_DATOS"] = "false"
os.environ["PLC_AI_ENABLED"] = "false"
os.environ["PLC_DISCOVERY_ENABLED"] = "false"

from app.config.settings import get_settings          # noqa: E402
from app.core.alarm_engine import MotorAlarmas        # noqa: E402
from app.core.crud_manager import CrudManager         # noqa: E402
from app.core.db_manager import DbManager             # noqa: E402
from app.db.provision import provisionar              # noqa: E402

FALLOS = 0


def ck(desc: str, cond: bool, extra: str = "") -> None:
    global FALLOS
    print(("  OK    " if cond else "  FALLA ") + desc + (f"   {extra}" if extra else ""))
    if not cond:
        FALLOS += 1


class ManagerFalso:
    """
    Un ConnectionManager mínimo: registra observadores y guarda lo difundido.

    Replica el contrato REAL, incluido que `broadcast` sea una corrutina y
    que los observadores se llamen de forma síncrona dentro de ella. Si el
    motor dependiera de algo más del manager, esto fallaría — que es
    justamente lo que se quiere saber.
    """

    def __init__(self) -> None:
        self.observadores = []
        self.difundido = []

    def registrar_observador(self, cb) -> None:
        self.observadores.append(cb)

    def quitar_observador(self, cb) -> None:
        if cb in self.observadores:
            self.observadores.remove(cb)

    async def broadcast(self, msg: dict) -> None:
        self.difundido.append(msg)

    def tipos(self):
        return [m.get("type") for m in self.difundido]


def valor(plc: str, tag: str, v):
    """Un mensaje de cambio de valor, con la forma exacta del WebSocket."""
    return {"type": "tag_update", "plc": plc, "tag": tag, "value": v,
            "source_ts": "2026-09-07T12:00:00+00:00"}


async def esperar_volcado(motor: MotorAlarmas) -> None:
    """
    Fuerza el volcado en vez de dormir 0.5 s por paso.

    Con `sleep()` la prueba tardaría medio minuto y, peor, sería intermitente
    en una máquina cargada: el fallo aparecería una de cada veinte veces y
    nadie sabría por qué.
    """
    await motor._volcar()


async def main() -> int:
    print(f"\nBase de pruebas: {TMP}\n")
    ruta_db = str(TMP / "alarmas.db")

    # ── Montaje ───────────────────────────────────────────────────
    r = await provisionar(motor="sqlite", base_datos=ruta_db, crear_esquema=True)
    ck("se crea el esquema HMI en SQLite", bool(r.get("ok")), str(r.get("mensaje", ""))[:60])

    settings = get_settings()
    db = DbManager()
    await db.start()
    alta = await db.alta_conexion(db_id="test", motor="sqlite", base_datos=ruta_db)
    ck("la conexión de pruebas queda dada de alta", bool(alta.get("ok")))

    crud = CrudManager(db, settings)
    manager = ManagerFalso()

    async def nueva_regla(**kw):
        base = {"nombre": "R", "texto": "Texto", "clase": "Error",
                "comparador": "bit", "bit_disparo": 0, "activo": 1}
        base.update(kw)
        res = await crud.crear("alarmas_def", base, db_id="test")
        return int(res["id"])

    # ── Reglas de prueba ──────────────────────────────────────────
    id_bit = await nueva_regla(nombre="Puerta abierta", texto="Puerta abierta",
                               clase="Critical", tag="PLC_1|DB1.puerta",
                               comparador="bit", bit_disparo=0)
    id_temp = await nueva_regla(nombre="Temp alta", texto="Temperatura alta",
                                clase="Error", tag="PLC_1|DB1.temp",
                                comparador=">", valor_limite=80, banda_muerta=2)
    id_off = await nueva_regla(nombre="Silenciada", texto="No debe saltar",
                               tag="PLC_1|DB1.otro", activo=0)
    await nueva_regla(nombre="Sin tag", texto="Nunca se evalúa", tag=None)

    motor = MotorAlarmas(crud, settings)
    motor.db_id = "test"
    await motor.start(manager)

    e = motor.estado()
    ck("carga las 4 reglas", e["reglas_total"] == 4, f"{e['reglas_total']}")
    ck("no vigila la silenciada ni la que no tiene tag",
       e["tags_vigilados"] == 2, f"tags={e['tags_vigilados']}")
    ck("cuenta las reglas sin tag para poder avisar",
       e["reglas_sin_tag"] == 1, f"{e['reglas_sin_tag']}")

    # ── 1 · FLANCOS ───────────────────────────────────────────────
    print("\n--- Flancos: un evento por disparo, no uno por lectura ---")
    for _ in range(5):
        motor.on_mensaje(valor("PLC_1", "DB1.puerta", True))
    await esperar_volcado(motor)

    d = await crud.listar("alarmas", db_id="test", limite=50)
    ck("cinco lecturas seguidas en True generan UN evento",
       d["total"] == 1, f"filas={d['total']}")
    ck("el evento se difunde por WebSocket",
       "alarma.activada" in manager.tipos())

    fila = d["filas"][0]
    ck("severidad 1 para una Critical", fila["severidad"] == 1, str(fila["severidad"]))
    ck("guarda el tag que la disparó", fila["tag"] == "PLC_1|DB1.puerta")
    ck("arranca en estado 'activa'", fila["estado"] == "activa")
    ck("el mensaje es el texto de la regla", fila["mensaje"] == "Puerta abierta")

    # Se apaga y se vuelve a encender: ahora SÍ son dos eventos.
    motor.on_mensaje(valor("PLC_1", "DB1.puerta", False))
    await esperar_volcado(motor)
    motor.on_mensaje(valor("PLC_1", "DB1.puerta", True))
    await esperar_volcado(motor)
    d = await crud.listar("alarmas", db_id="test", limite=50)
    ck("apagar y volver a encender sí genera un segundo evento",
       d["total"] == 2, f"filas={d['total']}")

    # ── 2 · BANDA MUERTA ──────────────────────────────────────────
    print("\n--- Banda muerta: oscilar en el umbral no genera ruido ---")
    antes = (await crud.listar("alarmas", db_id="test", limite=200))["total"]

    motor.on_mensaje(valor("PLC_1", "DB1.temp", 81))     # dispara
    await esperar_volcado(motor)
    # Oscilación típica alrededor de 80. Con banda 2 hay que bajar de 78.
    for v in (79.5, 80.5, 79.0, 80.2, 78.5, 79.9):
        motor.on_mensaje(valor("PLC_1", "DB1.temp", v))
    await esperar_volcado(motor)

    d = await crud.listar("alarmas", db_id="test", limite=200)
    ck("seis oscilaciones dentro de la banda no generan nada",
       d["total"] == antes + 1, f"esperado {antes+1}, hay {d['total']}")

    motor.on_mensaje(valor("PLC_1", "DB1.temp", 70))     # ahora sí normaliza
    await esperar_volcado(motor)
    d = await crud.listar("alarmas", db_id="test", filtros={"tag": "PLC_1|DB1.temp"},
                          limite=50)
    temp = d["filas"][0]
    ck("bajar de la banda sí la normaliza",
       bool(temp["ts_normalizacion"]), str(temp["estado"]))
    ck("la normalización se difunde", "alarma.normalizada" in manager.tipos())

    # ── 3 · PENDIENTES ────────────────────────────────────────────
    print("\n--- Pendiente = sin reconocer, no 'sigue activa' ---")
    pend = await motor.pendientes()
    ids = [f["id"] for f in pend]
    ck("la que se normalizó sola SIGUE pendiente",
       temp["id"] in ids,
       "si falla, el turno siguiente no se entera de que hubo un problema")
    ck("la más grave va primero",
       bool(pend) and pend[0]["severidad"] == 1, str(pend[0]["severidad"]) if pend else "-")

    await motor.reconocer(int(temp["id"]), usuario_id=None)
    pend2 = await motor.pendientes()
    ck("tras reconocerla, sale de pendientes",
       temp["id"] not in [f["id"] for f in pend2])
    ck("el reconocimiento se difunde", "alarma.reconocida" in manager.tipos())

    fila_t = (await crud.obtener("alarmas", int(temp["id"]), db_id="test"))["fila"]
    ck("normalizada + reconocida -> estado 'reconocida'",
       fila_t["estado"] == "reconocida", str(fila_t["estado"]))

    # Reconocer algo que SIGUE activo no debe decir que ya pasó.
    activa = [f for f in pend2 if not f["ts_normalizacion"]]
    if activa:
        await motor.reconocer(int(activa[0]["id"]))
        f2 = (await crud.obtener("alarmas", int(activa[0]["id"]), db_id="test"))["fila"]
        ck("reconocer una que sigue activa la deja en 'activa'",
           f2["estado"] == "activa", str(f2["estado"]))
        ck("...pero con marca de reconocimiento", bool(f2["ts_reconocimiento"]))

    # ── 4 · REINICIO ──────────────────────────────────────────────
    print("\n--- Reinicio: no duplicar el evento que quedó abierto ---")
    motor.on_mensaje(valor("PLC_1", "DB1.temp", 95))     # deja una abierta
    await esperar_volcado(motor)
    abiertas_antes = (await crud.listar("alarmas", db_id="test",
                                        filtros={"estado": "activa"},
                                        limite=50))["total"]
    await motor.stop()

    motor2 = MotorAlarmas(crud, settings)
    motor2.db_id = "test"
    manager2 = ManagerFalso()
    await motor2.start(manager2)

    total_antes = (await crud.listar("alarmas", db_id="test", limite=200))["total"]
    motor2.on_mensaje(valor("PLC_1", "DB1.temp", 96))    # sigue alta
    await esperar_volcado(motor2)
    total_despues = (await crud.listar("alarmas", db_id="test", limite=200))["total"]
    ck("al reiniciar NO crea un segundo evento para la misma alarma",
       total_despues == total_antes,
       f"antes {total_antes}, después {total_despues}")
    ck("adopta el evento abierto que había",
       motor2.reglas[id_temp].evento_id is not None)

    motor2.on_mensaje(valor("PLC_1", "DB1.temp", 60))    # y puede cerrarlo
    await esperar_volcado(motor2)
    cerradas = (await crud.listar("alarmas", db_id="test",
                                  filtros={"estado": "activa"}, limite=50))["total"]
    ck("el evento adoptado se puede normalizar",
       cerradas < abiertas_antes, f"activas ahora {cerradas}")

    # ── 5 · RECARGA ───────────────────────────────────────────────
    print("\n--- Recargar reglas no cierra en falso las activas ---")
    motor2.on_mensaje(valor("PLC_1", "DB1.temp", 99))
    await esperar_volcado(motor2)
    evento = motor2.reglas[id_temp].evento_id
    ck("hay una alarma abierta antes de recargar", evento is not None)

    await crud.actualizar("alarmas_def", id_temp,
                          {"texto": "Temperatura MUY alta"}, db_id="test")
    await motor2.recargar()

    ck("tras editar el texto, la alarma sigue abierta",
       motor2.reglas[id_temp].evento_id == evento,
       "si falla, editar una alarma cerraría todas las activas de la planta")
    ck("y sigue marcada como disparada", motor2.reglas[id_temp].disparada)
    ck("el texto nuevo sí se aplicó",
       motor2.reglas[id_temp].texto == "Temperatura MUY alta")

    # ── Silenciada ────────────────────────────────────────────────
    print("\n--- Una regla con activo=0 no se evalúa ---")
    antes = (await crud.listar("alarmas", db_id="test", limite=200))["total"]
    for _ in range(3):
        motor2.on_mensaje(valor("PLC_1", "DB1.otro", True))
    await esperar_volcado(motor2)
    d = await crud.listar("alarmas", db_id="test", limite=200)
    ck("la silenciada no escribe nada", d["total"] == antes,
       f"id={id_off}")

    async def total_eventos() -> int:
        return (await crud.listar("alarmas", db_id="test", limite=1))["total"]

    async def evento(id_evento: int) -> dict:
        return (await crud.obtener("alarmas", id_evento, db_id="test"))["fila"]

    # ── 6 · LA CONDICIÓN SE PUEDE CAMBIAR ─────────────────────────
    #
    # El editor manda cada celda por separado: primero llega el comparador,
    # solo, y el límite se escribe después. Antes ese primer PATCH se
    # rechazaba siempre («hace falta valor_limite»), la celda volvía a «Bit
    # activo» y no había forma de configurar una alarma analógica.
    print("\n--- La condición se puede cambiar, un campo cada vez ---")
    id_cond = await nueva_regla(nombre="Nivel", texto="Nivel alto",
                                tag="PLC_1|DB1.nivel")
    motivo = ""
    try:
        await crud.actualizar("alarmas_def", id_cond, {"comparador": ">"},
                              db_id="test")
    except Exception as exc:  # noqa: BLE001
        motivo = str(exc)
    ck("pasar de «Bit activo» a «Mayor que» sin mandar el límite se acepta",
       not motivo, motivo[:70])
    guardada = (await crud.obtener("alarmas_def", id_cond, db_id="test"))["fila"]
    ck("y queda guardado así", guardada["comparador"] == ">",
       str(guardada["comparador"]))

    await motor2.recargar()
    motor2.on_mensaje(valor("PLC_1", "DB1.nivel", 999))
    await esperar_volcado(motor2)
    ck("sin límite todavía, la analógica ni salta ni rompe nada",
       motor2.reglas[id_cond].evento_id is None)

    await crud.actualizar("alarmas_def", id_cond, {"valor_limite": 50},
                          db_id="test")
    await motor2.recargar()
    motor2.on_mensaje(valor("PLC_1", "DB1.nivel", 51))
    await esperar_volcado(motor2)
    ck("en cuanto tiene límite, salta",
       motor2.reglas[id_cond].evento_id is not None)

    rechazado = False
    try:
        await crud.actualizar("alarmas_def", id_cond, {"comparador": "casi"},
                              db_id="test")
    except Exception:  # noqa: BLE001
        rechazado = True
    ck("un comparador que no existe se sigue rechazando", rechazado)

    # ── 7 · BIT INACTIVO ──────────────────────────────────────────
    print("\n--- «Bit inactivo»: la alarma de la señal que falta ---")
    id_marcha = await nueva_regla(nombre="Sin marcha",
                                  texto="Falta la señal de marcha",
                                  tag="PLC_1|DB1.marcha", comparador="!bit")
    id_palabra = await nueva_regla(nombre="Permisivo 3",
                                   texto="Se cayó el permisivo 3",
                                   tag="PLC_1|DB1.estado", comparador="!bit",
                                   bit_disparo=3)
    id_bool5 = await nueva_regla(nombre="Bool con bit 5",
                                 texto="Un Bool no tiene bit 5",
                                 tag="PLC_1|DB1.bool5", comparador="bit",
                                 bit_disparo=5)
    await motor2.recargar()

    antes = await total_eventos()
    motor2.on_mensaje(valor("PLC_1", "DB1.marcha", True))
    await esperar_volcado(motor2)
    ck("con el bit a 1 no salta", await total_eventos() == antes)

    motor2.on_mensaje(valor("PLC_1", "DB1.marcha", False))
    await esperar_volcado(motor2)
    ck("con el bit a 0, salta", motor2.reglas[id_marcha].evento_id is not None)

    ev_marcha = motor2.reglas[id_marcha].evento_id
    motor2.on_mensaje(valor("PLC_1", "DB1.marcha", True))
    await esperar_volcado(motor2)
    ck("y al volver a 1 se normaliza",
       ev_marcha is not None and bool((await evento(ev_marcha))["ts_normalizacion"]))

    # En una palabra de estado se mira el bit que se configuró, no el 0.
    motor2.on_mensaje(valor("PLC_1", "DB1.estado", 0b1000))
    await esperar_volcado(motor2)
    ck("palabra con el bit 3 a 1: no salta",
       motor2.reglas[id_palabra].evento_id is None)
    motor2.on_mensaje(valor("PLC_1", "DB1.estado", 0b0111))
    await esperar_volcado(motor2)
    ck("palabra con el bit 3 a 0 (y los demás a 1): salta",
       motor2.reglas[id_palabra].evento_id is not None)

    # Un Bool es UN bit. Antes, con `bit_disparo` distinto de 0 no saltaba
    # nunca; y con «Bit inactivo» habría estado encendida para siempre.
    motor2.on_mensaje(valor("PLC_1", "DB1.bool5", True))
    await esperar_volcado(motor2)
    ck("un Bool salta aunque la regla tenga apuntado otro bit",
       motor2.reglas[id_bool5].evento_id is not None)

    # ── 8 · PAPELERA ──────────────────────────────────────────────
    print("\n--- Papelera: eliminar no borra, y se puede restaurar ---")
    id_pap = await nueva_regla(nombre="Va a la papelera",
                               texto="Se elimina estando activa",
                               clase="Warning", tag="PLC_1|DB1.pap")
    await motor2.recargar()
    motor2.on_mensaje(valor("PLC_1", "DB1.pap", True))
    await esperar_volcado(motor2)
    ev_pap = motor2.reglas[id_pap].evento_id
    ck("la regla tiene su alarma activa antes de eliminarla", ev_pap is not None)
    reglas_antes = motor2.estado()["reglas_total"]

    r = await crud.cambiar_papelera("alarmas_def", id_pap, True, db_id="test")
    ck("eliminar marca la fecha y NO borra la fila",
       bool(r["fila"].get("eliminado_en")), str(r["fila"].get("eliminado_en")))
    fecha_1 = r["fila"].get("eliminado_en")

    await motor2.recargar()
    await esperar_volcado(motor2)
    ck("el motor deja de tenerla cargada", id_pap not in motor2.reglas)
    ck("y deja de contarla entre sus reglas",
       motor2.estado()["reglas_total"] == reglas_antes - 1,
       f"antes {reglas_antes}, ahora {motor2.estado()['reglas_total']}")

    f_pap = await evento(int(ev_pap))
    ck("su alarma activa se cierra, no se queda en «Activa» para siempre",
       bool(f_pap["ts_normalizacion"]) and f_pap["estado"] == "normalizada",
       str(f_pap["estado"]))
    ck("el evento conserva el número de su alarma",
       f_pap["alarma_def_id"] == id_pap, str(f_pap["alarma_def_id"]))
    ck("y sigue PENDIENTE: nadie la había reconocido",
       ev_pap in [f["id"] for f in await motor2.pendientes()])

    antes = await total_eventos()
    for v in (False, True):
        motor2.on_mensaje(valor("PLC_1", "DB1.pap", v))
    await esperar_volcado(motor2)
    ck("eliminada, ya no genera eventos", await total_eventos() == antes)

    r2 = await crud.cambiar_papelera("alarmas_def", id_pap, True, db_id="test")
    ck("eliminarla otra vez conserva la fecha de la primera",
       r2["fila"].get("eliminado_en") == fecha_1)

    # La papelera NO se escribe con un PATCH: ese camino pide solo `Usuarios`
    # y sería un atajo para quitar alarmas sin el rol que exige borrarlas.
    try:
        await crud.actualizar(
            "alarmas_def", id_cond,
            {"eliminado_en": "2026-01-01T00:00:00+00:00"}, db_id="test")
    except Exception:  # noqa: BLE001
        pass
    intacta = (await crud.obtener("alarmas_def", id_cond, db_id="test"))["fila"]
    ck("un PATCH genérico no puede mandar una regla a la papelera",
       not intacta.get("eliminado_en"))

    r = await crud.cambiar_papelera("alarmas_def", id_pap, False, db_id="test")
    ck("restaurar le quita la fecha", not r["fila"].get("eliminado_en"))
    await motor2.recargar()
    ck("y el motor vuelve a vigilarla", id_pap in motor2.reglas)

    motor2.on_mensaje(valor("PLC_1", "DB1.pap", True))
    await esperar_volcado(motor2)
    ck("restaurada con la condición cumpliéndose, abre un evento NUEVO",
       motor2.reglas[id_pap].evento_id not in (None, ev_pap),
       f"antes {ev_pap}, ahora {motor2.reglas[id_pap].evento_id}")

    no_existe = False
    try:
        await crud.cambiar_papelera("alarmas_def", 987654, True, db_id="test")
    except Exception as exc:  # noqa: BLE001
        no_existe = getattr(exc, "codigo", 0) == 404
    ck("eliminar una regla que no existe es un 404, no un acierto", no_existe)

    # Una base creada ANTES de que existiera la papelera no tiene la columna.
    # Tiene que seguir leyéndose igual, y estrenarla sola al eliminar.
    ruta_vieja = str(TMP / "antigua.db")
    await provisionar(motor="sqlite", base_datos=ruta_vieja, crear_esquema=True)
    await db.alta_conexion(db_id="antigua", motor="sqlite", base_datos=ruta_vieja)
    antigua = await db._driver_de("antigua")
    # Se le quita la columna para dejarla como estaba una base de entonces.
    # (`DROP COLUMN` existe en SQLite desde la 3.35, de 2021.)
    await antigua._ejecutar_interno(
        "ALTER TABLE alarmas_def DROP COLUMN eliminado_en")
    crud_ant = CrudManager(db, settings)
    id_ant = int((await crud_ant.crear(
        "alarmas_def", {"nombre": "De antes", "texto": "Regla de una base antigua",
                        "clase": "Error", "comparador": "bit", "activo": 1},
        db_id="antigua"))["id"])
    lista = await crud_ant.listar("alarmas_def", db_id="antigua")
    ck("una base sin la columna de la papelera se sigue leyendo",
       lista["total"] == 1 and "eliminado_en" not in lista["filas"][0])
    r = await crud_ant.cambiar_papelera("alarmas_def", id_ant, True,
                                        db_id="antigua")
    ck("y al eliminar la primera, la columna se añade sola",
       bool(r["fila"].get("eliminado_en")))

    # Y la que NO puede estrenarla: el HMI conectado con un usuario de solo
    # datos (lo normal en SQL Server) no tiene permiso de ALTER. Tiene que
    # decirlo con la sentencia exacta, no con un error genérico.
    await antigua._ejecutar_interno(
        "ALTER TABLE alarmas_def DROP COLUMN eliminado_en")
    crud_sin = CrudManager(db, settings)
    ejecutar_de_verdad = antigua._ejecutar_interno

    async def sin_permiso(sql, parametros=None):
        if sql.lstrip().upper().startswith("ALTER"):
            raise RuntimeError("ALTER TABLE permission denied")
        return await ejecutar_de_verdad(sql, parametros)

    antigua._ejecutar_interno = sin_permiso
    aviso = None
    try:
        await crud_sin.cambiar_papelera("alarmas_def", id_ant, True,
                                        db_id="antigua")
    except Exception as exc:  # noqa: BLE001
        aviso = exc
    antigua._ejecutar_interno = ejecutar_de_verdad
    ck("sin permiso para añadirla, no se pierde nada: avisa (409)",
       getattr(aviso, "codigo", 0) == 409, type(aviso).__name__)
    ck("y el aviso trae la sentencia exacta que la crea",
       "ALTER TABLE alarmas_def ADD" in getattr(aviso, "sql", "")
       and "eliminado_en" in getattr(aviso, "sql", ""),
       getattr(aviso, "sql", ""))
    sigue = await crud_sin.listar("alarmas_def", db_id="antigua")
    ck("la regla sigue donde estaba, sin tocar", sigue["total"] == 1)

    # ── 9 · SILENCIAR CON LA ALARMA ACTIVA ────────────────────────
    print("\n--- Silenciar una regla con su alarma activa ---")
    id_sil = await nueva_regla(nombre="Se silencia activa",
                               texto="Se silencia estando activa",
                               tag="PLC_1|DB1.sil")
    await motor2.recargar()
    motor2.on_mensaje(valor("PLC_1", "DB1.sil", True))
    await esperar_volcado(motor2)
    ev_sil = motor2.reglas[id_sil].evento_id

    await crud.actualizar("alarmas_def", id_sil, {"activo": 0}, db_id="test")
    await motor2.recargar()
    await esperar_volcado(motor2)
    ck("el evento se cierra en vez de quedarse colgado",
       ev_sil is not None and bool((await evento(int(ev_sil)))["ts_normalizacion"]))

    await crud.actualizar("alarmas_def", id_sil, {"activo": 1}, db_id="test")
    await motor2.recargar()
    motor2.on_mensaje(valor("PLC_1", "DB1.sil", True))
    await esperar_volcado(motor2)
    ck("al reactivarla con la condición cumpliéndose abre uno nuevo",
       motor2.reglas[id_sil].evento_id not in (None, ev_sil))

    # Una recarga justo mientras se escribe el evento (el editor guarda en
    # ese instante) cambia los objetos de las reglas por otros nuevos. El
    # evento recién abierto no puede quedarse apuntado en el objeto viejo.
    id_car = await nueva_regla(nombre="Recarga a destiempo",
                               texto="Se recarga mientras se escribe",
                               tag="PLC_1|DB1.car")
    await motor2.recargar()
    crear_de_verdad = crud.crear

    async def crear_y_recargar(recurso, datos, **kw):
        res = await crear_de_verdad(recurso, datos, **kw)
        if recurso == "alarmas":
            await motor2.recargar()
        return res

    crud.crear = crear_y_recargar
    motor2.on_mensaje(valor("PLC_1", "DB1.car", True))
    await esperar_volcado(motor2)
    crud.crear = crear_de_verdad
    ev_car = motor2.reglas[id_car].evento_id
    ck("recargar mientras se escribe no pierde el evento recién abierto",
       ev_car is not None)
    motor2.on_mensaje(valor("PLC_1", "DB1.car", False))
    await esperar_volcado(motor2)
    ck("...así que después sí se puede normalizar",
       ev_car is not None and bool((await evento(int(ev_car)))["ts_normalizacion"]))

    # ── 10 · QUIÉN LA RECONOCIÓ, CON NOMBRE ───────────────────────
    print("\n--- La columna «Usuario»: un nombre, no un número ---")
    from app.api.alarm_routes import nombres_de_usuarios  # noqa: E402

    principal = await db._driver_de("test")
    id_ana = int(await principal.insertar("usuarios", {
        "usuario": "ana", "password_hash": "no-es-un-hash",
        "categoria": "Usuarios", "estado": "Activo"}))
    await motor2.reconocer(int(ev_pap), usuario_id=id_ana)
    f_pap = await evento(int(ev_pap))
    ck("reconocer deja apuntado quién fue", f_pap["usuario_id"] == id_ana,
       str(f_pap["usuario_id"]))
    nombres = await nombres_de_usuarios(crud, "usuarios", "test",
                                        [id_ana, 987654])
    ck("ese id se traduce a su nombre", nombres == {id_ana: "ana"}, str(nombres))
    sin_tabla = await nombres_de_usuarios(crud, "no_existe", "test", [id_ana])
    ck("si los nombres no se pueden leer, no se rompe la lista", sin_tabla == {})

    # ── Cierre ────────────────────────────────────────────────────
    await motor2.stop()
    await db.stop()

    print(f"\n{'=' * 58}")
    if FALLOS:
        print(f"  {FALLOS} comprobación(es) FALLARON")
    else:
        print("  Todo correcto: el motor de alarmas funciona de punta a punta.")
    print(f"{'=' * 58}\n")
    return 1 if FALLOS else 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
