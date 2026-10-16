# -*- coding: utf-8 -*-
"""
funciones_routes.py
===================
El «modo función» de los widgets, por HTTP.

    POST /funciones/validar    ¿compila? ¿qué nombres usa? — para el editor
    POST /funciones/probar     ejecuta con valores de prueba — «Valores de prueba»
    POST /funciones/evaluar    ejecuta con los tags reales — los widgets en vivo
    DELETE /funciones/estado/{widget_id}   olvida las internas de un widget

Cómo se ejecuta el código, y por qué no es un `exec` a secas, está en
`app/core/funciones_py.py`. Aquí: modelos, permisos y la memoria compartida.

PERMISOS
--------
`validar` y `probar` son del Diseñador: Administradores. `evaluar` lo llama
CUALQUIER pantalla que dibuje un widget con función —la Vista Previa de un
operario incluida—, así que pide sesión pero no rol: el código que ejecuta
no lo escribió quien llama, sino quien diseñó la pantalla, y ese ya pasó por
el control de Administradores al guardarla.
"""
from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from app.api.auth_routes import exigir_rol
from app.core.funciones_py import Evaluador, ejecutar_sync, validar, valor_inicial

logger = logging.getLogger("funciones_routes")

router = APIRouter(prefix="/funciones", tags=["Funciones"])

TIPOS = ("bool", "entero", "decimal", "texto")


def _evaluador(request: Request) -> Evaluador:
    ev = getattr(request.app.state, "evaluador_funciones", None)
    if ev is None:
        ev = Evaluador()
        request.app.state.evaluador_funciones = ev
    return ev


class Interna(BaseModel):
    nombre: str = Field(..., max_length=80)
    tipo: str = Field("bool")
    # Solo en `probar`: con qué valor arranca. Ausente = el defecto del tipo.
    valor: Optional[Any] = None


def _tipos(internas: List[Interna]) -> Dict[str, str]:
    return {i.nombre.strip(): (i.tipo if i.tipo in TIPOS else "bool")
            for i in internas if i.nombre.strip()}


class CuerpoValidar(BaseModel):
    codigo: str = Field("", max_length=20_000)
    salida: str = Field("varPrincipal", max_length=80)
    nombres: List[str] = Field(default_factory=list)


@router.post(
    "/validar",
    summary="Comprobar la sintaxis y los nombres de una función",
    description="Para el editor del modal: dice si el código Python compila, "
                "qué nombres lee y asigna, y cuáles no son ni entradas ni "
                "variables internas (probables errores de tecleo). No ejecuta "
                "nada.",
    dependencies=[Depends(exigir_rol("Administradores"))],
)
async def validar_funcion(cuerpo: CuerpoValidar) -> Dict[str, Any]:
    return validar(cuerpo.codigo, [n for n in cuerpo.nombres if n], cuerpo.salida)


class CuerpoProbar(BaseModel):
    codigo: str = Field("", max_length=20_000)
    salida: str = Field("varPrincipal", max_length=80)
    entradas: Dict[str, Any] = Field(default_factory=dict)
    internas: List[Interna] = Field(default_factory=list)


@router.post(
    "/probar",
    summary="Ejecutar una función con valores de prueba",
    description="Ejecuta el código Python con las entradas y los valores "
                "iniciales de las internas que se indiquen, y devuelve el "
                "valor de la salida, las internas después del código, lo "
                "impreso con `print()` y el error (con línea) si lo hubo. "
                "Sin memoria: cada prueba parte de lo que se manda.",
    dependencies=[Depends(exigir_rol("Administradores"))],
)
async def probar_funcion(cuerpo: CuerpoProbar) -> Dict[str, Any]:
    tipos = _tipos(cuerpo.internas)
    iniciales: Dict[str, Any] = {}
    for i in cuerpo.internas:
        n = i.nombre.strip()
        if not n:
            continue
        iniciales[n] = i.valor if i.valor is not None else valor_inicial(tipos[n])
    import asyncio
    loop = asyncio.get_running_loop()
    r = await loop.run_in_executor(
        None, ejecutar_sync, cuerpo.codigo, cuerpo.salida, cuerpo.entradas,
        iniciales, tipos)
    return {"ok": True, **r}


class CuerpoEvaluar(BaseModel):
    widget_id: str = Field(..., max_length=120)
    salida_clave: str = Field(..., max_length=80)
    salida: str = Field("varPrincipal", max_length=80)
    codigo: str = Field("", max_length=20_000)
    entradas: Dict[str, Any] = Field(default_factory=dict)
    internas: List[Interna] = Field(default_factory=list)


@router.post(
    "/evaluar",
    summary="Calcular la salida de un widget con los tags reales",
    description="Lo llama cada widget con «Modo función» cuando cambia alguna "
                "de sus entradas. El servidor recuerda las variables internas "
                "por widget y salida, y **solo ejecuta cuando las entradas o "
                "el código cambian**: varios visores del mismo widget no "
                "hacen contar dos veces a un contador.",
    dependencies=[Depends(exigir_rol("Invitado"))],
)
async def evaluar_funcion(request: Request, cuerpo: CuerpoEvaluar) -> Dict[str, Any]:
    clave = f"{cuerpo.widget_id}|{cuerpo.salida_clave}"
    r = await _evaluador(request).evaluar(
        clave, cuerpo.codigo, cuerpo.salida, cuerpo.entradas, _tipos(cuerpo.internas))
    return {"ok": True, **r}


@router.delete(
    "/estado/{widget_id}",
    summary="Olvidar las variables internas de un widget",
    description="Las internas vuelven a su valor inicial en la siguiente "
                "evaluación. Útil tras cambiar la función en el Diseñador.",
    dependencies=[Depends(exigir_rol("Administradores"))],
)
async def olvidar_estado(request: Request, widget_id: str) -> Dict[str, Any]:
    n = _evaluador(request).olvidar(widget_id + "|")
    return {"ok": True, "olvidadas": n}


@router.get(
    "/estado",
    summary="Cuántas funciones tiene en memoria el servidor",
    dependencies=[Depends(exigir_rol("Administradores"))],
)
async def estado(request: Request) -> Dict[str, Any]:
    return {"ok": True, **_evaluador(request).estado()}
