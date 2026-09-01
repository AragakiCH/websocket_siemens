// =========================================================================
// ValorUnidad.tsx
// Lectura numérica con su unidad: «19 km/h».
//
// Es el campo más común de un HMI: el número que viene del PLC y, al lado, en
// pequeño, en qué se mide. Nada más — sin escala, sin barra, sin colores por
// rango. Cuando solo hace falta leer un valor, un tanque o un medidor son
// ruido: ocupan sitio y no dicen nada que el número no diga mejor.
//
// LA UNIDAD LA ESCRIBES TÚ
// En el Inspector, y se guarda con el diseño. No se saca del PLC a propósito:
// el OPC UA no siempre la trae, y cuando la trae suele venir como el
// programador la escribió («KMH», «Km/h», vacía). Escribiéndola tú, la
// pantalla dice lo que tiene que decir y no depende de cómo esté el servidor.
//
// POR QUÉ NO SE USA `formatValue()`
// Esa función YA le pega la unidad del PlcVariable al número. Si la usáramos,
// una variable que trae unidad saldría con las dos: «19 km/h km/h». Aquí se
// formatea solo el número y la unidad la pone este widget, una sola vez.
// =========================================================================
import { GaugeIcon } from 'lucide-react';
import type { CustomWidgetDef, RenderCtx, InspectorCtx } from '../types';
import type { PlcVariable } from '../../../../models/plc';
import { estiloDeParte } from '../../partes';

// ─── Config ──────────────────────────────────────────────────────

export interface ConfigValorUnidad {
  unidad: string;
}

export const CONFIG_VALOR_UNIDAD: ConfigValorUnidad = { unidad: '' };

export function leerConfigValorUnidad(config: any): ConfigValorUnidad {
  const c = config ?? {};
  return { unidad: typeof c.unidad === 'string' ? c.unidad : '' };
}

/**
 * El número, sin unidad.
 *
 * Es `formatValue()` quitándole la última línea, la que engancha
 * `variable.unit`. Se repite aquí en vez de añadir un parámetro a la de
 * siempre porque ese `formatValue` lo usan los 18 widgets built-in y un
 * parámetro nuevo sería una bandera que hay que acertar en cada llamada.
 */
function soloValor(variable?: PlcVariable): string {
  if (!variable || variable.value === null || variable.value === undefined) return '—';
  if (variable.type === 'bool') return variable.value ? 'ON' : 'OFF';
  if (variable.type === 'string') return String(variable.value);

  const num = typeof variable.value === 'number' ? variable.value : Number(variable.value);
  if (Number.isNaN(num)) return String(variable.value);
  return variable.type === 'double' ? num.toFixed(1) : String(num);
}

// ─── Dibujo ──────────────────────────────────────────────────────

function ValorUnidad({ widget, variable }: RenderCtx) {
  const cfg = leerConfigValorUnidad(widget.config);
  const pValor = estiloDeParte(widget, 'valor');
  const pUnidad = estiloDeParte(widget, 'label');
  const pCaja = estiloDeParte(widget, 'box');

  /**
   * TAMAÑO DEL NÚMERO: automático hasta que lo toques.
   *
   * Se mira `widget.partes.valor.fontSize` en crudo, y no el estilo ya
   * resuelto, porque ese siempre trae un valor: el 14 que hereda del widget.
   * Con él no se puede distinguir «lo dejó como estaba» de «lo puso en 14», y
   * un readout a 14 px en una caja de 80 px de alto se ve perdido.
   *
   * Mientras no lo toques, crece con la caja: agrandas el widget y el número
   * se agranda, que es lo que esperas de un display.
   */
  const tamValor =
    widget.partes?.valor?.fontSize ??
    Math.max(14, Math.min(72, Math.round(widget.height * 0.44)));

  // Misma historia con la negrita, y por el mismo motivo: el estilo resuelto
  // hereda el `bold: false` del widget, así que preguntándole a él el número
  // saldría fino siempre. Un valor de proceso va en negrita — es lo que se
  // lee de un vistazo desde lejos —, y sigue pudiéndose quitar en Apariencia.
  const negritaValor = widget.partes?.valor?.bold ?? true;

  // Sin fondo ni borde configurados se dibuja una superficie tenue. Un campo
  // de lectura invisible no se distingue de una etiqueta suelta, y este es de
  // los widgets que se colocan en fila: sin caja no se ve dónde acaba uno y
  // empieza el siguiente. En cuanto pones fondo o borde en Apariencia → Caja,
  // manda lo tuyo (lo pinta el contenedor de WidgetRenderer) y esto se apaga.
  const sinCaja = pCaja.background === 'transparent' && !pCaja.borderWidth;

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent:
          pUnidad.align === 'left' ? 'flex-start' : pUnidad.align === 'right' ? 'flex-end' : 'center',
        gap: Math.max(4, Math.round(tamValor * 0.16)),
        width: '100%',
        height: '100%',
        boxSizing: 'border-box',
        padding: '4px 10px',
        overflow: 'hidden',
        borderRadius: pCaja.borderRadius,
        background: sinCaja ? 'rgba(148,163,184,0.10)' : undefined,
        border: sinCaja ? '1px solid rgba(148,163,184,0.32)' : undefined,
        fontFamily: 'Inter, Arial, sans-serif',
        // Las dos piezas apoyadas en la misma línea base, como se escribiría a
        // mano. Centradas por su caja, «19» y «km/h» quedan desalineadas
        // porque tienen alturas muy distintas.
        lineHeight: 1.1,
      }}
    >
      <span
        style={{
          fontSize: tamValor,
          fontWeight: negritaValor ? 700 : 500,
          color: pValor.color,
          // `tabular-nums`: todas las cifras ocupan lo mismo, así el número no
          // baila de ancho al pasar de 9 a 10 con el valor actualizándose.
          fontVariantNumeric: 'tabular-nums',
          whiteSpace: 'nowrap',
          alignSelf: 'baseline',
        }}
      >
        {soloValor(variable)}
      </span>

      {!!cfg.unidad.trim() && (
        <span
          style={{
            fontSize: pUnidad.fontSize,
            fontWeight: pUnidad.bold ? 700 : 500,
            color: pUnidad.color,
            whiteSpace: 'nowrap',
            alignSelf: 'baseline',
          }}
        >
          {cfg.unidad}
        </span>
      )}
    </div>
  );
}

// ─── Panel del Inspector ─────────────────────────────────────────

function InspectorValorUnidad({ config, setConfig }: InspectorCtx) {
  const cfg = leerConfigValorUnidad(config);

  return (
    <>
      <label className="block">
        <span className="mb-1 block text-xs font-medium text-slate-500 dark:text-slate-400">
          Unidad
        </span>
        <input
          value={cfg.unidad}
          onChange={(e) => setConfig({ unidad: e.target.value })}
          placeholder="km/h, bar, °C, rpm…"
          className="w-full rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-navy outline-none transition focus:border-siemens focus:ring-2 focus:ring-siemens/20 dark:border-navy-slate dark:bg-navy dark:text-slate-100"
        />
        <span className="mt-1 block text-[10px] leading-relaxed text-slate-400">
          Se escribe tal cual, sin tocar el PLC. Déjala vacía y solo se ve el
          número.
        </span>
      </label>

      <div className="rounded-lg bg-slate-100 px-2.5 py-2 text-[11px] leading-relaxed text-slate-500 dark:bg-navy-slate/40 dark:text-slate-400">
        El tamaño del número se ajusta solo al alto del widget. Si quieres
        fijarlo, ponlo en <b>Apariencia → Valor</b>; la unidad se estiliza en{' '}
        <b>Apariencia → Unidad</b>.
      </div>
    </>
  );
}

// ─── Definición ──────────────────────────────────────────────────

export const valorUnidad: CustomWidgetDef = {
  kind: 'custom:valor-unidad',
  label: 'Valor con Unidad',
  category: 'Datos',
  icon: GaugeIcon,
  defaultWidth: 180,
  defaultHeight: 80,
  render: (ctx) => <ValorUnidad {...ctx} />,
  inspector: (ctx) => <InspectorValorUnidad {...ctx} />,
  defaultConfig: CONFIG_VALOR_UNIDAD,
};
