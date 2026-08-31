# -*- coding: utf-8 -*-
"""
crud_manager.py
===============
CRUD genérico sobre las tablas del esquema del HMI (`alarmas`, `recetas`).

**El problema y cómo se resuelve.** Un CRUD genérico es un agujero de seguridad
esperando a ocurrir: si el cliente puede decir "tabla X, columna Y", puede leer
o escribir cualquier cosa. Aquí NO se acepta nada del cliente que acabe en el
texto del SQL:

  * La **tabla** sale de un diccionario cerrado (`RECURSOS`), no del cliente.
  * Las **columnas** salen de la definición de ese recurso; cualquier campo
    que llegue y no esté declarado se descarta en silencio.
  * Los **valores** van siempre bindeados (`:param`), nunca concatenados.
  * El **orden** solo puede ser por una columna declarada, y ASC/DESC.

Con eso, la superficie de ataque es cero por construcción: no hay ninguna ruta
por la que un texto del usuario llegue a interpretarse como SQL.

**Por qué no hay CRUD de `usuarios` aquí.** Ya existe en `/auth`, y con razón:
crear un usuario no es un INSERT, es hashear una contraseña, validar el rol y
comprobar permisos. Exponerlo como CRUD genérico permitiría escribir
directamente en `password_hash`.

**Por qué `plc_prg` es de solo lectura.** Esa tabla la escribe el historizador
por lotes. Dejar insertar filas a mano corrompería el histórico con datos que
no vinieron del PLC.
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

from app.db.sql_driver import _nombre_seguro, ts_para_motor

logger = logging.getLogger("crud_manager")

# Tope de filas por página: protege al navegador y a la BD.
MAX_LIMITE = 500


# ====================================================================== #
# Qué hay que hacer ANTES de borrar una fila
# ====================================================================== #
# Ninguna clave foránea del esquema lleva `ON DELETE` — ver la nota larga en
# `SqlDriver.ddl_esquema_hmi()`. Resumido: SQL Server rechaza el esquema
# entero (Msg 1785) en cuanto una tabla es alcanzable por dos caminos en
# cascada, y aquí lo es por diseño: un `receta_valor` depende a la vez del
# registro y del elemento.
#
# Lo que el motor no hace, lo hace esto: por cada recurso, las sentencias que
# dejan el terreno limpio antes del DELETE, EN ORDEN. Es el mismo efecto que
# tenían las cascadas, con dos ventajas — funciona igual en los cuatro
# motores, y está escrito donde se puede leer.
#
# Los nombres de tabla se sustituyen desde `_tablas_hmi()`, que aplica el
# prefijo del esquema y valida el identificador. Del cliente solo llega `:id`,
# bindeado.
TABLAS_HMI: Tuple[str, ...] = (
    "usuarios", "plc_prg", "alarmas_def", "alarmas", "recetas",
    "receta_elementos", "receta_registros", "receta_valores",
)

DEPENDENCIAS: Dict[str, Tuple[str, ...]] = {
    # Borrar a una persona no puede borrar lo que hizo: se pierde el "quién",
    # nunca el registro. Es lo que hacía `ON DELETE SET NULL`.
    #
    # Hoy no se llega aquí: `usuarios` no está en `RECURSOS` y la API no
    # ofrece borrar cuentas (se desactivan con PATCH /auth/usuarios). Se deja
    # escrito porque el día que ese borrado exista, el fallo sería silencioso
    # y del peor tipo: perder el historial de alarmas de un turno entero por
    # dar de baja a quien lo reconoció.
    "usuarios": (
        "UPDATE {alarmas} SET usuario_id = NULL WHERE usuario_id = :id",
        "UPDATE {recetas} SET usuario_id = NULL WHERE usuario_id = :id",
        "UPDATE {receta_registros} SET usuario_id = NULL WHERE usuario_id = :id",
    ),
    # Quitar una regla de alarma no borra los eventos que ya provocó: el
    # historial es justo lo que se quiere conservar.
    "alarmas_def": (
        "UPDATE {alarmas} SET alarma_def_id = NULL WHERE alarma_def_id = :id",
    ),
    # Una receta sí se lleva todo lo suyo, de abajo arriba: primero los
    # valores (que dependen de dos padres), luego registros y elementos.
    "recetas": (
        "DELETE FROM {receta_valores} WHERE receta_registro_id IN "
        "(SELECT id FROM {receta_registros} WHERE receta_id = :id)",
        "DELETE FROM {receta_valores} WHERE receta_elemento_id IN "
        "(SELECT id FROM {receta_elementos} WHERE receta_id = :id)",
        "DELETE FROM {receta_registros} WHERE receta_id = :id",
        "DELETE FROM {receta_elementos} WHERE receta_id = :id",
    ),
    "receta_elementos": (
        "DELETE FROM {receta_valores} WHERE receta_elemento_id = :id",
    ),
    "receta_registros": (
        "DELETE FROM {receta_valores} WHERE receta_registro_id = :id",
    ),
}


class Recurso:
    """Definición de una tabla expuesta por el CRUD."""

    def __init__(
        self,
        tabla: str,
        columnas: Dict[str, str],
        obligatorias: List[str],
        filtros: List[str],
        orden_defecto: str = "id",
        solo_lectura: bool = False,
        marca_creado: str = "",
        marca_actualizado: str = "",
    ) -> None:
        self.tabla = tabla
        # nombre -> tipo lógico: texto | numero | entero | fecha
        self.columnas = columnas
        self.obligatorias = obligatorias
        self.filtros = filtros
        self.orden_defecto = orden_defecto
        self.solo_lectura = solo_lectura
        # Columnas de fecha que rellena el servidor, no el cliente.
        self.marca_creado = marca_creado
        self.marca_actualizado = marca_actualizado

    def editables(self) -> List[str]:
        """Columnas que el cliente puede escribir (nunca `id` ni las marcas)."""
        prohibidas = {"id", self.marca_creado, self.marca_actualizado}
        return [c for c in self.columnas if c not in prohibidas]


# ====================================================================== #
# Catálogo cerrado de recursos
# ====================================================================== #
# Las cinco clases de alarma de TIA Portal, de más a menos grave. Se guardan
# con su nombre en inglés porque es como aparecen en TIA y en el editor de la
# vista: traducirlas aquí obligaría a traducir de vuelta al comparar.
CLASES_ALARMA = ("Critical", "Error", "Warning", "Maintenance", "Information")

# Cómo se evalúa una alarma. 'bit' es la discreta de TIA (mira un bit del
# tag); las demás son analógicas y comparan contra `valor_limite`.
COMPARADORES = ("bit", ">", ">=", "<", "<=", "==", "!=")


RECURSOS: Dict[str, Recurso] = {
    # ------------------------------------------------------------------ #
    # alarmas_def · la CONFIGURACIÓN: qué se vigila
    # ------------------------------------------------------------------ #
    # Esto es lo que edita una persona, y lo que el editor de alarmas de la
    # vista ha estado enseñando sin tener dónde guardarlo. Es el equivalente
    # a la tabla "Discrete alarms" de TIA Portal.
    "alarmas_def": Recurso(
        tabla="alarmas_def",
        columnas={
            "id": "entero",
            "nombre": "texto",
            "texto": "texto",
            "clase": "texto",
            "tag": "texto",
            "bit_disparo": "entero",
            "comparador": "texto",
            "valor_limite": "numero",
            "banda_muerta": "numero",
            "tag_reconocimiento": "texto",
            "bit_reconocimiento": "entero",
            "area": "texto",
            "activo": "entero",
            "creado_en": "fecha",
            "actualizado_en": "fecha",
        },
        obligatorias=["nombre", "texto"],
        filtros=["clase", "tag", "area", "activo", "comparador"],
        orden_defecto="id",
        marca_creado="creado_en",
        marca_actualizado="actualizado_en",
    ),
    # ------------------------------------------------------------------ #
    # alarmas · los EVENTOS: qué pasó y cuándo
    # ------------------------------------------------------------------ #
    "alarmas": Recurso(
        tabla="alarmas",
        columnas={
            "id": "entero",
            "alarma_def_id": "entero",
            "plc_prg_id": "entero",
            "usuario_id": "entero",
            "tipo": "texto",
            "area": "texto",
            "severidad": "entero",
            "mensaje": "texto",
            "tag": "texto",
            "valor_disparo": "numero",
            "estado": "texto",
            "ts_activacion": "fecha",
            "ts_reconocimiento": "fecha",
            "ts_normalizacion": "fecha",
        },
        obligatorias=["mensaje"],
        filtros=["estado", "tipo", "area", "severidad", "tag", "usuario_id",
                 "plc_prg_id", "alarma_def_id"],
        orden_defecto="ts_activacion",
        marca_creado="ts_activacion",
    ),
    # ------------------------------------------------------------------ #
    # RECETAS · tres niveles, como en TIA Portal
    # ------------------------------------------------------------------ #
    #   recetas            "Recipe_1"            la receta
    #   receta_elementos   limon, azucar, pisco  sus columnas
    #   receta_registros   "Mezcla del lunes"    una mezcla concreta
    #   receta_valores     30 ml, 20 g, 60 ml    sus valores
    "recetas": Recurso(
        tabla="recetas",
        columnas={
            "id": "entero",
            "usuario_id": "entero",
            "nombre": "texto",
            "nombre_visible": "texto",
            "numero": "entero",
            "version": "texto",
            "ruta": "texto",
            "tipo": "texto",
            "max_registros": "entero",
            "tipo_comunicacion": "texto",
            "comprobar_limites": "entero",
            "informacion_herramienta": "texto",
            "activo": "entero",
            "creado_en": "fecha",
            "actualizado_en": "fecha",
        },
        obligatorias=["nombre"],
        filtros=["nombre", "numero", "tipo", "activo", "usuario_id"],
        orden_defecto="numero",
        marca_creado="creado_en",
        marca_actualizado="actualizado_en",
    ),
    "receta_elementos": Recurso(
        tabla="receta_elementos",
        columnas={
            "id": "entero",
            "receta_id": "entero",
            "plc_prg_id": "entero",
            "nombre": "texto",
            "nombre_visible": "texto",
            "tag": "texto",
            "tipo_dato": "texto",
            "longitud_dato": "entero",
            "valor_default": "numero",
            "valor_minimo": "numero",
            "valor_maximo": "numero",
            "valor_texto": "texto",
            "lugar_decimal": "entero",
            "decimales": "entero",
            "unidad": "texto",
            "informacion_herramienta": "texto",
            "orden": "entero",
            "activo": "entero",
            "creado_en": "fecha",
            "actualizado_en": "fecha",
        },
        obligatorias=["receta_id", "nombre"],
        filtros=["receta_id", "tag", "tipo_dato", "activo", "plc_prg_id"],
        orden_defecto="orden",
        marca_creado="creado_en",
        marca_actualizado="actualizado_en",
    ),
    "receta_registros": Recurso(
        tabla="receta_registros",
        columnas={
            "id": "entero",
            "receta_id": "entero",
            "usuario_id": "entero",
            "nombre": "texto",
            "nombre_visible": "texto",
            "numero": "entero",
            "comentario": "texto",
            "ts_ultima_carga": "fecha",
            "activo": "entero",
            "creado_en": "fecha",
            "actualizado_en": "fecha",
        },
        obligatorias=["receta_id", "nombre"],
        filtros=["receta_id", "numero", "activo", "usuario_id"],
        orden_defecto="numero",
        marca_creado="creado_en",
        marca_actualizado="actualizado_en",
    ),
    "receta_valores": Recurso(
        tabla="receta_valores",
        columnas={
            "id": "entero",
            "receta_registro_id": "entero",
            "receta_elemento_id": "entero",
            "valor_num": "numero",
            "valor_texto": "texto",
        },
        obligatorias=["receta_registro_id", "receta_elemento_id"],
        filtros=["receta_registro_id", "receta_elemento_id"],
        orden_defecto="id",
    ),
    # Solo lectura: la escribe el historizador, no las personas.
    "plc_prg": Recurso(
        tabla="plc_prg",
        columnas={
            "id": "entero", "ts": "fecha", "plc_id": "texto",
            "programa": "texto", "tag": "texto", "valor_num": "numero",
            "valor_texto": "texto", "tipo": "texto",
        },
        obligatorias=[],
        filtros=["plc_id", "tag", "programa", "tipo"],
        orden_defecto="ts",
        solo_lectura=True,
    ),
}


class ErrorCrud(Exception):
    """Error de validación, con código HTTP y mensaje ya legible."""

    def __init__(self, mensaje: str, codigo: int = 400) -> None:
        super().__init__(mensaje)
        self.mensaje = mensaje
        self.codigo = codigo


class CrudManager:
    """Ejecuta el CRUD contra la conexión de BD que se indique."""

    def __init__(self, db_manager, settings) -> None:
        self._db = db_manager
        self._s = settings

    # ------------------------------------------------------------------ #
    def _recurso(self, nombre: str) -> Recurso:
        r = RECURSOS.get((nombre or "").strip().lower())
        if r is None:
            raise ErrorCrud(
                f"Recurso '{nombre}' no válido. Opciones: "
                f"{', '.join(sorted(RECURSOS))}.", 404)
        return r

    def _db_id(self, db_id: Optional[str]) -> str:
        """
        Conexión a usar. Si no se indica, la configurada para el esquema del
        HMI; si tampoco, la primera dada de alta.
        """
        if db_id:
            return db_id
        preferida = getattr(self._s, "auth_db_id", "") or ""
        if preferida:
            return preferida
        conexiones = self._db.listar_conexiones()
        if not conexiones:
            raise ErrorCrud(
                "No hay ninguna conexión a base de datos dada de alta. "
                "Créala primero con POST /db.", 409)
        return conexiones[0]["db_id"]

    def _tabla(self, recurso: Recurso) -> str:
        """Nombre real de la tabla, con el prefijo del esquema si lo hay."""
        prefijo = getattr(self._s, "esquema_prefijo", "") or ""
        return _nombre_seguro(f"{prefijo}{recurso.tabla}")

    def _tablas_hmi(self) -> Dict[str, str]:
        """Nombres reales de las tablas del esquema, con prefijo y validados."""
        prefijo = getattr(self._s, "esquema_prefijo", "") or ""
        return {n: _nombre_seguro(f"{prefijo}{n}") for n in TABLAS_HMI}

    async def _driver(self, db_id: Optional[str]):
        try:
            return await self._db._driver_de(self._db_id(db_id))
        except ErrorCrud:
            raise
        except Exception as exc:  # noqa: BLE001
            raise ErrorCrud(f"No se pudo abrir la conexión: {exc}", 503)

    # ------------------------------------------------------------------ #
    def _convertir(self, recurso: Recurso, campo: str, valor: Any,
                   motor: str) -> Any:
        """Adapta el valor al tipo declarado. Lanza si no encaja."""
        tipo = recurso.columnas.get(campo, "texto")
        if valor is None:
            return None
        try:
            if tipo == "entero":
                if isinstance(valor, bool):
                    return 1 if valor else 0
                return int(valor)
            if tipo == "numero":
                if isinstance(valor, bool):
                    return 1.0 if valor else 0.0
                return float(valor)
            if tipo == "fecha":
                return ts_para_motor(valor, motor)
            return str(valor)
        except (TypeError, ValueError):
            raise ErrorCrud(
                f"El campo '{campo}' esperaba un valor de tipo {tipo} y llegó "
                f"'{valor}'.")

    @staticmethod
    def _ahora(motor: str) -> Any:
        return ts_para_motor(datetime.now(timezone.utc), motor)

    # ================================================================== #
    # Listar
    # ================================================================== #
    async def listar(
        self,
        recurso_nombre: str,
        db_id: Optional[str] = None,
        filtros: Optional[Dict[str, Any]] = None,
        desde: Optional[str] = None,
        hasta: Optional[str] = None,
        orden: Optional[str] = None,
        descendente: bool = True,
        limite: int = 100,
        offset: int = 0,
    ) -> dict:
        """Lista con filtros por columna declarada, rango de fechas y página."""
        recurso = self._recurso(recurso_nombre)
        driver = await self._driver(db_id)
        tabla = self._tabla(recurso)
        limite = max(1, min(int(limite), MAX_LIMITE))
        offset = max(0, int(offset))

        condiciones: List[str] = []
        parametros: Dict[str, Any] = {}

        for campo, valor in (filtros or {}).items():
            if valor is None or campo not in recurso.filtros:
                continue                    # campo no declarado: se ignora
            condiciones.append(f"{campo} = :f_{campo}")
            parametros[f"f_{campo}"] = self._convertir(
                recurso, campo, valor, driver.motor)

        # El rango de fechas se aplica sobre la columna temporal del recurso.
        col_fecha = recurso.marca_creado or recurso.orden_defecto
        if desde and recurso.columnas.get(col_fecha) == "fecha":
            condiciones.append(f"{col_fecha} >= :desde")
            parametros["desde"] = ts_para_motor(desde, driver.motor)
        if hasta and recurso.columnas.get(col_fecha) == "fecha":
            condiciones.append(f"{col_fecha} <= :hasta")
            parametros["hasta"] = ts_para_motor(hasta, driver.motor)

        where = (" WHERE " + " AND ".join(condiciones)) if condiciones else ""

        # El ORDER BY no se puede bindear: se valida contra las columnas.
        col_orden = orden if orden in recurso.columnas else recurso.orden_defecto
        direccion = "DESC" if descendente else "ASC"

        columnas = ", ".join(recurso.columnas)
        # Paginación portable: SQL Server necesita OFFSET/FETCH y ORDER BY.
        if driver.motor == "mssql":
            sql = (f"SELECT {columnas} FROM {tabla}{where} "
                   f"ORDER BY {col_orden} {direccion} "
                   f"OFFSET {offset} ROWS FETCH NEXT {limite} ROWS ONLY")
        else:
            sql = (f"SELECT {columnas} FROM {tabla}{where} "
                   f"ORDER BY {col_orden} {direccion} "
                   f"LIMIT {limite} OFFSET {offset}")

        try:
            resultado = await driver.query(sql, parametros, limite)
            total = await self._contar(driver, tabla, where, parametros)
        except Exception as exc:  # noqa: BLE001
            raise self._traducir(exc, tabla)

        salida = {"ok": True, "recurso": recurso_nombre, "tabla": tabla,
                  "total": total, "limite": limite, "offset": offset}
        salida.update(resultado.to_dict())
        return salida

    async def _contar(self, driver, tabla: str, where: str,
                      parametros: dict) -> int:
        try:
            r = await driver.query(
                f"SELECT COUNT(*) AS n FROM {tabla}{where}", parametros, 1)
            return int(r.filas[0]["n"]) if r.filas else 0
        except Exception:  # noqa: BLE001
            return -1               # no es crítico: -1 = desconocido

    # ================================================================== #
    # Obtener uno
    # ================================================================== #
    async def obtener(self, recurso_nombre: str, id_: int,
                      db_id: Optional[str] = None) -> dict:
        recurso = self._recurso(recurso_nombre)
        driver = await self._driver(db_id)
        tabla = self._tabla(recurso)
        columnas = ", ".join(recurso.columnas)

        try:
            r = await driver.query(
                f"SELECT {columnas} FROM {tabla} WHERE id = :id", {"id": id_}, 1)
        except Exception as exc:  # noqa: BLE001
            raise self._traducir(exc, tabla)

        if not r.filas:
            raise ErrorCrud(f"No existe {recurso_nombre} con id {id_}.", 404)
        return {"ok": True, "recurso": recurso_nombre, "fila": r.filas[0]}

    # ================================================================== #
    # Autoría: quién hizo cada escritura
    # ================================================================== #
    # Columna que enlaza una fila con la persona que la creó o la tocó.
    # La tienen `alarmas` (quién la reconoció), `recetas` y
    # `receta_registros` (quién la editó).
    COLUMNA_AUTOR = "usuario_id"

    @staticmethod
    def _sellar_autor(
        recurso, datos: Dict[str, Any], usuario_id: Optional[int]
    ) -> Dict[str, Any]:
        """
        Rellena `usuario_id` con el de la SESIÓN y descarta el que venga del
        cliente.

        **Esto es una barrera de seguridad, no una comodidad.** Antes el
        cuerpo de la petición traía `usuario_id` y se insertaba tal cual: un
        operario podía reconocer una alarma poniendo `usuario_id: 1` y el
        histórico diría que la reconoció el supervisor. Firmar una acción con
        la identidad de otro es exactamente lo que una trazabilidad de planta
        tiene que impedir.

        La regla es simple: **la identidad no se pide, se deduce del token**.
        El cliente ya no tiene voz en esto; lo que mande en ese campo se
        ignora en silencio (no se rechaza la petición: la vista puede seguir
        mandándolo por costumbre sin que nada se rompa).

        Si el recurso no tiene esa columna, no se toca nada. Si no hay sesión
        (instalación sin autenticación), tampoco: la columna admite NULL y
        eso es más honesto que inventarse un autor.
        """
        columnas = getattr(recurso, "columnas", None) or {}
        if CrudManager.COLUMNA_AUTOR not in columnas:
            return datos

        salida = dict(datos or {})
        # Fuera lo que haya mandado el cliente, siempre.
        salida.pop(CrudManager.COLUMNA_AUTOR, None)
        if usuario_id:
            salida[CrudManager.COLUMNA_AUTOR] = int(usuario_id)
        return salida

    # ================================================================== #
    # Crear
    # ================================================================== #
    async def crear(self, recurso_nombre: str, datos: Dict[str, Any],
                    db_id: Optional[str] = None,
                    usuario_id: Optional[int] = None) -> dict:
        recurso = self._recurso(recurso_nombre)
        if recurso.solo_lectura:
            raise ErrorCrud(
                f"'{recurso_nombre}' es de solo lectura: la escribe el "
                f"historizador a partir de los datos del PLC.", 405)

        datos = self._sellar_autor(recurso, datos, usuario_id)

        driver = await self._driver(db_id)
        tabla = self._tabla(recurso)

        valores: Dict[str, Any] = {}
        for campo in recurso.editables():
            if campo in datos:
                valores[campo] = self._convertir(
                    recurso, campo, datos[campo], driver.motor)

        faltan = [c for c in recurso.obligatorias if not valores.get(c)]
        if faltan:
            raise ErrorCrud(
                f"Faltan campos obligatorios: {', '.join(faltan)}.")

        self._validar_reglas(recurso_nombre, valores)

        ahora = self._ahora(driver.motor)
        if recurso.marca_creado:
            valores[recurso.marca_creado] = ahora
        if recurso.marca_actualizado:
            valores[recurso.marca_actualizado] = ahora

        try:
            nuevo_id = await driver.insertar(tabla, valores)
        except Exception as exc:  # noqa: BLE001
            raise self._traducir(exc, tabla)

        # Un id 0 no es un id: significa que la fila se creó pero no se pudo
        # leer cuál es. Devolverlo tal cual es peor que fallar — la vista se
        # queda con un objeto que apunta a la nada, y el error real aparece
        # tres pasos después, disfrazado ("Faltan campos obligatorios:
        # receta_id"). Se dice aquí, donde todavía se entiende.
        if not nuevo_id:
            logger.error("INSERT en '%s' sin id devuelto (motor %s).",
                         tabla, driver.motor)
            raise ErrorCrud(
                f"La fila se creó en '{tabla}', pero el servidor no devolvió "
                f"su identificador, así que no se puede seguir trabajando con "
                f"ella. Actualiza la vista para verla.", 500)

        # La fila COMPLETA, no solo el id. La tabla tiene columnas con valor
        # por defecto (`activo`, `tipo`, `max_registros`, las marcas de
        # tiempo) y quien acaba de crear la fila no las conoce: sin esto la
        # vista pinta una fila a medias y la corrige sola en el siguiente
        # refresco, que es justo el parpadeo que se nota.
        fila: Dict[str, Any] = {}
        if nuevo_id:
            try:
                fila = (await self.obtener(recurso_nombre, nuevo_id, db_id))["fila"]
            except Exception:  # noqa: BLE001
                fila = {}

        logger.info("CRUD: creado %s id=%s en %s", recurso_nombre, nuevo_id, tabla)
        return {"ok": True, "recurso": recurso_nombre, "tabla": tabla,
                "id": nuevo_id, "fila": fila,
                "mensaje": f"{recurso_nombre.rstrip('s').capitalize()} creado."}

    # ================================================================== #
    # Actualizar
    # ================================================================== #
    async def actualizar(self, recurso_nombre: str, id_: int,
                         datos: Dict[str, Any],
                         db_id: Optional[str] = None,
                         usuario_id: Optional[int] = None) -> dict:
        recurso = self._recurso(recurso_nombre)
        if recurso.solo_lectura:
            raise ErrorCrud(f"'{recurso_nombre}' es de solo lectura.", 405)

        datos = self._sellar_autor(recurso, datos, usuario_id)

        driver = await self._driver(db_id)
        tabla = self._tabla(recurso)

        valores: Dict[str, Any] = {}
        for campo in recurso.editables():
            if campo in datos:
                valores[campo] = self._convertir(
                    recurso, campo, datos[campo], driver.motor)

        if not valores:
            raise ErrorCrud(
                f"No se indicó ningún campo modificable. Campos válidos: "
                f"{', '.join(recurso.editables())}.")

        # Las reglas se validan contra la fila COMPLETA, no solo contra lo que
        # llega. En un PATCH parcial de una receta puede venir únicamente
        # `valor_default`: sin leer el mínimo y el máximo ya guardados, la
        # comprobación de rango no haría nada y se podría colar un valor fuera
        # de límites en una máquina real. Este fue un bug detectado en pruebas.
        efectivos = dict(valores)
        if self._necesita_fila_completa(recurso_nombre, valores):
            try:
                actual = (await self.obtener(recurso_nombre, id_, db_id))["fila"]
            except ErrorCrud:
                raise
            except Exception:  # noqa: BLE001
                actual = {}
            for campo, valor in actual.items():
                efectivos.setdefault(campo, valor)

        self._validar_reglas(recurso_nombre, efectivos, parcial=True)

        if recurso.marca_actualizado:
            valores[recurso.marca_actualizado] = self._ahora(driver.motor)

        asignaciones = ", ".join(f"{c} = :{c}" for c in valores)
        parametros = dict(valores)
        parametros["id_filtro"] = id_

        try:
            filas = await driver._ejecutar_interno(
                f"UPDATE {tabla} SET {asignaciones} WHERE id = :id_filtro",
                parametros)
        except Exception as exc:  # noqa: BLE001
            raise self._traducir(exc, tabla)

        if filas == 0:
            raise ErrorCrud(f"No existe {recurso_nombre} con id {id_}.", 404)
        return {"ok": True, "recurso": recurso_nombre, "id": id_,
                "campos_actualizados": [c for c in valores],
                "mensaje": f"Actualizado {recurso_nombre} {id_}."}

    # ================================================================== #
    # Borrar
    # ================================================================== #
    async def borrar(self, recurso_nombre: str, id_: int,
                     db_id: Optional[str] = None) -> dict:
        recurso = self._recurso(recurso_nombre)
        if recurso.solo_lectura:
            raise ErrorCrud(
                f"'{recurso_nombre}' es de solo lectura. Para depurar el "
                f"histórico, hazlo con SQL directo y a conciencia.", 405)

        driver = await self._driver(db_id)
        tabla = self._tabla(recurso)

        # Lo que el motor ya no hace por nosotros. No va en una transacción
        # única a propósito: `_ejecutar_interno()` confirma cada sentencia, y
        # si algo se corta a medias el resultado es una fila padre que sigue
        # ahí con menos hijos — repetir el borrado la termina. Lo contrario
        # (padre borrado, hijos huérfanos) sí sería irreparable, y ese orden
        # no puede ocurrir: la padre se borra la última.
        limpieza = DEPENDENCIAS.get((recurso_nombre or "").strip().lower(), ())
        if limpieza:
            nombres = self._tablas_hmi()
            for plantilla in limpieza:
                try:
                    await driver._ejecutar_interno(
                        plantilla.format(**nombres), {"id": id_})
                except Exception as exc:  # noqa: BLE001
                    raise self._traducir(exc, tabla)

        try:
            filas = await driver._ejecutar_interno(
                f"DELETE FROM {tabla} WHERE id = :id", {"id": id_})
        except Exception as exc:  # noqa: BLE001
            raise self._traducir(exc, tabla)

        if filas == 0:
            raise ErrorCrud(f"No existe {recurso_nombre} con id {id_}.", 404)
        logger.info("CRUD: borrado %s id=%s", recurso_nombre, id_)
        return {"ok": True, "recurso": recurso_nombre, "id": id_,
                "mensaje": f"Eliminado {recurso_nombre} {id_}."}

    @staticmethod
    def _necesita_fila_completa(recurso: str, valores: Dict[str, Any]) -> bool:
        """
        ¿Hay que leer la fila guardada para poder validar?

        Solo cuando se tocan campos cuya regla depende de otros campos. Se
        evita así un SELECT extra en cada PATCH que no lo necesite.
        """
        if recurso == "receta_elementos":
            return bool({"valor_default", "valor_minimo", "valor_maximo"}
                        & set(valores))
        return False

    # ================================================================== #
    # Reglas de negocio
    # ================================================================== #
    @staticmethod
    def _validar_reglas(recurso: str, valores: Dict[str, Any],
                        parcial: bool = False) -> None:
        """
        Validaciones que van más allá del tipo de dato.

        La de los elementos de receta es la importante: `valor_minimo <=
        valor_maximo` y el default dentro del rango. Estos números acaban
        escribiéndose en una máquina real; un rango invertido convierte la
        última barrera de seguridad en un adorno.
        """
        if recurso == "receta_elementos":
            mn = valores.get("valor_minimo")
            mx = valores.get("valor_maximo")
            df = valores.get("valor_default")
            if mn is not None and mx is not None and mn > mx:
                raise ErrorCrud(
                    f"valor_minimo ({mn}) no puede ser mayor que valor_maximo "
                    f"({mx}).")
            if df is not None:
                if mn is not None and df < mn:
                    raise ErrorCrud(
                        f"valor_default ({df}) está por debajo del mínimo ({mn}).")
                if mx is not None and df > mx:
                    raise ErrorCrud(
                        f"valor_default ({df}) supera el máximo ({mx}).")

        if recurso == "alarmas_def":
            clase = valores.get("clase")
            if clase and clase not in CLASES_ALARMA:
                raise ErrorCrud(
                    f"clase debe ser una de: {', '.join(CLASES_ALARMA)}. "
                    f"Son las cinco de TIA Portal, en el mismo orden de "
                    f"gravedad.")
            comp = valores.get("comparador")
            if comp and comp not in COMPARADORES:
                raise ErrorCrud(
                    f"comparador debe ser uno de: {', '.join(COMPARADORES)}. "
                    f"'bit' es una alarma discreta (mira un bit del tag); el "
                    f"resto son analógicas y necesitan `valor_limite`.")
            # Una alarma analógica sin límite no puede dispararse nunca: es
            # una regla que parece configurada y no vigila nada.
            if comp and comp != "bit" and valores.get("valor_limite") is None:
                raise ErrorCrud(
                    f"Con comparador '{comp}' hace falta `valor_limite`: sin "
                    f"él la alarma no puede evaluarse y nunca saltaría.")

        if recurso == "alarmas":
            sev = valores.get("severidad")
            if sev is not None and not (1 <= int(sev) <= 5):
                raise ErrorCrud("severidad debe estar entre 1 (crítica) y 5 "
                                "(informativa).")
            estado = valores.get("estado")
            validos = {"activa", "reconocida", "normalizada"}
            if estado and estado not in validos:
                raise ErrorCrud(
                    f"estado debe ser uno de: {', '.join(sorted(validos))}.")

    @staticmethod
    def _traducir(exc: Exception, tabla: str) -> ErrorCrud:
        """Convierte errores del motor en mensajes accionables."""
        texto = str(exc).lower()
        if any(x in texto for x in ("no such table", "doesn't exist",
                                    "does not exist", "invalid object name")):
            return ErrorCrud(
                f"La tabla '{tabla}' no existe. Crea el esquema primero con "
                f"POST /db/{{db_id}}/esquema.", 409)
        if "foreign key" in texto or "reference" in texto:
            return ErrorCrud(
                "Hay una referencia inválida: comprueba que `usuario_id` y "
                "`plc_prg_id` existan en sus tablas.", 409)
        if "unique" in texto or "duplicate" in texto:
            return ErrorCrud("Ya existe un registro con esos datos.", 409)
        return ErrorCrud(f"Error de base de datos: {exc}", 500)

    # ------------------------------------------------------------------ #
    @staticmethod
    def catalogo() -> dict:
        """Recursos disponibles y sus campos (para la vista)."""
        return {
            "recursos": [
                {
                    "recurso": nombre,
                    "tabla": r.tabla,
                    "solo_lectura": r.solo_lectura,
                    "columnas": r.columnas,
                    "obligatorias": r.obligatorias,
                    "filtros": r.filtros,
                    "editables": r.editables(),
                }
                for nombre, r in sorted(RECURSOS.items())
            ]
        }
