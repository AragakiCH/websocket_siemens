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
from app.api.origen import es_local
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
# defecto se conservan: las conexiones del equipo se quedan TODAS, y las del
# zip se AÑADEN (con su contraseña re-cifrada con la clave local y sin
# autoconectar, para revisarlas antes). Si una del zip choca por `db_id` con
# una de aquí hay dos casos: es la MISMA base (mismo motor, servidor, base y
# usuario) y entonces sobra —ya está—; o es OTRA base que casualmente se
# llama igual (`local` en los dos equipos, por ejemplo), y entonces entra
# renombrada (`local_importada`), porque descartarla era perder la conexión
# del compañero que uno quería tener a mano para sus flujos. Lo que en el
# zip apunte a ese `db_id` (grupos de historización, consultas) se reescribe
# al nombre nuevo. Quien de verdad quiera pisar sus conexiones lo pide
# explícitamente con `conservar_conexiones=false`.
FICHERO_CONEXIONES = "conexiones.json"
FICHERO_CLAVE = ".clave"
# Ficheros con contraseñas cifradas por la clave: si se conserva la clave
# local, lo que venga del zip hay que re-cifrarlo con ella.
FICHEROS_CON_CIFRADO = (FICHERO_CONEXIONES, "plcs.json")
# Ficheros del zip cuyas entradas llevan `db_id`: si una conexión entra
# renombrada, aquí hay que apuntar al nombre nuevo.
FICHEROS_CON_DB_ID = ("historicos.json", "consultas.json")
SUFIJO_IMPORTADA = "_importada"

# ====================================================================== #
# Lo que NO vive en la carpeta de datos y aun así es configuración
# ====================================================================== #
# Dos cosas se quedaban fuera de la copia:
#
#   * `.env`, que vive junto al ejecutable (puertos, modo de acceso, subred
#     de descubrimiento, zona horaria, IA…). Va en la copia como
#     `_instalacion/env.txt`, con las claves/contraseñas tapadas, y al
#     restaurar NO se aplica: queda en `datos/_instalacion/` para leerlo y
#     copiar a mano lo que convenga. Aplicarlo a ciegas cambiaría el puerto
#     o la carpeta de datos del equipo que restaura, que es justo lo que
#     nadie quiere que una restauración haga.
#   * las preferencias del NAVEGADOR (qué variables están marcadas, el
#     lienzo de Flujos, el modo de color, la base elegida para alarmas y
#     recetas…), que viven en localStorage. La vista las manda a
#     `POST /sistema/datos/navegador` justo antes de pedir la copia, se
#     guardan en `preferencias_navegador.json` (dentro de la carpeta, así
#     que viajan en el zip) y tras restaurar la vista las vuelve a leer.
CARPETA_INSTALACION = "_instalacion"
FICHERO_PREFERENCIAS = "preferencias_navegador.json"
PALABRAS_SECRETAS = ("KEY", "TOKEN", "SECRET", "PASSWORD", "CONTRASENA",
                     "CONTRASEÑA", "CLAVE")
MAX_PREFERENCIAS = 2 * 1024 * 1024


def _env_tapado() -> Optional[str]:
    """El `.env` en uso, con los valores sensibles sustituidos por ***."""
    ruta = Path(os.getenv("PLC_ENV_FILE") or ".env")
    if not ruta.is_file():
        return None
    try:
        lineas = ruta.read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        return None
    salida = []
    for linea in lineas:
        limpia = linea.strip()
        if "=" in limpia and not limpia.startswith("#"):
            clave = limpia.split("=", 1)[0].strip().upper()
            if any(p in clave for p in PALABRAS_SECRETAS):
                salida.append(f"{limpia.split('=', 1)[0]}=***")
                continue
        salida.append(linea)
    return "\n".join(salida) + "\n"


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


def _misma_base(a: Dict[str, Any], b: Dict[str, Any]) -> bool:
    """¿Apuntan las dos conexiones a la misma base del mismo servidor?"""
    def _n(c: Dict[str, Any]) -> tuple:
        return (str(c.get("motor", "")).lower(),
                str(c.get("host", "")).strip().lower(),
                int(c.get("puerto") or 0),
                str(c.get("base_datos", "")).strip().lower(),
                str(c.get("usuario", "")).strip().lower())
    return _n(a) == _n(b)


def _fusionar_conexiones(locales: List[Dict[str, Any]],
                         importadas: List[Dict[str, Any]],
                         f_zip, f_local) -> tuple:
    """
    Conexiones locales + las del zip. Ninguna local se toca.

    Devuelve `(lista_final, añadidas, descartadas, renombradas)`:
      * `añadidas`: `db_id` (ya definitivo) de las que entraron;
      * `descartadas`: las del zip que eran la MISMA base que una local;
      * `renombradas`: `{db_id_del_zip: db_id_aquí}` de las que chocaban por
        nombre con otra base distinta y entraron con sufijo. Sirve para
        reescribir lo que en el zip apuntaba a ese nombre.
    """
    por_id = {str(c.get("db_id", "")): c for c in locales}
    final = list(locales)
    anadidas: List[str] = []
    descartadas: List[str] = []
    renombradas: Dict[str, str] = {}
    for c in importadas:
        db_id = str(c.get("db_id", ""))
        if not db_id:
            continue
        nuevo_id = db_id
        if db_id in por_id:
            if _misma_base(por_id[db_id], c):
                descartadas.append(db_id)
                continue
            base = f"{db_id}{SUFIJO_IMPORTADA}"
            nuevo_id = base
            i = 2
            while nuevo_id in por_id:
                nuevo_id = f"{base}_{i}"
                i += 1
            renombradas[db_id] = nuevo_id
        c = dict(c)
        c["db_id"] = nuevo_id
        if nuevo_id != db_id:
            c["nombre"] = f"{c.get('nombre') or db_id} (importada)"[:80]
        c["password"] = _recifrar(c.get("password", ""), f_zip, f_local)
        # Que no arranque sola apuntando a un servidor que quizá no existe
        # aquí: se deja dada de alta para revisarla, no para que falle cada
        # arranque.
        c["autoconectar"] = False
        final.append(c)
        por_id[nuevo_id] = c
        anadidas.append(nuevo_id)
    return final, anadidas, descartadas, renombradas


def _reapuntar_db_id(datos: Any, renombradas: Dict[str, str]) -> Any:
    """
    Cambia el `db_id` de las entradas (grupos de historización, consultas)
    que apunten a una conexión que entró renombrada. Solo la clave `db_id`,
    en el primer nivel de cada entrada: es donde vive en esos ficheros.
    """
    if not renombradas:
        return datos
    if isinstance(datos, list):
        salida = []
        for e in datos:
            if isinstance(e, dict) and str(e.get("db_id", "")) in renombradas:
                e = dict(e)
                e["db_id"] = renombradas[str(e["db_id"])]
            salida.append(e)
        return salida
    if isinstance(datos, dict):
        return {k: (_reapuntar_db_id(v, renombradas)
                    if isinstance(v, (list, dict)) else v)
                for k, v in datos.items()}
    return datos


# ====================================================================== #
# Preferencias del navegador (para que viajen en la copia)
# ====================================================================== #
@router.post(
    "/sistema/datos/navegador",
    tags=["Sistema"],
    summary="Guardar las preferencias del navegador en la carpeta de datos",
    description="La vista manda un objeto `{clave: valor}` con lo que guarda "
                "en localStorage y es configuración (variables marcadas, "
                "lienzo de Flujos, modo de color, bases elegidas). Se guarda "
                "en `preferencias_navegador.json`, que viaja en la copia de "
                "seguridad. Nunca tokens ni cachés: la vista los filtra y "
                "aquí se rechazan por nombre.",
    dependencies=[Depends(exigir_rol("Supervisor"))],
)
async def guardar_preferencias(request: Request) -> Dict[str, Any]:
    try:
        cuerpo = await request.json()
    except Exception:  # noqa: BLE001
        raise HTTPException(400, "Se esperaba un JSON {clave: valor}.")
    if not isinstance(cuerpo, dict):
        raise HTTPException(400, "Se esperaba un JSON {clave: valor}.")
    limpio = {k: v for k, v in cuerpo.items()
              if isinstance(k, str) and isinstance(v, str)
              and "token" not in k.lower()}
    texto = json.dumps({"guardado_en": datetime.now().isoformat(timespec="seconds"),
                        "preferencias": limpio}, ensure_ascii=False, indent=2)
    if len(texto.encode("utf-8")) > MAX_PREFERENCIAS:
        raise HTTPException(413, "Las preferencias superan el tamaño máximo.")
    ruta = resolver_carpeta_datos() / FICHERO_PREFERENCIAS
    try:
        tmp = ruta.with_suffix(".json.tmp")
        tmp.write_text(texto, encoding="utf-8")
        tmp.replace(ruta)
    except OSError as exc:
        raise HTTPException(500, f"No se pudieron guardar las preferencias: {exc}")
    return {"ok": True, "claves": len(limpio)}


@router.get(
    "/sistema/datos/navegador",
    tags=["Sistema"],
    summary="Leer las preferencias del navegador guardadas",
    description="Lo que guardó `POST /sistema/datos/navegador` (o lo que "
                "trajo una copia restaurada). La vista lo aplica a su "
                "localStorage tras restaurar.",
    dependencies=[Depends(exigir_rol("Supervisor"))],
)
async def leer_preferencias() -> Dict[str, Any]:
    ruta = resolver_carpeta_datos() / FICHERO_PREFERENCIAS
    if not ruta.is_file():
        return {"ok": True, "preferencias": {}, "guardado_en": ""}
    try:
        d = json.loads(ruta.read_text(encoding="utf-8"))
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(500, f"preferencias_navegador.json ilegible: {exc}")
    prefs = d.get("preferencias") if isinstance(d, dict) else None
    return {"ok": True,
            "preferencias": prefs if isinstance(prefs, dict) else {},
            "guardado_en": d.get("guardado_en", "") if isinstance(d, dict) else ""}


# ====================================================================== #
# Traza de rendimiento del runtime
# ====================================================================== #
# La vista manda, con `navigator.sendBeacon`, lotes de marcas de tiempo:
# cuándo se pidió una pantalla, cuándo llegó, cuánto tardó cada widget en
# montarse, cuánto bloqueó el hilo principal. Es lo que permite responder a
# «¿por qué tarda?» con números de ESE equipo en vez de con conjeturas.
#
# Va a `traza_rendimiento.log` en la carpeta de datos: con extensión `.log`
# a propósito, para que `es_configuracion()` lo deje fuera de las copias de
# seguridad. Se acepta solo desde la propia máquina y se recorta a un tamaño
# fijo: un visor encendido una semana no puede llenar el disco.
TRAZA_FICHERO = "traza_rendimiento.log"
TRAZA_MAX_BYTES = 4 * 1024 * 1024


@router.post(
    "/sistema/traza",
    tags=["Sistema"],
    summary="Guardar marcas de rendimiento de la vista",
    description="Solo desde la máquina del servidor. Cada lote se añade como "
                "líneas JSON a `traza_rendimiento.log` en la carpeta de datos.",
    include_in_schema=False,
)
async def guardar_traza(request: Request) -> Dict[str, Any]:
    if not es_local(request):
        raise HTTPException(403, "Solo desde el equipo servidor.")
    try:
        cuerpo = await request.json()
    except Exception:  # noqa: BLE001
        return {"ok": False}
    lote = cuerpo.get("lote") if isinstance(cuerpo, dict) else None
    if not isinstance(lote, list) or not lote:
        return {"ok": True, "guardadas": 0}

    ruta = resolver_carpeta_datos() / TRAZA_FICHERO
    try:
        if ruta.is_file() and ruta.stat().st_size > TRAZA_MAX_BYTES:
            # Se queda con la mitad final: lo reciente es lo que interesa.
            datos = ruta.read_bytes()[-TRAZA_MAX_BYTES // 2:]
            ruta.write_bytes(datos[datos.find(b"\n") + 1:])
        ahora = datetime.now().isoformat(timespec="milliseconds")
        pagina = str(cuerpo.get("pagina", ""))[:200]
        with ruta.open("a", encoding="utf-8") as f:
            for m in lote[:2000]:
                if not isinstance(m, dict):
                    continue
                m = {"recibido": ahora, "pagina": pagina, **m}
                f.write(json.dumps(m, ensure_ascii=False) + "\n")
    except OSError as exc:
        logger.warning("No se pudo escribir la traza: %s", exc)
        return {"ok": False}
    return {"ok": True, "guardadas": len(lote)}


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
            # Lo que dejó una restauración anterior como referencia no se
            # vuelve a empaquetar: la copia lleva el .env de AHORA (abajo).
            if p.relative_to(ruta).parts[0] == CARPETA_INSTALACION:
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
        env = _env_tapado()
        if env is not None:
            z.writestr(f"{CARPETA_INSTALACION}/env.txt", env)
        z.writestr(
            "_LEEME.txt",
            "Copia de seguridad de la configuracion de PsiCore\n"
            f"Origen : {ruta}\n"
            f"Fecha  : {datetime.now().isoformat(timespec='seconds')}\n\n"
            "Contiene la clave de cifrado (.clave): tratalo como un fichero\n"
            "sensible. Sin ella, las contrasenas guardadas no se pueden leer.\n\n"
            "Para restaurarlo: Configuracion -> Carpeta de datos -> Restaurar,\n"
            "y reinicia el servicio despues.\n\n"
            "Incluye _instalacion/env.txt: el .env del equipo de origen con\n"
            "las claves tapadas, SOLO como referencia. Al restaurar no se\n"
            "aplica: queda en datos/_instalacion/ para copiar a mano lo que\n"
            "convenga (puertos, subred, zona horaria...).\n\n"
            "Incluye preferencias_navegador.json si la vista las mando antes\n"
            "de pedir la copia: variables marcadas, lienzo de Flujos, modo de\n"
            "color, base elegida para alarmas y recetas.\n\n"
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
    renombradas: Dict[str, str] = {}
    # Las conexiones se fusionan ANTES de recorrer el zip: el resultado (qué
    # db_id cambió de nombre) hace falta para reescribir los ficheros que
    # apuntan a ellas, vengan en el orden que vengan dentro del zip.
    if conservar and FICHERO_CONEXIONES in nombres:
        try:
            datos_cx = json.loads(z.read(FICHERO_CONEXIONES).decode("utf-8"))
        except Exception:  # noqa: BLE001
            datos_cx = None
        if isinstance(datos_cx, list):
            datos_cx, anadidas, descartadas, renombradas = _fusionar_conexiones(
                locales, [c for c in datos_cx if isinstance(c, dict)],
                f_zip, f_local)
            ruta_conexiones.write_text(
                json.dumps(datos_cx, ensure_ascii=False, indent=2),
                encoding="utf-8")
            restaurados += 1

    for nombre in nombres:
        if nombre == "_LEEME.txt":
            continue
        salida = destino / nombre
        salida.parent.mkdir(parents=True, exist_ok=True)

        if conservar and nombre in (FICHERO_CLAVE, FICHERO_CONEXIONES):
            # La clave de este equipo se queda: es la que abre sus
            # contraseñas, y todo lo que entra del zip se re-cifra con ella.
            # Las conexiones ya se fusionaron arriba.
            continue

        if conservar and renombradas and nombre in FICHEROS_CON_DB_ID:
            try:
                datos = json.loads(z.read(nombre).decode("utf-8"))
            except Exception:  # noqa: BLE001
                datos = None
            if datos is not None:
                salida.write_text(
                    json.dumps(_reapuntar_db_id(datos, renombradas),
                               ensure_ascii=False, indent=2),
                    encoding="utf-8")
                restaurados += 1
                continue

        if conservar and nombre in FICHEROS_CON_CIFRADO:
            try:
                datos = json.loads(z.read(nombre).decode("utf-8"))
            except Exception:  # noqa: BLE001
                datos = None
            if isinstance(datos, list):
                if nombre == FICHERO_CONEXIONES:
                    pass  # ya fusionadas arriba (no se llega aquí)
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
                               "conexiones_descartadas": descartadas,
                               "conexiones_renombradas": renombradas},
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
        if renombradas:
            nota_conexiones += (
                "; " + ", ".join(f"{a} entró como {b}" for a, b in
                                 renombradas.items())
                + " porque aquí ya había otra base con ese id (sus grupos "
                  "y consultas del zip apuntan al nombre nuevo)")
        if descartadas:
            nota_conexiones += (
                f"; {', '.join(descartadas)} del zip ya estaban aquí (misma "
                f"base) y no se duplicaron")
        nota_conexiones += "."

    # `usuario_de` devuelve '' cuando no hay sesión, que pasa de verdad en dos
    # casos legítimos: con `auth_requerida=false`, y en el arranque en frío
    # mientras todavía no existe ninguna cuenta. Se escribe 'anónimo' para que
    # el registro no quede con un hueco que parezca un fallo del programa.
    logger.warning("Configuración restaurada por %s (%d ficheros). Respaldo en %s.%s",
                   usuario_de(sesion) or "anónimo", restaurados, respaldo,
                   nota_conexiones)
    nota_env = ""
    if any(n.startswith(f"{CARPETA_INSTALACION}/") for n in nombres):
        nota_env = (f" El .env del equipo de origen quedó en "
                    f"{CARPETA_INSTALACION}/env.txt SOLO como referencia "
                    f"(no se aplica).")
    return {
        "ok": True,
        "ficheros": restaurados,
        "ruta": str(destino),
        "respaldo_anterior": str(respaldo),
        "preferencias_navegador": FICHERO_PREFERENCIAS in nombres,
        "conexiones_conservadas": conservar,
        "conexiones_anadidas": anadidas,
        "conexiones_descartadas": descartadas,
        "conexiones_renombradas": renombradas,
        "mensaje": f"{restaurados} fichero(s) restaurados.{nota_conexiones}"
                   f"{nota_env} REINICIA el servicio para que se apliquen. "
                   f"La configuración anterior quedó en {respaldo.name}.",
    }
