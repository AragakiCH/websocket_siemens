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
import json
import logging
import os
import shutil
import subprocess
import sys
import zipfile
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import (APIRouter, Depends, File, Form, HTTPException, Request,
                     UploadFile)
from fastapi.responses import StreamingResponse

from app.api.auth_routes import exigir_rol, usuario_de
from app.config.rutas import (describir, es_configuracion,
                              resolver_carpeta_datos)
from app.core.auth_manager import Sesion
from app.db.store import PREFIJO_CIFRADO

logger = logging.getLogger("sistema_routes")

router = APIRouter()

# Tope de la copia. La configuración son unos pocos KB; si alguien sube 200 MB
# es que se equivocó de fichero, y conviene decirlo antes de descomprimirlo.
MAX_ZIP = 50 * 1024 * 1024


# ====================================================================== #
# Lo que es DE ESTE EQUIPO y no viaja en una copia de otro
# ====================================================================== #
# Una copia de seguridad se restaura por dos motivos muy distintos:
#
#   * en el MISMO equipo, tras reinstalar o tras una metedura de pata: ahí
#     quiere decir "déjalo todo como estaba";
#   * en OTRO equipo, para llevarse las pantallas, los PLCs y las consultas:
#     ahí NO quiere decir "pisa mi base de datos con la del otro PC".
#
# Lo segundo es lo que pasaba: alguien traía las pantallas de un compañero y
# se encontraba con que su conexión a SQL Server —la de su instancia, su
# base y su usuario, que llevaba semanas funcionando— había desaparecido, y
# en su lugar había una que apuntaba a una base que en su equipo no existe.
# Y, de regalo, `.clave` también era la del otro, así que ni restaurando a
# mano `conexiones.json` volvían a leerse sus contraseñas.
#
# `conexiones.json` y `.clave` describen ESTE servidor, no el proyecto. Por
# defecto se conservan: las conexiones del equipo se quedan, las del zip que
# no choquen por `db_id` se añaden (con su contraseña re-cifrada con la clave
# local), y las que choquen se descartan, porque la del equipo es la que
# funciona aquí. Quien de verdad quiera pisarlas lo pide explícitamente con
# `conservar_conexiones=false`.
FICHERO_CONEXIONES = "conexiones.json"
FICHERO_CLAVE = ".clave"
# Ficheros con contraseñas cifradas por la clave: si se conserva la clave
# local, lo que venga del zip hay que re-cifrarlo con ella.
FICHEROS_CON_CIFRADO = (FICHERO_CONEXIONES, "plcs.json")


def _fernet(clave: Optional[bytes]):
    """Fernet a partir de una clave leída de disco, o None si no vale."""
    if not clave:
        return None
    try:
        from cryptography.fernet import Fernet
        return Fernet(clave.strip())
    except Exception:  # noqa: BLE001
        return None


def _recifrar(valor: Any, origen, destino) -> str:
    """
    Pasa una contraseña de la clave del zip a la clave local.

    Si no se puede descifrar (el zip venía sin `.clave`, o con otra), se deja
    en blanco: mejor una contraseña vacía que pide volver a escribirla que un
    `enc:...` que nunca va a abrir y da "credenciales incorrectas" sin decir
    por qué.
    """
    v = str(valor or "")
    if not v:
        return ""
    if not v.startswith(PREFIJO_CIFRADO):
        # Texto plano (alguien editó el JSON a mano): se cifra con la local.
        return (PREFIJO_CIFRADO + destino.encrypt(v.encode()).decode()
                if destino else v)
    if origen is None or destino is None:
        return ""
    try:
        claro = origen.decrypt(v[len(PREFIJO_CIFRADO):].encode())
    except Exception:  # noqa: BLE001
        return ""
    return PREFIJO_CIFRADO + destino.encrypt(claro).decode()


def _fusionar_conexiones(locales: List[Dict[str, Any]],
                         importadas: List[Dict[str, Any]],
                         f_zip, f_local) -> tuple:
    """
    Conexiones locales + las del zip que no choquen por `db_id`.

    Devuelve `(lista_final, añadidas, descartadas)` con los `db_id` de cada
    grupo, para que el mensaje al usuario diga exactamente qué pasó con cada
    una en vez de un "restaurado" que no explica por qué su base sigue ahí.
    """
    ids_locales = {str(c.get("db_id", "")) for c in locales}
    final = list(locales)
    anadidas: List[str] = []
    descartadas: List[str] = []
    for c in importadas:
        db_id = str(c.get("db_id", ""))
        if db_id in ids_locales:
            descartadas.append(db_id)
            continue
        c = dict(c)
        c["password"] = _recifrar(c.get("password", ""), f_zip, f_local)
        # Que no arranque sola apuntando a un servidor que quizá no existe
        # aquí: se deja dada de alta para revisarla, no para que falle cada
        # arranque.
        c["autoconectar"] = False
        final.append(c)
        anadidas.append(db_id)
    return final, anadidas, descartadas


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

    # Solo la CONFIGURACIÓN. En la instalación empaquetada esta carpeta
    # contiene además el perfil de WebView2 (`navegador/`) y el log del
    # servicio, que no son configuración de nadie, pesan decenas de MB y
    # —lo que rompía esto— están ABIERTOS por el proceso mientras la
    # aplicación corre: comprimirlos lanzaba un PermissionError y el
    # endpoint devolvía un 500. En desarrollo no pasaba nunca, porque esas
    # carpetas solo existen en el .exe instalado.
    omitidos: List[str] = []
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as z:
        for p in sorted(ruta.rglob("*")):
            if not p.is_file() or not es_configuracion(p, ruta):
                continue
            try:
                z.write(p, arcname=str(p.relative_to(ruta)))
            except (PermissionError, OSError) as exc:
                # Un fichero que alguien tiene abierto justo ahora no puede
                # costar la copia entera. Se anota en el _LEEME y se sigue:
                # una copia con 12 de 13 ficheros y la ausencia declarada es
                # infinitamente mejor que ninguna copia.
                logger.warning("No se pudo incluir %s en la copia: %s", p, exc)
                omitidos.append(f"{p.relative_to(ruta)} ({exc.__class__.__name__})")
        if omitidos:
            z.writestr(
                "_OMITIDOS.txt",
                "Estos ficheros NO pudieron incluirse porque estaban en uso:\n\n"
                + "\n".join(omitidos)
                + "\n\nCierra PsiCore y vuelve a generar la copia si los "
                  "necesitas.\n",
            )
        z.writestr(
            "_LEEME.txt",
            "Copia de seguridad de la configuracion de PsiCore\n"
            f"Origen : {ruta}\n"
            f"Fecha  : {datetime.now().isoformat(timespec='seconds')}\n\n"
            "Contiene la clave de cifrado (.clave): tratalo como un fichero\n"
            "sensible. Sin ella, las contrasenas guardadas no se pueden leer.\n\n"
            "Para restaurarlo: Configuracion -> Carpeta de datos -> Restaurar,\n"
            "y reinicia el servicio despues.\n\n"
            "NO contiene el perfil del navegador incrustado ni los registros:\n"
            "no son configuracion, pesan mucho y el perfil incluye cookies.\n",
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
                "**Las conexiones a base de datos de este equipo se "
                "conservan** (`conservar_conexiones=true`, el valor por "
                "defecto): `conexiones.json` y la clave de cifrado describen "
                "ESTE servidor, no el proyecto. Las del zip que no choquen "
                "por `db_id` se añaden desactivadas, con su contraseña "
                "re-cifrada con la clave local; las que choquen se descartan. "
                "Con `false` se pisa todo, como una restauración en el mismo "
                "equipo tras reinstalar.\n\n"
                "**Hay que reiniciar el servicio después.** Los pools de base "
                "de datos, las sesiones y los PLCs conectados viven en "
                "memoria; cambiarles el disco por debajo dejaría el proceso a "
                "medio camino entre dos configuraciones.",
)
async def restaurar_backup(
    request: Request,
    archivo: UploadFile = File(..., description="El .zip descargado antes."),
    conservar_conexiones: bool = Form(
        default=True,
        description="Conservar `conexiones.json` y `.clave` de este equipo y "
                    "fusionar las conexiones del zip en vez de sustituirlas.",
    ),
    # La sesión se recibe como PARÁMETRO y no en `dependencies=[...]`.
    #
    # Comprobar el permiso se comprueba igual de las dos formas, pero en la
    # lista `dependencies` el resultado se descarta y aquí hace falta: esta es
    # la operación más destructiva de todo el programa —sustituye cuentas,
    # conexiones y pantallas de golpe— y hasta ahora se registraba en la
    # auditoría con el usuario en blanco. Es decir: quedaba constancia de que
    # alguien había reemplazado la configuración entera, pero no de quién.
    sesion: Optional[Sesion] = Depends(exigir_rol("Supervisor")),
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
    # `ignore` con el MISMO criterio que la copia de seguridad, y por el mismo
    # motivo: `copytree` sobre el perfil de WebView2 abierto falla, y fallar
    # aquí aborta la restauración entera con el mensaje "no se pudo respaldar
    # la configuración actual" — que es verdad, pero el fichero que lo impedía
    # era una cookie.
    def _ignorar(carpeta: str, nombres: List[str]) -> List[str]:
        raiz_actual = Path(carpeta)
        return [n for n in nombres
                if not es_configuracion(raiz_actual / n, destino)]

    try:
        shutil.copytree(destino, respaldo, ignore=_ignorar)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(
            500, f"No se pudo respaldar la configuración actual antes de "
                 f"sustituirla, así que no se sustituye nada: {exc}")

    # ¿Hay conexiones de ESTE equipo que proteger? Solo si existen las dos
    # piezas: la lista y la clave que abre sus contraseñas. En un equipo recién
    # instalado no hay nada que conservar y la copia se restaura entera, que
    # es justo lo que se quiere tras reinstalar.
    ruta_conexiones = destino / FICHERO_CONEXIONES
    ruta_clave = destino / FICHERO_CLAVE
    conservar = (conservar_conexiones and ruta_conexiones.is_file()
                 and ruta_clave.is_file())
    locales: List[Dict[str, Any]] = []
    if conservar:
        try:
            cargadas = json.loads(ruta_conexiones.read_text(encoding="utf-8"))
            locales = [c for c in cargadas if isinstance(c, dict)] \
                if isinstance(cargadas, list) else []
        except Exception as exc:  # noqa: BLE001
            logger.warning("conexiones.json local ilegible (%s); se "
                           "restaura el del zip tal cual.", exc)
            conservar = False

    f_local = _fernet(ruta_clave.read_bytes()) if conservar else None
    f_zip = (_fernet(z.read(FICHERO_CLAVE))
             if conservar and FICHERO_CLAVE in nombres else None)

    restaurados = 0
    anadidas: List[str] = []
    descartadas: List[str] = []
    for nombre in nombres:
        if nombre == "_LEEME.txt":
            continue
        salida = destino / nombre
        salida.parent.mkdir(parents=True, exist_ok=True)

        if conservar and nombre == FICHERO_CLAVE:
            # La clave de este equipo se queda: es la que abre sus
            # contraseñas, y todo lo que entra del zip se re-cifra con ella.
            continue

        if conservar and nombre in FICHEROS_CON_CIFRADO:
            try:
                datos = json.loads(z.read(nombre).decode("utf-8"))
            except Exception:  # noqa: BLE001
                datos = None
            if isinstance(datos, list):
                if nombre == FICHERO_CONEXIONES:
                    datos, anadidas, descartadas = _fusionar_conexiones(
                        locales, [c for c in datos if isinstance(c, dict)],
                        f_zip, f_local)
                else:
                    for d in datos:
                        if isinstance(d, dict) and d.get("password"):
                            d["password"] = _recifrar(
                                d["password"], f_zip, f_local)
                salida.write_text(
                    json.dumps(datos, ensure_ascii=False, indent=2),
                    encoding="utf-8")
                restaurados += 1
                continue

        salida.write_bytes(z.read(nombre))
        restaurados += 1

    aud = getattr(request.app.state, "auditoria", None)
    if aud is not None:
        # `sesion=` rellena solo el usuario y su id desde el token, igual que
        # en el resto del CRUD: el cliente no elige con qué nombre se firma.
        aud.registrar("sistema.restaurado", recurso=str(destino),
                      detalle={"ficheros": restaurados,
                               "respaldo": str(respaldo),
                               "archivo": archivo.filename or "",
                               "bytes": len(contenido),
                               "conexiones_conservadas": conservar,
                               "conexiones_anadidas": anadidas,
                               "conexiones_descartadas": descartadas},
                      sesion=sesion)

    nota_conexiones = ""
    if conservar:
        nota_conexiones = (
            f" Las {len(locales)} conexión(es) a base de datos de este equipo "
            f"se han conservado")
        if anadidas:
            nota_conexiones += (
                f"; del zip se añadieron {', '.join(anadidas)} (desactivadas, "
                f"revísalas antes de usarlas)")
        if descartadas:
            nota_conexiones += (
                f"; se descartaron {', '.join(descartadas)} del zip porque "
                f"aquí ya existen con ese id")
        nota_conexiones += "."

    # `usuario_de` devuelve '' cuando no hay sesión, que pasa de verdad en dos
    # casos legítimos: con `auth_requerida=false`, y en el arranque en frío
    # mientras todavía no existe ninguna cuenta. Se escribe 'anónimo' para que
    # el registro no quede con un hueco que parezca un fallo del programa.
    logger.warning("Configuración restaurada por %s (%d ficheros). Respaldo en %s.%s",
                   usuario_de(sesion) or "anónimo", restaurados, respaldo,
                   nota_conexiones)
    return {
        "ok": True,
        "ficheros": restaurados,
        "ruta": str(destino),
        "respaldo_anterior": str(respaldo),
        "conexiones_conservadas": conservar,
        "conexiones_anadidas": anadidas,
        "conexiones_descartadas": descartadas,
        "mensaje": f"{restaurados} fichero(s) restaurados.{nota_conexiones} "
                   f"REINICIA el servicio para que se apliquen. La "
                   f"configuración anterior quedó en {respaldo.name}.",
    }
