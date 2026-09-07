#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Genera `desktop/psi_core.ico`, el icono del ejecutable y del instalador.

¿POR QUÉ UN SCRIPT Y NO UN .ICO A PELO?
---------------------------------------
Un .ico binario en el repositorio es un fichero que nadie puede revisar en un
diff ni retocar sin abrir un editor de imágenes. Aquí el icono es CÓDIGO: se
ve qué cambia en cada commit y se regenera con una orden.

    python tools/generar_icono.py

POR QUÉ SE DIBUJA CON PRIMITIVAS Y NO CON UNA TIPOGRAFÍA
--------------------------------------------------------
La tentación es escribir "Ψ" con una fuente del sistema. Es mala idea en un
programa que se empaqueta: la fuente que hay en la máquina que construye el
.exe no tiene por qué estar en la que lo ejecuta, y sobre todo cada fuente
dibuja la psi con un grosor distinto. A 16×16 píxeles —el tamaño de la barra
de tareas y del explorador— una psi de fuente normal se convierte en una
mancha gris ilegible.

Dibujada con rectángulos redondeados el trazo es GRUESO a propósito y el
resultado se reconoce igual a 16 que a 256 píxeles.

POR QUÉ SE DIBUJA EN GRANDE Y SE REDUCE
----------------------------------------
Pillow no antialiasa las primitivas: un borde curvo sale con escalones. Se
dibuja a 1024 px y se reduce con LANCZOS a cada tamaño, así que el suavizado
lo hace el remuestreo. Es el mismo truco que el supersampling de un motor 3D.

LOS SEIS TAMAÑOS NO SON DECORATIVOS
------------------------------------
Windows elige uno según el contexto (16 barra de tareas, 32 escritorio,
48 iconos grandes, 256 vista de mosaicos). Si el .ico solo trae 256, Windows
lo reduce él mismo con un algoritmo peor y el icono se ve sucio y borroso en
la barra de tareas, que es justo donde más se mira.
"""
from __future__ import annotations

import sys
from pathlib import Path

try:
    from PIL import Image, ImageDraw
except ImportError:  # noqa: BLE001
    sys.exit(
        "Falta Pillow.  Instálalo con:\n"
        "    pip install Pillow\n"
        "(No está en requirements.txt porque solo hace falta para regenerar\n"
        " el icono, no para ejecutar ni para empaquetar la aplicación.)"
    )

# --------------------------------------------------------------------------
#  Paleta — la misma del frontend, no una inventada
# --------------------------------------------------------------------------
#  Salen de frontend/src: #0f172a es el fondo oscuro de la interfaz y #009999
#  el color de marca. La psi se dibuja con una versión aclarada del color de
#  marca porque el #009999 puro sobre el #0f172a se queda corto de contraste
#  a 16 px: se lee como un borrón oscuro sobre otro borrón oscuro.
FONDO = (15, 23, 42, 255)        # #0f172a
GLIFO = (0, 201, 201, 255)       # #00c9c9  (#009999 aclarado)
BORDE = (0, 122, 122, 255)       # #007a7a  (aro sutil, da profundidad)

LIENZO = 1024                    # tamaño de trabajo; se reduce al final
TAMANOS = [16, 32, 48, 64, 128, 256]

RAIZ = Path(__file__).resolve().parent.parent
DESTINO = RAIZ / "desktop" / "psi_core.ico"


def _barra(dib: "ImageDraw.ImageDraw", x0, y0, x1, y1, color, radio) -> None:
    """Un trazo con las puntas redondeadas."""
    dib.rounded_rectangle([x0, y0, x1, y1], radius=radio, fill=color)


def dibujar() -> "Image.Image":
    """La psi, a 1024 px."""
    img = Image.new("RGBA", (LIENZO, LIENZO), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    # --- Fondo: cuadrado redondeado ---------------------------------------
    #  El margen deja aire alrededor. Sin él, Windows dibuja el icono pegado
    #  a los bordes y parece más grande que los del resto de la barra.
    margen = 48
    d.rounded_rectangle(
        [margen, margen, LIENZO - margen, LIENZO - margen],
        radius=200, fill=FONDO, outline=BORDE, width=8,
    )

    # --- La psi -----------------------------------------------------------
    #  Se construye con cuatro trazos:
    #    · el tallo vertical, que sobresale por abajo
    #    · los dos brazos exteriores
    #    · la base que los une
    #  Las medidas están en píxeles del lienzo de 1024.
    grosor = 74
    radio = grosor // 2

    centro = LIENZO // 2
    arriba = 250          # donde empiezan los brazos y el tallo
    base_y = 590          # altura de la barra que une los brazos
    abajo = 812           # final del tallo, por debajo de la base
    izq = 300             # brazo izquierdo
    der = 724             # brazo derecho

    # Brazos exteriores
    _barra(d, izq - radio, arriba, izq + radio, base_y + radio, GLIFO, radio)
    _barra(d, der - radio, arriba, der + radio, base_y + radio, GLIFO, radio)
    # Base que los une
    _barra(d, izq - radio, base_y - radio, der + radio, base_y + radio, GLIFO, radio)
    # Tallo central: se dibuja el ÚLTIMO para que quede por encima de la base
    _barra(d, centro - radio, arriba, centro + radio, abajo, GLIFO, radio)

    # Pie del tallo, como el de la letra impresa
    _barra(d, centro - 130, abajo - grosor, centro + 130, abajo, GLIFO, radio)

    return img


def main() -> int:
    grande = dibujar()

    # Un fotograma por tamaño, reducido con LANCZOS desde el lienzo grande.
    # Se hace a mano en vez de dejárselo a `save(sizes=...)` porque Pillow
    # reduce internamente desde la imagen que le pasas usando NEAREST en
    # algunas versiones, y el resultado a 16 px sale con dientes de sierra.
    fotogramas = [grande.resize((n, n), Image.LANCZOS) for n in TAMANOS]

    DESTINO.parent.mkdir(parents=True, exist_ok=True)
    fotogramas[-1].save(
        DESTINO, format="ICO",
        sizes=[(n, n) for n in TAMANOS],
        append_images=fotogramas[:-1],
    )

    kb = DESTINO.stat().st_size / 1024
    print(f"OK  {DESTINO.relative_to(RAIZ)}  ({kb:.1f} KB)")
    print(f"    Tamaños: {', '.join(f'{n}x{n}' for n in TAMANOS)}")
    print()
    print("Lo recogen solos, sin tocar nada más:")
    print("    desktop/psi_core.spec   -> icon=... (ya comprueba si existe)")
    print("    desktop/instalador.iss  -> SetupIconFile")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
