import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import {
  ArrowLeftIcon,
  SaveIcon,
  CheckCircle2Icon,
  DatabaseIcon,
  SlidersHorizontalIcon,
  NetworkIcon,
  WifiOffIcon,
  PlusIcon,
  Trash2Icon,
  XIcon,
  SearchIcon,
  AlertCircleIcon,
  FileCodeIcon,
} from 'lucide-react';
import { useAppStore } from '../context/AppStore';
import { UPDATE_RATE_OPTIONS, DataType, PlcVendor } from '../models/plc';
import { formatValue } from '../utils/format';
import { SelectField } from '../components/ui/Field';
import { fetchRexrothPrograms } from '../services/rexrothApi';

const typeColor: Record<DataType, string> = {
  bool: 'bg-purple-100 text-purple-700',
  int: 'bg-blue-100 text-blue-700',
  double: 'bg-teal-100 text-teal-700',
  string: 'bg-amber-100 text-amber-700',
};

interface PlcInfo {
  plc: string;          // backend devuelve "plc", no "plc_id"
  nombre: string;
  vendor: string;
  endpoint: string;
  conectado: boolean;
  estado_conexion: string;
  num_tags: number;
  modo_lectura: string;
  sampling_interval_ms: number;
  publishing_interval_ms: number;
}

// =========================================================================
// Tabla de PLCs (una por marca)
// =========================================================================
function PlcTable({
  title,
  plcs,
  onRemove,
  t,
  showModo,
}: {
  title: string;
  plcs: PlcInfo[];
  onRemove: (id: string) => void;
  t: (k: string) => string;
  showModo?: boolean;
}) {
  return (
    <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-card dark:border-navy-slate dark:bg-navy-soft">
      <div className="border-b border-slate-100 bg-slate-50 px-4 py-2.5 dark:border-navy-slate dark:bg-navy">
        <h3 className="text-xs font-bold uppercase tracking-wide text-slate-500 dark:text-slate-400">
          {title}
        </h3>
      </div>
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="border-b border-slate-100 text-xs uppercase tracking-wide text-slate-400 dark:border-navy-slate">
            <th className="px-4 py-2.5 font-semibold">ID</th>
            <th className="px-4 py-2.5 font-semibold">IP</th>
            <th className="px-4 py-2.5 font-semibold">{t('config.status')}</th>
            <th className="px-4 py-2.5 font-semibold">Tags</th>
            {showModo && (
              <th className="px-4 py-2.5 font-semibold">{t('config.readMode')}</th>
            )}
            <th className="w-12 px-4 py-2.5" />
          </tr>
        </thead>
        <tbody>
          {plcs.map((p) => {
            const ip = p.endpoint
              .replace('opc.tcp://', '')
              .replace(/:.*$/, '');
            return (
              <tr
                key={p.plc}
                className="border-b border-slate-50 transition-colors last:border-0 hover:bg-slate-50/60 dark:border-navy-slate/50 dark:hover:bg-navy-slate/30"
              >
                <td className="px-4 py-2.5 font-medium text-navy dark:text-slate-100">
                  {p.plc}
                </td>
                <td className="px-4 py-2.5 font-mono text-xs text-slate-500 dark:text-slate-400">
                  {ip}
                </td>
                <td className="px-4 py-2.5">
                  <span
                    className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                      p.conectado
                        ? 'bg-state-ok/15 text-state-ok'
                        : 'bg-red-100 text-red-500 dark:bg-red-500/15'
                    }`}
                  >
                    <span
                      className={`h-1.5 w-1.5 rounded-full ${
                        p.conectado ? 'bg-state-ok' : 'bg-red-500'
                      }`}
                    />
                    {p.conectado ? t('config.plcOnline') : t('config.plcOffline')}
                  </span>
                </td>
                <td className="px-4 py-2.5 tabular-nums text-slate-600 dark:text-slate-300">
                  {p.num_tags}
                </td>
                {showModo && (
                  <td className="px-4 py-2.5">
                    <span className="rounded-md bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600 dark:bg-navy dark:text-slate-300">
                      {p.modo_lectura}
                    </span>
                  </td>
                )}
                <td className="px-4 py-2.5">
                  <button
                    onClick={() => onRemove(p.plc)}
                    className="rounded p-1 text-slate-400 transition hover:bg-red-50 hover:text-red-500 dark:hover:bg-red-500/10"
                    title={t('config.removePlc')}
                  >
                    <Trash2Icon className="h-4 w-4" />
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// =========================================================================
// Página Configuración
// =========================================================================
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
    t,
  } = useAppStore();

  const [saved, setSaved] = useState(false);
  const selectedCount = variables.filter((v) => v.selected).length;

  // ---------- PLCs desde GET /health ----------
  const [plcs, setPlcs] = useState<PlcInfo[]>([]);

  const refreshPlcs = useCallback(async () => {
    try {
      const res = await fetch('/health');
      if (!res.ok) return;
      const data = await res.json();
      if (Array.isArray(data.plcs)) setPlcs(data.plcs);
    } catch {
      /* backend no disponible */
    }
  }, []);

  useEffect(() => {
    refreshPlcs();
    const id = setInterval(refreshPlcs, 5000);
    return () => clearInterval(id);
  }, [refreshPlcs]);

  // ---------- Modal "Agregar PLC" ----------
  const [showModal, setShowModal] = useState(false);
  const [vendor, setVendor] = useState<PlcVendor>('siemens');
  const [newIp, setNewIp] = useState('');
  const [newUser, setNewUser] = useState('');
  const [newPass, setNewPass] = useState('');
  const [app, setApp] = useState('');        // autodetectada por el backend
  const [programs, setPrograms] = useState<string[]>([]);
  const [program, setProgram] = useState('');
  const [searching, setSearching] = useState(false);
  const [adding, setAdding] = useState(false);
  const [modalError, setModalError] = useState('');
  const [modalHint, setModalHint] = useState('');

  const isRexroth = vendor === 'rexroth';
  const credsReady =
    newIp.trim() !== '' && newUser.trim() !== '' && newPass !== '';

  // Reset al cambiar marca
  useEffect(() => {
    setApp('');
    setPrograms([]);
    setProgram('');
    setModalError('');
    setModalHint('');
  }, [vendor]);

  const resetForm = () => {
    setVendor('siemens');
    setNewIp('');
    setNewUser('');
    setNewPass('');
    setApp('');
    setPrograms([]);
    setProgram('');
    setModalError('');
    setModalHint('');
    setSearching(false);
    setAdding(false);
  };

  const openModal = () => {
    resetForm();
    setShowModal(true);
  };

  // ---- Rexroth: buscar programas (app autodetectada) ----
  const buscarProgramas = useCallback(async () => {
    if (!credsReady) {
      setModalError(t('login.needCreds'));
      return;
    }
    setModalError('');
    setSearching(true);
    setModalHint(t('login.searching'));
    setPrograms([]);
    setProgram('');
    setApp('');
    try {
      const result = await fetchRexrothPrograms({
        ip: newIp,
        usuario: newUser,
        password: newPass,
      });
      setApp(result.app);
      setPrograms(result.programas);
      setModalHint(
        `${result.programas.length} ${t('login.programsFound')}` +
        (result.app ? ` (${result.app})` : ''),
      );
      if (result.programas.length === 1) setProgram(result.programas[0]);
    } catch (e: any) {
      setModalError(e?.message ?? String(e));
      setModalHint('');
    } finally {
      setSearching(false);
    }
  }, [credsReady, newIp, newUser, newPass, t]);

  // ---- Agregar PLC (POST /plcs) ----
  const agregarPlc = async () => {
    if (isRexroth && !program) {
      setModalError(t('login.needProgram'));
      return;
    }
    setModalError('');
    setAdding(true);
    try {
      const body: Record<string, unknown> = {
        host: newIp.trim(),
        puerto: 4840,
        vendor,
      };
      if (isRexroth) {
        body.usuario = newUser.trim();
        body.password = newPass;
        body.app = app || 'Application';
        body.programa = program;
      }
      const r = await fetch('/plcs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await r.json().catch(() => null);
      if (!r.ok || data?.ok === false) {
        throw new Error(
          data?.mensaje ?? data?.detail ?? `HTTP ${r.status}`,
        );
      }
      setShowModal(false);
      resetForm();
      await refreshPlcs();
    } catch (e: any) {
      setModalError(e?.message ?? String(e));
    } finally {
      setAdding(false);
    }
  };

  // ---- Eliminar PLC (DELETE /plcs/:id) ----
  const eliminarPlc = async (plcId: string) => {
    try {
      await fetch(`/plcs/${plcId}`, { method: 'DELETE' });
      setPlcs((prev) => prev.filter((p) => p.plc !== plcId));
    } catch {
      /* ignore */
    }
  };

  // ---------- Agrupar PLCs por marca ----------
  const siemensPlcs = plcs.filter(
    (p) => p.vendor === 'siemens' || !p.vendor,
  );
  const rexrothPlcs = plcs.filter((p) => p.vendor === 'rexroth');

  const canAdd = !adding && newIp.trim() !== '' && (!isRexroth || !!program);

  // ---------- Agrupar variables por PLC ----------
  const varGroups = React.useMemo(() => {
    const map = new Map<string, typeof variables>();
    for (const v of variables) {
      const sep = v.id.indexOf('|');
      const plcId = sep > 0 ? v.id.slice(0, sep) : '_unknown';
      const arr = map.get(plcId);
      if (arr) arr.push(v);
      else map.set(plcId, [v]);
    }
    return Array.from(map.entries()).map(([plcId, vars]) => {
      const info = plcs.find((p) => p.plc === plcId);
      const vendorLabel =
        info?.vendor === 'rexroth'
          ? 'Bosch Rexroth ctrlX'
          : 'Siemens S7-1500';
      const ip = info
        ? info.endpoint.replace('opc.tcp://', '').replace(/:.*$/, '')
        : plcId;
      return {
        plcId,
        label: `${vendorLabel} — ${ip}`,
        vars,
        tagCount: vars.length,
      };
    });
  }, [variables, plcs]);

  // ---------- Opciones de rate ----------
  const rateOptions = UPDATE_RATE_OPTIONS.map((o) =>
    o.value >= 1000 ? { label: t(`rate.${o.value}`), value: o.value } : o,
  );

  const handleSave = () => {
    saveConfig();
    setSaved(true);
    setTimeout(() => setSaved(false), 2200);
  };

  // =========================================================================
  // Render
  // =========================================================================
  return (
    <div className="flex min-h-full w-full flex-col bg-slate-50 dark:bg-navy">
      {/* Header */}
      <header className="flex items-center justify-between border-b border-slate-200 bg-white px-6 py-4 dark:border-navy-slate dark:bg-navy-soft">
        <div className="flex items-center gap-3">
          <button
            onClick={() => navigate('/')}
            className="flex h-9 w-9 items-center justify-center rounded-lg text-slate-500 transition hover:bg-slate-100 dark:hover:bg-navy-slate/40"
          >
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
          className="flex items-center gap-2 rounded-lg bg-siemens px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-siemens-600"
        >
          <SaveIcon className="h-4 w-4" />
          {t('config.save')}
        </button>
      </header>

      <div className="mp-scroll mp-scroll-dark grid flex-1 content-start grid-cols-1 gap-6 overflow-auto p-6 lg:grid-cols-3">
        {/* ============================================================= */}
        {/* Sección Conexión PLC                                          */}
        {/* ============================================================= */}
        <section className="lg:col-span-3">
          <div className="mb-3 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <NetworkIcon className="h-4 w-4 text-siemens" />
              <h2 className="text-sm font-bold text-navy dark:text-slate-100">
                {t('config.plcConnection')}
              </h2>
            </div>
            <button
              onClick={openModal}
              className="flex items-center gap-1.5 rounded-lg bg-siemens px-3 py-1.5 text-xs font-semibold text-white shadow-sm transition hover:bg-siemens-600"
            >
              <PlusIcon className="h-3.5 w-3.5" />
              {t('config.addPlc')}
            </button>
          </div>

          {plcs.length === 0 ? (
            <div className="flex items-center gap-3 rounded-xl border border-slate-200 bg-white p-4 shadow-card dark:border-navy-slate dark:bg-navy-soft">
              <WifiOffIcon className="h-5 w-5 text-slate-400" />
              <p className="text-sm text-slate-500 dark:text-slate-400">
                {t('config.noPlc')}
              </p>
            </div>
          ) : (
            <div className="space-y-4">
              {siemensPlcs.length > 0 && (
                <PlcTable
                  title="Siemens S7-1500"
                  plcs={siemensPlcs}
                  onRemove={eliminarPlc}
                  t={t}
                />
              )}
              {rexrothPlcs.length > 0 && (
                <PlcTable
                  title="Bosch Rexroth ctrlX"
                  plcs={rexrothPlcs}
                  onRemove={eliminarPlc}
                  t={t}
                  showModo
                />
              )}
            </div>
          )}
        </section>

        {/* ============================================================= */}
        {/* Variables agrupadas por PLC                                   */}
        {/* ============================================================= */}
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

          <div className="space-y-4">
            {varGroups.map(({ plcId, label, vars, tagCount }) => (
              <div
                key={plcId}
                className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-card dark:border-navy-slate dark:bg-navy-soft"
              >
                {/* Header del grupo */}
                <div className="flex items-center justify-between border-b border-slate-100 bg-slate-50 px-4 py-2.5 dark:border-navy-slate dark:bg-navy">
                  <h3 className="text-xs font-bold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                    {label}
                  </h3>
                  <span className="text-[11px] text-slate-400">
                    {tagCount} tags
                  </span>
                </div>

                <table className="w-full text-left text-sm">
                  <thead>
                    <tr className="border-b border-slate-100 text-xs uppercase tracking-wide text-slate-400 dark:border-navy-slate">
                      <th className="w-12 px-4 py-2.5" />
                      <th className="px-4 py-2.5 font-semibold">
                        {t('config.colName')}
                      </th>
                      <th className="px-4 py-2.5 font-semibold">
                        {t('config.colType')}
                      </th>
                      <th className="px-4 py-2.5 text-right font-semibold">
                        {t('config.colValue')}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {vars.map((v) => (
                      <tr
                        key={v.id}
                        className="border-b border-slate-50 transition-colors last:border-0 hover:bg-slate-50/60 dark:border-navy-slate/50 dark:hover:bg-navy-slate/30"
                      >
                        <td className="px-4 py-2.5">
                          <input
                            type="checkbox"
                            checked={v.selected}
                            onChange={(e) =>
                              toggleVariable(v.id, e.target.checked)
                            }
                            className="h-4 w-4 cursor-pointer accent-siemens"
                            aria-label={`${t('config.selectVar')} ${v.name}`}
                          />
                        </td>
                        <td className="px-4 py-2.5 font-medium text-navy dark:text-slate-100">
                          {v.name}
                        </td>
                        <td className="px-4 py-2.5">
                          <span
                            className={`rounded-md px-2 py-0.5 text-xs font-semibold ${typeColor[v.type]}`}
                          >
                            {v.type}
                          </span>
                        </td>
                        <td className="px-4 py-2.5 text-right font-mono text-xs tabular-nums text-slate-600 dark:text-slate-300">
                          {formatValue(v)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}
          </div>
        </section>

        {/* ============================================================= */}
        {/* Configuración general                                         */}
        {/* ============================================================= */}
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
              onChange={setUpdateRate}
            />
            <SelectField
              label={t('config.theme')}
              value={config.theme}
              options={[
                { label: t('config.themeLight'), value: 'light' },
                { label: t('config.themeDark'), value: 'dark' },
                { label: t('config.themeAuto'), value: 'auto' },
              ]}
              onChange={setTheme}
            />
            <SelectField
              label={t('config.language')}
              value={config.language}
              options={[
                { label: t('config.langEs'), value: 'es' },
                { label: t('config.langEn'), value: 'en' },
              ]}
              onChange={setLanguage}
            />
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

      {/* =============================================================== */}
      {/* Modal: Agregar PLC                                              */}
      {/* =============================================================== */}
      <AnimatePresence>
        {showModal && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm"
            onMouseDown={() => setShowModal(false)}
          >
            <motion.div
              initial={{ opacity: 0, y: 24, scale: 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 24, scale: 0.96 }}
              transition={{ duration: 0.25, ease: 'easeOut' }}
              className="relative w-full max-w-lg rounded-2xl border border-white/10 bg-navy-soft p-6 shadow-2xl"
              onMouseDown={(e) => e.stopPropagation()}
            >
              {/* Cerrar */}
              <button
                onClick={() => setShowModal(false)}
                className="absolute right-4 top-4 rounded-lg p-1 text-slate-400 transition hover:bg-white/10 hover:text-white"
              >
                <XIcon className="h-5 w-5" />
              </button>

              <h2 className="mb-5 text-lg font-bold text-white">
                {t('config.addPlc')}
              </h2>

              {/* Tabs de marca */}
              <div className="mb-5 grid grid-cols-2 gap-2 rounded-xl border border-white/10 bg-navy/60 p-1">
                <button
                  type="button"
                  onClick={() => setVendor('siemens')}
                  className={`rounded-lg py-2 text-sm font-medium transition ${
                    !isRexroth
                      ? 'bg-siemens text-white shadow shadow-siemens/30'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  Siemens
                </button>
                <button
                  type="button"
                  onClick={() => setVendor('rexroth')}
                  className={`rounded-lg py-2 text-sm font-medium transition ${
                    isRexroth
                      ? 'bg-siemens text-white shadow shadow-siemens/30'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  Rexroth
                </button>
              </div>

              <p className="mb-4 text-[11px] text-slate-500">
                {isRexroth
                  ? t('login.vendorRexrothHint')
                  : t('login.vendorSiemensHint')}
              </p>

              <div className="space-y-3">
                {/* IP (con sufijo :4840 para Rexroth) */}
                <div>
                  <span className="mb-1.5 block text-xs font-medium text-slate-400">
                    {t('login.ip')}
                  </span>
                  <div className="flex items-stretch">
                    <input
                      type="text"
                      value={newIp}
                      placeholder="192.168.0.1"
                      onChange={(e) => setNewIp(e.target.value)}
                      className={`flex-1 border border-white/10 bg-navy/60 py-2.5 px-3 text-sm text-white placeholder-slate-500 outline-none transition focus:border-siemens focus:ring-2 focus:ring-siemens/30 ${
                        isRexroth ? 'rounded-l-xl' : 'rounded-xl'
                      }`}
                    />
                    {isRexroth && (
                      <span className="flex items-center rounded-r-xl border border-l-0 border-white/10 bg-navy/80 px-3 text-xs font-mono text-slate-500">
                        :4840
                      </span>
                    )}
                  </div>
                </div>

                {/* Credenciales Rexroth */}
                {isRexroth && (
                  <>
                    <ModalInput
                      label={t('login.user')}
                      value={newUser}
                      onChange={setNewUser}
                      placeholder="boschrexroth"
                    />
                    <ModalInput
                      label={t('login.password')}
                      value={newPass}
                      onChange={setNewPass}
                      placeholder="••••••••"
                      type="password"
                    />

                    {/* Buscar programas (app autodetectada) */}
                    <button
                      type="button"
                      onClick={buscarProgramas}
                      disabled={searching || !credsReady}
                      className="flex w-full items-center justify-center gap-2 rounded-xl border border-white/10 bg-siemens/20 py-2.5 text-sm font-medium text-white transition hover:bg-siemens/30 disabled:opacity-40"
                    >
                      {searching ? (
                        <>
                          <motion.span
                            className="h-4 w-4 rounded-full border-2 border-white/40 border-t-white"
                            animate={{ rotate: 360 }}
                            transition={{ repeat: Infinity, duration: 0.7, ease: 'linear' }}
                          />
                          {t('login.searching')}
                        </>
                      ) : (
                        <>
                          <SearchIcon className="h-4 w-4" />
                          {t('login.search')}
                        </>
                      )}
                    </button>

                    {/* Programa (aparece tras buscar) */}
                    {programs.length > 0 && (
                      <div>
                        <span className="mb-1.5 block text-xs font-medium text-slate-400">
                          {t('login.program')}
                        </span>
                        <ModalSelect
                          value={program}
                          onChange={setProgram}
                          disabled={searching}
                          placeholder={t('login.selectProgram')}
                          options={programs}
                          icon={
                            <FileCodeIcon className="h-4 w-4 text-slate-500" />
                          }
                        />
                      </div>
                    )}

                    {modalHint && (
                      <p className="text-[11px] text-slate-500">
                        {modalHint}
                      </p>
                    )}
                  </>
                )}
              </div>

              {/* Error */}
              {modalError && (
                <div className="mt-4 flex items-start gap-2 rounded-xl border border-red-500/30 bg-red-500/10 p-3">
                  <AlertCircleIcon className="mt-0.5 h-4 w-4 shrink-0 text-red-400" />
                  <p className="whitespace-pre-wrap text-xs text-red-300">
                    {modalError}
                  </p>
                </div>
              )}

              {/* Botón Agregar */}
              <button
                onClick={agregarPlc}
                disabled={!canAdd}
                className="mt-5 flex w-full items-center justify-center gap-2 rounded-xl bg-siemens py-3 text-sm font-semibold text-white shadow-lg shadow-siemens/30 transition-colors hover:bg-siemens-600 disabled:opacity-50"
              >
                {adding ? (
                  <>
                    <motion.span
                      className="h-4 w-4 rounded-full border-2 border-white/40 border-t-white"
                      animate={{ rotate: 360 }}
                      transition={{
                        repeat: Infinity,
                        duration: 0.7,
                        ease: 'linear',
                      }}
                    />
                    {t('login.connecting')}
                  </>
                ) : (
                  <>
                    <PlusIcon className="h-4 w-4" />
                    {t('config.addPlc')}
                  </>
                )}
              </button>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Toast de guardado */}
      <AnimatePresence>
        {saved && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 20 }}
            className="fixed bottom-6 left-1/2 flex -translate-x-1/2 items-center gap-2 rounded-xl bg-navy px-4 py-3 text-sm font-medium text-white shadow-xl"
          >
            <CheckCircle2Icon className="h-4 w-4 text-state-ok" />
            {t('config.saved')}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// =========================================================================
// Componentes auxiliares del modal
// =========================================================================
function ModalInput({
  label,
  value,
  onChange,
  placeholder,
  type,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
}) {
  return (
    <div>
      <span className="mb-1.5 block text-xs font-medium text-slate-400">
        {label}
      </span>
      <input
        type={type ?? 'text'}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-xl border border-white/10 bg-navy/60 py-2.5 px-3 text-sm text-white placeholder-slate-500 outline-none transition focus:border-siemens focus:ring-2 focus:ring-siemens/30"
      />
    </div>
  );
}

function ModalSelect({
  value,
  onChange,
  options,
  placeholder,
  icon,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  options: string[];
  placeholder: string;
  icon: React.ReactNode;
  disabled?: boolean;
}) {
  return (
    <div className="relative flex-1">
      <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2">
        {icon}
      </span>
      <select
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className="w-full appearance-none rounded-xl border border-white/10 bg-navy/60 py-2.5 pl-10 pr-3 text-sm text-white outline-none transition focus:border-siemens focus:ring-2 focus:ring-siemens/30 disabled:opacity-50"
      >
        <option value="" disabled>
          {placeholder}
        </option>
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    </div>
  );
}
