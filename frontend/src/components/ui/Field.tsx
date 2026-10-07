import React from 'react';
// Compact labeled control row used across the app (inspector, config, login).
const inputBase =
'w-full rounded-lg border border-slate-200 bg-white text-navy outline-none transition focus:border-siemens focus:ring-2 focus:ring-siemens/20 dark:border-navy-slate dark:bg-navy dark:text-slate-100 dark:placeholder-slate-500';
const labelBase =
'mb-1 block text-xs font-medium text-slate-500 dark:text-slate-400';
export function TextField({
  label,
  value,
  onChange,
  type = 'text',
  placeholder,
  icon







}: {label?: string;value: string;onChange: (v: string) => void;type?: string;placeholder?: string;icon?: React.ReactNode;}) {
  return (
    <label className="block">
      {label && <span className={labelBase}>{label}</span>}
      <div className="relative">
        {icon &&
        <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400">
            {icon}
          </span>
        }
        <input
          type={type}
          value={value}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
          className={`${inputBase} py-2 ${icon ? 'pl-10 pr-3' : 'px-3'} text-sm`} />
        
      </div>
    </label>);

}
export function NumberField({
  label,
  value,
  onChange,
  step = 1





}: {label: string;value: number;onChange: (v: number) => void;step?: number;}) {
  return (
    <label className="block">
      <span className={labelBase}>{label}</span>
      <input
        type="number"
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className={`${inputBase} px-3 py-2 text-sm`} />
      
    </label>);

}
export function SelectField<T extends string | number>({
  label,
  value,
  options,
  onChange








}: {label: string;value: T;options: {label: string;value: T;}[];onChange: (v: T) => void;}) {
  return (
    <label className="block">
      <span className={labelBase}>{label}</span>
      <select
        value={String(value)}
        onChange={(e) => {
          const raw = e.target.value;
          const match = options.find((o) => String(o.value) === raw);
          if (match) onChange(match.value);
        }}
        className={`${inputBase} px-3 py-2 text-sm`}>
        
        {options.map((o) =>
        <option key={String(o.value)} value={String(o.value)}>
            {o.label}
          </option>
        )}
      </select>
    </label>);

}

// ─── Buscar dentro de un desplegable ─────────────────────────────

type GrupoOpciones = {label: string;options: {label: string;value: string;}[];};

/** Minúsculas y sin tildes: «valvula» encuentra «Válvula». */
export function normalizarBusqueda(texto: string): string {
  return (texto ?? '').
  normalize('NFD').
  replace(/[\u0300-\u036f]/g, '').
  toLowerCase().
  trim();
}

/**
 * Los grupos de un desplegable, quedándose con lo que coincide.
 *
 * DOS OPCIONES NO SE FILTRAN NUNCA:
 *   * la de valor vacío («Ninguna»): tiene que poder elegirse siempre;
 *   * la que está PUESTA ahora: un <select> cuyo valor no está entre sus
 *     opciones enseña la primera, y parecería que el enlace se perdió por
 *     haber escrito en el buscador.
 *
 * Se puede escribir más de una palabra: «bvar 192» pide las dos.
 */
export function filtrarGrupos(
grupos: GrupoOpciones[],
texto: string,
valorActual: string)
: {grupos: GrupoOpciones[];coinciden: number;total: number;} {
  const palabras = normalizarBusqueda(texto).split(/\s+/).filter(Boolean);
  let coinciden = 0;
  let total = 0;
  const filtrados = grupos.map((g) => ({
    ...g,
    options: g.options.filter((o) => {
      if (o.value === '') return true;
      total += 1;
      const etiqueta = normalizarBusqueda(o.label);
      const casa = palabras.every((w) => etiqueta.includes(w));
      if (casa) coinciden += 1;
      return casa || o.value === valorActual;
    })
  }));
  return { grupos: palabras.length === 0 ? grupos : filtrados, coinciden, total };
}

/**
 * El campo de búsqueda que va ENCIMA de un desplegable de variables.
 *
 * Encima y no dentro: el desplegable es el nativo del navegador, que no
 * admite nada dentro, y con doscientas variables de un PLC bajar con la
 * rueda hasta `PLC_PRG.rVar87` no es manera.
 */
export function BuscadorOpciones({
  valor,
  onCambiar,
  coinciden,
  total,
  marcador = 'Buscar variable…',
  compacto



}: {valor: string;onCambiar: (v: string) => void;coinciden: number;total: number;marcador?: string;compacto?: boolean;}) {
  const buscando = valor.trim() !== '';
  return (
    <div className="relative mb-1.5">
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400">

        <circle cx="11" cy="11" r="7" />
        <path d="m21 21-4.3-4.3" />
      </svg>
      <input
        type="text"
        value={valor}
        placeholder={marcador}
        spellCheck={false}
        onChange={(e) => onCambiar(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onCambiar('');
        }}
        className={`${inputBase} ${compacto ? 'py-1 text-[11px]' : 'py-1.5 text-xs'} pl-8 ${
        buscando ? 'pr-[4.6rem]' : 'pr-2'}`
        } />

      {buscando &&
      <span className="absolute right-1.5 top-1/2 flex -translate-y-1/2 items-center gap-1">
          <span
          className={`text-[10px] tabular-nums ${
          coinciden === 0 ? 'font-semibold text-amber-500' : 'text-slate-400'}`
          }>

            {coinciden}/{total}
          </span>
          <button
          type="button"
          onClick={() => onCambiar('')}
          title="Limpiar la búsqueda"
          className="flex h-5 w-5 items-center justify-center rounded text-slate-400 transition hover:bg-slate-100 hover:text-navy dark:hover:bg-navy-slate dark:hover:text-slate-100">

            ×
          </button>
        </span>
      }
    </div>);

}

/**
 * Igual que SelectField pero con las opciones repartidas en <optgroup>.
 *
 * Existe para el enlace de variables del Inspector: hace falta separar las
 * compatibles de las que no lo son SIN sacar a estas últimas de la lista.
 * Un grupo vacío no se dibuja, así que cuando todas las variables calzan se
 * ve exactamente igual que un select normal.
 *
 * Con `buscable` lleva encima un campo para filtrar la lista. Sin él queda
 * exactamente como estaba.
 */
export function SelectGroupField({
  label,
  value,
  groups,
  onChange,
  buscable




}: {label: string;value: string;groups: GrupoOpciones[];onChange: (v: string) => void;buscable?: boolean;}) {
  const [busca, setBusca] = React.useState('');
  const filtro = filtrarGrupos(groups, buscable ? busca : '', value);

  const desplegable =
  <select
    value={value}
    onChange={(e) => onChange(e.target.value)}
    className={`${inputBase} px-3 py-2 text-sm`}>

      {filtro.grupos.map((g) => {
      if (g.options.length === 0) return null;
      const opciones = g.options.map((o) =>
      <option key={o.value} value={o.value}>
            {o.label}
          </option>
      );
      // Grupo sin título: opciones sueltas arriba de todo (el "Ninguna").
      if (!g.label) return <React.Fragment key="_sueltas">{opciones}</React.Fragment>;
      return (
        <optgroup key={g.label} label={g.label}>
            {opciones}
          </optgroup>);

    })}
    </select>;


  if (!buscable) {
    return (
      <label className="block">
        <span className={labelBase}>{label}</span>
        {desplegable}
      </label>);

  }

  // Con buscador NO va todo dentro de un <label>: pulsar el rótulo enfocaría
  // el primer control, que sería el buscador y no el desplegable.
  return (
    <div className="block">
      <span className={labelBase}>{label}</span>
      <BuscadorOpciones
        valor={busca}
        onCambiar={setBusca}
        coinciden={filtro.coinciden}
        total={filtro.total} />

      {desplegable}
    </div>);

}
export function ColorField({
  label,
  value,
  onChange




}: {label: string;value: string;onChange: (v: string) => void;}) {
  return (
    <label className="flex items-center justify-between gap-2">
      <span className="text-xs font-medium text-slate-500 dark:text-slate-400">
        {label}
      </span>
      <div className="flex items-center gap-2">
        <span className="font-mono text-[11px] text-slate-400">{value}</span>
        <input
          type="color"
          value={value.length === 7 ? value : '#009999'}
          onChange={(e) => onChange(e.target.value)}
          className="h-7 w-9 cursor-pointer rounded border border-slate-200 bg-white p-0.5 dark:border-navy-slate dark:bg-navy" />
        
      </div>
    </label>);

}
export function ToggleField({
  label,
  value,
  onChange




}: {label: string;value: boolean;onChange: (v: boolean) => void;}) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-xs font-medium text-slate-500 dark:text-slate-400">
        {label}
      </span>
      <button
        type="button"
        onClick={() => onChange(!value)}
        className={`relative h-5 w-9 rounded-full transition-colors ${value ? 'bg-siemens' : 'bg-slate-300 dark:bg-navy-slate'}`}>
        
        <span
          className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all ${value ? 'left-4' : 'left-0.5'}`} />
        
      </button>
    </div>);

}
export function SliderField({
  label,
  value,
  min,
  max,
  step = 1,
  onChange,
  suffix








}: {label: string;value: number;min: number;max: number;step?: number;onChange: (v: number) => void;suffix?: string;}) {
  return (
    <label className="block">
      <div className="mb-1 flex items-center justify-between">
        <span className="text-xs font-medium text-slate-500 dark:text-slate-400">
          {label}
        </span>
        <span className="text-[11px] font-semibold text-navy dark:text-slate-100">
          {value}
          {suffix}
        </span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full accent-siemens" />
      
    </label>);

}