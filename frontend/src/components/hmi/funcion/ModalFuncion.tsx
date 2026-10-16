// =========================================================================
// ModalFuncion.tsx
// «Configurar modo función»: para la salida elegida (varPrincipal o una
// variable con nombre), sus tags de entrada, sus variables internas y la
// expresión que calculará su valor.
//
// TRABAJA SOBRE UNA COPIA
//
//   Se edita un borrador de TODAS las salidas a la vez: saltar de var1 a var2
//   no pierde lo escrito en var1. Nada llega al widget hasta «Guardar
//   función»; «Cancelar» (o Escape) lo tira entero.
//
// LA EXPRESIÓN ES PYTHON
//
//   El bloque 3 es código Python que corre en el servidor
//   (app/core/funciones_py.py): las entradas y las internas son variables
//   normales, la salida se asigna (`varPrincipal = …`) o es la última
//   expresión, y se pueden definir funciones con `def`. El editor enseña qué
//   nombres del modal usa el código (y se pueden insertar con un clic),
//   valida la sintaxis con el servidor mientras se escribe, y «Valores de
//   prueba» lo ejecuta de verdad antes de guardar. En vivo lo calcula
//   `funcion/enVivo.ts`.
// =========================================================================
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  AlertCircleIcon,
  CheckCircle2Icon,
  Loader2Icon,
  PlayIcon,
  PlusIcon,
  XIcon,
} from 'lucide-react';
import {
  identificadoresEn,
  probarFuncion,
  validarFuncion,
  type ResultadoFuncion,
  type Validacion,
} from '../../../services/funcionesApi';
import type { PlcVariable } from '../../../models/plc';
import { filtrarGrupos } from '../../ui/Field';
import {
  TIPOS_INTERNA,
  errorDeFuncion,
  funcionVacia,
  type ConfigFunciones,
  type FuncionSalida,
  type InternaFuncion,
  type TipoInterna,
} from '../../../utils/funciones';

type Grupos = { label: string; options: { label: string; value: string }[] }[];

export interface SalidaFuncion {
  clave: string;
  /** Cómo se llama en la expresión: «varPrincipal», «var1»… */
  nombre: string;
}

// TODOS LOS CUADROS MIDEN LO MISMO (h-10): el de búsqueda era más bajo y la
// fila se veía descuadrada.
const CAMPO =
  'h-10 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm text-navy outline-none transition focus:border-siemens focus:ring-2 focus:ring-siemens/25 dark:border-navy-slate dark:bg-navy dark:text-slate-100';
const ROTULO =
  'block truncate text-[10px] font-bold uppercase tracking-wide text-slate-500 dark:text-slate-400';
const BOTON_ANADIR =
  'inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-siemens/50 bg-siemens/10 px-3 py-1.5 text-xs font-semibold text-siemens transition hover:bg-siemens/20 dark:text-siemens-200';
const BOTON_QUITAR =
  'inline-flex h-8 w-8 items-center justify-center rounded text-slate-400 transition hover:bg-red-50 hover:text-red-500 dark:hover:bg-red-500/10';

// Columnas de cada lista. Los títulos van UNA vez arriba, con las mismas
// columnas que las filas, y no repetidos en cada fila: así todo queda
// alineado y caben más filas antes de que salga el scroll.
const COLS_ENTRADA =
  'grid grid-cols-[150px_minmax(0,2fr)_minmax(0,1fr)_150px_32px] items-center gap-3';
const COLS_INTERNA = 'grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_32px] items-center gap-3';

/**
 * Las filas de una lista, con SU PROPIO scroll a partir de unas cuatro
 * filas: si no, con diez tags el modal crecía hasta salirse de la pantalla.
 * Al añadir una fila baja solo hasta ella, para que se vea la nueva.
 */
function ListaConScroll({ filas, children }: { filas: number; children: React.ReactNode }) {
  const caja = useRef<HTMLDivElement>(null);
  const antes = useRef(filas);
  useEffect(() => {
    if (filas > antes.current && caja.current) caja.current.scrollTop = caja.current.scrollHeight;
    antes.current = filas;
  }, [filas]);
  return (
    <div ref={caja} className="mp-scroll max-h-[212px] space-y-2.5 overflow-y-auto pr-1">
      {children}
    </div>
  );
}

/** Buscador del mismo alto que los demás cuadros. Filtra el «Tag asociado» de su fila. */
function Buscador({
  valor,
  onCambiar,
  coinciden,
}: {
  valor: string;
  onCambiar: (v: string) => void;
  coinciden: number;
}) {
  const buscando = valor.trim() !== '';
  return (
    <div className="relative">
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400"
      >
        <circle cx="11" cy="11" r="7" />
        <path d="m20 20-3.5-3.5" />
      </svg>
      <input
        value={valor}
        onChange={(e) => onCambiar(e.target.value)}
        placeholder="Buscar variable…"
        spellCheck={false}
        className={`${CAMPO} pl-9 ${buscando ? 'pr-14' : ''}`}
      />
      {buscando && (
        <span className="absolute right-2 top-1/2 flex -translate-y-1/2 items-center gap-1">
          <span
            className={`text-[10px] tabular-nums ${
              coinciden === 0 ? 'text-state-error' : 'text-slate-400'
            }`}
          >
            {coinciden}
          </span>
          <button
            type="button"
            onClick={() => onCambiar('')}
            title="Limpiar búsqueda"
            className="rounded p-0.5 text-slate-400 hover:text-navy dark:hover:text-slate-100"
          >
            <XIcon className="h-3.5 w-3.5" />
          </button>
        </span>
      )}
    </div>
  );
}

function Bloque({
  numero,
  titulo,
  descripcion,
  accion,
  children,
}: {
  numero: number;
  titulo: string;
  descripcion?: string;
  accion?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border border-slate-200 bg-slate-50/60 p-4 dark:border-navy-slate dark:bg-navy-soft">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="flex items-center gap-2.5 text-[15px] font-bold text-navy dark:text-slate-100">
            <span className="inline-flex h-6 w-6 items-center justify-center rounded-md bg-siemens/15 text-xs font-bold text-siemens dark:text-siemens-200">
              {numero}
            </span>
            {titulo}
          </h3>
          {descripcion && (
            <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{descripcion}</p>
          )}
        </div>
        {accion}
      </div>
      {children}
    </section>
  );
}

/** Una fila de «Tags de entrada». El buscador es suyo: filtra SU desplegable. */
function FilaEntrada({
  nombre,
  variableId,
  grupos,
  variable,
  onNombre,
  onVariable,
  onQuitar,
}: {
  nombre: string;
  variableId: string;
  grupos: Grupos;
  variable?: PlcVariable;
  onNombre: (v: string) => void;
  onVariable: (v: string) => void;
  onQuitar: () => void;
}) {
  const [busca, setBusca] = useState('');
  const filtro = filtrarGrupos(grupos, busca, variableId);
  const tipo = !variableId
    ? '—'
    : variableId.startsWith('param:')
    ? 'Parámetro'
    : variable?.type ?? 'Sin dato';
  return (
    <div className={COLS_ENTRADA}>
      <input
        value={nombre}
        onChange={(e) => onNombre(e.target.value)}
        spellCheck={false}
        placeholder="p. ej. m31_en"
        aria-label="Nombre en la función"
        className={CAMPO}
      />
      <select
        value={variableId}
        onChange={(e) => onVariable(e.target.value)}
        aria-label="Tag asociado"
        className={`${CAMPO} cursor-pointer font-medium`}
      >
        {filtro.grupos.map((g, i) =>
          g.options.length === 0 ? null : g.label ? (
            <optgroup key={g.label + i} label={g.label}>
              {g.options.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </optgroup>
          ) : (
            g.options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))
          )
        )}
      </select>
      <Buscador valor={busca} onCambiar={setBusca} coinciden={filtro.coinciden} />
      <div
        className={`${CAMPO} flex items-center truncate text-slate-500 dark:text-slate-400`}
        title={tipo}
      >
        <span className="truncate">{tipo}</span>
      </div>
      <button type="button" onClick={onQuitar} title="Quitar este tag" className={BOTON_QUITAR}>
        <XIcon className="h-4 w-4" />
      </button>
    </div>
  );
}

/**
 * El editor de la expresión: números de línea a la izquierda, como el diseño.
 *
 * `area` lo pone el padre: así los chips de variables pueden INSERTAR un
 * nombre donde esté el cursor. `lineaError` resalta la línea que el servidor
 * marcó al validar.
 */
function EditorExpresion({
  valor,
  onCambiar,
  area,
  lineaError,
}: {
  valor: string;
  onCambiar: (v: string) => void;
  area: React.RefObject<HTMLTextAreaElement>;
  lineaError: number | null;
}) {
  const margen = useRef<HTMLDivElement>(null);
  const lineas = Math.max(6, valor.split('\n').length);
  return (
    <div className="flex overflow-hidden rounded-lg border border-slate-200 bg-white dark:border-navy-slate dark:bg-[#0f1729]">
      <div
        ref={margen}
        aria-hidden
        className="select-none overflow-hidden border-r border-slate-200 bg-slate-50 px-3 py-3 text-right font-mono text-xs leading-[19px] text-slate-400 dark:border-navy-slate dark:bg-navy"
      >
        {Array.from({ length: lineas }, (_, i) => (
          <div
            key={i}
            className={
              lineaError === i + 1
                ? 'rounded-sm bg-state-error/15 font-bold text-state-error'
                : undefined
            }
          >
            {i + 1}
          </div>
        ))}
      </div>
      <textarea
        ref={area}
        value={valor}
        onChange={(e) => onCambiar(e.target.value)}
        // Los números de línea acompañan al texto al desplazarse.
        onScroll={(e) => {
          if (margen.current) margen.current.scrollTop = e.currentTarget.scrollTop;
        }}
        onKeyDown={(e) => {
          // Tab sangra (dos espacios) en vez de saltar al botón siguiente:
          // en un editor de código es lo que se espera.
          if (e.key !== 'Tab') return;
          e.preventDefault();
          const t = e.currentTarget;
          const ini = t.selectionStart;
          const fin = t.selectionEnd;
          onCambiar(valor.slice(0, ini) + '  ' + valor.slice(fin));
          requestAnimationFrame(() => {
            if (area.current) area.current.selectionStart = area.current.selectionEnd = ini + 2;
          });
        }}
        spellCheck={false}
        rows={8}
        placeholder={
          '# Python. Las entradas y las internas son variables; asigna la salida.\n' +
          'if temperatura > 80:\n' +
          '    varPrincipal = 3\n' +
          'else:\n' +
          '    contador = contador + 1\n' +
          '    varPrincipal = contador'
        }
        className="min-h-[160px] flex-1 resize-y bg-transparent px-3 py-3 font-mono text-xs leading-[19px] text-navy outline-none placeholder:text-slate-400 dark:text-slate-100"
      />
    </div>
  );
}

/** Un nombre del modal, como chip: encendido si el código lo usa; clic = insertarlo. */
function Chip({
  nombre,
  usado,
  tono,
  titulo,
  onClick,
}: {
  nombre: string;
  usado: boolean;
  tono: 'entrada' | 'interna' | 'salida' | 'error';
  titulo: string;
  onClick?: () => void;
}) {
  const colores = {
    entrada: usado
      ? 'border-siemens/60 bg-siemens/15 text-siemens dark:text-siemens-200'
      : 'border-slate-300 text-slate-500 dark:border-navy-slate dark:text-slate-400',
    interna: usado
      ? 'border-violet-400/60 bg-violet-400/15 text-violet-700 dark:text-violet-300'
      : 'border-slate-300 text-slate-500 dark:border-navy-slate dark:text-slate-400',
    salida: usado
      ? 'border-emerald-400/60 bg-emerald-400/15 text-emerald-700 dark:text-emerald-300'
      : 'border-amber-400/60 bg-amber-400/10 text-amber-700 dark:text-amber-300',
    error: 'border-state-error/50 bg-state-error/10 text-state-error',
  }[tono];
  return (
    <button
      type="button"
      onClick={onClick}
      title={titulo}
      className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 font-mono text-[11px] transition hover:brightness-110 ${colores}`}
    >
      {nombre}
    </button>
  );
}

/** Valor de prueba de una entrada, escrito como se escribiría en Python. */
function leerValorPrueba(texto: string): unknown {
  const t = texto.trim();
  if (t === '') return null;
  if (t === 'True' || t.toLowerCase() === 'true') return true;
  if (t === 'False' || t.toLowerCase() === 'false') return false;
  if (t === 'None' || t.toLowerCase() === 'null') return null;
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  return t.replace(/^['"]|['"]$/g, '');
}

function mostrarValor(v: unknown): string {
  if (v === null || v === undefined) return 'None';
  if (typeof v === 'boolean') return v ? 'True' : 'False';
  if (typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(Math.round(v * 1e6) / 1e6);
  return JSON.stringify(v);
}

/**
 * «Valores de prueba y resultado»: se escriben valores para las entradas y
 * las internas, se pulsa Probar, y el servidor ejecuta EXACTAMENTE lo que
 * ejecutará en vivo. Las entradas arrancan con su lectura actual, si la hay.
 */
function Pruebas({
  f,
  nombreSalida,
  variablePorId,
}: {
  f: FuncionSalida;
  nombreSalida: string;
  variablePorId: (id: string) => PlcVariable | undefined;
}) {
  const [valores, setValores] = useState<Record<string, string>>({});
  const [iniciales, setIniciales] = useState<Record<string, string>>({});
  const [resultado, setResultado] = useState<ResultadoFuncion | null>(null);
  const [probando, setProbando] = useState(false);
  const [fallo, setFallo] = useState('');

  const valorDe = (e: { nombre: string; variableId: string }): string => {
    if (e.nombre in valores) return valores[e.nombre];
    const v = e.variableId ? variablePorId(e.variableId)?.value : undefined;
    return v === undefined || v === null ? '' : mostrarValor(v);
  };
  const inicialDe = (i: InternaFuncion): string => {
    if (i.nombre in iniciales) return iniciales[i.nombre];
    return { bool: 'False', entero: '0', decimal: '0.0', texto: '' }[i.tipo];
  };

  const probar = async () => {
    setProbando(true);
    setFallo('');
    try {
      const entradas: Record<string, unknown> = {};
      for (const e of f.entradas) {
        if (e.nombre.trim()) entradas[e.nombre.trim()] = leerValorPrueba(valorDe(e));
      }
      const internas = f.internas
        .filter((i) => i.nombre.trim())
        .map((i) => ({ nombre: i.nombre.trim(), tipo: i.tipo, valor: leerValorPrueba(inicialDe(i)) }));
      setResultado(await probarFuncion(f.expresion, nombreSalida, entradas, internas));
    } catch (e: any) {
      setFallo(e?.message ?? 'No se pudo probar.');
    } finally {
      setProbando(false);
    }
  };

  const CAMPO_CHICO =
    'h-8 w-full rounded-md border border-slate-200 bg-white px-2 font-mono text-xs text-navy outline-none transition focus:border-siemens focus:ring-2 focus:ring-siemens/25 dark:border-navy-slate dark:bg-navy dark:text-slate-100';

  return (
    <div className="mt-3 space-y-3">
      {f.entradas.length === 0 && f.internas.length === 0 ? (
        <p className="text-xs text-slate-500 dark:text-slate-400">
          Sin entradas ni internas: la función se prueba tal cual.
        </p>
      ) : (
        <div className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
          {f.entradas
            .filter((e) => e.nombre.trim())
            .map((e) => (
              <label key={`e-${e.nombre}`} className="flex items-center gap-2 text-xs">
                <span className="w-28 shrink-0 truncate font-mono text-siemens dark:text-siemens-200" title={e.nombre}>
                  {e.nombre}
                </span>
                <input
                  value={valorDe(e)}
                  onChange={(ev) => setValores((v) => ({ ...v, [e.nombre]: ev.target.value }))}
                  placeholder="None"
                  spellCheck={false}
                  className={CAMPO_CHICO}
                  title="Valor de prueba. Vacío = None (tag sin lectura)."
                />
              </label>
            ))}
          {f.internas
            .filter((i) => i.nombre.trim())
            .map((i) => (
              <label key={`i-${i.nombre}`} className="flex items-center gap-2 text-xs">
                <span className="w-28 shrink-0 truncate font-mono text-violet-700 dark:text-violet-300" title={`${i.nombre} (interna, valor inicial)`}>
                  {i.nombre}
                </span>
                <input
                  value={inicialDe(i)}
                  onChange={(ev) => setIniciales((v) => ({ ...v, [i.nombre]: ev.target.value }))}
                  spellCheck={false}
                  className={CAMPO_CHICO}
                  title="Con qué valor arranca esta interna en la prueba."
                />
              </label>
            ))}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => void probar()}
          disabled={probando || f.expresion.trim() === ''}
          className="inline-flex items-center gap-1.5 rounded-lg bg-siemens px-3 py-1.5 text-xs font-semibold text-white transition hover:brightness-110 disabled:opacity-40"
        >
          {probando ? <Loader2Icon className="h-3.5 w-3.5 animate-spin" /> : <PlayIcon className="h-3.5 w-3.5" />}
          Probar
        </button>
        {resultado && resultado.exito && (
          <span className="inline-flex items-center gap-1.5 text-xs text-slate-600 dark:text-slate-300">
            <CheckCircle2Icon className="h-3.5 w-3.5 text-state-ok" />
            <span className="font-mono">{nombreSalida}</span> ={' '}
            <span className="rounded bg-emerald-400/15 px-1.5 py-0.5 font-mono text-sm font-bold text-emerald-700 dark:text-emerald-300">
              {mostrarValor(resultado.valor)}
            </span>
            <span className="text-slate-400">· {resultado.ms} ms</span>
          </span>
        )}
      </div>

      {(fallo || (resultado && !resultado.exito)) && (
        <p className="flex items-start gap-2 rounded-lg border border-state-error/30 bg-state-error/5 px-3 py-2 text-xs leading-relaxed text-state-error">
          <AlertCircleIcon className="mt-px h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 break-words">
            {fallo ||
              (resultado?.linea ? `Línea ${resultado.linea}: ${resultado.error}` : resultado?.error)}
          </span>
        </p>
      )}

      {resultado && f.internas.some((i) => i.nombre.trim()) && (
        <p className="text-xs text-slate-500 dark:text-slate-400">
          Internas después:{' '}
          {Object.entries(resultado.internas).map(([k, v], i) => (
            <span key={k} className="font-mono">
              {i > 0 ? ' · ' : ''}
              {k} = {mostrarValor(v)}
            </span>
          ))}
        </p>
      )}

      {resultado && resultado.impreso.length > 0 && (
        <pre className="mp-scroll max-h-32 overflow-auto rounded-lg bg-[#0f1729] px-3 py-2 font-mono text-[11px] leading-relaxed text-slate-200">
          {resultado.impreso.join('\n')}
        </pre>
      )}
    </div>
  );
}

export function ModalFuncion({
  salidas,
  config,
  gruposPara,
  variablePorId,
  onGuardar,
  onCerrar,
}: {
  salidas: SalidaFuncion[];
  config: ConfigFunciones;
  /** Las opciones de «Tag asociado»: las mismas de «Variable asociada». */
  gruposPara: (asignada: string) => Grupos;
  variablePorId: (id: string) => PlcVariable | undefined;
  onGuardar: (porSalida: Record<string, FuncionSalida>) => void;
  onCerrar: () => void;
}) {
  const [borrador, setBorrador] = useState<Record<string, FuncionSalida>>(() => ({
    ...config.porSalida,
  }));
  const [clave, setClave] = useState(salidas[0]?.clave ?? '');
  const salida = salidas.find((s) => s.clave === clave) ?? salidas[0];
  const f: FuncionSalida = (salida && borrador[salida.clave]) || funcionVacia();

  useEffect(() => {
    const tecla = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCerrar();
    };
    window.addEventListener('keydown', tecla);
    return () => window.removeEventListener('keydown', tecla);
  }, [onCerrar]);

  const cambiar = (parche: Partial<FuncionSalida>) => {
    if (!salida) return;
    setBorrador((b) => ({ ...b, [salida.clave]: { ...f, ...parche } }));
  };

  // El primer problema de CUALQUIER salida: guardar guarda todas, así que
  // una mal en var2 también bloquea aunque estés mirando var1.
  const error = useMemo(() => {
    for (const s of salidas) {
      const fs = borrador[s.clave];
      if (!fs) continue;
      const e = errorDeFuncion(fs, s.nombre);
      if (e) return s.clave === salida?.clave ? e : `${s.nombre}: ${e}`;
    }
    return '';
  }, [borrador, salidas, salida]);

  const guardar = () => {
    if (error) return;
    // Solo las salidas que siguen existiendo; las vacías no se guardan.
    const limpio: Record<string, FuncionSalida> = {};
    for (const s of salidas) {
      const fs = borrador[s.clave];
      if (!fs) continue;
      if (fs.entradas.length === 0 && fs.internas.length === 0 && fs.expresion.trim() === '') continue;
      limpio[s.clave] = {
        entradas: fs.entradas.map((e) => ({ ...e, nombre: e.nombre.trim() })),
        internas: fs.internas.map((i) => ({ ...i, nombre: i.nombre.trim() })),
        expresion: fs.expresion,
      };
    }
    onGuardar(limpio);
  };

  const nombreSalida = salida?.nombre ?? '—';

  // ── El código y sus nombres ──────────────────────────────────
  const area = useRef<HTMLTextAreaElement>(null);
  const usados = useMemo(() => identificadoresEn(f.expresion), [f.expresion]);
  const nombresModal = useMemo(
    () => [...f.entradas.map((e) => e.nombre.trim()), ...f.internas.map((i) => i.nombre.trim())].filter(Boolean),
    [f.entradas, f.internas]
  );

  /** Mete `nombre` donde esté el cursor del editor. */
  const insertar = (nombre: string) => {
    const t = area.current;
    if (!t) return;
    const ini = t.selectionStart ?? f.expresion.length;
    const fin = t.selectionEnd ?? ini;
    const antes = f.expresion.slice(0, ini);
    const despues = f.expresion.slice(fin);
    // Un espacio delante si lo anterior es letra o número, para no pegar
    // `contadorvarPrincipal`.
    const sep = /[A-Za-z0-9_)\]]$/.test(antes) ? ' ' : '';
    cambiar({ expresion: antes + sep + nombre + despues });
    requestAnimationFrame(() => {
      t.focus();
      const pos = ini + sep.length + nombre.length;
      t.selectionStart = t.selectionEnd = pos;
    });
  };

  // Validación con el servidor, con retardo: sintaxis y nombres desconocidos.
  const [validacion, setValidacion] = useState<Validacion | null>(null);
  useEffect(() => {
    const codigo = f.expresion;
    if (!codigo.trim()) {
      setValidacion(null);
      return;
    }
    let vivo = true;
    const reloj = window.setTimeout(() => {
      validarFuncion(codigo, nombresModal, nombreSalida)
        .then((v) => {
          if (vivo) setValidacion(v);
        })
        .catch(() => {
          /* sin servidor no se valida; se guarda igual */
        });
    }, 450);
    return () => {
      vivo = false;
      window.clearTimeout(reloj);
    };
  }, [f.expresion, nombresModal, nombreSalida]);

  return createPortal(
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/55 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCerrar();
      }}
    >
      <div
        role="dialog"
        aria-label="Configurar modo función"
        className="flex max-h-[92vh] w-full max-w-5xl flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl dark:border-navy-slate dark:bg-[#1c2737]"
      >
        {/* ── Cabecera ── */}
        <header className="flex items-start gap-4 border-b border-slate-200 px-7 py-5 dark:border-navy-slate">
          <span className="inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-siemens/15 font-serif text-xl font-bold italic text-siemens dark:text-siemens-200">
            ƒx
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="text-2xl font-bold text-navy dark:text-slate-100">Configurar modo función</h2>
            <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
              Define las entradas y la expresión que calculará el valor de esta variable.
            </p>
          </div>
          <button
            type="button"
            onClick={onCerrar}
            title="Cerrar"
            className="rounded-lg border border-slate-200 p-2 text-slate-500 transition hover:bg-slate-100 dark:border-navy-slate dark:text-slate-300 dark:hover:bg-navy-slate/50"
          >
            <XIcon className="h-4 w-4" />
          </button>
        </header>

        <div className="mp-scroll flex-1 space-y-4 overflow-auto px-7 py-5">
          {/* ── Variable de salida ── */}
          <div className="flex flex-wrap items-center gap-5 rounded-xl border border-siemens/40 border-l-4 border-l-siemens bg-siemens/5 px-6 py-3.5 dark:bg-siemens/10">
            <div className="min-w-0">
              <div className="text-[10px] font-bold uppercase tracking-wide text-siemens dark:text-siemens-200">
                Variable de salida
              </div>
              <div className="truncate text-lg font-bold text-navy dark:text-slate-100">{nombreSalida}</div>
            </div>
            <span className="rounded-full border border-siemens/60 bg-siemens/15 px-4 py-1.5 text-[11px] font-bold uppercase text-siemens dark:text-siemens-200">
              Modo función
            </span>
            <label className="ml-auto flex items-center gap-2 text-sm text-slate-500 dark:text-slate-300">
              Resultado →
              <select
                value={salida?.clave ?? ''}
                onChange={(e) => setClave(e.target.value)}
                disabled={salidas.length === 0}
                title="Elige qué variable calcula esta función"
                className="cursor-pointer rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm font-semibold text-navy outline-none focus:border-siemens dark:border-navy-slate dark:bg-navy dark:text-slate-100"
              >
                {salidas.map((s) => (
                  <option key={s.clave} value={s.clave}>
                    {s.nombre}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {salidas.length === 0 ? (
            <p className="rounded-xl border border-dashed border-slate-300 px-5 py-6 text-center text-sm text-slate-500 dark:border-navy-slate dark:text-slate-400">
              Este widget no tiene variables que calcular. Añade una en «Variables con nombre» del
              Inspector y vuelve a abrir esta ventana.
            </p>
          ) : (
            <>
              {/* ── 1. Tags de entrada ── */}
              <Bloque
                numero={1}
                titulo="Tags de entrada"
                descripcion="Fuentes disponibles para consultar. Estos tags son de solo lectura dentro de la función."
                accion={
                  <button
                    type="button"
                    className={BOTON_ANADIR}
                    onClick={() => cambiar({ entradas: [...f.entradas, { nombre: '', variableId: '' }] })}
                  >
                    <PlusIcon className="h-3.5 w-3.5" /> Añadir tag
                  </button>
                }
              >
                {f.entradas.length === 0 ? (
                  <p className="text-xs text-slate-400">Sin tags de entrada todavía.</p>
                ) : (
                  <>
                  <div className={`${COLS_ENTRADA} mb-1.5 pr-1`}>
                    <span className={ROTULO}>Nombre en la función</span>
                    <span className={ROTULO}>Tag asociado</span>
                    <span className={ROTULO}>Buscar tag</span>
                    <span className={ROTULO}>Tag seleccionado</span>
                    <span />
                  </div>
                  <ListaConScroll filas={f.entradas.length}>
                    {f.entradas.map((e, i) => (
                      <FilaEntrada
                        // Por posición: el nombre se edita y no sirve de llave.
                        key={`${salida!.clave}-${i}`}
                        nombre={e.nombre}
                        variableId={e.variableId}
                        grupos={gruposPara(e.variableId)}
                        variable={variablePorId(e.variableId)}
                        onNombre={(v) =>
                          cambiar({ entradas: f.entradas.map((x, j) => (j === i ? { ...x, nombre: v } : x)) })
                        }
                        onVariable={(v) =>
                          cambiar({ entradas: f.entradas.map((x, j) => (j === i ? { ...x, variableId: v } : x)) })
                        }
                        onQuitar={() => cambiar({ entradas: f.entradas.filter((_, j) => j !== i) })}
                      />
                    ))}
                  </ListaConScroll>
                  </>
                )}
              </Bloque>

              {/* ── 2. Variables internas ── */}
              <Bloque
                numero={2}
                titulo="Variables internas"
                descripcion="Datos propios de la función disponibles para el cálculo."
                accion={
                  <button
                    type="button"
                    className={BOTON_ANADIR}
                    onClick={() => cambiar({ internas: [...f.internas, { nombre: '', tipo: 'bool' }] })}
                  >
                    <PlusIcon className="h-3.5 w-3.5" /> Añadir variable
                  </button>
                }
              >
                {f.internas.length === 0 ? (
                  <p className="text-xs text-slate-400">Sin variables internas todavía.</p>
                ) : (
                  <>
                  <div className={`${COLS_INTERNA} mb-1.5 pr-1`}>
                    <span className={ROTULO}>Nombre</span>
                    <span className={ROTULO}>Tipo de dato</span>
                    <span />
                  </div>
                  <ListaConScroll filas={f.internas.length}>
                    {f.internas.map((v, i) => (
                      <div key={`${salida!.clave}-${i}`} className={COLS_INTERNA}>
                        <input
                          value={v.nombre}
                          onChange={(e) =>
                            cambiar({
                              internas: f.internas.map((x, j) => (j === i ? { ...x, nombre: e.target.value } : x)),
                            })
                          }
                          spellCheck={false}
                          placeholder="p. ej. contador"
                          aria-label="Nombre"
                          className={CAMPO}
                        />
                        <select
                          value={v.tipo}
                          onChange={(e) =>
                            cambiar({
                              internas: f.internas.map((x, j) =>
                                j === i ? { ...x, tipo: e.target.value as TipoInterna } : x
                              ),
                            })
                          }
                          aria-label="Tipo de dato"
                          className={`${CAMPO} cursor-pointer`}
                        >
                          {TIPOS_INTERNA.map((t) => (
                            <option key={t.valor} value={t.valor}>
                              {t.label}
                            </option>
                          ))}
                        </select>
                        <button
                          type="button"
                          title="Quitar esta variable"
                          onClick={() => cambiar({ internas: f.internas.filter((_, j) => j !== i) })}
                          className={BOTON_QUITAR}
                        >
                          <XIcon className="h-4 w-4" />
                        </button>
                      </div>
                    ))}
                  </ListaConScroll>
                  </>
                )}
              </Bloque>

              {/* ── 3. Expresión (Python) ── */}
              <Bloque
                numero={3}
                titulo="Expresión"
                descripcion={`Código Python. Asigna la salida (${nombreSalida} = …) o termina con una expresión. Puedes usar if/else, bucles, def y math.`}
                accion={
                  <span className="text-xs font-semibold text-siemens dark:text-siemens-200">
                    Resultado → {nombreSalida}
                  </span>
                }
              >
                {/* Los nombres del modal, y si el código los usa. Clic = insertar. */}
                <div className="mb-2 flex flex-wrap items-center gap-1.5">
                  <span className="mr-1 text-[10px] font-bold uppercase tracking-wide text-slate-400">
                    Variables
                  </span>
                  <Chip
                    nombre={nombreSalida}
                    usado={validacion ? validacion.asigna_salida : usados.has(nombreSalida)}
                    tono="salida"
                    titulo={
                      (validacion ? validacion.asigna_salida : usados.has(nombreSalida))
                        ? 'La salida recibe valor'
                        : 'La salida todavía no recibe valor: asígnala o termina con una expresión'
                    }
                    onClick={() => insertar(nombreSalida)}
                  />
                  {f.entradas
                    .filter((e) => e.nombre.trim())
                    .map((e) => (
                      <Chip
                        key={`e-${e.nombre}`}
                        nombre={e.nombre.trim()}
                        usado={usados.has(e.nombre.trim())}
                        tono="entrada"
                        titulo={`Entrada (${e.variableId || 'sin tag'}). Clic para insertarla.`}
                        onClick={() => insertar(e.nombre.trim())}
                      />
                    ))}
                  {f.internas
                    .filter((i) => i.nombre.trim())
                    .map((i) => (
                      <Chip
                        key={`i-${i.nombre}`}
                        nombre={i.nombre.trim()}
                        usado={usados.has(i.nombre.trim())}
                        tono="interna"
                        titulo={`Variable interna (${i.tipo}). Conserva su valor entre evaluaciones. Clic para insertarla.`}
                        onClick={() => insertar(i.nombre.trim())}
                      />
                    ))}
                  {validacion?.desconocidos.map((n) => (
                    <Chip
                      key={`d-${n}`}
                      nombre={n}
                      usado
                      tono="error"
                      titulo="El código usa este nombre, pero no es ninguna entrada ni variable interna."
                    />
                  ))}
                  {f.entradas.length === 0 && f.internas.length === 0 && (
                    <span className="text-[11px] text-slate-400">
                      Añade tags de entrada o variables internas arriba para usarlos aquí.
                    </span>
                  )}
                </div>

                <EditorExpresion
                  valor={f.expresion}
                  onCambiar={(v) => cambiar({ expresion: v })}
                  area={area}
                  lineaError={validacion && !validacion.ok ? validacion.linea : null}
                />

                {validacion && !validacion.ok && (
                  <p className="mt-2 flex items-start gap-2 text-xs text-state-error">
                    <AlertCircleIcon className="mt-px h-3.5 w-3.5 shrink-0" />
                    <span>
                      {validacion.linea ? `Línea ${validacion.linea}: ` : ''}
                      {validacion.error}
                    </span>
                  </p>
                )}
                {validacion && validacion.ok && !validacion.vacio && !validacion.asigna_salida && (
                  <p className="mt-2 text-xs text-amber-600 dark:text-amber-400">
                    El código no deja valor en <span className="font-mono">{nombreSalida}</span>: asígnalo o
                    termina con una expresión.
                  </p>
                )}

                <details className="mt-3 rounded-lg border border-slate-200 bg-white px-4 py-2.5 dark:border-navy-slate dark:bg-navy-soft">
                  <summary className="cursor-pointer text-xs font-semibold text-siemens dark:text-siemens-200">
                    Valores de prueba y resultado
                  </summary>
                  <Pruebas key={salida!.clave} f={f} nombreSalida={nombreSalida} variablePorId={variablePorId} />
                </details>
              </Bloque>
            </>
          )}
        </div>

        {/* ── Pie ── */}
        <footer className="flex items-center gap-3 border-t border-slate-200 px-7 py-4 dark:border-navy-slate">
          <p className="min-w-0 flex-1 text-xs text-state-error">{error}</p>
          <button
            type="button"
            onClick={onCerrar}
            className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-semibold text-navy transition hover:bg-slate-100 dark:border-navy-slate dark:text-slate-100 dark:hover:bg-navy-slate/50"
          >
            Cancelar
          </button>
          <button
            type="button"
            onClick={guardar}
            disabled={!!error || salidas.length === 0}
            className="rounded-lg bg-siemens px-4 py-2 text-sm font-semibold text-white transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Guardar función
          </button>
        </footer>
      </div>
    </div>,
    document.body
  );
}
