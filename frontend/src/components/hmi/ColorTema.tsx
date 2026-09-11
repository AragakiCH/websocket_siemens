// =========================================================================
// ColorTema.tsx
// Elegir un color de un widget: o DEL TEMA, o uno propio.
//
// POR QUÉ HACÍA FALTA
// Hasta ahora el Inspector solo sabía guardar un literal (`#009999`). Con eso,
// el Gestor de Temas sería decorativo: cambiar el color primario no movería ni
// un widget, porque ninguno lo estaría mirando. Aquí es donde un widget se
// engancha al tema.
//
// Lo que se guarda cuando eliges un color del tema es, literalmente, el texto
// `var(--psi-primary)`. Va al mismo campo de siempre (`style.color`), viaja en
// el mismo JSON y se pinta con el mismo estilo en línea — quien resuelve la
// variable es el navegador. Por eso esto no obliga a tocar el render de ningún
// widget, ni los que ya existen ni los ZIP que cargue el usuario.
//
// Y NO SE PIERDE EL COLOR SUELTO
// Elegir «Personalizado» vuelve a un literal. Es la mitad que WebIQ describe
// como «seguir pudiendo estilar botones concretos»: el tema pone el valor por
// defecto, el widget que lo necesite se sale de él a propósito.
// =========================================================================
import React from 'react';
import { useTema } from '../../context/TemaProvider';
import { GRUPOS_COLOR, ROLES_CATALOGO, esToken, rolDeToken, tokenDeRol }
  from '../../models/tema';

const DAMERO: React.CSSProperties = {
  backgroundImage:
    'linear-gradient(45deg,#cbd5e1 25%,transparent 25%,transparent 75%,#cbd5e1 75%),' +
    'linear-gradient(45deg,#cbd5e1 25%,transparent 25%,transparent 75%,#cbd5e1 75%)',
  backgroundSize: '8px 8px',
  backgroundPosition: '0 0, 4px 4px',
  backgroundColor: '#fff',
};

const LITERAL = '__propio';
const NINGUNO = '__ninguno';

export function ColorTema({
  label,
  value,
  onChange,
  permiteNinguno = false,
  colorAlPoner = '#cbd5e1',
}: {
  label: string;
  value: string | undefined;
  onChange: (v: string) => void;
  /** El fondo puede NO existir; el color de un texto, no. */
  permiteNinguno?: boolean;
  /** Con qué color se estrena el control cuando se pasa de «ninguno» a uno. */
  colorAlPoner?: string;
}) {
  const { tema } = useTema();

  const valor = value ?? '';
  const vacio = permiteNinguno && (!valor || valor === 'transparent');
  const rol = rolDeToken(valor);

  // Los colores propios del tema («Añadir color») se ofrecen igual que los
  // del catálogo: si se pueden crear pero no elegir, no sirven de nada.
  const extras = (tema?.extras ?? []).filter((e) => !ROLES_CATALOGO.includes(e.id));

  // Un token que apunta a un rol que este tema no define. Pasa al importar un
  // diseño hecho con otro tema. Se ENSEÑA en vez de caer en «Personalizado»
  // en silencio: el widget se está pintando con el valor de respaldo del CSS
  // y quien lo mire tiene que poder enterarse.
  const rolDesconocido =
    rol !== null &&
    !ROLES_CATALOGO.includes(rol) &&
    !extras.some((e) => e.id === rol);

  const seleccion = vacio ? NINGUNO : rol ? rol : LITERAL;

  const alElegir = (v: string) => {
    if (v === NINGUNO) return onChange('transparent');
    if (v === LITERAL) {
      // Al salir del tema se arranca del color que el tema estaba dando, no
      // de un gris cualquiera: así «personalizar» empieza por donde estabas.
      const resuelto = resolver(valor);
      return onChange(resuelto ?? colorAlPoner);
    }
    onChange(tokenDeRol(v));
  };

  const esHex = /^#[0-9a-fA-F]{6}$/.test(valor);

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-slate-500 dark:text-slate-400">
          {label}
        </span>

        <div className="flex items-center gap-1.5">
          {/* La muestra. Con un token se pinta poniendo el propio
              `var(--psi-…)` como fondo: lo resuelve el navegador, así que
              enseña el color de verdad del tema activo sin calcularlo. */}
          <span
            className="h-7 w-9 shrink-0 rounded border border-slate-200 dark:border-navy-slate"
            style={vacio ? DAMERO : { background: valor }}
            title={vacio ? 'Sin fondo' : valor}
          />

          {!vacio && esHex && (
            <input
              type="color"
              value={valor}
              onChange={(e) => onChange(e.target.value)}
              className="h-7 w-9 cursor-pointer rounded border border-slate-200 bg-white p-0.5 dark:border-navy-slate dark:bg-navy"
            />
          )}
        </div>
      </div>

      <select
        value={rolDesconocido ? LITERAL : seleccion}
        onChange={(e) => alElegir(e.target.value)}
        className="w-full rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-[11px] text-navy outline-none transition focus:border-siemens dark:border-navy-slate dark:bg-navy dark:text-slate-100"
      >
        {permiteNinguno && <option value={NINGUNO}>Sin fondo</option>}
        <option value={LITERAL}>
          {seleccion === LITERAL && valor ? `Personalizado · ${valor}` : 'Personalizado…'}
        </option>
        {GRUPOS_COLOR.map((g) => (
          <optgroup key={g.id} label={`Tema · ${g.label}`}>
            {g.roles.map((r) => (
              <option key={r.id} value={r.id}>
                {r.label}
              </option>
            ))}
          </optgroup>
        ))}
        {extras.length > 0 && (
          <optgroup label="Tema · Colores propios">
            {extras.map((e) => (
              <option key={e.id} value={e.id}>
                {e.nombre}
              </option>
            ))}
          </optgroup>
        )}
      </select>

      {rolDesconocido && (
        <p className="text-[10px] leading-snug text-amber-600 dark:text-amber-400">
          Este widget usa «{rol}», que el tema actual no define. Se está
          pintando con el color de reserva.
        </p>
      )}

      {seleccion !== LITERAL && !vacio && (
        <p className="text-[10px] text-slate-400">
          Sigue al tema: cambiarlo en el Gestor de Temas cambia este widget.
        </p>
      )}
    </div>
  );
}

/**
 * El color que un valor produce AHORA mismo, en `#rrggbb`.
 *
 * Se necesita al pasar de «del tema» a «personalizado»: hay que dejar un
 * literal, y el literal razonable es el que se estaba viendo. Se resuelve
 * pintando el valor en un elemento de usar y tirar y preguntándole al
 * navegador qué le salió, que es la única forma de saber a qué resuelve una
 * variable CSS.
 */
function resolver(valor: string): string | null {
  if (/^#[0-9a-fA-F]{6}$/.test(valor)) return valor;
  if (!esToken(valor) || typeof document === 'undefined') return null;
  try {
    const sonda = document.createElement('span');
    sonda.style.color = valor;
    sonda.style.display = 'none';
    document.body.appendChild(sonda);
    const calculado = getComputedStyle(sonda).color;
    sonda.remove();
    const m = /^rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(calculado);
    if (!m) return null;
    const hex = (n: string) => Number(n).toString(16).padStart(2, '0');
    return `#${hex(m[1])}${hex(m[2])}${hex(m[3])}`;
  } catch {
    return null;
  }
}
