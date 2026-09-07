# -*- coding: utf-8 -*-
"""
migraciones.py
==============
Poner al día el esquema del HMI de una base que YA existe.

**El problema.** `ddl_esquema_hmi()` es idempotente a base de
`CREATE TABLE IF NOT EXISTS`: ejecutarlo sobre una base que ya tiene las
tablas no falla... y tampoco hace nada. Así que una columna nueva —añadida al
DDL para las bases futuras— no llega jamás a las bases que ya están en
producción, que son justo las que importan. El síntoma es de los peores:
todo parece bien hasta que un INSERT falla con *"Invalid column name
'usuario_id'"* en la planta, un martes.

**Lo que hace esto.** Compara las columnas REALES de cada tabla con las que
el DDL declara hoy, y añade las que falten con un `ALTER TABLE`. Nada más:

  * No borra columnas. Una columna de sobra no rompe nada; borrarla sí, y
    puede llevarse datos que este código no sabe que importan.
  * No cambia tipos. Un `ALTER COLUMN` sobre una tabla con filas es una
    operación que puede tardar horas y bloquear la tabla; eso se decide a
    mano, no en el arranque de un servicio.
  * No toca las filas existentes. Las columnas nuevas nacen a NULL, que es
    exactamente lo que significan: "de esta fila no sabemos quién fue".

**Por qué es seguro ejecutarlo dos veces.** Porque lo primero que hace es
mirar qué hay. Si la columna ya está, no emite nada.

**Las claves foráneas van aparte y pueden fallar sin que pase nada.** SQLite
no sabe añadir una FK a una tabla existente (habría que recrear la tabla), y
en los demás motores puede faltar el permiso. La columna es lo que hace
funcionar el código; la FK es integridad referencial que se puede añadir
después con SQL a mano. Por eso un fallo ahí se informa y no aborta.
"""
from __future__ import annotations

import logging
from typing import Any, Dict, List, Tuple

from app.db.sql_driver import _nombre_seguro, _prefijo_seguro, tipos_motor

logger = logging.getLogger("migraciones")


# ====================================================================== #
# Qué columnas tiene que tener cada tabla y que podrían faltar
# ====================================================================== #
# Solo las AÑADIDAS después de la primera versión del esquema. Las
# originales no hace falta listarlas: si faltan, la tabla no es del HMI y
# recrearla es otro problema.
#
# Formato: tabla -> ((columna, clave_de_tipo, referencia, nombre_fk), ...)
#
# `referencia` vacía = columna suelta. Con valor = además se intenta la FK
# contra esa tabla del esquema. `nombre_fk` se escribe LITERAL y tiene que
# coincidir con el del DDL (`ddl_esquema_hmi`), o una base creada de cero y
# una migrada acabarían con la misma restricción bajo dos nombres distintos
# y cualquier script que la busque por nombre fallaría en una de las dos.
COLUMNAS_AÑADIDAS: Dict[str, Tuple[Tuple[str, str, str, str], ...]] = {
    # Quién configuró la regla de alarma. Ver la nota larga en
    # `CrudManager._sellar_autor()`: la identidad no se pide, se deduce del
    # token.
    "alarmas_def": (("usuario_id", "fk", "usuarios",
                     "fk_{p}alarmas_def_usuario"),),
    # Quién movió los límites de un ingrediente. `valor_minimo` y
    # `valor_maximo` son la última barrera antes de escribir en una máquina.
    "receta_elementos": (("usuario_id", "fk", "usuarios",
                          "fk_{p}receta_elementos_usuario"),),
    # Quién escribió cada celda de una mezcla.
    "receta_valores": (("usuario_id", "fk", "usuarios",
                        "fk_{p}receta_valores_usuario"),),
}


def _sql_add(motor: str, tabla: str, columna: str, tipo: str) -> str:
    """
    `ALTER TABLE ... ADD`, con la sintaxis de cada motor.

    SQL Server es el raro: no lleva la palabra `COLUMN`. Los otros tres la
    aceptan y es más explícita, así que se usa donde se puede.
    """
    if motor == "mssql":
        return f"ALTER TABLE {tabla} ADD {columna} {tipo} NULL"
    return f"ALTER TABLE {tabla} ADD COLUMN {columna} {tipo} NULL"


def _sql_fk(motor: str, tabla: str, columna: str, destino: str,
            nombre: str) -> str:
    return (
        f"ALTER TABLE {tabla} ADD CONSTRAINT {nombre} "
        f"FOREIGN KEY ({columna}) REFERENCES {destino} (id)"
    )


async def asegurar_columnas_hmi(driver, prefijo: str = "") -> List[Dict[str, Any]]:
    """
    Añade a las tablas del HMI las columnas que les falten.

    Devuelve un informe: una entrada por tabla revisada, diciendo qué se
    añadió, qué ya estaba y qué no se pudo hacer. El informe es el producto
    principal — quien ejecuta una migración sobre una base de producción
    necesita leer qué pasó, no un `{"ok": true}`.
    """
    p = _prefijo_seguro(prefijo)
    tipos = tipos_motor(driver.motor)
    informe: List[Dict[str, Any]] = []

    for tabla_base, columnas in COLUMNAS_AÑADIDAS.items():
        tabla = _nombre_seguro(f"{p}{tabla_base}")
        entrada: Dict[str, Any] = {
            "tabla": tabla, "añadidas": [], "ya_estaban": [], "avisos": [],
        }

        try:
            reales = {c["nombre"].lower()
                      for c in await driver.listar_columnas(tabla)}
        except Exception as exc:  # noqa: BLE001
            # La tabla no existe: no es un fallo de la migración, es una base
            # a la que todavía no se le ha creado el esquema. Lo dice y sigue
            # con las demás.
            entrada["avisos"].append(
                f"No se pudo leer la tabla (¿no existe todavía?): {exc}"
            )
            informe.append(entrada)
            continue

        for columna, clave_tipo, referencia, plantilla_fk in columnas:
            if columna.lower() in reales:
                entrada["ya_estaban"].append(columna)
                continue

            tipo = tipos[clave_tipo]
            try:
                await driver._ejecutar_interno(
                    _sql_add(driver.motor, tabla, columna, tipo)
                )
            except Exception as exc:  # noqa: BLE001
                entrada["avisos"].append(
                    f"No se pudo añadir '{columna}': {exc}"
                )
                continue

            entrada["añadidas"].append(columna)
            logger.info("Migración: %s.%s añadida (%s).", tabla, columna, tipo)

            if not referencia:
                continue
            # La FK, en su propio intento. SQLite no sabe añadirla a una tabla
            # que ya existe, y ahí no hay nada que arreglar: la columna
            # funciona igual.
            destino = _nombre_seguro(f"{p}{referencia}")
            nombre_fk = _nombre_seguro(plantilla_fk.format(p=p))
            try:
                await driver._ejecutar_interno(
                    _sql_fk(driver.motor, tabla, columna, destino, nombre_fk)
                )
            except Exception as exc:  # noqa: BLE001
                entrada["avisos"].append(
                    f"La columna '{columna}' se añadió, pero sin su clave "
                    f"foránea a '{destino}'"
                    + (". SQLite no permite añadirla a una tabla existente; "
                       "no afecta al funcionamiento."
                       if driver.motor == "sqlite" else f": {exc}")
                )

        informe.append(entrada)

    return informe


def resumir(informe: List[Dict[str, Any]]) -> str:
    """Una frase con lo que pasó, para devolver por la API y para el log."""
    añadidas = sum(len(e["añadidas"]) for e in informe)
    avisos = sum(len(e["avisos"]) for e in informe)
    if añadidas == 0 and avisos == 0:
        return "El esquema ya estaba al día: no hizo falta añadir ninguna columna."
    partes = []
    if añadidas:
        partes.append(
            f"{añadidas} columna{'' if añadidas == 1 else 's'} añadida"
            f"{'' if añadidas == 1 else 's'}"
        )
    if avisos:
        partes.append(f"{avisos} aviso{'' if avisos == 1 else 's'}")
    return ", ".join(partes).capitalize() + "."
