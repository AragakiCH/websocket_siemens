# -*- coding: utf-8 -*-
"""
rest_routes.py
==============
Endpoints REST del servicio. Documentación interactiva en /docs (Swagger UI).

  GET    /health          -> estado de cada PLC, intervalos, nº de tags y clientes WS.
  GET    /plcs            -> lista de ids de PLC gestionados (para el selector).
  POST   /plcs            -> añade un PLC por IP/endpoint (Siemens o Rexroth).
  DELETE /plcs/{id}       -> quita un PLC gestionado.
  POST   /discover        -> re-escanea la red una vez y añade PLCs nuevos.
  GET    /tags?plc=X      -> tags descubiertos (de todos los PLCs o solo de X).
  GET    /browse?plc=X    -> árbol de tags por PLC y Data Block / programa.

Específicos de Bosch Rexroth ctrlX. Son OPCIONALES: solo hacen falta si el
ctrlX tiene varias apps/programas y quieres elegir cuál leer. En el caso normal
(una app 'Application' con un programa 'PLC_PRG') basta con `POST /plcs`
mandando host + usuario + password: el driver los descubre solo.

  POST   /rexroth/apps     -> apps PLC publicadas en Datalayer/plc/app.
  POST   /rexroth/programs -> programas (POUs) de una app, bajo su nodo `sym`.
"""
from __future__ import annotations

from typing import Dict, List, Optional

from fastapi import APIRouter, Body, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from app.core.internas_store import PLC_INTERNO
from app.api.auth_routes import exigir_rol, usuario_de
from app.core.auth_manager import Sesion

router = APIRouter()


def _auditar(request: Request, accion: str, sesion, recurso: str,
             detalle: dict | None = None) -> None:
    """Registra la acción. Un PLC de produccion borrado sin saber por quien
    es exactamente lo que la auditoria existe para evitar."""
    aud = getattr(request.app.state, "auditoria", None)
    if aud is not None:
        aud.registrar(accion, recurso=recurso, detalle=detalle, sesion=sesion)


class NuevoPlc(BaseModel):
    """
    Cuerpo de POST /plcs.

    Siemens: basta `host` (la sesión OPC UA es anónima).
    Rexroth: además son obligatorios `usuario` y `password`. `app` y `programa`
    son opcionales: si no llegan, se autodetectan al conectar.
    """

    host: str = Field(
        ...,
        description="IP, hostname o endpoint completo `opc.tcp://host:puerto`.",
        examples=["192.168.50.1"],
    )
    puerto: int = Field(
        default=4840, ge=1, le=65535,
        description="Puerto OPC UA (se ignora si `host` ya es un endpoint completo).",
    )
    vendor: str = Field(
        default="siemens",
        description="Marca del PLC: `siemens` (S7-1500), `rexroth` (ctrlX "
                    "CORE) o `allenbradley` (Logix por EtherNet/IP).",
        examples=["siemens", "rexroth", "allenbradley"],
    )
    slot: int = Field(
        default=0, ge=0, le=31,
        description="Allen-Bradley: slot del procesador en el chasis. "
                    "Siemens por S7comm: slot de la CPU (1 en 1200/1500, 2 en 300).")
    rack: int = Field(default=0, ge=0, le=7, description="Solo Siemens por S7comm.")
    transporte: str = Field(
        default="",
        description="Solo Siemens: `opcua` (defecto) o `s7comm` (puerto 102, "
                    "para S7-1200 sin OPC UA, S7-300/400).")
    s7_tags: str = Field(
        default="",
        description="Solo S7comm: lista de tags, una por línea: "
                    "`nombre;DB1;offset;TIPO` (p. ej. `temperatura;DB1;0;REAL`, "
                    "`marcha;DB1;4.0;BOOL`, `texto;DB1;6;STRING[20]`).")
    usuario: str = Field(
        default="", description="Solo Rexroth: usuario del ctrlX.")
    password: str = Field(
        default="", description="Solo Rexroth: contraseña del ctrlX.")
    app: str = Field(
        default="",
        description="Solo Rexroth (OPCIONAL): aplicación bajo "
                    "`Datalayer/plc/app`. Vacío = se autodetecta.")
    programa: str = Field(
        default="",
        description="Solo Rexroth (OPCIONAL): programa (POU) bajo el nodo "
                    "`sym`. Vacío = se autodetecta.")


class CredencialesRexroth(BaseModel):
    """Credenciales para explorar un ctrlX antes de darlo de alta."""

    host: str = Field(
        ...,
        description="IP, hostname o endpoint completo del ctrlX.",
        examples=["192.168.1.1"],
    )
    # 4840 = "el de siempre": con el transporte Data Layer (defecto) se
    # sustituye por el puerto HTTPS del ctrlX (PLC_REXROTH_HTTPS_PORT, 443).
    puerto: int = Field(default=4840, ge=1, le=65535)
    usuario: str = Field(..., examples=["boschrexroth"])
    password: str = Field(...)


class ProgramasRexroth(CredencialesRexroth):
    """Igual que CredencialesRexroth, más la app cuyos programas se listan."""

    app: str = Field(
        default="",
        description="Aplicación devuelta por `POST /rexroth/apps`. "
                    "Vacío = se autodetecta la primera con símbolos.",
    )


def _endpoint_desde(host: str, puerto: int) -> str:
    """Normaliza IP/hostname/endpoint a un endpoint `opc.tcp://host:puerto`."""
    host = (host or "").strip()
    if not host:
        raise HTTPException(400, "Indica la IP del PLC.")
    if host.startswith("opc.tcp://"):
        return host
    return f"opc.tcp://{host}:{puerto}"


@router.get(
    "/health",
    summary="Estado general del servicio",
    description="Salud agregada: cuántos PLCs hay, cuáles están conectados, "
                "número de tags y de clientes WebSocket.",
    responses={200: {"content": {"application/json": {"example": {
        "status": "ok",
        "num_plcs": 1,
        "plcs_conectados": 1,
        "total_tags": 12,
        "clientes_ws": 3,
        "plcs": [{
            "plc_id": "PLC_2",
            "endpoint": "opc.tcp://192.168.50.1:4840",
            "conectado": True,
            "estado_conexion": "conectado",
            "num_tags": 12,
        }],
    }}}}},
)
async def health(request: Request) -> dict:
    return request.app.state.plc_manager.get_health()


@router.get(
    "/plcs",
    summary="Listar PLCs gestionados",
    description="Ids de los PLCs actualmente monitoreados. Úsalos en `?plc=` "
                "de /tags, /browse y del WebSocket `/ws?plc=<id>`.",
    responses={200: {"content": {"application/json": {"example": {
        "plcs": ["PLC_2", "192.168.50.3"],
    }}}}},
)
async def plcs(request: Request) -> dict:
    return {"plcs": request.app.state.plc_manager.list_plc_ids()}


@router.post(
    "/plcs",
    summary="Agregar un PLC por IP (Siemens o Rexroth)",
    description="Añade un PLC en caliente con la IP (o endpoint `opc.tcp://`) "
                "indicada. Responde de inmediato; la conexión OPC UA se "
                "intenta en segundo plano con reintentos automáticos. Todos "
                "los clientes WebSocket reciben un snapshot actualizado.\n\n"
                "Con `vendor=rexroth` hay que mandar además `usuario` y "
                "`password`. Los campos `app` y `programa` son OPCIONALES: si "
                "se omiten, el driver navega `plc/app/<app>/sym/<programa>` y "
                "toma la primera app con símbolos y su primer programa. Solo "
                "hace falta indicarlos si el ctrlX tiene varios y quieres uno "
                "concreto (consúltalos con `/rexroth/apps` y "
                "`/rexroth/programs`).",
    responses={200: {"content": {"application/json": {"examples": {
        "siemens": {"summary": "S7-1500 añadido", "value": {
            "ok": True, "plc_id": "192.168.50.1",
            "endpoint": "opc.tcp://192.168.50.1:4840", "vendor": "siemens",
            "mensaje": "PLC 192.168.50.1 (siemens) añadido; conectando...",
        }},
        "rexroth": {"summary": "ctrlX CORE añadido", "value": {
            "ok": True, "plc_id": "192.168.1.1",
            "endpoint": "opc.tcp://192.168.1.1:4840", "vendor": "rexroth",
            "mensaje": "PLC 192.168.1.1 (rexroth) añadido; conectando...",
        }},
        "duplicado": {"summary": "Ya existía", "value": {
            "ok": False, "plc_id": "192.168.50.1",
            "endpoint": "opc.tcp://192.168.50.1:4840",
            "mensaje": "Ese PLC ya está gestionado (id=192.168.50.1).",
        }},
    }}}}},
)
async def agregar_plc(
    request: Request,
    sesion: Sesion = Depends(exigir_rol("Administradores")),
    cuerpo: NuevoPlc = Body(..., examples=[
        {"host": "192.168.50.1", "puerto": 4840, "vendor": "siemens"},
        {"host": "192.168.1.1", "puerto": 4840, "vendor": "rexroth",
         "usuario": "boschrexroth", "password": "boschrexroth"},
        {"host": "192.168.1.1", "puerto": 4840, "vendor": "rexroth",
         "usuario": "boschrexroth", "password": "boschrexroth",
         "app": "Application", "programa": "PLC_PRG"},
    ]),
) -> dict:
    _auditar(request, "plc.alta", sesion, cuerpo.host,
             {"vendor": cuerpo.vendor})
    return await request.app.state.plc_manager.add_plc_manual(
        host=cuerpo.host,
        puerto=cuerpo.puerto,
        vendor=cuerpo.vendor,
        usuario=cuerpo.usuario,
        password=cuerpo.password,
        app=cuerpo.app,
        programa=cuerpo.programa,
        slot=cuerpo.slot,
        rack=cuerpo.rack,
        transporte=cuerpo.transporte,
        s7_tags=cuerpo.s7_tags,
    )


@router.delete(
    "/plcs/{plc_id}",
    summary="Quitar un PLC",
    description="Detiene la conexión OPC UA de ese PLC y lo elimina del "
                "monitoreo. Los clientes WebSocket reciben `type: plc_removed`.",
    responses={200: {"content": {"application/json": {"examples": {
        "ok": {"summary": "Eliminado", "value": {
            "ok": True, "plc_id": "192.168.50.1",
            "mensaje": "PLC 192.168.50.1 eliminado.",
        }},
        "no_existe": {"summary": "Id desconocido", "value": {
            "ok": False, "mensaje": "No existe el PLC 'foo'.",
        }},
    }}}}},
)
async def quitar_plc(
    request: Request, plc_id: str,
    sesion: Sesion = Depends(exigir_rol("Administradores")),
) -> dict:
    _auditar(request, "plc.baja", sesion, plc_id)
    return await request.app.state.plc_manager.remove_plc(plc_id)


@router.post(
    "/discover",
    summary="Escanear la red buscando PLCs",
    description="Escanea la subred configurada (PLC_DISCOVERY_SUBNET, o la "
                "derivada del endpoint semilla) en el puerto 4840 y añade los "
                "PLCs nuevos que respondan como servidores OPC UA. Puede "
                "tardar varios segundos.",
    responses={200: {"content": {"application/json": {"example": {
        "ok": True, "encontrados": 2, "nuevos": ["PLC_2"],
        "mensaje": "1 PLC(s) nuevo(s) añadido(s).",
    }}}}},
)
async def redescubrir(
    request: Request,
    sesion: Sesion = Depends(exigir_rol("Administradores")),
) -> dict:
    return await request.app.state.plc_manager.rescan()


@router.get(
    "/tags",
    summary="Tags con su último valor",
    description="Todos los tags descubiertos (browse de Data Blocks) con el "
                "último valor recibido. Filtra con `?plc=<id>`.",
    responses={200: {"content": {"application/json": {"example": {
        "plc": None,
        "tags": [{
            "plc": "PLC_2", "tag": "DB_Datos.Temperatura", "name": "Temperatura",
            "db": "DB_Datos", "node_id": "ns=3;s=\"DB_Datos\".\"Temperatura\"",
            "type": "Float", "value": 23.7,
            "timestamp": "2026-07-14T07:30:00+00:00",
            "source_ts": "2026-07-14T07:29:59.900+00:00", "delta_ms": 512,
        }],
    }}}}},
)
async def tags(request: Request, plc: Optional[str] = None) -> dict:
    lista = request.app.state.plc_manager.get_tags(plc)

    # Las variables INTERNAS se mezclan aquí, y esta línea es la que hace que
    # todo lo demás funcione sin tocarse.
    #
    # No existen en ningún PLC —viven en el servidor— pero se publican con
    # `plc="interno"` y exactamente la misma forma que un tag de campo. Al
    # entrar por `GET /tags`, el selector de variables del inspector, la
    # tendencia, el motor de alarmas y cualquier widget subido por ZIP las
    # ven y las tratan como a las demás, porque para ellos no hay diferencia.
    #
    # Se respeta el filtro `?plc=`: pedir los tags de `PLC_2` no debe traer
    # variables internas, y pedir `?plc=interno` trae solo esas.
    internas = getattr(request.app.state, "internas_store", None)
    if internas is not None and plc in (None, PLC_INTERNO):
        lista = lista + internas.tags()

    return {"plc": plc, "tags": lista}


@router.get(
    "/browse",
    summary="Árbol de tags por Data Block",
    description="Estructura descubierta por browse OPC UA, agrupada por PLC "
                "y Data Block (útil para depuración).",
    responses={200: {"content": {"application/json": {"example": {
        "timestamp": "2026-07-14T07:30:00+00:00",
        "plcs": [{
            "plc": "PLC_2",
            "datablocks": {"DB_Datos": [{
                "name": "Temperatura", "full_name": "DB_Datos.Temperatura",
                "node_id": "ns=3;s=\"DB_Datos\".\"Temperatura\"", "type": "Float",
            }]},
        }],
    }}}}},
)
async def browse(request: Request, plc: Optional[str] = None) -> dict:
    return request.app.state.plc_manager.get_browse(plc)


# ====================================================================== #
# Siemens: ¿qué CPU es y por dónde se puede hablar con ella?
# ====================================================================== #
class SondeoSiemens(BaseModel):
    host: str = Field(..., examples=["192.168.0.10"])
    rack: int = Field(default=0, ge=0, le=7)
    slot: Optional[int] = Field(default=None, ge=0, le=31,
                                description="Vacío = probar 1, 2 y 0.")


@router.post(
    "/siemens/identificar",
    summary="Identificar una CPU Siemens y decir por qué transporte conectar",
    description="Pregunta la identidad de la CPU por S7comm (puerto 102, que "
                "responde en cualquier S7 aunque el OPC UA no exista) y "
                "comprueba si hay servidor OPC UA en el 4840. Con eso dice el "
                "modelo (CPU 1214C, CPU 1516-3...) y qué transporte usar.",
    responses={
        200: {"content": {"application/json": {"example": {
            "ok": True, "modelo": "CPU 1214C DC/DC/Rly", "familia": "S7-1200",
            "nombre": "PLC_2", "estado": "Run", "rack": 0, "slot": 1,
            "opcua": False, "transporte_sugerido": "s7comm",
            "mensaje": "Es un S7-1200 y no responde en el 4840: ...",
        }}}},
        502: {"description": "No responde ni en el 102 ni en el 4840."},
    },
)
async def siemens_identificar(cuerpo: SondeoSiemens) -> dict:
    import asyncio as _asyncio
    from app.drivers.s7comm_driver import identificar

    host = (cuerpo.host or "").strip().split("://")[-1].split("/")[0].split(":")[0]
    if not host:
        raise HTTPException(400, "Indica la IP del PLC.")

    # ¿Hay algo escuchando en el 4840? Solo el socket: abrir sesión OPC UA
    # tarda y aquí solo hace falta saber si existe.
    async def hay_opcua() -> bool:
        try:
            _r, w = await _asyncio.wait_for(
                _asyncio.open_connection(host, 4840), timeout=2.0)
            w.close()
            try:
                await w.wait_closed()
            except Exception:  # noqa: BLE001
                pass
            return True
        except Exception:  # noqa: BLE001
            return False

    tarea_opcua = _asyncio.create_task(hay_opcua())
    info: dict = {}
    error_s7 = ""
    try:
        info = await identificar(host, cuerpo.rack, cuerpo.slot)
    except Exception as exc:  # noqa: BLE001
        error_s7 = str(exc)
    opcua = await tarea_opcua

    # Sin el paquete no se ha sondeado nada: decirlo como "el PLC no
    # responde" mandaría a revisar cables cuando lo que falta es un pip.
    if "No module named 'snap7'" in error_s7 or "ModuleNotFoundError" in error_s7:
        raise HTTPException(
            500,
            "Falta el paquete 'python-snap7' en el entorno del backend: "
            "ejecuta  pip install python-snap7  y reinicia el servicio. Sin "
            "él no se puede hablar S7comm (puerto 102) con ningún Siemens.",
        )

    if not info and not opcua:
        raise HTTPException(
            502,
            f"{host} no responde ni por S7comm (puerto 102) ni por OPC UA "
            f"(4840). Revisa la IP y la red (¿hace ping?). Detalle: {error_s7}",
        )

    familia = info.get("familia", "S7")
    modelo = info.get("modelo", "")
    if info and not modelo:
        # Conecta por el 102 pero no dice su modelo: típico del S7-1200.
        modelo = "CPU Siemens (responde por S7comm; no publica su modelo, " \
                 "típico del S7-1200)"
    if opcua:
        sugerido = "opcua"
        mensaje = (f"{modelo or 'La CPU'} tiene servidor OPC UA activo: se "
                   f"conecta por OPC UA y descubre los DB solo.")
    elif familia == "S7-1200":
        sugerido = "s7comm"
        mensaje = (f"{modelo} es un S7-1200 y no responde en el 4840: o el "
                   f"firmware es anterior a 4.4 o el servidor OPC UA no está "
                   f"activado (Propiedades → OPC UA → Servidor, con licencia). "
                   f"Conecta por S7comm: en TIA marca 'Permitir acceso PUT/GET' "
                   f"en la CPU, desmarca 'Acceso optimizado' en los DB que "
                   f"quieras leer, y escribe aquí la lista de tags.")
    elif familia in ("S7-300", "S7-400"):
        sugerido = "s7comm"
        mensaje = f"{modelo}: sin OPC UA. Conecta por S7comm (slot {info.get('slot')})."
    else:
        sugerido = "s7comm"
        mensaje = (f"{modelo or 'La CPU'} no responde en el 4840. Activa el "
                   f"servidor OPC UA en TIA Portal o conecta por S7comm.")
    return {"ok": True, **info, "opcua": opcua, "transporte_sugerido": sugerido,
            "mensaje": mensaje, "error_s7comm": error_s7}


class FuenteTia(BaseModel):
    nombre: str = Field(..., description="Nombre del fichero (.db, .udt, .scl).")
    contenido: str = Field(..., max_length=4_000_000)


class ImportarSiemens(BaseModel):
    host: str = Field(default="", description="IP del PLC para sondear qué DB "
                                             "existen. Vacío = no se sondea.")
    rack: int = Field(default=0, ge=0, le=7)
    slot: int = Field(default=1, ge=0, le=31)
    fuentes: List[FuenteTia] = Field(..., min_length=1, max_length=50)


@router.post(
    "/siemens/importar",
    summary="Calcular los tags de S7comm a partir de las fuentes de TIA Portal",
    description="Recibe los ficheros que genera TIA con «Generate source from "
                "blocks» (.db, .udt, .scl), calcula el offset de cada variable "
                "con las reglas de un DB de acceso estándar, y —si llega la IP— "
                "sondea el PLC para saber qué DB existen y de qué tamaño, para "
                "emparejar cada bloque con su número. Es lo que evita que nadie "
                "tenga que escribir offsets a mano.",
    responses={200: {"content": {"application/json": {"example": {
        "ok": True,
        "bloques": [{"nombre": "Data_block_1", "clase": "global", "optimizado": False,
                     "tamano": 10, "db": 1, "db_como": "tamaño",
                     "tags": [{"nombre": "prueba_variable", "offset": 0, "bit": 0,
                               "tipo": "BOOL", "linea": "prueba_variable;DB1;0.0;BOOL"}],
                     "avisos": []}],
        "dbs_plc": {"1": 10, "7": 56},
        "avisos": [],
    }}}}},
)
async def siemens_importar(cuerpo: ImportarSiemens) -> dict:
    from app.drivers.s7_fuentes import numero_en_nombre, parsear_fuentes
    from app.drivers.s7comm_driver import sondear_dbs

    bloques, avisos = parsear_fuentes([(f.nombre, f.contenido) for f in cuerpo.fuentes])

    # Qué DB hay de verdad en el PLC, y de qué tamaño.
    dbs_plc: Dict[int, int] = {}
    host = (cuerpo.host or "").strip().split("://")[-1].split("/")[0].split(":")[0]
    if host:
        candidatos = set(range(1, 41))
        for b in bloques:
            n = numero_en_nombre(b.nombre)
            if n:
                candidatos.add(n)
        try:
            dbs_plc = await sondear_dbs(host, cuerpo.rack, cuerpo.slot, sorted(candidatos))
        except Exception as exc:  # noqa: BLE001
            avisos.append(f"No se pudo sondear los DB del PLC ({exc}); asigna el "
                          f"número de DB a mano.")

    # Emparejar cada bloque con un número de DB:
    #   1) el nombre lo dice ("Data_block_1", "DB7_x") y ese DB existe;
    #   2) hay UN solo DB en el PLC con exactamente su tamaño;
    #   3) el nombre lo dice aunque no se haya podido sondear;
    #   4) nada: que lo elija el usuario.
    usados: set = set()
    salida_bloques = []
    for b in bloques:
        db: Optional[int] = None
        como = ""
        por_nombre = numero_en_nombre(b.nombre) if b.clase != "pegado" else None
        if por_nombre and por_nombre in dbs_plc and por_nombre not in usados:
            db, como = por_nombre, "nombre"
        elif dbs_plc and b.tamano:
            iguales = [n for n, t in dbs_plc.items() if t == b.tamano and n not in usados]
            if len(iguales) == 1:
                db, como = iguales[0], "tamaño"
        if db is None and por_nombre and not dbs_plc:
            db, como = por_nombre, "nombre (sin sondear)"
        if db is not None:
            usados.add(db)
            if dbs_plc and b.tamano and dbs_plc.get(db) not in (None, b.tamano):
                b.avisos.append(
                    f"El DB{db} del PLC mide {dbs_plc[db]} bytes y la fuente calcula "
                    f"{b.tamano}: puede que el PLC tenga otra versión del bloque "
                    f"(compila y carga) o que la fuente no sea de este proyecto.")
        salida_bloques.append({
            "nombre": b.nombre, "clase": b.clase, "base": b.base,
            "optimizado": b.optimizado, "tamano": b.tamano,
            "db": db, "db_como": como,
            "tags": [{"nombre": t.nombre, "offset": t.offset, "bit": t.bit,
                      "tipo": t.tipo, "longitud": t.longitud,
                      "linea": t.linea(db or 0)} for t in b.tags],
            "avisos": b.avisos,
        })
    return {"ok": True, "bloques": salida_bloques,
            "dbs_plc": {str(k): v for k, v in sorted(dbs_plc.items())},
            "avisos": avisos}


# ====================================================================== #
# Allen-Bradley: identificar el controlador antes de darlo de alta
# ====================================================================== #
class SondeoAllenBradley(BaseModel):
    host: str = Field(..., examples=["192.168.1.10"])
    slot: int = Field(default=0, ge=0, le=31)


@router.post(
    "/allenbradley/identificar",
    summary="Identificar un PLC Allen-Bradley por EtherNet/IP",
    description="Abre una sesión CIP temporal y devuelve la identidad del "
                "controlador: nombre del proyecto, modelo, revisión y posición "
                "del selector. No hay credenciales: EtherNet/IP no autentica.",
    responses={
        200: {"content": {"application/json": {"example": {
            "ok": True, "endpoint": "enip://192.168.1.10:44818/0",
            "nombre": "Linea_2", "producto": "1769-L33ER/A LOGIX5333ER",
            "revision": {"major": 32, "minor": 11}, "modo": "REMOTE RUN",
        }}}},
        502: {"description": "No responde en 44818 o el slot no tiene CPU."},
    },
)
async def allenbradley_identificar(cuerpo: SondeoAllenBradley) -> dict:
    from app.config.settings import get_settings
    from app.drivers.ethernetip_driver import endpoint_enip, host_de, probar

    host = host_de(cuerpo.host)
    if not host:
        raise HTTPException(400, "Indica la IP del PLC.")
    estado, info = await probar(
        host, cuerpo.slot,
        float(getattr(get_settings(), "ab_connect_timeout", 5.0)))
    if estado != "OK":
        raise HTTPException(
            502,
            f"No se pudo contactar con el PLC en {host} (slot {cuerpo.slot}) "
            f"por EtherNet/IP. Revisa la IP, que el puerto 44818 esté abierto "
            f"y el slot del procesador. Detalle: {info.get('error', '')}",
        )
    return {"ok": True, "endpoint": endpoint_enip(host, cuerpo.slot), **info}


# ====================================================================== #
# Bosch Rexroth ctrlX: exploración previa al alta del PLC
# ====================================================================== #
def _usa_datalayer() -> bool:
    """¿El transporte Rexroth configurado es el Data Layer REST (defecto)?"""
    from app.config.settings import get_settings
    t = (getattr(get_settings(), "rexroth_transporte", "datalayer") or "datalayer")
    return t.strip().lower() != "opcua"


def _puerto_https(host: str, puerto: int) -> int:
    """
    Puerto HTTPS del ctrlX para el Data Layer. La vista manda 4840 por
    costumbre del OPC UA; aquí no significa nada y se cae al configurado.
    """
    from app.config.settings import get_settings
    from app.drivers.ctrlx_datalayer_driver import puerto_de
    explicito = puerto_de(host, 0)
    if explicito:
        return explicito
    if not puerto or puerto == 4840:
        return int(getattr(get_settings(), "rexroth_https_port", 443))
    return puerto


async def _explorar_datalayer(cuerpo: CredencialesRexroth, listar, *args):
    """
    Igual que `_explorar_ctrlx`, pero por el Data Layer REST: login con JWT,
    sin certificado que aceptar. Distingue credenciales malas (401) de equipo
    caído (502), que es lo que la pantalla necesita para decir qué revisar.
    """
    from app.config.settings import get_settings
    from app.drivers.ctrlx_datalayer_driver import (
        ErrorCredenciales, abrir_sesion, host_de,
    )

    if not cuerpo.usuario or not cuerpo.password:
        raise HTTPException(400, "El ctrlX necesita usuario y contraseña.")
    host = host_de(cuerpo.host)
    puerto = _puerto_https(cuerpo.host, cuerpo.puerto)
    try:
        cliente = await abrir_sesion(host, puerto, cuerpo.usuario,
                                     cuerpo.password, get_settings())
    except ErrorCredenciales as exc:
        raise HTTPException(401, str(exc))
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(
            502,
            f"No se pudo contactar con el ctrlX en https://{host}:{puerto}. "
            f"Revisa la IP, que el equipo esté encendido y el puerto HTTPS "
            f"({puerto}). Detalle: {exc}",
        )
    try:
        return await listar(cliente, *args)
    except RuntimeError as exc:
        raise HTTPException(404, str(exc))
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(502, f"{type(exc).__name__}: {exc}")
    finally:
        await cliente.close()


async def _explorar_ctrlx(cuerpo: CredencialesRexroth, listar, *args):
    """
    Abre una sesión temporal contra el ctrlX, ejecuta `listar` y cierra.

    Se conecta y desconecta en cada llamada a propósito: esto ocurre en la
    pantalla de login, antes de que el PLC exista como tal, así que no hay
    ningún driver ni sesión persistente que reutilizar.

    Es el camino OPC UA (`PLC_REXROTH_TRANSPORTE=opcua`). El defecto es el
    Data Layer, en `_explorar_datalayer`.
    """
    # Import local: `cryptography` solo se necesita para PLCs Rexroth.
    from app.config.settings import get_settings
    from app.drivers.rexroth_driver import conectar_ctrlx

    endpoint = _endpoint_desde(cuerpo.host, cuerpo.puerto)
    if not cuerpo.usuario or not cuerpo.password:
        raise HTTPException(400, "El ctrlX necesita usuario y contraseña.")

    try:
        cliente = await conectar_ctrlx(
            endpoint, cuerpo.usuario, cuerpo.password, get_settings()
        )
    except Exception as exc:  # noqa: BLE001
        # 401: credenciales/seguridad. Es el caso más común y conviene
        # distinguirlo de "conecté pero no encontré nada".
        raise HTTPException(
            401,
            f"No se pudo abrir sesión con {endpoint}. Revisa usuario, "
            f"contraseña y que el certificado del cliente esté aceptado en el "
            f"ctrlX. Detalle: {exc}",
        )

    try:
        return await listar(cliente, *args)
    except RuntimeError as exc:
        # Conectó, pero el árbol esperado no está (proyecto sin publicar).
        raise HTTPException(404, str(exc))
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(502, f"{type(exc).__name__}: {exc}")
    finally:
        try:
            await cliente.disconnect()
        except Exception:  # noqa: BLE001
            pass


@router.post(
    "/rexroth/apps",
    summary="Listar aplicaciones PLC de un ctrlX",
    description="Abre una sesión temporal con el ctrlX y devuelve las "
                "aplicaciones publicadas bajo `Datalayer/plc/app` que exponen "
                "símbolos. Normalmente hay una sola: `Application`.",
    responses={
        200: {"content": {"application/json": {"example": {
            "ok": True, "endpoint": "opc.tcp://192.168.1.1:4840",
            "apps": ["Application"],
        }}}},
        401: {"description": "Credenciales inválidas o certificado no aceptado."},
        404: {"description": "Conectó, pero no hay símbolos publicados."},
    },
)
async def rexroth_apps(
    cuerpo: CredencialesRexroth = Body(..., examples=[{
        "host": "192.168.1.1", "puerto": 4840,
        "usuario": "boschrexroth", "password": "boschrexroth",
    }]),
) -> dict:
    if _usa_datalayer():
        async def _apps_dl(cliente):
            apps = await cliente.listar_apps()
            if not apps:
                raise RuntimeError(
                    "El ctrlX no publica ninguna aplicación PLC bajo "
                    "'plc/app'. ¿Está cargado y en RUN el proyecto?")
            return apps
        apps = await _explorar_datalayer(cuerpo, _apps_dl)
        from app.drivers.ctrlx_datalayer_driver import host_de
        return {"ok": True, "transporte": "datalayer",
                "endpoint": f"https://{host_de(cuerpo.host)}:"
                            f"{_puerto_https(cuerpo.host, cuerpo.puerto)}",
                "apps": apps}

    from app.drivers.rexroth_driver import listar_apps

    apps = await _explorar_ctrlx(cuerpo, listar_apps)
    return {
        "ok": True,
        "transporte": "opcua",
        "endpoint": _endpoint_desde(cuerpo.host, cuerpo.puerto),
        "apps": apps,
    }


@router.post(
    "/rexroth/programs",
    summary="Listar programas (POUs) de una aplicación del ctrlX",
    description="Devuelve los hijos del nodo `sym` de la aplicación indicada, "
                "es decir los programas cuyos símbolos se pueden leer. Si sale "
                "vacío, publica el proyecto desde la configuración de símbolos "
                "del PLC.",
    responses={
        200: {"content": {"application/json": {"example": {
            "ok": True, "endpoint": "opc.tcp://192.168.1.1:4840",
            "app": "Application", "programas": ["PLC_PRG", "MotionProg"],
        }}}},
        401: {"description": "Credenciales inválidas o certificado no aceptado."},
        404: {"description": "La app no expone programas en `sym`."},
    },
)
async def rexroth_programas(
    cuerpo: ProgramasRexroth = Body(..., examples=[{
        "host": "192.168.1.1", "puerto": 4840,
        "usuario": "boschrexroth", "password": "boschrexroth",
    }]),
) -> dict:
    if _usa_datalayer():
        async def _listar_dl(cliente):
            app_sel = (cuerpo.app or "").strip()
            if not app_sel:
                apps = await cliente.listar_apps()
                if not apps:
                    raise RuntimeError(
                        "El ctrlX no publica ninguna aplicación PLC bajo "
                        "'plc/app'. ¿Está cargado y en RUN el proyecto?")
                app_sel = "Application" if "Application" in apps else apps[0]
            programas = await cliente.listar_programas(app_sel)
            if not programas:
                raise RuntimeError(
                    f"'plc/app/{app_sel}/sym' no tiene programas. Publica los "
                    f"símbolos del proyecto (Symbol Configuration) en el ctrlX.")
            return app_sel, programas
        app_sel, programas = await _explorar_datalayer(cuerpo, _listar_dl)
        from app.drivers.ctrlx_datalayer_driver import host_de
        return {"ok": True, "transporte": "datalayer",
                "endpoint": f"https://{host_de(cuerpo.host)}:"
                            f"{_puerto_https(cuerpo.host, cuerpo.puerto)}",
                "app": app_sel, "programas": programas}

    from app.drivers.rexroth_driver import listar_apps, listar_programas

    async def _listar(cliente):
        # Si no llega `app`, se toma la primera que exponga símbolos.
        app_sel = (cuerpo.app or "").strip()
        if not app_sel:
            app_sel = (await listar_apps(cliente))[0]
        return app_sel, await listar_programas(cliente, app_sel)

    app_sel, programas = await _explorar_ctrlx(cuerpo, _listar)
    return {
        "ok": True,
        "transporte": "opcua",
        "endpoint": _endpoint_desde(cuerpo.host, cuerpo.puerto),
        "app": app_sel,
        "programas": programas,
    }
