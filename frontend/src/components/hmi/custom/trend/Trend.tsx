// =========================================================================
// Trend.tsx
// Tendencia en vivo: varias variables numéricas dibujadas contra el tiempo.
//
// POR QUÉ NO USA UNA LIBRERÍA DE GRÁFICOS
// El proyecto no tenía ninguna, y para una tendencia EN VIVO una librería de
// propósito general es peor negocio de lo que parece: Recharts vuelve a
// dibujar su árbol de componentes en cada dato, y con el refresco a 100 ms que
// permite Configuración se entrecorta. Aquí se dibuja un `<polyline>` por
// serie, que es una cadena de texto que el navegador pinta de un tirón.
// Además evita sumar ~500 KB al ejecutable por un solo widget.
//
// DE DÓNDE SALEN LOS DATOS
// De las variables que ya llegan por WebSocket. El widget se queda con los
// últimos N segundos en memoria, como un osciloscopio: nada se guarda en disco
// ni en la base de datos, y al recargar la página empieza de cero. Eso es lo
// normal en una tendencia en vivo — para mirar el pasado está el historizador.
//
// POR QUÉ LEE EL STORE DIRECTAMENTE
// `RenderCtx` trae UNA variable, la del campo «Variable asociada». Un trend
// necesita varias, así que se salta ese campo y guarda su propia lista en
// `config.series`. Como es un componente de React dentro del árbol de la app,
// puede pedirle al AppStore todas las variables.
// =========================================================================
import { useEffect, useMemo, useRef, useState } from 'react';
import { LineChartIcon, PlusIcon, Trash2Icon, ActivityIcon } from 'lucide-react';
import type { CustomWidgetDef, RenderCtx, InspectorCtx } from '../types';
import { useAppStore } from '../../../../context/AppStore';
import { estiloDeParte } from '../../partes';
import { colorSerie, MAX_SERIES } from './paleta';

// ─── Config ──────────────────────────────────────────────────────

export interface SerieTrend {
  /** Id estable de la fila. No es el de la variable: así renombrar o
   *  reasignar la variable no pierde el color ni el orden. */
  id: string;
  variableId: string;
  /** Vacío = se usa el nombre de la variable. */
  etiqueta: string;
}

export interface ConfigTrend {
  series: SerieTrend[];
  /** Ancho de la ventana, en segundos. */
  ventanaSeg: number;
  mostrarLeyenda: boolean;
  mostrarRejilla: boolean;
  /** Autoescala el eje Y a lo que haya en pantalla. */
  autoEscala: boolean;
  min: string;
  max: string;
}

export const CONFIG_TREND: ConfigTrend = {
  series: [],
  ventanaSeg: 60,
  mostrarLeyenda: true,
  mostrarRejilla: true,
  autoEscala: true,
  min: '',
  max: '',
};

export function leerConfigTrend(config: any): ConfigTrend {
  const c = config ?? {};
  return {
    series: Array.isArray(c.series) ? c.series : [],
    ventanaSeg: Number(c.ventanaSeg) > 0 ? Number(c.ventanaSeg) : 60,
    mostrarLeyenda: c.mostrarLeyenda !== false,
    mostrarRejilla: c.mostrarRejilla !== false,
    autoEscala: c.autoEscala !== false,
    min: typeof c.min === 'string' ? c.min : '',
    max: typeof c.max === 'string' ? c.max : '',
  };
}

const nuevoId = () => `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

// ─── Muestreo ────────────────────────────────────────────────────

interface Muestra {
  t: number;
  v: number;
}

/**
 * Guarda los últimos `ventanaSeg` segundos de cada variable.
 *
 * El búfer vive en un ref y no en el estado: mutarlo no puede provocar un
 * render, y el redibujado lo dispara el propio cambio de `variables`. Si
 * fuera estado, cada muestra sería un `setState` y a 100 ms serían diez por
 * segundo por variable, todos redibujando el widget entero.
 */
function useMuestreo(ids: string[], ventanaSeg: number) {
  const { variables } = useAppStore();
  const buffer = useRef<Map<string, Muestra[]>>(new Map());
  const [, redibujar] = useState(0);

  useEffect(() => {
    const ahora = Date.now();
    const desde = ahora - ventanaSeg * 1000;
    let hubo = false;

    for (const id of ids) {
      const v = variables.find((x) => x.id === id);
      if (!v) continue;
      const num = typeof v.value === 'number' ? v.value : Number(v.value);
      if (!Number.isFinite(num)) continue;

      const lista = buffer.current.get(id) ?? [];
      lista.push({ t: ahora, v: num });

      // Fuera lo que se salió de la ventana. Sin esto el array crece sin
      // límite y a 100 ms son 36.000 puntos por hora y por variable.
      let corte = 0;
      while (corte < lista.length && lista[corte].t < desde) corte++;
      buffer.current.set(id, corte > 0 ? lista.slice(corte) : lista);
      hubo = true;
    }

    // Variables que ya no están en ninguna serie: se olvidan.
    for (const k of Array.from(buffer.current.keys())) {
      if (!ids.includes(k)) buffer.current.delete(k);
    }

    if (hubo) redibujar((n) => n + 1);
  }, [variables, ids.join('|'), ventanaSeg]);

  return buffer.current;
}

// ─── Dibujo ──────────────────────────────────────────────────────

/** Números redondos para las marcas del eje: 1, 2, 5, 10, 20, 50… */
function pasoBonito(rango: number, divisiones: number): number {
  if (rango <= 0) return 1;
  const crudo = rango / divisiones;
  const magnitud = Math.pow(10, Math.floor(Math.log10(crudo)));
  const norm = crudo / magnitud;
  const paso = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
  return paso * magnitud;
}

function fmtNum(n: number): string {
  if (!Number.isFinite(n)) return '—';
  const abs = Math.abs(n);
  if (abs >= 1000) return n.toFixed(0);
  if (abs >= 10) return n.toFixed(1);
  return n.toFixed(2);
}

function Trend({ widget }: RenderCtx) {
  const cfg = leerConfigTrend(widget.config);
  const { variables, isDark } = useAppStore();

  const pCaja = estiloDeParte(widget, 'box');
  const pRejilla = estiloDeParte(widget, 'icon');
  const pTexto = estiloDeParte(widget, 'label');

  const ids = useMemo(
    () => cfg.series.map((s) => s.variableId).filter(Boolean),
    [cfg.series]
  );
  const buffer = useMuestreo(ids, cfg.ventanaSeg);

  const tinta = pTexto.color ?? (isDark ? '#94a3b8' : '#64748b');
  const rejilla = pRejilla.color ?? (isDark ? 'rgba(148,163,184,0.18)' : 'rgba(148,163,184,0.28)');
  const fondo =
    pCaja.background && pCaja.background !== 'transparent'
      ? pCaja.background
      : isDark
      ? '#0f172a'
      : '#ffffff';

  // Escala vertical. Con autoescala se mira solo lo que hay en pantalla, que
  // es lo que hace útil una tendencia: si el proceso se mueve entre 12.0 y
  // 12.4, se quiere ver ESE movimiento, no una línea plana en un eje 0-100.
  const ahora = Date.now();
  const desde = ahora - cfg.ventanaSeg * 1000;

  let yMin = Number(cfg.min);
  let yMax = Number(cfg.max);
  if (cfg.autoEscala || !Number.isFinite(yMin) || !Number.isFinite(yMax)) {
    let lo = Infinity;
    let hi = -Infinity;
    for (const id of ids) {
      for (const m of buffer.get(id) ?? []) {
        if (m.v < lo) lo = m.v;
        if (m.v > hi) hi = m.v;
      }
    }
    if (!Number.isFinite(lo)) {
      lo = 0;
      hi = 1;
    }
    if (lo === hi) {
      // Una señal constante dejaría un rango de cero y una división por cero.
      const d = Math.abs(lo) > 1 ? Math.abs(lo) * 0.1 : 0.5;
      lo -= d;
      hi += d;
    }
    const aire = (hi - lo) * 0.12;
    yMin = lo - aire;
    yMax = hi + aire;
  }

  // Lienzo interno en coordenadas fijas: el SVG escala solo al tamaño del
  // widget, así que el trend se ve igual pequeño que grande.
  const W = 1000;
  const H = 400;
  const mIzq = 54;
  const mDer = 10;
  const mArr = 10;
  const mAba = 22;
  const gw = W - mIzq - mDer;
  const gh = H - mArr - mAba;

  const px = (t: number) => mIzq + ((t - desde) / (cfg.ventanaSeg * 1000)) * gw;
  const py = (v: number) => mArr + (1 - (v - yMin) / (yMax - yMin)) * gh;

  const paso = pasoBonito(yMax - yMin, 4);
  const marcas: number[] = [];
  for (let v = Math.ceil(yMin / paso) * paso; v <= yMax; v += paso) marcas.push(v);

  const sinSeries = cfg.series.length === 0;

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        width: '100%',
        height: '100%',
        boxSizing: 'border-box',
        overflow: 'hidden',
        background: fondo,
        borderRadius: pCaja.borderRadius,
        border: pCaja.borderWidth
          ? `${pCaja.borderWidth}px solid ${pCaja.borderColor}`
          : `1px solid ${rejilla}`,
        opacity: pCaja.opacity,
        fontFamily: 'Inter, Arial, sans-serif',
      }}
    >
      {sinSeries ? (
        <div
          style={{
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 6,
            color: tinta,
            padding: 12,
            textAlign: 'center',
          }}
        >
          <ActivityIcon style={{ width: 22, height: 22, opacity: 0.5 }} />
          <p style={{ margin: 0, fontSize: 11, lineHeight: 1.5, opacity: 0.8 }}>
            Agrega variables en el Inspector para verlas graficadas.
          </p>
        </div>
      ) : (
        <>
          <svg
            viewBox={`0 0 ${W} ${H}`}
            preserveAspectRatio="none"
            style={{ flex: 1, width: '100%', minHeight: 0, display: 'block' }}
          >
            {/* Rejilla y valores del eje. Recesiva a propósito: es referencia,
                no dato — si compite con las líneas, estorba. */}
            {cfg.mostrarRejilla &&
              marcas.map((v) => (
                <g key={v}>
                  <line
                    x1={mIzq}
                    x2={W - mDer}
                    y1={py(v)}
                    y2={py(v)}
                    stroke={rejilla}
                    strokeWidth={1}
                    vectorEffect="non-scaling-stroke"
                  />
                  <text
                    x={mIzq - 8}
                    y={py(v)}
                    textAnchor="end"
                    dominantBaseline="middle"
                    fill={tinta}
                    style={{ fontSize: 18, opacity: 0.75 }}
                  >
                    {fmtNum(v)}
                  </text>
                </g>
              ))}

            {/* Eje del tiempo: relativo al ahora, que es lo que importa en
                vivo — «hace 60 s» se entiende mejor que una hora absoluta. */}
            <text x={mIzq} y={H - 5} fill={tinta} style={{ fontSize: 17, opacity: 0.6 }}>
              −{cfg.ventanaSeg}s
            </text>
            <text
              x={W - mDer}
              y={H - 5}
              textAnchor="end"
              fill={tinta}
              style={{ fontSize: 17, opacity: 0.6 }}
            >
              ahora
            </text>

            {/* Una polilínea por serie. `vectorEffect` mantiene el grosor
                real aunque el viewBox se estire: sin él, un widget ancho y
                bajo dibujaría líneas aplastadas. */}
            {cfg.series.map((s, i) => {
              const datos = buffer.get(s.variableId) ?? [];
              if (datos.length < 2) return null;
              const pts = datos
                .map((m) => `${px(m.t).toFixed(1)},${py(m.v).toFixed(1)}`)
                .join(' ');
              return (
                <polyline
                  key={s.id}
                  points={pts}
                  fill="none"
                  stroke={colorSerie(i, isDark)}
                  strokeWidth={2}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                  vectorEffect="non-scaling-stroke"
                />
              );
            })}
          </svg>

          {/* Leyenda con el VALOR ACTUAL de cada serie.
              En un HMI se mira de lejos y muchas veces sin ratón, así que un
              tooltip al pasar por encima no sirve de nada. El número visible
              al lado del nombre cumple la misma función y además es lo que
              hace legible el color: la identidad nunca depende solo del tono. */}
          {cfg.mostrarLeyenda && (
            <div
              style={{
                display: 'flex',
                flexWrap: 'wrap',
                gap: '4px 12px',
                padding: '6px 10px',
                borderTop: `1px solid ${rejilla}`,
                flexShrink: 0,
              }}
            >
              {cfg.series.map((s, i) => {
                const v = variables.find((x) => x.id === s.variableId);
                const num = v ? Number(v.value) : NaN;
                return (
                  <span
                    key={s.id}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 5,
                      fontSize: pTexto.fontSize ?? 12,
                      color: tinta,
                      minWidth: 0,
                    }}
                  >
                    <span
                      style={{
                        width: 9,
                        height: 3,
                        borderRadius: 2,
                        background: colorSerie(i, isDark),
                        flexShrink: 0,
                      }}
                    />
                    <span
                      style={{
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        opacity: 0.85,
                      }}
                    >
                      {s.etiqueta || v?.name || '—'}
                    </span>
                    <b style={{ fontVariantNumeric: 'tabular-nums' }}>
                      {fmtNum(num)}
                      {v?.unit ? ` ${v.unit}` : ''}
                    </b>
                  </span>
                );
              })}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ─── Inspector ───────────────────────────────────────────────────

const INPUT =
  'w-full rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-navy outline-none transition focus:border-siemens focus:ring-2 focus:ring-siemens/20 dark:border-navy-slate dark:bg-navy dark:text-slate-100';

function InspectorTrend({ config, setConfig }: InspectorCtx) {
  const cfg = leerConfigTrend(config);
  const { selectedVariables, isDark } = useAppStore();

  // Solo numéricas: una tendencia de un bool sería una escalera entre 0 y 1 y
  // de un texto no se puede dibujar nada.
  const numericas = selectedVariables.filter(
    (v) => v.type === 'int' || v.type === 'double'
  );

  const set = (patch: Partial<ConfigTrend>) => setConfig({ ...cfg, ...patch });

  const agregar = () => {
    const usadas = new Set(cfg.series.map((s) => s.variableId));
    const libre = numericas.find((v) => !usadas.has(v.id));
    set({
      series: [
        ...cfg.series,
        { id: nuevoId(), variableId: libre?.id ?? '', etiqueta: '' },
      ],
    });
  };

  const editar = (id: string, patch: Partial<SerieTrend>) =>
    set({ series: cfg.series.map((s) => (s.id === id ? { ...s, ...patch } : s)) });

  const borrar = (id: string) =>
    set({ series: cfg.series.filter((s) => s.id !== id) });

  const lleno = cfg.series.length >= MAX_SERIES;

  return (
    <>
      <div>
        <div className="mb-1.5 flex items-center justify-between">
          <span className="text-xs font-medium text-slate-500 dark:text-slate-400">
            Variables
          </span>
          <span className="text-[10px] text-slate-400">
            {cfg.series.length}/{MAX_SERIES}
          </span>
        </div>

        {numericas.length === 0 && (
          <p className="mb-2 rounded-lg bg-amber-50 px-2.5 py-2 text-[11px] leading-relaxed text-amber-700 dark:bg-amber-500/10 dark:text-amber-400">
            No hay variables numéricas seleccionadas. Márcalas en Configuración
            → Controladores para poder graficarlas.
          </p>
        )}

        <div className="space-y-1.5">
          {cfg.series.map((s, i) => (
            <div
              key={s.id}
              className="group flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white p-1.5 dark:border-navy-slate dark:bg-navy"
            >
              {/* El color no se elige: lo da la posición, y está validado
                  para que las seis se distingan también con daltonismo. */}
              <span
                title={`Serie ${i + 1}`}
                className="h-4 w-1.5 shrink-0 rounded-full"
                style={{ background: colorSerie(i, isDark) }}
              />
              <div className="min-w-0 flex-1 space-y-1">
                <select
                  value={s.variableId}
                  onChange={(e) => editar(s.id, { variableId: e.target.value })}
                  className={INPUT}
                >
                  <option value="">— Elegir variable —</option>
                  {numericas.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.name} ({v.type})
                    </option>
                  ))}
                </select>
                <input
                  type="text"
                  value={s.etiqueta}
                  onChange={(e) => editar(s.id, { etiqueta: e.target.value })}
                  placeholder="Nombre en la leyenda (opcional)"
                  className={`${INPUT} text-[11px]`}
                />
              </div>
              <button
                type="button"
                onClick={() => borrar(s.id)}
                title="Quitar serie"
                aria-label="Quitar serie"
                className="shrink-0 rounded p-1 text-slate-400 opacity-0 transition hover:bg-red-50 hover:text-state-error focus-visible:opacity-100 group-hover:opacity-100 dark:hover:bg-state-error/10"
              >
                <Trash2Icon className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
        </div>

        <button
          type="button"
          onClick={agregar}
          disabled={lleno}
          title={lleno ? 'Con más de seis líneas el gráfico deja de leerse' : undefined}
          className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-slate-300 py-1.5 text-xs font-semibold text-slate-500 transition hover:border-siemens hover:text-siemens disabled:cursor-not-allowed disabled:opacity-40 dark:border-navy-slate dark:text-slate-400"
        >
          <PlusIcon className="h-3.5 w-3.5" />
          Agregar variable
        </button>
      </div>

      <label className="block">
        <span className="mb-1 block text-xs font-medium text-slate-500 dark:text-slate-400">
          Ventana de tiempo
        </span>
        <select
          value={String(cfg.ventanaSeg)}
          onChange={(e) => set({ ventanaSeg: Number(e.target.value) })}
          className={INPUT}
        >
          <option value="15">15 segundos</option>
          <option value="30">30 segundos</option>
          <option value="60">1 minuto</option>
          <option value="180">3 minutos</option>
          <option value="300">5 minutos</option>
          <option value="900">15 minutos</option>
        </select>
      </label>

      <label className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-slate-500 dark:text-slate-400">
          Escala automática
        </span>
        <input
          type="checkbox"
          checked={cfg.autoEscala}
          onChange={(e) => set({ autoEscala: e.target.checked })}
          className="h-4 w-4 rounded border-slate-300 text-siemens focus:ring-2 focus:ring-siemens/40 dark:border-navy-slate dark:bg-navy"
        />
      </label>

      {!cfg.autoEscala && (
        <div className="grid grid-cols-2 gap-2">
          <label className="block">
            <span className="mb-1 block text-[11px] text-slate-400">Mínimo</span>
            <input
              type="text"
              inputMode="decimal"
              value={cfg.min}
              onChange={(e) => set({ min: e.target.value })}
              placeholder="0"
              className={INPUT}
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-[11px] text-slate-400">Máximo</span>
            <input
              type="text"
              inputMode="decimal"
              value={cfg.max}
              onChange={(e) => set({ max: e.target.value })}
              placeholder="100"
              className={INPUT}
            />
          </label>
        </div>
      )}

      <label className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-slate-500 dark:text-slate-400">
          Mostrar leyenda
        </span>
        <input
          type="checkbox"
          checked={cfg.mostrarLeyenda}
          onChange={(e) => set({ mostrarLeyenda: e.target.checked })}
          className="h-4 w-4 rounded border-slate-300 text-siemens focus:ring-2 focus:ring-siemens/40 dark:border-navy-slate dark:bg-navy"
        />
      </label>

      <label className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-slate-500 dark:text-slate-400">
          Mostrar rejilla
        </span>
        <input
          type="checkbox"
          checked={cfg.mostrarRejilla}
          onChange={(e) => set({ mostrarRejilla: e.target.checked })}
          className="h-4 w-4 rounded border-slate-300 text-siemens focus:ring-2 focus:ring-siemens/40 dark:border-navy-slate dark:bg-navy"
        />
      </label>

      <p className="rounded-lg bg-slate-100 px-2.5 py-2 text-[11px] leading-relaxed text-slate-500 dark:bg-navy-slate/40 dark:text-slate-400">
        Muestra los últimos {cfg.ventanaSeg} segundos en vivo. No guarda nada:
        al recargar la página empieza de cero.
      </p>
    </>
  );
}

// ─── Definición ──────────────────────────────────────────────────

export const trendWidget: CustomWidgetDef = {
  kind: 'custom:trend',
  label: 'Tendencia',
  category: 'Datos',
  icon: LineChartIcon,
  defaultWidth: 420,
  defaultHeight: 240,
  render: (ctx) => <Trend {...ctx} />,
  inspector: (ctx) => <InspectorTrend {...ctx} />,
  defaultConfig: CONFIG_TREND,
};
