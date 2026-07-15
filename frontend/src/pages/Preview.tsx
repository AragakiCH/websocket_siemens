// =========================================================================
// Preview.tsx  (ruta /preview)
// Muestra SOLO el diseño hecho en el Designer, sin cuadrícula, sin
// herramientas de edición, con las medidas exactas que se eligieron y con
// los valores del PLC en vivo. Pensada para abrirse en una pestaña nueva.
//
// - Los widgets + medidas se leen de localStorage (los guarda el Designer).
// - Los valores en vivo salen de useAppStore().variables: al montarse este
//   contexto, el RealPLCService abre su propio WebSocket y recibe el
//   snapshot del backend, así que los valores llegan solos.
// =========================================================================
import React, { useEffect, useState } from 'react';
import { useAppStore } from '../context/AppStore';
import { WidgetRenderer } from '../components/hmi/WidgetRenderer';
import { loadDesign, SavedDesign, DESIGN_KEY } from '../utils/designStorage';

export function Preview() {
  const { variables, isDark } = useAppStore();
  const [design, setDesign] = useState<SavedDesign | null>(() => loadDesign());

  // Si el diseño cambia en la pestaña del Designer, se refleja aquí en vivo.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === DESIGN_KEY) setDesign(loadDesign());
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  if (!design || design.widgets.length === 0) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-slate-100 p-8 text-center text-sm text-slate-500 dark:bg-navy dark:text-slate-400">
        No hay ningún diseño guardado todavía. Crea uno en el Designer y vuelve
        a abrir la vista previa.
      </div>
    );
  }

  const { widgets, canvas } = design;

  return (
    <div className="flex min-h-full w-full items-center justify-center overflow-auto bg-slate-200 p-6 dark:bg-navy">
      <div
        className={`relative overflow-hidden rounded-lg shadow-xl ${
          isDark ? 'bg-navy-soft' : 'bg-white'
        }`}
        style={{ width: canvas.width, height: canvas.height }}>
        {widgets
          .filter((w) => w.visible !== false)
          .map((w) => (
            <div
              key={w.id}
              style={{
                position: 'absolute',
                left: w.x,
                top: w.y,
                width: w.width,
                height: w.height
              }}>
              <WidgetRenderer
                widget={w}
                variable={
                  w.variableId
                    ? variables.find((v) => v.id === w.variableId)
                    : undefined
                }
              />
            </div>
          ))}
      </div>
    </div>
  );
}
