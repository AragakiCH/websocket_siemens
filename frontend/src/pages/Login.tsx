// =========================================================================
// Login.tsx
// Pantalla de conexión al PLC. Soporta DOS marcas:
//
//   * Siemens (S7-1500): exactamente el flujo de siempre. Basta la IP; la
//     sesión OPC UA es anónima y los tags se descubren solos bajo
//     DataBlocksGlobal. Usuario/contraseña quedan como campos informativos.
//
//   * Rexroth (ctrlX CORE): la IP no basta. El ctrlX exige usuario y
//     contraseña, y hay que decirle QUÉ leer. Por eso, tras escribir las
//     credenciales, se pulsa "Buscar" y el backend devuelve las aplicaciones
//     publicadas; al elegir una se cargan sus programas (POUs). El botón
//     Conectar se habilita recién cuando hay un programa seleccionado.
//
// El alta real del PLC la hace AppStore.connect() contra POST /plcs.
// =========================================================================
import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import {
  NetworkIcon,
  UserIcon,
  LockIcon,
  PlugZapIcon,
  CpuIcon,
  SearchIcon,
  LayersIcon,
  FileCodeIcon,
  AlertCircleIcon } from
'lucide-react';
import { useAppStore } from '../context/AppStore';
import { PlcVendor } from '../models/plc';
import { fetchRexrothApps, fetchRexrothPrograms } from '../services/rexrothApi';

export function Login() {
  const navigate = useNavigate();
  const { connect, t } = useAppStore();

  // ---- Marca seleccionada -------------------------------------------- //
  const [vendor, setVendor] = useState<PlcVendor>('siemens');

  // ---- Campos comunes ------------------------------------------------- //
  const [ip, setIp] = useState('192.168.0.1');
  const [user, setUser] = useState('admin');
  const [password, setPassword] = useState('');

  // ---- Solo Rexroth: apps y programas descubiertos -------------------- //
  const [apps, setApps] = useState<string[]>([]);
  const [app, setApp] = useState('');
  const [programs, setPrograms] = useState<string[]>([]);
  const [program, setProgram] = useState('');
  const [searching, setSearching] = useState(false);
  const [hint, setHint] = useState('');

  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState('');

  const isRexroth = vendor === 'rexroth';

  // Al cambiar de marca se limpia todo lo específico de la anterior, para no
  // arrastrar el programa de un PLC al otro.
  useEffect(() => {
    setApps([]);
    setApp('');
    setPrograms([]);
    setProgram('');
    setHint('');
    setError('');
    // Usuario de fábrica del ctrlX, como comodidad.
    setUser((u) => vendor === 'rexroth' && u === 'admin' ? 'boschrexroth' : u);
  }, [vendor]);

  const credsListas = ip.trim() !== '' && user.trim() !== '' && password !== '';

  // ------------------------------------------------------------------- //
  // Paso 2 (Rexroth): programas de la app elegida
  // Se define antes que buscarApps porque esta última lo invoca cuando el
  // ctrlX expone una sola aplicación.
  // ------------------------------------------------------------------- //
  const buscarProgramas = useCallback(
    async (appSel: string) => {
      if (!appSel) return;
      setSearching(true);
      setPrograms([]);
      setProgram('');
      try {
        const result = await fetchRexrothPrograms(
          { ip, usuario: user, password },
          appSel
        );
        setPrograms(result.programas);
        setHint(`${result.programas.length} ${t('login.programsFound')}`);
        if (result.programas.length === 1) setProgram(result.programas[0]);
      } catch (e: any) {
        setError(e?.message ?? String(e));
        setHint('');
      } finally {
        setSearching(false);
      }
    },
    [ip, user, password, t]
  );

  // ------------------------------------------------------------------- //
  // Paso 1 (Rexroth): aplicaciones publicadas en el ctrlX
  // ------------------------------------------------------------------- //
  const buscarApps = useCallback(async () => {
    if (!credsListas) {
      setError(t('login.needCreds'));
      return;
    }
    setError('');
    setSearching(true);
    setHint(t('login.searching'));
    setApps([]);
    setApp('');
    setPrograms([]);
    setProgram('');

    try {
      const encontradas = await fetchRexrothApps({ ip, usuario: user, password });
      setApps(encontradas);
      setHint(`${encontradas.length} ${t('login.appsFound')}`);
      // Si solo hay una app (el caso normal) se elige sola y se cargan sus
      // programas de inmediato: un clic menos.
      if (encontradas.length === 1) {
        setApp(encontradas[0]);
        await buscarProgramas(encontradas[0]);
      }
    } catch (e: any) {
      setError(e?.message ?? String(e));
      setHint('');
    } finally {
      setSearching(false);
    }
  }, [credsListas, ip, user, password, t, buscarProgramas]);

  const onCambiarApp = (valor: string) => {
    setApp(valor);
    setError('');
    void buscarProgramas(valor);
  };

  // ------------------------------------------------------------------- //
  // Conectar
  // ------------------------------------------------------------------- //
  const handleConnect = async () => {
    if (isRexroth && !program) {
      setError(t('login.needProgram'));
      return;
    }
    setError('');
    setConnecting(true);
    try {
      await connect({
        vendor,
        ip: ip.trim(),
        puerto: 4840,
        usuario: isRexroth ? user.trim() : '',
        password: isRexroth ? password : '',
        app: isRexroth ? app || 'Application' : '',
        programa: isRexroth ? program : ''
      });
      navigate('/menu');
    } catch (e: any) {
      setError(e?.message ?? t('login.connectError'));
    } finally {
      setConnecting(false);
    }
  };

  const puedeConectar =
  !connecting && ip.trim() !== '' && (!isRexroth || !!program);

  return (
    <div className="relative flex min-h-full w-full items-center justify-center overflow-hidden bg-navy p-6">
      {/* subtle industrial backdrop */}
      <div className="hmi-grid-dark absolute inset-0 opacity-40" />
      <div className="absolute -left-32 top-1/2 h-96 w-96 -translate-y-1/2 rounded-full bg-siemens/10 blur-3xl" />

      <motion.div
        initial={{
          opacity: 0,
          y: 24
        }}
        animate={{
          opacity: 1,
          y: 0
        }}
        transition={{
          duration: 0.5,
          ease: 'easeOut'
        }}
        className="relative z-10 w-full max-w-md rounded-2xl border border-white/10 bg-navy-soft/90 p-8 shadow-2xl backdrop-blur">

        <div className="mb-7 flex flex-col items-center text-center">
          <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-siemens shadow-lg shadow-siemens/40">
            <CpuIcon className="h-7 w-7 text-white" />
          </div>
          <h1 className="text-2xl font-bold text-white">SRX Studio</h1>
          <p className="mt-1 text-sm text-slate-400">{t('login.subtitle')}</p>
        </div>

        {/* ---- Selector de marca ---- */}
        <div className="mb-5">
          <span className="mb-1.5 block text-xs font-medium text-slate-400">
            {t('login.vendor')}
          </span>
          <div className="grid grid-cols-2 gap-2 rounded-xl border border-white/10 bg-navy/60 p-1">
            <VendorTab
              active={vendor === 'siemens'}
              label={t('login.vendorSiemens')}
              onClick={() => setVendor('siemens')} />

            <VendorTab
              active={vendor === 'rexroth'}
              label={t('login.vendorRexroth')}
              onClick={() => setVendor('rexroth')} />

          </div>
          <p className="mt-1.5 text-[11px] text-slate-500">
            {isRexroth ?
            t('login.vendorRexrothHint') :
            t('login.vendorSiemensHint')}
          </p>
        </div>

        <div className="space-y-4">
          <LoginInput
            label={t('login.ip')}
            value={ip}
            onChange={setIp}
            icon={<NetworkIcon className="h-4 w-4" />}
            placeholder="192.168.0.1" />

          <LoginInput
            label={t('login.user')}
            value={user}
            onChange={setUser}
            icon={<UserIcon className="h-4 w-4" />}
            placeholder={isRexroth ? 'boschrexroth' : 'admin'} />

          <LoginInput
            label={t('login.password')}
            value={password}
            onChange={setPassword}
            icon={<LockIcon className="h-4 w-4" />}
            placeholder="••••••••"
            type="password" />

          {/* ---- Solo Rexroth: aplicación + programa ---- */}
          {isRexroth &&
          <>
              <div>
                <span className="mb-1.5 block text-xs font-medium text-slate-400">
                  {t('login.app')}
                </span>
                <div className="flex gap-2">
                  <LoginSelect
                  value={app}
                  onChange={onCambiarApp}
                  disabled={searching || apps.length === 0}
                  placeholder={t('login.selectApp')}
                  options={apps}
                  icon={<LayersIcon className="h-4 w-4" />} />

                  <button
                  type="button"
                  onClick={buscarApps}
                  disabled={searching || !credsListas}
                  title={t('login.search')}
                  className="flex shrink-0 items-center gap-1.5 rounded-xl border border-white/10 bg-siemens/20 px-3 text-xs font-medium text-white transition hover:bg-siemens/30 disabled:opacity-40">

                    <SearchIcon className="h-4 w-4" />
                    {t('login.search')}
                  </button>
                </div>
              </div>

              <div>
                <span className="mb-1.5 block text-xs font-medium text-slate-400">
                  {t('login.program')}
                </span>
                <LoginSelect
                value={program}
                onChange={setProgram}
                disabled={searching || programs.length === 0}
                placeholder={t('login.selectProgram')}
                options={programs}
                icon={<FileCodeIcon className="h-4 w-4" />} />

              </div>

              <p className="text-[11px] text-slate-500">
                {hint || t('login.searchHint')}
              </p>
            </>
          }
        </div>

        {/* ---- Mensaje de error ---- */}
        {error &&
        <div className="mt-4 flex items-start gap-2 rounded-xl border border-red-500/30 bg-red-500/10 p-3">
            <AlertCircleIcon className="mt-0.5 h-4 w-4 shrink-0 text-red-400" />
            <p className="whitespace-pre-wrap text-xs text-red-300">{error}</p>
          </div>
        }

        <motion.button
          onClick={handleConnect}
          whileHover={{
            scale: 1.015
          }}
          whileTap={{
            scale: 0.98
          }}
          disabled={!puedeConectar}
          className="mt-7 flex w-full items-center justify-center gap-2 rounded-xl bg-siemens py-3 text-sm font-semibold text-white shadow-lg shadow-siemens/30 transition-colors hover:bg-siemens-600 disabled:opacity-70">

          {connecting ?
          <>
              <motion.span
              className="h-4 w-4 rounded-full border-2 border-white/40 border-t-white"
              animate={{
                rotate: 360
              }}
              transition={{
                repeat: Infinity,
                duration: 0.7,
                ease: 'linear'
              }} />

              {t('login.connecting')}
            </> :

          <>
              <PlugZapIcon className="h-4 w-4" />
              {t('login.connect')}
            </>
          }
        </motion.button>

        <p className="mt-5 text-center text-[11px] text-slate-500">
          {t('login.emulated')}
        </p>
      </motion.div>
    </div>);

}

/** Pestaña del selector de marca. */
function VendorTab({
  active,
  label,
  onClick




}: {active: boolean;label: string;onClick: () => void;}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-lg py-2 text-sm font-medium transition ${
      active ?
      'bg-siemens text-white shadow shadow-siemens/30' :
      'text-slate-400 hover:text-slate-200'}`}>

      {label}
    </button>);

}

function LoginInput({
  label,
  value,
  onChange,
  icon,
  placeholder,
  type







}: {label: string;value: string;onChange: (v: string) => void;icon: React.ReactNode;placeholder?: string;type?: string;}) {
  return (
    <div>
      <span className="mb-1.5 block text-xs font-medium text-slate-400">
        {label}
      </span>
      <div className="relative">
        <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-500">
          {icon}
        </span>
        <input
          type={type ?? 'text'}
          value={value}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
          className="w-full rounded-xl border border-white/10 bg-navy/60 py-3 pl-10 pr-3 text-sm text-white placeholder-slate-500 outline-none transition focus:border-siemens focus:ring-2 focus:ring-siemens/30" />

      </div>
    </div>);

}

/**
 * Desplegable con el mismo estilo visual que LoginInput. Se usa para las
 * aplicaciones y los programas que devuelve el ctrlX.
 */
function LoginSelect({
  value,
  onChange,
  options,
  placeholder,
  icon,
  disabled







}: {value: string;onChange: (v: string) => void;options: string[];placeholder: string;icon: React.ReactNode;disabled?: boolean;}) {
  return (
    <div className="relative flex-1">
      <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-500">
        {icon}
      </span>
      <select
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className="w-full appearance-none rounded-xl border border-white/10 bg-navy/60 py-3 pl-10 pr-3 text-sm text-white outline-none transition focus:border-siemens focus:ring-2 focus:ring-siemens/30 disabled:opacity-50">

        <option value="" disabled>
          {placeholder}
        </option>
        {options.map((o) =>
        <option key={o} value={o}>
            {o}
          </option>
        )}
      </select>
    </div>);

}
