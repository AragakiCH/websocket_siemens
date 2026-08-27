# -*- coding: utf-8 -*-
"""
plc_store.py
============
Persistencia de la lista de PLCs dados de alta.

**Por qué existe (multiusuario).** Hasta ahora los PLCs vivían solo en la
memoria del proceso: al reiniciar el servicio se perdía el trabajo de TODOS los
usuarios a la vez, y había que volver a darlos de alta a mano. Con diez
personas trabajando sobre el mismo HMI eso deja de ser una molestia y pasa a
ser una interrupción de planta.

Se guarda en `datos/plcs.json`, con el mismo patrón que `DbStore`:

  * Escritura atómica (`.tmp` + `replace`): nunca queda un fichero a medias.
  * Tolerante a fichero corrupto: si el JSON es ilegible se arranca sin PLCs
    y se avisa en el log, en vez de impedir el arranque del servicio.
  * Contraseñas CIFRADAS con la misma clave Fernet que las conexiones a BD
    (`datos/.clave`). Solo aplica a Rexroth: el ctrlX necesita usuario y
    contraseña, y esas credenciales no pueden quedar en claro en un JSON.

Lo que NO se guarda: el estado de ejecución (conectado, número de tags, último
error). Eso se recalcula solo al reconectar.
"""
from __future__ import annotations

import json
import logging
import threading
from pathlib import Path
from typing import List, Optional

from cryptography.fernet import Fernet, InvalidToken

from app.core.plc_discovery import EndpointPlc
from app.db.store import PREFIJO_CIFRADO, cargar_o_crear_clave, carpeta_datos

logger = logging.getLogger("plc_store")

# Campos de EndpointPlc que se persisten. `origen` se fuerza a 'manual' al
# recargar: un PLC que sobrevive a un reinicio es, por definición, uno que
# alguien eligió conservar.
CAMPOS = ("endpoint", "host", "port", "nombre", "vendor",
          "usuario", "password", "app", "programa")


class PlcStore:
    """Lee y escribe `datos/plcs.json`, cifrando las contraseñas."""

    def __init__(self, carpeta: Optional[str] = None) -> None:
        self.carpeta = carpeta_datos(carpeta)
        self.ruta = self.carpeta / "plcs.json"
        self._fernet = Fernet(cargar_o_crear_clave(self.carpeta / ".clave"))
        self._lock = threading.Lock()

    # ------------------------------------------------------------------ #
    # Cifrado (mismo esquema que DbStore)
    # ------------------------------------------------------------------ #
    def cifrar(self, texto: str) -> str:
        if not texto:
            return ""
        return PREFIJO_CIFRADO + self._fernet.encrypt(texto.encode()).decode()

    def descifrar(self, valor: str) -> str:
        if not valor:
            return ""
        if not valor.startswith(PREFIJO_CIFRADO):
            # Alguien editó el JSON a mano y puso la contraseña en claro.
            return valor
        try:
            return self._fernet.decrypt(
                valor[len(PREFIJO_CIFRADO):].encode()
            ).decode()
        except InvalidToken:
            logger.error(
                "No se pudo descifrar la contraseña de un PLC: la clave no "
                "corresponde. ¿Se copió plcs.json sin su .clave?"
            )
            return ""

    # ------------------------------------------------------------------ #
    # Carga y guardado
    # ------------------------------------------------------------------ #
    def cargar(self) -> List[EndpointPlc]:
        """
        Devuelve los PLCs guardados. Lista vacía si no hay fichero o si está
        corrupto: un JSON roto no debe impedir que arranque el servicio.
        """
        if not self.ruta.is_file():
            return []
        try:
            crudo = json.loads(self.ruta.read_text("utf-8"))
        except Exception as exc:  # noqa: BLE001
            logger.error("plcs.json ilegible (%s); se arranca sin PLCs.", exc)
            return []

        salida: List[EndpointPlc] = []
        for d in crudo:
            try:
                salida.append(EndpointPlc(
                    endpoint=d["endpoint"],
                    host=d.get("host", ""),
                    port=int(d.get("port") or 4840),
                    nombre=d.get("nombre", ""),
                    origen="manual",
                    vendor=d.get("vendor", "siemens"),
                    usuario=d.get("usuario", ""),
                    password=self.descifrar(d.get("password", "")),
                    app=d.get("app", ""),
                    programa=d.get("programa", ""),
                ))
            except Exception as exc:  # noqa: BLE001
                # Una entrada mala no invalida las demás.
                logger.warning("Entrada de PLC ilegible en plcs.json: %s", exc)

        logger.info("PlcStore: %d PLC(s) recuperado(s) del disco.", len(salida))
        return salida

    def guardar(self, endpoints: List[EndpointPlc]) -> None:
        """Vuelca la lista de PLCs, cifrando las contraseñas."""
        with self._lock:
            datos = []
            for ep in endpoints:
                d = {campo: getattr(ep, campo, "") for campo in CAMPOS}
                d["password"] = self.cifrar(ep.password or "")
                datos.append(d)
            try:
                tmp = self.ruta.with_suffix(".json.tmp")
                tmp.write_text(
                    json.dumps(datos, indent=2, ensure_ascii=False),
                    encoding="utf-8",
                )
                tmp.replace(self.ruta)
            except Exception as exc:  # noqa: BLE001
                # No poder persistir NO debe tumbar el alta de un PLC: el PLC
                # ya está conectado y funcionando en memoria.
                logger.error("No se pudo guardar plcs.json: %s", exc)
