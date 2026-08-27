# -*- coding: utf-8 -*-
"""
sistema_routes.py
=================
Dónde están los datos, cómo llevárselos y cómo devolverlos.

    GET    /sistema/datos             dónde guarda, cuánto ocupa, ¿se puede escribir?
    POST   /sistema/datos/abrir       abrir esa carpeta en el explorador del SERVIDOR
    GET    /sistema/datos/backup      descargar toda la configuración en un .zip
    POST   /sistema/datos/restaurar   subir un .zip y recuperarla

POR QUÉ ESTO ES UNA PANTALLA Y NO UNA NOTA EN LA DOCUMENTACIÓN
---------------------------------------------------------------
Tres preguntas que aparecen siempre y que nadie debería tener que buscar en un
manual: *¿dónde han quedado mis cosas?*, *¿cómo me las llevo al otro equipo?* y
*¿cómo las recupero después de actualizar?*.

La copia en `.zip` es además la respuesta honesta a "quiero verlo en
Documentos": la carpeta de trabajo vive donde tiene que vivir —compartida entre
usuarios y fuera del alcance del desinstalador— y el respaldo se guarda donde a
cada uno le convenga.

SOBRE LA RESTAURACIÓN
---------------------
Escribe los ficheros y **exige reiniciar el servicio**. No intenta recargar en
caliente: los pools de base de datos, las sesiones abiertas y los PLCs
conectados viven en memoria, y sustituirles el disco por debajo dejaría un
proceso a medio camino entre dos configuraciones. Es más honesto pedir un
reinicio que fingir que no hace falta.
"""
from __future__ import annotations

import io
import logging
import os
import shutil
import subprocess
import sys
import zipfile
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List

from fastapi import APIRouter, Depends, File, HTTPException, Request, UploadFile
from fastapi.responses import StreamingResponse

from app.api.auth_routes import exigir_rol, usuario_de
from app.config.rutas import describir, resolver_carpeta_datos
from app.core.auth_manager import Sesion

logger = logging.getLogger("sistema_routes")

router = APIRouter()

# Tope de la copia. La configuración son unos pocos KB; si alguien sube 200 MB
# es que se equivocó de fichero, y conviene decirlo antes de descomprimirlo.
MAX_ZIP = 50 * 1024 * 1024


@router.get(
    "/sistema/datos",
    tags=["Sistema"],
    summary="Dónde se guarda la configuración",
    description="Ruta real, de dónde sale esa ruta, si se puede escribir en "
                "ella y qué contiene.\n\n"
                "**`escribible: false` es una alarma**, no un detalle: el "
                "servicio arrancaría igual y perdería todo lo que se hiciera "
                "en él. Mejor verlo antes de trabajar dos horas.",
    responses={200: {"content": {"application/json": {"example": {
        "ruta": "C:\\\\ProgramData\\\\PsiCore\\\\datos",
        "origen": "carpeta de datos del sistema (instalación empaquetada)",
        "empaquetado": True, "escribible": True,
        "num_ficheros": 7, "bytes": 24576,
    }}}}},
)
async def estado_datos() -> Dict[str, Any]:
    return describir()


@router.post(
    "/sistema/datos/abrir",
    tags=["Sistema"],
    summary="Abrir la carpeta de datos en el explorador",
    description="Abre la carpeta **en la máquina donde corre el backend**, no "
                "en la de quien pulsa el botón. En la aplicación de escritorio "
                "son la misma; con el backend en un servidor remoto, esto no "
                "sirve de nada y por eso responde diciéndolo.",
    dependencies=[Depends(exigir_rol("Administradores"))],
)
async def abrir_carpeta(request: Request) -> Dict[str, Any]:
    ruta = resolver_carpeta_datos()
    cliente = request.client.host if request.client else ""
    if cliente not in ("127.0.0.1", "::1", "localhost"):
        return {
            "ok": False, "ruta": str(ruta),
            "mensaje": "La carpeta se abriría en la máquina del servidor, no "
                       "en la tuya. Copia la ruta y ábrela a mano, o descarga "
                       "la copia de seguridad.",
        }
    try:
        if os.name == "nt":
            os.startfile(str(ruta))  # noqa: S606
        elif sys.platform == "darwin":
            subprocess.Popen(["open", str(ruta)])
        else:
            subprocess.Popen(["xdg-open", str(ruta)])
        return {"ok": True, "ruta": str(ruta),
                "mensaje": "Carpeta abierta en el explorador."}
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "ruta": str(ruta),
                "mensaje": f"No se pudo abrir: {exc}. La ruta es {ruta}"}


def _nombre_backup() -> str:
    return f"psicore-config-{datetime.now().strftime('%Y%m%d-%H%M')}.zip"


@router.get(
    "/sistema/datos/backup",
    tags=["Sistema"],
    summary="Descargar la configuración completa en un .zip",
    description="Incluye conexiones, PLCs, proyectos, consultas, grupos de "
                "historización y la auditoría.\n\n"
                "⚠️ **Incluye también `.clave`**, que descifra las contraseñas "
                "de base de datos guardadas. Es imprescindible que vaya "
                "dentro: sin ella el respaldo restaurado no podría leer sus "
                "propias contraseñas. Pero eso convierte al `.zip` en un "
                "fichero sensible — guárdalo como guardarías una contraseña.\n\n"
                "No incluye los DATOS historizados: esos están en la base de "
                "datos, y se respaldan con las herramientas de su motor.",
    dependencies=[Depends(exigir_rol("Supervisor"))],
)
async def descargar_backup() -> StreamingResponse:
    ruta = resolver_carpeta_datos()
    buffer = io.BytesIO()

    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as z:
        for p in sorted(ruta.rglob("*")):
            if p.is_file():
                z.write(p, arcname=str(p.relative_to(ruta)))
        z.writestr(
            "_LEEME.txt",
            "Copia de seguridad de la configuracion de PsiCore\n"
            f"Origen : {ruta}\n"
            f"Fecha  : {datetime.now().isoformat(timespec='seconds')}\n\n"
            "Contiene la clave de cifrado (.clave): tratalo como un fichero\n"
            "sensible. Sin ella, las contrasenas guardadas no se pueden leer.\n\n"
            "Para restaurarlo: Configuracion -> Carpeta de datos -> Restaurar,\n"
            "y reinicia el servicio despues.\n",
        )

    buffer.seek(0)
    nombre = _nombre_backup()
    logger.info("Copia de seguridad generada desde %s", ruta)
    return StreamingResponse(
        buffer,
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{nombre}"'},
    )


@router.post(
    "/sistema/datos/restaurar",
    tags=["Sistema"],
    summary="Restaurar la configuración desde un .zip",
    description="Sustituye la configuración actual por la del respaldo.\n\n"
                "**Antes de tocar nada** guarda lo que hay ahora en una "
                "carpeta hermana `datos_antes_de_restaurar_<fecha>`: si el "
                "respaldo resulta ser el equivocado, no se ha perdido nada.\n\n"
                "**Hay que reiniciar el servicio después.** Los pools de base "
                "de datos, las sesiones y los PLCs conectados viven en "
                "memoria; cambiarles el disco por debajo dejaría el proceso a "
                "medio camino entre dos configuraciones.",
    dependencies=[Depends(exigir_rol("Supervisor"))],
)
async def restaurar_backup(
    request: Request,
    archivo: UploadFile = File(..., description="El .zip descargado antes."),
) -> Dict[str, Any]:
    contenido = await archivo.read()
    if len(contenido) > MAX_ZIP:
        raise HTTPException(
            413, f"El archivo pesa {len(contenido) // 1024} KB; el máximo es "
                 f"{MAX_ZIP // 1024 // 1024} MB. La configuración de PsiCore "
                 f"ocupa unos pocos KB: comprueba que sea el fichero correcto.")

    try:
        z = zipfile.ZipFile(io.BytesIO(contenido))
    except zipfile.BadZipFile:
        raise HTTPException(400, "Ese archivo no es un .zip válido.")

    # Un zip puede contener rutas como `../../windows/system32/...`. Se validan
    # TODAS antes de escribir ni una: es el ataque clásico contra un
    # restaurador, y comprobar a mitad de la extracción ya sería tarde.
    nombres: List[str] = []
    for info in z.infolist():
        if info.is_dir():
            continue
        nombre = info.filename.replace("\\", "/")
        if nombre.startswith("/") or ".." in Path(nombre).parts:
            raise HTTPException(
                400, f"El zip contiene una ruta no permitida: '{info.filename}'.")
        nombres.append(nombre)

    if not any(n.endswith(".json") or n.endswith(".clave") for n in nombres):
        raise HTTPException(
            400, "Ese zip no parece una copia de PsiCore: no contiene ningún "
                 "fichero de configuración.")

    destino = resolver_carpeta_datos()
    respaldo = destino.parent / (
        f"datos_antes_de_restaurar_{datetime.now().strftime('%Y%m%d-%H%M%S')}")
    try:
        shutil.copytree(destino, respaldo)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(
            500, f"No se pudo respaldar la configuración actual antes de "
                 f"sustituirla, así que no se sustituye nada: {exc}")

    restaurados = 0
    for nombre in nombres:
        if nombre == "_LEEME.txt":
            continue
        salida = destino / nombre
        salida.parent.mkdir(parents=True, exist_ok=True)
        salida.write_bytes(z.read(nombre))
        restaurados += 1

    aud = getattr(request.app.state, "auditoria", None)
    if aud is not None:
        aud.registrar("sistema.restaurado", "", str(destino),
                      {"ficheros": restaurados, "respaldo": str(respaldo)})

    logger.warning("Configuración restaurada (%d ficheros). Respaldo en %s",
                   restaurados, respaldo)
    return {
        "ok": True,
        "ficheros": restaurados,
        "ruta": str(destino),
        "respaldo_anterior": str(respaldo),
        "mensaje": f"{restaurados} fichero(s) restaurados. "
                   f"REINICIA el servicio para que se apliquen. La "
                   f"configuración anterior quedó en {respaldo.name}.",
    }
