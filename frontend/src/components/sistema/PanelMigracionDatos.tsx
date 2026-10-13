// =========================================================================
// PanelMigracionDatos.tsx — llevarse los DATOS de la base a otro equipo
//
// La copia de la carpeta de datos (PanelCarpetaDatos) se lleva la
// configuración: PLCs, pantallas, conexiones. Lo que vive dentro de la base
// SQL —reglas de alarma, su historial, las recetas con sus registros y el
// histórico del PLC— no iba en ninguna parte, y montar un segundo equipo
// obligaba a rehacerlo a mano. Esto lo exporta a un .zip y lo importa en
// cualquier otra base del HMI, renumerando las claves para que encaje aunque
// el destino ya tenga datos. Las cuentas de usuario NO viajan: son de cada
// instalación. Ver app/db/migracion_datos.py.
//
// POR QUÉ AQUÍ Y NO EN «BASES DE DATOS»
// Esa pestaña es para dar de alta conexiones y crear el esquema: la fontanería.
// Esto es una operación de sistema, hermana de «Descargar copia» /
// «Restaurar», y quien la busca piensa en «me llevo mis datos», no en
// «configuro una conexión».
// =========================================================================
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertCircleIcon,
  AlertTriangleIcon,
  CheckCircle2Icon,
  DatabaseIcon,
  DownloadIcon,
  FlaskConicalIcon,
  Loader2Icon,
  UploadIcon,
} from 'lucide-react';
import { API_BASE, cargarConexiones, type ConexionRemota } from '../flows/api';
import { getToken } from '../../services/authApi';
import { descargarBlob } from '../../utils/descargas';

interface InformeTabla {
  tabla: string;
  leidas: number;
  insertadas: number;
  reutilizadas: number;
  omitidas: number;
  avisos: string[];
}

interface Informe {
  ok: boolean;
  simulado: boolean;
  modo: string;
  mensaje: string;
  origen?: { db_id?: string; nombre?: string; motor?: string; base_datos?: string };
  generado_en?: string;
  tablas: InformeTabla[];
  totales: { insertadas: number; reutilizadas: number; omitidas: number };
}

const NOMBRES: Record<string, string> = {
  plc_prg: 'Histórico del PLC',
  alarmas_def: 'Reglas de alarma',
  alarmas: 'Historial de alarmas',
  recetas: 'Recetas',
  receta_elementos: 'Elementos de receta',
  receta_registros: 'Registros de receta',
  receta_valores: 'Valores de receta',
};

const BTN_SEC =
  'flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-600 transition hover:border-siemens/40 hover:text-siemens disabled:opacity-50 dark:border-navy-slate dark:text-slate-300';
const CHECK =
  'h-3.5 w-3.5 rounded border-slate-300 text-siemens focus:ring-2 focus:ring-siemens/40 dark:border-navy-slate dark:bg-navy';

export function PanelMigracionDatos() {
  const [bases, setBases] = useState<ConexionRemota[]>([]);
  const [dbId, setDbId] = useState('');
  const [historico, setHistorico] = useState(true);
  const [modo, setModo] = useState<'fusionar' | 'añadir'>('fusionar');
  const [trabajando, setTrabajando] = useState('');
  const [mensaje, setMensaje] = useState('');
  const [error, setError] = useState('');
  const [informe, setInforme] = useState<Informe | null>(null);
  // El fichero elegido se guarda para poder simular primero y aplicar
  // después SIN volver a elegirlo.
  const [archivo, setArchivo] = useState<File | null>(null);
  const inputZip = useRef<HTMLInputElement>(null);

  const cargar = useCallback(async () => {
    try {
      const lista = await cargarConexiones();
      setBases(lista);
      setDbId((actual) =>
        actual && lista.some((b) => b.db_id === actual)
          ? actual
          : lista.find((b) => b.conectado)?.db_id ?? lista[0]?.db_id ?? ''
      );
    } catch (e: any) {
      setError(e?.message ?? 'No se pudieron listar las bases de datos.');
    }
  }, []);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  const cabeceras = (): Record<string, string> => {
    const token = getToken();
    return token ? { Authorization: `Bearer ${token}` } : {};
  };

  const exportar = async () => {
    if (!dbId) return;
    setTrabajando('exportar');
    setMensaje('');
    setError('');
    setInforme(null);
    try {
      const r = await fetch(
        `${API_BASE}/db/${encodeURIComponent(dbId)}/datos/exportar?incluir_historico=${historico}`,
        { headers: cabeceras() }
      );
      if (!r.ok) {
        const d = await r.json().catch(() => null);
        throw new Error(d?.detail ?? `El servidor respondió ${r.status}.`);
      }
      const blob = await r.blob();
      const cd = r.headers.get('Content-Disposition') || '';
      const nombre = /filename="?([^";]+)"?/.exec(cd)?.[1] ?? `psicore-datos-${dbId}.zip`;
      descargarBlob(blob, nombre);
      setMensaje(`Datos exportados: ${nombre}`);
    } catch (e: any) {
      setError(e?.message ?? 'No se pudo exportar.');
    } finally {
      setTrabajando('');
    }
  };

  const importar = async (simular: boolean) => {
    if (!dbId || !archivo) return;
    if (
      !simular &&
      !window.confirm(
        `¿Importar «${archivo.name}» en la base «${dbId}»?\n\n` +
          `Modo: ${modo === 'fusionar' ? 'fusionar con lo que ya hay' : 'añadir todo como nuevo'}.\n` +
          `La operación es todo o nada: si algo falla, no se aplica nada.`
      )
    ) {
      return;
    }
    setTrabajando(simular ? 'simular' : 'importar');
    setMensaje('');
    setError('');
    try {
      const cuerpo = new FormData();
      cuerpo.append('archivo', archivo);
      cuerpo.append('modo', modo);
      cuerpo.append('simular', String(simular));
      cuerpo.append('incluir_historico', String(historico));
      const r = await fetch(`${API_BASE}/db/${encodeURIComponent(dbId)}/datos/importar`, {
        method: 'POST',
        headers: cabeceras(),
        body: cuerpo,
      });
      const d = await r.json().catch(() => null);
      if (!r.ok || d?.ok === false) {
        throw new Error(d?.detail ?? d?.mensaje ?? `HTTP ${r.status}`);
      }
      setInforme(d as Informe);
      setMensaje(d.mensaje);
      if (!simular) setArchivo(null);
    } catch (e: any) {
      setError(e?.message ?? 'No se pudo importar.');
    } finally {
      setTrabajando('');
      if (inputZip.current) inputZip.current.value = '';
    }
  };

  const base = bases.find((b) => b.db_id === dbId);
  const ocupado = !!trabajando;

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-card dark:border-navy-slate dark:bg-navy-soft">
      <div className="flex items-start gap-2.5">
        <DatabaseIcon className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" />
        <div className="min-w-0 flex-1">
          <p className="text-[12.5px] font-semibold text-navy dark:text-slate-100">
            Migrar datos de la base
          </p>
          <p className="mt-0.5 text-[11px] leading-relaxed text-slate-400">
            Reglas e historial de alarmas, recetas completas y, si quieres, el
            histórico del PLC. <strong>Sin cuentas de usuario</strong>: cada
            equipo conserva las suyas.
          </p>
        </div>
      </div>

      {/* ── Base ─────────────────────────────────────────────── */}
      <label className="mt-4 block">
        <span className="mb-1 block text-[11px] font-medium text-slate-500 dark:text-slate-400">
          Base de datos
        </span>
        <select
          value={dbId}
          onChange={(e) => setDbId(e.target.value)}
          disabled={ocupado || bases.length === 0}
          className="w-full cursor-pointer rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-navy outline-none transition focus:border-siemens focus:ring-2 focus:ring-siemens/20 disabled:opacity-60 dark:border-navy-slate dark:bg-navy dark:text-slate-100"
        >
          {bases.length === 0 && <option value="">— sin conexiones dadas de alta —</option>}
          {bases.map((b) => (
            <option key={b.db_id} value={b.db_id}>
              {b.nombre || b.db_id} · {b.etiqueta_motor || b.motor}
              {b.base_datos ? ` · ${b.base_datos}` : ''}
              {b.conectado ? '' : ' (sin conexión)'}
            </option>
          ))}
        </select>
      </label>

      <label className="mt-2.5 flex items-center gap-2 text-[11.5px] text-slate-600 dark:text-slate-300">
        <input
          type="checkbox"
          checked={historico}
          onChange={(e) => setHistorico(e.target.checked)}
          disabled={ocupado}
          className={CHECK}
        />
        Incluir el histórico del PLC (<code className="text-[10.5px]">plc_prg</code>; puede pesar mucho)
      </label>

      {/* ── Exportar ─────────────────────────────────────────── */}
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button
          onClick={() => void exportar()}
          disabled={ocupado || !dbId || !base?.conectado}
          className="flex items-center gap-1.5 rounded-lg bg-siemens px-3 py-2 text-xs font-semibold text-white transition hover:bg-siemens-600 disabled:opacity-50"
        >
          {trabajando === 'exportar' ? (
            <Loader2Icon className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <DownloadIcon className="h-3.5 w-3.5" />
          )}
          Exportar datos
        </button>
        <span className="text-[11px] text-slate-400">
          Descarga un <code>.zip</code> para llevarlo al otro equipo.
        </span>
      </div>

      {/* ── Importar ─────────────────────────────────────────── */}
      <div className="mt-4 border-t border-slate-200 pt-4 dark:border-navy-slate">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
          Importar en esta base
        </p>

        <div className="mt-2 flex flex-wrap items-center gap-2">
          <button
            onClick={() => inputZip.current?.click()}
            disabled={ocupado || !dbId}
            className={BTN_SEC}
          >
            <UploadIcon className="h-3.5 w-3.5" />
            {archivo ? 'Cambiar archivo…' : 'Elegir archivo…'}
          </button>
          <input
            ref={inputZip}
            type="file"
            accept=".zip"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) {
                setArchivo(f);
                setInforme(null);
                setMensaje('');
                setError('');
              }
            }}
          />
          {archivo && (
            <span className="min-w-0 truncate text-[11.5px] text-slate-600 dark:text-slate-300">
              {archivo.name} · {(archivo.size / 1024).toFixed(0)} KB
            </span>
          )}
        </div>

        <div className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1 text-[11.5px] text-slate-600 dark:text-slate-300">
          <label className="flex items-center gap-1.5">
            <input
              type="radio"
              name="modo-importar"
              checked={modo === 'fusionar'}
              onChange={() => setModo('fusionar')}
              disabled={ocupado}
              className={CHECK}
            />
            Fusionar con lo que ya hay
          </label>
          <label className="flex items-center gap-1.5">
            <input
              type="radio"
              name="modo-importar"
              checked={modo === 'añadir'}
              onChange={() => setModo('añadir')}
              disabled={ocupado}
              className={CHECK}
            />
            Añadir todo como nuevo
          </label>
        </div>
        <p className="mt-1 text-[10.5px] leading-relaxed text-slate-400">
          {modo === 'fusionar'
            ? 'Una receta o una regla de alarma que ya exista con el mismo nombre se reutiliza en vez de duplicarse; los eventos y lecturas repetidos se saltan. Importar dos veces no duplica nada.'
            : 'Todo entra con ids nuevos, aunque haya algo con el mismo nombre. Para cuando dos máquinas distintas llaman igual a cosas distintas.'}{' '}
          Las claves foráneas se renumeran solas.
        </p>

        <div className="mt-3 flex flex-wrap gap-2">
          <button
            onClick={() => void importar(true)}
            disabled={ocupado || !archivo || !dbId || !base?.conectado}
            className={BTN_SEC}
            title="Hace todo el recorrido sin guardar nada y enseña qué pasaría."
          >
            {trabajando === 'simular' ? (
              <Loader2Icon className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <FlaskConicalIcon className="h-3.5 w-3.5" />
            )}
            Simular
          </button>
          <button
            onClick={() => void importar(false)}
            disabled={ocupado || !archivo || !dbId || !base?.conectado}
            className="flex items-center gap-1.5 rounded-lg border border-amber-400/60 bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-700 transition hover:bg-amber-100 disabled:opacity-50 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300"
          >
            {trabajando === 'importar' ? (
              <Loader2Icon className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <UploadIcon className="h-3.5 w-3.5" />
            )}
            Importar ahora
          </button>
        </div>
        <p className="mt-2 text-[10.5px] leading-relaxed text-slate-400">
          Todo o nada: si una fila falla, la base queda como estaba. Conviene{' '}
          <strong>simular</strong> primero y mirar el informe. Hace falta rol
          Supervisor para importar.
        </p>
      </div>

      {/* ── Resultado ────────────────────────────────────────── */}
      {mensaje && (
        <p className="mt-3 flex items-start gap-2 rounded-lg border border-state-ok/30 bg-state-ok/5 px-3 py-2.5 text-xs leading-relaxed text-state-ok">
          <CheckCircle2Icon className="mt-px h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0">
            {informe?.simulado && <strong>Simulación · </strong>}
            {mensaje}
          </span>
        </p>
      )}
      {error && (
        <p className="mt-3 flex items-start gap-2 rounded-lg border border-state-error/30 bg-state-error/5 px-3 py-2.5 text-xs leading-relaxed text-state-error">
          <AlertCircleIcon className="mt-px h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 break-words">{error}</span>
        </p>
      )}

      {informe && (
        <div className="mt-3 overflow-hidden rounded-lg border border-slate-200 dark:border-navy-slate">
          {informe.origen?.nombre || informe.generado_en ? (
            <p className="border-b border-slate-200 bg-slate-50 px-3 py-1.5 text-[10.5px] text-slate-500 dark:border-navy-slate dark:bg-navy dark:text-slate-400">
              Origen: {informe.origen?.nombre || informe.origen?.db_id || '—'}
              {informe.origen?.motor ? ` · ${informe.origen.motor}` : ''}
              {informe.generado_en
                ? ` · exportado ${new Date(informe.generado_en).toLocaleString()}`
                : ''}
            </p>
          ) : null}
          <table className="w-full text-[11px]">
            <thead>
              <tr className="bg-slate-50 text-left text-[10px] uppercase tracking-wide text-slate-400 dark:bg-navy">
                <th className="px-3 py-1.5 font-semibold">Tabla</th>
                <th className="px-2 py-1.5 text-right font-semibold">Leídas</th>
                <th className="px-2 py-1.5 text-right font-semibold">Nuevas</th>
                <th className="px-2 py-1.5 text-right font-semibold">Reutil.</th>
                <th className="px-3 py-1.5 text-right font-semibold">Omitidas</th>
              </tr>
            </thead>
            <tbody>
              {informe.tablas.map((t) => (
                <tr
                  key={t.tabla}
                  className="border-t border-slate-100 text-slate-600 dark:border-navy-slate/60 dark:text-slate-300"
                >
                  <td className="px-3 py-1.5">
                    {NOMBRES[t.tabla] ?? t.tabla}
                    {t.avisos.length > 0 && (
                      <span
                        className="ml-1.5 inline-flex items-center gap-0.5 text-amber-600 dark:text-amber-400"
                        title={t.avisos.join('\n')}
                      >
                        <AlertTriangleIcon className="h-3 w-3" />
                        {t.avisos.length}
                      </span>
                    )}
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{t.leidas}</td>
                  <td className="px-2 py-1.5 text-right font-semibold tabular-nums text-navy dark:text-slate-100">
                    {t.insertadas}
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{t.reutilizadas}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{t.omitidas}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {informe.tablas.some((t) => t.avisos.length > 0) && (
            <ul className="space-y-0.5 border-t border-slate-200 bg-amber-50/60 px-3 py-2 text-[10.5px] leading-snug text-amber-700 dark:border-navy-slate dark:bg-amber-500/5 dark:text-amber-300">
              {informe.tablas.flatMap((t) =>
                t.avisos.map((a, i) => (
                  <li key={`${t.tabla}-${i}`}>
                    <b>{NOMBRES[t.tabla] ?? t.tabla}:</b> {a}
                  </li>
                ))
              )}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
