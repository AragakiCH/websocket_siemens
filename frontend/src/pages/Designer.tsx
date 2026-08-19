import React, { useCallback, useEffect, useMemo, useState, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowLeftIcon,
  MousePointer2Icon,
  ActivityIcon,
  Trash2Icon,
  EyeIcon,
  LayoutDashboardIcon,
  WorkflowIcon } from
'lucide-react';
import { useAppStore } from '../context/AppStore';
import { HmiWidget, WidgetKind, defaultStyle } from '../models/widget';
import { catalogByKind } from '../components/hmi/widgetCatalog';
import { WidgetSidebar } from '../components/hmi/WidgetSidebar';
import { CanvasWidget } from '../components/hmi/CanvasWidget';
import { PropertyInspector } from '../components/hmi/PropertyInspector';
import { UPDATE_RATE_OPTIONS } from '../models/plc';
import { saveDesign, loadDesign } from '../utils/designStorage';
import { FlowEditor } from '../components/flows/FlowEditor';

type DesignerTab = 'designer' | 'flows';

let counter = 1;

// Límites razonables para el tamaño del lienzo (px).
const CANVAS_MIN = 200;
const CANVAS_MAX = 4000;
const clampCanvas = (n: number) =>
Math.max(CANVAS_MIN, Math.min(CANVAS_MAX, Math.round(n || 0)));

export function Designer() {
  const navigate = useNavigate();
  const {
    widgets,
    setWidgets,
    variables,
    selectedVariables,
    config,
    isDark,
    t
  } = useAppStore();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const [activeTab, setActiveTab] = useState<DesignerTab>('designer');

  

  // ---- Tamaño del lienzo (px) — persistido en localStorage --------------
  const saved = useMemo(() => loadDesign(), []);
  const [canvasW, setCanvasW] = useState<number>(saved?.canvas.width ?? 1280);
  const [canvasH, setCanvasH] = useState<number>(saved?.canvas.height ?? 760);

  // Texto que se escribe en los inputs (se aplica al salir / dar Enter).
  const [wInput, setWInput] = useState(String(canvasW));
  const [hInput, setHInput] = useState(String(canvasH));

  const commitW = () => {
    const v = clampCanvas(parseInt(wInput, 10) || canvasW);
    setCanvasW(v);
    setWInput(String(v));
  };
  const commitH = () => {
    const v = clampCanvas(parseInt(hInput, 10) || canvasH);
    setCanvasH(v);
    setHInput(String(v));
  };

  // Al entrar, si el store está vacío pero hay un diseño guardado, lo carga
  // (para que sobreviva a un refresh de la página).
  useEffect(() => {
    if (widgets.length === 0 && saved?.widgets?.length) {
      setWidgets(saved.widgets);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Guarda el diseño cada vez que cambian los widgets o las medidas.
  useEffect(() => {
    saveDesign({ widgets, canvas: { width: canvasW, height: canvasH } });
  }, [widgets, canvasW, canvasH]);

  const selected = widgets.find((w) => w.id === selectedId) ?? null;

  const createWidget = useCallback(
    (kind: WidgetKind, x: number, y: number): HmiWidget | null => {
      const cat = catalogByKind(kind);
      if (!cat) {
        console.warn(`[Designer] widget kind sin registrar: ${kind}`);
        return null;
      }
      const style = defaultStyle();
      if (kind === 'rectangle' || kind === 'circle') {
        style.background = '#cbd5e1';
        style.borderColor = '#94a3b8';
        style.borderWidth = 1;
      }
      return {
        id: `w_${Date.now()}_${counter}`,
        kind,
        name: `${cat.label} ${counter++}`,
        x,
        y,
        width: cat.defaultWidth,
        height: cat.defaultHeight,
        text: cat.label,
        style,
        visible: true,
        enabled: true,
        variableId: null
      };
    },
    []
  );

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const kind = e.dataTransfer.getData('widget-kind') as WidgetKind;
    if (!kind) return;
    const bounds = canvasRef.current?.getBoundingClientRect();
    if (!bounds) return;
    const cat = catalogByKind(kind);
    if (!cat) return;
    const x = Math.max(
      0,
      Math.round(e.clientX - bounds.left - cat.defaultWidth / 2)
    );
    const y = Math.max(
      0,
      Math.round(e.clientY - bounds.top - cat.defaultHeight / 2)
    );
    const w = createWidget(kind, x, y);
    if (!w) return;
    setWidgets((prev) => [...prev, w]);
    setSelectedId(w.id);
  };

  const patchWidget = (id: string, patch: Partial<HmiWidget>) =>
  setWidgets((prev) => prev.map((w) => w.id === id ? { ...w, ...patch } : w));

  const patchStyle = (id: string, patch: Partial<HmiWidget['style']>) =>
  setWidgets((prev) =>
  prev.map((w) =>
  w.id === id ? { ...w, style: { ...w.style, ...patch } } : w
  )
  );

  const deleteWidget = (id: string) => {
    setWidgets((prev) => prev.filter((w) => w.id !== id));
    setSelectedId(null);
  };

  // Abre la vista previa en una pestaña nueva (guarda antes por si acaso).
  const openPreview = () => {
    saveDesign({ widgets, canvas: { width: canvasW, height: canvasH } });
    window.open('/preview', '_blank', 'noopener');
  };

  const rawRate = UPDATE_RATE_OPTIONS.find((o) => o.value === config.updateRate);
  const rateLabel =
  rawRate && rawRate.value >= 1000 ?
  t(`rate.${rawRate.value}`) :
  rawRate?.label;

  return (
    <div className="flex h-full max-h-full w-full flex-col overflow-hidden bg-slate-100 dark:bg-navy">
      {/* Top toolbar */}
      <header className="flex items-center justify-between border-b border-slate-200 bg-white px-4 py-2.5 dark:border-navy-slate dark:bg-navy-soft">
        <div className="flex items-center gap-3">
          <button
            onClick={() => navigate('/')}
            className="flex h-8 w-8 items-center justify-center rounded-lg text-slate-500 transition hover:bg-slate-100 dark:hover:bg-navy-slate/40">
            <ArrowLeftIcon className="h-4 w-4" />
          </button>
          <div>
            <h1 className="text-sm font-bold text-navy dark:text-slate-100">
              {t('designer.title')}
            </h1>
            <p className="text-[11px] text-slate-400">
              {t('designer.mainView')}
            </p>
          </div>

          {/* ── Pestañas ── */}
          <div className="ml-4 flex rounded-lg border border-slate-200 bg-slate-50 p-0.5 dark:border-navy-slate dark:bg-navy">
            <button
              onClick={() => setActiveTab('designer')}
              className={`flex items-center gap-1.5 rounded-md px-3 py-1 text-xs font-semibold transition ${
                activeTab === 'designer'
                  ? 'bg-white text-navy shadow-sm dark:bg-navy-slate dark:text-slate-100'
                  : 'text-slate-400 hover:text-slate-600 dark:hover:text-slate-300'
              }`}
            >
              <LayoutDashboardIcon className="h-3.5 w-3.5" />
              Diseñador
            </button>
            <button
              onClick={() => setActiveTab('flows')}
              className={`flex items-center gap-1.5 rounded-md px-3 py-1 text-xs font-semibold transition ${
                activeTab === 'flows'
                  ? 'bg-white text-navy shadow-sm dark:bg-navy-slate dark:text-slate-100'
                  : 'text-slate-400 hover:text-slate-600 dark:hover:text-slate-300'
              }`}
            >
              <WorkflowIcon className="h-3.5 w-3.5" />
              Flujos
            </button>
          </div>
        </div>

        {activeTab === 'designer' && (
        <div className="flex items-center gap-3">
          {/* --- Medidas del lienzo (px) --- */}
          {/* --- Medidas del lienzo (px) --- */}
          <div className="flex items-center gap-1.5 rounded-lg border border-slate-200 bg-slate-50 px-2 py-1 dark:border-navy-slate dark:bg-navy">
            <span className="text-[11px] font-medium text-slate-400">Lienzo</span>
            <input
              type="text"
              inputMode="numeric"
              value={wInput}
              onChange={(e) => setWInput(e.target.value.replace(/[^0-9]/g, ''))}
              onBlur={commitW}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
              }}
              className="w-16 rounded border border-slate-200 bg-white px-1.5 py-0.5 text-center text-xs text-navy outline-none focus:border-siemens dark:border-navy-slate dark:bg-navy-soft dark:text-slate-100"
              title="Ancho (px)" />
            <span className="text-xs text-slate-400">×</span>
            <input
              type="text"
              inputMode="numeric"
              value={hInput}
              onChange={(e) => setHInput(e.target.value.replace(/[^0-9]/g, ''))}
              onBlur={commitH}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
              }}
              className="w-16 rounded border border-slate-200 bg-white px-1.5 py-0.5 text-center text-xs text-navy outline-none focus:border-siemens dark:border-navy-slate dark:bg-navy-soft dark:text-slate-100"
              title="Alto (px)" />
            <span className="text-[11px] text-slate-400">px</span>
          </div>

          <span className="flex items-center gap-1.5 rounded-full bg-state-ok/10 px-2.5 py-1 text-xs font-semibold text-state-ok">
            <ActivityIcon className="h-3.5 w-3.5" />
            {t('designer.live')} · {rateLabel}
          </span>
          <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-500 dark:bg-navy dark:text-slate-400">
            {widgets.length} {t('designer.widgets')}
          </span>

          {/* --- Vista previa (pestaña nueva) --- */}
          <button
            onClick={openPreview}
            className="flex items-center gap-1.5 rounded-lg bg-siemens px-2.5 py-1.5 text-xs font-semibold text-white transition hover:bg-siemens-600">
            <EyeIcon className="h-3.5 w-3.5" />
            Vista previa
          </button>

          {widgets.length > 0 &&
          <button
            onClick={() => {
              setWidgets([]);
              setSelectedId(null);
            }}
            className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium text-slate-500 transition hover:bg-red-50 hover:text-state-error dark:hover:bg-state-error/10">
              <Trash2Icon className="h-3.5 w-3.5" />
              {t('designer.clear')}
            </button>
          }
        </div>
        )}
      </header>

      {/* ═══ Contenido según pestaña activa ═══ */}
      {activeTab === 'designer' ? (
      <div className="flex flex-1 overflow-hidden">
        <WidgetSidebar />

        {/* Canvas */}
        <main className="mp-scroll mp-scroll-dark relative flex-1 overflow-auto p-8">
          <div
            ref={canvasRef}
            onDragOver={(e) => e.preventDefault()}
            onDrop={handleDrop}
            onPointerDown={() => setSelectedId(null)}
            className={`relative mx-auto rounded-xl border shadow-inner ${isDark ? 'border-navy-slate bg-navy-soft' : 'border-slate-300 bg-white'}`}
            style={{
              width: canvasW,
              height: canvasH
            }}>
            {widgets.length === 0 &&
            <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-slate-400">
                <MousePointer2Icon className="mb-3 h-10 w-10" />
                <p className="text-sm font-medium">{t('designer.dragHere')}</p>
                <p className="text-xs">{t('designer.designHint')}</p>
              </div>
            }
            {widgets.map((w) =>
            <CanvasWidget
              key={w.id}
              widget={w}
              variable={
              w.variableId ?
              variables.find((v) => v.id === w.variableId) :
              undefined
              }
              selected={w.id === selectedId}
              onSelect={setSelectedId}
              onMove={(id, x, y) => patchWidget(id, { x, y })}
              onResize={(id, width, height) => patchWidget(id, { width, height })}
              canvasRef={canvasRef} />
            )}
          </div>
        </main>

        <PropertyInspector
          widget={selected}
          selectedVariables={selectedVariables}
          onChange={(patch) => selected && patchWidget(selected.id, patch)}
          onStyleChange={(patch) => selected && patchStyle(selected.id, patch)}
          onDelete={() => selected && deleteWidget(selected.id)} />
      </div>
      ) : (
        <FlowEditor />
      )}
    </div>);

}
