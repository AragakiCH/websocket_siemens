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

SERVIDORES SIN PANTALLA (ctrlX CORE)
------------------------------------
En un ctrlX no hay navegador: nadie puede entrar por 127.0.0.1, y con la regla
de arriba a secas sería imposible crear la primera cuenta o configurar la base.
Para eso está `PLC_REDES_SERVIDOR`: redes cuyas peticiones cuentan como del
servidor. `auto` toma las subredes de las interfaces de la propia máquina (la
LAN a la que está enchufado el ctrlX), que es lo que el snap pone por defecto;
también vale una lista fija (`192.168.17.0/24,10.0.0.5`). Sigue sin mirarse
ninguna cabecera: es la IP real del socket contra esa lista.
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
    if dir_ip.is_loopback:
        return True
    return any(dir_ip in red for red in _redes_servidor(request))


# --------------------------------------------------------------------- #
# Redes del servidor (PLC_REDES_SERVIDOR)
# --------------------------------------------------------------------- #
_Red = ipaddress.IPv4Network | ipaddress.IPv6Network
_cache_redes: dict[str, list[_Red]] = {}


def _redes_servidor(request: Request) -> list[_Red]:
    """Lista resuelta (y cacheada por valor de la opción) de redes servidor."""
    settings = getattr(getattr(request, "app", None), "state", None)
    valor = (getattr(getattr(settings, "settings", None), "redes_servidor", "")
             or "").strip()
    if not valor:
        return []
    if valor not in _cache_redes:
        redes = (_redes_propias() if valor.lower() == "auto"
                 else _parsear_redes(valor))
        _cache_redes[valor] = redes
        logger.info("Redes tratadas como equipo servidor (%s): %s", valor,
                    ", ".join(str(r) for r in redes) or "ninguna")
    return _cache_redes[valor]


def _parsear_redes(valor: str) -> list[_Red]:
    redes: list[_Red] = []
    for trozo in valor.split(","):
        trozo = trozo.strip()
        if not trozo:
            continue
        try:
            redes.append(ipaddress.ip_network(trozo, strict=False))
        except ValueError:
            logger.warning("PLC_REDES_SERVIDOR: '%s' no es una red ni una IP "
                           "válida; se ignora.", trozo)
    return redes


def _redes_propias() -> list[_Red]:
    """
    Subredes IPv4 directamente conectadas a esta máquina, leídas de
    `/proc/net/route` (rutas sin puerta de enlace). No necesita paquetes
    extra ni permisos especiales, y funciona dentro de un snap estricto.
    En Windows no existe ese fichero: devuelve vacío (allí hay pantalla).
    """
    redes: list[_Red] = []
    try:
        with open("/proc/net/route", encoding="ascii") as f:
            next(f)  # cabecera
            for linea in f:
                campos = linea.split()
                if len(campos) < 8:
                    continue
                destino, gateway, mascara = campos[1], campos[2], campos[7]
                if gateway != "00000000" or destino == "00000000":
                    continue
                ip = ipaddress.IPv4Address(int(destino, 16).to_bytes(4, "little"))
                bits = bin(int(mascara, 16)).count("1")
                if ip.is_loopback or bits == 32:
                    continue
                red = ipaddress.ip_network(f"{ip}/{bits}", strict=False)
                if red not in redes:
                    redes.append(red)
    except (OSError, ValueError, StopIteration) as exc:
        logger.warning("No se pudieron leer las redes propias: %s", exc)
    return redes


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
