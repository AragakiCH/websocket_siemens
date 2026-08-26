// =========================================================================
// AlarmsEditor.tsx
// Tabla de configuración de alarmas, al estilo del editor de TIA Portal.
//
// ⚠️ SOLO VISTA. No hay motor de alarmas todavía: nada evalúa los `triggerTag`
//    ni dispara nada. La tabla `alarmas` del esquema del HMI existe
//    (sql_driver.ts -> ddl_esquema_hmi) pero ningún endpoint la escribe.
//
// Lo que sí hace: dejar armar la lista y que sobreviva a un refresh, igual
// que el Flow Editor con su lienzo (localStorage, no servidor).
//
// Las cinco columnas son las de TIA y se dejan con su nombre en inglés a
// propósito: es el vocabulario con el que se trabaja en el proyecto y así se
// reconocen al lado del editor de Siemens.
//
//   ID           correlativo, no editable
//   Name         nombre corto de la alarma
//   Alarm text   el mensaje que ve el operador
//   Alarm class  categoría (desplegable)
//   Trigger tag  variable que la dispara
// =========================================================================
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { motion, AnimatePresence, useReducedMotion } from 'framer-motion';
import {
  BellIcon,
  PlusIcon,
  Trash2Icon,
  SearchIcon,
  CopyIcon,
  TagIcon,
  AlertOctagonIcon,
  AlertCircleIcon,
  AlertTriangleIcon,
  WrenchIcon,
  InfoIcon,
  BellOffIcon,
  ChevronDownIcon,
} from 'lucide-react';
import { Th, Celda, IconoBoton, AccionesFila } from '../ui/TableBits';

const STORAGE_KEY = 'hmi.alarms';

// ─── Clases de alarma ────────────────────────────────────────────
//
// Ordenadas de más grave a menos, que es como conviene leerlas en el
// desplegable. `ejemplo` se usa como texto sugerido al crear una alarma
// nueva: es más útil arrancar de algo que de una fila en blanco.
export type AlarmClassId =
  | 'Critical'
  | 'Error'
  | 'Warning'
  | 'Maintenance'
  | 'Information';

interface AlarmClassDef {
  id: AlarmClassId;
  icon: typeof BellIcon;
  ejemplo: string;
  /** Punto de color de la fila. */
  punto: string;
  /** Insignia: fondo + texto, en claro y oscuro. */
  insignia: string;
}

export const ALARM_CLASSES: AlarmClassDef[] = [
  {
    id: 'Critical',
    icon: AlertOctagonIcon,
    ejemplo: 'Parada de emergencia activada',
    punto: 'bg-rose-600',
    insignia:
      'bg-rose-100 text-rose-700 ring-rose-200 dark:bg-rose-500/15 dark:text-rose-300 dark:ring-rose-500/25',
  },
  {
    id: 'Error',
    icon: AlertCircleIcon,
    ejemplo: 'Fallo de comunicación con PLC',
    punto: 'bg-red-500',
    insignia:
      'bg-red-100 text-red-700 ring-red-200 dark:bg-red-500/15 dark:text-red-300 dark:ring-red-500/25',
  },
  {
    id: 'Warning',
    icon: AlertTriangleIcon,
    ejemplo: 'Temperatura superior a 80 °C',
    punto: 'bg-amber-500',
    insignia:
      'bg-amber-100 text-amber-700 ring-amber-200 dark:bg-amber-500/15 dark:text-amber-300 dark:ring-amber-500/25',
  },
  {
    id: 'Maintenance',
    icon: WrenchIcon,
    ejemplo: 'Se requiere mantenimiento preventivo',
    punto: 'bg-violet-500',
    insignia:
      'bg-violet-100 text-violet-700 ring-violet-200 dark:bg-violet-500/15 dark:text-violet-300 dark:ring-violet-500/25',
  },
  {
    id: 'Information',
    icon: InfoIcon,
    ejemplo: 'Sistema iniciado',
    punto: 'bg-sky-500',
    insignia:
      'bg-sky-100 text-sky-700 ring-sky-200 dark:bg-sky-500/15 dark:text-sky-300 dark:ring-sky-500/25',
  },
];

const claseDe = (id: AlarmClassId): AlarmClassDef =>
  ALARM_CLASSES.find((c) => c.id === id) ?? ALARM_CLASSES[1];

// ─── Modelo ──────────────────────────────────────────────────────

export interface Alarm {
  id: number;
  name: string;
  text: string;
  alarmClass: AlarmClassId;
  triggerTag: string;
}

function cargar(): Alarm[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const datos = JSON.parse(raw);
    return Array.isArray(datos) ? datos : [];
  } catch {
    return [];
  }
}

function guardar(alarmas: Alarm[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(alarmas));
  } catch {
    /* cuota llena o almacenamiento deshabilitado: no vale romper la vista */
  }
}

// ═════════════════════════════════════════════════════════════════

export function AlarmsEditor() {
  const [alarmas, setAlarmas] = useState<Alarm[]>(cargar);
  const [filtro, setFiltro] = useState('');
  const [recienCreada, setRecienCreada] = useState<number | null>(null);
  const sinMovimiento = useReducedMotion();
  const cuerpoRef = useRef<HTMLDivElement>(null);

  useEffect(() => { guardar(alarmas); }, [alarmas]);

  /**
   * Siguiente ID: el mayor usado + 1.
   *
   * NO se renumera al borrar, a propósito. Si la alarma 3 desaparece, la 4
   * sigue siendo la 4: un ID que se reasigna deja de identificar nada, y el
   * día que esto se conecte a la tabla `alarmas` habría filas históricas
   * apuntando a un ID que ahora significa otra cosa.
   */
  const siguienteId = useMemo(
    () => (alarmas.length === 0 ? 1 : Math.max(...alarmas.map((a) => a.id)) + 1),
    [alarmas]
  );

  const agregar = useCallback(() => {
    const clase = ALARM_CLASSES[1]; // Error, la más frecuente
    const nueva: Alarm = {
      id: siguienteId,
      name: `Alarma_${siguienteId}`,
      text: '',
      alarmClass: clase.id,
      triggerTag: '',
    };
    setAlarmas((prev) => [...prev, nueva]);
    setRecienCreada(nueva.id);
    setFiltro('');
    // Deja ver la fila nueva sin que el usuario tenga que buscarla.
    requestAnimationFrame(() => {
      cuerpoRef.current?.scrollTo({
        top: cuerpoRef.current.scrollHeight,
        behavior: sinMovimiento ? 'auto' : 'smooth',
      });
    });
  }, [siguienteId, sinMovimiento]);

  const editar = useCallback((id: number, patch: Partial<Alarm>) => {
    setAlarmas((prev) => prev.map((a) => (a.id === id ? { ...a, ...patch } : a)));
  }, []);

  const borrar = useCallback((id: number) => {
    setAlarmas((prev) => prev.filter((a) => a.id !== id));
  }, []);

  const duplicar = useCallback((id: number) => {
    setAlarmas((prev) => {
      const orig = prev.find((a) => a.id === id);
      if (!orig) return prev;
      const nuevoId = Math.max(...prev.map((a) => a.id)) + 1;
      const copia: Alarm = { ...orig, id: nuevoId, name: `${orig.name}_copia` };
      const i = prev.findIndex((a) => a.id === id);
      return [...prev.slice(0, i + 1), copia, ...prev.slice(i + 1)];
    });
  }, []);

  // ── Filtro ────────────────────────────────────────────────────
  const visibles = useMemo(() => {
    const q = filtro.trim().toLowerCase();
    if (!q) return alarmas;
    return alarmas.filter((a) =>
      `${a.id} ${a.name} ${a.text} ${a.alarmClass} ${a.triggerTag}`
        .toLowerCase()
        .includes(q)
    );
  }, [alarmas, filtro]);

  // Cuántas hay de cada clase, para la leyenda de arriba.
  const conteos = useMemo(() => {
    const m = new Map<AlarmClassId, number>();
    for (const a of alarmas) m.set(a.alarmClass, (m.get(a.alarmClass) ?? 0) + 1);
    return m;
  }, [alarmas]);

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
            <BellIcon className="h-4 w-4" />
          </span>
          <div className="leading-tight">
            <p className="text-sm font-bold text-navy dark:text-slate-100">Alarmas</p>
            <p className="text-[11px] text-slate-400">
              {alarmas.length === 0
                ? 'Ninguna configurada'
                : `${alarmas.length} configurada${alarmas.length === 1 ? '' : 's'}`}
            </p>
          </div>
        </div>

        {/* Leyenda con el conteo por clase */}
        {alarmas.length > 0 && (
          <div className="hidden flex-wrap items-center gap-1.5 md:flex">
            {ALARM_CLASSES.filter((c) => conteos.get(c.id)).map((c) => (
              <span
                key={c.id}
                className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1 ${c.insignia}`}
              >
                <span className={`h-1.5 w-1.5 rounded-full ${c.punto}`} />
                {c.id}
                <span className="opacity-60">{conteos.get(c.id)}</span>
              </span>
            ))}
          </div>
        )}

        <div className="ml-auto flex items-center gap-2">
          {alarmas.length > 0 && (
            <div className="relative">
              <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
              <input
                type="search"
                value={filtro}
                onChange={(e) => setFiltro(e.target.value)}
                // El placeholder enumera las columnas a propósito: la búsqueda
                // barre las cinco a la vez y no hay forma de adivinarlo mirando
                // una caja que solo diga "Buscar…".
                placeholder="Buscar por ID, nombre, texto, clase o tag…"
                aria-label="Buscar alarmas por ID, nombre, texto, clase o tag"
                className="w-44 rounded-lg border border-slate-200 bg-white py-1.5 pl-8 pr-2.5 text-xs text-navy outline-none transition placeholder:text-slate-400 focus:border-siemens focus:ring-2 focus:ring-siemens/20 dark:border-navy-slate dark:bg-navy dark:text-slate-100 sm:w-72"
              />
            </div>
          )}
          <button
            onClick={agregar}
            className="flex min-h-[34px] items-center gap-1.5 rounded-lg bg-siemens px-3 py-1.5 text-xs font-semibold text-white outline-none transition hover:bg-siemens-600 focus-visible:ring-2 focus-visible:ring-siemens/50"
          >
            <PlusIcon className="h-3.5 w-3.5" />
            Agregar alarma
          </button>
        </div>
      </div>

      {/* ══ Tabla ═══════════════════════════════════════════════ */}
      <div className="flex-1 overflow-hidden p-4">
        <div className="mx-auto flex h-full max-w-6xl flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-card dark:border-navy-slate dark:bg-navy-soft">

          {/* El contenedor scrollea en los dos ejes: en pantallas angostas la
              tabla no se comprime, se desplaza. Así ninguna columna se
              vuelve ilegible. */}
          <div ref={cuerpoRef} className="mp-scroll mp-scroll-dark flex-1 overflow-auto">
            <table className="w-full min-w-[860px] border-collapse text-left">
              <thead className="sticky top-0 z-10">
                <tr className="bg-slate-100 dark:bg-navy">
                  <Th className="w-[72px] text-center">ID</Th>
                  <Th className="w-[200px]">Name</Th>
                  <Th>Alarm text</Th>
                  <Th className="w-[190px]">Alarm class</Th>
                  <Th className="w-[210px]">Trigger tag</Th>
                  <Th className="w-[76px] text-center">
                    <span className="sr-only">Acciones</span>
                  </Th>
                </tr>
              </thead>

              <tbody>
                <AnimatePresence initial={false}>
                  {visibles.map((a) => {
                    const clase = claseDe(a.alarmClass);
                    const Icono = clase.icon;
                    return (
                      <motion.tr
                        key={a.id}
                        layout={!sinMovimiento}
                        {...filaAnim}
                        className="group border-t border-slate-100 transition-colors hover:bg-slate-50/80 dark:border-navy-slate/70 dark:hover:bg-navy/40"
                      >
                        {/* ID — no editable */}
                        <td className="px-2 py-1.5">
                          <div className="flex items-center justify-center gap-1.5">
                            <Icono className={`h-3.5 w-3.5 ${textoDe(clase)}`} />
                            <span className="font-mono text-xs tabular-nums text-slate-500 dark:text-slate-400">
                              {a.id}
                            </span>
                          </div>
                        </td>

                        {/* Name */}
                        <td className="px-1 py-1">
                          <Celda
                            value={a.name}
                            onChange={(v) => editar(a.id, { name: v })}
                            placeholder="Nombre de la alarma"
                            autoFocus={recienCreada === a.id}
                            onFocus={() => setRecienCreada(null)}
                            aria-label={`Nombre de la alarma ${a.id}`}
                            className="font-medium"
                          />
                        </td>

                        {/* Alarm text */}
                        <td className="px-1 py-1">
                          <Celda
                            value={a.text}
                            onChange={(v) => editar(a.id, { text: v })}
                            placeholder={clase.ejemplo}
                            aria-label={`Texto de la alarma ${a.id}`}
                          />
                        </td>

                        {/* Alarm class — el desplegable.
                            Sin fondo de color a propósito: el <select> pinta
                            la lista desplegable NATIVA con su mismo fondo, y
                            un fondo claro con el texto claro del modo oscuro
                            dejaba las opciones ilegibles. El color de la clase
                            vive en el punto de la izquierda, que no arrastra
                            ese problema. */}
                        <td className="px-1 py-1">
                          <div className="relative">
                            <select
                              value={a.alarmClass}
                              onChange={(e) =>
                                editar(a.id, {
                                  alarmClass: e.target.value as AlarmClassId,
                                })
                              }
                              aria-label={`Clase de la alarma ${a.id}`}
                              className="w-full cursor-pointer appearance-none rounded-md border border-transparent bg-transparent py-1.5 pl-7 pr-7 text-xs font-medium text-navy outline-none transition hover:border-slate-200 hover:bg-white focus:border-siemens focus:bg-white focus:ring-2 focus:ring-siemens/20 dark:text-slate-100 dark:hover:border-navy-slate dark:hover:bg-navy dark:focus:bg-navy"
                            >
                              {ALARM_CLASSES.map((c) => (
                                <option key={c.id} value={c.id}>
                                  {c.id}
                                </option>
                              ))}
                            </select>
                            <span
                              aria-hidden="true"
                              className={`pointer-events-none absolute left-2.5 top-1/2 h-2 w-2 -translate-y-1/2 rounded-full ${clase.punto}`}
                            />
                            <ChevronDownIcon
                              aria-hidden="true"
                              className="pointer-events-none absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400"
                            />
                          </div>
                        </td>

                        {/* Trigger tag */}
                        <td className="px-1 py-1">
                          <div className="relative">
                            <TagIcon className="pointer-events-none absolute left-2.5 top-1/2 h-3 w-3 -translate-y-1/2 text-slate-400" />
                            <Celda
                              value={a.triggerTag}
                              onChange={(v) => editar(a.id, { triggerTag: v })}
                              // Mismo texto que usa TIA cuando no hay tag.
                              placeholder="<No tag>"
                              aria-label={`Tag disparador de la alarma ${a.id}`}
                              className="pl-7 font-mono"
                            />
                          </div>
                        </td>

                        {/* Acciones — aparecen al pasar por encima */}
                        <td className="px-1 py-1">
                          <AccionesFila>
                            <IconoBoton
                              onClick={() => duplicar(a.id)}
                              titulo="Duplicar"
                              className="hover:bg-slate-100 hover:text-siemens dark:hover:bg-navy-slate/60"
                            >
                              <CopyIcon className="h-3.5 w-3.5" />
                            </IconoBoton>
                            <IconoBoton
                              onClick={() => borrar(a.id)}
                              titulo="Eliminar"
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

            {/* Sin alarmas todavía */}
            {alarmas.length === 0 && (
              <div className="flex flex-col items-center justify-center px-6 py-16 text-center">
                <BellOffIcon className="mb-3 h-10 w-10 text-slate-300 dark:text-slate-600" />
                <p className="text-sm font-semibold text-slate-500 dark:text-slate-300">
                  Todavía no hay alarmas
                </p>
                <p className="mt-1 max-w-sm text-xs leading-relaxed text-slate-400">
                  Cada alarma necesita un nombre, el texto que verá el operador,
                  su clase y el tag que la dispara.
                </p>
                <button
                  onClick={agregar}
                  className="mt-5 flex items-center gap-1.5 rounded-lg bg-siemens px-3.5 py-2 text-xs font-semibold text-white transition hover:bg-siemens-600"
                >
                  <PlusIcon className="h-3.5 w-3.5" />
                  Crear la primera
                </button>
              </div>
            )}

            {/* Hay alarmas pero ninguna pasa el filtro */}
            {alarmas.length > 0 && visibles.length === 0 && (
              <div className="px-6 py-12 text-center">
                <p className="text-sm text-slate-400">
                  Ninguna alarma coincide con «{filtro}».
                </p>
                <button
                  onClick={() => setFiltro('')}
                  className="mt-2 text-xs font-semibold text-siemens hover:underline"
                >
                  Limpiar búsqueda
                </button>
              </div>
            )}
          </div>

          {/* Pie: recordatorio honesto de que esto no dispara nada */}
          <div className="flex items-start gap-2 border-t border-slate-100 bg-slate-50/70 px-4 py-2.5 dark:border-navy-slate dark:bg-navy/40">
            <InfoIcon className="mt-px h-3.5 w-3.5 shrink-0 text-slate-400" />
            <p className="min-w-0 text-[11px] leading-relaxed text-slate-400">
              Vista de configuración: la lista se guarda en este navegador,
              pero todavía no hay motor de alarmas — ningún tag se evalúa ni se
              dispara nada.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════
// Piezas
// ═════════════════════════════════════════════════════════════════

/** Color de texto del icono de la fila, derivado de la insignia de la clase. */
function textoDe(c: AlarmClassDef): string {
  const m = c.insignia.match(/text-[a-z]+-\d+/);
  return m ? m[0] : 'text-slate-400';
}
