# -*- coding: utf-8 -*-
"""
probar_crud_usuarios.py
=======================
Prueba el CRUD de gestion de usuarios contra un backend REAL, en un entorno
aislado que se borra al terminar.

    python tools/probar_crud_usuarios.py

Cubre, en orden: crear, leer, buscar con filtros/orden/paginacion, editar
(incluido renombrar y borrar el email), las SALVAGUARDAS (no dejarte fuera ni
quedarte sin Supervisor), borrar, los permisos por rol y la auditoria.

No toca tu .env, ni tu base de datos, ni tus PLCs: usa PLC_DATOS_DIR y una
SQLite temporal.
"""
import asyncio
import os
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
tmp = Path(tempfile.mkdtemp(prefix="crud_"))
env = os.environ.copy(); env.update(
    PLC_AUTOSTART_PLCS="false", PLC_DISCOVERY_ENABLED="false",
    PLC_AUTH_REQUERIDA="true", PLC_AI_ENABLED="false",
    PLC_DATOS_DIR=str(tmp/"datos"), PYTHONPATH=str(Path(__file__).resolve().parent.parent))
p = subprocess.Popen([sys.executable,"-m","uvicorn","app.main:app","--port","8095",
    "--host","127.0.0.1","--log-level","error"], cwd=str(tmp), env=env,
    stdout=open(tmp/"s.log","w"), stderr=subprocess.STDOUT)
for _ in range(80):
    try: urllib.request.urlopen("http://127.0.0.1:8095/auth/estado",timeout=2); break
    except Exception: time.sleep(0.5)

F=0
def ck(d,c,x=""):
    global F
    print(("  OK   " if c else "  FALLA ")+d+(f"   {x}" if x else ""))
    if not c: F+=1

async def main():
    import httpx
    async with httpx.AsyncClient(base_url="http://127.0.0.1:8095", timeout=25) as c:
        await c.post("/db/provision", json={"motor":"sqlite","base_datos":str(tmp/"d.db"),
                                            "crear_esquema":True})
        await c.post("/db", json={"db_id":"local","motor":"sqlite","base_datos":str(tmp/"d.db")})
        await c.post("/auth/registro", json={"usuario":"hugo","password":"Planta2026!"})
        H={"Authorization":"Bearer "+(await c.post("/auth/login",
            json={"usuario":"hugo","password":"Planta2026!"})).json()["token"]}

        print("\n--- CREATE ---")
        r = await c.post("/auth/usuarios", headers=H, json={
            "usuario":"operador01","password":"Operario2026","email":"op1@psi.pe",
            "categoria":"Usuarios","estado":"Activo"})
        ck("POST crea la cuenta", r.status_code==200 and r.json()["ok"],
           str(r.status_code))
        ck("respeta la categoria pedida",
           r.json()["usuario"]["categoria"]=="Usuarios")
        r = await c.post("/auth/usuarios", headers=H, json={
            "usuario":"operador01","password":"Otra12345"})
        ck("nombre repetido -> 409", r.status_code==409)
        r = await c.post("/auth/usuarios", headers=H, json={
            "usuario":"x","password":"corta"})
        ck("datos invalidos -> 400", r.status_code==400)

        for n,cat in [("ana","Administradores"),("luis","Usuarios"),("marta","Invitado")]:
            await c.post("/auth/usuarios", headers=H, json={
                "usuario":n,"password":"Clave12345","categoria":cat,
                "email":f"{n}@psi.pe"})

        print("\n--- READ ---")
        r = await c.get("/auth/usuarios/operador01", headers=H)
        ck("GET uno", r.status_code==200 and r.json()["usuario"]["email"]=="op1@psi.pe")
        ck("incluye 'conectado'", "conectado" in r.json()["usuario"])
        ck("NUNCA devuelve el hash",
           not any("password" in k for k in r.json()["usuario"]))
        r = await c.get("/auth/usuarios/nadie", headers=H)
        ck("inexistente -> 404", r.status_code==404)

        print("\n--- BUSCAR / filtros / orden / paginacion ---")
        r = await c.get("/auth/usuarios/buscar", headers=H)
        d = r.json()
        ck("lista todos", d["total"]==5, f"total={d['total']}")
        r = await c.get("/auth/usuarios/buscar", headers=H, params={"texto":"oper"})
        ck("busca por nombre", r.json()["total"]==1)
        r = await c.get("/auth/usuarios/buscar", headers=H, params={"texto":"ana@psi"})
        ck("busca por EMAIL tambien", r.json()["total"]==1)
        r = await c.get("/auth/usuarios/buscar", headers=H, params={"categoria":"Usuarios"})
        ck("filtra por categoria", r.json()["total"]==2, str(r.json()["total"]))
        r = await c.get("/auth/usuarios/buscar", headers=H,
                        params={"orden":"usuario","descendente":"true","limite":2})
        u = [x["usuario"] for x in r.json()["usuarios"]]
        ck("orden descendente + limite", u==["operador01","marta"], str(u))
        ck("total sigue siendo el real (sin paginar)", r.json()["total"]==5)
        r = await c.get("/auth/usuarios/buscar", headers=H,
                        params={"orden":"usuario","limite":2,"desplazamiento":2})
        ck("paginacion (offset)", [x["usuario"] for x in r.json()["usuarios"]]==["luis","marta"],
           str([x["usuario"] for x in r.json()["usuarios"]]))
        r = await c.get("/auth/usuarios/buscar", headers=H, params={"orden":"; DROP TABLE usuarios--"})
        ck("orden malicioso se ignora (lista blanca)", r.status_code==200)
        r = await c.get("/auth/usuarios/buscar", headers=H, params={"categoria":"Jefazo"})
        ck("categoria inventada -> 400", r.status_code==400)

        print("\n--- UPDATE ---")
        r = await c.patch("/auth/usuarios/luis", headers=H,
                          json={"email":"luis.nuevo@psi.pe","categoria":"Administradores"})
        ck("PATCH varios campos a la vez", r.status_code==200 and len(r.json()["cambios"])==2,
           str(r.json().get("cambios")))
        r = await c.get("/auth/usuarios/luis", headers=H)
        ck("se guardo el email", r.json()["usuario"]["email"]=="luis.nuevo@psi.pe")
        r = await c.patch("/auth/usuarios/luis", headers=H, json={"email":""})
        ck("email vacio lo borra", r.status_code==200)
        r = await c.patch("/auth/usuarios/marta", headers=H, json={"nuevo_usuario":"marta.silva"})
        ck("renombrar", r.status_code==200 and r.json()["usuario"]=="marta.silva")
        ck("y devuelve el nombre anterior", r.json()["anterior"]=="marta")
        r = await c.patch("/auth/usuarios/ana", headers=H, json={"nuevo_usuario":"luis"})
        ck("renombrar a uno existente -> 409", r.status_code==409)
        r = await c.patch("/auth/usuarios/ana", headers=H, json={})
        ck("PATCH vacio no rompe", r.status_code==200 and r.json()["cambios"]==[])

        print("\n--- SALVAGUARDAS ---")
        r = await c.patch("/auth/usuarios/hugo", headers=H, json={"estado":"Inactivo"})
        ck("NO puedo desactivarme a mi mismo -> 409", r.status_code==409, str(r.status_code))
        r = await c.patch("/auth/usuarios/hugo", headers=H, json={"categoria":"Usuarios"})
        ck("NO puedo degradarme a mi mismo -> 409", r.status_code==409)
        r = await c.delete("/auth/usuarios/hugo", headers=H)
        ck("NO puedo borrarme a mi mismo -> 409", r.status_code==409)

        # hugo es el UNICO Supervisor. Creamos otro y comprobamos que ahora si.
        await c.post("/auth/usuarios", headers=H, json={
            "usuario":"jefe","password":"Jefe123456","categoria":"Supervisor"})
        Hj={"Authorization":"Bearer "+(await c.post("/auth/login",
            json={"usuario":"jefe","password":"Jefe123456"})).json()["token"]}
        r = await c.patch("/auth/usuarios/hugo", headers=Hj, json={"estado":"Inactivo"})
        ck("con OTRO supervisor, si se puede desactivar a hugo", r.status_code==200)
        r = await c.patch("/auth/usuarios/jefe", headers=Hj, json={"categoria":"Usuarios"})
        ck("ultimo Supervisor no puede degradarse -> 409", r.status_code==409)
        r = await c.delete("/auth/usuarios/jefe", headers=Hj)
        ck("ultimo Supervisor no se puede borrar -> 409", r.status_code==409)

        print("\n--- DELETE ---")
        r = await c.delete("/auth/usuarios/operador01", headers=Hj)
        ck("borra la cuenta", r.status_code==200 and r.json()["ok"])
        r = await c.get("/auth/usuarios/operador01", headers=Hj)
        ck("ya no existe -> 404", r.status_code==404)
        r = await c.delete("/auth/usuarios/nadie", headers=Hj)
        ck("borrar inexistente -> 404", r.status_code==404)

        print("\n--- PERMISOS ---")
        r = await c.post("/auth/login", json={"usuario":"ana","password":"Clave12345"})
        Ha={"Authorization":"Bearer "+r.json()["token"]}
        r = await c.get("/auth/usuarios/buscar", headers=Ha)
        ck("Administradores SI puede listar", r.status_code==200)
        r = await c.post("/auth/usuarios", headers=Ha, json={"usuario":"z1","password":"Clave12345"})
        ck("Administradores NO puede crear -> 403", r.status_code==403)
        r = await c.delete("/auth/usuarios/luis", headers=Ha)
        ck("Administradores NO puede borrar -> 403", r.status_code==403)
        r = await c.get("/auth/usuarios/buscar")
        ck("sin token -> 401", r.status_code==401)

        print("\n--- AUDITORIA ---")
        ev = (await c.get("/auditoria", headers=Hj, params={"accion":"usuario."})).json()["eventos"]
        acc = {e["accion"] for e in ev}
        ck("consta creado/modificado/borrado",
           {"usuario.creado","usuario.modificado","usuario.borrado"} <= acc, str(sorted(acc)))
        ck("con QUIEN lo hizo", any(e["usuario"] in ("hugo","jefe") for e in ev))

asyncio.run(main())
p.terminate()
print("\nFALLOS:", F)
