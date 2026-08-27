// =========================================================================
// SelectorTagPlc.tsx
// La celda "Tag" de un elemento de receta: escribir o elegir de la lista.
//
// POR QUÉ NO ES UN <select>
//
//   Un desplegable cerrado obligaría a que el tag EXISTA ya en la lista, y
//   esa lista solo se llena tras un browse OPC UA correcto. Configurar las
//   recetas con el PLC apagado —que es lo normal en oficina— sería imposible.
//   Así que es un campo de texto con ayuda: se puede teclear cualquier cosa,
//   y si hay tags descubiertos se ofrecen filtrados mientras escribes.
//
// EL FORMATO ES `plc_id|tag`
//
//   El mismo que usa el WebSocket, el historizador y `plc_prg`. No se inventa
//   aquí: `claveTag()` lo arma igual que el backend en `on_mensaje()`. Si se
//   escribiera solo el nombre del tag, dos PLCs con un "Temperatura" cada uno
//   serían indistinguibles el día que haya dos.
//
// LO QUE SE VE DE CADA TAG
//
//   El PLC, el Data Block (o el POU en Rexroth), el tipo OPC y el ÚLTIMO
//   VALOR recibido. El valor es lo que confirma que es el tag correcto: dos
//   tags con nombres parecidos se distinguen mirando cuál marca 23.7.
// =========================================================================
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { CheckIcon, TagIcon, TriangleAlertIcon } from 'lucide-react';
import { claveTag, type TagRemoto } from '../flows/api';

/**
 * Tipo OPC UA -> tipo de TIA, para rellenar "Data type" al elegir un tag.
 *
 * Solo se aplica cuando el elemento NO tiene tipo todavía: si alguien lo
 * eligió a mano, manda esa elección. Y solo con los que tienen equivalente
 * claro — inventar el tipo de un tag es peor que dejarlo en blanco, porque
 * decide cuántos bytes se le mandan a una máquina.
 */
export const TIPO_OPC_A_TIA: Record<string, string> = {
  Boolean: 'Bool',
  Bool: 'Bool',
  SByte: 'Byte',
  Byte: 'Byte',
  Int16: 'Int',
  UInt16: 'UInt',
  Int32: 'DInt',
  UInt32: 'UDInt',
  Float: 'Real',
  Double: 'LReal',
  LReal: 'LReal',
  Real: 'Real',
  String: 'String',
};

/** Alto máximo de la lista. Se usa también para decidir si cabe debajo. */
const ALTO_LISTA = 288;

function resumirValor(v: any): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  const t = String(v);
  return t.length > 14 ? `${t.slice(0, 13)}…` : t;
}

export function SelectorTagPlc({
  valor,
  onElegir,
  tags,
  cargando,
  sinPlcs,
}: {
  valor: string;
  /** `tag` siempre; `tipo` solo cuando se eligió de la lista y se conoce. */
  onElegir: (tag: string, tipoTia?: string) => void;
  tags: TagRemoto[];
  cargando: boolean;
  /** No hay ningún PLC dado de alta (distinto de "hay, pero sin conectar"). */
  sinPlcs: boolean;
}) {
  const [abierto, setAbierto] = useState(false);
  const [resaltado, setResaltado] = useState(0);
  // La lista se abre hacia ARRIBA cuando no cabe debajo. La tabla vive dentro
  // de un contenedor con scroll, así que en las últimas filas una lista fija
  // hacia abajo queda cortada por el borde y no se puede llegar a ella.
  const [haciaArriba, setHaciaArriba] = useState(false);
  const caja = useRef<HTMLDivElement | null>(null);

  // Cerrar al hacer clic fuera. Sin esto la lista se queda flotando sobre la
  // tabla mientras editas otra fila.
  useEffect(() => {
    if (!abierto) return;
    const fuera = (e: MouseEvent) => {
      if (caja.current && !caja.current.contains(e.target as Node)) {
        setAbierto(false);
      }
    };
    document.addEventListener('mousedown', fuera);
    return () => document.removeEventListener('mousedown', fuera);
  }, [abierto]);

  // Se filtra por PLC y por tag a la vez: escribir "temp" encuentra el tag,
  // escribir "PLC_2" acota al equipo.
  const sugerencias = useMemo(() => {
    const t = valor.trim().toLowerCase();
    const lista = t
      ? tags.filter((x) => `${x.plc}|${x.tag}`.toLowerCase().includes(t))
      : tags;
    return lista.slice(0, 60);
  }, [tags, valor]);

  const abrir = () => {
    const r = caja.current?.getBoundingClientRect();
    if (r) setHaciaArriba(window.innerHeight - r.bottom < ALTO_LISTA + 24);
    setAbierto(true);
  };

  const elegir = (t: TagRemoto) => {
    onElegir(claveTag(t), TIPO_OPC_A_TIA[String(t.type ?? '')] || undefined);
    setAbierto(false);
  };

  const teclas = (ev: React.KeyboardEvent<HTMLInputElement>) => {
    if (ev.key === 'Escape') {
      setAbierto(false);
      return;
    }
    if (!abierto && (ev.key === 'ArrowDown' || ev.key === 'ArrowUp')) {
      abrir();
      return;
    }
    if (!abierto || sugerencias.length === 0) return;
    if (ev.key === 'ArrowDown') {
      ev.preventDefault();
      setResaltado((i) => (i + 1) % sugerencias.length);
    } else if (ev.key === 'ArrowUp') {
      ev.preventDefault();
      setResaltado((i) => (i - 1 + sugerencias.length) % sugerencias.length);
    } else if (ev.key === 'Enter') {
      ev.preventDefault();
      elegir(sugerencias[Math.min(resaltado, sugerencias.length - 1)]);
    }
  };

  const puesto = !!valor.trim();
  const conocido = puesto && tags.some((t) => claveTag(t) === valor.trim());

  return (
    <div ref={caja} className="relative">
      <TagIcon
        className={`pointer-events-none absolute left-2.5 top-1/2 z-10 h-3 w-3 -translate-y-1/2 ${
          puesto ? 'text-siemens' : 'text-slate-400'
        }`}
      />
      <input
        type="text"
        value={valor}
        onChange={(e) => {
          onElegir(e.target.value);
          setResaltado(0);
          abrir();
        }}
        onFocus={abrir}
        onKeyDown={teclas}
        placeholder="<None>"
        aria-label="Tag del PLC"
        aria-expanded={abierto}
        title={
          puesto && !conocido
            ? 'Ese tag no está entre los descubiertos ahora mismo. No es un ' +
              'error: puede que el PLC esté apagado o que aún no se haya ' +
              'hecho el browse.'
            : 'Escribe o elige de la lista. Formato: plc_id|tag'
        }
        className={`w-full rounded-md border border-transparent bg-transparent py-1.5 pl-7 pr-2.5 font-mono text-xs text-navy outline-none transition placeholder:text-slate-300 hover:border-slate-200 hover:bg-white focus:border-siemens focus:bg-white focus:ring-2 focus:ring-siemens/20 dark:text-slate-100 dark:placeholder:text-slate-600 dark:hover:border-navy-slate dark:hover:bg-navy dark:focus:bg-navy`}
      />

      {abierto && (
        <div
          style={{ maxHeight: ALTO_LISTA }}
          className={`absolute left-0 z-30 w-[420px] max-w-[80vw] overflow-auto rounded-lg border border-slate-200 bg-white p-1 shadow-lg dark:border-navy-slate dark:bg-navy-soft ${
            haciaArriba ? 'bottom-full mb-1' : 'top-full mt-1'
          }`}
        >
          {cargando ? (
            <p className="px-3 py-3 text-[11px] text-slate-400">
              Buscando tags en los PLCs…
            </p>
          ) : tags.length === 0 ? (
            // Distinguir los dos motivos importa: uno se arregla dando de
            // alta un PLC y el otro encendiéndolo.
            <p className="flex items-start gap-2 px-3 py-3 text-[11px] leading-relaxed text-slate-400">
              <TriangleAlertIcon className="mt-px h-3 w-3 shrink-0 text-amber-500" />
              <span>
                {sinPlcs
                  ? 'No hay ningún PLC dado de alta. Añádelo en el Diseñador y sus variables aparecerán aquí.'
                  : 'Hay PLCs configurados pero ninguno ha conectado todavía: la lista se llena tras el browse OPC UA. Mientras tanto puedes escribir el tag a mano.'}
              </span>
            </p>
          ) : sugerencias.length === 0 ? (
            <p className="px-3 py-3 text-[11px] text-slate-400">
              Ningún tag contiene «{valor.trim()}». Se guardará tal cual lo
              escribas.
            </p>
          ) : (
            <ul role="listbox">
              {sugerencias.map((t, i) => {
                const clave = claveTag(t);
                const activo = i === resaltado;
                const puesta = clave === valor.trim();
                return (
                  <li key={clave}>
                    <button
                      type="button"
                      role="option"
                      aria-selected={puesta}
                      // `onMouseDown` y no `onClick`: el blur del input se
                      // dispara antes que el click y cerraría la lista sin
                      // llegar a elegir nada.
                      onMouseDown={(ev) => {
                        ev.preventDefault();
                        elegir(t);
                      }}
                      onMouseEnter={() => setResaltado(i)}
                      className={`flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left transition ${
                        activo
                          ? 'bg-siemens-50 dark:bg-siemens/15'
                          : 'hover:bg-slate-50 dark:hover:bg-navy/50'
                      }`}
                    >
                      <span className="w-4 shrink-0 text-siemens">
                        {puesta && <CheckIcon className="h-3.5 w-3.5" />}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-mono text-[11px] text-navy dark:text-slate-100">
                          {t.tag}
                        </span>
                        <span className="block truncate text-[10px] text-slate-400">
                          {t.plc}
                          {t.db ? ` · ${t.db}` : ''}
                          {t.type ? ` · ${t.type}` : ''}
                        </span>
                      </span>
                      {/* El último valor recibido: es lo que confirma que es
                          el tag correcto cuando hay varios parecidos. */}
                      <span className="shrink-0 font-mono text-[10px] tabular-nums text-slate-400">
                        {resumirValor(t.value)}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
