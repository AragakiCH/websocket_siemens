# -*- coding: utf-8 -*-
"""
llm_client.py
=============
Cliente para modelos de **Ollama Cloud** (ollama.com).

Ollama Cloud expone una API compatible con OpenAI en `/v1/chat/completions`,
así que este cliente sirve igual para un Ollama local (`http://localhost:11434`)
o para cualquier otro proveedor compatible: solo cambia `base_url`.

Soporta las tres cosas que necesita el agente:

  * **chat()**        — una respuesta completa.
  * **chat_stream()** — tokens según van llegando (para que el chat se sienta vivo).
  * **tool calling**  — el modelo pide ejecutar una herramienta y nosotros se la
                        damos ya ejecutada. Es lo que convierte un chatbot en un
                        agente.

Sobre el tool calling: no todos los modelos lo soportan. Si el modelo elegido
no lo hace, `soporta_herramientas()` devuelve False y el agente cae a un modo
degradado (responde con texto, sin ejecutar acciones). Es mejor que fallar.
"""
from __future__ import annotations

import json
import logging
from typing import Any, AsyncIterator, Dict, List, Optional

import httpx

logger = logging.getLogger("llm_client")

# Modelos que NO admiten tool calling (se irá ampliando; los cloud rotan).
SIN_HERRAMIENTAS = {"gemma", "embed"}

# Timeout generoso: un modelo grande con contexto largo puede tardar.
TIMEOUT_S = 180.0


class LlmError(RuntimeError):
    """Error hablando con el proveedor del modelo, con mensaje ya legible."""


class LlmClient:
    """Cliente de chat compatible con la API de OpenAI."""

    def __init__(
        self,
        base_url: str = "https://ollama.com",
        api_key: str = "",
        model: str = "gpt-oss:120b-cloud",
        max_tokens: int = 8192,
        temperature: float = 0.2,
        timeout_s: float = TIMEOUT_S,
    ) -> None:
        self.base_url = (base_url or "https://ollama.com").rstrip("/")
        self.api_key = api_key or ""
        self.model = model
        self.max_tokens = max_tokens
        self.temperature = temperature
        self.timeout_s = timeout_s

    # ------------------------------------------------------------------ #
    @property
    def configurado(self) -> bool:
        """
        True si hay API key. Un Ollama local no la necesita, así que también
        se considera configurado si apunta a localhost.
        """
        return bool(self.api_key) or "localhost" in self.base_url \
            or "127.0.0.1" in self.base_url

    def soporta_herramientas(self, modelo: Optional[str] = None) -> bool:
        """Heurística: algunas familias de modelos no admiten tool calling."""
        nombre = (modelo or self.model).lower()
        return not any(m in nombre for m in SIN_HERRAMIENTAS)

    def _cabeceras(self) -> Dict[str, str]:
        cab = {"Content-Type": "application/json"}
        if self.api_key:
            cab["Authorization"] = f"Bearer {self.api_key}"
        return cab

    def _cuerpo(
        self,
        mensajes: List[dict],
        herramientas: Optional[List[dict]] = None,
        modelo: Optional[str] = None,
        stream: bool = False,
        temperatura: Optional[float] = None,
    ) -> dict:
        cuerpo: Dict[str, Any] = {
            "model": modelo or self.model,
            "messages": mensajes,
            "stream": stream,
            "max_tokens": self.max_tokens,
            "temperature": (self.temperature if temperatura is None
                            else temperatura),
        }
        if herramientas and self.soporta_herramientas(modelo):
            cuerpo["tools"] = herramientas
            cuerpo["tool_choice"] = "auto"
        return cuerpo

    # ------------------------------------------------------------------ #
    # Chat completo
    # ------------------------------------------------------------------ #
    async def chat(
        self,
        mensajes: List[dict],
        herramientas: Optional[List[dict]] = None,
        modelo: Optional[str] = None,
        temperatura: Optional[float] = None,
    ) -> dict:
        """
        Pide una respuesta y devuelve el mensaje del asistente tal cual:

            {"role": "assistant", "content": "...",
             "tool_calls": [{"id": ..., "function": {"name", "arguments"}}]}

        `tool_calls` solo aparece si el modelo decidió usar una herramienta.
        """
        if not self.configurado:
            raise LlmError(
                "No hay API key configurada. Ponla en el .env como "
                "PLC_AI_API_KEY, o usa un Ollama local en PLC_AI_BASE_URL."
            )

        url = f"{self.base_url}/v1/chat/completions"
        cuerpo = self._cuerpo(mensajes, herramientas, modelo, False, temperatura)

        try:
            async with httpx.AsyncClient(timeout=self.timeout_s) as cli:
                r = await cli.post(url, headers=self._cabeceras(), json=cuerpo)
        except httpx.TimeoutException as exc:
            raise LlmError(
                f"El modelo tardó más de {self.timeout_s:.0f}s en responder. "
                f"Prueba con un modelo más pequeño o una pregunta más corta."
            ) from exc
        except httpx.RequestError as exc:
            raise LlmError(
                f"No se pudo contactar con {self.base_url}: {exc}. "
                f"Revisa la conexión a internet del servidor."
            ) from exc

        self._revisar_respuesta(r, modelo or self.model)

        try:
            datos = r.json()
            return datos["choices"][0]["message"]
        except (KeyError, IndexError, json.JSONDecodeError) as exc:
            raise LlmError(
                f"Respuesta inesperada del modelo: {r.text[:300]}"
            ) from exc

    @staticmethod
    def _revisar_respuesta(r: httpx.Response, modelo: str) -> None:
        """Traduce los códigos de error a algo que el usuario entienda."""
        if r.status_code == 200:
            return
        if r.status_code == 401:
            raise LlmError("API key inválida o caducada. Genera otra en "
                           "https://ollama.com/settings/keys")
        if r.status_code in (404, 410):
            raise LlmError(
                f"El modelo '{modelo}' ya no está disponible (los modelos cloud "
                f"rotan). Consulta el catálogo vigente en "
                f"https://ollama.com/search?c=cloud y actualiza PLC_AI_MODEL."
            )
        if r.status_code == 429:
            raise LlmError("Se alcanzó el límite de peticiones del proveedor. "
                           "Espera un momento y reintenta.")
        raise LlmError(f"Error {r.status_code} del proveedor: {r.text[:300]}")

    # ------------------------------------------------------------------ #
    # Chat en streaming
    # ------------------------------------------------------------------ #
    async def chat_stream(
        self,
        mensajes: List[dict],
        herramientas: Optional[List[dict]] = None,
        modelo: Optional[str] = None,
        temperatura: Optional[float] = None,
    ) -> AsyncIterator[dict]:
        """
        Va emitiendo trozos de la respuesta según llegan (SSE).

        Emite dicts `{"tipo": "texto", "texto": "..."}` para el contenido y
        `{"tipo": "fin", "mensaje": {...}}` al terminar, con el mensaje
        completo (incluidas las `tool_calls` ya reensambladas).

        El reensamblado de `tool_calls` es necesario porque el proveedor las
        manda troceadas: el nombre en un chunk y los argumentos en varios.
        """
        if not self.configurado:
            raise LlmError("No hay API key configurada (PLC_AI_API_KEY).")

        url = f"{self.base_url}/v1/chat/completions"
        cuerpo = self._cuerpo(mensajes, herramientas, modelo, True, temperatura)

        texto_total: List[str] = []
        # índice -> {"id", "function": {"name", "arguments"}}
        llamadas: Dict[int, dict] = {}

        try:
            async with httpx.AsyncClient(timeout=self.timeout_s) as cli:
                async with cli.stream("POST", url, headers=self._cabeceras(),
                                      json=cuerpo) as r:
                    if r.status_code != 200:
                        await r.aread()
                        self._revisar_respuesta(r, modelo or self.model)

                    async for linea in r.aiter_lines():
                        if not linea or not linea.startswith("data:"):
                            continue
                        payload = linea[5:].strip()
                        if payload == "[DONE]":
                            break
                        try:
                            trozo = json.loads(payload)
                        except json.JSONDecodeError:
                            continue

                        delta = (trozo.get("choices") or [{}])[0].get("delta", {})

                        texto = delta.get("content")
                        if texto:
                            texto_total.append(texto)
                            yield {"tipo": "texto", "texto": texto}

                        for tc in delta.get("tool_calls") or []:
                            idx = tc.get("index", 0)
                            acumulada = llamadas.setdefault(
                                idx, {"id": "", "type": "function",
                                      "function": {"name": "", "arguments": ""}})
                            if tc.get("id"):
                                acumulada["id"] = tc["id"]
                            fn = tc.get("function") or {}
                            if fn.get("name"):
                                acumulada["function"]["name"] = fn["name"]
                            if fn.get("arguments"):
                                acumulada["function"]["arguments"] += fn["arguments"]

        except httpx.TimeoutException as exc:
            raise LlmError(f"El modelo tardó más de {self.timeout_s:.0f}s.") from exc
        except httpx.RequestError as exc:
            raise LlmError(f"No se pudo contactar con {self.base_url}: {exc}") from exc

        mensaje: Dict[str, Any] = {
            "role": "assistant",
            "content": "".join(texto_total),
        }
        if llamadas:
            mensaje["tool_calls"] = [llamadas[i] for i in sorted(llamadas)]
        yield {"tipo": "fin", "mensaje": mensaje}

    # ------------------------------------------------------------------ #
    async def comprobar(self, modelo: Optional[str] = None) -> dict:
        """
        Ping al proveedor: confirma que la API key y el modelo funcionan.
        Se usa en `GET /ai/estado` para que la vista muestre un semáforo.
        """
        try:
            msg = await self.chat(
                [{"role": "user", "content": "Responde solo: OK"}],
                modelo=modelo, temperatura=0.0,
            )
            return {"ok": True, "modelo": modelo or self.model,
                    "respuesta": (msg.get("content") or "").strip()[:80],
                    "mensaje": "El modelo responde correctamente."}
        except LlmError as exc:
            return {"ok": False, "modelo": modelo or self.model,
                    "mensaje": str(exc)}
