import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import {
  ArrowLeftIcon,
  SaveIcon,
  CheckCircle2Icon,
  DatabaseIcon,
  SlidersHorizontalIcon } from
'lucide-react';
import { useAppStore } from '../context/AppStore';
import { UPDATE_RATE_OPTIONS, DataType } from '../models/plc';
import { formatValue } from '../utils/format';
import { SelectField } from '../components/ui/Field';
const typeColor: Record<DataType, string> = {
  bool: 'bg-purple-100 text-purple-700',
  int: 'bg-blue-100 text-blue-700',
  double: 'bg-teal-100 text-teal-700',
  string: 'bg-amber-100 text-amber-700'
};
export function Configuracion() {
  const navigate = useNavigate();
  const {
    variables,
    toggleVariable,
    config,
    setUpdateRate,
    setTheme,
    setLanguage,
    saveConfig,
    t
  } = useAppStore();
  const [saved, setSaved] = useState(false);
  const selectedCount = variables.filter((v) => v.selected).length;
  // Rate labels: sub-second ones are language-neutral ("250 ms"); translate the rest.
  const rateOptions = UPDATE_RATE_OPTIONS.map((o) =>
  o.value >= 1000 ?
  {
    label: t(`rate.${o.value}`),
    value: o.value
  } :
  o
  );
  const handleSave = () => {
    saveConfig();
    setSaved(true);
    setTimeout(() => setSaved(false), 2200);
  };
  return (
    <div className="flex min-h-full w-full flex-col bg-slate-50 dark:bg-navy">
      <header className="flex items-center justify-between border-b border-slate-200 bg-white px-6 py-4 dark:border-navy-slate dark:bg-navy-soft">
        <div className="flex items-center gap-3">
          <button
            onClick={() => navigate('/menu')}
            className="flex h-9 w-9 items-center justify-center rounded-lg text-slate-500 transition hover:bg-slate-100 dark:hover:bg-navy-slate/40">
            
            <ArrowLeftIcon className="h-5 w-5" />
          </button>
          <div>
            <h1 className="text-lg font-bold text-navy dark:text-slate-100">
              {t('config.title')}
            </h1>
            <p className="text-xs text-slate-400">{t('config.subtitle')}</p>
          </div>
        </div>
        <button
          onClick={handleSave}
          className="flex items-center gap-2 rounded-lg bg-siemens px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-siemens-600">
          
          <SaveIcon className="h-4 w-4" />
          {t('config.save')}
        </button>
      </header>

      <div className="mp-scroll mp-scroll-dark grid flex-1 grid-cols-1 gap-6 overflow-auto p-6 lg:grid-cols-3">
        {/* Variables table */}
        <section className="lg:col-span-2">
          <div className="mb-3 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <DatabaseIcon className="h-4 w-4 text-siemens" />
              <h2 className="text-sm font-bold text-navy dark:text-slate-100">
                {t('config.variables')}
              </h2>
            </div>
            <span className="rounded-full bg-siemens-50 px-2.5 py-1 text-xs font-semibold text-siemens dark:bg-siemens/15">
              {selectedCount} {t('config.selected')}
            </span>
          </div>

          <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-card dark:border-navy-slate dark:bg-navy-soft">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-slate-100 bg-slate-50 text-xs uppercase tracking-wide text-slate-400 dark:border-navy-slate dark:bg-navy">
                  <th className="w-12 px-4 py-3"></th>
                  <th className="px-4 py-3 font-semibold">
                    {t('config.colName')}
                  </th>
                  <th className="px-4 py-3 font-semibold">
                    {t('config.colType')}
                  </th>
                  <th className="px-4 py-3 text-right font-semibold">
                    {t('config.colValue')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {variables.map((v) =>
                <tr
                  key={v.id}
                  className="border-b border-slate-50 transition-colors last:border-0 hover:bg-slate-50/60 dark:border-navy-slate/50 dark:hover:bg-navy-slate/30">
                  
                    <td className="px-4 py-2.5">
                      <input
                      type="checkbox"
                      checked={v.selected}
                      onChange={(e) => toggleVariable(v.id, e.target.checked)}
                      className="h-4 w-4 cursor-pointer accent-siemens"
                      aria-label={`${t('config.selectVar')} ${v.name}`} />
                    
                    </td>
                    <td className="px-4 py-2.5 font-medium text-navy dark:text-slate-100">
                      {v.name}
                    </td>
                    <td className="px-4 py-2.5">
                      <span
                      className={`rounded-md px-2 py-0.5 text-xs font-semibold ${typeColor[v.type]}`}>
                      
                        {v.type}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono text-xs text-slate-600 tabular-nums dark:text-slate-300">
                      {formatValue(v)}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>

        {/* General settings */}
        <section>
          <div className="mb-3 flex items-center gap-2">
            <SlidersHorizontalIcon className="h-4 w-4 text-siemens" />
            <h2 className="text-sm font-bold text-navy dark:text-slate-100">
              {t('config.general')}
            </h2>
          </div>
          <div className="space-y-5 rounded-xl border border-slate-200 bg-white p-5 shadow-card dark:border-navy-slate dark:bg-navy-soft">
            <SelectField
              label={t('config.updateRate')}
              value={config.updateRate}
              options={rateOptions}
              onChange={setUpdateRate} />
            
            <SelectField
              label={t('config.theme')}
              value={config.theme}
              options={[
              {
                label: t('config.themeLight'),
                value: 'light'
              },
              {
                label: t('config.themeDark'),
                value: 'dark'
              },
              {
                label: t('config.themeAuto'),
                value: 'auto'
              }]
              }
              onChange={setTheme} />
            
            <SelectField
              label={t('config.language')}
              value={config.language}
              options={[
              {
                label: t('config.langEs'),
                value: 'es'
              },
              {
                label: t('config.langEn'),
                value: 'en'
              }]
              }
              onChange={setLanguage} />
            
            <div className="rounded-lg bg-slate-50 p-3 text-xs leading-relaxed text-slate-500 dark:bg-navy dark:text-slate-400">
              {t('config.onlySelected')}{' '}
              <span className="font-semibold text-navy dark:text-slate-100">
                {t('config.mainView')}
              </span>
              .
            </div>
          </div>
        </section>
      </div>

      <AnimatePresence>
        {saved &&
        <motion.div
          initial={{
            opacity: 0,
            y: 20
          }}
          animate={{
            opacity: 1,
            y: 0
          }}
          exit={{
            opacity: 0,
            y: 20
          }}
          className="fixed bottom-6 left-1/2 flex -translate-x-1/2 items-center gap-2 rounded-xl bg-navy px-4 py-3 text-sm font-medium text-white shadow-xl">
          
            <CheckCircle2Icon className="h-4 w-4 text-state-ok" />
            {t('config.saved')}
          </motion.div>
        }
      </AnimatePresence>
    </div>);

}