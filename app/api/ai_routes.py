# -*- coding: utf-8 -*-
"""
ai_routes.py
============
Endpoints del asistente de IA.

  POST   /ai/chat              -> preguntar y esperar la respuesta completa.
  WS     /ai/ws                -> preguntar con respuesta en streaming.
  GET    /ai/estado            -> diagnóstico: modelo, herramientas, RAG.
  GET    /ai/herramientas      -> catálogo que el agente ve ahora mismo.
  GET    /ai/sugerencias       -> preguntas de ejemplo para la vista.
  POST   /ai/recargar          -> re-lee OpenAPI y docs SIN reiniciar.
  GET    /ai/sesiones          -> conversaciones abiertas.
  DELETE /ai/sesiones/{id}     -> borrar una conversación.
  POST   /ai/buscar            -> probar el RAG sin gastar tokens del modelo.

Estos endpoints se excluyen a propósito del catálogo de herramientas del
agente: si pudiera llamarse a sí mismo, entraría en bucle.
"""
from __future__ import annotations

import logging
from typing import List, Optional

from fastapi import APIRouter, Body, Query, Request, WebSocket, WebSocketDisconnect
from pydantic import BaseModel, Field

from app.ai.prompts import SUGERENCIAS

logger = logging.getLogger("ai_routes")

router = APIRouter()
TAG = ["Asistente de IA"]


def _agente(request: Request):
    return getattr(request.app.state, "agente", None)


class Pregunta(BaseModel):
    """Cuerpo de POST /ai/chat."""

    mensaje: str = Field(
        ...,
        description="Lo que se le pregunta o pide al asistente.",
        examples=["¿Qué PLCs hay conectados y cómo están?"],
    )
    sesion_id: Optional[str] = Field(
        default=None,
        description="Para continuar una conversación. Si se omite, se crea "
                    "una nueva y su id viene en la respuesta.",
    )
    modelo: Optional[str] = Field(
        default=None,
        description="Modelo concreto para esta pregunta. Si se omite, se usa "
                    "el de `PLC_AI_MODEL`. Ver opciones en `GET /ai/estado`.",
    )


class BusquedaRag(BaseModel):
    """Cuerpo de POST /ai/buscar."""

    consulta: str = Field(..., examples=["banda muerta del historizador"])
    k: int = Field(default=5, ge=1, le=20,
                   description="Número de fragmentos a devolver.")


# ====================================================================== #
# Chat
# ====================================================================== #
@router.post(
    "/ai/chat",
    tags=TAG,
    summary="Preguntar al asistente",
    description="Envía una pregunta y devuelve la respuesta completa.\n\n"
                "El asistente **no solo conversa**: puede ejecutar las "
                "herramientas del propio sistema (consultar tags, leer el "
                "histórico, generar un Excel...) y razonar con el resultado. "
                "Un ciclo puede encadenar varias herramientas.\n\n"
                "La respuesta incluye:\n\n"
                "- `respuesta`: el texto final.\n"
                "- `traza`: qué herramientas usó, con qué argumentos y cuánto "
                "tardó cada una. **Es lo que permite auditar de dónde salió "
                "cada dato** — importante en un entorno industrial.\n"
                "- `citas`: qué secciones de la documentación se le "
                "inyectaron por RAG.\n\n"
                "Para respuesta en vivo (token a token), usa el WebSocket "
                "`/ai/ws`.",
    responses={200: {"content": {"application/json": {"examples": {
        "ok": {"summary": "Respuesta con herramientas", "value": {
            "ok": True, "sesion_id": "a1b2c3d4e5f6",
            "respuesta": "Hay 2 PLCs conectados: el Siemens 192.168.50.1 "
                         "(5 tags, conectado) y el Rexroth 192.168.100.31 "
                         "(4 tags, conectado, modo subscription).",
            "modelo": "gpt-oss:120b-cloud", "pasos": 2,
            "traza": [{"herramienta": "get_health", "argumentos": {},
                       "ok": True, "ms": 12.4}],
            "citas": [{"titulo": "API.md › 3. Consultas",
                       "fuente": "API.md", "relevancia": 8.4}],
            "ms": 3421.8,
        }},
        "sin_api_key": {"summary": "Falta configurar", "value": {
            "ok": False, "sesion_id": "a1b2c3d4e5f6",
            "mensaje": "No hay API key configurada. Ponla en el .env como "
                       "PLC_AI_API_KEY, o usa un Ollama local en "
                       "PLC_AI_BASE_URL.",
        }},
    }}}}},
)
async def chat(
    request: Request,
    cuerpo: Pregunta = Body(..., openapi_examples={
        "estado": {
            "summary": "Consultar el estado del sistema",
            "description": "El agente llamará a `get_health` / `get_plcs` y "
                           "resumirá lo que encuentre.",
            "value": {"mensaje": "¿Qué PLCs hay conectados y cómo están?"},
        },
        "analisis": {
            "summary": "Analizar datos del histórico",
            "description": "Encadena herramientas: busca los tags, lee el "
                           "histórico y analiza tendencias y anomalías.",
            "value": {"mensaje": "Analiza la temperatura de la última hora y "
                                 "dime si ves algo raro"},
        },
        "documentacion": {
            "summary": "Pregunta sobre el propio proyecto (RAG)",
            "description": "Se responde con la documentación real del "
                           "proyecto, citando fichero y sección.",
            "value": {"mensaje": "¿Qué diferencia hay entre el historizador y "
                                 "una grabación?"},
        },
        "continuar": {
            "summary": "Continuar una conversación",
            "description": "Reutiliza `sesion_id` para que recuerde el hilo.",
            "value": {"mensaje": "¿Y en los últimos 10 minutos?",
                      "sesion_id": "a1b2c3d4e5f6"},
        },
    }),
) -> dict:
    agente = _agente(request)
    if agente is None:
        return {"ok": False,
                "mensaje": "El asistente está desactivado "
                           "(PLC_AI_ENABLED=false en el .env)."}
    return await agente.preguntar(cuerpo.mensaje, cuerpo.sesion_id,
                                  cuerpo.modelo)


@router.websocket("/ai/ws")
async def chat_ws(websocket: WebSocket) -> None:
    """
    Chat con respuesta en streaming.

    El cliente envía `{"mensaje": "...", "sesion_id": "...", "modelo": "..."}`
    y recibe una secuencia de eventos:

        {"tipo": "inicio",      "sesion_id": "...", "modelo": "..."}
        {"tipo": "citas",       "citas": [...]}
        {"tipo": "herramienta", "estado": "ejecutando", "herramienta": "get_tags"}
        {"tipo": "herramienta", "estado": "hecho", "ok": true, "ms": 12.4}
        {"tipo": "texto",       "texto": "Hay 2 PLCs"}     ← token a token
        {"tipo": "fin",         "respuesta": "...", "traza": [...]}
        {"tipo": "error",       "mensaje": "..."}

    Mostrar los eventos `herramienta` mientras el modelo trabaja es lo que
    diferencia una espera muda de una en la que se ve qué está pasando.
    """
    await websocket.accept()
    agente = getattr(websocket.app.state, "agente", None)

    if agente is None:
        await websocket.send_json({
            "tipo": "error",
            "mensaje": "El asistente está desactivado (PLC_AI_ENABLED=false).",
        })
        await websocket.close()
        return

    try:
        while True:
            datos = await websocket.receive_json()
            mensaje = (datos or {}).get("mensaje", "").strip()
            if not mensaje:
                await websocket.send_json({
                    "tipo": "error", "mensaje": "Envía un campo 'mensaje'."})
                continue

            try:
                async for evento in agente.preguntar_stream(
                        mensaje, datos.get("sesion_id"), datos.get("modelo")):
                    await websocket.send_json(evento)
            except Exception as exc:  # noqa: BLE001
                logger.warning("Error en el stream de IA: %s", exc)
                await websocket.send_json({"tipo": "error",
                                           "mensaje": str(exc)})

    except WebSocketDisconnect:
        logger.info("Cliente de IA desconectado.")
    except Exception as exc:  # noqa: BLE001
        logger.warning("WebSocket de IA cerrado por error: %s", exc)


# ====================================================================== #
# Diagnóstico y gestión
# ====================================================================== #
@router.get(
    "/ai/estado",
    tags=TAG,
    summary="Estado del asistente",
    description="Diagnóstico completo: modelo activo, si hay API key, cuántas "
                "herramientas ve el agente y cuánta documentación tiene "
                "indexada.\n\n"
                "Con `?comprobar=true` hace además una llamada real al modelo "
                "para verificar que la API key funciona y que el modelo sigue "
                "existiendo (los modelos cloud rotan y desaparecen).",
    responses={200: {"content": {"application/json": {"example": {
        "activo": True, "modelo": "gpt-oss:120b-cloud",
        "proveedor": "https://ollama.com", "api_key_configurada": True,
        "soporta_herramientas": True, "max_pasos": 8, "sesiones_activas": 1,
        "herramientas": {"num_herramientas": 34,
                         "por_riesgo": {"lectura": 20, "escritura": 14},
                         "escritura_permitida": False,
                         "dominios": ["Bases de datos", "Exportar a Excel",
                                      "Historizador (PLC → BD)", "REST"]},
        "rag": {"fragmentos_indexados": 96, "terminos_unicos": 1828,
                "algoritmo": "BM25 (recuperación léxica, sin dependencias)"},
    }}}}},
)
async def estado(
    request: Request,
    comprobar: bool = Query(
        default=False,
        description="Hacer una llamada real al modelo para verificarlo."),
) -> dict:
    agente = _agente(request)
    if agente is None:
        return {"activo": False,
                "mensaje": "Asistente desactivado (PLC_AI_ENABLED=false)."}
    return await agente.estado(comprobar_modelo=comprobar)


@router.get(
    "/ai/herramientas",
    tags=TAG,
    summary="Herramientas que ve el agente",
    description="Catálogo actual, derivado del OpenAPI en tiempo de "
                "ejecución.\n\n"
                "**Aquí está la clave de que el agente se adapte solo**: no "
                "hay una lista escrita a mano. Cuando añades un endpoint "
                "nuevo, aparece aquí automáticamente y el agente sabe usarlo, "
                "guiándose por el `summary` y la `description` que ya "
                "escribiste para Swagger. Documentar bien un endpoint es, "
                "literalmente, enseñárselo al agente.",
    responses={200: {"content": {"application/json": {"example": {
        "num_herramientas": 34,
        "herramientas": [{
            "nombre": "get_tags", "metodo": "GET", "ruta": "/tags",
            "riesgo": "lectura", "dominio": "REST",
            "resumen": "Tags con su último valor",
        }],
    }}}}},
)
async def herramientas(request: Request) -> dict:
    agente = _agente(request)
    if agente is None:
        return {"num_herramientas": 0, "herramientas": [],
                "mensaje": "Asistente desactivado."}

    catalogo = agente.catalogo
    if not catalogo.herramientas:
        catalogo.construir()
    return {
        "num_herramientas": len(catalogo.herramientas),
        "escritura_permitida": catalogo.permitir_escritura,
        "herramientas": [
            {"nombre": h.nombre, "metodo": h.metodo, "ruta": h.ruta,
             "riesgo": h.riesgo, "dominio": h.dominio, "resumen": h.resumen,
             "binaria": h.binaria}
            for h in sorted(catalogo.herramientas.values(),
                            key=lambda x: (x.dominio, x.nombre))
        ],
    }


@router.post(
    "/ai/recargar",
    tags=TAG,
    summary="Recargar herramientas y documentación",
    description="Vuelve a leer el OpenAPI y a indexar `docs/*.md` **sin "
                "reiniciar el servicio**.\n\n"
                "Úsalo después de añadir un endpoint o actualizar la "
                "documentación: el agente incorpora lo nuevo al instante.",
    responses={200: {"content": {"application/json": {"example": {
        "herramientas": 34, "fragmentos": 96,
        "mensaje": "Agente recargado: 34 herramienta(s) y 96 fragmento(s) de "
                   "documentación.",
    }}}}},
)
async def recargar(request: Request) -> dict:
    agente = _agente(request)
    if agente is None:
        return {"ok": False, "mensaje": "Asistente desactivado."}
    return agente.recargar()


@router.post(
    "/ai/buscar",
    tags=TAG,
    summary="Probar el RAG sin gastar tokens",
    description="Devuelve los fragmentos de documentación que el RAG "
                "recuperaría para una consulta, con su puntuación de "
                "relevancia. **No llama al modelo**, así que no consume "
                "tokens ni cuesta dinero.\n\n"
                "Sirve para depurar: si el asistente responde mal, mira "
                "primero si el RAG le está dando el contexto correcto.",
    responses={200: {"content": {"application/json": {"example": {
        "consulta": "banda muerta del historizador", "num_resultados": 2,
        "resultados": [{
            "titulo": "API_DB.md › 4. Historizador › Volumen",
            "fuente": "API_DB.md", "relevancia": 12.4,
            "extracto": "Si te pasa, no quites tags: usa las válvulas…",
        }],
    }}}}},
)
async def buscar(request: Request, cuerpo: BusquedaRag) -> dict:
    agente = _agente(request)
    if agente is None:
        return {"ok": False, "mensaje": "Asistente desactivado."}

    resultados = agente.rag.recuperador.buscar(cuerpo.consulta, cuerpo.k)
    return {
        "consulta": cuerpo.consulta,
        "num_resultados": len(resultados),
        "resultados": [
            {"titulo": f.titulo, "fuente": f.fuente,
             "relevancia": round(score, 2),
             "extracto": f.texto[:300] + ("…" if len(f.texto) > 300 else "")}
            for f, score in resultados
        ],
    }


@router.get(
    "/ai/sugerencias",
    tags=TAG,
    summary="Preguntas de ejemplo",
    description="Preguntas listas para mostrar como botones en el chat, para "
                "que el usuario vea de un vistazo qué puede pedir.",
)
async def sugerencias() -> dict:
    return {"sugerencias": SUGERENCIAS}


@router.get(
    "/ai/sesiones",
    tags=TAG,
    summary="Conversaciones abiertas",
    description="Sesiones activas con su número de mensajes. Cada sesión "
                "conserva un historial acotado para no disparar el contexto.",
)
async def sesiones(request: Request) -> dict:
    agente = _agente(request)
    if agente is None:
        return {"num_sesiones": 0, "sesiones": []}
    return {
        "num_sesiones": len(agente.sesiones),
        "sesiones": [s.resumen() for s in agente.sesiones.values()],
    }


@router.delete(
    "/ai/sesiones/{sesion_id}",
    tags=TAG,
    summary="Borrar una conversación",
    description="Elimina el historial de esa sesión. La siguiente pregunta "
                "empezará de cero.",
)
async def borrar_sesion(request: Request, sesion_id: str) -> dict:
    agente = _agente(request)
    if agente is None:
        return {"ok": False, "mensaje": "Asistente desactivado."}
    if agente.borrar_sesion(sesion_id):
        return {"ok": True, "sesion_id": sesion_id,
                "mensaje": f"Sesión '{sesion_id}' borrada."}
    return {"ok": False, "mensaje": f"No existe la sesión '{sesion_id}'."}
