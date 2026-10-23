// =========================================================================
// custom/faceplate/Constantes.tsx
// Las constantes en los desplegables de parámetros de un faceplate.
//
// DÓNDE SALEN
// En los DOS sitios donde se rellenan los parámetros de un tipo de faceplate:
//   * «Tags de esta ventana» de la acción «Abrir un faceplate» (inspectores/
//     accion.tsx), y
//   * «Tags de esta instancia» del widget «Faceplate» (Faceplate.tsx).
// En ningún otro selector: `selectedVariables` las deja fuera.
//
// DE CADA TIPO DE FACEPLATE
// Se piden con `?faceplate=<project_id>`: las del faceplate «Motor» no salen
// en el de «Válvula». Y en cada parámetro, solo las de SU tipo (bool, int,
// double, texto): ofrecer una `double` a un parámetro `bool` sería ofrecer un
// enlace que no va a funcionar.
//
// POR QUÉ LOS MANDOS VAN DEBAJO DEL DESPLEGABLE Y NO DENTRO
// El desplegable es un <select> nativo —el que ya tenía su buscador encima—,
// y la lista de un <select> la dibuja el navegador: dentro de una opción no
// cabe un botón. Así que:
//   * en la lista: el grupo «Constantes» con «Nombre = valor» y la opción
//     «+ Nueva constante…»;
//   * debajo, solo cuando hace falta: el formulario para crearla, o —si la
//     elegida es una constante— su fila con ✎ y 🗑 para editarla o borrarla.
// =========================================================================
import { useCallback, useEffect, useState } from 'react';
import { CheckIcon, LockIcon, PencilIcon, Trash2Icon, XIcon } from 'lucide-react';
import {
  borrarConstante,
  crearConstante,
  editarConstante,
  esClaveConstante,
  fmtValorConstante,
  idDeClave,
  listarConstantes,
  usosConstante,
  type Constante,
  type TipoConstante,
} from '../../../../services/constantesApi';

/** Valor de la opción «+ Nueva constante…». Nunca se guarda en un parámetro. */
export const NUEVA_CONSTANTE = '__nueva_constante__';

type Opcion = { label: string; value: string };

const TIPOS_VALIDOS: TipoConstante[] = ['bool', 'int', 'double', 'string'];
/** El tipo de un parámetro de faceplate, como tipo de constante. */
export function tipoConstanteDe(tipo: string): TipoConstante | null {
  return (TIPOS_VALIDOS as string[]).includes(tipo) ? (tipo as TipoConstante) : null;
}

/**
 * Las constantes de un tipo de faceplate. Se vuelven a pedir cuando otra
 * pantalla (u otro diseñador) crea, cambia o borra alguna.
 */
export function useConstantes(faceplate: string) {
  const [lista, setLista] = useState<Constante[]>([]);
  const [rev, setRev] = useState(0);
  const recargar = useCallback(() => setRev((n) => n + 1), []);

  useEffect(() => {
    if (!faceplate) {
      setLista([]);
      return;
    }
    let vivo = true;
    listarConstantes(faceplate)
      .then((l) => vivo && setLista(l))
      .catch(() => vivo && setLista([]));
    return () => {
      vivo = false;
    };
  }, [faceplate, rev]);

  useEffect(() => {
    const alAviso = (ev: Event) => {
      const m = (ev as CustomEvent).detail;
      if (m?.type === 'config.updated' && m.recurso === 'constantes') recargar();
    };
    window.addEventListener('hmi:ws', alAviso);
    return () => window.removeEventListener('hmi:ws', alAviso);
  }, [recargar]);

  return { lista, recargar };
}

/** El grupo «Constantes» del desplegable de un parámetro. */
export function grupoConstantes(
  lista: Constante[],
  tipo: string
): { label: string; options: Opcion[] } | null {
  const t = tipoConstanteDe(tipo);
  if (!t) return null;
  const propias = lista.filter((c) => c.tipo === t);
  return {
    label: 'Constantes',
    options: [
      ...propias.map((c) => ({ label: `${c.nombre} = ${fmtValorConstante(c)}`, value: c.clave })),
      { label: '+ Nueva constante…', value: NUEVA_CONSTANTE },
    ],
  };
}

const CAMPO =
  'w-full min-w-0 rounded-md border border-slate-200 bg-white px-2 py-1 text-[11px] text-navy outline-none ' +
  'focus:border-siemens focus:ring-2 focus:ring-siemens/20 dark:border-navy-slate dark:bg-navy dark:text-slate-100';
const BOTON_ICONO =
  'inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-slate-400 transition ' +
  'hover:bg-slate-100 hover:text-slate-600 disabled:opacity-40 dark:hover:bg-navy-slate/50';

/** El campo del valor según el tipo: Sí/No, número o texto. */
function CampoValor({
  tipo,
  valor,
  onCambiar,
  onEnter,
}: {
  tipo: TipoConstante;
  valor: string;
  onCambiar: (v: string) => void;
  onEnter: () => void;
}) {
  if (tipo === 'bool') {
    return (
      <select value={valor} onChange={(e) => onCambiar(e.target.value)} className={`${CAMPO} cursor-pointer`}>
        <option value="true">Sí (true)</option>
        <option value="false">No (false)</option>
      </select>
    );
  }
  return (
    <input
      type={tipo === 'string' ? 'text' : 'number'}
      step={tipo === 'int' ? 1 : 'any'}
      value={valor}
      placeholder={tipo === 'string' ? 'Texto' : '0'}
      onChange={(e) => onCambiar(e.target.value)}
      onKeyDown={(e) => e.key === 'Enter' && onEnter()}
      className={`${CAMPO} font-mono`}
    />
  );
}

const valorInicial = (tipo: TipoConstante) => (tipo === 'bool' ? 'false' : '');
const aTexto = (c: Constante) => (c.tipo === 'bool' ? String(!!c.valor) : String(c.valor ?? ''));

/**
 * Lo que va DEBAJO del desplegable de un parámetro:
 *   * `creando` → el formulario de una constante nueva;
 *   * si el valor elegido es una constante → su fila, con editar y borrar;
 *   * si no → nada.
 */
export function PanelConstante({
  faceplate,
  tipo,
  valor,
  lista,
  creando,
  onCerrarCreacion,
  onAsignar,
  recargar,
}: {
  faceplate: string;
  /** Tipo del parámetro: el de la constante (no se elige). */
  tipo: string;
  /** Lo asignado ahora al parámetro. */
  valor: string;
  lista: Constante[];
  creando: boolean;
  onCerrarCreacion: () => void;
  /** Asigna una clave al parámetro (`''` = sin asignar). */
  onAsignar: (clave: string) => void;
  recargar: () => void;
}) {
  const t = tipoConstanteDe(tipo);
  const actual = esClaveConstante(valor) ? lista.find((c) => c.id === idDeClave(valor)) : undefined;

  const [nombre, setNombre] = useState('');
  const [texto, setTexto] = useState('');
  const [editando, setEditando] = useState(false);
  const [confirmando, setConfirmando] = useState<null | { widgets: number; pantallas: string[] }>(null);
  const [ocupado, setOcupado] = useState(false);
  const [error, setError] = useState('');

  // Al abrir el formulario de alta, vacío.
  useEffect(() => {
    if (creando && t) {
      setNombre('');
      setTexto(valorInicial(t));
      setError('');
    }
  }, [creando, t]);
  // Al cambiar de constante elegida, fuera la edición a medias.
  useEffect(() => {
    setEditando(false);
    setConfirmando(null);
    setError('');
  }, [valor]);

  if (!t) return null;

  const crear = async () => {
    if (ocupado) return;
    if (!nombre.trim()) return setError('Ponle un nombre.');
    if (t !== 'string' && t !== 'bool' && texto.trim() === '') return setError('Pon el valor.');
    setOcupado(true);
    setError('');
    try {
      const c = await crearConstante({ faceplate, nombre: nombre.trim(), tipo: t, valor: texto });
      recargar();
      onAsignar(c.clave);
      onCerrarCreacion();
    } catch (e: any) {
      setError(e?.message ?? 'No se pudo crear la constante.');
    } finally {
      setOcupado(false);
    }
  };

  const guardarEdicion = async () => {
    if (!actual || ocupado) return;
    if (!nombre.trim()) return setError('Ponle un nombre.');
    setOcupado(true);
    setError('');
    try {
      await editarConstante(actual.id, { nombre: nombre.trim(), valor: texto });
      recargar();
      setEditando(false);
    } catch (e: any) {
      setError(e?.message ?? 'No se pudo guardar.');
    } finally {
      setOcupado(false);
    }
  };

  const pedirBorrar = async () => {
    if (!actual || ocupado) return;
    setOcupado(true);
    setError('');
    try {
      setConfirmando(await usosConstante(actual.id));
    } catch {
      setConfirmando({ widgets: 0, pantallas: [] });
    } finally {
      setOcupado(false);
    }
  };

  const borrar = async () => {
    if (!actual || ocupado) return;
    setOcupado(true);
    try {
      await borrarConstante(actual.id);
      onAsignar('');
      recargar();
      setConfirmando(null);
    } catch (e: any) {
      setError(e?.message ?? 'No se pudo borrar.');
    } finally {
      setOcupado(false);
    }
  };

  const caja = 'mt-1 rounded-lg border border-slate-200 bg-slate-50 p-1.5 dark:border-navy-slate dark:bg-navy-slate/30';
  const errorEl = error && <p className="mt-1 text-[10px] font-semibold text-red-500">{error}</p>;

  // ── Alta ──
  if (creando) {
    return (
      <div className={caja}>
        <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-slate-400">
          Nueva constante · {t === 'string' ? 'texto' : t}
        </p>
        <div className="grid grid-cols-[1fr_88px] gap-1">
          <input
            autoFocus
            value={nombre}
            maxLength={60}
            placeholder="Nombre"
            onChange={(e) => setNombre(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void crear();
              if (e.key === 'Escape') onCerrarCreacion();
            }}
            className={CAMPO}
          />
          <CampoValor tipo={t} valor={texto} onCambiar={setTexto} onEnter={() => void crear()} />
        </div>
        <div className="mt-1 flex justify-end gap-1">
          <button type="button" onClick={onCerrarCreacion} className="rounded-md px-2 py-0.5 text-[11px] text-slate-500 hover:text-slate-700 dark:text-slate-400">
            Cancelar
          </button>
          <button
            type="button"
            disabled={ocupado}
            onClick={() => void crear()}
            className="rounded-md bg-siemens px-2.5 py-0.5 text-[11px] font-semibold text-white transition hover:bg-siemens/90 disabled:opacity-50"
          >
            Crear y asignar
          </button>
        </div>
        {errorEl}
      </div>
    );
  }

  if (!actual) return null;

  // ── Confirmar el borrado ──
  if (confirmando) {
    const usada = confirmando.widgets > 0;
    return (
      <div className="mt-1 rounded-lg border border-red-300/60 bg-red-50 p-1.5 text-[11px] leading-relaxed text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300">
        ¿Borrar «{actual.nombre}»?
        {usada && (
          <>
            {' '}Está asignada en <b>{confirmando.widgets}</b> widget{confirmando.widgets === 1 ? '' : 's'}
            {confirmando.pantallas.length ? ` (${confirmando.pantallas.join(', ')})` : ''}: esos
            parámetros se quedarán sin valor.
          </>
        )}
        <div className="mt-1 flex justify-end gap-1">
          <button type="button" onClick={() => setConfirmando(null)} className="rounded-md px-2 py-0.5 text-slate-500 hover:text-slate-700 dark:text-slate-400">
            Cancelar
          </button>
          <button
            type="button"
            disabled={ocupado}
            onClick={() => void borrar()}
            className="rounded-md bg-red-600 px-2.5 py-0.5 font-semibold text-white transition hover:bg-red-700 disabled:opacity-50"
          >
            Borrar
          </button>
        </div>
        {errorEl}
      </div>
    );
  }

  // ── Editar ──
  if (editando) {
    return (
      <div className={caja}>
        <div className="grid grid-cols-[1fr_88px_auto_auto] items-center gap-1">
          <input
            autoFocus
            value={nombre}
            maxLength={60}
            onChange={(e) => setNombre(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void guardarEdicion();
              if (e.key === 'Escape') setEditando(false);
            }}
            className={CAMPO}
          />
          <CampoValor tipo={actual.tipo} valor={texto} onCambiar={setTexto} onEnter={() => void guardarEdicion()} />
          <button type="button" title="Guardar" disabled={ocupado} onClick={() => void guardarEdicion()} className={`${BOTON_ICONO} text-siemens`}>
            <CheckIcon className="h-3.5 w-3.5" />
          </button>
          <button type="button" title="Cancelar" onClick={() => setEditando(false)} className={BOTON_ICONO}>
            <XIcon className="h-3.5 w-3.5" />
          </button>
        </div>
        <p className="mt-1 text-[10px] leading-relaxed text-slate-400">
          Cambia el valor en todas las instancias de este faceplate que la usan.
        </p>
        {errorEl}
      </div>
    );
  }

  // ── La elegida, con sus mandos ──
  return (
    <div className="group mt-1 flex items-center gap-1.5 rounded-lg border border-slate-200 bg-slate-50 px-2 py-1 dark:border-navy-slate dark:bg-navy-slate/30">
      <LockIcon className="h-3 w-3 shrink-0 text-slate-400" aria-label="Constante" />
      <span className="min-w-0 flex-1 truncate text-[11px] text-slate-600 dark:text-slate-300" title={actual.nombre}>
        {actual.nombre}
      </span>
      <span className="shrink-0 font-mono text-[11px] text-slate-400">{fmtValorConstante(actual)}</span>
      <span className="flex shrink-0 opacity-60 transition group-hover:opacity-100">
        <button
          type="button"
          title="Editar la constante"
          onClick={() => {
            setNombre(actual.nombre);
            setTexto(aTexto(actual));
            setError('');
            setEditando(true);
          }}
          className={BOTON_ICONO}
        >
          <PencilIcon className="h-3 w-3" />
        </button>
        <button
          type="button"
          title="Borrar la constante"
          disabled={ocupado}
          onClick={() => void pedirBorrar()}
          className={`${BOTON_ICONO} hover:!text-red-500`}
        >
          <Trash2Icon className="h-3 w-3" />
        </button>
      </span>
    </div>
  );
}
