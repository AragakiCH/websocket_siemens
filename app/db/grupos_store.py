# -*- coding: utf-8 -*-
"""
grupos_store.py
===============
Los GRUPOS de la barra de pestañas del Diseñador, y en cuál cae cada pantalla.

POR QUÉ NO VIVE DENTRO DE LA PANTALLA
-------------------------------------
Lo obvio sería meterle un campo `grupo` al documento de la pantalla. No se
puede, y no por gusto: cada pantalla es un documento con VERSIÓN y con LÁPIZ
(`designer:<project_id>`). Un `PATCH` sobre ella sube la versión y el backend
exige el lock — así que arrastrar una pestaña a un grupo devolvería un 423 si
otra persona la está editando, o le provocaría un 409 a quien estuviera
guardando en ese momento.

Arrastrar una pestaña es un gesto de organización, no una edición del diseño.
Tiene que funcionar aunque la pantalla esté abierta por otro, y no puede tocar
su versión. Por eso la pertenencia vive aquí, fuera del documento.

Efecto secundario que sale gratis: borrar y recrear la organización nunca
puede corromper un diseño, porque son ficheros distintos.

POR PROYECTO, NO GLOBAL
-----------------------
Igual que las categorías de la paleta (ver `categorias_store.py`): los grupos
de una envasadora no le dicen nada a quien monta un tablero de bombeo.

SIN GRUPOS DE FÁBRICA, SIN REFUGIO
----------------------------------
Aquí NO hay un equivalente a las cuatro categorías fijas ni a `basicos`. Una
pantalla sin grupo simplemente se queda suelta en la barra, que es como está
hoy todo. Estar en un grupo es opcional, y esa es la diferencia de fondo con
las categorías: allí todo widget tiene que caer en algún sitio o desaparece de
la paleta; aquí una pantalla suelta se ve perfectamente.

Formato en disco (`datos/grupos_pantallas.json`):

```json
{
  "version": 1,
  "actualizado_en": "2026-09-22T10:00:00Z",
  "proyectos": {
    "principal": {
      "grupos": [{"id": "linea-1", "nombre": "Línea 1"}],
      "asignaciones": {"principal_pantalla_2": "linea-1"},
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
from typing import Dict, Iterable, List, Optional, Set

logger = logging.getLogger("grupos_store")

NOMBRE_FICHERO = "grupos_pantallas.json"

#: Un nombre más largo no cabe en una ficha de la barra sin empujar las
#: pestañas fuera de la vista, y uno vacío deja una ficha sin título.
MAX_NOMBRE = 32

#: Tope de grupos por proyecto. No es una limitación técnica: una barra con
#: cuarenta carpetas es exactamente el problema que los grupos venían a
#: resolver, solo que un piso más arriba.
MAX_GRUPOS = 40

_RE_LIMPIA = re.compile(r"[^a-z0-9]+")


def _ahora_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def slug(nombre: str) -> str:
    """
    El `id` estable de un grupo a partir de su nombre.

    Se quitan tildes y mayúsculas ANTES de comparar, que es todo el motivo de
    que exista: sin esto, «Línea 1» y «linea 1» serían dos fichas distintas y
    casi idénticas en la barra, y nadie entendería por qué sus pantallas salen
    repartidas entre las dos.

    La misma receta que `slug()` de `categorias_store.py` y que `idCategoria()`
    del frontend — si se toca una, se tocan las tres.
    """
    base = unicodedata.normalize("NFKD", (nombre or "").strip())
    base = "".join(c for c in base if not unicodedata.combining(c))
    base = _RE_LIMPIA.sub("-", base.lower()).strip("-")
    return base[:48]


def limpiar_nombre(nombre: str) -> str:
    """Nombre visible, sin espacios de sobra ni saltos de línea."""
    return " ".join((nombre or "").split())[:MAX_NOMBRE]


class GrupoEnUso(ValueError):
    """Se intentó borrar un grupo que todavía tiene pantallas dentro."""


class GruposStore:
    """Lee y escribe `datos/grupos_pantallas.json`."""

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

        Si está corrupto se arranca SIN grupos, no con lo que se pueda
        rescatar. El fallo seguro aquí es la barra de siempre: todas las
        pantallas sueltas, en su orden, que es algo que el usuario reconoce y
        puede rehacer en un minuto. Un fichero a medio parsear dejaría medias
        pantallas dentro de grupos y parecería que el programa perdió cosas.

        Ninguna pantalla se pierde jamás por esto: el fichero solo dice dónde
        se AGRUPAN, los diseños viven en otro sitio.
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
                "Los grupos de pantallas están corruptos (%s). Se arranca con "
                "la barra de siempre: todas las pantallas sueltas. No se ha "
                "perdido ningún diseño. Revisa %s", exc, self.ruta)
            self.proyectos = {}
        return len(self.proyectos)

    @staticmethod
    def _normalizar(bruto: object) -> dict:
        """
        Deja un proyecto en forma, venga como venga del disco.

        Se tolera basura y se tira en silencio en vez de reventar: este fichero
        lo puede haber tocado alguien a mano, y un HMI que no arranca porque
        sobra una coma en la organización de sus pestañas es peor que unas
        pestañas a medio organizar.
        """
        d = bruto if isinstance(bruto, dict) else {}

        vistos: Dict[str, dict] = {}
        orden: List[str] = []
        for g in d.get("grupos") or []:
            if not isinstance(g, dict):
                continue
            gid = slug(str(g.get("id") or g.get("nombre") or ""))
            if not gid or gid in vistos:
                continue
            vistos[gid] = {
                "id": gid,
                "nombre": limpiar_nombre(str(g.get("nombre") or gid)) or gid,
            }
            orden.append(gid)
        grupos = [vistos[i] for i in orden]

        validos = set(vistos)
        asignaciones: Dict[str, str] = {}
        for pantalla, gid in (d.get("asignaciones") or {}).items():
            if not isinstance(pantalla, str) or not isinstance(gid, str):
                continue
            destino = slug(gid)
            # Una asignación a un grupo que ya no existe se tira: la pantalla
            # vuelve a estar suelta, que es lo único que se puede pintar.
            if destino in validos:
                asignaciones[pantalla] = destino

        return {
            "grupos": grupos,
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
        Lo que ve la barra de ese proyecto.

        Un proyecto del que nunca se ha creado un grupo NO se escribe en disco
        al consultarlo: se devuelve vacío y ya. Escribir en cada GET llenaría
        el fichero de proyectos idénticos y vacíos, y el primer arranque del
        Diseñador dejaría un fichero que nadie pidió.
        """
        p = self.proyectos.get(proyecto_id)
        if p is None:
            return self._normalizar({})
        return {**p}

    def grupos(self, proyecto_id: str) -> List[dict]:
        return list(self.documento(proyecto_id)["grupos"])

    def asignaciones(self, proyecto_id: str) -> Dict[str, str]:
        return dict(self.documento(proyecto_id)["asignaciones"])

    def existe(self, proyecto_id: str, grupo_id: str) -> bool:
        return any(g["id"] == grupo_id
                   for g in self.documento(proyecto_id)["grupos"])

    def ocupantes(
        self,
        proyecto_id: str,
        grupo_id: str,
        existentes: Optional[Iterable[str]] = None,
    ) -> List[str]:
        """
        Las pantallas que hoy están dentro de ese grupo. Lista vacía = vacío.

        `existentes` es la lista de `project_id` que siguen vivos, y la trae
        quien llama porque este módulo no sabe nada de pantallas. Sin ella, una
        pantalla borrada hace tres días seguiría «ocupando» el grupo y no
        habría forma de borrarlo: el usuario vería «todavía tiene 1 pantalla
        dentro» con el desplegable vacío delante. Eso es un callejón sin
        salida, y este parámetro es lo que lo evita.
        """
        dentro = [p for p, g in self.documento(proyecto_id)["asignaciones"].items()
                  if g == grupo_id]
        if existentes is not None:
            vivos: Set[str] = set(existentes)
            dentro = [p for p in dentro if p in vivos]
        return sorted(dentro)

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
        """Añade un grupo vacío. Devuelve la entrada creada."""
        limpio = limpiar_nombre(nombre)
        gid = slug(limpio)
        if not limpio or not gid:
            raise ValueError(
                "El nombre del grupo no puede estar vacío ni ser solo signos: "
                "hace falta al menos una letra o un número.")

        p = self._asegurar(proyecto_id)
        for g in p["grupos"]:
            if g["id"] == gid:
                raise ValueError(
                    f"Ya existe un grupo '{g['nombre']}' en este proyecto. Se "
                    f"comparan sin tildes ni mayúsculas, así que '{limpio}' y "
                    f"'{g['nombre']}' serían el mismo.")
        if len(p["grupos"]) >= MAX_GRUPOS:
            raise ValueError(
                f"Este proyecto ya tiene {MAX_GRUPOS} grupos, que es el tope. "
                f"Junta algunos antes de crear otro.")

        entrada = {"id": gid, "nombre": limpio}
        p["grupos"].append(entrada)
        self._tocar(proyecto_id, usuario)
        return entrada

    def renombrar(self, proyecto_id: str, grupo_id: str, nombre: str,
                  usuario: str = "") -> dict:
        """
        Cambia la etiqueta visible. El `id` NO cambia, a propósito.

        Si el id siguiera al nombre, renombrar «Línea 1» a «Línea A» dejaría
        huérfana cada asignación que apunta a `linea-1` y las pantallas se
        saldrían solas del grupo al renombrarlo. Por eso el id se fija al
        crear y el nombre es solo lo que se lee.

        Renombrar un grupo NO toca ninguna pantalla: no hay versión que subir
        ni lápiz que pedir, que es justo por lo que los grupos viven aparte.
        """
        limpio = limpiar_nombre(nombre)
        if not limpio or not slug(limpio):
            raise ValueError(
                "El nombre del grupo no puede estar vacío ni ser solo signos: "
                "hace falta al menos una letra o un número.")

        p = self._asegurar(proyecto_id)
        objetivo = next((g for g in p["grupos"] if g["id"] == grupo_id), None)
        if objetivo is None:
            raise KeyError(f"No existe el grupo '{grupo_id}'.")

        nuevo_slug = slug(limpio)
        for g in p["grupos"]:
            if g["id"] != grupo_id and g["id"] == nuevo_slug:
                raise ValueError(
                    f"Ya hay otro grupo que se llama '{g['nombre']}'.")

        objetivo["nombre"] = limpio
        self._tocar(proyecto_id, usuario)
        return dict(objetivo)

    def borrar(self, proyecto_id: str, grupo_id: str,
               existentes: Optional[Iterable[str]] = None,
               usuario: str = "") -> bool:
        """
        Quita un grupo, SOLO si está vacío.

        No se ofrece «sacar todas y borrar» de una: vaciarlo primero obliga a
        mirar a dónde va cada pantalla. Un botón que las suelta todas de golpe
        deja la barra con quince pestañas sueltas que hay que volver a
        repartir, y para entonces ya no te acuerdas de cuáles estaban dentro.

        Borrar el grupo NUNCA borra pantallas. Solo deshace la agrupación.
        """
        p = self._asegurar(proyecto_id)
        objetivo = next((g for g in p["grupos"] if g["id"] == grupo_id), None)
        if objetivo is None:
            raise KeyError(f"No existe el grupo '{grupo_id}'.")

        dentro = self.ocupantes(proyecto_id, grupo_id, existentes)
        if dentro:
            raise GrupoEnUso(
                f"'{objetivo['nombre']}' todavía tiene {len(dentro)} "
                f"pantalla(s) dentro. Sácalas antes de borrar el grupo.")

        p["grupos"] = [g for g in p["grupos"] if g["id"] != grupo_id]
        # Las asignaciones a pantallas ya borradas que apuntaban aquí se van
        # con él: si no, resucitarían al crear otro grupo con el mismo nombre.
        p["asignaciones"] = {k: v for k, v in p["asignaciones"].items()
                             if v != grupo_id}
        self._tocar(proyecto_id, usuario)
        return True

    def asignar(self, proyecto_id: str, pantalla: str,
                grupo_id: Optional[str], usuario: str = "") -> Dict[str, str]:
        """
        Mete una pantalla en un grupo, o la saca.

        `grupo_id=None` (o vacío) la SACA y vuelve a estar suelta en la barra.
        Una pantalla está en un grupo como mucho: meterla en otro la mueve, no
        la duplica.
        """
        pantalla = (pantalla or "").strip()
        if not pantalla:
            raise ValueError("Hace falta el `project_id` de la pantalla.")

        p = self._asegurar(proyecto_id)
        if not grupo_id:
            p["asignaciones"].pop(pantalla, None)
        else:
            destino = slug(grupo_id)
            if not any(g["id"] == destino for g in p["grupos"]):
                raise KeyError(
                    f"No existe el grupo '{grupo_id}' en el proyecto "
                    f"'{proyecto_id}'. Créalo antes de mover pantallas a él.")
            p["asignaciones"][pantalla] = destino

        self._tocar(proyecto_id, usuario)
        return dict(p["asignaciones"])

    def reordenar(self, proyecto_id: str, orden: List[str],
                  usuario: str = "") -> List[dict]:
        """
        Cambia el orden en que se pintan las fichas de grupo.

        `orden` es la lista de ids como debe quedar. Lo que no venga se deja al
        final en el orden que tenía, y lo que venga y no exista se ignora: así
        una petición con la lista a medias —dos pestañas del navegador
        abiertas, una con un grupo que la otra no ha visto— reordena lo que
        puede en vez de fallar entera o tirar un grupo de la barra.
        """
        p = self._asegurar(proyecto_id)
        por_id = {g["id"]: g for g in p["grupos"]}

        nuevos: List[dict] = []
        for gid in orden:
            g = por_id.pop(slug(str(gid)), None)
            if g is not None:
                nuevos.append(g)
        # `por_id` conserva el orden de inserción, que es el que tenían.
        nuevos.extend(por_id.values())

        p["grupos"] = nuevos
        self._tocar(proyecto_id, usuario)
        return list(nuevos)

    def olvidar_pantalla(self, pantalla: str) -> bool:
        """
        Quita una pantalla borrada de su grupo.

        Lo llama `DELETE /pantallas/{id}`. Los ids de pantalla son únicos en
        TODA la instalación (cada uno es un fichero en la misma carpeta), así
        que se busca en todos los proyectos sin necesidad de saber de cuál era.

        Sin esto, crear otra pantalla con el mismo id la metería sola en el
        grupo de la anterior — que parece magia negra cuando pasa.
        """
        tocado = False
        for p in self.proyectos.values():
            if p["asignaciones"].pop(pantalla, None) is not None:
                tocado = True
        if tocado:
            self._escribir()
        return tocado

    def olvidar_proyecto(self, proyecto_id: str) -> bool:
        """
        Borra los grupos de un proyecto que ya no existe.

        Lo llama el borrado de proyectos. Sin esto, crear otro proyecto con el
        mismo id heredaría la organización del anterior.
        """
        if proyecto_id not in self.proyectos:
            return False
        del self.proyectos[proyecto_id]
        self._escribir()
        return True
