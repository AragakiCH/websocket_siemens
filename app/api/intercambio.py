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
  * las variables INTERNAS           -> en un proyecto, TODAS las definidas
    (son parte del trabajo de quien lo diseñó: las 19 de su equipo tienen
    que ser 19 en el otro, no solo las 3 que ya enlazó); en una pantalla
    suelta, las que enlazan sus widgets;
  * los PLC y su configuración      -> definición (sin contraseñas), el
    catálogo de variables que se les vio por última vez y qué tags están
    habilitados para escritura con sus límites. Los VALORES no viajan:
    existen porque existe el autómata. El catálogo sí, porque es lo que
    deja asignar variables y ver los enlaces con el PLC apagado.

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
CLAVES_DE_PANTALLA = ("pantalla", "project_id", "faceplate", "tipo")
#: Claves cuyo valor es una LISTA de ids de pantalla (el Navegador de
#: Pantallas guarda `config.pantallas: [...]`).
CLAVES_LISTA_DE_PANTALLA = ("pantallas",)

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

    def _recorrer(v: Any) -> None:
        # En profundidad: un widget dentro de un Contenedor o de una
        # plantilla también necesita su definición en el otro equipo.
        if isinstance(v, dict):
            kind = v.get("kind")
            if isinstance(kind, str) and kind.startswith("custom:"):
                limpio = kind[len("custom:"):]
                if limpio and limpio not in kinds:
                    kinds.append(limpio)
            for dentro in v.values():
                _recorrer(dentro)
        elif isinstance(v, list):
            for x in v:
                _recorrer(x)

    for pantalla in pantallas:
        _recorrer(pantalla.get("widgets", []))
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
                     usuario: str = "", actualizar: bool = True,
                     ) -> Tuple[List[str], List[str], List[str]]:
    """
    Guarda los widgets del fichero.

    Devuelve `(importados, ya_existentes, con_error)`. En `importados` van
    también los ACTUALIZADOS (ya estaban, pero con otro contenido); en
    `ya_existentes`, los idénticos.

    Un widget que ya está aquí con OTRO contenido se reemplaza por el del
    fichero (`actualizar=True`). Antes se conservaba el de aquí, y el
    resultado era que un proyecto llegaba con los widgets guía de hace tres
    meses y los faceplates salían descuadrados: el fichero trae la versión
    con la que ese proyecto se diseñó, y esa es la que tiene que verse. Los
    proyectos de aquí que usen ese widget lo verán también actualizado; si
    eso no se quiere, `actualizar=False` deja los de aquí intactos.

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
        actual = widget_store.obtener(kind)
        if actual is not None:
            igual = (actual.html == str(w.get("html") or "")
                     and (actual.css or "") == str(w.get("css") or "")
                     and (actual.js or "") == str(w.get("js") or "")
                     and (actual.meta or {}) == (w.get("meta") or {}))
            if igual or not actualizar:
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


def internas_para_exportar(internas_store, pantallas: List[dict],
                           todas: bool = False) -> List[dict]:
    """
    La DEFINICIÓN de las variables internas: las que usan estas pantallas
    o, con `todas=True` (proyecto entero), todas las definidas en el equipo.

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
    if todas:
        # Un proyecto se lleva TODAS las internas del equipo, enlazadas o no:
        # quien las definió las va a necesitar al seguir diseñando allí, y
        # con solo las enlazadas llegaban 3 de 19 y parecía que se perdían.
        filas = []
        try:
            filas = internas_store.listar()
        except Exception as exc:  # noqa: BLE001
            logger.warning("No se pudieron listar las internas: %s", exc)
        for d in filas:
            d = dict(d)
            d.pop("valor", None)
            d.pop("creado_en", None)
            d.pop("actualizado_en", None)
            salida.append(d)
        return salida
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
    if not mapa:
        return valor
    if isinstance(valor, dict):
        salida = {}
        for clave, dentro in valor.items():
            if (clave in CLAVES_DE_PANTALLA and isinstance(dentro, str)
                    and dentro in mapa):
                salida[clave] = mapa[dentro]
            elif (clave in CLAVES_LISTA_DE_PANTALLA and isinstance(dentro, list)
                  and all(isinstance(x, str) for x in dentro)):
                salida[clave] = [mapa.get(x, x) for x in dentro]
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


# ====================================================================== #
# PLC: definición, catálogo de variables y escritura
# ====================================================================== #
#
# Lo que un proyecto necesita del PLC para abrirse igual en otro equipo:
#
#   * la DEFINICIÓN del PLC (IP, puerto, marca, transporte, rack/slot…), sin
#     la contraseña: un Rexroth la pide al importar y se mete a mano;
#   * el CATÁLOGO de variables que se le vio por última vez. No son valores
#     —esos existen porque existe el autómata— sino la lista de nombres y
#     tipos, que es lo que permite asignar variables en el inspector y ver
#     los enlaces con el PLC apagado (ver tags_store.py);
#   * qué tags están HABILITADOS PARA ESCRITURA y con qué límites. Es
#     configuración que se hizo a mano, tag a tag, y rehacerla en el otro
#     equipo es la clase de trabajo que se olvida a medias.
#
# Campos de la definición que viajan. `password` NO está a propósito.
CAMPOS_PLC = ("endpoint", "host", "port", "nombre", "vendor", "usuario",
              "app", "programa", "slot", "rack", "transporte", "s7_tags")
#: Campos de un tag del catálogo (los mismos que guarda tags_store).
CAMPOS_TAG = ("name", "full_name", "node_id", "data_type", "db_name")
#: Campos de una entrada de escritura que son CONFIGURACIÓN (no quién/cuándo).
CAMPOS_ESCRITURA = ("tag", "node_id", "data_type", "minimo", "maximo",
                    "descripcion")


def plcs_para_exportar(plc_manager, escritura_store) -> List[dict]:
    """
    Los PLC dados de alta, cada uno con su catálogo y su lista de escritura.

    El «PLC» de las variables internas no entra: no es un autómata, y sus
    variables ya viajan en `variables_internas`.
    """
    if plc_manager is None:
        return []
    salida: List[dict] = []
    try:
        endpoints = plc_manager.endpoints()
    except Exception as exc:  # noqa: BLE001
        logger.warning("No se pudieron listar los PLC: %s", exc)
        return []
    for plc_id, ep in endpoints.items():
        d: Dict[str, Any] = {"plc_id": plc_id}
        for campo in CAMPOS_PLC:
            d[campo] = getattr(ep, campo, "")
        tags: List[dict] = []
        try:
            for t in plc_manager.catalogo(plc_id):
                tags.append({c: getattr(t, c, "") for c in CAMPOS_TAG})
        except Exception as exc:  # noqa: BLE001
            logger.warning("No se pudo leer el catálogo de '%s': %s",
                           plc_id, exc)
        d["tags"] = tags
        escritura: List[dict] = []
        if escritura_store is not None:
            try:
                for e in escritura_store.listar(plc_id):
                    escritura.append({c: e.get(c) for c in CAMPOS_ESCRITURA})
            except Exception as exc:  # noqa: BLE001
                logger.warning("No se pudo leer la escritura de '%s': %s",
                               plc_id, exc)
        d["escritura"] = escritura
        salida.append(d)
    return salida


async def importar_plcs(plc_manager, escritura_store, lista: List[dict],
                        usuario: str = "") -> dict:
    """
    Da de alta los PLC del fichero que no existan y les aplica su catálogo y
    su escritura. **Nunca pisa nada**: un PLC que ya está (mismo endpoint)
    se reutiliza tal cual; el catálogo solo se adopta si el PLC de aquí no
    tiene ninguno; la escritura solo añade tags que aquí no estaban
    habilitados, y respeta los límites que alguien ya puso a mano.

    Devuelve un dict con lo que pasó, para que la vista lo cuente:
      creados, ya_existentes, omitidos ([{plc_id, motivo}]),
      renombrados ({id_del_fichero: id_aquí}), catalogos (cuántos PLC
      adoptaron catálogo), escritura (tags habilitados nuevos).
    """
    r: Dict[str, Any] = {"creados": [], "ya_existentes": [], "omitidos": [],
                         "renombrados": {}, "catalogos": 0, "escritura": 0}
    if plc_manager is None or not lista:
        return r

    for d in lista:
        original = str(d.get("plc_id") or "")
        endpoint = str(d.get("endpoint") or "")
        host = str(d.get("host") or "")
        vendor = str(d.get("vendor") or "siemens")
        if not host and not endpoint:
            r["omitidos"].append({"plc_id": original,
                                  "motivo": "sin dirección"})
            continue

        # ¿Ya está? Por endpoint, que es lo que identifica a un autómata.
        plc_id = plc_manager.id_por_endpoint(endpoint) if endpoint else None
        if plc_id is not None:
            r["ya_existentes"].append(plc_id)
        elif vendor == "rexroth" and not d.get("password"):
            # El fichero no trae contraseñas (a propósito) y un ctrlX no
            # acepta sesiones anónimas: no se puede dar de alta a ciegas.
            r["omitidos"].append({
                "plc_id": original,
                "motivo": "es un Rexroth y necesita contraseña: dalo de alta "
                          "a mano en Configuración",
            })
            continue
        else:
            try:
                res = await plc_manager.add_plc_manual(
                    host=host or endpoint,
                    puerto=int(d.get("port") or 4840),
                    vendor=vendor,
                    usuario=str(d.get("usuario") or ""),
                    password=str(d.get("password") or ""),
                    app=str(d.get("app") or ""),
                    programa=str(d.get("programa") or ""),
                    slot=int(d.get("slot") or 0),
                    rack=int(d.get("rack") or 0),
                    transporte=str(d.get("transporte") or ""),
                    s7_tags=str(d.get("s7_tags") or ""),
                )
            except Exception as exc:  # noqa: BLE001
                res = {"ok": False, "mensaje": str(exc)}
            if not res.get("ok"):
                r["omitidos"].append({"plc_id": original,
                                      "motivo": res.get("mensaje", "")})
                continue
            plc_id = res["plc_id"]
            r["creados"].append(plc_id)

        if original and original != plc_id:
            r["renombrados"][original] = plc_id

        # Catálogo: solo si aquí no hay ninguno. Si el PLC ya conectó alguna
        # vez, lo que se vio aquí vale más que lo que se vio allí.
        tags = d.get("tags") or []
        if tags:
            try:
                if plc_manager.adoptar_catalogo(plc_id, tags):
                    r["catalogos"] += 1
            except Exception as exc:  # noqa: BLE001
                logger.warning("No se pudo adoptar el catálogo de '%s': %s",
                               plc_id, exc)

        # Escritura: añade lo que falte, con sus límites y descripción.
        escritura = d.get("escritura") or []
        if escritura and escritura_store is not None:
            try:
                r["escritura"] += escritura_store.habilitar_lote(
                    plc_id, [e for e in escritura if isinstance(e, dict)],
                    usuario)
            except Exception as exc:  # noqa: BLE001
                logger.warning("No se pudo aplicar la escritura de '%s': %s",
                               plc_id, exc)

    if r["catalogos"]:
        try:
            await plc_manager.difundir_snapshot()
        except Exception as exc:  # noqa: BLE001
            logger.debug("No se pudo difundir el snapshot: %s", exc)
    return r


def remapear_variables(valor: Any, mapa_plc: Dict[str, str]) -> Any:
    """
    Reescribe los enlaces `<plc>|<tag>` cuando el id del PLC cambió al
    importar (aquí ya había otro con ese id). Misma idea que
    `remapear_pantallas()`: solo las claves de `CLAVES_DE_VARIABLE`, en
    profundidad, y solo si el prefijo es exactamente un id renombrado.
    """
    if not mapa_plc:
        return valor
    if isinstance(valor, dict):
        salida = {}
        for clave, dentro in valor.items():
            if (clave in CLAVES_DE_VARIABLE and isinstance(dentro, str)
                    and "|" in dentro):
                plc, _, tag = dentro.partition("|")
                salida[clave] = (f"{mapa_plc[plc]}|{tag}" if plc in mapa_plc
                                 else dentro)
            else:
                salida[clave] = remapear_variables(dentro, mapa_plc)
        return salida
    if isinstance(valor, list):
        return [remapear_variables(x, mapa_plc) for x in valor]
    return valor


# ====================================================================== #
# Grupos de la barra de pestañas (las «carpetas» de pantallas)
# ====================================================================== #
#
# La organización de la barra —qué grupos hay, en qué orden, y en cuál cae
# cada pantalla— vive fuera de las pantallas (ver grupos_store.py). Si no
# viaja, el proyecto importado llega con todas las pestañas sueltas, que es
# justo lo que uno nota al abrirlo: «estaba todo en carpetas y ahora no».


def grupos_para_exportar(grupos_store, proyecto_id: str) -> dict:
    """`{"grupos": [{id, nombre}...], "asignaciones": {pantalla: grupo}}`."""
    if grupos_store is None:
        return {"grupos": [], "asignaciones": {}}
    try:
        doc = grupos_store.documento(proyecto_id)
    except Exception as exc:  # noqa: BLE001
        logger.warning("No se pudieron leer los grupos de '%s': %s",
                       proyecto_id, exc)
        return {"grupos": [], "asignaciones": {}}
    return {
        "grupos": [{"id": str(g.get("id") or ""), "nombre": str(g.get("nombre") or "")}
                   for g in doc.get("grupos", []) if isinstance(g, dict)],
        "asignaciones": {str(k): str(v) for k, v in
                         (doc.get("asignaciones") or {}).items()},
    }


def importar_grupos(grupos_store, proyecto_id: str, datos: dict,
                    mapa_pantallas: Dict[str, str], usuario: str = "") -> dict:
    """
    Recrea los grupos en el proyecto recién importado y mete cada pantalla
    en el suyo. Las pantallas que cambiaron de id al importar se buscan por
    `mapa_pantallas`; una asignación a una pantalla que no vino en el
    fichero se ignora. Devuelve `{"grupos": n, "asignadas": n}`.
    """
    r = {"grupos": 0, "asignadas": 0}
    if grupos_store is None or not isinstance(datos, dict):
        return r
    ids: Dict[str, str] = {}
    for g in datos.get("grupos") or []:
        if not isinstance(g, dict):
            continue
        original = str(g.get("id") or "")
        nombre = str(g.get("nombre") or original)
        try:
            creado = grupos_store.crear(proyecto_id, nombre, usuario)
        except Exception as exc:  # noqa: BLE001
            logger.warning("Grupo '%s' no se pudo crear en '%s': %s",
                           nombre, proyecto_id, exc)
            continue
        ids[original] = creado["id"]
        r["grupos"] += 1
    for pantalla, gid in (datos.get("asignaciones") or {}).items():
        destino = ids.get(str(gid))
        if destino is None:
            continue
        pid = mapa_pantallas.get(str(pantalla), str(pantalla))
        try:
            grupos_store.asignar(proyecto_id, pid, destino, usuario)
            r["asignadas"] += 1
        except Exception as exc:  # noqa: BLE001
            logger.warning("No se pudo asignar '%s' al grupo '%s': %s",
                           pid, destino, exc)
    return r


# ====================================================================== #
# Flujos: conexiones a BD, grupos de historización y consultas guardadas
# ====================================================================== #
#
# El lienzo de Flujos es un dibujo en el navegador (localStorage); lo que
# de verdad hace algo vive en el servidor: las CONEXIONES a base de datos,
# los GRUPOS de historización (qué tags, a qué base, cada cuánto) y las
# CONSULTAS guardadas (las que alimentan widgets y el Excel). Eso es lo que
# viaja aquí; el dibujo lo añade y lo aplica la vista.
#
# Las conexiones van SIN contraseña: la de aquí está cifrada con la clave
# de este equipo y no se puede leer allí. Entran desactivadas
# (`autoconectar: false`), para teclear la contraseña y probarla antes.
CAMPOS_CONEXION = ("db_id", "motor", "nombre", "host", "puerto",
                   "base_datos", "usuario", "opciones")
SUFIJO_CONEXION_IMPORTADA = "_importada"


def _misma_base(a: dict, b: dict) -> bool:
    def _n(c: dict) -> tuple:
        return (str(c.get("motor", "")).lower(),
                str(c.get("host", "")).strip().lower(),
                int(c.get("puerto") or 0),
                str(c.get("base_datos", "")).strip().lower(),
                str(c.get("usuario", "")).strip().lower())
    return _n(a) == _n(b)


def flujos_para_exportar(db_store, historizador) -> dict:
    """`{"conexiones": [...], "grupos": [...], "consultas": [...]}`."""
    salida = {"conexiones": [], "grupos": [], "consultas": []}
    if db_store is not None:
        try:
            for c in db_store.conexiones.values():
                d = c.publico()
                salida["conexiones"].append({k: d.get(k) for k in CAMPOS_CONEXION})
            for q in db_store.consultas.values():
                salida["consultas"].append(q.publico())
        except Exception as exc:  # noqa: BLE001
            logger.warning("No se pudieron leer conexiones/consultas: %s", exc)
    if historizador is not None:
        try:
            for g in historizador.grupos.values():
                salida["grupos"].append(historizador._serializar(g))
        except Exception as exc:  # noqa: BLE001
            logger.warning("No se pudieron leer los grupos: %s", exc)
    return salida


async def importar_flujos(db_store, historizador, datos: dict,
                          mapa_plc: Dict[str, str], usuario: str = "") -> dict:
    """
    Conexiones, grupos y consultas del fichero, sin pisar nada:

      * conexión con el mismo `db_id` y la MISMA base -> ya está, se omite;
        mismo `db_id` pero OTRA base -> entra como `<db_id>_importada`;
        nueva -> entra tal cual. Siempre sin contraseña y desactivada.
      * grupo con el mismo `grupo_id` -> se deja el de aquí; nuevo -> se
        crea DETENIDO, apuntando a la conexión (renombrada si lo fue) y con
        los tags reescritos si algún PLC cambió de id.
      * consulta con el mismo `query_id` -> se deja; nueva -> entra.
    """
    r: Dict[str, Any] = {"conexiones_nuevas": [], "conexiones_existentes": [],
                         "conexiones_renombradas": {}, "grupos_nuevos": [],
                         "grupos_existentes": [], "consultas_nuevas": [],
                         "consultas_existentes": [], "omitidos": []}
    if not isinstance(datos, dict):
        return r
    mapa_db: Dict[str, str] = {}

    # ── Conexiones ───────────────────────────────────────────────
    if db_store is not None:
        from app.db.store import ConexionGuardada
        for c in datos.get("conexiones") or []:
            if not isinstance(c, dict):
                continue
            db_id = str(c.get("db_id") or "").strip()
            if not db_id:
                continue
            nuevo_id = db_id
            local = db_store.conexiones.get(db_id)
            if local is not None:
                if _misma_base(local.publico(), c):
                    r["conexiones_existentes"].append(db_id)
                    continue
                base = f"{db_id}{SUFIJO_CONEXION_IMPORTADA}"
                nuevo_id, i = base, 2
                while nuevo_id in db_store.conexiones:
                    nuevo_id = f"{base}_{i}"
                    i += 1
                mapa_db[db_id] = nuevo_id
                r["conexiones_renombradas"][db_id] = nuevo_id
            try:
                puerto = c.get("puerto")
                puerto = int(puerto) if puerto not in (None, "") else None
                nombre = str(c.get("nombre") or db_id)
                if nuevo_id != db_id:
                    nombre = f"{nombre} (importada)"[:80]
                db_store.guardar_conexion(ConexionGuardada(
                    db_id=nuevo_id, motor=str(c.get("motor") or ""),
                    nombre=nombre, host=str(c.get("host") or ""),
                    puerto=puerto, base_datos=str(c.get("base_datos") or ""),
                    usuario=str(c.get("usuario") or ""),
                    opciones=dict(c.get("opciones") or {}),
                    autoconectar=False,
                ), "")
                r["conexiones_nuevas"].append(nuevo_id)
            except Exception as exc:  # noqa: BLE001
                r["omitidos"].append({"tipo": "conexion", "id": db_id,
                                      "motivo": str(exc)})

    # ── Grupos de historización ──────────────────────────────────
    if historizador is not None:
        for g in datos.get("grupos") or []:
            if not isinstance(g, dict):
                continue
            gid = str(g.get("grupo_id") or "").strip()
            if not gid:
                continue
            if gid in historizador.grupos:
                r["grupos_existentes"].append(gid)
                continue
            db_id = str(g.get("db_id") or "")
            db_id = mapa_db.get(db_id, db_id)
            tags = []
            for t in g.get("tags") or []:
                t = str(t)
                plc, sep, resto = t.partition("|")
                tags.append(f"{mapa_plc[plc]}|{resto}" if sep and plc in mapa_plc else t)
            try:
                res = historizador.alta_grupo(
                    grupo_id=gid, db_id=db_id, tags=tags,
                    tabla=str(g.get("tabla") or "plc_prg"),
                    nombre=str(g.get("nombre") or ""),
                    # Detenido: que nadie empiece a escribir en una base que
                    # aquí todavía no se ha revisado ni conectado.
                    activo=False,
                    banda_muerta=float(g.get("banda_muerta") or 0),
                    intervalo_min_ms=int(g.get("intervalo_min_ms") or 0),
                    modo=str(g.get("modo") or "muestreo"),
                    periodo_ms=int(g.get("periodo_ms") or 1000),
                )
            except Exception as exc:  # noqa: BLE001
                res = {"ok": False, "mensaje": str(exc)}
            if res.get("ok"):
                r["grupos_nuevos"].append(gid)
            else:
                r["omitidos"].append({"tipo": "grupo", "id": gid,
                                      "motivo": res.get("mensaje", "")})

    # ── Consultas guardadas ──────────────────────────────────────
    if db_store is not None:
        from app.db.store import ConsultaGuardada
        for q in datos.get("consultas") or []:
            if not isinstance(q, dict):
                continue
            qid = str(q.get("query_id") or "").strip()
            if not qid:
                continue
            if qid in db_store.consultas:
                r["consultas_existentes"].append(qid)
                continue
            db_id = str(q.get("db_id") or "")
            try:
                db_store.guardar_consulta(ConsultaGuardada(
                    query_id=qid, db_id=mapa_db.get(db_id, db_id),
                    nombre=str(q.get("nombre") or ""), sql=str(q.get("sql") or ""),
                    parametros=dict(q.get("parametros") or {}),
                    limite=int(q.get("limite") or 1000),
                    descripcion=str(q.get("descripcion") or ""),
                ))
                r["consultas_nuevas"].append(qid)
            except Exception as exc:  # noqa: BLE001
                r["omitidos"].append({"tipo": "consulta", "id": qid,
                                      "motivo": str(exc)})
    r["mapa_db"] = mapa_db
    return r


# ====================================================================== #
# Datos de BD: reglas de alarma y recetas
# ====================================================================== #
#
# Viven en la base SQL (tablas alarmas_def y recetas/receta_*), no en la
# carpeta de datos. Se sacan y se meten con el mismo motor que «Migrar datos
# de la base» (app/db/migracion_datos.py): claves renumeradas, fusionar por
# clave natural, una transacción. Lo que no viaja: eventos de alarma e
# histórico del PLC, que son de la instalación.


async def datos_bd_para_exportar(crud, db_manager, settings) -> dict:
    """
    `{"db_id": <base principal>, "tablas": {...}, "bases": {db_id: {...}}}`.

    Se exporta de TODAS las bases dadas de alta que respondan y tengan las
    tablas del HMI, no solo de la principal: las recetas de una planta
    pueden vivir en `scada_34` mientras las cuentas están en `local`, y un
    proyecto que solo mirara la principal llegaría con 14 recetas y ningún
    elemento. `tablas` repite la principal por compatibilidad con ficheros
    anteriores. Van también las CUENTAS (con el hash de la contraseña): al
    importar, las que ya existan aquí no se tocan.
    """
    if crud is None or db_manager is None:
        return {}
    from app.db import migracion_datos
    prefijo = (getattr(settings, "esquema_prefijo", "") or
               getattr(settings, "auth_tabla_prefijo", "") or "")
    try:
        principal = crud._db_id(None)
    except Exception:  # noqa: BLE001
        principal = ""
    bases: Dict[str, Dict[str, list]] = {}
    for c in db_manager.listar_conexiones():
        db_id = str(c.get("db_id") or "")
        try:
            driver = await db_manager._driver_de(db_id)
            tablas = await migracion_datos.exportar_filas(
                driver, prefijo, ("usuarios",) + migracion_datos.TABLAS_DISENO)
        except Exception as exc:  # noqa: BLE001
            logger.warning("Base '%s': no se pudo exportar (%s); se sigue "
                           "con las demás.", db_id, exc)
            continue
        if any(tablas.get(t) for t in tablas):
            bases[db_id] = tablas
    if not bases:
        return {}
    return {"db_id": principal, "tablas": bases.get(principal, {}),
            "bases": bases}


async def importar_datos_bd(crud, db_manager, settings, datos: dict) -> dict:
    """
    Mete las alarmas y recetas del fichero en la base del HMI de AQUÍ (la
    de `PLC_AUTH_DB_ID`, o la primera). Devuelve el informe de la
    migración, o `{"ok": False, "mensaje": ...}` sin tumbar la importación.
    """
    vacio = {"ok": True, "totales": {"insertadas": 0, "reutilizadas": 0,
                                     "omitidas": 0}, "tablas": []}
    if crud is None or db_manager is None or not isinstance(datos, dict):
        return vacio
    # Ficheros nuevos traen `bases` (una entrada por base de origen); los
    # anteriores solo `tablas`. Todo entra en la base principal de AQUÍ,
    # fusionando: lo que se repita entre bases de origen no se duplica.
    origenes: Dict[str, dict] = {}
    if isinstance(datos.get("bases"), dict) and datos["bases"]:
        origenes = {str(k): v for k, v in datos["bases"].items()
                    if isinstance(v, dict) and v}
    elif datos.get("tablas"):
        origenes = {str(datos.get("db_id") or "origen"): datos["tablas"]}
    if not origenes:
        return vacio
    from app.db import migracion_datos
    try:
        db_id = crud._db_id(None)
        driver = await db_manager._driver_de(db_id)
        prefijo = (getattr(settings, "esquema_prefijo", "") or
                   getattr(settings, "auth_tabla_prefijo", "") or "")
        # Si a la base de aquí le falta alguna tabla del HMI (una SQLite
        # recién creada, una base a medio provisionar), se crea: es lo que
        # evita el «La tabla receta_registros no existe» al importar.
        try:
            await db_manager.asegurar_esquema(db_id, prefijo)
            if hasattr(crud, "invalidar_columnas"):
                crud.invalidar_columnas()
        except Exception as exc:  # noqa: BLE001
            logger.warning("No se pudo asegurar el esquema en '%s': %s",
                           db_id, exc)
        total = {"insertadas": 0, "reutilizadas": 0, "omitidas": 0}
        por_tabla: Dict[str, dict] = {}
        for origen_id, tablas in origenes.items():
            informe = await migracion_datos.importar_filas(
                driver, tablas, prefijo, "fusionar",
                origen={"db_id": origen_id, "desde": "proyecto"},
                usuarios="tal_cual")
            for k in total:
                total[k] += int(informe.get("totales", {}).get(k, 0))
            for t in informe.get("tablas", []):
                acc = por_tabla.setdefault(t["tabla"], {
                    "tabla": t["tabla"], "insertadas": 0, "reutilizadas": 0,
                    "omitidas": 0, "avisos": []})
                for k in ("insertadas", "reutilizadas", "omitidas"):
                    acc[k] += int(t.get(k, 0))
                for a in t.get("avisos", []) or []:
                    if a not in acc["avisos"]:
                        acc["avisos"].append(a)
        return {"ok": True, "db_id": db_id, "totales": total,
                "tablas": list(por_tabla.values()),
                "mensaje": f"{total['insertadas']} fila(s) nuevas, "
                           f"{total['reutilizadas']} ya existían."}
    except Exception as exc:  # noqa: BLE001
        logger.exception("No se pudieron importar alarmas/recetas")
        return {"ok": False, "mensaje": str(exc),
                "totales": {"insertadas": 0, "reutilizadas": 0, "omitidas": 0},
                "tablas": []}


# ====================================================================== #
# Constantes de faceplate
# ====================================================================== #
#
# Cada tipo de faceplate (una pantalla marcada como tipo) puede tener
# constantes: valores fijos con nombre que se asignan a sus parámetros. Los
# widgets las enlazan como `constante|<id>`. Sin ellas, una instancia que
# tenía «Velocidad nominal = 1450» llega con el hueco vacío.
PREFIJO_CONSTANTE = "constante|"


def constantes_para_exportar(constantes_store, pantallas: List[dict]) -> List[dict]:
    """Las constantes de los faceplates que son pantallas de este proyecto."""
    if constantes_store is None:
        return []
    ids = {str(p.get("project_id") or "") for p in pantallas}
    salida: List[dict] = []
    try:
        for c in constantes_store.listar():
            if str(c.get("faceplate") or "") in ids:
                salida.append({k: c.get(k) for k in
                               ("id", "faceplate", "nombre", "tipo", "valor")})
    except Exception as exc:  # noqa: BLE001
        logger.warning("No se pudieron leer las constantes: %s", exc)
    return salida


def importar_constantes(constantes_store, lista: List[dict],
                        mapa_pantallas: Dict[str, str]) -> Tuple[List[str], Dict[str, str], List[dict]]:
    """
    Crea las constantes del fichero. Se intenta conservar el id (así los
    enlaces `constante|id` de los widgets siguen valiendo sin tocarlos); si
    el id ya está ocupado aquí por OTRA constante, nace con uno nuevo y se
    devuelve el cambio en `renombradas` para reescribir los enlaces. Una
    constante idéntica (mismo id, faceplate y nombre) ya está y se omite.

    Devuelve `(creadas, renombradas, conflictos)`.
    """
    creadas: List[str] = []
    renombradas: Dict[str, str] = {}
    conflictos: List[dict] = []
    if constantes_store is None:
        return creadas, renombradas, conflictos
    for d in lista or []:
        if not isinstance(d, dict):
            continue
        cid = str(d.get("id") or "")
        faceplate = str(d.get("faceplate") or "")
        faceplate = mapa_pantallas.get(faceplate, faceplate)
        datos = {"faceplate": faceplate, "nombre": d.get("nombre"),
                 "tipo": d.get("tipo"), "valor": d.get("valor")}
        try:
            actual = constantes_store.obtener(cid) if cid else None
        except Exception:  # noqa: BLE001
            actual = None
        if actual is not None:
            if actual.faceplate == faceplate and actual.nombre == d.get("nombre"):
                continue          # la misma: ya está
            datos_id = None       # id ocupado por otra: que nazca con uno nuevo
        else:
            datos_id = cid or None
        try:
            c = constantes_store.crear({**datos, "id": datos_id} if datos_id else datos)
        except Exception as exc:  # noqa: BLE001
            conflictos.append({"id": cid, "nombre": d.get("nombre"),
                               "error": str(exc)})
            continue
        creadas.append(c.id)
        if cid and c.id != cid:
            renombradas[cid] = c.id
    return creadas, renombradas, conflictos


def remapear_constantes(valor: Any, renombradas: Dict[str, str]) -> Any:
    """`constante|viejo` -> `constante|nuevo` en los enlaces de los widgets."""
    if not renombradas:
        return valor
    mapa = {f"{PREFIJO_CONSTANTE}{a}": f"{PREFIJO_CONSTANTE}{b}"
            for a, b in renombradas.items()}
    if isinstance(valor, dict):
        return {k: (mapa[v] if (k in CLAVES_DE_VARIABLE and isinstance(v, str)
                                and v in mapa)
                    else remapear_constantes(v, renombradas))
                for k, v in valor.items()}
    if isinstance(valor, list):
        return [remapear_constantes(x, renombradas) for x in valor]
    return valor


# ====================================================================== #
# Categorías de la paleta de widgets
# ====================================================================== #
#
# Por proyecto, igual que los grupos de la barra: qué secciones tiene la
# paleta, en qué orden y en cuál cae cada widget personalizado. Sin esto el
# proyecto llega con la paleta de fábrica y los widgets del cliente
# repartidos donde su `widget.json` diga, no donde quien diseñó los dejó.


def categorias_para_exportar(categorias_store, proyecto_id: str) -> dict:
    if categorias_store is None:
        return {"categorias": [], "asignaciones": {}}
    try:
        doc = categorias_store.documento(proyecto_id)
    except Exception as exc:  # noqa: BLE001
        logger.warning("No se pudieron leer las categorías: %s", exc)
        return {"categorias": [], "asignaciones": {}}
    return {
        "categorias": [{"id": str(c.get("id") or ""), "nombre": str(c.get("nombre") or ""),
                        "fija": bool(c.get("fija"))}
                       for c in doc.get("categorias", []) if isinstance(c, dict)],
        "asignaciones": {str(k): str(v) for k, v in
                         (doc.get("asignaciones") or {}).items()},
    }


def importar_categorias(categorias_store, proyecto_id: str, datos: dict,
                        usuario: str = "") -> dict:
    """
    Recrea la paleta del proyecto importado: las categorías de fábrica se
    renombran si allí tenían otro nombre, las propias se crean, se dejan en
    el mismo orden y cada widget va a la suya.
    """
    r = {"categorias": 0, "asignadas": 0}
    if categorias_store is None or not isinstance(datos, dict):
        return r
    orden: List[str] = []
    for c in datos.get("categorias") or []:
        if not isinstance(c, dict):
            continue
        cid = str(c.get("id") or "")
        nombre = str(c.get("nombre") or cid)
        try:
            if categorias_store.existe(proyecto_id, cid):
                actual = next((x for x in categorias_store.categorias(proyecto_id)
                               if x["id"] == cid), None)
                if actual is not None and actual.get("nombre") != nombre:
                    categorias_store.renombrar(proyecto_id, cid, nombre, usuario)
                orden.append(cid)
            else:
                creada = categorias_store.crear(proyecto_id, nombre, usuario)
                orden.append(creada["id"])
                r["categorias"] += 1
        except Exception as exc:  # noqa: BLE001
            logger.warning("Categoría '%s' no se pudo crear en '%s': %s",
                           nombre, proyecto_id, exc)
    if orden:
        try:
            categorias_store.reordenar(proyecto_id, orden, usuario)
        except Exception as exc:  # noqa: BLE001
            logger.warning("No se pudo ordenar la paleta: %s", exc)
    for kind, cid in (datos.get("asignaciones") or {}).items():
        try:
            categorias_store.asignar(proyecto_id, str(kind), str(cid), usuario)
            r["asignadas"] += 1
        except Exception as exc:  # noqa: BLE001
            logger.warning("No se pudo asignar '%s' a '%s': %s", kind, cid, exc)
    return r
