# Migrar los datos de la base a otro equipo · 13 oct 2026

## Lo que se pidió

Sacar los datos de la base SQL del HMI para llevarlos a otra base (en otra
máquina, del motor que sea), **sin las cuentas de usuario**, y que al
importar sobre una base que ya tiene datos no haya choques de ids: las
claves foráneas se adaptan solas.

## Dónde está

**Configuración → Sistema → «Datos de la base»**, debajo de la carpeta de
datos (donde ya vivían «Descargar copia» y «Restaurar»). Fuera del
Diseñador y de los widgets a propósito: es una operación de sistema.

- **Exportar datos**: elige la base, marca o no «incluir histórico» y
  descarga `psicore-datos-<db>-<fecha>.zip`.
- **Importar**: elige el `.zip`, el modo, y **Simular** (recomendado) o
  **Importar ahora**. Sale un informe por tabla: leídas, nuevas,
  reutilizadas, omitidas y avisos.

## Qué viaja y qué no

| Tabla | Viaja | Nota |
|---|---|---|
| `alarmas_def` | sí | reglas de alarma |
| `alarmas` | sí | historial de eventos |
| `recetas`, `receta_elementos`, `receta_registros`, `receta_valores` | sí | recetas completas |
| `plc_prg` | opcional | histórico del PLC; puede pesar mucho |
| `usuarios` | **no** | cada instalación tiene las suyas; las columnas `usuario_id` entran a NULL (se pierde el «quién», nunca el dato) |

## Cómo se evitan los choques

Las filas se insertan **sin `id`**: el motor asigna uno nuevo y se guarda el
mapa viejo→nuevo para reescribir las claves foráneas de las tablas que
vienen después, en orden de dependencia:

`plc_prg → alarmas_def → recetas → receta_elementos → receta_registros → alarmas → receta_valores`

**Modo fusionar** (defecto): antes de insertar se busca la fila por su
clave natural y, si ya está, se reutiliza su id:

| Tabla | Clave natural |
|---|---|
| `alarmas_def` | nombre + tag |
| `recetas` | nombre |
| `receta_elementos` | receta + nombre |
| `receta_registros` | receta + nombre |
| `receta_valores` | registro + elemento (si existe, se deja el del destino) |
| `alarmas` | ts_activacion + tag + mensaje |
| `plc_prg` | ts + plc_id + tag |

Importar dos veces el mismo fichero no duplica nada. **Modo añadir** salta
esa búsqueda y lo mete todo como nuevo.

**Todo o nada**: la importación va en una sola transacción; si una fila
falla, la base queda como estaba. «Simular» hace el recorrido completo y
termina en ROLLBACK, con el mismo informe.

Las fechas viajan en ISO 8601 con zona y entran por `ts_para_motor()`: de
SQL Server a PostgreSQL (o SQLite, MySQL) el instante es el mismo.

## API

| Método | Ruta | Rol |
|---|---|---|
| `GET` | `/db/{db_id}/datos/exportar?incluir_historico=true` | Administradores |
| `POST` | `/db/{db_id}/datos/importar` (multipart: `archivo`, `modo`, `simular`, `incluir_historico`) | Supervisor |

Cuelgan de `/db`, así que el proxy de Vite no necesita línea nueva. Las dos
quedan en la auditoría (`bd.datos.exportados` / `bd.datos.importados`); tras
importar se difunde `config.updated` y se recarga el motor de alarmas.

## Formato del fichero

Un `.zip` con `manifiesto.json` (origen, motor, filas por tabla, lo
excluido) y un `<tabla>.jsonl` por tabla, una fila JSON por línea. Se
escribe y se lee página a página, sin cargar el histórico entero en memoria.

## Probado

Con dos bases SQLite y el código real (`app/db/migracion_datos.py`): origen
con usuario, 2 lecturas, 2 reglas, 1 evento, 2 recetas con elementos,
registros y valores; destino con usuario propio, 3 recetas (una llamada
igual que una del origen, con un elemento igual), 5 lecturas y 1 regla.
Resultado: la receta repetida se fundió reutilizando su elemento, la otra
entró con id nuevo pese al choque, el evento quedó apuntando a la lectura y
la regla re-numeradas, `usuario_id` a NULL, la reimportación no creó nada y
«añadir» lo creó todo.

## Ficheros

| Fichero | Qué hace |
|---|---|
| `app/db/migracion_datos.py` | Exportar / importar con re-mapeo, claves naturales, transacción única. |
| `app/api/migracion_routes.py` | Los dos endpoints, permisos, auditoría. |
| `app/main.py` | Alta del router. |
| `frontend/src/components/sistema/PanelMigracionDatos.tsx` | La tarjeta de la interfaz. |
| `frontend/src/pages/Configuracion.tsx` | La monta en Sistema. |
