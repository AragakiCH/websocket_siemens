# -*- coding: utf-8 -*-
"""
internas_store.py
=================
Variables que NO existen en ningún PLC: viven en el servidor.

QUÉ SON Y POR QUÉ HACEN FALTA
-----------------------------
Una variable interna es un valor con nombre y tipo que guarda el servidor y
ven todos los paneles a la vez. No hay autómata detrás, nadie las lee por OPC
UA, y su valor solo cambia porque alguien lo cambia desde la vista.

Existen porque hay tres cosas que hoy no tienen dónde vivir:

  * **Probar una pantalla sin planta.** Enlazar un widget a `interno|nivel` y
    mover el valor a mano es la única forma de ver si la animación funciona
    cuando el PLC está apagado, o todavía no existe.
  * **Estado propio del HMI.** "Modo mantenimiento", "turno actual", el texto
    de un cartel. Son decisiones del panel, no del proceso; meterlas en un DB
    del PLC obliga a recompilar el programa para cambiar un rótulo.
  * **Un valor compartido entre pantallas.** `localStorage` no sirve: es de
    un navegador. Esto lo ven los cinco paneles de la línea.

NO ES LO MISMO QUE `variables_store.py`
---------------------------------------
Se parecen en el nombre y no tienen nada que ver. Aquel RECLAMA un hueco de
reserva en un DB del PLC y le pone nombre: la variable existe de verdad en el
autómata y el programa puede actuar sobre ella. Este no toca el PLC.

La distinción importa al elegir: si el programa del autómata tiene que LEER el
valor, hace falta un hueco reservado (`variables_store`). Si el valor solo lo
usa el HMI, es interna y no cuesta una descarga de TIA.

POR QUÉ SE HACEN PASAR POR TAGS
-------------------------------
Se publican con `plc = "interno"`, así que su clave es `interno|nombre`,
exactamente con la misma forma que `PLC_2|DB_Datos.Temperatura`. Eso no es un
atajo: es lo que hace que TODO lo que ya existe funcione sin tocarse. El
selector de variables del inspector, la tendencia, el motor de alarmas, el
historizador y cualquier widget subido por ZIP tratan `interno|nivel` como
tratan cualquier otro tag, porque para ellos no hay diferencia.

Los nombres de tipo que se publican (`Boolean`, `Int32`, `Double`, `String`)
son los de OPC UA a propósito: `mapOpcType()` en el frontend traduce por
subcadena, y usar el vocabulario de siempre evita un caso especial allí.

PERSISTENCIA
------------
Un fichero JSON en la carpeta de datos, reescrito entero en cada cambio. Son
decenas de variables, no millones: la simplicidad vale más que el ahorro. Se
escribe primero a un temporal y se renombra, para que un corte de luz a mitad
no deje el fichero a medias — que es como se pierden las cuatro variables de
toda una línea.
"""
from __future__ import annotations

import json
import logging
import os
import re
import unicodedata
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

logger = logging.getLogger("internas_store")

NOMBRE_FICHERO = "variables_internas.json"

#: El `plc` con el que se publican. Es una palabra reservada: ningún PLC real
#: puede llamarse así, y por eso se puede distinguir un tag interno de uno de
#: campo mirando solo su clave.
PLC_INTERNO = "interno"

# ---------------------------------------------------------------------- #
# Tipos
# ---------------------------------------------------------------------- #
# Lo que ve quien crea la variable, lo que se guarda, y cómo se publica.
#
# `opc` es el nombre que viaja en el campo `type` de los mensajes. No es
# decorativo: `mapOpcType()` en plcAdapter.ts busca subcadenas ('bool',
# 'int', 'real'/'float'/'double') para decidir qué widget acepta la variable.
TIPOS: Dict[str, Dict[str, Any]] = {
    "bool":   {"etiqueta": "Sí / no",       "opc": "Boolean", "defecto": False},
    "int":    {"etiqueta": "Entero",        "opc": "Int32",   "defecto": 0},
    "double": {"etiqueta": "Decimal",       "opc": "Double",  "defecto": 0.0},
    "string": {"etiqueta": "Texto",         "opc": "String",  "defecto": ""},
}

# Nombre de la variable: es lo que acaba en la clave `interno|<nombre>`, y esa
# clave viaja en JSON, en nombres de fichero de exportación y en consultas SQL
# del historizador. Se restringe de verdad, en vez de confiar en que nadie
# escriba una barra vertical — que partiría la clave en dos.
_RE_NOMBRE = re.compile(r"^[a-z][a-z0-9_]{0,47}$")
LARGO_MAX_DESCRIPCION = 200


class ErrorInterna(Exception):
    """Fallo de validación, con el mensaje ya listo para enseñar."""

    def __init__(self, mensaje: str, codigo: int = 400) -> None:
        super().__init__(mensaje)
        self.mensaje = mensaje
        self.codigo = codigo


def _ahora() -> str:
    return datetime.now(timezone.utc).isoformat()


def normalizar_nombre(texto: str) -> str:
    """
    Convierte lo que se teclee en un nombre válido.

    Se hace AQUÍ y no se rechaza sin más porque el caso normal es escribir
    "Nivel Depósito 1" y esperar que funcione. Devolver un error por una
    mayúscula y un espacio es hacerle al usuario un trabajo que la máquina
    puede hacer sola: queda `nivel_deposito_1`.
    """
    t = (texto or "").strip().lower()
    # Los acentos fuera: la clave viaja por URLs, ficheros y SQL, y una `ó`
    # sobrevive a casi todo menos al sitio donde no lo hace.
    t = "".join(c for c in unicodedata.normalize("NFD", t)
                if unicodedata.category(c) != "Mn")
    t = re.sub(r"[^a-z0-9]+", "_", t).strip("_")
    if t and t[0].isdigit():
        t = f"v_{t}"
    return t[:48]


@dataclass
class Interna:
    """Una variable interna."""

    nombre: str
    tipo: str
    descripcion: str = ""
    unidad: str = ""
    # Rango, solo para los tipos numéricos. Sirve a los widgets que dibujan
    # proporciones (un depósito, una aguja): sin él no saben qué es "lleno".
    minimo: Optional[float] = None
    maximo: Optional[float] = None
    valor: Any = None
    #: Con qué valor arranca el servicio. Ver `reiniciar_volatiles()`.
    valor_inicial: Any = None
    #: True = el valor sobrevive al reinicio. False = vuelve al inicial.
    retentiva: bool = True
    creado_en: str = field(default_factory=_ahora)
    actualizado_en: str = field(default_factory=_ahora)

    def como_fila(self) -> dict:
        """
        La variable tal como la define quien la configura.

        ES DISTINTA DE `como_tag()`, Y CONFUNDIRLAS CUESTA CARO. Esta tiene
        `nombre`, `tipo`, `retentiva`, `valor_inicial`... — el vocabulario de
        la pantalla de configuración. `como_tag()` tiene `plc`, `tag`, `type`,
        `value` — el vocabulario de un tag de PLC, para que los widgets no
        noten la diferencia.

        Devolver una donde se espera la otra no da un error de servidor: da
        una respuesta 200 con las claves equivocadas, y quien la recibe se
        rompe al leer un campo que no está. Pasó: el POST devolvía el tag, la
        vista hacía `variable.nombre.localeCompare(...)` con `nombre` a
        undefined, y React desmontaba la aplicación entera — pantalla en
        negro después de crear la variable, que sí se había creado.
        """
        return asdict(self)

    def como_tag(self) -> dict:
        """
        La misma forma que devuelve `GET /tags` para un tag de PLC.

        Campo a campo igual a `get_tags_con_valor()` en subscription_handler:
        quien consuma esto no puede notar la diferencia, y ese es el objetivo.
        """
        return {
            "plc": PLC_INTERNO,
            "tag": self.nombre,
            "name": self.nombre,
            "db": "Internas",
            "node_id": f"interna:{self.nombre}",
            "type": TIPOS[self.tipo]["opc"],
            "value": self.valor,
            "timestamp": self.actualizado_en,
            "source_ts": self.actualizado_en,
            "delta_ms": None,
            # Extras que un tag de PLC no tiene. Van al final y son opcionales
            # para todo lo que ya existe.
            "interna": True,
            "descripcion": self.descripcion,
            "unidad": self.unidad,
            "minimo": self.minimo,
            "maximo": self.maximo,
        }

    def como_mensaje(self) -> dict:
        """El mensaje de cambio de valor, igual que el de un PLC."""
        return {
            "timestamp": self.actualizado_en,
            "plc": PLC_INTERNO,
            "tag": self.nombre,
            "value": self.valor,
            "type": TIPOS[self.tipo]["opc"],
            "source_ts": self.actualizado_en,
            "server_ts": self.actualizado_en,
            "delta_ms": None,
        }


def convertir(valor: Any, tipo: str) -> Any:
    """
    Lleva `valor` al tipo declarado, o explica por qué no se puede.

    Es más permisivo de lo que parece a propósito: la vista manda lo que hay
    en un `<input>`, que siempre es texto. `"12.5"` en una variable decimal
    tiene que funcionar; `"hola"` no.
    """
    if valor is None:
        return None
    try:
        if tipo == "bool":
            if isinstance(valor, str):
                v = valor.strip().lower()
                if v in ("true", "1", "si", "sí", "on"):
                    return True
                if v in ("false", "0", "no", "off", ""):
                    return False
                raise ValueError(valor)
            return bool(valor)
        if tipo == "int":
            if isinstance(valor, bool):
                return int(valor)
            return int(float(str(valor).replace(",", ".")))
        if tipo == "double":
            if isinstance(valor, bool):
                return float(valor)
            return float(str(valor).replace(",", "."))
        return str(valor)
    except (TypeError, ValueError):
        raise ErrorInterna(
            f"'{valor}' no es un valor válido para una variable de tipo "
            f"{TIPOS[tipo]['etiqueta']}.")


class InternasStore:
    """Las variables internas, en memoria y en disco."""

    def __init__(self, carpeta: Optional[str] = None) -> None:
        if carpeta:
            self.carpeta = Path(carpeta)
        else:
            try:
                from app.config.rutas import resolver_carpeta_datos
                self.carpeta = resolver_carpeta_datos()
            except Exception:  # noqa: BLE001
                self.carpeta = Path("datos")
        self.carpeta.mkdir(parents=True, exist_ok=True)
        self.ruta = self.carpeta / NOMBRE_FICHERO
        self._vars: Dict[str, Interna] = {}
        self._cargar()

    # ------------------------------------------------------------------ #
    # Disco
    # ------------------------------------------------------------------ #
    def _cargar(self) -> None:
        if not self.ruta.is_file():
            return
        try:
            doc = json.loads(self.ruta.read_text(encoding="utf-8"))
        except Exception as exc:  # noqa: BLE001
            # Un fichero corrupto NO puede impedir que el servicio arranque:
            # se avisa y se empieza vacío. Perder las variables es malo;
            # que no arranque el HMI de una planta lo es más.
            logger.error("No se pudo leer %s (%s). Se empieza sin variables "
                         "internas.", self.ruta, exc)
            return

        for d in doc.get("variables", []):
            try:
                tipo = d.get("tipo")
                if tipo not in TIPOS:
                    continue
                v = Interna(
                    nombre=d["nombre"],
                    tipo=tipo,
                    descripcion=d.get("descripcion", ""),
                    unidad=d.get("unidad", ""),
                    minimo=d.get("minimo"),
                    maximo=d.get("maximo"),
                    valor=d.get("valor"),
                    valor_inicial=d.get("valor_inicial"),
                    retentiva=bool(d.get("retentiva", True)),
                    creado_en=d.get("creado_en") or _ahora(),
                    actualizado_en=d.get("actualizado_en") or _ahora(),
                )
                self._vars[v.nombre] = v
            except Exception:  # noqa: BLE001
                logger.warning("Variable interna descartada: %r", d)

        self.reiniciar_volatiles()
        logger.info("Variables internas cargadas: %d", len(self._vars))

    def reiniciar_volatiles(self) -> None:
        """
        Devuelve a su valor inicial las que no son retentivas.

        Se llama al arrancar. Una variable como "modo mantenimiento" no debe
        seguir activa después de reiniciar el servicio solo porque alguien la
        dejó puesta el viernes: si algo se apagó y volvió, el estado que
        describe ya no es cierto.
        """
        for v in self._vars.values():
            if not v.retentiva:
                v.valor = v.valor_inicial

    def _guardar(self) -> None:
        doc = {
            "version": 1,
            "guardado_en": _ahora(),
            "variables": [asdict(v) for v in self._vars.values()],
        }
        tmp = self.ruta.with_suffix(".tmp")
        try:
            tmp.write_text(json.dumps(doc, indent=2, ensure_ascii=False),
                           encoding="utf-8")
            os.replace(tmp, self.ruta)
        except Exception as exc:  # noqa: BLE001
            logger.error("No se pudieron guardar las variables internas: %s", exc)
            raise ErrorInterna(
                f"No se pudo escribir {self.ruta}: {exc}", 500)

    # ------------------------------------------------------------------ #
    # Consulta
    # ------------------------------------------------------------------ #
    def listar(self) -> List[dict]:
        return [asdict(v) for v in
                sorted(self._vars.values(), key=lambda x: x.nombre)]

    def tags(self) -> List[dict]:
        """Para mezclar en `GET /tags`."""
        return [v.como_tag() for v in
                sorted(self._vars.values(), key=lambda x: x.nombre)]

    def snapshot_entries(self) -> Dict[str, dict]:
        """
        Entradas para el snapshot del WebSocket, con clave `interno|<nombre>`.

        MISMA FIRMA Y MISMA FORMA que `SubscriptionHandler.snapshot_entries()`,
        y no por simetría: el cliente hace `this.tags = msg.tags` —reemplaza
        la lista ENTERA— cada vez que llega un snapshot. Si las internas no
        vinieran aquí, cada reconexión del WebSocket las borraría de la vista
        y los widgets enlazados a ellas se quedarían en blanco hasta que
        alguien moviera el valor a mano.
        """
        return {
            f"{PLC_INTERNO}|{v.nombre}": {
                "plc": PLC_INTERNO,
                "tag": v.nombre,
                "value": v.valor,
                "type": TIPOS[v.tipo]["opc"],
                "timestamp": v.actualizado_en,
                "source_ts": v.actualizado_en,
            }
            for v in self._vars.values()
        }

    def obtener(self, nombre: str) -> Interna:
        v = self._vars.get(nombre)
        if v is None:
            raise ErrorInterna(f"No existe la variable interna '{nombre}'.", 404)
        return v

    def existe(self, nombre: str) -> bool:
        return nombre in self._vars

    # ------------------------------------------------------------------ #
    # Alta
    # ------------------------------------------------------------------ #
    def crear(self, datos: Dict[str, Any]) -> Interna:
        nombre = normalizar_nombre(str(datos.get("nombre", "")))
        if not nombre:
            raise ErrorInterna("La variable necesita un nombre.")
        if not _RE_NOMBRE.match(nombre):
            raise ErrorInterna(
                f"'{nombre}' no sirve como nombre. Empieza por una letra y usa "
                f"solo letras, números y guiones bajos (máximo 48).")
        if nombre in self._vars:
            raise ErrorInterna(
                f"Ya existe una variable interna llamada '{nombre}'.", 409)

        tipo = str(datos.get("tipo", "bool"))
        if tipo not in TIPOS:
            raise ErrorInterna(
                f"Tipo '{tipo}' no válido. Opciones: {', '.join(TIPOS)}.")

        v = Interna(nombre=nombre, tipo=tipo)
        self._aplicar(v, datos, creando=True)
        self._vars[nombre] = v
        self._guardar()
        logger.info("Variable interna creada: %s (%s)", nombre, tipo)
        return v

    # ------------------------------------------------------------------ #
    # Edición
    # ------------------------------------------------------------------ #
    def actualizar(self, nombre: str, datos: Dict[str, Any]) -> Interna:
        v = self.obtener(nombre)

        # Renombrar es cambiar la CLAVE con la que la conocen los widgets.
        # Se permite, pero se avisa en el resultado: el widget que apuntaba a
        # `interno|viejo` se queda sin enlace, y eso tiene que verse.
        nuevo = datos.get("nombre")
        renombrada = False
        if nuevo is not None:
            n = normalizar_nombre(str(nuevo))
            if not n or not _RE_NOMBRE.match(n):
                raise ErrorInterna(
                    f"'{nuevo}' no sirve como nombre. Empieza por una letra y "
                    f"usa solo letras, números y guiones bajos.")
            if n != v.nombre:
                if n in self._vars:
                    raise ErrorInterna(f"Ya existe una variable '{n}'.", 409)
                renombrada = True

        # Cambiar el tipo obliga a reinterpretar el valor. Si no se puede, se
        # cae al valor por defecto del tipo nuevo en vez de fallar: quien
        # cambia de Texto a Decimal está aceptando que "hola" no sobrevive.
        tipo_nuevo = datos.get("tipo")
        if tipo_nuevo is not None and tipo_nuevo != v.tipo:
            if tipo_nuevo not in TIPOS:
                raise ErrorInterna(f"Tipo '{tipo_nuevo}' no válido.")
            v.tipo = tipo_nuevo
            for campo in ("valor", "valor_inicial"):
                try:
                    setattr(v, campo, convertir(getattr(v, campo), tipo_nuevo))
                except ErrorInterna:
                    setattr(v, campo, TIPOS[tipo_nuevo]["defecto"])
            if tipo_nuevo in ("bool", "string"):
                v.minimo = v.maximo = None
                v.unidad = ""

        self._aplicar(v, datos, creando=False)

        if renombrada:
            del self._vars[v.nombre]
            v.nombre = normalizar_nombre(str(nuevo))
            self._vars[v.nombre] = v

        v.actualizado_en = _ahora()
        self._guardar()
        return v

    def _aplicar(self, v: Interna, datos: Dict[str, Any], creando: bool) -> None:
        """Campos comunes al alta y a la edición. No toca `nombre` ni `tipo`."""
        if "descripcion" in datos:
            v.descripcion = str(datos["descripcion"] or "")[:LARGO_MAX_DESCRIPCION]
        if "unidad" in datos:
            v.unidad = str(datos["unidad"] or "")[:16]
        if "retentiva" in datos:
            v.retentiva = bool(datos["retentiva"])

        if v.tipo in ("int", "double"):
            for campo in ("minimo", "maximo"):
                if campo in datos:
                    bruto = datos[campo]
                    if bruto is None or bruto == "":
                        setattr(v, campo, None)
                    else:
                        setattr(v, campo, float(convertir(bruto, "double")))
            # Un rango invertido no avisa de nada: hace que un depósito se
            # dibuje vacío cuando está lleno. Se rechaza aquí.
            if (v.minimo is not None and v.maximo is not None
                    and v.minimo > v.maximo):
                raise ErrorInterna(
                    f"El mínimo ({v.minimo}) no puede ser mayor que el máximo "
                    f"({v.maximo}).")

        if "valor_inicial" in datos:
            v.valor_inicial = convertir(datos["valor_inicial"], v.tipo)
        elif creando:
            v.valor_inicial = TIPOS[v.tipo]["defecto"]

        if "valor" in datos:
            v.valor = convertir(datos["valor"], v.tipo)
        elif creando:
            v.valor = v.valor_inicial

    # ------------------------------------------------------------------ #
    # Valor
    # ------------------------------------------------------------------ #
    def fijar_valor(self, nombre: str, valor: Any) -> Interna:
        """
        Cambia el valor. Es la operación del día a día.

        Separada de `actualizar()` a propósito: forzar un valor lo hace
        cualquiera que use el panel, y cambiar el tipo o el rango de una
        variable es configuración. Endpoints distintos, permisos distintos.
        """
        v = self.obtener(nombre)
        v.valor = convertir(valor, v.tipo)
        v.actualizado_en = _ahora()
        self._guardar()
        return v

    # ------------------------------------------------------------------ #
    # Baja
    # ------------------------------------------------------------------ #
    def borrar(self, nombre: str) -> None:
        self.obtener(nombre)
        del self._vars[nombre]
        self._guardar()
        logger.info("Variable interna borrada: %s", nombre)
