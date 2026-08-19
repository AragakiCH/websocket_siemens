import { AlertTriangleIcon, Loader2Icon } from 'lucide-react';

interface Props {
  /** grupo_id de los grupos que siguen capturando en el servidor. */
  grupos: string[];
  /** Cuántos nodos se van a borrar (para redactar bien el mensaje). */
  numNodos: number;
  procesando: boolean;
  error: string;
  onSoloDibujo: () => void;
  onDetenerYBorrar: () => void;
  onCancelar: () => void;
}

/**
 * Aviso antes de borrar un nodo Historian cuyo grupo sigue activo.
 *
 * Borrar el dibujo NO detiene la captura — el grupo vive en el backend, en
 * `datos/historicos.json`, y sigue escribiendo aunque el lienzo quede vacío.
 * En vez de encadenar el borrado con un stop automático (que convertiría un
 * clic en la papelera en una parada de producción), se pregunta.
 */
export function ConfirmarBorrado({
  grupos, numNodos, procesando, error,
  onSoloDibujo, onDetenerYBorrar, onCancelar,
}: Props) {
  return (
    <div
      className="fixed inset-0 flex items-center justify-center bg-navy/40 p-4 backdrop-blur-sm"
      style={{ zIndex: 100 }}
      onPointerDown={(e) => { e.stopPropagation(); if (!procesando) onCancelar(); }}
    >
      <div
        className="w-full max-w-sm rounded-xl border border-slate-200 bg-white shadow-2xl dark:border-navy-slate dark:bg-navy-soft"
        onPointerDown={(e) => e.stopPropagation()}
      >
        {/* Cabecera */}
        <div className="flex gap-3 border-b border-slate-100 p-4 dark:border-navy-slate">
          <AlertTriangleIcon className="mt-0.5 h-5 w-5 shrink-0 text-amber-500" />
          <div className="min-w-0">
            <h3 className="text-sm font-bold text-slate-800 dark:text-slate-100">
              {grupos.length === 1
                ? 'Este grupo sigue capturando'
                : `${grupos.length} grupos siguen capturando`}
            </h3>
            <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
              Borrar {numNodos === 1 ? 'el nodo' : 'los nodos'} solo quita el
              dibujo del lienzo. En el servidor la captura continúa y las filas
              se siguen escribiendo.
            </p>
          </div>
        </div>

        {/* Grupos afectados */}
        <div className="max-h-32 overflow-y-auto px-4 py-3">
          <ul className="space-y-1">
            {grupos.map((g) => (
              <li key={g} className="flex items-center gap-2 text-xs">
                <span className="relative flex h-2 w-2 shrink-0">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-green-400 opacity-60" />
                  <span className="relative inline-flex h-2 w-2 rounded-full bg-green-500" />
                </span>
                <span className="min-w-0 truncate font-mono text-slate-600 dark:text-slate-300">
                  {g}
                </span>
              </li>
            ))}
          </ul>
        </div>

        {error && (
          <p className="mx-4 mb-2 break-words rounded-md bg-red-50 px-3 py-2 text-[11px] text-red-600 dark:bg-red-500/10 dark:text-red-400">
            {error}
          </p>
        )}

        {/* Acciones */}
        <div className="flex flex-col gap-2 border-t border-slate-100 p-4 dark:border-navy-slate">
          <button
            onClick={onDetenerYBorrar}
            disabled={procesando}
            className="flex items-center justify-center gap-1.5 rounded-lg bg-siemens px-3 py-2 text-xs font-semibold text-white transition hover:bg-siemens-600 disabled:opacity-50"
          >
            {procesando && <Loader2Icon className="h-3.5 w-3.5 animate-spin" />}
            {procesando ? 'Deteniendo…' : 'Detener y borrar'}
          </button>
          <button
            onClick={onSoloDibujo}
            disabled={procesando}
            className="rounded-lg border border-slate-200 px-3 py-2 text-xs font-medium text-slate-600 transition hover:bg-slate-50 disabled:opacity-50 dark:border-navy-slate dark:text-slate-300 dark:hover:bg-navy-slate/40"
          >
            Solo borrar el dibujo
          </button>
          <button
            onClick={onCancelar}
            disabled={procesando}
            className="rounded-lg px-3 py-1.5 text-xs text-slate-400 transition hover:text-slate-600 disabled:opacity-50 dark:hover:text-slate-200"
          >
            Cancelar
          </button>
        </div>
      </div>
    </div>
  );
}
