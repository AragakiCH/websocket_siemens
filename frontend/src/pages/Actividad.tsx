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
// LA FORMA DE LA PANTALLA
// El histórico manda y ocupa la columna ancha; conectados, bloqueos y
// cuentas son CONTEXTO y viven en un raíl a la derecha. Antes los cuatro
// eran tarjetas del mismo tamaño en una rejilla 2×2, y eso decía que las
// cuatro cosas pesan lo mismo — cuando en realidad tres se leen de un
// vistazo y la cuarta es a la que se viene.
//
// Los conectados y los bloqueos se refrescan solos al recibir eventos por el
// WebSocket (`presence` y `lock.changed`), así que no hay polling para eso.
// La auditoría sí es bajo demanda: es un histórico, no cambia mientras miras.
// =========================================================================
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import {
  ArrowLeftIcon,
  UsersIcon,
  LockIcon,
  UnlockIcon,
  ShieldCheckIcon,
  RefreshCwIcon,
  AlertCircleIcon,
  UserXIcon,
  UserCheckIcon,
  SearchIcon,
  CpuIcon,
  LayoutDashboardIcon,
  ServerIcon,
  DatabaseIcon,
  HistoryIcon,
  MonitorIcon,
  FileTextIcon,
  type LucideIcon,
} from 'lucide-react';
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
  haceCuanto,
} from '../services/activityApi';

// ---------------------------------------------------------------------- //
// Presentación de un evento
// ---------------------------------------------------------------------- //

/**
 * Etiquetas cortas para las pestañas.
 *
 * `FAMILIAS` vive en `activityApi` y sus textos ("Control de edición") están
 * pensados para un desplegable, donde hay sitio. En una fila de pestañas
 * seis palabras largas obligan a partir la línea, así que aquí se acortan
 * SOLO para la pestaña. El valor que se manda al backend es el mismo.
 */
const TAB_CORTO: Record<string, string> = {
  'lock.': 'Edición',
  'bd.': 'Bases',
};

/**
 * Icono y color por familia de evento.
 *
 * El color no es decorativo: separa de un golpe lo que AÑADE de lo que
 * QUITA. En una lista de doscientas líneas, "Agregó un PLC" y "Quitó un PLC"
 * se distinguen antes por el color del icono que leyendo el verbo.
 */
function pintaDe(accion: string): { Icono: LucideIcon; clase: string } {
  const quita = /\.(baja|borrado|forzado|parada)/.test(accion);
  const anade = /\.(alta|creado|adquirido|arranque)/.test(accion);
  const tono = quita
    ? 'bg-state-error/10 text-state-error ring-state-error/25'
    : anade
      ? 'bg-siemens/10 text-siemens ring-siemens/25'
      : 'bg-slate-100 text-slate-400 ring-slate-200 dark:bg-navy-slate/50 dark:ring-navy-slate';

  const familia = accion.split('.')[0];
  const Icono =
    familia === 'plc' ? CpuIcon :
    familia === 'proyecto' ? LayoutDashboardIcon :
    familia === 'lock' ? LockIcon :
    familia === 'usuario' ? ShieldCheckIcon :
    familia === 'bd' ? DatabaseIcon :
    ServerIcon;

  return { Icono, clase: tono };
}

/** Iniciales para el avatar. `anónimo` se marca con una interrogación. */
function inicial(usuario: string): string {
  const u = (usuario || '').trim();
  if (!u || u.toLowerCase().includes('anónimo') || u.toLowerCase().includes('anonimo')) {
    return '?';
  }
  return u[0].toUpperCase();
}

const esAnonimo = (u: string) =>
  !u || u.toLowerCase().includes('anónimo') || u.toLowerCase().includes('anonimo');

/**
 * Etiqueta del día al que pertenece un evento.
 *
 * Se agrupa por día porque es como se busca de verdad: nadie recuerda la
 * hora exacta, pero sí "fue hoy" o "fue ayer".
 */
function diaDe(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const hoy = new Date();
  const ayer = new Date();
  ayer.setDate(hoy.getDate() - 1);
  const mismo = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();
  if (mismo(d, hoy)) return 'Hoy';
  if (mismo(d, ayer)) return 'Ayer';
  return d.toLocaleDateString(undefined, {
    day: '2-digit', month: 'long', year: 'numeric',
  });
}

/** Solo la hora, para la segunda línea de la columna «Cuándo». */
function horaDe(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ''
    : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// ═════════════════════════════════════════════════════════════════════════
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

  // Cuántos eventos se PINTAN. La petición ya trae el lote entero, así que
  // «Ver más» no vuelve a preguntar nada: solo deja de recortar la lista.
  // Doscientas filas de golpe son doscientos nodos que nadie va a leer.
  const [mostrar, setMostrar] = useState(12);

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

  // Al cambiar de filtro se vuelve a empezar por arriba: seguir en «40
  // eventos» tras cambiar de pestaña enseña un tramo que nadie pidió.
  useEffect(() => {
    setMostrar(12);
  }, [filtroUsuario, filtroAccion]);

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
  // Derivados de presentación
  // ------------------------------------------------------------------ //
  const visibles = eventos.slice(0, mostrar);

  /** Filas ya intercaladas con su separador de día. */
  const filas = useMemo(() => {
    const out: Array<
      | { tipo: 'dia'; dia: string; n: number }
      | { tipo: 'ev'; ev: EventoAuditoria; i: number }
    > = [];
    let ultimo = '';
    visibles.forEach((ev, i) => {
      const d = diaDe(ev.ts);
      if (d !== ultimo) {
        out.push({
          tipo: 'dia',
          dia: d,
          n: eventos.filter((x) => diaDe(x.ts) === d).length,
        });
        ultimo = d;
      }
      out.push({ tipo: 'ev', ev, i });
    });
    return out;
  }, [visibles, eventos]);

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
    <Marco
      onVolver={() => navigate('/menu')}
      onRefrescar={cargarTodo}
      cargando={cargando}
    >
      {/* ── Encabezado de la sección ─────────────────────────────── */}
      <div className="mb-5 flex items-start gap-3">
        <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-siemens-50 text-siemens dark:bg-siemens/15">
          <HistoryIcon className="h-4.5 w-4.5" />
        </span>
        <div className="min-w-0">
          <h1 className="text-lg font-bold leading-tight text-navy dark:text-slate-100">
            Actividad y sesiones
          </h1>
          <p className="mt-0.5 text-[12.5px] text-slate-400">
            {eventos.length} evento{eventos.length === 1 ? '' : 's'} registrado
            {eventos.length === 1 ? '' : 's'} en este equipo. Las horas son de la
            zona local.
          </p>
        </div>
      </div>

      {error && (
        <div className="mb-4 flex items-start gap-2 rounded-xl border border-state-error/30 bg-state-error/10 px-3.5 py-3">
          <AlertCircleIcon className="mt-px h-4 w-4 shrink-0 text-state-error" />
          <p className="min-w-0 text-xs text-state-error">{error}</p>
        </div>
      )}

      {/* El histórico manda; el resto es contexto y va al raíl derecho. */}
      <div className="flex flex-col gap-5 xl:flex-row xl:items-start">

        {/* ══════════════════ HISTÓRICO ══════════════════ */}
        <section className="min-w-0 flex-1 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-card dark:border-navy-slate dark:bg-navy-soft">

          {/* Pestañas + buscador */}
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-3 py-2.5 dark:border-navy-slate">
            <div className="flex flex-wrap items-center gap-1">
              {FAMILIAS.map((f) => (
                <button
                  key={f.valor}
                  type="button"
                  onClick={() => setFiltroAccion(f.valor)}
                  aria-pressed={filtroAccion === f.valor}
                  className={`rounded-lg px-2.5 py-1.5 text-xs font-semibold outline-none transition focus-visible:ring-2 focus-visible:ring-siemens/40 ${
                    filtroAccion === f.valor
                      ? 'bg-slate-100 text-navy shadow-sm ring-1 ring-slate-200 dark:bg-navy-slate dark:text-slate-100 dark:ring-navy-slate'
                      : 'text-slate-500 hover:text-navy dark:text-slate-400 dark:hover:text-slate-200'
                  }`}
                >
                  {TAB_CORTO[f.valor] ?? f.etiqueta}
                </button>
              ))}
            </div>

            <div className="relative min-w-[180px] flex-1 sm:max-w-[240px]">
              <SearchIcon className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
              <input
                type="search"
                value={filtroUsuario}
                onChange={(e) => setFiltroUsuario(e.target.value)}
                placeholder="Filtrar por usuario…"
                aria-label="Filtrar los eventos por usuario"
                className="w-full rounded-lg border border-slate-200 bg-white py-1.5 pl-9 pr-3 text-xs text-navy outline-none transition placeholder:text-slate-400 focus:border-siemens focus:ring-2 focus:ring-siemens/20 dark:border-navy-slate dark:bg-navy dark:text-slate-100"
              />
            </div>
          </div>

          {eventos.length === 0 ? (
            <div className="px-4 py-16 text-center">
              <HistoryIcon className="mx-auto mb-3 h-8 w-8 text-slate-300 dark:text-slate-600" />
              <p className="text-sm font-semibold text-slate-500 dark:text-slate-300">
                Sin eventos que coincidan
              </p>
              <p className="mt-1 text-xs text-slate-400">
                Prueba con otra pestaña o vacía el filtro de usuario.
              </p>
            </div>
          ) : (
            <div className="mp-scroll mp-scroll-dark overflow-x-auto">
              <table className="w-full min-w-[720px] text-left text-sm">
                <thead>
                  <tr>
                    <Th className="w-36">Cuándo</Th>
                    <Th className="w-44">Quién</Th>
                    <Th className="w-[300px]">Qué hizo</Th>
                    <Th>Sobre qué</Th>
                  </tr>
                </thead>
                <tbody>
                  {filas.map((f) =>
                    f.tipo === 'dia' ? (
                      <tr key={`dia-${f.dia}`}>
                        <td
                          colSpan={4}
                          className="bg-slate-50 px-4 py-1.5 dark:bg-navy/60"
                        >
                          <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                            {f.dia}
                          </span>
                          <span className="ml-2 text-[10px] tabular-nums text-slate-400 opacity-70">
                            {f.n}
                          </span>
                        </td>
                      </tr>
                    ) : (
                      <FilaEvento
                        key={`${f.ev.ts}-${f.i}`}
                        ev={f.ev}
                        esYo={f.ev.usuario === sesion?.usuario}
                      />
                    )
                  )}
                </tbody>
              </table>
            </div>
          )}

          {/* Pie: de dónde sale esto, y cómo ver más */}
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 bg-slate-50/70 px-4 py-2.5 dark:border-navy-slate dark:bg-navy/40">
            <p className="flex items-center gap-1.5 text-[11px] text-slate-400">
              <FileTextIcon className="h-3.5 w-3.5 shrink-0" />
              Se guarda en{' '}
              <code className="rounded bg-slate-200/70 px-1 font-mono text-[10.5px] text-slate-500 dark:bg-navy-slate/60 dark:text-slate-300">
                datos/auditoria.jsonl
              </code>
              , una línea por evento.
            </p>
            {mostrar < eventos.length && (
              <button
                onClick={() => setMostrar((n) => n + 10)}
                className="rounded-lg border border-slate-200 px-3 py-1.5 text-[11.5px] font-semibold text-slate-600 outline-none transition hover:bg-white focus-visible:ring-2 focus-visible:ring-siemens/40 dark:border-navy-slate dark:text-slate-300 dark:hover:bg-navy-soft"
              >
                Ver {Math.min(10, eventos.length - mostrar)} eventos más
              </button>
            )}
          </div>
        </section>

        {/* ══════════════════ RAÍL DERECHO ══════════════════ */}
        <aside className="w-full shrink-0 space-y-4 xl:w-[330px]">

          {/* ── Trabajando ahora ── */}
          <TarjetaRail
            icono={<UsersIcon className="h-3.5 w-3.5" />}
            titulo="Trabajando ahora"
            contador={
              <span
                className="flex items-center gap-1 text-[11px] tabular-nums text-slate-400"
                title={`${sockets} pestaña(s) abierta(s)`}
              >
                <MonitorIcon className="h-3 w-3" />
                {sockets}
              </span>
            }
          >
            {conectados.length === 0 ? (
              <Vacio texto="Nadie más conectado en este momento." />
            ) : (
              <ul className="divide-y divide-slate-100 dark:divide-navy-slate/60">
                {conectados.map((u) => (
                  <li key={u.usuario} className="flex items-center gap-2.5 px-4 py-2.5">
                    {/* El punto verde es la señal más rápida de "está vivo". */}
                    <span className="h-2 w-2 shrink-0 rounded-full bg-state-ok" />
                    <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-navy dark:text-slate-100">
                      {u.usuario}
                      {u.usuario === sesion?.usuario && (
                        <span className="ml-1.5 text-[11px] font-normal text-slate-400">
                          (tú)
                        </span>
                      )}
                    </span>
                    <span className="shrink-0 text-[11px] text-slate-400">
                      {u.categoria}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <Nota>
              Una persona con dos pestañas abiertas cuenta una sola vez; por eso
              puede haber más pantallas que personas.
            </Nota>
          </TarjetaRail>

          {/* ── Control de edición ── */}
          <TarjetaRail
            icono={<LockIcon className="h-3.5 w-3.5" />}
            titulo="Control de edición"
            contador={
              <span className="text-[11px] tabular-nums text-slate-400">
                {bloqueos.length}
              </span>
            }
          >
            {bloqueos.length === 0 ? (
              <Vacio texto="Nadie está editando ninguna pantalla." icono={<LockIcon className="h-3.5 w-3.5" />} />
            ) : (
              <ul className="divide-y divide-slate-100 dark:divide-navy-slate/60">
                {bloqueos.map((b) => (
                  <li key={b.recurso} className="flex items-center gap-2.5 px-4 py-2.5">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[13px] font-semibold text-navy dark:text-slate-100">
                        {b.usuario}
                      </p>
                      <p className="truncate font-mono text-[10.5px] text-slate-400">
                        {b.recurso} · {Math.round(b.segundos_restantes)} s
                      </p>
                    </div>
                    {/* Quitarle el lápiz a otro es acción de Supervisor y
                        queda registrada en la auditoría. */}
                    {esSupervisor && b.usuario !== sesion?.usuario && (
                      <button
                        onClick={() => void quitarLapiz(b.recurso)}
                        title="Quitarle el control (queda registrado)"
                        className="flex shrink-0 items-center gap-1 rounded-lg bg-state-warn/15 px-2 py-1 text-[11px] font-semibold text-state-warn outline-none transition hover:bg-state-warn/25 focus-visible:ring-2 focus-visible:ring-state-warn/40"
                      >
                        <UnlockIcon className="h-3 w-3" />
                        Tomar
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
            <Nota>
              El control se suelta solo a los{' '}
              <b className="font-semibold text-slate-500 dark:text-slate-300">30 s</b>{' '}
              sin actividad, así que un navegador cerrado no deja la pantalla
              bloqueada.
            </Nota>
          </TarjetaRail>

          {/* ── Cuentas ── */}
          <TarjetaRail
            icono={<ShieldCheckIcon className="h-3.5 w-3.5" />}
            titulo="Cuentas"
            contador={
              <span className="text-[11px] tabular-nums text-slate-400">
                {cuentas.length}
              </span>
            }
          >
            {cuentas.length === 0 ? (
              <Vacio texto="Sin permiso para ver las cuentas, o no hay ninguna." />
            ) : (
              <ul className="divide-y divide-slate-100 dark:divide-navy-slate/60">
                {cuentas.map((u) => {
                  const activo = u.estado === 'Activo';
                  const enLinea = conectados.some((c) => c.usuario === u.usuario);
                  return (
                    <li key={u.id} className="flex items-center gap-2.5 px-4 py-2.5">
                      <span
                        className={`h-2 w-2 shrink-0 rounded-full ${
                          enLinea
                            ? 'bg-state-ok'
                            : 'bg-slate-300 dark:bg-navy-slate'
                        }`}
                      />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[13px] font-semibold text-navy dark:text-slate-100">
                          {u.usuario}
                          <span className="ml-1.5 text-[11px] font-normal text-slate-400">
                            {u.categoria}
                          </span>
                        </p>
                        <p
                          className="truncate text-[10.5px] text-slate-400"
                          title={fechaLocal(u.ultimo_acceso)}
                        >
                          {u.ultimo_acceso
                            ? `Último acceso ${haceCuanto(u.ultimo_acceso)}`
                            : 'Nunca ha entrado'}
                        </p>
                      </div>
                      {!activo && (
                        <span className="shrink-0 rounded bg-slate-200 px-1.5 py-0.5 text-[9.5px] font-bold text-slate-500 dark:bg-navy-slate dark:text-slate-400">
                          INACTIVO
                        </span>
                      )}
                      {esSupervisor && u.usuario !== sesion?.usuario && (
                        <button
                          onClick={() => void alternarCuenta(u)}
                          title={
                            activo
                              ? 'Desactivar: cierra sus sesiones al instante'
                              : 'Reactivar la cuenta'
                          }
                          className={`flex shrink-0 items-center gap-1 rounded-lg px-2 py-1 text-[10.5px] font-semibold outline-none transition focus-visible:ring-2 ${
                            activo
                              ? 'bg-state-error/10 text-state-error hover:bg-state-error/20 focus-visible:ring-state-error/40'
                              : 'bg-state-ok/10 text-state-ok hover:bg-state-ok/20 focus-visible:ring-state-ok/40'
                          }`}
                        >
                          {activo ? (
                            <><UserXIcon className="h-3 w-3" />Desactivar</>
                          ) : (
                            <><UserCheckIcon className="h-3 w-3" />Activar</>
                          )}
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}

          </TarjetaRail>
        </aside>
      </div>
    </Marco>
  );
}

// ====================================================================== //
// Piezas de presentación
// ====================================================================== //

/** Una fila del histórico. */
function FilaEvento({ ev, esYo }: { ev: EventoAuditoria; esYo: boolean }) {
  const { Icono, clase } = pintaDe(ev.accion);
  const anon = esAnonimo(ev.usuario);

  return (
    <tr className="border-t border-slate-100 transition-colors hover:bg-slate-50/70 dark:border-navy-slate/50 dark:hover:bg-navy/40">
      {/* Cuándo: relativo arriba (se lee más rápido) y hora exacta debajo */}
      <td className="whitespace-nowrap px-4 py-2.5 align-top" title={fechaLocal(ev.ts)}>
        <p className="text-[12px] font-semibold text-navy dark:text-slate-200">
          {haceCuanto(ev.ts)}
        </p>
        <p className="font-mono text-[10.5px] tabular-nums text-slate-400">
          {horaDe(ev.ts)}
        </p>
      </td>

      {/* Quién */}
      <td className="px-4 py-2.5 align-top">
        <span className="flex items-center gap-2">
          <span
            className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-bold ${
              anon
                ? 'bg-slate-100 text-slate-400 dark:bg-navy-slate/60'
                : 'bg-siemens/15 text-siemens dark:text-siemens-200'
            }`}
          >
            {inicial(ev.usuario)}
          </span>
          <span
            className={`min-w-0 truncate text-[12.5px] ${
              anon
                ? 'text-slate-400'
                : 'font-semibold text-navy dark:text-slate-100'
            }`}
          >
            {ev.usuario}
            {esYo && (
              <span className="ml-1 text-[10.5px] font-normal text-slate-400">
                (tú)
              </span>
            )}
          </span>
        </span>
      </td>

      {/* Qué hizo */}
      <td className="px-4 py-2.5 align-top">
        <span className="flex items-center gap-2">
          <span
            className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-md ring-1 ${clase}`}
          >
            <Icono className="h-3 w-3" />
          </span>
          <span className="min-w-0 text-[12.5px] text-navy dark:text-slate-200">
            {etiquetaAccion(ev.accion)}
          </span>
        </span>
      </td>

      {/* Sobre qué */}
      <td className="px-4 py-2.5 align-top">
        <span className="flex flex-wrap items-center gap-1.5">
          {ev.recurso && (
            <code className="font-mono text-[11.5px] text-slate-500 dark:text-slate-400">
              {ev.recurso}
            </code>
          )}
          {ev.detalle &&
            Object.entries(ev.detalle).map(([k, v]) => (
              <span
                key={k}
                className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[10px] text-slate-500 dark:bg-navy-slate/50 dark:text-slate-400"
              >
                {k}: {String(v)}
              </span>
            ))}
        </span>
      </td>
    </tr>
  );
}

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

/** Tarjeta del raíl derecho. */
function TarjetaRail({
  icono,
  titulo,
  contador,
  children,
}: {
  icono: React.ReactNode;
  titulo: string;
  contador?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-card dark:border-navy-slate dark:bg-navy-soft">
      <div className="flex items-center gap-2 border-b border-slate-200 px-4 py-2.5 dark:border-navy-slate">
        <span className="text-siemens">{icono}</span>
        <h2 className="min-w-0 flex-1 truncate text-[11px] font-bold uppercase tracking-wider text-navy dark:text-slate-100">
          {titulo}
        </h2>
        {contador}
      </div>
      {children}
    </section>
  );
}

function Vacio({ texto, icono }: { texto: string; icono?: React.ReactNode }) {
  return (
    <p className="flex items-center gap-2 px-4 py-4 text-[12px] text-slate-400">
      {icono && <span className="shrink-0">{icono}</span>}
      <span className="min-w-0">{texto}</span>
    </p>
  );
}

function Nota({ children }: { children: React.ReactNode }) {
  return (
    <p className="border-t border-slate-100 bg-slate-50/70 px-4 py-2.5 text-[11px] leading-relaxed text-slate-400 dark:border-navy-slate/60 dark:bg-navy/40">
      {children}
    </p>
  );
}

/** Marco de la página: cabecera con volver y actualizar. */
function Marco({
  children,
  onVolver,
  onRefrescar,
  cargando,
}: {
  children: React.ReactNode;
  onVolver: () => void;
  onRefrescar?: () => void;
  cargando?: boolean;
}) {
  return (
    <div className="flex h-full w-full flex-col bg-slate-50 dark:bg-navy">
      <header className="flex shrink-0 items-center justify-between gap-4 border-b border-slate-200 bg-white px-5 py-3 dark:border-navy-slate dark:bg-navy-soft">
        <div className="flex min-w-0 items-center gap-3">
          <button
            onClick={onVolver}
            aria-label="Volver al menú"
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-slate-500 outline-none transition hover:bg-slate-100 hover:text-navy focus-visible:ring-2 focus-visible:ring-siemens/40 dark:hover:bg-navy-slate/40 dark:hover:text-slate-100"
          >
            <ArrowLeftIcon className="h-5 w-5" />
          </button>
          <div className="min-w-0">
            <p className="truncate text-[15px] font-bold text-navy dark:text-slate-100">
              Actividad
            </p>
            <p className="truncate text-[11.5px] text-slate-400">
              Quién está trabajando y qué se ha hecho
            </p>
          </div>
        </div>
        {onRefrescar && (
          <button
            onClick={onRefrescar}
            disabled={cargando}
            className="flex min-h-[34px] shrink-0 items-center gap-1.5 rounded-lg border border-slate-200 px-3 text-xs font-semibold text-slate-600 outline-none transition hover:bg-slate-100 focus-visible:ring-2 focus-visible:ring-siemens/40 disabled:opacity-50 dark:border-navy-slate dark:text-slate-300 dark:hover:bg-navy-slate/40"
          >
            <RefreshCwIcon className={`h-3.5 w-3.5 ${cargando ? 'animate-spin' : ''}`} />
            Actualizar
          </button>
        )}
      </header>

      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        className="mp-scroll mp-scroll-dark flex-1 overflow-y-auto p-5"
      >
        {children}
      </motion.div>
    </div>
  );
}
