// =========================================================================
// RecipesEditor.tsx
// Editor de recetas, con la misma estructura que el de TIA Portal.
//
// ⚠️ SOLO VISTA. Nada de esto habla con un PLC todavía: no hay "escribir en
//    el PLC" ni "leer del PLC", que es lo que hace útil a una receta de
//    verdad. Acá solo se define la estructura y se guarda en el navegador.
//
// SON TRES NIVELES, y esa es toda la idea:
//
//   Recipe        el contenedor. Dónde se guarda, cuántos registros caben,
//                 cómo se comunica con el PLC.
//     └ Elements       las COLUMNAS. Los ingredientes: limon, azucar, pisco.
//                      Cada uno apunta a un tag del PLC.
//     └ Data records   las FILAS. Cada una es una fórmula concreta con su
//                      valor para cada ingrediente.
//
// Puesto en tabla, una receta es esta matriz:
//
//                │ limon │ azucar │ pisco
//     ───────────┼───────┼────────┼───────
//     Clásico    │  30   │   20   │  60
//     Doble      │  30   │   20   │  90
//
// En runtime el operador elegiría "Clásico" y el HMI escribiría 30, 20 y 60
// en los tags de cada elemento. Eso es lo que falta.
//
// LAS CELDAS ROSADAS
// Son el mismo código visual de TIA: un elemento SIN tag no tiene dónde
// escribir su valor, así que su columna entera queda bloqueada en la pestaña
// de registros hasta que se le asigne uno.
// =========================================================================
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { motion, AnimatePresence, useReducedMotion } from 'framer-motion';
import {
  BookOpenIcon,
  PlusIcon,
  Trash2Icon,
  CopyIcon,
  TagIcon,
  InfoIcon,
  LayersIcon,
  ListIcon,
  AlertTriangleIcon,
  FolderOpenIcon,
} from 'lucide-react';
import {
  Th,
  Celda,
  CeldaLectura,
  CeldaSelect,
  CeldaCheck,
  IconoBoton,
  AccionesFila,
} from '../ui/TableBits';

const STORAGE_KEY = 'hmi.recipes';

// ─── Vocabulario de TIA ──────────────────────────────────────────

/** `Limited` reserva memoria fija; `Unlimited` crece según haya espacio. */
export const RECIPE_TYPES = ['Limited', 'Unlimited'] as const;
export type RecipeType = (typeof RECIPE_TYPES)[number];

/**
 * Cómo viajan los valores al PLC.
 *
 *   Tags   un tag por elemento, N escrituras sueltas. Hay un instante en que
 *          el PLC tiene el primer valor nuevo y el último viejo.
 *   Array  todos los elementos en un único tag de tipo array, en UNA sola
 *          escritura. Llegan juntos o no llega ninguno.
 */
export const COMM_TYPES = ['Tags', 'Array'] as const;
export type CommType = (typeof COMM_TYPES)[number];

/** `''` = sin definir, que es como lo deja TIA mientras no haya tag. */
export const DATA_TYPES = [
  '',
  'Bool',
  'Byte',
  'Int',
  'UInt',
  'DInt',
  'UDInt',
  'Real',
  'LReal',
  'String',
] as const;
export type ElementDataType = (typeof DATA_TYPES)[number];

/**
 * Bytes que ocupa cada tipo. Es lo que TIA muestra en "Data length" y no se
 * escribe a mano: sale del tipo, así que acá también es de solo lectura.
 */
const LARGO_TIPO: Record<string, number> = {
  '': 0,
  Bool: 1,
  Byte: 1,
  Int: 2,
  UInt: 2,
  DInt: 4,
  UDInt: 4,
  Real: 4,
  LReal: 8,
  String: 254,
};

// ─── Modelo ──────────────────────────────────────────────────────

export interface RecipeElement {
  id: string;
  name: string;
  displayName: string;
  /** Tag del PLC. `''` se muestra como `<None>` y bloquea la columna. */
  tag: string;
  dataType: ElementDataType;
  defaultValue: string;
  minValue: string;
  maxValue: string;
  decimals: string;
  tooltip: string;
}

export interface RecipeDataRecord {
  id: string;
  name: string;
  displayName: string;
  number: number;
  /** elementId -> valor escrito. Se indexa por id, no por nombre: así
   *  renombrar un elemento no pierde los valores ya cargados. */
  values: Record<string, string>;
  comment: string;
}

export interface Recipe {
  id: string;
  name: string;
  displayName: string;
  number: number;
  /** ISO. TIA la actualiza sola en cada cambio de estructura; acá igual. */
  version: string;
  path: string;
  type: RecipeType;
  maxRecords: string;
  commType: CommType;
  checkLimits: boolean;
  tooltip: string;
  elements: RecipeElement[];
  records: RecipeDataRecord[];
}

type Pestana = 'elements' | 'records';

// ─── Persistencia ────────────────────────────────────────────────

function cargar(): Recipe[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const datos = JSON.parse(raw);
    return Array.isArray(datos) ? datos : [];
  } catch {
    return [];
  }
}

function guardar(recetas: Recipe[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(recetas));
  } catch {
    /* cuota llena o almacenamiento deshabilitado */
  }
}

const nuevoId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

/** Fecha corta, con el mismo aire que la columna Version de TIA. */
function fmtVersion(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  })}`;
}

// ═════════════════════════════════════════════════════════════════

export function RecipesEditor() {
  const [recetas, setRecetas] = useState<Recipe[]>(cargar);
  const [selId, setSelId] = useState<string | null>(null);
  const [pestana, setPestana] = useState<Pestana>('elements');
  const sinMovimiento = useReducedMotion();

  useEffect(() => { guardar(recetas); }, [recetas]);

  // Si no hay nada elegido (primera carga, o se borró la seleccionada),
  // cae sobre la primera: el panel de abajo nunca se queda vacío sin motivo.
  useEffect(() => {
    if (recetas.length === 0) { setSelId(null); return; }
    if (!selId || !recetas.some((r) => r.id === selId)) setSelId(recetas[0].id);
  }, [recetas, selId]);

  const receta = recetas.find((r) => r.id === selId) ?? null;

  /**
   * Aplica un cambio a una receta y le sube la marca de tiempo.
   *
   * Todo pasa por acá para que `version` no se olvide nunca: en TIA esa
   * columna es lo único que dice cuándo cambió la estructura, y una versión
   * desactualizada es peor que no tenerla.
   */
  const editarReceta = useCallback((id: string, patch: Partial<Recipe>) => {
    setRecetas((prev) =>
      prev.map((r) =>
        r.id === id ? { ...r, ...patch, version: new Date().toISOString() } : r
      )
    );
  }, []);

  // ── Recetas ───────────────────────────────────────────────────
  const agregarReceta = useCallback(() => {
    setRecetas((prev) => {
      const n = prev.length === 0 ? 1 : Math.max(...prev.map((r) => r.number)) + 1;
      const nueva: Recipe = {
        id: nuevoId(),
        name: `Recipe_${n}`,
        displayName: `Recipe_${n}`,
        number: n,
        version: new Date().toISOString(),
        path: '\\Flash\\Recipes',
        type: 'Limited',
        maxRecords: '500',
        commType: 'Tags',
        checkLimits: true,
        tooltip: '',
        elements: [],
        records: [],
      };
      setSelId(nueva.id);
      setPestana('elements');
      return [...prev, nueva];
    });
  }, []);

  const borrarReceta = useCallback((id: string) => {
    setRecetas((prev) => prev.filter((r) => r.id !== id));
  }, []);

  const duplicarReceta = useCallback((id: string) => {
    setRecetas((prev) => {
      const orig = prev.find((r) => r.id === id);
      if (!orig) return prev;
      const n = Math.max(...prev.map((r) => r.number)) + 1;
      // Ids nuevos para elementos y registros, y el mapa de valores se
      // reindexa: si se copiaran los ids, las dos recetas compartirían
      // elementos y editar una movería la otra.
      const mapa = new Map<string, string>();
      const elements = orig.elements.map((e) => {
        const id2 = nuevoId();
        mapa.set(e.id, id2);
        return { ...e, id: id2 };
      });
      const records = orig.records.map((rec) => ({
        ...rec,
        id: nuevoId(),
        values: Object.fromEntries(
          Object.entries(rec.values).map(([k, v]) => [mapa.get(k) ?? k, v])
        ),
      }));
      const copia: Recipe = {
        ...orig,
        id: nuevoId(),
        name: `${orig.name}_copia`,
        displayName: `${orig.displayName}_copia`,
        number: n,
        version: new Date().toISOString(),
        elements,
        records,
      };
      const i = prev.findIndex((r) => r.id === id);
      return [...prev.slice(0, i + 1), copia, ...prev.slice(i + 1)];
    });
  }, []);

  // ── Elementos ─────────────────────────────────────────────────
  const agregarElemento = useCallback(() => {
    if (!receta) return;
    const n = receta.elements.length + 1;
    const nuevo: RecipeElement = {
      id: nuevoId(),
      name: `Recipe_element_${n}`,
      displayName: `Recipe_element_${n}`,
      tag: '',
      dataType: '',
      defaultValue: '',
      minValue: '',
      maxValue: '',
      decimals: '0',
      tooltip: '',
    };
    editarReceta(receta.id, { elements: [...receta.elements, nuevo] });
  }, [receta, editarReceta]);

  const editarElemento = useCallback(
    (elemId: string, patch: Partial<RecipeElement>) => {
      if (!receta) return;
      editarReceta(receta.id, {
        elements: receta.elements.map((e) =>
          e.id === elemId ? { ...e, ...patch } : e
        ),
      });
    },
    [receta, editarReceta]
  );

  /** Borra el elemento Y su valor en cada registro: si no, quedan huérfanos. */
  const borrarElemento = useCallback(
    (elemId: string) => {
      if (!receta) return;
      editarReceta(receta.id, {
        elements: receta.elements.filter((e) => e.id !== elemId),
        records: receta.records.map((r) => {
          const { [elemId]: _, ...resto } = r.values;
          return { ...r, values: resto };
        }),
      });
    },
    [receta, editarReceta]
  );

  // ── Registros ─────────────────────────────────────────────────
  const agregarRegistro = useCallback(() => {
    if (!receta) return;
    const n =
      receta.records.length === 0
        ? 1
        : Math.max(...receta.records.map((r) => r.number)) + 1;
    // Arranca con el valor por defecto de cada elemento, como hace TIA.
    const values: Record<string, string> = {};
    for (const e of receta.elements) values[e.id] = e.defaultValue;
    const nuevo: RecipeDataRecord = {
      id: nuevoId(),
      name: `Recipe_data_record_${n}`,
      displayName: `Recipe_data_record_${n}`,
      number: n,
      values,
      comment: '',
    };
    editarReceta(receta.id, { records: [...receta.records, nuevo] });
  }, [receta, editarReceta]);

  const editarRegistro = useCallback(
    (recId: string, patch: Partial<RecipeDataRecord>) => {
      if (!receta) return;
      editarReceta(receta.id, {
        records: receta.records.map((r) =>
          r.id === recId ? { ...r, ...patch } : r
        ),
      });
    },
    [receta, editarReceta]
  );

  const editarValor = useCallback(
    (recId: string, elemId: string, valor: string) => {
      if (!receta) return;
      const rec = receta.records.find((r) => r.id === recId);
      if (!rec) return;
      editarRegistro(recId, { values: { ...rec.values, [elemId]: valor } });
    },
    [receta, editarRegistro]
  );

  const borrarRegistro = useCallback(
    (recId: string) => {
      if (!receta) return;
      editarReceta(receta.id, {
        records: receta.records.filter((r) => r.id !== recId),
      });
    },
    [receta, editarReceta]
  );

  const duplicarRegistro = useCallback(
    (recId: string) => {
      if (!receta) return;
      const orig = receta.records.find((r) => r.id === recId);
      if (!orig) return;
      const n = Math.max(...receta.records.map((r) => r.number)) + 1;
      const copia: RecipeDataRecord = {
        ...orig,
        id: nuevoId(),
        name: `${orig.name}_copia`,
        displayName: `${orig.displayName}_copia`,
        number: n,
        values: { ...orig.values },
      };
      const i = receta.records.findIndex((r) => r.id === recId);
      editarReceta(receta.id, {
        records: [
          ...receta.records.slice(0, i + 1),
          copia,
          ...receta.records.slice(i + 1),
        ],
      });
    },
    [receta, editarReceta]
  );

  // Elementos incompletos: sin ellos los registros no pueden guardar nada.
  const sinTag = useMemo(
    () => (receta ? receta.elements.filter((e) => !e.tag.trim()).length : 0),
    [receta]
  );

  const filaAnim = sinMovimiento
    ? {}
    : {
        initial: { opacity: 0, y: -6 },
        animate: { opacity: 1, y: 0 },
        exit: { opacity: 0, x: -12 },
        transition: { duration: 0.18 },
      };

  return (
    <div className="flex h-full flex-col overflow-hidden bg-slate-100 dark:bg-navy">

      {/* ══ Barra superior ══════════════════════════════════════ */}
      <div className="flex flex-wrap items-center gap-3 border-b border-slate-200 bg-white px-4 py-2.5 dark:border-navy-slate dark:bg-navy-soft">
        <div className="flex items-center gap-2">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-siemens-50 text-siemens dark:bg-siemens/15">
            <BookOpenIcon className="h-4 w-4" />
          </span>
          <div className="leading-tight">
            <p className="text-sm font-bold text-navy dark:text-slate-100">Recetas</p>
            <p className="text-[11px] text-slate-400">
              {recetas.length === 0
                ? 'Ninguna configurada'
                : `${recetas.length} receta${recetas.length === 1 ? '' : 's'}`}
            </p>
          </div>
        </div>

        {receta && (
          <div className="hidden items-center gap-1.5 md:flex">
            <Chip icon={<LayersIcon className="h-3 w-3" />}>
              {receta.elements.length} elemento{receta.elements.length === 1 ? '' : 's'}
            </Chip>
            <Chip icon={<ListIcon className="h-3 w-3" />}>
              {receta.records.length} registro{receta.records.length === 1 ? '' : 's'}
            </Chip>
            {sinTag > 0 && (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-700 ring-1 ring-amber-200 dark:bg-amber-500/15 dark:text-amber-300 dark:ring-amber-500/25">
                <AlertTriangleIcon className="h-3 w-3" />
                {sinTag} sin tag
              </span>
            )}
          </div>
        )}

        <button
          onClick={agregarReceta}
          className="ml-auto flex min-h-[34px] items-center gap-1.5 rounded-lg bg-siemens px-3 py-1.5 text-xs font-semibold text-white outline-none transition hover:bg-siemens-600 focus-visible:ring-2 focus-visible:ring-siemens/50"
        >
          <PlusIcon className="h-3.5 w-3.5" />
          Agregar receta
        </button>
      </div>

      {/* ══ Cuerpo: maestro arriba, detalle abajo ═══════════════ */}
      <div className="flex flex-1 flex-col gap-3 overflow-hidden p-3">

        {/* ── Maestro: la lista de recetas ─────────────────────── */}
        <Panel titulo="Recipes" className="min-h-[130px] flex-[4]">
          {recetas.length === 0 ? (
            <Vacio
              icono={<BookOpenIcon className="h-9 w-9" />}
              titulo="Todavía no hay recetas"
              texto="Una receta agrupa los ingredientes (elements) y las fórmulas concretas (data records) que se cargarán al PLC."
              accion="Crear la primera"
              onAccion={agregarReceta}
            />
          ) : (
            <table className="w-full min-w-[1180px] border-collapse">
              <thead className="sticky top-0 z-10">
                <tr className="bg-slate-100 dark:bg-navy">
                  <Th className="w-[190px]">Name</Th>
                  <Th className="w-[170px]">Display name</Th>
                  <Th className="w-[80px]">Number</Th>
                  <Th className="w-[150px]">Version</Th>
                  <Th className="w-[150px]">Path</Th>
                  <Th className="w-[120px]">Type</Th>
                  <Th className="w-[150px]">Max. data records</Th>
                  <Th className="w-[130px]">Communication type</Th>
                  <Th className="w-[100px] text-center">Check limits</Th>
                  <Th>Tooltip</Th>
                  <Th className="w-[76px]" />
                </tr>
              </thead>
              <tbody>
                <AnimatePresence initial={false}>
                  {recetas.map((r) => {
                    const activa = r.id === selId;
                    return (
                      <motion.tr
                        key={r.id}
                        layout={!sinMovimiento}
                        {...filaAnim}
                        onClick={() => setSelId(r.id)}
                        className={`group cursor-pointer border-t border-slate-100 transition-colors dark:border-navy-slate/70 ${
                          activa
                            ? 'bg-siemens-50/70 dark:bg-siemens/10'
                            : 'hover:bg-slate-50/80 dark:hover:bg-navy/40'
                        }`}
                      >
                        <td className="px-1 py-1">
                          <div className="flex items-center gap-1.5">
                            {/* Barra de selección: dice qué receta se está
                                viendo abajo sin robarle sitio a la columna. */}
                            <span
                              aria-hidden="true"
                              className={`h-6 w-1 shrink-0 rounded-full ${
                                activa ? 'bg-siemens' : 'bg-transparent'
                              }`}
                            />
                            <Celda
                              value={r.name}
                              onChange={(v) => editarReceta(r.id, { name: v })}
                              placeholder="Recipe_1"
                              aria-label={`Nombre de la receta ${r.number}`}
                              className="font-medium"
                            />
                          </div>
                        </td>
                        <td className="px-1 py-1">
                          <Celda
                            value={r.displayName}
                            onChange={(v) => editarReceta(r.id, { displayName: v })}
                            aria-label="Nombre visible"
                          />
                        </td>
                        <td className="px-1 py-1">
                          <Celda
                            value={String(r.number)}
                            onChange={(v) =>
                              editarReceta(r.id, { number: parseInt(v, 10) || 0 })
                            }
                            numerica
                            aria-label="Número"
                          />
                        </td>
                        <td className="px-1 py-1">
                          {/* La escribe el sistema en cada cambio. */}
                          <CeldaLectura title="Se actualiza sola al modificar la receta">
                            {fmtVersion(r.version)}
                          </CeldaLectura>
                        </td>
                        <td className="px-1 py-1">
                          <div className="relative">
                            <FolderOpenIcon className="pointer-events-none absolute left-2.5 top-1/2 h-3 w-3 -translate-y-1/2 text-slate-400" />
                            <Celda
                              value={r.path}
                              onChange={(v) => editarReceta(r.id, { path: v })}
                              placeholder="\Flash\Recipes"
                              aria-label="Ruta de almacenamiento"
                              className="pl-7 font-mono"
                            />
                          </div>
                        </td>
                        <td className="px-1 py-1">
                          <CeldaSelect
                            value={r.type}
                            onChange={(v) =>
                              editarReceta(r.id, { type: v as RecipeType })
                            }
                            opciones={RECIPE_TYPES}
                            aria-label="Tipo de almacenamiento"
                          />
                        </td>
                        <td className="px-1 py-1">
                          <Celda
                            value={r.maxRecords}
                            onChange={(v) =>
                              editarReceta(r.id, {
                                maxRecords: v.replace(/[^0-9]/g, ''),
                              })
                            }
                            placeholder="500"
                            numerica
                            bloqueada={r.type === 'Unlimited'}
                            title={
                              r.type === 'Unlimited'
                                ? 'Sin límite: no aplica con Type = Unlimited'
                                : undefined
                            }
                            aria-label="Máximo de registros"
                          />
                        </td>
                        <td className="px-1 py-1">
                          <CeldaSelect
                            value={r.commType}
                            onChange={(v) =>
                              editarReceta(r.id, { commType: v as CommType })
                            }
                            opciones={COMM_TYPES}
                            aria-label="Tipo de comunicación"
                          />
                        </td>
                        <td className="px-1 py-1">
                          <CeldaCheck
                            checked={r.checkLimits}
                            onChange={(v) => editarReceta(r.id, { checkLimits: v })}
                            aria-label="Validar contra los límites de cada elemento"
                          />
                        </td>
                        <td className="px-1 py-1">
                          <Celda
                            value={r.tooltip}
                            onChange={(v) => editarReceta(r.id, { tooltip: v })}
                            placeholder="Ayuda para el operador"
                            aria-label="Tooltip"
                          />
                        </td>
                        <td className="px-1 py-1">
                          <AccionesFila>
                            <IconoBoton
                              onClick={() => duplicarReceta(r.id)}
                              titulo="Duplicar receta"
                              className="hover:bg-slate-100 hover:text-siemens dark:hover:bg-navy-slate/60"
                            >
                              <CopyIcon className="h-3.5 w-3.5" />
                            </IconoBoton>
                            <IconoBoton
                              onClick={() => borrarReceta(r.id)}
                              titulo="Eliminar receta"
                              className="hover:bg-red-50 hover:text-state-error dark:hover:bg-state-error/10"
                            >
                              <Trash2Icon className="h-3.5 w-3.5" />
                            </IconoBoton>
                          </AccionesFila>
                        </td>
                      </motion.tr>
                    );
                  })}
                </AnimatePresence>
              </tbody>
            </table>
          )}
        </Panel>

        {/* ── Detalle: elements / data records de la seleccionada ─ */}
        {receta && (
          <div className="flex flex-[6] flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-card dark:border-navy-slate dark:bg-navy-soft">

            {/* Pestañas del detalle */}
            <div className="flex flex-wrap items-center gap-2 border-b border-slate-200 px-3 py-2 dark:border-navy-slate">
              <div className="flex rounded-lg border border-slate-200 bg-slate-50 p-0.5 dark:border-navy-slate dark:bg-navy">
                <BotonPestana
                  activa={pestana === 'elements'}
                  onClick={() => setPestana('elements')}
                  icon={<LayersIcon className="h-3.5 w-3.5" />}
                  label="Elements"
                  contador={receta.elements.length}
                />
                <BotonPestana
                  activa={pestana === 'records'}
                  onClick={() => setPestana('records')}
                  icon={<ListIcon className="h-3.5 w-3.5" />}
                  label="Data records"
                  contador={receta.records.length}
                />
              </div>

              <p className="truncate text-[11px] text-slate-400">
                de <b className="font-semibold text-slate-500 dark:text-slate-300">{receta.name}</b>
              </p>

              <button
                onClick={pestana === 'elements' ? agregarElemento : agregarRegistro}
                disabled={pestana === 'records' && receta.elements.length === 0}
                className="ml-auto flex min-h-[30px] items-center gap-1.5 rounded-lg border border-siemens/30 bg-siemens-50 px-2.5 py-1 text-xs font-semibold text-siemens-700 outline-none transition hover:bg-siemens-100 focus-visible:ring-2 focus-visible:ring-siemens/40 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-siemens/10 dark:text-siemens-200 dark:hover:bg-siemens/20"
                title={
                  pestana === 'records' && receta.elements.length === 0
                    ? 'Primero define al menos un elemento'
                    : undefined
                }
              >
                <PlusIcon className="h-3.5 w-3.5" />
                {pestana === 'elements' ? 'Agregar elemento' : 'Agregar registro'}
              </button>
            </div>

            <div className="mp-scroll mp-scroll-dark flex-1 overflow-auto">
              {pestana === 'elements' ? (
                receta.elements.length === 0 ? (
                  <Vacio
                    icono={<LayersIcon className="h-9 w-9" />}
                    titulo="Sin elementos"
                    texto="Los elementos son las columnas de la receta: un ingrediente por fila, cada uno apuntando al tag del PLC donde se escribirá su valor."
                    accion="Agregar el primero"
                    onAccion={agregarElemento}
                  />
                ) : (
                  <table className="w-full min-w-[1140px] border-collapse">
                    <thead className="sticky top-0 z-10">
                      <tr className="bg-slate-100 dark:bg-navy">
                        <Th className="w-[170px]">Name</Th>
                        <Th className="w-[160px]">Display name</Th>
                        <Th className="w-[190px]">Tag</Th>
                        <Th className="w-[120px]">Data type</Th>
                        <Th className="w-[90px]">Data length</Th>
                        <Th className="w-[110px]">Default value</Th>
                        <Th className="w-[120px]">Minimum value</Th>
                        <Th className="w-[120px]">Maximum value</Th>
                        <Th className="w-[110px]">Decimal places</Th>
                        <Th>Tooltip</Th>
                        <Th className="w-[76px]" />
                      </tr>
                    </thead>
                    <tbody>
                      <AnimatePresence initial={false}>
                        {receta.elements.map((e) => (
                          <motion.tr
                            key={e.id}
                            layout={!sinMovimiento}
                            {...filaAnim}
                            className="group border-t border-slate-100 transition-colors hover:bg-slate-50/80 dark:border-navy-slate/70 dark:hover:bg-navy/40"
                          >
                            <td className="px-1 py-1">
                              <Celda
                                value={e.name}
                                onChange={(v) => editarElemento(e.id, { name: v })}
                                placeholder="limon"
                                aria-label="Nombre del elemento"
                                className="font-medium"
                              />
                            </td>
                            <td className="px-1 py-1">
                              <Celda
                                value={e.displayName}
                                onChange={(v) => editarElemento(e.id, { displayName: v })}
                                aria-label="Nombre visible"
                              />
                            </td>
                            <td className="px-1 py-1">
                              <div className="relative">
                                <TagIcon
                                  className={`pointer-events-none absolute left-2.5 top-1/2 h-3 w-3 -translate-y-1/2 ${
                                    e.tag.trim() ? 'text-siemens' : 'text-slate-400'
                                  }`}
                                />
                                <Celda
                                  value={e.tag}
                                  onChange={(v) => editarElemento(e.id, { tag: v })}
                                  // Mismo texto que muestra TIA sin tag.
                                  placeholder="<None>"
                                  title="Sin tag, la columna de este elemento queda bloqueada en Data records"
                                  aria-label="Tag del PLC"
                                  className="pl-7 font-mono"
                                />
                              </div>
                            </td>
                            <td className="px-1 py-1">
                              <CeldaSelect
                                value={e.dataType}
                                onChange={(v) =>
                                  editarElemento(e.id, {
                                    dataType: v as ElementDataType,
                                  })
                                }
                                opciones={DATA_TYPES}
                                aria-label="Tipo de dato"
                              />
                            </td>
                            <td className="px-1 py-1">
                              {/* Sale del tipo, no se escribe. */}
                              <CeldaLectura
                                title="Bytes que ocupa el tipo elegido"
                                className="text-right tabular-nums"
                              >
                                {LARGO_TIPO[e.dataType] ?? 0}
                              </CeldaLectura>
                            </td>
                            <td className="px-1 py-1">
                              <Celda
                                value={e.defaultValue}
                                onChange={(v) => editarElemento(e.id, { defaultValue: v })}
                                placeholder="0"
                                numerica
                                aria-label="Valor por defecto"
                              />
                            </td>
                            <td className="px-1 py-1">
                              <Celda
                                value={e.minValue}
                                onChange={(v) => editarElemento(e.id, { minValue: v })}
                                placeholder="—"
                                numerica
                                aria-label="Valor mínimo"
                              />
                            </td>
                            <td className="px-1 py-1">
                              <Celda
                                value={e.maxValue}
                                onChange={(v) => editarElemento(e.id, { maxValue: v })}
                                placeholder="—"
                                numerica
                                aria-label="Valor máximo"
                              />
                            </td>
                            <td className="px-1 py-1">
                              <Celda
                                value={e.decimals}
                                onChange={(v) =>
                                  editarElemento(e.id, {
                                    decimals: v.replace(/[^0-9]/g, ''),
                                  })
                                }
                                placeholder="0"
                                numerica
                                aria-label="Decimales"
                              />
                            </td>
                            <td className="px-1 py-1">
                              <Celda
                                value={e.tooltip}
                                onChange={(v) => editarElemento(e.id, { tooltip: v })}
                                placeholder="Ayuda para el operador"
                                aria-label="Tooltip"
                              />
                            </td>
                            <td className="px-1 py-1">
                              <AccionesFila>
                                <IconoBoton
                                  onClick={() => borrarElemento(e.id)}
                                  titulo="Eliminar elemento (y su columna en los registros)"
                                  className="hover:bg-red-50 hover:text-state-error dark:hover:bg-state-error/10"
                                >
                                  <Trash2Icon className="h-3.5 w-3.5" />
                                </IconoBoton>
                              </AccionesFila>
                            </td>
                          </motion.tr>
                        ))}
                      </AnimatePresence>
                    </tbody>
                  </table>
                )
              ) : receta.elements.length === 0 ? (
                <Vacio
                  icono={<LayersIcon className="h-9 w-9" />}
                  titulo="Primero los elementos"
                  texto="Un registro es una fila con un valor por elemento. Sin elementos definidos no hay columnas que llenar."
                  accion="Ir a Elements"
                  onAccion={() => setPestana('elements')}
                />
              ) : receta.records.length === 0 ? (
                <Vacio
                  icono={<ListIcon className="h-9 w-9" />}
                  titulo="Sin registros"
                  texto="Cada registro es una fórmula concreta: el conjunto de valores que se cargará al PLC de una sola vez."
                  accion="Agregar el primero"
                  onAccion={agregarRegistro}
                />
              ) : (
                <table className="w-full border-collapse">
                  <thead className="sticky top-0 z-10">
                    <tr className="bg-slate-100 dark:bg-navy">
                      <Th className="w-[200px]">Name</Th>
                      <Th className="w-[190px]">Display name</Th>
                      <Th className="w-[80px]">Number</Th>
                      {/* Una columna por elemento: la tabla crece con la receta */}
                      {receta.elements.map((e) => (
                        <Th key={e.id} className="w-[130px]">
                          <span className="flex items-center gap-1">
                            {!e.tag.trim() && (
                              <AlertTriangleIcon
                                className="h-3 w-3 shrink-0 text-amber-500"
                                aria-label="Sin tag asignado"
                              />
                            )}
                            <span className="truncate" title={e.name}>
                              {e.name || '—'}
                            </span>
                          </span>
                        </Th>
                      ))}
                      <Th className="w-[170px]">Comment</Th>
                      <Th className="w-[76px]" />
                    </tr>
                  </thead>
                  <tbody>
                    <AnimatePresence initial={false}>
                      {receta.records.map((rec) => (
                        <motion.tr
                          key={rec.id}
                          layout={!sinMovimiento}
                          {...filaAnim}
                          className="group border-t border-slate-100 transition-colors hover:bg-slate-50/80 dark:border-navy-slate/70 dark:hover:bg-navy/40"
                        >
                          <td className="px-1 py-1">
                            <Celda
                              value={rec.name}
                              onChange={(v) => editarRegistro(rec.id, { name: v })}
                              aria-label="Nombre del registro"
                              className="font-medium"
                            />
                          </td>
                          <td className="px-1 py-1">
                            <Celda
                              value={rec.displayName}
                              onChange={(v) => editarRegistro(rec.id, { displayName: v })}
                              aria-label="Nombre visible"
                            />
                          </td>
                          <td className="px-1 py-1">
                            <Celda
                              value={String(rec.number)}
                              onChange={(v) =>
                                editarRegistro(rec.id, {
                                  number: parseInt(v, 10) || 0,
                                })
                              }
                              numerica
                              aria-label="Número"
                            />
                          </td>

                          {/* Un valor por elemento. Rosa = el elemento no
                              tiene tag, así que no hay dónde escribirlo. */}
                          {receta.elements.map((e) => {
                            const bloqueada = !e.tag.trim();
                            return (
                              <td key={e.id} className="px-1 py-1">
                                <Celda
                                  value={rec.values[e.id] ?? ''}
                                  onChange={(v) => editarValor(rec.id, e.id, v)}
                                  placeholder={e.defaultValue || '0'}
                                  numerica
                                  bloqueada={bloqueada}
                                  title={
                                    bloqueada
                                      ? `«${e.name}» no tiene tag asignado. Ponle uno en la pestaña Elements para poder cargar su valor.`
                                      : undefined
                                  }
                                  aria-label={`${e.name} en ${rec.name}`}
                                />
                              </td>
                            );
                          })}

                          <td className="px-1 py-1">
                            <Celda
                              value={rec.comment}
                              onChange={(v) => editarRegistro(rec.id, { comment: v })}
                              placeholder="Nota"
                              aria-label="Comentario"
                            />
                          </td>
                          <td className="px-1 py-1">
                            <AccionesFila>
                              <IconoBoton
                                onClick={() => duplicarRegistro(rec.id)}
                                titulo="Duplicar registro"
                                className="hover:bg-slate-100 hover:text-siemens dark:hover:bg-navy-slate/60"
                              >
                                <CopyIcon className="h-3.5 w-3.5" />
                              </IconoBoton>
                              <IconoBoton
                                onClick={() => borrarRegistro(rec.id)}
                                titulo="Eliminar registro"
                                className="hover:bg-red-50 hover:text-state-error dark:hover:bg-state-error/10"
                              >
                                <Trash2Icon className="h-3.5 w-3.5" />
                              </IconoBoton>
                            </AccionesFila>
                          </td>
                        </motion.tr>
                      ))}
                    </AnimatePresence>
                  </tbody>
                </table>
              )}
            </div>

            {/* Pie honesto */}
            <div className="flex items-start gap-2 border-t border-slate-100 bg-slate-50/70 px-4 py-2.5 dark:border-navy-slate dark:bg-navy/40">
              <InfoIcon className="mt-px h-3.5 w-3.5 shrink-0 text-slate-400" />
              <p className="min-w-0 text-[11px] leading-relaxed text-slate-400">
                Vista de configuración: se guarda en este navegador. Todavía no
                existe «escribir en el PLC» ni «leer del PLC», que es lo que
                hace que una receta sirva de algo.
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════
// Piezas locales
// ═════════════════════════════════════════════════════════════════

function Panel({
  titulo,
  className = '',
  children,
}: {
  titulo: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <section
      className={`flex flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-card dark:border-navy-slate dark:bg-navy-soft ${className}`}
    >
      <p className="border-b border-slate-200 px-4 py-2 text-[10px] font-bold uppercase tracking-wider text-slate-400 dark:border-navy-slate">
        {titulo}
      </p>
      <div className="mp-scroll mp-scroll-dark flex-1 overflow-auto">{children}</div>
    </section>
  );
}

function BotonPestana({
  activa,
  onClick,
  icon,
  label,
  contador,
}: {
  activa: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  contador: number;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={activa}
      onClick={onClick}
      className={`flex items-center gap-1.5 rounded-md px-3 py-1 text-xs font-semibold outline-none transition focus-visible:ring-2 focus-visible:ring-siemens/50 ${
        activa
          ? 'bg-white text-navy shadow-sm dark:bg-navy-slate dark:text-slate-100'
          : 'text-slate-400 hover:text-slate-600 dark:hover:text-slate-300'
      }`}
    >
      {icon}
      {label}
      <span
        className={`rounded-full px-1.5 text-[10px] tabular-nums ${
          activa
            ? 'bg-siemens-50 text-siemens dark:bg-siemens/20 dark:text-siemens-200'
            : 'bg-slate-200/70 text-slate-400 dark:bg-navy-slate/60'
        }`}
      >
        {contador}
      </span>
    </button>
  );
}

function Chip({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-500 dark:bg-navy-slate/50 dark:text-slate-400">
      {icon}
      {children}
    </span>
  );
}

function Vacio({
  icono,
  titulo,
  texto,
  accion,
  onAccion,
}: {
  icono: React.ReactNode;
  titulo: string;
  texto: string;
  accion: string;
  onAccion: () => void;
}) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-12 text-center">
      <span className="mb-3 text-slate-300 dark:text-slate-600">{icono}</span>
      <p className="text-sm font-semibold text-slate-500 dark:text-slate-300">{titulo}</p>
      <p className="mt-1 max-w-md text-xs leading-relaxed text-slate-400">{texto}</p>
      <button
        onClick={onAccion}
        className="mt-5 flex items-center gap-1.5 rounded-lg bg-siemens px-3.5 py-2 text-xs font-semibold text-white transition hover:bg-siemens-600"
      >
        <PlusIcon className="h-3.5 w-3.5" />
        {accion}
      </button>
    </div>
  );
}
