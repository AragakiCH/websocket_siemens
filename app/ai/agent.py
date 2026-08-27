# -*- coding: utf-8 -*-
"""
agent.py
========
El agente: bucle de razonamiento con herramientas.

    pregunta
       │
       ├─► RAG: recupera documentación relevante
       ├─► Estado vivo + esquema de BD
       ├─► Monta el system prompt segmentado
       ▼
    ┌─────────────────────────────────────────┐
    │  modelo                                  │
    │    ├─ ¿quiere usar una herramienta?      │
    │    │     sí → se ejecuta → observación ──┼──┐ (repetir, máx. N pasos)
    │    │     no → respuesta final            │  │
    └─────────────────────────────────────────┘  │
                       ▲                          │
                       └──────────────────────────┘

Decisiones que conviene entender antes de tocar esto:

* **Límite de pasos** (`ai_max_pasos`). Sin él, un modelo puede quedarse
  llamando herramientas en bucle: cuelga la petición y dispara el gasto. Al
  llegar al límite se le pide que responda con lo que tenga.

* **Los errores de herramienta se le devuelven al modelo**, no se lanzan. Un
  agente que ve "falta el parámetro grupo_id" puede corregir y reintentar;
  uno al que le ocultas el error, no.

* **Sesiones con historial acotado.** Se conservan los últimos N mensajes:
  suficiente para seguir el hilo, sin que el contexto (y el coste) crezcan
  sin control.

* **La respuesta incluye la traza** de qué herramientas se usaron y qué
  documentación se citó. En un entorno industrial, una respuesta sin
  trazabilidad no vale: hay que poder auditar de dónde salió el dato.
"""
from __future__ import annotations

import json
import logging
import time
import uuid
from collections import deque
from typing import Any, AsyncIterator, Deque, Dict, List, Optional

from app.ai.llm_client import LlmClient, LlmError
from app.ai.prompts import construir_system_prompt
from app.ai.rag import MotorRag
from app.ai.tools import CatalogoHerramientas

logger = logging.getLogger("ai_agent")


class Sesion:
    """Una conversación con su historial."""

    def __init__(self, sesion_id: str, maximo: int = 20) -> None:
        self.sesion_id = sesion_id
        self.mensajes: Deque[dict] = deque(maxlen=maximo)
        self.creada = time.time()
        self.ultima = time.time()
        self.num_preguntas = 0

    def añadir(self, mensaje: dict) -> None:
        self.mensajes.append(mensaje)
        self.ultima = time.time()

    def historial(self) -> List[dict]:
        return list(self.mensajes)

    def resumen(self) -> dict:
        return {
            "sesion_id": self.sesion_id,
            "num_mensajes": len(self.mensajes),
            "num_preguntas": self.num_preguntas,
            "creada": self.creada,
            "ultima_actividad": self.ultima,
        }


class Agente:
    """Orquesta LLM + herramientas + RAG."""

    def __init__(self, app, settings) -> None:
        self._app = app
        self._s = settings
        self.llm = LlmClient(
            base_url=settings.ai_base_url,
            api_key=settings.ai_api_key,
            model=settings.ai_model,
            max_tokens=settings.ai_max_tokens,
            temperature=settings.ai_temperature,
            timeout_s=settings.ai_timeout_s,
        )
        self.catalogo = CatalogoHerramientas(
            app, permitir_escritura=settings.ai_permitir_escritura)
        self.rag = MotorRag()
        self.sesiones: Dict[str, Sesion] = {}

    # ================================================================== #
    # Ciclo de vida
    # ================================================================== #
    def iniciar(self) -> dict:
        """Construye el catálogo e indexa la documentación."""
        n_tools = self.catalogo.construir()
        n_frag = self.rag.indexar_documentacion()
        logger.info("Agente listo: %d herramienta(s), %d fragmento(s) RAG.",
                    n_tools, n_frag)
        return {"herramientas": n_tools, "fragmentos": n_frag}

    def recargar(self) -> dict:
        """
        Re-lee el OpenAPI y la documentación **sin reiniciar el servicio**.

        Es lo que hace que el agente se adapte a funciones nuevas: añades un
        endpoint, llamas a esto, y ya sabe usarlo.
        """
        resultado = self.iniciar()
        resultado["mensaje"] = (
            f"Agente recargado: {resultado['herramientas']} herramienta(s) "
            f"y {resultado['fragmentos']} fragmento(s) de documentación.")
        return resultado

    def sesion(self, sesion_id: Optional[str]) -> Sesion:
        sid = sesion_id or uuid.uuid4().hex[:12]
        if sid not in self.sesiones:
            self.sesiones[sid] = Sesion(sid, self._s.ai_historial_max)
        return self.sesiones[sid]

    def borrar_sesion(self, sesion_id: str) -> bool:
        return self.sesiones.pop(sesion_id, None) is not None

    # ================================================================== #
    # Contexto
    # ================================================================== #
    async def _preparar_contexto(self, pregunta: str) -> tuple:
        """Recupera documentación + estado vivo + esquema, y monta el prompt."""
        documentacion, citas = self.rag.recuperar(
            pregunta, self._s.ai_rag_fragmentos)

        estado = ""
        esquema = ""
        try:
            estado = self.rag.contexto_vivo(self._app)
        except Exception as exc:  # noqa: BLE001
            logger.debug("Sin estado vivo: %s", exc)
        try:
            esquema = await self.rag.contexto_esquema(self._app)
        except Exception as exc:  # noqa: BLE001
            logger.debug("Sin esquema de BD: %s", exc)

        system = construir_system_prompt(
            catalogo_texto=self.catalogo.catalogo_texto(),
            estado_vivo=estado,
            esquema_bd=esquema,
            documentacion=documentacion,
            permitir_escritura=self.catalogo.permitir_escritura,
        )
        return system, citas

    # ================================================================== #
    # Pregunta (respuesta completa)
    # ================================================================== #
    async def preguntar(
        self,
        pregunta: str,
        sesion_id: Optional[str] = None,
        modelo: Optional[str] = None,
    ) -> dict:
        """
        Ejecuta el ciclo completo y devuelve la respuesta con su traza.
        """
        inicio = time.perf_counter()
        sesion = self.sesion(sesion_id)
        sesion.num_preguntas += 1

        try:
            system, citas = await self._preparar_contexto(pregunta)
        except Exception as exc:  # noqa: BLE001
            return {"ok": False, "sesion_id": sesion.sesion_id,
                    "mensaje": f"Error preparando el contexto: {exc}"}

        mensajes: List[dict] = [{"role": "system", "content": system}]
        mensajes.extend(sesion.historial())
        mensajes.append({"role": "user", "content": pregunta})

        herramientas = self.catalogo.esquemas()
        traza: List[dict] = []

        for paso in range(self._s.ai_max_pasos):
            try:
                respuesta = await self.llm.chat(mensajes, herramientas, modelo)
            except LlmError as exc:
                return {"ok": False, "sesion_id": sesion.sesion_id,
                        "mensaje": str(exc), "traza": traza}

            llamadas = respuesta.get("tool_calls") or []
            if not llamadas:
                # El modelo ha terminado: esta es la respuesta final.
                texto = (respuesta.get("content") or "").strip()
                sesion.añadir({"role": "user", "content": pregunta})
                sesion.añadir({"role": "assistant", "content": texto})
                return {
                    "ok": True,
                    "sesion_id": sesion.sesion_id,
                    "respuesta": texto,
                    "modelo": modelo or self.llm.model,
                    "pasos": paso + 1,
                    "traza": traza,
                    "citas": citas,
                    "ms": round((time.perf_counter() - inicio) * 1000, 1),
                }

            # El modelo pide herramientas: se ejecutan y se le devuelven.
            mensajes.append(respuesta)
            for llamada in llamadas:
                registro = await self._ejecutar_llamada(llamada)
                traza.append(registro)
                mensajes.append({
                    "role": "tool",
                    "tool_call_id": llamada.get("id", ""),
                    "content": registro["resultado"],
                })

        # Se agotaron los pasos: se pide un cierre con lo que haya.
        mensajes.append({
            "role": "user",
            "content": ("Has alcanzado el límite de pasos. Responde ahora con "
                        "la información que ya tienes, e indica qué te faltó "
                        "por comprobar."),
        })
        try:
            final = await self.llm.chat(mensajes, None, modelo)
            texto = (final.get("content") or "").strip()
        except LlmError as exc:
            texto = f"No se pudo cerrar la respuesta: {exc}"

        sesion.añadir({"role": "user", "content": pregunta})
        sesion.añadir({"role": "assistant", "content": texto})
        return {
            "ok": True, "sesion_id": sesion.sesion_id, "respuesta": texto,
            "modelo": modelo or self.llm.model, "pasos": self._s.ai_max_pasos,
            "limite_alcanzado": True, "traza": traza, "citas": citas,
            "ms": round((time.perf_counter() - inicio) * 1000, 1),
        }

    # ------------------------------------------------------------------ #
    async def _ejecutar_llamada(self, llamada: dict) -> dict:
        """Ejecuta una tool_call y devuelve su registro para la traza."""
        fn = llamada.get("function") or {}
        nombre = fn.get("name", "")
        crudo = fn.get("arguments") or "{}"

        try:
            argumentos = json.loads(crudo) if isinstance(crudo, str) else crudo
        except json.JSONDecodeError:
            return {
                "herramienta": nombre, "argumentos": {}, "ok": False,
                "resultado": (f"Los argumentos no son JSON válido: {crudo[:200]}. "
                              f"Vuelve a llamar a la herramienta con JSON bien "
                              f"formado."),
                "ms": 0.0,
            }

        t0 = time.perf_counter()
        ok, resultado = await self.catalogo.ejecutar(nombre, argumentos)
        ms = round((time.perf_counter() - t0) * 1000, 1)

        logger.info("Herramienta '%s' -> %s (%.0f ms)", nombre,
                    "ok" if ok else "error", ms)
        return {"herramienta": nombre, "argumentos": argumentos, "ok": ok,
                "resultado": resultado, "ms": ms}

    # ================================================================== #
    # Pregunta en streaming (para el WebSocket)
    # ================================================================== #
    async def preguntar_stream(
        self,
        pregunta: str,
        sesion_id: Optional[str] = None,
        modelo: Optional[str] = None,
    ) -> AsyncIterator[dict]:
        """
        Igual que `preguntar()`, pero emitiendo eventos según ocurren.

        Eventos: `inicio`, `citas`, `herramienta`, `texto`, `fin`, `error`.
        La vista los usa para mostrar "consultando get_tags…" mientras el
        modelo trabaja, en vez de una ruleta muda.
        """
        inicio = time.perf_counter()
        sesion = self.sesion(sesion_id)
        sesion.num_preguntas += 1
        yield {"tipo": "inicio", "sesion_id": sesion.sesion_id,
               "modelo": modelo or self.llm.model}

        try:
            system, citas = await self._preparar_contexto(pregunta)
        except Exception as exc:  # noqa: BLE001
            yield {"tipo": "error", "mensaje": f"Error de contexto: {exc}"}
            return
        yield {"tipo": "citas", "citas": citas}

        mensajes: List[dict] = [{"role": "system", "content": system}]
        mensajes.extend(sesion.historial())
        mensajes.append({"role": "user", "content": pregunta})

        herramientas = self.catalogo.esquemas()
        traza: List[dict] = []
        texto_final = ""

        for paso in range(self._s.ai_max_pasos):
            mensaje_completo: Optional[dict] = None
            try:
                async for evento in self.llm.chat_stream(
                        mensajes, herramientas, modelo):
                    if evento["tipo"] == "texto":
                        yield {"tipo": "texto", "texto": evento["texto"]}
                    elif evento["tipo"] == "fin":
                        mensaje_completo = evento["mensaje"]
            except LlmError as exc:
                yield {"tipo": "error", "mensaje": str(exc)}
                return

            if mensaje_completo is None:
                yield {"tipo": "error", "mensaje": "El modelo no devolvió nada."}
                return

            llamadas = mensaje_completo.get("tool_calls") or []
            if not llamadas:
                texto_final = (mensaje_completo.get("content") or "").strip()
                break

            mensajes.append(mensaje_completo)
            for llamada in llamadas:
                fn = (llamada.get("function") or {}).get("name", "")
                yield {"tipo": "herramienta", "estado": "ejecutando",
                       "herramienta": fn}
                registro = await self._ejecutar_llamada(llamada)
                traza.append(registro)
                yield {"tipo": "herramienta", "estado": "hecho",
                       "herramienta": registro["herramienta"],
                       "ok": registro["ok"], "ms": registro["ms"],
                       "argumentos": registro["argumentos"]}
                mensajes.append({
                    "role": "tool",
                    "tool_call_id": llamada.get("id", ""),
                    "content": registro["resultado"],
                })

        sesion.añadir({"role": "user", "content": pregunta})
        sesion.añadir({"role": "assistant", "content": texto_final})
        yield {
            "tipo": "fin", "sesion_id": sesion.sesion_id,
            "respuesta": texto_final, "traza": traza, "citas": citas,
            "ms": round((time.perf_counter() - inicio) * 1000, 1),
        }

    # ================================================================== #
    async def estado(self, comprobar_modelo: bool = False) -> dict:
        """Diagnóstico para la vista: qué hay listo y qué falta."""
        salida = {
            "activo": True,
            "modelo": self.llm.model,
            "modelos_disponibles": self._s.ai_models,
            "proveedor": self.llm.base_url,
            "api_key_configurada": bool(self.llm.api_key),
            "soporta_herramientas": self.llm.soporta_herramientas(),
            "max_pasos": self._s.ai_max_pasos,
            "sesiones_activas": len(self.sesiones),
            "herramientas": self.catalogo.estado(),
            "rag": self.rag.estado(),
        }
        if comprobar_modelo:
            salida["comprobacion"] = await self.llm.comprobar()
        return salida
