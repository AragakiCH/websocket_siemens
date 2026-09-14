// =========================================================================
// Simbolo.tsx
// Un símbolo de la biblioteca: una válvula, una bomba, un tanque.
//
// QUÉ APORTA FRENTE A DIBUJARLO
// Un sinóptico de planta son treinta o cuarenta equipos. Dibujarlos uno a uno
// con rectángulos y círculos del Diseñador es una tarde por pantalla y el
// resultado no se parece a lo que el operario espera ver. Aquí se elige de
// una rejilla, se le pone el rótulo y ya está.
//
// COLOR Y ROTACIÓN
// La rotación no la hace este widget: la aplica `WidgetRenderer` a todos por
// igual con `style.rotation`, así que un símbolo gira como cualquier otra
// cosa del lienzo — y con una dinámica, por variable.
//
// El color se hace girando el TONO del símbolo hasta el elegido. Suena raro y
// es lo correcto: así los grises metálicos no se tocan (un giro de tono no
// altera lo que no tiene color) y sólo cambia el cuerpo. Repintando figura a
// figura habría que decidir cuáles son «el cuerpo» de cada uno de los miles
// de símbolos, y eso no se acierta.
//
// EL RÓTULO
// Se puede poner y se puede quitar. Va debajo y se estiliza en
// Apariencia → Texto, como el de cualquier otro widget. Al elegir un símbolo
// se rellena con su nombre, que es lo que uno escribiría; se cambia o se
// apaga con un clic.
// =========================================================================
import { useEffect, useMemo, useState } from 'react';
import { ShapesIcon } from 'lucide-react';
import type { CustomWidgetDef, RenderCtx, InspectorCtx } from '../types';
import { estiloDeParte } from '../../partes';
import {
  CATALOGOS,
  cargarCatalogo,
  catalogoCargado,
  filtroTinte,
  svgAjustado,
  type Simbolo as Pieza,
} from './tipos';

// ─── Config ──────────────────────────────────────────────────────

export interface ConfigSimbolo {
  catalogo: string;
  simbolo: string;
  /** `''` = con sus colores originales. */
  color: string;
  label: string;
  mostrarLabel: boolean;
}

export const CONFIG_SIMBOLO: ConfigSimbolo = {
  catalogo: 'valvulas',
  simbolo: '',
  color: '',
  label: '',
  mostrarLabel: true,
};

export function leerConfigSimbolo(config: any): ConfigSimbolo {
  const c = config ?? {};
  return {
    catalogo: typeof c.catalogo === 'string' && c.catalogo ? c.catalogo : 'valvulas',
    simbolo: typeof c.simbolo === 'string' ? c.simbolo : '',
    color: typeof c.color === 'string' ? c.color : '',
    label: typeof c.label === 'string' ? c.label : '',
    // Ausente = sí. Un símbolo colocado antes de que existiera el rótulo no
    // tiene texto que enseñar, así que no cambia nada; y para uno nuevo es
    // mejor verlo y quitarlo que no saber que existe.
    mostrarLabel: c.mostrarLabel !== false,
  };
}

/** El símbolo elegido, cargando su catálogo la primera vez que hace falta. */
function usePieza(catalogo: string, id: string): { pieza?: Pieza; cargando: boolean } {
  const ya = catalogoCargado(catalogo);
  const [lista, setLista] = useState<Pieza[] | undefined>(ya);

  useEffect(() => {
    let vivo = true;
    if (catalogoCargado(catalogo)) {
      setLista(catalogoCargado(catalogo));
      return;
    }
    setLista(undefined);
    cargarCatalogo(catalogo).then((l) => {
      if (vivo) setLista(l);
    });
    return () => {
      vivo = false;
    };
  }, [catalogo]);

  return {
    pieza: lista?.find((s) => s.id === id),
    cargando: lista === undefined,
  };
}

// ─── Dibujo ──────────────────────────────────────────────────────

function Aviso({ texto }: { texto: string }) {
  return (
    <div
      style={{
        display: 'flex',
        height: '100%',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 8,
        textAlign: 'center',
        fontSize: 11,
        lineHeight: 1.4,
        color: 'rgba(100,116,139,0.95)',
      }}>

      {texto}
    </div>);

}

function Simbolo({ widget }: RenderCtx) {
  const cfg = leerConfigSimbolo(widget.config);
  const { pieza, cargando } = usePieza(cfg.catalogo, cfg.simbolo);
  const pTexto = estiloDeParte(widget, 'label');

  const dibujo = useMemo(
    () => (pieza ? svgAjustado(pieza.svg) : ''),
    [pieza]
  );
  const filtro = pieza ? filtroTinte(pieza.hue, cfg.color) : '';
  const rotulo = cfg.mostrarLabel ? cfg.label.trim() : '';

  if (!cfg.simbolo) {
    return <Aviso texto="Elige un símbolo en las propiedades." />;
  }
  if (cargando) {
    return <Aviso texto="Cargando…" />;
  }
  if (!pieza) {
    return <Aviso texto={`El símbolo «${cfg.simbolo}» ya no está en la biblioteca.`} />;
  }

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        width: '100%',
        height: '100%',
        boxSizing: 'border-box',
        overflow: 'hidden',
      }}>

      <div
        style={{ flex: 1, minHeight: 0, filter: filtro || undefined }}
        // El SVG sale de nuestro propio catálogo generado, no de nada que
        // haya escrito un usuario.
        dangerouslySetInnerHTML={{ __html: dibujo }} />


      {!!rotulo &&
      <div
        style={{
          flexShrink: 0,
          paddingTop: 2,
          fontSize: pTexto.fontSize,
          fontWeight: pTexto.bold ? 700 : 500,
          color: pTexto.color,
          textAlign: pTexto.align,
          fontFamily: 'Inter, Arial, sans-serif',
          lineHeight: 1.2,
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}>

          {rotulo}
        </div>
      }
    </div>);

}

// ─── Panel del Inspector ─────────────────────────────────────────

const CAMPO =
'w-full rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-navy outline-none transition focus:border-siemens focus:ring-2 focus:ring-siemens/20 dark:border-navy-slate dark:bg-navy dark:text-slate-100';

function InspectorSimbolo({ config, setConfig }: InspectorCtx) {
  const cfg = leerConfigSimbolo(config);
  const [lista, setLista] = useState<Pieza[]>(() => catalogoCargado(cfg.catalogo) ?? []);
  const [cargando, setCargando] = useState(!catalogoCargado(cfg.catalogo));
  const [busca, setBusca] = useState('');

  useEffect(() => {
    let vivo = true;
    setCargando(!catalogoCargado(cfg.catalogo));
    cargarCatalogo(cfg.catalogo).then((l) => {
      if (!vivo) return;
      setLista(l);
      setCargando(false);
    });
    return () => {
      vivo = false;
    };
  }, [cfg.catalogo]);

  const filtrados = useMemo(() => {
    const q = busca.trim().toLowerCase();
    if (!q) return lista;
    return lista.filter((s) => s.nombre.toLowerCase().includes(q));
  }, [lista, busca]);

  const elegido = lista.find((s) => s.id === cfg.simbolo);

  const elegir = (s: Pieza) =>
  setConfig({
    ...cfg,
    simbolo: s.id,
    // El rótulo se estrena con el nombre del símbolo, que es lo que uno
    // iba a escribir. Sólo si estaba vacío: si ya había uno puesto a mano,
    // cambiar de símbolo no tiene por qué borrarlo.
    label: cfg.label.trim() ? cfg.label : s.nombre,
  });

  return (
    <>
      <label className="block">
        <span className="mb-1 block text-xs font-medium text-slate-500 dark:text-slate-400">
          Catálogo
        </span>
        <select
          value={cfg.catalogo}
          onChange={(e) => setConfig({ ...cfg, catalogo: e.target.value, simbolo: '' })}
          className={`${CAMPO} cursor-pointer`}>

          {CATALOGOS.map((c) =>
          <option key={c.id} value={c.id}>
              {c.titulo}
            </option>
          )}
        </select>
      </label>

      <label className="block">
        <span className="mb-1 flex items-baseline justify-between gap-2">
          <span className="text-xs font-medium text-slate-500 dark:text-slate-400">
            Símbolo
          </span>
          <span className="text-[10px] text-slate-400">
            {cargando ? 'cargando…' : `${filtrados.length} de ${lista.length}`}
          </span>
        </span>
        <input
          value={busca}
          onChange={(e) => setBusca(e.target.value)}
          placeholder="Buscar: ball, check, safety…"
          className={CAMPO} />

      </label>

      {/* La rejilla. Se elige mirando, no leyendo una lista de nombres en
          inglés de 2002: con setenta y tres válvulas, el nombre no basta. */}
      <div className="grid max-h-64 grid-cols-4 gap-1 overflow-auto rounded-lg border border-slate-200 p-1 dark:border-navy-slate">
        {filtrados.map((s) =>
        <button
          key={s.id}
          onClick={() => elegir(s)}
          title={s.nombre}
          className={`flex aspect-square items-center justify-center rounded-md border p-1 transition ${
          s.id === cfg.simbolo ?
          'border-siemens bg-siemens/10' :
          'border-transparent hover:bg-slate-100 dark:hover:bg-navy-slate'}`
          }>

            <span
            className="h-full w-full"
            dangerouslySetInnerHTML={{ __html: svgAjustado(s.svg) }} />

          </button>
        )}
        {!cargando && filtrados.length === 0 &&
        <p className="col-span-4 p-3 text-center text-[11px] text-slate-400">
            Ninguno se llama así.
          </p>
        }
      </div>

      {/* ── Color ──────────────────────────────────────────────── */}
      <label className="block">
        <span className="mb-1 block text-xs font-medium text-slate-500 dark:text-slate-400">
          Color
        </span>
        <div className="flex items-center gap-2">
          <input
            type="color"
            value={cfg.color || '#0099cc'}
            onChange={(e) => setConfig({ ...cfg, color: e.target.value })}
            className="h-7 w-10 cursor-pointer rounded border border-slate-200 bg-white dark:border-navy-slate" />

          <button
            onClick={() => setConfig({ ...cfg, color: '' })}
            className="rounded-lg border border-slate-200 px-2 py-1 text-[11px] text-slate-500 transition hover:bg-slate-100 dark:border-navy-slate dark:hover:bg-navy-slate">

            Colores originales
          </button>
        </div>
        <span className="mt-1 block text-[10px] leading-relaxed text-slate-400">
          {elegido && elegido.hue === null ?
          'Este símbolo es gris metálico: no tiene color que cambiar.' :
          'Gira el tono del símbolo. Los grises metálicos no se tocan.'}
        </span>
      </label>

      {/* ── Rótulo ─────────────────────────────────────────────── */}
      <label className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-slate-500 dark:text-slate-400">
          Mostrar rótulo
        </span>
        <input
          type="checkbox"
          checked={cfg.mostrarLabel}
          onChange={(e) => setConfig({ ...cfg, mostrarLabel: e.target.checked })}
          className="h-4 w-4 rounded border-slate-300 text-siemens focus:ring-2 focus:ring-siemens/40 dark:border-navy-slate dark:bg-navy" />

      </label>

      {cfg.mostrarLabel &&
      <input
        value={cfg.label}
        onChange={(e) => setConfig({ ...cfg, label: e.target.value })}
        placeholder="V-101"
        className={CAMPO} />

      }

      <div className="rounded-lg bg-slate-100 px-2.5 py-2 text-[11px] leading-relaxed text-slate-500 dark:bg-navy-slate/40 dark:text-slate-400">
        El rótulo se estiliza en <b>Apariencia → Texto</b>, y el símbolo gira
        con <b>Geometría → Rotación</b>. Las dos cosas se pueden atar a una
        variable desde <b>Dinámicas</b>.
      </div>
    </>);

}

// ─── Definición ──────────────────────────────────────────────────

export const simbolo: CustomWidgetDef = {
  kind: 'custom:simbolo',
  label: 'Símbolo',
  category: 'Equipos',
  icon: ShapesIcon,
  defaultWidth: 120,
  defaultHeight: 120,
  render: (ctx) => <Simbolo {...ctx} />,
  inspector: (ctx) => <InspectorSimbolo {...ctx} />,
  defaultConfig: CONFIG_SIMBOLO,
};
