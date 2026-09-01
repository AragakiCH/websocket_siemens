// =========================================================================
// Contenedor.tsx
// Agrupa widgets: los que sueltas encima viajan con él.
//
// PARA QUÉ SIRVE
// Un HMI real se llena de conjuntos que van juntos — el tanque con su nivel,
// su bomba y su etiqueta. Sin agrupar, recolocar ese conjunto es mover cinco
// widgets uno a uno y volver a cuadrarlos. Con el contenedor arrastras el
// marco y el conjunto entero se mueve manteniendo las distancias.
//
// CÓMO SE USA
//   1. Suelta el Contenedor en el lienzo y dale el tamaño de la zona.
//   2. Arrastra widgets encima. Al soltarlos quedan dentro (el Inspector del
//      widget te lo dice, y el contenedor muestra cuántos lleva).
//   3. Arrastra el contenedor: se mueve todo junto.
//   4. Para sacar uno, arrástralo fuera del marco. Sin menús.
//
// QUÉ NO HACE, Y POR QUÉ
// No recorta lo que sobresale ni redimensiona a los hijos al estirarlo. El
// contenedor organiza y mueve; no es una ventana con scroll ni un layout que
// reparte espacio. Estirarlo solo cambia la zona que "captura" widgets, así
// que puedes agrandarlo sin miedo a deformar lo de dentro.
//
// NO ES EL «PANEL DE SECCIÓN»
// Se parecen y hacen cosas distintas. El Panel de Sección tiene que ver con
// la NAVEGACIÓN: marca dónde se ve la sección abierta, y quién pertenece a
// qué sección se decide con el campo «Sección». El Contenedor es puramente de
// COLOCACIÓN: agrupa para mover, y le da igual la sección en la que estés.
// =========================================================================
import { GroupIcon } from 'lucide-react';
import type { CustomWidgetDef, RenderCtx, InspectorCtx } from '../types';
import { estiloDeParte } from '../../partes';

// ─── Config ──────────────────────────────────────────────────────

export interface ConfigContenedor {
  titulo: string;
  mostrarTitulo: boolean;
}

export const CONFIG_CONTENEDOR: ConfigContenedor = {
  titulo: 'Grupo',
  mostrarTitulo: true,
};

export function leerConfigContenedor(config: any): ConfigContenedor {
  const c = config ?? {};
  return {
    titulo: typeof c.titulo === 'string' ? c.titulo : CONFIG_CONTENEDOR.titulo,
    mostrarTitulo: c.mostrarTitulo !== false,
  };
}

// ─── Dibujo ──────────────────────────────────────────────────────

function Contenedor({ widget }: RenderCtx) {
  const cfg = leerConfigContenedor(widget.config);
  const pCaja = estiloDeParte(widget, 'box');
  const pTitulo = estiloDeParte(widget, 'label');

  // El cuerpo va VACÍO a propósito. Los widgets del grupo no se dibujan aquí
  // dentro: siguen siendo widgets del lienzo con sus coordenadas absolutas, y
  // se pintan encima de este marco. Ver grupo.ts para el porqué.
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        width: '100%',
        height: '100%',
        boxSizing: 'border-box',
        borderRadius: pCaja.borderRadius,
        // Sin borde configurado se dibuja uno punteado tenue: un contenedor
        // totalmente invisible no se puede agarrar para moverlo, y no se
        // entendería por qué los widgets "se mueven solos".
        border: pCaja.borderWidth
          ? `${pCaja.borderWidth}px solid ${pCaja.borderColor}`
          : '1px dashed rgba(148,163,184,0.55)',
        background: pCaja.background === 'transparent' ? 'transparent' : pCaja.background,
        opacity: pCaja.opacity,
        fontFamily: 'Inter, Arial, sans-serif',
        overflow: 'hidden',
      }}
    >
      {cfg.mostrarTitulo && !!cfg.titulo.trim() && (
        <div
          style={{
            padding: '5px 10px',
            flexShrink: 0,
            fontSize: pTitulo.fontSize,
            fontWeight: pTitulo.bold ? 700 : 600,
            color: pTitulo.color,
            textAlign: pTitulo.align,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            borderBottom: '1px solid rgba(148,163,184,0.2)',
          }}
        >
          {cfg.titulo}
        </div>
      )}
    </div>
  );
}

// ─── Panel del Inspector ─────────────────────────────────────────

function InspectorContenedor({ config, setConfig }: InspectorCtx) {
  const cfg = leerConfigContenedor(config);

  return (
    <>
      <label className="block">
        <span className="mb-1 block text-xs font-medium text-slate-500 dark:text-slate-400">
          Título
        </span>
        <input
          value={cfg.titulo}
          onChange={(e) => setConfig({ ...cfg, titulo: e.target.value })}
          placeholder="Sin título"
          className="w-full rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-navy outline-none transition focus:border-siemens focus:ring-2 focus:ring-siemens/20 dark:border-navy-slate dark:bg-navy dark:text-slate-100"
        />
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

      <div className="rounded-lg bg-slate-100 px-2.5 py-2 text-[11px] leading-relaxed text-slate-500 dark:bg-navy-slate/40 dark:text-slate-400">
        Arrastra widgets <b>encima</b> del contenedor para meterlos, y fuera del
        marco para sacarlos. Al mover el contenedor se mueve todo lo que lleva
        dentro. Estirarlo no deforma ni recorta el contenido.
      </div>
    </>
  );
}

// ─── Definición ──────────────────────────────────────────────────

export const contenedorGrupo: CustomWidgetDef = {
  kind: 'custom:contenedor',
  label: 'Contenedor',
  category: 'Básicos',
  icon: GroupIcon,
  defaultWidth: 320,
  defaultHeight: 220,
  render: (ctx) => <Contenedor {...ctx} />,
  inspector: (ctx) => <InspectorContenedor {...ctx} />,
  defaultConfig: CONFIG_CONTENEDOR,
};
