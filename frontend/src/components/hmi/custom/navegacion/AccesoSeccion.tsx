// =========================================================================
// AccesoSeccion.tsx
// Tarjeta de acceso: un botón que lleva a otra sección y enseña, dentro,
// una miniatura VIVA de la pantalla a la que va.
//
// DE DÓNDE SALE
// Del proyecto de ejemplo (SCADA-SDF). Su «Vista general» no es una lista de
// enlaces: es una rejilla de tarjetas donde cada una dibuja en pequeño el
// sinóptico de su zona. El operador ve a dónde va ANTES de pulsar, y de paso
// la vista general se convierte en un resumen de la línea entera.
//
// QUÉ MIRA, Y QUÉ NO
// La miniatura es el diseño de verdad, cargado del servidor y escalado — no
// una captura ni un icono. Si alguien cambia esa pantalla en el Diseñador, la
// miniatura cambia con ella. Lo que NO trae son los valores en vivo: se
// dibuja con `interactivo` en falso, así que un widget interactivo de ahí
// dentro no responde al ratón. Una miniatura de 200 px no es sitio para
// operar; es sitio para reconocer.
//
// A DÓNDE SE VA: A UNA SECCIÓN, NO A UNA PANTALLA
// Podría parecer más directo apuntar a la pantalla, pero en esta aplicación
// una pantalla no se abre «a pelo»: se abre porque una sección del menú la
// tiene asignada, y el Panel de Sección la dibuja sin que el menú se mueva.
// Si esta tarjeta saltara a una pantalla suelta, no habría dónde pintarla.
//
// Apuntando a la sección se usa el MISMO `setVistaActiva` que el menú y que
// las pestañas de la barra: los tres mandos quedan sincronizados solos.
//
// POR QUÉ NO SE DIBUJA DENTRO DE UNA PANTALLA EMPOTRADA
// Está en `KINDS_NAVEGACION`, como el menú y el Panel de Sección. Si una
// tarjeta apuntara a una pantalla que a su vez tiene otra tarjeta apuntando
// de vuelta, cada miniatura dibujaría la siguiente sin final. Cortarlo aquí
// es una línea; detectarlo en caliente serían varias y un contador de
// profundidad que alguien tendría que mantener.
// =========================================================================
import { Suspense, lazy } from 'react';
import { ImageIcon, ArrowUpRightIcon, Loader2Icon } from 'lucide-react';
import type { CustomWidgetDef, RenderCtx, InspectorCtx } from '../types';
import {
  GRUPO_POR_DEFECTO,
  useVistaActiva,
  useSecciones,
  setVistaActiva,
  nombreDePantalla,
  esNivel,
} from './store';
import { CampoGrupo, AvisoVistaPropia } from './inspector';
import { estiloDeParte } from '../../partes';

/** Ver la nota del mismo `lazy()` en PantallaScreen: rompe un ciclo de imports. */
const PantallaEmbebida = lazy(() => import('./PantallaEmbebida'));

// ─── Config ──────────────────────────────────────────────────────

export interface ConfigAcceso {
  grupo: string;
  /** Sección a la que salta. Vacío = sin destino todavía. */
  seccion: string;
  mostrarTitulo: boolean;
  /** El nombre de la pantalla de destino, bajo el título. */
  mostrarDestino: boolean;
}

export const CONFIG_ACCESO: ConfigAcceso = {
  grupo: GRUPO_POR_DEFECTO,
  seccion: '',
  mostrarTitulo: true,
  mostrarDestino: true,
};

export function leerConfigAcceso(config: any): ConfigAcceso {
  const c = config ?? {};
  return {
    grupo:
      typeof c.grupo === 'string' && c.grupo.trim() ? c.grupo : GRUPO_POR_DEFECTO,
    seccion: typeof c.seccion === 'string' ? c.seccion : '',
    mostrarTitulo: c.mostrarTitulo !== false,
    mostrarDestino: c.mostrarDestino !== false,
  };
}

// ─── Dibujo ──────────────────────────────────────────────────────

function Acceso({ widget, interactivo }: RenderCtx) {
  const cfg = leerConfigAcceso(widget.config);
  const secciones = useSecciones(cfg.grupo);
  const activa = useVistaActiva(cfg.grupo);

  const pCaja = estiloDeParte(widget, 'box');
  const pTexto = estiloDeParte(widget, 'label');

  const destino = secciones.find((s) => s.id === cfg.seccion);
  const pantalla = (destino?.pantalla ?? '').trim();
  const esActual = !!cfg.seccion && cfg.seccion === activa;

  const titulo = destino?.label || destino?.id || 'Sin destino';

  const ir = () => {
    // En el Diseñador NO navega: ahí el clic sirve para seleccionar la
    // tarjeta y arrastrarla. Navegar al soltarla haría imposible colocarla.
    if (!interactivo || !cfg.seccion) return;
    setVistaActiva(cfg.grupo, cfg.seccion);
  };

  return (
    <div
      role={interactivo && cfg.seccion ? 'link' : undefined}
      tabIndex={interactivo && cfg.seccion ? 0 : undefined}
      aria-current={esActual ? 'page' : undefined}
      title={
        pantalla
          ? `Abrir «${titulo}» (${nombreDePantalla(pantalla) || pantalla})`
          : `Abrir «${titulo}»`
      }
      onClick={ir}
      onKeyDown={(e) => {
        // Enter y espacio, como en el proyecto de ejemplo: en planta se
        // navega con teclado más de lo que parece, y un <div> pulsable que
        // solo responde al ratón deja fuera esa forma de trabajar.
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          ir();
        }
      }}
      style={{
        display: 'flex',
        flexDirection: 'column',
        width: '100%',
        height: '100%',
        boxSizing: 'border-box',
        overflow: 'hidden',
        cursor: interactivo && cfg.seccion ? 'pointer' : 'default',
        borderRadius: pCaja.borderRadius,
        border: `${pCaja.borderWidth || 1}px solid ${
          esActual ? pTexto.color : pCaja.borderColor
        }`,
        // La que está abierta se marca, igual que la pestaña activa de la
        // barra: si no, una rejilla de tarjetas no dice en cuál estás.
        boxShadow: esActual ? `0 0 0 1px ${pTexto.color}` : 'none',
        background:
          pCaja.background === 'transparent' ? 'rgba(255,255,255,0.9)' : pCaja.background,
        opacity: pCaja.opacity,
        fontFamily: 'Inter, Arial, sans-serif',
      }}
    >
      {cfg.mostrarTitulo && (
        <div
          style={{
            display: 'flex',
            alignItems: 'baseline',
            gap: 6,
            padding: '7px 10px 5px',
            flexShrink: 0,
          }}
        >
          <span
            style={{
              fontSize: pTexto.fontSize,
              fontWeight: pTexto.bold ? 700 : 600,
              color: pTexto.color,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {titulo}
          </span>

          {cfg.mostrarDestino && pantalla && (
            <span
              style={{
                fontSize: Math.max(9, (pTexto.fontSize ?? 14) - 4),
                color: 'rgba(100,116,139,0.9)',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
            >
              {nombreDePantalla(pantalla) || pantalla}
            </span>
          )}

          <ArrowUpRightIcon
            style={{
              width: 13,
              height: 13,
              marginLeft: 'auto',
              flexShrink: 0,
              color: pTexto.color,
              opacity: 0.7,
            }}
          />
        </div>
      )}

      {/* La miniatura. */}
      <div
        style={{
          flex: 1,
          minHeight: 0,
          position: 'relative',
          margin: '0 8px 8px',
          borderRadius: 4,
          overflow: 'hidden',
          background: 'rgba(148,163,184,0.10)',
          // Ni el ratón ni el teclado entran: lo que se pulsa es la tarjeta
          // entera. Sin esto, un botón del diseño de dentro se tragaría el
          // clic y la tarjeta no navegaría.
          pointerEvents: 'none',
        }}
      >
        {pantalla ? (
          <Suspense
            fallback={
              <div
                style={{
                  display: 'flex',
                  height: '100%',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 6,
                  fontSize: 11,
                  color: 'rgba(100,116,139,0.9)',
                }}
              >
                <Loader2Icon style={{ width: 13, height: 13 }} className="animate-spin" />
                Cargando…
              </div>
            }
          >
            <PantallaEmbebida
              key={pantalla}
              projectId={pantalla}
              modo="ajustar"
              interactivo={false}
            />
          </Suspense>
        ) : (
          <div
            style={{
              display: 'flex',
              height: '100%',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 4,
              padding: 8,
              textAlign: 'center',
              fontSize: 10,
              lineHeight: 1.4,
              color: 'rgba(100,116,139,0.9)',
            }}
          >
            <ImageIcon style={{ width: 16, height: 16, opacity: 0.6 }} />
            {cfg.seccion
              ? 'Esta sección no abre ninguna pantalla, así que no hay nada que previsualizar.'
              : 'Elige a qué sección lleva esta tarjeta.'}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Panel del Inspector ─────────────────────────────────────────

function InspectorAcceso({ widget, config, setConfig }: InspectorCtx) {
  const cfg = leerConfigAcceso(config);
  const secciones = useSecciones(cfg.grupo);

  // Los niveles son encabezados del menú: no se pulsan y no abren nada, así
  // que ofrecerlos aquí sería ofrecer un destino que no lleva a ningún sitio.
  const elegibles = secciones.filter((s) => !esNivel(s));
  const destino = secciones.find((s) => s.id === cfg.seccion);
  const pantalla = (destino?.pantalla ?? '').trim();

  return (
    <>
      <AvisoVistaPropia vista={widget.vista} />

      <CampoGrupo valor={cfg.grupo} onChange={(grupo) => setConfig({ ...cfg, grupo })} />

      <label className="block">
        <span className="mb-1 block text-xs font-medium text-slate-500 dark:text-slate-400">
          Lleva a la sección
        </span>
        <select
          value={cfg.seccion}
          onChange={(e) => setConfig({ ...cfg, seccion: e.target.value })}
          className="w-full cursor-pointer rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-navy outline-none transition focus:border-siemens focus:ring-2 focus:ring-siemens/20 dark:border-navy-slate dark:bg-navy dark:text-slate-100"
        >
          <option value="">— Sin destino —</option>
          {elegibles.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label || s.id}
              {(s.pantalla ?? '').trim() ? '' : '  (sin pantalla)'}
            </option>
          ))}
        </select>
      </label>

      <label className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-slate-500 dark:text-slate-400">
          Mostrar título
        </span>
        <input
          type="checkbox"
          checked={cfg.mostrarTitulo}
          onChange={(e) => setConfig({ ...cfg, mostrarTitulo: e.target.checked })}
          className="h-4 w-4 rounded border-slate-300 text-siemens focus:ring-2 focus:ring-siemens/40 dark:border-navy-slate dark:bg-navy"
        />
      </label>

      <label className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-slate-500 dark:text-slate-400">
          Mostrar la pantalla de destino
        </span>
        <input
          type="checkbox"
          checked={cfg.mostrarDestino}
          onChange={(e) => setConfig({ ...cfg, mostrarDestino: e.target.checked })}
          className="h-4 w-4 rounded border-slate-300 text-siemens focus:ring-2 focus:ring-siemens/40 dark:border-navy-slate dark:bg-navy"
        />
      </label>

      <div className="rounded-lg bg-slate-100 px-2.5 py-2 text-[11px] leading-relaxed text-slate-500 dark:bg-navy-slate/40 dark:text-slate-400">
        {elegibles.length === 0 ? (
          <>
            Este grupo todavía no tiene secciones. Agrega un <b>Menú Lateral</b>{' '}
            con el grupo «{cfg.grupo}».
          </>
        ) : !cfg.seccion ? (
          <>
            Elige arriba a qué sección lleva. La miniatura enseñará la pantalla
            que esa sección tenga asignada en el <b>Menú Lateral</b>.
          </>
        ) : pantalla ? (
          <>
            Se previsualiza <b>{nombreDePantalla(pantalla) || pantalla}</b>, que
            es la pantalla asignada a «{destino?.label || cfg.seccion}».
            <br />
            <br />
            La miniatura es el diseño de verdad, no una captura: si cambia esa
            pantalla, cambia aquí. No trae valores en vivo — una miniatura no es
            sitio para operar.
          </>
        ) : (
          <>
            «{destino?.label || cfg.seccion}» no tiene ninguna pantalla asignada,
            así que no hay nada que previsualizar: la tarjeta navegará igual,
            pero enseñará un hueco.
            <br />
            <br />
            Para asignársela, elígela en el desplegable de esa sección, en las
            propiedades del <b>Menú Lateral</b>.
          </>
        )}
      </div>
    </>
  );
}

// ─── Definición ──────────────────────────────────────────────────

export const accesoSeccion: CustomWidgetDef = {
  kind: 'custom:acceso-seccion',
  label: 'Acceso a Sección',
  category: 'Básicos',
  icon: ImageIcon,
  defaultWidth: 260,
  defaultHeight: 190,
  render: (ctx) => <Acceso {...ctx} />,
  inspector: (ctx) => <InspectorAcceso {...ctx} />,
  defaultConfig: CONFIG_ACCESO,
};
