// =========================================================================
// SelectorBaseRecetas.tsx
// "Guardar en": en qué base de datos viven las cuatro tablas de recetas.
//
// POR QUÉ NO ES UN <select> NATIVO
//
//   Porque el navegador pinta la lista desplegable con SU tema, no con el de
//   la página. En modo oscuro salía un panel blanco con el texto casi
//   ilegible, y no hay CSS que lo arregle: esa lista la dibuja el sistema
//   operativo. Un control propio cuesta cincuenta líneas y se ve igual en los
//   dos temas.
//
//   De paso caben cosas que un <option> no admite: el punto de estado, el
//   motor, y el nombre de la base en una segunda línea. Con una conexión
//   local y otra en el servidor, "¿cuál es cuál?" se responde de un vistazo.
//
// LO QUE NO ES
//
//   No es la base con la que se inició sesión (esa la elige el login), ni la
//   ruta `Path` de la receta (esa es la carpeta del panel HMI, como en TIA).
//   Es dónde se guardan ESTAS tablas, y vale para toda la pantalla: una fila
//   no puede apuntar a una base distinta de aquella en la que está.
// =========================================================================
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { CheckIcon, ChevronDownIcon, DatabaseIcon } from 'lucide-react';
import type { BaseDatos } from '../../services/authApi';

export function SelectorBaseRecetas({
  valor,
  bases,
  deshabilitado,
  onCambiar,
}: {
  valor: string;
  bases: BaseDatos[];
  deshabilitado: boolean;
  onCambiar: (v: string) => void;
}) {
  const [abierto, setAbierto] = useState(false);
  const [resaltado, setResaltado] = useState(0);
  const caja = useRef<HTMLDivElement | null>(null);

  const actual = useMemo(
    () => bases.find((b) => b.db_id === valor),
    [bases, valor]
  );

  useEffect(() => {
    if (!abierto) return;
    const fuera = (e: MouseEvent) => {
      if (caja.current && !caja.current.contains(e.target as Node)) {
        setAbierto(false);
      }
    };
    const tecla = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setAbierto(false);
    };
    document.addEventListener('mousedown', fuera);
    document.addEventListener('keydown', tecla);
    return () => {
      document.removeEventListener('mousedown', fuera);
      document.removeEventListener('keydown', tecla);
    };
  }, [abierto]);

  const abrir = () => {
    if (deshabilitado) return;
    const i = bases.findIndex((b) => b.db_id === valor);
    setResaltado(i >= 0 ? i : 0);
    setAbierto(true);
  };

  const elegir = (dbId: string) => {
    setAbierto(false);
    if (dbId !== valor) onCambiar(dbId);
  };

  const teclas = (ev: React.KeyboardEvent) => {
    if (!abierto) {
      if (ev.key === 'ArrowDown' || ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault();
        abrir();
      }
      return;
    }
    if (bases.length === 0) return;
    if (ev.key === 'ArrowDown') {
      ev.preventDefault();
      setResaltado((i) => (i + 1) % bases.length);
    } else if (ev.key === 'ArrowUp') {
      ev.preventDefault();
      setResaltado((i) => (i - 1 + bases.length) % bases.length);
    } else if (ev.key === 'Enter') {
      ev.preventDefault();
      elegir(bases[Math.min(resaltado, bases.length - 1)].db_id);
    }
  };

  // Sin catálogo (backend caído, o ninguna conexión dada de alta) se enseña
  // igualmente contra cuál se está trabajando: quitar el dato sería peor que
  // enseñarlo sin poder cambiarlo.
  const soloLectura = bases.length === 0;

  return (
    <div ref={caja} className="relative">
      <button
        type="button"
        onClick={() => (abierto ? setAbierto(false) : abrir())}
        onKeyDown={teclas}
        disabled={deshabilitado || soloLectura}
        aria-haspopup="listbox"
        aria-expanded={abierto}
        aria-label="Base de datos donde se guardan las recetas"
        title="Base de datos donde viven las cuatro tablas de recetas"
        className={`group flex h-8 max-w-[300px] items-center gap-2 rounded-lg border px-2.5 text-[11px] outline-none transition focus-visible:ring-2 focus-visible:ring-siemens/40 disabled:cursor-not-allowed disabled:opacity-60 ${
          abierto
            ? 'border-siemens bg-white ring-2 ring-siemens/20 dark:bg-navy'
            : 'border-slate-200 bg-white hover:border-slate-300 dark:border-navy-slate dark:bg-navy-soft dark:hover:border-slate-600'
        }`}
      >
        <DatabaseIcon className="h-3.5 w-3.5 shrink-0 text-slate-400" />
        <span className="shrink-0 text-slate-400">Guardar en</span>
        <span className="min-w-0 flex-1 truncate text-left font-semibold text-navy dark:text-slate-100">
          {actual?.nombre ?? valor ?? '—'}
        </span>
        {actual && <Punto vivo={!!actual.conectado} />}
        {!soloLectura && (
          <ChevronDownIcon
            className={`h-3.5 w-3.5 shrink-0 text-slate-400 transition-transform ${
              abierto ? 'rotate-180' : ''
            }`}
          />
        )}
      </button>

      {abierto && !soloLectura && (
        <div
          role="listbox"
          className="absolute left-0 top-full z-40 mt-1.5 w-[320px] max-w-[85vw] overflow-hidden rounded-xl border border-slate-200 bg-white shadow-xl dark:border-navy-slate dark:bg-navy-soft"
        >
          <p className="border-b border-slate-100 px-3 py-2 text-[10px] font-bold uppercase tracking-wider text-slate-400 dark:border-navy-slate/70">
            Guardar las recetas en
          </p>

          <ul className="max-h-64 overflow-auto p-1">
            {bases.map((b, i) => {
              const puesta = b.db_id === valor;
              const activa = i === resaltado;
              return (
                <li key={b.db_id}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={puesta}
                    onMouseEnter={() => setResaltado(i)}
                    onClick={() => elegir(b.db_id)}
                    className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition ${
                      activa
                        ? 'bg-siemens-50 dark:bg-siemens/15'
                        : 'hover:bg-slate-50 dark:hover:bg-navy/50'
                    }`}
                  >
                    <Punto vivo={!!b.conectado} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-xs font-semibold text-navy dark:text-slate-100">
                        {b.nombre}
                      </span>
                      <span className="block truncate text-[10px] text-slate-400">
                        {[b.etiqueta_motor || b.motor, b.base_datos]
                          .filter(Boolean)
                          .join(' · ') || b.db_id}
                        {b.conectado ? '' : ' · sin conexión'}
                      </span>
                    </span>
                    {puesta && (
                      <CheckIcon className="h-4 w-4 shrink-0 text-siemens" />
                    )}
                  </button>
                </li>
              );
            })}
          </ul>

          {/* La frase que evita la pregunta más probable. `Path` es la
              carpeta del panel, como en TIA; esto es otra cosa. */}
          <p className="border-t border-slate-100 px-3 py-2 text-[10px] leading-relaxed text-slate-400 dark:border-navy-slate/70">
            Cambia dónde se leen y se guardan recetas, elementos, registros y
            valores. No es la columna <span className="font-mono">Path</span>,
            que es la carpeta del panel HMI.
          </p>
        </div>
      )}
    </div>
  );
}

/** Punto de estado. El color dice si esa conexión responde ahora mismo. */
function Punto({ vivo }: { vivo: boolean }) {
  return (
    <span
      aria-hidden="true"
      title={vivo ? 'Responde' : 'Sin conexión'}
      className={`h-2 w-2 shrink-0 rounded-full ${
        vivo ? 'bg-state-ok' : 'bg-state-error'
      }`}
    />
  );
}
