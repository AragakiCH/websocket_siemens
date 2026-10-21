# -*- coding: utf-8 -*-
"""
etiquetas_trend_routes.py
=========================
Las ETIQUETAS del widget Tendencia, guardadas en el servidor.

Una etiqueta es una marca con nombre que un Supervisor deja sobre una curva
en un instante, con la foto de lo que valían todas las variables del trend en
ese momento. Se guardan aquí —y no solo en el navegador— para poder verlas
después al filtrar el historizador por fecha y hora, y para que otro operador
las vea también.

  GET    /trend/etiquetas?widget=…&desde=…&hasta=…  -> las de un trend en un rango
  POST   /trend/etiquetas                           -> crear una   [Supervisor]
  DELETE /trend/etiquetas/{id}                      -> borrar una  [Supervisor]

DÓNDE VIVEN
  En `datos/etiquetas_trend.json` (la carpeta de datos, junto a
  `historicos.json`, `internas.json`…). NO van a SQL: no se crea ni se toca
  ninguna tabla. Nunca se borran solas.

INDEPENDIENTES DEL HISTORIZADOR
  Una etiqueta se guarda aunque el historizador no esté grabando: lleva su
  instante, su valor y las lecturas de todas las variables, así que se puede
  dibujar en su sitio aunque al filtrar no haya líneas.

DIFUSIÓN
  Tras crear o borrar se emite `config.updated` con recurso `etiquetas_trend`:
  las demás pantallas abiertas vuelven a pedir la lista sin recargar.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import secrets
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field

from app.api.auth_routes import exigir_rol, usuario_de
from app.core.auth_manager import Sesion

logger = logging.getLogger("etiquetas_trend")

router = APIRouter(prefix="/trend/etiquetas", tags=["Tendencia · etiquetas"])

FICHERO = "etiquetas_trend.json"

_candado = asyncio.Lock()
_cache: Optional[List[Dict[str, Any]]] = None


def _ruta() -> Path:
    from app.config.rutas import resolver_carpeta_datos
    return resolver_carpeta_datos() / FICHERO


def _ahora_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _leer_fichero() -> List[Dict[str, Any]]:
    ruta = _ruta()
    if not ruta.exists():
        return []
    try:
        doc = json.loads(ruta.read_text(encoding="utf-8"))
    except Exception as exc:  # noqa: BLE001
        # Un fichero ilegible NO se pisa: se avisa y se trabaja sin él. Si se
        # guardara encima, se perderían todas las etiquetas por un carácter.
        logger.error("No se pudo leer %s: %s", ruta, exc)
        raise HTTPException(500, f"No se pudo leer {ruta.name}: {exc}")
    lista = doc.get("etiquetas") if isinstance(doc, dict) else None
    return [e for e in (lista or []) if isinstance(e, dict) and e.get("id")]


def _guardar_fichero(lista: List[Dict[str, Any]]) -> None:
    ruta = _ruta()
    doc = {"version": 1, "etiquetas": lista}
    tmp = ruta.with_suffix(".tmp")
    tmp.write_text(json.dumps(doc, indent=2, ensure_ascii=False), encoding="utf-8")
    os.replace(tmp, ruta)


def _todas() -> List[Dict[str, Any]]:
    global _cache
    if _cache is None:
        _cache = _leer_fichero()
    return _cache


def _instante(texto: Optional[str]) -> Optional[datetime]:
    if not texto:
        return None
    try:
        d = datetime.fromisoformat(texto.replace("Z", "+00:00"))
    except ValueError:
        raise HTTPException(400, f"Fecha no válida: {texto!r}")
    return d if d.tzinfo else d.replace(tzinfo=timezone.utc)


async def _avisar(request: Request, sesion: Optional[Sesion], accion: str) -> None:
    try:
        await request.app.state.manager.difundir_config(
            "etiquetas_trend", usuario_de(sesion), accion)
    except Exception:  # noqa: BLE001
        pass


class Lectura(BaseModel):
    variable: str = Field(default="", max_length=300)
    nombre: str = Field(default="", max_length=200)
    color: str = Field(default="", max_length=40)
    valor: Optional[float] = None
    unidad: Optional[str] = Field(default=None, max_length=40)


class NuevaEtiqueta(BaseModel):
    widget: str = Field(..., min_length=1, max_length=200,
                        description="Id del widget Tendencia.")
    variable: str = Field(default="", max_length=300,
                          description="Variable (`plc|tag`) sobre la que va el punto.")
    curva: str = Field(default="", max_length=200, description="Nombre de esa línea.")
    color: str = Field(default="", max_length=40)
    nombre: str = Field(..., min_length=1, max_length=60)
    ts: str = Field(..., description="Instante del punto, ISO 8601 (UTC).")
    valor: float = Field(..., description="Valor de la curva en ese instante.")
    lecturas: List[Lectura] = Field(default_factory=list, max_length=200)


@router.get("", summary="Etiquetas de un trend en un rango")
async def listar(
    widget: str = Query(..., min_length=1),
    desde: Optional[str] = Query(default=None, description="ISO 8601"),
    hasta: Optional[str] = Query(default=None, description="ISO 8601"),
    _sesion: Optional[Sesion] = Depends(exigir_rol("Invitado")),
) -> dict:
    d = _instante(desde)
    h = _instante(hasta)
    async with _candado:
        lista = list(_todas())
    salida = []
    for e in lista:
        if e.get("widget") != widget:
            continue
        t = _instante(e.get("ts"))
        if t is None:
            continue
        if d and t < d:
            continue
        if h and t > h:
            continue
        salida.append(e)
    salida.sort(key=lambda e: e.get("ts", ""))
    return {"ok": True, "etiquetas": salida}


@router.post("", summary="Crear una etiqueta")
async def crear(
    request: Request,
    cuerpo: NuevaEtiqueta,
    sesion: Optional[Sesion] = Depends(exigir_rol("Supervisor")),
) -> dict:
    t = _instante(cuerpo.ts)
    nueva = {
        "id": "et_" + secrets.token_hex(5),
        "widget": cuerpo.widget,
        "variable": cuerpo.variable,
        "curva": cuerpo.curva,
        "color": cuerpo.color,
        "nombre": cuerpo.nombre.strip(),
        "ts": t.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
        "valor": cuerpo.valor,
        # `valor: null` se conserva (es «sin dato» en ese instante); la
        # unidad vacía no.
        "lecturas": [
            {k: v for k, v in l.model_dump().items() if not (k == "unidad" and v is None)}
            for l in cuerpo.lecturas
        ],
        "autor": usuario_de(sesion),
        "creado": _ahora_iso(),
    }
    async with _candado:
        lista = _todas()
        lista.append(nueva)
        try:
            _guardar_fichero(lista)
        except Exception as exc:  # noqa: BLE001
            lista.pop()
            logger.error("No se pudo guardar la etiqueta: %s", exc)
            raise HTTPException(500, f"No se pudo guardar la etiqueta: {exc}")
    await _avisar(request, sesion, "crear")
    return {"ok": True, "etiqueta": nueva}


@router.delete("/{etiqueta_id}", summary="Borrar una etiqueta")
async def borrar(
    request: Request,
    etiqueta_id: str,
    sesion: Optional[Sesion] = Depends(exigir_rol("Supervisor")),
) -> dict:
    async with _candado:
        lista = _todas()
        quedan = [e for e in lista if e.get("id") != etiqueta_id]
        if len(quedan) == len(lista):
            raise HTTPException(404, "Esa etiqueta ya no existe.")
        try:
            _guardar_fichero(quedan)
        except Exception as exc:  # noqa: BLE001
            logger.error("No se pudo borrar la etiqueta: %s", exc)
            raise HTTPException(500, f"No se pudo borrar la etiqueta: {exc}")
        lista[:] = quedan
    await _avisar(request, sesion, "borrar")
    return {"ok": True}
