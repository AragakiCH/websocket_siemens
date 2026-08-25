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

/**
 * Igual que SelectField pero con las opciones repartidas en <optgroup>.
 *
 * Existe para el enlace de variables del Inspector: hace falta separar las
 * compatibles de las que no lo son SIN sacar a estas últimas de la lista.
 * Un grupo vacío no se dibuja, así que cuando todas las variables calzan se
 * ve exactamente igual que un select normal.
 */
export function SelectGroupField({
  label,
  value,
  groups,
  onChange




}: {label: string;value: string;groups: {label: string;options: {label: string;value: string;}[];}[];onChange: (v: string) => void;}) {
  return (
    <label className="block">
      <span className={labelBase}>{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={`${inputBase} px-3 py-2 text-sm`}>

        {groups.map((g) => {
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
      </select>
    </label>);

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