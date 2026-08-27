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
import { useCallback, useEffect, useState } from 'react';
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

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-card dark:border-navy-slate dark:bg-navy-soft">
      <div className="mb-4 flex items-center justify-between gap-3">
        <p className="text-xs leading-relaxed text-slate-400">
          Cada base tiene sus propias cuentas, alarmas y recetas. La que use el
          login se elige al entrar.
        </p>
        <div className="flex shrink-0 items-center gap-2">
          <button
            onClick={() => void recargar()}
            title="Actualizar"
            className="flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 transition hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-navy-slate/40"
          >
            <RefreshCwIcon className={`h-4 w-4 ${cargando ? 'animate-spin' : ''}`} />
          </button>
          <button
            onClick={() => {
              setForm(form ? null : { ...NUEVA });
              setErrorForm('');
            }}
            className="flex items-center gap-1.5 rounded-lg bg-siemens px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-siemens-600"
          >
            {form ? <XIcon className="h-3.5 w-3.5" /> : <PlusIcon className="h-3.5 w-3.5" />}
            {form ? 'Cancelar' : 'Añadir'}
          </button>
        </div>
      </div>

      {error && (
        <p className="mb-4 flex items-start gap-2 rounded-lg border border-state-error/30 bg-state-error/5 px-3 py-2.5 text-xs text-state-error">
          <AlertCircleIcon className="mt-px h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0">{error}</span>
        </p>
      )}

      {/* ── Alta ───────────────────────────────────────────────── */}
      {form && (
        <div className="mb-5 rounded-lg border border-slate-200 bg-slate-50 p-4 dark:border-navy-slate dark:bg-navy/40">
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

          {form &&
            ['base_no_existe', 'ruta_no_existe', 'credenciales', 'sin_permisos'].includes(
              diagForm?.codigo ?? ''
            ) && (
              <CrearBaseDatos
                config={form}
                codigo={diagForm?.codigo}
                onCreada={() => void guardar()}
              />
            )}

          <p className="mt-3 text-[11px] leading-relaxed text-slate-400">
            La conexión se verifica antes de guardarse: si las credenciales o la
            red fallan, no se guarda nada.
          </p>

          <button
            onClick={() => void guardar()}
            disabled={guardando}
            className="mt-3 flex w-full items-center justify-center gap-2 rounded-lg bg-siemens px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-siemens-600 disabled:cursor-not-allowed disabled:opacity-60"
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
        </div>
      )}

      {/* ── Lista ──────────────────────────────────────────────── */}
      {conexiones.length === 0 && !cargando ? (
        <p className="py-6 text-center text-xs text-slate-400">
          No hay ninguna conexión dada de alta.
        </p>
      ) : (
        <ul className="space-y-2">
          {conexiones.map((c) => (
            <li
              key={c.db_id}
              className="rounded-lg border border-slate-200 px-3.5 py-3 dark:border-navy-slate"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex min-w-0 items-start gap-2.5">
                  <DatabaseIcon className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" />
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-navy dark:text-slate-100">
                      {c.nombre || c.db_id}
                      <span className="ml-2 font-mono text-[11px] font-normal text-slate-400">
                        {c.db_id}
                      </span>
                    </p>
                    <p className="truncate text-[11px] text-slate-400">
                      {[c.etiqueta_motor, c.host, c.base_datos]
                        .filter(Boolean)
                        .join(' · ')}
                      {typeof c.num_consultas === 'number' && c.num_consultas > 0
                        ? ` · ${c.num_consultas} consulta(s)`
                        : ''}
                    </p>
                  </div>
                </div>

                <div className="flex shrink-0 items-center gap-2">
                  <span className="flex items-center gap-1.5">
                    <span
                      aria-hidden="true"
                      className={`h-2 w-2 rounded-full ${
                        c.conectado ? 'bg-state-ok' : 'bg-state-error'
                      }`}
                    />
                    <span
                      className={`text-[11px] font-medium ${
                        c.conectado ? 'text-state-ok' : 'text-state-error'
                      }`}
                    >
                      {c.conectado ? 'conectada' : 'sin conexión'}
                    </span>
                  </span>

                  <button
                    onClick={() => void probar(c.db_id)}
                    disabled={probando === c.db_id}
                    title="Probar y reconectar"
                    className="flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 transition hover:bg-slate-100 hover:text-siemens disabled:opacity-50 dark:hover:bg-navy-slate/40"
                  >
                    {probando === c.db_id ? (
                      <Loader2Icon className="h-4 w-4 animate-spin" />
                    ) : (
                      <PlugZapIcon className="h-4 w-4" />
                    )}
                  </button>

                  <button
                    onClick={() => setConfirmar(confirmar === c.db_id ? '' : c.db_id)}
                    title="Borrar"
                    className="flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 transition hover:bg-state-error/10 hover:text-state-error"
                  >
                    <Trash2Icon className="h-4 w-4" />
                  </button>
                </div>
              </div>

              {/* Por qué falla, si acaba de fallar la prueba */}
              {diagFila[c.db_id] && (
                <PanelDiagnostico diagnostico={diagFila[c.db_id]} />
              )}

              {/* Resultado de la última prueba */}
              {resultado[c.db_id] && !diagFila[c.db_id] && (
                <p
                  className={`mt-2 flex items-start gap-1.5 text-[11px] leading-relaxed ${
                    resultado[c.db_id].startsWith('OK')
                      ? 'text-state-ok'
                      : 'text-state-error'
                  }`}
                >
                  {resultado[c.db_id].startsWith('OK') ? (
                    <CheckCircle2Icon className="mt-px h-3 w-3 shrink-0" />
                  ) : (
                    <AlertCircleIcon className="mt-px h-3 w-3 shrink-0" />
                  )}
                  <span className="min-w-0">{resultado[c.db_id]}</span>
                </p>
              )}

              {/* El error del backend, si el pool no levantó */}
              {c.ultimo_error && !resultado[c.db_id] && (
                <p className="mt-2 flex items-start gap-1.5 text-[11px] leading-relaxed text-state-error">
                  <AlertCircleIcon className="mt-px h-3 w-3 shrink-0" />
                  <span className="min-w-0">{c.ultimo_error}</span>
                </p>
              )}

              {/* Confirmación en dos pasos, sin diálogo del navegador */}
              {confirmar === c.db_id && (
                <div className="mt-3 flex flex-wrap items-center gap-3 rounded-lg border border-state-error/30 bg-state-error/5 px-3 py-2.5">
                  <p className="min-w-0 flex-1 text-[11px] leading-relaxed text-state-error">
                    Se borra la conexión <strong>{c.db_id}</strong> y todas sus
                    consultas guardadas. Los datos de la base NO se tocan.
                  </p>
                  <div className="flex shrink-0 gap-2">
                    <button
                      onClick={() => setConfirmar('')}
                      className="rounded-lg px-3 py-1.5 text-xs font-semibold text-slate-500 transition hover:bg-slate-100 dark:hover:bg-navy-slate/40"
                    >
                      Cancelar
                    </button>
                    <button
                      onClick={() => void borrar(c.db_id)}
                      className="rounded-lg bg-state-error px-3 py-1.5 text-xs font-semibold text-white transition hover:opacity-90"
                    >
                      Borrar
                    </button>
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
