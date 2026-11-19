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
// QUÉ ENSEÑA CADA FILA
// Lo mismo que una tabla de alarmas de planta, en este orden:
//
//     SÍMBOLO – ID   FECHA   HORA   MENSAJE   USUARIO   ✓
//
// El símbolo es el de la clase y el ID el NÚMERO DE LA ALARMA —el que tiene
// en Configuración → Alarmas—, no el del evento. USUARIO es quién la
// reconoció: mientras siga en esta lista va vacío, porque lo que aquí se
// enseña es justamente lo que nadie ha reconocido todavía.
//
// Con sitio se pinta como tabla, con sus títulos. En un widget estrecho las
// columnas no caben, y los mismos datos pasan a dos líneas: el mensaje
// arriba y el resto debajo. No se pierde nada por hacerlo pequeño.
//
// EL BOTÓN «VER TODAS»
// Lleva a la pantalla de Alarmas (pendientes e histórico), como el de la
// franja de arriba. Desde allí, la flecha de volver devuelve a esta misma
// pantalla del HMI.
//
// RECONOCER Y NAVEGAR, SOLO EN LA VISTA PREVIA
// En el Diseñador los botones se ven pero no hacen nada (`interactivo` =
// false): allí el clic sirve para seleccionar y mover el widget, y reconocer
// una alarma de planta desde el editor por accidente sería un fallo serio.
// El backend además exige rol para firmar el reconocimiento; si falta, se
// dice en el propio widget en vez de fallar en silencio.
// =========================================================================
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import { useInRouterContext, useNavigate } from 'react-router-dom';
import {
  BellRingIcon,
  CheckIcon,
  CheckCircle2Icon,
  ChevronRightIcon,
  Loader2Icon,
} from 'lucide-react';
import type { CustomWidgetDef, RenderCtx, InspectorCtx } from '../types';
import { estiloDeParte } from '../../partes';
import { SimboloClase } from '../../../alarms/SimboloClase';
import {
  alRecibirAlarma,
  colorBarra,
  colorSimbolo,
  fetchPendientes,
  haceCuanto,
  nombreUsuario,
  partesTag,
  reconocer as apiReconocer,
  soloFecha,
  soloHora,
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
  /**
   * En la lista, la columna HORA. En el resumen, el «hace 3 min» de la peor.
   * (Es el mismo ajuste que antes enseñaba «hace X» en cada fila.)
   */
  hora: boolean;
  /** Botón de la cabecera que abre la pantalla de Alarmas. */
  verTodas: boolean;
  /** Columna SÍMBOLO – ID: el icono de la clase y el número de la alarma. */
  colId: boolean;
  /** Columna FECHA. */
  colFecha: boolean;
  /** Columna USUARIO: quién la reconoció. */
  colUsuario: boolean;
  /** Fila de títulos encima de la lista (ID, Fecha, Hora…). */
  cabeceras: boolean;
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
  verTodas: true,
  colId: true,
  colFecha: true,
  colUsuario: true,
  cabeceras: true,
};

/**
 * Por debajo de este ancho (en píxeles de diseño) las columnas no caben y la
 * lista pasa a dos líneas por alarma. Con las cinco columnas, 440 es donde
 * el mensaje se queda con sitio para unas veinte letras.
 */
const ANCHO_TABLA = 440;

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
    // Lo nuevo va ENCENDIDO por defecto: un widget guardado antes de que
    // existieran estos ajustes no los trae, y tiene que enseñar los datos
    // nuevos sin que nadie tenga que abrirlo y marcarlos uno a uno.
    verTodas: c.verTodas !== false,
    colId: c.colId !== false,
    // Salvo la fecha en un widget al que ya se le había quitado el «hace X»:
    // quien decidió no enseñar cuándo saltó no espera que ahora aparezca.
    colFecha: c.colFecha !== undefined ? c.colFecha !== false : c.hora !== false,
    colUsuario: c.colUsuario !== false,
    cabeceras: c.cabeceras !== false,
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

  // Tabla o dos líneas, según quepa. Se decide con el ancho de DISEÑO del
  // widget, que es el que manda en el lienzo: la pantalla entera se escala
  // después, y con ella esto.
  const comoTabla = (widget.width ?? 0) >= ANCHO_TABLA;
  const conTitulo = !!cfg.titulo.trim();

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
      {/* ── Cabecera ──────────────────────────────────────
          Sale con título, con el botón «Ver todas», o con los dos. Sin
          ninguno de los dos no hay cabecera: solo la lista. */}
      {(conTitulo || cfg.verTodas) && (
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
          {conTitulo && (
            <BellRingIcon
              style={{ width: tamTitulo, height: tamTitulo, flexShrink: 0 }}
              // `colorSimbolo` y no `tonoSeveridad().texto`: ese es BLANCO
              // en una Critical (va sobre su fondo rojo), y aquí no hay
              // fondo — la campana desaparecía justo con la alarma más grave.
              className={peor ? colorSimbolo(peor.severidad) : ''}
            />
          )}
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
            {conTitulo ? cfg.titulo : ''}
          </span>
          {estado === 'ok' && (
            <Contador n={filtradas.length} severidad={peor?.severidad ?? 5} />
          )}
          {cfg.verTodas && (
            <BotonVerTodas
              interactivo={!!interactivo}
              // En un widget muy estrecho se queda en la flecha: el texto
              // se comería el sitio del título.
              soloIcono={(widget.width ?? 0) < 260}
            />
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
          {comoTabla ? (
            // Una TABLA de verdad, y no una rejilla por fila: así el
            // navegador alinea las columnas entre filas él solo, sea cual
            // sea el tamaño de letra y el formato de fecha del equipo. El
            // mensaje se queda con todo lo que sobra.
            <table
              style={{
                width: '100%',
                borderCollapse: 'collapse',
                tableLayout: 'auto',
              }}
            >
              {cfg.cabeceras && (
                <thead>
                  <tr>
                    <th style={{ ...TH, padding: 0 }}>
                      <div style={ANCHO_BARRA} />
                    </th>
                    {cfg.colId && <th style={TH}>ID</th>}
                    {cfg.colFecha && <th style={TH}>Fecha</th>}
                    {cfg.hora && <th style={TH}>Hora</th>}
                    <th style={{ ...TH, width: '100%' }}>Mensaje</th>
                    {cfg.colUsuario && <th style={TH}>Usuario</th>}
                    {cfg.reconocer && <th style={TH} />}
                  </tr>
                </thead>
              )}
              <tbody>
                {visibles.map((a) => (
                  <FilaTabla
                    key={a.id}
                    alarma={a}
                    cfg={cfg}
                    interactivo={!!interactivo}
                    ocupada={ocupada === a.id}
                    onReconocer={() => void reconocerUna(a)}
                  />
                ))}
              </tbody>
            </table>
          ) : (
            visibles.map((a) => (
              <FilaCompacta
                key={a.id}
                alarma={a}
                cfg={cfg}
                interactivo={!!interactivo}
                ocupada={ocupada === a.id}
                onReconocer={() => void reconocerUna(a)}
              />
            ))
          )}
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

// ─── Las filas ───────────────────────────────────────────────────

/** Celda de título de la tabla: discreta, para que mande el contenido. */
const TH: CSSProperties = {
  padding: '4px 8px',
  textAlign: 'left',
  fontSize: '0.78em',
  fontWeight: 600,
  letterSpacing: '0.04em',
  textTransform: 'uppercase',
  whiteSpace: 'nowrap',
  opacity: 0.6,
  borderBottom: '1px solid rgba(148,163,184,0.25)',
};

/** Celda de dato. `nowrap`: una fila, una línea. */
const TD: CSSProperties = {
  padding: '5px 8px',
  whiteSpace: 'nowrap',
  verticalAlign: 'middle',
  borderBottom: '1px solid rgba(148,163,184,0.15)',
};

const CIFRAS: CSSProperties = { fontVariantNumeric: 'tabular-nums' };

/** Ancho de la barra de severidad de la tabla. */
const ANCHO_BARRA: CSSProperties = { width: 3 };

interface PropsFila {
  alarma: EventoAlarma;
  cfg: ConfigAlarmas;
  interactivo: boolean;
  ocupada: boolean;
  onReconocer: () => void;
}

/** Lo que se lee al dejar el puntero sobre una alarma: lo que no cabe en la fila. */
function detalleDe(a: EventoAlarma): string {
  const { plc, tag } = partesTag(a.tag);
  return [
    CLASE_DE_SEVERIDAD[a.severidad] ?? '',
    a.mensaje,
    a.area?.trim() || '',
    tag ? (plc ? `${plc} · ${tag}` : tag) : '',
    a.valor_disparo !== null && a.valor_disparo !== undefined
      ? `disparó con ${a.valor_disparo}`
      : '',
    a.ts_normalizacion ? 'ya normalizada' : 'sigue activa',
  ]
    .filter(Boolean)
    .join(' · ');
}

/** El número de la alarma (el de Configuración → Alarmas), o una raya. */
function idDe(a: EventoAlarma): string {
  return a.alarma_def_id === null || a.alarma_def_id === undefined
    ? '—'
    : String(a.alarma_def_id);
}

/**
 * Una alarma como fila de la tabla:
 * SÍMBOLO – ID · FECHA · HORA · MENSAJE · USUARIO · ✓
 *
 * La barra de la izquierda repite la severidad en color: se lee sin leer,
 * desde el otro lado de la sala.
 */
function FilaTabla({ alarma: a, cfg, interactivo, ocupada, onReconocer }: PropsFila) {
  const usuario = nombreUsuario(a);
  return (
    <tr title={detalleDe(a)}>
      {/* La barra lleva dentro un bloque con el ancho: una celda VACÍA con
          `width: 3` se queda en cero en cuanto otra columna pide el 100 %
          (la del mensaje), y la barra desaparecía. */}
      <td className={colorBarra(a.severidad)} style={{ padding: 0 }}>
        <div style={ANCHO_BARRA} />
      </td>
      {cfg.colId && (
        <td style={TD}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <SimboloClase severidad={a.severidad} tam={14} />
            <span style={{ ...CIFRAS, fontWeight: 700 }}>{idDe(a)}</span>
          </span>
        </td>
      )}
      {cfg.colFecha && (
        <td style={{ ...TD, ...CIFRAS }}>{soloFecha(a.ts_activacion)}</td>
      )}
      {cfg.hora && (
        <td style={{ ...TD, ...CIFRAS }} title={haceCuanto(a.ts_activacion)}>
          {soloHora(a.ts_activacion)}
        </td>
      )}
      {/* `maxWidth: 0` + `width: 100%` es lo que hace que ESTA columna se
          quede con el sitio que sobra y recorte con puntos suspensivos, en
          vez de ensanchar la tabla hasta sacarla del widget. */}
      <td
        style={{
          ...TD,
          width: '100%',
          maxWidth: 0,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          fontWeight: 600,
        }}
      >
        {a.mensaje}
      </td>
      {cfg.colUsuario && (
        <td
          style={{
            ...TD,
            maxWidth: '10em',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            opacity: usuario ? 1 : 0.5,
          }}
          title={
            usuario
              ? `La reconoció ${usuario}`
              : 'Todavía no la ha reconocido nadie'
          }
        >
          {usuario || '—'}
        </td>
      )}
      {cfg.reconocer && (
        <td style={{ ...TD, padding: '3px 8px 3px 4px' }}>
          <BotonReconocer
            interactivo={interactivo}
            ocupada={ocupada}
            onReconocer={onReconocer}
          />
        </td>
      )}
    </tr>
  );
}

/**
 * La misma alarma cuando el widget es estrecho: el mensaje arriba, a todo lo
 * ancho, y debajo el resto en una línea. Los mismos datos que la tabla.
 */
function FilaCompacta({ alarma: a, cfg, interactivo, ocupada, onReconocer }: PropsFila) {
  const usuario = nombreUsuario(a);
  const detalles = [
    cfg.colFecha ? soloFecha(a.ts_activacion) : '',
    cfg.hora ? soloHora(a.ts_activacion) : '',
    cfg.colUsuario ? usuario || '' : '',
  ].filter(Boolean);

  return (
    <div
      title={detalleDe(a)}
      style={{
        display: 'flex',
        alignItems: 'stretch',
        gap: 8,
        padding: '5px 8px 5px 0',
        borderBottom: '1px solid rgba(148,163,184,0.15)',
      }}
    >
      <span
        className={colorBarra(a.severidad)}
        style={{ width: 3, flexShrink: 0, borderRadius: 2 }}
      />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
          {cfg.colId && (
            <>
              <SimboloClase severidad={a.severidad} tam={13} />
              <span style={{ ...CIFRAS, fontWeight: 700, flexShrink: 0 }}>
                {idDe(a)}
              </span>
            </>
          )}
          <span
            style={{
              fontWeight: 600,
              minWidth: 0,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {a.mensaje}
          </span>
        </div>
        {detalles.length > 0 && (
          <div
            style={{
              ...CIFRAS,
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
      {cfg.reconocer && (
        <span style={{ alignSelf: 'center', flexShrink: 0 }}>
          <BotonReconocer
            interactivo={interactivo}
            ocupada={ocupada}
            onReconocer={onReconocer}
          />
        </span>
      )}
    </div>
  );
}

/** El ✓ de cada fila: darse por enterado. Firma con el usuario de la sesión. */
function BotonReconocer({
  interactivo,
  ocupada,
  onReconocer,
}: {
  interactivo: boolean;
  ocupada: boolean;
  onReconocer: () => void;
}) {
  return (
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
  );
}

// ─── El botón «Ver todas» ────────────────────────────────────────

/**
 * Abre la pantalla de Alarmas.
 *
 * Navega DENTRO de la aplicación (sin recargar): así la flecha de volver de
 * esa pantalla devuelve aquí, a la misma sección del HMI, y el WebSocket y
 * los valores del PLC no se pierden por el camino.
 *
 * `useNavigate` revienta si no hay enrutador por encima. Hoy lo hay siempre
 * —el Diseñador y la vista previa cuelgan del mismo—, pero un botón no puede
 * tumbar una pantalla de planta el día que el widget se pinte en otro sitio:
 * sin enrutador, el botón es un enlace normal y corriente.
 */
function BotonVerTodas(props: { interactivo: boolean; soloIcono: boolean }) {
  return useInRouterContext() ? (
    <BotonVerTodasSpa {...props} />
  ) : (
    <CuerpoVerTodas {...props} alPulsar={() => window.location.assign('/alarmas')} />
  );
}

function BotonVerTodasSpa(props: { interactivo: boolean; soloIcono: boolean }) {
  const navigate = useNavigate();
  return <CuerpoVerTodas {...props} alPulsar={() => navigate('/alarmas')} />;
}

function CuerpoVerTodas({
  interactivo,
  soloIcono,
  alPulsar,
}: {
  interactivo: boolean;
  soloIcono: boolean;
  alPulsar: () => void;
}) {
  return (
    <button
      type="button"
      onClick={alPulsar}
      disabled={!interactivo}
      title={
        interactivo
          ? 'Abrir la pantalla de Alarmas: pendientes e histórico'
          : 'Abre la pantalla de Alarmas. Funciona en la vista previa, no en el Diseñador'
      }
      aria-label="Ver todas las alarmas"
      className="hover:bg-siemens/15"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 2,
        flexShrink: 0,
        height: 24,
        padding: soloIcono ? '0 4px' : '0 6px 0 9px',
        borderRadius: 6,
        border: '1px solid rgba(148,163,184,0.35)',
        background: 'transparent',
        color: 'inherit',
        fontFamily: 'inherit',
        fontSize: 11,
        fontWeight: 600,
        whiteSpace: 'nowrap',
        cursor: interactivo ? 'pointer' : 'default',
        opacity: interactivo ? 1 : 0.55,
      }}
    >
      {!soloIcono && 'Ver todas'}
      <ChevronRightIcon style={{ width: 14, height: 14 }} />
    </button>
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
        // Mismo motivo que la campana de la cabecera: con `tonoSeveridad`
        // el número salía BLANCO cuando la peor era una Critical.
        className={colorSimbolo(peor.severidad)}
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

      <Casilla
        marcada={cfg.verTodas}
        alCambiar={(v) => poner({ verTodas: v })}
        texto="Botón «Ver todas» (abre la pantalla de Alarmas)"
      />

      <Casilla
        marcada={cfg.reconocer}
        alCambiar={(v) => poner({ reconocer: v })}
        texto="Botón para reconocer cada alarma"
      />

      {cfg.modo === 'lista' ? (
        <div>
          <span className={CLASE_ETIQUETA}>Datos de cada alarma</span>
          <div className="space-y-1.5">
            <Casilla
              marcada={cfg.colId}
              alCambiar={(v) => poner({ colId: v })}
              texto="Símbolo e ID de la alarma"
            />
            <Casilla
              marcada={cfg.colFecha}
              alCambiar={(v) => poner({ colFecha: v })}
              texto="Fecha"
            />
            <Casilla
              marcada={cfg.hora}
              alCambiar={(v) => poner({ hora: v })}
              texto="Hora"
            />
            <Casilla
              marcada={cfg.colUsuario}
              alCambiar={(v) => poner({ colUsuario: v })}
              texto="Usuario (quién la reconoció)"
            />
            <Casilla
              marcada={cfg.cabeceras}
              alCambiar={(v) => poner({ cabeceras: v })}
              texto="Títulos de columna"
            />
          </div>
          <span className={CLASE_AYUDA}>
            El mensaje va siempre. Con menos de {ANCHO_TABLA} px de ancho las
            columnas no caben y cada alarma pasa a dos líneas, con los mismos
            datos.
          </span>
        </div>
      ) : (
        <Casilla
          marcada={cfg.hora}
          alCambiar={(v) => poner({ hora: v })}
          texto="Enseñar hace cuánto saltó la más grave"
        />
      )}

      <div className="rounded-lg bg-slate-100 px-2.5 py-2 text-[11px] leading-relaxed text-slate-500 dark:bg-navy-slate/40 dark:text-slate-400">
        Reconocer y «Ver todas» solo funcionan en la <b>vista previa</b>; en
        el Diseñador los botones se ven pero no actúan. El título se estiliza
        en <b>Apariencia → Título</b> y las filas en{' '}
        <b>Apariencia → Texto</b>.
      </div>
    </>
  );
}

/** Una casilla del panel, con su texto al lado. */
function Casilla({
  marcada,
  alCambiar,
  texto,
}: {
  marcada: boolean;
  alCambiar: (v: boolean) => void;
  texto: string;
}) {
  return (
    <label className="flex items-center gap-2 text-xs text-slate-600 dark:text-slate-300">
      <input
        type="checkbox"
        checked={marcada}
        onChange={(e) => alCambiar(e.target.checked)}
        className="h-3.5 w-3.5 accent-siemens"
      />
      {texto}
    </label>
  );
}

// ─── Definición ──────────────────────────────────────────────────

export const alarmasWidget: CustomWidgetDef = {
  kind: 'custom:alarmas',
  label: 'Alarmas',
  category: 'Datos',
  icon: BellRingIcon,
  // Ancho de sobra para la tabla con sus cinco columnas. (Los que ya estén
  // colocados conservan su tamaño; por debajo de `ANCHO_TABLA` se pintan en
  // dos líneas por alarma.)
  defaultWidth: 560,
  defaultHeight: 240,
  render: (ctx) => <WidgetAlarmas {...ctx} />,
  inspector: (ctx) => <InspectorAlarmas {...ctx} />,
  defaultConfig: CONFIG_ALARMAS,
};
