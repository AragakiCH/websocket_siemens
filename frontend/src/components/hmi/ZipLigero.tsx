// =========================================================================
// ZipLigero.tsx
// Un widget ZIP dibujado EN LA PÁGINA, sin iframe: Shadow DOM para su HTML
// y su CSS, y su `widget.js` ejecutado dentro de un ámbito que le da el
// `window` y el `document` que espera.
//
// POR QUÉ EXISTE
// Un iframe es un documento entero: el navegador le crea su contexto de
// JavaScript, analiza el HTML, construye el CSSOM, corre nuestro puente y
// después el script del ZIP. Son unos pocos milisegundos cada uno, pero la
// pantalla «Secador» de una línea son tres faceplates con treinta ZIP cada
// uno: noventa documentos. Aunque se monten todos a la vez, el navegador los
// va terminando de uno en uno durante medio segundo, y eso se VE: unos
// aparecen, otros todavía no. Por turnos, por tandas o de golpe, con iframes
// no hay forma de que noventa documentos aparezcan en el mismo fotograma.
//
// Sin documento no hay ese coste. Noventa `innerHTML` de unos KB y noventa
// scripts de 3 KB son decenas de milisegundos EN TOTAL, y todo se pinta en
// el mismo fotograma. Es la diferencia entre «carga rápido» y «ya está».
//
// LO QUE SE LE DA AL SCRIPT DEL ZIP
// Los 136 widgets de un proyecto real usan una superficie pequeña y
// constante (se midió antes de escribir esto):
//
//   document.querySelector / querySelectorAll / getElementById   -> el shadow root
//   document.addEventListener('DOMContentLoaded')                -> ya está listo: se llama
//   document.readyState / activeElement / documentElement        -> 'complete' / root / host
//   document.fonts / createElement / createElementNS             -> el documento real
//   window.WIDGET / onWidgetUpdate / onWidgetEscrito / escribir  -> el puente
//   window.addEventListener('resize' | 'message')                -> ResizeObserver del host / el puente
//   ResizeObserver, requestAnimationFrame, getComputedStyle      -> los reales
//
// Todo eso se resuelve con dos objetos (`window` y `document` de mentira) y
// un `with` que los pone delante del ámbito global. Lo que el script no
// encuentre en ellos cae al `window` real, así que un `devicePixelRatio` o un
// `setTimeout` siguen funcionando.
//
// LO QUE CAMBIA RESPECTO AL IFRAME, Y HAY QUE SABERLO
//   · AISLAMIENTO. El script del ZIP corre en la misma página que la
//     aplicación. Con `with` se le interponen un `window` y un `document`
//     propios, pero eso es una comodidad, no un sandbox: un script que
//     quiera salir, sale. Es aceptable porque un ZIP solo lo importa un
//     Administrador (PUT /widgets exige ese rol): es código de la
//     instalación, como un plugin, no contenido de terceros. Quien no quiera
//     asumirlo tiene el iframe de siempre a un paso (ver `esLigero`).
//   · MODALES. Un `position: fixed` del ZIP se mide contra la ventana... o
//     contra el lienzo, porque el lienzo lleva `transform: scale()`. Los ZIP
//     con `fixed` en su CSS o con `<script>` dentro del HTML siguen yendo
//     por iframe: `esLigero()` los reconoce y los manda allí. (`vw`/`vh` sí
//     van ligeros: se traducen a unidades de contenedor, que miden la caja
//     del widget igual que las medía el iframe.)
//   · SI EL SCRIPT REVIENTA AL ARRANCAR, se vuelve al iframe para ESE widget
//     y se deja constancia en la consola. Mejor un iframe lento que un hueco.
// =========================================================================
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { HmiWidget, WidgetStyle } from '../../models/widget';
import type { PlcVariable } from '../../models/plc';
import type { ZipWidget } from '../../services/zipWidgetLoader';
import { formatValue, valueFraction, isTruthy } from '../../utils/format';
import { escribir, partirId } from '../../services/escrituraApi';
import { permiteEscritura } from './acciones';
import { HtmlWidgetRenderer } from './HtmlWidgetRenderer';
import { hojaDe, htmlEstatico, montarEnShadow, poner } from './MiniaturaZip';
import { ahora, traza } from '../../utils/traza';

interface Props {
  zipWidget: ZipWidget;
  widget: HmiWidget;
  variable?: PlcVariable;
  enlaces?: Record<string, PlcVariable | undefined>;
  style: WidgetStyle;
  interactivo?: boolean;
  onModal?: (abierto: boolean) => void;
  onClic?: () => void;
  clicable?: boolean;
}

// ─── ¿Este ZIP puede ir sin iframe? ───────────────────────────────

const compatibilidad = new Map<string, boolean>();

/**
 * Decidido una vez por ZIP, mirando su código. Conservador a propósito: ante
 * la duda, iframe, que es lo que siempre ha funcionado.
 */
export function esLigero(zip: ZipWidget): boolean {
  const clave = `${zip.meta.kind}|${zip.actualizado_en ?? ''}|${zip.js.length}|${zip.css.length}`;
  const previo = compatibilidad.get(clave);
  if (previo !== undefined) return previo;

  const css = zip.css ?? '';
  const html = zip.html ?? '';
  const js = zip.js ?? '';
  // (`vw`/`vh` NO excluyen: se traducen a unidades de contenedor, que miden
  // lo mismo que medían en el iframe. Ver `adaptarCss` en MiniaturaZip.)
  const ok =
    !/position\s*:\s*fixed/i.test(css + html) &&
    !/<script\b/i.test(html) &&
    !/\b(document\.(body|head|write|cookie)|window\.(open|top|parent|location)|localStorage|sessionStorage|XMLHttpRequest|\bfetch\s*\(|\bimport\s*\(|\beval\s*\()/.test(js);
  compatibilidad.set(clave, ok);
  return ok;
}

// ─── El ámbito del script ─────────────────────────────────────────

interface Puente {
  widget: Record<string, unknown>;
  clicable: boolean;
  /** Oyentes de `window.addEventListener('message')`. */
  mensajes: Set<(e: { data: unknown }) => void>;
  /** Oyentes de `window.addEventListener('resize')`. */
  redimension: Set<() => void>;
  escribir: (valor: unknown, variable?: string) => void;
  /** El `window` de mentira del script, para llamarle a `onWidgetUpdate`. */
  win: any;
}

const WIDGET_INICIAL = {
  value: '', on: false, frac: 0, label: '', name: '',
  color: '#009999', bg: 'transparent', borderColor: '#94a3b8',
  fontSize: 14, bold: false, opacity: 1,
  escritura: false, unidad: '', vars: {},
};

function crearAmbito(host: HTMLElement, root: ShadowRoot, puente: Puente) {
  // `document` de mentira: lo que mira dentro del widget va al shadow root;
  // lo que crea nodos o pregunta por fuentes va al documento real.
  const doc = new Proxy(document, {
    get(real, k) {
      switch (k) {
        case 'querySelector':
        case 'querySelectorAll':
        case 'getElementById':
          return (root as any)[k].bind(root);
        case 'readyState':
          return 'complete';
        case 'activeElement':
          return root.activeElement;
        case 'documentElement':
        case 'body':
          return host;
        case 'addEventListener':
          return (tipo: string, fn: any, opts?: any) => {
            if (tipo === 'DOMContentLoaded' || tipo === 'readystatechange') {
              // Ya está todo en su sitio: se llama en cuanto termine el
              // script, que es lo que el widget espera que pase «después».
              Promise.resolve().then(() => fn.call(doc, new Event(tipo)));
              return;
            }
            if (tipo === 'visibilitychange') {
              real.addEventListener(tipo, fn, opts);
              return;
            }
            root.addEventListener(tipo, fn, opts);
          };
        case 'removeEventListener':
          return (tipo: string, fn: any, opts?: any) => {
            root.removeEventListener(tipo, fn, opts);
            real.removeEventListener(tipo, fn, opts);
          };
        default: {
          const v = (real as any)[k];
          return typeof v === 'function' ? v.bind(real) : v;
        }
      }
    },
  });

  const base: Record<string, any> = {
    document: doc,
    onWidgetUpdate: null,
    onWidgetEscrito: null,
    escribir: (valor: unknown, variable?: string) => puente.escribir(valor, variable),
    addEventListener: (tipo: string, fn: any, opts?: any) => {
      if (tipo === 'message') puente.mensajes.add(fn);
      else if (tipo === 'resize') puente.redimension.add(fn);
      else window.addEventListener(tipo, fn, opts);
    },
    removeEventListener: (tipo: string, fn: any, opts?: any) => {
      if (tipo === 'message') puente.mensajes.delete(fn);
      else if (tipo === 'resize') puente.redimension.delete(fn);
      else window.removeEventListener(tipo, fn, opts);
    },
    postMessage: () => undefined,
  };
  Object.defineProperty(base, 'WIDGET', {
    get: () => puente.widget,
    set: () => undefined,
    enumerable: true,
  });
  Object.defineProperty(base, 'innerWidth', { get: () => host.clientWidth });
  Object.defineProperty(base, 'innerHeight', { get: () => host.clientHeight });

  const win: any = new Proxy(base, {
    get(t, k) {
      if (k === 'window' || k === 'self' || k === 'globalThis' || k === 'parent' || k === 'top') return win;
      if (k in t) return t[k as string];
      const v = (window as any)[k];
      return typeof v === 'function' ? v.bind(window) : v;
    },
    set(t, k, v) {
      t[k as string] = v;
      return true;
    },
  });

  // Lo que el `with` interpone: solo los nombres que hay que desviar. El
  // resto (`setTimeout`, `ResizeObserver`, `Math`...) sigue siendo global.
  const DESVIADOS = new Set([
    'window', 'self', 'globalThis', 'document',
    'WIDGET', 'onWidgetUpdate', 'onWidgetEscrito', 'escribir',
    'innerWidth', 'innerHeight',
  ]);
  const ambito = new Proxy(
    {},
    {
      has: (_t, k) => typeof k === 'string' && (DESVIADOS.has(k) || k in base),
      get: (_t, k) => (k === 'document' ? doc : win[k]),
      set: (_t, k, v) => {
        base[k as string] = v;
        return true;
      },
    }
  );
  return { win, ambito };
}

// ─── Componente ───────────────────────────────────────────────────

export function ZipLigero(props: Props) {
  const {
    zipWidget, widget, variable, enlaces, style,
    interactivo = false, onClic, clicable = false,
  } = props;

  // Si el script del ZIP falla al arrancar, ESTE widget vuelve al iframe.
  const [fallo, setFallo] = useState(false);

  const ref = useRef<HTMLDivElement>(null);
  const puente = useRef<Puente | null>(null);

  const escrituraOk = permiteEscritura(widget.config);
  const unidad =
    typeof (widget.config as any)?.unidad === 'string'
      ? ((widget.config as any).unidad as string)
      : '';
  const label = variable ? formatValue(variable) : widget.text ?? '';
  const rawValue = variable?.value ?? '';
  const on = isTruthy(variable);
  const frac = valueFraction(variable);

  // Lo que el manejador de escritura necesita saber AHORA (igual que en
  // HtmlWidgetRenderer: el puente se crea una vez, esto lo mantiene al día).
  const vivo = useRef({ interactivo, variable, enlaces, widget, onClic, escrituraOk, clicable });
  useEffect(() => {
    vivo.current = { interactivo, variable, enlaces, widget, onClic, escrituraOk, clicable };
  });

  const html = useMemo(() => htmlEstatico(zipWidget.html ?? ''), [zipWidget.html]);
  const hoja = useMemo(() => hojaDe(zipWidget), [zipWidget]);

  // El paquete, idéntico al que viaja por postMessage en el modo iframe.
  const payload = useMemo(
    () => ({
      type: 'widget-update',
      clicable: clicable && interactivo,
      widget: {
        escritura: escrituraOk && interactivo,
        unidad,
        vars: Object.fromEntries(
          Object.entries(enlaces ?? {}).map(([k, v]) => [
            k,
            {
              value: v?.value ?? '',
              on: isTruthy(v),
              frac: valueFraction(v),
              label: v ? formatValue(v) : '—',
            },
          ])
        ),
        value: rawValue,
        on,
        frac,
        label: String(label),
        name: widget.name || '',
        color: style.color,
        bg: style.background,
        borderColor: style.borderColor,
        fontSize: style.fontSize,
        bold: style.bold,
        opacity: style.opacity,
      },
    }),
    [enlaces, rawValue, on, frac, label, widget.name,
      style.color, style.background, style.borderColor,
      style.fontSize, style.bold, style.opacity,
      clicable, interactivo, escrituraOk, unidad]
  );
  const ultimoPayload = useRef(payload);
  ultimoPayload.current = payload;

  // ── Montaje: HTML, CSS y el script, una vez por ZIP ────────────────
  useLayoutEffect(() => {
    const host = ref.current;
    if (!host || fallo) return;
    const t0 = ahora();
    const root = montarEnShadow(host, hoja, html);

    const p: Puente = {
      widget: { ...WIDGET_INICIAL },
      clicable: false,
      mensajes: new Set(),
      redimension: new Set(),
      escribir: () => undefined,
      win: null,
    };
    puente.current = p;

    const { win, ambito } = crearAmbito(host, root, p);
    p.win = win;

    /** El widget pide escribir en el PLC (mismas reglas que el iframe). */
    p.escribir = async (valor, variable) => {
      const nombre = typeof variable === 'string' ? variable : '';
      const fin = (ok: boolean, error = '') => {
        const d = { type: 'widget-escrito', ok, error, variable: nombre };
        try {
          if (typeof win.onWidgetEscrito === 'function') win.onWidgetEscrito(d);
          for (const fn of Array.from(p.mensajes)) fn({ data: d });
        } catch (e) {
          console.warn('[zip ligero] onWidgetEscrito falló en', zipWidget.meta.kind, e);
        }
      };
      const ctx = vivo.current;
      if (!ctx.interactivo) return fin(false, 'En el Diseñador no se escribe.');
      if (!ctx.escrituraOk) return fin(false, 'Este widget está en sólo lectura.');
      const v = nombre ? ctx.enlaces?.[nombre] : ctx.variable;
      const enCrudo = String(ctx.widget.variableId ?? '');
      const id = v?.id ?? (!nombre && !enCrudo.startsWith('param:') ? enCrudo : '');
      if (!id) {
        return fin(
          false,
          nombre
            ? `La variable «${nombre}» no está enlazada a ningún tag.`
            : 'Este widget no tiene variable asociada.'
        );
      }
      const { plc_id, tag } = partirId(id);
      if (!plc_id) return fin(false, `«${id}» no identifica un PLC.`);
      try {
        await escribir([{ plc_id, tag, valor }]);
        fin(true);
      } catch (e: any) {
        fin(false, e?.message ?? 'No se pudo escribir.');
      }
    };

    // El script del ZIP, con `window` y `document` interpuestos. `with` va
    // antes que cualquier `"use strict"` del ZIP: así ese literal deja de
    // ser directiva (sería ilegal con `with`) y el resto corre igual.
    try {
      // eslint-disable-next-line no-new-func
      const correr = new Function('__w', `with (__w) {\n${zipWidget.js}\n}`);
      correr(ambito);
    } catch (e) {
      console.warn(
        '[zip ligero] el script de «%s» falló al arrancar; se vuelve al iframe.',
        zipWidget.meta.kind, e
      );
      puente.current = null;
      setFallo(true);
      return;
    }

    // Los datos de AHORA, antes del primer pintado: el widget nace completo.
    aplicar(host, root, p, ultimoPayload.current);
    traza('zip.montado', { kind: zipWidget.meta.kind, ms: Math.round(ahora() - t0) });

    // `window.addEventListener('resize')` del ZIP = la caja del widget.
    const ro = new ResizeObserver(() => {
      for (const fn of Array.from(p.redimension)) {
        try { fn(); } catch { /* del widget */ }
      }
    });
    ro.observe(host);

    // El clic, como en el iframe: cualquier pulsación dentro es «me han
    // pulsado»; qué hacer lo decide el anfitrión.
    const alClic = () => {
      if (!vivo.current.interactivo) return;
      vivo.current.onClic?.();
    };
    host.addEventListener('click', alClic, true);

    return () => {
      ro.disconnect();
      host.removeEventListener('click', alClic, true);
      puente.current = null;
      p.mensajes.clear();
      p.redimension.clear();
      if (host.shadowRoot) host.shadowRoot.innerHTML = '';
    };
    // `ultimoPayload` se lee a propósito sin estar en las dependencias: el
    // montaje es una vez por ZIP; las lecturas van por `aplicar` abajo.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [html, hoja, zipWidget.js, zipWidget.meta.kind, fallo]);

  // ── Cada lectura: el mismo paquete que mandaría el postMessage ─────
  useLayoutEffect(() => {
    const host = ref.current;
    const p = puente.current;
    const root = host?.shadowRoot;
    if (!host || !p || !root) return;
    aplicar(host, root, p, payload);
  }, [payload]);

  if (fallo) {
    return <HtmlWidgetRenderer {...props} />;
  }

  return (
    <div
      ref={ref}
      title={zipWidget.meta.label}
      style={{
        width: '100%',
        height: '100%',
        overflow: 'hidden',
        background: 'transparent',
        colorScheme: 'light',
        pointerEvents: interactivo ? 'auto' : 'none',
        cursor: clicable && interactivo ? 'pointer' : undefined,
      }}
    />
  );
}

/**
 * Lo mismo que `__wAplicar` dentro del iframe, pero sobre el host y el
 * shadow root: variables CSS, textos `data-w-*`, `WIDGET`, y después el
 * `onWidgetUpdate` del ZIP y sus oyentes de `message`.
 */
function aplicar(
  host: HTMLElement,
  root: ShadowRoot,
  p: Puente,
  d: { type: string; clicable: boolean; widget: Record<string, any> }
): void {
  const win = p.win;
  p.widget = d.widget;
  p.clicable = d.clicable;
  const w = d.widget;
  const s = host.style;
  s.setProperty('--w-color', w.color);
  s.setProperty('--w-bg', w.bg);
  s.setProperty('--w-border-color', w.borderColor);
  s.setProperty('--w-on', w.on ? '1' : '0');
  s.setProperty('--w-frac', String(w.frac));
  s.setProperty('--w-font-size', `${w.fontSize}px`);
  s.setProperty('--w-bold', w.bold ? 'bold' : 'normal');
  s.setProperty('--w-opacity', String(w.opacity));
  const vars = w.vars || {};
  for (const k of Object.keys(vars)) {
    s.setProperty(`--w-${k}-on`, vars[k].on ? '1' : '0');
    s.setProperty(`--w-${k}-frac`, String(vars[k].frac));
    s.setProperty(`--w-${k}-value`, String(vars[k].value));
    poner(root, `[data-w-var="${k}"]`, String(vars[k].label));
  }
  poner(root, '[data-w-label]', String(w.label));
  poner(root, '[data-w-value]', String(w.value));
  poner(root, '[data-w-name]', String(w.name));

  try {
    if (typeof win.onWidgetUpdate === 'function') win.onWidgetUpdate(w);
    for (const fn of Array.from(p.mensajes)) fn({ data: d });
  } catch (e) {
    // Un fallo del ZIP al refrescar no puede tumbar la pantalla: se anota
    // y la siguiente lectura lo vuelve a intentar.
    console.warn('[zip ligero] onWidgetUpdate falló en un widget:', e);
  }
}
