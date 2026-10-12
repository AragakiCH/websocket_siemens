// =========================================================================
// NavegadorPanel.tsx
// Navegador de Pantallas: las flechas ◀ ▶ ⌂ como widget suelto, con la lista
// de pantallas por las que se mueve asignada en sus Propiedades.
//
// QUÉ HACE
// Manda sobre el Panel de Sección de su grupo. Lleva una LISTA ORDENADA de
// pantallas, y las flechas recorren esa lista:
//
//   ▶  la siguiente de la lista. Desde el origen, la primera.
//   ◀  la anterior. Desde la primera, de vuelta al origen (lo que la sección
//      enseña por sí sola). Si el panel enseña algo que NO está en la lista
//      —lo abrió otro mando—, deshace un paso del historial.
//   ⌂  directo al origen, sin perder el recorrido. HOY ESTÁ OCULTA (ver
//      `CASITA_DISPONIBLE`): ◀ ya llega al origen desde la primera pantalla
//      y se prefirió el mando más simple. El código se queda por si hace
//      falta recuperarla.
//
// Cada paso pasa por el mismo historial que todo lo demás (`abrirEnPanel`,
// `irAlOrigenPanel` en store.ts), así que las flechas de la cabecera del
// panel, la acción «Volver en el Panel de Sección» y este widget siempre
// están de acuerdo sobre dónde se está.
//
// DE DÓNDE VIENE
// Primero fue una barra de botones dentro del Panel de Sección; después, un
// botón suelto por pantalla. Lo que se quería era más simple: UN solo mando
// con las flechas, y decirle ahí qué pantallas recorrer. Esto es eso.
//
// SE QUEDA CUANDO EL PANEL CAMBIA DE PANTALLA
// Los widgets de la sección se esconden mientras el panel enseña otra
// pantalla (Preview.tsx / Designer.tsx), porque quedarían encima de ella.
// Este NO: es el mando con el que se vuelve. Por eso está en
// `sigueConPanelAbierto()` y no en `KINDS_NAVEGACION`, que significa
// «armazón, en todas las secciones» y le quitaría poder ser de una sección.
//
// TAMBIÉN SIRVE DENTRO DE LA PANTALLA QUE SE EMPOTRA. Corre con la pantalla
// de FUERA como actual (`pantallaActual` es global del módulo), así que un
// navegador puesto en «Pantalla 4» manda sobre el panel que la enseña.
//
// Y EN EL DISEÑADOR TAMBIÉN: `CanvasWidget` se queda con el `pointerdown`
// para seleccionar y arrastrar, pero el `click` llega igual. Pulsar navega.
// =========================================================================
import type { CSSProperties, MouseEvent, ReactNode } from 'react';
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  HomeIcon,
  MonitorIcon,
  PlusIcon,
  Trash2Icon,
  ArrowUpIcon,
  ArrowDownIcon,
  CompassIcon,
} from 'lucide-react';
import type { CustomWidgetDef, RenderCtx, InspectorCtx } from '../types';
import {
  GRUPO_POR_DEFECTO,
  KIND_NAVEGADOR_PANEL,
  usePanel,
  usePantallas,
  usePantallaAbierta,
  useVistaActiva,
  etiquetaDeVista,
  nombreDePantalla,
  abrirEnPanel,
  volverPanel,
  irAlOrigenPanel,
} from './store';
import { CampoGrupo } from './inspector';
import { estiloDeParte } from '../../partes';

// ─── Config ──────────────────────────────────────────────────────

/**
 * Interruptor de la casita (⌂, «al origen»).
 *
 * En `false` no se dibuja ni se ofrece en el Inspector, diga lo que diga el
 * `mostrarInicio` guardado en el diseño. Se dejó así a propósito en vez de
 * borrar el botón: el camino de vuelta ya lo cubre ◀, pero si algún día un
 * panel con muchas pantallas pide un salto directo al origen, se pone en
 * `true` y vuelve todo —dibujo, opción y texto de ayuda— sin tocar más.
 */
const CASITA_DISPONIBLE = false;

export interface ConfigNavegador {
  grupo: string;
  /** `project_id` de cada pantalla, en el orden en que se recorren. */
  pantallas: string[];
  /** La casita (al origen). Solo cuenta si `CASITA_DISPONIBLE` está en true. */
  mostrarInicio: boolean;
  /** El nombre de lo que se está viendo, entre las flechas. */
  mostrarNombre: boolean;
}

export const CONFIG_NAVEGADOR: ConfigNavegador = {
  grupo: GRUPO_POR_DEFECTO,
  pantallas: [],
  mostrarInicio: true,
  mostrarNombre: false,
};

export function leerConfigNavegador(config: any): ConfigNavegador {
  const c = config ?? {};
  return {
    grupo: typeof c.grupo === 'string' && c.grupo.trim() ? c.grupo : GRUPO_POR_DEFECTO,
    pantallas: Array.isArray(c.pantallas)
      ? c.pantallas.filter((p: unknown): p is string => typeof p === 'string' && !!p.trim())
      : [],
    mostrarInicio: c.mostrarInicio !== false,
    mostrarNombre: c.mostrarNombre === true,
  };
}

// ─── Dibujo ──────────────────────────────────────────────────────

function Flecha({
  titulo,
  activo,
  color,
  tam,
  onClick,
  children,
}: {
  titulo: string;
  activo: boolean;
  color: string;
  tam: number;
  onClick: () => void;
  children: ReactNode;
}) {
  const pulsar = (e: MouseEvent) => {
    // Que el clic no suba al lienzo: aquí es una orden, no una selección.
    e.stopPropagation();
    if (activo) onClick();
  };
  return (
    <button
      type="button"
      title={titulo}
      aria-label={titulo}
      aria-disabled={!activo}
      tabIndex={activo ? 0 : -1}
      onClick={pulsar}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        flex: '1 1 0',
        minWidth: 0,
        height: '100%',
        padding: 0,
        border: 'none',
        borderRadius: 6,
        background: 'transparent',
        color,
        opacity: activo ? 1 : 0.3,
        cursor: activo ? 'pointer' : 'default',
        transition: 'opacity 0.15s, background 0.15s',
      }}
      onMouseEnter={(e) => {
        if (activo) e.currentTarget.style.background = 'rgba(148,163,184,0.18)';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = 'transparent';
      }}
    >
      <span style={{ width: tam, height: tam, display: 'inline-flex' }}>{children}</span>
    </button>
  );
}

function Navegador({ widget, style }: RenderCtx) {
  const cfg = leerConfigNavegador(widget.config);
  const pCaja = estiloDeParte(widget, 'box');
  const pIcono = estiloDeParte(widget, 'icon');
  const pTexto = estiloDeParte(widget, 'label');
  const panel = usePanel(cfg.grupo);
  const activa = useVistaActiva(cfg.grupo);
  // Suscribe al catálogo: el nombre entre las flechas sigue a la pantalla.
  usePantallas();

  // ── Dónde se está dentro de la lista ───────────────────────────
  //   -1  en el origen (nada abierto)
  //   -2  abierto algo que no está en la lista (lo abrió otro mando)
  //   n   la pantalla n de la lista
  const pos = !panel.abierta ? -1 : cfg.pantallas.indexOf(panel.abierta);
  const posicion = pos >= 0 ? pos : panel.abierta ? -2 : -1;

  const haySiguiente =
    cfg.pantallas.length > 0 &&
    (posicion === -1 ? true : posicion >= 0 && posicion < cfg.pantallas.length - 1);
  const hayAnterior = posicion === -2 ? panel.puedeVolver : posicion >= 0;

  const siguiente = () => {
    if (posicion === -1) abrirEnPanel(cfg.grupo, cfg.pantallas[0]);
    else if (posicion >= 0) abrirEnPanel(cfg.grupo, cfg.pantallas[posicion + 1]);
  };
  const anterior = () => {
    if (posicion === -2) volverPanel(cfg.grupo);
    else if (posicion === 0) irAlOrigenPanel(cfg.grupo);
    else if (posicion > 0) abrirEnPanel(cfg.grupo, cfg.pantallas[posicion - 1]);
  };

  // Lo que se ve ahora, para el rótulo opcional y los títulos de las flechas.
  const nombreOrigen = etiquetaDeVista(cfg.grupo, activa) || 'Inicio';
  const nombreActual = panel.abierta
    ? nombreDePantalla(panel.abierta) || panel.abierta
    : nombreOrigen;
  const nombreDe = (i: number) => nombreDePantalla(cfg.pantallas[i]) || cfg.pantallas[i];
  const tituloSiguiente = haySiguiente
    ? `Ir a «${nombreDe(posicion === -1 ? 0 : posicion + 1)}»`
    : cfg.pantallas.length === 0
      ? 'Asigna pantallas en Propiedades'
      : 'Última pantalla de la lista';
  const tituloAnterior = hayAnterior
    ? posicion === -2
      ? 'Atrás'
      : posicion === 0
        ? `Volver a «${nombreOrigen}»`
        : `Volver a «${nombreDe(posicion - 1)}»`
    : 'Ya estás en el origen';

  // Colores: las flechas con la parte «Flechas» (hereda el color del widget);
  // la caja como cualquier otra.
  const color = pIcono.color || style.color;
  const alto = Math.max(16, widget.height - 2 * (pCaja.borderWidth || 0));
  const tam = Math.max(12, Math.min(22, Math.round(alto * 0.5)));

  const caja: CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    width: '100%',
    height: '100%',
    boxSizing: 'border-box',
    padding: '2px 4px',
    gap: 2,
    borderRadius: pCaja.borderRadius,
    border: pCaja.borderWidth
      ? `${pCaja.borderWidth}px solid ${pCaja.borderColor}`
      : undefined,
    background: pCaja.background === 'transparent' ? undefined : pCaja.background,
    opacity: pCaja.opacity,
    fontFamily: 'inherit',
  };

  return (
    <div style={caja} role="group" aria-label="Navegador de pantallas">
      <Flecha titulo={tituloAnterior} activo={hayAnterior} color={color} tam={tam} onClick={anterior}>
        <ChevronLeftIcon style={{ width: '100%', height: '100%' }} />
      </Flecha>

      {cfg.mostrarNombre && (
        <span
          style={{
            flex: '3 1 0',
            minWidth: 0,
            textAlign: 'center',
            fontSize: pTexto.fontSize,
            fontWeight: pTexto.bold ? 700 : 600,
            color: pTexto.color || style.color,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            padding: '0 4px',
          }}
          title={nombreActual}
        >
          {nombreActual}
        </span>
      )}

      <Flecha titulo={tituloSiguiente} activo={haySiguiente} color={color} tam={tam} onClick={siguiente}>
        <ChevronRightIcon style={{ width: '100%', height: '100%' }} />
      </Flecha>

      {CASITA_DISPONIBLE && cfg.mostrarInicio && (
        <Flecha
          titulo={panel.abierta ? `Volver a «${nombreOrigen}»` : 'Ya estás en el origen'}
          activo={!!panel.abierta}
          color={color}
          tam={Math.round(tam * 0.88)}
          onClick={() => irAlOrigenPanel(cfg.grupo)}
        >
          <HomeIcon style={{ width: '100%', height: '100%' }} />
        </Flecha>
      )}
    </div>
  );
}

// ─── Inspector ───────────────────────────────────────────────────

const INPUT =
  'w-full rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-navy outline-none transition focus:border-siemens focus:ring-2 focus:ring-siemens/20 dark:border-navy-slate dark:bg-navy dark:text-slate-100';
const CHECK =
  'h-4 w-4 rounded border-slate-300 text-siemens focus:ring-2 focus:ring-siemens/40 dark:border-navy-slate dark:bg-navy';
const ICONO_BTN =
  'inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-slate-400 transition hover:bg-slate-100 hover:text-navy disabled:opacity-30 disabled:hover:bg-transparent dark:hover:bg-navy-slate/50 dark:hover:text-slate-100';

/** La lista ordenada de pantallas: elegir, reordenar, quitar. */
function EditorPantallas({
  lista,
  onChange,
}: {
  lista: string[];
  onChange: (lista: string[]) => void;
}) {
  const pantallas = usePantallas();
  const abierta = usePantallaAbierta();

  const editar = (i: number, v: string) => onChange(lista.map((p, k) => (k === i ? v : p)));
  const mover = (i: number, d: number) => {
    const j = i + d;
    if (j < 0 || j >= lista.length) return;
    const copia = [...lista];
    [copia[i], copia[j]] = [copia[j], copia[i]];
    onChange(copia);
  };
  const quitar = (i: number) => onChange(lista.filter((_, k) => k !== i));
  // Al añadir se propone la primera que aún no esté en la lista, para que el
  // paso típico («las tres pantallas de la línea») sea tres clics.
  const agregar = () => {
    const libre = pantallas.find((p) => p.project_id !== abierta && !lista.includes(p.project_id))
      ?? pantallas.find((p) => !lista.includes(p.project_id));
    onChange([...lista, libre?.project_id ?? '']);
  };

  return (
    <div className="space-y-1">
      {lista.map((id, i) => {
        const huerfana = !!id && pantallas.length > 0 && !pantallas.some((p) => p.project_id === id);
        return (
          <div key={`${i}-${id}`} className="flex items-center gap-1">
            <span className="w-4 shrink-0 text-center font-mono text-[10px] text-slate-400">
              {i + 1}
            </span>
            <MonitorIcon
              className={`h-3 w-3 shrink-0 ${
                id && !huerfana ? 'text-siemens' : 'text-slate-300 dark:text-navy-slate'
              }`}
            />
            <select
              value={id}
              onChange={(e) => editar(i, e.target.value)}
              className={`min-w-0 flex-1 cursor-pointer rounded border bg-transparent px-1.5 py-0.5 text-[11px] outline-none transition focus:border-siemens focus:ring-1 focus:ring-siemens/30 dark:bg-navy ${
                huerfana
                  ? 'border-state-error/40 text-state-error'
                  : id
                    ? 'border-siemens/40 text-navy dark:text-slate-100'
                    : 'border-slate-200 text-slate-400 dark:border-navy-slate'
              }`}
            >
              <option value="">— elegir pantalla —</option>
              {pantallas.map((p) => (
                <option key={p.project_id} value={p.project_id}>
                  {p.nombre}
                  {p.project_id === abierta ? ' (actual)' : ''}
                </option>
              ))}
              {/* La borrada se sigue ofreciendo para que el <select> no
                  caiga a la primera opción y pierda la asignación solo con
                  abrir el Inspector. */}
              {huerfana && <option value={id}>{id} — ya no existe</option>}
            </select>
            <button type="button" className={ICONO_BTN} title="Subir" disabled={i === 0}
              onClick={() => mover(i, -1)}>
              <ArrowUpIcon className="h-3.5 w-3.5" />
            </button>
            <button type="button" className={ICONO_BTN} title="Bajar"
              disabled={i === lista.length - 1} onClick={() => mover(i, 1)}>
              <ArrowDownIcon className="h-3.5 w-3.5" />
            </button>
            <button type="button" className={`${ICONO_BTN} hover:text-state-error`}
              title="Quitar de la lista" onClick={() => quitar(i)}>
              <Trash2Icon className="h-3.5 w-3.5" />
            </button>
          </div>
        );
      })}

      <button
        type="button"
        onClick={agregar}
        className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-slate-300 px-2.5 py-1.5 text-xs font-medium text-slate-500 transition hover:border-siemens hover:text-siemens dark:border-navy-slate dark:text-slate-400"
      >
        <PlusIcon className="h-3.5 w-3.5" />
        Añadir pantalla
      </button>
      {pantallas.length === 0 && (
        <p className="text-[10px] leading-relaxed text-slate-400">
          El proyecto no tiene otras pantallas todavía. Crea una en la barra de
          pestañas y después añádela aquí.
        </p>
      )}
    </div>
  );
}

function InspectorNavegador({ config, setConfig }: InspectorCtx) {
  const cfg = leerConfigNavegador(config);
  const abierta = usePantallaAbierta();
  const seApuntaASiMisma = cfg.pantallas.includes(abierta);

  return (
    <>
      <div>
        <span className="mb-1 block text-xs font-medium text-slate-500 dark:text-slate-400">
          Pantallas, en orden
        </span>
        <EditorPantallas
          lista={cfg.pantallas}
          onChange={(pantallas) => setConfig({ ...cfg, pantallas })}
        />
        <span className="mt-1 block text-[10px] leading-relaxed text-slate-400">
          ▶ abre la siguiente de la lista (desde el origen, la primera). ◀ vuelve
          a la anterior, y desde la primera, al origen de la sección.
        </span>
        {seApuntaASiMisma && (
          <span className="mt-1 block text-[10px] leading-snug text-amber-600 dark:text-amber-400">
            La lista incluye la pantalla en la que ya estás: se enseñaría dentro
            de sí misma, sin su menú ni su panel.
          </span>
        )}
      </div>

      {CASITA_DISPONIBLE && (
        <label className="flex items-center justify-between gap-2">
          <span className="text-xs font-medium text-slate-500 dark:text-slate-400">
            Botón de inicio (al origen)
          </span>
          <input
            type="checkbox"
            checked={cfg.mostrarInicio}
            onChange={(e) => setConfig({ ...cfg, mostrarInicio: e.target.checked })}
            className={CHECK}
          />
        </label>
      )}

      <label className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-slate-500 dark:text-slate-400">
          Nombre de la pantalla entre las flechas
        </span>
        <input
          type="checkbox"
          checked={cfg.mostrarNombre}
          onChange={(e) => setConfig({ ...cfg, mostrarNombre: e.target.checked })}
          className={CHECK}
        />
      </label>

      <CampoGrupo valor={cfg.grupo} onChange={(grupo) => setConfig({ ...cfg, grupo })} />

      <div className={`${INPUT} cursor-default bg-slate-100 text-[11px] leading-relaxed text-slate-500 dark:bg-navy-slate/40 dark:text-slate-400`}>
        Manda sobre el <b>Panel de Sección</b> de su grupo. <b>No se esconde</b>{' '}
        cuando el panel cambia de pantalla —los demás widgets de la sección
        sí—, así que siempre queda a mano para volver. También funciona
        colocado dentro de la pantalla que se empotra. El color de las
        flechas se ajusta en la parte <b>Flechas</b>.
      </div>
    </>
  );
}

// ─── Definición ──────────────────────────────────────────────────

export const navegadorPanel: CustomWidgetDef = {
  kind: KIND_NAVEGADOR_PANEL,
  label: 'Navegador de Pantallas',
  category: 'Básicos',
  icon: CompassIcon,
  defaultWidth: 80,
  defaultHeight: 36,
  render: (ctx) => <Navegador {...ctx} />,
  inspector: (ctx) => <InspectorNavegador {...ctx} />,
  defaultConfig: CONFIG_NAVEGADOR,
};
