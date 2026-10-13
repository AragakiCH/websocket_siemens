# -*- coding: utf-8 -*-
"""
migracion_datos.py
==================
Llevarse los DATOS del esquema del HMI de una base a otra.

QUÉ RESUELVE
------------
La copia de seguridad de `/sistema/datos` se lleva la CONFIGURACIÓN (PLCs,
pantallas, conexiones), pero no lo que vive dentro de la base SQL: las
reglas de alarma, el historial de alarmas, las recetas con sus registros y
el histórico del PLC. Montar un segundo equipo obligaba a rehacer todo eso a
mano, o a mover la base con herramientas del motor —que no sirven si el otro
equipo usa otro motor, y que arrastran también las cuentas.

Esto exporta esas tablas a un `.zip` portable y las importa en cualquier
otra base del HMI, del motor que sea, **re-numerando las claves**.

LO QUE SE LLEVA Y LO QUE NO
---------------------------
  Se llevan   alarmas_def, alarmas, recetas, receta_elementos,
              receta_registros, receta_valores, y opcionalmente plc_prg
              (el histórico, que puede pesar mucho).
  No se lleva `usuarios`. Las cuentas son de cada instalación: el otro
              equipo tiene su propio Supervisor y sus propias contraseñas.
              Las columnas `usuario_id` que apuntan a ellas se importan a
              NULL —se pierde el «quién», nunca el dato—, que es la misma
              decisión que toma `CrudManager` al borrar una cuenta.

POR QUÉ LOS IDS NO SE PUEDEN COPIAR TAL CUAL
--------------------------------------------
Todas las tablas usan un `id` autonumérico, y la base de destino puede tener
ya sus propias filas: la receta 7 de un equipo no tiene nada que ver con la
receta 7 del otro. Así que las filas se insertan SIN id, el motor asigna uno
nuevo, y se guarda el mapa viejo→nuevo para reescribir las claves foráneas de
las tablas que vienen después. El orden de importación es el de dependencia:

    plc_prg → alarmas_def → recetas → receta_elementos → receta_registros
            → alarmas → receta_valores

QUÉ PASA CUANDO EL DESTINO YA TIENE DATOS (modo «fusionar»)
-----------------------------------------------------------
Antes de insertar se busca la fila por su clave NATURAL —lo que la identifica
para una persona, no para el motor— y, si ya está, se reutiliza su id en vez
de duplicarla:

    alarmas_def       nombre + tag
    recetas           nombre
    receta_elementos  receta + nombre
    receta_registros  receta + nombre
    receta_valores    registro + elemento        (si existe, se deja el del destino)
    alarmas           ts_activacion + tag + mensaje  (un evento no se repite)
    plc_prg           ts + plc_id + tag              (una lectura no se repite)

Así importar dos veces el mismo fichero no duplica nada, y mezclar dos
instalaciones que comparten recetas las funde en vez de dejar «Mezcla A» y
«Mezcla A» una al lado de la otra. El modo «añadir» salta esa búsqueda y lo
mete todo como nuevo, para cuando dos máquinas distintas llaman igual a cosas
distintas.

TODO O NADA
-----------
La importación entera va en UNA transacción. Si falla la fila 40.000 del
histórico, la base queda exactamente como estaba: una importación a medias
—recetas sin sus valores, alarmas apuntando a reglas que no entraron— es
peor que ninguna. Por eso no se usa `SqlDriver.insertar()` (que abre su
propia transacción por fila) sino una conexión propia de principio a fin.

`simular=True` recorre todo el camino, con las mismas búsquedas y los mismos
avisos, y al final hace ROLLBACK. Es lo que permite enseñar «se van a crear
12 recetas y reutilizar 3» antes de tocar nada.

FORMATO DEL FICHERO
-------------------
Un `.zip` con `manifiesto.json` y un `<tabla>.jsonl` por tabla (una fila
JSON por línea). JSON Lines y no un JSON gigante por una razón práctica: el
histórico puede tener millones de filas, y así se escribe y se lee de una en
una sin cargarlo entero en memoria. Las fechas van en ISO 8601 con zona,
como las emite `_serializable()`, y al importar pasan por `ts_para_motor()`:
exportar desde SQL Server e importar en PostgreSQL da el mismo instante.
"""
from __future__ import annotations

import json
import logging
import os
import tempfile
import zipfile
from datetime import datetime, timezone
from typing import Any, Dict, Iterable, List, Optional, Set, Tuple

from sqlalchemy import text

from app.db.sql_driver import (
    _nombre_seguro,
    _prefijo_seguro,
    _serializable,
    a_utc,
    ts_para_motor,
)

logger = logging.getLogger("migracion_datos")

VERSION_FORMATO = 1

# Filas por viaje al leer y al insertar en bloque.
PAGINA = 2000


# ====================================================================== #
# Qué se migra, y cómo
# ====================================================================== #
class Tabla:
    """Lo que hay que saber de una tabla para sacarla y volverla a meter."""

    def __init__(
        self,
        nombre: str,
        fks: Dict[str, str],
        fechas: Tuple[str, ...],
        clave_natural: Tuple[str, ...],
        historico: bool = False,
    ) -> None:
        self.nombre = nombre
        # columna -> tabla a la que apunta. Las que apuntan a `usuarios` se
        # ponen a NULL al importar (la tabla no viaja).
        self.fks = fks
        self.fechas = fechas
        # Columnas que identifican la fila para una persona. Las de FK se
        # comparan YA TRADUCIDAS al id del destino.
        self.clave_natural = clave_natural
        # Se puede dejar fuera del fichero (pesa).
        self.historico = historico


# EN ORDEN DE DEPENDENCIA. Importar en este orden garantiza que, cuando una
# fila llega, todas las que referencia ya tienen id nuevo.
TABLAS: Tuple[Tabla, ...] = (
    Tabla("plc_prg", {}, ("ts", "ts_local"), ("ts", "plc_id", "tag"), historico=True),
    Tabla("alarmas_def", {"usuario_id": "usuarios"},
          ("creado_en", "actualizado_en"), ("nombre", "tag")),
    Tabla("recetas", {"usuario_id": "usuarios"},
          ("creado_en", "actualizado_en"), ("nombre",)),
    Tabla("receta_elementos",
          {"receta_id": "recetas", "plc_prg_id": "plc_prg", "usuario_id": "usuarios"},
          ("creado_en", "actualizado_en"), ("receta_id", "nombre")),
    Tabla("receta_registros", {"receta_id": "recetas", "usuario_id": "usuarios"},
          ("ts_ultima_carga", "creado_en", "actualizado_en"), ("receta_id", "nombre")),
    Tabla("alarmas",
          {"alarma_def_id": "alarmas_def", "plc_prg_id": "plc_prg", "usuario_id": "usuarios"},
          ("ts_activacion", "ts_reconocimiento", "ts_normalizacion"),
          ("ts_activacion", "tag", "mensaje")),
    Tabla("receta_valores",
          {"receta_registro_id": "receta_registros",
           "receta_elemento_id": "receta_elementos",
           "usuario_id": "usuarios"},
          (), ("receta_registro_id", "receta_elemento_id")),
)

TABLA_POR_NOMBRE: Dict[str, Tabla] = {t.nombre: t for t in TABLAS}

# Lo que NUNCA viaja, dicho por su nombre para que conste en el manifiesto.
EXCLUIDAS = ("usuarios",)


# ====================================================================== #
# Utilidades
# ====================================================================== #
def _clave_fecha(valor: Any) -> str:
    """Una marca de tiempo como texto comparable, venga de donde venga."""
    dt = a_utc(valor)
    return dt.isoformat(timespec="milliseconds") if dt else ""


def _norm(valor: Any) -> Any:
    """Normaliza un valor para comparar claves naturales."""
    if valor is None:
        return None
    if isinstance(valor, float) and valor.is_integer():
        return int(valor)
    if isinstance(valor, str):
        return valor.strip()
    return valor


def _sql_pagina(motor: str, tabla: str, columnas: List[str], n: int) -> str:
    """`SELECT` de la siguiente página por `id`, con la sintaxis de cada motor."""
    cols = ", ".join(columnas)
    if motor == "mssql":
        return (f"SELECT TOP ({n}) {cols} FROM {tabla} "
                f"WHERE id > :desde ORDER BY id")
    return (f"SELECT {cols} FROM {tabla} WHERE id > :desde "
            f"ORDER BY id LIMIT {n}")


async def _columnas_reales(driver, tabla: str) -> List[str]:
    """Las columnas que ESTA base tiene en `tabla`, o [] si no existe."""
    try:
        return [c["nombre"] for c in await driver.listar_columnas(tabla)]
    except Exception:  # noqa: BLE001
        return []


# ====================================================================== #
# EXPORTAR
# ====================================================================== #
async def exportar(
    driver,
    prefijo: str = "",
    incluir_historico: bool = True,
    origen: Optional[Dict[str, Any]] = None,
) -> Tuple[str, Dict[str, Any]]:
    """
    Escribe el `.zip` en un fichero temporal y devuelve su ruta y el manifiesto.

    Quien llama es responsable de borrar el fichero cuando termine de
    enviarlo. Va a disco y no a memoria por el histórico: un `plc_prg` de un
    año son cientos de MB, y un `BytesIO` de ese tamaño en un servidor de
    planta es lo que tumba el servicio justo cuando se está haciendo la
    copia.
    """
    if driver._engine is None:
        raise RuntimeError("La conexión no está abierta.")
    p = _prefijo_seguro(prefijo)
    motor = driver.motor

    tmp = tempfile.NamedTemporaryFile(prefix="psicore-datos-", suffix=".zip",
                                      delete=False)
    ruta = tmp.name
    tmp.close()

    manifiesto: Dict[str, Any] = {
        "formato": "psicore-datos",
        "version": VERSION_FORMATO,
        "generado_en": datetime.now(timezone.utc).isoformat(),
        "origen": origen or {},
        "motor": motor,
        "prefijo": p,
        "excluye": list(EXCLUIDAS),
        "tablas": {},
    }

    try:
        with zipfile.ZipFile(ruta, "w", zipfile.ZIP_DEFLATED) as z:
            async with driver._engine.connect() as conn:
                for t in TABLAS:
                    if t.historico and not incluir_historico:
                        continue
                    tabla = _nombre_seguro(f"{p}{t.nombre}")
                    columnas = await _columnas_reales(driver, tabla)
                    if not columnas:
                        manifiesto["tablas"][t.nombre] = {
                            "filas": 0, "columnas": [], "ausente": True}
                        continue
                    # `id` siempre primero: es la llave de la paginación y la
                    # que el importador usa para el mapa viejo→nuevo.
                    columnas = ["id"] + [c for c in columnas if c.lower() != "id"]

                    filas = 0
                    desde = 0
                    sql = text(_sql_pagina(motor, tabla, columnas, PAGINA))
                    # El .jsonl se va escribiendo dentro del zip, página a
                    # página, sin pasar por memoria.
                    with z.open(f"{t.nombre}.jsonl", "w") as salida:
                        while True:
                            r = await conn.execute(sql, {"desde": desde})
                            lote = r.fetchall()
                            if not lote:
                                break
                            for fila in lote:
                                doc = {c: _serializable(v)
                                       for c, v in zip(columnas, fila)}
                                salida.write(
                                    (json.dumps(doc, ensure_ascii=False) + "\n")
                                    .encode("utf-8"))
                                filas += 1
                            desde = int(lote[-1][0])
                            if len(lote) < PAGINA:
                                break
                    manifiesto["tablas"][t.nombre] = {
                        "filas": filas, "columnas": columnas}
                    logger.info("Exportadas %d filas de %s.", filas, tabla)

            z.writestr("manifiesto.json",
                       json.dumps(manifiesto, ensure_ascii=False, indent=2))
            z.writestr(
                "_LEEME.txt",
                "Datos del HMI de PsiCore.\n\n"
                "Impórtalo desde Configuración → Sistema → «Migrar datos de la "
                "base», en el equipo de destino. No contiene cuentas de "
                "usuario. Las claves se renumeran al importar, así que sirve "
                "sobre una base que ya tiene datos.\n")
    except Exception:
        try:
            os.unlink(ruta)
        except OSError:
            pass
        raise

    return ruta, manifiesto


# ====================================================================== #
# IMPORTAR
# ====================================================================== #
class InformeTabla:
    def __init__(self, nombre: str) -> None:
        self.nombre = nombre
        self.leidas = 0
        self.insertadas = 0
        self.reutilizadas = 0
        self.omitidas = 0
        self.avisos: List[str] = []

    def aviso(self, texto: str) -> None:
        # Los avisos repetidos no aportan: con 10 ya se entiende el patrón.
        if len(self.avisos) < 10:
            self.avisos.append(texto)
        elif len(self.avisos) == 10:
            self.avisos.append("…")

    def to_dict(self) -> Dict[str, Any]:
        return {
            "tabla": self.nombre, "leidas": self.leidas,
            "insertadas": self.insertadas, "reutilizadas": self.reutilizadas,
            "omitidas": self.omitidas, "avisos": self.avisos,
        }


def leer_manifiesto(ruta_zip: str) -> Dict[str, Any]:
    """Valida que el zip sea nuestro y devuelve su manifiesto."""
    try:
        z = zipfile.ZipFile(ruta_zip)
    except zipfile.BadZipFile:
        raise ValueError("Ese archivo no es un .zip válido.")
    with z:
        if "manifiesto.json" not in z.namelist():
            raise ValueError("Ese zip no es una exportación de datos de "
                             "PsiCore: no trae manifiesto.json.")
        try:
            m = json.loads(z.read("manifiesto.json").decode("utf-8"))
        except Exception as exc:  # noqa: BLE001
            raise ValueError(f"El manifiesto está dañado: {exc}")
    if m.get("formato") != "psicore-datos":
        raise ValueError("Ese zip no es una exportación de datos de PsiCore.")
    if int(m.get("version", 0)) > VERSION_FORMATO:
        raise ValueError(
            f"El fichero es de una versión más nueva del programa "
            f"(formato {m.get('version')}); actualiza este equipo primero.")
    return m


def _iterar_jsonl(z: zipfile.ZipFile, nombre: str) -> Iterable[Dict[str, Any]]:
    with z.open(nombre) as f:
        for linea in f:
            linea = linea.strip()
            if linea:
                yield json.loads(linea)


class _Importador:
    """Estado de UNA importación. Vive lo que dura la transacción."""

    def __init__(self, driver, conn, prefijo: str, modo: str) -> None:
        self.driver = driver
        self.conn = conn
        self.motor = driver.motor
        self.p = _prefijo_seguro(prefijo)
        self.fusionar = modo != "añadir"
        # tabla -> {id_viejo: id_nuevo}
        self.mapas: Dict[str, Dict[int, int]] = {}
        self.informe: Dict[str, InformeTabla] = {}

    # ---- SQL -----------------------------------------------------------
    def tabla(self, base: str) -> str:
        return _nombre_seguro(f"{self.p}{base}")

    async def insertar_con_id(self, tabla: str, valores: Dict[str, Any]) -> int:
        """
        INSERT que devuelve el id, en LA MISMA conexión de la transacción.

        Es la misma receta por motor que `SqlDriver.insertar()` (ver allí por
        qué SQL Server necesita `OUTPUT INSERTED.id`), pero sin abrir una
        transacción propia: aquí todo cuelga del `begin()` de fuera.
        """
        campos = list(valores)
        cols = ", ".join(campos)
        marcas = ", ".join(":" + c for c in campos)
        if self.motor == "postgresql":
            r = await self.conn.execute(
                text(f"INSERT INTO {tabla} ({cols}) VALUES ({marcas}) RETURNING id"),
                valores)
            fila = r.first()
            return int(fila[0]) if fila else 0
        if self.motor == "mssql":
            r = await self.conn.execute(
                text(f"INSERT INTO {tabla} ({cols}) OUTPUT INSERTED.id "
                     f"VALUES ({marcas})"), valores)
            fila = r.first()
            return int(fila[0]) if fila else 0
        await self.conn.execute(
            text(f"INSERT INTO {tabla} ({cols}) VALUES ({marcas})"), valores)
        consulta = ("SELECT LAST_INSERT_ID()" if self.motor == "mysql"
                    else "SELECT last_insert_rowid()")
        r = await self.conn.execute(text(consulta))
        fila = r.first()
        return int(fila[0]) if fila else 0

    async def insertar_lote(self, tabla: str, campos: List[str],
                            filas: List[Dict[str, Any]]) -> None:
        if not filas:
            return
        cols = ", ".join(campos)
        marcas = ", ".join(":" + c for c in campos)
        await self.conn.execute(
            text(f"INSERT INTO {tabla} ({cols}) VALUES ({marcas})"), filas)

    # ---- Claves naturales del destino -----------------------------------
    async def claves_existentes(
        self, t: Tabla, tabla: str, columnas: List[str],
        rango_ts: Optional[Tuple[str, str]] = None,
    ) -> Dict[Tuple[Any, ...], int]:
        """
        clave natural -> id, de lo que YA hay en el destino.

        Para el histórico se acota al rango de fechas que trae el fichero:
        cargar las claves de un año entero para comparar con una semana no
        tiene sentido.
        """
        if not self.fusionar:
            return {}
        cols = [c for c in t.clave_natural if c in columnas]
        if len(cols) != len(t.clave_natural):
            return {}       # al destino le falta una columna de la clave
        sql = f"SELECT id, {', '.join(cols)} FROM {tabla}"
        params: Dict[str, Any] = {}
        if rango_ts and t.historico:
            sql += " WHERE ts >= :a AND ts <= :b"
            params = {"a": ts_para_motor(rango_ts[0], self.motor),
                      "b": ts_para_motor(rango_ts[1], self.motor)}
        r = await self.conn.execute(text(sql), params)
        salida: Dict[Tuple[Any, ...], int] = {}
        for fila in r.fetchall():
            salida[self.clave(t, dict(zip(["id"] + cols, fila)))] = int(fila[0])
        return salida

    def clave(self, t: Tabla, fila: Dict[str, Any]) -> Tuple[Any, ...]:
        """La clave natural de una fila, con fechas normalizadas."""
        partes: List[Any] = []
        for c in t.clave_natural:
            v = fila.get(c)
            partes.append(_clave_fecha(v) if c in t.fechas else _norm(v))
        return tuple(partes)

    # ---- Una tabla ---------------------------------------------------------
    async def importar_tabla(self, t: Tabla, z: zipfile.ZipFile,
                             referenciados: Set[int]) -> None:
        inf = InformeTabla(t.nombre)
        self.informe[t.nombre] = inf
        mapa: Dict[int, int] = {}
        self.mapas[t.nombre] = mapa

        fichero = f"{t.nombre}.jsonl"
        if fichero not in z.namelist():
            inf.aviso("No viene en el fichero.")
            return

        tabla = self.tabla(t.nombre)
        reales = await _columnas_reales(self.driver, tabla)
        if not reales:
            inf.aviso(f"La tabla {tabla} no existe en el destino. Crea el "
                      f"esquema primero (Bases de datos → Crear esquema).")
            return
        reales_lc = {c.lower(): c for c in reales}

        # Rango de fechas del histórico, para acotar la búsqueda de repetidas.
        rango: Optional[Tuple[str, str]] = None
        if t.historico and self.fusionar:
            lo = hi = ""
            for doc in _iterar_jsonl(z, fichero):
                k = _clave_fecha(doc.get("ts"))
                if not k:
                    continue
                lo = k if not lo or k < lo else lo
                hi = k if not hi or k > hi else hi
            if lo:
                rango = (lo, hi)

        existentes = await self.claves_existentes(t, tabla, reales, rango)
        descartadas: Set[str] = set()
        lote: List[Dict[str, Any]] = []
        campos_lote: Optional[List[str]] = None

        for doc in _iterar_jsonl(z, fichero):
            inf.leidas += 1
            try:
                id_viejo = int(doc.get("id"))
            except (TypeError, ValueError):
                inf.omitidas += 1
                inf.aviso("Fila sin id; se omite.")
                continue

            # 1 · Traducir claves foráneas y quitar lo que no viaja.
            fila: Dict[str, Any] = {}
            saltar = False
            for col, v in doc.items():
                if col.lower() == "id":
                    continue
                if col not in reales_lc:
                    if col not in descartadas:
                        descartadas.add(col)
                        inf.aviso(f"El destino no tiene la columna '{col}'; "
                                  f"se descarta en todas las filas.")
                    continue
                col_real = reales_lc[col.lower()]
                if col in t.fks:
                    destino = t.fks[col]
                    if destino in EXCLUIDAS or v is None:
                        fila[col_real] = None
                        continue
                    nuevo = self.mapas.get(destino, {}).get(int(v))
                    if nuevo is None:
                        # El padre no entró (no venía, o se omitió). Una FK
                        # obligatoria sin padre no puede entrar; una opcional
                        # entra a NULL con aviso.
                        obligatoria = col in ("receta_id", "receta_registro_id",
                                              "receta_elemento_id")
                        if obligatoria:
                            saltar = True
                            inf.aviso(f"Fila {id_viejo}: su {col}={v} no está "
                                      f"en el destino; se omite.")
                            break
                        fila[col_real] = None
                        continue
                    fila[col_real] = nuevo
                elif col in t.fechas:
                    fila[col_real] = ts_para_motor(v, self.motor) if v else None
                else:
                    fila[col_real] = v
            if saltar:
                inf.omitidas += 1
                continue

            # 2 · ¿Ya está? (clave natural, con las FK ya traducidas)
            k = self.clave(t, fila) if self.fusionar else None
            if k is not None and all(x is not None for x in k) and k in existentes:
                mapa[id_viejo] = existentes[k]
                inf.reutilizadas += 1
                continue

            # 3 · Insertar. El histórico va en bloque salvo las filas que
            #     alguien referencia (hace falta su id nuevo).
            if t.historico and id_viejo not in referenciados:
                if campos_lote is None:
                    campos_lote = list(fila)
                if list(fila) != campos_lote:
                    await self.insertar_lote(tabla, campos_lote, lote)
                    lote = []
                    campos_lote = list(fila)
                lote.append(fila)
                inf.insertadas += 1
                if len(lote) >= PAGINA:
                    await self.insertar_lote(tabla, campos_lote, lote)
                    lote = []
                if k is not None:
                    existentes[k] = -1   # para no repetirla dentro del mismo fichero
                continue

            nuevo = await self.insertar_con_id(tabla, fila)
            mapa[id_viejo] = nuevo
            inf.insertadas += 1
            if k is not None:
                existentes[k] = nuevo

        if lote and campos_lote:
            await self.insertar_lote(tabla, campos_lote, lote)


def _ids_referenciados(z: zipfile.ZipFile, tabla_destino: str) -> Set[int]:
    """
    Qué ids de `tabla_destino` apuntan desde otras tablas del fichero.

    Solo se usa para el histórico: esas filas se insertan una a una para
    conocer su id nuevo; el resto va en bloque.
    """
    ids: Set[int] = set()
    for t in TABLAS:
        cols = [c for c, d in t.fks.items() if d == tabla_destino]
        if not cols or f"{t.nombre}.jsonl" not in z.namelist():
            continue
        for doc in _iterar_jsonl(z, f"{t.nombre}.jsonl"):
            for c in cols:
                v = doc.get(c)
                if v is not None:
                    try:
                        ids.add(int(v))
                    except (TypeError, ValueError):
                        pass
    return ids


async def importar(
    driver,
    ruta_zip: str,
    prefijo: str = "",
    modo: str = "fusionar",
    simular: bool = False,
    incluir_historico: bool = True,
) -> Dict[str, Any]:
    """
    Mete en `driver` lo que trae el zip. Devuelve el informe por tabla.

    Con `simular=True` hace todo el recorrido y termina en ROLLBACK: el
    informe es exactamente el que daría la importación real.
    """
    if driver._engine is None:
        raise RuntimeError("La conexión no está abierta.")
    manifiesto = leer_manifiesto(ruta_zip)
    modo = "añadir" if (modo or "").strip().lower() in ("añadir", "anadir", "add") else "fusionar"

    with zipfile.ZipFile(ruta_zip) as z:
        referenciados_plc = _ids_referenciados(z, "plc_prg")

        async with driver._engine.connect() as conn:
            trans = await conn.begin()
            imp = _Importador(driver, conn, prefijo, modo)
            try:
                for t in TABLAS:
                    if t.historico and not incluir_historico:
                        inf = InformeTabla(t.nombre)
                        inf.aviso("No se importa el histórico (se pidió así).")
                        imp.informe[t.nombre] = inf
                        imp.mapas[t.nombre] = {}
                        continue
                    await imp.importar_tabla(
                        t, z, referenciados_plc if t.nombre == "plc_prg" else set())
                if simular:
                    await trans.rollback()
                else:
                    await trans.commit()
            except Exception:
                await trans.rollback()
                raise

    tablas = [imp.informe[t.nombre].to_dict() for t in TABLAS if t.nombre in imp.informe]
    total_ins = sum(x["insertadas"] for x in tablas)
    total_reu = sum(x["reutilizadas"] for x in tablas)
    total_omi = sum(x["omitidas"] for x in tablas)
    verbo = "Se crearían" if simular else "Se crearon"
    mensaje = (f"{verbo} {total_ins} fila(s); {total_reu} ya existían y se "
               f"reutilizaron; {total_omi} omitidas.")
    return {
        "ok": True,
        "simulado": simular,
        "modo": modo,
        "mensaje": mensaje,
        "origen": manifiesto.get("origen", {}),
        "generado_en": manifiesto.get("generado_en", ""),
        "tablas": tablas,
        "totales": {"insertadas": total_ins, "reutilizadas": total_reu,
                    "omitidas": total_omi},
    }
