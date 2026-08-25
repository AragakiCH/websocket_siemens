# -*- coding: utf-8 -*-
"""
probar_multiusuario.py
======================
Prueba TODO el multiusuario de una sola vez, sin tocar nada de tu instalación.

Levanta un backend aparte, con su propia base de datos SQLite temporal y su
propia carpeta `datos/`, ejecuta el escenario completo y borra todo al acabar.
**No toca tu .env, ni tu BD, ni tus PLCs.**

Uso:

    python tools/probar_multiusuario.py

Qué comprueba, en orden:

    1. Arranque en frío     · configurar sin cuentas (modo arranque)
    2. Primer usuario       · sale Supervisor aunque pida otra cosa
    3. Contraseñas          · hash correcto, mensaje neutro al fallar
    4. Roles                · un 'Usuarios' no puede tocar PLCs ni ver cuentas
    5. Proyecto compartido  · dos WebSockets ven el mismo cambio en vivo
    6. Presencia            · quién está conectado
    7. Conflicto de versión · 409 y forzado con version=null
    8. Fase 4 · el lápiz    · exclusión, 423, heartbeat, caducidad y toma
    9. Auditoría            · queda registrado quién hizo qué
   10. Persistencia         · sobrevive al reinicio del servicio

Requiere `websockets` y `httpx` (van en requirements.txt).
"""
from __future__ import annotations

import asyncio
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

RAIZ = Path(__file__).resolve().parent.parent
PUERTO = 8077
BASE = f"http://127.0.0.1:{PUERTO}"
WS = f"ws://127.0.0.1:{PUERTO}/ws"

VERDE, ROJO, AMARILLO, GRIS, FIN = (
    "\033[92m", "\033[91m", "\033[93m", "\033[90m", "\033[0m"
)

_fallos = 0


def check(desc: str, condicion: bool, extra: str = "") -> None:
    global _fallos
    if condicion:
        print(f"  {VERDE}✓{FIN} {desc}" + (f" {GRIS}{extra}{FIN}" if extra else ""))
    else:
        _fallos += 1
        print(f"  {ROJO}✗ {desc}{FIN}" + (f" {ROJO}{extra}{FIN}" if extra else ""))


def titulo(txt: str) -> None:
    print(f"\n{AMARILLO}{txt}{FIN}")


# ====================================================================== #
# Servidor de pruebas
# ====================================================================== #
def arrancar_servidor(tmp: Path) -> subprocess.Popen:
    """Lanza uvicorn con un entorno aislado y espera a que responda."""
    entorno = os.environ.copy()
    entorno.update({
        "PLC_AUTOSTART_PLCS": "false",
        "PLC_DISCOVERY_ENABLED": "false",
        "PLC_AUTH_REQUERIDA": "true",       # el modo que interesa probar
        # CLAVE: sin esto el backend escribiría en la carpeta `datos/` de
        # tu instalación real y pisaría tus conexiones y proyectos.
        "PLC_DATOS_DIR": str(tmp / "datos"),
        # El asistente de IA indexa toda la documentación al arrancar y puede
        # tardar bastante. No pinta nada en esta prueba, así que se apaga: sin
        # esto el arranque se va a decenas de segundos y parece que se colgó.
        "PLC_AI_ENABLED": "false",
        "PYTHONPATH": str(RAIZ),
        "PYTHONIOENCODING": "utf-8",
    })

    # La salida va a un FICHERO, no a un PIPE. Con un pipe que nadie lee, el
    # buffer del sistema se llena y el servidor se bloquea escribiendo — que
    # es justo lo que parecería un "no respondió a tiempo".
    log = tmp / "servidor.log"
    fh = open(log, "w", encoding="utf-8")
    proceso = subprocess.Popen(
        [sys.executable, "-m", "uvicorn", "app.main:app",
         "--host", "127.0.0.1", "--port", str(PUERTO), "--log-level", "info"],
        cwd=str(tmp),            # `datos/` se crea AQUÍ, no en tu proyecto
        env=entorno,
        stdout=fh, stderr=subprocess.STDOUT, text=True,
    )

    import urllib.error
    import urllib.request

    espera = 90          # el primer arranque compila e importa bastante
    t0 = time.time()
    aviso = False
    while time.time() - t0 < espera:
        if proceso.poll() is not None:
            fh.close()
            print(f"{ROJO}El servidor terminó con código "
                  f"{proceso.returncode}. Últimas líneas:{FIN}")
            print(log.read_text('utf-8', errors='replace')[-3000:])
            sys.exit(1)
        try:
            urllib.request.urlopen(f"{BASE}/auth/estado", timeout=3)
            print(f"{GRIS}Servidor listo en {time.time() - t0:.1f}s{FIN}")
            return proceso
        except urllib.error.HTTPError:
            # Responde con un código de error, pero RESPONDE: está arriba.
            # Tratar esto como "no listo" era el fallo de la versión anterior.
            print(f"{GRIS}Servidor listo en {time.time() - t0:.1f}s{FIN}")
            return proceso
        except Exception:
            if not aviso and time.time() - t0 > 10:
                print(f"{GRIS}Esperando al servidor… "
                      f"(log: {log}){FIN}")
                aviso = True
            time.sleep(0.5)

    proceso.kill()
    fh.close()
    print(f"{ROJO}El servidor no respondió en {espera}s.{FIN}")
    print(f"{AMARILLO}Últimas líneas de {log}:{FIN}")
    print(log.read_text('utf-8', errors='replace')[-3000:] or "(vacío)")
    print(f"\n{AMARILLO}Causas habituales:{FIN}")
    print("  · El puerto 8077 ya está ocupado por otro proceso.")
    print("  · Faltan dependencias: pip install -r requirements.txt")
    print("  · Un antivirus o el firewall bloquean el localhost.")
    sys.exit(1)


# ====================================================================== #
# Escenario
# ====================================================================== #
async def escenario(tmp: Path) -> None:
    import httpx
    import websockets

    db = tmp / "prueba.db"

    async with httpx.AsyncClient(base_url=BASE, timeout=20) as c:
        # ---- 1. Arranque en frío ------------------------------------- #
        titulo("1 · Arranque en frío (sin ninguna cuenta)")
        r = await c.get("/auth/estado")
        check("GET /auth/estado responde sin login", r.status_code == 200)
        check("informa que no hay usuarios", r.json()["hay_usuarios"] is False)

        r = await c.post("/db", json={
            "db_id": "local", "motor": "sqlite",
            "base_datos": str(db), "crear_esquema": True})
        creadas = r.json().get("esquema", {}).get("tablas_creadas", [])
        check("se puede configurar la BD sin cuentas (modo arranque)",
              r.status_code == 200 and r.json()["ok"])
        check("esquema creado", set(creadas) >= {"usuarios", "plc_prg", "alarmas"},
              str(creadas))

        # ---- 2. Primer usuario --------------------------------------- #
        titulo("2 · Primera cuenta")
        r = await c.post("/auth/registro", json={
            "usuario": "hugo", "password": "Planta2026!",
            "categoria": "Invitado"})          # pide el rol MÁS BAJO...
        cat = r.json()["usuario"]["categoria"]
        check("el primer usuario sale Supervisor aunque pida Invitado",
              cat == "Supervisor", f"(salió '{cat}')")

        # ---- 3. Contraseñas ------------------------------------------ #
        titulo("3 · Contraseñas")
        r = await c.post("/auth/login",
                         json={"usuario": "hugo", "password": "Planta2026!"})
        check("login correcto", r.status_code == 200)
        tok_sup = r.json()["token"]
        SUP = {"Authorization": f"Bearer {tok_sup}"}

        r = await c.post("/auth/login",
                         json={"usuario": "hugo", "password": "Planta2027!"})
        msg_mala = str(r.json().get("detail"))
        r2 = await c.post("/auth/login",
                          json={"usuario": "noexiste", "password": "x"})
        check("contraseña incorrecta -> 401", r.status_code == 401)
        check("mismo mensaje si el usuario no existe (no se filtra qué cuentas hay)",
              msg_mala == str(r2.json().get("detail")))

        # La puerta se cerró
        r = await c.post("/plcs", json={"host": "10.0.0.1"})
        check("ya con cuentas, sin token -> 401", r.status_code == 401)

        # ---- 4. Roles ------------------------------------------------- #
        titulo("4 · Roles aplicados en el BACKEND")
        await c.post("/auth/registro", headers=SUP, json={
            "usuario": "ana", "password": "Operaria2026",
            "categoria": "Usuarios"})
        r = await c.post("/auth/login",
                         json={"usuario": "ana", "password": "Operaria2026"})
        tok_ana = r.json()["token"]
        ANA = {"Authorization": f"Bearer {tok_ana}"}

        await c.post("/auth/registro", headers=SUP, json={
            "usuario": "luis", "password": "Ingeniero26",
            "categoria": "Administradores"})
        r = await c.post("/auth/login",
                         json={"usuario": "luis", "password": "Ingeniero26"})
        tok_luis = r.json()["token"]
        LUIS = {"Authorization": f"Bearer {tok_luis}"}

        r = await c.post("/plcs", headers=ANA, json={"host": "10.0.0.1"})
        check("'Usuarios' NO puede agregar PLCs -> 403", r.status_code == 403)
        r = await c.get("/auth/usuarios", headers=ANA)
        check("'Usuarios' NO puede listar cuentas -> 403", r.status_code == 403)
        r = await c.get("/auth/usuarios", headers=LUIS)
        check("'Administradores' SÍ puede listar cuentas", r.status_code == 200)
        r = await c.patch("/auth/usuarios/ana", headers=LUIS,
                          json={"categoria": "Supervisor"})
        check("'Administradores' NO puede ascender a nadie -> 403",
              r.status_code == 403)

        # ---- 5 y 6. Dos clientes en vivo ------------------------------ #
        titulo("5 · Dos navegadores viendo el mismo cambio")
        rec_luis, rec_ana = [], []
        listo1, listo2 = asyncio.Event(), asyncio.Event()

        async def escuchar(tok, buzon, listo):
            async with websockets.connect(f"{WS}?token={tok}") as ws:
                listo.set()
                try:
                    while True:
                        buzon.append(json.loads(
                            await asyncio.wait_for(ws.recv(), timeout=25)))
                except Exception:
                    pass

        t1 = asyncio.create_task(escuchar(tok_luis, rec_luis, listo1))
        t2 = asyncio.create_task(escuchar(tok_ana, rec_ana, listo2))
        await asyncio.wait_for(listo1.wait(), 10)
        await asyncio.wait_for(listo2.wait(), 10)
        await asyncio.sleep(1.2)

        titulo("6 · Presencia")
        pres = [m for m in rec_ana if m.get("type") == "presence"]
        nombres = {u["usuario"] for u in pres[-1]["usuarios"]} if pres else set()
        check("ana ve a los dos conectados", {"ana", "luis"} <= nombres,
              str(sorted(nombres)))

        # Luis toma el lápiz para poder editar
        await c.post("/locks/designer:principal/adquirir", headers=LUIS)

        r = await c.get("/proyectos/principal", headers=LUIS)
        v = r.json()["version"]
        r = await c.patch("/proyectos/principal/widgets/w_horno", headers=LUIS,
                          json={"widget": {"id": "w_horno", "tipo": "gauge",
                                           "x": 300, "y": 150},
                                "version": v})
        check("luis guarda un widget", r.status_code == 200)
        v2 = r.json()["version"]
        await asyncio.sleep(1.2)

        ev_ana = [m for m in rec_ana if m.get("type") == "project.updated"]
        check("ANA recibe el cambio de LUIS en vivo", len(ev_ana) > 0,
              f"(v{ev_ana[-1]['version']} por '{ev_ana[-1]['por']}')" if ev_ana else "")

        # ---- 7. Conflicto de versión --------------------------------- #
        titulo("7 · Conflicto de versión")
        r = await c.patch("/proyectos/principal/widgets/w_horno", headers=LUIS,
                          json={"widget": {"id": "w_horno", "x": 999},
                                "version": v})     # versión VIEJA
        check("escribir con versión vieja -> 409", r.status_code == 409)
        check("el 409 dice cuál es la versión actual",
              r.json()["detail"]["version_actual"] == v2)
        r = await c.patch("/proyectos/principal/widgets/w_horno", headers=LUIS,
                          json={"widget": {"id": "w_horno", "x": 999},
                                "version": None})  # forzar
        check("forzando con version=null sí escribe", r.status_code == 200)

        # ---- 8. FASE 4: el lápiz ------------------------------------- #
        titulo("8 · Fase 4 · el lápiz de edición")
        r = await c.get("/locks", headers=LUIS)
        locks = r.json()["locks"]
        check("luis tiene el lápiz",
              any(l["usuario"] == "luis" and l["recurso"] == "designer:principal"
                  for l in locks), str([l["usuario"] for l in locks]))

        r = await c.post("/locks/designer:principal/adquirir", headers=SUP)
        check("hugo NO puede tomarlo mientras luis edita",
              r.json()["concedido"] is False)
        check("y le dice quién lo tiene y cuánto queda",
              r.json().get("titular", {}).get("usuario") == "luis")

        # Hugo (Administradores? no, es Supervisor) intenta ESCRIBIR sin lápiz
        r = await c.patch("/proyectos/principal/widgets/w_otro", headers=SUP,
                          json={"widget": {"id": "w_otro"}, "version": None})
        check("escribir sin el lápiz -> 423 Locked", r.status_code == 423,
              f"(salió {r.status_code})")

        r = await c.post("/locks/designer:principal/renovar", headers=LUIS)
        check("heartbeat de luis mantiene el lápiz", r.json()["concedido"] is True)

        # Toma de control por el Supervisor
        rec_luis.clear()
        r = await c.post("/locks/designer:principal/forzar", headers=SUP)
        check("el Supervisor puede tomar el control", r.json()["concedido"] is True)
        check("y queda constancia de a quién se lo quitó",
              r.json().get("anterior") == "luis")
        await asyncio.sleep(1.2)
        ev_lock = [m for m in rec_luis if m.get("type") == "lock.changed"]
        check("a LUIS le llega el aviso al instante",
              any(m.get("accion") == "forzado" for m in ev_lock))

        r = await c.post("/locks/designer:principal/renovar", headers=LUIS)
        check("el heartbeat de luis ya devuelve concedido:false",
              r.json()["concedido"] is False)

        # Un Administradores NO puede forzar
        r = await c.post("/locks/designer:principal/forzar", headers=LUIS)
        check("'Administradores' NO puede tomar el control -> 403",
              r.status_code == 403)

        # Liberar y comprobar que queda libre
        await c.post("/locks/designer:principal/liberar", headers=SUP)
        r = await c.post("/locks/designer:principal/adquirir", headers=LUIS)
        check("tras liberar, luis lo vuelve a tomar",
              r.json()["concedido"] is True)

        t1.cancel(); t2.cancel()
        await asyncio.sleep(0.4)

        # ---- 9. Auditoría -------------------------------------------- #
        titulo("9 · Auditoría")
        r = await c.get("/auditoria", headers=SUP, params={"limite": 100})
        eventos = r.json()["eventos"]
        acciones = {e["accion"] for e in eventos}
        check("hay eventos registrados", len(eventos) > 0, f"({len(eventos)})")
        check("consta la toma de control", "lock.forzado" in acciones)
        forzado = next((e for e in eventos if e["accion"] == "lock.forzado"), None)
        check("con quién se lo quitó a quién",
              bool(forzado) and forzado["usuario"] == "hugo" and
              forzado.get("detalle", {}).get("se_lo_quito_a") == "luis")
        check("consta la creación de usuarios", "usuario.creado" in acciones)
        r = await c.get("/auditoria", headers=ANA)
        check("'Usuarios' NO puede leer la auditoría -> 403", r.status_code == 403)

        # ---- 10. Desactivar cierra sesión ---------------------------- #
        titulo("10 · Desactivar una cuenta")
        await c.patch("/auth/usuarios/ana", headers=SUP,
                      json={"estado": "Inactivo"})
        r = await c.get("/auth/me", headers=ANA)
        check("la sesión de ana se cierra al instante",
              r.json()["autenticado"] is False)
        r = await c.post("/auth/login",
                         json={"usuario": "ana", "password": "Operaria2026"})
        check("ana ya no puede entrar -> 403", r.status_code == 403)


async def comprobar_persistencia(tmp: Path) -> None:
    """Tras parar el servicio, lo guardado debe seguir en disco."""
    titulo("11 · Persistencia en disco")
    datos = tmp / "datos"
    proyecto = datos / "proyectos" / "principal.json"
    check("existe datos/proyectos/principal.json", proyecto.is_file())
    if proyecto.is_file():
        doc = json.loads(proyecto.read_text("utf-8"))
        check("el proyecto conserva el widget y su versión",
              len(doc["widgets"]) > 0 and doc["version"] > 1,
              f"(v{doc['version']}, {len(doc['widgets'])} widget(s))")
    check("existe la auditoría", (datos / "auditoria.jsonl").is_file())
    check("la clave de cifrado está creada", (datos / ".clave").is_file())


def main() -> int:
    tmp = Path(tempfile.mkdtemp(prefix="hmi_prueba_"))
    print(f"{GRIS}Entorno aislado en {tmp}{FIN}")
    print(f"{GRIS}(tu .env, tu BD y tus PLCs no se tocan){FIN}")

    proceso = arrancar_servidor(tmp)
    try:
        asyncio.run(escenario(tmp))
    finally:
        proceso.terminate()
        try:
            proceso.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proceso.kill()

    asyncio.run(comprobar_persistencia(tmp))
    shutil.rmtree(tmp, ignore_errors=True)

    print()
    if _fallos == 0:
        print(f"{VERDE}Todo correcto.{FIN}")
        return 0
    print(f"{ROJO}{_fallos} comprobación(es) fallaron.{FIN}")
    return 1


if __name__ == "__main__":
    sys.exit(main())
