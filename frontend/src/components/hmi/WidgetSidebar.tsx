import React, { useCallback, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { UploadIcon, Trash2Icon, AlertCircleIcon, CheckCircle2Icon } from 'lucide-react';
import { getWidgetCatalog, CatalogItem } from './widgetCatalog';
import { useAppStore } from '../../context/AppStore';
import {
  parseWidgetZip,
  addZipWidget,
  removeZipWidget,
  loadZipWidgets,
  fullKind,
} from '../../services/zipWidgetLoader';

const categories: CatalogItem['category'][] = [
  'Básicos',
  'Indicadores',
  'Equipos',
  'Datos',
];

export function WidgetSidebar() {
  const { t, widgetLabel } = useAppStore();
  const fileRef = useRef<HTMLInputElement>(null);
  const [catalog, setCatalog] = useState(() => getWidgetCatalog());
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null);

  // Refresca el catálogo después de agregar/quitar un ZIP widget
  const refreshCatalog = useCallback(() => setCatalog(getWidgetCatalog()), []);

  const showToast = (msg: string, ok: boolean) => {
    setToast({ msg, ok });
    setTimeout(() => setToast(null), 3000);
  };

  const handleUpload = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    // Limpiar el input para poder subir el mismo archivo otra vez
    e.target.value = '';
    try {
      const widget = await parseWidgetZip(file);
      // Se espera al guardado: si el servidor lo rechaza hay que decirlo,
      // no dejar creer que quedó guardado (se perdería al cerrar).
      await addZipWidget(widget);
      refreshCatalog();
      showToast(`"${widget.meta.label}" cargado`, true);
    } catch (err: any) {
      showToast(err?.message || 'Error al cargar el ZIP', false);
    }
  }, [refreshCatalog]);

  const handleRemoveZip = useCallback(async (kind: string, label: string) => {
    await removeZipWidget(kind);
    refreshCatalog();
    showToast(`"${label}" eliminado`, true);
  }, [refreshCatalog]);

  // Identifica qué kinds son ZIP widgets para mostrar botón de eliminar
  const zipKinds: Set<string> = new Set(loadZipWidgets().map((z) => fullKind(z.meta.kind)));

  return (
    <aside className="mp-scroll mp-scroll-dark flex w-60 shrink-0 flex-col overflow-auto border-r border-slate-200 bg-white dark:border-navy-slate dark:bg-navy-soft">
      <div className="border-b border-slate-100 px-4 py-3 dark:border-navy-slate">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-sm font-bold text-navy dark:text-slate-100">
              {t('sidebar.title')}
            </h2>
            <p className="text-xs text-slate-400">{t('sidebar.hint')}</p>
          </div>
          <button
            onClick={() => fileRef.current?.click()}
            title={t('sidebar.uploadZip')}
            className="flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 transition hover:bg-siemens-50 hover:text-siemens dark:hover:bg-siemens/15"
          >
            <UploadIcon className="h-4 w-4" />
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".zip"
            className="hidden"
            onChange={handleUpload}
          />
        </div>
      </div>

      <div className="p-3">
        {categories.map((cat) => {
          const items = catalog.filter((w) => w.category === cat);
          if (items.length === 0) return null;
          return (
            <div key={cat} className="mb-4">
              <p className="mb-2 px-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                {t(`cat.${cat}`)}
              </p>
              <div className="grid grid-cols-2 gap-2">
                {items.map((w) => {
                  const Icon = w.icon;
                  const isZip = zipKinds.has(w.kind);
                  return (
                    <motion.div
                      key={w.kind}
                      draggable
                      onDragStart={(e) => {
                        (e as unknown as React.DragEvent).dataTransfer.setData(
                          'widget-kind',
                          w.kind
                        );
                      }}
                      whileHover={{ scale: 1.04 }}
                      whileTap={{ scale: 0.96 }}
                      className="group relative flex cursor-grab flex-col items-center gap-1.5 rounded-lg border border-slate-200 bg-slate-50 p-2.5 text-center transition hover:border-siemens/40 hover:bg-siemens-50 active:cursor-grabbing dark:border-navy-slate dark:bg-navy dark:hover:border-siemens/50 dark:hover:bg-siemens/10"
                    >
                      <Icon className="h-5 w-5 text-siemens" />
                      <span className="text-[11px] font-medium leading-tight text-navy dark:text-slate-200">
                        {widgetLabel(w.kind)}
                      </span>
                      {isZip && (
                        <button
                          onClick={(ev) => {
                            ev.stopPropagation();
                            ev.preventDefault();
                            handleRemoveZip(
                              w.kind.replace('custom:', ''),
                              w.label
                            );
                          }}
                          className="absolute -right-1 -top-1 hidden h-5 w-5 items-center justify-center rounded-full bg-red-500 text-white shadow group-hover:flex"
                          title={t('sidebar.removeWidget')}
                        >
                          <Trash2Icon className="h-3 w-3" />
                        </button>
                      )}
                    </motion.div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>

      {/* Toast de feedback */}
      <AnimatePresence>
        {toast && (
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 10 }}
            className={`fixed bottom-4 left-4 z-50 flex items-center gap-2 rounded-xl px-4 py-2.5 text-xs font-medium text-white shadow-xl ${
              toast.ok ? 'bg-state-ok' : 'bg-red-500'
            }`}
          >
            {toast.ok ? (
              <CheckCircle2Icon className="h-4 w-4" />
            ) : (
              <AlertCircleIcon className="h-4 w-4" />
            )}
            {toast.msg}
          </motion.div>
        )}
      </AnimatePresence>
    </aside>
  );
}