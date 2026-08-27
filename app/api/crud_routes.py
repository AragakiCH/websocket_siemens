# -*- coding: utf-8 -*-
"""
crud_routes.py
==============
CRUD sobre las tablas del esquema del HMI.

Cuatro endpoints genéricos que cubren `alarmas`, `recetas` y la lectura de
`plc_prg`, en vez de doce endpoints casi idénticos:

  GET    /crud                    -> catálogo: qué recursos y campos hay.
  GET    /crud/{recurso}          -> listar con filtros, rango y paginación.
  GET    /crud/{recurso}/{id}     -> obtener uno.
  POST   /crud/{recurso}          -> crear.
  PATCH  /crud/{recurso}/{id}     -> actualizar (solo los campos enviados).
  DELETE /crud/{recurso}/{id}     -> borrar.

**Seguridad.** El nombre del recurso no llega al SQL: se busca en un catálogo
cerrado, y de él salen la tabla y las columnas permitidas. Los valores van
bindeados. Un campo que no esté declarado se descarta sin más.

**Qué NO está aquí y por qué:**

  * `usuarios` -> se gestiona en `/auth`. Crear un usuario no es un INSERT:
    es hashear la contraseña y validar el rol. Un CRUD genérico permitiría
    escribir directamente en `password_hash`.
  * `plc_prg` -> solo lectura. La escribe el historizador por lotes; dejar
    insertar filas a mano corrompería el histórico con datos que no vinieron
    del PLC.
"""
from __future__ import annotations

from typing import Any, Dict, Optional

from fastapi import APIRouter, Body, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field

from app.api.auth_routes import exigir_rol, usuario_de
from app.core.auth_manager import Sesion
from app.core.crud_manager import ErrorCrud

router = APIRouter()
TAG = ["CRUD (alarmas y recetas)"]


def _crud(request: Request):
    manager = getattr(request.app.state, "crud_manager", None)
    if manager is None:
        raise HTTPException(503, "El CRUD no está disponible.")
    return manager


def _error(exc: ErrorCrud) -> HTTPException:
    return HTTPException(exc.codigo, exc.mensaje)


class CuerpoLibre(BaseModel):
    """
    Cuerpo abierto: los campos válidos dependen del recurso.

    Se validan contra el catálogo del `CrudManager`, no aquí, porque las
    columnas de `alarmas` y `recetas` son distintas. `GET /crud` los lista.
    """

    model_config = {"extra": "allow"}


# ====================================================================== #
@router.get(
    "/crud",
    tags=TAG,
    summary="Catálogo de recursos y campos",
    description="Qué recursos expone el CRUD, con sus columnas, cuáles son "
                "obligatorias, cuáles se pueden filtrar y cuáles editar.\n\n"
                "Sirve para que la vista construya formularios y tablas sin "
                "tener los campos escritos a mano: si mañana se añade una "
                "columna al esquema, aparece aquí.",
    responses={200: {"content": {"application/json": {"example": {
        "recursos": [{
            "recurso": "recetas", "tabla": "recetas", "solo_lectura": False,
            "obligatorias": ["nombre", "nombre_receta", "tag"],
            "filtros": ["nombre_receta", "tag", "tipo_dato", "activo"],
            "columnas": {"id": "entero", "nombre": "texto",
                         "valor_minimo": "numero"},
        }],
    }}}}},
)
async def catalogo(request: Request) -> dict:
    return _crud(request).catalogo()


@router.get(
    "/crud/{recurso}",
    tags=TAG,
    summary="Listar registros",
    description="Lista con filtros, rango de fechas y paginación.\n\n"
                "Los filtros se pasan como parámetros de query con el nombre "
                "de la columna: `?estado=activa&severidad=1`. Solo se aceptan "
                "las columnas declaradas como filtrables (ver `GET /crud`); "
                "el resto se ignoran.\n\n"
                "`total` indica cuántos registros hay en total con esos "
                "filtros, para poder paginar en la vista.",
    responses={200: {"content": {"application/json": {"example": {
        "ok": True, "recurso": "alarmas", "tabla": "alarmas",
        "total": 128, "limite": 100, "offset": 0,
        "columnas": ["id", "tipo", "mensaje", "estado", "ts_activacion"],
        "filas": [{"id": 42, "tipo": "proceso", "mensaje": "Temperatura alta",
                   "estado": "activa",
                   "ts_activacion": "2026-08-25T10:12:03+00:00"}],
        "num_filas": 1, "truncado": False, "ms": 8.2,
    }}}}},
)
async def listar(
    request: Request,
    recurso: str,
    db_id: Optional[str] = Query(
        default=None,
        description="Conexión a usar. Si se omite, la del esquema del HMI."),
    desde: Optional[str] = Query(
        default=None, description="Fecha inicial ISO 8601."),
    hasta: Optional[str] = Query(default=None, description="Fecha final."),
    orden: Optional[str] = Query(
        default=None, description="Columna por la que ordenar."),
    descendente: bool = Query(default=True),
    limite: int = Query(default=100, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
) -> dict:
    # Todo lo que no sea un parámetro conocido se trata como filtro por columna.
    reservados = {"db_id", "desde", "hasta", "orden", "descendente",
                  "limite", "offset"}
    filtros: Dict[str, Any] = {
        k: v for k, v in request.query_params.items() if k not in reservados}
    try:
        return await _crud(request).listar(
            recurso, db_id, filtros, desde, hasta, orden, descendente,
            limite, offset)
    except ErrorCrud as exc:
        raise _error(exc)


@router.get(
    "/crud/{recurso}/{id_}",
    tags=TAG,
    summary="Obtener un registro",
    responses={404: {"description": "No existe ese id."}},
)
async def obtener(
    request: Request,
    recurso: str,
    id_: int,
    db_id: Optional[str] = Query(default=None),
) -> dict:
    try:
        return await _crud(request).obtener(recurso, id_, db_id)
    except ErrorCrud as exc:
        raise _error(exc)


@router.post(
    "/crud/{recurso}",
    tags=TAG,
    summary="Crear un registro",
    description="Crea una alarma o una receta. Los campos válidos son los que "
                "devuelve `GET /crud`; cualquier otro se descarta.\n\n"
                "**Validaciones de negocio** (más allá del tipo de dato):\n\n"
                "- *recetas*: `valor_minimo <= valor_maximo`, y `valor_default` "
                "dentro del rango. Estos números acaban escribiéndose en una "
                "máquina real: un rango invertido convierte la última barrera "
                "de seguridad en un adorno.\n"
                "- *alarmas*: `severidad` entre 1 (crítica) y 5 (informativa), "
                "y `estado` en `activa | reconocida | normalizada`.\n\n"
                "Las marcas de tiempo (`creado_en`, `ts_activacion`) las pone "
                "el servidor: no se aceptan del cliente.",
    responses={
        200: {"content": {"application/json": {"example": {
            "ok": True, "recurso": "recetas", "tabla": "recetas",
            "mensaje": "Receta creado."}}}},
        400: {"description": "Falta un campo obligatorio o una regla no se cumple."},
        409: {"description": "La tabla no existe, o hay una FK inválida."},
    },
)
async def crear(
    request: Request,
    recurso: str,
    sesion: Sesion = Depends(exigir_rol("Usuarios")),
    db_id: Optional[str] = Query(default=None),
    cuerpo: CuerpoLibre = Body(..., openapi_examples={
        "alarma_def_discreta": {
            "summary": "DEFINICIÓN de alarma discreta (recurso: alarmas_def)",
            "description": "Equivale a una fila de «Discrete alarms» en TIA "
                           "Portal. Es la CONFIGURACIÓN —qué vigilar—, no un "
                           "evento: se crea una vez y no cambia en meses.\n\n"
                           "`comparador: bit` significa que se mira el bit "
                           "`bit_disparo` del tag, igual que el «Trigger bit» "
                           "de TIA.",
            "value": {
                "nombre": "Alarma_1",
                "texto": "Fallo de comunicación con PLC",
                "clase": "Error",
                "tag": "192.168.50.1|DB_snap7.estado_com",
                "bit_disparo": 0,
                "comparador": "bit",
                "tag_reconocimiento": "192.168.50.1|DB_snap7.ack_alarmas",
                "bit_reconocimiento": 0,
                "area": "Sala eléctrica",
                "activo": 1,
            },
        },
        "alarma_def_analogica": {
            "summary": "DEFINICIÓN de alarma analógica (recurso: alarmas_def)",
            "description": "TIA las trata en una tabla aparte; aquí caben en "
                           "la misma porque lo único que cambia es la "
                           "comparación.\n\n"
                           "`banda_muerta` es la histéresis: sin ella, un "
                           "valor oscilando en el límite generaría cientos de "
                           "eventos por minuto.",
            "value": {
                "nombre": "Temp_Reactor_Alta",
                "texto": "Temperatura del reactor por encima de 80 °C",
                "clase": "Critical",
                "tag": "192.168.50.1|DB_snap7.temperatura",
                "comparador": ">",
                "valor_limite": 80.0,
                "banda_muerta": 2.0,
                "area": "Reactor 1",
                "activo": 1,
            },
        },
        "receta_cabecera": {
            "summary": "1· LA RECETA (recurso: recetas)",
            "description": "El primer nivel de TIA: la receta en sí. Es lo que "
                           "el PLC selecciona por `numero`, no por nombre.\n\n"
                           "`comprobar_limites` es el «Check limits» de TIA, y "
                           "no es decorativo: con él activo el backend valida "
                           "cada valor contra el mín/máx de su elemento ANTES "
                           "de escribirlo en la máquina.",
            "value": {
                "nombre": "Recipe_1",
                "nombre_visible": "Pisco Sour",
                "numero": 1,
                "version": "27/8/2026",
                "ruta": "\\Flash\\Recipes",
                "tipo": "Limited",
                "max_registros": 500,
                "tipo_comunicacion": "Tags",
                "comprobar_limites": 1,
                "activo": 1,
            },
        },
        "receta_elemento": {
            "summary": "2· UN ELEMENTO (recurso: receta_elementos)",
            "description": "Una columna de la receta: qué tag es, de qué tipo "
                           "y entre qué límites puede moverse.\n\n"
                           "`valor_minimo` y `valor_maximo` son la última "
                           "barrera antes de mandar un valor a una máquina "
                           "real: si alguien teclea 900 donde el máximo son "
                           "90, se rechaza en el servidor.",
            "value": {
                "receta_id": 1,
                "nombre": "limon",
                "nombre_visible": "Zumo de limón",
                "tag": "192.168.50.1|DB_snap7.limon_ml",
                "tipo_dato": "REAL",
                "valor_default": 30.0,
                "valor_minimo": 10.0,
                "valor_maximo": 80.0,
                "decimales": 1,
                "lugar_decimal": 1,
                "unidad": "ml",
                "informacion_herramienta": "Zumo recién exprimido.",
                "orden": 0,
                "activo": 1,
            },
        },
        "receta_registro": {
            "summary": "3· UN DATA RECORD (recurso: receta_registros)",
            "description": "La cabecera de una mezcla concreta. Sus valores "
                           "van aparte, en `receta_valores`: uno por elemento.",
            "value": {
                "receta_id": 1,
                "nombre": "Recipe_data_record_1",
                "nombre_visible": "Mezcla clásica",
                "numero": 1,
                "comentario": "La proporción de siempre.",
                "activo": 1,
            },
        },
        "receta_valor": {
            "summary": "4· UN VALOR del data record (recurso: receta_valores)",
            "description": "Una celda de la rejilla que enseña TIA. Se guarda "
                           "en formato ESTRECHO —una fila por (registro, "
                           "elemento)— para que añadir un ingrediente nuevo no "
                           "obligue nunca a un ALTER TABLE. La rejilla ancha "
                           "se reconstruye al leer.\n\n"
                           "`valor_num` para los numéricos, `valor_texto` para "
                           "los STRING: así conviven tipos distintos sin "
                           "inventar una columna por tipo.",
            "value": {
                "receta_registro_id": 1,
                "receta_elemento_id": 1,
                "valor_num": 30.0,
            },
        },
        "alarma_evento": {
            "summary": "EVENTO de alarma (recurso: alarmas)",
            "description": "Lo que PASÓ. Normalmente lo escribe el motor de "
                           "alarmas, no una persona. `alarma_def_id` enlaza "
                           "con la definición que lo produjo; va vacío en las "
                           "alarmas de sistema, que no vienen de ninguna regla "
                           "configurada.",
            "value": {
                "alarma_def_id": 2,
                "tipo": "proceso",
                "area": "Reactor 1",
                "severidad": 2,
                "mensaje": "Temperatura por encima del límite",
                "tag": "192.168.50.1|DB_snap7.temperatura",
                "valor_disparo": 94.3,
                "estado": "activa",
            },
        },
    }),
) -> dict:
    try:
        resultado = await _crud(request).crear(
            recurso, cuerpo.model_dump(), db_id)
    except ErrorCrud as exc:
        raise _error(exc)
    await _avisar(request, sesion, recurso, "creado")
    return resultado


@router.patch(
    "/crud/{recurso}/{id_}",
    tags=TAG,
    summary="Actualizar un registro",
    description="Actualiza **solo los campos enviados**; el resto se dejan "
                "como estaban. Se aplican las mismas validaciones de negocio "
                "que al crear.\n\n"
                "Caso típico en alarmas: reconocer una alarma enviando "
                "`{\"estado\": \"reconocida\", \"usuario_id\": 3}`.",
    responses={404: {"description": "No existe ese id."}},
)
async def actualizar(
    request: Request,
    recurso: str,
    id_: int,
    sesion: Sesion = Depends(exigir_rol("Usuarios")),
    db_id: Optional[str] = Query(default=None),
    cuerpo: CuerpoLibre = Body(..., openapi_examples={
        "reconocer": {
            "summary": "Reconocer una alarma",
            "value": {"estado": "reconocida", "usuario_id": 3},
        },
        "ajustar_elemento": {
            "summary": "Cambiar el rango de un elemento (receta_elementos)",
            "description": "Se valida que el default siga dentro del rango: "
                           "subir un mínimo por encima del valor por defecto "
                           "dejaría una receta que no se puede cargar.",
            "value": {"valor_minimo": 15.0, "valor_default": 35.0},
        },
        "corregir_valor": {
            "summary": "Corregir un valor del data record (receta_valores)",
            "value": {"valor_num": 32.5},
        },
        "desactivar_definicion": {
            "summary": "Silenciar una definición de alarma (alarmas_def)",
            "description": "Poner `activo: 0` deja de generar eventos nuevos "
                           "sin borrar la regla ni su historial. Es lo que se "
                           "quiere durante un mantenimiento programado.",
            "value": {"activo": 0},
        },
        "cambiar_umbral": {
            "summary": "Subir el umbral de una alarma analógica",
            "value": {"valor_limite": 85.0, "banda_muerta": 3.0},
        },
    }),
) -> dict:
    try:
        resultado = await _crud(request).actualizar(
            recurso, id_, cuerpo.model_dump(), db_id)
    except ErrorCrud as exc:
        raise _error(exc)
    await _avisar(request, sesion, recurso, "actualizado")
    return resultado


@router.delete(
    "/crud/{recurso}/{id_}",
    tags=TAG,
    summary="Borrar un registro",
    description="Elimina la fila. Requiere rol **Administradores**: borrar "
                "una receta o el histórico de una alarma no debería estar al "
                "alcance de cualquier operario.",
    responses={
        404: {"description": "No existe ese id."},
        405: {"description": "El recurso es de solo lectura (plc_prg)."},
    },
)
async def borrar(
    request: Request,
    recurso: str,
    id_: int,
    sesion: Sesion = Depends(exigir_rol("Administradores")),
    db_id: Optional[str] = Query(default=None),
) -> dict:
    try:
        resultado = await _crud(request).borrar(recurso, id_, db_id)
    except ErrorCrud as exc:
        raise _error(exc)
    await _avisar(request, sesion, recurso, "borrado")
    return resultado


# ====================================================================== #
async def _avisar(request: Request, sesion, recurso: str, accion: str) -> None:
    """
    Difunde `config.updated` para que todas las pantallas se refresquen.

    Sin esto, el operario 2 seguiría viendo una alarma que el operario 1 acaba
    de reconocer — que es justo la confusión que el multiusuario debe evitar.
    """
    try:
        await request.app.state.manager.difundir_config(
            recurso, usuario_de(sesion), accion)
    except Exception:  # noqa: BLE001
        pass
