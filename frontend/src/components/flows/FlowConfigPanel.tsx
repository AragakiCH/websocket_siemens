import { useState } from 'react';
import {
  SaveIcon,
  DatabaseIcon,
  ActivityIcon,
  PlayIcon,
  SquareIcon,
  Trash2Icon,
  CheckCircle2Icon,
  AlertCircleIcon,
} from 'lucide-react';
import { FlowNodeData } from './types';
import { API_BASE, ERROR_SIN_BACKEND, extraerMensaje } from './api';
import { ConnectionForm } from './bd/ConnectionForm';
import { HistorianForm } from './historian/HistorianForm';
import { StartForm } from './historian/StartForm';
import { StopForm } from './historian/StopForm';

interface Props {
  node: FlowNodeData | null;
  nodes: FlowNodeData[];
  onUpdateConfig: (id: string, patch: Record<string, any>) => void;
  onUpdateStatus: (id: string, status: FlowNodeData['status'], msg?: string) => void;
  onDelete: (id: string) => void;
}

export function FlowConfigPanel({ node, nodes, onUpdateConfig, onUpdateStatus, onDelete }: Props) {
  const [saving, setSaving] = useState(false);

  if (!node) {
    return (
      <div className="flex w-72 flex-col items-center justify-center border-l border-slate-200 bg-white/50 px-6 text-center dark:border-navy-slate dark:bg-navy-soft/50">
        <DatabaseIcon className="mb-3 h-8 w-8 text-slate-300 dark:text-slate-600" />
        <p className="text-sm font-medium text-slate-400 dark:text-slate-500">
          Selecciona un nodo
        </p>
        <p className="mt-1 text-xs text-slate-300 dark:text-slate-600">
          Haz clic en un nodo del canvas para configurarlo
        </p>
      </div>
    );
  }

  const connectionNodes = nodes.filter((n) => n.type === 'connection');
  const historianNodes = nodes.filter((n) => n.type === 'historian');

  const handleChange = (patch: Record<string, any>) => {
    onUpdateConfig(node.id, patch);
  };

  // ── POST individual ───────────────────────────────────────────
  const handleSave = async () => {
    setSaving(true);
    onUpdateStatus(node.id, 'saving');

    try {
      let url: string;
      let body: any;

      switch (node.type) {
        case 'connection': {
          url = `${API_BASE}/db`;
          const c = node.config;
          body = {
            db_id: c.db_id,
            motor: c.motor,
            nombre: c.nombre || '',
            host: c.host || '',
            puerto: c.puerto || null,
            base_datos: c.base_datos || '',
            usuario: c.usuario || '',
            password: c.password || '',
            opciones: c.opciones || {},
            autoconectar: c.autoconectar ?? true,
          };
          break;
        }
        case 'historian': {
          const h = node.config;

          // Red de seguridad: en modo "seleccion" una lista vacía significaría
          // para el backend TODOS los tags, justo lo contrario de lo que quiso
          // decir el usuario. Se bloquea antes de mandar nada.
          if (h.modo_tags === 'seleccion' && (h.tags || []).length === 0) {
            onUpdateStatus(
              node.id, 'error',
              'No hay tags seleccionados. Marca al menos uno, o cambia a ' +
              '"Todos los tags" si de verdad quieres guardar todo.'
            );
            setSaving(false);
            return;
          }

          url = `${API_BASE}/historian`;
          body = {
            grupo_id: h.grupo_id,
            db_id: h.db_id,
            // En modo "todos" se manda [] a propósito: para el backend una
            // lista vacía significa TODOS los tags de todos los PLCs. La
            // selección del usuario se conserva en config por si vuelve a
            // cambiar de modo, pero no se envía.
            tags: h.modo_tags === 'seleccion' ? (h.tags || []) : [],
            tabla: h.tabla || 'historico_tags',
            nombre: h.nombre || '',
            activo: h.activo ?? true,
            banda_muerta: h.banda_muerta ?? 0,
            intervalo_min_ms: h.intervalo_min_ms ?? 0,
          };
          break;
        }
        // Start y Stop son el mismo POST cambiando la última parte de la ruta.
        case 'start':
        case 'stop': {
          const grupoId = (node.config.grupo_id || '').trim();
          if (!grupoId) {
            onUpdateStatus(node.id, 'error', 'Falta grupo_id');
            setSaving(false);
            return;
          }
          url = `${API_BASE}/historian/${encodeURIComponent(grupoId)}/${node.type}`;
          body = {};
          break;
        }
        default:
          setSaving(false);
          return;
      }

      let resp: Response;
      try {
        resp = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
      } catch {
        // fetch solo lanza si NO hubo respuesta: backend apagado, CORS, DNS...
        throw new Error(ERROR_SIN_BACKEND);
      }

      // Se lee como texto primero: si el backend devuelve HTML (por ejemplo el
      // fallback de la SPA ante una ruta mal escrita) JSON.parse reventaría.
      const raw = await resp.text();
      let data: any = null;
      try {
        data = raw ? JSON.parse(raw) : null;
      } catch {
        data = null;
      }

      // 1) Error de transporte / validación (4xx, 5xx).
      if (!resp.ok) {
        throw new Error(
          extraerMensaje(data) || raw.slice(0, 300) || `HTTP ${resp.status} ${resp.statusText}`
        );
      }

      // 2) Error de NEGOCIO: el backend responde 200 con {"ok": false}.
      //    Es el caso de credenciales de BD inválidas, db_id inexistente,
      //    grupo inexistente... Sin este chequeo el nodo se pintaba de verde.
      if (data && data.ok === false) {
        throw new Error(extraerMensaje(data) || 'El servidor rechazó la operación.');
      }

      // Se prefiere el mensaje del backend: trae el detalle útil
      // ("Conexión 'x' verificada y guardada.", latencia, etc.).
      onUpdateStatus(node.id, 'ok', extraerMensaje(data) || 'Guardado correctamente');
    } catch (err: any) {
      onUpdateStatus(node.id, 'error', err?.message || 'Error desconocido');
    } finally {
      setSaving(false);
    }
  };

  const TypeIcon =
    node.type === 'connection' ? DatabaseIcon :
    node.type === 'historian' ? ActivityIcon :
    node.type === 'start' ? PlayIcon :
    SquareIcon;

  const typeLabel =
    node.type === 'connection' ? 'Conexión BD' :
    node.type === 'historian' ? 'Historian' :
    node.type === 'start' ? 'Start' :
    'Stop';

  const typeColor =
    node.type === 'connection' ? 'text-siemens' :
    node.type === 'historian' ? 'text-amber-500' :
    node.type === 'start' ? 'text-green-500' :
    'text-red-500';

  return (
    <div className="mp-scroll mp-scroll-dark flex w-72 flex-col border-l border-slate-200 bg-white dark:border-navy-slate dark:bg-navy-soft">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3 dark:border-navy-slate">
        <div className="flex items-center gap-2">
          <TypeIcon className={`h-4 w-4 ${typeColor}`} />
          <div>
            <p className="text-xs font-bold text-slate-800 dark:text-slate-100">{typeLabel}</p>
            <p className="text-[10px] text-slate-400">{node.id}</p>
          </div>
        </div>
      </div>

      {/* Form */}
      <div className="flex-1 overflow-y-auto px-4 py-3">
        {node.type === 'connection' && (
          <ConnectionForm config={node.config} onChange={handleChange} />
        )}
        {node.type === 'historian' && (
          <HistorianForm
            config={node.config}
            connectionNodes={connectionNodes}
            onChange={handleChange}
          />
        )}
        {node.type === 'start' && (
          <StartForm
            config={node.config}
            historianNodes={historianNodes}
            onChange={handleChange}
          />
        )}
        {node.type === 'stop' && (
          <StopForm
            config={node.config}
            historianNodes={historianNodes}
            onChange={handleChange}
          />
        )}
      </div>

      {/* Status message */}
      {node.statusMsg && (
        <div
          className={`mx-4 mb-2 flex max-h-40 gap-2 overflow-y-auto rounded-md border px-3 py-2 text-[11px] ${
            node.status === 'ok'
              ? 'border-green-200 bg-green-50 text-green-700 dark:border-green-500/20 dark:bg-green-500/10 dark:text-green-400'
              : node.status === 'error'
              ? 'border-red-200 bg-red-50 text-red-700 dark:border-red-500/20 dark:bg-red-500/10 dark:text-red-400'
              : 'border-slate-200 bg-slate-50 text-slate-500 dark:border-navy-slate dark:bg-navy-slate/40'
          }`}
          title={node.statusMsg}
        >
          {node.status === 'ok' && (
            <CheckCircle2Icon className="mt-px h-3.5 w-3.5 shrink-0" />
          )}
          {node.status === 'error' && (
            <AlertCircleIcon className="mt-px h-3.5 w-3.5 shrink-0" />
          )}
          {/* break-words + whitespace-pre-wrap: los errores de ODBC/SQL Server
              son larguísimos y sin esto se salían del panel. */}
          <span className="min-w-0 whitespace-pre-wrap break-words">
            {node.statusMsg}
          </span>
        </div>
      )}

      {/* Actions */}
      <div className="flex items-center gap-2 border-t border-slate-100 px-4 py-3 dark:border-navy-slate">
        <button
          onClick={handleSave}
          disabled={saving}
          className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-siemens px-3 py-2 text-xs font-semibold text-white transition hover:bg-siemens-600 disabled:opacity-50"
        >
          <SaveIcon className="h-3.5 w-3.5" />
          {saving ? 'Guardando…' : 'Guardar'}
        </button>
        <button
          onClick={() => onDelete(node.id)}
          className="flex items-center justify-center rounded-lg px-3 py-2 text-xs text-slate-400 transition hover:bg-red-50 hover:text-red-500 dark:hover:bg-red-500/10"
          title="Eliminar nodo"
        >
          <Trash2Icon className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}
