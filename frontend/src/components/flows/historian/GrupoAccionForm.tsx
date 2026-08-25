import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  RefreshCwIcon,
  Loader2Icon,
  AlertTriangleIcon,
} from 'lucide-react';
import { FlowNodeData } from '../types';
import { GrupoRemoto, cargarGrupos } from '../api';

export type AccionGrupo = 'start' | 'stop';

interface Props {
  /** Qué endpoint representa el nodo: `/start` o `/stop`. */
  accion: AccionGrupo;
  config: Record<string, any>;
  historianNodes: FlowNodeData[];
  onChange: (patch: Record<string, any>) => void;
}

/**
 * Textos y colores de cada acción. Start y Stop comparten TODO lo demás
 * (selector de grupo, fusión servidor+lienzo, ficha de estadísticas), así que
 * lo único que cambia vive acá.
 */
const TEXTOS: Record<AccionGrupo, {
  ruta: string;
  verbo: string;
  /** Estado del grupo en el que la acción no haría nada. */
  redundanteSi: boolean;
  avisoRedundante: string;
  clases: string;
  clasesTexto: string;
}> = {
  start: {
    ruta: '/historian/{grupo_id}/start',
    verbo: 'reanudar',
    redundanteSi: true,   // ya está activo
    avisoRedundante: 'Este grupo ya está capturando. Mandar el start igual no rompe nada (es idempotente), pero tampoco hace nada.',
    clases: 'border-green-200 bg-green-50 dark:border-green-500/20 dark:bg-green-500/5',
    clasesTexto: 'text-green-700 dark:text-green-400',
  },
  stop: {
    ruta: '/historian/{grupo_id}/stop',
    verbo: 'pausar',
    redundanteSi: false,  // ya está detenido
    avisoRedundante: 'Este grupo ya está detenido. Mandar el stop igual no rompe nada (es idempotente), pero tampoco hace nada.',
    clases: 'border-red-200 bg-red-50 dark:border-red-500/20 dark:bg-red-500/5',
    clasesTexto: 'text-red-600 dark:text-red-400',
  },
};

/** Un grupo ofrecible en el select, venga del servidor o del lienzo. */
interface OpcionGrupo {
  grupo_id: string;
  etiqueta: string;
  origen: 'servidor' | 'lienzo' | 'desconocido';
  datos?: GrupoRemoto;
}

const fmt = (n: number) => (n ?? 0).toLocaleString('es-PE');

function fmtFecha(iso: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return isNaN(d.getTime()) ? iso : d.toLocaleString('es-PE');
}

export function GrupoAccionForm({ accion, config, historianNodes, onChange }: Props) {
  const t = TEXTOS[accion];
  const [grupos, setGrupos] = useState<GrupoRemoto[]>([]);
  const [cargando, setCargando] = useState(false);
  const [error, setError] = useState('');

  const recargar = useCallback(async () => {
    setCargando(true);
    setError('');
    try {
      setGrupos(await cargarGrupos());
    } catch (err: any) {
      setError(err?.message || 'No se pudieron cargar los grupos.');
      setGrupos([]);
    } finally {
      setCargando(false);
    }
  }, []);

  useEffect(() => { recargar(); }, [recargar]);

  /**
   * Fusiona los grupos reales del historizador con los nodos del lienzo.
   *
   * Los nodos Historian sin `grupo_id` se descartan: antes se ofrecían con
   * `value=""`, indistinguible del placeholder "— Seleccionar —".
   */
  const opciones = useMemo<OpcionGrupo[]>(() => {
    const mapa = new Map<string, OpcionGrupo>();

    for (const g of grupos) {
      mapa.set(g.grupo_id, {
        grupo_id: g.grupo_id,
        etiqueta: `${g.grupo_id}${g.nombre && g.nombre !== g.grupo_id ? ` · ${g.nombre}` : ''}`,
        origen: 'servidor',
        datos: g,
      });
    }

    for (const n of historianNodes) {
      const id = (n.config?.grupo_id || '').trim();
      if (!id || mapa.has(id)) continue;
      mapa.set(id, { grupo_id: id, etiqueta: id, origen: 'lienzo' });
    }

    const actual = (config.grupo_id || '').trim();
    if (actual && !mapa.has(actual)) {
      mapa.set(actual, { grupo_id: actual, etiqueta: actual, origen: 'desconocido' });
    }

    return Array.from(mapa.values());
  }, [grupos, historianNodes, config.grupo_id]);

  const delServidor = opciones.filter((o) => o.origen === 'servidor');
  const delLienzo = opciones.filter((o) => o.origen === 'lienzo');
  const desconocidos = opciones.filter((o) => o.origen === 'desconocido');
  const actual = opciones.find((o) => o.grupo_id === (config.grupo_id || '').trim());
  const datos = actual?.datos;

  return (
    <div className="space-y-3">
      {/* grupo_id */}
      <Field label={accion === 'start' ? 'Grupo a iniciar' : 'Grupo a detener'} required>
        <div className="flex items-center gap-1.5">
          {opciones.length > 0 ? (
            <select
              value={config.grupo_id || ''}
              onChange={(e) => onChange({ grupo_id: e.target.value })}
              className="input-field flex-1"
            >
              <option value="">— Seleccionar —</option>
              {delServidor.length > 0 && (
                <optgroup label="En el historizador">
                  {delServidor.map((o) => (
                    <option key={o.grupo_id} value={o.grupo_id}>
                      {o.etiqueta} {o.datos?.activo ? '• activo' : '• detenido'}
                    </option>
                  ))}
                </optgroup>
              )}
              {delLienzo.length > 0 && (
                <optgroup label="En el lienzo (sin guardar)">
                  {delLienzo.map((o) => (
                    <option key={o.grupo_id} value={o.grupo_id}>{o.etiqueta}</option>
                  ))}
                </optgroup>
              )}
              {desconocidos.length > 0 && (
                <optgroup label="No está en el historizador">
                  {desconocidos.map((o) => (
                    <option key={o.grupo_id} value={o.grupo_id}>{o.etiqueta}</option>
                  ))}
                </optgroup>
              )}
            </select>
          ) : (
            <input
              type="text"
              value={config.grupo_id || ''}
              onChange={(e) => onChange({ grupo_id: e.target.value })}
              placeholder="ID del grupo historian"
              className="input-field flex-1"
            />
          )}
          <button
            type="button"
            onClick={recargar}
            disabled={cargando}
            title="Recargar desde GET /historian"
            className="shrink-0 rounded-md p-1.5 text-slate-400 transition hover:bg-slate-100 hover:text-siemens disabled:opacity-40 dark:hover:bg-navy-slate/40"
          >
            {cargando
              ? <Loader2Icon className="h-3.5 w-3.5 animate-spin" />
              : <RefreshCwIcon className="h-3.5 w-3.5" />}
          </button>
        </div>

        {error && (
          <p className="mt-1 break-words text-[10px] text-amber-500">
            No se pudo leer GET /historian ({error}). Se muestran solo los del lienzo.
          </p>
        )}
      </Field>

      {/* Avisos según el grupo elegido */}
      {actual?.origen === 'lienzo' && (
        <Aviso>
          Este grupo está dibujado pero todavía no existe en el historizador.
          Guarda primero el nodo Historian, o el {accion} te va a responder
          «No existe el grupo».
        </Aviso>
      )}

      {actual?.origen === 'desconocido' && (
        <Aviso>
          El historizador no conoce el grupo <b>{actual.grupo_id}</b>. El {accion} va
          a responder «No existe el grupo».
        </Aviso>
      )}

      {/* La acción no haría nada porque el grupo ya está en ese estado. */}
      {datos && datos.activo === t.redundanteSi && (
        <Aviso>{t.avisoRedundante}</Aviso>
      )}

      {/* Estadísticas del grupo elegido */}
      {datos && (
        <div className="space-y-1.5 rounded-lg border border-slate-200 bg-slate-50 p-3 dark:border-navy-slate dark:bg-navy-slate/30">
          <div className="flex items-center justify-between gap-2">
            <span className="truncate text-[11px] font-bold text-slate-700 dark:text-slate-200">
              {datos.grupo_id}
            </span>
            <span
              className={`shrink-0 rounded px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide ${
                datos.activo
                  ? 'bg-green-100 text-green-700 dark:bg-green-500/15 dark:text-green-400'
                  : 'bg-slate-200 text-slate-500 dark:bg-navy-slate dark:text-slate-400'
              }`}
            >
              {datos.activo ? 'activo' : 'detenido'}
            </span>
          </div>

          <Dato etiqueta="Destino" valor={`${datos.db_id} → ${datos.tabla}`} />
          <Dato
            etiqueta="Tags"
            valor={datos.todos_los_tags ? 'todos los tags' : `${fmt(datos.num_tags)} seleccionado(s)`}
          />
          <Dato etiqueta="Filas escritas" valor={fmt(datos.filas_escritas)} />
          <Dato
            etiqueta="En buffer"
            valor={fmt(datos.en_buffer)}
            // Buffer creciendo = la BD no está aceptando las escrituras.
            alerta={datos.en_buffer > 0}
          />
          {datos.filas_descartadas > 0 && (
            <Dato etiqueta="Descartadas" valor={fmt(datos.filas_descartadas)} />
          )}
          <Dato etiqueta="Última escritura" valor={fmtFecha(datos.ultima_escritura)} />

          {datos.ultimo_error && (
            <p className="break-words rounded bg-red-50 px-2 py-1 text-[10px] text-red-600 dark:bg-red-500/10 dark:text-red-400">
              {datos.ultimo_error}
            </p>
          )}
        </div>
      )}

      <div className={`rounded-lg border p-3 ${t.clases}`}>
        <p className={`text-[11px] ${t.clasesTexto}`}>
          Al guardar se enviará{' '}
          <code className="font-mono font-bold">POST {t.ruta}</code> para{' '}
          {t.verbo} la captura del grupo seleccionado.{' '}
          {accion === 'start'
            ? 'La configuración del grupo no cambia: esto es solo el interruptor.'
            : 'No se borra ni la configuración ni los datos ya guardados.'}
        </p>
      </div>
    </div>
  );
}

// ─── Helpers de presentación ────────────────────────────────────
function Dato({ etiqueta, valor, alerta }: { etiqueta: string; valor: string; alerta?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-2 text-[10px]">
      <span className="shrink-0 text-slate-400">{etiqueta}</span>
      <span
        className={`min-w-0 truncate text-right font-medium ${
          alerta ? 'text-amber-600 dark:text-amber-400' : 'text-slate-600 dark:text-slate-300'
        }`}
        title={valor}
      >
        {valor}
      </span>
    </div>
  );
}

function Aviso({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex gap-2 rounded-lg border border-amber-200 bg-amber-50 p-2.5 dark:border-amber-500/20 dark:bg-amber-500/5">
      <AlertTriangleIcon className="mt-px h-3.5 w-3.5 shrink-0 text-amber-500" />
      <p className="min-w-0 break-words text-[11px] text-amber-700 dark:text-amber-400">
        {children}
      </p>
    </div>
  );
}

function Field({ label, required, children }: { label: string; required?: boolean; children: React.ReactNode }) {
  return (
    <div>
      <label className="mb-1 block text-[11px] font-semibold text-slate-500 dark:text-slate-400">
        {label}
        {required && <span className="ml-0.5 text-red-400">*</span>}
      </label>
      {children}
    </div>
  );
}
