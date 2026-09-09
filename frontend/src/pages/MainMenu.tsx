import React from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import {
  SettingsIcon,
  LayoutDashboardIcon,
  ArrowRightIcon,
  UsersIcon,
  ShieldCheckIcon,
  BellIcon,
  LogOutIcon } from
'lucide-react';
import { useAppStore } from '../context/AppStore';
import { Logo } from '../components/ui/Logo';
import { fetchPendientes } from '../services/alarmasRuntimeApi';
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
  // NOTA SOBRE LA REJILLA
  //
  // Antes eran dos columnas fijas con un apaño para centrar la última cuando
  // el número era impar. Eso tenía dos problemas: cada módulo nuevo empujaba
  // la página hacia abajo hasta obligar a hacer scroll para ver el último, y
  // la tarjeta centrada quedaba desalineada con las de arriba.
  //
  // Ahora las tarjetas se reparten a lo ANCHO (hasta cuatro por fila) y la
  // última fila se alinea a la izquierda, como cualquier lanzador de
  // aplicaciones. Con ocho módulos siguen cabiendo dos filas en pantalla, y
  // no hay ningún caso especial que mantener.
  // Cuántas personas más están conectadas ahora mismo.
  const otros = presentes.filter(
    (p) => !p.usuario.includes('anónimo')
  ).length;

  // Cuántas alarmas esperan a que alguien las reconozca. Se pide una vez al
  // entrar al menú: el banner de arriba ya avisa en vivo, y aquí solo sirve
  // para que la tarjeta diga si hay algo que mirar antes de entrar.
  const [pendientes, setPendientes] = React.useState(0);
  React.useEffect(() => {
    let vivo = true;
    fetchPendientes(1)
      .then((p) => { if (vivo) setPendientes(p.total); })
      .catch(() => { /* motor apagado o BD caída: la tarjeta va sin número */ });
    return () => { vivo = false; };
  }, []);
  const handleLogout = () => {
    disconnect();
    navigate('/');
  };
  return (
    <div className="relative flex min-h-full w-full flex-col bg-slate-50 dark:bg-navy">
      <header className="flex items-center justify-between border-b border-slate-200 bg-white px-8 py-4 dark:border-navy-slate dark:bg-navy-soft">
        {/* El logo real, no un icono genérico con el nombre al lado. Sale del
            componente compartido, así que cambiar `public/logo.png` lo cambia
            aquí y en la pantalla de acceso a la vez. */}
        <Logo variante="barra" />
        {/* Salir vuelve al acceso (/). La sesion todavia no se valida
            contra la BD, asi que por ahora solo limpia el estado local. */}
        <button
          onClick={handleLogout}
          className="flex min-h-[44px] items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium text-slate-500 outline-none transition hover:bg-slate-100 hover:text-navy focus-visible:ring-2 focus-visible:ring-siemens/40 dark:hover:bg-navy-slate/40 dark:hover:text-slate-100">
          <LogOutIcon className="h-4 w-4" />
          {t('menu.logout')}
        </button>
      </header>

      <div className="flex flex-1 flex-col items-center justify-center px-6 py-10">
        <motion.div
          initial={{
            opacity: 0,
            y: 12
          }}
          animate={{
            opacity: 1,
            y: 0
          }}
          className="mb-8 text-center">
          
          <h1 className="text-2xl font-bold text-navy dark:text-slate-100">
            {t('menu.title')}
          </h1>
          <p className="mt-1.5 text-sm text-slate-500 dark:text-slate-400">
            {t('menu.subtitle')}
          </p>
        </motion.div>

        <div className="grid w-full max-w-6xl grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          <MenuCard
            title={t('menu.configTitle')}
            description={t('menu.configDesc')}
            icon={<SettingsIcon className="h-6 w-6" />}
            onClick={() => navigate('/config')}
            delay={0.05}
            open={t('menu.open')} />
          
          <MenuCard
            title={t('menu.mainTitle')}
            description={t('menu.mainDesc')}
            icon={<LayoutDashboardIcon className="h-6 w-6" />}
            onClick={() => navigate('/designer')}
            delay={0.12}
            open={t('menu.open')} />

          {verActividad &&
          <MenuCard
            title="Actividad"
            description={
            otros > 1 ?
            `${otros} personas conectadas ahora. Vea quién está trabajando, ` +
            `quién edita cada pantalla y el histórico de cambios.` :
            'Vea quién está trabajando, quién edita cada pantalla y el ' +
            'histórico de quién hizo qué y cuándo.'}
            icon={<UsersIcon className="h-6 w-6" />}
            onClick={() => navigate('/actividad')}
            delay={0.19}
            open={t('menu.open')} />
          }

          {verCuentas &&
          <MenuCard
            title="Cuentas"
            description={
            'Cree y edite las cuentas, cambie categorías y contraseñas, y ' +
            'active o desactive el acceso.'}
            icon={<ShieldCheckIcon className="h-6 w-6" />}
            onClick={() => navigate('/usuarios')}
            delay={0.26}
            open={t('menu.open')} />
          }

          {/* Alarmas va la ÚLTIMA y la ve todo el mundo: en una planta, saber
              qué está saltando no es una función de administración. */}
          <MenuCard
            title="Alarmas"
            description={
            pendientes > 0 ?
            `${pendientes} sin reconocer. Vea qué saltó, cuándo y con qué ` +
            `valor, y déjelo firmado.` :
            'Vea qué alarmas están activas, el histórico de lo que pasó y ' +
            'reconozca las que ya ha atendido.'}
            icon={<BellIcon className="h-6 w-6" />}
            onClick={() => navigate('/alarmas')}
            delay={0.33}
            open={t('menu.open')}
            distintivo={pendientes > 0 ? String(pendientes) : ''} />
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
  /** Contador sobre el icono. Vacío = sin distintivo. */
  distintivo = ''
}: {
  title: string;
  description: string;
  icon: React.ReactNode;
  onClick: () => void;
  delay: number;
  open: string;
  distintivo?: string;
}) {
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
      className="group flex h-full flex-col items-start gap-4 rounded-2xl border border-slate-200 bg-white p-6 text-left shadow-card transition-shadow hover:border-siemens/40 hover:shadow-cardHover dark:border-navy-slate dark:bg-navy-soft">

      <div className="relative flex h-12 w-12 items-center justify-center rounded-xl bg-siemens-50 text-siemens transition-colors group-hover:bg-siemens group-hover:text-white dark:bg-siemens/15">
        {icon}
        {/* El contador va sobre el ICONO y no en el texto: desde el otro lado
            de la sala se ve la mancha roja, y eso es todo lo que hace falta
            para saber que hay que acercarse. */}
        {distintivo && (
          <span className="absolute -right-1.5 -top-1.5 flex h-6 min-w-[24px] items-center justify-center rounded-full bg-state-error px-1.5 text-[11px] font-bold text-white ring-2 ring-white dark:ring-navy-soft">
            {distintivo}
          </span>
        )}
      </div>
      <div>
        <h2 className="text-base font-bold text-navy dark:text-slate-100">
          {title}
        </h2>
        <p className="mt-1.5 text-[13px] leading-relaxed text-slate-500 dark:text-slate-400">
          {description}
        </p>
      </div>
      <span className="mt-auto flex items-center gap-1.5 pt-1 text-[13px] font-semibold text-siemens">
        {open}
        <ArrowRightIcon className="h-4 w-4 transition-transform group-hover:translate-x-1" />
      </span>
    </motion.button>);

}