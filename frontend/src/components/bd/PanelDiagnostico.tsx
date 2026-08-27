// =========================================================================
// PanelDiagnostico.tsx — el "por qué no conecta", en tres capas
//
// Un error de conexión tiene tres audiencias a la vez, y darles el mismo texto
// no sirve a ninguna:
//
//   QUÉ PASÓ      una frase. Sitúa el problema (¿es la red? ¿la contraseña?)
//   QUÉ HACER     la acción concreta. Es lo único que desbloquea a alguien
//   EL DETALLE    el mensaje literal del driver, plegado. Es lo que se busca
//                 en Google cuando la traducción no acierta
//
// El detalle SIEMPRE está. Un diagnóstico equivocado que además esconda el
// error original deja a la persona sin nada — peor que no traducir nada.
// =========================================================================
import { useState } from 'react';
import {
  AlertCircleIcon,
  ChevronDownIcon,
  KeyRoundIcon,
  LightbulbIcon,
  PackageIcon,
  ServerCrashIcon,
  ShieldAlertIcon,
} from 'lucide-react';
import type { Diagnostico } from '../flows/api';

/**
 * Un icono por familia de problema.
 *
 * No es decoración: cambia dónde mira la persona antes de leer. Una llave
 * dice "revisa la contraseña" y un enchufe roto dice "ni siquiera llegaste al
 * servidor" — y esas dos son las que más se confunden entre sí.
 */
const ICONO: Record<string, typeof AlertCircleIcon> = {
  falta_paquete: PackageIcon,
  falta_driver: PackageIcon,
  sin_servidor: ServerCrashIcon,
  host_desconocido: ServerCrashIcon,
  timeout: ServerCrashIcon,
  credenciales: KeyRoundIcon,
  sin_permisos: ShieldAlertIcon,
  base_no_existe: AlertCircleIcon,
  ruta_no_existe: AlertCircleIcon,
  tls: ShieldAlertIcon,
  desconocido: AlertCircleIcon,
};

export function PanelDiagnostico({
  diagnostico,
  mensajeCrudo,
}: {
  /** Lo que devolvió el backend. Si falta, se muestra `mensajeCrudo` a secas. */
  diagnostico?: Diagnostico;
  /** Texto de respaldo cuando el fallo no llegó a producir diagnóstico. */
  mensajeCrudo?: string;
}) {
  const [abierto, setAbierto] = useState(false);

  // Sin diagnóstico (backend viejo, o un fallo antes de intentar conectar):
  // se enseña el texto tal cual. Nunca una pantalla vacía.
  if (!diagnostico) {
    if (!mensajeCrudo) return null;
    return (
      <p
        role="alert"
        className="mt-4 flex items-start gap-2 rounded-lg border border-state-error/30 bg-state-error/5 px-3 py-2.5 text-xs leading-relaxed text-state-error"
      >
        <AlertCircleIcon className="mt-px h-3.5 w-3.5 shrink-0" />
        <span className="min-w-0 break-words">{mensajeCrudo}</span>
      </p>
    );
  }

  const Icono = ICONO[diagnostico.codigo] ?? AlertCircleIcon;

  return (
    <div
      role="alert"
      className="mt-4 rounded-xl border border-state-error/30 bg-state-error/5 p-3.5"
    >
      {/* Qué pasó */}
      <div className="flex items-start gap-2.5">
        <Icono className="mt-px h-4 w-4 shrink-0 text-state-error" />
        <div className="min-w-0">
          <p className="text-[13px] font-semibold text-state-error">
            {diagnostico.titulo}
          </p>
          <p className="mt-1 text-xs leading-relaxed text-state-error/90">
            {diagnostico.mensaje}
          </p>
        </div>
      </div>

      {/* Qué hacer — separado a propósito: es la parte que desbloquea */}
      {diagnostico.sugerencia && (
        <div className="mt-3 flex items-start gap-2.5 rounded-lg bg-slate-100/80 px-3 py-2.5 dark:bg-navy/60">
          <LightbulbIcon className="mt-px h-4 w-4 shrink-0 text-amber-500" />
          <p className="min-w-0 text-xs leading-relaxed text-slate-600 dark:text-slate-300">
            {diagnostico.sugerencia}
          </p>
        </div>
      )}

      {/* El error literal del driver */}
      {diagnostico.detalle && (
        <div className="mt-2.5">
          <button
            type="button"
            onClick={() => setAbierto((v) => !v)}
            aria-expanded={abierto}
            className="flex items-center gap-1 rounded text-[11px] font-semibold text-slate-500 outline-none transition hover:text-slate-700 focus-visible:ring-2 focus-visible:ring-siemens/40 dark:text-slate-400 dark:hover:text-slate-200"
          >
            <ChevronDownIcon
              className={`h-3 w-3 transition-transform ${abierto ? 'rotate-180' : ''}`}
            />
            Detalle técnico
          </button>
          {abierto && (
            <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-slate-900/90 p-3 text-[10.5px] leading-relaxed text-slate-300">
              {diagnostico.detalle}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

/** Saca el diagnóstico que `flows/api.ts` pega al Error, si lo hay. */
export function diagnosticoDe(e: any): Diagnostico | undefined {
  return e?.diagnostico as Diagnostico | undefined;
}
