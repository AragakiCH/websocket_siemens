# -*- coding: utf-8 -*-
"""
tools.py
========
Catálogo de herramientas del agente, **derivado del OpenAPI en tiempo de
ejecución**.

Ésta es la decisión de diseño central de todo el módulo de IA:

    El agente NO tiene una lista de herramientas escrita a mano.
    Lee `app.openapi()` al arrancar y convierte cada endpoint en una
    herramienta, con su descripción y sus parámetros.

Consecuencia directa: **cuando añadas un endpoint nuevo, el agente lo sabe
usar sin tocar una línea de este módulo.** El `summary` y la `description`
que ya escribes para Swagger le sirven al modelo para entender cuándo usarlo.
Documentar bien el endpoint es, literalmente, entrenar al agente.

Modelo de permisos (por qué existe):
El agente puede equivocarse. Un `DELETE /plcs/{id}` mal interpretado deja la
planta sin monitorizar. Por eso cada herramienta se clasifica:

  ┌───────────┬──────────────────────────────┬──────────────────────────────┐
  │ LECTURA   │ GET, y POST que solo leen    │ Se ejecuta sin preguntar     │
  │ ESCRITURA │ POST/PUT/PATCH que modifican │ Requiere confirmación (salvo │
  │           │ y todos los DELETE           │ ai_permitir_escritura=true)  │
  │ PROHIBIDA │ Lista negra explícita        │ Nunca, ni con permiso        │
  └───────────┴──────────────────────────────┴──────────────────────────────┘

Las herramientas se ejecutan **en proceso**, llamando a la app ASGI con
`httpx.ASGITransport`: no hay salto de red ni puerto que abrir, y funciona
igual empaquetado en el .exe.
"""
from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple

import httpx

logger = logging.getLogger("ai_tools")

# --- Clasificación de riesgo ------------------------------------------ #
LECTURA = "lectura"
ESCRITURA = "escritura"
PROHIBIDA = "prohibida"

# POST que en realidad solo LEEN (no modifican estado del sistema).
# Son POST por comodidad (llevan cuerpo), no porque muten nada.
POST_DE_LECTURA = {
    "/db/{db_id}/preview",          # ejecuta un SELECT de prueba
    "/db/queries/{query_id}/run",   # ejecuta una consulta registrada
    "/rexroth/apps",                # explora un ctrlX (sesión temporal)
    "/rexroth/programs",
    "/export/consultas/{query_id}/excel",
}

# Nunca, bajo ningún concepto. Aunque se active ai_permitir_escritura.
# Motivo: son operaciones destructivas o de infraestructura que deben hacerse
# a mano, con una persona mirando.
RUTAS_PROHIBIDAS = {
    "/db/{db_id}",          # DELETE: borra conexión + consultas + históricos
    "/plcs/{plc_id}",       # DELETE: deja un PLC sin monitorizar
    "/db/{db_id}/esquema",  # crea tablas en una BD que puede ser ajena
}

# Endpoints que devuelven un fichero binario: al agente no le sirven (no puede
# leer un .xlsx), pero sí puede DECIRLE al usuario la URL para descargarlo.
RUTAS_BINARIAS = {
    "/export/grabaciones/{grabacion_id}/excel",
    "/export/historico/excel",
    "/export/consultas/{query_id}/excel",
}

# Tamaño máximo del resultado que se le devuelve al modelo. Un GET /tags con
# 500 tags reventaría la ventana de contexto y costaría un dineral.
MAX_CARACTERES_RESULTADO = 6000


@dataclass
class Herramienta:
    """Una herramienta ejecutable, derivada de un endpoint."""

    nombre: str                       # p.ej. "get_tags"
    metodo: str                       # GET | POST | DELETE...
    ruta: str                         # /tags, /plcs/{plc_id}...
    resumen: str = ""
    descripcion: str = ""
    riesgo: str = LECTURA
    parametros_query: List[dict] = field(default_factory=list)
    parametros_ruta: List[dict] = field(default_factory=list)
    cuerpo: Optional[dict] = None     # JSON Schema del body
    binaria: bool = False
    dominio: str = "General"          # tag de Swagger: agrupa el catálogo

    # ------------------------------------------------------------------ #
    def esquema_openai(self) -> dict:
        """
        Convierte la herramienta al formato de *function calling*.

        Se aplanan los tres orígenes de parámetros (ruta, query y cuerpo) en
        un único objeto: al modelo le resulta mucho más fácil rellenar un
        formulario plano que anidar `path`/`query`/`body`.
        """
        propiedades: Dict[str, Any] = {}
        obligatorios: List[str] = []

        for p in self.parametros_ruta + self.parametros_query:
            esquema = dict(p.get("schema") or {"type": "string"})
            esquema.pop("title", None)
            if p.get("description"):
                esquema["description"] = p["description"]
            propiedades[p["name"]] = esquema
            if p.get("required"):
                obligatorios.append(p["name"])

        if self.cuerpo:
            props_cuerpo = self.cuerpo.get("properties") or {}
            for nombre, esquema in props_cuerpo.items():
                limpio = dict(esquema)
                limpio.pop("title", None)
                propiedades[nombre] = limpio
            obligatorios.extend(self.cuerpo.get("required") or [])

        descripcion = self.resumen or self.nombre
        if self.descripcion:
            # La descripción larga de Swagger es justo lo que el modelo
            # necesita para decidir CUÁNDO usar la herramienta.
            descripcion += "\n\n" + _recortar(self.descripcion, 900)
        if self.riesgo == ESCRITURA:
            descripcion += ("\n\n[ACCIÓN QUE MODIFICA EL SISTEMA: requiere "
                            "confirmación del usuario antes de ejecutarse.]")
        if self.binaria:
            descripcion += ("\n\n[Devuelve un fichero. No lo puedes leer: "
                            "limítate a dar al usuario la URL de descarga.]")

        return {
            "type": "function",
            "function": {
                "name": self.nombre,
                "description": descripcion,
                "parameters": {
                    "type": "object",
                    "properties": propiedades,
                    "required": sorted(set(obligatorios)),
                },
            },
        }

    def resumen_corto(self) -> str:
        """Una línea para el catálogo que se muestra en el prompt."""
        return f"- `{self.nombre}` ({self.metodo} {self.ruta}): {self.resumen}"


def _recortar(texto: str, maximo: int) -> str:
    texto = re.sub(r"\n{3,}", "\n\n", (texto or "").strip())
    return texto if len(texto) <= maximo else texto[:maximo] + "…"


def _nombre_desde_ruta(metodo: str, ruta: str) -> str:
    """
    `GET /db/{db_id}/tablas` -> `get_db_tablas`.

    Nombre corto, estable y legible: el modelo lo usa para invocar.
    """
    partes = [p for p in ruta.strip("/").split("/") if p]
    limpias = []
    for p in partes:
        if p.startswith("{"):
            continue                       # los parámetros no van en el nombre
        limpias.append(re.sub(r"[^a-zA-Z0-9]+", "_", p).strip("_").lower())
    base = "_".join(x for x in limpias if x) or "raiz"
    return f"{metodo.lower()}_{base}"[:64]


class CatalogoHerramientas:
    """Construye y ejecuta las herramientas derivadas del OpenAPI."""

    def __init__(self, app, permitir_escritura: bool = False) -> None:
        self._app = app
        self.permitir_escritura = permitir_escritura
        self.herramientas: Dict[str, Herramienta] = {}
        self._construido = False

    # ================================================================== #
    # Construcción desde el OpenAPI
    # ================================================================== #
    def construir(self, incluir_ai: bool = False) -> int:
        """
        Recorre el OpenAPI y crea una herramienta por operación.

        Se puede llamar de nuevo en caliente para recoger endpoints añadidos
        sin reiniciar (`POST /ai/recargar`).
        """
        self.herramientas = {}
        try:
            spec = self._app.openapi()
        except Exception as exc:  # noqa: BLE001
            logger.error("No se pudo leer el OpenAPI: %s", exc)
            return 0

        componentes = (spec.get("components") or {}).get("schemas") or {}
        usados: Dict[str, int] = {}

        for ruta, operaciones in (spec.get("paths") or {}).items():
            # El agente no debe llamarse a sí mismo: bucle infinito asegurado.
            if not incluir_ai and ruta.startswith("/ai"):
                continue

            for metodo, op in operaciones.items():
                if metodo.lower() not in ("get", "post", "put", "patch", "delete"):
                    continue

                riesgo = self._clasificar(metodo, ruta)
                if riesgo == PROHIBIDA:
                    continue

                nombre = _nombre_desde_ruta(metodo, ruta)
                if nombre in usados:            # colisión: get_db / get_db_2
                    usados[nombre] += 1
                    nombre = f"{nombre}_{usados[nombre]}"
                else:
                    usados[nombre] = 1

                params = op.get("parameters") or []
                cuerpo = self._extraer_cuerpo(op, componentes)

                self.herramientas[nombre] = Herramienta(
                    nombre=nombre,
                    metodo=metodo.upper(),
                    ruta=ruta,
                    resumen=op.get("summary") or "",
                    descripcion=op.get("description") or "",
                    riesgo=riesgo,
                    parametros_query=[p for p in params if p.get("in") == "query"],
                    parametros_ruta=[p for p in params if p.get("in") == "path"],
                    cuerpo=cuerpo,
                    binaria=ruta in RUTAS_BINARIAS,
                    dominio=(op.get("tags") or ["General"])[0],
                )

        self._construido = True
        logger.info("Catálogo de IA construido: %d herramienta(s) desde el "
                    "OpenAPI.", len(self.herramientas))
        return len(self.herramientas)

    @staticmethod
    def _clasificar(metodo: str, ruta: str) -> str:
        """Riesgo de una operación: lectura, escritura o prohibida."""
        metodo = metodo.lower()
        if ruta in RUTAS_PROHIBIDAS and metodo == "delete":
            return PROHIBIDA
        if ruta in RUTAS_PROHIBIDAS and metodo in ("post", "put", "patch"):
            return PROHIBIDA
        if metodo == "get":
            return LECTURA
        if metodo == "post" and ruta in POST_DE_LECTURA:
            return LECTURA
        return ESCRITURA

    @staticmethod
    def _extraer_cuerpo(op: dict, componentes: dict) -> Optional[dict]:
        """Resuelve el `$ref` del requestBody a un JSON Schema plano."""
        rb = op.get("requestBody") or {}
        contenido = (rb.get("content") or {}).get("application/json") or {}
        esquema = contenido.get("schema") or {}

        ref = esquema.get("$ref")
        if ref and ref.startswith("#/components/schemas/"):
            esquema = componentes.get(ref.split("/")[-1], {})

        if esquema.get("type") == "object" or "properties" in esquema:
            return {
                "properties": esquema.get("properties") or {},
                "required": esquema.get("required") or [],
            }
        return None

    # ================================================================== #
    # Catálogo para el modelo
    # ================================================================== #
    def esquemas(self, solo_lectura: Optional[bool] = None) -> List[dict]:
        """Herramientas en formato function-calling."""
        if not self._construido:
            self.construir()
        solo = (not self.permitir_escritura) if solo_lectura is None else solo_lectura
        return [
            h.esquema_openai() for h in self.herramientas.values()
            if not (solo and h.riesgo == ESCRITURA)
        ]

    def catalogo_texto(self) -> str:
        """
        Catálogo agrupado por dominio, para el prompt del sistema.

        Se le da al modelo aunque también reciba los esquemas: ver la lista
        organizada por áreas le ayuda a orientarse antes de elegir.
        """
        if not self._construido:
            self.construir()

        por_dominio: Dict[str, List[Herramienta]] = {}
        for h in self.herramientas.values():
            por_dominio.setdefault(h.dominio, []).append(h)

        lineas: List[str] = []
        for dominio in sorted(por_dominio):
            lineas.append(f"\n### {dominio}")
            for h in sorted(por_dominio[dominio], key=lambda x: x.nombre):
                marca = " ⚠️" if h.riesgo == ESCRITURA else ""
                lineas.append(h.resumen_corto() + marca)
        return "\n".join(lineas)

    def obtener(self, nombre: str) -> Optional[Herramienta]:
        return self.herramientas.get(nombre)

    def estado(self) -> dict:
        if not self._construido:
            self.construir()
        por_riesgo: Dict[str, int] = {}
        for h in self.herramientas.values():
            por_riesgo[h.riesgo] = por_riesgo.get(h.riesgo, 0) + 1
        return {
            "num_herramientas": len(self.herramientas),
            "por_riesgo": por_riesgo,
            "escritura_permitida": self.permitir_escritura,
            "dominios": sorted({h.dominio for h in self.herramientas.values()}),
        }

    # ================================================================== #
    # Ejecución
    # ================================================================== #
    async def ejecutar(
        self, nombre: str, argumentos: Dict[str, Any]
    ) -> Tuple[bool, str]:
        """
        Ejecuta una herramienta contra la propia app y devuelve
        `(ok, resultado_en_texto)` listo para dárselo al modelo.

        Los errores NO se lanzan: se devuelven como texto para que el agente
        pueda leerlos y corregir el tiro (probar otro parámetro, avisar al
        usuario...). Es la diferencia entre un agente que se recupera y uno
        que se cae.
        """
        herramienta = self.obtener(nombre)
        if herramienta is None:
            return False, (f"La herramienta '{nombre}' no existe. Usa solo las "
                           f"del catálogo.")

        if herramienta.riesgo == ESCRITURA and not self.permitir_escritura:
            return False, (
                f"'{nombre}' modifica el sistema y la escritura está "
                f"desactivada. Explica al usuario qué harías y con qué "
                f"parámetros, y que lo confirme él desde la vista o Swagger."
            )

        argumentos = argumentos or {}

        # 1) Sustituir los parámetros de la ruta.
        ruta = herramienta.ruta
        consumidos = set()
        for p in herramienta.parametros_ruta:
            nombre_p = p["name"]
            if nombre_p not in argumentos:
                return False, (f"Falta el parámetro obligatorio '{nombre_p}' "
                               f"para '{nombre}'.")
            ruta = ruta.replace("{" + nombre_p + "}",
                                str(argumentos[nombre_p]))
            consumidos.add(nombre_p)

        # 2) Query params.
        query = {
            p["name"]: argumentos[p["name"]]
            for p in herramienta.parametros_query
            if p["name"] in argumentos and argumentos[p["name"]] is not None
        }
        consumidos.update(query.keys())

        # 3) El resto va al cuerpo.
        cuerpo = {k: v for k, v in argumentos.items() if k not in consumidos}

        try:
            transporte = httpx.ASGITransport(app=self._app)
            async with httpx.AsyncClient(transport=transporte,
                                         base_url="http://interno",
                                         timeout=120.0) as cli:
                if herramienta.metodo == "GET":
                    r = await cli.get(ruta, params=query)
                elif herramienta.metodo == "DELETE":
                    r = await cli.delete(ruta, params=query)
                else:
                    r = await cli.request(herramienta.metodo, ruta,
                                          params=query,
                                          json=cuerpo if cuerpo else {})
        except Exception as exc:  # noqa: BLE001
            logger.warning("Fallo ejecutando '%s': %s", nombre, exc)
            return False, f"Error ejecutando '{nombre}': {exc}"

        return self._formatear(herramienta, r)

    @staticmethod
    def _formatear(herramienta: Herramienta,
                   r: httpx.Response) -> Tuple[bool, str]:
        """Convierte la respuesta HTTP en texto útil para el modelo."""
        if herramienta.binaria and r.status_code == 200:
            # El modelo no puede leer un .xlsx: se le da la URL.
            return True, json.dumps({
                "ok": True,
                "tipo": "fichero",
                "bytes": len(r.content),
                "url_descarga": str(r.request.url).replace(
                    "http://interno", ""),
                "nota": "Fichero Excel generado. Da al usuario esta URL para "
                        "que lo descargue; no intentes leer su contenido.",
            }, ensure_ascii=False)

        try:
            datos = r.json()
            texto = json.dumps(datos, ensure_ascii=False, indent=1,
                               default=str)
        except Exception:  # noqa: BLE001
            texto = r.text

        if len(texto) > MAX_CARACTERES_RESULTADO:
            texto = (texto[:MAX_CARACTERES_RESULTADO] +
                     f"\n… [resultado recortado: {len(texto)} caracteres en "
                     f"total. Si necesitas más, filtra la consulta o usa un "
                     f"límite más bajo.]")

        # 4xx no es un fallo del agente: es información. Se marca ok=False para
        # que el modelo sepa que debe corregir, pero se le da el cuerpo entero.
        return (200 <= r.status_code < 300), texto
