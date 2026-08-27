// =========================================================================
// PanelBasesDatos.tsx — alta, prueba y baja de conexiones a base de datos
//
// Cierra el ciclo de vida completo de una conexión desde la interfaz. Los
// cuatro endpoints que usa YA EXISTÍAN en el backend y no los llamaba nadie:
// estaban en la lista de "17 endpoints sin consumir" de docs/ANALISIS_PROYECTO.md.
//
//   GET    /db              listar, con el estado del pool en vivo
//   POST   /db              dar de alta (VERIFICA antes de guardar)
//   POST   /db/{id}/test    SELECT 1 + latencia; reabre el pool si se cayó
//   DELETE /db/{id}         borrar la conexión y sus consultas
//
// Por qué importa tenerlo aquí y no solo en el asistente del login: el
// asistente solo aparece cuando NO hay ninguna base y se cierra para siempre
// en cuanto existe la primera cuenta. La segunda base —la de la nube, la de
// pruebas— se da de alta aquí.
//
// DOS DECISIONES QUE SE NOTAN AL USARLO
//
//   * "Probar" no es cosmético. Reabre el pool, así que sirve de reconectar
//     para una base que estaba apagada cuando arrancó el servicio. Sin este
//     botón, la única forma de recuperarla era reiniciar el backend.
//
//   * Borrar pide confirmación en dos pasos, en el sitio, sin diálogo del
//     navegador. `DELETE /db/{id}` se lleva por delante TODAS las consultas
//     guardadas de esa conexión, y eso no se puede deshacer.
// =========================================================================
import { Fragment, useCallback, useEffect, useState, type ReactNode } from 'react';
import {
  AlertCircleIcon,
  CheckCircle2Icon,
  DatabaseIcon,
  Loader2Icon,
  PlugZapIcon,
  PlusIcon,
  RefreshCwIcon,
  Trash2Icon,
  XIcon,
} from 'lucide-react';
import { ConnectionForm } from '../flows/bd/ConnectionForm';
import {
  borrarConexion,
  cargarConexiones,
  guardarConexion,
  probarConexion,
  type ConexionRemota,
  type Diagnostico,
} from '../flows/api';
import { PanelDiagnostico } from './PanelDiagnostico';
import { CrearBaseDatos } from './CrearBaseDatos';

const NUEVA: Record<string, any> = {
  db_id: '',
  motor: 'mssql',
  nombre: '',
  host: 'localhost',
  puerto: 1433,
  base_datos: '',
  usuario: '',
  password: '',
  opciones: {
    driver: 'ODBC Driver 18 for SQL Server',
    TrustServerCertificate: 'yes',
  },
  autoconectar: true,
};

export function PanelBasesDatos() {
  const [conexiones, setConexiones] = useState<ConexionRemota[]>([]);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState('');

  const [form, setForm] = useState<Record<string, any> | null>(null);
  const [guardando, setGuardando] = useState(false);
  const [errorForm, setErrorForm] = useState('');
  const [diagForm, setDiagForm] = useState<Diagnostico | undefined>();

  // Estado por fila: qué se está probando y qué se está confirmando borrar.
  const [probando, setProbando] = useState('');
  const [resultado, setResultado] = useState<Record<string, string>>({});
  const [diagFila, setDiagFila] = useState<Record<string, Diagnostico | undefined>>({});
  const [confirmar, setConfirmar] = useState('');

  const recargar = useCallback(async () => {
    setCargando(true);
    try {
      setConexiones(await cargarConexiones());
      setError('');
    } catch (e: any) {
      setError(e?.message ?? 'No se pudieron cargar las conexiones.');
    } finally {
      setCargando(false);
    }
  }, []);

  useEffect(() => {
    void recargar();
  }, [recargar]);

  const guardar = async () => {
    if (!form) return;
    if (!String(form.db_id || '').trim()) {
      setErrorForm('Ponle un identificador a la conexión.');
      return;
    }
    setGuardando(true);
    setErrorForm('');
    setDiagForm(undefined);
    try {
      await guardarConexion(form);
      setForm(null);
      await recargar();
    } catch (e: any) {
      setErrorForm(e?.message ?? 'No se pudo guardar.');
      setDiagForm(e?.diagnostico);
    } finally {
      setGuardando(false);
    }
  };

  const probar = async (dbId: string) => {
    setProbando(dbId);
    try {
      const r = await probarConexion(dbId);
      const ms = typeof r?.latencia_ms === 'number' ? ` (${r.latencia_ms} ms)` : '';
      setResultado((x) => ({ ...x, [dbId]: `OK${ms}` }));
      setDiagFila((x) => ({ ...x, [dbId]: undefined }));
    } catch (e: any) {
      setResultado((x) => ({ ...x, [dbId]: e?.message ?? 'Falló' }));
      setDiagFila((x) => ({ ...x, [dbId]: e?.diagnostico }));
    } finally {
      setProbando('');
      await recargar();
    }
  };

  const borrar = async (dbId: string) => {
    setConfirmar('');
    try {
      await borrarConexion(dbId);
      await recargar();
    } catch (e: any) {
      setError(e?.message ?? 'No se pudo borrar.');
    }
  };

  const hayForm = !!form;

  return (
    <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-card dark:border-navy-slate dark:bg-navy-soft">

      {/* ── Barra de la tarjeta ────────────────────────────────── */}
      {/* La frase explicativa se mudó al encabezado de la sección: tenerla
          también aquí eran dos textos peleándose por ser el subtítulo. */}
      <div className="flex items-center justify-between gap-3 border-b border-slate-200 bg-slate-50 px-4 py-2.5 dark:border-navy-slate dark:bg-navy">
        <p className="text-[11px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
          Conexiones
          <span className="ml-2 font-mono text-[11px] font-normal normal-case tracking-normal text-slate-400">
            {conexiones.length}
          </span>
        </p>
        <div className="flex shrink-0 items-center gap-1.5">
          <button
            onClick={() => void recargar()}
            title="Actualizar"
            aria-label="Actualizar la lista"
            className="flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 outline-none transition hover:bg-slate-200/60 hover:text-slate-600 focus-visible:ring-2 focus-visible:ring-siemens/40 dark:hover:bg-navy-slate/40"
          >
            <RefreshCwIcon className={`h-4 w-4 ${cargando ? 'animate-spin' : ''}`} />
          </button>
          <button
            onClick={() => {
              setForm(hayForm ? null : { ...NUEVA });
              setErrorForm('');
            }}
            className={`flex min-h-[32px] items-center gap-1.5 rounded-lg px-3 text-xs font-semibold outline-none transition focus-visible:ring-2 focus-visible:ring-siemens/50 ${
              hayForm
                ? 'bg-slate-200 text-slate-600 hover:bg-slate-300 dark:bg-navy-slate dark:text-slate-300'
                : 'bg-siemens text-white hover:bg-siemens-600'
            }`}
          >
            {hayForm ? <XIcon className="h-3.5 w-3.5" /> : <PlusIcon className="h-3.5 w-3.5" />}
            {hayForm ? 'Cancelar' : 'Añadir'}
          </button>
        </div>
      </div>

      {error && (
        <p className="flex items-start gap-2 border-b border-state-error/20 bg-state-error/5 px-4 py-2.5 text-xs text-state-error">
          <AlertCircleIcon className="mt-px h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0">{error}</span>
        </p>
      )}

      {/* ── Alta ───────────────────────────────────────────────── */}
      {form && (
        <div className="border-b border-slate-200 bg-slate-50 p-4 dark:border-navy-slate dark:bg-navy/40">
          {/* El formulario conserva un ancho de lectura —estirar un campo de
              texto a 2000 px no lo hace más usable— pero alineado a la
              IZQUIERDA, no centrado: flotando en medio de la tarjeta se veía
              descolgado del resto de la vista. */}
          <div className="max-w-3xl">
            <ConnectionForm
              config={form}
              onChange={(patch) => {
                setForm((f) => ({ ...(f ?? {}), ...patch }));
                setErrorForm('');
              }}
            />

            {(errorForm || diagForm) && (
              <PanelDiagnostico diagnostico={diagForm} mensajeCrudo={errorForm} />
            )}

            {['base_no_existe', 'ruta_no_existe', 'credenciales', 'sin_permisos'].includes(
              diagForm?.codigo ?? ''
            ) && (
              <CrearBaseDatos
                config={form}
                codigo={diagForm?.codigo}
                onCreada={() => void guardar()}
              />
            )}

            <div className="mt-4 flex flex-wrap items-center gap-3">
              <button
                onClick={() => void guardar()}
                disabled={guardando}
                className="flex min-h-[40px] items-center justify-center gap-2 rounded-lg bg-siemens px-4 text-sm font-semibold text-white outline-none transition hover:bg-siemens-600 focus-visible:ring-2 focus-visible:ring-siemens/50 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {guardando ? (
                  <>
                    <Loader2Icon className="h-4 w-4 animate-spin" />
                    Verificando…
                  </>
                ) : (
                  <>
                    <PlugZapIcon className="h-4 w-4" />
                    Probar y guardar
                  </>
                )}
              </button>
              <p className="min-w-0 flex-1 text-[11px] leading-relaxed text-slate-400">
                La conexión se verifica antes de guardarse: si las credenciales
                o la red fallan, no se guarda nada.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* ── Lista ──────────────────────────────────────────────── */}
      {conexiones.length === 0 && !cargando ? (
        <div className="px-4 py-10 text-center">
          <DatabaseIcon className="mx-auto mb-3 h-8 w-8 text-slate-300 dark:text-slate-600" />
          <p className="text-sm font-semibold text-slate-500 dark:text-slate-300">
            No hay ninguna conexión dada de alta
          </p>
          <p className="mt-1 text-xs text-slate-400">
            Pulsa «Añadir» para registrar la primera.
          </p>
        </div>
      ) : (
        /* Una TABLA, no una lista de tarjetas. Las conexiones se comparan
           entre sí —qué motor, qué servidor, cuál está caída— y para comparar
           hacen falta columnas alineadas. Con tarjetas, el motor de una fila
           caía debajo del host de la de arriba y no se podía leer en vertical. */
        <div className="mp-scroll mp-scroll-dark overflow-x-auto">
          <table className="w-full min-w-[880px] text-left text-sm">
            <thead>
              <tr>
                <ThBd className="w-36">Estado</ThBd>
                <ThBd>Conexión</ThBd>
                <ThBd className="w-40">Motor</ThBd>
                <ThBd className="w-56">Servidor</ThBd>
                <ThBd className="w-44">Base de datos</ThBd>
                <ThBd className="w-24 text-right">Consultas</ThBd>
                <ThBd className="w-24" />
              </tr>
            </thead>
            <tbody>
              {conexiones.map((c) => {
                const diag = diagFila[c.db_id];
                const res = resultado[c.db_id];
                // El error del pool solo se enseña si NO hay un resultado de
                // prueba más reciente: si acabas de pulsar "Probar" y salió
                // bien, seguir mostrando el fallo de hace diez minutos es
                // decirle a alguien que su arreglo no funcionó cuando sí.
                const errorPool = c.ultimo_error && !res ? c.ultimo_error : '';
                const abierto = !!diag || !!res || !!errorPool || confirmar === c.db_id;

                return (
                  <Fragment key={c.db_id}>
                    <tr
                      className={`group border-t border-slate-100 transition-colors dark:border-navy-slate/60 ${
                        abierto
                          ? 'bg-slate-50/70 dark:bg-navy/40'
                          : 'hover:bg-slate-50/70 dark:hover:bg-navy/40'
                      }`}
                    >
                      <td className="px-4 py-3">
                        <ChipEstadoBd ok={c.conectado} />
                      </td>

                      <td className="px-4 py-3">
                        <p className="truncate font-semibold text-navy dark:text-slate-100">
                          {c.nombre || c.db_id}
                        </p>
                        <p className="truncate font-mono text-[11px] text-slate-400">
                          {c.db_id}
                        </p>
                      </td>

                      <td className="px-4 py-3 text-[13px] text-slate-500 dark:text-slate-400">
                        {c.etiqueta_motor || c.motor}
                      </td>

                      <td className="truncate px-4 py-3 font-mono text-xs text-slate-500 dark:text-slate-400">
                        {c.host || '—'}
                        {c.puerto ? <span className="text-slate-300 dark:text-slate-600">:{c.puerto}</span> : null}
                      </td>

                      <td className="truncate px-4 py-3 font-mono text-xs text-slate-500 dark:text-slate-400">
                        {c.base_datos || '—'}
                      </td>

                      <td className="px-4 py-3 text-right tabular-nums text-slate-500 dark:text-slate-400">
                        {c.num_consultas ?? 0}
                      </td>

                      <td className="px-4 py-3">
                        <div className="flex items-center justify-end gap-1 opacity-60 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
                          <button
                            onClick={() => void probar(c.db_id)}
                            disabled={probando === c.db_id}
                            title="Probar y reconectar"
                            aria-label={`Probar la conexión ${c.db_id}`}
                            className="flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 outline-none transition hover:bg-siemens/10 hover:text-siemens focus-visible:ring-2 focus-visible:ring-siemens/40 disabled:opacity-50"
                          >
                            {probando === c.db_id ? (
                              <Loader2Icon className="h-4 w-4 animate-spin" />
                            ) : (
                              <PlugZapIcon className="h-4 w-4" />
                            )}
                          </button>
                          <button
                            onClick={() =>
                              setConfirmar(confirmar === c.db_id ? '' : c.db_id)
                            }
                            title="Borrar"
                            aria-label={`Borrar la conexión ${c.db_id}`}
                            className="flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 outline-none transition hover:bg-state-error/10 hover:text-state-error focus-visible:ring-2 focus-visible:ring-state-error/40"
                          >
                            <Trash2Icon className="h-4 w-4" />
                          </button>
                        </div>
                      </td>
                    </tr>

                    {/* Fila de detalle. Todo lo que antes crecía DENTRO de la
                        fila —diagnóstico, resultado, confirmación— pasa aquí,
                        a ancho completo. Así las columnas de arriba siguen
                        alineadas por muy largo que sea un error de ODBC. */}
                    {abierto && (
                      <tr className="bg-slate-50/70 dark:bg-navy/40">
                        <td colSpan={7} className="px-4 pb-3.5 pt-0">
                          <div className="space-y-2.5">
                            {diag && <PanelDiagnostico diagnostico={diag} compacto />}

                            {res && !diag && (
                              <p
                                className={`flex items-start gap-1.5 rounded-lg px-3 py-2 text-[11.5px] leading-relaxed ring-1 ${
                                  res.startsWith('OK')
                                    ? 'bg-state-ok/10 text-state-ok ring-state-ok/25'
                                    : 'bg-state-error/10 text-state-error ring-state-error/25'
                                }`}
                              >
                                {res.startsWith('OK') ? (
                                  <CheckCircle2Icon className="mt-px h-3.5 w-3.5 shrink-0" />
                                ) : (
                                  <AlertCircleIcon className="mt-px h-3.5 w-3.5 shrink-0" />
                                )}
                                <span className="min-w-0 break-words">{res}</span>
                              </p>
                            )}

                            {errorPool && !diag && (
                              <p className="flex items-start gap-1.5 rounded-lg bg-state-error/10 px-3 py-2 text-[11.5px] leading-relaxed text-state-error ring-1 ring-state-error/25">
                                <AlertCircleIcon className="mt-px h-3.5 w-3.5 shrink-0" />
                                <span className="min-w-0 break-words">{errorPool}</span>
                              </p>
                            )}

                            {confirmar === c.db_id && (
                              <div className="flex flex-wrap items-center gap-3 rounded-lg bg-state-error/10 px-3 py-2.5 ring-1 ring-state-error/25">
                                <p className="min-w-0 flex-1 text-[11.5px] leading-relaxed text-state-error">
                                  Se borra la conexión{' '}
                                  <strong className="font-mono">{c.db_id}</strong> y
                                  todas sus consultas guardadas. Los datos de la
                                  base NO se tocan.
                                </p>
                                <div className="flex shrink-0 gap-2">
                                  <button
                                    onClick={() => setConfirmar('')}
                                    className="rounded-lg px-3 py-1.5 text-xs font-semibold text-slate-500 outline-none transition hover:bg-slate-200/70 focus-visible:ring-2 focus-visible:ring-siemens/40 dark:hover:bg-navy-slate/40"
                                  >
                                    Cancelar
                                  </button>
                                  <button
                                    onClick={() => void borrar(c.db_id)}
                                    className="rounded-lg bg-state-error px-3 py-1.5 text-xs font-semibold text-white outline-none transition hover:brightness-110 focus-visible:ring-2 focus-visible:ring-state-error/50"
                                  >
                                    Borrar
                                  </button>
                                </div>
                              </div>
                            )}
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/** Cabecera de columna de la tabla de conexiones. */
function ThBd({
  children,
  className = '',
}: {
  children?: ReactNode;
  className?: string;
}) {
  return (
    <th
      scope="col"
      className={`whitespace-nowrap px-4 pb-2 pt-3 text-left text-[10px] font-bold uppercase tracking-wider text-slate-400 ${className}`}
    >
      {children}
    </th>
  );
}

/**
 * Estado del pool.
 *
 * El punto de color solo no basta: quien no separa rojo de verde necesita la
 * palabra, y la palabra sola sin el punto se pierde en una tabla de seis
 * columnas. Van los dos.
 */
function ChipEstadoBd({ ok }: { ok: boolean }) {
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
      {ok ? 'conectada' : 'sin conexión'}
    </span>
  );
}
