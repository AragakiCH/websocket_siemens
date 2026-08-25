# -*- coding: utf-8 -*-
"""
grabador.py
===========
Grabaciones en vivo: muestrea los tags de los PLCs a intervalo fijo durante un
periodo, y al terminar se descarga el resultado en Excel.

Diferencia con el **historizador** (`app/db/historian.py`), que es fácil de
confundir:

  ┌──────────────┬────────────────────────┬─────────────────────────────────┐
  │              │ Historizador           │ Grabador                        │
  ├──────────────┼────────────────────────┼─────────────────────────────────┤
  │ Cuándo       │ Siempre, en segundo    │ Solo mientras dura la grabación │
  │              │ plano                  │                                 │
  │ Qué captura  │ CADA cambio del PLC    │ El valor actual cada N ms       │
  │ Dónde va     │ Base de datos          │ Memoria → Excel                 │
  │ Para qué     │ Histórico permanente   │ Un ensayo, un arranque, una     │
  │              │                        │ incidencia concreta             │
  └──────────────┴────────────────────────┴─────────────────────────────────┘

El muestreo a intervalo fijo es lo que hace que el Excel salga **ordenado**: si
se guardara cada cambio, cada tag tendría marcas de tiempo distintas y la tabla
quedaría llena de huecos. Muestreando a la vez, todas las variables comparten
fila y el gráfico sale limpio.

No abre ninguna conexión extra al PLC: se engancha al mismo flujo que alimenta
el WebSocket (igual que el historizador) y mantiene en memoria el último valor
conocido de cada tag.
"""
from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

logger = logging.getLogger("grabador")

# Tope de muestras por grabación. 200.000 filas x ~10 tags es un Excel enorme
# ya; más que eso hay que ir al historizador y a la base de datos.
MAX_MUESTRAS = 200_000

# Intervalo mínimo permitido. Por debajo de 100 ms el PLC no publica más rápido
# (límite del servidor OPC UA), así que solo generaría filas repetidas.
INTERVALO_MIN_MS = 100


def _ahora() -> datetime:
    return datetime.now(timezone.utc)


class Grabacion:
    """Una sesión de captura en curso o ya terminada."""

    def __init__(
        self,
        grabacion_id: str,
        tags: List[str],
        intervalo_ms: int = 1000,
        duracion_s: int = 0,
        nombre: str = "",
    ) -> None:
        self.grabacion_id = grabacion_id
        # Claves "plc|tag". Lista vacía = todos los tags disponibles.
        self.tags = list(tags)
        self.intervalo_ms = max(INTERVALO_MIN_MS, int(intervalo_ms))
        # 0 = indefinida: se graba hasta que se pare a mano.
        self.duracion_s = max(0, int(duracion_s))
        self.nombre = nombre or grabacion_id

        self.estado = "grabando"          # grabando | terminada | detenida
        self.inicio = _ahora()
        self.fin: Optional[datetime] = None
        self.muestras: List[dict] = []
        self.motivo_fin = ""

    # ------------------------------------------------------------------ #
    @property
    def segundos_transcurridos(self) -> float:
        final = self.fin or _ahora()
        return (final - self.inicio).total_seconds()

    @property
    def terminada(self) -> bool:
        return self.estado != "grabando"

    def tags_efectivos(self, disponibles: Dict[str, Any]) -> List[str]:
        """Tags a muestrear: los elegidos, o todos si la lista está vacía."""
        return self.tags or sorted(disponibles.keys())

    def estado_dict(self) -> dict:
        """Estado para la API y para la vista."""
        restante = None
        if self.duracion_s and not self.terminada:
            restante = max(0.0, self.duracion_s - self.segundos_transcurridos)
        return {
            "grabacion_id": self.grabacion_id,
            "nombre": self.nombre,
            "estado": self.estado,
            "tags": self.tags,
            "todos_los_tags": not self.tags,
            "num_tags": len(self.tags),
            "intervalo_ms": self.intervalo_ms,
            "duracion_s": self.duracion_s,
            "inicio": self.inicio.isoformat(),
            "fin": self.fin.isoformat() if self.fin else None,
            "segundos_transcurridos": round(self.segundos_transcurridos, 1),
            "segundos_restantes": round(restante, 1) if restante is not None else None,
            "num_muestras": len(self.muestras),
            "motivo_fin": self.motivo_fin,
            "descargable": self.terminada or bool(self.muestras),
        }


class Grabador:
    """Gestiona todas las grabaciones y el muestreo periódico."""

    def __init__(self, plc_manager=None) -> None:
        self._plc = plc_manager
        # Último valor conocido de cada tag: "plc|tag" -> {plc, tag, value, type}
        self._ultimos: Dict[str, dict] = {}
        self.grabaciones: Dict[str, Grabacion] = {}
        self._tareas: Dict[str, asyncio.Task] = {}
        self._running = False

    # ================================================================== #
    # Ciclo de vida
    # ================================================================== #
    async def start(self, connection_manager) -> None:
        """Se engancha al flujo de tags para mantener la caché de valores."""
        self._running = True
        connection_manager.registrar_observador(self.on_mensaje)
        logger.info("Grabador iniciado.")

    async def stop(self) -> None:
        """Cierra las grabaciones en curso (sus datos siguen descargables)."""
        self._running = False
        for tarea in list(self._tareas.values()):
            tarea.cancel()
        for g in self.grabaciones.values():
            if not g.terminada:
                g.estado = "detenida"
                g.fin = _ahora()
                g.motivo_fin = "El servicio se apagó."
        self._tareas.clear()
        logger.info("Grabador detenido.")

    # ================================================================== #
    # Caché de últimos valores (observador del ConnectionManager)
    # ================================================================== #
    def on_mensaje(self, mensaje: dict) -> None:
        """
        Guarda el último valor de cada tag. Debe ser RÁPIDO: se ejecuta dentro
        del bucle de broadcast.
        """
        tag = mensaje.get("tag")
        if not tag:
            return                      # snapshot / status / plc_removed
        plc = mensaje.get("plc", "")
        self._ultimos[f"{plc}|{tag}"] = {
            "plc": plc,
            "tag": tag,
            "value": mensaje.get("value"),
            "type": mensaje.get("type"),
        }

    def sembrar_desde_snapshot(self) -> int:
        """
        Precarga la caché con el snapshot del PlcManager.

        Sin esto, una grabación que arranca justo después de conectar tendría
        las primeras filas vacías hasta que cada tag cambiara por primera vez.
        """
        if self._plc is None:
            return 0
        try:
            snapshot = self._plc.build_snapshot_message()
        except Exception as exc:  # noqa: BLE001
            logger.debug("No se pudo sembrar la caché: %s", exc)
            return 0

        for clave, t in (snapshot.get("tags") or {}).items():
            self._ultimos.setdefault(clave, {
                "plc": t.get("plc", ""), "tag": t.get("tag", ""),
                "value": t.get("value"), "type": t.get("type"),
            })
        return len(self._ultimos)

    def tags_disponibles(self) -> List[dict]:
        """
        Tags que se pueden grabar ahora mismo (para el selector de la vista).

        Es la misma información que `GET /tags`, pero con la clave compuesta
        `"plc|tag"` ya montada, que es la que espera este módulo.
        """
        self.sembrar_desde_snapshot()
        return [
            {"clave": clave, "plc": d.get("plc", ""), "tag": d.get("tag", ""),
             "tipo": d.get("type"), "valor_actual": d.get("value")}
            for clave, d in sorted(self._ultimos.items())
        ]

    # ================================================================== #
    # Grabaciones
    # ================================================================== #
    def iniciar(
        self,
        grabacion_id: str,
        tags: Optional[List[str]] = None,
        intervalo_ms: int = 1000,
        duracion_s: int = 0,
        nombre: str = "",
    ) -> dict:
        """Arranca una grabación nueva."""
        grabacion_id = (grabacion_id or "").strip()
        if not grabacion_id:
            return {"ok": False, "mensaje": "Indica un identificador (grabacion_id)."}

        anterior = self.grabaciones.get(grabacion_id)
        if anterior is not None and not anterior.terminada:
            return {"ok": False, "grabacion_id": grabacion_id,
                    "mensaje": f"La grabación '{grabacion_id}' ya está en curso. "
                               f"Párala antes de volver a empezar."}

        self.sembrar_desde_snapshot()

        # Avisar si se piden tags que ahora mismo no existen: probablemente sea
        # una errata en la clave, y si no se dice, el Excel saldría vacío.
        pedidos = list(tags or [])
        desconocidos = [t for t in pedidos if t not in self._ultimos]

        grabacion = Grabacion(grabacion_id, pedidos, intervalo_ms,
                              duracion_s, nombre)
        self.grabaciones[grabacion_id] = grabacion
        self._tareas[grabacion_id] = asyncio.create_task(self._bucle(grabacion))

        logger.info("Grabación '%s' iniciada (%d tag(s), cada %d ms, %s).",
                    grabacion_id, len(grabacion.tags) or len(self._ultimos),
                    grabacion.intervalo_ms,
                    f"{grabacion.duracion_s}s" if grabacion.duracion_s else "indefinida")

        salida = {
            "ok": True, "grabacion_id": grabacion_id,
            "intervalo_ms": grabacion.intervalo_ms,
            "duracion_s": grabacion.duracion_s,
            "num_tags": len(grabacion.tags) or len(self._ultimos),
            "mensaje": f"Grabación '{grabacion_id}' en curso.",
        }
        if desconocidos:
            salida["tags_desconocidos"] = desconocidos
            salida["mensaje"] += (
                f" Aviso: {len(desconocidos)} tag(s) no existen ahora mismo y "
                f"saldrán vacíos."
            )
        return salida

    async def _bucle(self, grabacion: Grabacion) -> None:
        """Muestrea la caché cada `intervalo_ms` hasta que toque parar."""
        intervalo = grabacion.intervalo_ms / 1000.0
        try:
            while self._running and not grabacion.terminada:
                self._muestrear(grabacion)

                if len(grabacion.muestras) >= MAX_MUESTRAS:
                    grabacion.estado = "terminada"
                    grabacion.fin = _ahora()
                    grabacion.motivo_fin = (
                        f"Se alcanzó el máximo de {MAX_MUESTRAS:,} muestras."
                    )
                    break

                if grabacion.duracion_s and \
                        grabacion.segundos_transcurridos >= grabacion.duracion_s:
                    grabacion.estado = "terminada"
                    grabacion.fin = _ahora()
                    grabacion.motivo_fin = "Duración completada."
                    break

                await asyncio.sleep(intervalo)
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001
            grabacion.estado = "detenida"
            grabacion.fin = _ahora()
            grabacion.motivo_fin = f"Error: {exc}"
            logger.warning("Grabación '%s' abortada: %s",
                           grabacion.grabacion_id, exc)
        finally:
            self._tareas.pop(grabacion.grabacion_id, None)
            if not grabacion.terminada:
                grabacion.estado = "detenida"
                grabacion.fin = _ahora()
            logger.info("Grabación '%s' finalizada: %d muestra(s). %s",
                        grabacion.grabacion_id, len(grabacion.muestras),
                        grabacion.motivo_fin)

    def _muestrear(self, grabacion: Grabacion) -> None:
        """
        Toma una foto de todos los tags del grupo en el MISMO instante.

        Compartir la marca de tiempo es lo que permite que el Excel salga
        pivotado sin huecos: todas las variables caen en la misma fila.
        """
        ts = _ahora().isoformat()
        for clave in grabacion.tags_efectivos(self._ultimos):
            dato = self._ultimos.get(clave)
            if dato is None:
                # Tag pedido que aún no ha publicado ningún valor.
                plc, _, tag = clave.partition("|")
                grabacion.muestras.append(
                    {"ts": ts, "plc": plc, "tag": tag, "valor": None, "tipo": None}
                )
                continue
            grabacion.muestras.append({
                "ts": ts,
                "plc": dato.get("plc", ""),
                "tag": dato.get("tag", ""),
                "valor": dato.get("value"),
                "tipo": dato.get("type"),
            })

    def parar(self, grabacion_id: str) -> dict:
        """Detiene una grabación en curso. Los datos siguen descargables."""
        grabacion = self.grabaciones.get(grabacion_id)
        if grabacion is None:
            return {"ok": False, "mensaje": f"No existe la grabación '{grabacion_id}'."}
        if grabacion.terminada:
            return {"ok": True, "grabacion_id": grabacion_id,
                    "estado": grabacion.estado,
                    "num_muestras": len(grabacion.muestras),
                    "mensaje": "La grabación ya estaba terminada."}

        grabacion.estado = "terminada"
        grabacion.fin = _ahora()
        grabacion.motivo_fin = "Detenida por el usuario."
        tarea = self._tareas.pop(grabacion_id, None)
        if tarea is not None:
            tarea.cancel()

        return {"ok": True, "grabacion_id": grabacion_id, "estado": "terminada",
                "num_muestras": len(grabacion.muestras),
                "segundos": round(grabacion.segundos_transcurridos, 1),
                "mensaje": f"Grabación '{grabacion_id}' detenida con "
                           f"{len(grabacion.muestras)} muestra(s). Ya se puede "
                           f"descargar el Excel."}

    def borrar(self, grabacion_id: str) -> dict:
        """Elimina la grabación y libera su memoria."""
        grabacion = self.grabaciones.pop(grabacion_id, None)
        if grabacion is None:
            return {"ok": False, "mensaje": f"No existe la grabación '{grabacion_id}'."}
        tarea = self._tareas.pop(grabacion_id, None)
        if tarea is not None:
            tarea.cancel()
        return {"ok": True, "grabacion_id": grabacion_id,
                "mensaje": f"Grabación '{grabacion_id}' eliminada."}

    def listar(self) -> dict:
        """Todas las grabaciones con su estado."""
        grabaciones = [g.estado_dict() for g in self.grabaciones.values()]
        return {
            "num_grabaciones": len(grabaciones),
            "en_curso": sum(1 for g in grabaciones if g["estado"] == "grabando"),
            "tags_en_cache": len(self._ultimos),
            "grabaciones": grabaciones,
        }

    def obtener(self, grabacion_id: str) -> Optional[Grabacion]:
        return self.grabaciones.get(grabacion_id)
