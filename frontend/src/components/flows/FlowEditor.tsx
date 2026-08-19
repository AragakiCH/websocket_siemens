import React, { useState, useRef, useCallback, useEffect } from 'react';
import {
  PlusIcon,
  ZoomInIcon,
  ZoomOutIcon,
  MaximizeIcon,
  Trash2Icon,
} from 'lucide-react';
import { FlowNodeData, FlowConnection, NodeType, NODE_CATALOG, COLOR_DOT } from './types';
import { FlowNode, EstadoGrupo } from './FlowNode';
import { FlowConfigPanel } from './FlowConfigPanel';
import { ConfirmarBorrado } from './ConfirmarBorrado';
import { useEstadoHistorian } from './useEstadoHistorian';
import { detenerGrupo } from './api';

let _nodeCounter = 1;

const STORAGE_KEY = 'srx_flow_editor';

function loadFlowState(): { nodes: FlowNodeData[]; connections: FlowConnection[] } {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* ignore */ }
  return { nodes: [], connections: [] };
}

function saveFlowState(nodes: FlowNodeData[], connections: FlowConnection[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ nodes, connections }));
}

type Selection =
  | { kind: 'node'; id: string }
  | { kind: 'connection'; id: string }
  | null;

/** Borrado en espera de confirmación porque afecta grupos que están grabando. */
interface BorradoPendiente {
  grupos: string[];
  numNodos: number;
  aplicar: () => void;
}

export function FlowEditor() {
  const saved = loadFlowState();
  const [nodes, setNodes] = useState<FlowNodeData[]>(saved.nodes);
  const [connections, setConnections] = useState<FlowConnection[]>(saved.connections);
  const [selection, setSelection] = useState<Selection>(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState(false);
  const [panStart, setPanStart] = useState({ x: 0, y: 0 });
  const [showAddMenu, setShowAddMenu] = useState(false);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; target: Selection } | null>(null);

  // Linking: drag from output port to input port
  const [linking, setLinking] = useState<{ fromId: string; mouse: { x: number; y: number } } | null>(null);
  const linkingRef = useRef(linking);
  linkingRef.current = linking;

  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => { saveFlowState(nodes, connections); }, [nodes, connections]);

  const selectedNodeId = selection?.kind === 'node' ? selection.id : null;
  const selectedNode = nodes.find((n) => n.id === selectedNodeId) ?? null;
  const selectedConnId = selection?.kind === 'connection' ? selection.id : null;

  // Close context menu
  useEffect(() => {
    if (!ctxMenu) return;
    const close = () => setCtxMenu(null);
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, [ctxMenu]);

  // ── Estado real del historizador (badges + confirmación) ──────
  const { grupos: gruposServidor, refrescar: refrescarGrupos } = useEstadoHistorian();
  const [pendiente, setPendiente] = useState<BorradoPendiente | null>(null);
  const [deteniendo, setDeteniendo] = useState(false);
  const [errorDetener, setErrorDetener] = useState('');

  /** Estado en vivo de un nodo Historian, para su badge. */
  const estadoDeNodo = useCallback((node: FlowNodeData): EstadoGrupo => {
    if (node.type !== 'historian') return null;
    const gid = (node.config?.grupo_id || '').trim();
    if (!gid) return null;
    const g = gruposServidor.get(gid);
    if (!g) return null;
    return g.activo ? 'capturando' : 'detenido';
  }, [gruposServidor]);

  /**
   * De los nodos que se van a borrar, cuáles tienen un grupo GRABANDO ahora.
   * Solo los Historian cuentan: borrar un Start, un Stop o una Conexión no
   * detiene nada en el backend.
   */
  const gruposActivosEn = useCallback((ids: string[]): string[] => {
    const encontrados = new Set<string>();
    for (const id of ids) {
      const node = nodes.find((n) => n.id === id);
      if (!node || node.type !== 'historian') continue;
      const gid = (node.config?.grupo_id || '').trim();
      if (gid && gruposServidor.get(gid)?.activo) encontrados.add(gid);
    }
    return Array.from(encontrados);
  }, [nodes, gruposServidor]);

  /**
   * Puerta única de borrado: si nada está grabando, borra directo; si algo
   * sigue activo, abre el diálogo y espera la decisión del usuario.
   */
  const pedirBorrado = useCallback((ids: string[], aplicar: () => void) => {
    const activos = gruposActivosEn(ids);
    if (activos.length === 0) { aplicar(); return; }
    setErrorDetener('');
    setPendiente({ grupos: activos, numNodos: ids.length, aplicar });
  }, [gruposActivosEn]);

  // ── CRUD ──────────────────────────────────────────────────────
  const addNode = useCallback((type: NodeType) => {
    const cat = NODE_CATALOG.find((c) => c.type === type)!;
    const id = `${type}_${Date.now()}_${_nodeCounter++}`;
    setNodes((prev) => [...prev, {
      id, type,
      label: `${cat.label} ${_nodeCounter - 1}`,
      position: { x: 200 + Math.random() * 200, y: 120 + Math.random() * 150 },
      config: { ...cat.defaultConfig },
      status: 'idle',
    }]);
    setSelection({ kind: 'node', id });
    setShowAddMenu(false);
  }, []);

  const borrarNodoDirecto = useCallback((id: string) => {
    setNodes((prev) => prev.filter((n) => n.id !== id));
    setConnections((prev) => prev.filter((c) => c.from !== id && c.to !== id));
    setSelection((s) => (s?.kind === 'node' && s.id === id ? null : s));
  }, []);

  // Pasa por la puerta de confirmación. Lo usan el menú contextual, la tecla
  // Delete y el botón de papelera del panel derecho.
  const deleteNode = useCallback((id: string) => {
    pedirBorrado([id], () => borrarNodoDirecto(id));
  }, [pedirBorrado, borrarNodoDirecto]);

  // ── Keyboard ──────────────────────────────────────────────────
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (selection?.kind === 'connection') {
          setConnections((prev) => prev.filter((c) => c.id !== selection.id));
          setSelection(null);
          e.preventDefault();
        } else if (selection?.kind === 'node') {
          // Vía deleteNode para que la tecla Delete también confirme si el
          // grupo sigue grabando en el servidor.
          deleteNode(selection.id);
          e.preventDefault();
        }
      }
      if (e.key === 'Escape') {
        setSelection(null);
        setCtxMenu(null);
        setLinking(null);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [selection, deleteNode]);

  const deleteConnection = useCallback((id: string) => {
    setConnections((prev) => prev.filter((c) => c.id !== id));
    setSelection((s) => (s?.kind === 'connection' && s.id === id ? null : s));
  }, []);

  const moveNode = useCallback((id: string, x: number, y: number) => {
    setNodes((prev) => prev.map((n) => (n.id === id ? { ...n, position: { x, y } } : n)));
  }, []);

  const updateConfig = useCallback((id: string, patch: Record<string, any>) => {
    setNodes((prev) => prev.map((n) => (n.id === id ? { ...n, config: { ...n.config, ...patch } } : n)));
  }, []);

  const updateStatus = useCallback((id: string, status: FlowNodeData['status'], msg?: string) => {
    setNodes((prev) => prev.map((n) => (n.id === id ? { ...n, status, statusMsg: msg } : n)));
  }, []);

  // ── Linking ───────────────────────────────────────────────────
  const startLink = useCallback((fromId: string) => {
    setLinking({ fromId, mouse: { x: 0, y: 0 } });
  }, []);

  const completeLink = useCallback((toId: string) => {
    const cur = linkingRef.current;
    if (!cur) return;
    if (cur.fromId === toId) { setLinking(null); return; }
    setConnections((prev) => {
      if (prev.some((c) => c.from === cur.fromId && c.to === toId)) return prev;
      return [...prev, { id: `conn_${Date.now()}`, from: cur.fromId, fromPort: 'output' as const, to: toId, toPort: 'input' as const }];
    });
    setLinking(null);
  }, []);

  // ── Pointer events on container ───────────────────────────────
  const handlePointerDown = (e: React.PointerEvent) => {
    const el = e.target as HTMLElement;
    // Only start pan if clicking on empty canvas background
    if (el.dataset.canvas || el === containerRef.current) {
      setSelection(null);
      setCtxMenu(null);
      setIsPanning(true);
      setPanStart({ x: e.clientX - pan.x, y: e.clientY - pan.y });
    }
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (isPanning) {
      setPan({ x: e.clientX - panStart.x, y: e.clientY - panStart.y });
    }
    if (linkingRef.current) {
      const rect = containerRef.current?.getBoundingClientRect();
      if (rect) {
        setLinking((prev) =>
          prev ? { ...prev, mouse: { x: (e.clientX - rect.left - pan.x) / zoom, y: (e.clientY - rect.top - pan.y) / zoom } } : null
        );
      }
    }
  };

  const handlePointerUp = () => {
    setIsPanning(false);
    if (linkingRef.current) setLinking(null);
  };

  const handleWheel = (e: React.WheelEvent) => {
    const delta = e.deltaY > 0 ? -0.08 : 0.08;
    setZoom((z) => Math.max(0.3, Math.min(2, z + delta)));
  };

  const resetView = () => { setZoom(1); setPan({ x: 0, y: 0 }); };

  // ── Port positions ────────────────────────────────────────────
  const getPortPos = (id: string, port: 'input' | 'output') => {
    const node = nodes.find((n) => n.id === id);
    if (!node) return { x: 0, y: 0 };
    return {
      x: node.position.x + (port === 'output' ? 180 : 0),
      y: node.position.y + 36,
    };
  };

  const clearAll = () => {
    pedirBorrado(nodes.map((n) => n.id), () => {
      setNodes([]); setConnections([]); setSelection(null);
    });
  };

  // ── Resolución del diálogo de confirmación ────────────────────
  const soloBorrarDibujo = () => {
    pendiente?.aplicar();
    setPendiente(null);
  };

  const detenerYBorrar = async () => {
    if (!pendiente) return;
    setDeteniendo(true);
    setErrorDetener('');
    try {
      // Todos los stops en paralelo: si uno falla no se borra nada, así el
      // usuario no se queda con la mitad detenida y el dibujo ya perdido.
      await Promise.all(pendiente.grupos.map((g) => detenerGrupo(g)));
      pendiente.aplicar();
      setPendiente(null);
      refrescarGrupos();
    } catch (err: any) {
      setErrorDetener(err?.message || 'No se pudo detener el grupo.');
    } finally {
      setDeteniendo(false);
    }
  };

  const handleCtxDelete = () => {
    if (!ctxMenu?.target) return;
    if (ctxMenu.target.kind === 'node') deleteNode(ctxMenu.target.id);
    if (ctxMenu.target.kind === 'connection') deleteConnection(ctxMenu.target.id);
    setCtxMenu(null);
  };

  const transform = `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`;

  return (
    <div
      ref={containerRef}
      className="flex h-full overflow-hidden"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onWheel={handleWheel}
    >
      <div className="relative flex-1 overflow-hidden bg-slate-50 dark:bg-navy">

        {/* ── Layer 0: Background dots (pan target) ── */}
        <div
          data-canvas="true"
          className="absolute inset-0 cursor-grab active:cursor-grabbing"
          style={{
            zIndex: 0,
            backgroundImage: 'radial-gradient(circle, rgba(148,163,184,0.18) 1px, transparent 1px)',
            backgroundSize: `${20 * zoom}px ${20 * zoom}px`,
            backgroundPosition: `${pan.x}px ${pan.y}px`,
          }}
        />

        {/* ── Layer 1: SVG connections (pointer-events:none, children override) ── */}
        <svg
          className="pointer-events-none absolute inset-0"
          style={{ zIndex: 5, overflow: 'visible' }}
        >
          <g transform={`translate(${pan.x},${pan.y}) scale(${zoom})`}>
            {connections.map((conn) => {
              const from = getPortPos(conn.from, 'output');
              const to = getPortPos(conn.to, 'input');
              const dx = Math.abs(to.x - from.x) * 0.5;
              const d = `M${from.x},${from.y} C${from.x + dx},${from.y} ${to.x - dx},${to.y} ${to.x},${to.y}`;
              const isSelected = selectedConnId === conn.id;
              return (
                <g key={conn.id}>
                  {/* Fat invisible hit area */}
                  <path
                    d={d}
                    fill="none"
                    stroke="transparent"
                    strokeWidth={16}
                    style={{ pointerEvents: 'stroke', cursor: 'pointer' }}
                    onClick={(e) => { e.stopPropagation(); setSelection({ kind: 'connection', id: conn.id }); }}
                    onContextMenu={(e) => {
                      e.preventDefault(); e.stopPropagation();
                      setSelection({ kind: 'connection', id: conn.id });
                      setCtxMenu({ x: e.clientX, y: e.clientY, target: { kind: 'connection', id: conn.id } });
                    }}
                  />
                  {/* Visible cable */}
                  <path
                    d={d}
                    fill="none"
                    stroke={isSelected ? '#ef4444' : '#009999'}
                    strokeWidth={isSelected ? 3 : 2}
                    opacity={isSelected ? 1 : 0.7}
                    style={{ pointerEvents: 'none' }}
                  />
                </g>
              );
            })}
            {/* Live linking preview */}
            {linking && linking.mouse.x !== 0 && (() => {
              const from = getPortPos(linking.fromId, 'output');
              const to = linking.mouse;
              const dx = Math.abs(to.x - from.x) * 0.5;
              return (
                <path
                  d={`M${from.x},${from.y} C${from.x + dx},${from.y} ${to.x - dx},${to.y} ${to.x},${to.y}`}
                  fill="none" stroke="#009999" strokeWidth={2}
                  strokeDasharray="6 4" opacity={0.5}
                  style={{ pointerEvents: 'none' }}
                />
              );
            })()}
          </g>
        </svg>

        {/* ── Layer 2: Nodes ── */}
        <div
          className="absolute inset-0"
          style={{ zIndex: 10, pointerEvents: 'none' }}
        >
          <div style={{ transform, transformOrigin: '0 0', pointerEvents: 'none' }}>
            {nodes.map((node) => (
              <FlowNode
                key={node.id}
                node={node}
                selected={selectedNodeId === node.id}
                onSelect={() => setSelection({ kind: 'node', id: node.id })}
                onMove={moveNode}
                onStartLink={startLink}
                onCompleteLink={completeLink}
                onContextMenu={(e) => {
                  setSelection({ kind: 'node', id: node.id });
                  setCtxMenu({ x: e.clientX, y: e.clientY, target: { kind: 'node', id: node.id } });
                }}
                isLinking={!!linking}
                zoom={zoom}
                estadoGrupo={estadoDeNodo(node)}
              />
            ))}
          </div>
        </div>

        {/* Toolbar */}
        <div className="absolute left-3 top-3 flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white/90 px-2 py-1.5 shadow-sm backdrop-blur dark:border-navy-slate dark:bg-navy-soft/90" style={{ zIndex: 30 }}>
          <div className="relative">
            <button
              onClick={() => setShowAddMenu(!showAddMenu)}
              className="flex items-center gap-1 rounded-md bg-siemens px-2 py-1 text-xs font-semibold text-white transition hover:bg-siemens-600"
            >
              <PlusIcon className="h-3.5 w-3.5" />
              Nodo
            </button>
            {showAddMenu && (
              <div className="absolute left-0 top-full mt-1 w-48 rounded-lg border border-slate-200 bg-white py-1 shadow-lg dark:border-navy-slate dark:bg-navy-soft">
                <p className="px-3 py-1 text-[10px] font-bold uppercase tracking-wider text-slate-400">Base de Datos</p>
                {NODE_CATALOG.filter((c) => c.category === 'bd').map((cat) => (
                  <button key={cat.type} onClick={() => addNode(cat.type)}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-slate-700 transition hover:bg-slate-50 dark:text-slate-300 dark:hover:bg-navy-slate/40">
                    <span className="h-2 w-2 rounded-full bg-siemens" />{cat.label}
                  </button>
                ))}
                <div className="my-1 border-t border-slate-100 dark:border-navy-slate" />
                <p className="px-3 py-1 text-[10px] font-bold uppercase tracking-wider text-slate-400">Historizador</p>
                {NODE_CATALOG.filter((c) => c.category === 'historian').map((cat) => (
                  <button key={cat.type} onClick={() => addNode(cat.type)}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-slate-700 transition hover:bg-slate-50 dark:text-slate-300 dark:hover:bg-navy-slate/40">
                    <span className={`h-2 w-2 rounded-full ${COLOR_DOT[cat.color] ?? 'bg-slate-400'}`} />{cat.label}
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="mx-1 h-4 w-px bg-slate-200 dark:bg-navy-slate" />
          <button onClick={() => setZoom((z) => Math.min(2, z + 0.15))} className="rounded p-1 text-slate-500 transition hover:bg-slate-100 dark:hover:bg-navy-slate/40" title="Zoom in">
            <ZoomInIcon className="h-3.5 w-3.5" />
          </button>
          <span className="min-w-[36px] text-center text-[11px] font-medium text-slate-500">{Math.round(zoom * 100)}%</span>
          <button onClick={() => setZoom((z) => Math.max(0.3, z - 0.15))} className="rounded p-1 text-slate-500 transition hover:bg-slate-100 dark:hover:bg-navy-slate/40" title="Zoom out">
            <ZoomOutIcon className="h-3.5 w-3.5" />
          </button>
          <button onClick={resetView} className="rounded p-1 text-slate-500 transition hover:bg-slate-100 dark:hover:bg-navy-slate/40" title="Reset view">
            <MaximizeIcon className="h-3.5 w-3.5" />
          </button>
          {nodes.length > 0 && (
            <>
              <div className="mx-1 h-4 w-px bg-slate-200 dark:bg-navy-slate" />
              <button onClick={clearAll} className="rounded p-1 text-slate-400 transition hover:bg-red-50 hover:text-red-500 dark:hover:bg-red-500/10" title="Limpiar todo">
                <Trash2Icon className="h-3.5 w-3.5" />
              </button>
            </>
          )}
        </div>

        {/* Status bar */}
        <div className="absolute bottom-3 left-3 flex items-center gap-3 rounded-lg border border-slate-200 bg-white/80 px-3 py-1.5 text-[11px] text-slate-500 backdrop-blur dark:border-navy-slate dark:bg-navy-soft/80 dark:text-slate-400" style={{ zIndex: 30 }}>
          <span>{nodes.length} nodos</span>
          <span>{connections.length} conexiones</span>
        </div>

        {/* Empty state */}
        {nodes.length === 0 && (
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-slate-400" style={{ zIndex: 1 }}>
            <PlusIcon className="mb-3 h-10 w-10 opacity-40" />
            <p className="text-sm font-medium">Agrega un nodo para empezar</p>
            <p className="text-xs">Usa el botón &quot;+ Nodo&quot;</p>
          </div>
        )}

        {/* Context menu */}
        {ctxMenu && (
          <div
            className="fixed min-w-[140px] rounded-lg border border-slate-200 bg-white py-1 shadow-xl dark:border-navy-slate dark:bg-navy-soft"
            style={{ left: ctxMenu.x, top: ctxMenu.y, zIndex: 50 }}
            onPointerDown={(e) => e.stopPropagation()}
          >
            <button onClick={handleCtxDelete}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-red-500 transition hover:bg-red-50 dark:hover:bg-red-500/10">
              <Trash2Icon className="h-3.5 w-3.5" />
              Eliminar {ctxMenu.target?.kind === 'connection' ? 'cable' : 'nodo'}
            </button>
          </div>
        )}
      </div>

      {/* Config panel */}
      <FlowConfigPanel
        node={selectedNode}
        nodes={nodes}
        onUpdateConfig={updateConfig}
        onUpdateStatus={updateStatus}
        onDelete={deleteNode}
      />

      {/* Confirmación: hay grupos grabando entre lo que se va a borrar */}
      {pendiente && (
        <ConfirmarBorrado
          grupos={pendiente.grupos}
          numNodos={pendiente.numNodos}
          procesando={deteniendo}
          error={errorDetener}
          onSoloDibujo={soloBorrarDibujo}
          onDetenerYBorrar={detenerYBorrar}
          onCancelar={() => { if (!deteniendo) setPendiente(null); }}
        />
      )}
    </div>
  );
}
