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
from app.db.diagnostico import diagnosticar
from app.db.provision import afinar_diagnostico
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
        # db_id -> última revisión CONTRA EL SERVIDOR (no contra el pool).
        #
        # Hay una diferencia que se nota mucho en la vista: `self._drivers`
        # dice si TENEMOS un pool abierto, no si la base sigue estando ahí.
        # Si alguien borra la base en SQL Server, el pool puede seguir
        # marcado como vivo un buen rato y la pantalla enseña "conectada"
        # sobre una base que ya no existe. Esto guarda la última respuesta
        # real del servidor, con su código de diagnóstico.
        self._estados: Dict[str, dict] = {}
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

        Este servicio NO crea tablas: se conecta a una base de datos cuyo
        esquema ya existe. Las tablas se crean con `sql/esquema_hmi_*.sql`,
        ejecutado por un DBA. Es deliberado: una aplicación que puede alterar
        la estructura de la base de datos de producción es una aplicación que
        puede romperla.
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
            # El error crudo del driver no dice qué hacer: `IM002`, `10061` y
            # `18456` son tres problemas completamente distintos y ninguno se
            # explica. Se traduce a algo accionable, SIN perder el original
            # (va en `diagnostico.detalle`).
            diag = diagnosticar(
                exc, motor=motor, host=host, puerto=puerto,
                base_datos=base_datos, opciones=opciones or {},
            )
            # SQL Server manda 18456 y 4060 juntos y no se distinguen leyendo.
            # Una sonda contra `master` con las mismas credenciales lo resuelve.
            diag = await afinar_diagnostico(
                diag, motor=motor, host=host, puerto=puerto,
                base_datos=base_datos, usuario=usuario, password=password,
                opciones=opciones or {},
            )
            return {
                "ok": False, "db_id": db_id,
                "mensaje": f"{diag['titulo']}. {diag['sugerencia']}",
                "diagnostico": diag,
            }
        finally:
            await prueba.disconnect()

        async with self._lock:
            self._store.guardar_conexion(conexion, password)
            await self._abrir(conexion)
            # Acabamos de verificarla arriba con `prueba.test()`: la revisión
            # anterior (que podía decir "esa base no existe") ya no vale.
            self._estados[db_id] = {
                "db_id": db_id, "ok": True, "estado": "ok",
                "titulo": "Responde correctamente.", "sugerencia": "",
                "mensaje": "Conexión verificada al guardarla.",
            }

        logger.info("Conexión '%s' dada de alta (%s).", db_id, motor)
        respuesta = {"ok": True, "db_id": db_id, "motor": motor,
                     "latencia_ms": round(latencia, 1),
                     "mensaje": f"Conexión '{db_id}' verificada y guardada."}

        # Creación opcional del esquema estándar, ya con la conexión guardada.
        # Un fallo aquí NO invalida el alta: la conexión sigue siendo válida y
        # el esquema se puede crear luego con POST /db/{db_id}/esquema.
        return respuesta

    # ================================================================== #
    # Esquema estándar del HMI
    # ================================================================== #
    async def baja_conexion(self, db_id: str) -> dict:
        """Cierra el pool y borra la conexión y sus consultas."""
        async with self._lock:
            driver = self._drivers.pop(db_id, None)
            if driver is not None:
                try:
                    await driver.disconnect()
                except Exception:  # noqa: BLE001
                    pass
            self._estados.pop(db_id, None)
            self._errores.pop(db_id, None)
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
            # Mismo tratamiento que en el alta: el botón "Probar" es justo
            # donde alguien está intentando entender por qué no funciona, así
            # que es donde más falta hace un mensaje que diga qué mirar.
            diag = diagnosticar(
                exc, motor=conexion.motor, host=conexion.host,
                puerto=conexion.puerto, base_datos=conexion.base_datos,
                opciones=conexion.opciones or {},
            )
            diag = await afinar_diagnostico(
                diag, motor=conexion.motor, host=conexion.host,
                puerto=conexion.puerto, base_datos=conexion.base_datos,
                usuario=conexion.usuario,
                password=self._store.password_de(db_id),
                opciones=conexion.opciones or {},
            )
            # El pool que acaba de fallar no sirve para nada y, mientras
            # siga en el diccionario, `listar_conexiones()` lo cuenta como
            # conectado. Se cierra aquí: la próxima consulta lo reabrirá si
            # la base vuelve.
            muerto = self._drivers.pop(db_id, None)
            if muerto is not None:
                try:
                    await muerto.disconnect()
                except Exception:  # noqa: BLE001
                    pass
            self._errores[db_id] = f"{diag['titulo']}. {diag['sugerencia']}"
            return {"ok": False, "db_id": db_id,
                    "mensaje": f"{diag['titulo']}. {diag['sugerencia']}",
                    "diagnostico": diag}

    # ================================================================== #
    # Estado real: preguntarle al servidor, no al pool
    # ================================================================== #
    async def revisar_conexion(self, db_id: str,
                               espera: float = 8.0) -> Dict[str, Any]:
        """
        Comprueba CONTRA EL SERVIDOR en qué estado está esta conexión y
        cachea el resultado.

        Devuelve siempre la misma forma, con `estado` tomado de los códigos
        de `app/db/diagnostico.py`, que son estables y sirven para que la
        vista decida qué ofrecer:

            ok             -> responde; se puede entrar.
            base_no_existe -> el servidor está, la base ya no. (Alguien la
                              borró, o nunca se creó.) Esto es lo que
                              distingue "la borré en SSMS" de "el servidor
                              está apagado", que antes se veían igual.
            sin_servidor / host_desconocido / timeout -> no se llega.
            credenciales / sin_permisos -> se llega, pero no se entra.

        El `espera` está para que una conexión a un servidor remoto apagado
        no deje la pantalla del login colgada: un timeout es una respuesta
        tan válida como cualquier otra.
        """
        if db_id not in self._store.conexiones:
            estado = {"db_id": db_id, "ok": False, "estado": "no_registrada",
                      "titulo": f"No existe la conexión '{db_id}'.",
                      "sugerencia": "Dala de alta antes de usarla.",
                      "mensaje": f"No existe la conexión '{db_id}'."}
            self._estados.pop(db_id, None)
            return estado

        try:
            r = await asyncio.wait_for(self.probar_conexion(db_id), espera)
        except asyncio.TimeoutError:
            estado = {
                "db_id": db_id, "ok": False, "estado": "timeout",
                "titulo": "El servidor no contestó a tiempo.",
                "sugerencia": "Comprueba que está encendido y que el puerto "
                              "está abierto en el cortafuegos.",
                "mensaje": "El servidor no contestó a tiempo.",
            }
            self._errores[db_id] = estado["mensaje"]
            self._estados[db_id] = estado
            return estado
        except Exception as exc:  # noqa: BLE001
            estado = {"db_id": db_id, "ok": False, "estado": "desconocido",
                      "titulo": str(exc), "sugerencia": "",
                      "mensaje": str(exc)}
            self._estados[db_id] = estado
            return estado

        if r.get("ok"):
            estado = {"db_id": db_id, "ok": True, "estado": "ok",
                      "titulo": "Responde correctamente.", "sugerencia": "",
                      "mensaje": r.get("mensaje", "Conexión OK."),
                      "latencia_ms": r.get("latencia_ms")}
        else:
            diag = r.get("diagnostico") or {}
            estado = {
                "db_id": db_id, "ok": False,
                "estado": diag.get("codigo") or "desconocido",
                "titulo": diag.get("titulo") or r.get("mensaje", ""),
                "sugerencia": diag.get("sugerencia", ""),
                "mensaje": r.get("mensaje", ""),
                "diagnostico": diag or None,
            }
        self._estados[db_id] = estado
        return estado

    async def revisar_conexiones(self, espera: float = 8.0) -> List[dict]:
        """Revisa todas a la vez. En paralelo: una caída no frena a las demás."""
        ids = list(self._store.conexiones.keys())
        if not ids:
            return []
        resultados = await asyncio.gather(
            *(self.revisar_conexion(i, espera) for i in ids),
            return_exceptions=True,
        )
        salida = []
        for db_id, r in zip(ids, resultados):
            if isinstance(r, BaseException):
                r = {"db_id": db_id, "ok": False, "estado": "desconocido",
                     "titulo": str(r), "sugerencia": "", "mensaje": str(r)}
                self._estados[db_id] = r
            salida.append(r)
        return salida

    def estado_cacheado(self, db_id: str) -> Dict[str, Any]:
        """Última revisión conocida, sin tocar la red. `{}` si no hay ninguna."""
        return dict(self._estados.get(db_id) or {})

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
            # Lo que dijo el SERVIDOR la última vez que se le preguntó. Manda
            # sobre el pool: si la base ya no existe, da igual que nos quedara
            # un pool abierto — la vista no debe decir "conectada".
            est = self._estados.get(c.db_id)
            if est:
                d["estado"] = est.get("estado", "")
                d["estado_titulo"] = est.get("titulo", "")
                d["estado_sugerencia"] = est.get("sugerencia", "")
                if not est.get("ok"):
                    d["conectado"] = False
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
