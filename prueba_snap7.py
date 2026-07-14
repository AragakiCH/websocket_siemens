import asyncio
from asyncua import Client, ua

URL = "opc.tcp://192.168.50.1:4840"

# Nodos de metadata que NO queremos ver
IGNORAR = {"Icon", "InputArguments", "OutputArguments"}

async def browse_datablocks(node, indent=0):
    """Recorre solo los nodos de datos, ignorando metadata e iconos."""
    for child in await node.get_children():
        name = (await child.read_browse_name()).Name

        # Saltar metadata conocida
        if name in IGNORAR:
            continue

        node_class = await child.read_node_class()
        prefix = "  " * indent

        if node_class == ua.NodeClass.Variable:
            try:
                value = await child.read_value()
                # Ignorar valores binarios (iconos, bytestrings)
                if isinstance(value, bytes):
                    continue
                nodeid = child.nodeid.to_string()
                print(f"{prefix}📄 {name} = {value}  ({type(value).__name__})  [{nodeid}]")
            except Exception:
                pass
        else:
            print(f"{prefix}📁 {name}")
            await browse_datablocks(child, indent + 1)

async def main():
    client = Client(url=URL)
    await client.connect()
    print(f"✅ Conectado a {URL}\n")

    # Ir directo a DataBlocksGlobal (ns=3), sin pasar por Server/Diagnostics
    # Ruta: Objects -> DeviceSet -> PLC_2 -> DataBlocksGlobal
    try:
        objects = client.nodes.objects
        deviceset = await objects.get_child(["3:DeviceSet"])
        plc = await deviceset.get_child(["3:PLC_2"])
        dbs = await plc.get_child(["3:DataBlocksGlobal"])

        print("=== Tus Data Blocks ===\n")
        await browse_datablocks(dbs, 0)
    except Exception as e:
        print(f"⚠️ No pude navegar por ruta directa: {e}")
        print("Cayendo a browse general de Objects...")
        await browse_datablocks(client.nodes.objects, 0)

    await client.disconnect()
    print("\n🔌 Desconectado")

if __name__ == "__main__":
    asyncio.run(main())