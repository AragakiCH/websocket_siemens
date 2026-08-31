# -*- coding: utf-8 -*-
"""
probar_trazabilidad.py
======================
Comprueba que cada acción queda atribuida a QUIEN la hizo de verdad, y que
nadie puede firmar con la identidad de otro.

    python tools/probar_trazabilidad.py

Lo que verifica:

  1. El token identifica     · sin token no se entra; con token, se sabe quién
  2. `usuario_id` en la sesión · el id numérico viaja en /auth/me
  3. **Sellado del autor**    · el `usuario_id` del CUERPO se IGNORA; manda la
                                sesión. Es la prueba clave: sin esto, un
                                operario puede reconocer una alarma diciendo
                                que fue el supervisor.
  4. Auditoría con id        · nombre + id numérico en cada evento
  5. Filtro por usuario_id   · encuentra lo que hizo alguien aunque se renombre

Entorno aislado, se borra al terminar. No toca tu .env, tu BD ni tus PLCs.
"""
from __future__ import annotations

import asyncio
import os
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

RAIZ = Path(__file__).resolve().parent.parent
PUERTO = 8093
BASE = f"http://127.0.0.1:{PUERTO}"

VERDE, ROJO, AMARILLO, GRIS, FIN = (
    "\033[92m", "\033[91m", "\033[93m", "\033[90m", "\033[0m")
_fallos = 0


def ck(desc: str, cond: bool, extra: str = "") -> None:
    global _fallos
    if cond:
        print(f"  {VERDE}✓{FIN} {desc}" + (f" {GRIS}{extra}{FIN}" if extra else ""))
    else:
        _fallos += 1
        print(f"  {ROJO}✗ {desc}{FIN}" + (f" {ROJO}{extra}{FIN}" if extra else ""))


def titulo(t: str) -> None:
    print(f"\n{AMARILLO}{t}{FIN}")


def arrancar(tmp: Path) -> subprocess.Popen:
    env = os.environ.copy()
    env.update({
        "PLC_AUTOSTART_PLCS": "false", "PLC_DISCOVERY_ENABLED": "false",
        "PLC_AUTH_REQUERIDA": "true", "PLC_AI_ENABLED": "false",
        "PLC_DATOS_DIR": str(tmp / "datos"), "PYTHONPATH": str(RAIZ),
        "PYTHONIOENCODING": "utf-8",
    })
    log = open(tmp / "s.log", "w", encoding="utf-8")
    p = subprocess.Popen(
        [sys.executable, "-m", "uvicorn", "app.main:app", "--host", "127.0.0.1",
         "--port", str(PUERTO), "--log-level", "error"],
        cwd=str(tmp), env=env, stdout=log, stderr=subprocess.STDOUT, text=True)
    for _ in range(120):
        if p.poll() is not None:
            log.close()
            print(f"{ROJO}El servidor murió:{FIN}")
            print((tmp / "s.log").read_text("utf-8", errors="replace")[-2000:])
            sys.exit(1)
        try:
            urllib.request.urlopen(f"{BASE}/auth/estado", timeout=3)
            return p
        except Exception:
            time.sleep(0.5)
    p.kill()
    print(f"{ROJO}El servidor no respondió.{FIN}")
    print((tmp / "s.log").read_text("utf-8", errors="replace")[-2000:])
    sys.exit(1)


async def escenario(tmp: Path) -> None:
    import httpx

    db = tmp / "traza.db"
    async with httpx.AsyncClient(base_url=BASE, timeout=25) as c:
        await c.post("/db/provision", json={
            "motor": "sqlite", "base_datos": str(db), "crear_esquema": True})
        await c.post("/db", json={
            "db_id": "local", "motor": "sqlite", "base_datos": str(db)})
        await c.post("/auth/registro", json={
            "usuario": "supervisor", "password": "Planta2026!"})
        SUP = {"Authorization": "Bearer " + (await c.post("/auth/login", json={
            "usuario": "supervisor", "password": "Planta2026!"})).json()["token"]}

        await c.post("/auth/usuarios", headers=SUP, json={
            "usuario": "operario", "password": "Operario2026",
            "categoria": "Usuarios"})
        r = await c.post("/auth/login", json={
            "usuario": "operario", "password": "Operario2026"})
        OPE = {"Authorization": "Bearer " + r.json()["token"]}
        id_operario = r.json()["usuario"]["id"]

        r = await c.get("/auth/me", headers=SUP)
        id_supervisor = r.json()["sesion"]["usuario_id"]

        # ---- 1. El token identifica -------------------------------- #
        titulo("1 · El token identifica a quien lo usa")
        r = await c.get("/auth/me")
        ck("sin token -> no autenticado", r.json()["autenticado"] is False)
        r = await c.get("/auth/me", headers=OPE)
        ck("con token -> dice quién es",
           r.json()["sesion"]["usuario"] == "operario")
        ck("y trae su usuario_id numérico",
           isinstance(r.json()["sesion"].get("usuario_id"), int) and
           r.json()["sesion"]["usuario_id"] == id_operario,
           f"id={id_operario}")
        r = await c.get("/auth/me", headers={"Authorization": "Bearer inventado"})
        ck("token inventado -> no autenticado",
           r.json()["autenticado"] is False)

        # ---- 2. Sellado del autor ---------------------------------- #
        titulo("2 · SELLADO: el usuario_id sale de la sesión, no del cuerpo")

        # El operario crea una receta MINTIENDO: dice ser el supervisor.
        r = await c.post("/crud/recetas", headers=OPE, json={
            "nombre": "Receta_A", "nombre_receta": "Horno",
            "tag": "192.168.1.1|PLC_PRG.temp", "tipo_dato": "REAL",
            "usuario_id": id_supervisor,          # <- la mentira
        })
        ck("el operario puede crear una receta", r.status_code == 200,
           f"HTTP {r.status_code}: {str(r.json())[:90]}")

        if r.status_code == 200:
            id_receta = r.json().get("id")
            r2 = await c.get(f"/crud/recetas/{id_receta}", headers=SUP)
            fila = r2.json().get("fila") or r2.json()
            guardado = fila.get("usuario_id")
            ck("se guardó el id del OPERARIO, no el que mintió",
               guardado == id_operario,
               f"guardado={guardado}, operario={id_operario}, "
               f"supervisor={id_supervisor}")
            ck("NO se guardó la identidad suplantada",
               guardado != id_supervisor)

            # Y al actualizar, lo mismo.
            await c.patch(f"/crud/recetas/{id_receta}", headers=SUP, json={
                "nombre": "Receta_A2", "usuario_id": id_operario})
            r3 = await c.get(f"/crud/recetas/{id_receta}", headers=SUP)
            fila = r3.json().get("fila") or r3.json()
            ck("al actualizar se sella con quien edita (el supervisor)",
               fila.get("usuario_id") == id_supervisor,
               f"guardado={fila.get('usuario_id')}")

        # ---- 3. Auditoría con id ----------------------------------- #
        titulo("3 · La auditoría guarda nombre Y id")
        ev = (await c.get("/auditoria", headers=SUP,
                          params={"limite": 200})).json()["eventos"]
        con_id = [e for e in ev if e.get("usuario_id")]
        ck("hay eventos con usuario_id", len(con_id) > 0,
           f"{len(con_id)} de {len(ev)}")
        ck("el id coincide con el nombre",
           all(e["usuario_id"] == id_supervisor
               for e in con_id if e["usuario"] == "supervisor"))
        crud = [e for e in ev if e["accion"].startswith("crud.")]
        ck("las acciones del CRUD quedan registradas", len(crud) > 0,
           str(sorted({e["accion"] for e in crud})))

        # ---- 4. Filtro por id ------------------------------------- #
        titulo("4 · Filtrar por usuario_id sobrevive a un renombrado")
        r = await c.get("/auditoria", headers=SUP,
                        params={"usuario_id": id_operario, "limite": 100})
        antes = len(r.json()["eventos"])
        ck("el filtro por id encuentra sus acciones", antes > 0, f"{antes} evento(s)")

        await c.patch("/auth/usuarios/operario", headers=SUP,
                      json={"nuevo_usuario": "operario.turno1"})
        r = await c.get("/auditoria", headers=SUP,
                        params={"usuario_id": id_operario, "limite": 100})
        ck("tras renombrarlo, el id sigue encontrando lo mismo",
           len(r.json()["eventos"]) >= antes, f"{len(r.json()['eventos'])}")
        r = await c.get("/auditoria", headers=SUP,
                        params={"usuario": "operario.turno1", "limite": 100})
        ck("por NOMBRE nuevo no aparece lo antiguo (por eso hace falta el id)",
           len(r.json()["eventos"]) < antes or antes == 0,
           "el nombre es editable; el id no")

        # ---- 5. Sin sesión no se escribe --------------------------- #
        titulo("5 · Sin token no se puede escribir nada")
        for metodo, url, cuerpo in [
            ("post", "/crud/recetas", {"nombre": "X", "nombre_receta": "Y",
                                       "tag": "t", "tipo_dato": "REAL"}),
            ("post", "/auth/usuarios", {"usuario": "colado",
                                        "password": "Colado12345"}),
            ("post", "/plcs", {"host": "10.0.0.1"}),
        ]:
            r = await getattr(c, metodo)(url, json=cuerpo)
            ck(f"{metodo.upper()} {url} sin token -> 401",
               r.status_code == 401, f"HTTP {r.status_code}")


def main() -> int:
    tmp = Path(tempfile.mkdtemp(prefix="traza_"))
    print(f"{GRIS}Entorno aislado en {tmp}{FIN}")
    p = arrancar(tmp)
    try:
        asyncio.run(escenario(tmp))
    finally:
        p.terminate()
        try:
            p.wait(timeout=10)
        except subprocess.TimeoutExpired:
            p.kill()
    import shutil
    shutil.rmtree(tmp, ignore_errors=True)
    print()
    if _fallos == 0:
        print(f"{VERDE}Trazabilidad correcta.{FIN}")
        return 0
    print(f"{ROJO}{_fallos} comprobación(es) fallaron.{FIN}")
    return 1


if __name__ == "__main__":
    sys.exit(main())
