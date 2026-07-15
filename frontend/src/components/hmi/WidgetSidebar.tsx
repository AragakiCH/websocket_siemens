import React from 'react';
import { motion } from 'framer-motion';
import { widgetCatalog, CatalogItem } from './widgetCatalog';
import { useAppStore } from '../../context/AppStore';
const categories: CatalogItem['category'][] = [
'Básicos',
'Indicadores',
'Equipos',
'Datos'];

export function WidgetSidebar() {
  const { t, widgetLabel } = useAppStore();
  return (
    <aside className="mp-scroll mp-scroll-dark flex w-60 shrink-0 flex-col overflow-auto border-r border-slate-200 bg-white dark:border-navy-slate dark:bg-navy-soft">
      <div className="border-b border-slate-100 px-4 py-3 dark:border-navy-slate">
        <h2 className="text-sm font-bold text-navy dark:text-slate-100">
          {t('sidebar.title')}
        </h2>
        <p className="text-xs text-slate-400">{t('sidebar.hint')}</p>
      </div>
      <div className="p-3">
        {categories.map((cat) =>
        <div key={cat} className="mb-4">
            <p className="mb-2 px-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
              {t(`cat.${cat}`)}
            </p>
            <div className="grid grid-cols-2 gap-2">
              {widgetCatalog.
            filter((w) => w.category === cat).
            map((w) => {
              const Icon = w.icon;
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
                  whileHover={{
                    scale: 1.04
                  }}
                  whileTap={{
                    scale: 0.96
                  }}
                  className="flex cursor-grab flex-col items-center gap-1.5 rounded-lg border border-slate-200 bg-slate-50 p-2.5 text-center transition hover:border-siemens/40 hover:bg-siemens-50 active:cursor-grabbing dark:border-navy-slate dark:bg-navy dark:hover:border-siemens/50 dark:hover:bg-siemens/10">
                  
                      <Icon className="h-5 w-5 text-siemens" />
                      <span className="text-[11px] font-medium leading-tight text-navy dark:text-slate-200">
                        {widgetLabel(w.kind)}
                      </span>
                    </motion.div>);

            })}
            </div>
          </div>
        )}
      </div>
    </aside>);

}