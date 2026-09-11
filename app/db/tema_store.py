# -*- coding: utf-8 -*-
"""
tema_store.py
=============
Los TEMAS del proyecto: paleta de colores (modo claro y oscuro) y tipografías.

QUÉ RESUELVE
------------
Hasta ahora cada widget guardaba su color a fuego: `"color": "#009999"`. Con
veinte widgets repartidos en cinco pantallas, cambiar el color corporativo era
abrir widget por widget. Y el "modo oscuro" que ya existía solo repintaba el
armazón de la aplicación —menús, barras—; el HMI en sí seguía igual, porque
sus colores estaban escritos dentro de cada widget.

Un tema define VARIABLES CSS. El widget deja de guardar `#009999` y guarda
`var(--psi-primary)`. El navegador resuelve la variable al pintar, así que
cambiar el tema repinta todo a la vez —y el widget que quiera un color propio
sigue pudiendo guardar su literal. Es el modelo de WebIQ: «cambiar todos los
botones a azul de golpe pudiendo seguir estilando botones concretos».

POR QUÉ EL CATÁLOGO DE ROLES NO ESTÁ AQUÍ
------------------------------------------
Este módulo valida el FORMATO (que un id sea un id y que un color sea un
color), no la LISTA de roles. El catálogo —qué grupos hay, cómo se llaman en
la interfaz y en qué orden salen— vive solo en el frontend (`models/tema.ts`).

Es deliberado. Si la lista estuviera en los dos sitios, añadir un rol serían
dos ficheros que hay que acordarse de tocar a la vez, y el día que se olvide
uno el servidor rechazaría un color que la interfaz acaba de ofrecer. Aquí se
acepta cualquier rol bien formado; el frontend enseña los que conoce y agrupa
el resto bajo «Otros». Así también funciona el botón «Añadir color», que crea
roles que ningún catálogo podía prever.

Lo que sí vive aquí es UN tema por defecto, para que una instalación recién
puesta tenga colores sin que nadie tenga permiso de escritura todavía.

VALIDACIÓN DE VALORES
---------------------
Los valores acaban dentro de una hoja de estilos del navegador, así que se
validan contra una lista blanca en vez de confiar en ellos. El frontend los
aplica con `style.setProperty()`, que es una API del CSSOM y no concatena
texto, pero un tema exportado por alguien más se importa como cualquier
fichero: la comprobación va en el servidor, que es quien no se puede saltar.

Formato en disco (`datos/temas.json`):

```json
{
  "version": 7,
  "actualizado_en": "2026-09-10T09:12:00Z",
  "actualizado_por": "jmendoza",
  "activo": "psi-petrol",
  "temas": [
    {
      "id": "psi-petrol",
      "nombre": "PSI Petrol",
      "modo_por_defecto": "auto",
      "colores": {"light": {"primary": "#009999"}, "dark": {"primary": "#8fd6d6"}},
      "fuentes": {"cuerpo": {"familia": "Inter, system-ui, sans-serif"}},
      "extras": [{"id": "marcaAgua", "nombre": "Marca de agua"}]
    }
  ]
}
```
"""
from __future__ import annotations

import asyncio
import json
import logging
import re
import threading
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from app.db.store import carpeta_datos

logger = logging.getLogger("tema_store")

FICHERO = "temas.json"

MODOS = ("light", "dark")
MODOS_POR_DEFECTO = ("light", "dark", "auto")

# Id de tema y de rol: se convierten en nombres de variable CSS, así que no
# pueden llevar nada que cierre una declaración.
_RE_ID_TEMA = re.compile(r"^[a-z0-9][a-z0-9_-]{0,48}$")
_RE_ID_ROL = re.compile(r"^[A-Za-z][A-Za-z0-9]{0,40}$")

# Colores aceptados. Lista blanca corta a propósito: todo lo que un selector
# de color puede producir, más `transparent` y `currentColor`, que el resto de
# la aplicación ya usa. `var(...)` NO se acepta dentro de un tema: un tema que
# se refiere a otra variable puede referirse a sí mismo, y el resultado sería
# un color que el navegador descarta sin decir nada.
_RE_COLOR = re.compile(
    r"^(?:"
    r"#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})"
    r"|rgba?\(\s*[0-9.]+\s*[, ]\s*[0-9.]+\s*[, ]\s*[0-9.]+\s*(?:[,/]\s*[0-9.%]+\s*)?\)"
    r"|hsla?\(\s*[0-9.]+(?:deg)?\s*[, ]\s*[0-9.]+%\s*[, ]\s*[0-9.]+%\s*(?:[,/]\s*[0-9.%]+\s*)?\)"
    r"|transparent|currentColor"
    r")$"
)

# Familia tipográfica: nombres, comillas y comas. Sin paréntesis (que abrirían
# un `url()`), sin punto y coma y sin llaves.
_RE_FAMILIA = re.compile(r"^[A-Za-z0-9 ,'\"._-]{1,160}$")

# Roles tipográficos que el tema puede definir. Aquí sí hay lista cerrada
# porque cada uno tiene un consumidor concreto escrito en la hoja de estilos
# (`--psi-fuente-cuerpo` la usa `body`); un rol inventado no lo leería nadie.
ROLES_FUENTE = ("cuerpo", "titulo", "dato", "mono")

PESOS = (100, 200, 300, 400, 500, 600, 700, 800, 900)


class ConflictoDeVersion(Exception):
    """Alguien guardó los temas mientras tú los editabas."""

    def __init__(self, esperada: int, actual: int) -> None:
        super().__init__(
            f"Conflicto de versión: editaste sobre la v{esperada} pero los "
            f"temas van por la v{actual}. Otro usuario guardó antes."
        )
        self.esperada = esperada
        self.actual = actual


def _ahora_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


# ---------------------------------------------------------------------- #
# Tema por defecto
# ---------------------------------------------------------------------- #
#
# Parte del petróleo corporativo que la aplicación ya usaba (#009999), para
# que instalar esta versión no cambie el aspecto de nada de un día para otro.
#
# Los roles `*Fixed` valen lo mismo en claro y en oscuro. No es un descuido:
# es lo que significan en Material Design 3 —son los colores que NO cambian
# con el modo, para elementos que tienen que reconocerse igual en los dos.

_LIGHT = {
    # El petroleo corporativo, tal cual. Es el valor que llevan hoy los
    # veinte widgets guardados y el que `defaultStyle()` ponia a fuego.
    "primary": "#009999", "onPrimary": "#ffffff",
    "primaryContainer": "#9cf1f0", "onPrimaryContainer": "#002020",
    "secondary": "#4a6363", "onSecondary": "#ffffff",
    "secondaryContainer": "#cce8e7", "onSecondaryContainer": "#051f1f",
    "tertiary": "#4b607c", "onTertiary": "#ffffff",
    "tertiaryContainer": "#d3e4ff", "onTertiaryContainer": "#031c35",
    # Alarma, aviso y normal valen LO MISMO en claro y en oscuro, y son los
    # tres que la aplicacion ya usa (tailwind `state.*`, la tabla de alarmas,
    # el banner). Un rojo de alarma que cambia de tono al pasar a modo noche
    # es exactamente lo que no puede pasar: el operario lo reconoce de lejos.
    "error": "#ef4444", "onError": "#ffffff",
    "errorContainer": "#ffdad6", "onErrorContainer": "#410002",
    "warning": "#f59e0b", "onWarning": "#2c1700",
    "warningContainer": "#ffddb3", "onWarningContainer": "#2c1700",
    "success": "#22c55e", "onSuccess": "#002204",
    "successContainer": "#94f990", "onSuccessContainer": "#002204",
    "background": "#f4fbfa", "onBackground": "#161d1d",
    "surface": "#ffffff", "onSurface": "#161d1d",
    "surfaceVariant": "#dae5e4", "onSurfaceVariant": "#3f4949",
    # El gris de borde que llevan los widgets guardados.
    "outline": "#94a3b8", "outlineVariant": "#cbd5e1",
}

_DARK = {
    # En oscuro el petroleo puro no se lee; se sube al tono 200 de la misma
    # escala que ya esta en tailwind.config.js (`siemens.200`).
    "primary": "#8fd6d6", "onPrimary": "#003737",
    "primaryContainer": "#004f4f", "onPrimaryContainer": "#9cf1f0",
    "secondary": "#b0cccb", "onSecondary": "#1b3535",
    "secondaryContainer": "#334b4b", "onSecondaryContainer": "#cce8e7",
    "tertiary": "#b3c8e8", "onTertiary": "#1c314b",
    "tertiaryContainer": "#334863", "onTertiaryContainer": "#d3e4ff",
    # Los mismos tres de siempre (ver la nota en _LIGHT).
    "error": "#ef4444", "onError": "#ffffff",
    "errorContainer": "#93000a", "onErrorContainer": "#ffdad6",
    "warning": "#f59e0b", "onWarning": "#2c1700",
    "warningContainer": "#683d00", "onWarningContainer": "#ffddb3",
    "success": "#22c55e", "onSuccess": "#002204",
    "successContainer": "#005313", "onSuccessContainer": "#94f990",
    "background": "#0e1514", "onBackground": "#dde4e3",
    "surface": "#111a19", "onSurface": "#dde4e3",
    "surfaceVariant": "#3f4949", "onSurfaceVariant": "#bec9c8",
    "outline": "#64748b", "outlineVariant": "#334155",
}

# Los `*Fixed`, iguales en los dos modos.
_FIJOS = {
    "primaryFixed": "#9cf1f0", "onPrimaryFixed": "#002020",
    "primaryFixedDim": "#80d5d4", "onPrimaryFixedVariant": "#004f4f",
    "secondaryFixed": "#cce8e7", "onSecondaryFixed": "#051f1f",
    "secondaryFixedDim": "#b0cccb", "onSecondaryFixedVariant": "#334b4b",
    "tertiaryFixed": "#d3e4ff", "onTertiaryFixed": "#031c35",
    "tertiaryFixedDim": "#b3c8e8", "onTertiaryFixedVariant": "#334863",
}

_FUENTES_POR_DEFECTO = {
    "cuerpo": {"familia": "Inter, system-ui, sans-serif", "tamano": 14,
               "peso": 400, "interlineado": 1.45, "espaciado": 0},
    "titulo": {"familia": "Inter, system-ui, sans-serif", "tamano": 18,
               "peso": 700, "interlineado": 1.25, "espaciado": 0},
    # Las lecturas de proceso. Tabular por defecto: un número que cambia de
    # ancho al pasar de 9 a 10 hace que la columna entera baile.
    "dato": {"familia": "Inter, system-ui, sans-serif", "tamano": 16,
             "peso": 600, "interlineado": 1.2, "espaciado": 0},
    "mono": {"familia": "Consolas, 'Courier New', monospace", "tamano": 13,
             "peso": 400, "interlineado": 1.4, "espaciado": 0},
}

TEMA_POR_DEFECTO = "psi-petrol"


def _tema_base() -> dict:
    return {
        "id": TEMA_POR_DEFECTO,
        "nombre": "PSI Petrol",
        "modo_por_defecto": "auto",
        "colores": {
            "light": {**_LIGHT, **_FIJOS},
            "dark": {**_DARK, **_FIJOS},
        },
        "fuentes": {k: dict(v) for k, v in _FUENTES_POR_DEFECTO.items()},
        "extras": [],
        "bloqueado": True,
    }


def _tema_alto_contraste() -> dict:
    """
    Segundo tema de serie, y no es un adorno.

    En planta hay pantallas a pleno sol y operarios con gafas de seguridad
    rayadas. Tener a mano un tema de alto contraste evita que cada instalación
    se lo tenga que inventar, y sirve de ejemplo de qué se puede cambiar.
    """
    claro = {**_LIGHT, **_FIJOS}
    claro.update({
        "primary": "#003d3d", "onPrimary": "#ffffff",
        "primaryContainer": "#7fe4e3", "onPrimaryContainer": "#000f0f",
        "background": "#ffffff", "onBackground": "#000000",
        "surface": "#ffffff", "onSurface": "#000000",
        "surfaceVariant": "#e8eded", "onSurfaceVariant": "#1a1f1f",
        "outline": "#2f3838", "outlineVariant": "#8b9595",
        "error": "#8c0009", "warning": "#5c3600", "success": "#00450f",
    })
    oscuro = {**_DARK, **_FIJOS}
    oscuro.update({
        "primary": "#a8fffe", "onPrimary": "#000000",
        "primaryContainer": "#006a6a", "onPrimaryContainer": "#ffffff",
        "background": "#000000", "onBackground": "#ffffff",
        "surface": "#000000", "onSurface": "#ffffff",
        "surfaceVariant": "#1a2423", "onSurfaceVariant": "#e6efee",
        "outline": "#c4cfce", "outlineVariant": "#5a6564",
        "error": "#ffd2cd", "warning": "#ffd99b", "success": "#b6ffb0",
    })
    fuentes = {k: dict(v) for k, v in _FUENTES_POR_DEFECTO.items()}
    for rol in fuentes.values():
        rol["peso"] = min(900, int(rol["peso"]) + 100)
    return {
        "id": "alto-contraste",
        "nombre": "Alto contraste",
        "modo_por_defecto": "light",
        "colores": {"light": claro, "dark": oscuro},
        "fuentes": fuentes,
        "extras": [],
        "bloqueado": True,
    }


def documento_inicial() -> dict:
    return {
        "version": 1,
        "actualizado_en": _ahora_iso(),
        "actualizado_por": "",
        "activo": TEMA_POR_DEFECTO,
        "temas": [_tema_base(), _tema_alto_contraste()],
    }


# ---------------------------------------------------------------------- #
# Validación
# ---------------------------------------------------------------------- #
def _texto(valor: Any, campo: str, maximo: int) -> str:
    if not isinstance(valor, str):
        raise ValueError(f"'{campo}' tiene que ser texto.")
    v = valor.strip()
    if not v:
        raise ValueError(f"'{campo}' no puede estar vacío.")
    if len(v) > maximo:
        raise ValueError(f"'{campo}' no puede pasar de {maximo} caracteres.")
    return v


def _numero(valor: Any, campo: str, minimo: float, maximo: float,
            por_defecto: float) -> float:
    if valor is None:
        return por_defecto
    try:
        n = float(valor)
    except (TypeError, ValueError):
        raise ValueError(f"'{campo}' tiene que ser un número.")
    if not minimo <= n <= maximo:
        raise ValueError(f"'{campo}' tiene que estar entre {minimo} y {maximo}.")
    return n


def validar_tema(bruto: Any) -> dict:
    """
    Comprueba y normaliza UN tema. Lanza ValueError con un mensaje que se
    pueda enseñar tal cual en la interfaz.
    """
    if not isinstance(bruto, dict):
        raise ValueError("Cada tema tiene que ser un objeto.")

    tid = _texto(bruto.get("id"), "id", 48)
    if not _RE_ID_TEMA.match(tid):
        raise ValueError(
            f"Id de tema inválido: '{tid}'. Minúsculas, dígitos, guion y "
            f"guion bajo; tiene que empezar por letra o dígito."
        )
    nombre = _texto(bruto.get("nombre"), "nombre", 80)

    modo = bruto.get("modo_por_defecto") or "auto"
    if modo not in MODOS_POR_DEFECTO:
        raise ValueError(
            f"'modo_por_defecto' tiene que ser uno de {MODOS_POR_DEFECTO}."
        )

    colores_brutos = bruto.get("colores") or {}
    if not isinstance(colores_brutos, dict):
        raise ValueError("'colores' tiene que ser un objeto.")
    colores: Dict[str, Dict[str, str]] = {}
    for m in MODOS:
        paleta = colores_brutos.get(m) or {}
        if not isinstance(paleta, dict):
            raise ValueError(f"'colores.{m}' tiene que ser un objeto.")
        if len(paleta) > 300:
            raise ValueError(f"'colores.{m}' tiene demasiadas entradas.")
        limpia: Dict[str, str] = {}
        for rol, valor in paleta.items():
            if not isinstance(rol, str) or not _RE_ID_ROL.match(rol):
                raise ValueError(
                    f"Nombre de color inválido: '{rol}'. Solo letras y "
                    f"dígitos, empezando por letra."
                )
            if not isinstance(valor, str) or not _RE_COLOR.match(valor.strip()):
                raise ValueError(
                    f"Color inválido en '{rol}': '{valor}'. Se admite "
                    f"#rgb, #rrggbb, #rrggbbaa, rgb(), rgba(), hsl(), "
                    f"hsla(), transparent o currentColor."
                )
            limpia[rol] = valor.strip()
        colores[m] = limpia

    if not colores["light"] and not colores["dark"]:
        raise ValueError("Un tema sin ningún color no sirve de nada.")

    fuentes_brutas = bruto.get("fuentes") or {}
    if not isinstance(fuentes_brutas, dict):
        raise ValueError("'fuentes' tiene que ser un objeto.")
    fuentes: Dict[str, Dict[str, Any]] = {}
    for rol in ROLES_FUENTE:
        f = fuentes_brutas.get(rol)
        base = _FUENTES_POR_DEFECTO[rol]
        if not isinstance(f, dict):
            fuentes[rol] = dict(base)
            continue
        familia = (f.get("familia") or base["familia"]).strip()
        if not _RE_FAMILIA.match(familia):
            raise ValueError(
                f"Tipografía inválida en '{rol}': '{familia}'. Solo el nombre "
                f"de la familia y sus alternativas separadas por comas."
            )
        peso = int(_numero(f.get("peso"), f"fuentes.{rol}.peso",
                           100, 900, base["peso"]))
        if peso not in PESOS:
            raise ValueError(f"'fuentes.{rol}.peso' tiene que ser múltiplo de 100.")
        fuentes[rol] = {
            "familia": familia,
            "tamano": _numero(f.get("tamano"), f"fuentes.{rol}.tamano",
                              8, 96, base["tamano"]),
            "peso": peso,
            "interlineado": _numero(f.get("interlineado"),
                                    f"fuentes.{rol}.interlineado",
                                    0.8, 3, base["interlineado"]),
            "espaciado": _numero(f.get("espaciado"),
                                 f"fuentes.{rol}.espaciado",
                                 -2, 8, base.get("espaciado", 0)),
        }

    extras_brutos = bruto.get("extras") or []
    if not isinstance(extras_brutos, list) or len(extras_brutos) > 100:
        raise ValueError("'extras' tiene que ser una lista de como mucho 100.")
    extras: List[Dict[str, str]] = []
    for e in extras_brutos:
        if not isinstance(e, dict):
            raise ValueError("Cada entrada de 'extras' tiene que ser un objeto.")
        eid = _texto(e.get("id"), "extras.id", 40)
        if not _RE_ID_ROL.match(eid):
            raise ValueError(f"Id de color añadido inválido: '{eid}'.")
        extras.append({"id": eid, "nombre": _texto(e.get("nombre"),
                                                   "extras.nombre", 60)})

    return {
        "id": tid,
        "nombre": nombre,
        "modo_por_defecto": modo,
        "colores": colores,
        "fuentes": fuentes,
        "extras": extras,
        # Los dos temas de serie se marcan para que la interfaz no ofrezca
        # borrarlos; no es seguridad, es evitar dejar la instalación sin
        # ningún tema al que volver.
        "bloqueado": bool(bruto.get("bloqueado")),
    }


class TemaStore:
    """Lee y escribe `datos/temas.json`."""

    def __init__(self, carpeta: Optional[str] = None) -> None:
        self.ruta = carpeta_datos(carpeta) / FICHERO
        self._doc: dict = documento_inicial()
        self._lock_hilos = threading.Lock()
        self._lock_async = asyncio.Lock()
        self.cargar()

    # ------------------------------------------------------------------ #
    def cargar(self) -> None:
        """
        Lee el fichero. Si no existe se crea con los temas de serie; si está
        corrupto se avisa y se sigue con los de serie SIN tocar el fichero —
        pisarlo sería destruir la única copia de un tema que quizá se pueda
        recuperar a mano.
        """
        if not self.ruta.exists():
            self._doc = documento_inicial()
            self._escribir()
            logger.info("Creado %s con los temas de serie.", FICHERO)
            return
        try:
            bruto = json.loads(self.ruta.read_text("utf-8"))
            self._doc = self._normalizar(bruto)
            logger.info("TemaStore cargado: %d tema(s), activo '%s'.",
                        len(self._doc["temas"]), self._doc["activo"])
        except Exception as exc:  # noqa: BLE001
            logger.error(
                "%s ilegible (%s). Se usan los temas de serie; el fichero NO "
                "se sobrescribe.", FICHERO, exc
            )
            self._doc = documento_inicial()

    @staticmethod
    def _normalizar(bruto: Any) -> dict:
        if not isinstance(bruto, dict):
            raise ValueError("El fichero de temas no es un objeto.")
        temas: List[dict] = []
        vistos = set()
        for t in bruto.get("temas") or []:
            try:
                limpio = validar_tema(t)
            except ValueError as exc:
                logger.error("Tema descartado: %s", exc)
                continue
            if limpio["id"] in vistos:
                logger.error("Tema duplicado '%s'; se queda el primero.",
                             limpio["id"])
                continue
            vistos.add(limpio["id"])
            temas.append(limpio)

        if not temas:
            temas = [_tema_base(), _tema_alto_contraste()]

        activo = bruto.get("activo")
        if activo not in {t["id"] for t in temas}:
            activo = temas[0]["id"]

        try:
            version = max(1, int(bruto.get("version") or 1))
        except (TypeError, ValueError):
            version = 1

        return {
            "version": version,
            "actualizado_en": bruto.get("actualizado_en") or _ahora_iso(),
            "actualizado_por": bruto.get("actualizado_por") or "",
            "activo": activo,
            "temas": temas,
        }

    # ------------------------------------------------------------------ #
    def _escribir(self) -> None:
        """Escritura atómica. Asume lock tomado."""
        tmp = self.ruta.with_suffix(".json.tmp")
        tmp.write_text(
            json.dumps(self._doc, indent=2, ensure_ascii=False), encoding="utf-8"
        )
        tmp.replace(self.ruta)

    def _escribir_sync(self) -> None:
        with self._lock_hilos:
            self._escribir()

    async def _escribir_async(self) -> None:
        bucle = asyncio.get_running_loop()
        await bucle.run_in_executor(None, self._escribir_sync)

    # ------------------------------------------------------------------ #
    def obtener(self) -> dict:
        """El documento completo. Es pequeño: no hace falta paginarlo."""
        return self._doc

    async def guardar(self, temas: List[Any], activo: str,
                      version: Optional[int] = None,
                      usuario: str = "") -> dict:
        """
        Reemplaza la lista entera de temas.

        Se guarda todo de golpe y no tema a tema porque el Gestor de Temas
        edita varios a la vez (renombrar uno, duplicar otro, cambiar el
        activo) y partirlo en varias escrituras dejaría estados intermedios
        visibles para los demás clientes.

        `version=None` fuerza la escritura: es lo que manda el cliente tras
        ver un 409 y decidir quedarse con lo suyo.
        """
        if not isinstance(temas, list) or not temas:
            raise ValueError("Hace falta al menos un tema.")
        if len(temas) > 60:
            raise ValueError("Como mucho 60 temas.")

        limpios: List[dict] = []
        vistos = set()
        for t in temas:
            limpio = validar_tema(t)
            if limpio["id"] in vistos:
                raise ValueError(f"Hay dos temas con el id '{limpio['id']}'.")
            vistos.add(limpio["id"])
            limpios.append(limpio)

        if activo not in vistos:
            raise ValueError(
                f"El tema activo '{activo}' no está en la lista enviada."
            )

        async with self._lock_async:
            if version is not None and int(version) != int(self._doc["version"]):
                raise ConflictoDeVersion(int(version), int(self._doc["version"]))
            self._doc = {
                "version": int(self._doc["version"]) + 1,
                "actualizado_en": _ahora_iso(),
                "actualizado_por": usuario or "",
                "activo": activo,
                "temas": limpios,
            }
            await self._escribir_async()
            return self._doc

    async def restaurar(self, usuario: str = "") -> dict:
        """Vuelve a los temas de serie. Los personalizados se pierden."""
        async with self._lock_async:
            base = documento_inicial()
            base["version"] = int(self._doc["version"]) + 1
            base["actualizado_por"] = usuario or ""
            self._doc = base
            await self._escribir_async()
            return self._doc
