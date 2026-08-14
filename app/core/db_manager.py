# -*- coding: utf-8 -*-
"""
db_manager.py
=============
Gestor de conexiones a bases de datos, hermano de `PlcManager`.

Responsabilidades:
  * Mantener un pool abierto por cada conexión dada de alta (no se abre y
    cierra una conexión por consulta: eso mataría el rendimiento del HMI).
  * Alta y baja en caliente desde la API, con persistencia en disco.
  * Reconectar automáticamente si la BD se cayó y vuelve.
  * Ejecutar las consultas GUARDADAS por su id, con parámetros bindeados.

Diferencia clave con los PLCs: un PLC empuja datos (subscription), una BD hay
que preguntarle. Por eso aquí no hay WebSocket ni broadcast: el widget pide
y recibe. El refresco periódico lo decide el frontend llamando cada N segundos.
"""
from __future__ import annotations

import asyncio
import logging
from typing import Any, Dict, List, Optional

from app.db.db_driver import DbDriver, ResultadoConsulta
from app.db.sql_driver import MOTORES, SqlDriver, validar_sql_lectura
from app.db.store import ConexionGuardada, ConsultaGuardada, DbStore

logger = logging.getLogger("db_manager")


class DbManager:
    """Administra N conexiones a bases de datos en simultáneo."""

    def __init__(self, store: Optional[DbStore] = None) -> None:
        self._store = store or DbStore()
        # db_id -> driver con su pool abierto
        self._drivers: Dict[str, DbDriver] = {}
        # db_id -> último error de conexión (para mostrarlo en la vista)
        self._errores: Dict[str, str] = {}
        self._lock = asyncio.Lock()

    @property
    def store(self) -> DbStore:
        return self._store

    # ================================================================== #
    # Arranque / parada
    # ================================================================== #
    async def start(self) -> None:
        """
        Abre los pools de las conexiones marcadas como `autoconectar`.

        Una BD caída NO impide arrancar: se registra el error y el widget
        podrá reintentar. El servicio nunca se bloquea por una BD.
        """
        for conexion in self._store.conexiones.values():
            if not conexion.autoconectar:
                continue
            try:
                await self._abrir(conexion)
            except Exception as exc:  # noqa: BLE001
                self._errores[conexion.db_id] = str(exc)
                logger.warning("No se pudo conectar a '%s': %s",
                               conexion.db_id, exc)
        logger.info("DbManager iniciado: %d/%d conexión(es) activa(s).",
                    len(self._drivers), len(self._store.conexiones))

    async def stop(self) -> None:
        """Cierra todos los pools limpiamente."""
        await asyncio.gather(
            *(d.disconnect() for d in self._drivers.values()),
            return_exceptions=True,
        )
        self._drivers.clear()
        logger.info("DbManager detenido.")

    # ================================================================== #
    # Conexiones
    # ================================================================== #
    async def _abrir(self, conexion: ConexionGuardada) -> DbDriver:
        """Crea el driver y abre su pool. Reemplaza el anterior si existía."""
        anterior = self._drivers.pop(conexion.db_id, None)
        if anterior is not None:
            try:
                await anterior.disconnect()
            except Exception:  # noqa: BLE001
                pass

        driver = SqlDriver(
            motor=conexion.motor,
            host=conexion.host,
            puerto=conexion.puerto,
            base_datos=conexion.base_datos,
            usuario=conexion.usuario,
            password=self._store.password_de(conexion.db_id),
            opciones=conexion.opciones,
        )
        await driver.connect()
        self._drivers[conexion.db_id] = driver
        self._errores.pop(conexion.db_id, None)
        return driver

    async def alta_conexion(
        self,
        db_id: str,
        motor: str,
        host: str = "",
        puerto: Optional[int] = None,
        base_datos: str = "",
        usuario: str = "",
        password: str = "",
        nombre: str = "",
        opciones: Optional[Dict[str, str]] = None,
        autoconectar: bool = True,
    ) -> dict:
        """
        Da de alta (o actualiza) una conexión y abre su pool.

        A diferencia de los PLCs, aquí la conexión se verifica ANTES de
        guardar: no tiene sentido persistir credenciales que no funcionan.
        """
        db_id = (db_id or "").strip()
        if not db_id:
            return {"ok": False, "mensaje": "Indica un identificador (db_id)."}
        if motor not in MOTORES:
            return {"ok": False,
                    "mensaje": f"Motor '{motor}' no soportado. "
                               f"Opciones: {', '.join(sorted(MOTORES))}."}

        conexion = ConexionGuardada(
            db_id=db_id, motor=motor, nombre=nombre or db_id,
            host=host, puerto=puerto, base_datos=base_datos,
            usuario=usuario, opciones=opciones or {},
            autoconectar=autoconectar,
        )

        # Verificar antes de persistir: driver temporal con la contraseña en claro.
        prueba = SqlDriver(
            motor=motor, host=host, puerto=puerto, base_datos=base_datos,
            usuario=usuario, password=password, opciones=opciones or {},
        )
        try:
            await prueba.connect()
            latencia = await prueba.test()
        except Exception as exc:  # noqa: BLE001
            return {"ok": False, "db_id": db_id,
                    "mensaje": f"No se pudo conectar: {exc}"}
        finally:
            await prueba.disconnect()

        async with self._lock:
            self._store.guardar_conexion(conexion, password)
            await self._abrir(conexion)

        logger.info("Conexión '%s' dada de alta (%s).", db_id, motor)
        return {"ok": True, "db_id": db_id, "motor": motor,
                "latencia_ms": round(latencia, 1),
                "mensaje": f"Conexión '{db_id}' verificada y guardada."}

    async def baja_conexion(self, db_id: str) -> dict:
        """Cierra el pool y borra la conexión y sus consultas."""
        async with self._lock:
            driver = self._drivers.pop(db_id, None)
            if driver is not None:
                try:
                    await driver.disconnect()
                except Exception:  # noqa: BLE001
                    pass
            n_consultas = len(self._store.consultas_de(db_id))
            if not self._store.borrar_conexion(db_id):
                return {"ok": False, "mensaje": f"No existe la conexión '{db_id}'."}

        return {"ok": True, "db_id": db_id,
                "consultas_borradas": n_consultas,
                "mensaje": f"Conexión '{db_id}' eliminada "
                           f"({n_consultas} consulta(s) asociada(s))."}

    async def probar_conexion(self, db_id: str) -> dict:
        """Comprueba que la BD responde; si el pool se cayó, lo reabre."""
        conexion = self._store.conexiones.get(db_id)
        if conexion is None:
            return {"ok": False, "mensaje": f"No existe la conexión '{db_id}'."}
        try:
            driver = await self._driver_de(db_id)
            latencia = await driver.test()
            return {"ok": True, "db_id": db_id,
                    "latencia_ms": round(latencia, 1), "mensaje": "Conexión OK."}
        except Exception as exc:  # noqa: BLE001
            self._errores[db_id] = str(exc)
            return {"ok": False, "db_id": db_id, "mensaje": f"Falló: {exc}"}

    async def _driver_de(self, db_id: str) -> DbDriver:
        """
        Devuelve el driver de `db_id`, reabriendo el pool si hace falta.

        Esto es lo que da tolerancia a fallos: si la BD estaba caída al
        arrancar y luego vuelve, la primera consulta la reconecta sola.
        """
        driver = self._drivers.get(db_id)
        if driver is not None and driver.is_connected():
            return driver

        conexion = self._store.conexiones.get(db_id)
        if conexion is None:
            raise KeyError(f"No existe la conexión '{db_id}'.")
        return await self._abrir(conexion)

    def listar_conexiones(self) -> List[dict]:
        """Conexiones guardadas con su estado (sin contraseñas)."""
        salida = []
        for c in self._store.conexiones.values():
            driver = self._drivers.get(c.db_id)
            d = c.publico()
            d["etiqueta_motor"] = MOTORES.get(c.motor, {}).get("etiqueta", c.motor)
            d["conectado"] = bool(driver and driver.is_connected())
            d["num_consultas"] = len(self._store.consultas_de(c.db_id))
            if c.db_id in self._errores:
                d["ultimo_error"] = self._errores[c.db_id]
            salida.append(d)
        return salida

    # ================================================================== #
    # Consultas guardadas
    # ================================================================== #
    def alta_consulta(
        self,
        query_id: str,
        db_id: str,
        sql: str,
        nombre: str = "",
        parametros: Optional[Dict[str, Dict[str, Any]]] = None,
        limite: int = 1000,
        descripcion: str = "",
    ) -> dict:
        """
        Registra una consulta. Se valida el SQL AQUÍ, no al ejecutar: así el
        error sale en el diseñador y no en la pantalla de un operario.
        """
        query_id = (query_id or "").strip()
        if not query_id:
            return {"ok": False, "mensaje": "Indica un identificador (query_id)."}
        if db_id not in self._store.conexiones:
            return {"ok": False,
                    "mensaje": f"No existe la conexión '{db_id}'. Créala primero."}
        try:
            validar_sql_lectura(sql)
        except ValueError as exc:
            return {"ok": False, "mensaje": str(exc)}

        consulta = ConsultaGuardada(
            query_id=query_id, db_id=db_id, nombre=nombre or query_id,
            sql=sql, parametros=parametros or {},
            limite=max(1, min(int(limite), 10000)), descripcion=descripcion,
        )
        self._store.guardar_consulta(consulta)
        logger.info("Consulta '%s' guardada sobre '%s'.", query_id, db_id)
        return {"ok": True, "query_id": query_id, "db_id": db_id,
                "mensaje": f"Consulta '{query_id}' guardada."}

    def baja_consulta(self, query_id: str) -> dict:
        if not self._store.borrar_consulta(query_id):
            return {"ok": False, "mensaje": f"No existe la consulta '{query_id}'."}
        return {"ok": True, "query_id": query_id,
                "mensaje": f"Consulta '{query_id}' eliminada."}

    def listar_consultas(self, db_id: Optional[str] = None) -> List[dict]:
        return [q.publico() for q in self._store.consultas_de(db_id)]

    # ================================================================== #
    # Ejecución
    # ================================================================== #
    async def ejecutar(
        self,
        query_id: str,
        parametros: Optional[Dict[str, Any]] = None,
    ) -> dict:
        """
        Ejecuta una consulta guardada. Es lo que llaman los widgets.

        Los parámetros recibidos del frontend se filtran contra los DECLARADOS
        en la consulta: si el widget manda uno que no existe, se ignora. Los
        que falten toman su valor por defecto.
        """
        consulta = self._store.consultas.get(query_id)
        if consulta is None:
            return {"ok": False, "mensaje": f"No existe la consulta '{query_id}'."}

        # Resolver parámetros: solo los declarados, con sus valores por defecto.
        recibidos = parametros or {}
        finales: Dict[str, Any] = {}
        faltantes: List[str] = []
        for nombre, cfg in consulta.parametros.items():
            if nombre in recibidos:
                finales[nombre] = recibidos[nombre]
            elif "defecto" in cfg:
                finales[nombre] = cfg["defecto"]
            else:
                faltantes.append(nombre)

        if faltantes:
            return {"ok": False, "query_id": query_id,
                    "mensaje": f"Faltan parámetros sin valor por defecto: "
                               f"{', '.join(faltantes)}."}

        try:
            driver = await self._driver_de(consulta.db_id)
            resultado: ResultadoConsulta = await driver.query(
                consulta.sql, finales, consulta.limite
            )
        except asyncio.TimeoutError:
            return {"ok": False, "query_id": query_id,
                    "mensaje": "La consulta tardó demasiado y se canceló."}
        except KeyError as exc:
            return {"ok": False, "query_id": query_id, "mensaje": str(exc)}
        except Exception as exc:  # noqa: BLE001
            self._errores[consulta.db_id] = str(exc)
            return {"ok": False, "query_id": query_id,
                    "mensaje": f"Error ejecutando la consulta: {exc}"}

        salida = {"ok": True, "query_id": query_id, "db_id": consulta.db_id,
                  "parametros": finales}
        salida.update(resultado.to_dict())
        return salida

    async def probar_sql(
        self,
        db_id: str,
        sql: str,
        parametros: Optional[Dict[str, Any]] = None,
        limite: int = 50,
    ) -> dict:
        """
        Ejecuta un SQL suelto SIN guardarlo. Es para el modo Diseñador:
        permite previsualizar el resultado antes de registrar la consulta.

        Pasa por la misma validación de solo-lectura, así que tampoco desde
        aquí se puede modificar la base de datos.
        """
        try:
            validar_sql_lectura(sql)
            driver = await self._driver_de(db_id)
            resultado = await driver.query(sql, parametros or {}, limite)
        except ValueError as exc:
            return {"ok": False, "mensaje": str(exc)}
        except KeyError as exc:
            return {"ok": False, "mensaje": str(exc)}
        except Exception as exc:  # noqa: BLE001
            return {"ok": False, "mensaje": f"Error: {exc}"}

        salida = {"ok": True, "db_id": db_id}
        salida.update(resultado.to_dict())
        return salida

    # ================================================================== #
    # Introspección (ayuda al diseñador)
    # ================================================================== #
    async def tablas(self, db_id: str) -> dict:
        try:
            driver = await self._driver_de(db_id)
            return {"ok": True, "db_id": db_id, "tablas": await driver.listar_tablas()}
        except Exception as exc:  # noqa: BLE001
            return {"ok": False, "mensaje": f"Error: {exc}"}

    async def columnas(self, db_id: str, tabla: str) -> dict:
        try:
            driver = await self._driver_de(db_id)
            return {"ok": True, "db_id": db_id, "tabla": tabla,
                    "columnas": await driver.listar_columnas(tabla)}
        except Exception as exc:  # noqa: BLE001
            return {"ok": False, "mensaje": f"Error: {exc}"}

    def health(self) -> dict:
        """Estado agregado, para GET /health."""
        conexiones = self.listar_conexiones()
        return {
            "num_conexiones": len(conexiones),
            "conectadas": sum(1 for c in conexiones if c["conectado"]),
            "num_consultas": len(self._store.consultas),
            "conexiones": conexiones,
        }
