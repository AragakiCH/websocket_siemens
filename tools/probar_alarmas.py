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
