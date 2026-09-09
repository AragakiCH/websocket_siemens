// =========================================================================
// PanelExportar.tsx
// La pestaña «Exportar»: sacar los datos del PLC a un Excel.
//
// DOS FUENTES, UN SOLO SITIO
// Hay dos maneras de acabar con un .xlsx en el disco y son distintas de
// verdad, no dos botones del mismo:
//
//   EN VIVO   -> se muestrea el PLC AHORA, a intervalo fijo, y lo capturado
//                vive en memoria hasta que se descarga o se borra. Para mirar
//                qué hace una máquina en los próximos dos minutos.
//   DE LA BD  -> se lee lo que ya guardó el historizador. Para pedir el turno
//                del martes pasado.
//
// Podrían haber ido en sitios separados —la de la BD encaja en el nodo
// Historian, que ya sabe de qué grupo habla—, pero entonces habría que saber
// de antemano en qué pantalla se esconde cada tipo de exportación. Quien
// quiere un Excel piensa «quiero un Excel», así que las dos viven aquí.
//
// POR QUÉ SIDEBAR Y NO PESTAÑAS ARRIBA
// Con las fuentes arriba, el contenido quedaba en dos tarjetas que medían lo
// que medía su contenido: en una pantalla ancha eso dejaba media ventana
// vacía debajo. Con la barra a la izquierda el contenido ocupa TODO el alto,
// y lo que crece es lo que interesa —la lista de variables y la de
// grabaciones—, que es exactamente donde hacía falta sitio.
//
// LA REGLA DE ALTURA
// La raíz es `h-full` y a partir de ahí nadie vuelve a medir por contenido:
// cada columna es `flex-col` con UNA zona `flex-1` que hace el scroll por
// dentro. Así la cabecera y el botón de grabar se quedan siempre a la vista
// por mucho que crezca la lista.
//
// ESTADO DE LA SEGUNDA SECCIÓN
// «Desde la base de datos» está montada pero SIN CONECTAR: los controles se
// ven y se pueden tocar, y el botón de descargar está desactivado. Se hizo
// así a propósito para cerrar primero el flujo en vivo de punta a punta.
// =========================================================================
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertCircleIcon,
  BarChart3Icon,
  CheckCircle2Icon,
  CircleSlashIcon,
  DatabaseIcon,
  DownloadIcon,
  FileSpreadsheetIcon,
  InfoIcon,
  LineChartIcon,
  Loader2Icon,
  RadioIcon,
  RefreshCwIcon,
  SearchIcon,
  SquareIcon,
  TableIcon,
  Trash2Icon,
  ClockIcon,
  TriangleAlertIcon,
} from 'lucide-react';
import {
  borrarGrabacion,
  descargarExcelGrabacion,
  descargarExcelHistorico,
  duracionLegible,
  fetchTagsGrabables,
  iniciarGrabacion,
  listarGrabaciones,
  pararGrabacion,
  progresoDe,
  type Grabacion,
  type TagGrabable,
} from '../../services/exportApi';
import { cargarGrupos, type GrupoRemoto } from '../flows/api';

type Fuente = 'vivo' | 'bd';

/**
 * Cada cuánto se refresca la lista mientras algo está grabando.
 *
 * Un segundo es lo que hace que la barra de progreso y el contador se vean
 * vivos sin castigar al backend. Y el sondeo SOLO corre mientras hay algo en
 * curso: con todo terminado no hay nada que actualizar y una petición por
 * segundo eterna sería tirar batería para nada.
 */
const REFRESCO_MS = 1000;

/** Id sugerido: legible, ordenable y distinto en cada grabación. */
function idSugerido(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `grabacion_${p(d.getDate())}${p(d.getMonth() + 1)}_${p(d.getHours())}${p(d.getMinutes())}`;
}

/**
 * `"192.168.50.1|DB_snap7.temperatura"` -> `"DB_snap7.temperatura"`.
 *
 * La clave compuesta es lo que espera el backend, pero enseñarla entera en
 * una lista de doscientos tags es ruido: el PLC ya va en su propia línea.
 */
const soloTag = (clave: string): string => clave.split('|').slice(1).join('|') || clave;

/** Tope del backend: `MAX_MUESTRAS` en app/export/grabador.py. */
const MAX_MUESTRAS = 200_000;

// =========================================================================
// Raíz
// =========================================================================

export function PanelExportar() {
  const [fuente, setFuente] = useState<Fuente>('vivo');

  return (
    <div className="flex h-full overflow-hidden bg-slate-50 dark:bg-navy">

      {/* ══ Barra de fuentes ═══════════════════════════════════ */}
      <aside className="flex w-56 shrink-0 flex-col overflow-y-auto overscroll-contain border-r border-slate-200 bg-white dark:border-navy-slate dark:bg-navy-soft">
        <div className="border-b border-slate-200 px-4 py-3 dark:border-navy-slate">
          <p className="flex items-center gap-2 text-sm font-bold text-navy dark:text-slate-100">
            <FileSpreadsheetIcon className="h-4 w-4 text-siemens" />
            Exportar
          </p>
          <p className="mt-0.5 text-[10.5px] leading-snug text-slate-400">
            Los datos del PLC a un .xlsx
          </p>
        </div>

        <nav className="flex flex-col gap-1 p-2">
          <ItemFuente
            activo={fuente === 'vivo'}
            onClick={() => setFuente('vivo')}
            icono={<RadioIcon className="h-4 w-4" />}
            titulo="Grabar en vivo"
            sub="Muestrea el PLC ahora"
          />
          <ItemFuente
            activo={fuente === 'bd'}
            onClick={() => setFuente('bd')}
            icono={<DatabaseIcon className="h-4 w-4" />}
            titulo="Base de datos"
            sub="Lo ya historizado"
          />
        </nav>

        {/* Qué trae el fichero. Va abajo del todo y en gris: no es un control,
            es la respuesta a «¿y qué me voy a encontrar al abrirlo?», que se
            pregunta una vez y luego ya se sabe. Ocupa un sitio que si no
            quedaría vacío. */}
        <div className="mt-auto border-t border-slate-200 p-3 dark:border-navy-slate">
          <p className="mb-2 text-[10px] font-bold uppercase tracking-wider text-slate-400">
            El Excel trae
          </p>
          <div className="flex flex-col gap-1.5">
            <Hoja icono={<InfoIcon className="h-3 w-3" />} nombre="Información" que="Origen, tags, rango" />
            <Hoja icono={<TableIcon className="h-3 w-3" />} nombre="Datos" que="Una fila por instante" />
            <Hoja icono={<BarChart3Icon className="h-3 w-3" />} nombre="Estadísticas" que="Mín, máx, media, σ" />
            <Hoja icono={<LineChartIcon className="h-3 w-3" />} nombre="Tendencia" que="Gráfico de líneas" />
          </div>
        </div>
      </aside>

      {/* ══ Contenido ══════════════════════════════════════════ */}
      {fuente === 'vivo' ? <SeccionEnVivo /> : <SeccionBaseDatos />}
    </div>
  );
}

// =========================================================================
// SECCIÓN 1 · GRABAR EN VIVO
// =========================================================================

function SeccionEnVivo() {
  // ── Catálogo de tags ───────────────────────────────────────────
  const [tags, setTags] = useState<TagGrabable[]>([]);
  const [cargandoTags, setCargandoTags] = useState(true);
  const [errorTags, setErrorTags] = useState('');

  // ── Formulario ─────────────────────────────────────────────────
  const [nombre, setNombre] = useState('');
  const [grabacionId, setGrabacionId] = useState(idSugerido);
  const [intervaloMs, setIntervaloMs] = useState(1000);
  const [duracionS, setDuracionS] = useState(60);
  const [marcados, setMarcados] = useState<Set<string>>(new Set());
  const [busca, setBusca] = useState('');
  const [iniciando, setIniciando] = useState(false);
  const [errorForm, setErrorForm] = useState('');
  const [aviso, setAviso] = useState('');

  // ── Lista ──────────────────────────────────────────────────────
  const [grabaciones, setGrabaciones] = useState<Grabacion[]>([]);
  const [errorLista, setErrorLista] = useState('');
  const [ocupada, setOcupada] = useState<string>('');

  const cargarTags = useCallback(async () => {
    setCargandoTags(true);
    setErrorTags('');
    try {
      setTags(await fetchTagsGrabables());
    } catch (e: any) {
      setErrorTags(e?.message ?? 'No se pudieron cargar los tags.');
    } finally {
      setCargandoTags(false);
    }
  }, []);

  const cargarLista = useCallback(async () => {
    try {
      const r = await listarGrabaciones();
      setGrabaciones(r.grabaciones);
      setErrorLista('');
    } catch (e: any) {
      setErrorLista(e?.message ?? 'No se pudo leer la lista de grabaciones.');
    }
  }, []);

  useEffect(() => {
    void cargarTags();
    void cargarLista();
  }, [cargarTags, cargarLista]);

  // Sondeo mientras haya algo grabando, y solo entonces. El efecto depende de
  // ese booleano y no del array entero: si dependiera de `grabaciones`, cada
  // respuesta recrearía el intervalo y el ritmo se iría descuadrando.
  const hayEnCurso = grabaciones.some((g) => g.estado === 'grabando');
  useEffect(() => {
    if (!hayEnCurso) return;
    const id = setInterval(() => { void cargarLista(); }, REFRESCO_MS);
    return () => clearInterval(id);
  }, [hayEnCurso, cargarLista]);

  // ── Derivados de presentación ──────────────────────────────────
  const filtrados = useMemo(() => {
    const q = busca.trim().toLowerCase();
    if (!q) return tags;
    return tags.filter(
      (t) => t.tag.toLowerCase().includes(q) || t.plc.toLowerCase().includes(q)
    );
  }, [tags, busca]);

  /**
   * Lo que va a pesar la grabación, ANTES de lanzarla.
   *
   * El backend guarda un registro por cada par (instante × variable), y su
   * tope de 200 000 es sobre esa cuenta. Con muchas variables se alcanza
   * mucho antes de lo que uno diría mirando solo la duración: 50 tags a
   * 100 ms se cortan a los siete minutos. Por eso se avisa aquí y no
   * después, con la grabación ya truncada.
   */
  const cuentas = useMemo(() => {
    const nVars = marcados.size || tags.length;
    if (!nVars || !duracionS) return null;
    // Mientras se teclea, el intervalo pasa por valores a medio escribir —
    // incluido el 0, que aquí seria una division por cero y un «Infinity
    // filas» en pantalla. Se usa el minimo real del backend hasta que el
    // campo se cierra y se recorta de verdad.
    const iv = Math.max(100, intervaloMs || 100);
    // EL «+1» NO SOBRA: es el poste de la valla.
    //
    // El bucle del backend muestrea ANTES de mirar el reloj, así que toma una
    // foto en el segundo 0 y otra en el 30. Entre 0 y 30 cada segundo hay 30
    // huecos pero 31 marcas, y son las marcas las que salen como filas.
    // Sin esto la cuenta previa decía 30 y el Excel traía 31.
    const filas = Math.floor((duracionS * 1000) / iv) + 1;
    const muestras = filas * nVars;
    return { nVars, filas, muestras, pasa: muestras > MAX_MUESTRAS };
  }, [marcados.size, tags.length, duracionS, intervaloMs]);

  const alternarTag = (clave: string) => {
    setMarcados((prev) => {
      const s = new Set(prev);
      if (s.has(clave)) s.delete(clave);
      else s.add(clave);
      return s;
    });
  };

  const marcarVisibles = (valor: boolean) => {
    setMarcados((prev) => {
      const s = new Set(prev);
      for (const t of filtrados) {
        if (valor) s.add(t.clave);
        else s.delete(t.clave);
      }
      return s;
    });
  };

  const arrancar = async () => {
    const id = grabacionId.trim();
    if (!id) {
      setErrorForm('Ponle un identificador a la grabación.');
      return;
    }
    setIniciando(true);
    setErrorForm('');
    setAviso('');
    try {
      const r = await iniciarGrabacion({
        grabacion_id: id,
        // Vacío = todos. Es el propio contrato del backend, así que marcar
        // todas a mano y no marcar ninguna acaban en el mismo sitio.
        tags: Array.from(marcados),
        intervalo_ms: intervaloMs,
        duracion_s: duracionS,
        nombre: nombre.trim(),
      });
      if (!r.ok) {
        setErrorForm(r.mensaje || 'No se pudo iniciar la grabación.');
      } else {
        if (r.tags_desconocidos?.length) {
          setAviso(
            `${r.tags_desconocidos.length} tag(s) no existen ahora mismo y ` +
            `saldrán vacíos: ${r.tags_desconocidos.map(soloTag).join(', ')}`
          );
        }
        // Id nuevo para la siguiente: repetir el mismo choca con el que
        // acaba de arrancar y el backend lo rechaza.
        setGrabacionId(idSugerido());
      }
      await cargarLista();
    } catch (e: any) {
      setErrorForm(e?.message ?? 'No se pudo iniciar la grabación.');
    } finally {
      setIniciando(false);
    }
  };

  const accion = async (id: string, fn: () => Promise<any>) => {
    setOcupada(id);
    setErrorLista('');
    try {
      await fn();
      await cargarLista();
    } catch (e: any) {
      setErrorLista(e?.message ?? 'No se pudo completar la acción.');
    } finally {
      setOcupada('');
    }
  };

  const enCurso = grabaciones.filter((g) => g.estado === 'grabando').length;

  return (
    <div className="flex min-w-0 flex-1 overflow-hidden">

      {/* ══ Columna 1 · configurar ═════════════════════════════ */}
      <div className="flex w-[350px] shrink-0 flex-col overflow-hidden border-r border-slate-200 bg-white dark:border-navy-slate dark:bg-navy-soft">

        <Cabecera
          icono={<RadioIcon className="h-4 w-4 text-siemens" />}
          titulo="Nueva grabación"
          sub="Muestrea el PLC ahora mismo"
        />

        <div className="flex flex-col gap-3 border-b border-slate-200 p-4 dark:border-navy-slate">
          <div className="grid grid-cols-2 gap-3">
            <Campo label="Nombre">
              <input
                value={nombre}
                onChange={(e) => setNombre(e.target.value)}
                placeholder="Ensayo de arranque"
                className={INPUT}
              />
            </Campo>
            <Campo label="Identificador">
              <input
                value={grabacionId}
                onChange={(e) => setGrabacionId(e.target.value)}
                placeholder="ensayo_arranque"
                className={`${INPUT} font-mono`}
              />
            </Campo>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Campo label="Intervalo" ayuda="Mínimo 100 ms">
              <Numero
                value={intervaloMs}
                onChange={setIntervaloMs}
                min={100}
                step={100}
                unidad="ms"
              />
            </Campo>
            <Campo label="Duración" ayuda="0 = a mano">
              <Numero value={duracionS} onChange={setDuracionS} min={0} unidad="s" />
            </Campo>
          </div>

          {/* Lo que va a salir, antes de lanzarlo. Es la cuenta que nadie
              hace de cabeza y la única forma de ver que una hora a 100 ms es
              mala idea ANTES y no cuando ya está truncada. */}
          {cuentas && (
            <div
              className={`rounded-lg px-3 py-2 text-[11px] leading-relaxed ${
                cuentas.pasa
                  ? 'bg-amber-500/10 text-amber-700 dark:text-amber-400'
                  : 'bg-slate-50 text-slate-500 dark:bg-navy dark:text-slate-400'
              }`}
            >
              {cuentas.pasa && (
                <TriangleAlertIcon className="mr-1 inline h-3.5 w-3.5 align-text-bottom" />
              )}
              <Fuerte>{cuentas.filas.toLocaleString('es-PE')}</Fuerte> filas de datos ×{' '}
              <Fuerte>{cuentas.nVars}</Fuerte> variables ={' '}
              <Fuerte>{cuentas.muestras.toLocaleString('es-PE')}</Fuerte> muestras
              {cuentas.pasa && (
                <>
                  {' '}— pasa del tope de {MAX_MUESTRAS.toLocaleString('es-PE')} y se
                  cortará sola. Sube el intervalo o marca menos variables.
                </>
              )}
            </div>
          )}
        </div>

        {/* ── Variables ───────────────────────────────────── */}
        <div className="flex items-center justify-between gap-2 px-4 pt-3">
          <span className="text-[11px] font-bold uppercase tracking-wider text-slate-400">
            Variables
          </span>
          <span className="rounded-full bg-siemens-50 px-2 py-0.5 text-[10.5px] font-semibold text-siemens ring-1 ring-siemens/20 dark:bg-siemens/15 dark:text-siemens-200">
            {marcados.size === 0 ? `Todas · ${tags.length}` : `${marcados.size} de ${tags.length}`}
          </span>
        </div>

        <div className="px-4 pb-2 pt-2">
          <div className="relative">
            <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
            <input
              value={busca}
              onChange={(e) => setBusca(e.target.value)}
              placeholder="Buscar variable o PLC…"
              className={`${INPUT} pl-8`}
            />
          </div>
          <div className="mt-1.5 flex items-center gap-3 text-[10.5px]">
            <button
              onClick={() => marcarVisibles(true)}
              className="font-semibold text-siemens outline-none hover:underline focus-visible:underline"
            >
              Marcar {busca ? 'lo filtrado' : 'todas'}
            </button>
            <button
              onClick={() => setMarcados(new Set())}
              className="font-semibold text-slate-400 outline-none hover:underline focus-visible:underline"
            >
              Limpiar
            </button>
            <span className="ml-auto text-slate-400">Sin marcar = todas</span>
          </div>
        </div>

        {/* La lista es lo que crece: se queda con todo el alto que sobre y
            hace su propio scroll. Antes tenía un tope fijo de 18rem y en una
            pantalla alta dejaba medio panel en blanco debajo. */}
        <div className="mp-scroll mp-scroll-dark min-h-0 flex-1 overflow-y-auto overscroll-contain border-t border-slate-100 dark:border-navy-slate/60">
          {cargandoTags ? (
            <Centro>
              <Loader2Icon className="h-4 w-4 animate-spin text-slate-300" />
            </Centro>
          ) : errorTags ? (
            <Centro>
              <p className="text-xs text-state-error">{errorTags}</p>
              <button
                onClick={() => void cargarTags()}
                className="mt-2 text-[11px] font-semibold text-siemens hover:underline"
              >
                Reintentar
              </button>
            </Centro>
          ) : filtrados.length === 0 ? (
            <Centro>
              <p className="text-xs text-slate-400">
                {tags.length === 0
                  ? 'Ningún PLC ha conectado todavía, así que no hay variables que ofrecer.'
                  : 'Nada coincide con la búsqueda.'}
              </p>
            </Centro>
          ) : (
            <ul className="divide-y divide-slate-100 dark:divide-navy-slate/50">
              {filtrados.map((t) => (
                <li key={t.clave}>
                  <label className="flex cursor-pointer items-center gap-2.5 px-4 py-1.5 transition hover:bg-slate-50 dark:hover:bg-navy-slate/30">
                    <input
                      type="checkbox"
                      checked={marcados.has(t.clave)}
                      onChange={() => alternarTag(t.clave)}
                      className="h-3.5 w-3.5 shrink-0 accent-siemens"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-mono text-[11.5px] text-navy dark:text-slate-200">
                        {soloTag(t.clave)}
                      </span>
                      <span className="block truncate text-[10px] text-slate-400">
                        {t.plc} · {t.tipo}
                      </span>
                    </span>
                    <span className="shrink-0 tabular-nums text-[11px] font-semibold text-slate-500 dark:text-slate-400">
                      {formateaValor(t.valor_actual)}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* ── Arrancar ────────────────────────────────────── */}
        <div className="flex flex-col gap-2 border-t border-slate-200 p-3 dark:border-navy-slate">
          {errorForm && <Nota tipo="error">{errorForm}</Nota>}
          {aviso && <Nota tipo="aviso">{aviso}</Nota>}
          <button
            onClick={() => void arrancar()}
            disabled={iniciando}
            className="flex items-center justify-center gap-2 rounded-lg bg-siemens px-4 py-2 text-sm font-semibold text-white outline-none transition hover:bg-siemens-600 focus-visible:ring-2 focus-visible:ring-siemens/50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {iniciando ? (
              <Loader2Icon className="h-4 w-4 animate-spin" />
            ) : (
              <RadioIcon className="h-4 w-4" />
            )}
            Empezar a grabar
          </button>
        </div>
      </div>

      {/* ══ Columna 2 · grabaciones ════════════════════════════ */}
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">

        <Cabecera
          icono={<FileSpreadsheetIcon className="h-4 w-4 text-siemens" />}
          titulo="Grabaciones"
          sub={
            grabaciones.length === 0
              ? 'Todavía no hay ninguna'
              : `${grabaciones.length} en total${enCurso ? ` · ${enCurso} en curso` : ''}`
          }
          accion={
            <button
              onClick={() => void cargarLista()}
              title="Refrescar"
              aria-label="Refrescar"
              className="rounded-lg p-1.5 text-slate-400 outline-none transition hover:bg-slate-100 hover:text-slate-600 focus-visible:ring-2 focus-visible:ring-siemens/40 dark:hover:bg-navy-slate/50"
            >
              <RefreshCwIcon className="h-3.5 w-3.5" />
            </button>
          }
        />

        <div className="mp-scroll mp-scroll-dark min-h-0 flex-1 overflow-y-auto">
          {errorLista && (
            <div className="p-4 pb-0">
              <Nota tipo="error">{errorLista}</Nota>
            </div>
          )}

          {grabaciones.length === 0 ? (
            <SinGrabaciones />
          ) : (
            <ul className="flex flex-col gap-3 p-4">
              {grabaciones.map((g) => (
                <FilaGrabacion
                  key={g.grabacion_id}
                  g={g}
                  ocupada={ocupada === g.grabacion_id}
                  onParar={() => void accion(g.grabacion_id, () => pararGrabacion(g.grabacion_id))}
                  onBorrar={() => void accion(g.grabacion_id, () => borrarGrabacion(g.grabacion_id))}
                  onDescargar={() =>
                    void accion(g.grabacion_id, () => descargarExcelGrabacion(g.grabacion_id))
                  }
                />
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Qué enseñar cuando no hay ninguna grabación.
 *
 * Una tarjeta vacía con un icono gris al medio deja media ventana muerta y no
 * responde la única pregunta que tiene quien llega aquí por primera vez: qué
 * intervalo le pongo. Así que el hueco lo ocupan los tres ajustes que se usan
 * de verdad, con el porqué de cada uno.
 */
function SinGrabaciones() {
  const casos = [
    {
      titulo: 'Transitorio rápido',
      ajuste: '100 ms · 10–30 s',
      que: 'Un arranque de motor, un pico de presión. Cosas que pasan y se acaban antes de que te des cuenta.',
    },
    {
      titulo: 'Análisis normal',
      ajuste: '1000 ms · 1–5 min',
      que: 'Ver cómo se comporta algo un rato. Es el caso de siempre y el que trae puesto el formulario.',
    },
    {
      titulo: 'Tendencia lenta',
      ajuste: '5000 ms · indefinida',
      que: 'La temperatura de un horno a lo largo de un turno. Se para a mano cuando ya viste lo que querías.',
    },
  ];

  return (
    <div className="flex h-full flex-col items-center justify-center gap-6 p-8">
      <div className="text-center">
        <FileSpreadsheetIcon className="mx-auto mb-3 h-9 w-9 text-slate-300 dark:text-slate-600" />
        <p className="text-sm font-semibold text-slate-500 dark:text-slate-300">
          Ninguna grabación todavía
        </p>
        <p className="mx-auto mt-1 max-w-md text-xs leading-relaxed text-slate-400">
          Configura una a la izquierda y pulsa «Empezar a grabar». Podrás
          descargar el Excel incluso con la grabación en curso.
        </p>
      </div>

      <div className="grid w-full max-w-3xl gap-3 sm:grid-cols-3">
        {casos.map((c) => (
          <div
            key={c.titulo}
            className="rounded-xl border border-slate-200 bg-white p-3.5 dark:border-navy-slate dark:bg-navy-soft"
          >
            <p className="text-[12.5px] font-semibold text-navy dark:text-slate-100">
              {c.titulo}
            </p>
            <p className="mt-1 font-mono text-[11px] font-semibold text-siemens">
              {c.ajuste}
            </p>
            <p className="mt-2 text-[11px] leading-relaxed text-slate-400">{c.que}</p>
          </div>
        ))}
      </div>

      <p className="max-w-md text-center text-[10.5px] leading-relaxed text-slate-400">
        El intervalo lo decide lo rápido que cambia lo que quieres ver, no lo
        largo que sea. Las muestras viven en memoria (máx.{' '}
        {MAX_MUESTRAS.toLocaleString('es-PE')}); para histórico permanente está
        el Historizador.
      </p>
    </div>
  );
}

// ─── Una grabación de la lista ───────────────────────────────────

function FilaGrabacion({
  g,
  ocupada,
  onParar,
  onBorrar,
  onDescargar,
}: {
  g: Grabacion;
  ocupada: boolean;
  onParar: () => void;
  onBorrar: () => void;
  onDescargar: () => void;
}) {
  const grabando = g.estado === 'grabando';
  const progreso = progresoDe(g);

  // Lo que de verdad se va a abrir en el Excel. `num_muestras` es el conteo
  // largo del backend —un registro por (instante × variable)— y enseñarlo a
  // secas hace pensar que son filas, o peor, que son variables.
  const nVars = g.todos_los_tags ? 0 : g.num_tags;
  const filas = nVars > 0 ? Math.round(g.num_muestras / nVars) : 0;

  return (
    <li className="rounded-xl border border-slate-200 bg-white p-3.5 dark:border-navy-slate dark:bg-navy-soft">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate text-sm font-semibold text-navy dark:text-slate-100">
              {g.nombre || g.grabacion_id}
            </span>
            <ChipEstado estado={g.estado} />
          </div>
          <p className="mt-0.5 truncate font-mono text-[10.5px] text-slate-400">
            {g.grabacion_id}
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-1">
          {grabando && (
            <BotonFila
              onClick={onParar}
              disabled={ocupada}
              icono={<SquareIcon className="h-3.5 w-3.5" />}
              label="Parar"
              titulo="Termina antes de tiempo. Lo capturado sigue descargable."
            />
          )}
          <BotonFila
            onClick={onDescargar}
            disabled={ocupada || g.num_muestras === 0}
            destacado
            icono={
              ocupada ? (
                <Loader2Icon className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <DownloadIcon className="h-3.5 w-3.5" />
              )
            }
            label="Excel"
            titulo={
              g.num_muestras === 0
                ? 'Todavía no hay muestras que exportar'
                : grabando
                  ? 'Descarga lo capturado hasta ahora, sin parar la grabación'
                  : 'Descargar el Excel'
            }
          />
          <BotonFila
            onClick={onBorrar}
            disabled={ocupada || grabando}
            peligro
            icono={<Trash2Icon className="h-3.5 w-3.5" />}
            label=""
            titulo={grabando ? 'Párala antes de borrarla' : 'Borrar y liberar su memoria'}
          />
        </div>
      </div>

      <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-slate-500 dark:text-slate-400">
        {filas > 0 ? (
          <Dato n={filas.toLocaleString('es-PE')} l="filas" />
        ) : (
          <Dato n={g.num_muestras.toLocaleString('es-PE')} l="muestras" />
        )}
        <Dato n={g.todos_los_tags ? 'Todas' : String(g.num_tags)} l="variables" />
        <Dato n={`${g.intervalo_ms} ms`} l="intervalo" />
        <Dato n={duracionLegible(g.duracion_s)} l="duración" />
        {grabando && g.duracion_s > 0 && (
          <Dato n={`${Math.max(0, Math.round(g.segundos_restantes))} s`} l="restantes" />
        )}
      </div>

      {/* Una grabación indefinida no tiene final contra el que medir, así que
          se le pone una barra en movimiento en vez de un porcentaje
          inventado. */}
      {grabando && (
        <div className="mt-2.5 h-1 w-full overflow-hidden rounded-full bg-slate-200 dark:bg-navy-slate">
          {progreso === null ? (
            <div className="h-full w-1/3 animate-pulse rounded-full bg-siemens" />
          ) : (
            <div
              className="h-full rounded-full bg-siemens transition-[width] duration-1000 ease-linear"
              style={{ width: `${Math.round(progreso * 100)}%` }}
            />
          )}
        </div>
      )}

      {g.motivo_fin && (
        <p className="mt-2 text-[10.5px] text-slate-400">{g.motivo_fin}</p>
      )}
    </li>
  );
}

// =========================================================================
// SECCIÓN 2 · DESDE LA BASE DE DATOS  (solo la vista, sin conectar)
// =========================================================================

function SeccionBaseDatos() {
  // ── Grupos del historizador ────────────────────────────────────
  //
  // La lista sale de `GET /historian`, NO de los nodos del lienzo de Flujos.
  // El nodo es solo el formulario con el que se creó el grupo, y vive en el
  // localStorage de ese navegador; el grupo vive en el backend y sigue
  // escribiendo aunque nadie tenga el lienzo abierto. Sacarla de los nodos
  // haría que en un PC recién estrenado no hubiera nada que exportar aunque
  // haya meses de datos guardados.
  const [grupos, setGrupos] = useState<GrupoRemoto[]>([]);
  const [cargando, setCargando] = useState(true);
  const [errorGrupos, setErrorGrupos] = useState('');

  // ── Filtros ────────────────────────────────────────────────────
  const [grupoId, setGrupoId] = useState('');
  const [tag, setTag] = useState('');
  const [desde, setDesde] = useState('');
  const [hasta, setHasta] = useState('');
  const [limite, setLimite] = useState(10000);

  // ── Descarga ───────────────────────────────────────────────────
  const [bajando, setBajando] = useState(false);
  const [error, setError] = useState('');
  const [listo, setListo] = useState('');

  const traerGrupos = useCallback(async () => {
    setCargando(true);
    setErrorGrupos('');
    try {
      setGrupos(await cargarGrupos());
    } catch (e: any) {
      setErrorGrupos(e?.message ?? 'No se pudieron cargar los grupos.');
    } finally {
      setCargando(false);
    }
  }, []);

  useEffect(() => { void traerGrupos(); }, [traerGrupos]);

  const grupo = grupos.find((g) => g.grupo_id === grupoId) ?? null;

  /**
   * Variables que se pueden filtrar, SIN el prefijo del PLC.
   *
   * `grupo.tags` las trae como `"192.168.1.7|PLC_PRG.temp"` pero el endpoint
   * espera `"PLC_PRG.temp"` a secas. Es la clase de detalle que no falla:
   * simplemente devuelve cero filas y parece que no hay datos.
   *
   * Un grupo que graba TODO trae la lista vacía —en el backend
   * `todos_los_tags` es literalmente `not self.tags`—, así que ahí no hay
   * nada que ofrecer y solo queda «Todas».
   */
  const tagsDelGrupo = useMemo(() => {
    if (!grupo) return [];
    const vistos = new Set<string>();
    for (const clave of grupo.tags ?? []) {
      const limpio = soloTag(clave);
      if (limpio) vistos.add(limpio);
    }
    return Array.from(vistos).sort();
  }, [grupo]);

  // Al cambiar de grupo, la variable elegida casi seguro no existe en el
  // nuevo. Dejarla puesta filtraría por algo que no está y devolvería cero
  // filas sin decir por qué.
  useEffect(() => { setTag(''); }, [grupoId]);

  const descargar = async () => {
    if (!grupoId) return;
    setBajando(true);
    setError('');
    setListo('');
    try {
      const nombre = await descargarExcelHistorico({
        grupoId,
        tag,
        desde,
        hasta,
        limite,
      });
      setListo(nombre);
    } catch (e: any) {
      setError(e?.message ?? 'No se pudo descargar el histórico.');
    } finally {
      setBajando(false);
    }
  };

  return (
    <div className="flex min-w-0 flex-1 overflow-hidden">

      {/* ══ Columna 1 · filtros ════════════════════════════════ */}
      <div className="flex w-[350px] shrink-0 flex-col overflow-hidden border-r border-slate-200 bg-white dark:border-navy-slate dark:bg-navy-soft">
        <Cabecera
          icono={<DatabaseIcon className="h-4 w-4 text-siemens" />}
          titulo="Desde la base de datos"
          sub="Lo que ya guardó el historizador"
          accion={
            <button
              onClick={() => void traerGrupos()}
              title="Refrescar los grupos"
              aria-label="Refrescar los grupos"
              className="rounded-lg p-1.5 text-slate-400 outline-none transition hover:bg-slate-100 hover:text-slate-600 focus-visible:ring-2 focus-visible:ring-siemens/40 dark:hover:bg-navy-slate/50"
            >
              <RefreshCwIcon className="h-3.5 w-3.5" />
            </button>
          }
        />

        <div className="mp-scroll mp-scroll-dark min-h-0 flex-1 overflow-y-auto">
          <div className="flex flex-col gap-3 p-4">

            <Campo label="Grupo de historización">
              <select
                value={grupoId}
                onChange={(e) => setGrupoId(e.target.value)}
                disabled={cargando || grupos.length === 0}
                className={`${INPUT} disabled:opacity-50`}
              >
                <option value="">
                  {cargando
                    ? 'Cargando…'
                    : grupos.length === 0
                      ? 'No hay grupos configurados'
                      : '— Selecciona un grupo —'}
                </option>
                {grupos.map((g) => (
                  <option key={g.grupo_id} value={g.grupo_id}>
                    {g.nombre || g.grupo_id}
                    {g.activo ? '' : ' (pausado)'}
                  </option>
                ))}
              </select>
            </Campo>

            {errorGrupos && <Nota tipo="error">{errorGrupos}</Nota>}

            <Campo
              label="Variable"
              ayuda={
                grupo && tagsDelGrupo.length === 0
                  ? 'Este grupo graba todos los tags, así que no declara una lista.'
                  : 'Vacío = todas las del grupo.'
              }
            >
              <select
                value={tag}
                onChange={(e) => setTag(e.target.value)}
                disabled={tagsDelGrupo.length === 0}
                className={`${INPUT} disabled:opacity-50`}
              >
                <option value="">Todas</option>
                {tagsDelGrupo.map((n) => (
                  <option key={n} value={n}>{n}</option>
                ))}
              </select>
            </Campo>

            <Campo label="Desde" ayuda="Vacío = desde el principio.">
              <input
                type="datetime-local"
                value={desde}
                onChange={(e) => setDesde(e.target.value)}
                className={INPUT}
              />
            </Campo>
            <Campo label="Hasta" ayuda="Vacío = hasta el último dato.">
              <input
                type="datetime-local"
                value={hasta}
                onChange={(e) => setHasta(e.target.value)}
                className={INPUT}
              />
            </Campo>

            <Campo label="Límite de registros" ayuda="Máximo 100 000.">
              <Numero value={limite} onChange={setLimite} min={1} max={100000} unidad="filas" />
            </Campo>
          </div>
        </div>

        <div className="flex flex-col gap-2 border-t border-slate-200 p-3 dark:border-navy-slate">
          {error && <Nota tipo="error">{error}</Nota>}
          {listo && (
            <div className="flex items-start gap-2 rounded-lg bg-state-ok/10 px-3 py-2 text-[11px] leading-snug text-state-ok">
              <CheckCircle2Icon className="mt-px h-3.5 w-3.5 shrink-0" />
              <span className="min-w-0 break-all">Descargado: {listo}</span>
            </div>
          )}
          <button
            onClick={() => void descargar()}
            disabled={!grupoId || bajando}
            title={!grupoId ? 'Elige primero un grupo' : 'Descargar el histórico en Excel'}
            className="flex w-full items-center justify-center gap-2 rounded-lg bg-siemens px-4 py-2 text-sm font-semibold text-white outline-none transition hover:bg-siemens-600 focus-visible:ring-2 focus-visible:ring-siemens/50 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {bajando ? (
              <Loader2Icon className="h-4 w-4 animate-spin" />
            ) : (
              <DownloadIcon className="h-4 w-4" />
            )}
            Descargar Excel
          </button>
        </div>
      </div>

      {/* ══ Columna 2 · los grupos ═════════════════════════════ */}
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <Cabecera
          icono={<DatabaseIcon className="h-4 w-4 text-siemens" />}
          titulo="Grupos del historizador"
          sub={
            cargando
              ? 'Cargando…'
              : grupos.length === 0
                ? 'Ninguno configurado'
                : `${grupos.length} en total · ${grupos.filter((g) => g.activo).length} grabando`
          }
        />

        <div className="mp-scroll mp-scroll-dark min-h-0 flex-1 overflow-y-auto">
          {cargando ? (
            <Centro>
              <Loader2Icon className="h-4 w-4 animate-spin text-slate-300" />
            </Centro>
          ) : grupos.length === 0 ? (
            <SinGrupos />
          ) : (
            <ul className="flex flex-col gap-3 p-4">
              {grupos.map((g) => (
                <TarjetaGrupo
                  key={g.grupo_id}
                  g={g}
                  elegido={g.grupo_id === grupoId}
                  onElegir={() => setGrupoId(g.grupo_id)}
                />
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Un grupo de la lista. Se puede pulsar para elegirlo en el formulario.
 *
 * Enseña `filas_escritas` y `ultima_escritura` porque son las dos cosas que
 * dicen si vale la pena pedirle un Excel: un grupo con cero filas o con la
 * última escritura de hace semanas va a devolver poco o nada, y es mejor
 * verlo antes que después de una descarga vacía.
 */
function TarjetaGrupo({
  g,
  elegido,
  onElegir,
}: {
  g: GrupoRemoto;
  elegido: boolean;
  onElegir: () => void;
}) {
  return (
    <li>
      <button
        onClick={onElegir}
        className={`w-full rounded-xl border p-3.5 text-left outline-none transition focus-visible:ring-2 focus-visible:ring-siemens/40 ${
          elegido
            ? 'border-siemens bg-siemens-50/60 dark:bg-siemens/10'
            : 'border-slate-200 bg-white hover:border-siemens/40 dark:border-navy-slate dark:bg-navy-soft'
        }`}
      >
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate text-sm font-semibold text-navy dark:text-slate-100">
            {g.nombre || g.grupo_id}
          </span>
          {g.activo ? (
            <span className="flex shrink-0 items-center gap-1.5 rounded-full bg-state-ok/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-state-ok">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-state-ok" />
              Grabando
            </span>
          ) : (
            <span className="flex shrink-0 items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-slate-500 dark:bg-navy-slate dark:text-slate-400">
              <CircleSlashIcon className="h-2.5 w-2.5" />
              Pausado
            </span>
          )}
        </div>

        <p className="mt-0.5 truncate font-mono text-[10.5px] text-slate-400">
          {g.grupo_id} · {g.tabla}
        </p>

        <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-slate-500 dark:text-slate-400">
          <Dato n={(g.filas_escritas ?? 0).toLocaleString('es-PE')} l="filas escritas" />
          <Dato n={g.todos_los_tags ? 'Todas' : String(g.num_tags)} l="variables" />
          {g.ultima_escritura && (
            <span className="flex items-center gap-1 text-slate-400">
              <ClockIcon className="h-3 w-3" />
              {g.ultima_escritura}
            </span>
          )}
        </div>

        {g.ultimo_error && (
          <p className="mt-1.5 truncate text-[10.5px] text-state-error">{g.ultimo_error}</p>
        )}
      </button>
    </li>
  );
}

/** Sin grupos no hay nada que exportar, y el arreglo no está en esta vista. */
function SinGrupos() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 p-8 text-center">
      <DatabaseIcon className="h-9 w-9 text-slate-300 dark:text-slate-600" />
      <div>
        <p className="text-sm font-semibold text-slate-500 dark:text-slate-300">
          No hay ningún grupo de historización
        </p>
        <p className="mx-auto mt-1 max-w-md text-xs leading-relaxed text-slate-400">
          El histórico lo escribe el Historizador, y todavía no hay ninguno
          configurado. Se crean en la pestaña <strong>Flujos</strong>: suelta un
          nodo «Historian», elige la conexión y los tags, y a partir de ahí
          empieza a guardar en la base de datos.
        </p>
      </div>
      <p className="max-w-md text-[10.5px] leading-relaxed text-slate-400">
        Mientras tanto, «Grabar en vivo» no necesita nada de esto: muestrea el
        PLC directamente y no toca la base de datos.
      </p>
    </div>
  );
}

// =========================================================================
// Piezas de presentación
// =========================================================================

const INPUT =
  'w-full rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-navy outline-none transition ' +
  'placeholder:text-slate-400 focus:border-siemens focus:ring-2 focus:ring-siemens/20 ' +
  'dark:border-navy-slate dark:bg-navy dark:text-slate-100';

function Cabecera({
  icono,
  titulo,
  sub,
  accion,
}: {
  icono: React.ReactNode;
  titulo: string;
  sub?: string;
  accion?: React.ReactNode;
}) {
  return (
    <div className="flex shrink-0 items-center justify-between gap-2 border-b border-slate-200 bg-white px-4 py-3 dark:border-navy-slate dark:bg-navy-soft">
      <div className="flex min-w-0 items-center gap-2.5">
        <span className="shrink-0">{icono}</span>
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-navy dark:text-slate-100">{titulo}</p>
          {sub && <p className="truncate text-[11px] text-slate-400">{sub}</p>}
        </div>
      </div>
      {accion}
    </div>
  );
}

function ItemFuente({
  activo,
  onClick,
  icono,
  titulo,
  sub,
}: {
  activo: boolean;
  onClick: () => void;
  icono: React.ReactNode;
  titulo: string;
  sub: string;
}) {
  return (
    <button
      onClick={onClick}
      aria-current={activo ? 'page' : undefined}
      className={`flex items-start gap-2.5 rounded-lg px-2.5 py-2 text-left outline-none transition focus-visible:ring-2 focus-visible:ring-siemens/40 ${
        activo
          ? 'bg-siemens-50 text-siemens dark:bg-siemens/15 dark:text-siemens-200'
          : 'text-slate-500 hover:bg-slate-50 dark:text-slate-400 dark:hover:bg-navy-slate/40'
      }`}
    >
      <span className="mt-px shrink-0">{icono}</span>
      <span className="min-w-0">
        <span className="block truncate text-xs font-semibold">{titulo}</span>
        <span className="block truncate text-[10px] text-slate-400">{sub}</span>
      </span>
    </button>
  );
}

function Hoja({
  icono,
  nombre,
  que,
}: {
  icono: React.ReactNode;
  nombre: string;
  que: string;
}) {
  return (
    <div className="flex items-start gap-2">
      <span className="mt-0.5 shrink-0 text-slate-400">{icono}</span>
      <span className="min-w-0">
        <span className="block truncate text-[11px] font-semibold text-slate-600 dark:text-slate-300">
          {nombre}
        </span>
        <span className="block truncate text-[10px] text-slate-400">{que}</span>
      </span>
    </div>
  );
}

function Campo({
  label,
  ayuda,
  children,
}: {
  label: string;
  ayuda?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex min-w-0 flex-col gap-1">
      <span className="text-[11px] font-semibold text-slate-500 dark:text-slate-400">
        {label}
      </span>
      {children}
      {ayuda && <span className="text-[10px] text-slate-400">{ayuda}</span>}
    </label>
  );
}

/**
 * Número con su unidad pegada dentro del campo.
 *
 * POR QUÉ GUARDA TEXTO Y NO EL NÚMERO
 * Un `<input type="number">` atado directamente a un `number` no se puede
 * dejar vacío: al borrar el contenido, `Number('')` es 0, el estado vuelve a
 * 0 y el campo se rellena solo. El resultado es que para escribir 30 sobre un
 * 0 hay que borrar algo que no se deja borrar, y acabas con «030».
 *
 * Aquí el estado interno es la CADENA que se está escribiendo, que sí puede
 * quedar vacía. El número sale hacia fuera solo cuando lo que hay se puede
 * leer como número.
 *
 * Y EL RECORTE VA EN EL BLUR, NO EN CADA TECLA
 * Recortar mientras se teclea es el mismo problema por otro lado: con un
 * mínimo de 100, teclear «3» se convertiría en 100 antes de poder escribir el
 * segundo dígito. Se deja escribir lo que sea y se ajusta al salir del campo,
 * que es cuando ya se sabe qué quiso poner.
 */
function Numero({
  value,
  onChange,
  min = 0,
  max,
  step,
  unidad,
}: {
  value: number;
  onChange: (n: number) => void;
  min?: number;
  max?: number;
  step?: number;
  unidad: string;
}) {
  const [txt, setTxt] = useState(String(value));

  // Solo si el valor cambió DESDE FUERA. La comparación por número y no por
  // texto es lo que deja el campo vacío en paz: `Number('')` es 0, así que
  // con el modelo en 0 no se considera un cambio y no se rellena solo.
  useEffect(() => {
    if (Number(txt) !== value) setTxt(String(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const escribir = (s: string) => {
    setTxt(s);
    const n = Number(s);
    if (s.trim() !== '' && Number.isFinite(n)) onChange(n);
  };

  const salir = () => {
    const n = Number(txt);
    const limpio =
      txt.trim() === '' || !Number.isFinite(n)
        ? min
        : Math.min(max ?? Number.POSITIVE_INFINITY, Math.max(min, n));
    setTxt(String(limpio));
    onChange(limpio);
  };

  return (
    <div className="relative">
      <input
        type="number"
        min={min}
        max={max}
        step={step}
        value={txt}
        onChange={(e) => escribir(e.target.value)}
        onBlur={salir}
        // Fuera las flechitas del navegador: se montan justo encima de la
        // unidad y dejan el campo ilegible. Subir y bajar de 100 en 100 no
        // le hace falta a nadie aquí.
        className={`${INPUT} pr-9 tabular-nums [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none`}
      />
      <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-[10px] text-slate-400">
        {unidad}
      </span>
    </div>
  );
}

function BotonFila({
  onClick,
  disabled,
  icono,
  label,
  titulo,
  destacado,
  peligro,
}: {
  onClick: () => void;
  disabled?: boolean;
  icono: React.ReactNode;
  label: string;
  titulo: string;
  destacado?: boolean;
  peligro?: boolean;
}) {
  const base =
    'flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-[11px] font-semibold outline-none transition ' +
    'focus-visible:ring-2 disabled:cursor-not-allowed disabled:opacity-35';
  const color = destacado
    ? 'bg-siemens text-white hover:bg-siemens-600 focus-visible:ring-siemens/50'
    : peligro
      ? 'text-slate-400 hover:bg-state-error/10 hover:text-state-error focus-visible:ring-state-error/40'
      : 'border border-slate-200 text-slate-600 hover:bg-slate-50 focus-visible:ring-siemens/40 dark:border-navy-slate dark:text-slate-300 dark:hover:bg-navy-slate/40';

  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={titulo}
      aria-label={label || titulo}
      className={`${base} ${color}`}
    >
      {icono}
      {label}
    </button>
  );
}

function ChipEstado({ estado }: { estado: Grabacion['estado'] }) {
  const mapa = {
    grabando: {
      texto: 'Grabando',
      clase: 'bg-state-ok/10 text-state-ok',
      icono: <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-state-ok" />,
    },
    terminada: {
      texto: 'Terminada',
      clase: 'bg-slate-100 text-slate-500 dark:bg-navy-slate dark:text-slate-400',
      icono: <CheckCircle2Icon className="h-3 w-3" />,
    },
    detenida: {
      texto: 'Detenida',
      clase: 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
      icono: <SquareIcon className="h-2.5 w-2.5" />,
    },
  }[estado];

  return (
    <span
      className={`flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${mapa.clase}`}
    >
      {mapa.icono}
      {mapa.texto}
    </span>
  );
}

function Dato({ n, l }: { n: string; l: string }) {
  return (
    <span className="flex items-baseline gap-1">
      <span className="font-semibold tabular-nums text-navy dark:text-slate-200">{n}</span>
      <span className="text-slate-400">{l}</span>
    </span>
  );
}

function Fuerte({ children }: { children: React.ReactNode }) {
  return (
    <span className="font-semibold tabular-nums text-navy dark:text-slate-200">{children}</span>
  );
}

function Nota({ tipo, children }: { tipo: 'error' | 'aviso'; children: React.ReactNode }) {
  const error = tipo === 'error';
  return (
    <div
      className={`flex items-start gap-2 rounded-lg px-3 py-2 text-[11px] leading-snug ${
        error
          ? 'bg-state-error/10 text-state-error'
          : 'bg-amber-500/10 text-amber-700 dark:text-amber-400'
      }`}
    >
      {error ? (
        <AlertCircleIcon className="mt-px h-3.5 w-3.5 shrink-0" />
      ) : (
        <TriangleAlertIcon className="mt-px h-3.5 w-3.5 shrink-0" />
      )}
      <span className="min-w-0">{children}</span>
    </div>
  );
}

function Centro({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center px-4 py-10 text-center">
      {children}
    </div>
  );
}

/** Un valor del PLC, corto. Los decimales largos rompen la columna. */
function formateaValor(v: any): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'boolean') return v ? 'ON' : 'OFF';
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(2);
  return String(v);
}
