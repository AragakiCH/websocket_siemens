// =========================================================================
// Alarmas.tsx
// Las alarmas pendientes, DENTRO del lienzo.
//
// QUÉ HUECO LLENA
// Hasta ahora las alarmas se veían en tres sitios: la franja de arriba (solo
// la peor), la pantalla de Alarmas (todas, fuera del HMI) y un contador en el
// menú. Ninguno vive en la pantalla que el operador mira: quien diseña la
// sinóptica de la Línea 2 no podía poner "las alarmas de la Línea 2" al lado
// de sus válvulas. Este widget es eso: una lista que se coloca, se estira y
// se filtra como cualquier otro widget.
//
// NO REINVENTA NADA
// Consume `/alarmas/pendientes` con los mismos helpers que la franja y la
// pantalla de Alarmas (`alarmasRuntimeApi`): mismos colores por severidad,
// mismo "hace X", misma regla de qué es pendiente. Si mañana cambia el orden
// o el significado de "pendiente" en el backend, aquí cambia solo.
//
// DE DÓNDE SALEN LOS DATOS, Y POR QUÉ ASÍ
// Una lectura al montar y, a partir de ahí, los eventos del WebSocket que ya
// está abierto (`alarma.activada` / `normalizada` / `reconocida`). Sin
// polling, igual que la franja: con cinco pantallas y tres widgets en cada
// una, preguntar cada dos segundos serían cientos de consultas por minuto a
// la base para recibir lo mismo casi siempre. Al recibir un evento se RECARGA
// la lista en vez de tocarla en memoria, por el mismo motivo que allí: las
// reglas de qué es pendiente y en qué orden son del backend.
//
// EL FILTRO ES LO QUE LO HACE ÚTIL EN UNA PANTALLA
// Sin filtro sería la pantalla de Alarmas en pequeño. Con él, cada pantalla
// enseña lo suyo: por área (la que se escribe en la definición de la alarma),
// por texto del tag (para acotar a una máquina) y por gravedad mínima. Se
// filtra aquí, sobre la respuesta, y no con parámetros al servidor: el
// endpoint no los tiene, la lista pendiente es corta por definición, y así
// un filtro nuevo no obliga a tocar el backend.
//
// RECONOCER SOLO EN LA VISTA PREVIA
// En el Diseñador el botón se ve pero no hace nada (`interactivo` = false):
// allí el clic sirve para seleccionar y mover el widget, y reconocer una
// alarma de planta desde el editor por accidente sería un fallo serio. El
// backend además exige rol para firmar el reconocimiento; si falta, se dice
// en el propio widget en vez de fallar en silencio.
// =========================================================================
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  BellRingIcon,
  CheckIcon,
  CheckCircle2Icon,
  Loader2Icon,
} from 'lucide-react';
import type { CustomWidgetDef, RenderCtx, InspectorCtx } from '../types';
import { estiloDeParte } from '../../partes';
import {
  alRecibirAlarma,
  fetchPendientes,
  haceCuanto,
  partesTag,
  reconocer as apiReconocer,
  tonoSeveridad,
  CLASE_DE_SEVERIDAD,
  type EventoAlarma,
  type Pendientes,
} from '../../../../services/alarmasRuntimeApi';

// ─── Config ──────────────────────────────────────────────────────

export interface ConfigAlarmas {
  /** Cabecera del widget. Vacío = sin cabecera (solo la lista). */
  titulo: string;
  /** `lista` = las alarmas una a una; `resumen` = un contador con la peor. */
  modo: 'lista' | 'resumen';
  /** Cuántas filas se enseñan como mucho. El resto se cuenta al pie. */
  maximo: number;
  /**
   * Gravedad más leve que se enseña: 1 = solo críticas … 5 = todas.
   * Se llama "máxima" porque el número de severidad crece cuanto MENOS grave
   * es (1 = Critical, 5 = Information), igual que en la definición.
   */
  severidadMaxima: number;
  /** Solo alarmas de esta área (la de su definición). Vacío = todas. */
  area: string;
  /** Solo alarmas cuyo tag contenga este texto. Vacío = todas. */
  tag: string;
  /** Botón para reconocer cada alarma (solo funciona en la vista previa). */
  reconocer: boolean;
  /** Enseñar "hace 3 min" en cada fila. */
  hora: boolean;
}

export const CONFIG_ALARMAS: ConfigAlarmas = {
  titulo: 'Alarmas',
  modo: 'lista',
  maximo: 8,
  severidadMaxima: 5,
  area: '',
  tag: '',
  reconocer: true,
  hora: true,
};

export function leerConfigAlarmas(config: any): ConfigAlarmas {
  const c = config ?? {};
  const entero = (v: any, def: number, min: number, max: number) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.round(n))) : def;
  };
  return {
    titulo: typeof c.titulo === 'string' ? c.titulo : CONFIG_ALARMAS.titulo,
    modo: c.modo === 'resumen' ? 'resumen' : 'lista',
    maximo: entero(c.maximo, CONFIG_ALARMAS.maximo, 1, 50),
    severidadMaxima: entero(c.severidadMaxima, 5, 1, 5),
    area: typeof c.area === 'string' ? c.area : '',
    tag: typeof c.tag === 'string' ? c.tag : '',
    reconocer: c.reconocer !== false,
    hora: c.hora !== false,
  };
}

/** Las que pasan el filtro del widget, en el orden en que llegaron. */
function filtrar(alarmas: EventoAlarma[], cfg: ConfigAlarmas): EventoAlarma[] {
  const area = cfg.area.trim().toLowerCase();
  const tag = cfg.tag.trim().toLowerCase();
  return alarmas.filter((a) => {
    if (a.severidad > cfg.severidadMaxima) return false;
    if (area && (a.area ?? '').trim().toLowerCase() !== area) return false;
    if (tag && !(a.tag ?? '').toLowerCase().includes(tag)) return false;
    return true;
  });
}

// ─── Datos ───────────────────────────────────────────────────────

type Estado = 'cargando' | 'ok' | 'error';

/**
 * La lista de pendientes, viva.
 *
 * Es un hook y no una llamada dentro del render porque el widget tiene
 * ciclo de vida propio: se suscribe al WebSocket al montar y se da de baja al
 * desmontar. Sin la baja, cada vez que se cambia de pantalla quedaría un
 * listener más y el mismo evento recargaría N veces.
 */
function usePendientes(): {
  datos: Pendientes | null;
  estado: Estado;
  refrescar: () => Promise<void>;
} {
  const [datos, setDatos] = useState<Pendientes | null>(null);
  const [estado, setEstado] = useState<Estado>('cargando');

  const refrescar = useCallback(async () => {
    try {
      // 200 = el tope del endpoint. Se filtra aquí, así que hay que traer
      // todo lo pendiente: un widget que solo quiere las de "Envasado" no
      // puede saber cuántas del principio de la lista son de otra área.
      setDatos(await fetchPendientes(200));
      setEstado('ok');
    } catch {
      // No se enseña el motivo dentro del widget: el HMI es del operador, y
      // la pantalla de Alarmas ya explica si el motor está apagado o la base
      // no responde. Aquí basta con que no parezca que "no hay alarmas".
      setEstado('error');
    }
  }, []);

  useEffect(() => {
    void refrescar();
    return alRecibirAlarma(() => {
      void refrescar();
    });
  }, [refrescar]);

  return { datos, estado, refrescar };
}

// ─── Dibujo ──────────────────────────────────────────────────────

function WidgetAlarmas({ widget, interactivo }: RenderCtx) {
  const cfg = leerConfigAlarmas(widget.config);
  const pCaja = estiloDeParte(widget, 'box');
  const pTitulo = estiloDeParte(widget, 'valor');
  const pTexto = estiloDeParte(widget, 'label');

  const { datos, estado, refrescar } = usePendientes();
  const [ocupada, setOcupada] = useState<number | null>(null);
  const [aviso, setAviso] = useState('');

  // El "hace X" se queda congelado si nadie vuelve a dibujar. Medio minuto
  // basta: la unidad más fina que se enseña son los segundos.
  const [, tick] = useState(0);
  useEffect(() => {
    const t = window.setInterval(() => tick((n) => n + 1), 30000);
    return () => window.clearInterval(t);
  }, []);

  const filtradas = useMemo(
    () => filtrar(datos?.alarmas ?? [], cfg),
    // Se recalcula con lo que de verdad cambia el resultado, no con el
    // objeto `cfg` (que es nuevo en cada render).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [datos, cfg.severidadMaxima, cfg.area, cfg.tag]
  );

  const reconocerUna = async (a: EventoAlarma) => {
    if (!interactivo || ocupada !== null) return;
    setOcupada(a.id);
    setAviso('');
    try {
      await apiReconocer(a.id);
      await refrescar();
    } catch (e: any) {
      setAviso(
        e?.status === 403
          ? 'Tu usuario no puede reconocer alarmas.'
          : e?.status === 401
            ? 'Inicia sesión para reconocer.'
            : 'No se pudo reconocer. Inténtalo de nuevo.'
      );
    } finally {
      setOcupada(null);
    }
  };

  // Sin fondo ni borde configurados se dibuja una superficie tenue, por el
  // mismo motivo que el Valor con Unidad: una lista sin caja no se distingue
  // del lienzo. En cuanto pones algo en Apariencia → Caja, manda lo tuyo.
  const sinCaja = pCaja.background === 'transparent' && !pCaja.borderWidth;
  const tamTexto = pTexto.fontSize ?? 12;
  const tamTitulo = pTitulo.fontSize ?? Math.round(tamTexto * 1.1);

  const peor = filtradas[0] ?? null;
  const visibles = filtradas.slice(0, cfg.maximo);
  const ocultas = filtradas.length - visibles.length;

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        width: '100%',
        height: '100%',
        boxSizing: 'border-box',
        overflow: 'hidden',
        borderRadius: pCaja.borderRadius,
        background: sinCaja ? 'rgba(148,163,184,0.10)' : undefined,
        border: sinCaja ? '1px solid rgba(148,163,184,0.32)' : undefined,
        fontFamily: 'Inter, Arial, sans-serif',
        color: pTexto.color,
        fontSize: tamTexto,
        lineHeight: 1.25,
      }}
    >
      {/* ── Cabecera ────────────────────────────────────── */}
      {!!cfg.titulo.trim() && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '6px 10px',
            borderBottom: '1px solid rgba(148,163,184,0.25)',
            flexShrink: 0,
          }}
        >
          <BellRingIcon
            style={{ width: tamTitulo, height: tamTitulo, flexShrink: 0 }}
            className={peor ? tonoSeveridad(peor.severidad).texto : ''}
          />
          <span
            style={{
              fontSize: tamTitulo,
              fontWeight: pTitulo.bold === false ? 500 : 700,
              color: pTitulo.color,
              flex: 1,
              minWidth: 0,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              textAlign: pTitulo.align ?? 'left',
            }}
          >
            {cfg.titulo}
          </span>
          {estado === 'ok' && (
            <Contador n={filtradas.length} severidad={peor?.severidad ?? 5} />
          )}
        </div>
      )}

      {/* ── Cuerpo ──────────────────────────────────────── */}
      {estado === 'cargando' && !datos ? (
        <Centro>
          <Loader2Icon className="animate-spin" style={{ width: 16, height: 16, opacity: 0.6 }} />
        </Centro>
      ) : estado === 'error' ? (
        <Centro>
          <span style={{ opacity: 0.6 }}>Alarmas no disponibles</span>
        </Centro>
      ) : filtradas.length === 0 ? (
        <Centro>
          <CheckCircle2Icon className="text-state-ok" style={{ width: 18, height: 18 }} />
          <span style={{ opacity: 0.75 }}>Sin alarmas pendientes</span>
        </Centro>
      ) : cfg.modo === 'resumen' ? (
        <Resumen
          total={filtradas.length}
          peor={peor!}
          alto={widget.height}
          hora={cfg.hora}
          color={pTitulo.color}
        />
      ) : (
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }} className="mp-scroll mp-scroll-dark">
          {visibles.map((a) => (
            <Fila
              key={a.id}
              alarma={a}
              hora={cfg.hora}
              conBoton={cfg.reconocer}
              interactivo={!!interactivo}
              ocupada={ocupada === a.id}
              onReconocer={() => void reconocerUna(a)}
            />
          ))}
          {ocultas > 0 && (
            <div style={{ padding: '4px 10px', opacity: 0.6, fontSize: Math.max(10, tamTexto - 1) }}>
              +{ocultas} más
            </div>
          )}
        </div>
      )}

      {aviso && (
        <div
          role="alert"
          className="text-state-error"
          style={{
            padding: '4px 10px',
            fontSize: Math.max(10, tamTexto - 1),
            borderTop: '1px solid rgba(148,163,184,0.25)',
            flexShrink: 0,
          }}
        >
          {aviso}
        </div>
      )}
    </div>
  );
}

/** Contenido centrado en el hueco del cuerpo: estados vacíos y de carga. */
function Centro({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        flex: 1,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 6,
        padding: 8,
        textAlign: 'center',
      }}
    >
      {children}
    </div>
  );
}

/** El número de pendientes, con el color de la peor. */
function Contador({ n, severidad }: { n: number; severidad: number }) {
  const tono = tonoSeveridad(n > 0 ? severidad : 5);
  return (
    <span
      className={`${tono.fondo} ${tono.texto}`}
      style={{
        borderRadius: 999,
        padding: '1px 8px',
        fontSize: 11,
        fontWeight: 700,
        fontVariantNumeric: 'tabular-nums',
        flexShrink: 0,
      }}
    >
      {n}
    </span>
  );
}

/** Una alarma. La barra de la izquierda es la severidad: se lee sin leer. */
function Fila({
  alarma: a,
  hora,
  conBoton,
  interactivo,
  ocupada,
  onReconocer,
}: {
  alarma: EventoAlarma;
  hora: boolean;
  conBoton: boolean;
  interactivo: boolean;
  ocupada: boolean;
  onReconocer: () => void;
}) {
  const tono = tonoSeveridad(a.severidad);
  const { tag } = partesTag(a.tag);
  const detalles = [
    a.area?.trim() || '',
    tag,
    hora ? haceCuanto(a.ts_activacion) : '',
  ].filter(Boolean);

  return (
    <div
      title={`${CLASE_DE_SEVERIDAD[a.severidad] ?? ''} · ${a.mensaje}`}
      style={{
        display: 'flex',
        alignItems: 'stretch',
        gap: 8,
        padding: '5px 8px 5px 0',
        borderBottom: '1px solid rgba(148,163,184,0.15)',
      }}
    >
      <span className={tono.punto} style={{ width: 3, flexShrink: 0, borderRadius: 2 }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontWeight: 600,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {a.mensaje}
        </div>
        {detalles.length > 0 && (
          <div
            style={{
              opacity: 0.65,
              fontSize: '0.9em',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {detalles.join(' · ')}
          </div>
        )}
      </div>
      {conBoton && (
        <button
          type="button"
          onClick={onReconocer}
          disabled={!interactivo || ocupada}
          title={
            interactivo
              ? 'Reconocer esta alarma'
              : 'Se reconoce desde la vista previa, no desde el Diseñador'
          }
          aria-label="Reconocer"
          className="hover:bg-state-ok/15"
          style={{
            alignSelf: 'center',
            width: 24,
            height: 24,
            flexShrink: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius: 6,
            border: '1px solid rgba(148,163,184,0.35)',
            background: 'transparent',
            color: 'inherit',
            cursor: interactivo ? 'pointer' : 'default',
            opacity: interactivo ? 1 : 0.45,
          }}
        >
          {ocupada ? (
            <Loader2Icon className="animate-spin" style={{ width: 13, height: 13 }} />
          ) : (
            <CheckIcon style={{ width: 13, height: 13 }} />
          )}
        </button>
      )}
    </div>
  );
}

/**
 * Modo resumen: el número grande y la peor debajo.
 *
 * Para el rincón de una sinóptica donde no cabe una lista pero sí hace falta
 * saber que hay algo. El número crece con el alto del widget, como el Valor
 * con Unidad.
 */
function Resumen({
  total,
  peor,
  alto,
  hora,
  color,
}: {
  total: number;
  peor: EventoAlarma;
  alto: number;
  hora: boolean;
  color?: string;
}) {
  const tono = tonoSeveridad(peor.severidad);
  const tamNumero = Math.max(20, Math.min(72, Math.round(alto * 0.36)));
  return (
    <div
      style={{
        flex: 1,
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 2,
        padding: '4px 10px',
        textAlign: 'center',
      }}
    >
      <span
        className={tono.texto}
        style={{
          fontSize: tamNumero,
          fontWeight: 700,
          lineHeight: 1,
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {total}
      </span>
      <span style={{ opacity: 0.7, fontSize: '0.9em' }}>
        {total === 1 ? 'pendiente' : 'pendientes'}
      </span>
      <span
        style={{
          color,
          fontWeight: 600,
          maxWidth: '100%',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          marginTop: 4,
        }}
        title={peor.mensaje}
      >
        {peor.mensaje}
      </span>
      {hora && (
        <span style={{ opacity: 0.6, fontSize: '0.85em' }}>
          {haceCuanto(peor.ts_activacion)}
        </span>
      )}
    </div>
  );
}

// ─── Panel del Inspector ─────────────────────────────────────────

const CLASE_INPUT =
  'w-full rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-navy outline-none transition focus:border-siemens focus:ring-2 focus:ring-siemens/20 dark:border-navy-slate dark:bg-navy dark:text-slate-100';
const CLASE_ETIQUETA =
  'mb-1 block text-xs font-medium text-slate-500 dark:text-slate-400';
const CLASE_AYUDA = 'mt-1 block text-[10px] leading-relaxed text-slate-400';

function InspectorAlarmas({ config, setConfig }: InspectorCtx) {
  const cfg = leerConfigAlarmas(config);
  const poner = (cambio: Partial<ConfigAlarmas>) => setConfig({ ...cfg, ...cambio });

  return (
    <>
      <label className="block">
        <span className={CLASE_ETIQUETA}>Título</span>
        <input
          value={cfg.titulo}
          onChange={(e) => poner({ titulo: e.target.value })}
          placeholder="Alarmas"
          className={CLASE_INPUT}
        />
        <span className={CLASE_AYUDA}>Déjalo vacío para quitar la cabecera.</span>
      </label>

      <div>
        <span className={CLASE_ETIQUETA}>Modo</span>
        <div className="flex rounded-lg border border-slate-200 bg-slate-50 p-0.5 dark:border-navy-slate dark:bg-navy">
          {(['lista', 'resumen'] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => poner({ modo: m })}
              className={`flex-1 rounded-md px-2 py-1 text-xs font-semibold transition ${
                cfg.modo === m
                  ? 'bg-white text-navy shadow-sm dark:bg-navy-slate dark:text-slate-100'
                  : 'text-slate-400 hover:text-slate-600 dark:hover:text-slate-300'
              }`}
            >
              {m === 'lista' ? 'Lista' : 'Resumen'}
            </button>
          ))}
        </div>
        <span className={CLASE_AYUDA}>
          <b>Lista</b>: una fila por alarma. <b>Resumen</b>: el número de
          pendientes y la más grave, para un rincón pequeño.
        </span>
      </div>

      {cfg.modo === 'lista' && (
        <label className="block">
          <span className={CLASE_ETIQUETA}>Filas como mucho</span>
          <input
            type="number"
            min={1}
            max={50}
            value={cfg.maximo}
            onChange={(e) => poner({ maximo: Number(e.target.value) })}
            className={CLASE_INPUT}
          />
        </label>
      )}

      <label className="block">
        <span className={CLASE_ETIQUETA}>Gravedad</span>
        <select
          value={cfg.severidadMaxima}
          onChange={(e) => poner({ severidadMaxima: Number(e.target.value) })}
          className={CLASE_INPUT}
        >
          <option value={1}>Solo críticas</option>
          <option value={2}>Críticas y errores</option>
          <option value={3}>Hasta avisos (Warning)</option>
          <option value={4}>Hasta mantenimiento</option>
          <option value={5}>Todas</option>
        </select>
      </label>

      <label className="block">
        <span className={CLASE_ETIQUETA}>Solo del área</span>
        <input
          value={cfg.area}
          onChange={(e) => poner({ area: e.target.value })}
          placeholder="Envasado, Horno 2…"
          className={CLASE_INPUT}
        />
        <span className={CLASE_AYUDA}>
          El área que se escribe al definir la alarma. Vacío = todas.
        </span>
      </label>

      <label className="block">
        <span className={CLASE_ETIQUETA}>Solo tags que contengan</span>
        <input
          value={cfg.tag}
          onChange={(e) => poner({ tag: e.target.value })}
          placeholder="Bomba_1, Linea2…"
          className={CLASE_INPUT}
        />
        <span className={CLASE_AYUDA}>
          Para acotar a una máquina sin depender de que tenga área.
        </span>
      </label>

      <label className="flex items-center gap-2 text-xs text-slate-600 dark:text-slate-300">
        <input
          type="checkbox"
          checked={cfg.reconocer}
          onChange={(e) => poner({ reconocer: e.target.checked })}
          className="h-3.5 w-3.5 accent-siemens"
        />
        Botón para reconocer cada alarma
      </label>

      <label className="flex items-center gap-2 text-xs text-slate-600 dark:text-slate-300">
        <input
          type="checkbox"
          checked={cfg.hora}
          onChange={(e) => poner({ hora: e.target.checked })}
          className="h-3.5 w-3.5 accent-siemens"
        />
        Enseñar hace cuánto saltó
      </label>

      <div className="rounded-lg bg-slate-100 px-2.5 py-2 text-[11px] leading-relaxed text-slate-500 dark:bg-navy-slate/40 dark:text-slate-400">
        Reconocer solo funciona en la <b>vista previa</b>; en el Diseñador el
        botón se ve pero no actúa. El título se estiliza en{' '}
        <b>Apariencia → Título</b> y las filas en <b>Apariencia → Texto</b>.
      </div>
    </>
  );
}

// ─── Definición ──────────────────────────────────────────────────

export const alarmasWidget: CustomWidgetDef = {
  kind: 'custom:alarmas',
  label: 'Alarmas',
  category: 'Datos',
  icon: BellRingIcon,
  defaultWidth: 320,
  defaultHeight: 220,
  render: (ctx) => <WidgetAlarmas {...ctx} />,
  inspector: (ctx) => <InspectorAlarmas {...ctx} />,
  defaultConfig: CONFIG_ALARMAS,
};
