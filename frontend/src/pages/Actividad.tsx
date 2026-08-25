// =========================================================================
// Actividad.tsx  —  "¿Qué han hecho los demás?"
//
// Reúne en una sola pantalla lo que antes solo se podía consultar desde
// /docs o con curl:
//
//   · CONECTADOS  quién está trabajando ahora mismo (en vivo por WebSocket)
//   · BLOQUEOS    quién tiene el lápiz de cada pantalla
//   · AUDITORÍA   el histórico de quién hizo qué y cuándo
//   · CUENTAS     las cuentas, su último acceso y su estado
//
// Solo la ven Administradores y Supervisor, pero eso es COMODIDAD, no
// seguridad: el backend rechaza con 403 a quien no tenga permiso aunque
// llegue a esta URL a mano.
//
// Los conectados y los bloqueos se refrescan solos al recibir eventos por el
// WebSocket (`presence` y `lock.changed`), así que no hay polling para eso.
// La auditoría sí es bajo demanda: es un histórico, no cambia mientras miras.
// =========================================================================
import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import {
  ArrowLeftIcon,
  UsersIcon,
  LockIcon,
  ScrollTextIcon,
  ShieldCheckIcon,
  RefreshCwIcon,
  CircleIcon,
  AlertCircleIcon,
  UserXIcon,
  UserCheckIcon,
  UnlockIcon } from
'lucide-react';
import { useAppStore } from '../context/AppStore';
import {
  Bloqueo,
  Conectado,
  CuentaUsuario,
  EventoAuditoria,
  FAMILIAS,
  cambiarEstadoCuenta,
  etiquetaAccion,
  fechaLocal,
  fetchAuditoria,
  fetchBloqueos,
  fetchConectados,
  fetchCuentas,
  forzarBloqueo,
  haceCuanto } from
'../services/activityApi';

export function Actividad() {
  const navigate = useNavigate();
  const { permisos, sesion, presentes } = useAppStore();

  const [conectados, setConectados] = useState<Conectado[]>([]);
  const [sockets, setSockets] = useState(0);
  const [bloqueos, setBloqueos] = useState<Bloqueo[]>([]);
  const [eventos, setEventos] = useState<EventoAuditoria[]>([]);
  const [cuentas, setCuentas] = useState<CuentaUsuario[]>([]);

  const [filtroUsuario, setFiltroUsuario] = useState('');
  const [filtroAccion, setFiltroAccion] = useState('');
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState('');

  const esSupervisor = !!permisos?.gestionar_usuarios;

  // ------------------------------------------------------------------ //
  // Carga
  // ------------------------------------------------------------------ //
  const cargarTodo = useCallback(async () => {
    setCargando(true);
    setError('');
    try {
      const [c, b, ev] = await Promise.all([
        fetchConectados(),
        fetchBloqueos(),
        fetchAuditoria({ usuario: filtroUsuario, accion: filtroAccion }),
      ]);
      setConectados(c.usuarios);
      setSockets(c.num_clientes_ws);
      setBloqueos(b);
      setEventos(ev);
      // Las cuentas van aparte: si el rol no llega, el 403 no debe impedir
      // ver el resto de la pantalla.
      try {
        setCuentas(await fetchCuentas());
      } catch {
        setCuentas([]);
      }
    } catch (e: any) {
      setError(e?.message ?? 'No se pudo cargar la actividad.');
    } finally {
      setCargando(false);
    }
  }, [filtroUsuario, filtroAccion]);

  useEffect(() => {
    void cargarTodo();
  }, [cargarTodo]);

  // Presencia y bloqueos en vivo: llegan por WebSocket, sin polling.
  useEffect(() => {
    setConectados(presentes.filter((p) => !p.usuario.includes('anónimo')));
  }, [presentes]);

  useEffect(() => {
    const alEvento = (e: Event) => {
      const msg = (e as CustomEvent).detail;
      if (msg?.type === 'lock.changed') {
        // Un lock cambió: se vuelve a pedir la lista. Es una petición
        // diminuta y así no hay que replicar aquí la lógica de caducidad.
        void fetchBloqueos().then(setBloqueos).catch(() => {});
      }
    };
    window.addEventListener('hmi:ws', alEvento as EventListener);
    return () => window.removeEventListener('hmi:ws', alEvento as EventListener);
  }, []);

  // ------------------------------------------------------------------ //
  // Acciones
  // ------------------------------------------------------------------ //
  const alternarCuenta = async (u: CuentaUsuario) => {
    const nuevo = u.estado === 'Activo' ? 'Inactivo' : 'Activo';
    if (nuevo === 'Inactivo' && u.usuario === sesion?.usuario) {
      setError('No puedes desactivar tu propia cuenta.');
      return;
    }
    try {
      await cambiarEstadoCuenta(u.usuario, nuevo as 'Activo' | 'Inactivo');
      await cargarTodo();
    } catch (e: any) {
      setError(e?.message ?? 'No se pudo cambiar el estado.');
    }
  };

  const quitarLapiz = async (recurso: string) => {
    try {
      await forzarBloqueo(recurso);
      await cargarTodo();
    } catch (e: any) {
      setError(e?.message ?? 'No se pudo tomar el control.');
    }
  };

  // ------------------------------------------------------------------ //
  // Vista
  // ------------------------------------------------------------------ //
  if (permisos && !permisos.gestionar_bd && !esSupervisor) {
    return (
      <Marco onVolver={() => navigate('/menu')}>
        <div className="flex flex-col items-center gap-3 py-24 text-center">
          <ShieldCheckIcon className="h-10 w-10 text-slate-400" />
          <p className="text-sm text-slate-500 dark:text-slate-400">
            Tu categoría ({sesion?.categoria ?? 'sin sesión'}) no permite ver la
            actividad de otros usuarios.
          </p>
        </div>
      </Marco>
    );
  }

  return (
    <Marco onVolver={() => navigate('/menu')} onRefrescar={cargarTodo}
      cargando={cargando}>

      {error &&
      <div className="mb-5 flex items-start gap-2 rounded-xl border border-red-500/30 bg-red-500/10 p-3">
          <AlertCircleIcon className="mt-0.5 h-4 w-4 shrink-0 text-red-400" />
          <p className="text-xs text-red-400">{error}</p>
        </div>
      }

      <div className="grid gap-5 lg:grid-cols-2">

        {/* ══════════ CONECTADOS ══════════ */}
        <Tarjeta
          icono={<UsersIcon className="h-4 w-4" />}
          titulo="Trabajando ahora"
          resumen={`${conectados.length} persona(s) · ${sockets} pantalla(s)`}>

          {conectados.length === 0 ?
          <Vacio texto="Nadie más conectado en este momento." /> :

          <ul className="divide-y divide-slate-200 dark:divide-navy-slate">
              {conectados.map((u) =>
            <li key={u.usuario} className="flex items-center gap-3 py-2.5">
                  {/* El punto verde es la señal más rápida de "está vivo". */}
                  <CircleIcon className="h-2.5 w-2.5 fill-state-ok text-state-ok" />
                  <span className="flex-1 text-sm font-medium text-navy dark:text-slate-100">
                    {u.usuario}
                    {u.usuario === sesion?.usuario &&
                <span className="ml-1.5 text-[11px] font-normal text-slate-400">(tú)</span>
                }
                  </span>
                  <span className="text-xs text-slate-400">{u.categoria}</span>
                </li>
            )}
            </ul>
          }
          <p className="mt-3 text-[11px] text-slate-400">
            Una persona con dos pestañas abiertas cuenta una sola vez; por eso
            puede haber más pantallas que personas.
          </p>
        </Tarjeta>

        {/* ══════════ BLOQUEOS ══════════ */}
        <Tarjeta
          icono={<LockIcon className="h-4 w-4" />}
          titulo="Control de edición"
          resumen={`${bloqueos.length} pantalla(s) en edición`}>

          {bloqueos.length === 0 ?
          <Vacio texto="Nadie está editando ninguna pantalla." /> :

          <ul className="divide-y divide-slate-200 dark:divide-navy-slate">
              {bloqueos.map((b) =>
            <li key={b.recurso} className="flex items-center gap-3 py-2.5">
                  <div className="flex-1">
                    <p className="text-sm font-medium text-navy dark:text-slate-100">
                      {b.usuario}
                    </p>
                    <p className="text-[11px] text-slate-400">
                      {b.recurso} · caduca en {Math.round(b.segundos_restantes)} s
                    </p>
                  </div>
                  {/* Quitarle el lápiz a otro es acción de Supervisor y queda
                      registrada en la auditoría. */}
                  {esSupervisor && b.usuario !== sesion?.usuario &&
              <button
                onClick={() => void quitarLapiz(b.recurso)}
                title="Quitarle el control (queda registrado)"
                className="flex items-center gap-1 rounded-lg bg-state-warn/15 px-2 py-1 text-[11px] font-semibold text-state-warn transition hover:bg-state-warn/25">
                      <UnlockIcon className="h-3 w-3" />
                      Tomar control
                    </button>
              }
                </li>
            )}
            </ul>
          }
          <p className="mt-3 text-[11px] text-slate-400">
            El control se suelta solo a los 30 s sin actividad, así que un
            navegador cerrado no deja la pantalla bloqueada.
          </p>
        </Tarjeta>

        {/* ══════════ CUENTAS ══════════ */}
        <Tarjeta
          icono={<ShieldCheckIcon className="h-4 w-4" />}
          titulo="Cuentas"
          resumen={`${cuentas.length} cuenta(s)`}>

          {cuentas.length === 0 ?
          <Vacio texto="Sin permiso para ver las cuentas, o no hay ninguna." /> :

          <ul className="divide-y divide-slate-200 dark:divide-navy-slate">
              {cuentas.map((u) => {
              const activo = u.estado === 'Activo';
              const enLinea = conectados.some((c) => c.usuario === u.usuario);
              return (
                <li key={u.id} className="flex items-center gap-3 py-2.5">
                    <CircleIcon
                    className={`h-2.5 w-2.5 ${
                    enLinea ?
                    'fill-state-ok text-state-ok' :
                    'fill-slate-300 text-slate-300 dark:fill-navy-slate dark:text-navy-slate'}`
                    } />

                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-navy dark:text-slate-100">
                        {u.usuario}
                        <span className="ml-1.5 text-[11px] font-normal text-slate-400">
                          {u.categoria}
                        </span>
                      </p>
                      <p className="text-[11px] text-slate-400"
                      title={fechaLocal(u.ultimo_acceso)}>
                        {u.ultimo_acceso ?
                      `Último acceso ${haceCuanto(u.ultimo_acceso)}` :
                      'Nunca ha entrado'}
                      </p>
                    </div>
                    {!activo &&
                  <span className="rounded bg-slate-200 px-1.5 py-0.5 text-[10px] font-bold text-slate-500 dark:bg-navy-slate dark:text-slate-400">
                        INACTIVO
                      </span>
                  }
                    {esSupervisor && u.usuario !== sesion?.usuario &&
                  <button
                    onClick={() => void alternarCuenta(u)}
                    title={activo ?
                    'Desactivar: cierra sus sesiones al instante' :
                    'Reactivar la cuenta'}
                    className={`flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] font-semibold transition ${
                    activo ?
                    'bg-red-500/10 text-red-400 hover:bg-red-500/20' :
                    'bg-state-ok/10 text-state-ok hover:bg-state-ok/20'}`
                    }>
                        {activo ?
                    <><UserXIcon className="h-3 w-3" />Desactivar</> :
                    <><UserCheckIcon className="h-3 w-3" />Activar</>}
                      </button>
                  }
                  </li>);

            })}
            </ul>
          }
        </Tarjeta>

        {/* ══════════ AUDITORÍA ══════════ */}
        <div className="lg:col-span-2">
          <Tarjeta
            icono={<ScrollTextIcon className="h-4 w-4" />}
            titulo="Histórico de actividad"
            resumen={`${eventos.length} evento(s)`}
            cabecera={
            <div className="flex flex-wrap items-center gap-2">
                <select
                value={filtroAccion}
                onChange={(e) => setFiltroAccion(e.target.value)}
                className="rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs text-navy outline-none dark:border-navy-slate dark:bg-navy dark:text-slate-200">
                  {FAMILIAS.map((f) =>
                <option key={f.valor} value={f.valor}>{f.etiqueta}</option>
                )}
                </select>
                <input
                value={filtroUsuario}
                onChange={(e) => setFiltroUsuario(e.target.value)}
                placeholder="Filtrar por usuario…"
                className="w-40 rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs text-navy outline-none placeholder-slate-400 dark:border-navy-slate dark:bg-navy dark:text-slate-200" />

              </div>
            }>

            {eventos.length === 0 ?
            <Vacio texto="Sin eventos que coincidan con el filtro." /> :

            <div className="max-h-[26rem] overflow-y-auto">
                <table className="w-full text-left text-sm">
                  <thead className="sticky top-0 bg-white text-[11px] uppercase text-slate-400 dark:bg-navy-soft">
                    <tr>
                      <th className="py-2 pr-3 font-semibold">Cuándo</th>
                      <th className="py-2 pr-3 font-semibold">Quién</th>
                      <th className="py-2 pr-3 font-semibold">Qué hizo</th>
                      <th className="py-2 font-semibold">Sobre qué</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200 dark:divide-navy-slate">
                    {eventos.map((ev, i) =>
                  <tr key={`${ev.ts}-${i}`}>
                        <td className="whitespace-nowrap py-2 pr-3 text-xs text-slate-400"
                    title={fechaLocal(ev.ts)}>
                          {haceCuanto(ev.ts)}
                        </td>
                        <td className="py-2 pr-3 text-xs font-medium text-navy dark:text-slate-200">
                          {ev.usuario}
                        </td>
                        <td className="py-2 pr-3 text-xs text-navy dark:text-slate-300">
                          {etiquetaAccion(ev.accion)}
                        </td>
                        <td className="py-2 text-xs text-slate-400">
                          {ev.recurso}
                          {ev.detalle &&
                      <span className="ml-1.5 text-[11px] text-slate-400">
                              {Object.entries(ev.detalle).
                        map(([k, v]) => `${k}: ${v}`).
                        join(' · ')}
                            </span>
                      }
                        </td>
                      </tr>
                  )}
                  </tbody>
                </table>
              </div>
            }
            <p className="mt-3 text-[11px] text-slate-400">
              Se guarda en <code>datos/auditoria.jsonl</code>, una línea por
              evento. Las horas se muestran en la zona de este equipo.
            </p>
          </Tarjeta>
        </div>
      </div>
    </Marco>);

}

// ====================================================================== //
// Piezas de presentación
// ====================================================================== //
function Marco({
  children,
  onVolver,
  onRefrescar,
  cargando






}: {children: React.ReactNode;onVolver: () => void;onRefrescar?: () => void;cargando?: boolean;}) {
  return (
    <div className="mp-scroll mp-scroll-dark h-full w-full overflow-y-auto bg-slate-50 dark:bg-navy">
      <header className="sticky top-0 z-10 flex items-center justify-between border-b border-slate-200 bg-white px-6 py-3 dark:border-navy-slate dark:bg-navy-soft">
        <div className="flex items-center gap-3">
          <button
            onClick={onVolver}
            className="flex h-9 w-9 items-center justify-center rounded-lg text-slate-400 transition hover:bg-slate-100 hover:text-navy dark:hover:bg-navy-slate/40 dark:hover:text-slate-100">
            <ArrowLeftIcon className="h-4 w-4" />
          </button>
          <div>
            <p className="text-sm font-bold text-navy dark:text-slate-100">
              Actividad
            </p>
            <p className="text-xs text-slate-400">
              Quién está trabajando y qué se ha hecho
            </p>
          </div>
        </div>
        {onRefrescar &&
        <button
          onClick={onRefrescar}
          disabled={cargando}
          className="flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium text-slate-500 transition hover:bg-slate-100 hover:text-navy disabled:opacity-50 dark:hover:bg-navy-slate/40 dark:hover:text-slate-100">
            <RefreshCwIcon className={`h-4 w-4 ${cargando ? 'animate-spin' : ''}`} />
            Actualizar
          </button>
        }
      </header>
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        className="mx-auto max-w-6xl px-6 py-6">
        {children}
      </motion.div>
    </div>);

}

function Tarjeta({
  icono,
  titulo,
  resumen,
  cabecera,
  children






}: {icono: React.ReactNode;titulo: string;resumen?: string;cabecera?: React.ReactNode;children: React.ReactNode;}) {
  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-5 dark:border-navy-slate dark:bg-navy-soft">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-siemens/10 text-siemens">
            {icono}
          </span>
          <div>
            <h2 className="text-sm font-bold text-navy dark:text-slate-100">
              {titulo}
            </h2>
            {resumen &&
            <p className="text-[11px] text-slate-400">{resumen}</p>
            }
          </div>
        </div>
        {cabecera}
      </div>
      {children}
    </section>);

}

function Vacio({ texto }: {texto: string;}) {
  return (
    <p className="py-6 text-center text-xs text-slate-400">{texto}</p>);

}
