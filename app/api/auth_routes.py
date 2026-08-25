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
  GET    /auth/usuarios     -> listar cuentas            [Administradores]
  PATCH  /auth/usuarios/{u} -> cambiar rol/estado/clave  [Supervisor]
  GET    /auth/conectados   -> quién está trabajando ahora

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
        return await auth.contar() == 0
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


class NuevoUsuario(Credenciales):
    email: str = Field(default="", examples=["jmendoza@psi.pe"])
    categoria: str = Field(
        default=ROL_POR_DEFECTO,
        description=f"Una de: {', '.join(ROLES)} (de más a menos permisos).",
    )
    estado: str = Field(default="Activo", description=" | ".join(ESTADOS))


class CambioUsuario(BaseModel):
    """Cuerpo de PATCH /auth/usuarios/{usuario}. Todo opcional."""

    categoria: Optional[str] = Field(default=None, description=" | ".join(ROLES))
    estado: Optional[str] = Field(default=None, description=" | ".join(ESTADOS))
    password: Optional[str] = Field(
        default=None, description="Nueva contraseña (mínimo 8 caracteres)."
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
        "roles": ROLES, "mensaje": "No hay cuentas: la primera será Supervisor.",
    }}}}},
)
async def estado_auth(request: Request) -> dict:
    auth = _auth(request)
    try:
        total = await auth.contar()
        disponible = True
        detalle = ""
    except ErrorAuth as exc:
        total, disponible, detalle = 0, False, exc.mensaje

    return {
        "ok": True,
        "hay_usuarios": total > 0,
        "num_usuarios": total,
        "auth_requerida": request.app.state.settings.auth_requerida,
        "bd_disponible": disponible,
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
        if await auth.contar() > 0 and request.app.state.settings.auth_requerida:
            if sesion is None:
                raise HTTPException(401, "Necesitas iniciar sesión.")
            if not tiene_permiso(sesion.categoria, "Supervisor"):
                raise HTTPException(
                    403, "Solo un Supervisor puede crear cuentas nuevas.")

        usuario = await auth.registrar(
            usuario=cuerpo.usuario, password=cuerpo.password,
            email=cuerpo.email, categoria=cuerpo.categoria,
            estado=cuerpo.estado,
        )
        aud = getattr(request.app.state, "auditoria", None)
        if aud is not None:
            aud.registrar("usuario.creado", usuario_de(sesion), usuario.usuario,
                          {"categoria": usuario.categoria})
        return {"ok": True, "usuario": usuario.publico(),
                "mensaje": f"Cuenta '{usuario.usuario}' creada."}
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
        return await _auth(request).login(cuerpo.usuario, cuerpo.password)
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
async def listar_usuarios(request: Request) -> dict:
    try:
        return {"ok": True, "usuarios": await _auth(request).listar()}
    except ErrorAuth as exc:
        raise HTTPException(exc.codigo, exc.mensaje)


@router.patch(
    "/auth/usuarios/{usuario}",
    tags=["Autenticación"],
    summary="Cambiar rol, estado o contraseña de una cuenta",
    dependencies=[Depends(exigir_rol("Supervisor"))],
    description="Desactivar una cuenta cierra sus sesiones **al instante**, "
                "no cuando caduquen: si se desactiva a alguien, suele haber "
                "un motivo para que salga ya.",
)
async def modificar_usuario(
    request: Request,
    usuario: str,
    cuerpo: CambioUsuario = Body(...),
) -> dict:
    auth = _auth(request)
    hechos = []
    try:
        if cuerpo.categoria is not None:
            await auth.cambiar_categoria(usuario, cuerpo.categoria)
            hechos.append(f"categoría → {cuerpo.categoria}")
        if cuerpo.estado is not None:
            await auth.cambiar_estado(usuario, cuerpo.estado)
            hechos.append(f"estado → {cuerpo.estado}")
        if cuerpo.password is not None:
            await auth.cambiar_password(usuario, cuerpo.password)
            await auth.cerrar_sesiones_de(usuario)
            hechos.append("contraseña cambiada (sesiones cerradas)")
    except ErrorAuth as exc:
        raise HTTPException(exc.codigo, exc.mensaje)

    aud = getattr(request.app.state, "auditoria", None)
    if aud is not None and hechos:
        # Cambiar el rol o desactivar a alguien es de lo más sensible que se
        # puede hacer aquí: siempre queda registrado.
        aud.registrar("usuario.modificado", "", usuario, {"cambios": hechos})

    if not hechos:
        return {"ok": False, "mensaje": "No se indicó ningún cambio."}
    return {"ok": True, "usuario": usuario, "cambios": hechos,
            "mensaje": f"{usuario}: {', '.join(hechos)}."}


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
