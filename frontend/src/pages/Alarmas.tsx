// =========================================================================
// Alarmas.tsx  (ruta /alarmas)
// Lo que está pasando en la planta, no lo que está configurado.
//
//   PENDIENTES  lo que hay que atender. Es la pestaña de trabajo.
//   HISTÓRICO   qué pasó, con filtros. Para revisar un turno o investigar.
//
// PENDIENTE NO ES "SIGUE ACTIVA"
//
//   Es SIN RECONOCER. Una alarma que saltó de madrugada y se normalizó sola
//   sigue aquí por la mañana, marcada como «Se fue sola». Si desapareciera al
//   normalizarse, quien entra al turno no sabría que hubo un problema — y esa
//   es exactamente la información que se necesita.
//
//   Por eso la columna de situación tiene TRES valores y no dos, y el de en
//   medio es el que suele faltar en estas pantallas.
//
// POR QUÉ NO HAY POLLING
//
//   Los eventos llegan por el WebSocket que ya tiene abierto el
//   RealPLCService. Con cinco PCs abiertos, preguntar cada dos segundos
//   serían 150 consultas por minuto contra la base para recibir lo mismo casi
//   siempre. El botón de refrescar queda para cuando alguien quiere estar
//   seguro.
// =========================================================================
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import {
  ArrowLeftIcon,
  RefreshCwIcon,
  BellIcon,
  BellOffIcon,
  CheckIcon,
  CheckCheckIcon,
  HistoryIcon,
  AlertCircleIcon,
  ActivityIcon,
  Loader2Icon,
  TagIcon,
  InfoIcon,
} from 'lucide-react';
import {
  CLASE_DE_SEVERIDAD,
  alRecibirAlarma,
  fechaHora,
  fetchEstadoMotor,
  fetchHistorico,
  fetchPendientes,
  haceCuanto,
  partesTag,
  reconocer,
  reconocerTodas,
  situacion,
  tonoSeveridad,
  type EstadoMotor,
  type EventoAlarma,
} from '../services/alarmasRuntimeApi';

type Pestana = 'pendientes' | 'historico';

// ===================================================================== //
// Piezas
// ===================================================================== //
function Severidad({ n }: { n: number }) {
  const t = tonoSeveridad(n);
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-[11px] font-semibold ${t.fondo} ${t.borde} ${n <= 1 ? t.texto : t.texto}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${t.punto}`} />
      {CLASE_DE_SEVERIDAD[n] ?? `Sev. ${n}`}
    </span>
  );
}

function Situacion({ a }: { a: EventoAlarma }) {
  const s = situacion(a);
  const clase =
    s.clave === 'activa'
      ? 'bg-state-error/10 text-state-error ring-state-error/25'
      : s.clave === 'sin_ver'
        ? 'bg-state-warn/10 text-state-warn ring-state-warn/25'
        : 'bg-slate-100 text-slate-400 ring-slate-200 dark:bg-navy-slate/40 dark:ring-navy-slate';
  return (
    <span
      title={s.ayuda}
      className={`inline-flex cursor-help items-center rounded-md px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset ${clase}`}
    >
      {s.etiqueta}
    </span>
  );
}

function Tag({ tag }: { tag: string | null }) {
  const { plc, tag: t } = partesTag(tag);
  if (!t) {
    return (
      <span
        className="text-[11px] italic text-slate-400"
        title="Este evento no vino de una regla con tag: lo generó el sistema."
      >
        sin tag
      </span>
    );
  }
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <TagIcon className="h-3 w-3 shrink-0 text-slate-400" />
      <span className="min-w-0">
        <span className="block truncate font-mono text-[11px] text-navy dark:text-slate-200">
          {t}
        </span>
        {plc && (
          <span className="block truncate text-[10px] text-slate-400">{plc}</span>
        )}
      </span>
    </span>
  );
}

/** Un dato del panel de diagnóstico. */
function Dato({
  etiqueta, valor, ayuda, alerta = false,
}: {
  etiqueta: string;
  valor: string | number;
  ayuda?: string;
  alerta?: boolean;
}) {
  return (
    <div title={ayuda} className={ayuda ? 'cursor-help' : ''}>
      <p className="text-[10.5px] uppercase tracking-wide text-slate-400">
        {etiqueta}
      </p>
      <p
        className={`font-mono text-sm font-semibold tabular-nums ${
          alerta ? 'text-state-warn' : 'text-navy dark:text-slate-100'
        }`}
      >
        {valor}
      </p>
    </div>
  );
}

// ===================================================================== //
// Pantalla
// ===================================================================== //
export function Alarmas() {
  const navigate = useNavigate();
  const [pestana, setPestana] = useState<Pestana>('pendientes');

  const [pendientes, setPendientes] = useState<EventoAlarma[]>([]);
  const [historico, setHistorico] = useState<EventoAlarma[]>([]);
  const [totalHist, setTotalHist] = useState(0);
  const [motor, setMotor] = useState<EstadoMotor | null>(null);

  const [cargando, setCargando] = useState(true);
  const [ocupado, setOcupado] = useState<number | 'todas' | null>(null);
  const [error, setError] = useState('');

  const [fSeveridad, setFSeveridad] = useState<number | ''>('');
  const [fEstado, setFEstado] = useState('');

  // ── Carga ─────────────────────────────────────────────────────
  const cargar = useCallback(async () => {
    setCargando(true);
    try {
      const [p, e] = await Promise.all([
        fetchPendientes(200),
        // El estado del motor se pide junto: es donde se ve si hay reglas
        // sin tag, que es el motivo número uno de "configuré la alarma y no
        // salta". Un fallo aquí no debe tumbar la lista.
        fetchEstadoMotor().catch(() => null),
      ]);
      setPendientes(p.alarmas);
      setMotor(e);
      setError('');
    } catch (ex: any) {
      setError(ex?.message ?? 'No se pudo leer el estado de las alarmas.');
    } finally {
      setCargando(false);
    }
  }, []);

  const cargarHistorico = useCallback(async () => {
    try {
      const r = await fetchHistorico({
        severidad: fSeveridad === '' ? undefined : Number(fSeveridad),
        estado: fEstado || undefined,
        limite: 200,
      });
      setHistorico(r.filas);
      setTotalHist(r.total);
    } catch (ex: any) {
      setError(ex?.message ?? 'No se pudo leer el histórico.');
    }
  }, [fSeveridad, fEstado]);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  useEffect(() => {
    if (pestana === 'historico') void cargarHistorico();
  }, [pestana, cargarHistorico]);

  // En vivo: el motor difunde cada activación, normalización y
  // reconocimiento. Se recarga en vez de tocar la lista a mano — las reglas
  // de qué sigue pendiente y en qué orden viven en el backend, y duplicarlas
  // aquí es garantizar que un día digan cosas distintas.
  useEffect(() => {
    return alRecibirAlarma(() => {
      void cargar();
      if (pestana === 'historico') void cargarHistorico();
    });
  }, [cargar, cargarHistorico, pestana]);

  // ── Acciones ──────────────────────────────────────────────────
  const alReconocer = async (id: number) => {
    setOcupado(id);
    try {
      await reconocer(id);
      await cargar();
      setError('');
    } catch (ex: any) {
      setError(
        ex?.status === 403
          ? 'Reconocer una alarma queda firmado con tu nombre, así que hace ' +
            'falta haber iniciado sesión con categoría Usuarios o superior.'
          : ex?.message ?? 'No se pudo reconocer la alarma.'
      );
    } finally {
      setOcupado(null);
    }
  };

  const alReconocerTodas = async () => {
    setOcupado('todas');
    try {
      await reconocerTodas();
      await cargar();
      setError('');
    } catch (ex: any) {
      setError(ex?.message ?? 'No se pudieron reconocer las alarmas.');
    } finally {
      setOcupado(null);
    }
  };

  // ── Derivados ─────────────────────────────────────────────────
  const filas = pestana === 'pendientes' ? pendientes : historico;

  const criticas = useMemo(
    () => pendientes.filter((a) => a.severidad <= 2).length,
    [pendientes]
  );

  const campo =
    'rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs outline-none transition focus:border-siemens focus:ring-2 focus:ring-siemens/20 dark:border-navy-slate dark:bg-navy-soft dark:text-slate-100';

  return (
    <div className="flex h-full w-full flex-col bg-slate-50 dark:bg-navy">
      {/* ───────────────────────────────────────────── cabecera ── */}
      <header className="flex shrink-0 items-center justify-between gap-4 border-b border-slate-200 bg-white px-5 py-3 dark:border-navy-slate dark:bg-navy-soft">
        <div className="flex min-w-0 items-center gap-3">
          <button
            onClick={() => navigate('/menu')}
            aria-label="Volver al menú"
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-slate-500 outline-none transition hover:bg-slate-100 hover:text-navy focus-visible:ring-2 focus-visible:ring-siemens/40 dark:hover:bg-navy-slate/40 dark:hover:text-slate-100"
          >
            <ArrowLeftIcon className="h-5 w-5" />
          </button>
          <div className="min-w-0">
            <p className="truncate text-[15px] font-bold text-navy dark:text-slate-100">
              Alarmas
            </p>
            <p className="truncate text-[11.5px] text-slate-400">
              Lo que está pasando en la planta
            </p>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <button
            onClick={() => {
              void cargar();
              if (pestana === 'historico') void cargarHistorico();
            }}
            disabled={cargando}
            className="flex min-h-[34px] items-center gap-1.5 rounded-lg border border-slate-200 px-3 text-xs font-semibold text-slate-600 outline-none transition hover:bg-slate-100 focus-visible:ring-2 focus-visible:ring-siemens/40 disabled:opacity-50 dark:border-navy-slate dark:text-slate-300 dark:hover:bg-navy-slate/40"
          >
            <RefreshCwIcon className={`h-3.5 w-3.5 ${cargando ? 'animate-spin' : ''}`} />
            Actualizar
          </button>
          {pendientes.length > 0 && (
            <button
              onClick={() => void alReconocerTodas()}
              disabled={ocupado !== null}
              title="Reconocer todo lo pendiente. Cada fila queda firmada con tu nombre igual que si las reconocieras una a una."
              className="flex min-h-[34px] items-center gap-1.5 rounded-lg bg-siemens px-3.5 text-xs font-semibold text-white outline-none transition hover:bg-siemens-600 focus-visible:ring-2 focus-visible:ring-siemens/40 disabled:opacity-50"
            >
              {ocupado === 'todas' ? (
                <Loader2Icon className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <CheckCheckIcon className="h-3.5 w-3.5" />
              )}
              Reconocer todas ({pendientes.length})
            </button>
          )}
        </div>
      </header>

      {/* ───────────────────────────────────────── pestañas ────── */}
      <div className="flex shrink-0 items-center gap-1 border-b border-slate-200 bg-white px-5 dark:border-navy-slate dark:bg-navy-soft">
        {([
          ['pendientes', 'Pendientes', BellIcon, pendientes.length],
          ['historico', 'Histórico', HistoryIcon, totalHist],
        ] as const).map(([id, txt, Icono, n]) => (
          <button
            key={id}
            onClick={() => setPestana(id)}
            className={`flex items-center gap-1.5 border-b-2 px-3 py-2.5 text-xs font-semibold transition ${
              pestana === id
                ? 'border-siemens text-siemens'
                : 'border-transparent text-slate-400 hover:text-navy dark:hover:text-slate-200'
            }`}
          >
            <Icono className="h-3.5 w-3.5" />
            {txt}
            {n > 0 && (
              <span
                className={`rounded px-1.5 py-px text-[10px] tabular-nums ${
                  id === 'pendientes' && criticas > 0
                    ? 'bg-state-error/15 text-state-error'
                    : 'bg-slate-100 text-slate-500 dark:bg-navy-slate/50 dark:text-slate-300'
                }`}
              >
                {n}
              </span>
            )}
          </button>
        ))}
      </div>

      <div className="mp-scroll mp-scroll-dark flex-1 overflow-y-auto p-5">
        {error && (
          <div className="mb-4 flex items-start gap-2.5 rounded-lg border border-state-error/30 bg-state-error/5 px-3.5 py-2.5 text-xs text-state-error">
            <AlertCircleIcon className="mt-px h-4 w-4 shrink-0" />
            <p className="leading-relaxed">{error}</p>
          </div>
        )}

        {/* Diagnóstico del motor. `reglas_sin_tag` es el número que explica
            el 90 % de los "configuré la alarma y no salta": la regla existe,
            tiene nombre y texto, y no vigila nada. */}
        {motor && (
          <div className="mb-4 rounded-xl border border-slate-200 bg-white px-4 py-3 dark:border-navy-slate dark:bg-navy-soft">
            <div className="mb-2.5 flex items-center gap-2">
              <ActivityIcon className="h-3.5 w-3.5 text-siemens" />
              <p className="text-[11.5px] font-semibold text-navy dark:text-slate-100">
                Motor de alarmas
              </p>
            </div>
            <div className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3 lg:grid-cols-6">
              <Dato etiqueta="Reglas activas" valor={motor.reglas_activas}
                ayuda="Cuántas definiciones está vigilando ahora mismo." />
              <Dato etiqueta="Sin tag" valor={motor.reglas_sin_tag}
                alerta={motor.reglas_sin_tag > 0}
                ayuda="Configuradas pero sin Trigger tag: no se evalúan nunca. Desde el editor se ven igual que las que sí funcionan." />
              <Dato etiqueta="Tags vigilados" valor={motor.tags_vigilados}
                ayuda="Variables distintas del PLC que el motor está mirando." />
              <Dato etiqueta="Disparadas" valor={motor.disparadas_ahora}
                ayuda="Reglas cuya condición se cumple en este instante." />
              <Dato etiqueta="Valores evaluados" valor={motor.valores_evaluados}
                ayuda="Cuántos valores del PLC ha comparado desde que arrancó. Si es 0, no está llegando nada: mira la conexión del PLC." />
              <Dato etiqueta="Eventos escritos" valor={motor.eventos_abiertos}
                ayuda="Alarmas registradas en la tabla desde el arranque." />
            </div>
            {motor.ultimo_error && (
              <p className="mt-2.5 flex items-start gap-1.5 border-t border-slate-100 pt-2.5 text-[11px] leading-relaxed text-state-error dark:border-navy-slate">
                <AlertCircleIcon className="mt-px h-3 w-3 shrink-0" />
                {motor.ultimo_error}
              </p>
            )}
          </div>
        )}

        {/* Filtros — solo en el histórico. En pendientes no hay nada que
            filtrar: si hay algo pendiente, hay que verlo. */}
        {pestana === 'historico' && (
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <select value={fSeveridad}
              onChange={(e) => setFSeveridad(e.target.value === '' ? '' : Number(e.target.value))}
              className={campo}>
              <option value="">Todas las clases</option>
              {[1, 2, 3, 4, 5].map((n) => (
                <option key={n} value={n}>{CLASE_DE_SEVERIDAD[n]}</option>
              ))}
            </select>
            <select value={fEstado} onChange={(e) => setFEstado(e.target.value)}
              className={campo}>
              <option value="">Todos los estados</option>
              <option value="activa">Activa</option>
              <option value="reconocida">Reconocida</option>
              <option value="normalizada">Normalizada</option>
            </select>
            {(fSeveridad !== '' || fEstado) && (
              <button
                onClick={() => { setFSeveridad(''); setFEstado(''); }}
                className="rounded-lg px-2.5 py-1.5 text-xs font-semibold text-slate-500 transition hover:bg-slate-100 dark:hover:bg-navy-slate/40"
              >
                Quitar filtros
              </button>
            )}
          </div>
        )}

        {/* ─────────────────────────────────────────── la lista ── */}
        <motion.div
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          className="overflow-hidden rounded-xl border border-slate-200 bg-white dark:border-navy-slate dark:bg-navy-soft"
        >
          <div className="overflow-x-auto">
            <table className="w-full min-w-[880px] text-xs">
              <thead className="border-b border-slate-200 bg-slate-50 text-[11px] uppercase tracking-wide text-slate-400 dark:border-navy-slate dark:bg-navy/40">
                <tr>
                  <th className="w-[140px] px-3 py-2 text-left font-semibold">Clase</th>
                  <th className="px-3 py-2 text-left font-semibold">Mensaje</th>
                  <th className="w-[190px] px-3 py-2 text-left font-semibold">Tag y valor</th>
                  <th className="w-[130px] px-3 py-2 text-left font-semibold">Situación</th>
                  <th className="w-[150px] px-3 py-2 text-left font-semibold">Cuándo</th>
                  <th className="w-[120px] px-3 py-2 text-right font-semibold">
                    {pestana === 'pendientes' ? 'Acción' : 'Reconocida'}
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-navy-slate/60">
                {cargando && filas.length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-3 py-10 text-center text-slate-400">
                      <Loader2Icon className="mx-auto mb-2 h-5 w-5 animate-spin" />
                      Leyendo las alarmas…
                    </td>
                  </tr>
                )}

                {!cargando && filas.length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-3 py-14 text-center">
                      <BellOffIcon className="mx-auto mb-3 h-9 w-9 text-slate-300 dark:text-slate-600" />
                      <p className="text-sm font-semibold text-slate-500 dark:text-slate-300">
                        {pestana === 'pendientes'
                          ? 'Nada pendiente'
                          : 'No hay eventos con esos filtros'}
                      </p>
                      <p className="mx-auto mt-1 max-w-sm text-[11.5px] leading-relaxed text-slate-400">
                        {pestana === 'pendientes'
                          ? 'Todas las alarmas están reconocidas. Cuando salte ' +
                            'una, aparecerá aquí y en la franja de arriba sin ' +
                            'que haya que recargar.'
                          : 'Prueba a quitar algún filtro.'}
                      </p>
                    </td>
                  </tr>
                )}

                {filas.map((a) => (
                  <tr key={a.id}
                    className="transition hover:bg-slate-50/70 dark:hover:bg-navy/40">
                    <td className="px-3 py-2.5">
                      <Severidad n={a.severidad} />
                    </td>
                    <td className="px-3 py-2.5">
                      <p className="font-medium text-navy dark:text-slate-100">
                        {a.mensaje}
                      </p>
                      {a.area && (
                        <p className="text-[10.5px] text-slate-400">{a.area}</p>
                      )}
                    </td>
                    <td className="px-3 py-2.5">
                      <Tag tag={a.tag} />
                      {a.valor_disparo !== null && (
                        <p className="mt-0.5 font-mono text-[10.5px] tabular-nums text-slate-400">
                          disparó con {a.valor_disparo}
                        </p>
                      )}
                    </td>
                    <td className="px-3 py-2.5">
                      <Situacion a={a} />
                    </td>
                    <td className="px-3 py-2.5">
                      <p className="text-slate-600 dark:text-slate-300">
                        {haceCuanto(a.ts_activacion)}
                      </p>
                      <p className="text-[10.5px] text-slate-400">
                        {fechaHora(a.ts_activacion)}
                      </p>
                    </td>
                    <td className="px-3 py-2.5 text-right">
                      {a.ts_reconocimiento ? (
                        <span
                          className="inline-flex items-center gap-1 text-[11px] text-slate-400"
                          title={`Reconocida el ${fechaHora(a.ts_reconocimiento)}`}
                        >
                          <CheckIcon className="h-3 w-3 text-state-ok" />
                          {haceCuanto(a.ts_reconocimiento)}
                        </span>
                      ) : (
                        <button
                          onClick={() => void alReconocer(a.id)}
                          disabled={ocupado !== null}
                          title="Dejar constancia de que la has visto. Queda firmado con tu nombre."
                          className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-2.5 py-1 text-[11px] font-semibold text-slate-600 transition hover:border-siemens hover:bg-siemens/5 hover:text-siemens disabled:opacity-40 dark:border-navy-slate dark:text-slate-300"
                        >
                          {ocupado === a.id ? (
                            <Loader2Icon className="h-3 w-3 animate-spin" />
                          ) : (
                            <CheckIcon className="h-3 w-3" />
                          )}
                          Reconocer
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </motion.div>

        {/* La explicación de por qué una alarma que ya pasó sigue en la
            lista. Va escrita porque es lo primero que se pregunta quien ve
            «Se fue sola» y no es evidente sin conocer el modelo. */}
        {pestana === 'pendientes' && pendientes.some((a) => a.ts_normalizacion) && (
          <div className="mt-3 flex items-start gap-2 rounded-lg border border-slate-200 bg-white px-3.5 py-2.5 text-[11px] leading-relaxed text-slate-500 dark:border-navy-slate dark:bg-navy-soft dark:text-slate-400">
            <InfoIcon className="mt-px h-3.5 w-3.5 shrink-0 text-slate-400" />
            <p>
              Las marcadas <strong>«Se fue sola»</strong> ya se normalizaron
              solas, pero siguen aquí porque nadie las ha reconocido. Es a
              propósito: si desaparecieran, el turno siguiente no sabría que
              hubo un problema.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
