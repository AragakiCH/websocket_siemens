import React, { useRef, useState } from 'react';
import {
  DatabaseIcon,
  ActivityIcon,
  PlayIcon,
  SquareIcon,
  CheckCircle2Icon,
  AlertCircleIcon,
  Loader2Icon,
} from 'lucide-react';
import { FlowNodeData } from './types';

const ICON_MAP: Record<string, React.FC<{ className?: string }>> = {
  Database: DatabaseIcon,
  Activity: ActivityIcon,
  Play: PlayIcon,
  Square: SquareIcon,
};

const COLOR_MAP: Record<string, { border: string; bg: string; dot: string }> = {
  siemens: {
    border: 'border-siemens/60',
    bg: 'bg-siemens/10 dark:bg-siemens/5',
    dot: 'bg-siemens',
  },
  amber: {
    border: 'border-amber-400/60',
    bg: 'bg-amber-50 dark:bg-amber-500/5',
    dot: 'bg-amber-500',
  },
  green: {
    border: 'border-green-400/60',
    bg: 'bg-green-50 dark:bg-green-500/5',
    dot: 'bg-green-500',
  },
  red: {
    border: 'border-red-400/60',
    bg: 'bg-red-50 dark:bg-red-500/5',
    dot: 'bg-red-500',
  },
};

function getNodeMeta(type: string) {
  switch (type) {
    case 'connection':
      return { icon: 'Database', color: 'siemens', category: 'POST /db' };
    case 'historian':
      return { icon: 'Activity', color: 'amber', category: 'POST /historian' };
    case 'start':
      return { icon: 'Play', color: 'green', category: 'POST /start' };
    case 'stop':
      return { icon: 'Square', color: 'red', category: 'POST /stop' };
    default:
      return { icon: 'Database', color: 'siemens', category: '' };
  }
}

/** Los nodos de acción (start/stop) son terminales: no encadenan hacia otro. */
const SIN_SALIDA = new Set(['start', 'stop']);

/**
 * Estado REAL del grupo en el servidor (de `GET /historian`).
 * `null` = el historizador no conoce ese grupo, o el nodo no tiene grupo_id.
 */
export type EstadoGrupo = 'capturando' | 'detenido' | null;

interface Props {
  node: FlowNodeData;
  selected: boolean;
  onSelect: () => void;
  onMove: (id: string, x: number, y: number) => void;
  onStartLink: (fromId: string) => void;
  onCompleteLink: (toId: string) => void;
  onContextMenu: (e: React.MouseEvent) => void;
  isLinking: boolean;
  zoom: number;
  estadoGrupo?: EstadoGrupo;
}

export function FlowNode({
  node, selected, onSelect, onMove, onStartLink, onCompleteLink,
  onContextMenu, isLinking, zoom, estadoGrupo = null,
}: Props) {
  const meta = getNodeMeta(node.type);
  const colors = COLOR_MAP[meta.color] ?? COLOR_MAP.siemens;
  const Icon = ICON_MAP[meta.icon] ?? DatabaseIcon;

  const dragRef = useRef<{ startX: number; startY: number; nodeX: number; nodeY: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  const handlePointerDown = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).dataset.port) return;
    e.stopPropagation();
    onSelect();
    dragRef.current = {
      startX: e.clientX, startY: e.clientY,
      nodeX: node.position.x, nodeY: node.position.y,
    };
    setDragging(true);
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (!dragRef.current) return;
    const dx = (e.clientX - dragRef.current.startX) / zoom;
    const dy = (e.clientY - dragRef.current.startY) / zoom;
    onMove(node.id, Math.round(dragRef.current.nodeX + dx), Math.round(dragRef.current.nodeY + dy));
  };

  const handlePointerUp = (e: React.PointerEvent) => {
    if (dragRef.current) {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    }
    dragRef.current = null;
    setDragging(false);
  };

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    onContextMenu(e);
  };

  const StatusIcon = () => {
    switch (node.status) {
      case 'ok': return <CheckCircle2Icon className="h-3.5 w-3.5 text-green-500" />;
      case 'error': return <AlertCircleIcon className="h-3.5 w-3.5 text-red-500" />;
      case 'saving': return <Loader2Icon className="h-3.5 w-3.5 animate-spin text-siemens" />;
      default: return null;
    }
  };

  return (
    <div
      className={`
        group absolute select-none rounded-xl border-2 bg-white shadow-md
        transition-shadow dark:bg-navy-soft
        ${colors.border}
        ${selected ? 'ring-2 ring-siemens/40 shadow-lg' : 'hover:shadow-lg'}
        ${dragging ? 'cursor-grabbing opacity-90' : 'cursor-grab'}
      `}
      style={{
        left: node.position.x,
        top: node.position.y,
        width: 180,
        minHeight: 72,
        zIndex: selected ? 30 : dragging ? 25 : 20,
        pointerEvents: 'auto',  // CRITICAL: override parent's 'none'
      }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onContextMenu={handleContextMenu}
    >
      {/* Input port (left) — drop target when linking */}
      {node.type !== 'connection' && (
        <div
          data-port="input"
          className={`absolute -left-2.5 top-1/2 h-5 w-5 -translate-y-1/2 rounded-full border-2 border-white shadow-md transition dark:border-navy-soft ${
            isLinking
              ? 'cursor-crosshair bg-siemens scale-125'
              : 'bg-slate-400 hover:bg-siemens hover:scale-110'
          }`}
          style={{ pointerEvents: 'auto', zIndex: 40 }}
          onPointerDown={(e) => e.stopPropagation()}
          onPointerUp={(e) => {
            e.stopPropagation();
            onCompleteLink(node.id);
          }}
        >
          {isLinking && (
            <span className="absolute inset-0 animate-ping rounded-full bg-siemens/40" />
          )}
        </div>
      )}

      {/* Output port (right) — drag to start link */}
      {!SIN_SALIDA.has(node.type) && (
        <div
          data-port="output"
          className="absolute -right-2.5 top-1/2 h-5 w-5 -translate-y-1/2 cursor-crosshair rounded-full border-2 border-white bg-slate-400 shadow-md transition hover:bg-siemens hover:scale-125 dark:border-navy-soft"
          style={{ pointerEvents: 'auto', zIndex: 40 }}
          onPointerDown={(e) => {
            e.stopPropagation();
            e.preventDefault();
            onStartLink(node.id);
          }}
        />
      )}

      {/* Header */}
      <div className={`flex items-center gap-2 rounded-t-[10px] px-3 py-2 ${colors.bg}`}>
        <div className={`flex h-6 w-6 items-center justify-center rounded-md ${colors.dot} bg-opacity-20`}>
          <Icon className="h-3.5 w-3.5 text-white" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="truncate text-xs font-bold text-slate-800 dark:text-slate-100">{node.label}</p>
          <p className="text-[10px] text-slate-400">{meta.category}</p>
        </div>
        <StatusIcon />
      </div>

      {/* Brief info */}
      <div className="px-3 py-1.5">
        {node.type === 'connection' && (
          <p className="truncate text-[10px] text-slate-500 dark:text-slate-400">
            {/* Con una conexión ya existente lo que identifica al nodo es su
                db_id, no el motor y el host: es a lo que APUNTA. */}
            {node.config.usar_existente
              ? node.config.db_id || 'Elige una conexión'
              : node.config.motor
                ? `${node.config.motor}://${node.config.host || '…'}`
                : 'Sin configurar'}
          </p>
        )}
        {node.type === 'historian' && (
          <>
            <p className="truncate text-[10px] text-slate-500 dark:text-slate-400">
              {node.config.grupo_id || 'Sin grupo'} → {node.config.tabla || 'historico_tags'}
            </p>
            {/* Estado EN VIVO del servidor, no el resultado del último Guardar. */}
            {estadoGrupo && (
              <div className="mt-1 flex items-center gap-1.5">
                {estadoGrupo === 'capturando' ? (
                  <>
                    <span className="relative flex h-1.5 w-1.5 shrink-0">
                      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-green-400 opacity-70" />
                      <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-green-500" />
                    </span>
                    <span className="text-[9px] font-semibold uppercase tracking-wide text-green-600 dark:text-green-400">
                      capturando
                    </span>
                  </>
                ) : (
                  <>
                    <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-slate-300 dark:bg-slate-600" />
                    <span className="text-[9px] font-semibold uppercase tracking-wide text-slate-400">
                      detenido
                    </span>
                  </>
                )}
              </div>
            )}
          </>
        )}
        {node.type === 'start' && (
          <p className="truncate text-[10px] text-slate-500 dark:text-slate-400">
            {node.config.grupo_id ? `Iniciar: ${node.config.grupo_id}` : 'Sin grupo'}
          </p>
        )}
        {node.type === 'stop' && (
          <p className="truncate text-[10px] text-slate-500 dark:text-slate-400">
            {node.config.grupo_id ? `Detener: ${node.config.grupo_id}` : 'Sin grupo'}
          </p>
        )}
      </div>
    </div>
  );
}
