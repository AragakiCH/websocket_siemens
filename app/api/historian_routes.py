# -*- coding: utf-8 -*-
"""
historian_routes.py
===================
Endpoints del HISTORIZADOR: guardar en base de datos los tags de los PLCs.

Es el camino de ESCRITURA del sistema, separado del de los widgets:

  * El usuario elige en la vista QUÉ tags quiere guardar y en qué conexión.
  * El backend escucha el mismo flujo que alimenta el WebSocket (no abre una
    segunda sesión OPC UA) y va escribiendo por lotes.
  * Los widgets luego LEEN ese histórico, con las consultas de siempre o con
    el atajo `GET /historian/{grupo_id}/datos`.

  GET    /historian                  -> grupos con su estado y estadísticas.
  POST   /historian                  -> crear/actualizar un grupo.
  DELETE /historian/{grupo_id}       -> eliminar un grupo (no borra los datos).
  POST   /historian/{grupo_id}/start -> reanudar la captura.
  POST   /historian/{grupo_id}/stop  -> pausar la captura.
  POST   /historian/flush            -> forzar el volcado del buffer.
  GET    /historian/{grupo_id}/datos -> leer el histórico (widget de tendencia).
"""
from __future__ import annotations

from typing import List, Optional

from fastapi import APIRouter, Body, Depends, Query, Request
from pydantic import BaseModel, Field

from app.api.auth_routes import exigir_rol, usuario_de
from app.core.auth_manager import Sesion

router = APIRouter()


async def _avisar(request: Request, sesion=None, accion: str = "") -> None:
    """Difunde `config.updated` del recurso 'historicos' a todas las pantallas."""
    try:
        await request.app.state.manager.difundir_config(
            "historicos", usuario_de(sesion), accion)
    except Exception:  # noqa: BLE001
        pass

TAG = ["Historizador (PLC → BD)"]


class NuevoGrupo(BaseModel):
    """Cuerpo de POST /historian."""

    grupo_id: str = Field(
        ...,
        description="Identificador único del grupo. Ej: 'proceso'.",
        examples=["proceso"],
    )
    db_id: str = Field(
        ...,
        description="Conexión donde se escribe (de `GET /db`).",
        examples=["mes_produccion"],
    )
    tags: List[str] = Field(
        default_factory=list,
        description="Tags a guardar, en formato `\"<plc_id>|<tag>\"` — la misma "
                    "clave que usa el WebSocket. **Lista vacía = TODOS los "
                    "tags de todos los PLCs** (cuidado con el volumen).\n\n"
                    "Los valores disponibles salen de `GET /tags`.",
        examples=[["192.168.50.1|DB_snap7.temperatura",
                   "192.168.100.31|PLC_PRG.AI_Sensor_mA"]],
    )
    tabla: str = Field(
        default="historico_tags",
        description="Tabla destino. Se crea sola si no existe. Solo letras, "
                    "dígitos y guion bajo.",
    )
    nombre: str = Field(default="", description="Etiqueta legible.")
    activo: bool = Field(
        default=True, description="Empezar a capturar de inmediato.")
    banda_muerta: float = Field(
        default=0.0, ge=0,
        description="**Válvula de seguridad (0 = desactivada).** Ignora "
                    "cambios numéricos menores que este valor. Útil para "
                    "señales ruidosas: con 0.5 en una temperatura, solo se "
                    "guarda cuando varía medio grado.",
    )
    intervalo_min_ms: int = Field(
        default=0, ge=0,
        description="**Válvula de seguridad (0 = desactivada).** Tiempo mínimo "
                    "entre muestras guardadas del MISMO tag. Con 1000, un tag "
                    "que cambia cada 100 ms solo genera 1 fila por segundo.",
    )


def _hist(request: Request):
    return request.app.state.historizador


# ====================================================================== #
# Grupos
# ====================================================================== #
@router.get(
    "/historian",
    tags=TAG,
    summary="Estado del historizador",
    description="Grupos configurados con sus estadísticas en vivo: filas "
                "escritas, filas pendientes en el buffer, última escritura y "
                "último error. Sirve para la pantalla de diagnóstico.\n\n"
                "`en_buffer` alto y creciendo significa que la BD no está "
                "aceptando las escrituras (mira `ultimo_error`).",
    responses={200: {"content": {"application/json": {"example": {
        "num_grupos": 1, "activos": 1,
        "filas_escritas_total": 15420, "en_buffer_total": 37,
        "intervalo_flush_s": 2.0,
        "grupos": [{
            "grupo_id": "proceso", "nombre": "Variables de proceso",
            "db_id": "mes_produccion", "tabla": "historico_tags",
            "activo": True, "num_tags": 2,
            "tags": ["192.168.50.1|DB_snap7.temperatura",
                     "192.168.50.1|DB_snap7.presion"],
            "todos_los_tags": False,
            "banda_muerta": 0.0, "intervalo_min_ms": 0,
            "filas_escritas": 15420, "filas_descartadas": 0,
            "ultima_escritura": "2026-07-30T17:45:02+00:00",
            "ultimo_error": "", "en_buffer": 37,
        }],
    }}}}},
)
async def estado_historizador(request: Request) -> dict:
    return _hist(request).estado()


@router.post(
    "/historian",
    tags=TAG,
    summary="Crear o actualizar un grupo de historización",
    description="Define QUÉ tags se guardan y DÓNDE. La tabla se crea sola la "
                "primera vez que hay algo que escribir.\n\n"
                "**Esquema de la tabla** (estrecho, una fila por lectura):\n\n"
                "| Columna | Contenido |\n"
                "|---|---|\n"
                "| `ts` | Marca de tiempo del PLC (`source_ts`), en UTC |\n"
                "| `plc` | Id del PLC de origen |\n"
                "| `tag` | Nombre del tag |\n"
                "| `valor_num` | Valor numérico (los booleanos como 0/1) |\n"
                "| `valor_texto` | Valor si el tag es de texto |\n"
                "| `tipo` | Tipo de dato OPC UA original |\n\n"
                "Añadir o quitar tags NO altera la tabla.\n\n"
                "⚠️ **Volumen**: se guarda cada cambio. Un tag que cambia cada "
                "100 ms genera ~864.000 filas al día. Si te pasa, usa "
                "`banda_muerta` o `intervalo_min_ms` en vez de quitar tags.",
    responses={200: {"content": {"application/json": {"examples": {
        "ok": {"summary": "Grupo creado", "value": {
            "ok": True, "grupo_id": "proceso", "db_id": "mes_produccion",
            "tabla": "historico_tags", "num_tags": 2,
            "mensaje": "Grupo 'proceso' guardado y activo.",
        }},
        "sin_conexion": {"summary": "La conexión no existe", "value": {
            "ok": False,
            "mensaje": "No existe la conexión 'mes_produccion'. Créala primero.",
        }},
    }}}}},
)
async def crear_grupo(
    request: Request,
    sesion: Sesion = Depends(exigir_rol("Administradores")),
    cuerpo: NuevoGrupo = Body(..., openapi_examples={
        "seleccion": {
            "summary": "Tags seleccionados (lo habitual)",
            "description": "El usuario marca en la vista qué variables quiere "
                           "guardar, de uno o varios PLCs a la vez.",
            "value": {
                "grupo_id": "proceso",
                "db_id": "mes_produccion",
                "nombre": "Variables de proceso",
                "tags": [
                    "192.168.50.1|DB_snap7.temperatura",
                    "192.168.50.1|DB_snap7.presion",
                    "192.168.100.31|PLC_PRG.AI_Sensor_mA",
                ],
                "tabla": "historico_tags",
                "activo": True,
            },
        },
        "todos": {
            "summary": "Todos los tags de todos los PLCs",
            "description": "Lista de tags VACÍA = se guarda todo. Cómodo, pero "
                           "revisa el volumen antes de dejarlo en producción.",
            "value": {
                "grupo_id": "todo",
                "db_id": "mes_produccion",
                "nombre": "Histórico completo",
                "tags": [],
                "activo": True,
            },
        },
        "con_banda_muerta": {
            "summary": "Con válvula de seguridad (señal ruidosa)",
            "description": "Guarda solo si la temperatura varía más de 0,5 °C "
                           "y como máximo una muestra por segundo. Reduce el "
                           "volumen sin perder los cambios que importan.",
            "value": {
                "grupo_id": "temperaturas",
                "db_id": "mes_produccion",
                "nombre": "Temperaturas filtradas",
                "tags": ["192.168.50.1|DB_snap7.temperatura"],
                "tabla": "historico_temperaturas",
                "activo": True,
                "banda_muerta": 0.5,
                "intervalo_min_ms": 1000,
            },
        },
    }),
) -> dict:
    resultado = _hist(request).alta_grupo(
        grupo_id=cuerpo.grupo_id, db_id=cuerpo.db_id, tags=cuerpo.tags,
        tabla=cuerpo.tabla, nombre=cuerpo.nombre, activo=cuerpo.activo,
        banda_muerta=cuerpo.banda_muerta,
        intervalo_min_ms=cuerpo.intervalo_min_ms,
    )
    if resultado.get("ok"):
        await _avisar(request, sesion, "alta")
    return resultado


@router.delete(
    "/historian/{grupo_id}",
    tags=TAG,
    summary="Eliminar un grupo",
    description="Vuelca lo que quede pendiente y borra la configuración del "
                "grupo. **Los datos ya guardados NO se borran**: la tabla y su "
                "contenido siguen ahí.",
    responses={200: {"content": {"application/json": {"example": {
        "ok": True, "grupo_id": "proceso",
        "mensaje": "Grupo 'proceso' eliminado. Los datos ya guardados NO se borran.",
    }}}}},
)
async def borrar_grupo(
    request: Request, grupo_id: str,
    sesion: Sesion = Depends(exigir_rol("Administradores")),
) -> dict:
    resultado = await _hist(request).baja_grupo(grupo_id)
    if resultado.get("ok"):
        await _avisar(request, sesion, "baja")
    return resultado


@router.post(
    "/historian/{grupo_id}/start",
    tags=TAG,
    summary="Reanudar la captura de un grupo",
    description="Vuelve a guardar los tags del grupo. La configuración no se "
                "pierde al pausar, así que esto es solo un interruptor.",
    responses={200: {"content": {"application/json": {"example": {
        "ok": True, "grupo_id": "proceso", "activo": True,
        "mensaje": "Grupo 'proceso' activado.",
    }}}}},
)
async def arrancar_grupo(
    request: Request, grupo_id: str,
    sesion: Sesion = Depends(exigir_rol("Administradores")),
) -> dict:
    resultado = _hist(request).activar(grupo_id, True)
    if resultado.get("ok"):
        await _avisar(request, sesion, "activado")
    return resultado


@router.post(
    "/historian/{grupo_id}/stop",
    tags=TAG,
    summary="Pausar la captura de un grupo",
    description="Deja de guardar, sin borrar la configuración ni los datos. "
                "Lo pendiente en el buffer se escribirá en el siguiente ciclo.",
    responses={200: {"content": {"application/json": {"example": {
        "ok": True, "grupo_id": "proceso", "activo": False,
        "mensaje": "Grupo 'proceso' detenido.",
    }}}}},
)
async def parar_grupo(
    request: Request, grupo_id: str,
    sesion: Sesion = Depends(exigir_rol("Administradores")),
) -> dict:
    resultado = _hist(request).activar(grupo_id, False)
    if resultado.get("ok"):
        await _avisar(request, sesion, "pausado")
    return resultado


@router.post(
    "/historian/flush",
    tags=TAG,
    summary="Forzar el volcado del buffer",
    description="Escribe YA lo que haya pendiente, sin esperar al ciclo "
                "automático (cada 2 s). Útil para comprobar desde Swagger que "
                "la escritura funciona, sin esperar.",
    responses={200: {"content": {"application/json": {"example": {
        "ok": True, "escritas": 37, "pendientes": 0,
        "mensaje": "37 fila(s) volcada(s).",
    }}}}},
)
async def volcar_buffer(request: Request) -> dict:
    return await _hist(request).flush_ahora()


# ====================================================================== #
# Lectura del histórico
# ====================================================================== #
@router.get(
    "/historian/{grupo_id}/datos",
    tags=TAG,
    summary="Leer el histórico (atajo para el widget de tendencia)",
    description="Devuelve las filas guardadas, sin tener que registrar una "
                "consulta. Como el esquema de la tabla lo controla el backend, "
                "el SELECT se genera de forma segura y los filtros van "
                "bindeados.\n\n"
                "Ordena por `ts` descendente (lo más reciente primero). Para "
                "un gráfico de línea, el frontend suele invertir el orden.\n\n"
                "Si necesitas agregaciones (medias por hora, máximos por "
                "turno...), registra una consulta normal con `POST /db/queries` "
                "sobre la misma tabla.",
    responses={200: {"content": {"application/json": {"example": {
        "ok": True, "grupo_id": "proceso", "tabla": "historico_tags",
        "columnas": ["ts", "plc", "tag", "valor_num", "valor_texto", "tipo"],
        "filas": [
            {"ts": "2026-07-30T17:45:02.113000+00:00", "plc": "192.168.50.1",
             "tag": "DB_snap7.temperatura", "valor_num": 53.09,
             "valor_texto": None, "tipo": "Float"},
            {"ts": "2026-07-30T17:45:01.910000+00:00", "plc": "192.168.50.1",
             "tag": "DB_snap7.temperatura", "valor_num": 52.87,
             "valor_texto": None, "tipo": "Float"},
        ],
        "num_filas": 2, "truncado": False, "ms": 4.1,
    }}}}},
)
async def leer_historico(
    request: Request,
    grupo_id: str,
    tag: Optional[str] = Query(
        default=None,
        description="Filtrar por un tag concreto (sin el prefijo del PLC). "
                    "Ej: `DB_snap7.temperatura`.",
    ),
    desde: Optional[str] = Query(
        default=None,
        description="Fecha/hora inicial en ISO 8601. Ej: `2026-07-30T00:00:00`.",
    ),
    hasta: Optional[str] = Query(
        default=None, description="Fecha/hora final en ISO 8601."),
    limite: int = Query(
        default=1000, ge=1, le=10000,
        description="Máximo de filas devueltas.",
    ),
) -> dict:
    return await _hist(request).leer(grupo_id, tag, desde, hasta, limite)
