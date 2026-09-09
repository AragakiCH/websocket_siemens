# -*- coding: utf-8 -*-
"""
escritura_store.py
==================
QUÉ tags se puede escribir, y DENTRO DE QUÉ LÍMITES.

POR QUÉ EXISTE UNA LISTA BLANCA
-------------------------------
Un servidor OPC UA declara escribibles muchísimas más variables de las que
tiene sentido tocar desde un HMI. Basta con que alguien enlace un slider al
tag equivocado —o que se cuele un `full_name` mal escrito en una receta— para
mandar un valor a una variable que gobierna algo que no debía moverse. Y a
diferencia de una lectura mal enlazada, esto no se descubre mirando la
pantalla: se descubre en la máquina.

Así que la regla es al revés de lo habitual: **nada es escribible hasta que
alguien lo habilita a mano**, dejando por escrito quién lo hizo y con qué
límites. Habilitar un tag es una decisión de ingeniería, no un efecto
secundario de arrastrar un widget.

Los límites `minimo`/`maximo` son la segunda red. El tipo ya lo valida
`drivers/escritura.py` —que un Int16 no desborde—, pero que un valor quepa en
un Int16 no significa que la máquina lo admita: 32000 cabe de sobra en el tag
de una consigna de temperatura cuyo máximo real son 90 °C.

Formato: un único JSON en `datos/escritura_permitida.json`. Un solo fichero y
no uno por tag, al contrario que los widgets, porque esto se lee ENTERO en
cada escritura para validar, y son decenas de entradas, no miles.
"""
from __future__ import annotations

import json
import logging
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, Optional

logger = logging.getLogger("escritura_store")

NOMBRE_FICHERO = "escritura_permitida.json"


def _ahora_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


@dataclass
class TagEscribible:
    """Un tag habilitado para escritura, con sus límites."""

    plc_id: str
    tag: str                      # full_name, como lo ve el resto del sistema
    node_id: str = ""
    data_type: str = ""
    minimo: Optional[float] = None
    maximo: Optional[float] = None
    # Texto que se le enseña a quien va a escribir. Para que el diálogo de
    # confirmación pueda decir "Consigna de temperatura de la Cuba 1" en vez
    # de "DB_snap7.setpoint_temp".
    descripcion: str = ""
    habilitado_por: str = ""
    habilitado_en: str = ""
    actualizado_en: str = ""

    def clave(self) -> str:
        return f"{self.plc_id}|{self.tag}"

    def publico(self) -> dict:
        return asdict(self)


class ErrorDeRango(ValueError):
    """El valor está fuera de los límites configurados para ese tag."""


class TagNoEscribible(PermissionError):
    """Ese tag no está en la lista blanca."""


class EscrituraStore:
    """Lee y escribe la lista blanca en `datos/escritura_permitida.json`."""

    def __init__(self, carpeta: Optional[str] = None) -> None:
        if carpeta:
            self.carpeta = Path(carpeta)
        else:
            try:
                from app.config.rutas import resolver_carpeta_datos
                self.carpeta = resolver_carpeta_datos()
            except Exception:  # noqa: BLE001
                self.carpeta = Path(__file__).resolve().parents[2] / "datos"
        self.carpeta.mkdir(parents=True, exist_ok=True)
        self.ruta = self.carpeta / NOMBRE_FICHERO

        self.tags: Dict[str, TagEscribible] = {}
        self.cargar()

    # ------------------------------------------------------------------ #
    def cargar(self) -> int:
        """
        Relee el fichero.

        Si está corrupto se arranca con la lista VACÍA, no con lo que se
        pudiera rescatar. Aquí "vacío" significa "no se puede escribir en
        nada", que es el fallo seguro: un fichero a medio parsear podría dejar
        habilitado un tag sin sus límites, y eso es peor que no poder escribir.
        """
        self.tags = {}
        if not self.ruta.is_file():
            return 0
        try:
            doc = json.loads(self.ruta.read_text("utf-8"))
            for fila in doc.get("tags", []):
                t = TagEscribible(**fila)
                self.tags[t.clave()] = t
        except Exception as exc:  # noqa: BLE001
            logger.error(
                "La lista de tags escribibles está corrupta (%s). Se arranca "
                "SIN permitir ninguna escritura, que es el fallo seguro. "
                "Revisa %s", exc, self.ruta)
            self.tags = {}
        logger.info("Tags habilitados para escritura: %d.", len(self.tags))
        return len(self.tags)

    def _escribir(self) -> None:
        """Escritura atómica: `.tmp` + rename, nunca un fichero a medias."""
        doc = {
            "version": 1,
            "actualizado_en": _ahora_iso(),
            "tags": [asdict(t) for t in self.tags.values()],
        }
        tmp = self.ruta.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(doc, indent=2, ensure_ascii=False), encoding="utf-8")
        tmp.replace(self.ruta)

    # ------------------------------------------------------------------ #
    def listar(self, plc_id: str = "") -> List[dict]:
        tags = sorted(self.tags.values(), key=lambda t: (t.plc_id, t.tag))
        return [t.publico() for t in tags if not plc_id or t.plc_id == plc_id]

    def obtener(self, plc_id: str, tag: str) -> Optional[TagEscribible]:
        return self.tags.get(f"{plc_id}|{tag}")

    def habilitar(
        self,
        plc_id: str,
        tag: str,
        node_id: str = "",
        data_type: str = "",
        minimo: Optional[float] = None,
        maximo: Optional[float] = None,
        descripcion: str = "",
        usuario: str = "",
    ) -> TagEscribible:
        """Habilita un tag para escritura, o actualiza sus límites."""
        if not plc_id or not tag:
            raise ValueError("Hacen falta el plc_id y el tag.")

        if minimo is not None and maximo is not None and minimo > maximo:
            raise ValueError(
                f"El mínimo ({minimo}) es mayor que el máximo ({maximo}): "
                f"con esos límites no se podría escribir ningún valor."
            )

        anterior = self.tags.get(f"{plc_id}|{tag}")
        entrada = TagEscribible(
            plc_id=plc_id, tag=tag, node_id=node_id, data_type=data_type,
            minimo=minimo, maximo=maximo, descripcion=descripcion,
            habilitado_por=(anterior.habilitado_por if anterior else usuario) or usuario,
            habilitado_en=(anterior.habilitado_en if anterior else _ahora_iso()),
            actualizado_en=_ahora_iso(),
        )
        self.tags[entrada.clave()] = entrada
        self._escribir()
        logger.info("Tag '%s' del PLC '%s' habilitado para escritura por %s "
                    "(rango %s..%s).", tag, plc_id, usuario or "?", minimo, maximo)
        return entrada

    def deshabilitar(self, plc_id: str, tag: str) -> bool:
        clave = f"{plc_id}|{tag}"
        if clave not in self.tags:
            return False
        del self.tags[clave]
        self._escribir()
        logger.info("Tag '%s' del PLC '%s' YA NO es escribible.", tag, plc_id)
        return True

    # ------------------------------------------------------------------ #
    def validar(self, plc_id: str, tag: str, valor: object) -> TagEscribible:
        """
        Comprueba que el tag esté habilitado y que el valor esté en su rango.

        Devuelve la entrada, o lanza `TagNoEscribible` / `ErrorDeRango`.
        """
        entrada = self.obtener(plc_id, tag)
        if entrada is None:
            raise TagNoEscribible(
                f"El tag '{tag}' del PLC '{plc_id}' no está habilitado para "
                f"escritura. Habilítalo primero en Configuración → Escritura, "
                f"indicando sus límites."
            )

        # Los límites solo aplican a valores numéricos. Un booleano o un texto
        # no tienen "rango", y comparar `True > 5` en Python daría False sin
        # error, dejando pasar en silencio algo que no se estaba validando.
        if isinstance(valor, bool) or not isinstance(valor, (int, float)):
            return entrada

        if entrada.minimo is not None and valor < entrada.minimo:
            raise ErrorDeRango(
                f"{valor} está por debajo del mínimo permitido para '{tag}' "
                f"({entrada.minimo})."
            )
        if entrada.maximo is not None and valor > entrada.maximo:
            raise ErrorDeRango(
                f"{valor} supera el máximo permitido para '{tag}' "
                f"({entrada.maximo})."
            )
        return entrada

    def estado(self) -> dict:
        return {
            "num_tags": len(self.tags),
            "fichero": str(self.ruta),
            "por_plc": {
                plc: sum(1 for t in self.tags.values() if t.plc_id == plc)
                for plc in sorted({t.plc_id for t in self.tags.values()})
            },
        }
