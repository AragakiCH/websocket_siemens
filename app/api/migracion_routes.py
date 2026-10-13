# -*- coding: utf-8 -*-
"""
migracion_routes.py
===================
Llevarse los datos del HMI de una base a otra.

    GET   /db/{db_id}/datos/exportar     descarga un .zip con las tablas del HMI
    POST  /db/{db_id}/datos/importar     sube ese .zip y lo mete en esta base

Cuelgan de `/db/...` a propósito: son operaciones SOBRE una conexión dada de
alta, y así el proxy de Vite (que ya reenvía `/db`) no necesita una línea
nueva — que es el olvido clásico que deja un endpoint «sin existir» en
desarrollo.

Lo que se lleva, lo que no, y cómo se renumeran las claves está explicado en
`app/db/migracion_datos.py`. Aquí solo permisos, ficheros y auditoría.
"""
from __future__ import annotations

import logging
import os
import tempfile
from datetime import datetime
from typing import Any, Dict, Optional

from fastapi import (APIRouter, BackgroundTasks, Depends, File, Form,
                     HTTPException, Request, UploadFile)
from fastapi.responses import FileResponse

from app.api.auth_routes import exigir_rol, usuario_de
from app.core.auth_manager import Sesion
from app.db import migracion_datos

logger = logging.getLogger("migracion_routes")

router = APIRouter()

# Tope del fichero que se sube. El histórico de un año puede ser grande;
# más que esto ya conviene partirlo o llevarse la base con el motor.
MAX_ZIP = 1024 * 1024 * 1024  # 1 GB


def _borrar(ruta: str) -> None:
    try:
        os.unlink(ruta)
    except OSError:
        pass


async def _driver(request: Request, db_id: str):
    mgr = request.app.state.db_manager
    try:
        return await mgr._driver_de(db_id)
    except KeyError as exc:
        raise HTTPException(404, str(exc))
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(503, f"No se pudo abrir la conexión: {exc}")


def _prefijo(request: Request) -> str:
    st = request.app.state.settings
    return (getattr(st, "esquema_prefijo", "") or
            getattr(st, "auth_tabla_prefijo", "") or "")


def _auditar(request: Request, accion: str, sesion, db_id: str,
             detalle: Dict[str, Any]) -> None:
    aud = getattr(request.app.state, "auditoria", None)
    if aud is not None:
        aud.registrar(accion, recurso=db_id, detalle=detalle, sesion=sesion)


@router.get(
    "/db/{db_id}/datos/exportar",
    tags=["Bases de datos"],
    summary="Exportar los datos del HMI de esta base (.zip)",
    description=(
        "Descarga un `.zip` con las tablas del esquema del HMI: reglas de "
        "alarma, historial de alarmas, recetas (con elementos, registros y "
        "valores) y, si se pide, el histórico del PLC (`plc_prg`).\n\n"
        "**No incluye `usuarios`**: las cuentas son de cada instalación.\n\n"
        "El fichero se importa en cualquier otra base del HMI, del motor que "
        "sea, con `POST /db/{db_id}/datos/importar`, que renumera las claves "
        "para que encaje aunque el destino ya tenga datos."
    ),
)
async def exportar_datos(
    request: Request,
    db_id: str,
    tareas: BackgroundTasks,
    incluir_historico: bool = True,
    sesion: Optional[Sesion] = Depends(exigir_rol("Administradores")),
) -> FileResponse:
    driver = await _driver(request, db_id)
    conexion = next((c for c in request.app.state.db_manager.listar_conexiones()
                     if c.get("db_id") == db_id), {})
    origen = {
        "db_id": db_id,
        "nombre": conexion.get("nombre", ""),
        "motor": getattr(driver, "motor", ""),
        "base_datos": getattr(driver, "base_datos", ""),
        "exportado_por": usuario_de(sesion) or "anónimo",
    }
    try:
        ruta, manifiesto = await migracion_datos.exportar(
            driver, _prefijo(request), incluir_historico, origen)
    except Exception as exc:  # noqa: BLE001
        logger.exception("Fallo exportando datos de %s", db_id)
        raise HTTPException(500, f"No se pudo exportar: {exc}")

    filas = {k: v.get("filas", 0) for k, v in manifiesto["tablas"].items()}
    _auditar(request, "bd.datos.exportados", sesion, db_id,
             {"incluir_historico": incluir_historico, "filas": filas,
              "bytes": os.path.getsize(ruta)})

    nombre = (f"psicore-datos-{db_id}-"
              f"{datetime.now().strftime('%Y%m%d-%H%M%S')}.zip")
    # El temporal se borra cuando la respuesta ya salió.
    tareas.add_task(_borrar, ruta)
    return FileResponse(ruta, media_type="application/zip", filename=nombre,
                        headers={"Cache-Control": "no-store"})


@router.post(
    "/db/{db_id}/datos/importar",
    tags=["Bases de datos"],
    summary="Importar en esta base un .zip de datos del HMI",
    description=(
        "Mete en esta base lo que trae un `.zip` generado con "
        "`GET /db/{db_id}/datos/exportar`, **renumerando las claves**: las "
        "filas se insertan sin `id`, el motor asigna uno nuevo y las claves "
        "foráneas se reescriben con el mapa viejo→nuevo, en orden de "
        "dependencia.\n\n"
        "`modo=fusionar` (defecto): lo que ya exista en el destino por su "
        "clave natural (receta por nombre, regla de alarma por nombre+tag, "
        "evento por instante+tag+mensaje…) se reutiliza en vez de duplicarse. "
        "`modo=añadir`: todo entra como nuevo.\n\n"
        "`simular=true`: hace el recorrido completo y termina en ROLLBACK; "
        "el informe es el que daría la importación real.\n\n"
        "**Todo o nada**: la importación va en una sola transacción. Las "
        "columnas `usuario_id` entran a NULL (las cuentas no viajan)."
    ),
)
async def importar_datos(
    request: Request,
    db_id: str,
    archivo: UploadFile = File(..., description="El .zip exportado."),
    modo: str = Form("fusionar"),
    simular: bool = Form(False),
    incluir_historico: bool = Form(True),
    sesion: Optional[Sesion] = Depends(exigir_rol("Supervisor")),
) -> Dict[str, Any]:
    driver = await _driver(request, db_id)

    # A disco por trozos: el zip del histórico puede pesar cientos de MB y no
    # tiene por qué pasar entero por la memoria del servidor.
    tmp = tempfile.NamedTemporaryFile(prefix="psicore-importar-", suffix=".zip",
                                      delete=False)
    total = 0
    try:
        while True:
            trozo = await archivo.read(1024 * 1024)
            if not trozo:
                break
            total += len(trozo)
            if total > MAX_ZIP:
                raise HTTPException(
                    413, f"El archivo supera {MAX_ZIP // 1024 // 1024} MB.")
            tmp.write(trozo)
        tmp.close()

        try:
            informe = await migracion_datos.importar(
                driver, tmp.name, _prefijo(request), modo, simular,
                incluir_historico)
        except ValueError as exc:
            raise HTTPException(400, str(exc))
        except Exception as exc:  # noqa: BLE001
            logger.exception("Fallo importando datos en %s", db_id)
            raise HTTPException(
                500, f"La importación falló y no se aplicó nada: {exc}")
    finally:
        tmp.close()
        _borrar(tmp.name)

    informe["db_id"] = db_id
    informe["archivo"] = archivo.filename or ""

    if not simular:
        _auditar(request, "bd.datos.importados", sesion, db_id,
                 {"archivo": archivo.filename or "", "bytes": total,
                  "modo": informe["modo"], "totales": informe["totales"],
                  "origen": informe.get("origen", {})})
        # Alarmas y recetas se leen desde la vista: que se refresquen.
        try:
            await request.app.state.manager.difundir_config(
                "datos", usuario_de(sesion), "importados")
        except Exception:  # noqa: BLE001
            pass
        # El motor de alarmas tiene las reglas en memoria: si entraron
        # reglas nuevas, que las vea sin esperar al reinicio.
        motor = getattr(request.app.state, "motor_alarmas", None)
        if motor is not None and informe["totales"]["insertadas"]:
            try:
                await motor.recargar()
            except Exception:  # noqa: BLE001
                pass
        logger.warning("Datos importados en %s por %s: %s", db_id,
                       usuario_de(sesion) or "anónimo", informe["mensaje"])
    return informe
