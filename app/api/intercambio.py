# -*- coding: utf-8 -*-
"""
intercambio.py
==============
Las piezas comunes de EXPORTAR e IMPORTAR, que hoy hacen dos cosas:

  * un PROYECTO entero  -> `proyecto_routes.py`
  * una PANTALLA suelta -> `project_routes.py`

**Por qué un módulo aparte.** Las dos operaciones comparten las decisiones que
de verdad importan —cómo se elige un id libre, qué widgets personalizados
viajan, qué se hace con los enlaces entre pantallas— y son exactamente las
decisiones que se rompen cuando se copian y pegan: se arregla un caso, el otro
se queda atrás, y nadie se entera hasta que alguien importa algo raro.

Lo que viaja dentro de un fichero exportado, y por qué:

  * las pantallas y sus widgets     -> es lo que se quiere llevar;
  * los widgets personalizados      -> sin ellos quedan cajas vacías;
  * las variables INTERNAS enlazadas -> sin ellas los widgets se enlazan
    a algo que en el otro equipo no existe, y el síntoma es un widget en
    blanco sin ningún error;
  * las variables de PLC NO viajan  -> existen porque existe el autómata.
    Crearlas al importar sería inventarse un dato que nadie puede leer.

Nada de esto sabe de HTTP a propósito. Las rutas deciden códigos y mensajes;
aquí solo vive la lógica que las dos comparten.
"""
from __future__ import annotations

import logging
import unicodedata
import re
from datetime import datetime, timezone
from typing import Any, Callable, Dict, List, Optional, Tuple

logger = logging.getLogger("intercambio")

#: Marca del fichero. Se comprueba al importar para poder decir "esto no es un
#: proyecto" en vez de reventar con un KeyError en la línea 40.
FORMATO_PROYECTO = "psicore.proyecto"
FORMATO_PANTALLA = "psicore.pantalla"

#: Versión del formato, común a los dos. Sube cuando cambie de forma
#: incompatible. Un fichero con una versión MAYOR se rechaza con un mensaje
#: que dice qué pasa: leerlo a medias y crear algo incompleto es mucho peor
#: que no importarlo.
FORMATO_VERSION = 1

#: Tope de pantallas en un fichero de proyecto. No es una limitación del
#: producto: un JSON de fuera puede traer cualquier cosa, y crear diez mil
#: pantallas dejaría la carpeta de datos inservible antes de poder cancelar.
MAX_PANTALLAS_IMPORTADAS = 200

#: Claves cuyo valor es el ID DE UNA PANTALLA dentro de la configuración de un
#: widget. Hoy solo la usa el Menú Lateral (`config.secciones[].pantalla`),
#: que guarda a qué pantalla salta cada sección.
#:
#: Importa porque los ids pueden cambiar al importar, y un enlace que apunte
#: al id viejo llevaría a la pantalla de otro proyecto —o a ninguna— sin dar
#: ningún error.
CLAVES_DE_PANTALLA = ("pantalla", "project_id")

#: Claves cuyo valor es la CLAVE DE UNA VARIABLE (`<plc>|<tag>`) enlazada a un
#: widget. Se busca por nombre de clave y en profundidad, igual que
#: `CLAVES_DE_PANTALLA`, porque el enlace no siempre está en el mismo sitio:
#: la mayoría de widgets lo guardan en `widget.variableId`, pero la tendencia
#: lleva una por serie, dentro de `config.series[].variableId`.
#:
#: Buscar la CLAVE en vez de una ruta fija es lo que hace que un widget nuevo
#: que enlace variables funcione sin tocar esto — con la condición, escrita
#: aquí para quien lo lea mañana, de que llame `variableId` a su campo.
CLAVES_DE_VARIABLE = ("variableId",)

#: Prefijo de las variables que viven en el servidor y no en un PLC. Tiene que
#: coincidir con `PLC_INTERNO` en `app/core/internas_store.py`.
PREFIJO_INTERNA = "interno|"


def ahora_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def slug(texto: str, maximo: int = 40) -> str:
    """Convierte un nombre escrito por una persona en algo que valga como id."""
    base = unicodedata.normalize("NFD", texto or "")
    base = "".join(c for c in base if unicodedata.category(c) != "Mn")
    base = re.sub(r"[^A-Za-z0-9]+", "_", base).strip("_").lower()
    return base[:maximo]


def id_libre(ocupado: Callable[[str], bool], base: str,
             maximo: int = 64, intentos: int = 500) -> Optional[str]:
    """
    Primer id de la familia `base`, `base_2`, `base_3`… que esté libre.

    Se prefiere SIEMPRE el original. Importar en un equipo donde eso no existe
    deja los ids tal cual estaban, y eso vale por dos: los enlaces entre
    pantallas siguen apuntando a donde deben sin tocar nada, y el fichero de
    disco se llama igual en los dos equipos, que es lo que uno espera al mover
    algo de sitio.

    Devuelve `None` si no encuentra hueco; quien llama decide qué error dar.
    """
    base = (base or "importado")[:maximo]
    if not ocupado(base):
        return base
    for i in range(2, intentos):
        sufijo = f"_{i}"
        intento = f"{base[:maximo - len(sufijo)]}{sufijo}"
        if not ocupado(intento):
            return intento
    return None


def nombre_libre(usados: List[str], nombre: str, sufijo: str,
                 maximo: int = 80) -> str:
    """
    Marca el nombre solo si CHOCA con uno que ya existe.

    Dos cosas con el mismo nombre en una lista son indistinguibles, y el caso
    normal de importar es "traigo otra vez lo que ya tenía". Añadir el sufijo
    siempre ensuciaría el nombre sin motivo; no añadirlo nunca dejaría dos
    entradas idénticas.
    """
    if nombre not in usados:
        return nombre[:maximo]
    return f"{nombre} {sufijo}"[:maximo]


def kinds_personalizados(pantallas: List[dict]) -> List[str]:
    """
    Los widgets `custom:` que usan estas pantallas, sin repetir y sin prefijo.

    Ojo: no todos los `custom:` son importados. Los de navegación
    (`custom:menu-lateral`, `custom:pantalla-screen`…) vienen compilados dentro
    de la aplicación y no están en el almacén, así que quien llama tiene que
    aceptar que alguno no aparezca. No es un error: significa "ese ya lo trae
    el programa".
    """
    kinds: List[str] = []
    for pantalla in pantallas:
        for widget in pantalla.get("widgets", []):
            kind = str(widget.get("kind") or "")
            if not kind.startswith("custom:"):
                continue
            limpio = kind[len("custom:"):]
            if limpio and limpio not in kinds:
                kinds.append(limpio)
    return kinds


def widgets_para_exportar(widget_store, pantallas: List[dict]) -> List[dict]:
    """
    La DEFINICIÓN de los widgets personalizados que usan estas pantallas.

    Sin esto, abrir lo exportado en otro equipo dejaría cajas vacías donde
    había un widget, sin ningún error que lo explicara: el diseño sabe que ahí
    va un `custom:manometro`, pero ese equipo no tiene ni idea de qué es eso.
    """
    if widget_store is None:
        return []
    salida: List[dict] = []
    for kind in kinds_personalizados(pantallas):
        w = widget_store.obtener(kind)
        if w is None:
            continue
        salida.append({
            "kind": w.kind, "nombre": w.nombre,
            "html": w.html, "css": w.css, "js": w.js, "meta": w.meta,
        })
    return salida


def importar_widgets(widget_store, lista: List[dict],
                     usuario: str = "") -> Tuple[List[str], List[str], List[str]]:
    """
    Guarda los widgets del fichero que NO existan ya aquí.

    Devuelve `(importados, ya_existentes, con_error)`.

    Los que ya están se dejan como están: reemplazarlos cambiaría el aspecto
    de OTROS proyectos que los usen, y eso nadie lo ha pedido.

    Un widget que no se deja guardar no tumba la importación. Si el diseño ya
    está creado, quedarse sin un widget es un problema pequeño y visible (una
    caja vacía) mientras que tirarlo todo por eso sería desproporcionado: se
    cuenta lo que pasó y se sigue.
    """
    importados: List[str] = []
    omitidos: List[str] = []
    fallidos: List[str] = []
    if widget_store is None:
        return importados, omitidos, fallidos

    for w in lista or []:
        kind = str(w.get("kind") or "")
        if not kind:
            continue
        if widget_store.obtener(kind) is not None:
            omitidos.append(kind)
            continue
        try:
            widget_store.guardar(
                kind, str(w.get("nombre") or ""), str(w.get("html") or ""),
                str(w.get("css") or ""), str(w.get("js") or ""),
                w.get("meta") or {}, usuario,
            )
            importados.append(kind)
        except ValueError as exc:
            logger.warning("Widget '%s' del fichero no se pudo guardar: %s",
                           kind, exc)
            fallidos.append(kind)
    return importados, omitidos, fallidos


def internas_usadas(pantallas: List[dict]) -> List[str]:
    """
    Nombres de las variables INTERNAS que enlazan estos widgets, sin repetir.

    Recorre la estructura entera buscando las claves de `CLAVES_DE_VARIABLE`,
    no una ruta fija: la tendencia guarda una variable por serie dentro de
    `config`, y un enlace que no se encuentre aquí es un enlace que llegará
    roto al otro equipo.

    Solo devuelve las INTERNAS. Las de PLC no viajan y no deben: una variable
    de campo existe porque existe el autómata, y "crearla" al importar sería
    inventarse un dato que nadie puede leer. Si el PLC destino no la tiene, el
    widget se queda sin valor y eso es lo correcto — el arreglo es conectar el
    PLC, no falsificar la variable.
    """
    nombres: List[str] = []

    def _recorrer(v: Any) -> None:
        if isinstance(v, dict):
            for clave, dentro in v.items():
                if (clave in CLAVES_DE_VARIABLE and isinstance(dentro, str)
                        and dentro.startswith(PREFIJO_INTERNA)):
                    nombre = dentro[len(PREFIJO_INTERNA):]
                    if nombre and nombre not in nombres:
                        nombres.append(nombre)
                else:
                    _recorrer(dentro)
        elif isinstance(v, list):
            for x in v:
                _recorrer(x)

    for pantalla in pantallas:
        _recorrer(pantalla.get("widgets", []))
    return nombres


def internas_para_exportar(internas_store, pantallas: List[dict]) -> List[dict]:
    """
    La DEFINICIÓN de las variables internas que usan estas pantallas.

    Mismo razonamiento que `widgets_para_exportar()`: sin esto, abrir lo
    exportado en otro equipo deja widgets enlazados a `interno|nivel` donde no
    existe ninguna `nivel`, y el síntoma es un widget en blanco sin un solo
    error que lo explique.

    **No viaja el valor actual, sí el inicial.** El valor de ahora es estado
    de ejecución de OTRA instalación: traerse un «modo manual» en `true`
    porque alguien lo dejó puesto sería importar una decisión que nadie tomó
    aquí. El `valor_inicial` sí es configuración —es con qué debe arrancar— y
    es lo que se usa para darle valor a la variable recién creada.
    """
    if internas_store is None:
        return []
    salida: List[dict] = []
    for nombre in internas_usadas(pantallas):
        try:
            v = internas_store.obtener(nombre)
        except Exception:  # noqa: BLE001
            # Enlazada a una variable que ya no existe. No es un error de la
            # exportación: es un enlace roto que ya estaba roto aquí.
            logger.warning("El diseño enlaza 'interno|%s', que no existe.",
                           nombre)
            continue
        d = v.como_fila()
        d.pop("valor", None)
        d.pop("creado_en", None)
        d.pop("actualizado_en", None)
        salida.append(d)
    return salida


def importar_internas(internas_store, lista: List[dict],
                      usuario: str = "") -> Tuple[List[str], List[str], List[dict]]:
    """
    Crea las variables internas del fichero que NO existan ya aquí.

    Devuelve `(importadas, ya_existentes, conflictos)`.

    **Una que ya existe se deja como está**, igual que con los widgets:
    reemplazarla cambiaría el valor y los límites de una variable que otros
    proyectos de este equipo pueden estar usando, y eso nadie lo ha pedido. El
    widget importado se enlaza a la que ya hay, que es lo que su nombre dice.

    **Salvo que el TIPO no coincida**, y entonces hay que decirlo. Una
    `nivel` que aquí es Texto y allí era Decimal se va a enlazar igual —la
    clave es la misma— y el widget enseñará algo que no tiene sentido sin dar
    ningún error. Es el único caso en que callarse haría daño, así que se
    devuelve en `conflictos` para que la vista lo nombre.

    Una variable que no se deja crear no tumba la importación, por lo mismo
    que un widget: el diseño ya está, y quedarse sin una variable es un
    problema pequeño y visible.
    """
    importadas: List[str] = []
    existentes: List[str] = []
    conflictos: List[dict] = []
    if internas_store is None:
        return importadas, existentes, conflictos

    for d in lista or []:
        nombre = str(d.get("nombre") or "")
        if not nombre:
            continue
        if internas_store.existe(nombre):
            try:
                actual = internas_store.obtener(nombre)
                if actual.tipo != d.get("tipo"):
                    conflictos.append({
                        "nombre": nombre,
                        "tipo_aqui": actual.tipo,
                        "tipo_del_fichero": d.get("tipo"),
                    })
                else:
                    existentes.append(nombre)
            except Exception:  # noqa: BLE001
                existentes.append(nombre)
            continue
        try:
            # El valor arranca en el inicial: es lo único que el fichero trae
            # y lo único que tiene sentido como punto de partida.
            datos = dict(d)
            datos["valor"] = d.get("valor_inicial")
            internas_store.crear(datos)
            importadas.append(nombre)
        except Exception as exc:  # noqa: BLE001
            logger.warning("Variable interna '%s' del fichero no se pudo "
                           "crear: %s", nombre, exc)
            conflictos.append({"nombre": nombre, "error": str(exc)})
    return importadas, existentes, conflictos


def remapear_pantallas(valor: Any, mapa: Dict[str, str]) -> Any:
    """
    Reescribe los enlaces entre pantallas cuando sus ids han cambiado.

    Recorre la configuración del widget entera porque las secciones del Menú
    Lateral están anidadas dentro de `config`, y mañana puede haber otro widget
    que enlace igual. Solo se tocan las claves de `CLAVES_DE_PANTALLA` y solo
    si su valor es exactamente un id que se ha renombrado: una etiqueta que por
    casualidad diga lo mismo que un id no se toca, porque no está bajo una de
    esas claves.
    """
    if isinstance(valor, dict):
        salida = {}
        for clave, dentro in valor.items():
            if (clave in CLAVES_DE_PANTALLA and isinstance(dentro, str)
                    and dentro in mapa):
                salida[clave] = mapa[dentro]
            else:
                salida[clave] = remapear_pantallas(dentro, mapa)
        return salida
    if isinstance(valor, list):
        return [remapear_pantallas(x, mapa) for x in valor]
    return valor


def soltar_enlaces_rotos(valor: Any, validos: set) -> Tuple[Any, List[str]]:
    """
    Vacía los enlaces que apunten a una pantalla que no está en `validos`.

    **Es para importar UNA pantalla suelta.** Al llevarse una sola, sus
    enlaces a las pantallas hermanas se quedan sin destino: esas no viajan en
    el fichero. Hay tres salidas posibles y solo una es aceptable:

      * dejar el id tal cual -> si en este equipo existe una pantalla con ese
        id **de otro proyecto**, el Panel de Sección cargaría el diseño del
        HMI de al lado sin decir nada. Es el peor final: no falla, miente;
      * borrar el enlace en silencio -> el usuario pierde su intención sin
        enterarse;
      * borrarlo Y DECIRLO, que es lo que se hace aquí. La sección se queda
        como una sección normal (enseña sus propios widgets) y se devuelve la
        lista de las que se quedaron sin destino para poder nombrarlas.

    Un enlace que SÍ apunta a una pantalla del proyecto destino no se toca:
    ese es el caso de reimportar una pantalla junto a sus hermanas, y ahí
    funciona sin más.
    """
    sueltos: List[str] = []

    def _recorrer(v: Any) -> Any:
        if isinstance(v, dict):
            salida = {}
            for clave, dentro in v.items():
                if (clave in CLAVES_DE_PANTALLA and isinstance(dentro, str)
                        and dentro and dentro not in validos):
                    sueltos.append(dentro)
                    salida[clave] = ""
                else:
                    salida[clave] = _recorrer(dentro)
            return salida
        if isinstance(v, list):
            return [_recorrer(x) for x in v]
        return v

    limpio = _recorrer(valor)
    # Sin repetir, conservando el orden en que aparecieron.
    unicos = list(dict.fromkeys(sueltos))
    return limpio, unicos
