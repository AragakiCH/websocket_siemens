import React, { useState, useRef, useCallback, useEffect } from 'react';
import { motion, AnimatePresence, useReducedMotion } from 'framer-motion';
import {
  PlusIcon,
  ZoomInIcon,
  ZoomOutIcon,
  MaximizeIcon,
  Trash2Icon,
  DatabaseIcon,
  ActivityIcon,
  PlayIcon,
  SquareIcon,
  PanelLeftIcon,
  PanelLeftCloseIcon,
  type LucideIcon,
} from 'lucide-react';
import { FlowNodeData, FlowConnection, NodeType, NODE_CATALOG, COLOR_DOT } from './types';
import { FlowNode, EstadoGrupo } from './FlowNode';
import { FlowConfigPanel } from './FlowConfigPanel';
import { ConfirmarBorrado } from './ConfirmarBorrado';
import { useEstadoHistorian } from './useEstadoHistorian';
import { detenerGrupo } from './api';


// ─── Paleta de nodos (solo presentación) ───────────────────────
//
// El catálogo de tipos y sus `defaultConfig` siguen viviendo en types.ts.
// Aquí solo está lo que hace falta para DIBUJARLO: qué icono le toca a cada
// uno y una línea que diga para qué sirve, que es la pregunta que se hace
// cualquiera la primera vez que abre el editor.

/**
 * Tipo MIME propio del arrastre.
 *
 * Uno inventado y no 'text/plain' a proposito: asi el lienzo distingue un
 * nodo de la paleta de cualquier otra cosa que se pueda soltar encima (un
 * archivo del escritorio, texto de otra pestana) y no intenta crear un nodo
 * con lo que sea que venga.
 */
const MIME_NODO = 'application/x-psicore-nodo';

/**
 * Ancho de la paleta, en pixeles y no en una clase de Tailwind.
 *
 * La animacion tiene que interpolar HASTA un numero, asi que el ancho deja
 * de poder vivir solo en `w-52`. Se declara aqui una vez y lo usan los dos:
 * el contenido lo fija para no deformarse, y la animacion lo usa de destino.
 */
const ANCHO_PALETA = 208;

const ICONO: Record<string, LucideIcon> = {
  Database: DatabaseIcon,
  Activity: ActivityIcon,
  Play: PlayIcon,
  Square: SquareIcon,
};

const DESCRIPCION: Record<NodeType, string> = {
  connection: 'Apunta a una base de datos',
  historian: 'Graba tags en una tabla',
  start: 'Arranca la grabación',
  stop: 'Detiene la grabación',
};

// Las categorías salen del propio catálogo; esto solo les pone título y
// decide en qué orden se leen.
const GRUPOS: { categoria: 'bd' | 'historian'; titulo: string }[] = [
  { categoria: 'bd', titulo: 'Conexión' },
  { categoria: 'historian', titulo: 'Historizador' },
];

/**
 * Paleta fija de la izquierda.
 *
 * Antes esto era un desplegable detrás del botón «+ Nodo»: para saber qué
 * nodos existían había que abrirlo, y al soltar uno se cerraba solo, así que
 * armar un flujo de cuatro nodos eran cuatro aperturas del mismo menú. En un
 * editor de flujos la paleta es justo lo que más se mira, así que se queda a
 * la vista con las dos categorías desplegadas.
 *
 * Llama al MISMO `addNode` de siempre: no hay un camino nuevo para crear
 * nodos, solo se dejó de esconder el que ya había.
 */
function PaletaNodos({
  onAdd,
  onCerrar,
  onArrastreInicio,
  onArrastreFin,
}: {
  onAdd: (type: NodeType) => void;
  onCerrar: () => void;
  onArrastreInicio: (type: NodeType) => void;
  onArrastreFin: () => void;
}) {
  // Quien tenga puesto "reducir movimiento" en su sistema no quiere ver
  // nada deslizarse: se le cambia de golpe, que es lo que pidio.
  const sinMovimiento = useReducedMotion();

  return (
    <motion.aside
      initial={{ width: 0, opacity: 0 }}
      animate={{ width: ANCHO_PALETA, opacity: 1 }}
      exit={{ width: 0, opacity: 0 }}
      transition={
        sinMovimiento
          ? { duration: 0 }
          // Curva de salida rapida: arranca suelto y frena al final, que es
          // como se mueve un panel de verdad. Y 0.22 s a proposito: por
          // debajo se ve seco y por encima se siente lento cuando lo abres y
          // lo cierras varias veces seguidas.
          : { duration: 0.22, ease: [0.32, 0.72, 0, 1] }
      }
      // `overflow-hidden` es lo que hace que esto parezca un panel que se
      // desliza: el contenido mantiene su ancho y se va quedando fuera del
      // marco, en vez de aplastarse contra el borde mientras se cierra.
      className="shrink-0 overflow-hidden border-r border-slate-200 bg-white dark:border-navy-slate dark:bg-navy-soft"
    >
    <div
      className="flex h-full flex-col overflow-y-auto overscroll-contain"
      style={{ width: ANCHO_PALETA }}
    >
      <div className="flex items-start justify-between gap-2 border-b border-slate-200 px-3 py-2.5 dark:border-navy-slate">
        <div className="min-w-0">
          <p className="text-[11px] font-bold uppercase tracking-wider text-slate-400">
            Nodos
          </p>
          <p className="mt-0.5 text-[10.5px] leading-snug text-slate-400">
            Arrastra uno al lienzo
          </p>
        </div>
        <button
          onClick={onCerrar}
          title="Ocultar la paleta"
          aria-label="Ocultar la paleta"
          className="-mr-1 shrink-0 rounded-md p-1 text-slate-400 outline-none transition hover:bg-slate-100 hover:text-slate-600 focus-visible:ring-2 focus-visible:ring-siemens/40 dark:hover:bg-navy-slate/50 dark:hover:text-slate-300"
        >
          <PanelLeftCloseIcon className="h-4 w-4" />
        </button>
      </div>

      <div className="flex flex-col gap-4 p-2.5">
        {GRUPOS.map((g) => {
          const delGrupo = NODE_CATALOG.filter((c) => c.category === g.categoria);
          if (delGrupo.length === 0) return null;
          return (
            <div key={g.categoria}>
              <p className="mb-1.5 px-1 text-[10px] font-bold uppercase tracking-wider text-slate-400">
                {g.titulo}
              </p>
              <div className="flex flex-col gap-1">
                {delGrupo.map((cat) => {
                  const Icono = ICONO[cat.icon] ?? DatabaseIcon;
                  return (
                    <button
                      key={cat.type}
                      draggable
                      onDragStart={(e) => {
                        // El tipo viaja en el dataTransfer, que es lo unico
                        // que sobrevive hasta el `drop`. El aviso al editor
                        // es aparte porque durante el `dragover` el navegador
                        // NO deja leer el dataTransfer (lo tapa por
                        // seguridad), y sin saber que se arrastra no se
                        // podria pintar la pista de "suelta aqui".
                        e.dataTransfer.setData(MIME_NODO, cat.type);
                        e.dataTransfer.effectAllowed = 'copy';
                        onArrastreInicio(cat.type);
                      }}
                      onDragEnd={onArrastreFin}
                      onClick={() => onAdd(cat.type)}
                      title={`Arrastra «${cat.label}» al lienzo, o pulsa para soltarlo en el centro`}
                      className="flex cursor-grab items-start gap-2 rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-left outline-none transition hover:border-siemens/40 hover:bg-siemens-50/60 focus-visible:ring-2 focus-visible:ring-siemens/40 active:cursor-grabbing dark:border-navy-slate dark:bg-navy dark:hover:border-siemens/40 dark:hover:bg-siemens/10"
                    >
                      <span
                        className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md ${
                          COLOR_DOT[cat.color] ?? 'bg-slate-400'
                        }`}
                      >
                        <Icono className="h-3.5 w-3.5 text-white" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-xs font-semibold text-navy dark:text-slate-100">
                          {cat.label}
                        </span>
                        <span className="block text-[10.5px] leading-tight text-slate-400">
                          {DESCRIPCION[cat.type]}
                        </span>
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
    </motion.aside>
  );
}

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
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; target: Selection } | null>(null);

  // Paleta plegada o no. Se pliega para ganar lienzo en un flujo grande.
  const [paletaAbierta, setPaletaAbierta] = useState(true);

  // Tipo que se esta arrastrando ahora mismo desde la paleta, o null. Solo
  // sirve para pintar la pista de "suelta aqui": el dato de verdad viaja en
  // el dataTransfer, que es lo unico que llega intacto al `drop`.
  const [arrastreTipo, setArrastreTipo] = useState<NodeType | null>(null);

  // Linking: drag from output port to input port
  const [linking, setLinking] = useState<{ fromId: string; mouse: { x: number; y: number } } | null>(null);
  const linkingRef = useRef(linking);
  linkingRef.current = linking;

  const containerRef = useRef<HTMLDivElement>(null);

  // El LIENZO, que ya no empieza donde empieza el contenedor: la paleta se
  // le puso delante. Todo lo que traduce pixeles de pantalla a coordenadas
  // del lienzo (el cable que se esta tendiendo, el nodo que se suelta) tiene
  // que medir contra este, o sale desplazado justo el ancho de la paleta.
  const lienzoRef = useRef<HTMLDivElement>(null);

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
  /**
   * Crea un nodo. `posicion` es donde se solto, en coordenadas del lienzo.
   *
   * Sin ella cae donde caia siempre, en un punto al azar de la zona de
   * arriba a la izquierda: es lo que sigue pasando al PULSAR un nodo de la
   * paleta en vez de arrastrarlo.
   */
  const addNode = useCallback((type: NodeType, posicion?: { x: number; y: number }) => {
    const cat = NODE_CATALOG.find((c) => c.type === type)!;
    const id = `${type}_${Date.now()}_${_nodeCounter++}`;
    setNodes((prev) => [...prev, {
      id, type,
      label: `${cat.label} ${_nodeCounter - 1}`,
      position: posicion ?? { x: 200 + Math.random() * 200, y: 120 + Math.random() * 150 },
      config: { ...cat.defaultConfig },
      status: 'idle',
    }]);
    setSelection({ kind: 'node', id });
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
      const rect = lienzoRef.current?.getBoundingClientRect();
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

  // ── Soltar un nodo de la paleta ───────────────────────────────
  //
  // Se usa el arrastre nativo del navegador (draggable + dataTransfer) y no
  // los eventos de puntero que ya maneja el editor. Son dos gestos distintos
  // que empiezan igual —apretar y mover— y mezclarlos obligaria a adivinar
  // cual es cual en cada pointerdown. Ademas el arrastre nativo trae gratis
  // el fantasma del elemento y el cursor de "copiar".

  /** Sin esto el navegador rechaza el soltar y nunca dispara `onDrop`. */
  const sobreLienzo = (e: React.DragEvent) => {
    if (!arrastreTipo) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  };

  const soltarEnLienzo = (e: React.DragEvent) => {
    e.preventDefault();
    setArrastreTipo(null);

    const tipo = e.dataTransfer.getData(MIME_NODO) as NodeType;
    if (!NODE_CATALOG.some((c) => c.type === tipo)) return;

    const rect = lienzoRef.current?.getBoundingClientRect();
    if (!rect) return;

    // Pantalla -> lienzo: se deshace el desplazamiento y luego el zoom, en
    // ese orden, porque el CSS los aplica al reves (`translate` y despues
    // `scale`). Y se descuenta media anchura del nodo para que quede bajo el
    // cursor y no colgando de su esquina.
    const x = (e.clientX - rect.left - pan.x) / zoom - 90;
    const y = (e.clientY - rect.top - pan.y) / zoom - 24;

    addNode(tipo, { x: Math.round(x), y: Math.round(y) });
  };

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
    >
      {/* La paleta va DENTRO del flex de la raiz, antes del lienzo: asi el
          lienzo (`flex-1`) se encoge lo justo y el pan y el zoom siguen
          midiendo contra su propio ancho, sin cuentas nuevas. */}
      {/* `AnimatePresence` es lo que permite animar la SALIDA: sin el, React
          desmonta la paleta en cuanto `paletaAbierta` pasa a false y no queda
          nada en pantalla que animar. `initial={false}` evita que se despliegue
          sola al entrar a la pestana, que se veria como un tiron. */}
      <AnimatePresence initial={false}>
        {paletaAbierta && (
          <PaletaNodos
            key="paleta"
            onAdd={addNode}
            onCerrar={() => setPaletaAbierta(false)}
            onArrastreInicio={setArrastreTipo}
            onArrastreFin={() => setArrastreTipo(null)}
          />
        )}
      </AnimatePresence>

      {/* El zoom con la rueda vive AQUI, en el lienzo, no en la raiz.
          Estaba en el contenedor de fuera, que envuelve tambien al panel de
          configuracion de la derecha: rodar la rueda para recorrer un
          formulario largo, o la lista de tags del Historian, hacia zoom sobre
          los nodos al mismo tiempo. Dos cosas moviendose a la vez con el
          mismo gesto.

          El pan (onPointerDown/Move/Up) SI se queda en la raiz a proposito:
          `handlePointerDown` solo arranca si el clic fue sobre el fondo
          (`data-canvas`), y tenerlo arriba es lo que permite seguir
          arrastrando aunque el cursor se salga por encima del panel. */}
      <div
        ref={lienzoRef}
        className="relative flex-1 overflow-hidden bg-slate-50 dark:bg-navy"
        onWheel={handleWheel}
        onDragOver={sobreLienzo}
        onDrop={soltarEnLienzo}
      >

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
          {/* Solo aparece con la paleta plegada: abierta ya tiene su propio
              boton de cerrar en la cabecera, y dos controles para lo mismo a
              dos centimetros uno del otro sobran. */}
          {!paletaAbierta && (
            <>
              <button
                onClick={() => setPaletaAbierta(true)}
                title="Mostrar la paleta de nodos"
                aria-label="Mostrar la paleta de nodos"
                className="rounded p-1 text-slate-500 transition hover:bg-slate-100 dark:hover:bg-navy-slate/40"
              >
                <PanelLeftIcon className="h-3.5 w-3.5" />
              </button>
              <div className="mx-1 h-4 w-px bg-slate-200 dark:bg-navy-slate" />
            </>
          )}
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

        {/* Pista mientras se arrastra. El borde marca DONDE se puede soltar,
            que con la paleta al lado no es evidente, y el rotulo dice que se
            va a crear. `pointer-events-none` es obligatorio: cualquier cosa
            que capture el puntero encima del lienzo se come el `drop`. */}
        {arrastreTipo && (
          <div
            className="pointer-events-none absolute inset-2 flex items-start justify-center rounded-xl border-2 border-dashed border-siemens/50 bg-siemens/5"
            style={{ zIndex: 25 }}
          >
            <span className="mt-4 rounded-full bg-siemens px-3 py-1 text-[11px] font-semibold text-white shadow-sm">
              Suelta para colocar «{NODE_CATALOG.find((c) => c.type === arrastreTipo)?.label}»
            </span>
          </div>
        )}

        {/* Empty state */}
        {nodes.length === 0 && (
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-slate-400" style={{ zIndex: 1 }}>
            <PlusIcon className="mb-3 h-10 w-10 opacity-40" />
            <p className="text-sm font-medium">Agrega un nodo para empezar</p>
            <p className="text-xs">Arrástralo desde la paleta de la izquierda</p>
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
