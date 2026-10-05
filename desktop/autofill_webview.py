# -*- coding: utf-8 -*-
"""
autofill_webview.py
===================
Apaga el AUTORRELLENO de WebView2 (Edge) en la ventana de escritorio.

EL SÍNTOMA
----------
En el login, solo en el campo «Usuario» y solo en la aplicación de
escritorio: al escribir hay un retraso, la caja pasa de gris a BLANCA de
golpe y, escribiendo seguido, se pierden letras. En el navegador, con el
mismo frontend, no pasa.

LA CAUSA
--------
No es el frontend. WebView2 trae activado el autorrelleno general de Edge
(`IsGeneralAutofillEnabled = true` de fábrica), que actúa sobre los campos
de texto de formularios y con especial interés en `autocomplete="username"`.
Al teclear, Edge:

  1. abre su desplegable de sugerencias —una ventana nativa APARTE de la
     del programa—, y mientras aparece se lleva parte de las pulsaciones:
     esas son las letras que "se saltan";
  2. pinta el campo con su estilo de autorrelleno (`:-webkit-autofill`),
     que es un fondo blanco fijo que ignora el tema oscuro: ese es el
     "se pone blanco de un momento a otro".

Por eso lo sufre solo ese campo: la contraseña la protege el gestor de
contraseñas, que en WebView2 viene APAGADO (`IsPasswordAutosaveEnabled =
false`), y los demás campos no tienen un `autocomplete` que Edge reconozca
como formulario de acceso.

LA SOLUCIÓN
-----------
Desactivar los dos ajustes en el `CoreWebView2` de la ventana. pywebview no
expone esos ajustes (fija otros en `EdgeChrome.on_webview_ready`), así que
se envuelve ese método para añadir los dos nuestros justo después, en el
mismo hilo de la interfaz y antes de cargar la primera página. Un HMI no
tiene nada que autorrellenar: no hay direcciones, tarjetas ni formularios
web; solo el login, y para ese existe «Mantener la sesión iniciada».

Se llama ANTES de `webview.create_window`. Fuera de Windows, o si pywebview
no trae el motor de Edge, no hace nada y no falla.
"""
from __future__ import annotations

import logging
import sys

logger = logging.getLogger("autofill_webview")

_APLICADO = False


def desactivar_autofill_webview() -> bool:
    """
    Envuelve `EdgeChrome.on_webview_ready` de pywebview para apagar el
    autorrelleno. Devuelve True si quedó instalado (o ya lo estaba).
    """
    global _APLICADO
    if _APLICADO:
        return True
    if not sys.platform.startswith("win"):
        return False
    try:
        from webview.platforms import edgechromium
    except Exception as exc:  # noqa: BLE001  (sin WebView2 / otro motor)
        logger.debug("Sin motor Edge de pywebview: %s", exc)
        return False

    original = edgechromium.EdgeChrome.on_webview_ready

    def on_webview_ready(self, sender, args):  # noqa: ANN001
        original(self, sender, args)
        if not getattr(args, "IsSuccess", True):
            return
        try:
            ajustes = sender.CoreWebView2.Settings
            # Cada uno en su try: un SDK viejo puede no tener alguna de las
            # dos propiedades, y la que sí exista tiene que aplicarse igual.
            for nombre in ("IsGeneralAutofillEnabled", "IsPasswordAutosaveEnabled"):
                try:
                    setattr(ajustes, nombre, False)
                except Exception as exc:  # noqa: BLE001
                    logger.debug("No se pudo poner %s=False: %s", nombre, exc)
        except Exception as exc:  # noqa: BLE001
            logger.warning("No se pudo desactivar el autorrelleno: %s", exc)

    edgechromium.EdgeChrome.on_webview_ready = on_webview_ready
    _APLICADO = True
    return True
