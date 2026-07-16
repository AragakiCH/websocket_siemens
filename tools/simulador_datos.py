# -*- coding: utf-8 -*-
"""
simulador_datos.py
==================
Escribe valores cambiantes en DB_snap7 del PLC (o PLCSim Advanced) vía OPC UA,
para ver el HMI moviéndose en tiempo real sin programar nada en TIA Portal.

Requisito: las variables del DB deben tener "Writable" activado (ya lo tienes).

Uso (con el venv activo, en OTRA terminal mientras corre el servidor):
    python tools\\simulador_datos.py
    python tools\\simulador_datos.py --endpoint opc.tcp://192.168.50.1:4840
"""
from __future__ import annotations

import argparse
import asyncio
import math

from asyncua import Client, ua

DB = "DB_snap7"
NAMESPACE = "http://www.siemens.com/simatic-s7-opcua"


async def main(endpoint: str, periodo: float) -> None:
    print(f"Conectando a {endpoint} ...")
    async with Client(url=endpoint) as client:
        idx = await client.get_namespace_index(NAMESPACE)
        base = f'ns={idx};s="{DB}"'

        contador = client.get_node(f'{base}."contador"')
        temperatura = client.get_node(f'{base}."temperatura"')
        presion = client.get_node(f'{base}."presion"')
        bomba_on = client.get_node(f'{base}."bomba_on"')
        mensaje = client.get_node(f'{base}."mensaje"')

        print("Conectado. Escribiendo valores cada "
              f"{periodo:.1f}s (Ctrl+C para parar)...")
        i = 0
        while True:
            i += 1
            # Señales "realistas": contador incremental, senoides y toggles.
            temp = 50.0 + 15.0 * math.sin(i * 0.25)          # 35..65 °C
            pres = 90.0 + 8.0 * math.cos(i * 0.15)           # 82..98 bar
            bomba = (i // 5) % 2 == 0                        # cambia cada 5 ciclos
            msg = "bomba ON" if bomba else "bomba OFF"

            await contador.write_value(
                ua.DataValue(ua.Variant(i % 32000, ua.VariantType.Int16)))
            await temperatura.write_value(
                ua.DataValue(ua.Variant(temp, ua.VariantType.Float)))
            await presion.write_value(
                ua.DataValue(ua.Variant(pres, ua.VariantType.Float)))
            await bomba_on.write_value(
                ua.DataValue(ua.Variant(bomba, ua.VariantType.Boolean)))
            await mensaje.write_value(
                ua.DataValue(ua.Variant(msg, ua.VariantType.String)))

            print(f"  ciclo {i}: temp={temp:.1f} pres={pres:.1f} "
                  f"bomba={'ON' if bomba else 'OFF'} contador={i % 32000}")
            await asyncio.sleep(periodo)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Simulador de datos DB_snap7")
    parser.add_argument("--endpoint", default="opc.tcp://192.168.50.1:4840")
    parser.add_argument("--periodo", type=float, default=1.0,
                        help="Segundos entre escrituras (defecto 1.0)")
    args = parser.parse_args()
    try:
        asyncio.run(main(args.endpoint, args.periodo))
    except KeyboardInterrupt:
        print("\nSimulador detenido.")
