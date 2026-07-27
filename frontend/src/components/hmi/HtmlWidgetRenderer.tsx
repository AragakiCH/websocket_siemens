// =========================================================================
// HtmlWidgetRenderer.tsx
// ===========================================================================
// Renderiza un widget HTML custom (cargado desde ZIP) dentro de un iframe
// sandboxed. Los datos del PLC se inyectan como:
//   - CSS custom properties (--w-color, --w-on, --w-frac, etc.)
//   - Placeholders de texto ({{label}}, {{value}}, {{name}})
//   - Objeto global WIDGET accesible desde widget.js
//
// Si el ZIP incluye widget.js, el iframe permite scripts (allow-scripts)
// pero sigue aislado del DOM padre (sin allow-same-origin).
// =========================================================================
import { useMemo } from 'react';
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

  const srcDoc = useMemo(() => {
    // Reemplazar placeholders de texto en el HTML
    let html = zipWidget.html;
    html = html.replace(/\{\{label\}\}/g, String(label));
    html = html.replace(/\{\{value\}\}/g, String(rawValue));
    html = html.replace(/\{\{name\}\}/g, widget.name || '');

    // Objeto global WIDGET que el JS del usuario puede leer
    const widgetDataScript = `<script>
window.WIDGET = {
  value: ${JSON.stringify(rawValue)},
  on: ${on},
  frac: ${frac},
  label: ${JSON.stringify(String(label))},
  name: ${JSON.stringify(widget.name || '')},
  color: ${JSON.stringify(style.color)},
  bg: ${JSON.stringify(style.background)},
  borderColor: ${JSON.stringify(style.borderColor)},
  fontSize: ${style.fontSize},
  bold: ${style.bold},
  opacity: ${style.opacity},
};
</script>`;

    // Script del usuario (se ejecuta después del data script)
    const userScript = hasJs
      ? `<script>${zipWidget.js}</script>`
      : '';

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
  }
  :root {
    --w-color: ${style.color};
    --w-bg: ${style.background};
    --w-border-color: ${style.borderColor};
    --w-on: ${on ? '1' : '0'};
    --w-frac: ${frac};
    --w-font-size: ${style.fontSize}px;
    --w-bold: ${style.bold ? 'bold' : 'normal'};
    --w-opacity: ${style.opacity};
  }
  ${zipWidget.css}
</style>
</head>
<body>
${html}
${widgetDataScript}
${userScript}
</body>
</html>`;
  }, [zipWidget.html, zipWidget.css, zipWidget.js, hasJs,
      label, rawValue, widget.name,
      style.color, style.background, style.borderColor,
      style.fontSize, style.bold, style.opacity, on, frac]);

  return (
    <iframe
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
