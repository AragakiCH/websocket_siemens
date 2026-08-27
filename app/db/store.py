# -*- coding: utf-8 -*-
"""
store.py
========
Persistencia de las conexiones a BD y de las consultas guardadas.

A diferencia de los PLCs (que se dan de alta en cada arranque), las conexiones
a base de datos y sus consultas deben sobrevivir al reinicio del servidor: son
parte del diseño del HMI, no del estado de ejecución.

Se guarda en ficheros JSON junto al ejecutable / raíz del proyecto:

    datos/conexiones.json   -> conexiones (contraseñas CIFRADAS)
    datos/consultas.json    -> consultas guardadas (SQL + parámetros)
    datos/historicos.json   -> grupos de historización (qué tags se guardan)
    datos/.clave            -> clave de cifrado (permisos restringidos)

**Cifrado**: las contraseñas se cifran con Fernet (AES-128-CBC + HMAC, de la
librería `cryptography`). La clave se genera sola la primera vez y se guarda
en `datos/.clave`.

Limitación honesta: si alguien tiene acceso de lectura al disco del servidor,
tiene la clave y las contraseñas. Esto protege frente a "abrir el JSON y leer
la contraseña" (backups, capturas, repositorios), NO frente a un atacante con
acceso al sistema. Para eso haría falta un gestor de secretos externo o pedir
la contraseña maestra al arrancar.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import stat
import threading
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional

from cryptography.fernet import Fernet, InvalidToken

logger = logging.getLogger("db_store")

PREFIJO_CIFRADO = "enc:"   # marca los valores cifrados dentro del JSON


# ====================================================================== #
# Clave de cifrado compartida
# ====================================================================== #
def cargar_o_crear_clave(ruta_clave: Path) -> bytes:
    """
    Lee la clave Fernet de disco; si no existe, la genera y la protege.

    Está a nivel de módulo (y no dentro de `DbStore`) porque la comparten
    varios stores: las contraseñas de las conexiones a BD y las de los PLCs
    Rexroth se cifran con la MISMA clave, en `datos/.clave`. Una sola clave
    significa un solo fichero que respaldar y que proteger.
    """
    if ruta_clave.is_file():
        return ruta_clave.read_bytes().strip()

    ruta_clave.parent.mkdir(parents=True, exist_ok=True)
    clave = Fernet.generate_key()
    ruta_clave.write_bytes(clave)
    try:
        # Solo el propietario puede leerla (efectivo en Linux; en Windows es
        # orientativo, ahí manda la ACL de la carpeta).
        os.chmod(ruta_clave, stat.S_IRUSR | stat.S_IWUSR)
    except OSError:
        pass
    logger.info("Clave de cifrado creada en %s", ruta_clave)
    return clave


def carpeta_datos(carpeta: Optional[str] = None) -> Path:
    """
    Carpeta donde se persiste el estado de la aplicación, creada si no existe.

    Ahí viven conexiones, consultas, grupos de historización, PLCs, proyectos y
    la auditoría. Se resuelve en este orden:

      1. El argumento `carpeta`, si se pasa.
      2. La variable de entorno **`PLC_DATOS_DIR`**.
      3. La carpeta por defecto, que depende de cómo se esté ejecutando:
         en desarrollo `<raíz>/datos`; empaquetado, la carpeta de datos del
         SISTEMA (`C:\ProgramData\PsiCore\datos`), para que desinstalar o
         actualizar la aplicación no se lleve por delante la configuración.

    El paso 2 existe por dos motivos reales:

      * **Pruebas aisladas.** `tools/probar_multiusuario.py` levanta un backend
        de verdad; sin esto escribiría en la carpeta `datos/` de la instalación
        real y pisaría conexiones y proyectos del usuario.
      * **Despliegues a medida**, donde la carpeta la decide quien instala.

    La lógica vive en `app/config/rutas.py`, que además MIGRA los datos de una
    instalación anterior si la carpeta nueva está vacía. Ver ese módulo para el
    razonamiento completo (incluido por qué no es `Documentos`).
    """
    from app.config.rutas import resolver_carpeta_datos

    return resolver_carpeta_datos(carpeta)


# ====================================================================== #
# Modelos persistidos
# ====================================================================== #
@dataclass
class ConexionGuardada:
    """Una conexión a base de datos tal y como se guarda en disco."""

    db_id: str                       # identificador único (lo usa el widget)
    motor: str                       # postgresql | mysql | mssql | sqlite
    nombre: str = ""                 # etiqueta legible ("Producción MES")
    host: str = ""
    puerto: Optional[int] = None
    base_datos: str = ""
    usuario: str = ""
    password: str = ""               # en disco va cifrada
    opciones: Dict[str, str] = field(default_factory=dict)
    autoconectar: bool = True        # abrir el pool al arrancar el servidor

    def publico(self) -> dict:
        """Versión sin contraseña, apta para devolver por la API."""
        d = asdict(self)
        d.pop("password", None)
        return d


@dataclass
class ConsultaGuardada:
    """
    Una consulta registrada que los widgets pueden ejecutar por su id.

    El widget nunca manda SQL: manda `query_id` + valores de parámetros. Así
    el SQL vive solo en el servidor y no se puede manipular desde el navegador.
    """

    query_id: str
    db_id: str                        # conexión sobre la que se ejecuta
    nombre: str = ""
    sql: str = ""
    # Parámetros declarados: {"fecha": {"tipo": "string", "defecto": "2026-01-01"}}
    parametros: Dict[str, Dict[str, Any]] = field(default_factory=dict)
    limite: int = 1000
    descripcion: str = ""

    def publico(self) -> dict:
        return asdict(self)


# ====================================================================== #
# Almacén
# ====================================================================== #
class DbStore:
    """Lee y escribe conexiones y consultas, cifrando las contraseñas."""

    def __init__(self, carpeta: Optional[str] = None) -> None:
        self.carpeta = carpeta_datos(carpeta)

        self.ruta_conexiones = self.carpeta / "conexiones.json"
        self.ruta_consultas = self.carpeta / "consultas.json"
        self.ruta_historicos = self.carpeta / "historicos.json"
        self.ruta_clave = self.carpeta / ".clave"

        # Serialización de escrituras (ver `guardar` / `guardar_async`).
        # Son dos locks porque hay dos mundos: llamadores síncronos y async.
        self._lock_hilos = threading.Lock()
        self._lock_async = asyncio.Lock()

        self._fernet = Fernet(self._cargar_o_crear_clave())
        self.conexiones: Dict[str, ConexionGuardada] = {}
        self.consultas: Dict[str, ConsultaGuardada] = {}
        # Grupos de historización (se guardan como dicts planos: los
        # gestiona el Historizador, el store solo los persiste).
        self.historicos: Dict[str, dict] = {}
        self.cargar()

    # ------------------------------------------------------------------ #
    # Clave de cifrado
    # ------------------------------------------------------------------ #
    def _cargar_o_crear_clave(self) -> bytes:
        """Lee la clave de disco; si no existe, la genera y la protege."""
        return cargar_o_crear_clave(self.ruta_clave)

    def cifrar(self, texto: str) -> str:
        """Cifra una contraseña. Cadena vacía se deja tal cual."""
        if not texto:
            return ""
        return PREFIJO_CIFRADO + self._fernet.encrypt(texto.encode()).decode()

    def descifrar(self, valor: str) -> str:
        """
        Descifra un valor guardado. Si no lleva el prefijo, se asume que es
        texto plano (por ejemplo si alguien editó el JSON a mano).
        """
        if not valor:
            return ""
        if not valor.startswith(PREFIJO_CIFRADO):
            return valor
        try:
            return self._fernet.decrypt(
                valor[len(PREFIJO_CIFRADO):].encode()
            ).decode()
        except InvalidToken:
            logger.error(
                "No se pudo descifrar una contraseña: la clave de cifrado no "
                "corresponde. ¿Se copió conexiones.json sin su .clave?"
            )
            return ""

    # ------------------------------------------------------------------ #
    # Carga y guardado
    # ------------------------------------------------------------------ #
    def cargar(self) -> None:
        """Lee los tres ficheros. Si están corruptos, arranca vacío y avisa."""
        self.conexiones = {}
        self.consultas = {}
        self.historicos = {}

        if self.ruta_conexiones.is_file():
            try:
                crudo = json.loads(self.ruta_conexiones.read_text("utf-8"))
                for d in crudo:
                    c = ConexionGuardada(**d)
                    self.conexiones[c.db_id] = c
            except Exception as exc:  # noqa: BLE001
                logger.error("conexiones.json ilegible (%s); se ignora.", exc)

        if self.ruta_consultas.is_file():
            try:
                crudo = json.loads(self.ruta_consultas.read_text("utf-8"))
                for d in crudo:
                    q = ConsultaGuardada(**d)
                    self.consultas[q.query_id] = q
            except Exception as exc:  # noqa: BLE001
                logger.error("consultas.json ilegible (%s); se ignora.", exc)

        if self.ruta_historicos.is_file():
            try:
                crudo = json.loads(self.ruta_historicos.read_text("utf-8"))
                for d in crudo:
                    self.historicos[d["grupo_id"]] = d
            except Exception as exc:  # noqa: BLE001
                logger.error("historicos.json ilegible (%s); se ignora.", exc)

        logger.info(
            "Store cargado: %d conexión(es), %d consulta(s), %d grupo(s) de "
            "historización.",
            len(self.conexiones), len(self.consultas), len(self.historicos))

    def guardar(self) -> None:
        """
        Vuelca los tres ficheros a disco (escritura atómica).

        MULTIUSUARIO: esta versión es SÍNCRONA y se sigue usando desde código
        que no es async. El acceso concurrente se serializa con un lock de
        hilos (`_lock_hilos`), porque el volcado es un leer-modificar-escribir
        sobre diccionarios compartidos: sin él, dos peticiones simultáneas
        pueden entrelazarse y la última escritura gana, perdiendo la otra.

        Desde código async, usar `guardar_async()`: además de tomar el lock,
        saca la I/O del bucle de eventos.
        """
        with self._lock_hilos:
            self._volcar()

    async def guardar_async(self) -> None:
        """
        Igual que `guardar()`, pero apta para llamarse desde código async.

        Escribir tres JSON completos es I/O bloqueante: hacerlo dentro del
        bucle de eventos congela TODOS los WebSockets mientras dura. Con diez
        clientes recibiendo tags en vivo eso se nota. Por eso el volcado se
        delega a un hilo con `run_in_executor`.

        El `asyncio.Lock` serializa a los llamadores async entre sí; el lock de
        hilos de dentro protege frente a los llamadores síncronos.
        """
        async with self._lock_async:
            bucle = asyncio.get_running_loop()
            await bucle.run_in_executor(None, self.guardar)

    def _volcar(self) -> None:
        """Serializa el estado actual a los tres ficheros. Asume lock tomado."""
        self._escribir(
            self.ruta_conexiones,
            [asdict(c) for c in self.conexiones.values()],
        )
        self._escribir(
            self.ruta_consultas,
            [asdict(q) for q in self.consultas.values()],
        )
        self._escribir(self.ruta_historicos, list(self.historicos.values()))

    @staticmethod
    def _escribir(ruta: Path, datos: List[dict]) -> None:
        """Escribe primero en .tmp y luego renombra: evita ficheros a medias."""
        tmp = ruta.with_suffix(ruta.suffix + ".tmp")
        tmp.write_text(
            json.dumps(datos, indent=2, ensure_ascii=False), encoding="utf-8"
        )
        tmp.replace(ruta)

    # ------------------------------------------------------------------ #
    # Operaciones sobre conexiones
    # ------------------------------------------------------------------ #
    def guardar_conexion(self, conexion: ConexionGuardada,
                         password_plano: str) -> ConexionGuardada:
        """Añade o actualiza una conexión, cifrando su contraseña."""
        conexion.password = self.cifrar(password_plano)
        self.conexiones[conexion.db_id] = conexion
        self.guardar()
        return conexion

    def borrar_conexion(self, db_id: str) -> bool:
        """Borra la conexión y TODAS sus consultas asociadas."""
        if db_id not in self.conexiones:
            return False
        del self.conexiones[db_id]
        huerfanas = [q for q, c in self.consultas.items() if c.db_id == db_id]
        for q in huerfanas:
            del self.consultas[q]
        if huerfanas:
            logger.info("Borradas %d consulta(s) de la conexión %s.",
                        len(huerfanas), db_id)
        # Los grupos de historización que escribían en esta BD también sobran.
        grupos = [g for g, d in self.historicos.items() if d.get("db_id") == db_id]
        for g in grupos:
            del self.historicos[g]
        if grupos:
            logger.info("Borrados %d grupo(s) de historización de la conexión %s.",
                        len(grupos), db_id)
        self.guardar()
        return True

    def password_de(self, db_id: str) -> str:
        """Contraseña en claro de una conexión (solo para uso interno)."""
        c = self.conexiones.get(db_id)
        return self.descifrar(c.password) if c else ""

    # ------------------------------------------------------------------ #
    # Operaciones sobre consultas
    # ------------------------------------------------------------------ #
    def guardar_consulta(self, consulta: ConsultaGuardada) -> ConsultaGuardada:
        self.consultas[consulta.query_id] = consulta
        self.guardar()
        return consulta

    def borrar_consulta(self, query_id: str) -> bool:
        if query_id not in self.consultas:
            return False
        del self.consultas[query_id]
        self.guardar()
        return True

    # ------------------------------------------------------------------ #
    # Operaciones sobre grupos de historización
    # ------------------------------------------------------------------ #
    def guardar_grupo_historico(self, grupo: dict) -> None:
        self.historicos[grupo["grupo_id"]] = grupo
        self.guardar()

    def borrar_grupo_historico(self, grupo_id: str) -> bool:
        if grupo_id not in self.historicos:
            return False
        del self.historicos[grupo_id]
        self.guardar()
        return True

    def grupos_historicos(self, db_id: Optional[str] = None) -> List[dict]:
        """Grupos guardados, opcionalmente filtrados por conexión."""
        return [
            g for g in self.historicos.values()
            if db_id is None or g.get("db_id") == db_id
        ]

    def consultas_de(self, db_id: Optional[str] = None) -> List[ConsultaGuardada]:
        """Consultas de una conexión, o todas si `db_id` es None."""
        return [
            q for q in self.consultas.values()
            if db_id is None or q.db_id == db_id
        ]
