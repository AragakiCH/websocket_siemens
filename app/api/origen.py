# -*- coding: utf-8 -*-
"""
origen.py
=========
¿La petición viene del PROPIO equipo servidor, o de otro de la red?

PARA QUÉ SIRVE ESTA DISTINCIÓN
------------------------------
Psi Core se instala en dos papeles: un SERVIDOR, donde se trabaja y se guarda
todo, y VISORES, que muestran lo del servidor. Pero el visor no tiene frontend
propio: abre una ventana contra `http://SERVIDOR:8000/` y ve exactamente el
mismo HTML y el mismo JavaScript. No hay dos builds.

Así que "que el visor no pueda configurar la base de datos" no se puede
resolver empaquetando distinto, ni ocultando botones en el cliente: quien edite
la URL o llame a la API directamente se los salta.

Lo que sí distingue a los dos, sin depender de que el cliente colabore, es POR
DÓNDE ENTRA la petición. La ventana del propio servidor va por `127.0.0.1`; un
visor llega desde otra dirección de la red. Eso lo ve el servidor y no se puede
falsificar desde fuera.

LO QUE NO SE MIRA, Y POR QUÉ
----------------------------
NO se usan `X-Forwarded-For`, `X-Real-IP` ni `Forwarded`. Son cabeceras que
pone el cliente, y cualquiera puede mandar `X-Forwarded-For: 127.0.0.1` con
curl. Confiar en ellas convertiría este control en un adorno. Se usa solo
`request.client`, que es la dirección real del socket TCP.

La consecuencia de ignorarlas es que, detrás de un proxy inverso, TODO parecería
local. Psi Core se despliega sin proxy —uvicorn escucha directamente—, así que
hoy no aplica; si algún día se pone uno delante, hay que revisar este módulo, y
por eso está escrito aquí y no repartido por tres routers.
"""
from __future__ import annotations

import ipaddress
import logging
from typing import Optional

from fastapi import Request

logger = logging.getLogger("origen")


def ip_del_cliente(request: Request) -> str:
    """Dirección real del socket. Cadena vacía si no se puede determinar."""
    cliente = getattr(request, "client", None)
    return (getattr(cliente, "host", "") or "").strip()


def es_local(request: Request) -> bool:
    """
    True si la petición sale de esta misma máquina.

    Se aceptan las dos formas del bucle local: `127.0.0.0/8` en IPv4 y `::1` en
    IPv6. Y también `::ffff:127.0.0.1`, que es como un socket IPv6 representa
    una conexión IPv4 — sin eso, un servidor escuchando en modo dual daría
    "remoto" a su propia ventana, y el equipo servidor no podría configurarse a
    sí mismo.
    """
    ip = ip_del_cliente(request)
    if not ip:
        # Sin cliente identificable (algunos clientes de prueba internos) se
        # responde NO local. Es el fallo seguro: como mucho obliga a
        # configurar desde la ventana del servidor, que es donde toca.
        return False
    try:
        dir_ip = ipaddress.ip_address(ip)
    except ValueError:
        return False

    if getattr(dir_ip, "ipv4_mapped", None) is not None:
        dir_ip = dir_ip.ipv4_mapped
    return dir_ip.is_loopback


def exigir_local(request: Request, que: str = "esta operación") -> None:
    """
    Corta la petición si no viene del equipo servidor.

    El mensaje dice DÓNDE hacerlo, no solo que no se puede: quien se topa con
    esto normalmente no sabe que hay una distinción entre servidor y visor.
    """
    from fastapi import HTTPException

    if es_local(request):
        return
    ip = ip_del_cliente(request) or "desconocida"
    logger.warning("Rechazado %s desde %s: solo se permite desde el servidor.",
                   que, ip)
    raise HTTPException(
        403,
        f"{que.capitalize()} solo se puede hacer desde el equipo SERVIDOR. "
        f"Esta petición viene de {ip}, que es un visor.\n\n"
        f"Abre Psi Core en el equipo que hace de servidor y hazlo desde allí."
    )
