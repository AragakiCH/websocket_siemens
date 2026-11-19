# -*- coding: utf-8 -*-
"""
alarm_routes.py
===============
Las alarmas EN EJECUCIÓN. Configurarlas es otra cosa y va por otro sitio.

  GET  /alarmas/pendientes        -> lo que el operador tiene que ver ahora
  GET  /alarmas/historico         -> qué pasó y cuándo, con filtros
  GET  /alarmas/estado            -> diagnóstico del motor
  POST /alarmas/{id}/reconocer    -> darse por enterado          [Usuarios]
  POST /alarmas/reconocer-todas   -> lo mismo, en bloque         [Usuarios]
  POST /alarmas/recargar          -> releer las reglas          [Administradores]

Y la PAPELERA de las reglas, que sí es configuración pero vive aquí porque
eliminar una regla no es solo apuntarlo en su fila: el motor tiene que dejar
de vigilarla en ese mismo momento y cerrar la alarma que tuviera activa.

  POST /alarmas/definiciones/{id}/eliminar   -> a la papelera   [Administradores]
  POST /alarmas/definiciones/{id}/restaurar  -> de vuelta       [Administradores]

POR QUÉ ESTO NO ES `/crud/alarmas`
----------------------------------
El CRUD genérico ya expone la tabla `alarmas` y seguirá haciéndolo: sirve para
consultarla como cualquier otra. Lo que no puede es RECONOCER una alarma, y no
por falta de un endpoint sino porque reconocer no es un UPDATE:

  · hay que decidir si el evento queda 'activa' (sigue ocurriendo, pero ya lo
    viste) o 'reconocida' (ya pasó y lo viste), y eso depende de si tiene
    marca de normalización;
  · hay que sellar QUIÉN desde el token, nunca desde el cuerpo;
  · hay que avisar a los demás operadores por WebSocket, o cada uno seguiría
    viendo su banner rojo hasta que recargara.

Un PATCH suelto haría lo primero mal y no haría lo tercero.

QUÉ SIGNIFICA "PENDIENTE"
-------------------------
Sin reconocer. NO es "sigue activa". Una alarma que saltó de madrugada y se
normalizó sola sigue pendiente por la mañana, y es justo la que hay que
enseñarle a quien entra al turno. La explicación larga está en la cabecera de
`app/core/alarm_engine.py`.

PERMISOS
--------
Consultar no pide nada: en una planta, el estado de las alarmas es lo primero
que hay que poder ver, y esconderlo detrás de un login no protege nada (los
valores del PLC ya viajan por el WebSocket). Reconocer sí pide `Usuarios`,
porque queda firmado con el nombre.
"""
from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request

from app.api.auth_routes import exigir_rol, usuario_de
from app.core.auth_manager import Sesion
from app.core.crud_manager import ErrorCrud, ErrorPapelera
from app.db.sql_driver import _nombre_seguro

logger = logging.getLogger("alarm_routes")

router = APIRouter(prefix="/alarmas", tags=["Alarmas"])


def _error(exc: ErrorCrud) -> HTTPException:
    """
    Convierte un `ErrorCrud` en la respuesta HTTP que ya lleva dentro.

    POR QUÉ HACE FALTA. `ErrorCrud` nace con su código (503 si la base no
    abre, 400 si el dato es inválido) y un mensaje escrito para que alguien lo
    lea. Pero si nadie lo captura, FastAPI no sabe nada de él: se escapa como
    una excepción cualquiera y sale un **500 con la traza entera** en el log.

    Se notó con la base de datos caída: la vista consulta
    `/alarmas/pendientes` cada pocos segundos, así que cada consulta escupía
    dos trazas de sesenta líneas. El log quedaba inservible para ver cualquier
    otra cosa, y el frontend recibía un 500 genérico en vez del motivo real,
    que estaba ahí desde el principio: "no se pudo abrir la conexión".

    `crud_routes` ya tenía este mismo helper. Esto no es un caso nuevo, es el
    mismo tratamiento que faltaba en los endpoints de alarmas.
    """
    return HTTPException(exc.codigo, exc.mensaje)


def _motor(request: Request):
    """
    El motor, o un 503 explicando cuál de los dos motivos es.

    Distinguirlos importa: uno se arregla con una variable de entorno y el
    otro mirando por qué no arrancó el servicio.
    """
    motor = getattr(request.app.state, "motor_alarmas", None)
    if motor is None:
        activo = getattr(request.app.state.settings, "alarmas_enabled", True)
        raise HTTPException(
            503,
            "El motor de alarmas está apagado (PLC_ALARMAS_ENABLED=false). "
            "Las reglas se conservan y se pueden editar, pero no se evalúa "
            "ninguna."
            if not activo else
            "El motor de alarmas no llegó a arrancar. Mira el registro del "
            "servicio: casi siempre es que la base de datos con la tabla "
            "`alarmas_def` no estaba disponible al iniciar.",
        )
    return motor


def _auditar(request: Request, accion: str, sesion: Optional[Sesion],
             recurso: str = "", detalle: Optional[dict] = None) -> None:
    aud = getattr(request.app.state, "auditoria", None)
    if aud is not None:
        aud.registrar(accion, recurso=recurso, detalle=detalle, sesion=sesion)


# ====================================================================== #
# Quién la reconoció, con nombre
# ====================================================================== #
async def nombres_de_usuarios(crud, tabla_usuarios: str,
                              db_id: Optional[str],
                              ids: List[int]) -> Dict[int, str]:
    """
    `{usuario_id: nombre}` para los ids que se pidan.

    `alarmas.usuario_id` es quién reconoció el evento. A la vista le llegaba
    solo ese número, y un 3 en una columna «Usuario» no le dice nada a quien
    revisa el turno: lo que hace falta leer es «ana».

    Se busca en la tabla `usuarios` DE LA MISMA BASE que las alarmas, que es
    a la que apunta la clave foránea de esa columna.

    NUNCA tumba la lista. Si la tabla no existe, no hay permiso o la base no
    responde, devuelve lo que tenga (nada) y la vista enseña el número: una
    lista de alarmas sin nombres es una molestia; sin lista, un problema.
    """
    ids = sorted({n for n in (_entero(i) for i in ids) if n is not None})
    if not ids:
        return {}
    try:
        tabla = _nombre_seguro(tabla_usuarios)
        driver = await crud._driver(db_id)
        # Un marcador por id: el número de ids cambia, pero cada valor va
        # bindeado. Del cliente no llega nada a este SQL — los ids salen de
        # las filas que se acaban de leer.
        marcas = ", ".join(f":u{n}" for n in range(len(ids)))
        resultado = await driver.query(
            f"SELECT id, usuario FROM {tabla} WHERE id IN ({marcas})",
            {f"u{n}": valor for n, valor in enumerate(ids)},
            limite=len(ids),
        )
        return {int(f["id"]): str(f.get("usuario") or "")
                for f in resultado.filas if _entero(f.get("id")) is not None}
    except Exception as exc:  # noqa: BLE001
        logger.debug("No se pudieron leer los nombres de usuario: %s", exc)
        return {}


def _entero(valor: Any) -> Optional[int]:
    """`int(valor)`, o None si no lo es. Para ids que vienen de la base."""
    try:
        return int(valor)
    except (TypeError, ValueError):
        return None


async def _con_usuario(request: Request, db_id: Optional[str],
                       filas: List[dict]) -> List[dict]:
    """
    Añade a cada evento el campo `usuario`: el nombre de quien lo reconoció,
    o `None` si todavía nadie (o si el nombre no se pudo leer).

    Una sola consulta para toda la página, y ninguna si nadie ha reconocido
    nada — que en `/pendientes` es siempre: pendiente es, justamente, sin
    reconocer.
    """
    ids = [f.get("usuario_id") for f in filas if f.get("usuario_id") is not None]
    nombres: Dict[int, str] = {}
    if ids:
        auth = getattr(request.app.state, "auth_manager", None)
        tabla = getattr(auth, "tabla", "") or "usuarios"
        nombres = await nombres_de_usuarios(
            request.app.state.crud_manager, tabla, db_id, ids)
    for f in filas:
        uid = _entero(f.get("usuario_id"))
        f["usuario"] = (nombres.get(uid) or None) if uid is not None else None
    return filas


# ====================================================================== #
# Consulta
# ====================================================================== #
@router.get(
    "/pendientes",
    summary="Alarmas sin reconocer, la más grave primero",
    description="Lo que debe ver el operador ahora mismo.\n\n"
                "**Pendiente = sin reconocer**, no 'sigue activa'. Una alarma "
                "que se normalizó sola sigue apareciendo hasta que alguien la "
                "reconozca: si desapareciera, el turno siguiente no sabría "
                "que hubo un problema.\n\n"
                "El orden es por severidad (1 = Critical) y, dentro de cada "
                "una, por antigüedad: lo más grave arriba, y a igual "
                "gravedad, lo que lleva más tiempo esperando.",
)
async def pendientes(
    request: Request,
    limite: int = Query(200, ge=1, le=500),
) -> Dict[str, Any]:
    motor = _motor(request)
    try:
        filas = await motor.pendientes(limite=limite)
    except ErrorCrud as exc:
        raise _error(exc)
    filas = await _con_usuario(request, motor.db_id, filas)
    return {
        "ok": True,
        "alarmas": filas,
        "total": len(filas),
        # El resumen evita que la vista tenga que contar: el banner solo
        # necesita saber cuántas hay y cuál es la peor.
        "por_severidad": _resumen(filas),
        "peor": filas[0] if filas else None,
    }


def _resumen(filas: List[dict]) -> Dict[str, int]:
    out: Dict[str, int] = {}
    for f in filas:
        k = str(f.get("severidad") or 3)
        out[k] = out.get(k, 0) + 1
    return out


@router.get(
    "/historico",
    summary="Qué alarmas hubo, con filtros",
    description="El histórico completo de `alarmas`, incluidas las ya "
                "reconocidas y normalizadas.\n\n"
                "Para la lista de trabajo del operador usa "
                "`/alarmas/pendientes`: esto es para revisar un turno o "
                "investigar qué pasó.",
)
async def historico(
    request: Request,
    estado: Optional[str] = Query(None, description="activa | reconocida | normalizada"),
    severidad: Optional[int] = Query(None, ge=1, le=5),
    tag: Optional[str] = Query(None),
    desde: Optional[str] = Query(None, description="ISO 8601"),
    hasta: Optional[str] = Query(None, description="ISO 8601"),
    limite: int = Query(100, ge=1, le=500),
    offset: int = Query(0, ge=0),
) -> Dict[str, Any]:
    motor = _motor(request)
    filtros: Dict[str, Any] = {}
    if estado:
        filtros["estado"] = estado
    if severidad is not None:
        filtros["severidad"] = severidad
    if tag:
        filtros["tag"] = tag

    try:
        datos = await request.app.state.crud_manager.listar(
            "alarmas", db_id=motor.db_id, filtros=filtros,
            desde=desde, hasta=hasta,
            orden="ts_activacion", descendente=True,
            limite=limite, offset=offset,
        )
    except ErrorCrud as exc:
        raise _error(exc)
    # El nombre de quien reconoció cada una, para la columna «Usuario».
    await _con_usuario(request, motor.db_id, datos.get("filas") or [])
    return datos


@router.get(
    "/estado",
    summary="Diagnóstico del motor",
    description="Cuántas reglas hay cargadas, cuántas vigilan un tag de "
                "verdad, cuántas están disparadas ahora y si hubo errores "
                "escribiendo.\n\n"
                "El campo que más se mira es `reglas_sin_tag`: una alarma "
                "configurada sin `Trigger tag` no se evalúa nunca, y desde el "
                "editor no se distingue de una que sí funciona.",
)
async def estado(request: Request) -> Dict[str, Any]:
    # Este NO toca la base —`estado()` lee contadores en memoria—, así que no
    # puede lanzar ErrorCrud. Se deja tal cual a propósito: es justo el
    # endpoint al que se recurre cuando la base está caída para entender por
    # qué, y envolverlo en un try lo haría parecer frágil sin serlo.
    return {"ok": True, **_motor(request).estado()}


# ====================================================================== #
# Acciones
# ====================================================================== #
@router.post(
    "/reconocer-todas",
    summary="Reconocer todo lo pendiente",
    description="Para después de una parada, cuando se acumularon decenas.\n\n"
                "Queda firmado igual que una a una: cada fila lleva quién y "
                "cuándo.",
)
async def reconocer_todas(
    request: Request,
    sesion: Optional[Sesion] = Depends(exigir_rol("Usuarios")),
) -> Dict[str, Any]:
    # NOTA: esta ruta va ANTES que `/{evento_id}/reconocer`. FastAPI resuelve
    # por orden de declaración, y al revés "reconocer-todas" entraría por la
    # ruta con parámetro, que intentaría convertirlo a int y devolvería un
    # 422 desconcertante.
    motor = _motor(request)
    try:
        r = await motor.reconocer_todas(
            usuario_id=getattr(sesion, "usuario_id", None))
    except ErrorCrud as exc:
        raise _error(exc)
    _auditar(request, "alarma.reconocidas_todas", sesion,
             detalle={"cuantas": r.get("reconocidas", 0)})
    return r


@router.post(
    "/{evento_id}/reconocer",
    summary="Darse por enterado de una alarma",
    description="Marca quién la reconoció y cuándo.\n\n"
                "Si la condición **sigue cumpliéndose**, el evento se queda "
                "en `activa` con marca de reconocimiento: decir 'reconocida' "
                "de algo que aún está pasando daría a entender que ya pasó. "
                "Si ya se había normalizado, pasa a `reconocida` y sale de "
                "los pendientes.",
)
async def reconocer(
    evento_id: int,
    request: Request,
    sesion: Optional[Sesion] = Depends(exigir_rol("Usuarios")),
) -> Dict[str, Any]:
    motor = _motor(request)
    try:
        r = await motor.reconocer(
            evento_id, usuario_id=getattr(sesion, "usuario_id", None))
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(400, f"No se pudo reconocer la alarma: {exc}")
    _auditar(request, "alarma.reconocida", sesion, recurso=str(evento_id))
    return r


@router.post(
    "/recargar",
    summary="Releer las reglas de alarmas_def",
    description="Lo llama el editor al guardar, para que un cambio se aplique "
                "al momento y no en el siguiente barrido de un minuto.\n\n"
                "**Conserva el estado**: una alarma disparada sigue disparada "
                "después de recargar. Si no, editar el texto de una alarma "
                "cerraría en falso todas las activas.",
    dependencies=[Depends(exigir_rol("Administradores"))],
)
async def recargar(request: Request) -> Dict[str, Any]:
    motor = _motor(request)
    try:
        return {"ok": True, **await motor.recargar()}
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(
            503, f"No se pudieron leer las reglas de `alarmas_def`: {exc}")


# ====================================================================== #
# La papelera de las reglas
# ====================================================================== #
# POR QUÉ NO ES UN `DELETE /crud/alarmas_def/{id}`
#
# Ese sigue existiendo y borra la fila para siempre: es lo que hace «Borrar
# definitivamente» desde la papelera. Pero como ÚNICA forma de quitar una
# alarma era demasiado: un clic en el tachito y la regla desaparecía sin
# vuelta atrás, llevándose además el número con el que el histórico la
# identifica.
#
# Aquí la regla se marca con la fecha (`alarmas_def.eliminado_en`) y nada más.
# El editor la baja a su tabla de eliminadas, desde donde se restaura; el
# motor deja de vigilarla al momento, y si tenía una alarma activa la cierra,
# porque ya nadie iba a normalizarla.
#
# POR QUÉ NO ES UN `PATCH` CON `eliminado_en`
#
# Porque el PATCH genérico pide `Usuarios` y borrar pide `Administradores`:
# dejar escribir esa columna por ahí sería un atajo para quitar alarmas sin
# el rol que hace falta. Por eso el CRUD la enseña y no la deja escribir.
async def _papelera(request: Request, sesion: Optional[Sesion], def_id: int,
                    eliminar: bool, db_id: Optional[str]) -> Dict[str, Any]:
    crud = request.app.state.crud_manager
    try:
        r = await crud.cambiar_papelera("alarmas_def", def_id, eliminar, db_id)
    except ErrorPapelera as exc:
        # La base no tiene la columna y el usuario de la conexión no puede
        # crearla. Va con ESTRUCTURA, no como un texto más: así el editor
        # puede enseñar la sentencia con su botón de copiar y ofrecer, de
        # mientras, el borrado definitivo — en vez de dejar a quien pulsó el
        # tachito delante de un error que no sabe cómo resolver.
        raise HTTPException(409, detail={
            "codigo": "papelera_no_disponible",
            "mensaje": exc.mensaje,
            "sql": exc.sql,
            "detalle": exc.detalle,
        })
    except ErrorCrud as exc:
        raise _error(exc)

    # El motor tiene las reglas en memoria: sin esto seguiría evaluando la
    # eliminada (o ignorando la restaurada) hasta su barrido de un minuto.
    # No se usa `_motor()`: con el motor apagado la papelera tiene que
    # funcionar igual — las reglas se editan aunque no se evalúen.
    motor = getattr(request.app.state, "motor_alarmas", None)
    if motor is not None:
        try:
            await motor.recargar()
        except Exception as exc:  # noqa: BLE001
            # La fila ya quedó marcada, que es lo que se pidió. El barrido
            # periódico del motor la recogerá.
            logger.warning("Regla %s %s, pero el motor no pudo recargar: %s",
                           def_id, "eliminada" if eliminar else "restaurada",
                           exc)

    fila = r.get("fila") or {}
    _auditar(request,
             "alarma_def.eliminada" if eliminar else "alarma_def.restaurada",
             sesion, recurso=str(def_id),
             detalle={"nombre": fila.get("nombre"), "tag": fila.get("tag")})
    # Y a las demás pantallas abiertas, igual que cualquier otro cambio de
    # configuración hecho por el CRUD.
    try:
        await request.app.state.manager.difundir_config(
            "alarmas_def", usuario_de(sesion),
            "eliminado" if eliminar else "restaurado")
    except Exception:  # noqa: BLE001
        pass
    return r


@router.post(
    "/definiciones/{def_id}/eliminar",
    summary="Mandar una regla de alarma a la papelera",
    description="La regla **no se borra**: se marca con la fecha y deja de "
                "contar. El editor la muestra en su tabla de eliminadas y se "
                "puede restaurar.\n\n"
                "El motor deja de vigilarla al momento. Si tenía una alarma "
                "**activa**, ese evento se cierra (normalizado, con la hora "
                "de ahora): ya nadie iba a normalizarlo. Sigue pendiente de "
                "reconocer si nadie lo había visto.\n\n"
                "Los eventos que ya provocó conservan su número de alarma. "
                "Para borrarla del todo: `DELETE /crud/alarmas_def/{id}`.",
    responses={404: {"description": "No existe esa regla."},
               409: {"description": "A la tabla le falta la columna de la "
                                    "papelera y el usuario de la conexión no "
                                    "puede añadirla. `detail` es un objeto: "
                                    "`codigo` = `papelera_no_disponible`, "
                                    "`mensaje`, y `sql` con la sentencia que "
                                    "la crea."}},
)
async def eliminar_definicion(
    def_id: int,
    request: Request,
    sesion: Optional[Sesion] = Depends(exigir_rol("Administradores")),
    db_id: Optional[str] = Query(
        default=None,
        description="Base donde está la regla. Vacío = la de por defecto."),
) -> Dict[str, Any]:
    return await _papelera(request, sesion, def_id, True, db_id)


@router.post(
    "/definiciones/{def_id}/restaurar",
    summary="Sacar una regla de alarma de la papelera",
    description="Vuelve tal como estaba —mismo número, mismo tag, misma "
                "condición— y el motor la vigila otra vez desde ese momento. "
                "Si estaba silenciada (`activo = 0`) al eliminarla, vuelve "
                "silenciada.",
    responses={404: {"description": "No existe esa regla."}},
)
async def restaurar_definicion(
    def_id: int,
    request: Request,
    sesion: Optional[Sesion] = Depends(exigir_rol("Administradores")),
    db_id: Optional[str] = Query(default=None),
) -> Dict[str, Any]:
    return await _papelera(request, sesion, def_id, False, db_id)
