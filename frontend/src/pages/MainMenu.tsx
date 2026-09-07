import React from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import {
  SettingsIcon,
  LayoutDashboardIcon,
  ArrowRightIcon,
  UsersIcon,
  ShieldCheckIcon,
  LogOutIcon } from
'lucide-react';
import { useAppStore } from '../context/AppStore';
export function MainMenu() {
  const navigate = useNavigate();
  const { disconnect, t, permisos, presentes } = useAppStore();
  // Las tarjetas de administración solo se ofrecen a quien puede usarlas. El
  // permiso REAL lo aplica el backend en cada endpoint; esto es comodidad,
  // no seguridad.
  const verActividad = !permisos || permisos.gestionar_bd ||
  permisos.gestionar_usuarios;
  // Cuentas pide MÁS que Actividad: ver quién hizo qué es una cosa y poder
  // cambiar quién entra es otra. Un Administrador entra igual, pero la
  // pantalla se le presenta en modo consulta.
  const verCuentas = !permisos || permisos.gestionar_usuarios;
  // Cuántas tarjetas de administración se muestran. Hace falta el número
  // porque con UNA hay que centrarla a mano bajo las dos fijas, y con DOS la
  // rejilla ya cuadra sola en 2×2 y centrarla la descolocaría.
  const extras = (verActividad ? 1 : 0) + (verCuentas ? 1 : 0);
  const centrarSuelta = extras === 1
    ? 'md:col-span-2 md:mx-auto md:w-[calc(50%-0.75rem)]'
    : '';
  // Cuántas personas más están conectadas ahora mismo.
  const otros = presentes.filter(
    (p) => !p.usuario.includes('anónimo')
  ).length;
  const handleLogout = () => {
    disconnect();
    navigate('/');
  };
  return (
    <div className="relative flex min-h-full w-full flex-col bg-slate-50 dark:bg-navy">
      <header className="flex items-center justify-between border-b border-slate-200 bg-white px-8 py-4 dark:border-navy-slate dark:bg-navy-soft">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-siemens">
            <LayoutDashboardIcon className="h-5 w-5 text-white" />
          </div>
          <div>
            <p className="text-sm font-bold text-navy dark:text-slate-100">
              Psi Core
            </p>
          </div>
        </div>
        {/* Salir vuelve al acceso (/). La sesion todavia no se valida
            contra la BD, asi que por ahora solo limpia el estado local. */}
        <button
          onClick={handleLogout}
          className="flex min-h-[44px] items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium text-slate-500 outline-none transition hover:bg-slate-100 hover:text-navy focus-visible:ring-2 focus-visible:ring-siemens/40 dark:hover:bg-navy-slate/40 dark:hover:text-slate-100">
          <LogOutIcon className="h-4 w-4" />
          {t('menu.logout')}
        </button>
      </header>

      <div className="flex flex-1 flex-col items-center justify-center px-6 py-16">
        <motion.div
          initial={{
            opacity: 0,
            y: 12
          }}
          animate={{
            opacity: 1,
            y: 0
          }}
          className="mb-12 text-center">
          
          <h1 className="text-3xl font-bold text-navy dark:text-slate-100">
            {t('menu.title')}
          </h1>
          <p className="mt-2 text-slate-500 dark:text-slate-400">
            {t('menu.subtitle')}
          </p>
        </motion.div>

        <div className="grid w-full max-w-3xl grid-cols-1 gap-6 md:grid-cols-2">
          <MenuCard
            title={t('menu.configTitle')}
            description={t('menu.configDesc')}
            icon={<SettingsIcon className="h-8 w-8" />}
            onClick={() => navigate('/config')}
            delay={0.05}
            open={t('menu.open')} />
          
          <MenuCard
            title={t('menu.mainTitle')}
            description={t('menu.mainDesc')}
            icon={<LayoutDashboardIcon className="h-8 w-8" />}
            onClick={() => navigate('/designer')}
            delay={0.12}
            open={t('menu.open')} />

          {verActividad &&
          <MenuCard
            /* Tres tarjetas en una rejilla de dos columnas dejan la tercera
               pegada a la izquierda, desalineada de las de arriba. Ocupando
               las DOS columnas y volviendo al ancho de UNA (`50%` menos medio
               `gap-6`, que son 0.75rem) queda centrada bajo las otras dos,
               con exactamente su mismo tamaño. Con cuatro tarjetas no hace
               falta: la rejilla ya cuadra en 2×2 (ver `centrarSuelta`). */
            className={centrarSuelta}
            title="Actividad"
            description={
            otros > 1 ?
            `${otros} personas conectadas ahora. Vea quién está trabajando, ` +
            `quién edita cada pantalla y el histórico de cambios.` :
            'Vea quién está trabajando, quién edita cada pantalla y el ' +
            'histórico de quién hizo qué y cuándo.'}
            icon={<UsersIcon className="h-8 w-8" />}
            onClick={() => navigate('/actividad')}
            delay={0.19}
            open={t('menu.open')} />
          }

          {verCuentas &&
          <MenuCard
            className={centrarSuelta}
            title="Cuentas"
            description={
            'Cree y edite las cuentas, cambie categorías y contraseñas, y ' +
            'active o desactive el acceso.'}
            icon={<ShieldCheckIcon className="h-8 w-8" />}
            onClick={() => navigate('/usuarios')}
            delay={0.26}
            open={t('menu.open')} />
          }
        </div>
      </div>
    </div>);

}
function MenuCard({
  title,
  description,
  icon,
  onClick,
  delay,
  open,
  className = ''







}: {title: string;description: string;icon: React.ReactNode;onClick: () => void;delay: number;open: string;className?: string;}) {
  return (
    <motion.button
      onClick={onClick}
      initial={{
        opacity: 0,
        y: 20
      }}
      animate={{
        opacity: 1,
        y: 0
      }}
      transition={{
        delay,
        duration: 0.4
      }}
      whileHover={{
        scale: 1.03,
        y: -4
      }}
      whileTap={{
        scale: 0.99
      }}
      className={`group flex flex-col items-start gap-5 rounded-2xl border border-slate-200 bg-white p-8 text-left shadow-card transition-shadow hover:border-siemens/40 hover:shadow-cardHover dark:border-navy-slate dark:bg-navy-soft ${className}`}>
      
      <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-siemens-50 text-siemens transition-colors group-hover:bg-siemens group-hover:text-white dark:bg-siemens/15">
        {icon}
      </div>
      <div>
        <h2 className="text-xl font-bold text-navy dark:text-slate-100">
          {title}
        </h2>
        <p className="mt-2 text-sm leading-relaxed text-slate-500 dark:text-slate-400">
          {description}
        </p>
      </div>
      <span className="mt-auto flex items-center gap-1.5 text-sm font-semibold text-siemens">
        {open}
        <ArrowRightIcon className="h-4 w-4 transition-transform group-hover:translate-x-1" />
      </span>
    </motion.button>);

}