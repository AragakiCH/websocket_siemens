// =========================================================================
// MiniaturaZip.tsx
// Un widget ZIP dibujado EN PEQUEÑO y SIN iframe: para las miniaturas de las
// Tarjetas de Acceso.
//
// EL PROBLEMA, EN NÚMEROS
// La pantalla principal de un proyecto real lleva 40 Tarjetas de Acceso; la
// vista de una línea enseña 10 a la vez. Cada tarjeta dibuja la pantalla a
// la que lleva, y cada una de esas pantallas tiene 25-35 widgets ZIP. Con
// el `HtmlWidgetRenderer` de siempre eso son 10 × 30 = **300 iframes**, cada
// uno un documento entero (HTML + CSS + JS del ZIP + el puente), construidos
// en el hilo principal. Por turnos de dos cada 40 ms son más de seis
// segundos solo en montarlos, y mientras tanto las tarjetas se ven grises.
// Y al volver a la vista general se vuelve a empezar, porque las tarjetas
// se desmontan al salir.
//
// LO QUE SE HACE AQUÍ
// Una miniatura es para RECONOCER la pantalla, no para operarla (ya lo
// decía la Tarjeta: sin ratón, sin valores en vivo). Así que el ZIP se
// pinta como lo que es por debajo: su HTML y su CSS, metidos en un Shadow
// DOM del documento principal. Sin iframe, sin documento nuevo, sin JS del
// widget, sin puente. Trescientos de estos cuestan lo que trescientos
// `innerHTML` de unos KB: decenas de milisegundos, no segundos.
//
// El Shadow DOM da lo que daba el iframe en lo que importa: el CSS del ZIP
// no se escapa a la aplicación ni el de la aplicación entra en el widget. Y
// la hoja de estilos se construye UNA vez por `kind` y se comparte entre
// todas las instancias (`adoptedStyleSheets`): ocho «lectura_dato_rpm» en
// una pantalla son ocho copias del HTML y UNA del CSS analizado.
//
// LO QUE NO HACE, A PROPÓSITO
//   · No ejecuta `widget.js`. Un ZIP cuyo dibujo lo genera su script sale
//     vacío en la miniatura (su caja, su fondo, su CSS); de cerca, en el
//     Panel de Sección, va con iframe y se ve entero. Es un precio
//     razonable: la alternativa eran los seis segundos.
//   · No vive un modal, ni un clic, ni una escritura. Nada de eso tiene
//     sentido a 200 px.
//
// Sí recibe los valores (etiqueta, valor, variables con nombre y las
// variables CSS `--w-*`), porque cuesta lo mismo ponerlos que no ponerlos y
// una miniatura con el dato real reconoce mejor que una con «—».
// =========================================================================
import { useLayoutEffect, useMemo, useRef } from 'react';
import type { HmiWidget, WidgetStyle } from '../../models/widget';
import type { PlcVariable } from '../../models/plc';
import type { ZipWidget } from '../../services/zipWidgetLoader';
import { formatValue, valueFraction, isTruthy } from '../../utils/format';

interface Props {
  zipWidget: ZipWidget;
  widget: HmiWidget;
  variable?: PlcVariable;
  enlaces?: Record<string, PlcVariable | undefined>;
  style: WidgetStyle;
}

// ─── Hojas de estilo compartidas por kind ─────────────────────────

/**
 * El CSS base es el mismo que el del iframe, traducido al Shadow DOM:
 * `html, body` no existen aquí dentro, el papel lo hace `:host`.
 */
const CSS_BASE = `
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  :host {
    display: flex; align-items: center; justify-content: center;
    width: 100%; height: 100%; overflow: hidden;
    container-type: size;
    background: transparent; font-family: Arial, sans-serif;
    --w-color: #009999; --w-bg: transparent; --w-border-color: #94a3b8;
    --w-on: 0; --w-frac: 0; --w-font-size: 14px; --w-bold: normal; --w-opacity: 1;
  }
`;

/**
 * Adapta el CSS del ZIP al Shadow DOM.
 *
 * Dentro de un shadow root no hay `html`, `body` ni `:root`: los tres pasan
 * a `:host`, que es el elemento que hace de documento. Se tocan solo como
 * SELECTOR (al principio de una regla o tras `,`, `>`, `+`, `~`, `}`), no
 * dentro de nombres como `.body-card` o `[data-body]`.
 */
function adaptarCss(css: string): string {
  return (
    css
      .replace(/:root\b/g, ':host')
      .replace(/(^|[\s,>+~}])(?:html|body)\b(?![-_\w])/g, '$1:host')
      // Dentro de un iframe, `1vw` es el 1 % del ANCHO DEL WIDGET (el iframe
      // es su propia ventana). Aquí la ventana es la de verdad, así que
      // `100vmin` pasaría de «el lado corto de la caja» a «el lado corto del
      // monitor». Las unidades de contenedor (`cqw`, `cqh`, `cqmin`,
      // `cqmax`) miden exactamente lo que medía el iframe, porque el host
      // se declara contenedor de tamaño (ver CSS_BASE).
      .replace(/(\d*\.?\d+)v(w|h|min|max)\b/gi, '$1cq$2')
  );
}

export type Hoja = CSSStyleSheet | string;
const hojas = new Map<string, Hoja>();

const soportaAdopted =
  typeof document !== 'undefined' &&
  typeof CSSStyleSheet !== 'undefined' &&
  'adoptedStyleSheets' in Document.prototype &&
  'replaceSync' in CSSStyleSheet.prototype;

export function hojaDe(zip: ZipWidget): Hoja {
  // La clave lleva el `actualizado_en`: si alguien reimporta el ZIP con otro
  // CSS, la hoja se reconstruye en vez de seguir sirviendo la vieja.
  const clave = `${zip.meta.kind}|${zip.actualizado_en ?? ''}|${zip.css.length}`;
  let h = hojas.get(clave);
  if (h) return h;
  const texto = CSS_BASE + adaptarCss(zip.css ?? '');
  if (soportaAdopted) {
    try {
      const s = new CSSStyleSheet();
      s.replaceSync(texto);
      h = s;
    } catch {
      h = texto;
    }
  } else {
    h = texto;
  }
  hojas.set(clave, h);
  return h;
}

// ─── HTML estático ────────────────────────────────────────────────

/**
 * Los mismos marcadores que entiende el iframe (`{{label}}`, `{{value}}`,
 * `{{name}}`), convertidos a spans con `data-w-*` para poder refrescarlos
 * sin volver a analizar el HTML. El `<script>` del ZIP, si lo lleva inline,
 * no corre: `innerHTML` nunca ejecuta scripts, y es justo lo que se quiere.
 */
export function htmlEstatico(html: string): string {
  return html
    .replace(/\{\{label\}\}/g, '<span data-w-label></span>')
    .replace(/\{\{value\}\}/g, '<span data-w-value></span>')
    .replace(/\{\{name\}\}/g, '<span data-w-name></span>');
}

export function poner(root: ShadowRoot, selector: string, texto: string): void {
  root.querySelectorAll(selector).forEach((el) => {
    if (el.textContent !== texto) el.textContent = texto;
  });
}

/**
 * Deja el HTML del ZIP y su hoja dentro del shadow root del `host` (lo
 * crea si no existe). Lo usan la miniatura y el modo ligero.
 */
export function montarEnShadow(host: HTMLElement, hoja: Hoja, html: string): ShadowRoot {
  const root = host.shadowRoot ?? host.attachShadow({ mode: 'open' });
  if (typeof hoja === 'string') {
    root.innerHTML = `<style>${hoja}</style>${html}`;
  } else {
    root.adoptedStyleSheets = [hoja];
    root.innerHTML = html;
  }
  return root;
}

// ─── Componente ───────────────────────────────────────────────────

export function MiniaturaZip({ zipWidget, widget, variable, enlaces, style }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  const html = useMemo(() => htmlEstatico(zipWidget.html ?? ''), [zipWidget.html]);
  const hoja = useMemo(() => hojaDe(zipWidget), [zipWidget]);

  // Estructura: solo cuando cambia el ZIP.
  useLayoutEffect(() => {
    const host = ref.current;
    if (!host) return;
    montarEnShadow(host, hoja, html);
  }, [html, hoja]);

  // Valores: lo mismo que manda el puente por postMessage, pero directo.
  const label = variable ? formatValue(variable) : widget.text ?? '';
  const valor = String(variable?.value ?? '');
  const on = isTruthy(variable);
  const frac = valueFraction(variable);

  useLayoutEffect(() => {
    const host = ref.current;
    const root = host?.shadowRoot;
    if (!host || !root) return;
    const s = host.style;
    s.setProperty('--w-color', style.color);
    s.setProperty('--w-bg', style.background);
    s.setProperty('--w-border-color', style.borderColor);
    s.setProperty('--w-on', on ? '1' : '0');
    s.setProperty('--w-frac', String(frac));
    s.setProperty('--w-font-size', `${style.fontSize}px`);
    s.setProperty('--w-bold', style.bold ? 'bold' : 'normal');
    s.setProperty('--w-opacity', String(style.opacity));
    for (const [k, v] of Object.entries(enlaces ?? {})) {
      s.setProperty(`--w-${k}-on`, isTruthy(v) ? '1' : '0');
      s.setProperty(`--w-${k}-frac`, String(valueFraction(v)));
      s.setProperty(`--w-${k}-value`, String(v?.value ?? ''));
      poner(root, `[data-w-var="${k}"]`, v ? formatValue(v) : '—');
    }
    poner(root, '[data-w-label]', String(label));
    poner(root, '[data-w-value]', valor);
    poner(root, '[data-w-name]', widget.name || '');
  }, [
    html, hoja, enlaces, label, valor, on, frac, widget.name,
    style.color, style.background, style.borderColor,
    style.fontSize, style.bold, style.opacity,
  ]);

  return (
    <div
      ref={ref}
      title={zipWidget.meta.label}
      style={{
        width: '100%',
        height: '100%',
        overflow: 'hidden',
        pointerEvents: 'none',
        // Igual que el iframe: el fondo lo pinta el contenedor del widget.
        background: 'transparent',
        colorScheme: 'light',
      }}
    />
  );
}
