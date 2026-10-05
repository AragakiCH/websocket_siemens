# -*- coding: utf-8 -*-
"""
cache_webview.py
================
Vacía la CACHÉ HTTP de WebView2 antes de abrir la ventana. Solo la caché:
la sesión iniciada, el localStorage y las cookies se quedan como están.

POR QUÉ HACE FALTA
------------------
La ventana de escritorio arranca con `private_mode=False` y un `storage_path`
fijo para que la sesión sobreviva entre arranques. Eso arrastra también la
caché HTTP del navegador, y ahí es donde se cuela una versión anterior:

  1. Una instalación antigua servía `index.html` sin `Cache-Control`, así que
     WebView2 lo guardó con "frescura heurística" (puede darlo por bueno
     durante días sin volver a preguntar al servidor).
  2. Se instala la versión nueva. El instalador sobreescribe pero NO borra
     lo que sobra, así que los `assets/index-VIEJO.js` siguen en disco.
  3. WebView2 abre `index.html` de su caché → pide los assets viejos → el
     servidor los encuentra → se ve la aplicación ANTERIOR, sin un solo
     error en ningún sitio. "Le pasé el instalador y no ve mis cambios".

El servidor ya manda `no-store` para el index (ver app/main.py) y el
instalador ya limpia `_internal` al actualizar, pero ninguna de las dos cosas
arregla una caché que se guardó ANTES de esas dos correcciones. Esto sí:
vaciarla al arrancar cuesta unos milisegundos y unos KB de red, y garantiza
que la ventana pinta lo que hay en el servidor.

QUÉ SE BORRA Y QUÉ NO
---------------------
Dentro del perfil (`<storage_path>/EBWebView/<perfil>/`):

    Cache/          caché HTTP           -> se borra
    Code Cache/     bytecode JS          -> se borra
    GPUCache/, DawnCache/, ShaderCache/  -> se borran (se regeneran solos)
    Local Storage/, Session Storage/, Cookies, IndexedDB/  -> SE CONSERVAN

Es el mismo criterio que "Borrar datos de navegación → solo archivos en
caché" en Edge.
"""
from __future__ import annotations

import os
import shutil
from typing import Iterable, Optional

CARPETAS_CACHE: tuple = ("Cache", "Code Cache", "GPUCache", "DawnCache",
                         "DawnWebGPUCache", "DawnGraphiteCache", "ShaderCache",
                         "GrShaderCache", "GraphiteDawnCache")


def _perfiles(raiz: str) -> Iterable[str]:
    """Carpetas de perfil de Chromium dentro del storage: `Default` y demás."""
    ebw = os.path.join(raiz, "EBWebView")
    if not os.path.isdir(ebw):
        return []
    salida = []
    for nombre in os.listdir(ebw):
        ruta = os.path.join(ebw, nombre)
        # Un perfil tiene su propia carpeta; `Default` es el habitual.
        if os.path.isdir(ruta) and (nombre == "Default" or
                                    nombre.startswith("Profile") or
                                    os.path.isdir(os.path.join(ruta, "Cache"))):
            salida.append(ruta)
    # También hay cachés a nivel de storage (GrShaderCache, ShaderCache).
    salida.append(ebw)
    return salida


def limpiar_cache_webview(storage_path: Optional[str]) -> int:
    """
    Borra las carpetas de caché. Devuelve cuántas quitó. Nunca lanza: si
    algo está bloqueado (otra ventana abierta sobre el mismo perfil), se deja
    y se sigue, que es preferible a no abrir la ventana.
    """
    if not storage_path or not os.path.isdir(storage_path):
        return 0
    borradas = 0
    for perfil in _perfiles(storage_path):
        for nombre in CARPETAS_CACHE:
            ruta = os.path.join(perfil, nombre)
            if not os.path.isdir(ruta):
                continue
            try:
                shutil.rmtree(ruta, ignore_errors=True)
                if not os.path.isdir(ruta):
                    borradas += 1
            except OSError:
                pass
    return borradas
