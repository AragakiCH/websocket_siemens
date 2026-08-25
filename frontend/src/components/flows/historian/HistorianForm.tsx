import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  RefreshCwIcon,
  SearchIcon,
  AlertTriangleIcon,
  Loader2Icon,
  PencilIcon,
  ListChecksIcon,
} from 'lucide-react';
import { FlowNodeData } from '../types';
import {
  ConexionRemota,
  TagRemoto,
  cargarConexiones,
  cargarTags,
  claveTag,
} from '../api';

interface Props {
  config: Record<string, any>;
  connectionNodes: FlowNodeData[];
  onChange: (patch: Record<string, any>) => void;
}

type ModoTags = 'todos' | 'seleccion';

/** Una conexión ofrecible en el select, venga de donde venga. */
interface OpcionConexion {
  db_id: string;
  etiqueta: string;
  /** `true` en el servidor, `false` solo dibujada, `null` no se sabe. */
  conectado: boolean | null;
  origen: 'servidor' | 'lienzo' | 'desconocida';
  error?: string;
}

export function HistorianForm({ config, connectionNodes, onChange }: Props) {
  // Modo de selección de tags. Los nodos creados antes de esta pantalla no
  // tienen `modo_tags`, así que se deduce: si traían tags, era una selección.
  const modo: ModoTags =
    config.modo_tags ?? ((config.tags || []).length > 0 ? 'seleccion' : 'todos');

  const seleccion: string[] = Array.isArray(config.tags) ? config.tags : [];
  const seleccionSet = useMemo(() => new Set(seleccion), [seleccion]);

  // ── Conexiones reales (GET /db) ───────────────────────────────
  const [conexiones, setConexiones] = useState<ConexionRemota[]>([]);
  const [cargandoConex, setCargandoConex] = useState(false);
  const [errorConex, setErrorConex] = useState('');

  const recargarConexiones = useCallback(async () => {
    setCargandoConex(true);
    setErrorConex('');
    try {
      setConexiones(await cargarConexiones());
    } catch (err: any) {
      setErrorConex(err?.message || 'No se pudieron cargar las conexiones.');
      setConexiones([]);
    } finally {
      setCargandoConex(false);
    }
  }, []);

  useEffect(() => { recargarConexiones(); }, [recargarConexiones]);

  /**
   * Fusiona tres orígenes, en este orden de prioridad:
   *   1. Lo que el backend tiene guardado (`GET /db`) — la verdad.
   *   2. Nodos Conexión del lienzo con `db_id` puesto pero aún sin Guardar.
   *      Sin esto se rompe el flujo natural: dibujas la conexión, dibujas el
   *      historian, y quieres elegirla ANTES de guardar la primera.
   *   3. El `db_id` que ya tenía el nodo, si no aparece en ninguno de los dos.
   *      Si no se añadiera, el <select> se vería vacío y parecería que se
   *      borró solo.
   *
   * Los nodos del lienzo SIN `db_id` se descartan a propósito: antes se
   * ofrecían con `value={n.id}`, que mandaba el id interno del nodo
   * (`connection_1787…`) al backend y siempre fallaba.
   */
  const opciones = useMemo<OpcionConexion[]>(() => {
    const mapa = new Map<string, OpcionConexion>();

    for (const c of conexiones) {
      mapa.set(c.db_id, {
        db_id: c.db_id,
        etiqueta: `${c.db_id}${c.nombre && c.nombre !== c.db_id ? ` · ${c.nombre}` : ''} (${c.motor})`,
        conectado: c.conectado,
        origen: 'servidor',
        error: c.ultimo_error,
      });
    }

    for (const n of connectionNodes) {
      const id = (n.config?.db_id || '').trim();
      if (!id || mapa.has(id)) continue;
      mapa.set(id, {
        db_id: id,
        etiqueta: `${id} (${n.config?.motor || '?'})`,
        conectado: null,
        origen: 'lienzo',
      });
    }

    const actual = (config.db_id || '').trim();
    if (actual && !mapa.has(actual)) {
      mapa.set(actual, {
        db_id: actual, etiqueta: actual, conectado: null, origen: 'desconocida',
      });
    }

    return Array.from(mapa.values());
  }, [conexiones, connectionNodes, config.db_id]);

  const delServidor = opciones.filter((o) => o.origen === 'servidor');
  const delLienzo = opciones.filter((o) => o.origen === 'lienzo');
  const desconocidas = opciones.filter((o) => o.origen === 'desconocida');
  const conexionActual = opciones.find((o) => o.db_id === (config.db_id || '').trim());

  // ── Tags disponibles (GET /tags) ──────────────────────────────
  const [disponibles, setDisponibles] = useState<TagRemoto[]>([]);
  const [cargando, setCargando] = useState(false);
  const [errorTags, setErrorTags] = useState('');
  const [yaCargado, setYaCargado] = useState(false);
  const [filtro, setFiltro] = useState('');
  const [manual, setManual] = useState(false);

  const recargar = useCallback(async () => {
    setCargando(true);
    setErrorTags('');
    try {
      setDisponibles(await cargarTags());
    } catch (err: any) {
      setErrorTags(err?.message || 'No se pudieron cargar los tags.');
      setDisponibles([]);
    } finally {
      setCargando(false);
      setYaCargado(true);
    }
  }, []);

  // Se cargan al entrar en modo selección, una sola vez (el botón recarga).
  useEffect(() => {
    if (modo === 'seleccion' && !yaCargado && !cargando) recargar();
  }, [modo, yaCargado, cargando, recargar]);

  const cambiarModo = (nuevo: ModoTags) => {
    // La selección NO se borra al pasar a "todos": si el usuario vuelve,
    // encuentra sus tags como los dejó. Lo que se manda al backend lo decide
    // `modo_tags` en FlowConfigPanel.
    onChange({ modo_tags: nuevo });
  };

  const alternarTag = (clave: string) => {
    const nueva = seleccionSet.has(clave)
      ? seleccion.filter((c) => c !== clave)
      : [...seleccion, clave];
    onChange({ tags: nueva });
  };

  // ── Agrupación por PLC + filtro ───────────────────────────────
  const grupos = useMemo(() => {
    const texto = filtro.trim().toLowerCase();
    const porPlc = new Map<string, TagRemoto[]>();
    for (const t of disponibles) {
      if (texto && !`${t.plc} ${t.tag}`.toLowerCase().includes(texto)) continue;
      const lista = porPlc.get(t.plc);
      if (lista) lista.push(t);
      else porPlc.set(t.plc, [t]);
    }
    return Array.from(porPlc.entries());
  }, [disponibles, filtro]);

  // Tags guardados que YA no existen en ningún PLC: o el PLC está caído, o hay
  // un typo. El backend no avisa de esto (`interesa()` simplemente no matchea
  // y el grupo guarda cero filas), así que hay que decirlo acá.
  const huerfanos = useMemo(() => {
    if (!yaCargado || disponibles.length === 0) return [];
    const existentes = new Set(disponibles.map(claveTag));
    return seleccion.filter((c) => !existentes.has(c));
  }, [seleccion, disponibles, yaCargado]);

  const seleccionarGrupo = (tags: TagRemoto[], marcar: boolean) => {
    const claves = tags.map(claveTag);
    const nueva = marcar
      ? Array.from(new Set([...seleccion, ...claves]))
      : seleccion.filter((c) => !claves.includes(c));
    onChange({ tags: nueva });
  };

  return (
    <div className="space-y-3">
      {/* grupo_id */}
      <Field label="ID Grupo" required>
        <input
          type="text"
          value={config.grupo_id || ''}
          onChange={(e) => onChange({ grupo_id: e.target.value })}
          placeholder="ej: proceso"
          className="input-field"
        />
      </Field>

      {/* db_id — conexiones reales del backend + las dibujadas en el lienzo */}
      <Field label="Conexión BD" required>
        <div className="flex items-center gap-1.5">
          {opciones.length > 0 ? (
            <select
              value={config.db_id || ''}
              onChange={(e) => onChange({ db_id: e.target.value })}
              className="input-field flex-1"
            >
              <option value="">— Seleccionar —</option>
              {delServidor.length > 0 && (
                <optgroup label="En el servidor">
                  {delServidor.map((o) => (
                    <option key={o.db_id} value={o.db_id}>{o.etiqueta}</option>
                  ))}
                </optgroup>
              )}
              {delLienzo.length > 0 && (
                <optgroup label="En el lienzo (sin guardar)">
                  {delLienzo.map((o) => (
                    <option key={o.db_id} value={o.db_id}>{o.etiqueta}</option>
                  ))}
                </optgroup>
              )}
              {desconocidas.length > 0 && (
                <optgroup label="No está en el servidor">
                  {desconocidas.map((o) => (
                    <option key={o.db_id} value={o.db_id}>{o.etiqueta}</option>
                  ))}
                </optgroup>
              )}
            </select>
          ) : (
            <input
              type="text"
              value={config.db_id || ''}
              onChange={(e) => onChange({ db_id: e.target.value })}
              placeholder="ID de conexión (POST /db)"
              className="input-field flex-1"
            />
          )}
          <button
            type="button"
            onClick={recargarConexiones}
            disabled={cargandoConex}
            title="Recargar desde GET /db"
            className="shrink-0 rounded-md p-1.5 text-slate-400 transition hover:bg-slate-100 hover:text-siemens disabled:opacity-40 dark:hover:bg-navy-slate/40"
          >
            {cargandoConex
              ? <Loader2Icon className="h-3.5 w-3.5 animate-spin" />
              : <RefreshCwIcon className="h-3.5 w-3.5" />}
          </button>
        </div>

        {/* Estado de la conexión elegida */}
        {conexionActual && (
          <div className="mt-1 flex items-start gap-1.5 text-[10px]">
            <span
              className={`mt-1 h-1.5 w-1.5 shrink-0 rounded-full ${
                conexionActual.conectado === true
                  ? 'bg-green-500'
                  : conexionActual.conectado === false
                  ? 'bg-red-500'
                  : 'bg-slate-300 dark:bg-slate-600'
              }`}
            />
            <span className="min-w-0 break-words text-slate-500 dark:text-slate-400">
              {conexionActual.origen === 'lienzo' && 'Dibujada en el lienzo, todavía no guardada en el servidor.'}
              {conexionActual.origen === 'desconocida' && 'El servidor no conoce este db_id — el historizador lo rechazará.'}
              {conexionActual.origen === 'servidor' && (
                conexionActual.conectado ? 'Conectada.' : 'Guardada, pero el pool no está abierto.'
              )}
            </span>
          </div>
        )}

        {conexionActual?.error && (
          <p className="mt-1 break-words text-[10px] text-red-500">
            {conexionActual.error}
          </p>
        )}

        {errorConex && (
          <p className="mt-1 break-words text-[10px] text-amber-500">
            No se pudo leer GET /db ({errorConex}). Se muestran solo las del lienzo.
          </p>
        )}
      </Field>

      {/* ── Tags: dos modos ───────────────────────────────────── */}
      <Field label="Tags a historizar">
        <div className="grid grid-cols-2 gap-1">
          <button
            type="button"
            onClick={() => cambiarModo('todos')}
            className={`rounded-md px-2 py-1.5 text-[11px] font-medium transition ${
              modo === 'todos'
                ? 'bg-siemens text-white'
                : 'bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-navy-slate/40 dark:text-slate-400 dark:hover:bg-navy-slate/60'
            }`}
          >
            Todos los tags
          </button>
          <button
            type="button"
            onClick={() => cambiarModo('seleccion')}
            className={`rounded-md px-2 py-1.5 text-[11px] font-medium transition ${
              modo === 'seleccion'
                ? 'bg-siemens text-white'
                : 'bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-navy-slate/40 dark:text-slate-400 dark:hover:bg-navy-slate/60'
            }`}
          >
            Seleccionar
          </button>
        </div>
      </Field>

      {/* ── Modo TODOS ────────────────────────────────────────── */}
      {modo === 'todos' && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 dark:border-amber-500/20 dark:bg-amber-500/5">
          <div className="flex gap-2">
            <AlertTriangleIcon className="mt-px h-3.5 w-3.5 shrink-0 text-amber-500" />
            <div className="min-w-0 space-y-1 text-[11px] text-amber-700 dark:text-amber-400">
              <p className="font-semibold">Se guardará cada cambio de todos los tags.</p>
              <p>
                Se envía <code className="font-mono">tags: []</code>, que para el
                backend significa <b>todos los tags de todos los PLCs</b> —
                incluidos los PLCs que agregues después.
              </p>
              <p>
                Un tag que cambia cada 100 ms genera ~864.000 filas al día. Si el
                volumen se dispara, usa banda muerta o intervalo mínimo abajo.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* ── Modo SELECCIÓN ────────────────────────────────────── */}
      {modo === 'seleccion' && (
        <div className="space-y-2">
          {/* Barra de acciones */}
          <div className="flex items-center gap-1.5">
            <div className="relative flex-1">
              <SearchIcon className="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-slate-400" />
              <input
                type="text"
                value={filtro}
                onChange={(e) => setFiltro(e.target.value)}
                placeholder="Filtrar…"
                className="input-field !pl-7 text-[11px]"
              />
            </div>
            <button
              type="button"
              onClick={recargar}
              disabled={cargando}
              title="Recargar desde GET /tags"
              className="rounded-md p-1.5 text-slate-400 transition hover:bg-slate-100 hover:text-siemens disabled:opacity-40 dark:hover:bg-navy-slate/40"
            >
              {cargando
                ? <Loader2Icon className="h-3.5 w-3.5 animate-spin" />
                : <RefreshCwIcon className="h-3.5 w-3.5" />}
            </button>
            <button
              type="button"
              onClick={() => setManual((m) => !m)}
              title={manual ? 'Volver a la lista' : 'Escribir tags a mano'}
              className={`rounded-md p-1.5 transition hover:bg-slate-100 dark:hover:bg-navy-slate/40 ${
                manual ? 'text-siemens' : 'text-slate-400 hover:text-siemens'
              }`}
            >
              {manual
                ? <ListChecksIcon className="h-3.5 w-3.5" />
                : <PencilIcon className="h-3.5 w-3.5" />}
            </button>
          </div>

          {/* Entrada manual (fallback) */}
          {manual ? (
            <>
              <textarea
                value={seleccion.join('\n')}
                onChange={(e) =>
                  onChange({ tags: e.target.value.split('\n').filter((l) => l.trim()) })
                }
                placeholder={'192.168.50.1|DB_snap7.temperatura\n192.168.100.31|PLC_PRG.AI_Sensor_mA'}
                rows={5}
                className="input-field resize-none font-mono text-[11px]"
              />
              <p className="text-[10px] text-slate-400">
                Formato <code className="font-mono">plc_id|tag</code>, uno por línea.
              </p>
            </>
          ) : (
            <>
              {/* Estados de carga / error / vacío */}
              {cargando && (
                <p className="flex items-center gap-1.5 py-2 text-[11px] text-slate-400">
                  <Loader2Icon className="h-3 w-3 animate-spin" />
                  Cargando tags…
                </p>
              )}

              {!cargando && errorTags && (
                <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[11px] text-red-600 dark:border-red-500/20 dark:bg-red-500/5 dark:text-red-400">
                  <p className="whitespace-pre-wrap break-words">{errorTags}</p>
                </div>
              )}

              {!cargando && !errorTags && disponibles.length === 0 && yaCargado && (
                <div className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-[11px] text-slate-500 dark:border-navy-slate dark:bg-navy-slate/30 dark:text-slate-400">
                  <p className="font-medium">Ningún PLC ha publicado tags todavía.</p>
                  <p className="mt-1">
                    La lista se llena tras un browse OPC UA exitoso. Conecta un PLC
                    y recarga, o escríbelos a mano con el lápiz.
                  </p>
                </div>
              )}

              {/* Lista agrupada por PLC */}
              {!cargando && grupos.length > 0 && (
                <div className="mp-scroll max-h-64 space-y-2 overflow-y-auto rounded-lg border border-slate-200 p-2 dark:border-navy-slate">
                  {grupos.map(([plc, tags]) => {
                    const marcados = tags.filter((t) => seleccionSet.has(claveTag(t))).length;
                    const todos = marcados === tags.length;
                    return (
                      <div key={plc}>
                        <div className="mb-1 flex items-center justify-between gap-2">
                          <p className="truncate text-[10px] font-bold uppercase tracking-wider text-slate-400">
                            {plc}
                          </p>
                          <button
                            type="button"
                            onClick={() => seleccionarGrupo(tags, !todos)}
                            className="shrink-0 text-[10px] font-medium text-siemens hover:underline"
                          >
                            {todos ? 'ninguno' : 'todos'} ({marcados}/{tags.length})
                          </button>
                        </div>
                        {tags.map((t) => {
                          const clave = claveTag(t);
                          return (
                            <label
                              key={clave}
                              title={clave}
                              className="flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 hover:bg-slate-50 dark:hover:bg-navy-slate/30"
                            >
                              <input
                                type="checkbox"
                                checked={seleccionSet.has(clave)}
                                onChange={() => alternarTag(clave)}
                                className="shrink-0 rounded border-slate-300 text-siemens focus:ring-siemens"
                              />
                              <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-slate-600 dark:text-slate-300">
                                {t.tag}
                              </span>
                              {t.type && (
                                <span className="shrink-0 text-[9px] text-slate-400">
                                  {t.type}
                                </span>
                              )}
                            </label>
                          );
                        })}
                      </div>
                    );
                  })}
                </div>
              )}

              {!cargando && disponibles.length > 0 && grupos.length === 0 && (
                <p className="py-2 text-center text-[11px] text-slate-400">
                  Ningún tag coincide con «{filtro}».
                </p>
              )}
            </>
          )}

          {/* Tags seleccionados que ya no existen */}
          {huerfanos.length > 0 && (
            <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-700 dark:border-amber-500/20 dark:bg-amber-500/5 dark:text-amber-400">
              <p className="font-semibold">
                {huerfanos.length} tag(s) que ningún PLC publica:
              </p>
              <ul className="mt-1 space-y-0.5">
                {huerfanos.map((c) => (
                  <li key={c} className="flex items-center justify-between gap-2">
                    <span className="min-w-0 truncate font-mono text-[10px]">{c}</span>
                    <button
                      type="button"
                      onClick={() => alternarTag(c)}
                      className="shrink-0 text-[10px] font-medium hover:underline"
                    >
                      quitar
                    </button>
                  </li>
                ))}
              </ul>
              <p className="mt-1">
                O el PLC está desconectado, o hay un typo. El backend no avisa:
                simplemente nunca coinciden y no se guarda nada.
              </p>
            </div>
          )}

          {/* Contador */}
          <p
            className={`text-[11px] font-medium ${
              seleccion.length === 0 ? 'text-red-500' : 'text-slate-500 dark:text-slate-400'
            }`}
          >
            {seleccion.length === 0
              ? 'Sin tags seleccionados — marca al menos uno para poder guardar.'
              : `${seleccion.length} tag(s) seleccionado(s).`}
          </p>
        </div>
      )}

      {/* Tabla */}
      <Field label="Tabla destino">
        <input
          type="text"
          value={config.tabla || 'historico_tags'}
          onChange={(e) => onChange({ tabla: e.target.value })}
          className="input-field"
        />
      </Field>

      {/* Nombre */}
      <Field label="Nombre (etiqueta)">
        <input
          type="text"
          value={config.nombre || ''}
          onChange={(e) => onChange({ nombre: e.target.value })}
          placeholder="Opcional"
          className="input-field"
        />
      </Field>

      {/* Banda muerta */}
      <Field label="Banda muerta">
        <input
          type="number"
          value={config.banda_muerta ?? 0}
          onChange={(e) => onChange({ banda_muerta: parseFloat(e.target.value) || 0 })}
          min={0}
          step={0.1}
          className="input-field"
        />
        <p className="mt-0.5 text-[10px] text-slate-400">
          0 = desactivada. Ignora cambios menores a este valor.
        </p>
      </Field>

      {/* Intervalo mínimo */}
      <Field label="Intervalo mínimo (ms)">
        <input
          type="number"
          value={config.intervalo_min_ms ?? 0}
          onChange={(e) => onChange({ intervalo_min_ms: parseInt(e.target.value) || 0 })}
          min={0}
          step={100}
          className="input-field"
        />
        <p className="mt-0.5 text-[10px] text-slate-400">
          0 = sin límite. Con 1000, máx 1 fila/seg por tag.
        </p>
      </Field>

      {/* Activo */}
      <label className="flex items-center gap-2 text-xs text-slate-600 dark:text-slate-400">
        <input
          type="checkbox"
          checked={config.activo ?? true}
          onChange={(e) => onChange({ activo: e.target.checked })}
          className="rounded border-slate-300 text-siemens focus:ring-siemens"
        />
        Iniciar captura inmediatamente
      </label>
    </div>
  );
}

function Field({ label, required, children }: { label: string; required?: boolean; children: React.ReactNode }) {
  return (
    <div>
      <label className="mb-1 block text-[11px] font-semibold text-slate-500 dark:text-slate-400">
        {label}
        {required && <span className="ml-0.5 text-red-400">*</span>}
      </label>
      {children}
    </div>
  );
}
