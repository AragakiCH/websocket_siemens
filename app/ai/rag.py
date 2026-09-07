# -*- coding: utf-8 -*-
"""
rag.py
======
Sistema RAG (Retrieval-Augmented Generation) del asistente.

El agente no lleva el proyecto "aprendido": lo consulta. Antes de responder,
se recuperan los fragmentos relevantes y se le inyectan como contexto. Así,
cuando cambies la documentación o añadas una tabla, el asistente responde con
lo nuevo sin reentrenar nada.

**Tres fuentes, deliberadamente distintas:**

  1. ESTÁTICA — `docs/*.md` y `README.md`, troceados por sección. Es el
     "manual": explica cómo funciona cada parte y por qué.
  2. VIVA — estado actual del sistema: PLCs conectados, tags con su valor,
     conexiones a BD, grupos de historización. Se recalcula en cada consulta
     porque cambia por segundos.
  3. ESQUEMA — tablas y columnas reales de las bases de datos conectadas.
     Es lo que permite que el agente escriba SQL correcto contra TUS tablas,
     no contra las que se imagina.

**Por qué BM25 y no embeddings:**
BM25 es recuperación léxica clásica (el mismo algoritmo que usa Elasticsearch
por defecto). Ventajas aquí: cero dependencias, cero latencia, cero coste, y
funciona sin conexión. Con un corpus de ~1.700 líneas de documentación técnica
donde los términos son muy específicos (`historizador`, `banda_muerta`,
`ctrlX`, `plc_prg`), lo léxico funciona igual o mejor que lo semántico: el
usuario pregunta con las mismas palabras que están escritas en los docs.

Si algún día el corpus crece mucho o se quiere buscar por significado, el
punto de extensión es `Recuperador.buscar()`: se le puede enchufar un índice
vectorial sin tocar nada más.
"""
from __future__ import annotations

import logging
import math
import re
import unicodedata
from collections import Counter
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

logger = logging.getLogger("ai_rag")

# Palabras vacías del español (y algunas del inglés que salen en los docs).
VACIAS = {
    "el", "la", "los", "las", "un", "una", "unos", "unas", "de", "del", "al",
    "a", "en", "y", "o", "que", "se", "por", "para", "con", "sin", "su", "sus",
    "es", "son", "ser", "está", "están", "lo", "le", "les", "me", "mi", "te",
    "tu", "como", "más", "pero", "si", "no", "ya", "muy", "este", "esta",
    "esto", "esa", "ese", "eso", "cuando", "donde", "the", "of", "to", "and",
    "in", "is", "it", "for", "on", "with", "as",
}

# Tamaño objetivo de cada fragmento. Suficiente para una sección con contexto,
# sin comerse la ventana del modelo.
MAX_CARACTERES_FRAGMENTO = 1800


def normalizar(texto: str) -> List[str]:
    """
    Tokeniza: minúsculas, sin acentos, sin palabras vacías.

    Quitar acentos importa: el usuario escribe "historizacion" tanto como
    "historización", y ambas deben casar con el documento.
    """
    texto = unicodedata.normalize("NFKD", (texto or "").lower())
    texto = "".join(c for c in texto if not unicodedata.combining(c))
    tokens = re.findall(r"[a-z0-9_]{2,}", texto)
    return [t for t in tokens if t not in VACIAS]


@dataclass
class Fragmento:
    """Un trozo de documentación indexable."""

    id: str
    titulo: str
    texto: str
    fuente: str                  # fichero o "sistema"
    tipo: str = "doc"            # doc | esquema | estado
    tokens: List[str] = None     # type: ignore[assignment]

    def __post_init__(self) -> None:
        if self.tokens is None:
            # Se indexa el título además del cuerpo: el título suele llevar
            # justo el término que el usuario busca.
            self.tokens = normalizar(self.titulo + " " + self.texto)

    def render(self) -> str:
        return f"### {self.titulo}\n_(fuente: {self.fuente})_\n\n{self.texto}"


# ====================================================================== #
# Troceado de Markdown
# ====================================================================== #
def trocear_markdown(contenido: str, fuente: str) -> List[Fragmento]:
    """
    Trocea un `.md` por encabezados, conservando la jerarquía en el título.

    Se trocea por secciones y no por número fijo de caracteres a propósito:
    una sección es una unidad con sentido completo. Cortar a ciegas cada 500
    caracteres parte tablas y ejemplos por la mitad, y el modelo recibe
    fragmentos inservibles.
    """
    fragmentos: List[Fragmento] = []
    jerarquia: Dict[int, str] = {}
    titulo_actual = fuente
    buffer: List[str] = []
    n = 0

    def volcar() -> None:
        nonlocal buffer, n
        texto = "\n".join(buffer).strip()
        if len(texto) < 40:                 # secciones vacías o de una línea
            buffer = []
            return
        # Si la sección es enorme, se parte por párrafos respetando el límite.
        for trozo in _partir(texto, MAX_CARACTERES_FRAGMENTO):
            n += 1
            fragmentos.append(Fragmento(
                id=f"{fuente}#{n}", titulo=titulo_actual,
                texto=trozo, fuente=fuente, tipo="doc",
            ))
        buffer = []

    for linea in contenido.splitlines():
        m = re.match(r"^(#{1,4})\s+(.*)", linea)
        if m:
            volcar()
            nivel, titulo = len(m.group(1)), m.group(2).strip()
            jerarquia[nivel] = titulo
            for k in list(jerarquia):
                if k > nivel:
                    del jerarquia[k]
            # "API_DB.md › 4. Historizador › Esquema de la tabla"
            titulo_actual = " › ".join(
                [fuente] + [jerarquia[k] for k in sorted(jerarquia)])
        else:
            buffer.append(linea)
    volcar()
    return fragmentos


def _partir(texto: str, maximo: int) -> List[str]:
    """Parte por párrafos sin superar `maximo`, sin romper bloques de código."""
    if len(texto) <= maximo:
        return [texto]
    trozos, actual = [], []
    largo = 0
    for parrafo in texto.split("\n\n"):
        if largo + len(parrafo) > maximo and actual:
            trozos.append("\n\n".join(actual))
            actual, largo = [], 0
        actual.append(parrafo)
        largo += len(parrafo) + 2
    if actual:
        trozos.append("\n\n".join(actual))
    return trozos


# ====================================================================== #
# Recuperador BM25
# ====================================================================== #
class Recuperador:
    """Índice invertido con puntuación BM25."""

    K1 = 1.5      # saturación por frecuencia del término
    B = 0.75      # penalización por longitud del documento

    def __init__(self) -> None:
        self.fragmentos: List[Fragmento] = []
        self._df: Counter = Counter()      # en cuántos fragmentos sale cada token
        self._largo_medio: float = 1.0

    def indexar(self, fragmentos: List[Fragmento]) -> None:
        self.fragmentos = fragmentos
        self._df = Counter()
        for f in fragmentos:
            for token in set(f.tokens):
                self._df[token] += 1
        largos = [len(f.tokens) for f in fragmentos] or [1]
        self._largo_medio = sum(largos) / len(largos)
        logger.info("RAG indexado: %d fragmento(s), %d término(s) únicos.",
                    len(fragmentos), len(self._df))

    def buscar(self, consulta: str, k: int = 6) -> List[Tuple[Fragmento, float]]:
        """Devuelve los `k` fragmentos más relevantes con su puntuación."""
        if not self.fragmentos:
            return []
        tokens = normalizar(consulta)
        if not tokens:
            return []

        n = len(self.fragmentos)
        puntuaciones: List[Tuple[Fragmento, float]] = []

        for f in self.fragmentos:
            frecuencias = Counter(f.tokens)
            largo = len(f.tokens) or 1
            score = 0.0
            for token in tokens:
                tf = frecuencias.get(token, 0)
                if not tf:
                    continue
                df = self._df.get(token, 0) or 1
                # IDF suavizado (Robertson): términos raros pesan más.
                idf = math.log(1 + (n - df + 0.5) / (df + 0.5))
                denom = tf + self.K1 * (
                    1 - self.B + self.B * largo / self._largo_medio)
                score += idf * (tf * (self.K1 + 1)) / denom
            if score > 0:
                puntuaciones.append((f, score))

        puntuaciones.sort(key=lambda x: x[1], reverse=True)
        return puntuaciones[:k]


# ====================================================================== #
# Motor RAG
# ====================================================================== #
class MotorRag:
    """Une las tres fuentes y arma el contexto que se le pasa al modelo."""

    def __init__(self, raiz: Optional[str] = None) -> None:
        self.raiz = Path(raiz) if raiz else self._raiz_recursos()
        self.recuperador = Recuperador()
        self.ficheros_indexados: List[str] = []

    @staticmethod
    def _raiz_recursos() -> Path:
        """
        Carpeta donde buscar `docs/` y `README.md`.

        Empaquetado con PyInstaller los recursos van dentro del bundle, no
        junto al .exe: hay que preguntarle a `sys._MEIPASS` dónde los
        descomprimió. Sin esto, el asistente arrancaría sin documentación en
        la versión instalada y solo funcionaría desde el código fuente.
        """
        import sys
        if getattr(sys, "frozen", False):
            base = getattr(sys, "_MEIPASS", None)
            if base:
                return Path(base)
        return Path(__file__).resolve().parents[2]

    # ------------------------------------------------------------------ #
    # 1) Corpus estático
    # ------------------------------------------------------------------ #
    def indexar_documentacion(self) -> int:
        """Indexa `docs/*.md` y `README.md`. Recargable en caliente."""
        fragmentos: List[Fragmento] = []
        self.ficheros_indexados = []

        rutas = sorted((self.raiz / "docs").glob("*.md")) if \
            (self.raiz / "docs").is_dir() else []
        readme = self.raiz / "README.md"
        if readme.is_file():
            rutas.append(readme)

        for ruta in rutas:
            try:
                contenido = ruta.read_text(encoding="utf-8")
            except Exception as exc:  # noqa: BLE001
                logger.warning("No se pudo leer %s: %s", ruta.name, exc)
                continue
            trozos = trocear_markdown(contenido, ruta.name)
            fragmentos.extend(trozos)
            self.ficheros_indexados.append(f"{ruta.name} ({len(trozos)})")

        self.recuperador.indexar(fragmentos)
        return len(fragmentos)

    # ------------------------------------------------------------------ #
    # 2) Contexto vivo
    # ------------------------------------------------------------------ #
    @staticmethod
    def contexto_vivo(app) -> str:
        """
        Foto del estado actual del sistema, en texto compacto.

        Va SIEMPRE en el prompt (no se recupera por relevancia) porque casi
        cualquier pregunta necesita saber qué hay conectado ahora mismo. Es
        barato: son unas pocas líneas.
        """
        partes: List[str] = []

        # --- PLCs ---
        try:
            salud = app.state.plc_manager.get_health()
            if salud["num_plcs"]:
                lineas = [
                    f"- {p.get('plc')} ({p.get('vendor', '?')}): "
                    f"{p.get('estado_conexion')}, {p.get('num_tags', 0)} tags"
                    for p in salud.get("plcs", [])
                ]
                partes.append(
                    f"**PLCs** ({salud['plcs_conectados']}/{salud['num_plcs']} "
                    f"conectados):\n" + "\n".join(lineas))
            else:
                partes.append("**PLCs**: ninguno dado de alta ahora mismo.")
        except Exception as exc:  # noqa: BLE001
            partes.append(f"**PLCs**: no disponible ({exc}).")

        # --- Tags (muestra, no todos: pueden ser cientos) ---
        try:
            tags = app.state.plc_manager.get_tags()
            if tags:
                muestra = [
                    f"  - {t.get('plc')}|{t.get('tag')} = {t.get('value')} "
                    f"({t.get('type')})" for t in tags[:12]
                ]
                extra = (f"\n  … y {len(tags) - 12} más (usa `get_tags` para "
                         f"la lista completa)") if len(tags) > 12 else ""
                partes.append(f"**Tags disponibles** ({len(tags)}):\n"
                              + "\n".join(muestra) + extra)
        except Exception:  # noqa: BLE001
            pass

        # --- Bases de datos ---
        try:
            conexiones = app.state.db_manager.listar_conexiones()
            if conexiones:
                lineas = [
                    f"- `{c['db_id']}` ({c.get('etiqueta_motor', c['motor'])}): "
                    f"{'conectada' if c['conectado'] else 'DESCONECTADA'}, "
                    f"{c.get('num_consultas', 0)} consulta(s)"
                    for c in conexiones
                ]
                partes.append("**Bases de datos**:\n" + "\n".join(lineas))
            else:
                partes.append("**Bases de datos**: ninguna conectada.")
        except Exception:  # noqa: BLE001
            pass

        # --- Historizador ---
        try:
            est = app.state.historizador.estado()
            if est["num_grupos"]:
                lineas = [
                    f"- `{g['grupo_id']}` -> tabla `{g['tabla']}` en "
                    f"`{g['db_id']}`: {'activo' if g['activo'] else 'parado'}, "
                    f"{g['filas_escritas']} filas escritas"
                    for g in est.get("grupos", [])
                ]
                partes.append("**Historización**:\n" + "\n".join(lineas))
        except Exception:  # noqa: BLE001
            pass

        # --- Grabaciones ---
        try:
            gr = app.state.grabador.listar()
            if gr["num_grabaciones"]:
                partes.append(
                    f"**Grabaciones**: {gr['num_grabaciones']} "
                    f"({gr['en_curso']} en curso).")
        except Exception:  # noqa: BLE001
            pass

        return "\n\n".join(partes) if partes else "Sin información de estado."

    # ------------------------------------------------------------------ #
    # 3) Esquema real de las bases de datos
    # ------------------------------------------------------------------ #
    @staticmethod
    async def contexto_esquema(app, max_tablas: int = 12) -> str:
        """
        Tablas y columnas REALES de las conexiones activas.

        Sin esto, el agente escribiría SQL inventado. Con esto, escribe contra
        las columnas que existen de verdad. Es la diferencia entre una consulta
        que funciona y una que da error de columna desconocida.
        """
        try:
            db = app.state.db_manager
        except Exception:  # noqa: BLE001
            return ""

        bloques: List[str] = []
        for conexion in db.listar_conexiones():
            if not conexion.get("conectado"):
                continue
            db_id = conexion["db_id"]
            try:
                res = await db.tablas(db_id)
                tablas = (res.get("tablas") or [])[:max_tablas]
            except Exception:  # noqa: BLE001
                continue
            if not tablas:
                continue

            lineas = [f"**Conexión `{db_id}`** "
                      f"({conexion.get('etiqueta_motor', '')}):"]
            for tabla in tablas:
                try:
                    cols = (await db.columnas(db_id, tabla)).get("columnas") or []
                    firma = ", ".join(f"{c['nombre']} {c['tipo']}"
                                      for c in cols[:14])
                    if len(cols) > 14:
                        firma += f", … (+{len(cols) - 14})"
                    lineas.append(f"- `{tabla}`: {firma}")
                except Exception:  # noqa: BLE001
                    lineas.append(f"- `{tabla}`")
            bloques.append("\n".join(lineas))

        return "\n\n".join(bloques)

    # ------------------------------------------------------------------ #
    # Recuperación
    # ------------------------------------------------------------------ #
    def recuperar(self, consulta: str, k: int = 6) -> Tuple[str, List[dict]]:
        """
        Devuelve `(contexto_en_texto, citas)` para la pregunta dada.

        Las citas se devuelven aparte para que la vista pueda mostrar
        "según docs/API_DB.md › Historizador", que es lo que hace que el
        usuario se fíe de la respuesta.
        """
        resultados = self.recuperador.buscar(consulta, k)
        if not resultados:
            return "", []

        bloques, citas = [], []
        for fragmento, score in resultados:
            bloques.append(fragmento.render())
            citas.append({
                "titulo": fragmento.titulo,
                "fuente": fragmento.fuente,
                "relevancia": round(score, 2),
            })
        return "\n\n---\n\n".join(bloques), citas

    def estado(self) -> dict:
        return {
            "fragmentos_indexados": len(self.recuperador.fragmentos),
            "terminos_unicos": len(self.recuperador._df),
            "ficheros": self.ficheros_indexados,
            "algoritmo": "BM25 (recuperación léxica, sin dependencias)",
        }
