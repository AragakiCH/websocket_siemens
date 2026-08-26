// =========================================================================
// TableBits.tsx
// Piezas compartidas por las tablas de configuración (Alarmas, Recetas).
//
// Nacieron dentro de AlarmsEditor y se sacaron acá al aparecer la segunda
// tabla: dos copias del mismo input se van separando sola con el tiempo, y
// terminas con dos tablas que se ven casi igual pero no del todo.
//
// El estilo imita el editor de TIA Portal: celdas sin borde en reposo, para
// que se lea como una tabla y no como un muro de inputs; el borde aparece al
// pasar por encima o al enfocar, que es cuando hace falta saber dónde estás
// escribiendo.
// =========================================================================
import React from 'react';
import { ChevronDownIcon } from 'lucide-react';

/**
 * Encabezado de columna.
 *
 * `children` es opcional porque la columna de acciones (duplicar, eliminar)
 * no lleva título: solo reserva su ancho.
 */
export function Th({
  children,
  className = '',
}: {
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <th
      scope="col"
      className={`whitespace-nowrap border-b border-slate-200 px-3 py-2 text-left text-[10px] font-bold uppercase tracking-wider text-slate-400 dark:border-navy-slate ${className}`}
    >
      {children}
    </th>
  );
}

const CELDA_BASE =
  'w-full rounded-md border border-transparent bg-transparent px-2.5 py-1.5 text-xs outline-none transition placeholder:text-slate-300 dark:placeholder:text-slate-600';

const CELDA_EDITABLE =
  'text-navy hover:border-slate-200 hover:bg-white focus:border-siemens focus:bg-white focus:ring-2 focus:ring-siemens/20 dark:text-slate-100 dark:hover:border-navy-slate dark:hover:bg-navy dark:focus:bg-navy';

/**
 * Celda no editable por falta de configuración.
 *
 * El rosa es el mismo código visual de TIA: "acá no puedes escribir todavía
 * porque falta algo antes". Va con `title` explicando qué falta — un color
 * sin explicación solo genera dudas.
 */
const CELDA_BLOQUEADA =
  'cursor-not-allowed bg-pink-100 text-pink-400 dark:bg-pink-500/15 dark:text-pink-300/50';

/** Celda de texto editable. */
export function Celda({
  value,
  onChange,
  placeholder,
  className = '',
  bloqueada,
  title,
  numerica,
  autoFocus,
  onFocus,
  ...resto
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  className?: string;
  /** Pinta la celda de rosa y la vuelve de solo lectura. */
  bloqueada?: boolean;
  title?: string;
  /** Alinea a la derecha y usa cifras de ancho fijo. */
  numerica?: boolean;
  autoFocus?: boolean;
  onFocus?: () => void;
} & React.AriaAttributes) {
  return (
    <input
      type="text"
      value={value}
      title={title}
      readOnly={bloqueada}
      autoFocus={autoFocus}
      onFocus={onFocus}
      onChange={(e) => !bloqueada && onChange(e.target.value)}
      placeholder={bloqueada ? '' : placeholder}
      className={`${CELDA_BASE} ${bloqueada ? CELDA_BLOQUEADA : CELDA_EDITABLE} ${
        numerica ? 'text-right tabular-nums' : ''
      } ${className}`}
      {...resto}
    />
  );
}

/** Celda de solo lectura: un valor que calcula el sistema, no el usuario. */
export function CeldaLectura({
  children,
  title,
  className = '',
}: {
  children: React.ReactNode;
  title?: string;
  className?: string;
}) {
  return (
    <span
      title={title}
      className={`block px-2.5 py-1.5 text-xs text-slate-400 ${className}`}
    >
      {children}
    </span>
  );
}

/**
 * Desplegable de celda.
 *
 * SIN fondo de color a propósito: el <select> le pasa su fondo a la lista
 * desplegable nativa, y un fondo claro con el texto claro del modo oscuro
 * dejaba las opciones ilegibles.
 */
export function CeldaSelect({
  value,
  onChange,
  opciones,
  className = '',
  ...resto
}: {
  value: string;
  onChange: (v: string) => void;
  opciones: readonly string[];
  className?: string;
} & React.AriaAttributes) {
  return (
    <div className="relative">
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={`${CELDA_BASE} ${CELDA_EDITABLE} cursor-pointer appearance-none pr-7 font-medium ${className}`}
        {...resto}
      >
        {opciones.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
      <ChevronDownIcon
        aria-hidden="true"
        className="pointer-events-none absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400"
      />
    </div>
  );
}

/** Casilla centrada dentro de una celda. */
export function CeldaCheck({
  checked,
  onChange,
  ...resto
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
} & React.AriaAttributes) {
  return (
    <div className="flex justify-center py-1.5">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="h-4 w-4 cursor-pointer rounded border-slate-300 text-siemens focus:ring-2 focus:ring-siemens/40 dark:border-navy-slate dark:bg-navy"
        {...resto}
      />
    </div>
  );
}

/** Botón de acción de fila (duplicar, eliminar…). */
export function IconoBoton({
  onClick,
  titulo,
  className = '',
  children,
}: {
  onClick: () => void;
  titulo: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={titulo}
      aria-label={titulo}
      className={`flex h-7 w-7 items-center justify-center rounded-md text-slate-400 outline-none transition focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-siemens/40 ${className}`}
    >
      {children}
    </button>
  );
}

/** Contenedor de las acciones: aparecen al pasar por encima de la fila. */
export function AccionesFila({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
      {children}
    </div>
  );
}
