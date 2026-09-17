// =========================================================================
// PanelEscritura.tsx
// La LISTA BLANCA de escritura: qué tags del PLC puede tocar el HMI.
//
// QUÉ DECIDE ESTA PANTALLA
// El backend no escribe en un tag porque el servidor OPC UA lo declare
// escribible — declara escribibles muchísimas más variables de las que tiene
// sentido tocar desde un HMI. Escribe en los que alguien dio de alta AQUÍ, con
// sus límites. Hasta ahora eso solo se podía hacer por Swagger.
//
// LA REGLA QUE NO SE VE EN NINGÚN ENDPOINT, Y QUE ES LA IMPORTANTE
// Un tag solo es escribible DE VERDAD si el programa del PLC no le asigna
// nada. Si el programa hace `rVar33 := ...` en cada ciclo, la escritura entra
// y el siguiente scan la machaca: el valor vive milisegundos. El backend
// avisa —relee el tag y devuelve `coincide: false`— pero para entonces ya se
// habilitó algo que no debía.
//
// Peor aún: ese valor vive un ciclo, y en ESE ciclo otra parte del programa
// puede leerlo. Por eso el aviso está arriba del todo y no en una ayuda
// escondida: la división es consignas y comandos (del HMI) contra medidas,
// estados y calculados (del PLC).
//
// POR QUÉ HABILITAR CUESTA MÁS CLICS QUE DESHABILITAR
// Deshabilitar hace el sistema MÁS seguro: un clic y fuera. Habilitar abre la
// puerta a que alguien mueva algo en planta, así que pide abrir el formulario,
// poner límites y confirmar. La asimetría es deliberada.
//
// LOS LÍMITES NO SON DECORACIÓN
// El tipo ya impide que un Int16 desborde, pero que un valor QUEPA en un Int16
// no significa que la máquina lo admita: 32000 cabe de sobra en una consigna
// de temperatura cuyo máximo real son 90 °C. Los límites son la segunda red.
// =========================================================================
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangleIcon,
  CheckIcon,
  InfoIcon,
  Loader2Icon,
  PencilIcon,
  RefreshCwIcon,
  SearchIcon,
  ShieldCheckIcon,
  XIcon } from
'lucide-react';
import {
  candidatos as pedirCandidatos,
  habilitar as habilitarTag,
  deshabilitar as deshabilitarTag,
  type TagCandidato } from
'../../services/escrituraApi';

/** Lo que el panel le cuenta a la página para la insignia del menú. */
export interface EstadoEscritura {
  habilitados: number;
  candidatos: number;
}

interface Props {
  /** PLCs disponibles: `id` es el que va al endpoint. */
  plcs: { id: string; nombre: string; conectado: boolean }[];
  onEstado?: (e: EstadoEscritura) => void;
  /**
   * Tag con el que arrancar el buscador.
   *
   * Lo trae quien llega desde el Diseñador pulsando «Habilitar este tag»: con
   * 206 candidatos, dejarlo en la lista entera es obligarle a teclear otra vez
   * el nombre que acababa de tener delante.
   */
  buscaInicial?: string;
}

/**
 * Tipos que NO llevan límites: el servidor los ignora en booleanos y textos.
 * Enseñar dos campos que no hacen nada es peor que no enseñarlos.
 */
const esNumerico = (t: string): boolean =>
!/^(bool|boolean|string|char|wstring|byte|time|date)/i.test(t.trim());

/**
 * Tope de filas dibujadas.
 *
 * Un PLC de planta puede traer miles de tags escribibles. Dibujarlos todos
 * deja el buscador pegajoso justo cuando más se usa. Se corta y se dice — un
 * corte anunciado se entiende; una lista incompleta y muda, no.
 */
const TOPE_FILAS = 300;

// ── Piezas ───────────────────────────────────────────────────────

function Insignia({ texto, tono }: {texto: string;tono: 'tipo' | 'db';}) {
  return (
    <span
      className={`inline-block max-w-full truncate rounded px-1.5 py-0.5 font-mono text-[10.5px] ${
      tono === 'tipo' ?
      'bg-siemens/10 text-siemens dark:bg-siemens/15 dark:text-siemens-200' :
      'bg-slate-100 text-slate-500 dark:bg-navy dark:text-slate-400'}`
      }>
      {texto}
    </span>);

}

/** El interruptor. Mismo gesto en las dos direcciones, distinto peso detrás. */
function Interruptor({
  activo,
  onClick,
  titulo,
  ocupado
}: {activo: boolean;onClick: () => void;titulo: string;ocupado?: boolean;}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={activo}
      aria-label={titulo}
      title={titulo}
      disabled={ocupado}
      onClick={onClick}
      className={`relative h-5 w-9 shrink-0 rounded-full outline-none transition focus-visible:ring-2 focus-visible:ring-siemens/40 disabled:opacity-50 ${
      activo ? 'bg-siemens' : 'bg-slate-300 dark:bg-navy-slate'}`
      }>
      <span
        className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all ${
        activo ? 'left-[1.125rem]' : 'left-0.5'}`
        } />
    </button>);

}

/**
 * El formulario de alta, desplegado DENTRO de la fila.
 *
 * En un diálogo aparte se pierde de vista el tag que se está habilitando, que
 * es justo el dato que hay que tener delante para no equivocarse de fila.
 */
function FormularioAlta({
  cand,
  onGuardar,
  onCancelar,
  guardando,
  error
}: {
  cand: TagCandidato;
  onGuardar: (v: {minimo: number | null;maximo: number | null;descripcion: string;}) => void;
  onCancelar: () => void;
  guardando: boolean;
  error: string;
}) {
  const numerico = esNumerico(cand.data_type);
  const [min, setMin] = useState(cand.minimo == null ? '' : String(cand.minimo));
  const [max, setMax] = useState(cand.maximo == null ? '' : String(cand.maximo));
  const [desc, setDesc] = useState(cand.descripcion ?? '');
  const primero = useRef<HTMLInputElement>(null);

  // El foco entra solo en el primer campo útil: se abre con un clic en el
  // interruptor, y obligar a un segundo clic para empezar a escribir sobra.
  useEffect(() => {
    primero.current?.focus();
  }, []);

  const nMin = min.trim() === '' ? null : Number(min);
  const nMax = max.trim() === '' ? null : Number(max);
  const minMal = nMin !== null && !Number.isFinite(nMin);
  const maxMal = nMax !== null && !Number.isFinite(nMax);
  // El servidor también lo rechaza con un 400, pero decirlo aquí ahorra el
  // viaje y señala CUÁL de los dos campos está mal.
  const alReves = nMin !== null && nMax !== null && nMin > nMax;
  const puede = !guardando && !minMal && !maxMal && !alReves;

  const enviar = () => {
    if (!puede) return;
    onGuardar({
      minimo: numerico ? nMin : null,
      maximo: numerico ? nMax : null,
      descripcion: desc.trim()
    });
  };

  const alTeclear = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      enviar();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onCancelar();
    }
  };

  const claseCampo =
  'w-full rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-navy outline-none transition placeholder:text-slate-300 focus:border-siemens focus:ring-2 focus:ring-siemens/20 dark:border-navy-slate dark:bg-navy dark:text-slate-100';

  return (
    <div
      onKeyDown={alTeclear}
      className="border-l-2 border-siemens bg-siemens/[0.04] px-4 py-3 dark:bg-siemens/[0.07]">

      <div className="flex flex-wrap items-end gap-3">
        {numerico ?
        <>
            <label className="min-w-[7rem] flex-1">
              <span className="mb-1 block text-[10px] font-bold uppercase tracking-wider text-slate-400">
                Mínimo
              </span>
              <input
              ref={primero}
              value={min}
              onChange={(e) => setMin(e.target.value)}
              inputMode="decimal"
              placeholder="sin tope"
              className={`${claseCampo} ${minMal || alReves ? 'border-state-error' : ''}`} />

            </label>
            <label className="min-w-[7rem] flex-1">
              <span className="mb-1 block text-[10px] font-bold uppercase tracking-wider text-slate-400">
                Máximo
              </span>
              <input
              value={max}
              onChange={(e) => setMax(e.target.value)}
              inputMode="decimal"
              placeholder="sin tope"
              className={`${claseCampo} ${maxMal || alReves ? 'border-state-error' : ''}`} />

            </label>
          </> :

        <p className="flex-1 text-[11px] leading-relaxed text-slate-400">
            <InfoIcon className="mr-1 inline h-3 w-3" />
            Es de tipo <span className="font-mono">{cand.data_type}</span>: los
            límites no aplican y el servidor los ignora.
          </p>
        }

        <label className="min-w-[12rem] flex-[2]">
          <span className="mb-1 block text-[10px] font-bold uppercase tracking-wider text-slate-400">
            Descripción
          </span>
          <input
            ref={numerico ? undefined : primero}
            value={desc}
            onChange={(e) => setDesc(e.target.value)}
            placeholder="Consigna de temperatura · Cuba 1"
            className={claseCampo} />

        </label>

        <div className="flex shrink-0 items-center gap-1.5 pb-0.5">
          <button
            type="button"
            onClick={enviar}
            disabled={!puede}
            className="flex items-center gap-1.5 rounded-lg bg-siemens px-3 py-1.5 text-xs font-semibold text-white outline-none transition hover:bg-siemens-600 focus-visible:ring-2 focus-visible:ring-siemens/50 disabled:cursor-not-allowed disabled:opacity-40">
            {guardando ?
            <Loader2Icon className="h-3.5 w-3.5 animate-spin" /> :
            <CheckIcon className="h-3.5 w-3.5" />}
            Habilitar
          </button>
          <button
            type="button"
            onClick={onCancelar}
            className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs text-slate-500 transition hover:bg-slate-50 dark:border-navy-slate dark:text-slate-400 dark:hover:bg-navy-slate/40">
            Cancelar
          </button>
        </div>
      </div>

      {/* Un solo renglón de aviso, y el más urgente primero: el del servidor
          manda sobre el de validación local. */}
      {(error || alReves) &&
      <p className="mt-2 flex items-start gap-1.5 text-[11px] font-semibold text-state-error">
          <AlertTriangleIcon className="mt-px h-3 w-3 shrink-0" />
          {error || 'El mínimo no puede ser mayor que el máximo.'}
        </p>
      }

      {/* La descripción es para el operario, no para el que configura: sale en
          el Inspector del Diseñador y en el aviso del widget. */}
      {!error && !alReves &&
      <p className="mt-2 text-[11px] leading-relaxed text-slate-400">
          Deja los topes vacíos para no poner límite. La descripción se verá en
          el Diseñador al enlazar un widget con este tag.
        </p>
      }
    </div>);

}

// ── Panel ────────────────────────────────────────────────────────

export function PanelEscritura({ plcs, onEstado, buscaInicial = '' }: Props) {
  const [plcId, setPlcId] = useState('');
  const [lista, setLista] = useState<TagCandidato[]>([]);
  const [soporta, setSoporta] = useState(true);
  const [cargando, setCargando] = useState(false);
  const [error, setError] = useState('');
  const [sinPermiso, setSinPermiso] = useState(false);

  const [busca, setBusca] = useState(buscaInicial);
  const [soloActivos, setSoloActivos] = useState(false);

  /** Tag cuyo formulario está abierto. Solo uno a la vez, a propósito. */
  const [editando, setEditando] = useState<string | null>(null);
  const [guardando, setGuardando] = useState('');
  const [errorFila, setErrorFila] = useState('');

  // El primer PLC en cuanto se sepa cuáles hay. Con uno solo —el caso normal—
  // la pantalla llega ya cargada y no hay que elegir nada.
  useEffect(() => {
    if (!plcId && plcs.length) setPlcId(plcs[0].id);
  }, [plcs, plcId]);

  const cargar = useCallback(async (id: string) => {
    if (!id) return;
    setCargando(true);
    setError('');
    setSinPermiso(false);
    try {
      const d = await pedirCandidatos(id);
      setLista(d.candidatos ?? []);
      setSoporta(d.soporta_escritura !== false);
    } catch (e: any) {
      // El 403 es el caso previsible, no una avería: el endpoint pide rol
      // `Administradores`. Merece su propio mensaje y no un error rojo.
      if (e?.status === 403) {
        setSinPermiso(true);
        setLista([]);
      } else {
        setError(e?.message ?? 'No se pudieron leer los tags de este PLC.');
        setLista([]);
      }
    } finally {
      setCargando(false);
    }
  }, []);

  useEffect(() => {
    void cargar(plcId);
  }, [plcId, cargar]);

  const habilitados = useMemo(() => lista.filter((c) => c.habilitado).length, [lista]);

  useEffect(() => {
    onEstado?.({ habilitados, candidatos: lista.length });
  }, [habilitados, lista.length, onEstado]);

  const filtrados = useMemo(() => {
    const q = busca.trim().toLowerCase();
    return lista.filter((c) => {
      if (soloActivos && !c.habilitado) return false;
      if (!q) return true;
      return (
        c.tag.toLowerCase().includes(q) ||
        c.db_name?.toLowerCase().includes(q) ||
        c.descripcion?.toLowerCase().includes(q));

    });
  }, [lista, busca, soloActivos]);

  const visibles = filtrados.slice(0, TOPE_FILAS);

  /**
   * Alta o cambio de límites.
   *
   * Se recarga la lista entera en vez de parchear la fila en memoria: el
   * servidor normaliza lo que se le manda (recorta la descripción, ajusta
   * tipos) y quedarse con lo que YO creía haber guardado es cómo se acaba
   * enseñando una cosa distinta de la que hay.
   */
  const guardar = async (
  cand: TagCandidato,
  v: {minimo: number | null;maximo: number | null;descripcion: string;}) =>
  {
    setGuardando(cand.tag);
    setErrorFila('');
    try {
      await habilitarTag({ plc_id: plcId, tag: cand.tag, ...v });
      setEditando(null);
      await cargar(plcId);
    } catch (e: any) {
      setErrorFila(e?.message ?? 'El servidor rechazó el alta.');
    } finally {
      setGuardando('');
    }
  };

  /** Baja. Un clic y fuera: quitar permisos nunca necesita confirmación. */
  const quitar = async (cand: TagCandidato) => {
    setGuardando(cand.tag);
    setErrorFila('');
    try {
      await deshabilitarTag(plcId, cand.tag);
      if (editando === cand.tag) setEditando(null);
      await cargar(plcId);
    } catch (e: any) {
      setErrorFila(e?.message ?? 'No se pudo quitar de la lista.');
    } finally {
      setGuardando('');
    }
  };

  // ── Estados que no son «hay tabla que dibujar» ─────────────────

  if (!plcs.length) {
    return (
      <div className="rounded-xl border border-dashed border-slate-300 py-12 text-center dark:border-navy-slate">
        <p className="text-sm font-semibold text-slate-500">
          No hay ningún controlador configurado.
        </p>
        <p className="mt-1 text-xs text-slate-400">
          Agrega un PLC en «Conexión PLC» y vuelve aquí.
        </p>
      </div>);

  }

  return (
    <div className="space-y-4">
      {/* ── EL AVISO QUE MÁS VALE ─────────────────────────────────
          Va arriba y siempre, no detrás de un icono de ayuda: es la decisión
          que se toma en esta pantalla, y el error caro se comete antes de
          leer nada. */}
      <div className="flex items-start gap-3 rounded-xl border border-state-warn/30 bg-state-warn/[0.07] px-4 py-3">
        <ShieldCheckIcon className="mt-0.5 h-4 w-4 shrink-0 text-state-warn" />
        <div className="min-w-0 text-[12px] leading-relaxed text-slate-600 dark:text-slate-300">
          <p className="font-semibold text-state-warn">
            Habilita solo lo que el programa del PLC NO escriba.
          </p>
          <p className="mt-0.5">
            Consignas, comandos y modos son del HMI. Medidas, estados y valores
            calculados los gobierna el autómata: si el programa les asigna algo
            en cada ciclo, tu valor dura milisegundos y en ese ciclo otra parte
            del programa puede leerlo.
          </p>
        </div>
      </div>

      {/* ── Barra: PLC, buscador, filtro, recargar ─────────────── */}
      <div className="flex flex-wrap items-center gap-2">
        {/* Con un solo PLC no hay nada que elegir: se enseña cuál es y ya. */}
        {plcs.length > 1 ?
        <select
          value={plcId}
          onChange={(e) => {
            setPlcId(e.target.value);
            setEditando(null);
          }}
          className="rounded-lg border border-slate-200 bg-white px-2.5 py-2 text-xs font-semibold text-navy outline-none transition focus:border-siemens focus:ring-2 focus:ring-siemens/20 dark:border-navy-slate dark:bg-navy-soft dark:text-slate-100">
            {plcs.map((p) =>
          <option key={p.id} value={p.id}>
                {p.nombre} {p.conectado ? '' : '· sin conexión'}
              </option>
          )}
          </select> :

        <span className="rounded-lg bg-slate-100 px-2.5 py-2 text-xs font-semibold text-slate-500 dark:bg-navy dark:text-slate-400">
            {plcs[0].nombre}
          </span>
        }

        <div className="relative min-w-[12rem] flex-1">
          <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
          <input
            value={busca}
            onChange={(e) => setBusca(e.target.value)}
            placeholder="Buscar por tag, bloque o descripción…"
            className="w-full rounded-lg border border-slate-200 bg-white py-2 pl-8 pr-2.5 text-xs text-navy outline-none transition placeholder:text-slate-300 focus:border-siemens focus:ring-2 focus:ring-siemens/20 dark:border-navy-slate dark:bg-navy-soft dark:text-slate-100" />

        </div>

        {/* Con cientos de candidatos, «enséñame solo lo que ya di de alta» es
            la pregunta que más se repite: revisar qué está abierto. */}
        <button
          type="button"
          onClick={() => setSoloActivos((v) => !v)}
          className={`flex items-center gap-1.5 rounded-lg px-2.5 py-2 text-xs font-semibold transition ${
          soloActivos ?
          'bg-siemens/10 text-siemens ring-1 ring-siemens/25' :
          'text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-navy-slate/40'}`
          }>
          <CheckIcon className="h-3.5 w-3.5" />
          Solo habilitados
        </button>

        <button
          type="button"
          onClick={() => void cargar(plcId)}
          disabled={cargando}
          title="Volver a leer los tags de este PLC"
          aria-label="Recargar"
          className="flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 transition hover:bg-slate-100 hover:text-siemens disabled:opacity-40 dark:hover:bg-navy-slate/40">
          <RefreshCwIcon className={`h-4 w-4 ${cargando ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {/* El driver no sabe escribir: nada de lo de abajo va a funcionar, y hay
          que decirlo antes de que alguien dé de alta veinte tags. */}
      {!soporta && !sinPermiso &&
      <p className="flex items-start gap-2 rounded-lg bg-state-error/10 px-3 py-2 text-xs font-semibold text-state-error">
          <AlertTriangleIcon className="mt-px h-3.5 w-3.5 shrink-0" />
          El driver de este controlador no sabe escribir. Puedes dar de alta
          tags, pero toda escritura se rechazará.
        </p>
      }

      {errorFila &&
      <p className="flex items-start gap-2 rounded-lg bg-state-error/10 px-3 py-2 text-xs font-semibold text-state-error">
          <AlertTriangleIcon className="mt-px h-3.5 w-3.5 shrink-0" />
          {errorFila}
        </p>
      }

      {/* ── Resumen ────────────────────────────────────────────── */}
      {!sinPermiso && !error &&
      <p className="text-[11.5px] text-slate-400">
          <span className="font-bold text-siemens tabular-nums">{habilitados}</span>
          {' '}habilitado{habilitados === 1 ? '' : 's'} de{' '}
          <span className="tabular-nums">{lista.length}</span> tag
          {lista.length === 1 ? '' : 's'} escribible
          {lista.length === 1 ? '' : 's'}
          {busca || soloActivos ?
        <> · <span className="tabular-nums">{filtrados.length}</span> en el filtro</> :
        null}
        </p>
      }

      {/* ── Contenido ──────────────────────────────────────────── */}
      {sinPermiso ?
      <div className="rounded-xl border border-dashed border-slate-300 py-12 text-center dark:border-navy-slate">
          <ShieldCheckIcon className="mx-auto mb-3 h-8 w-8 text-slate-300" />
          <p className="text-sm font-semibold text-slate-500">
            Necesitas rol «Administradores»
          </p>
          <p className="mx-auto mt-1 max-w-md text-xs leading-relaxed text-slate-400">
            Decidir en qué se puede escribir mueve cosas en la planta, así que
            el servidor lo reserva a ese rol. Puedes seguir viendo el resto de
            la configuración.
          </p>
        </div> :
      error ?
      <div className="rounded-xl border border-dashed border-state-error/40 py-12 text-center">
          <AlertTriangleIcon className="mx-auto mb-3 h-8 w-8 text-state-error/60" />
          <p className="text-sm font-semibold text-state-error">{error}</p>
          <button
          type="button"
          onClick={() => void cargar(plcId)}
          className="mt-3 rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-500 transition hover:bg-slate-50 dark:border-navy-slate dark:hover:bg-navy-slate/40">
            Reintentar
          </button>
        </div> :
      cargando && !lista.length ?
      <div className="py-16 text-center">
          <Loader2Icon className="mx-auto h-6 w-6 animate-spin text-siemens" />
          <p className="mt-3 text-xs text-slate-400">Leyendo los tags del PLC…</p>
        </div> :
      !lista.length ?
      <div className="rounded-xl border border-dashed border-slate-300 py-12 text-center dark:border-navy-slate">
          <p className="text-sm font-semibold text-slate-500">
            Este controlador no tiene tags escribibles.
          </p>
          <p className="mx-auto mt-1 max-w-md text-xs leading-relaxed text-slate-400">
            Estructuras, arrays y binarios quedan fuera a propósito. Si esperabas
            ver alguno, comprueba que el PLC esté conectado y que sus tags estén
            cargados.
          </p>
        </div> :
      !filtrados.length ?
      // Sin resultados NO es lo mismo que sin tags, y la salida es distinta:
      // aquí lo que hay que hacer es limpiar el filtro.
      <div className="rounded-xl border border-dashed border-slate-300 py-12 text-center dark:border-navy-slate">
          <p className="text-sm font-semibold text-slate-500">
            Ningún tag coincide con el filtro.
          </p>
          <button
          type="button"
          onClick={() => {
            setBusca('');
            setSoloActivos(false);
          }}
          className="mt-3 rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-500 transition hover:bg-slate-50 dark:border-navy-slate dark:hover:bg-navy-slate/40">
            Limpiar filtro
          </button>
        </div> :

      <div className="overflow-hidden rounded-xl border border-slate-200 dark:border-navy-slate">
          <div className="mp-scroll mp-scroll-dark max-h-[52vh] overflow-y-auto">
            <table className="w-full border-collapse text-xs">
              <thead className="sticky top-0 z-10">
                <tr>
                  <th
                  scope="col"
                  className="whitespace-nowrap border-b border-slate-200 bg-slate-50 px-4 py-2.5 text-left text-[10px] font-bold uppercase tracking-wider text-slate-400 dark:border-navy-slate dark:bg-navy">
                    Tag
                  </th>
                  <th
                  scope="col"
                  className="hidden whitespace-nowrap border-b border-slate-200 bg-slate-50 px-4 py-2.5 text-left text-[10px] font-bold uppercase tracking-wider text-slate-400 sm:table-cell dark:border-navy-slate dark:bg-navy">
                    Tipo
                  </th>
                  <th
                  scope="col"
                  className="hidden whitespace-nowrap border-b border-slate-200 bg-slate-50 px-4 py-2.5 text-left text-[10px] font-bold uppercase tracking-wider text-slate-400 lg:table-cell dark:border-navy-slate dark:bg-navy">
                    Bloque
                  </th>
                  <th
                  scope="col"
                  className="whitespace-nowrap border-b border-slate-200 bg-slate-50 px-4 py-2.5 text-left text-[10px] font-bold uppercase tracking-wider text-slate-400 dark:border-navy-slate dark:bg-navy">
                    Límites
                  </th>
                  <th
                  scope="col"
                  className="w-24 whitespace-nowrap border-b border-slate-200 bg-slate-50 px-4 py-2.5 text-right text-[10px] font-bold uppercase tracking-wider text-slate-400 dark:border-navy-slate dark:bg-navy">
                    Escritura
                  </th>
                </tr>
              </thead>
              <tbody>
                {visibles.map((c) => {
                const abierto = editando === c.tag;
                const ocupado = guardando === c.tag;
                return (
                  <React.Fragment key={c.tag}>
                      <tr
                      className={`border-b border-slate-100 transition last:border-0 dark:border-navy-slate/60 ${
                      c.habilitado ?
                      'bg-siemens/[0.035]' :
                      'hover:bg-slate-50 dark:hover:bg-navy-slate/25'}`
                      }>
                        <td className="max-w-0 px-4 py-2.5">
                          <p
                          className={`truncate font-mono text-[12px] ${
                          c.habilitado ?
                          'font-semibold text-navy dark:text-slate-100' :
                          'text-slate-500 dark:text-slate-400'}`
                          }
                          title={c.tag}>
                            {c.tag}
                          </p>
                          {c.descripcion &&
                        <p
                          className="truncate text-[11px] text-slate-400"
                          title={c.descripcion}>
                              {c.descripcion}
                            </p>
                        }
                        </td>
                        <td className="hidden px-4 py-2.5 sm:table-cell">
                          <Insignia texto={c.data_type} tono="tipo" />
                        </td>
                        <td className="hidden max-w-[10rem] px-4 py-2.5 lg:table-cell">
                          {c.db_name ? <Insignia texto={c.db_name} tono="db" /> : null}
                        </td>
                        <td className="whitespace-nowrap px-4 py-2.5 text-slate-500 dark:text-slate-400">
                          {!c.habilitado ?
                        <span className="text-slate-300 dark:text-slate-600">—</span> :
                        !esNumerico(c.data_type) ?
                        <span className="text-[11px] text-slate-400">no aplica</span> :
                        c.minimo == null && c.maximo == null ?
                        <span className="text-[11px] text-slate-400">sin tope</span> :

                        <span className="font-mono text-[11.5px] tabular-nums">
                                {c.minimo ?? '−∞'} … {c.maximo ?? '+∞'}
                              </span>
                        }
                        </td>
                        <td className="px-4 py-2.5">
                          <div className="flex items-center justify-end gap-1.5">
                            {/* El lápiz solo aparece en lo ya habilitado: en lo
                                demás no hay límites que cambiar todavía. */}
                            {c.habilitado &&
                          <button
                            type="button"
                            onClick={() => setEditando(abierto ? null : c.tag)}
                            title="Cambiar límites o descripción"
                            aria-label="Editar límites"
                            className="rounded p-1 text-slate-400 transition hover:bg-slate-100 hover:text-siemens dark:hover:bg-navy-slate/40">
                                {abierto ?
                            <XIcon className="h-3.5 w-3.5" /> :
                            <PencilIcon className="h-3.5 w-3.5" />}
                              </button>
                          }
                            {ocupado ?
                          <Loader2Icon className="h-4 w-4 animate-spin text-siemens" /> :

                          <Interruptor
                            activo={c.habilitado}
                            ocupado={!!guardando}
                            titulo={
                            c.habilitado ?
                            `Quitar «${c.tag}» de la lista blanca` :
                            `Habilitar «${c.tag}» para escritura`
                            }
                            onClick={() => {
                              if (c.habilitado) void quitar(c);else
                              {
                                setErrorFila('');
                                setEditando(abierto ? null : c.tag);
                              }
                            }} />

                          }
                          </div>
                        </td>
                      </tr>

                      {abierto &&
                    <tr>
                          <td colSpan={5} className="p-0">
                            <FormularioAlta
                          cand={c}
                          guardando={ocupado}
                          error={errorFila}
                          onCancelar={() => {
                            setEditando(null);
                            setErrorFila('');
                          }}
                          onGuardar={(v) => void guardar(c, v)} />

                          </td>
                        </tr>
                    }
                    </React.Fragment>);

              })}
              </tbody>
            </table>
          </div>

          {filtrados.length > TOPE_FILAS &&
        <p className="border-t border-slate-200 bg-slate-50 px-4 py-2 text-[11px] text-slate-400 dark:border-navy-slate dark:bg-navy">
              Se enseñan {TOPE_FILAS} de {filtrados.length}. Afina la búsqueda
              para ver el resto.
            </p>
        }
        </div>
      }
    </div>);

}
