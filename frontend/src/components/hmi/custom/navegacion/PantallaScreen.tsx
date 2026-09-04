// =========================================================================
// PantallaScreen.tsx
// Contenedor de pantallas: el marco donde vive la vista que está abierta.
//
// QUÉ HACE Y QUÉ NO
// No dibuja el contenido de cada vista — ese contenido son los widgets que ya
// pones en el lienzo (tanques, gráficas, LEDs), cada uno con su "Vista"
// asignada en el Inspector. Este widget es el MARCO: el fondo sobre el que se
// apoyan y la cabecera que dice en qué sección estás.
//
// Es el mismo reparto que en WebIQ: la navegación cambia el screen activo, y
// el contenido de cada screen son sus propios elementos.
//
// POR QUÉ NO ANIDA WIDGETS DENTRO
// En este editor los widgets van posicionados en absoluto sobre un lienzo
// plano, no unos dentro de otros. Meter widgets dentro de otro obligaría a
// rehacer el arrastre, el redimensionado y el guardado. Con las capas se
// consigue lo mismo sin tocar nada de eso: colocas el widget encima del
// marco y le dices a qué vista pertenece.
//
// COLÓCALO DETRÁS
// Es un fondo, así que va debajo del resto. Suéltalo primero y luego pon
// encima los widgets de cada vista.
// =========================================================================
import { LayoutTemplateIcon } from 'lucide-react';
import type { CustomWidgetDef, RenderCtx, InspectorCtx } from '../types';
import {
  GRUPO_POR_DEFECTO,
  useVistaActiva,
  useSecciones,
  etiquetaDeVista,
} from './store';
import { CampoGrupo, AvisoVistaPropia } from './inspector';
import { estiloDeParte } from '../../partes';

// ─── Config del widget ───────────────────────────────────────────

export interface ConfigScreen {
  grupo: string;
  mostrarCabecera: boolean;
}

export const CONFIG_SCREEN: ConfigScreen = {
  grupo: GRUPO_POR_DEFECTO,
  mostrarCabecera: true,
};

export function leerConfigScreen(config: any): ConfigScreen {
  const c = config ?? {};
  return {
    grupo: typeof c.grupo === 'string' && c.grupo.trim() ? c.grupo : GRUPO_POR_DEFECTO,
    mostrarCabecera: c.mostrarCabecera !== false,
  };
}

// ─── Dibujo ──────────────────────────────────────────────────────

function Screen({ widget }: RenderCtx) {
  const cfg = leerConfigScreen(widget.config);

  // Caja y Cabecera por separado, igual que en el Menú Lateral.
  const pCaja = estiloDeParte(widget, 'box');
  const pCab = estiloDeParte(widget, 'label');
  const activa = useVistaActiva(cfg.grupo);

  const nombre = etiquetaDeVista(cfg.grupo, activa);

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
        border: pCaja.borderWidth
          ? `${pCaja.borderWidth}px solid ${pCaja.borderColor}`
          : '1px dashed rgba(148,163,184,0.5)',
        background:
          pCaja.background === 'transparent' ? 'rgba(148,163,184,0.07)' : pCaja.background,
        opacity: pCaja.opacity,
        fontFamily: 'Inter, Arial, sans-serif',
      }}
    >
      {cfg.mostrarCabecera && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '8px 12px',
            borderBottom: '1px solid rgba(148,163,184,0.25)',
            flexShrink: 0,
          }}
        >
          <span
            style={{
              width: 6,
              height: 6,
              borderRadius: '50%',
              background: pCab.color,
              flexShrink: 0,
            }}
          />
          <span
            style={{
              fontSize: pCab.fontSize,
              fontWeight: pCab.bold ? 700 : 600,
              color: pCab.color,
              textAlign: pCab.align,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {nombre || 'Sin sección activa'}
          </span>
        </div>
      )}

      {/* El hueco donde van los widgets de la vista: VACÍO, y a propósito.
          Antes traía un párrafo explicando cómo funcionaba, y era un mal
          sitio para ponerlo: el marco se ve tal cual en la Vista Previa y en
          el panel del operador, así que esa explicación acababa impresa en la
          pantalla de planta. Lo mismo está dicho en el Inspector, que es
          donde se lee mientras diseñas y no molesta a nadie después. */}
      <div style={{ flex: 1, minHeight: 0 }} />
    </div>
  );
}

// ─── Panel del Inspector ─────────────────────────────────────────

function InspectorScreen({ widget, config, setConfig }: InspectorCtx) {
  const cfg = leerConfigScreen(config);
  const secciones = useSecciones(cfg.grupo);

  return (
    <>
      <AvisoVistaPropia vista={widget.vista} />

      <CampoGrupo
        valor={cfg.grupo}
        onChange={(grupo) => setConfig({ ...cfg, grupo })}
      />

      <label className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-slate-500 dark:text-slate-400">
          Mostrar cabecera
        </span>
        <input
          type="checkbox"
          checked={cfg.mostrarCabecera}
          onChange={(e) => setConfig({ ...cfg, mostrarCabecera: e.target.checked })}
          className="h-4 w-4 rounded border-slate-300 text-siemens focus:ring-2 focus:ring-siemens/40 dark:border-navy-slate dark:bg-navy"
        />
      </label>

      <div className="rounded-lg bg-slate-100 px-2.5 py-2 text-[11px] leading-relaxed text-slate-500 dark:bg-navy-slate/40 dark:text-slate-400">
        {secciones.length === 0 ? (
          <>
            Este grupo todavía no tiene secciones. Agrega un{' '}
            <b>Menú Lateral</b> con el grupo «{cfg.grupo}».
          </>
        ) : (
          <>
            {secciones.length} vista{secciones.length === 1 ? '' : 's'} en este grupo:{' '}
            <b>{secciones.map((s) => s.label || s.id).join(' · ')}</b>
          </>
        )}
      </div>
    </>
  );
}

// ─── Definición ──────────────────────────────────────────────────

export const pantallaScreen: CustomWidgetDef = {
  kind: 'custom:pantalla-screen',
  // OJO: el `kind` se queda como está. Cambiarlo dejaría huérfano cualquier
  // widget ya colocado en un lienzo guardado.
  label: 'Panel de Sección',
  // RETIRADO. Enmarcaba la vista abierta y ponía su nombre encima, pero
  // no hacía nada más: los widgets se muestran y se esconden solos según
  // su sección, con marco o sin él. Un widget que hay que colocar para
  // que la navegación «se vea completa» y que no cambia nada confunde más
  // de lo que ayuda. Los que ya estén puestos se siguen dibujando.
  oculto: true,
  category: 'Básicos',
  icon: LayoutTemplateIcon,
  defaultWidth: 420,
  defaultHeight: 320,
  render: (ctx) => <Screen {...ctx} />,
  inspector: (ctx) => <InspectorScreen {...ctx} />,
  defaultConfig: CONFIG_SCREEN,
};
