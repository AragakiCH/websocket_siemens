// =========================================================================
// BotonPanel.tsx
// Botón de Pantalla: un botón suelto del lienzo que manda sobre lo que
// enseña el Panel de Sección.
//
// DE DÓNDE VIENE
// Empezó siendo una barra fija dentro del propio Panel de Sección: una lista
// de botones en sus Propiedades, pintados en fila bajo la cabecera. Funcionaba,
// pero obligaba a aceptar SU colocación. Lo que se quería era lo contrario:
// botones que se arrastran, se estiran y se estilizan como cualquier otro
// widget, puestos donde el diseño los pida. Así que la barra se fue y quedó
// esto, que hace exactamente lo mismo con el mismo historial de `store.ts`.
//
// LOS CUATRO MODOS
//   abrir     Enseña una pantalla concreta dentro del panel. Es el de siempre.
//             Se dibuja «encendido» mientras esa pantalla sea la abierta.
//   volver    Un paso atrás en el historial del panel.
//   adelante  Un paso adelante, si se había vuelto.
//   origen    Directo a lo que la sección enseña por sí sola.
//
// SE QUEDA CUANDO EL PANEL CAMBIA DE PANTALLA
// Los widgets de la sección se esconden mientras el panel enseña otra
// pantalla (Preview.tsx / Designer.tsx), porque quedarían encima de ella.
// Este NO: es el mando con el que se vuelve. Por eso hay un conjunto aparte
// en `store.ts` (`sigueConPanelAbierto`) y no se le mete en
// `KINDS_NAVEGACION`, que significa «armazón, en todas las secciones» y le
// quitaría la posibilidad de pertenecer a una sección.
//
// TAMBIÉN SIRVE DENTRO DE LA PANTALLA QUE SE EMPOTRA
// Un «Volver» colocado en la pantalla que el panel enseña corre con la
// pantalla de FUERA como actual (`pantallaActual` es global del módulo), así
// que actúa sobre el panel que lo contiene sin saber nada de él. Es lo que
// permite ir y venir desde los dos lados.
//
// Y EN EL DISEÑADOR TAMBIÉN. `CanvasWidget` se queda con el `pointerdown`
// para seleccionar y arrastrar, pero el `click` llega igual: pulsar navega,
// como en el Menú Lateral. Así se prueba sin salir al runtime.
// =========================================================================
import type { CSSProperties, MouseEvent, KeyboardEvent } from 'react';
import {
  MousePointerClickIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  HomeIcon,
  MonitorIcon,
} from 'lucide-react';
import type { CustomWidgetDef, RenderCtx, InspectorCtx } from '../types';
import {
  GRUPO_POR_DEFECTO,
  KIND_BOTON_PANEL,
  usePanel,
  usePantallas,
  usePantallaAbierta,
  useVistaActiva,
  etiquetaDeVista,
  nombreDePantalla,
  abrirEnPanel,
  volverPanel,
  avanzarPanel,
  irAlOrigenPanel,
} from './store';
import { CampoGrupo } from './inspector';
import { estiloDeParte } from '../../partes';

// ─── Config ──────────────────────────────────────────────────────

export type ModoBotonPanel = 'abrir' | 'volver' | 'adelante' | 'origen';

export interface ConfigBotonPanel {
  grupo: string;
  modo: ModoBotonPanel;
  /** Para `abrir`: `project_id` de la pantalla. Se guarda el id, no el nombre. */
  pantalla: string;
  /** Dibujar el icono del modo a la izquierda del rótulo. */
  icono: boolean;
}

export const CONFIG_BOTON_PANEL: ConfigBotonPanel = {
  grupo: GRUPO_POR_DEFECTO,
  modo: 'abrir',
  pantalla: '',
  icono: true,
};

const ETIQUETA = 'Botón de Pantalla';

const MODOS: { valor: ModoBotonPanel; label: string; ayuda: string }[] = [
  { valor: 'abrir', label: 'Mostrar una pantalla',
    ayuda: 'El panel enseña esa pantalla. Se ve encendido mientras sea la abierta.' },
  { valor: 'volver', label: 'Volver (un paso atrás)',
    ayuda: 'Deshace lo último que se abrió en el panel. Apagado si no hay nada detrás.' },
  { valor: 'adelante', label: 'Adelante (un paso)',
    ayuda: 'Recupera lo que se dejó al volver. Apagado si no hay nada delante.' },
  { valor: 'origen', label: 'Al origen de la sección',
    ayuda: 'Vuelve a lo que la sección enseña por sí sola, sin perder el recorrido.' },
];

export function leerConfigBotonPanel(config: any): ConfigBotonPanel {
  const c = config ?? {};
  return {
    grupo: typeof c.grupo === 'string' && c.grupo.trim() ? c.grupo : GRUPO_POR_DEFECTO,
    modo: MODOS.some((m) => m.valor === c.modo) ? c.modo : 'abrir',
    pantalla: typeof c.pantalla === 'string' ? c.pantalla : '',
    icono: c.icono !== false,
  };
}

// ─── Dibujo ──────────────────────────────────────────────────────

function Boton({ widget, style }: RenderCtx) {
  const cfg = leerConfigBotonPanel(widget.config);
  const pCaja = estiloDeParte(widget, 'box');
  const pBoton = estiloDeParte(widget, 'boton');
  const panel = usePanel(cfg.grupo);
  const activa = useVistaActiva(cfg.grupo);
  // Suscribe al catálogo: el rótulo automático sigue al nombre de la pantalla.
  usePantallas();

  // ── Qué hace y si puede hacerlo ahora ──────────────────────────
  let habilitado: boolean;
  let encendido: boolean;
  let accion: () => void;
  let Icono = MonitorIcon;
  let textoAuto: string;

  switch (cfg.modo) {
    case 'volver':
      habilitado = panel.puedeVolver;
      encendido = false;
      accion = () => volverPanel(cfg.grupo);
      Icono = ChevronLeftIcon;
      textoAuto = 'Volver';
      break;
    case 'adelante':
      habilitado = panel.puedeAvanzar;
      encendido = false;
      accion = () => avanzarPanel(cfg.grupo);
      Icono = ChevronRightIcon;
      textoAuto = 'Adelante';
      break;
    case 'origen':
      habilitado = !!panel.abierta;
      encendido = false;
      accion = () => irAlOrigenPanel(cfg.grupo);
      Icono = HomeIcon;
      textoAuto = etiquetaDeVista(cfg.grupo, activa) || 'Inicio';
      break;
    default:
      habilitado = !!cfg.pantalla;
      encendido = !!cfg.pantalla && cfg.pantalla === panel.abierta;
      accion = () => abrirEnPanel(cfg.grupo, cfg.pantalla);
      textoAuto = nombreDePantalla(cfg.pantalla) || cfg.pantalla || 'Sin pantalla';
  }

  // El rótulo: lo que se escribió en «Texto», salvo que sea el nombre con
  // el que nace el widget — entonces se enseña el automático, que es lo que
  // uno iba a escribir a mano (el nombre de la pantalla, «Volver»…).
  const propio = (widget.text ?? '').trim();
  const texto = propio && propio !== ETIQUETA ? propio : textoAuto;

  // ── Colores, con el mismo criterio que el botón normal ─────────
  // Relleno: la parte «Botón», y si no se tocó, el color del widget. El
  // rótulo sobre el relleno va blanco salvo color puesto a propósito
  // (`pBoton.color` hereda `style.color`, que es justo el del fondo).
  const relleno =
    pBoton.background && pBoton.background !== 'transparent'
      ? pBoton.background
      : style.color;
  const textoSobreRelleno = widget.partes?.boton?.color ?? '#fff';

  // «Abrir» va relleno solo mientras su pantalla es la abierta; el resto
  // del tiempo, en contorno, para que de un vistazo se vea dónde estás.
  // Los otros modos van rellenos cuando pueden actuar y apagados si no.
  const rellenar = cfg.modo === 'abrir' ? encendido : habilitado;

  const estilo: CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 7,
    width: '100%',
    height: '100%',
    boxSizing: 'border-box',
    padding: '0 12px',
    border: rellenar
      ? `${pCaja.borderWidth || 0}px solid ${pCaja.borderColor}`
      : `${pCaja.borderWidth || 1}px solid ${
          pCaja.borderWidth ? pCaja.borderColor : relleno
        }`,
    borderRadius: pBoton.borderRadius ?? pCaja.borderRadius,
    background: rellenar ? relleno : 'transparent',
    color: rellenar ? textoSobreRelleno : relleno,
    opacity: (habilitado ? 1 : 0.45) * (pCaja.opacity ?? 1),
    fontFamily: 'inherit',
    fontSize: pBoton.fontSize,
    fontWeight: pBoton.bold || encendido ? 700 : 600,
    lineHeight: 1.2,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    cursor: habilitado ? 'pointer' : 'default',
    transition: 'background 0.15s, color 0.15s, border-color 0.15s, opacity 0.15s',
    boxShadow: rellenar ? '0 1px 2px rgba(0,0,0,0.12)' : undefined,
  };

  const pulsar = (e: MouseEvent) => {
    // Que el clic no suba al lienzo: aquí es una orden, no una selección.
    e.stopPropagation();
    if (!habilitado) return;
    accion();
  };

  const teclado = (e: KeyboardEvent) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    e.stopPropagation();
    if (habilitado) accion();
  };

  return (
    <div
      role="button"
      tabIndex={habilitado ? 0 : -1}
      aria-pressed={cfg.modo === 'abrir' ? encendido : undefined}
      aria-disabled={!habilitado}
      title={
        cfg.modo === 'abrir'
          ? cfg.pantalla
            ? `Mostrar «${texto}» en el Panel de Sección`
            : 'Elige la pantalla en Propiedades'
          : MODOS.find((m) => m.valor === cfg.modo)?.label
      }
      onClick={pulsar}
      onKeyDown={teclado}
      style={estilo}
    >
      {cfg.icono && (
        <Icono
          style={{
            width: Math.max(12, Math.round((pBoton.fontSize ?? 14) * 0.95)),
            height: Math.max(12, Math.round((pBoton.fontSize ?? 14) * 0.95)),
            flexShrink: 0,
          }}
        />
      )}
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{texto}</span>
    </div>
  );
}

// ─── Inspector ───────────────────────────────────────────────────

const INPUT =
  'w-full rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-navy outline-none transition focus:border-siemens focus:ring-2 focus:ring-siemens/20 dark:border-navy-slate dark:bg-navy dark:text-slate-100';
const SELECT = `${INPUT} cursor-pointer`;
const CHECK =
  'h-4 w-4 rounded border-slate-300 text-siemens focus:ring-2 focus:ring-siemens/40 dark:border-navy-slate dark:bg-navy';

function InspectorBoton({ config, setConfig }: InspectorCtx) {
  const cfg = leerConfigBotonPanel(config);
  const pantallas = usePantallas();
  const abierta = usePantallaAbierta();
  const ayuda = MODOS.find((m) => m.valor === cfg.modo)?.ayuda ?? '';

  const huerfana =
    !!cfg.pantalla && pantallas.length > 0 &&
    !pantallas.some((p) => p.project_id === cfg.pantalla);
  const esSiMisma = !!cfg.pantalla && cfg.pantalla === abierta;

  return (
    <>
      <label className="block">
        <span className="mb-1 block text-xs font-medium text-slate-500 dark:text-slate-400">
          Al pulsar
        </span>
        <select
          value={cfg.modo}
          onChange={(e) => setConfig({ ...cfg, modo: e.target.value as ModoBotonPanel })}
          className={SELECT}
        >
          {MODOS.map((m) => (
            <option key={m.valor} value={m.valor}>
              {m.label}
            </option>
          ))}
        </select>
        <span className="mt-1 block text-[10px] leading-relaxed text-slate-400">{ayuda}</span>
      </label>

      {cfg.modo === 'abrir' && (
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-slate-500 dark:text-slate-400">
            Pantalla
          </span>
          <select
            value={cfg.pantalla}
            onChange={(e) => setConfig({ ...cfg, pantalla: e.target.value })}
            className={`${SELECT} ${huerfana ? 'border-state-error/40 text-state-error' : ''}`}
          >
            <option value="">— elegir pantalla —</option>
            {pantallas.map((p) => (
              <option key={p.project_id} value={p.project_id}>
                {p.nombre}
                {p.project_id === abierta ? ' (actual)' : ''}
              </option>
            ))}
            {/* La borrada se sigue ofreciendo para que el <select> no caiga
                a la primera opción y pierda la asignación solo con abrir
                el Inspector. */}
            {huerfana && <option value={cfg.pantalla}>{cfg.pantalla} — ya no existe</option>}
          </select>
          {huerfana && (
            <span className="mt-1 block text-[10px] leading-snug text-state-error">
              Esa pantalla ya no está en el proyecto. Elige otra.
            </span>
          )}
          {esSiMisma && !huerfana && (
            <span className="mt-1 block text-[10px] leading-snug text-amber-600 dark:text-amber-400">
              Es la pantalla en la que ya estás: se enseñaría dentro de sí
              misma, sin su menú ni su panel.
            </span>
          )}
          {pantallas.length === 0 && (
            <span className="mt-1 block text-[10px] leading-relaxed text-slate-400">
              El proyecto no tiene otras pantallas todavía. Crea una en la
              barra de pestañas y después asígnala aquí.
            </span>
          )}
        </label>
      )}

      <label className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-slate-500 dark:text-slate-400">
          Mostrar icono
        </span>
        <input
          type="checkbox"
          checked={cfg.icono}
          onChange={(e) => setConfig({ ...cfg, icono: e.target.checked })}
          className={CHECK}
        />
      </label>

      <CampoGrupo valor={cfg.grupo} onChange={(grupo) => setConfig({ ...cfg, grupo })} />

      <div className="rounded-lg bg-slate-100 px-2.5 py-2 text-[11px] leading-relaxed text-slate-500 dark:bg-navy-slate/40 dark:text-slate-400">
        El rótulo sale del campo <b>Texto</b> de arriba; vacío o sin tocar,
        se usa el nombre de la pantalla (o «Volver», «Adelante»…). El color
        del botón encendido se ajusta en la parte <b>Botón</b>.
        <br />
        <br />
        Este botón <b>no se esconde</b> cuando el panel cambia de pantalla
        —los demás widgets de la sección sí—, así que siempre queda a mano
        para volver. También funciona colocado dentro de la pantalla que se
        empotra: desde allí manda sobre el panel que la enseña.
      </div>
    </>
  );
}

// ─── Definición ──────────────────────────────────────────────────

export const botonPanel: CustomWidgetDef = {
  kind: KIND_BOTON_PANEL,
  label: ETIQUETA,
  category: 'Básicos',
  icon: MousePointerClickIcon,
  defaultWidth: 150,
  defaultHeight: 40,
  render: (ctx) => <Boton {...ctx} />,
  inspector: (ctx) => <InspectorBoton {...ctx} />,
  defaultConfig: CONFIG_BOTON_PANEL,
};
