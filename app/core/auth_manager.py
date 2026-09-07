# -*- coding: utf-8 -*-
"""
auth_manager.py
===============
Identidad de usuario: cuentas, contraseñas, sesiones y roles.

**Dónde viven los usuarios.** En la tabla SQL `usuarios` que crea
`POST /db/{db_id}/esquema`, no en un JSON aparte. Así se administran con SQL,
se respaldan con la base de datos, y la FK `alarmas.usuario_id` apunta a algo
real. La conexión que se usa se elige con `PLC_AUTH_DB_ID`; si se deja vacía,
se toma la primera conexión dada de alta.

**Contraseñas.** Nunca se guardan en claro. Se usa PBKDF2-HMAC-SHA256 con salt
aleatorio por usuario y 260.000 iteraciones, que es lo que trae la librería
estándar de Python sin dependencias extra. El formato guardado es:

    pbkdf2_sha256$260000$<salt_hex>$<hash_hex>

Las iteraciones van DENTRO del hash, no en el código: así se pueden subir con
el tiempo sin invalidar las contraseñas ya existentes (cada hash se verifica
con las iteraciones con las que se creó, y se puede re-hashear al vuelo).

**Por qué no bcrypt/argon2.** Son mejores, pero traen dependencia binaria que
en Windows a veces falla al instalar. PBKDF2 con 260k iteraciones es aceptable
para un HMI de planta y no añade nada al `requirements.txt`. La columna
`algoritmo` existe justo para poder migrar después sin invalidar nada.

**Sesiones.** Token opaco de 32 bytes en memoria del proceso. Al reiniciar el
servicio todos vuelven a entrar, que es el comportamiento correcto para un
servicio que de todas formas pierde el estado en vivo al reiniciarse. No se usa
JWT a propósito: sin almacén de revocación, un JWT robado vale hasta que expira
y aquí sí queremos poder cerrar sesiones al instante.

**Roles**, de más a menos permisos (los mismos strings que ofrece Login.tsx):

    Supervisor      -> todo, incluida la gestión de usuarios
    Administradores -> editar el diseño, PLCs y conexiones a BD
    Usuarios        -> ver la configuración, no modificarla
    Invitado        -> solo la vista de operación
"""
from __future__ import annotations

import asyncio
import hashlib
import hmac
import logging
import secrets
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional

logger = logging.getLogger("auth_manager")

# ---------------------------------------------------------------------- #
# Roles
# ---------------------------------------------------------------------- #
# Orden de MÁS a MENOS permisos. El índice ES el nivel: cuanto más bajo, más
# poder. `tiene_permiso()` compara índices, así que añadir un rol intermedio
# es insertarlo en esta lista y nada más.
ROLES = ["Supervisor", "Administradores", "Usuarios", "Invitado"]
ROL_POR_DEFECTO = "Usuarios"

ESTADO_ACTIVO = "Activo"
ESTADOS = [ESTADO_ACTIVO, "Inactivo"]

# Parámetros del hash.
ALGORITMO = "pbkdf2_sha256"
ITERACIONES = 260_000

# Duración de una sesión sin actividad.
HORAS_SESION = 12


def _ahora() -> datetime:
    return datetime.now(timezone.utc)


def _iso(dt: datetime) -> str:
    return dt.isoformat().replace("+00:00", "Z")


# ====================================================================== #
# Hash de contraseñas
# ====================================================================== #
def hash_password(password: str, iteraciones: int = ITERACIONES) -> str:
    """Devuelve `pbkdf2_sha256$<iter>$<salt>$<hash>` con salt aleatorio."""
    if not password:
        raise ValueError("La contraseña no puede estar vacía.")
    salt = secrets.token_bytes(16)
    dk = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, iteraciones)
    return f"{ALGORITMO}${iteraciones}${salt.hex()}${dk.hex()}"


def verificar_password(password: str, guardado: str) -> bool:
    """
    Comprueba una contraseña contra el hash guardado.

    La comparación final usa `hmac.compare_digest`, que tarda lo mismo acierte
    o no. Con `==` normal, el tiempo de respuesta filtra cuántos bytes del hash
    coincidían y permite reconstruirlo byte a byte.
    """
    if not password or not guardado:
        return False
    try:
        algoritmo, iteraciones, salt_hex, hash_hex = guardado.split("$", 3)
    except ValueError:
        logger.warning("Hash con formato desconocido; se rechaza el acceso.")
        return False
    if algoritmo != ALGORITMO:
        logger.warning("Algoritmo de hash no soportado: %s", algoritmo)
        return False
    try:
        dk = hashlib.pbkdf2_hmac(
            "sha256", password.encode("utf-8"),
            bytes.fromhex(salt_hex), int(iteraciones),
        )
    except Exception:  # noqa: BLE001
        return False
    return hmac.compare_digest(dk.hex(), hash_hex)


def necesita_rehash(guardado: str) -> bool:
    """True si el hash se creó con menos iteraciones de las actuales."""
    try:
        _, iteraciones, _, _ = guardado.split("$", 3)
        return int(iteraciones) < ITERACIONES
    except Exception:  # noqa: BLE001
        return True


def tiene_permiso(rol_usuario: str, rol_minimo: str) -> bool:
    """
    True si `rol_usuario` es al menos tan poderoso como `rol_minimo`.

    Un rol desconocido se trata como el más bajo: si alguien escribe a mano
    'Jefazo' en la columna, obtiene los permisos de un invitado, no todos.
    """
    try:
        nivel_usuario = ROLES.index(rol_usuario)
    except ValueError:
        nivel_usuario = len(ROLES)
    try:
        nivel_minimo = ROLES.index(rol_minimo)
    except ValueError:
        nivel_minimo = len(ROLES)
    return nivel_usuario <= nivel_minimo


# ====================================================================== #
# Modelos
# ====================================================================== #
@dataclass
class Usuario:
    """Un usuario tal y como lo devuelve la API (SIN el hash)."""

    id: int
    usuario: str
    email: str = ""
    categoria: str = ROL_POR_DEFECTO
    estado: str = ESTADO_ACTIVO
    creado_en: str = ""
    ultimo_acceso: str = ""

    def publico(self) -> dict:
        return {
            "id": self.id, "usuario": self.usuario, "email": self.email,
            "categoria": self.categoria, "estado": self.estado,
            "creado_en": self.creado_en, "ultimo_acceso": self.ultimo_acceso,
        }


@dataclass
class Sesion:
    """
    Sesión activa. Vive solo en memoria del proceso.

    **`db_id` no es decorativo.** Con varias bases dadas de alta, cada tabla
    `usuarios` es independiente: el `id` 3 de la local y el `id` 3 de la nube
    son personas distintas. Guardar aquí contra cuál se autenticó esta sesión
    es lo que impide que un `PATCH /auth/usuarios/x` hecho por alguien que
    entró en local acabe modificando la cuenta homónima del servidor.
    """

    token: str
    usuario: str
    categoria: str
    usuario_id: int
    db_id: str = ""
    creada: datetime = field(default_factory=_ahora)
    ultima_actividad: datetime = field(default_factory=_ahora)

    def caducada(self, horas: int = HORAS_SESION) -> bool:
        return _ahora() - self.ultima_actividad > timedelta(hours=horas)

    def publico(self) -> dict:
        return {
            "usuario": self.usuario, "categoria": self.categoria,
            "usuario_id": self.usuario_id, "db_id": self.db_id,
            "creada": _iso(self.creada),
            "ultima_actividad": _iso(self.ultima_actividad),
        }


class ErrorAuth(Exception):
    """Fallo de autenticación o de autorización, con mensaje para el usuario."""

    def __init__(self, mensaje: str, codigo: int = 401) -> None:
        super().__init__(mensaje)
        self.mensaje = mensaje
        self.codigo = codigo


# ====================================================================== #
# Gestor
# ====================================================================== #
class AuthManager:
    """Autentica contra la tabla `usuarios` y gestiona las sesiones."""

    def __init__(self, db_manager, settings) -> None:
        self._db = db_manager
        self._settings = settings
        self._sesiones: Dict[str, Sesion] = {}
        self._lock = asyncio.Lock()

    # ------------------------------------------------------------------ #
    # Acceso a la tabla
    # ------------------------------------------------------------------ #
    @property
    def tabla(self) -> str:
        prefijo = (self._settings.auth_tabla_prefijo or "").strip()
        if prefijo and not prefijo.endswith("_"):
            prefijo += "_"
        return f"{prefijo}usuarios"

    def _db_id(self, explicito: Optional[str] = None) -> str:
        """
        Conexión donde vive la tabla `usuarios`.

        Orden de precedencia, de más a menos fuerte:

          1. `explicito` — la base que eligió quien está entrando. Solo se
             acepta si está REALMENTE dada de alta: si no se validara, un
             `db_id` inventado desde el navegador acabaría en un mensaje de
             error interno en vez de en uno claro.
          2. `PLC_AUTH_DB_ID` del `.env`.
          3. La primera conexión de la lista. Es una casualidad, no una
             decisión, y por eso `info_bd()` lo marca con `fijada: False`.
        """
        conexiones = self._db.listar_conexiones()

        elegido = (explicito or "").strip()
        if elegido:
            if not any(c["db_id"] == elegido for c in conexiones):
                disponibles = ", ".join(c["db_id"] for c in conexiones) or "ninguna"
                raise ErrorAuth(
                    f"La base de datos '{elegido}' no está dada de alta. "
                    f"Disponibles: {disponibles}.",
                    codigo=404,
                )
            return elegido

        fijado = (self._settings.auth_db_id or "").strip()
        if fijado:
            return fijado

        if not conexiones:
            raise ErrorAuth(
                "No hay ninguna base de datos configurada. Da de alta una "
                "conexión (POST /db) y crea el esquema antes de usar cuentas.",
                codigo=503,
            )
        return conexiones[0]["db_id"]

    def bases_disponibles(self) -> List[Dict[str, Any]]:
        """
        Bases entre las que se puede elegir al entrar. Alimenta el desplegable
        del login, así que es información **pública**: identificador, nombre,
        motor y si responde ahora mismo. Nunca host ni credenciales.

        `por_defecto` marca cuál sale preseleccionada — la de `PLC_AUTH_DB_ID`
        si está fijada, o la primera si no.
        """
        try:
            defecto = self._db_id()
        except ErrorAuth:
            defecto = ""
        salida = []
        for c in self._db.listar_conexiones():
            salida.append({
                "db_id": c["db_id"],
                "nombre": c.get("nombre") or c["db_id"],
                "motor": c.get("motor", ""),
                "etiqueta_motor": c.get("etiqueta_motor", ""),
                "base_datos": c.get("base_datos", ""),
                "conectado": bool(c.get("conectado")),
                "por_defecto": c["db_id"] == defecto,
                # Por qué no responde, cuando no responde. "sin conexión" a
                # secas obliga a adivinar entre un servidor apagado, una
                # contraseña cambiada y una base borrada, que son tres
                # arreglos distintos.
                "estado": c.get("estado", ""),
                "estado_titulo": c.get("estado_titulo", ""),
                "estado_sugerencia": c.get("estado_sugerencia", ""),
            })
        return salida

    async def revisar_bases(self) -> List[Dict[str, Any]]:
        """
        Pregunta al servidor por TODAS las bases dadas de alta y refresca el
        catálogo. Lo llama el login al abrirse: sin esto, la lista enseña lo
        que había en el pool al arrancar el backend, que después de borrar
        una base en el gestor es exactamente lo contrario de la realidad.
        """
        return await self._db.revisar_conexiones()

    async def revisar_base(self, db_id: Optional[str] = None,
                           espera: float = 6.0) -> Dict[str, Any]:
        """
        Igual, pero solo la base elegida. `{}` si no hay ninguna.

        La espera es más corta que la del panel de administración a
        propósito: esto lo llama el LOGIN, y una pantalla de acceso que se
        queda quince segundos en blanco porque un servidor remoto está
        apagado es peor que una que dice "no contesta" en seis.
        """
        try:
            elegida = self._db_id(db_id)
        except ErrorAuth:
            return {}
        return await self._db.revisar_conexion(elegida, espera)

    def estado_base(self, db_id: Optional[str] = None) -> Dict[str, Any]:
        """Última revisión conocida de esa base, sin tocar la red."""
        try:
            elegida = self._db_id(db_id)
        except ErrorAuth:
            return {}
        return self._db.estado_cacheado(elegida)

    def info_bd(self, db_id: Optional[str] = None) -> Dict[str, Any]:
        """
        Qué base de datos respalda las cuentas. Para el badge del login.

        Es información **pública** a propósito (la sirve `/auth/estado`, que no
        exige sesión): quien está a punto de crear una cuenta tiene derecho a
        saber DÓNDE se va a crear. Sin esto, con una conexión local y otra en
        el servidor dadas de alta, no hay forma de distinguir desde la vista en
        cuál acabas de registrarte — y la cuenta que creaste "no existe" la
        próxima vez.

        Devuelve el identificador, el nombre y el motor. **Nunca** el host, el
        usuario ni la contraseña: eso solo lo ve un Administrador autenticado,
        en `GET /db`.

        `fijada` distingue los dos modos:
          * True  -> `PLC_AUTH_DB_ID` la eligió explícitamente.
          * False -> se tomó la primera conexión de la lista, que es una
                     casualidad, no una decisión. La vista lo advierte.
        """
        # Si la base la eligió quien está entrando, "fijada" deja de tener
        # sentido como advertencia: la elección fue explícita, aunque no venga
        # del .env.
        fijada = bool((db_id or "").strip()) or bool(
            (self._settings.auth_db_id or "").strip())
        try:
            db_id = self._db_id(db_id)
        except ErrorAuth as exc:
            return {"configurada": False, "fijada": fijada, "tabla": self.tabla,
                    "mensaje": exc.mensaje}

        conexiones = {c["db_id"]: c for c in self._db.listar_conexiones()}
        c = conexiones.get(db_id)
        if c is None:
            return {
                "configurada": False, "fijada": fijada, "db_id": db_id,
                "tabla": self.tabla,
                "mensaje": (f"PLC_AUTH_DB_ID apunta a '{db_id}', que no está "
                            f"dada de alta. Revísalo o crea esa conexión."),
            }

        return {
            "configurada": True,
            "fijada": fijada,
            "db_id": db_id,
            "nombre": c.get("nombre") or db_id,
            "motor": c.get("motor", ""),
            "etiqueta_motor": c.get("etiqueta_motor", ""),
            "base_datos": c.get("base_datos", ""),
            "conectado": bool(c.get("conectado")),
            "estado": c.get("estado", ""),
            "estado_titulo": c.get("estado_titulo", ""),
            "estado_sugerencia": c.get("estado_sugerencia", ""),
            "tabla": self.tabla,
            "mensaje": c.get("ultimo_error", ""),
        }

    async def _driver(self, db_id: Optional[str] = None):
        elegida = self._db_id(db_id)
        try:
            return await self._db._driver_de(elegida)
        except ErrorAuth:
            raise
        except KeyError as exc:
            raise ErrorAuth(
                f"La conexión '{elegida}' no existe. Revisa PLC_AUTH_DB_ID.",
                codigo=503,
            ) from exc
        except Exception as exc:  # noqa: BLE001
            raise ErrorAuth(
                f"No se pudo conectar a la base de datos de usuarios: {exc}",
                codigo=503,
            ) from exc

    async def _fila_usuario(
        self, usuario: str, db_id: Optional[str] = None
    ) -> Optional[dict]:
        """Lee un usuario por nombre. Devuelve la fila cruda (CON el hash)."""
        driver = await self._driver(db_id)
        # `query()` valida que sea solo lectura; el nombre de usuario va
        # bindeado, nunca concatenado.
        resultado = await driver.query(
            f"SELECT id, usuario, password_hash, algoritmo, email, categoria, "
            f"estado, creado_en, ultimo_acceso FROM {self.tabla} "
            f"WHERE usuario = :u",
            {"u": usuario}, limite=1,
        )
        return resultado.filas[0] if resultado.filas else None

    @staticmethod
    def _a_usuario(fila: dict) -> Usuario:
        return Usuario(
            id=int(fila.get("id") or 0),
            usuario=str(fila.get("usuario") or ""),
            email=str(fila.get("email") or ""),
            categoria=str(fila.get("categoria") or ROL_POR_DEFECTO),
            estado=str(fila.get("estado") or ESTADO_ACTIVO),
            creado_en=str(fila.get("creado_en") or ""),
            ultimo_acceso=str(fila.get("ultimo_acceso") or ""),
        )

    # ------------------------------------------------------------------ #
    # Alta de usuarios
    # ------------------------------------------------------------------ #
    async def registrar(
        self,
        usuario: str,
        password: str,
        email: str = "",
        categoria: str = ROL_POR_DEFECTO,
        estado: str = ESTADO_ACTIVO,
        db_id: Optional[str] = None,
    ) -> Usuario:
        """
        Crea una cuenta. Falla si el nombre ya existe.

        Regla especial: si la tabla está VACÍA, el primer usuario se crea como
        `Supervisor` sin importar lo que pida. Si no, no habría forma de tener
        un administrador inicial sin tocar la base de datos a mano.
        """
        usuario = (usuario or "").strip()
        if len(usuario) < 3:
            raise ErrorAuth("El usuario debe tener al menos 3 caracteres.", 400)
        if len(usuario) > 80:
            raise ErrorAuth("El usuario no puede pasar de 80 caracteres.", 400)
        if len(password or "") < 8:
            raise ErrorAuth("La contraseña debe tener al menos 8 caracteres.", 400)
        if categoria not in ROLES:
            raise ErrorAuth(
                f"Categoría inválida. Opciones: {', '.join(ROLES)}.", 400)
        if estado not in ESTADOS:
            raise ErrorAuth(
                f"Estado inválido. Opciones: {', '.join(ESTADOS)}.", 400)

        driver = await self._driver(db_id)

        if await self._fila_usuario(usuario, db_id) is not None:
            raise ErrorAuth(f"El usuario '{usuario}' ya existe.", 409)

        # "Primer usuario" es POR BASE: cada tabla `usuarios` necesita su
        # propio Supervisor inicial, porque son sistemas de cuentas separados.
        if await self.contar(db_id) == 0:
            categoria = "Supervisor"
            logger.info(
                "Primer usuario del sistema: '%s' se crea como Supervisor.",
                usuario,
            )

        await driver._ejecutar_interno(
            f"INSERT INTO {self.tabla} "
            f"(usuario, password_hash, algoritmo, email, categoria, estado, "
            f"creado_en) VALUES (:u, :p, :a, :e, :c, :s, :t)",
            {
                "u": usuario, "p": hash_password(password), "a": ALGORITMO,
                "e": (email or "").strip() or None, "c": categoria,
                "s": estado, "t": self._ts_para_motor(driver),
            },
        )
        logger.info("Usuario '%s' creado con categoría '%s'.", usuario, categoria)

        fila = await self._fila_usuario(usuario, db_id)
        return self._a_usuario(fila or {"usuario": usuario, "categoria": categoria})

    def _ts_para_motor(self, driver):
        """Marca de tiempo actual en el tipo que espera el motor (siempre UTC)."""
        from app.db.sql_driver import ts_para_motor

        return ts_para_motor(_ahora(), driver.motor)

    async def contar(self, db_id: Optional[str] = None) -> int:
        """Cuántas cuentas hay EN ESA BASE. 0 = 'sistema sin configurar'."""
        try:
            driver = await self._driver(db_id)
            r = await driver.query(f"SELECT COUNT(*) AS n FROM {self.tabla}",
                                   limite=1)
            return int(r.filas[0]["n"]) if r.filas else 0
        except ErrorAuth:
            raise
        except Exception:  # noqa: BLE001
            # La tabla puede no existir todavía: eso es 'sin usuarios'.
            return 0

    async def contar_en_todas(self) -> int:
        """
        Cuentas sumadas de TODAS las bases dadas de alta.

        Existe por un agujero que abre poder elegir base al entrar. El alta de
        la primera cuenta es anónima a propósito (sin eso el sistema no se
        puede poner en marcha), y esa primera cuenta se crea como Supervisor.
        Si "la primera" se midiera por base, con dos bases registradas y una
        vacía, cualquiera podría darse de alta como Supervisor en la vacía,
        entrar con ella... y ser Supervisor de TODO el backend: los permisos
        que concede la sesión no son por base, son del proceso entero.

        Midiendo el total, la puerta de arranque se cierra en cuanto existe la
        primera cuenta en cualquier sitio. Del segundo usuario en adelante hace
        falta un Supervisor, también para estrenar una base nueva.
        """
        total = 0
        for c in self._db.listar_conexiones():
            try:
                total += await self.contar(c["db_id"])
            except Exception as exc:  # noqa: BLE001
                # Una conexión rota NO puede tumbar este conteo. `contar()`
                # re-lanza `ErrorAuth` a propósito (a `/auth/estado` le sirve
                # para decir "esa base no responde"), pero aquí la pregunta es
                # otra: "¿el sistema ya tiene dueño?". Sin este try, una sola
                # conexión vieja e inservible bloquea el alta de la PRIMERA
                # cuenta en una base que funciona perfectamente — que es
                # justo el momento en que nadie puede entrar a arreglarlo.
                logger.warning(
                    "No se pudo contar cuentas en '%s' (%s); se ignora para "
                    "decidir si el sistema ya está inicializado.",
                    c["db_id"], exc,
                )
        return total

    async def listar(self, db_id: Optional[str] = None) -> List[dict]:
        """Todos los usuarios de esa base, sin hashes."""
        driver = await self._driver(db_id)
        r = await driver.query(
            f"SELECT id, usuario, email, categoria, estado, creado_en, "
            f"ultimo_acceso FROM {self.tabla} ORDER BY usuario", limite=500,
        )
        return [self._a_usuario(f).publico() for f in r.filas]

    # ================================================================== #
    # CRUD de usuarios (para la pantalla de gestión)
    # ================================================================== #
    # `listar()` de arriba se mantiene tal cual porque lo usan la pantalla de
    # Actividad y varios sitios más. Lo de aquí abajo es el CRUD completo:
    # buscar, leer uno, crear, editar, renombrar y borrar.

    # Columnas por las que se puede ordenar. Es una LISTA BLANCA, no un
    # parámetro libre: el nombre de una columna no se puede bindear, así que
    # aceptar texto del usuario aquí sería inyección SQL directa.
    ORDENABLES = {
        "usuario": "usuario",
        "categoria": "categoria",
        "estado": "estado",
        "creado_en": "creado_en",
        "ultimo_acceso": "ultimo_acceso",
        "id": "id",
    }

    async def buscar(
        self,
        texto: str = "",
        categoria: str = "",
        estado: str = "",
        orden: str = "usuario",
        descendente: bool = False,
        limite: int = 100,
        desplazamiento: int = 0,
        db_id: Optional[str] = None,
    ) -> dict:
        """
        Listado con búsqueda, filtros, orden y paginación.

        Devuelve `{usuarios, total, limite, desplazamiento}`. El `total` es el
        de la búsqueda SIN paginar: es lo que necesita la vista para pintar
        "mostrando 20 de 137" y decidir si hay página siguiente.

        Todo lo que viene del usuario va BINDEADO (`:texto`, `:cat`...). Lo
        único que se concatena es el nombre de la columna de orden, y solo
        después de pasar por la lista blanca `ORDENABLES`.
        """
        driver = await self._driver(db_id)

        condiciones: List[str] = []
        params: Dict[str, Any] = {}

        if texto and texto.strip():
            # Busca en nombre y correo a la vez: quien busca "juan" no está
            # pensando en qué columna vive lo que escribe.
            condiciones.append("(LOWER(usuario) LIKE :texto OR "
                               "LOWER(COALESCE(email, '')) LIKE :texto)")
            params["texto"] = f"%{texto.strip().lower()}%"
        if categoria:
            if categoria not in ROLES:
                raise ErrorAuth(
                    f"Categoría inválida. Opciones: {', '.join(ROLES)}.", 400)
            condiciones.append("categoria = :cat")
            params["cat"] = categoria
        if estado:
            if estado not in ESTADOS:
                raise ErrorAuth(
                    f"Estado inválido. Opciones: {', '.join(ESTADOS)}.", 400)
            condiciones.append("estado = :est")
            params["est"] = estado

        where = (" WHERE " + " AND ".join(condiciones)) if condiciones else ""

        # Total sin paginar, para que la vista sepa cuántos hay en realidad.
        r_total = await driver.query(
            f"SELECT COUNT(*) AS n FROM {self.tabla}{where}", params, limite=1)
        total = int(r_total.filas[0]["n"]) if r_total.filas else 0

        col = self.ORDENABLES.get((orden or "usuario").lower(), "usuario")
        dir_ = "DESC" if descendente else "ASC"

        limite = max(1, min(int(limite or 100), 500))
        desplazamiento = max(0, int(desplazamiento or 0))

        # La paginación NO es igual en los cuatro motores, y esto es de las
        # cosas que más sorprenden al portar una consulta:
        #
        #   SQL Server  ->  OFFSET n ROWS FETCH NEXT m ROWS ONLY   (SQL:2008)
        #   Los demás   ->  LIMIT m OFFSET n
        #
        # SQLite, MySQL y PostgreSQL NO entienden la forma de SQL Server
        # (SQLite responde literalmente `near "OFFSET": syntax error`), y SQL
        # Server no entiende `LIMIT`. Ambas exigen `ORDER BY`, que aquí
        # siempre está.
        #
        # Los dos números son enteros ya saneados arriba (`max`/`min` sobre
        # `int`), así que interpolarlos es seguro: no hay forma de colar texto.
        if driver.motor == "mssql":
            paginado = f"OFFSET {desplazamiento} ROWS FETCH NEXT {limite} ROWS ONLY"
        else:
            paginado = f"LIMIT {limite} OFFSET {desplazamiento}"

        sql = (
            f"SELECT id, usuario, email, categoria, estado, creado_en, "
            f"ultimo_acceso FROM {self.tabla}{where} "
            f"ORDER BY {col} {dir_} {paginado}"
        )
        r = await driver.query(sql, params, limite=limite)

        return {
            "usuarios": [self._a_usuario(f).publico() for f in r.filas],
            "total": total,
            "limite": limite,
            "desplazamiento": desplazamiento,
            "roles": ROLES,
            "estados": ESTADOS,
        }

    async def obtener(self, usuario: str,
                      db_id: Optional[str] = None) -> dict:
        """Una cuenta concreta, sin el hash. 404 si no existe."""
        fila = await self._fila_usuario(usuario, db_id)
        if fila is None:
            raise ErrorAuth(f"No existe el usuario '{usuario}'.", 404)
        datos = self._a_usuario(fila).publico()
        # Dato útil para la vista: si tiene sesión abierta ahora mismo, avisar
        # antes de desactivarlo o cambiarle el rol.
        datos["conectado"] = any(
            s.usuario == datos["usuario"] for s in self._sesiones.values()
        )
        return datos

    async def contar_supervisores_activos(
        self, excluyendo: str = "", db_id: Optional[str] = None
    ) -> int:
        """
        Cuántos Supervisores ACTIVOS hay, sin contar a `excluyendo`.

        Es la comprobación que evita el peor error posible de esta pantalla:
        quedarse sin ningún administrador. Sin esto, un Supervisor puede
        desactivarse, degradarse o borrarse y dejar el sistema sin nadie que
        pueda gestionar cuentas — y la única salida sería SQL a mano.
        """
        driver = await self._driver(db_id)
        sql = (f"SELECT COUNT(*) AS n FROM {self.tabla} "
               f"WHERE categoria = :c AND estado = :e")
        params: Dict[str, Any] = {"c": "Supervisor", "e": ESTADO_ACTIVO}
        if excluyendo:
            sql += " AND usuario <> :x"
            params["x"] = excluyendo
        r = await driver.query(sql, params, limite=1)
        return int(r.filas[0]["n"]) if r.filas else 0

    async def _proteger_ultimo_supervisor(
        self, usuario: str, db_id: Optional[str], accion: str
    ) -> None:
        """Lanza si `usuario` es el último Supervisor activo que queda."""
        fila = await self._fila_usuario(usuario, db_id)
        if fila is None:
            return
        datos = self._a_usuario(fila)
        if datos.categoria != "Supervisor" or datos.estado != ESTADO_ACTIVO:
            return
        if await self.contar_supervisores_activos(usuario, db_id) == 0:
            raise ErrorAuth(
                f"'{usuario}' es el ÚNICO Supervisor activo. Si {accion}, "
                f"nadie podría volver a gestionar cuentas y habría que "
                f"arreglarlo con SQL a mano. Crea o activa otro Supervisor "
                f"antes.",
                409,
            )

    async def crear_usuario(
        self,
        usuario: str,
        password: str,
        email: str = "",
        categoria: str = ROL_POR_DEFECTO,
        estado: str = ESTADO_ACTIVO,
        db_id: Optional[str] = None,
    ) -> dict:
        """
        Alta desde la pantalla de gestión.

        Se apoya en `registrar()`, que ya valida longitudes, unicidad y hashea
        la contraseña. La diferencia está en quién puede llamarlo: `registrar()`
        cubre además el arranque del sistema (primera cuenta sin sesión), y
        esto es siempre una acción de Supervisor.
        """
        creado = await self.registrar(
            usuario=usuario, password=password, email=email,
            categoria=categoria, estado=estado, db_id=db_id,
        )
        return creado.publico()

    async def actualizar(
        self,
        usuario: str,
        nuevo_usuario: Optional[str] = None,
        email: Optional[str] = None,
        categoria: Optional[str] = None,
        estado: Optional[str] = None,
        password: Optional[str] = None,
        db_id: Optional[str] = None,
        actor: str = "",
    ) -> dict:
        """
        Edición completa de una cuenta. Todos los campos son opcionales.

        `actor` es quien hace el cambio: sirve para impedir que alguien se
        degrade o se desactive a sí mismo, que es la forma más rápida de
        quedarse fuera sin querer.

        Devuelve la lista de cambios aplicados, para la auditoría y para poder
        decirle a la vista qué pasó exactamente.
        """
        driver = await self._driver(db_id)
        fila = await self._fila_usuario(usuario, db_id)
        if fila is None:
            raise ErrorAuth(f"No existe el usuario '{usuario}'.", 404)
        actual = self._a_usuario(fila)

        cambios: List[str] = []
        sets: List[str] = []
        params: Dict[str, Any] = {"u": usuario}

        # ---- Renombrar ------------------------------------------------ #
        renombrado = ""
        if nuevo_usuario is not None:
            nu = nuevo_usuario.strip()
            if nu and nu != usuario:
                if len(nu) < 3 or len(nu) > 80:
                    raise ErrorAuth(
                        "El usuario debe tener entre 3 y 80 caracteres.", 400)
                if await self._fila_usuario(nu, db_id) is not None:
                    raise ErrorAuth(f"El usuario '{nu}' ya existe.", 409)
                sets.append("usuario = :nu")
                params["nu"] = nu
                cambios.append(f"nombre → {nu}")
                renombrado = nu

        # ---- Email ---------------------------------------------------- #
        if email is not None:
            mail = email.strip()
            if mail and len(mail) > 160:
                raise ErrorAuth("El email no puede pasar de 160 caracteres.", 400)
            if mail and ("@" not in mail or "." not in mail.split("@")[-1]):
                raise ErrorAuth(f"El email '{mail}' no parece válido.", 400)
            sets.append("email = :em")
            # Cadena vacía -> NULL: la columna acepta NULL y así se distingue
            # "no tiene correo" de "tiene un correo vacío".
            params["em"] = mail or None
            if mail != (actual.email or ""):
                cambios.append(f"email → {mail or '(vacío)'}")

        # ---- Categoría (rol) ------------------------------------------ #
        if categoria is not None and categoria != actual.categoria:
            if categoria not in ROLES:
                raise ErrorAuth(
                    f"Categoría inválida. Opciones: {', '.join(ROLES)}.", 400)
            if actor and actor == usuario and categoria != "Supervisor":
                raise ErrorAuth(
                    "No puedes quitarte a ti mismo la categoría de Supervisor: "
                    "perderías el acceso a esta pantalla en el acto. Pídeselo "
                    "a otro Supervisor.", 409)
            if categoria != "Supervisor":
                await self._proteger_ultimo_supervisor(
                    usuario, db_id, "le cambias la categoría")
            sets.append("categoria = :cat")
            params["cat"] = categoria
            cambios.append(f"categoría → {categoria}")

        # ---- Estado --------------------------------------------------- #
        desactivar = False
        if estado is not None and estado != actual.estado:
            if estado not in ESTADOS:
                raise ErrorAuth(
                    f"Estado inválido. Opciones: {', '.join(ESTADOS)}.", 400)
            if actor and actor == usuario and estado != ESTADO_ACTIVO:
                raise ErrorAuth(
                    "No puedes desactivar tu propia cuenta: te cerraría la "
                    "sesión al instante y no podrías volver a entrar.", 409)
            if estado != ESTADO_ACTIVO:
                await self._proteger_ultimo_supervisor(
                    usuario, db_id, "lo desactivas")
                desactivar = True
            sets.append("estado = :est")
            params["est"] = estado
            cambios.append(f"estado → {estado}")

        # ---- Contraseña ----------------------------------------------- #
        if password is not None:
            if len(password) < 8:
                raise ErrorAuth(
                    "La contraseña debe tener al menos 8 caracteres.", 400)
            sets.append("password_hash = :pw")
            sets.append("algoritmo = :alg")
            params["pw"] = hash_password(password)
            params["alg"] = ALGORITMO
            cambios.append("contraseña cambiada")

        if not sets:
            return {"ok": True, "usuario": usuario, "cambios": [],
                    "mensaje": "No se indicó ningún cambio."}

        await driver._ejecutar_interno(
            f"UPDATE {self.tabla} SET {', '.join(sets)} WHERE usuario = :u",
            params,
        )

        # ---- Efectos sobre las sesiones abiertas ---------------------- #
        nombre_final = renombrado or usuario
        if desactivar or password is not None or renombrado:
            # Desactivar, cambiar la contraseña o renombrar invalidan la
            # sesión: en los tres casos, seguir dentro con el estado anterior
            # sería incorrecto.
            await self.cerrar_sesiones_de(usuario)
        elif categoria is not None:
            # Un cambio de rol SÍ puede aplicarse en caliente: la persona
            # sigue siendo quien era, solo cambia lo que puede hacer.
            async with self._lock:
                for s in self._sesiones.values():
                    if s.usuario == usuario:
                        s.categoria = categoria

        logger.info("Usuario '%s' modificado (%s).", usuario, ", ".join(cambios))
        return {"ok": True, "usuario": nombre_final, "anterior": usuario,
                "cambios": cambios,
                "mensaje": f"{nombre_final}: {', '.join(cambios)}."}

    async def borrar_usuario(
        self, usuario: str, db_id: Optional[str] = None, actor: str = ""
    ) -> dict:
        """
        Borra una cuenta de verdad (DELETE, no marcarla como inactiva).

        Es seguro para el histórico: `alarmas.usuario_id` tiene
        `ON DELETE SET NULL`, así que las alarmas que esa persona reconoció
        siguen ahí — se pierde el "quién", no el evento.

        Aun así, casi siempre es mejor **desactivar** que borrar: conserva la
        trazabilidad y se puede revertir. Por eso la vista debería ofrecer
        primero «Desactivar».
        """
        if actor and actor == usuario:
            raise ErrorAuth(
                "No puedes borrar tu propia cuenta. Pídeselo a otro Supervisor.",
                409)

        fila = await self._fila_usuario(usuario, db_id)
        if fila is None:
            raise ErrorAuth(f"No existe el usuario '{usuario}'.", 404)

        await self._proteger_ultimo_supervisor(usuario, db_id, "lo borras")

        driver = await self._driver(db_id)
        await driver._ejecutar_interno(
            f"DELETE FROM {self.tabla} WHERE usuario = :u", {"u": usuario})
        await self.cerrar_sesiones_de(usuario)

        logger.info("Usuario '%s' eliminado por '%s'.", usuario, actor or "-")
        return {"ok": True, "usuario": usuario,
                "mensaje": f"Cuenta '{usuario}' eliminada. Las alarmas que "
                           f"reconoció se conservan, sin el nombre."}

    async def cambiar_estado(
        self, usuario: str, estado: str, db_id: Optional[str] = None
    ) -> dict:
        """Activa o desactiva una cuenta, y cierra sus sesiones si se desactiva."""
        if estado not in ESTADOS:
            raise ErrorAuth(
                f"Estado inválido. Opciones: {', '.join(ESTADOS)}.", 400)
        driver = await self._driver(db_id)
        if await self._fila_usuario(usuario, db_id) is None:
            raise ErrorAuth(f"No existe el usuario '{usuario}'.", 404)

        await driver._ejecutar_interno(
            f"UPDATE {self.tabla} SET estado = :s WHERE usuario = :u",
            {"s": estado, "u": usuario},
        )
        if estado != ESTADO_ACTIVO:
            # Desactivar a alguien tiene que echarlo AHORA, no cuando caduque
            # su sesión: si se desactiva una cuenta suele ser por un motivo.
            await self.cerrar_sesiones_de(usuario)
        return {"ok": True, "usuario": usuario, "estado": estado}

    async def cambiar_categoria(
        self, usuario: str, categoria: str, db_id: Optional[str] = None
    ) -> dict:
        """Cambia el rol y refresca las sesiones abiertas de esa persona."""
        if categoria not in ROLES:
            raise ErrorAuth(
                f"Categoría inválida. Opciones: {', '.join(ROLES)}.", 400)
        driver = await self._driver(db_id)
        if await self._fila_usuario(usuario, db_id) is None:
            raise ErrorAuth(f"No existe el usuario '{usuario}'.", 404)

        await driver._ejecutar_interno(
            f"UPDATE {self.tabla} SET categoria = :c WHERE usuario = :u",
            {"c": categoria, "u": usuario},
        )
        # Que el cambio de permisos aplique sin obligar a volver a entrar.
        async with self._lock:
            for s in self._sesiones.values():
                if s.usuario == usuario:
                    s.categoria = categoria
        return {"ok": True, "usuario": usuario, "categoria": categoria}

    async def cambiar_password(
        self, usuario: str, password_nueva: str, db_id: Optional[str] = None
    ) -> dict:
        """Fija una contraseña nueva (ya hasheada) para un usuario."""
        if len(password_nueva or "") < 8:
            raise ErrorAuth("La contraseña debe tener al menos 8 caracteres.", 400)
        driver = await self._driver(db_id)
        if await self._fila_usuario(usuario, db_id) is None:
            raise ErrorAuth(f"No existe el usuario '{usuario}'.", 404)
        await driver._ejecutar_interno(
            f"UPDATE {self.tabla} SET password_hash = :p, algoritmo = :a "
            f"WHERE usuario = :u",
            {"p": hash_password(password_nueva), "a": ALGORITMO, "u": usuario},
        )
        return {"ok": True, "usuario": usuario}

    # ------------------------------------------------------------------ #
    # Login / sesiones
    # ------------------------------------------------------------------ #
    async def login(
        self, usuario: str, password: str, db_id: Optional[str] = None
    ) -> dict:
        """
        Verifica credenciales y abre una sesión.

        El mensaje de error es el MISMO tanto si el usuario no existe como si
        la contraseña es incorrecta. Distinguirlos permitiría averiguar qué
        cuentas existen probando nombres.
        """
        usuario = (usuario or "").strip()
        # Resolver la base ANTES de tocarla: si el db_id no existe, el error
        # dice cuál se pidió y cuáles hay, en vez de un fallo de conexión.
        elegida = self._db_id(db_id)
        fila = await self._fila_usuario(usuario, elegida)

        if fila is None or not verificar_password(
            password, str(fila.get("password_hash") or "")
        ):
            logger.warning("Intento de acceso fallido para '%s'.", usuario)
            raise ErrorAuth("Usuario o contraseña incorrectos.", 401)

        datos = self._a_usuario(fila)
        if datos.estado != ESTADO_ACTIVO:
            raise ErrorAuth(
                f"La cuenta '{usuario}' está {datos.estado.lower()}. "
                f"Contacta con un supervisor.", 403,
            )

        driver = await self._driver(elegida)

        # Subir el coste del hash si la cuenta es antigua. Se hace aquí porque
        # es el único momento en que la contraseña en claro está disponible.
        if necesita_rehash(str(fila.get("password_hash") or "")):
            try:
                await driver._ejecutar_interno(
                    f"UPDATE {self.tabla} SET password_hash = :p WHERE usuario = :u",
                    {"p": hash_password(password), "u": usuario},
                )
                logger.info("Hash de '%s' actualizado a %d iteraciones.",
                            usuario, ITERACIONES)
            except Exception as exc:  # noqa: BLE001
                logger.warning("No se pudo re-hashear a '%s': %s", usuario, exc)

        try:
            await driver._ejecutar_interno(
                f"UPDATE {self.tabla} SET ultimo_acceso = :t WHERE usuario = :u",
                {"t": self._ts_para_motor(driver), "u": usuario},
            )
        except Exception as exc:  # noqa: BLE001
            # No poder anotar el acceso no debe impedir entrar.
            logger.warning("No se pudo actualizar ultimo_acceso: %s", exc)

        token = secrets.token_urlsafe(32)
        sesion = Sesion(token=token, usuario=datos.usuario,
                        categoria=datos.categoria, usuario_id=datos.id,
                        db_id=elegida)
        async with self._lock:
            self._limpiar_caducadas()
            self._sesiones[token] = sesion

        logger.info("'%s' inició sesión (%s) contra la base '%s'.",
                    datos.usuario, datos.categoria, elegida)
        return {"ok": True, "token": token, "usuario": datos.publico(),
                "db_id": elegida, "expira_horas": HORAS_SESION}

    def sesion_de(self, token: Optional[str]) -> Optional[Sesion]:
        """Devuelve la sesión de un token, renovando su actividad."""
        if not token:
            return None
        sesion = self._sesiones.get(token)
        if sesion is None:
            return None
        if sesion.caducada():
            self._sesiones.pop(token, None)
            return None
        sesion.ultima_actividad = _ahora()
        return sesion

    async def logout(self, token: str) -> dict:
        async with self._lock:
            sesion = self._sesiones.pop(token, None)
        if sesion:
            logger.info("'%s' cerró sesión.", sesion.usuario)
        return {"ok": True}

    async def cerrar_sesiones_de(self, usuario: str) -> int:
        """Invalida todas las sesiones de una persona. Devuelve cuántas."""
        async with self._lock:
            tokens = [t for t, s in self._sesiones.items() if s.usuario == usuario]
            for t in tokens:
                self._sesiones.pop(t, None)
        if tokens:
            logger.info("Cerradas %d sesión(es) de '%s'.", len(tokens), usuario)
        return len(tokens)

    def _limpiar_caducadas(self) -> None:
        for t in [t for t, s in self._sesiones.items() if s.caducada()]:
            self._sesiones.pop(t, None)

    def conectados(self) -> List[dict]:
        """Usuarios con sesión activa (para la barra de presencia)."""
        self._limpiar_caducadas()
        vistos: Dict[str, dict] = {}
        for s in self._sesiones.values():
            # Una persona con dos pestañas es UNA persona conectada.
            if s.usuario not in vistos:
                vistos[s.usuario] = {"usuario": s.usuario,
                                     "categoria": s.categoria}
        return sorted(vistos.values(), key=lambda x: x["usuario"])

    def num_sesiones(self) -> int:
        self._limpiar_caducadas()
        return len(self._sesiones)
