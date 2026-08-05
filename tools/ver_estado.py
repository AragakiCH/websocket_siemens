# -*- coding: utf-8 -*-
"""
ver_estado.py
=============
Muestra de un vistazo si TODOS los PLCs dados de alta están conectados y
recibiendo datos. Útil cuando hay varias marcas a la vez (Siemens + Rexroth).

Se conecta al WebSocket del backend durante unos segundos y cuenta cuántos
cambios de valor llega de cada PLC: así se distingue "conectado" (sesión OPC UA
viva) de "recibiendo datos" (el PLC realmente publica cambios).

Uso (con el servidor corriendo, en otra terminal):
    python tools\\ver_estado.py
    python tools\\ver_estado.py --segundos 10 --host 192.168.1.50
"""
from __future__ import annotations

import argparse
import asyncio
import json
from collections import Counter
from urllib.request import urlopen


def _health(base: str) -> dict:
    with urlopen(f"{base}/health", timeout=5) as r:
        return json.loads(r.read())


async def _escuchar(base: str, segundos: float) -> Counter:
    """Cuenta los cambios de valor recibidos por PLC durante `segundos`."""
    try:
        import websockets  # type: ignore
    except ImportError:
        print("  (pip install websockets para medir el flujo en vivo)")
        return Counter()

    url = base.replace("http://", "ws://").replace("https://", "wss://") + "/ws"
    cuenta: Counter = Counter()
    try:
        async with websockets.connect(url) as ws:
            fin = asyncio.get_event_loop().time() + segundos
            while asyncio.get_event_loop().time() < fin:
                try:
                    restante = fin - asyncio.get_event_loop().time()
                    crudo = await asyncio.wait_for(ws.recv(), timeout=restante)
                except asyncio.TimeoutError:
                    break
                msg = json.loads(crudo)
                # Solo los cambios de valor traen 'tag'.
                if msg.get("tag"):
                    cuenta[msg.get("plc", "?")] += 1
    except Exception as exc:  # noqa: BLE001
        print(f"  (no se pudo escuchar el WebSocket: {exc})")
    return cuenta


async def main(base: str, segundos: float) -> None:
    salud = _health(base)

    print("=" * 68)
    print(f"  PLCs gestionados: {salud['num_plcs']}   "
          f"conectados: {salud['plcs_conectados']}   "
          f"clientes WS: {salud['clientes_ws']}")
    print("=" * 68)

    print(f"\nEscuchando el WebSocket {segundos:.0f} s para medir el flujo...\n")
    cuenta = await _escuchar(base, segundos)

    fila = "{:<20} {:<9} {:<13} {:>5} {:>8}  {}"
    print(fila.format("PLC", "MARCA", "ESTADO", "TAGS", "CAMBIOS", "DIAGNÓSTICO"))
    print("-" * 92)
    for p in salud["plcs"]:
        # La clave del id es 'plc' (ver SubscriptionHandler.health()).
        pid = p.get("plc") or p.get("plc_id") or "?"
        n = cuenta.get(pid, 0)
        if not p.get("conectado"):
            diag = "NO conectado: revisa IP / credenciales"
        elif n > 0:
            modo = p.get("modo_lectura", "")
            extra = f" [{modo}]" if modo and modo != "-" else ""
            diag = f"OK, recibiendo datos ({n / segundos:.1f}/s){extra}"
        else:
            diag = "conectado pero SIN cambios (¿valores estáticos en el PLC?)"
        print(fila.format(pid, p.get("vendor", "?"),
                          p.get("estado_conexion", "?"),
                          p.get("num_tags", 0), n, diag))
    print()


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="Estado de todos los PLCs")
    ap.add_argument("--host", default="localhost")
    ap.add_argument("--puerto", type=int, default=8000)
    ap.add_argument("--segundos", type=float, default=6.0)
    args = ap.parse_args()
    asyncio.run(main(f"http://{args.host}:{args.puerto}", args.segundos))
