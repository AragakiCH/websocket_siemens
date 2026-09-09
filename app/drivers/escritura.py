# -*- coding: utf-8 -*-
"""
escritura.py
============
Conversión de un valor de JSON al tipo EXACTO que espera el PLC.

POR QUÉ ES UN MÓDULO APARTE, Y POR QUÉ TIENE TANTOS COMENTARIOS
---------------------------------------------------------------
Leer un tag y escribirlo no son operaciones simétricas. Al leer, si el tipo se
interpreta mal, se ve un número raro en pantalla y alguien lo nota. Al escribir,
un tipo mal convertido **mueve algo en la planta**, y puede hacerlo sin dar
ningún error.

Los dos drivers (Siemens por OPC UA y Rexroth ctrlX, que también expone OPC UA)
comparten este módulo: la conversión es la misma y no debe divergir entre ellos.

LAS TRAMPAS QUE ESTO EVITA
--------------------------
1. `bool("false")` en Python es **True**. Y `bool("0")` también. Si el frontend
   manda la cadena "false" —cosa que pasa en cuanto un valor viaja por un
   `<input>` o por un query string— una conversión ingenua ARRANCARÍA el motor
   que se pretendía parar. Es el fallo más peligroso del módulo y por eso los
   booleanos se tratan con una lista explícita de textos aceptados.

2. Los enteros de OPC UA tienen ANCHO. Escribir 40000 en un `Int16` (máximo
   32767) no es un error obvio: según el servidor, puede desbordar en silencio
   y quedarse en -25536. Aquí se comprueba el rango de cada ancho y se rechaza
   antes de salir a la red.

3. `int` no vale donde el PLC espera `Float`. asyncua es estricto con el
   Variant, y un 5 entero contra un nodo Real puede fallar con un error de
   tipo ilegible o, peor, escribirse mal. Se convierte explícitamente.

4. `3.7` en un entero se truncaría a 3 sin avisar. Si alguien manda un decimal
   a una consigna entera, es que se ha equivocado: se rechaza en vez de
   redondear por su cuenta.
"""
from __future__ import annotations

from typing import Any

# Rango de cada entero de OPC UA. Escribir fuera de esto es un error del que
# llama, no algo que deba resolver el servidor desbordando.
RANGOS_ENTEROS = {
    "SByte": (-128, 127),
    "Byte": (0, 255),
    "Int16": (-32768, 32767),
    "UInt16": (0, 65535),
    "Int32": (-2147483648, 2147483647),
    "UInt32": (0, 4294967295),
    "Int64": (-9223372036854775808, 9223372036854775807),
    "UInt64": (0, 18446744073709551615),
}

TIPOS_REALES = {"Float", "Double"}
TIPOS_TEXTO = {"String", "LocalizedText", "XmlElement"}

# Textos que se aceptan como booleano. Todo lo demás se rechaza: es preferible
# un error claro a interpretar "quizá" como "sí" delante de un actuador.
TEXTO_VERDADERO = {"true", "1", "on", "si", "sí", "verdadero", "activo", "high"}
TEXTO_FALSO = {"false", "0", "off", "no", "falso", "inactivo", "low"}


class ErrorDeTipo(ValueError):
    """El valor no encaja con el tipo del tag. Lleva un mensaje accionable."""


def convertir(valor: Any, data_type: str) -> Any:
    """
    Devuelve `valor` convertido al tipo Python que corresponde a `data_type`.

    Lanza `ErrorDeTipo` con una explicación en castellano si no encaja. Nunca
    adivina: ante la duda, falla.
    """
    tipo = (data_type or "").strip()

    # ---------------------------------------------------------------- #
    # Booleanos
    # ---------------------------------------------------------------- #
    if tipo == "Boolean":
        if isinstance(valor, bool):
            return valor
        if isinstance(valor, (int, float)) and not isinstance(valor, bool):
            # 0 y 1 son inequívocos; 7 no lo es. Aceptar cualquier número
            # distinto de cero como "verdadero" es la clase de comodidad que
            # acaba arrancando una bomba por un valor que nadie revisó.
            if valor in (0, 1):
                return bool(valor)
            raise ErrorDeTipo(
                f"'{valor}' no es un booleano. Para un tag Boolean se admite "
                f"true/false, o los números 0 y 1."
            )
        if isinstance(valor, str):
            v = valor.strip().lower()
            if v in TEXTO_VERDADERO:
                return True
            if v in TEXTO_FALSO:
                return False
            raise ErrorDeTipo(
                f"'{valor}' no es un booleano reconocible. Usa true/false. "
                f"(Ojo: en Python la cadena 'false' vale como verdadera, así "
                f"que aquí se rechaza cualquier texto que no esté en la lista.)"
            )
        raise ErrorDeTipo(f"No se puede escribir {type(valor).__name__} en un tag Boolean.")

    # ---------------------------------------------------------------- #
    # Enteros
    # ---------------------------------------------------------------- #
    if tipo in RANGOS_ENTEROS:
        minimo, maximo = RANGOS_ENTEROS[tipo]

        if isinstance(valor, bool):
            # True vale 1 en Python. Permitirlo aquí escondería un error de
            # enlace entre un interruptor y una consigna numérica.
            raise ErrorDeTipo(
                f"El tag es {tipo} (entero) y se recibió un booleano. "
                f"Revisa a qué variable está enlazado el widget."
            )

        if isinstance(valor, float):
            if not valor.is_integer():
                raise ErrorDeTipo(
                    f"El tag es {tipo} (entero) y {valor} tiene decimales. "
                    f"Redondearlo aquí ocultaría el error: mándalo ya redondeado."
                )
            valor = int(valor)

        if isinstance(valor, str):
            try:
                valor = int(valor.strip())
            except ValueError:
                raise ErrorDeTipo(f"'{valor}' no es un número entero válido.")

        if not isinstance(valor, int):
            raise ErrorDeTipo(f"No se puede escribir {type(valor).__name__} en un tag {tipo}.")

        if not (minimo <= valor <= maximo):
            raise ErrorDeTipo(
                f"{valor} se sale del rango de un {tipo} ({minimo} a {maximo}). "
                f"El PLC podría desbordarlo en silencio, así que se rechaza aquí."
            )
        return valor

    # ---------------------------------------------------------------- #
    # Reales
    # ---------------------------------------------------------------- #
    if tipo in TIPOS_REALES:
        if isinstance(valor, bool):
            raise ErrorDeTipo(
                f"El tag es {tipo} (decimal) y se recibió un booleano. "
                f"Revisa a qué variable está enlazado el widget."
            )
        if isinstance(valor, (int, float)):
            return float(valor)
        if isinstance(valor, str):
            try:
                return float(valor.strip().replace(",", "."))
            except ValueError:
                raise ErrorDeTipo(f"'{valor}' no es un número válido.")
        raise ErrorDeTipo(f"No se puede escribir {type(valor).__name__} en un tag {tipo}.")

    # ---------------------------------------------------------------- #
    # Texto
    # ---------------------------------------------------------------- #
    if tipo in TIPOS_TEXTO:
        if isinstance(valor, (str, int, float)) and not isinstance(valor, bool):
            return str(valor)
        if isinstance(valor, bool):
            return "true" if valor else "false"
        raise ErrorDeTipo(f"No se puede escribir {type(valor).__name__} en un tag de texto.")

    # ---------------------------------------------------------------- #
    # Tipo desconocido
    # ---------------------------------------------------------------- #
    # Se rechaza en vez de intentarlo "a ver si cuela". Un tipo que este
    # módulo no conoce (una estructura, un array, un enumerado propio) merece
    # una implementación pensada, no una conversión por descarte.
    raise ErrorDeTipo(
        f"Tipo de dato '{data_type}' no soportado para escritura. "
        f"Soportados: Boolean, {', '.join(sorted(RANGOS_ENTEROS))}, "
        f"{', '.join(sorted(TIPOS_REALES))}, {', '.join(sorted(TIPOS_TEXTO))}."
    )


def es_escribible(data_type: str) -> bool:
    """¿Sabe este módulo convertir a ese tipo? Para avisar al configurar."""
    tipo = (data_type or "").strip()
    return (
        tipo == "Boolean"
        or tipo in RANGOS_ENTEROS
        or tipo in TIPOS_REALES
        or tipo in TIPOS_TEXTO
    )
