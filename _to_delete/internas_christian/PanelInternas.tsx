// =========================================================================
// PanelInternas.tsx
// Variables internas del HMI: crearlas, verlas y forzar su valor.
//
// QUÉ SON
// Las que no existen en ningún autómata: un modo de trabajo, una consigna de
// pantalla, un interruptor de «mostrar detalles». Y, sobre todo al principio,
// las que sirven para PROBAR — se fuerza un valor a mano y se ve la animación
// moverse sin tener un PLC delante.
//
// POR QUÉ ESTÁ EN EL DISEÑADOR Y NO EN CONFIGURACIÓN
// Porque es donde se usan. Se crea la variable, se enlaza al widget en la
// pestaña de al lado y se fuerza para ver si el dibujo responde, sin cambiar
// de pantalla ni de contexto. En Configuración estaría bien ordenada y mal
// puesta.
//
// EL VALOR QUE SE VE ES EL DE VERDAD
// No se lee de este panel ni de la respuesta del alta: sale de las variables
// que llegan por WebSocket, las mismas que ve un widget. Así, si algo no
// llegara, aquí se vería igual de mal que en la pantalla — y no habría dos
// verdades que comparar.
// =========================================================================
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  PlusIcon,
  Trash2Icon,
  RefreshCwIcon,
  AlertTriangleIcon,
  VariableIcon } from
'lucide-react';
import { useAppStore } from '../../context/AppStore';
import { escribir } from '../../services/escrituraApi';
import {
  listarInternas,
  crearInterna,
  borrarInterna,
  idDeInterna,
  TIPOS,
  PLC_INTERNO,
  type TipoInterna,
  type VariableInterna } from
'../../services/internasApi';

const CAMPO =
'w-full rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-navy outline-none transition focus:border-siemens focus:ring-2 focus:ring-siemens/20 dark:border-navy-slate dark:bg-navy dark:text-slate-100';

/** El valor de ahora mismo de una interna, tal y como lo ve un widget. */
function useValorEnVivo(nombre: string): { valor: unknown; hay: boolean } {
  const { variables } = useAppStore();
  const v = variables.find((x) => x.id === idDeInterna(nombre));
  return { valor: v?.value, hay: !!v };
}

/**
 * La celda con la que se fuerza el valor.
 *
 * Un control por tipo, y no un campo de texto para todo: un sí/no se cambia
 * de un clic, y pedir que alguien escriba «true» para arrancar algo es pedir
 * una errata.
 */
function Forzar({
  v,
  onError




}: {v: VariableInterna;onError: (t: string) => void;}) {
  const { valor, hay } = useValorEnVivo(v.nombre);
  const [borrador, setBorrador] = useState('');
  const [mandando, setMandando] = useState(false);

  // Mientras no se esté escribiendo, el campo enseña lo que hay de verdad.
  useEffect(() => {
    if (!mandando) setBorrador(valor === undefined || valor === null ? '' : String(valor));
    // `valor` cambia con cada lectura; `mandando` evita pisar lo que se teclea.
  }, [valor, mandando]);

  const mandar = useCallback(
    async (nuevo: unknown) => {
      setMandando(true);
      try {
        await escribir([{ plc_id: PLC_INTERNO, tag: v.nombre, valor: nuevo }]);
        onError('');
      } catch (e: any) {
        onError(`${v.nombre}: ${e?.message ?? 'no se pudo forzar.'}`);
      } finally {
        setMandando(false);
      }
    },
    [v.nombre, onError]
  );

  if (!hay) {
    return (
      <span className="text-[11px] italic text-slate-400">sin lectura…</span>);

  }

  if (v.tipo === 'bool') {
    const on = valor === true;
    return (
      <button
        onClick={() => void mandar(!on)}
        disabled={mandando}
        className={`w-20 rounded-full px-2 py-1 text-[11px] font-bold transition ${
        on ?
        'bg-state-ok text-white' :
        'bg-slate-200 text-slate-500 dark:bg-navy-slate dark:text-slate-400'}`
        }>

        {on ? 'SÍ' : 'NO'}
      </button>);

  }

  return (
    <div className="flex items-center gap-1.5">
      <input
        value={borrador}
        onChange={(e) => setBorrador(e.target.value)}
        onFocus={() => setMandando(true)}
        onBlur={() => setMandando(false)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            const t = borrador.trim().replace(',', '.');
            void mandar(v.tipo === 'string' ? borrador : Number(t));
            e.currentTarget.blur();
          }
          if (e.key === 'Escape') e.currentTarget.blur();
        }}
        className={`${CAMPO} w-28 tabular-nums`}
        inputMode={v.tipo === 'string' ? 'text' : 'decimal'} />

      <span className="text-[10px] text-slate-400">Enter</span>
    </div>);

}

export function PanelInternas() {
  const [lista, setLista] = useState<VariableInterna[]>([]);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState('');
  const [aviso, setAviso] = useState('');

  const [nombre, setNombre] = useState('');
  const [tipo, setTipo] = useState<TipoInterna>('bool');
  const [descripcion, setDescripcion] = useState('');

  const recargar = useCallback(async () => {
    try {
      setLista(await listarInternas());
      setError('');
    } catch (e: any) {
      setError(e?.message ?? 'No se pudieron leer las variables internas.');
    } finally {
      setCargando(false);
    }
  }, []);

  useEffect(() => {
    void recargar();
  }, [recargar]);

  const crear = async () => {
    const n = nombre.trim();
    if (!n) return;
    try {
      await crearInterna(n, tipo, undefined, descripcion.trim());
      setNombre('');
      setDescripcion('');
      setAviso('');
      await recargar();
    } catch (e: any) {
      setAviso(e?.message ?? 'No se pudo crear.');
    }
  };

  const quitar = async (v: VariableInterna) => {
    // Se pregunta porque los widgets enlazados a ella se quedan sin lectura y
    // no hay forma de saber cuántos son sin recorrer todo el proyecto.
    if (!window.confirm(
      `¿Quitar «${v.nombre}»?\n\nLos widgets que la tengan enlazada se ` +
      `quedarán sin lectura y pintarán «—».`)) return;
    try {
      await borrarInterna(v.nombre);
      await recargar();
    } catch (e: any) {
      setAviso(e?.message ?? 'No se pudo quitar.');
    }
  };

  const ordenadas = useMemo(
    () => [...lista].sort((a, b) => a.nombre.localeCompare(b.nombre)),
    [lista]
  );

  return (
    <div className="flex h-full flex-col overflow-hidden bg-slate-100 dark:bg-navy">
      {/* ── Cabecera ───────────────────────────────────────────── */}
      <div className="shrink-0 border-b border-slate-200 bg-white px-4 py-3 dark:border-navy-slate dark:bg-navy-soft">
        <div className="flex items-center gap-2">
          <VariableIcon className="h-4 w-4 text-siemens" />
          <h2 className="text-sm font-bold text-navy dark:text-slate-100">
            Variables internas
          </h2>
          <span className="text-xs text-slate-400">
            {ordenadas.length} definida{ordenadas.length === 1 ? '' : 's'}
          </span>
          <button
            onClick={() => void recargar()}
            title="Volver a leer la lista"
            className="ml-auto rounded-md p-1 text-slate-400 transition hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-navy-slate">

            <RefreshCwIcon className="h-3.5 w-3.5" />
          </button>
        </div>
        <p className="mt-1 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
          No existen en ningún PLC: viven en el servidor y las ven todos los
          paneles. Se enlazan a un widget como cualquier otra variable, y
          forzando su valor aquí se puede comprobar una animación sin tener el
          autómata delante.
        </p>
      </div>

      {/* ── Alta ───────────────────────────────────────────────── */}
      <div className="shrink-0 border-b border-slate-200 bg-white px-4 py-3 dark:border-navy-slate dark:bg-navy-soft">
        <div className="flex flex-wrap items-end gap-2">
          <label className="block">
            <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-slate-400">
              Nombre
            </span>
            <input
              value={nombre}
              onChange={(e) => setNombre(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void crear()}
              placeholder="modo_manual"
              spellCheck={false}
              className={`${CAMPO} w-48`} />

          </label>
          <label className="block">
            <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-slate-400">
              Tipo
            </span>
            <select
              value={tipo}
              onChange={(e) => setTipo(e.target.value as TipoInterna)}
              className={`${CAMPO} w-32 cursor-pointer`}>

              {TIPOS.map((t) =>
              <option key={t.valor} value={t.valor}>
                  {t.label}
                </option>
              )}
            </select>
          </label>
          <label className="block flex-1">
            <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-slate-400">
              Descripción
            </span>
            <input
              value={descripcion}
              onChange={(e) => setDescripcion(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void crear()}
              placeholder="Para qué sirve"
              className={`${CAMPO} min-w-[12rem]`} />

          </label>
          <button
            onClick={() => void crear()}
            disabled={!nombre.trim()}
            className="flex items-center gap-1.5 rounded-lg bg-siemens px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-siemens-600 disabled:opacity-40">

            <PlusIcon className="h-3.5 w-3.5" />
            Crear
          </button>
        </div>

        {!!aviso &&
        <div className="mt-2 flex items-start gap-1.5 rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-2 text-[11px] leading-relaxed text-amber-700 dark:border-amber-500/20 dark:bg-amber-500/5 dark:text-amber-400">
            <AlertTriangleIcon className="mt-px h-3.5 w-3.5 shrink-0" />
            <span className="min-w-0">{aviso}</span>
          </div>
        }
      </div>

      {/* ── Tabla ──────────────────────────────────────────────── */}
      <div className="flex-1 overflow-auto p-4">
        {cargando ?
        <p className="text-xs text-slate-400">Cargando…</p> :
        error ?
        <p className="text-xs text-red-500">{error}</p> :
        ordenadas.length === 0 ?
        <div className="rounded-xl border border-dashed border-slate-300 p-8 text-center dark:border-navy-slate">
            <p className="text-sm font-medium text-slate-500 dark:text-slate-300">
              Todavía no hay ninguna variable interna.
            </p>
            <p className="mt-1 text-xs text-slate-400">
              Crea una arriba y enlázala a un widget desde el Inspector: saldrá
              en el desplegable como <code>interno|&lt;nombre&gt;</code>.
            </p>
          </div> :

        <table className="w-full border-separate border-spacing-y-1 text-left">
            <thead>
              <tr className="text-[10px] uppercase tracking-wide text-slate-400">
                <th className="px-3 py-1 font-semibold">Nombre</th>
                <th className="px-3 py-1 font-semibold">Tipo</th>
                <th className="px-3 py-1 font-semibold">Descripción</th>
                <th className="px-3 py-1 font-semibold">Valor ahora</th>
                <th className="px-3 py-1" />
              </tr>
            </thead>
            <tbody>
              {ordenadas.map((v) =>
            <tr
              key={v.nombre}
              className="bg-white shadow-sm dark:bg-navy-soft">

                  <td className="rounded-l-lg px-3 py-2">
                    <code className="text-xs font-semibold text-navy dark:text-slate-100">
                      {v.nombre}
                    </code>
                    <span className="ml-2 text-[10px] text-slate-400">
                      {idDeInterna(v.nombre)}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-xs text-slate-500 dark:text-slate-400">
                    {TIPOS.find((t) => t.valor === v.tipo)?.label ?? v.tipo}
                  </td>
                  <td className="px-3 py-2 text-xs text-slate-500 dark:text-slate-400">
                    {v.descripcion || <span className="text-slate-300">—</span>}
                  </td>
                  <td className="px-3 py-2">
                    <Forzar v={v} onError={setAviso} />
                  </td>
                  <td className="rounded-r-lg px-3 py-2 text-right">
                    <button
                  onClick={() => void quitar(v)}
                  title="Quitar esta variable"
                  className="rounded p-1 text-slate-400 transition hover:bg-red-50 hover:text-red-500 dark:hover:bg-red-500/10">

                      <Trash2Icon className="h-3.5 w-3.5" />
                    </button>
                  </td>
                </tr>
            )}
            </tbody>
          </table>
        }
      </div>
    </div>);

}
