// =========================================================================
// HtmlWidgetRenderer.tsx
// ===========================================================================
// Renderiza un widget HTML custom (cargado desde ZIP) dentro de un iframe
// sandboxed. Los datos del PLC se inyectan como:
//   - CSS custom properties (--w-color, --w-on, --w-frac, etc.)
//   - Placeholders de texto ({{label}}, {{value}}, {{name}})
//   - Objeto global WIDGET accesible desde widget.js
//
// ANTI-PARPADEO: el iframe se carga UNA sola vez (srcDoc depende solo del
// HTML/CSS/JS del ZIP). Las actualizaciones de datos (color, frac, on, etc.)
// se envían por postMessage, y un listener dentro del iframe actualiza las
// CSS custom properties + el objeto WIDGET + llama a window.onWidgetUpdate()
// si el usuario lo definió en su widget.js.
// =========================================================================
import { useEffect, useMemo, useRef } from 'react';
import type { HmiWidget, WidgetStyle } from '../../models/widget';
import type { PlcVariable } from '../../models/plc';
import type { ZipWidget } from '../../services/zipWidgetLoader';
import { formatValue, valueFraction, isTruthy } from '../../utils/format';

interface Props {
  zipWidget: ZipWidget;
  widget: HmiWidget;
  variable?: PlcVariable;
  style: WidgetStyle;
}

export function HtmlWidgetRenderer({ zipWidget, widget, variable, style }: Props) {
  const frac = valueFraction(variable);
  const on = isTruthy(variable);
  const label = variable ? formatValue(variable) : widget.text;
  const rawValue = variable?.value ?? '';
  const hasJs = zipWidget.js.length > 0;
  const iframeRef = useRef<HTMLIFrameElement>(null);

  // --- srcDoc se genera UNA vez (solo cambia si el ZIP cambia) ----------- //
  const srcDoc = useMemo(() => {
    // Placeholders iniciales
    let html = zipWidget.html;
    html = html.replace(/\{\{label\}\}/g, '__W_LABEL__');
    html = html.replace(/\{\{value\}\}/g, '__W_VALUE__');
    html = html.replace(/\{\{name\}\}/g, '__W_NAME__');

    // Listener de postMessage para actualizaciones sin recarga
    const bridgeScript = `<script>
window.addEventListener('message', function(e) {
  var d = e.data;
  if (!d || d.type !== 'widget-update') return;

  // Actualizar objeto global WIDGET
  window.WIDGET = d.widget;

  // Actualizar CSS custom properties
  var r = document.documentElement.style;
  r.setProperty('--w-color', d.widget.color);
  r.setProperty('--w-bg', d.widget.bg);
  r.setProperty('--w-border-color', d.widget.borderColor);
  r.setProperty('--w-on', d.widget.on ? '1' : '0');
  r.setProperty('--w-frac', String(d.widget.frac));
  r.setProperty('--w-font-size', d.widget.fontSize + 'px');
  r.setProperty('--w-bold', d.widget.bold ? 'bold' : 'normal');
  r.setProperty('--w-opacity', String(d.widget.opacity));

  // Reemplazar textos dinámicos
  var els;
  els = document.querySelectorAll('[data-w-label]');
  els.forEach(function(el) { el.textContent = d.widget.label; });
  els = document.querySelectorAll('[data-w-value]');
  els.forEach(function(el) { el.textContent = String(d.widget.value); });
  els = document.querySelectorAll('[data-w-name]');
  els.forEach(function(el) { el.textContent = d.widget.name; });

  // Callback opcional del usuario
  if (typeof window.onWidgetUpdate === 'function') {
    window.onWidgetUpdate(d.widget);
  }
});
</script>`;

    // Script de inicialización con datos placeholder (se pisan con el primer postMessage)
    const initScript = `<script>
window.WIDGET = {
  value: '', on: false, frac: 0, label: '', name: '',
  color: '#009999', bg: 'transparent', borderColor: '#94a3b8',
  fontSize: 14, bold: false, opacity: 1
};
</script>`;

    // Script del usuario
    const userScript = hasJs ? `<script>${zipWidget.js}</script>` : '';

    // Convertir placeholders a spans con data-attributes para actualización dinámica
    html = html.replace(/__W_LABEL__/g, '<span data-w-label></span>');
    html = html.replace(/__W_VALUE__/g, '<span data-w-value></span>');
    html = html.replace(/__W_NAME__/g, '<span data-w-name></span>');

    return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  html, body {
    width: 100%; height: 100%;
    overflow: hidden;
    background: transparent;
    font-family: Arial, sans-serif;
  }
  body {
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--w-bg);
  }
  :root {
    --w-color: #009999;
    --w-bg: transparent;
    --w-border-color: #94a3b8;
    --w-on: 0;
    --w-frac: 0;
    --w-font-size: 14px;
    --w-bold: normal;
    --w-opacity: 1;
  }
  ${zipWidget.css}
</style>
</head>
<body>
${html}
${bridgeScript}
${initScript}
${userScript}
</body>
</html>`;
  }, [zipWidget.html, zipWidget.css, zipWidget.js, hasJs]);

  // --- Enviar datos actualizados por postMessage (sin recargar iframe) --- //
  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;

    const payload = {
      type: 'widget-update',
      widget: {
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
    };

    // El iframe puede no estar listo aún en el primer render
    const send = () => {
      try {
        iframe.contentWindow?.postMessage(payload, '*');
      } catch { /* iframe no listo */ }
    };

    // Enviar inmediatamente + al cargar (por si el iframe aún no terminó)
    send();
    iframe.addEventListener('load', send);
    return () => iframe.removeEventListener('load', send);
  }, [rawValue, on, frac, label, widget.name,
      style.color, style.background, style.borderColor,
      style.fontSize, style.bold, style.opacity]);

  return (
    <iframe
      ref={iframeRef}
      srcDoc={srcDoc}
      sandbox={hasJs ? 'allow-scripts' : ''}
      style={{
        width: '100%',
        height: '100%',
        border: 'none',
        pointerEvents: 'none',
        display: 'block',
        background: 'transparent',
      }}
      title={zipWidget.meta.label}
    />
  );
}
