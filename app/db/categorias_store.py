# -*- coding: utf-8 -*-
"""
categorias_store.py
===================
Las CATEGORÍAS de la paleta de widgets, y en cuál cae cada widget.

POR QUÉ HACE FALTA UN SITIO APARTE
----------------------------------
Un widget dice de qué categoría es en tres lugares distintos según de dónde
venga: los 18 built-in la llevan escrita en `widgetCatalog.ts`, los custom TSX
en su propio fichero, y los subidos por ZIP en su `widget.json`. De esos tres,
solo el último se puede editar sin recompilar.

Así que si la colocación de un widget viviera en su definición, arrastrar el
Tanque a una categoría nueva sería imposible — habría que tocar el código
fuente. Y mantener DOS mecanismos (el JSON para los ZIP, una tabla para el
resto) significa dos verdades y una pregunta sin respuesta buena el día que
discrepen.

La regla, una sola para los tres orígenes:

    categoría efectiva = asignaciones[kind]  ->  la que declara  ->  'basicos'

La categoría declarada es el DEFECTO —la opinión de quien hizo el widget—, y
la asignación es la decisión de quien monta esta instalación. No compiten:
una es el respaldo de la otra. Por eso resubir un ZIP corregido no deshace la
organización, y quitar la asignación devuelve el widget a donde su autor lo
puso.

POR PROYECTO, NO GLOBAL
-----------------------
Dos HMI de máquinas distintas no tienen por qué compartir secciones: las
categorías de una envasadora no le dicen nada a quien monta un tablero de
bombeo. El catálogo de widgets sí es global —un ZIP subido está disponible en
todas partes—, pero CÓMO se ordena en la paleta es de cada proyecto.

UN SOLO FICHERO
---------------
`datos/categorias_widgets.json`, con todos los proyectos dentro. Al contrario
que las pantallas, esto son cuatro categorías y un puñado de asignaciones por
proyecto: una carpeta con un fichero de trescientos bytes cada uno no compra
nada y sí añade un sitio más donde quedar a medias.

Formato en disco:

```json
{
  "version": 1,
  "actualizado_en": "2026-09-21T10:00:00Z",
  "proyectos": {
    "principal": {
      "categorias": [
        {"id": "basicos", "nombre": "Básicos", "fija": true},
        {"id": "paneles", "nombre": "Paneles", "fija": false}
      ],
      "asignaciones": {"custom:mi-panel": "paneles", "tank": "paneles"},
      "actualizado_en": "...",
      "actualizado_por": "cristian"
    }
  }
}
```
"""
from __future__ import annotations

import json
import logging
import re
import unicodedata
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, Mapping, Optional

logger = logging.getLogger("categorias_store")

NOMBRE_FICHERO = "categorias_widgets.json"

#: Las cuatro de siempre. Son las que los 28 widgets del código llevan
#: escritas en su definición, así que existen en todos los proyectos y no se
#: pueden borrar: sin ellas, la mitad del catálogo se quedaría apuntando a una
#: categoría que no existe. Renombrarlas sí se puede — el `id` no cambia.
CATEGORIAS_BASE: List[dict] = [
    {"id": "basicos", "nombre": "Básicos", "fija": True},
    {"id": "indicadores", "nombre": "Indicadores", "fija": True},
    {"id": "equipos", "nombre": "Equipos", "fija": True},
    {"id": "datos", "nombre": "Datos", "fija": True},
]

#: Donde cae un widget cuya categoría no se reconoce. Nunca se pierde nada de
#: vista: un widget que no aparece en la paleta es un widget que el usuario da
#: por roto.
CATEGORIA_REFUGIO = "basicos"

#: Un nombre más largo no cabe en la cabecera de la barra lateral, y uno vacío
#: deja una sección sin título que nadie sabe qué es.
MAX_NOMBRE = 32

#: Tope de categorías por proyecto. No es una limitación técnica: es que una
#: paleta con cincuenta secciones es peor que una con cuatro, y el tope obliga
#: a darse cuenta antes de llegar ahí.
MAX_CATEGORIAS = 40

_RE_LIMPIA = re.compile(r"[^a-z0-9]+")


def _ahora_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def slug(nombre: str) -> str:
    """
    El `id` estable de una categoría a partir de su nombre.

    Se quitan las tildes y se pasa a minúsculas ANTES de comparar, y ese es el
    motivo de que exista esta función: sin ella, subir un ZIP que dice
    `"Paneles"` teniendo ya una categoría `"paneles"` crearía una segunda
    sección casi idéntica, y nadie entendería por qué sus widgets salen
    repartidos entre las dos.

    Devuelve cadena vacía si no queda nada utilizable — el llamador decide si
    eso es un error o un nombre que hay que rechazar.
    """
    base = unicodedata.normalize("NFKD", (nombre or "").strip())
    base = "".join(c for c in base if not unicodedata.combining(c))
    base = _RE_LIMPIA.sub("-", base.lower()).strip("-")
    return base[:48]


def limpiar_nombre(nombre: str) -> str:
    """Nombre visible, sin espacios de sobra ni saltos de línea."""
    return " ".join((nombre or "").split())[:MAX_NOMBRE]


class CategoriaEnUso(ValueError):
    """Se intentó borrar una categoría que todavía tiene widgets dentro."""


class CategoriaFija(ValueError):
    """Se intentó borrar una de las cuatro que el código da por hechas."""


class CategoriasStore:
    """Lee y escribe `datos/categorias_widgets.json`."""

    def __init__(self, carpeta: Optional[str] = None) -> None:
        if carpeta:
            self.carpeta = Path(carpeta)
        else:
            try:
                from app.db.store import carpeta_datos
                self.carpeta = carpeta_datos()
            except Exception:  # noqa: BLE001
                self.carpeta = Path(__file__).resolve().parents[2] / "datos"
        self.carpeta.mkdir(parents=True, exist_ok=True)
        self.ruta = self.carpeta / NOMBRE_FICHERO

        self.proyectos: Dict[str, dict] = {}
        self.cargar()

    # ------------------------------------------------------------------ #
    # Disco
    # ------------------------------------------------------------------ #
    def cargar(self) -> int:
        """
        Relee el fichero.

        Si está corrupto se arranca SIN asignaciones, no con lo que se pueda
        rescatar. Aquí el fallo seguro es que cada widget vuelva a la
        categoría que declara: la paleta queda como de fábrica, que es algo
        que el usuario entiende y puede rehacer. Un fichero a medio parsear
        dejaría widgets repartidos al azar y parecería un fallo del programa.
        """
        self.proyectos = {}
        if not self.ruta.is_file():
            return 0
        try:
            doc = json.loads(self.ruta.read_text("utf-8"))
            for pid, bruto in (doc.get("proyectos") or {}).items():
                self.proyectos[pid] = self._normalizar(bruto)
        except Exception as exc:  # noqa: BLE001
            logger.error(
                "Las categorías de la paleta están corruptas (%s). Se arranca "
                "con la paleta de fábrica: cada widget vuelve a su categoría "
                "declarada. Revisa %s", exc, self.ruta)
            self.proyectos = {}
        return len(self.proyectos)

    @staticmethod
    def _normalizar(bruto: object) -> dict:
        """
        Deja un proyecto en forma, venga como venga del disco.

        Se tolera basura y se tira en silencio en vez de reventar: este
        fichero lo puede haber tocado alguien a mano, y un HMI que no arranca
        porque sobra una coma en la organización de su paleta es peor que una
        paleta a medio organizar.
        """
        d = bruto if isinstance(bruto, dict) else {}
        vistos: Dict[str, dict] = {}
        for c in d.get("categorias") or []:
            if not isinstance(c, dict):
                continue
            cid = slug(str(c.get("id") or c.get("nombre") or ""))
            if not cid or cid in vistos:
                continue
            vistos[cid] = {
                "id": cid,
                "nombre": limpiar_nombre(str(c.get("nombre") or cid)) or cid,
                "fija": bool(c.get("fija")),
            }
        # Las cuatro de siempre se reponen si faltan, conservando el nombre
        # que tuvieran: el usuario pudo renombrar «Datos» a «Lecturas» y eso
        # no debe perderse por reponerlas.
        for base in CATEGORIAS_BASE:
            ya = vistos.get(base["id"])
            vistos[base["id"]] = {**base, "nombre": (ya or base)["nombre"]}

        # EL ORDEN GUARDADO MANDA. Se respeta tal cual venía del disco,
        # porque se puede reordenar arrastrando y un proyecto que puso
        # «Motores» arriba del todo tiene que seguir viéndolo arriba.
        #
        # Las de fábrica que falten se reponen DELANTE, no detrás: eso solo
        # pasa en un proyecto que nunca se tocó (o en un fichero editado a
        # mano), y ahí lo primero que busca alguien es un rectángulo o un
        # texto, no la sección que montó para una máquina.
        orden: List[str] = []
        for c in (d.get("categorias") or []):
            if not isinstance(c, dict):
                continue
            cid = slug(str(c.get("id") or c.get("nombre") or ""))
            if cid in vistos and cid not in orden:
                orden.append(cid)
        faltan = [b["id"] for b in CATEGORIAS_BASE if b["id"] not in orden]
        categorias = [vistos[i] for i in faltan + orden if i in vistos]

        validos = {c["id"] for c in categorias}
        asignaciones: Dict[str, str] = {}
        for kind, cid in (d.get("asignaciones") or {}).items():
            if not isinstance(kind, str) or not isinstance(cid, str):
                continue
            destino = slug(cid)
            # Una asignación a una categoría que ya no existe se tira, no se
            # redirige al refugio: si mañana se vuelve a crear esa categoría,
            # el widget tiene que volver solo a su sitio.
            if destino in validos:
                asignaciones[kind] = destino

        return {
            "categorias": categorias,
            "asignaciones": asignaciones,
            "actualizado_en": str(d.get("actualizado_en") or ""),
            "actualizado_por": str(d.get("actualizado_por") or ""),
        }

    def _escribir(self) -> None:
        """Escritura atómica: `.tmp` + rename, nunca un fichero a medias."""
        doc = {
            "version": 1,
            "actualizado_en": _ahora_iso(),
            "proyectos": self.proyectos,
        }
        tmp = self.ruta.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(doc, indent=2, ensure_ascii=False),
                       encoding="utf-8")
        tmp.replace(self.ruta)

    def _tocar(self, pid: str, usuario: str) -> None:
        self.proyectos[pid]["actualizado_en"] = _ahora_iso()
        self.proyectos[pid]["actualizado_por"] = usuario or ""
        self._escribir()

    # ------------------------------------------------------------------ #
    # Lectura
    # ------------------------------------------------------------------ #
    def documento(self, proyecto_id: str) -> dict:
        """
        Lo que ve la paleta de ese proyecto.

        Un proyecto del que nunca se ha tocado nada NO se crea en disco al
        consultarlo: se devuelven las cuatro de siempre y ya. Escribir en cada
        GET llenaría el fichero de proyectos vacíos idénticos, y el primer
        arranque del Diseñador dejaría un fichero que nadie pidió.
        """
        p = self.proyectos.get(proyecto_id)
        if p is None:
            return self._normalizar({})
        return {**p}

    def categorias(self, proyecto_id: str) -> List[dict]:
        return list(self.documento(proyecto_id)["categorias"])

    def asignaciones(self, proyecto_id: str) -> Dict[str, str]:
        return dict(self.documento(proyecto_id)["asignaciones"])

    def existe(self, proyecto_id: str, cat_id: str) -> bool:
        return any(c["id"] == cat_id
                   for c in self.documento(proyecto_id)["categorias"])

    def ocupantes(
        self,
        proyecto_id: str,
        cat_id: str,
        declaradas: Optional[Mapping[str, str]] = None,
    ) -> List[str]:
        """
        Los `kind` que hoy caen en esa categoría. Lista vacía = está vacía.

        `declaradas` es `{kind: categoría que declara}` y la tiene que traer
        quien llama, porque la categoría declarada de un widget vive en su
        definición y este módulo no la conoce. Sin ella solo se ven los
        widgets movidos a mano, y se dejaría borrar una categoría que tiene
        dentro un ZIP que la declara en su `widget.json` — que reaparecería
        acto seguido en el refugio, moviéndose solo a ojos del usuario.
        """
        doc = self.documento(proyecto_id)
        asignadas = doc["asignaciones"]
        dentro = [k for k, c in asignadas.items() if c == cat_id]
        for kind, declarada in (declaradas or {}).items():
            if kind in asignadas:
                continue  # manda la asignación, no lo que declara
            if slug(declarada) == cat_id:
                dentro.append(kind)
        return sorted(set(dentro))

    def estado(self) -> dict:
        return {
            "num_proyectos": len(self.proyectos),
            "fichero": str(self.ruta),
        }

    # ------------------------------------------------------------------ #
    # Escritura
    # ------------------------------------------------------------------ #
    def _asegurar(self, proyecto_id: str) -> dict:
        if proyecto_id not in self.proyectos:
            self.proyectos[proyecto_id] = self._normalizar({})
        return self.proyectos[proyecto_id]

    def crear(self, proyecto_id: str, nombre: str, usuario: str = "") -> dict:
        """Añade una categoría. Devuelve la entrada creada."""
        limpio = limpiar_nombre(nombre)
        cid = slug(limpio)
        if not limpio or not cid:
            raise ValueError(
                "El nombre de la categoría no puede estar vacío ni ser solo "
                "signos: hace falta al menos una letra o un número.")

        p = self._asegurar(proyecto_id)
        for c in p["categorias"]:
            if c["id"] == cid:
                raise ValueError(
                    f"Ya existe una categoría '{c['nombre']}' en este "
                    f"proyecto. Se comparan sin tildes ni mayúsculas, así que "
                    f"'{limpio}' y '{c['nombre']}' serían la misma.")
        if len(p["categorias"]) >= MAX_CATEGORIAS:
            raise ValueError(
                f"Este proyecto ya tiene {MAX_CATEGORIAS} categorías, que es "
                f"el tope. Junta algunas antes de crear otra.")

        entrada = {"id": cid, "nombre": limpio, "fija": False}
        p["categorias"].append(entrada)
        self._tocar(proyecto_id, usuario)
        return entrada

    def renombrar(self, proyecto_id: str, cat_id: str, nombre: str,
                  usuario: str = "") -> dict:
        """
        Cambia la etiqueta visible. El `id` NO cambia, a propósito.

        Si el id siguiera al nombre, renombrar «Paneles» a «Pantallas» dejaría
        huérfana cada asignación que apunta a `paneles` y los widgets se
        desparramarían al refugio. Por eso el id se fija al crear y el nombre
        es solo lo que se lee.
        """
        limpio = limpiar_nombre(nombre)
        if not limpio or not slug(limpio):
            raise ValueError(
                "El nombre de la categoría no puede estar vacío ni ser solo "
                "signos: hace falta al menos una letra o un número.")

        p = self._asegurar(proyecto_id)
        objetivo = next((c for c in p["categorias"] if c["id"] == cat_id), None)
        if objetivo is None:
            raise KeyError(f"No existe la categoría '{cat_id}'.")

        nuevo_slug = slug(limpio)
        for c in p["categorias"]:
            if c["id"] != cat_id and c["id"] == nuevo_slug:
                raise ValueError(
                    f"Ya hay otra categoría que se llama '{c['nombre']}'.")

        objetivo["nombre"] = limpio
        self._tocar(proyecto_id, usuario)
        return dict(objetivo)

    def borrar(self, proyecto_id: str, cat_id: str,
               declaradas: Optional[Mapping[str, str]] = None,
               usuario: str = "") -> bool:
        """
        Quita una categoría, SOLO si está vacía.

        No se ofrece mover los widgets a otra parte al borrar. Vaciar primero
        obliga a mirar uno por uno dónde va cada widget; un «muévelos todos a
        Básicos» los tira a un montón que después hay que volver a repartir, y
        para entonces ya no te acuerdas de cuáles eran.
        """
        p = self._asegurar(proyecto_id)
        objetivo = next((c for c in p["categorias"] if c["id"] == cat_id), None)
        if objetivo is None:
            raise KeyError(f"No existe la categoría '{cat_id}'.")
        if objetivo.get("fija"):
            raise CategoriaFija(
                f"'{objetivo['nombre']}' es una de las categorías de fábrica y "
                f"no se puede borrar: hay widgets del programa que la declaran "
                f"como suya. Renombrarla sí se puede.")

        dentro = self.ocupantes(proyecto_id, cat_id, declaradas)
        if dentro:
            raise CategoriaEnUso(
                f"'{objetivo['nombre']}' todavía tiene {len(dentro)} widget(s) "
                f"dentro. Muévelos a otra categoría antes de borrarla.")

        p["categorias"] = [c for c in p["categorias"] if c["id"] != cat_id]
        self._tocar(proyecto_id, usuario)
        return True

    def asignar(self, proyecto_id: str, kind: str, cat_id: Optional[str],
                usuario: str = "") -> Dict[str, str]:
        """
        Mueve un widget de categoría en ESTE proyecto.

        `cat_id=None` borra la asignación y el widget vuelve a la categoría
        que declara su definición — que es lo que hace el «volver a la del
        autor». No es lo mismo que asignarlo al refugio: si mañana se corrige
        el `widget.json`, este widget se entera y el otro no.
        """
        kind = (kind or "").strip()
        if not kind:
            raise ValueError("Hace falta el `kind` del widget.")

        p = self._asegurar(proyecto_id)
        if cat_id is None or cat_id == "":
            p["asignaciones"].pop(kind, None)
        else:
            destino = slug(cat_id)
            if not any(c["id"] == destino for c in p["categorias"]):
                raise KeyError(
                    f"No existe la categoría '{cat_id}' en el proyecto "
                    f"'{proyecto_id}'. Créala antes de mover widgets a ella.")
            p["asignaciones"][kind] = destino

        self._tocar(proyecto_id, usuario)
        return dict(p["asignaciones"])

    def reordenar(self, proyecto_id: str, orden: List[str],
                  usuario: str = "") -> List[dict]:
        """
        Cambia el orden en que se pintan las secciones.

        `orden` es la lista de ids como debe quedar. Lo que no venga en ella se
        deja al final en el orden que tenía, y lo que venga y no exista se
        ignora: así una petición con la lista a medias —dos pestañas abiertas,
        una con una categoría que la otra no ha visto— reordena lo que puede en
        vez de fallar entera o tirar una sección de la paleta.
        """
        p = self._asegurar(proyecto_id)
        por_id = {c["id"]: c for c in p["categorias"]}

        nuevas: List[dict] = []
        for cid in orden:
            c = por_id.pop(slug(str(cid)), None)
            if c is not None:
                nuevas.append(c)
        # `por_id` conserva el orden de inserción, que es el que tenían.
        nuevas.extend(por_id.values())

        p["categorias"] = nuevas
        self._tocar(proyecto_id, usuario)
        return list(nuevas)

    def olvidar_proyecto(self, proyecto_id: str) -> bool:
        """
        Borra las categorías de un proyecto que ya no existe.

        Lo llama el borrado de proyectos. Sin esto, crear otro proyecto con el
        mismo id heredaría la organización del anterior — que parece magia
        negra cuando aparecen secciones que nadie creó.
        """
        if proyecto_id not in self.proyectos:
            return False
        del self.proyectos[proyecto_id]
        self._escribir()
        return True
