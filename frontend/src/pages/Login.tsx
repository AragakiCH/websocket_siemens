import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import {
  NetworkIcon,
  UserIcon,
  LockIcon,
  PlugZapIcon,
  CpuIcon } from
'lucide-react';
import { useAppStore } from '../context/AppStore';
import { TextField } from '../components/ui/Field';
export function Login() {
  const navigate = useNavigate();
  const { connect, t } = useAppStore();
  const [ip, setIp] = useState('192.168.0.1');
  const [user, setUser] = useState('admin');
  const [password, setPassword] = useState('');
  const [connecting, setConnecting] = useState(false);
  const handleConnect = () => {
    setConnecting(true);
    connect(ip);
    setTimeout(() => navigate('/menu'), 650);
  };
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
            placeholder="admin" />
          
          <LoginInput
            label={t('login.password')}
            value={password}
            onChange={setPassword}
            icon={<LockIcon className="h-4 w-4" />}
            placeholder="••••••••"
            type="password" />
          
        </div>

        <motion.button
          onClick={handleConnect}
          whileHover={{
            scale: 1.015
          }}
          whileTap={{
            scale: 0.98
          }}
          disabled={connecting}
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