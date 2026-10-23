# -*- coding: utf-8 -*-
"""
constantes_store.py
===================
Valores FIJOS con nombre que se asignan a los parámetros de un faceplate.

QUÉ SON
-------
Un faceplate tiene parámetros («Velocidad nominal», «Modo manual»…) y cada
instancia los rellena con un tag del PLC. Pero a veces lo que va en ese hueco
no es un tag sino un número fijo: la velocidad nominal de ESE motor es 1450,
no hay ningún tag que la lleve. Una constante es eso: nombre, tipo y valor,
guardados en el servidor.

DE CADA TIPO DE FACEPLATE
-------------------------
Cada constante pertenece a UN tipo de faceplate (`faceplate` = el
`project_id` de la pantalla marcada como tipo). La del faceplate «Motor» no
se ofrece en el de «Válvula». Así se pidió.

NO SON VARIABLES INTERNAS
-------------------------
Se parecen (las dos viven en el servidor, no en un PLC) y no son lo mismo:
una interna la puede cambiar un operario desde la pantalla; una constante la
fija quien diseña y no se escribe en operación. Por eso van en su propio
fichero y con su propio «PLC», y el gestor rechaza cualquier escritura sobre
ellas (ver `PlcManager.escribir_tags`).

POR QUÉ SE HACEN PASAR POR TAGS
-------------------------------
El mismo truco que las internas: se publican con `plc = "constante"`, así que
su clave es `constante|<id>`. El motor de faceplates traduce `param:x` a esa
clave y la busca entre las variables como cualquier otra: no hay que tocar
nada de la resolución ni de los widgets.

LA CLAVE LLEVA EL ID, NO EL NOMBRE. Renombrar «Velocidad nominal» a
«Velocidad» no rompe ningún enlace, porque lo que guardan las pantallas es
`constante|k1a2b3c4d`, que no cambia.

PERSISTENCIA
------------
`datos/variables_constantes.json`, reescrito entero en cada cambio (son
decenas, no millones), primero a un temporal y luego renombrado: un corte de
luz a mitad no deja el fichero a medias.
"""
from __future__ import annotations

import json
import logging
import os
import secrets
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

# Los mismos tipos y la misma conversión que las internas: así una constante
# `double` acepta «12,5» igual que una interna, y viaja con el mismo `Double`
# de OPC UA que entiende `mapOpcType()` en el frontend.
from app.core.internas_store import TIPOS, convertir, ErrorInterna

logger = logging.getLogger("constantes_store")

NOMBRE_FICHERO = "variables_constantes.json"

#: El `plc` con el que se publican. Palabra reservada, como `interno`.
PLC_CONSTANTE = "constante"

LARGO_MAX_NOMBRE = 60


class ErrorConstante(Exception):
    """Fallo de validación, con el mensaje ya listo para enseñar."""

    def __init__(self, mensaje: str, codigo: int = 400) -> None:
        super().__init__(mensaje)
        self.mensaje = mensaje
        self.codigo = codigo


def _ahora() -> str:
    return datetime.now(timezone.utc).isoformat()


def _nuevo_id() -> str:
    return "k" + secrets.token_hex(5)


def _convertir(valor: Any, tipo: str) -> Any:
    try:
        v = convertir(valor, tipo)
    except ErrorInterna as exc:
        raise ErrorConstante(exc.mensaje.replace("una variable", "una constante"))
    if v is None:
        return TIPOS[tipo]["defecto"]
    return v


@dataclass
class Constante:
    id: str
    faceplate: str
    nombre: str
    tipo: str
    valor: Any
    creado_en: str = field(default_factory=_ahora)
    actualizado_en: str = field(default_factory=_ahora)

    @property
    def clave(self) -> str:
        return f"{PLC_CONSTANTE}|{self.id}"

    def como_fila(self) -> dict:
        d = asdict(self)
        d["clave"] = self.clave
        return d

    def _base_tag(self) -> dict:
        return {
            "plc": PLC_CONSTANTE,
            "tag": self.id,
            "value": self.valor,
            "type": TIPOS[self.tipo]["opc"],
            "timestamp": self.actualizado_en,
            "source_ts": self.actualizado_en,
        }

    def como_tag(self) -> dict:
        """Misma forma que un tag de `GET /tags`, más lo propio."""
        return {
            **self._base_tag(),
            "name": self.nombre,
            "db": "Constantes",
            "node_id": f"constante:{self.id}",
            "delta_ms": None,
            "constante": True,
            "faceplate": self.faceplate,
        }

    def como_mensaje(self) -> dict:
        """El mensaje de cambio de valor, igual que el de un PLC."""
        return {
            **self._base_tag(),
            "server_ts": self.actualizado_en,
            "delta_ms": None,
        }


class ConstantesStore:
    """Las constantes de los faceplates, en memoria y en disco."""

    def __init__(self, carpeta: Optional[str] = None) -> None:
        if carpeta:
            self.carpeta = Path(carpeta)
        else:
            try:
                from app.config.rutas import resolver_carpeta_datos
                self.carpeta = resolver_carpeta_datos()
            except Exception:  # noqa: BLE001
                self.carpeta = Path("datos")
        self.carpeta.mkdir(parents=True, exist_ok=True)
        self.ruta = self.carpeta / NOMBRE_FICHERO
        self._items: Dict[str, Constante] = {}
        self._cargar()

    # ------------------------------------------------------------------ #
    # Disco
    # ------------------------------------------------------------------ #
    def _cargar(self) -> None:
        if not self.ruta.is_file():
            return
        try:
            doc = json.loads(self.ruta.read_text(encoding="utf-8"))
        except Exception as exc:  # noqa: BLE001
            # Un fichero corrupto no puede impedir que arranque el HMI.
            logger.error("No se pudo leer %s (%s). Se empieza sin constantes.",
                         self.ruta, exc)
            return
        for d in doc.get("constantes", []):
            try:
                tipo = d.get("tipo")
                if tipo not in TIPOS or not d.get("id") or not d.get("faceplate"):
                    continue
                c = Constante(
                    id=str(d["id"]),
                    faceplate=str(d["faceplate"]),
                    nombre=str(d.get("nombre") or d["id"]),
                    tipo=tipo,
                    valor=_convertir(d.get("valor"), tipo),
                    creado_en=d.get("creado_en") or _ahora(),
                    actualizado_en=d.get("actualizado_en") or _ahora(),
                )
                self._items[c.id] = c
            except Exception:  # noqa: BLE001
                logger.warning("Constante descartada: %r", d)
        logger.info("Constantes cargadas: %d", len(self._items))

    def _guardar(self) -> None:
        doc = {
            "version": 1,
            "guardado_en": _ahora(),
            "constantes": [asdict(c) for c in self._items.values()],
        }
        tmp = self.ruta.with_suffix(".tmp")
        try:
            tmp.write_text(json.dumps(doc, indent=2, ensure_ascii=False),
                           encoding="utf-8")
            os.replace(tmp, self.ruta)
        except Exception as exc:  # noqa: BLE001
            logger.error("No se pudieron guardar las constantes: %s", exc)
            raise ErrorConstante(f"No se pudo escribir {self.ruta}: {exc}", 500)

    # ------------------------------------------------------------------ #
    # Consulta
    # ------------------------------------------------------------------ #
    def listar(self, faceplate: Optional[str] = None) -> List[dict]:
        items = [c for c in self._items.values()
                 if not faceplate or c.faceplate == faceplate]
        items.sort(key=lambda c: c.nombre.lower())
        return [c.como_fila() for c in items]

    def tags(self) -> List[dict]:
        return [c.como_tag() for c in self._items.values()]

    def snapshot_entries(self) -> Dict[str, dict]:
        """
        Entradas para el snapshot del WebSocket, clave `constante|<id>`.

        Obligatorio por lo mismo que las internas: el cliente REEMPLAZA su
        lista de tags con cada snapshot, y una constante que no viniera aquí
        desaparecería en cada reconexión, dejando el faceplate sin valor.
        """
        return {c.clave: c._base_tag() for c in self._items.values()}

    def obtener(self, id_: str) -> Constante:
        c = self._items.get(id_)
        if c is None:
            raise ErrorConstante(f"No existe la constante '{id_}'.", 404)
        return c

    # ------------------------------------------------------------------ #
    # Validación
    # ------------------------------------------------------------------ #
    def _nombre_valido(self, nombre: Any, faceplate: str,
                       excepto: Optional[str] = None) -> str:
        n = " ".join(str(nombre or "").split())
        if not n:
            raise ErrorConstante("La constante necesita un nombre.")
        if len(n) > LARGO_MAX_NOMBRE:
            raise ErrorConstante(
                f"El nombre es demasiado largo (máximo {LARGO_MAX_NOMBRE}).")
        # Único DENTRO de su faceplate: dos «Velocidad nominal» en el mismo
        # desplegable no habría forma de distinguirlas.
        for c in self._items.values():
            if (c.faceplate == faceplate and c.id != excepto
                    and c.nombre.lower() == n.lower()):
                raise ErrorConstante(
                    f"Ya hay una constante llamada «{n}» en este faceplate.", 409)
        return n

    # ------------------------------------------------------------------ #
    # Alta, cambio y baja
    # ------------------------------------------------------------------ #
    def crear(self, datos: Dict[str, Any]) -> Constante:
        faceplate = str(datos.get("faceplate") or "").strip()
        if not faceplate:
            raise ErrorConstante("Falta el tipo de faceplate de la constante.")
        tipo = str(datos.get("tipo") or "")
        if tipo not in TIPOS:
            raise ErrorConstante(
                f"Tipo '{tipo}' no válido. Opciones: {', '.join(TIPOS)}.")
        nombre = self._nombre_valido(datos.get("nombre"), faceplate)
        c = Constante(
            id=_nuevo_id(),
            faceplate=faceplate,
            nombre=nombre,
            tipo=tipo,
            valor=_convertir(datos.get("valor"), tipo),
        )
        self._items[c.id] = c
        try:
            self._guardar()
        except ErrorConstante:
            self._items.pop(c.id, None)
            raise
        logger.info("Constante creada: %s = %r (%s, faceplate %s)",
                    c.nombre, c.valor, c.tipo, c.faceplate)
        return c

    def actualizar(self, id_: str, datos: Dict[str, Any]) -> Constante:
        """
        Cambia el nombre y/o el valor. El TIPO no se cambia: lo fija el
        parámetro al que se asigna, y una constante `bool` convertida en
        `double` dejaría sin sentido los faceplates que ya la usan.
        """
        c = self.obtener(id_)
        antes = asdict(c)
        if "nombre" in datos and datos["nombre"] is not None:
            c.nombre = self._nombre_valido(datos["nombre"], c.faceplate, excepto=c.id)
        if "valor" in datos:
            c.valor = _convertir(datos["valor"], c.tipo)
        c.actualizado_en = _ahora()
        try:
            self._guardar()
        except ErrorConstante:
            for k, v in antes.items():
                setattr(c, k, v)
            raise
        return c

    def borrar(self, id_: str) -> Constante:
        c = self.obtener(id_)
        del self._items[id_]
        try:
            self._guardar()
        except ErrorConstante:
            self._items[id_] = c
            raise
        logger.info("Constante borrada: %s (%s)", c.nombre, c.id)
        return c
