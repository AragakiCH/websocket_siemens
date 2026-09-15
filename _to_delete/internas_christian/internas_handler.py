# -*- coding: utf-8 -*-
"""
internas_handler.py
===================
Las variables internas, vestidas de PLC.

LA IDEA, EN UNA LÍNEA
---------------------
Un PLC que no está en ningún sitio. Este adaptador cumple la misma interfaz
pequeña que `SubscriptionHandler` —`snapshot_entries`, `buscar_tag`, `leer`,
`escribir`, `is_plc_connected`…— y se registra en el `PlcManager` con el id
`interno`.

POR QUÉ ASÍ Y NO UN CAMINO APARTE
---------------------------------
Porque TODO el sistema habla `plc|tag`: los desplegables del Diseñador, las
dinámicas, los parámetros de faceplate, las tendencias, el campo E/A, las
acciones de botón, los widgets importados, el historizador y el motor de
alarmas. Entrando por la misma puerta que un PLC de verdad, una variable
interna funciona en los doce sitios sin tocar ninguno.

La alternativa —una lista de variables internas por su cuenta, con su propio
canal y su propia escritura— habría obligado a que cada uno de esos doce
sitios supiera que existen dos clases de variable. Y el que se olvidara
fallaría solo con las internas, que es el peor sitio donde tener un fallo:
justo donde se prueban las cosas.

LO QUE NO TIENE
---------------
No hay conexión que vigilar, ni reconexión, ni muestreo: el valor está en
memoria. `is_plc_connected()` devuelve siempre `True` —y es verdad: las
variables internas nunca están caídas—, que además es lo que hace que la
escritura las acepte sin tratarlas como caso especial.
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Dict, List, Optional

from app.db.internas_store import OPC, InternasStore
from app.drivers.plc_driver import TagInfo, TagValue

logger = logging.getLogger("internas")

#: El id del PLC de mentira. Un widget guarda `interno|modo`, así que este
#: texto es parte del formato de los proyectos guardados: no se cambia.
PLC_INTERNO = "interno"

#: Nombre del "Data Block" con el que se agrupan en el árbol de exploración.
DB_INTERNAS = "Internas"


def _ahora_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


class InternasHandler:
    """Adapta `InternasStore` a lo que el `PlcManager` espera de un PLC."""

    def __init__(self, store: InternasStore, manager=None) -> None:
        self._store = store
        self._manager = manager          # ConnectionManager, para difundir
        self.plc_id = PLC_INTERNO
        self.plc_nombre = "Variables internas"
        self.vendor = PLC_INTERNO
        self.endpoint = ""
        self.estado_conexion = "ok"
        #: Lo que mira el `PlcManager` para no tratarlo como un autómata: ni
        #: se puede quitar desde la pantalla de PLCs, ni le aplica la lista
        #: blanca de escritura, ni se enseña como una conexión.
        self.es_interno = True

    # ------------------------------------------------------------------ #
    # Ciclo de vida: no hay nada que arrancar ni que parar.
    # ------------------------------------------------------------------ #
    async def start(self) -> None:
        logger.info("Variables internas listas: %d definida(s).",
                    len(self._store.listar()))

    async def stop(self) -> None:
        return None

    # ------------------------------------------------------------------ #
    # Estado
    # ------------------------------------------------------------------ #
    def is_plc_connected(self) -> bool:
        # Siempre. No es una licencia: una variable en memoria no se cae.
        return True

    def soporta_escritura(self) -> bool:
        return True

    def health(self) -> dict:
        return {
            "plc": self.plc_id,
            "nombre": self.plc_nombre,
            "vendor": self.vendor,
            "endpoint": "",
            "conectado": True,
            "estado_conexion": self.estado_conexion,
            "num_tags": len(self._store.listar()),
            "interno": True,
        }

    # ------------------------------------------------------------------ #
    # Lectura agregada
    # ------------------------------------------------------------------ #
    def _entrada(self, v: dict) -> dict:
        return {
            "plc": self.plc_id,
            "tag": v["nombre"],
            "value": v["valor"],
            "type": OPC[v["tipo"]],
            "timestamp": v.get("actualizado_en") or _ahora_iso(),
            "source_ts": "",
            "server_ts": "",
            "delta_ms": 0,
        }

    def snapshot_entries(self) -> Dict[str, dict]:
        return {f"{self.plc_id}|{v['nombre']}": self._entrada(v)
                for v in self._store.listar()}

    def get_tags_con_valor(self) -> List[dict]:
        return [self._entrada(v) for v in self._store.listar()]

    def get_browse_tree(self) -> dict:
        return {
            "plc": self.plc_id,
            "nombre": self.plc_nombre,
            "vendor": self.vendor,
            "dbs": {
                DB_INTERNAS: [
                    {"name": v["nombre"], "full_name": v["nombre"],
                     "node_id": v["nombre"], "data_type": OPC[v["tipo"]]}
                    for v in self._store.listar()
                ]
            },
        }

    # ------------------------------------------------------------------ #
    # Escritura
    # ------------------------------------------------------------------ #
    def buscar_tag(self, nombre: str) -> Optional[TagInfo]:
        v = self._store.obtener((nombre or "").strip())
        if v is None:
            return None
        # `node_id` es el propio nombre: aquí no hay un espacio de nombres
        # aparte que traducir, y inventar uno solo daría dos formas de llamar
        # a lo mismo.
        return TagInfo(
            name=v["nombre"],
            full_name=v["nombre"],
            node_id=v["nombre"],
            data_type=OPC[v["tipo"]],
            db_name=DB_INTERNAS,
        )

    def _valor(self, nombre: str) -> TagValue:
        v = self._store.obtener(nombre)
        if v is None:
            raise KeyError(f"No existe la variable interna '{nombre}'.")
        return TagValue(
            tag=v["nombre"],
            value=v["valor"],
            data_type=OPC[v["tipo"]],
            timestamp=_ahora_iso(),
            node_id=v["nombre"],
        )

    async def leer(self, node_id: str) -> TagValue:
        return self._valor(node_id)

    async def escribir(self, node_id: str, valor: object) -> TagValue:
        """
        Fuerza el valor y avisa a todos los paneles.

        El aviso lo manda AQUÍ y no quien llama porque en un PLC de verdad lo
        manda la suscripción del driver: el cambio llega solo. Una variable
        interna no tiene quién la vigile, así que si este método no difundiera,
        el valor cambiaría en el servidor y las pantallas seguirían enseñando
        el anterior hasta que alguien recargara.
        """
        self._store.poner_valor(node_id, valor)
        await self._difundir(node_id)
        return self._valor(node_id)

    async def _difundir(self, nombre: str) -> None:
        if self._manager is None:
            return
        v = self._store.obtener(nombre)
        if v is None:
            return
        # El mismo formato que manda `SubscriptionHandler.on_data_change`: para
        # el navegador es un cambio de tag más.
        await self._manager.broadcast({
            "timestamp": _ahora_iso(),
            "plc": self.plc_id,
            "tag": v["nombre"],
            "value": v["valor"],
            "type": OPC[v["tipo"]],
            "source_ts": "",
            "server_ts": "",
            "delta_ms": 0,
        })

    # ------------------------------------------------------------------ #
    # Altas y bajas: el catálogo cambió, hay que rehacer el snapshot
    # ------------------------------------------------------------------ #
    async def avisar_catalogo(self, plc_manager) -> None:
        """
        Difunde un snapshot entero.

        Al crear o borrar una variable no basta con mandar su valor: los
        clientes construyen su lista de variables a partir del snapshot, y una
        recién creada no existiría para ellos hasta recargar. Borrar es peor
        todavía — el tag seguiría en la lista de todos los navegadores abiertos
        aunque ya no exista aquí.
        """
        if self._manager is None:
            return
        await self._manager.broadcast(plc_manager.build_snapshot_message())
