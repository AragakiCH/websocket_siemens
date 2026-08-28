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
  InfoIcon,
  ListChecksIcon,
  HardDriveIcon,
} from 'lucide-react';
import { useAppStore } from '../context/AppStore';
import { UPDATE_RATE_OPTIONS, DataType, PlcVendor } from '../models/plc';
import { formatValue } from '../utils/format';
import { SelectField } from '../components/ui/Field';
import { fetchRexrothPrograms } from '../services/rexrothApi';
import { PanelBasesDatos } from '../components/bd/PanelBasesDatos';
import { PanelCarpetaDatos } from '../components/sistema/PanelCarpetaDatos';

// =========================================================================
// SISTEMA VISUAL DE ESTA VISTA
//
// Antes cada bloque se maquetaba por su cuenta: unos encabezados dentro de la
// tarjeta y otros fuera, tres estilos de cabecera de tabla, y una rejilla de
// 3 columnas con spans 3/2/3/1 que dejaba la tercera columna VACÍA al lado de
// las variables y dos columnas muertas al lado de la configuración general.
// De ahí venía la sensación de desorden, más que de cada pieza suelta.
//
// Ahora hay tres piezas y todo se construye con ellas.
// =========================================================================

/**
 * Color del tipo de dato.
 *
 * Llevaba solo variantes claras (`bg-purple-100`), así que en modo oscuro
 * salían pastillas pastel flotando sobre el fondo azul. Ahora cada tipo tiene
 * su par claro/oscuro y un anillo que le da borde en vez de dejarlo al aire.
 */
const typeColor: Record<DataType, string> = {
  bool:
    'bg-violet-100 text-violet-700 ring-violet-200 ' +
    'dark:bg-violet-500/15 dark:text-violet-300 dark:ring-violet-500/25',
  int:
    'bg-blue-100 text-blue-700 ring-blue-200 ' +
    'dark:bg-blue-500/15 dark:text-blue-300 dark:ring-blue-500/25',
  double:
    'bg-teal-100 text-teal-700 ring-teal-200 ' +
    'dark:bg-teal-500/15 dark:text-teal-300 dark:ring-teal-500/25',
  string:
    'bg-amber-100 text-amber-700 ring-amber-200 ' +
    'dark:bg-amber-500/15 dark:text-amber-300 dark:ring-amber-500/25',
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

/**
 * Encabezado de sección. UNO solo para las cuatro secciones.
 *
 * `acciones` va a la derecha en la misma línea base que el título: los
 * botones de "Añadir" y los contadores estaban antes cada uno a su manera, y
 * con cuatro secciones eso ya se lee como descuido.
 */
function Seccion({
  icon,
  titulo,
  descripcion,
  acciones,
  children,
  className = '',
}: {
  icon: React.ReactNode;
  titulo: string;
  descripcion?: string;
  acciones?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={className}>
      <div className="mb-3 flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="flex min-w-0 items-start gap-2.5">
          <span className="mt-px flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-siemens-50 text-siemens dark:bg-siemens/15">
            {icon}
          </span>
          <div className="min-w-0">
            <h2 className="text-sm font-bold leading-tight text-navy dark:text-slate-100">
              {titulo}
            </h2>
            {descripcion && (
              <p className="mt-0.5 text-[11.5px] leading-relaxed text-slate-400">
                {descripcion}
              </p>
            )}
          </div>
        </div>
        {acciones && (
          <div className="flex shrink-0 items-center gap-2">{acciones}</div>
        )}
      </div>
      {children}
    </section>
  );
}

/** Superficie base. Todas las tarjetas de la vista salen de aquí. */
function Tarjeta({
  children,
  className = '',
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`overflow-hidden rounded-xl border border-slate-200 bg-white shadow-card dark:border-navy-slate dark:bg-navy-soft ${className}`}
    >
      {children}
    </div>
  );
}

/** Punto + texto de estado. Mismo par en los PLCs y en las bases de datos. */
export function ChipEstado({ ok, si, no }: { ok: boolean; si: string; no: string }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1 ${
        ok
          ? 'bg-state-ok/10 text-state-ok ring-state-ok/25'
          : 'bg-state-error/10 text-state-error ring-state-error/25'
      }`}
    >
      <span
        aria-hidden="true"
        className={`h-1.5 w-1.5 rounded-full ${ok ? 'bg-state-ok' : 'bg-state-error'}`}
      />
      {ok ? si : no}
    </span>
  );
}

/** Celda de cabecera. Sustituye a los `shadow-[inset_...]` escritos a mano. */
function Th({
  children,
  className = '',
}: {
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <th
      scope="col"
      className={`whitespace-nowrap border-b border-slate-200 bg-slate-50 px-4 py-2.5 text-left text-[10px] font-bold uppercase tracking-wider text-slate-400 dark:border-navy-slate dark:bg-navy ${className}`}
    >
      {children}
    </th>
  );
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
    <Tarjeta>
      <div className="flex items-center justify-between border-b border-slate-200 bg-slate-50 px-4 py-2.5 dark:border-navy-slate dark:bg-navy">
        <h3 className="text-[11px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
          {title}
        </h3>
        <span className="text-[11px] tabular-nums text-slate-400">
          {plcs.length} PLC{plcs.length === 1 ? '' : 's'}
        </span>
      </div>

      {/* Scroll en los dos ejes con la cabecera fija: con muchos PLCs la
          tarjeta ya no crece sin fin, y en pantallas angostas las columnas se
          desplazan en vez de comprimirse hasta ser ilegibles. */}
      <div className="mp-scroll mp-scroll-dark max-h-72 overflow-auto">
        <table className="w-full min-w-[620px] text-left text-sm">
          <thead className="sticky top-0 z-10">
            <tr>
              <Th>ID</Th>
              <Th>IP</Th>
              <Th className="w-36">{t('config.status')}</Th>
              <Th className="w-20 text-right">Tags</Th>
              {showModo && <Th className="w-28">{t('config.readMode')}</Th>}
              <Th className="w-14" />
            </tr>
          </thead>
          <tbody>
            {plcs.map((p) => {
              const ip = p.endpoint.replace('opc.tcp://', '').replace(/:.*$/, '');
              return (
                <tr
                  key={p.plc}
                  className="group border-b border-slate-100 transition-colors last:border-0 hover:bg-slate-50/70 dark:border-navy-slate/50 dark:hover:bg-navy/40"
                >
                  <td className="px-4 py-2.5 font-medium text-navy dark:text-slate-100">
                    {p.plc}
                  </td>
                  <td className="px-4 py-2.5 font-mono text-xs text-slate-500 dark:text-slate-400">
                    {ip}
                  </td>
                  <td className="px-4 py-2.5">
                    <ChipEstado
                      ok={p.conectado}
                      si={t('config.plcOnline')}
                      no={t('config.plcOffline')}
                    />
                  </td>
                  <td className="px-4 py-2.5 text-right tabular-nums text-slate-600 dark:text-slate-300">
                    {p.num_tags}
                  </td>
                  {showModo && (
                    <td className="px-4 py-2.5">
                      <span className="rounded-md bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-600 dark:bg-navy dark:text-slate-300">
                        {p.modo_lectura}
                      </span>
                    </td>
                  )}
                  <td className="px-4 py-2.5">
                    {/* Se revela al pasar por encima de la fila: borrar un PLC
                        de producción no debe ser lo primero que salta a la
                        vista en una tabla que se consulta a diario. */}
                    <button
                      onClick={() => onRemove(p.plc)}
                      title={t('config.removePlc')}
                      aria-label={`${t('config.removePlc')}: ${p.plc}`}
                      className="flex h-7 w-7 items-center justify-center rounded-md text-slate-400 opacity-0 outline-none transition hover:bg-state-error/10 hover:text-state-error focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-siemens/40 group-hover:opacity-100 dark:hover:bg-state-error/10"
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
    </Tarjeta>
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
      <header className="shrink-0 border-b border-slate-200 bg-white dark:border-navy-slate dark:bg-navy-soft">
        <div className="flex items-center justify-between gap-4 px-6 py-3.5">
        <div className="flex min-w-0 items-center gap-3">
          <button
            onClick={() => navigate('/menu')}
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
        </div>
      </header>

      {/* La rejilla ocupa TODO el ancho disponible. Lo que evita que se
          desparrame no es un tope de píxeles, son las proporciones: a partir
          de 1536 px las variables se llevan 9 de 12 columnas y la
          configuración general se queda en 3, para que tres desplegables no
          acaben midiendo 600 px de ancho. */}
      <div className="mp-scroll mp-scroll-dark flex-1 overflow-auto">
        <div className="grid grid-cols-1 items-start gap-6 p-6 xl:grid-cols-12">

          {/* ========================================================= */}
          {/* PLCs                                                      */}
          {/* ========================================================= */}
          <Seccion
            className="xl:col-span-12"
            icon={<NetworkIcon className="h-3.5 w-3.5" />}
            titulo={t('config.plcConnection')}
            descripcion="Controladores dados de alta. El estado se refresca solo cada 5 segundos."
            acciones={
              <button
                onClick={openModal}
                className="flex min-h-[32px] items-center gap-1.5 rounded-lg bg-siemens px-3 text-xs font-semibold text-white shadow-sm outline-none transition hover:bg-siemens-600 focus-visible:ring-2 focus-visible:ring-siemens/50"
              >
                <PlusIcon className="h-3.5 w-3.5" />
                {t('config.addPlc')}
              </button>
            }
          >
            {plcs.length === 0 ? (
              <Tarjeta className="flex items-center gap-3 px-4 py-5">
                <WifiOffIcon className="h-5 w-5 shrink-0 text-slate-400" />
                <p className="text-sm text-slate-500 dark:text-slate-400">
                  {t('config.noPlc')}
                </p>
              </Tarjeta>
            ) : (
              /* Dos marcas en paralelo cuando hay sitio: son tablas
                 independientes y una debajo de otra desperdicia el ancho. */
              <div className="grid gap-4 xl:grid-cols-2">
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
          </Seccion>

          {/* ========================================================= */}
          {/* Variables por PLC                                         */}
          {/* ========================================================= */}
          <Seccion
            className="xl:col-span-8 2xl:col-span-9"
            icon={<ListChecksIcon className="h-3.5 w-3.5" />}
            titulo={t('config.variables')}
            descripcion="Solo las marcadas aparecen en el Diseñador."
            acciones={
              <span className="rounded-full bg-siemens-50 px-2.5 py-1 text-[11px] font-semibold text-siemens ring-1 ring-siemens/20 dark:bg-siemens/15 dark:text-siemens-200">
                {selectedCount} {t('config.selected')}
              </span>
            }
          >
            {varGroups.length === 0 ? (
              <Tarjeta className="px-4 py-8 text-center">
                <p className="text-sm text-slate-400">
                  Todavía no hay tags. Aparecen solos en cuanto un PLC conecta
                  y termina su descubrimiento.
                </p>
              </Tarjeta>
            ) : (
              <div className="space-y-4">
                {varGroups.map(({ plcId, label, vars, tagCount }) => (
                  <Tarjeta key={plcId}>
                    <div className="flex items-center justify-between border-b border-slate-200 bg-slate-50 px-4 py-2.5 dark:border-navy-slate dark:bg-navy">
                      <h3 className="truncate text-[11px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                        {label}
                      </h3>
                      <span className="shrink-0 text-[11px] tabular-nums text-slate-400">
                        {tagCount} tags
                      </span>
                    </div>

                    <div className="mp-scroll mp-scroll-dark max-h-[22rem] overflow-auto">
                      <table className="w-full min-w-[420px] text-left text-sm">
                        <thead className="sticky top-0 z-10">
                          <tr>
                            <Th className="w-11" />
                            <Th>{t('config.colName')}</Th>
                            <Th className="w-24">{t('config.colType')}</Th>
                            <Th className="w-32 text-right">
                              {t('config.colValue')}
                            </Th>
                          </tr>
                        </thead>
                        <tbody>
                          {vars.map((v) => (
                            <tr
                              key={v.id}
                              className="border-b border-slate-100 transition-colors last:border-0 hover:bg-slate-50/70 dark:border-navy-slate/50 dark:hover:bg-navy/40"
                            >
                              <td className="py-2 pl-4 pr-0">
                                <input
                                  type="checkbox"
                                  checked={v.selected}
                                  onChange={(e) =>
                                    toggleVariable(v.id, e.target.checked)
                                  }
                                  className="h-4 w-4 cursor-pointer rounded border-slate-300 accent-siemens dark:border-navy-slate"
                                  aria-label={`${t('config.selectVar')} ${v.name}`}
                                />
                              </td>
                              <td className="px-4 py-2 font-medium text-navy dark:text-slate-100">
                                {v.name}
                              </td>
                              <td className="px-4 py-2">
                                <span
                                  className={`rounded-md px-2 py-0.5 text-[11px] font-semibold ring-1 ${typeColor[v.type]}`}
                                >
                                  {v.type}
                                </span>
                              </td>
                              {/* tabular-nums: sin esto las cifras bailan de
                                  fila en fila y la columna deja de leerse
                                  como una columna. */}
                              <td className="px-4 py-2 text-right font-mono text-xs tabular-nums text-slate-600 dark:text-slate-300">
                                {formatValue(v)}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </Tarjeta>
                ))}
              </div>
            )}
          </Seccion>

          {/* ========================================================= */}
          {/* Configuración general                                     */}
          {/* ========================================================= */}
          {/* Va AL LADO de las variables, no debajo. Antes la rejilla era de
              3 columnas con spans 3/2/3/1: la tercera columna de la fila de
              variables quedaba vacía y esta sección se quedaba sola con dos
              columnas muertas al lado. `sticky` la mantiene a la vista
              mientras se recorre una lista larga de tags. */}
          <Seccion
            className="xl:col-span-4 2xl:col-span-3 xl:sticky xl:top-6"
            icon={<SlidersHorizontalIcon className="h-3.5 w-3.5" />}
            titulo={t('config.general')}
            descripcion="Ajustes de esta vista y de este navegador."
          >
            <Tarjeta className="space-y-4 p-4">
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

              <p className="flex items-start gap-2 rounded-lg bg-slate-50 px-3 py-2.5 text-[11.5px] leading-relaxed text-slate-500 dark:bg-navy dark:text-slate-400">
                <InfoIcon className="mt-px h-3.5 w-3.5 shrink-0 text-slate-400" />
                <span className="min-w-0">
                  {t('config.onlySelected')}{' '}
                  <span className="font-semibold text-navy dark:text-slate-100">
                    {t('config.mainView')}
                  </span>
                  .
                </span>
              </p>
            </Tarjeta>
          </Seccion>

          {/* ========================================================= */}
          {/* Bases de datos                                            */}
          {/* ========================================================= */}
          {/* Aquí se dan de alta la segunda base y las siguientes. El
              asistente del login solo aparece cuando no hay NINGUNA y se
              cierra para siempre en cuanto existe la primera cuenta. */}
          <Seccion
            className="xl:col-span-12"
            icon={<DatabaseIcon className="h-3.5 w-3.5" />}
            titulo="Bases de datos"
            descripcion="Cada base tiene sus propias cuentas, alarmas y recetas. La que use el login se elige al entrar."
          >
            <PanelBasesDatos />
          </Seccion>

          {/* ========================================================= */}
          {/* Carpeta de datos                                          */}
          {/* ========================================================= */}
          {/* Dónde queda todo lo que se configura, y cómo llevárselo. Va
              después de las bases de datos porque es la pregunta que
              aparece justo cuando ya hay algo que perder. */}
          <Seccion
            className="xl:col-span-12"
            icon={<HardDriveIcon className="h-3.5 w-3.5" />}
            titulo="Carpeta de datos"
            descripcion="Dónde vive la configuración de este equipo, y cómo hacer una copia antes de reinstalar o actualizar."
          >
            <PanelCarpetaDatos />
          </Seccion>
        </div>
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
