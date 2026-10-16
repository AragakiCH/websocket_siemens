# -*- coding: utf-8 -*-
"""
funciones_py.py
===============
El «modo función» de los widgets: la salida de un widget se calcula con
código PYTHON escrito en el Diseñador, a partir de unos tags de entrada y
unas variables internas.

QUÉ RECIBE Y QUÉ DEVUELVE
-------------------------
    entradas   {nombre: valor}  los tags, de solo lectura dentro del código
    internas   {nombre: valor}  variables propias de la función; lo que el
                                código les deje queda para la SIGUIENTE
                                evaluación (así un `contador` cuenta)
    salida     el nombre de la variable que hay que calcular (`varPrincipal`,
                                `var1`…)

El código asigna la salida:

    if temperatura > 80:
        varPrincipal = 3
    else:
        varPrincipal = contador

o, si es una sola expresión, su valor es el resultado:

    (nivel_a + nivel_b) / 2

Se pueden definir funciones (`def`) y usar `math`. Lo que se imprima con
`print()` se devuelve para verlo en «Valores de prueba».

POR QUÉ NO ES `exec()` A SECAS
------------------------------
Esto corre en el servidor, con el texto que alguien escribió en un
navegador. Un `exec` sin más es un intérprete abierto en la máquina del
HMI. Así que:

  1. El código se analiza ANTES de ejecutarse (`validar`). No se admiten
     `import`, `with`, `class`, nada `async`, ni atributos que empiecen por
     `_` (por ahí se sale de cualquier sandbox: `().__class__.__bases__…`).
  2. Los builtins son una lista cerrada: aritmética, texto, listas,
     `round`, `min`, `max`, `abs`… Nada de `open`, `eval`, `exec`,
     `__import__`, `getattr`, `globals`.
  3. Hay un LÍMITE DE TIEMPO. Un `while True` colgaría el hilo para siempre;
     con la traza activa se corta a los pocos cientos de milisegundos y se
     devuelve un error que dice en qué línea estaba.

No es una sandbox perfecta —ninguna hecha con `exec` lo es— y no pretende
contener a un atacante con acceso de Administrador al Diseñador, que de
todas formas ya puede escribir en el PLC. Pretende que un error honesto (un
bucle infinito, un `open` por costumbre) no tumbe el servicio ni toque el
disco. Quien diseña pantallas ya es alguien de confianza en esta aplicación.

LA EVALUACIÓN ES POR CAMBIO, NO POR VISOR
-----------------------------------------
Diez visores mirando el mismo widget mandan diez peticiones con las mismas
entradas. Si cada una ejecutara el código, un `contador = contador + 1`
contaría visores en vez de eventos. Por eso `Evaluador.evaluar()` recuerda,
por widget y salida, con qué entradas y qué código se calculó la última vez:
mientras no cambien, devuelve lo mismo sin ejecutar nada. La función corre
UNA vez por cambio real, como correría en un PLC.
"""
from __future__ import annotations

import ast
import asyncio
import ctypes
import hashlib
import json
import logging
import math
import threading
import time
import traceback
from typing import Any, Dict, List, Optional, Tuple

logger = logging.getLogger("funciones_py")

NOMBRE_FICHERO = "<funcion>"
# Tiempo máximo de UNA evaluación. Una función de HMI son unas decenas de
# operaciones; medio segundo es cien veces más de lo que necesita.
LIMITE_S = 0.5
MAX_IMPRESIONES = 50
MAX_CODIGO = 20_000


# ====================================================================== #
# Lo que el código puede usar
# ====================================================================== #
def _builtins_seguros(impresiones: List[str]) -> Dict[str, Any]:
    def _print(*args, **kwargs):
        sep = kwargs.get("sep", " ")
        texto = sep.join(str(a) for a in args)
        if len(impresiones) < MAX_IMPRESIONES:
            impresiones.append(texto)
        elif len(impresiones) == MAX_IMPRESIONES:
            impresiones.append("…")

    return {
        # Números y texto
        "abs": abs, "round": round, "min": min, "max": max, "sum": sum,
        "int": int, "float": float, "str": str, "bool": bool, "divmod": divmod,
        "pow": pow, "len": len, "range": range, "enumerate": enumerate,
        "zip": zip, "map": map, "filter": filter, "sorted": sorted,
        "reversed": reversed, "any": any, "all": all, "isinstance": isinstance,
        "list": list, "tuple": tuple, "dict": dict, "set": set,
        "repr": repr, "format": format, "chr": chr, "ord": ord,
        "True": True, "False": False, "None": None,
        # Excepciones, para que un `try` tenga algo que atrapar
        "Exception": Exception, "ValueError": ValueError,
        "TypeError": TypeError, "ZeroDivisionError": ZeroDivisionError,
        "KeyError": KeyError, "IndexError": IndexError,
        "print": _print,
    }


NOMBRES_PROHIBIDOS = frozenset({
    "exec", "eval", "compile", "open", "__import__", "import", "globals",
    "locals", "vars", "getattr", "setattr", "delattr", "hasattr", "input",
    "breakpoint", "exit", "quit", "help", "dir", "memoryview", "bytearray",
    "bytes", "super", "object", "type", "classmethod", "staticmethod",
    "property", "__builtins__", "__loader__", "__spec__", "__name__",
})

NODOS_PROHIBIDOS = (
    ast.Import, ast.ImportFrom, ast.ClassDef, ast.With, ast.AsyncWith,
    ast.AsyncFunctionDef, ast.AsyncFor, ast.Await, ast.Yield, ast.YieldFrom,
    ast.Global, ast.Nonlocal,
)

PALABRAS_CLAVE = frozenset({
    "False", "None", "True", "and", "as", "assert", "async", "await", "break",
    "class", "continue", "def", "del", "elif", "else", "except", "finally",
    "for", "from", "global", "if", "import", "in", "is", "lambda", "nonlocal",
    "not", "or", "pass", "raise", "return", "try", "while", "with", "yield",
})


# ====================================================================== #
# Análisis previo
# ====================================================================== #
class ErrorFuncion(Exception):
    def __init__(self, mensaje: str, linea: Optional[int] = None) -> None:
        super().__init__(mensaje)
        self.mensaje = mensaje
        self.linea = linea


def _traducir_sintaxis(exc: SyntaxError) -> str:
    msg = exc.msg or "error de sintaxis"
    traducciones = {
        "invalid syntax": "sintaxis no válida",
        "unexpected indent": "sangría inesperada",
        "expected an indented block": "falta el bloque sangrado",
        "unindent does not match any outer indentation level":
            "la sangría no coincide con ningún nivel anterior",
        "unterminated string literal": "texto sin cerrar",
        "'(' was never closed": "falta cerrar un paréntesis",
    }
    for k, v in traducciones.items():
        if k in msg:
            return v
    return msg


def analizar(codigo: str) -> ast.Module:
    """
    Parsea y comprueba que el código solo use lo permitido.

    Lanza `ErrorFuncion` con la línea del problema.
    """
    if len(codigo) > MAX_CODIGO:
        raise ErrorFuncion(f"El código es demasiado largo (máximo {MAX_CODIGO} caracteres).")
    try:
        arbol = ast.parse(codigo, filename=NOMBRE_FICHERO, mode="exec")
    except SyntaxError as exc:
        raise ErrorFuncion(_traducir_sintaxis(exc), exc.lineno)

    for nodo in ast.walk(arbol):
        if isinstance(nodo, NODOS_PROHIBIDOS):
            que = type(nodo).__name__
            legible = {
                "Import": "import", "ImportFrom": "import", "ClassDef": "class",
                "With": "with", "Global": "global", "Nonlocal": "nonlocal",
            }.get(que, que.lower())
            raise ErrorFuncion(f"«{legible}» no está permitido en una función de widget.",
                               getattr(nodo, "lineno", None))
        if isinstance(nodo, ast.Attribute) and nodo.attr.startswith("_"):
            raise ErrorFuncion(f"No se puede acceder a «.{nodo.attr}».",
                               getattr(nodo, "lineno", None))
        if isinstance(nodo, ast.Name) and nodo.id in NOMBRES_PROHIBIDOS:
            raise ErrorFuncion(f"«{nodo.id}» no está disponible aquí.",
                               getattr(nodo, "lineno", None))
        if isinstance(nodo, ast.Name) and nodo.id.startswith("__"):
            raise ErrorFuncion(f"Los nombres que empiezan por «__» están reservados.",
                               getattr(nodo, "lineno", None))
    return arbol


def nombres_usados(arbol: ast.Module) -> Tuple[List[str], List[str]]:
    """
    (leídos, asignados): qué nombres lee el código y a cuáles escribe, en
    orden de aparición y sin repetir. Los definidos dentro (parámetros de
    `def`, variables de `for`, nombres asignados antes de leerse) no cuentan
    como «leídos de fuera».
    """
    leidos: List[str] = []
    asignados: List[str] = []
    locales: set = set()

    def anotar(lista: List[str], n: str) -> None:
        if n not in lista:
            lista.append(n)

    for nodo in ast.walk(arbol):
        if isinstance(nodo, (ast.FunctionDef, ast.Lambda)):
            args = nodo.args
            for a in list(args.args) + list(args.kwonlyargs) + list(getattr(args, "posonlyargs", [])):
                locales.add(a.arg)
            if args.vararg:
                locales.add(args.vararg.arg)
            if args.kwarg:
                locales.add(args.kwarg.arg)
            if isinstance(nodo, ast.FunctionDef):
                locales.add(nodo.name)
        elif isinstance(nodo, ast.comprehension):
            for sub in ast.walk(nodo.target):
                if isinstance(sub, ast.Name):
                    locales.add(sub.id)
        elif isinstance(nodo, ast.ExceptHandler) and nodo.name:
            locales.add(nodo.name)

    for nodo in ast.walk(arbol):
        if isinstance(nodo, ast.Name):
            if isinstance(nodo.ctx, ast.Store):
                anotar(asignados, nodo.id)
            elif isinstance(nodo.ctx, ast.Load) and nodo.id not in locales:
                anotar(leidos, nodo.id)
    return leidos, asignados


def validar(codigo: str, nombres: List[str], salida: str) -> Dict[str, Any]:
    """
    Para el editor: ¿compila? ¿qué nombres usa? ¿cuáles no existen?

    `nombres` son las entradas e internas del modal. Un nombre leído que no
    esté ahí, ni sea un builtin, ni `math`, ni se asigne antes en el propio
    código, es casi seguro un error de tecleo — se avisa, no se bloquea:
    el servidor es quien dirá «no está definido» si de verdad no lo está.
    """
    if not codigo.strip():
        return {"ok": True, "vacio": True, "leidos": [], "asignados": [],
                "desconocidos": [], "asigna_salida": False, "error": "", "linea": None}
    try:
        arbol = analizar(codigo)
    except ErrorFuncion as exc:
        return {"ok": False, "vacio": False, "leidos": [], "asignados": [],
                "desconocidos": [], "asigna_salida": False,
                "error": exc.mensaje, "linea": exc.linea}
    leidos, asignados = nombres_usados(arbol)
    conocidos = set(nombres) | set(_builtins_seguros([]).keys()) | {"math", salida}
    desconocidos = [n for n in leidos if n not in conocidos and n not in asignados
                    and n not in PALABRAS_CLAVE]
    ultimo = arbol.body[-1] if arbol.body else None
    termina_en_expresion = isinstance(ultimo, ast.Expr) and not (
        isinstance(ultimo.value, ast.Call)
        and isinstance(ultimo.value.func, ast.Name)
        and ultimo.value.func.id == "print")
    return {
        "ok": True, "vacio": False, "leidos": leidos, "asignados": asignados,
        "desconocidos": desconocidos,
        "asigna_salida": salida in asignados or termina_en_expresion,
        "error": "", "linea": None,
    }


# ====================================================================== #
# Ejecución
# ====================================================================== #
def _preparar(arbol: ast.Module) -> Any:
    """
    Compila el árbol. Si el código termina en una expresión suelta, su valor
    se guarda en `__resultado__` para usarlo como salida.
    """
    if arbol.body and isinstance(arbol.body[-1], ast.Expr):
        ultimo = arbol.body[-1]
        es_print = (isinstance(ultimo.value, ast.Call)
                    and isinstance(ultimo.value.func, ast.Name)
                    and ultimo.value.func.id == "print")
        if not es_print:
            asign = ast.Assign(
                targets=[ast.Name(id="__resultado__", ctx=ast.Store())],
                value=ultimo.value)
            ast.copy_location(asign, ultimo)
            arbol.body[-1] = asign
            ast.fix_missing_locations(arbol)
    return compile(arbol, NOMBRE_FICHERO, "exec")


def _linea_del_error(exc: BaseException) -> Optional[int]:
    """La línea DEL CÓDIGO DEL USUARIO donde reventó, si se puede saber."""
    for frame in reversed(traceback.extract_tb(exc.__traceback__)):
        if frame.filename == NOMBRE_FICHERO:
            return frame.lineno
    return None


def _traducir_runtime(exc: BaseException) -> str:
    nombre = type(exc).__name__
    texto = str(exc)
    if isinstance(exc, NameError):
        n = texto.split("'")[1] if "'" in texto else texto
        return f"«{n}» no está definido. ¿Es una entrada o variable interna del modal?"
    if isinstance(exc, ZeroDivisionError):
        return "División entre cero."
    if isinstance(exc, TypeError) and "NoneType" in texto:
        return ("Una entrada no tiene valor todavía (None): el tag no se está "
                "leyendo. Comprueba con `if x is not None`.")
    if isinstance(exc, TypeError):
        return f"Tipos incompatibles: {texto}"
    if isinstance(exc, RecursionError):
        return "Recursión demasiado profunda."
    return f"{nombre}: {texto}"


def _coaccionar(valor: Any, tipo: str) -> Any:
    """Lo que el código dejó en una interna, al tipo declarado."""
    try:
        if valor is None:
            return None
        if tipo == "bool":
            return bool(valor)
        if tipo == "entero":
            return int(valor)
        if tipo == "decimal":
            return float(valor)
        if tipo == "texto":
            return str(valor)
    except (TypeError, ValueError):
        pass
    return valor


def valor_inicial(tipo: str) -> Any:
    return {"bool": False, "entero": 0, "decimal": 0.0, "texto": ""}.get(tipo, None)


def _serializable(v: Any) -> Any:
    """Solo lo que viaja en JSON. Lo demás, como texto."""
    if v is None or isinstance(v, (bool, int, float, str)):
        if isinstance(v, float) and (math.isnan(v) or math.isinf(v)):
            return None
        return v
    if isinstance(v, (list, tuple)):
        return [_serializable(x) for x in v]
    if isinstance(v, dict):
        return {str(k): _serializable(x) for k, x in v.items()}
    return str(v)


class _TiempoAgotado(BaseException):
    """Se inyecta en el hilo que ejecuta la función cuando vence el plazo."""


def _correr(compilado: Any, espacio: Dict[str, Any], limite_s: float) -> None:
    """
    Ejecuta con un reloj de verdad.

    POR QUÉ NO LA TRAZA DE LÍNEAS. La primera versión cortaba desde
    `settrace`: funcionaba con `while True:` + `pass` en dos líneas y se
    colgaba con `while True: pass` en una (en Python 3.10/3.11), porque un
    bucle que no cambia de línea no genera eventos de línea y la traza nunca
    volvía a llamarse. Un servicio de planta colgado por un renglón mal
    puesto no es aceptable.

    Esto usa `PyThreadState_SetAsyncExc`: un temporizador inyecta una
    excepción en ESTE hilo al vencer el plazo, y el intérprete la entrega en
    la siguiente comprobación de su bucle de evaluación, pase por donde pase
    el código. No depende de líneas, ni de que el código coopere.
    """
    hilo = threading.get_ident()
    disparado = threading.Event()

    def cortar() -> None:
        disparado.set()
        ctypes.pythonapi.PyThreadState_SetAsyncExc(
            ctypes.c_ulong(hilo), ctypes.py_object(_TiempoAgotado))

    reloj = threading.Timer(limite_s, cortar)
    reloj.daemon = True
    reloj.start()
    try:
        exec(compilado, espacio)  # noqa: S102 — ver la cabecera del módulo
    except _TiempoAgotado as exc:
        raise ErrorFuncion(
            f"La función tardó más de {int(limite_s * 1000)} ms y se cortó. "
            f"¿Un bucle sin fin?", _linea_del_error(exc))
    finally:
        reloj.cancel()
        if disparado.is_set():
            # El temporizador llegó a disparar: si fue DESPUÉS de terminar el
            # exec, la excepción sigue pendiente en este hilo y saltaría en
            # cualquier sitio. Se anula.
            ctypes.pythonapi.PyThreadState_SetAsyncExc(ctypes.c_ulong(hilo), None)


def ejecutar_sync(
    codigo: str,
    salida: str,
    entradas: Dict[str, Any],
    internas: Dict[str, Any],
    tipos_internas: Dict[str, str],
    limite_s: float = LIMITE_S,
) -> Dict[str, Any]:
    """
    Una evaluación completa, síncrona. Nunca lanza: todo va en el resultado.

        exito      True si hubo valor
        valor      lo que vale la salida
        internas   las internas DESPUÉS del código, ya coaccionadas
        impreso    lo que escribió print()
        error      texto del fallo, y `linea` si se sabe
        ms         lo que tardó
    """
    inicio = time.perf_counter()
    impresiones: List[str] = []
    base = {"exito": False, "valor": None, "internas": dict(internas),
            "impreso": impresiones, "error": "", "linea": None, "ms": 0.0}

    if not codigo.strip():
        base["error"] = "La función está vacía."
        return base

    try:
        arbol = analizar(codigo)
        compilado = _preparar(arbol)
    except ErrorFuncion as exc:
        base.update(error=exc.mensaje, linea=exc.linea)
        return base

    espacio: Dict[str, Any] = {
        "__builtins__": _builtins_seguros(impresiones),
        "math": math,
    }
    espacio.update(entradas)
    espacio.update(internas)
    # La salida nace con None: así `if ...: varPrincipal = 3` sin `else`
    # deja None (= sin valor) y no un valor de la evaluación anterior.
    espacio.setdefault(salida, None)

    try:
        _correr(compilado, espacio, limite_s)
    except ErrorFuncion as exc:
        base.update(error=exc.mensaje, linea=exc.linea)
    except RecursionError as exc:
        base.update(error=_traducir_runtime(exc), linea=_linea_del_error(exc))
    except Exception as exc:  # noqa: BLE001 — es código ajeno: cualquier cosa
        base.update(error=_traducir_runtime(exc), linea=_linea_del_error(exc))
    else:
        valor = espacio.get(salida)
        if valor is None and "__resultado__" in espacio:
            valor = espacio["__resultado__"]
        base["exito"] = True
        base["valor"] = _serializable(valor)
        if valor is None:
            base["error"] = (f"La función no dejó valor en «{salida}». Asígnalo "
                             f"(`{salida} = …`) o termina con una expresión.")
            base["exito"] = False

    # Las internas, con lo que el código les dejó.
    nuevas: Dict[str, Any] = {}
    for nombre, tipo in tipos_internas.items():
        nuevas[nombre] = _serializable(_coaccionar(espacio.get(nombre, internas.get(nombre)), tipo))
    base["internas"] = nuevas
    base["ms"] = round((time.perf_counter() - inicio) * 1000, 2)
    return base


# ====================================================================== #
# El evaluador con memoria (para los widgets en vivo)
# ====================================================================== #
def _huella(codigo: str, entradas: Dict[str, Any], tipos: Dict[str, str]) -> str:
    cuerpo = json.dumps([codigo, entradas, tipos], sort_keys=True, default=str)
    return hashlib.sha1(cuerpo.encode("utf-8")).hexdigest()


class Evaluador:
    """
    Guarda, por widget y salida, las internas y el último resultado.

    El estado vive en memoria del proceso y se pierde al reiniciar: es estado
    de ejecución (como la vista activa de una navegación), no de diseño. Si
    el código o las entradas cambian, se vuelve a ejecutar; si no, se
    devuelve lo último sin tocar nada — ver la cabecera del módulo.
    """

    MAX_CLAVES = 5000

    def __init__(self) -> None:
        self._estado: Dict[str, Dict[str, Any]] = {}
        self._cerrojos: Dict[str, asyncio.Lock] = {}

    def _cerrojo(self, clave: str) -> asyncio.Lock:
        c = self._cerrojos.get(clave)
        if c is None:
            c = asyncio.Lock()
            self._cerrojos[clave] = c
        return c

    async def evaluar(
        self,
        clave: str,
        codigo: str,
        salida: str,
        entradas: Dict[str, Any],
        tipos_internas: Dict[str, str],
    ) -> Dict[str, Any]:
        async with self._cerrojo(clave):
            huella = _huella(codigo, entradas, tipos_internas)
            previo = self._estado.get(clave)
            if previo and previo.get("huella") == huella:
                return {**previo["resultado"], "cacheado": True}

            # Las internas arrancan en su valor por defecto la primera vez y
            # conservan lo que el código les dejó las siguientes. Una interna
            # nueva en el modal nace a su defecto sin tocar a las demás.
            internas: Dict[str, Any] = {}
            anteriores = (previo or {}).get("internas", {})
            for nombre, tipo in tipos_internas.items():
                internas[nombre] = anteriores.get(nombre, valor_inicial(tipo))

            loop = asyncio.get_running_loop()
            resultado = await loop.run_in_executor(
                None, ejecutar_sync, codigo, salida, entradas, internas, tipos_internas)

            if len(self._estado) >= self.MAX_CLAVES and clave not in self._estado:
                # Antes que crecer sin tope, se olvida lo más viejo.
                self._estado.pop(next(iter(self._estado)))
            self._estado[clave] = {
                "huella": huella,
                "internas": resultado["internas"],
                "resultado": resultado,
                "en": time.time(),
            }
            return {**resultado, "cacheado": False}

    def olvidar(self, prefijo: str = "") -> int:
        """Borra el estado de un widget (`prefijo` = su id) o de todos."""
        claves = [k for k in self._estado if k.startswith(prefijo)]
        for k in claves:
            self._estado.pop(k, None)
            self._cerrojos.pop(k, None)
        return len(claves)

    def estado(self) -> Dict[str, Any]:
        return {"funciones": len(self._estado)}
