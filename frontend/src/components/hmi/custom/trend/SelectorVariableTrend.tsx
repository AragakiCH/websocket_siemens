// =========================================================================
// trend/SelectorVariableTrend.tsx
// La variable de UNA serie del Trend, con buscador.
//
// POR QUÉ NO ES UN <select>
// El desplegable nativo enseñaba TODAS las numéricas de Controladores, sin
// filtro. Con un PLC de cientos de tags, encontrar `rSetPoint_L3` era bajar a
// ojo por la lista. Aquí se escribe y se filtra mientras se teclea.
//
// POR QUÉ NO ES EL `SelectorTagPlc` DE RECETAS
// Ese trabaja con OTRA lista —los tags del browse OPC UA (`/tags`)— y deja
// teclear texto libre, porque una receta se configura con el PLC apagado. El
// Trend dibuja lo que llega por WebSocket: sus candidatas son las variables
// del store, y una serie con un id que no existe no dibujaría nada. Por eso
// aquí solo se ELIGE de la lista, no se teclea un id.
//
// LO QUE SE VE DE CADA VARIABLE
// El nombre, el tipo y de qué autómata es (Siemens / Rexroth / Interna). Con
// dos PLCs que tienen un `Temperatura` cada uno, la marca es lo único que los
// distingue.
//
// SE DESPLIEGA EN LÍNEA, NO FLOTANDO
// El Inspector es una columna con scroll propio. Una lista flotante
// (`position: absolute`) se recortaba contra el borde de abajo en las últimas
// series, justo donde más se usa. Abierta en línea empuja lo de abajo y se ve
// entera siempre.
// =========================================================================
import { useEffect, useMemo, useRef, useState } from 'react';
import { CheckIcon, ChevronDownIcon, SearchIcon } from 'lucide-react';
import { useAppStore } from '../../../../context/AppStore';
import { etiquetaVendor, type PlcVariable } from '../../../../models/plc';
import { partirId } from '../../../../services/escrituraApi';

const INPUT =
  'w-full rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs ' +
  'text-navy outline-none transition focus:border-siemens focus:ring-2 ' +
  'focus:ring-siemens/20 dark:border-navy-slate dark:bg-navy dark:text-slate-100';

/**
 * Cuántas filas se pintan como mucho. Con miles de tags, pintarlas todas en
 * cada tecla se nota; nadie elige mirando la fila 900 — se afina la búsqueda.
 */
const MAX_FILAS = 150;

export function SelectorVariableTrend({
  valor,
  opciones,
  delGrupo,
  enUso,
  onElegir,
}: {
  /** `variableId` actual de la serie (`plc|tag`), o vacío. */
  valor: string;
  /** Las numéricas de Controladores. */
  opciones: PlcVariable[];
  /** Las que guarda el grupo del historizador; `null` = el grupo no filtra. */
  delGrupo: PlcVariable[] | null;
  /** Ids que ya usan OTRAS series de este Trend. */
  enUso: Set<string>;
  onElegir: (variableId: string) => void;
}) {
  const { plcs } = useAppStore();
  const [abierto, setAbierto] = useState(false);
  const [busca, setBusca] = useState('');
  const [soloGrupo, setSoloGrupo] = useState(true);
  const [activa, setActiva] = useState(0);
  const caja = useRef<HTMLDivElement | null>(null);
  const lista = useRef<HTMLDivElement | null>(null);

  const actual = opciones.find((v) => v.id === valor);

  /** «Siemens», «Rexroth», «Interna»… o el plc_id si aún no hay ficha. */
  const origenDe = (id: string): string => {
    const { plc_id } = partirId(id);
    if (!plc_id) return '';
    const info = plcs[plc_id];
    if (info?.interno) return 'Interna';
    return etiquetaVendor(info?.vendor ?? '') || plc_id;
  };

  const base = delGrupo && soloGrupo ? delGrupo : opciones;
  const q = busca.trim().toLowerCase();
  const filtradas = useMemo(
    () =>
      q
        ? base.filter(
            (v) =>
              v.name.toLowerCase().includes(q) ||
              v.id.toLowerCase().includes(q) ||
              origenDe(v.id).toLowerCase().includes(q)
          )
        : base,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [base, q, plcs]
  );
  const vistas = filtradas.slice(0, MAX_FILAS);

  // Al abrir: la búsqueda limpia y la fila activa en la variable puesta.
  const abrir = () => {
    setBusca('');
    const i = base.findIndex((v) => v.id === valor);
    setActiva(i >= 0 && i < MAX_FILAS ? i : 0);
    setAbierto(true);
  };
  const cerrar = () => setAbierto(false);
  const elegir = (id: string) => {
    onElegir(id);
    setAbierto(false);
  };

  // Cerrar al pulsar fuera.
  useEffect(() => {
    if (!abierto) return;
    const fuera = (e: MouseEvent) => {
      if (caja.current && !caja.current.contains(e.target as Node)) setAbierto(false);
    };
    document.addEventListener('mousedown', fuera);
    return () => document.removeEventListener('mousedown', fuera);
  }, [abierto]);

  // Al escribir, la activa vuelve arriba; nunca fuera de lo que se ve.
  useEffect(() => {
    setActiva((i) => (i >= vistas.length ? Math.max(0, vistas.length - 1) : i));
  }, [vistas.length]);
  useEffect(() => setActiva(0), [q, soloGrupo]);

  // La activa siempre a la vista, al moverse con las flechas.
  useEffect(() => {
    if (!abierto) return;
    const el = lista.current?.querySelector<HTMLElement>(`[data-i="${activa}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [activa, abierto]);

  const teclas = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiva((i) => Math.min(vistas.length - 1, i + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiva((i) => Math.max(0, i - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const v = vistas[activa];
      if (v) elegir(v.id);
    } else if (e.key === 'Escape') {
      // Solo cierra la lista: que el Escape no llegue a deseleccionar el
      // widget en el lienzo, que es lo que haría si siguiera subiendo.
      e.preventDefault();
      e.stopPropagation();
      cerrar();
    }
  };

  return (
    <div ref={caja}>
      <button
        type="button"
        onClick={() => (abierto ? cerrar() : abrir())}
        title={actual ? `${actual.name} · ${actual.type} · ${origenDe(actual.id)}` : valor || undefined}
        className={`${INPUT} flex items-center gap-1.5 text-left ${
          abierto ? 'border-siemens ring-2 ring-siemens/20' : ''
        }`}
      >
        <span className="min-w-0 flex-1 truncate">
          {actual ? (
            <>
              {actual.name}{' '}
              <span className="text-slate-400">({actual.type})</span>
            </>
          ) : valor ? (
            // Una variable que ya no está entre las seleccionadas de
            // Controladores: no se borra sola, se enseña marcada.
            <span className="text-amber-600 dark:text-amber-400">
              {partirId(valor).tag || valor} · no está en Controladores
            </span>
          ) : (
            <span className="text-slate-400">— Elegir variable —</span>
          )}
        </span>
        <ChevronDownIcon
          className={`h-3.5 w-3.5 shrink-0 text-slate-400 transition-transform ${
            abierto ? 'rotate-180' : ''
          }`}
        />
      </button>

      {abierto && (
        <div className="mt-1 rounded-lg border border-siemens/40 bg-white p-1.5 shadow-sm dark:bg-navy">
          {delGrupo && (
            <div className="mb-1.5 flex gap-0.5 rounded-md bg-slate-100 p-0.5 dark:bg-navy-slate/40">
              {[
                { v: true, t: `Del grupo (${delGrupo.length})` },
                { v: false, t: `Todas (${opciones.length})` },
              ].map((o) => (
                <button
                  key={String(o.v)}
                  type="button"
                  onClick={() => setSoloGrupo(o.v)}
                  className={`flex-1 rounded px-1.5 py-0.5 text-[10px] font-semibold transition ${
                    soloGrupo === o.v
                      ? 'bg-white text-siemens shadow-sm dark:bg-navy-slate'
                      : 'text-slate-500 hover:text-slate-700 dark:text-slate-400'
                  }`}
                >
                  {o.t}
                </button>
              ))}
            </div>
          )}

          <div className="relative">
            <SearchIcon className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
            <input
              autoFocus
              value={busca}
              onChange={(e) => setBusca(e.target.value)}
              onKeyDown={teclas}
              placeholder="Buscar tag…"
              className={`${INPUT} pl-7`}
            />
          </div>

          <div
            ref={lista}
            role="listbox"
            className="mp-scroll mp-scroll-dark mt-1.5 max-h-56 overflow-y-auto"
          >
            {vistas.length === 0 ? (
              <p className="px-2 py-3 text-center text-[11px] text-slate-400">
                {base.length === 0
                  ? delGrupo && soloGrupo
                    ? 'El grupo no declara tags concretos.'
                    : 'No hay variables numéricas en Controladores.'
                  : 'Ninguna coincide con la búsqueda.'}
              </p>
            ) : (
              vistas.map((v, i) => {
                const puesta = v.id === valor;
                const repetida = !puesta && enUso.has(v.id);
                return (
                  <button
                    key={v.id}
                    type="button"
                    role="option"
                    aria-selected={puesta}
                    data-i={i}
                    onMouseEnter={() => setActiva(i)}
                    onClick={() => elegir(v.id)}
                    className={`flex w-full items-center gap-2 rounded-md px-2 py-1 text-left transition ${
                      i === activa ? 'bg-siemens/10' : 'hover:bg-slate-50 dark:hover:bg-navy-slate/40'
                    }`}
                  >
                    <span className="min-w-0 flex-1">
                      <span
                        className="block truncate font-mono text-[11px] text-slate-700 dark:text-slate-200"
                        title={v.name}
                      >
                        {v.name}
                      </span>
                      <span className="block truncate text-[10px] text-slate-400">
                        {v.type}
                        {origenDe(v.id) ? ` · ${origenDe(v.id)}` : ''}
                        {repetida ? ' · ya está en el gráfico' : ''}
                      </span>
                    </span>
                    {puesta && <CheckIcon className="h-3.5 w-3.5 shrink-0 text-siemens" />}
                  </button>
                );
              })
            )}
          </div>

          {filtradas.length > MAX_FILAS && (
            <p className="px-2 pt-1 text-[10px] text-slate-400">
              Y {filtradas.length - MAX_FILAS} más. Escribe más para afinar.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
