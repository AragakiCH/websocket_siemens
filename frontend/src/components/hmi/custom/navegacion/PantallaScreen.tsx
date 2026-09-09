// =========================================================================
// PantallaScreen.tsx
// Panel de Sección: el marco donde se dibuja la vista que está abierta.
//
// HACE DOS COSAS, SEGÚN LO QUE DIGA LA SECCIÓN ABIERTA
//
//   1. SIN PANTALLA ASIGNADA — el comportamiento de siempre. Es solo el
//      marco: el fondo sobre el que se apoyan los widgets de este mismo
//      lienzo y la cabecera que dice en qué sección estás. El contenido son
//      los widgets que ya pones alrededor, cada uno con su «Vista» asignada
//      en el Inspector; el marco no los contiene, son vecinos suyos.
//
//   2. CON PANTALLA ASIGNADA — carga ESA pantalla del proyecto y la dibuja
//      aquí dentro, escalada al hueco. Es lo que permite que el menú de la
//      izquierda lleve a pantallas completas sin desaparecer: nunca se sale
//      del proyecto actual, así que el menú sigue donde estaba y lo único
//      que cambia es el contenido del panel.
//
// La asignación se hace en el Inspector del MENÚ LATERAL, en el desplegable
// de cada sección — no aquí. Este widget solo obedece.
//
// POR QUÉ NO ANIDA WIDGETS DENTRO
// En este editor los widgets van posicionados en absoluto sobre un lienzo
// plano, no unos dentro de otros. Meter widgets dentro de otro obligaría a
// rehacer el arrastre, el redimensionado y el guardado. Para el caso 1 se
// consigue lo mismo con las capas; para el caso 2, la pantalla empotrada
// llega entera desde el servidor y se dibuja de una pieza.
//
// COLÓCALO DETRÁS
// Es un fondo, así que va debajo del resto. Suéltalo primero y luego pon
// encima los widgets de cada vista.
// =========================================================================
import { Suspense, lazy } from 'react';
import { LayoutTemplateIcon, Loader2Icon } from 'lucide-react';
import type { CustomWidgetDef, RenderCtx, InspectorCtx } from '../types';
import {
  GRUPO_POR_DEFECTO,
  useVistaActiva,
  useSecciones,
  etiquetaDeVista,
  nombreDePantalla,
} from './store';
import { CampoGrupo, AvisoVistaPropia } from './inspector';
import { estiloDeParte } from '../../partes';
import type { ModoAjuste } from './PantallaEmbebida';

/**
 * El dibujo de la pantalla empotrada se carga aparte, y no por tamaño: es
 * para ROMPER UN CICLO DE IMPORTS.
 *
 * Ese módulo necesita `WidgetRenderer` para dibujar, y `WidgetRenderer`
 * importa `custom/registry`, que importa este archivo:
 *
 *     registry → PantallaScreen → WidgetRenderer → registry
 *
 * Un import dinámico no entra en el grafo estático, así que el ciclo no
 * llega a formarse. De paso, quien no use pantallas empotradas no se
 * descarga nada de esto.
 *
 * `lazy()` va en el MÓDULO, no dentro del componente: creado en cada render
 * devolvería un tipo de componente nuevo cada vez y React desmontaría y
 * volvería a montar el panel sin parar.
 */
const PantallaEmbebida = lazy(() => import('./PantallaEmbebida'));

// ─── Config del widget ───────────────────────────────────────────

export interface ConfigScreen {
  grupo: string;
  mostrarCabecera: boolean;
  /**
   * Cómo encaja el lienzo de la pantalla empotrada en el marco.
   *
   *   ajustar  Una sola escala para los dos ejes: cabe entero y no se
   *            deforma. Sobra margen si las proporciones no coinciden.
   *   estirar  Escala cada eje por su lado: llena el marco, pero deforma.
   *   real     Sin escalar, con barras si no cabe.
   *
   * Por defecto «ajustar»: es el único que nunca miente sobre las formas, y
   * en un HMI una válvula ovalada porque el panel era más ancho es un
   * problema de verdad.
   */
  ajuste: ModoAjuste;
}

export const CONFIG_SCREEN: ConfigScreen = {
  grupo: GRUPO_POR_DEFECTO,
  mostrarCabecera: true,
  ajuste: 'ajustar',
};

const AJUSTES: { valor: ModoAjuste; label: string; ayuda: string }[] = [
  { valor: 'ajustar', label: 'Ajustar (mantiene proporción)',
    ayuda: 'Cabe entera sin deformarse. Puede sobrar margen.' },
  { valor: 'estirar', label: 'Estirar (llena el marco)',
    ayuda: 'Ocupa todo el hueco, pero deforma si las proporciones no coinciden.' },
  { valor: 'real', label: 'Tamaño real (con scroll)',
    ayuda: 'Sin escalar. Aparecen barras si la pantalla no cabe.' },
];

export function leerConfigScreen(config: any): ConfigScreen {
  const c = config ?? {};
  const ajuste = AJUSTES.some((a) => a.valor === c.ajuste)
    ? (c.ajuste as ModoAjuste)
    : CONFIG_SCREEN.ajuste;
  return {
    grupo: typeof c.grupo === 'string' && c.grupo.trim() ? c.grupo : GRUPO_POR_DEFECTO,
    mostrarCabecera: c.mostrarCabecera !== false,
    ajuste,
  };
}

// ─── Dibujo ──────────────────────────────────────────────────────

function Screen({ widget, interactivo }: RenderCtx) {
  const cfg = leerConfigScreen(widget.config);

  // Caja y Cabecera por separado, igual que en el Menú Lateral.
  const pCaja = estiloDeParte(widget, 'box');
  const pCab = estiloDeParte(widget, 'label');
  const activa = useVistaActiva(cfg.grupo);
  const secciones = useSecciones(cfg.grupo);

  const nombre = etiquetaDeVista(cfg.grupo, activa);

  // A qué pantalla apunta la sección abierta. Sale de la lista que publica
  // el propio menú, así que no hace falta ningún canal nuevo: el objeto
  // `Seccion` ya viaja entero con su campo `pantalla` dentro.
  const destino = (secciones.find((s) => s.id === activa)?.pantalla ?? '').trim();

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

      {/* El hueco. Vacío cuando la sección no apunta a ninguna pantalla —y a
          propósito: ahí el contenido son los widgets de este mismo lienzo,
          que se dibujan por encima del marco, no dentro de él. */}
      <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
        {!!destino && (
          <Suspense
            fallback={
              <div className="flex h-full w-full items-center justify-center gap-2 text-xs text-slate-400">
                <Loader2Icon className="h-4 w-4 animate-spin" />
                Cargando…
              </div>
            }
          >
            {/* La `key` fuerza un montaje limpio al cambiar de pantalla. Sin
                ella, React reutilizaría el componente y durante un instante
                se verían los widgets de la pantalla anterior con las medidas
                de la nueva. */}
            <PantallaEmbebida
              key={destino}
              projectId={destino}
              modo={cfg.ajuste}
              interactivo={!!interactivo}
            />
          </Suspense>
        )}
      </div>
    </div>
  );
}

// ─── Panel del Inspector ─────────────────────────────────────────

function InspectorScreen({ widget, config, setConfig }: InspectorCtx) {
  const cfg = leerConfigScreen(config);
  const secciones = useSecciones(cfg.grupo);

  // Qué secciones saltan a otra pantalla. Se enseña aquí porque la
  // asignación se hace en el OTRO widget (el menú), y sin esto no habría
  // forma de saber desde aquí qué va a aparecer dentro del marco.
  const conDestino = secciones.filter((s) => (s.pantalla ?? '').trim());
  const ayudaAjuste = AJUSTES.find((a) => a.valor === cfg.ajuste)?.ayuda ?? '';

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

      <label className="block">
        <span className="mb-1 block text-xs font-medium text-slate-500 dark:text-slate-400">
          Ajuste de la pantalla empotrada
        </span>
        <select
          value={cfg.ajuste}
          onChange={(e) =>
            setConfig({ ...cfg, ajuste: e.target.value as ModoAjuste })
          }
          className="w-full cursor-pointer rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-navy outline-none transition focus:border-siemens focus:ring-2 focus:ring-siemens/20 dark:border-navy-slate dark:bg-navy dark:text-slate-100"
        >
          {AJUSTES.map((a) => (
            <option key={a.valor} value={a.valor}>
              {a.label}
            </option>
          ))}
        </select>
        <span className="mt-1 block text-[10px] leading-relaxed text-slate-400">
          {ayudaAjuste}
        </span>
      </label>

      <div className="rounded-lg bg-slate-100 px-2.5 py-2 text-[11px] leading-relaxed text-slate-500 dark:bg-navy-slate/40 dark:text-slate-400">
        {secciones.length === 0 ? (
          <>
            Este grupo todavía no tiene secciones. Agrega un{' '}
            <b>Menú Lateral</b> con el grupo «{cfg.grupo}».
          </>
        ) : conDestino.length === 0 ? (
          <>
            {secciones.length} vista{secciones.length === 1 ? '' : 's'} en este
            grupo:{' '}
            <b>{secciones.map((s) => s.label || s.id).join(' · ')}</b>.
            <br />
            <br />
            Ninguna apunta todavía a otra pantalla, así que este marco solo
            hace de fondo. Para que una sección abra una pantalla completa
            aquí dentro, elígela en el desplegable de esa sección, en las
            propiedades del <b>Menú Lateral</b>.
          </>
        ) : (
          <>
            Secciones que abren una pantalla aquí dentro:
            <br />
            {conDestino.map((s) => (
              <span key={s.id} className="mt-0.5 block">
                <b>{s.label || s.id}</b> →{' '}
                {nombreDePantalla(s.pantalla!) || s.pantalla}
              </span>
            ))}
            <span className="mt-1.5 block">
              Las demás ({secciones.length - conDestino.length}) siguen
              mostrando los widgets de este mismo lienzo.
            </span>
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
  // DE VUELTA EN LA PALETA. Se había retirado (`oculto: true`) porque solo
  // enmarcaba la vista abierta y no cambiaba nada: los widgets se muestran y
  // se esconden solos según su sección, con marco o sin él.
  //
  // Ahora sí hace algo que no se puede hacer de otra forma: es el hueco donde
  // se dibuja OTRA pantalla del proyecto cuando una sección la tiene
  // asignada. Sin él, esa navegación no tiene dónde ocurrir.
  category: 'Básicos',
  icon: LayoutTemplateIcon,
  defaultWidth: 420,
  defaultHeight: 320,
  render: (ctx) => <Screen {...ctx} />,
  inspector: (ctx) => <InspectorScreen {...ctx} />,
  defaultConfig: CONFIG_SCREEN,
};
