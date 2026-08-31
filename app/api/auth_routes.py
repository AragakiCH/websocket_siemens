# -*- coding: utf-8 -*-
"""
auth_routes.py
==============
Endpoints de identidad, y las dependencias que aplican los roles.

  POST   /auth/registro     -> crear cuenta (el PRIMER usuario será Supervisor)
  POST   /auth/login        -> devuelve el token de sesión
  POST   /auth/logout       -> cierra la sesión actual
  GET    /auth/me           -> quién soy y qué puedo hacer
  GET    /auth/estado       -> si hay cuentas y si se exige login (público)
  GET    /auth/conectados   -> quién está trabajando ahora

CRUD de la pantalla de gestión de usuarios:

  GET    /auth/usuarios         -> listado simple            [Administradores]
  GET    /auth/usuarios/buscar  -> filtros, orden, paginado  [Administradores]
  GET    /auth/usuarios/{u}     -> leer una cuenta           [Administradores]
  POST   /auth/usuarios         -> crear                     [Supervisor]
  PATCH  /auth/usuarios/{u}     -> editar (todo opcional)    [Supervisor]
  DELETE /auth/usuarios/{u}     -> borrar                    [Supervisor]

Las tres mutaciones llevan salvaguardas que devuelven **409** antes de dejar el
sistema sin acceso: no puedes desactivarte, degradarte ni borrarte a ti mismo,
y no se puede tocar al último Supervisor activo. Sin eso, el único arreglo
sería entrar a la base con SQL a mano.

**Ojo con el orden de las rutas.** `/auth/usuarios/buscar` va declarada ANTES
que `/auth/usuarios/{usuario}`; si fuera al revés, FastAPI casaría "buscar"
como si fuera un nombre de usuario y el endpoint de búsqueda no existiría.

**Lo importante: los permisos se aplican AQUÍ, en el backend.** Esconder un
botón en la vista no es seguridad: cualquiera puede llamar al endpoint con
curl. Por eso cada ruta que modifica algo declara el rol mínimo que exige.

**El token** viaja en la cabecera `Authorization: Bearer <token>`. Para el
WebSocket, que no permite cabeceras personalizadas desde el navegador, se
acepta además `?token=` en el query string.
"""
from __future__ import annotations

import logging
from typing import Optional

from fastapi import APIRouter, Body, Depends, Header, HTTPException, Query, Request
from pydantic import BaseModel, Field

from app.core.auth_manager import (
    ESTADOS,
    ROLES,
    ROL_POR_DEFECTO,
    ErrorAuth,
    Sesion,
    tiene_permiso,
)

logger = logging.getLogger("auth_routes")

router = APIRouter()


def _auth(request: Request):
    return request.app.state.auth_manager


# ====================================================================== #
# Extracción del token y dependencias de rol
# ====================================================================== #
def token_de(
    authorization: Optional[str] = Header(default=None),
    token: Optional[str] = Query(default=None),
) -> Optional[str]:
    """
    Saca el token de `Authorization: Bearer ...` o de `?token=`.

    El query string existe por el WebSocket: la API del navegador no deja
    poner cabeceras al abrir una conexión WS.
    """
    if authorization:
        partes = authorization.split(None, 1)
        if len(partes) == 2 and partes[0].lower() == "bearer":
            return partes[1].strip()
        return authorization.strip()
    return token


async def sesion_actual(
    request: Request, tok: Optional[str] = Depends(token_de)
) -> Optional[Sesion]:
    """Sesión asociada al token, o None. NO exige estar autenticado."""
    return _auth(request).sesion_de(tok)


async def _sistema_sin_cuentas(request: Request) -> bool:
    """
    True si todavía no existe NINGUNA cuenta.

    **Modo arranque.** Sin esto el sistema es imposible de poner en marcha con
    `auth_requerida=true`: para crear una cuenta hace falta la tabla
    `usuarios`, que vive en una base de datos, que hay que dar de alta con
    `POST /db`... que exigiría estar autenticado. Pescadilla que se muerde la
    cola.

    Mientras no haya cuentas, los endpoints de administración quedan abiertos.
    En cuanto se crea la primera (que además se fuerza a Supervisor), la puerta
    se cierra sola. Es la misma ventana que tiene cualquier router doméstico
    recién sacado de la caja, y por el mismo motivo.
    """
    auth = getattr(request.app.state, "auth_manager", None)
    if auth is None:
        return True
    try:
        # TODAS las bases, no solo la activa: ver `contar_en_todas()`. Medirlo
        # por base dejaría la puerta de arranque abierta en cualquier base
        # vacía, y quien entrara por ahí sería Supervisor del backend entero.
        return await auth.contar_en_todas() == 0
    except Exception:  # noqa: BLE001
        # Si ni siquiera se puede consultar (sin BD configurada), estamos
        # necesariamente en el arranque.
        return True


async def exigir_sesion(
    request: Request, sesion: Optional[Sesion] = Depends(sesion_actual)
) -> Optional[Sesion]:
    """
    Exige sesión válida... salvo que `auth_requerida` esté desactivada o que el
    sistema aún no tenga cuentas (modo arranque).

    El escape de `auth_requerida` existe para no romper las instalaciones
    actuales: sin él, activar este módulo dejaría fuera a todo el mundo hasta
    crear cuentas.
    """
    if sesion is not None:
        return sesion
    if not request.app.state.settings.auth_requerida:
        return None
    if await _sistema_sin_cuentas(request):
        return None
    raise HTTPException(
        401, "Necesitas iniciar sesión. Envía 'Authorization: Bearer <token>'."
    )


def exigir_rol(rol_minimo: str):
    """
    Fábrica de dependencias: exige al menos `rol_minimo`.

    Se usa así en cualquier router:

        @router.post("/algo", dependencies=[Depends(exigir_rol("Administradores"))])

    o, si además hace falta saber QUIÉN lo hizo (para registrarlo en el evento
    que se difunde), como parámetro:

        sesion: Sesion = Depends(exigir_rol("Administradores"))
    """

    async def _dep(
        request: Request, sesion: Optional[Sesion] = Depends(sesion_actual)
    ) -> Optional[Sesion]:
        if sesion is None:
            if not request.app.state.settings.auth_requerida:
                return None
            # Modo arranque: sin cuentas todavía, se deja pasar para poder
            # configurar la BD y crear el primer Supervisor.
            if await _sistema_sin_cuentas(request):
                logger.warning(
                    "Acceso sin sesión permitido: el sistema aún no tiene "
                    "cuentas. Crea la primera cuanto antes."
                )
                return None
            raise HTTPException(401, "Necesitas iniciar sesión.")
        if not tiene_permiso(sesion.categoria, rol_minimo):
            raise HTTPException(
                403,
                f"Tu categoría ('{sesion.categoria}') no permite esta acción. "
                f"Hace falta al menos '{rol_minimo}'.",
            )
        return sesion

    return _dep


def usuario_de(sesion: Optional[Sesion]) -> str:
    """Nombre para registrar en los eventos. '' si no hay sesión."""
    return sesion.usuario if sesion else ""


# ====================================================================== #
# Modelos
# ====================================================================== #
class Credenciales(BaseModel):
    usuario: str = Field(..., examples=["jmendoza"])
    password: str = Field(..., examples=["Planta2026!"])
    db_id: Optional[str] = Field(
        default=None,
        description="Base de datos contra la que autenticar. Vacío = la de "
                    "`PLC_AUTH_DB_ID`, o la primera dada de alta. Cada base "
                    "tiene su propia tabla `usuarios`: una cuenta creada en "
                    "una NO existe en las demás.",
        examples=["local"],
    )


class NuevoUsuario(Credenciales):
    email: str = Field(default="", examples=["jmendoza@psi.pe"])
    categoria: str = Field(
        default=ROL_POR_DEFECTO,
        description=f"Una de: {', '.join(ROLES)} (de más a menos permisos).",
    )
    estado: str = Field(default="Activo", description=" | ".join(ESTADOS))


class CambioUsuario(BaseModel):
    """
    Cuerpo de PATCH /auth/usuarios/{usuario}.

    Todos los campos son opcionales: se cambia SOLO lo que se manda. Un campo
    ausente (`None`) se deja como está; no es lo mismo que mandarlo vacío
    (`email: ""` sí borra el correo).
    """

    nuevo_usuario: Optional[str] = Field(
        default=None,
        description="Renombrar la cuenta (3-80 caracteres, único). Cierra su "
                    "sesión: el token apunta al nombre anterior.",
        examples=["hugo.aragaki"],
    )
    email: Optional[str] = Field(
        default=None,
        description="Correo. Cadena vacía lo borra (la columna acepta NULL).",
        examples=["hugo@psi.pe"],
    )
    categoria: Optional[str] = Field(default=None, description=" | ".join(ROLES))
    estado: Optional[str] = Field(default=None, description=" | ".join(ESTADOS))
    password: Optional[str] = Field(
        default=None, description="Nueva contraseña (mínimo 8 caracteres). "
                                  "Cierra sus sesiones abiertas."
    )


# ====================================================================== #
# Endpoints
# ====================================================================== #
@router.get(
    "/auth/estado",
    tags=["Autenticación"],
    summary="Estado del sistema de cuentas (público)",
    description="Sirve para que la vista sepa qué pintar antes de que nadie "
                "haya entrado: si no hay ninguna cuenta, hay que mostrar "
                "'crear la primera cuenta' en vez del formulario de acceso.",
    responses={200: {"content": {"application/json": {"example": {
        "ok": True, "hay_usuarios": False, "auth_requerida": True,
        "bd": {"configurada": True, "fijada": True, "db_id": "psi",
               "nombre": "HMI PSI (servidor)", "etiqueta_motor": "SQL Server",
               "base_datos": "HMI_PSI", "conectado": True, "tabla": "usuarios"},
        "roles": ROLES, "mensaje": "No hay cuentas: la primera será Supervisor.",
    }}}}},
)
async def estado_auth(
    request: Request,
    db_id: Optional[str] = Query(
        default=None,
        description="Consultar el estado de ESTA base. El desplegable del "
                    "login lo usa al cambiar de opción: si hay cuentas o no "
                    "depende de la base, no del sistema.",
    ),
    revisar: bool = Query(
        default=False,
        description="Preguntar al servidor por cada base antes de responder, "
                    "en vez de fiarse del pool abierto. El login lo pide al "
                    "cargarse: si alguien borró la base en el gestor, el pool "
                    "puede seguir diciendo que está viva y el desplegable "
                    "ofrece entrar en algo que ya no existe.",
    ),
) -> dict:
    auth = _auth(request)

    # Refrescar ANTES de contar: así `bases`, `bd` y `bd_disponible` cuentan
    # todos la misma historia. Cuesta una conexión por base dada de alta.
    if revisar:
        try:
            await auth.revisar_bases()
        except Exception as exc:  # noqa: BLE001
            logger.warning("No se pudieron revisar las bases: %s", exc)

    bd_estado: dict = {}
    try:
        total = await auth.contar(db_id)
        disponible = True
        detalle = ""
    except ErrorAuth as exc:
        total, disponible, detalle = 0, False, exc.mensaje
        # "No se pudo conectar a la base de datos de usuarios: <traza ODBC>"
        # no le dice a nadie qué hacer. Se pregunta al servidor para poder
        # decir cuál de los cuatro problemas distintos es — y, sobre todo,
        # para distinguir "la base ya no existe" (que tiene arreglo desde
        # esta misma pantalla: crearla) de "el servidor no responde" (que no).
        try:
            # Si ya se revisó arriba, la respuesta del servidor está en caché
            # y volver a preguntar sería pagar dos veces el mismo timeout —
            # que es justo el caso en el que más duele, con el servidor caído.
            bd_estado = (auth.estado_base(db_id) if revisar
                         else await auth.revisar_base(db_id))
        except Exception as exc2:  # noqa: BLE001
            logger.warning("No se pudo diagnosticar la base: %s", exc2)
        if bd_estado and not bd_estado.get("ok"):
            detalle = " ".join(
                p for p in (bd_estado.get("titulo", ""),
                            bd_estado.get("sugerencia", "")) if p
            ).strip() or detalle

    # Qué base respalda las cuentas. Va aquí, en el endpoint público, porque
    # el login tiene que poder decir "vas a crear la cuenta en HMI PSI
    # (servidor)" ANTES de que nadie escriba nada. No incluye host ni
    # credenciales: eso es GET /db, y exige ser Administrador.
    try:
        bd = auth.info_bd(db_id)
    except Exception as exc:  # noqa: BLE001
        logger.warning("No se pudo describir la BD de cuentas: %s", exc)
        bd = {"configurada": False, "fijada": False, "mensaje": str(exc)}

    # Catálogo para el desplegable. Sin host ni credenciales.
    try:
        bases = auth.bases_disponibles()
    except Exception as exc:  # noqa: BLE001
        logger.warning("No se pudieron listar las bases: %s", exc)
        bases = []

    return {
        "ok": True,
        "hay_usuarios": total > 0,
        # Código estable del diagnóstico cuando la base no responde:
        # `base_no_existe`, `sin_servidor`, `credenciales`, `timeout`...
        # La vista lo usa para decidir qué ofrecer, no para enseñarlo.
        "bd_estado": bd_estado.get("estado", "") if bd_estado else "",
        "bd_sugerencia": bd_estado.get("sugerencia", "") if bd_estado else "",
        "num_usuarios": total,
        "auth_requerida": request.app.state.settings.auth_requerida,
        "bd_disponible": disponible,
        "bd": bd,
        "bases": bases,
        "roles": ROLES,
        "estados": ESTADOS,
        "mensaje": detalle or (
            "No hay cuentas: la primera que se cree será Supervisor."
            if total == 0 else ""
        ),
    }


@router.post(
    "/auth/registro",
    tags=["Autenticación"],
    summary="Crear una cuenta",
    description="El **primer** usuario del sistema se crea siempre como "
                "`Supervisor`, sin importar la categoría que pida: si no, no "
                "habría forma de tener un administrador inicial sin tocar la "
                "base de datos a mano.\n\n"
                "A partir del segundo, crear cuentas exige ser `Supervisor` "
                "cuando `PLC_AUTH_REQUERIDA=true`.",
    responses={
        200: {"description": "Cuenta creada."},
        409: {"description": "Ese nombre de usuario ya existe."},
        503: {"description": "No hay base de datos configurada."},
    },
)
async def registro(
    request: Request,
    cuerpo: NuevoUsuario,
    sesion: Optional[Sesion] = Depends(sesion_actual),
) -> dict:
    auth = _auth(request)
    try:
        # El primero es libre (hay que poder arrancar). Del segundo en
        # adelante, si se exige auth, solo un Supervisor da de alta cuentas.
        # El conteo es GLOBAL (todas las bases), no de la base destino: ver
        # `contar_en_todas()`. Si fuera por base, con dos registradas y una
        # vacía cualquiera se daría de alta como Supervisor en la vacía.
        if (await auth.contar_en_todas() > 0
                and request.app.state.settings.auth_requerida):
            if sesion is None:
                raise HTTPException(401, "Necesitas iniciar sesión.")
            if not tiene_permiso(sesion.categoria, "Supervisor"):
                raise HTTPException(
                    403, "Solo un Supervisor puede crear cuentas nuevas.")

        usuario = await auth.registrar(
            usuario=cuerpo.usuario, password=cuerpo.password,
            email=cuerpo.email, categoria=cuerpo.categoria,
            estado=cuerpo.estado, db_id=cuerpo.db_id,
        )
        aud = getattr(request.app.state, "auditoria", None)
        if aud is not None:
            # La base queda en la auditoría: con varias, "se creó la cuenta"
            # sin decir dónde no responde la pregunta que uno se hace cuando
            # esa cuenta luego "no existe".
            aud.registrar("usuario.creado", recurso=usuario.usuario,
                          detalle={"categoria": usuario.categoria,
                                   "id_creado": usuario.id,
                                   "db_id": auth._db_id(cuerpo.db_id)},
                          sesion=sesion)
        destino = auth._db_id(cuerpo.db_id)
        return {"ok": True, "usuario": usuario.publico(), "db_id": destino,
                "mensaje": f"Cuenta '{usuario.usuario}' creada en '{destino}'."}
    except ErrorAuth as exc:
        raise HTTPException(exc.codigo, exc.mensaje)


@router.post(
    "/auth/login",
    tags=["Autenticación"],
    summary="Iniciar sesión",
    description="Devuelve un token de sesión. Envíalo en las siguientes "
                "peticiones como `Authorization: Bearer <token>`, y en el "
                "WebSocket como `/ws?token=<token>`.\n\n"
                "El mensaje de error es el mismo si el usuario no existe que "
                "si la contraseña es incorrecta: distinguirlos permitiría "
                "averiguar qué cuentas existen probando nombres.",
    responses={
        200: {"content": {"application/json": {"example": {
            "ok": True, "token": "u3Xk...", "expira_horas": 12,
            "usuario": {"usuario": "jmendoza", "categoria": "Administradores"},
        }}}},
        401: {"description": "Usuario o contraseña incorrectos."},
        403: {"description": "La cuenta está inactiva."},
    },
)
async def login(request: Request, cuerpo: Credenciales) -> dict:
    try:
        return await _auth(request).login(
            cuerpo.usuario, cuerpo.password, cuerpo.db_id)
    except ErrorAuth as exc:
        raise HTTPException(exc.codigo, exc.mensaje)


@router.post(
    "/auth/logout",
    tags=["Autenticación"],
    summary="Cerrar sesión",
)
async def logout(request: Request, tok: Optional[str] = Depends(token_de)) -> dict:
    if not tok:
        return {"ok": True}
    sesion = _auth(request).sesion_de(tok)
    r = await _auth(request).logout(tok)
    # Quien se va no debe dejar la pantalla bloqueada para los demás.
    locks = getattr(request.app.state, "lock_manager", None)
    if locks is not None and sesion is not None:
        await locks.liberar_todos_de(sesion.usuario)
    return r


@router.get(
    "/auth/me",
    tags=["Autenticación"],
    summary="Quién soy",
    description="Devuelve la sesión actual y qué puede hacer. La vista lo usa "
                "para decidir qué menús mostrar — pero el permiso real lo "
                "aplica el backend en cada endpoint, no esta respuesta.",
)
async def yo(
    request: Request, sesion: Optional[Sesion] = Depends(sesion_actual)
) -> dict:
    if sesion is None:
        return {"ok": True, "autenticado": False,
                "auth_requerida": request.app.state.settings.auth_requerida}
    return {
        "ok": True,
        "autenticado": True,
        "sesion": sesion.publico(),
        "permisos": {
            "ver": True,
            "editar_diseño": tiene_permiso(sesion.categoria, "Administradores"),
            "gestionar_plcs": tiene_permiso(sesion.categoria, "Administradores"),
            "gestionar_bd": tiene_permiso(sesion.categoria, "Administradores"),
            "gestionar_usuarios": tiene_permiso(sesion.categoria, "Supervisor"),
        },
    }


@router.get(
    "/auth/usuarios",
    tags=["Autenticación"],
    summary="Listar cuentas",
    dependencies=[Depends(exigir_rol("Administradores"))],
    description="Nunca devuelve hashes de contraseña.",
)
async def listar_usuarios(
    request: Request, sesion: Optional[Sesion] = Depends(sesion_actual)
) -> dict:
    # La base de la SESIÓN, no la activa por defecto: quien entró en local
    # administra las cuentas de local. Mezclarlas dejaría a un Supervisor
    # editando homónimos de otra base sin saberlo.
    db_id = sesion.db_id if sesion else None
    try:
        return {"ok": True, "db_id": _auth(request)._db_id(db_id),
                "usuarios": await _auth(request).listar(db_id)}
    except ErrorAuth as exc:
        raise HTTPException(exc.codigo, exc.mensaje)


@router.get(
    "/auth/usuarios/buscar",
    tags=["Gestión de usuarios"],
    summary="Buscar cuentas (con filtros, orden y paginación)",
    dependencies=[Depends(exigir_rol("Administradores"))],
    description="""
El listado que consume la tabla de la pantalla de gestión.

* `texto` busca a la vez en **nombre y correo**: quien escribe "juan" no está
  pensando en qué columna vive lo que busca.
* `categoria` y `estado` filtran por valor exacto.
* `orden` solo acepta nombres de una **lista blanca** (`usuario`, `categoria`,
  `estado`, `creado_en`, `ultimo_acceso`, `id`): el nombre de una columna no se
  puede bindear como parámetro, así que aceptar texto libre aquí sería
  inyección SQL.
* `total` viene **sin paginar**, para poder pintar «20 de 137» y saber si hay
  página siguiente.

Nunca devuelve hashes de contraseña.
""",
    responses={200: {"content": {"application/json": {"example": {
        "ok": True, "db_id": "local", "total": 3, "limite": 100,
        "desplazamiento": 0,
        "roles": ["Supervisor", "Administradores", "Usuarios", "Invitado"],
        "estados": ["Activo", "Inactivo"],
        "usuarios": [{
            "id": 1, "usuario": "hugo", "email": "hugo@psi.pe",
            "categoria": "Supervisor", "estado": "Activo",
            "creado_en": "2026-08-25T19:09:23Z",
            "ultimo_acceso": "2026-08-26T08:14:02Z",
        }],
    }}}}},
)
async def buscar_usuarios(
    request: Request,
    texto: str = Query(default="", description="Busca en nombre y correo."),
    categoria: str = Query(default="", description="Filtro exacto por rol."),
    estado: str = Query(default="", description="`Activo` | `Inactivo`."),
    orden: str = Query(default="usuario"),
    descendente: bool = Query(default=False),
    limite: int = Query(default=100, ge=1, le=500),
    desplazamiento: int = Query(default=0, ge=0),
    sesion: Optional[Sesion] = Depends(sesion_actual),
) -> dict:
    db_id = sesion.db_id if sesion else None
    try:
        datos = await _auth(request).buscar(
            texto=texto, categoria=categoria, estado=estado, orden=orden,
            descendente=descendente, limite=limite,
            desplazamiento=desplazamiento, db_id=db_id,
        )
        return {"ok": True, "db_id": _auth(request)._db_id(db_id), **datos}
    except ErrorAuth as exc:
        raise HTTPException(exc.codigo, exc.mensaje)


@router.get(
    "/auth/usuarios/{usuario}",
    tags=["Gestión de usuarios"],
    summary="Leer una cuenta",
    dependencies=[Depends(exigir_rol("Administradores"))],
    description="Añade `conectado`: si esa persona tiene sesión abierta ahora "
                "mismo. La vista lo usa para avisar antes de desactivarla o "
                "cambiarle el rol.",
    responses={404: {"description": "No existe esa cuenta."}},
)
async def leer_usuario(
    request: Request, usuario: str,
    sesion: Optional[Sesion] = Depends(sesion_actual),
) -> dict:
    db_id = sesion.db_id if sesion else None
    try:
        return {"ok": True, "usuario": await _auth(request).obtener(usuario, db_id)}
    except ErrorAuth as exc:
        raise HTTPException(exc.codigo, exc.mensaje)


@router.post(
    "/auth/usuarios",
    tags=["Gestión de usuarios"],
    summary="Crear una cuenta",
    dependencies=[Depends(exigir_rol("Supervisor"))],
    description="Alta desde la pantalla de gestión.\n\n"
                "Es distinto de `POST /auth/registro`, que además cubre el "
                "arranque del sistema (la primera cuenta, sin sesión, forzada "
                "a Supervisor). Este exige **Supervisor** siempre y respeta la "
                "categoría que se pida.\n\n"
                "La contraseña se guarda **hasheada** (PBKDF2-SHA256 con salt "
                "propio); nunca se almacena en claro.",
    responses={
        409: {"description": "Ese nombre de usuario ya existe."},
        400: {"description": "Datos inválidos (longitudes, rol o estado)."},
    },
)
async def crear_usuario(
    request: Request,
    cuerpo: NuevoUsuario = Body(..., examples=[{
        "usuario": "operador01", "password": "Planta2026!",
        "email": "operador01@psi.pe", "categoria": "Usuarios",
        "estado": "Activo",
    }]),
    sesion: Optional[Sesion] = Depends(sesion_actual),
) -> dict:
    db_id = sesion.db_id if sesion else None
    try:
        creado = await _auth(request).crear_usuario(
            usuario=cuerpo.usuario, password=cuerpo.password,
            email=cuerpo.email, categoria=cuerpo.categoria,
            estado=cuerpo.estado, db_id=db_id,
        )
    except ErrorAuth as exc:
        raise HTTPException(exc.codigo, exc.mensaje)

    aud = getattr(request.app.state, "auditoria", None)
    if aud is not None:
        aud.registrar("usuario.creado", recurso=creado["usuario"],
                      detalle={"categoria": creado["categoria"],
                               "id_creado": creado.get("id")},
                      sesion=sesion)
    return {"ok": True, "usuario": creado,
            "mensaje": f"Cuenta '{creado['usuario']}' creada."}


@router.patch(
    "/auth/usuarios/{usuario}",
    tags=["Gestión de usuarios"],
    summary="Editar una cuenta",
    dependencies=[Depends(exigir_rol("Supervisor"))],
    description="""
Todos los campos son **opcionales**: se cambia solo lo que se manda.

**Efectos sobre la sesión de esa persona**

| Cambio | Qué le pasa a su sesión |
|---|---|
| Categoría (rol) | Se aplica **en caliente**: sigue dentro, con los permisos nuevos |
| Estado → Inactivo | Se cierra **al instante** |
| Contraseña | Se cierra (la anterior ya no vale) |
| Renombrado | Se cierra (la sesión apunta al nombre viejo) |

**Salvaguardas.** Devuelven **409** en vez de dejarte sin acceso:

* No puedes **desactivarte** ni **degradarte** a ti mismo.
* No se puede tocar al **último Supervisor activo** (ni desactivarlo, ni
  bajarle el rol). Sin esto, nadie podría volver a gestionar cuentas y habría
  que arreglarlo con SQL a mano.
""",
    responses={
        404: {"description": "No existe esa cuenta."},
        409: {"description": "Dejaría el sistema sin Supervisor, o te dejaría "
                             "fuera a ti mismo."},
    },
)
async def modificar_usuario(
    request: Request,
    usuario: str,
    cuerpo: CambioUsuario = Body(..., examples=[
        {"categoria": "Administradores"},
        {"estado": "Inactivo"},
        {"email": "nuevo@psi.pe", "categoria": "Usuarios"},
        {"password": "OtraClaveFuerte2026"},
        {"nuevo_usuario": "hugo.aragaki"},
    ]),
    sesion: Optional[Sesion] = Depends(sesion_actual),
) -> dict:
    db_id = sesion.db_id if sesion else None
    try:
        r = await _auth(request).actualizar(
            usuario=usuario,
            nuevo_usuario=cuerpo.nuevo_usuario,
            email=cuerpo.email,
            categoria=cuerpo.categoria,
            estado=cuerpo.estado,
            password=cuerpo.password,
            db_id=db_id,
            actor=usuario_de(sesion),
        )
    except ErrorAuth as exc:
        raise HTTPException(exc.codigo, exc.mensaje)

    aud = getattr(request.app.state, "auditoria", None)
    if aud is not None and r.get("cambios"):
        # Cambiar el rol o desactivar a alguien es de lo más sensible que se
        # puede hacer aquí: siempre queda registrado, y con quién lo hizo.
        aud.registrar("usuario.modificado", recurso=usuario,
                      detalle={"cambios": r["cambios"]}, sesion=sesion)
    return r


@router.delete(
    "/auth/usuarios/{usuario}",
    tags=["Gestión de usuarios"],
    summary="Borrar una cuenta",
    dependencies=[Depends(exigir_rol("Supervisor"))],
    description="""
Borra la fila de verdad (`DELETE`), no la marca como inactiva.

**Es seguro para el histórico**: `alarmas.usuario_id` tiene
`ON DELETE SET NULL`, así que las alarmas que esa persona reconoció siguen ahí
— se pierde el "quién", no el evento.

Aun así, **desactivar suele ser mejor que borrar**: conserva la trazabilidad y
se puede deshacer. La vista debería ofrecer primero «Desactivar» y dejar el
borrado como acción secundaria con confirmación.

Mismas salvaguardas que el PATCH: no puedes borrarte a ti mismo ni borrar al
último Supervisor activo.
""",
    responses={
        404: {"description": "No existe esa cuenta."},
        409: {"description": "Es tu propia cuenta, o el último Supervisor."},
    },
)
async def borrar_usuario(
    request: Request, usuario: str,
    sesion: Optional[Sesion] = Depends(sesion_actual),
) -> dict:
    db_id = sesion.db_id if sesion else None
    try:
        r = await _auth(request).borrar_usuario(
            usuario, db_id, actor=usuario_de(sesion))
    except ErrorAuth as exc:
        raise HTTPException(exc.codigo, exc.mensaje)

    aud = getattr(request.app.state, "auditoria", None)
    if aud is not None:
        aud.registrar("usuario.borrado", recurso=usuario, sesion=sesion)
    return r


@router.get(
    "/auth/conectados",
    tags=["Autenticación"],
    summary="Quién está trabajando ahora",
    description="Usuarios con sesión activa. Alguien con dos pestañas abiertas "
                "cuenta como una sola persona.",
    responses={200: {"content": {"application/json": {"example": {
        "ok": True, "num_clientes_ws": 3,
        "usuarios": [{"usuario": "jmendoza", "categoria": "Administradores"},
                     {"usuario": "acastro", "categoria": "Usuarios"}],
    }}}}},
)
async def conectados(request: Request) -> dict:
    return {
        "ok": True,
        "usuarios": _auth(request).conectados(),
        "num_sesiones": _auth(request).num_sesiones(),
        "num_clientes_ws": request.app.state.manager.count(),
    }
