# -*- coding: utf-8 -*-
"""
widget_store.py
===============
Persistencia de los WIDGETS PERSONALIZADOS importados desde un `.zip`.

**El problema que resuelve.** La definición de un widget importado (su HTML,
su CSS y su JS) vivía solo en `localStorage` del navegador. Eso fallaba de dos
formas distintas, y las dos se veían en producción:

  1. **Al cerrar la aplicación de escritorio**, el widget aparecía vacío al
     volver a abrir. El diseño venía del servidor —por eso la caja seguía en
     su sitio, con su nombre y su tamaño— pero la definición se había
     perdido con el `localStorage`.
  2. **En la vista previa desde otro navegador** (`127.0.0.1:8000/preview`)
     salía vacío también: otro navegador es otro `localStorage`, y ahí esa
     definición nunca existió.

Y había un tercero esperando: con varios usuarios, el widget que importa uno
sería invisible para los demás.

Los tres son el mismo problema — `localStorage` es privado del navegador por
definición — y la solución es la que ya se aplicó al diseño: **la fuente de
verdad es el servidor**, y el navegador solo guarda una caché.

Formato: un fichero JSON por widget en `datos/widgets/`, igual que
`ProjectStore`. Un fichero por widget y no un JSON único porque así importar o
borrar uno no reescribe los demás, y un fichero corrupto no se lleva por
delante todo el catálogo.
"""
from __future__ import annotations

import json
import logging
import re
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

logger = logging.getLogger("widget_store")

# Un widget es HTML + CSS + JS: puede pesar. Se acota para que nadie suba un
# .zip con un vídeo dentro y reviente la memoria del servidor al listarlos.
MAX_BYTES_WIDGET = 2 * 1024 * 1024        # 2 MB por widget

_RE_KIND = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")

# Nombres de dispositivo RESERVADOS en Windows. Siguen siéndolo aunque se les
# añada una extensión: `con.json` no es un fichero, es la consola. Un widget
# llamado así fallaría al guardarse con un error incomprensible, y `nul` es
# peor todavía — Windows acepta la escritura y descarta el contenido, así que
# el widget se "guardaría" bien y aparecería vacío al recargar.
#
# Es rarísimo que alguien llame `con` a un widget, pero el coste de descartarlo
# es una línea y el de no hacerlo es un fallo que nadie sabría diagnosticar.
_RESERVADOS_WINDOWS = {
    "con", "prn", "aux", "nul",
    "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9",
    "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
}


def _ahora_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def validar_kind(kind: str) -> str:
    """
    Valida el identificador del widget.

    Es lo que acaba en el nombre de un fichero, así que se restringe a una
    lista blanca: sin puntos, sin barras y sin `..`. Ese es el control que
    impide que un `kind` malicioso escriba fuera de `datos/widgets/`.
    """
    kind = (kind or "").strip().lower()
    if not _RE_KIND.match(kind):
        raise ValueError(
            f"Identificador de widget inválido: '{kind}'. Solo minúsculas, "
            f"dígitos, guion y guion bajo; debe empezar por letra o dígito "
            f"(máx. 64 caracteres)."
        )
    if kind in _RESERVADOS_WINDOWS:
        raise ValueError(
            f"'{kind}' es un nombre reservado por Windows (dispositivos como "
            f"CON, NUL o COM1) y no puede usarse como nombre de fichero. "
            f"Renombra el widget, por ejemplo a '{kind}-1'."
        )
    return kind


@dataclass
class WidgetPersonalizado:
    """Un widget importado desde un `.zip`."""

    kind: str
    nombre: str = ""
    html: str = ""
    css: str = ""
    js: str = ""
    # Metadatos del widget.json: categoría, tipo de dato esperado, variables...
    meta: Dict[str, Any] = field(default_factory=dict)
    creado_en: str = ""
    actualizado_en: str = ""
    creado_por: str = ""

    def tamano(self) -> int:
        return len(self.html) + len(self.css) + len(self.js)

    def publico(self) -> dict:
        return asdict(self)

    def resumen(self) -> dict:
        """Sin el contenido: para listar sin mover megas por la red."""
        return {
            "kind": self.kind,
            "nombre": self.nombre,
            "meta": self.meta,
            "bytes": self.tamano(),
            "creado_en": self.creado_en,
            "actualizado_en": self.actualizado_en,
            "creado_por": self.creado_por,
        }


class WidgetStore:
    """Lee y escribe los widgets personalizados en `datos/widgets/`."""

    def __init__(self, carpeta: Optional[str] = None) -> None:
        if carpeta:
            self.carpeta = Path(carpeta)
        else:
            try:
                from app.config.rutas import resolver_carpeta_datos
                self.carpeta = resolver_carpeta_datos() / "widgets"
            except Exception:  # noqa: BLE001
                raiz = Path(__file__).resolve().parents[2]
                self.carpeta = raiz / "datos" / "widgets"
        self.carpeta.mkdir(parents=True, exist_ok=True)

        self.widgets: Dict[str, WidgetPersonalizado] = {}
        self.cargar()

    # ------------------------------------------------------------------ #
    def cargar(self) -> int:
        """
        Relee la carpeta. Un fichero corrupto se salta con un aviso: es
        preferible perder un widget a no poder arrancar el diseñador.
        """
        self.widgets = {}
        for ruta in sorted(self.carpeta.glob("*.json")):
            if ruta.name.endswith(".tmp"):
                continue
            try:
                doc = json.loads(ruta.read_text("utf-8"))
                w = WidgetPersonalizado(**doc)
                self.widgets[w.kind] = w
            except Exception as exc:  # noqa: BLE001
                logger.warning("Widget '%s' ilegible, se omite: %s",
                               ruta.name, exc)
        logger.info("Widgets personalizados cargados: %d.", len(self.widgets))
        return len(self.widgets)

    def _ruta(self, kind: str) -> Path:
        return self.carpeta / f"{validar_kind(kind)}.json"

    def _escribir(self, w: WidgetPersonalizado) -> None:
        """Escritura atómica: `.tmp` + rename, nunca un fichero a medias."""
        ruta = self._ruta(w.kind)
        tmp = ruta.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(asdict(w), indent=2, ensure_ascii=False),
                       encoding="utf-8")
        tmp.replace(ruta)

    # ------------------------------------------------------------------ #
    def listar(self, con_contenido: bool = False) -> List[dict]:
        """Catálogo. Sin contenido por defecto: el HTML puede pesar."""
        widgets = sorted(self.widgets.values(), key=lambda w: w.kind)
        return [(w.publico() if con_contenido else w.resumen()) for w in widgets]

    def obtener(self, kind: str) -> Optional[WidgetPersonalizado]:
        try:
            return self.widgets.get(validar_kind(kind))
        except ValueError:
            return None

    def guardar(
        self,
        kind: str,
        nombre: str = "",
        html: str = "",
        css: str = "",
        js: str = "",
        meta: Optional[Dict[str, Any]] = None,
        usuario: str = "",
    ) -> WidgetPersonalizado:
        """Crea o actualiza un widget. Lanza ValueError si no es válido."""
        kind = validar_kind(kind)
        if not (html or "").strip():
            raise ValueError(
                "El widget no tiene HTML. El .zip debe incluir widget.html.")

        total = len(html) + len(css or "") + len(js or "")
        if total > MAX_BYTES_WIDGET:
            raise ValueError(
                f"El widget ocupa {total // 1024} KB y el máximo son "
                f"{MAX_BYTES_WIDGET // 1024} KB. Aligera el HTML o mueve las "
                f"imágenes a un fichero aparte.")

        anterior = self.widgets.get(kind)
        widget = WidgetPersonalizado(
            kind=kind,
            nombre=nombre or (anterior.nombre if anterior else kind),
            html=html, css=css or "", js=js or "", meta=meta or {},
            creado_en=(anterior.creado_en if anterior else _ahora_iso()),
            actualizado_en=_ahora_iso(),
            creado_por=(anterior.creado_por if anterior else usuario) or usuario,
        )
        self.widgets[kind] = widget
        self._escribir(widget)
        logger.info("Widget '%s' guardado (%d bytes) por %s.",
                    kind, widget.tamano(), usuario or "?")
        return widget

    def borrar(self, kind: str) -> bool:
        """
        Quita el widget del catálogo.

        NO se tocan los diseños que lo usen: sus cajas quedan en el lienzo
        pero sin definición. Es deliberado — borrar widgets de las pantallas
        de golpe sería mucho más destructivo que dejar un hueco visible que
        el diseñador puede corregir.
        """
        try:
            kind = validar_kind(kind)
        except ValueError:
            return False
        if kind not in self.widgets:
            return False
        del self.widgets[kind]
        try:
            self._ruta(kind).unlink(missing_ok=True)
        except OSError as exc:
            logger.warning("No se pudo borrar el fichero de '%s': %s", kind, exc)
        logger.info("Widget '%s' eliminado.", kind)
        return True

    def estado(self) -> dict:
        return {
            "num_widgets": len(self.widgets),
            "carpeta": str(self.carpeta),
            "bytes_totales": sum(w.tamano() for w in self.widgets.values()),
        }
