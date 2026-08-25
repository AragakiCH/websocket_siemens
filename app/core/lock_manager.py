# -*- coding: utf-8 -*-
"""
lock_manager.py
===============
Bloqueo de edición: "el lápiz" del diseñador (Fase 4, opción A del plan).

**El problema que resuelve.** Sin bloqueo, dos personas pueden arrastrar el
mismo widget a la vez. El control de versiones del `ProjectStore` evita que se
pierda trabajo silenciosamente —el segundo recibe un 409—, pero no evita la
confusión: nadie sabe quién manda sobre la pantalla. En un HMI industrial esa
ambigüedad no es una molestia de producto, es un riesgo operativo.

**Cómo funciona.** Un solo usuario tiene el lápiz sobre un recurso; el resto lo
ve todo en vivo, en modo lectura.

  1. Al entrar al Diseñador se intenta `adquirir()`.
  2. Mientras se edita, el cliente manda `renovar()` cada pocos segundos.
  3. Al salir, `liberar()`.
  4. Si el cliente desaparece (cierra el portátil, se cae la red, se va a
     comer), el lock **caduca solo** a los `TTL_SEGUNDOS` sin heartbeat. Sin
     esto, un navegador cerrado dejaría la pantalla bloqueada para siempre y
     alguien tendría que reiniciar el servicio.

**Toma de control.** Un `Supervisor` puede quitarle el lápiz a otro con
`forzar()`. Existe porque la alternativa real es esperar 30 segundos mirando
la pantalla, y en una parada de planta eso no se acepta. Queda registrado en
la auditoría y se avisa al que lo pierde.

**Ámbito.** El estado vive en memoria del proceso, igual que las sesiones. Con
un solo worker de uvicorn (que es como debe correr este servicio) es correcto.
El día que haya varios procesos, esto necesita Redis igual que el broadcast.
"""
from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Dict, List, Optional

logger = logging.getLogger("lock_manager")

# Segundos sin heartbeat tras los que el lock se considera abandonado.
# 30 s es un equilibrio: aguanta un pico de red o una pestaña en segundo plano
# sin soltar el lápiz, pero no deja la pantalla bloqueada un cuarto de hora
# porque alguien cerró el portátil.
TTL_SEGUNDOS = 30.0

# Cada cuánto debería renovar el cliente. Se devuelve en la respuesta para que
# el frontend no tenga que llevar el número duplicado.
HEARTBEAT_SEGUNDOS = 10.0


def _ahora() -> datetime:
    return datetime.now(timezone.utc)


def _iso(dt: datetime) -> str:
    return dt.isoformat().replace("+00:00", "Z")


@dataclass
class Bloqueo:
    """Un lápiz concedido sobre un recurso."""

    recurso: str          # "designer:principal", "alarmas", ...
    usuario: str
    categoria: str = ""
    adquirido: datetime = None  # type: ignore[assignment]
    ultimo_latido: datetime = None  # type: ignore[assignment]

    def __post_init__(self) -> None:
        if self.adquirido is None:
            self.adquirido = _ahora()
        if self.ultimo_latido is None:
            self.ultimo_latido = self.adquirido

    def caducado(self, ttl: float = TTL_SEGUNDOS) -> bool:
        return _ahora() - self.ultimo_latido > timedelta(seconds=ttl)

    def segundos_restantes(self, ttl: float = TTL_SEGUNDOS) -> float:
        transcurrido = (_ahora() - self.ultimo_latido).total_seconds()
        return max(0.0, ttl - transcurrido)

    def publico(self) -> dict:
        return {
            "recurso": self.recurso,
            "usuario": self.usuario,
            "categoria": self.categoria,
            "adquirido": _iso(self.adquirido),
            "ultimo_latido": _iso(self.ultimo_latido),
            "segundos_restantes": round(self.segundos_restantes(), 1),
        }


class LockManager:
    """Administra los lápices de edición por recurso."""

    def __init__(self, connection_manager=None) -> None:
        self._locks: Dict[str, Bloqueo] = {}
        self._manager = connection_manager
        self._lock = asyncio.Lock()

    def vincular_manager(self, connection_manager) -> None:
        """Inyecta el ConnectionManager para poder difundir los cambios."""
        self._manager = connection_manager

    # ------------------------------------------------------------------ #
    # Consulta
    # ------------------------------------------------------------------ #
    def _limpiar(self) -> List[Bloqueo]:
        """Quita los caducados. Devuelve los que se soltaron."""
        soltados = [b for b in self._locks.values() if b.caducado()]
        for b in soltados:
            self._locks.pop(b.recurso, None)
            logger.info("Lock '%s' caducado (era de '%s').", b.recurso, b.usuario)
        return soltados

    def titular(self, recurso: str) -> Optional[Bloqueo]:
        """Quién tiene el lápiz de ese recurso ahora mismo, o None."""
        self._limpiar()
        return self._locks.get(recurso)

    def puede_editar(self, recurso: str, usuario: str) -> bool:
        """
        True si `usuario` puede escribir en `recurso`.

        Un recurso SIN dueño es editable por cualquiera: el bloqueo es
        cooperativo, no una barrera de seguridad (esa la ponen los roles). Así,
        si el sistema corre sin identidad (`auth_requerida=false`), todo sigue
        funcionando como antes.
        """
        b = self.titular(recurso)
        if b is None:
            return True
        if not usuario:
            # Sesión anónima: solo puede editar lo que nadie tiene tomado.
            return False
        return b.usuario == usuario

    def listar(self) -> List[dict]:
        self._limpiar()
        return [b.publico() for b in self._locks.values()]

    # ------------------------------------------------------------------ #
    # Mutaciones
    # ------------------------------------------------------------------ #
    async def adquirir(self, recurso: str, usuario: str,
                       categoria: str = "") -> dict:
        """
        Intenta tomar el lápiz.

        Si ya lo tiene esa misma persona, se trata como una renovación: entrar
        dos veces al Diseñador (dos pestañas) no debe echarse a uno mismo.
        """
        async with self._lock:
            self._limpiar()
            actual = self._locks.get(recurso)

            if actual is not None and actual.usuario != usuario:
                return {
                    "ok": False,
                    "concedido": False,
                    "recurso": recurso,
                    "titular": actual.publico(),
                    "mensaje": (
                        f"'{actual.usuario}' está editando ahora mismo. "
                        f"Puedes ver los cambios en vivo; para tomar el "
                        f"control, pídeselo o espera "
                        f"{actual.segundos_restantes():.0f} s a que caduque."
                    ),
                }

            if actual is not None:
                actual.ultimo_latido = _ahora()
                bloqueo = actual
                nuevo = False
            else:
                bloqueo = Bloqueo(recurso=recurso, usuario=usuario,
                                  categoria=categoria)
                self._locks[recurso] = bloqueo
                nuevo = True

        if nuevo:
            logger.info("Lock '%s' concedido a '%s'.", recurso, usuario)
            await self._difundir(recurso, bloqueo, "adquirido")

        return {
            "ok": True, "concedido": True, "recurso": recurso,
            "titular": bloqueo.publico(),
            "heartbeat_s": HEARTBEAT_SEGUNDOS,
            "ttl_s": TTL_SEGUNDOS,
            "mensaje": "Tienes el control de edición.",
        }

    async def renovar(self, recurso: str, usuario: str) -> dict:
        """
        Heartbeat. Devuelve `concedido: False` si el lápiz ya no es tuyo,
        para que el cliente pase a modo lectura sin esperar a fallar al
        guardar.
        """
        async with self._lock:
            self._limpiar()
            actual = self._locks.get(recurso)
            if actual is None:
                return {"ok": True, "concedido": False, "recurso": recurso,
                        "mensaje": "El bloqueo caducó. Vuelve a tomarlo."}
            if actual.usuario != usuario:
                return {"ok": True, "concedido": False, "recurso": recurso,
                        "titular": actual.publico(),
                        "mensaje": f"Ahora edita '{actual.usuario}'."}
            actual.ultimo_latido = _ahora()
            return {"ok": True, "concedido": True, "recurso": recurso,
                    "titular": actual.publico(),
                    "heartbeat_s": HEARTBEAT_SEGUNDOS}

    async def liberar(self, recurso: str, usuario: str) -> dict:
        """Suelta el lápiz. Solo puede hacerlo quien lo tiene."""
        async with self._lock:
            actual = self._locks.get(recurso)
            if actual is None:
                return {"ok": True, "recurso": recurso,
                        "mensaje": "No había bloqueo."}
            if usuario and actual.usuario != usuario:
                return {"ok": False, "recurso": recurso,
                        "titular": actual.publico(),
                        "mensaje": f"El bloqueo es de '{actual.usuario}'."}
            self._locks.pop(recurso, None)

        logger.info("Lock '%s' liberado por '%s'.", recurso, usuario or "-")
        await self._difundir(recurso, None, "liberado", por=usuario)
        return {"ok": True, "recurso": recurso, "mensaje": "Control liberado."}

    async def forzar(self, recurso: str, usuario: str,
                     categoria: str = "") -> dict:
        """
        Toma de control: le quita el lápiz a quien lo tenga.

        Solo debe llamarse tras comprobar que quien lo pide es Supervisor (eso
        lo hace la capa de rutas). Aquí se registra quién se lo quitó a quién,
        porque es exactamente el tipo de acción que alguien va a querer
        auditar después.
        """
        async with self._lock:
            anterior = self._locks.get(recurso)
            bloqueo = Bloqueo(recurso=recurso, usuario=usuario,
                              categoria=categoria)
            self._locks[recurso] = bloqueo

        if anterior is not None and anterior.usuario != usuario:
            logger.warning("Lock '%s': '%s' tomó el control que tenía '%s'.",
                           recurso, usuario, anterior.usuario)
        await self._difundir(recurso, bloqueo, "forzado",
                             anterior=anterior.usuario if anterior else "")
        return {
            "ok": True, "concedido": True, "recurso": recurso,
            "titular": bloqueo.publico(),
            "heartbeat_s": HEARTBEAT_SEGUNDOS,
            "anterior": anterior.usuario if anterior else "",
            "mensaje": (
                f"Has tomado el control (lo tenía '{anterior.usuario}')."
                if anterior and anterior.usuario != usuario
                else "Tienes el control de edición."
            ),
        }

    async def liberar_todos_de(self, usuario: str) -> int:
        """
        Suelta todos los lápices de una persona. Se llama al cerrar sesión y
        al desactivar una cuenta: si alguien ya no está, su bloqueo tampoco
        debería seguir.
        """
        soltados: List[str] = []
        async with self._lock:
            for recurso, b in list(self._locks.items()):
                if b.usuario == usuario:
                    self._locks.pop(recurso, None)
                    soltados.append(recurso)
        for recurso in soltados:
            await self._difundir(recurso, None, "liberado", por=usuario)
        if soltados:
            logger.info("Liberados %d bloqueo(s) de '%s'.", len(soltados), usuario)
        return len(soltados)

    # ------------------------------------------------------------------ #
    # Vigilancia de caducados
    # ------------------------------------------------------------------ #
    async def barrer_caducados(self) -> None:
        """
        Suelta los locks abandonados y AVISA.

        Hace falta un barrido activo además de la limpieza perezosa: si nadie
        consulta el lock, los demás clientes nunca se enterarían de que quedó
        libre y seguirían en modo lectura sin motivo.
        """
        async with self._lock:
            soltados = self._limpiar()
        for b in soltados:
            await self._difundir(b.recurso, None, "caducado", por=b.usuario)

    # ------------------------------------------------------------------ #
    # Difusión
    # ------------------------------------------------------------------ #
    async def _difundir(self, recurso: str, bloqueo: Optional[Bloqueo],
                        accion: str, por: str = "", anterior: str = "") -> None:
        if self._manager is None:
            return
        try:
            await self._manager.broadcast({
                "timestamp": _iso(_ahora()),
                "type": "lock.changed",
                "recurso": recurso,
                "accion": accion,           # adquirido|liberado|forzado|caducado
                "titular": bloqueo.publico() if bloqueo else None,
                "por": por or (bloqueo.usuario if bloqueo else ""),
                "anterior": anterior,
            })
        except Exception as exc:  # noqa: BLE001
            logger.warning("No se pudo difundir el cambio de lock: %s", exc)
