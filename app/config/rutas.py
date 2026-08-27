# -*- coding: utf-8 -*-
"""
rutas.py
========
Dónde vive el estado de la aplicación, y cómo sobrevive a una reinstalación.

EL PROBLEMA
-----------
Hasta ahora los datos se guardaban en `<raíz del proyecto>/datos`. En
desarrollo está bien. En una instalación de escritorio es un desastre:

  * `Program Files` es de solo lectura para un usuario normal, así que ni
    siquiera se podría escribir;
  * y si se escribiera junto al `.exe`, **desinstalar o actualizar la versión
    se llevaría por delante los PLCs, las pantallas y las conexiones**.

QUÉ SE ELIGIÓ, Y POR QUÉ NO "DOCUMENTOS"
----------------------------------------
`C:\\ProgramData\\PsiCore\\datos` (y su equivalente en Linux).

La tentación es Documentos, porque se encuentra fácil. Pero **esto es un
servidor, no una aplicación personal**: los PLCs dados de alta, las pantallas
del diseñador y las conexiones a base de datos pertenecen a la INSTALACIÓN, no
a quien tenga la sesión de Windows abierta.

Con los datos en `Documentos` o en `%APPDATA%`, el turno de noche que entra con
otra cuenta de Windows se encuentra el HMI vacío. Y si mañana el servidor corre
como servicio de Windows —lo razonable en planta— correría con una cuenta de
sistema que tampoco vería nada de lo configurado.

Hay un segundo motivo, menor pero real: en esa carpeta está `.clave`, que
descifra todas las contraseñas de bases de datos. `Documentos` suele estar
sincronizado con OneDrive, y esa clave no debería acabar en la nube sin que
nadie lo haya decidido.

Para lo que sí se buscaba con "que se vea en Documentos" están las dos cosas
que acompañan a este módulo: la app enseña la ruta real y la abre en el
Explorador, y ofrece una copia de seguridad en `.zip` que sí puede guardarse
donde uno quiera.

MIGRACIÓN
---------
Nadie debería perder su configuración por actualizar. Al arrancar, si la
carpeta nueva está vacía y hay datos en alguna de las antiguas, se COPIAN.
Se copia y no se mueve a propósito: si algo saliera mal a mitad, el original
sigue intacto. La carpeta de origen queda marcada con un fichero que dice a
dónde se fue, para que nadie edite la copia equivocada durante meses.
"""
from __future__ import annotations

import os
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

APP = "PsiCore"

# Ficheros que hacen que una carpeta cuente como "tiene datos de verdad".
# `.clave` sola no basta: se crea vacía en cuanto alguien arranca el servicio.
SENALES = (
    "conexiones.json",
    "plcs.json",
    "consultas.json",
    "historicos.json",
    "auditoria.jsonl",
    "proyectos",
)

MARCA_MIGRACION = "_MIGRADO_A.txt"


def _raiz_proyecto() -> Path:
    """Raíz del repositorio (tres niveles por encima de este archivo)."""
    return Path(__file__).resolve().parent.parent.parent


def empaquetado() -> bool:
    """True si corre como `.exe` de PyInstaller."""
    return bool(getattr(sys, "frozen", False))


def carpeta_por_defecto() -> Path:
    """
    Dónde guardar cuando nadie lo ha dicho explícitamente.

    Empaquetado -> carpeta de datos del SISTEMA (compartida entre usuarios).
    En desarrollo -> `<raíz>/datos`, el comportamiento de siempre, para no
    ensuciar la máquina de nadie mientras se programa.
    """
    if not empaquetado():
        return _raiz_proyecto() / "datos"

    if os.name == "nt":
        # ProgramData, no AppData: los datos son de la máquina, no del usuario.
        base = os.getenv("PROGRAMDATA") or r"C:\ProgramData"
        return Path(base) / APP / "datos"

    # Linux/macOS: /var/lib si se puede escribir (equivalente a ProgramData),
    # y si no, la carpeta del usuario. Un servicio de sistema usa la primera.
    sistema = Path("/var/lib") / APP.lower() / "datos"
    try:
        sistema.parent.mkdir(parents=True, exist_ok=True)
        prueba = sistema.parent / ".escritura"
        prueba.touch()
        prueba.unlink()
        return sistema
    except Exception:  # noqa: BLE001
        return Path.home() / ".local" / "share" / APP.lower() / "datos"


def _tiene_datos(carpeta: Path) -> bool:
    """¿Hay algo que valga la pena conservar aquí?"""
    if not carpeta.is_dir():
        return False
    for nombre in SENALES:
        p = carpeta / nombre
        if p.is_file() and p.stat().st_size > 2:
            return True
        if p.is_dir() and any(p.iterdir()):
            return True
    return False


def _candidatas_antiguas(destino: Path) -> List[Path]:
    """
    Sitios donde pudo quedar la configuración de una versión anterior.

    En orden de preferencia: junto al ejecutable (instalación previa) y la
    carpeta del proyecto (alguien que venía de ejecutar desde el código).
    """
    posibles: List[Path] = []
    if empaquetado():
        posibles.append(Path(sys.executable).resolve().parent / "datos")
    posibles.append(_raiz_proyecto() / "datos")
    return [p for p in posibles if p.resolve() != destino.resolve()]


def migrar_si_hace_falta(destino: Path) -> Optional[Dict[str, Any]]:
    """
    Copia los datos de una instalación anterior si el destino está vacío.

    Devuelve un resumen de lo migrado, o `None` si no hubo nada que hacer.
    NUNCA sobrescribe: si el destino ya tiene datos, no se toca nada. Una
    migración que pisa lo actual con lo viejo es peor que no migrar.
    """
    if _tiene_datos(destino):
        return None

    for origen in _candidatas_antiguas(destino):
        if not _tiene_datos(origen):
            continue

        copiados: List[str] = []
        for elemento in origen.iterdir():
            if elemento.name == MARCA_MIGRACION:
                continue
            try:
                if elemento.is_dir():
                    shutil.copytree(elemento, destino / elemento.name,
                                    dirs_exist_ok=True)
                else:
                    shutil.copy2(elemento, destino / elemento.name)
                copiados.append(elemento.name)
            except Exception:  # noqa: BLE001
                # Un fichero que no se deja copiar no debe abortar el resto:
                # es mejor migrar nueve de diez que ninguno.
                continue

        # Marcar el origen para que nadie edite la copia equivocada dentro de
        # seis meses. Es "best effort": Program Files puede ser de solo lectura.
        try:
            (origen / MARCA_MIGRACION).write_text(
                f"Los datos de PsiCore se movieron a:\n{destino}\n\n"
                f"Fecha: {datetime.now(timezone.utc).isoformat()}\n"
                f"Esta carpeta ya NO la usa la aplicación. Se conserva como "
                f"respaldo; puedes borrarla cuando compruebes que todo va "
                f"bien.\n",
                encoding="utf-8",
            )
        except Exception:  # noqa: BLE001
            pass

        return {"origen": str(origen), "destino": str(destino),
                "elementos": copiados}

    return None


def resolver_carpeta_datos(carpeta: Optional[str] = None) -> Path:
    """
    Carpeta de datos definitiva, creada y migrada si hacía falta.

    Orden: argumento explícito -> `PLC_DATOS_DIR` -> la de por defecto.
    """
    raiz = carpeta or os.getenv("PLC_DATOS_DIR") or str(carpeta_por_defecto())
    ruta = Path(raiz)
    ruta.mkdir(parents=True, exist_ok=True)
    migrar_si_hace_falta(ruta)
    return ruta


def origen_de_la_ruta() -> str:
    """De dónde salió la ruta actual. Para explicarlo en la interfaz."""
    if os.getenv("PLC_DATOS_DIR"):
        return "variable de entorno PLC_DATOS_DIR"
    if empaquetado():
        return "carpeta de datos del sistema (instalación empaquetada)"
    return "carpeta del proyecto (modo desarrollo)"


def describir(carpeta: Optional[Path] = None) -> Dict[str, Any]:
    """
    Estado de la carpeta de datos, para enseñarlo en Configuración.

    Incluye si se puede escribir en ella: una carpeta de datos sin permiso de
    escritura es un servicio que arranca bien y pierde todo lo que hagas, y
    eso conviene verlo ANTES de trabajar dos horas.
    """
    ruta = Path(carpeta) if carpeta else resolver_carpeta_datos()
    ficheros: List[Dict[str, Any]] = []
    total = 0
    try:
        for p in sorted(ruta.rglob("*")):
            if p.is_file():
                tam = p.stat().st_size
                total += tam
                ficheros.append({
                    "nombre": str(p.relative_to(ruta)).replace("\\", "/"),
                    "bytes": tam,
                })
    except Exception:  # noqa: BLE001
        pass

    escribible = False
    try:
        prueba = ruta / ".escritura"
        prueba.touch()
        prueba.unlink()
        escribible = True
    except Exception:  # noqa: BLE001
        pass

    return {
        "ruta": str(ruta),
        "origen": origen_de_la_ruta(),
        "empaquetado": empaquetado(),
        "escribible": escribible,
        "num_ficheros": len(ficheros),
        "bytes": total,
        "ficheros": ficheros[:200],
    }
