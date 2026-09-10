# -*- coding: utf-8 -*-
"""
variables_store.py
==================
"Crear una variable" desde la vista, sobre huecos ya reservados en el PLC.

LO QUE NO SE PUEDE HACER, Y POR QUÉ ESTE MÓDULO EXISTE
------------------------------------------------------
No se puede crear una variable dentro de un PLC en marcha. Las variables de un
DB se reservan AL COMPILAR: TIA Portal calcula el mapa de memoria y lo
descarga. Añadir una implica editar el proyecto, recompilar y descargar. No hay
camino en caliente, ni en Siemens ni en el programa IEC del ctrlX.

OPC UA tiene un servicio `AddNodes` y `asyncua` lo expone, pero el servidor del
S7-1500 no lo implementa. Y aunque lo hiciera, crearía un nodo EN EL SERVIDOR
OPC UA, no en la memoria del programa: una variable que existe para quien mira
por OPC UA y no existe para el autómata, que no podría leerla ni actuar sobre
ella. Sería peor que no tenerla, porque parecería funcionar.

LA SOLUCIÓN: RESERVA PREVIA
---------------------------
Es el patrón que se usa en la industria justo para esto. En TIA Portal se crea
UNA VEZ un DB con huecos de sobra:

    DB_HMI.spare_real_00 .. spare_real_49     (Real)
    DB_HMI.spare_bool_00 .. spare_bool_99     (Bool)
    DB_HMI.spare_int_00  .. spare_int_49      (Int)

Una descarga, y ya no hace falta volver a compilar. A partir de ahí, "crear una
variable" desde la vista es RECLAMAR un hueco libre y ponerle nombre, unidades
y rango. Para quien lo usa acaba de crear «Consigna Cuba 3»; por debajo es
`DB_HMI.spare_real_07`. Y es una variable REAL del PLC: el programa puede
leerla y actuar sobre ella.

POR QUÉ VARIABLES SUELTAS Y NO UN ARRAY
---------------------------------------
Un `ARRAY[0..49] OF REAL` sería lo natural de escribir en TIA, pero se lleva mal
con todo lo demás:

  * El browse de este proyecto no lee `ValueRank` ni `ArrayDimensions`, así que
    un array llega como un escalar cuyo valor es una lista, y acaba
    convertido a texto.
  * `Node.write_value()` de asyncua no acepta `IndexRange`: escribir UN
    elemento exigiría bajar a `write_attribute` a mano.
  * Y el historizador, las alarmas y los widgets tratan cada tag como un
    escalar con nombre propio.

Con variables sueltas, cada hueco es un nodo normal que todo lo existente ya
sabe manejar. `detectar_array()` avisa si alguien declaró un array, porque el
síntoma —una variable que se ve como texto raro— no orienta nada.
"""
from __future__ import annotations

import json
import logging
import re
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, Optional

logger = logging.getLogger("variables_store")

NOMBRE_FICHERO = "variables_hmi.json"

# Un hueco es `<prefijo><separador><numero>`: spare_real_07, spare_bool_12...
_RE_HUECO = re.compile(r"^(?P<prefijo>.+?)[_\-]?(?P<indice>\d+)$")

# Nombre amigable: lo que ve el operario.
#
# Va como LISTA NEGRA y no como lista blanca, y es una corrección: el primer
# intento permitía "letras, números y . , ( ) / + -", y rechazaba el « · » que
# aparece en los propios ejemplos de este proyecto. Un nombre de planta lleva
# grados, porcentajes, almohadillas y puntos medios; enumerarlos todos por
# adelantado es garantizar que falte uno, y el usuario se come un error por
# escribir algo perfectamente razonable.
#
# Lo que sí hay que prohibir son los caracteres de control y los saltos de
# línea, que rompen ficheros y registros. Las comillas y la barra invertida no
# hace falta prohibirlas: esto se guarda con `json.dumps`, que las escapa, y el
# identificador que acaba en rutas y ficheros NO es este nombre, sino el `id`
# que genera `id_desde_nombre()` reducido a [a-z0-9_].
_RE_NOMBRE_PROHIBIDO = re.compile(r"[\x00-\x1f\x7f]")
LARGO_MAX_NOMBRE = 80


def _ahora_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


@dataclass
class VariableHmi:
    """Un hueco del PLC reclamado y bautizado desde la vista."""

    id: str                  # identificador estable, derivado del nombre
    nombre: str              # «Consigna de temperatura · Cuba 3»
    plc_id: str
    tag: str                 # el hueco físico: DB_HMI.spare_real_07
    node_id: str = ""
    data_type: str = ""
    unidad: str = ""
    minimo: Optional[float] = None
    maximo: Optional[float] = None
    descripcion: str = ""
    creado_por: str = ""
    creado_en: str = ""
    actualizado_en: str = ""

    def publico(self) -> dict:
        return asdict(self)


class HuecoOcupado(ValueError):
    """Ese hueco ya lo reclamó otra variable."""


class SinHuecos(RuntimeError):
    """No queda ningún hueco libre de ese tipo en el PLC."""


def id_desde_nombre(nombre: str) -> str:
    """
    Identificador estable a partir del nombre.

    Se deriva del nombre y NO se vuelve a calcular si luego lo renombran: el id
    es lo que guardan los widgets y las recetas, y recalcularlo al renombrar
    dejaría huérfano todo lo que apuntara a él.
    """
    base = (nombre or "").strip().lower()
    base = (base.replace("á", "a").replace("é", "e").replace("í", "i")
                .replace("ó", "o").replace("ú", "u").replace("ñ", "n"))
    base = re.sub(r"[^a-z0-9]+", "_", base).strip("_")[:60]
    return base or f"var_{datetime.now().strftime('%H%M%S')}"


def validar_nombre(nombre: str) -> str:
    n = (nombre or "").strip()
    if not n:
        raise ValueError("La variable necesita un nombre.")
    if len(n) > LARGO_MAX_NOMBRE:
        raise ValueError(
            f"El nombre tiene {len(n)} caracteres y el máximo son "
            f"{LARGO_MAX_NOMBRE}. En la vista no cabría entero.")
    if _RE_NOMBRE_PROHIBIDO.search(n):
        raise ValueError(
            "El nombre no puede llevar saltos de línea ni caracteres de "
            "control. Escríbelo en una sola línea.")
    return n


def detectar_array(data_type: str, valor_ejemplo=None) -> bool:
    """
    ¿Esto huele a un array en vez de a una variable suelta?

    Se comprueba por dos vías porque ninguna es fiable sola: el nombre del tipo
    a veces lo delata, y a veces solo se ve al leer el valor y encontrar una
    lista donde debería haber un número.
    """
    t = (data_type or "").lower()
    if "array" in t or t.endswith("[]") or "[" in t:
        return True
    return isinstance(valor_ejemplo, (list, tuple))


class VariablesStore:
    """Variables creadas desde la vista sobre huecos reservados."""

    def __init__(self, carpeta: Optional[str] = None) -> None:
        if carpeta:
            self.carpeta = Path(carpeta)
        else:
            try:
                from app.config.rutas import resolver_carpeta_datos
                self.carpeta = resolver_carpeta_datos()
            except Exception:  # noqa: BLE001
                self.carpeta = Path(__file__).resolve().parents[2] / "datos"
        self.carpeta.mkdir(parents=True, exist_ok=True)
        self.ruta = self.carpeta / NOMBRE_FICHERO

        self.variables: Dict[str, VariableHmi] = {}
        self.cargar()

    # ------------------------------------------------------------------ #
    def cargar(self) -> int:
        """
        Relee el fichero.

        Un fichero corrupto deja la lista VACÍA. Aquí el fallo seguro es no
        tener variables: una entrada a medio leer podría asociar un nombre al
        hueco equivocado, y entonces «Consigna Cuba 3» escribiría en el hueco
        de otra cosa. Perder los nombres se arregla; escribir en el sitio
        equivocado, no.
        """
        self.variables = {}
        if not self.ruta.is_file():
            return 0
        try:
            doc = json.loads(self.ruta.read_text("utf-8"))
            for fila in doc.get("variables", []):
                v = VariableHmi(**fila)
                self.variables[v.id] = v
        except Exception as exc:  # noqa: BLE001
            logger.error(
                "El fichero de variables está corrupto (%s). Se arranca SIN "
                "ninguna, que es el fallo seguro: una entrada mal leída podría "
                "apuntar al hueco equivocado. Revisa %s", exc, self.ruta)
            self.variables = {}
        logger.info("Variables del HMI cargadas: %d.", len(self.variables))
        return len(self.variables)

    def _escribir(self) -> None:
        doc = {"version": 1, "actualizado_en": _ahora_iso(),
               "variables": [asdict(v) for v in self.variables.values()]}
        tmp = self.ruta.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(doc, indent=2, ensure_ascii=False), encoding="utf-8")
        tmp.replace(self.ruta)

    # ------------------------------------------------------------------ #
    def listar(self, plc_id: str = "") -> List[dict]:
        vs = sorted(self.variables.values(), key=lambda v: v.nombre.lower())
        return [v.publico() for v in vs if not plc_id or v.plc_id == plc_id]

    def obtener(self, var_id: str) -> Optional[VariableHmi]:
        return self.variables.get((var_id or "").strip())

    def por_tag(self, plc_id: str, tag: str) -> Optional[VariableHmi]:
        for v in self.variables.values():
            if v.plc_id == plc_id and v.tag == tag:
                return v
        return None

    def huecos_ocupados(self, plc_id: str) -> set:
        return {v.tag for v in self.variables.values() if v.plc_id == plc_id}

    # ------------------------------------------------------------------ #
    def crear(
        self,
        nombre: str,
        plc_id: str,
        tag: str,
        node_id: str = "",
        data_type: str = "",
        unidad: str = "",
        minimo: Optional[float] = None,
        maximo: Optional[float] = None,
        descripcion: str = "",
        usuario: str = "",
    ) -> VariableHmi:
        """Reclama un hueco concreto y lo bautiza."""
        nombre = validar_nombre(nombre)

        if minimo is not None and maximo is not None and minimo > maximo:
            raise ValueError(
                f"El mínimo ({minimo}) es mayor que el máximo ({maximo}): "
                f"con esos límites no se podría escribir ningún valor.")

        ocupante = self.por_tag(plc_id, tag)
        if ocupante is not None:
            raise HuecoOcupado(
                f"El hueco '{tag}' ya lo usa la variable «{ocupante.nombre}». "
                f"Libérala primero, o elige otro hueco.")

        var_id = id_desde_nombre(nombre)
        # Dos variables con el mismo nombre son un accidente esperable
        # («Consigna» en dos cubas). Se desambigua en vez de rechazar.
        if var_id in self.variables:
            i = 2
            while f"{var_id}_{i}" in self.variables:
                i += 1
            var_id = f"{var_id}_{i}"

        v = VariableHmi(
            id=var_id, nombre=nombre, plc_id=plc_id, tag=tag, node_id=node_id,
            data_type=data_type, unidad=unidad, minimo=minimo, maximo=maximo,
            descripcion=descripcion, creado_por=usuario,
            creado_en=_ahora_iso(), actualizado_en=_ahora_iso(),
        )
        self.variables[var_id] = v
        self._escribir()
        logger.info("Variable «%s» creada por %s sobre %s / %s.",
                    nombre, usuario or "?", plc_id, tag)
        return v

    def actualizar(self, var_id: str, **campos) -> VariableHmi:
        """Cambia nombre, unidad, límites o descripción. NO cambia el hueco."""
        v = self.obtener(var_id)
        if v is None:
            raise KeyError(f"No existe la variable '{var_id}'.")

        if "nombre" in campos and campos["nombre"]:
            v.nombre = validar_nombre(campos["nombre"])
        for c in ("unidad", "descripcion"):
            if c in campos and campos[c] is not None:
                setattr(v, c, campos[c])
        for c in ("minimo", "maximo"):
            if c in campos:
                setattr(v, c, campos[c])

        if v.minimo is not None and v.maximo is not None and v.minimo > v.maximo:
            raise ValueError(f"El mínimo ({v.minimo}) supera al máximo ({v.maximo}).")

        v.actualizado_en = _ahora_iso()
        self._escribir()
        return v

    def liberar(self, var_id: str) -> Optional[VariableHmi]:
        """
        Suelta el hueco para que se pueda reutilizar.

        NO se pone a cero el valor en el PLC, y es deliberado: escribir en una
        variable de proceso como efecto secundario de borrar una etiqueta sería
        una sorpresa peligrosa. El hueco queda como estaba; lo que desaparece
        es el nombre.
        """
        v = self.variables.pop((var_id or "").strip(), None)
        if v is None:
            return None
        self._escribir()
        logger.info("Variable «%s» liberada; el hueco %s vuelve a estar libre.",
                    v.nombre, v.tag)
        return v

    def estado(self) -> dict:
        return {
            "num_variables": len(self.variables),
            "fichero": str(self.ruta),
            "por_plc": {
                p: sum(1 for v in self.variables.values() if v.plc_id == p)
                for p in sorted({v.plc_id for v in self.variables.values()})
            },
        }
