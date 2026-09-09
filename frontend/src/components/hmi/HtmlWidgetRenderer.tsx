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
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { HmiWidget, WidgetStyle } from '../../models/widget';
import type { PlcVariable } from '../../models/plc';
import type { ZipWidget } from '../../services/zipWidgetLoader';
import { formatValue, valueFraction, isTruthy } from '../../utils/format';

interface Props {
  zipWidget: ZipWidget;
  widget: HmiWidget;
  variable?: PlcVariable;
  style: WidgetStyle;
  /**
   * true = se está OPERANDO (Vista previa): el widget recibe los clics.
   * false/ausente = lienzo del Diseñador, donde el puntero es para colocarlo.
   */
  interactivo?: boolean;
  /**
   * Avisa al contenedor de que el widget abrió (o cerró) una capa a pantalla
   * completa. `WidgetRenderer` lo necesita para quitarse de en medio: su
   * `transform` haría que el `position: fixed` de este iframe se anclara al
   * rectángulo del widget en vez de a la ventana.
   */
  onModal?: (abierto: boolean) => void;
}

export function HtmlWidgetRenderer({
  zipWidget, widget, variable, style, interactivo = false, onModal,
}: Props) {
  const frac = valueFraction(variable);
  const on = isTruthy(variable);
  const label = variable ? formatValue(variable) : widget.text;
  const rawValue = variable?.value ?? '';
  const hasJs = zipWidget.js.length > 0;
  const iframeRef = useRef<HTMLIFrameElement>(null);

  /**
   * El widget tiene una capa a pantalla completa abierta (un modal).
   *
   * Mientras dure, el iframe deja de ser el rectangulito del widget y pasa a
   * ocupar la ventana entera: solo así el `position: fixed` de dentro tapa lo
   * que su autor quería tapar. Al cerrarse vuelve a su sitio.
   */
  const [modalAbierto, setModalAbierto] = useState(false);

  useEffect(() => {
    const alMensaje = (e: MessageEvent) => {
      // Solo se escucha a NUESTRO iframe. Con varios widgets ZIP en la misma
      // pantalla, sin esta comprobación el modal de uno agrandaría a todos.
      if (e.source !== iframeRef.current?.contentWindow) return;
      const d = e.data;
      if (!d || d.type !== 'widget-modal') return;
      setModalAbierto(!!d.abierto);
    };
    window.addEventListener('message', alMensaje);
    return () => window.removeEventListener('message', alMensaje);
  }, []);

  // En el Diseñador el widget no recibe clics, así que no puede haber modal:
  // si se quedara marcado (por ejemplo al pasar de la Vista previa al lienzo),
  // el iframe se comería la pantalla del editor.
  // PENDIENTE (decidido con Christian, sep 2026): mientras el modal está
  // abierto el widget se ve "desaparecer" de su hueco. No desaparece — el
  // iframe pasa a medir la ventana entera y el `body { display:flex;
  // align-items:center; justify-content:center }` de más abajo, que sirve para
  // centrar el widget en su cajita de 140×150, pasa a centrarlo en la
  // PANTALLA. Ahí queda justo detrás de la tarjeta del modal.
  //
  // Se deja así a propósito, que es lo que hace cualquier modal: tapar lo de
  // atrás. Si algún día se quiere el widget quieto en su sitio, la vía es
  // mandarle a este iframe las coordenadas reales del widget (las tiene el
  // anfitrión) y, mientras esté a pantalla completa, fijar el contenido con
  // `position: absolute` en esas coordenadas en vez de centrarlo. El
  // `position: fixed` del modal del ZIP sigue funcionando igual, porque se
  // mide contra el viewport del iframe y no contra ese contenido.
  const aPantallaCompleta = modalAbierto && interactivo;

  // El contenedor tiene que enterarse ANTES de que el navegador pinte, para
  // que el iframe no llegue a dibujarse a pantalla completa dentro de un
  // `transform` — que es justo lo que lo rompe.
  useLayoutEffect(() => { onModal?.(aPantallaCompleta); }, [aPantallaCompleta, onModal]);
  // Si el widget se desmonta con el modal abierto, el contenedor se quedaría
  // sin `transform` para siempre.
  useLayoutEffect(() => () => { onModal?.(false); }, [onModal]);

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

    // ------------------------------------------------------------------ //
    // ¿EL WIDGET ESTÁ ABRIENDO ALGO QUE NO CABE EN SU CAJA?
    //
    // Un modal se escribe con `position: fixed; inset: 0`, que en una página
    // normal significa «cubre la pantalla». Dentro de un iframe NO: `fixed` se
    // ancla al viewport DEL IFRAME, o sea al rectángulo del widget. Un motor
    // de 140×150 acababa con un modal de 100×414 recortado dentro. Y no hay
    // CSS que lo arregle: un iframe no puede pintar fuera de su propia caja.
    //
    // Lo único que puede arreglarlo es el anfitrión, agrandando el iframe. Y
    // para eso tiene que enterarse, que es lo que hace esto: corre DENTRO del
    // iframe (donde sí se ve el DOM) y avisa al padre cuando aparece o
    // desaparece algo posicionado como `fixed` que tapa casi todo el widget.
    // Esa condición es justamente «esto quería ser una capa a pantalla
    // completa», así que el anfitrión le da la pantalla.
    //
    // Se detecta en vez de exigir una llamada para que los ZIP que ya existen
    // funcionen sin reescribirlos. Quien quiera mandarlo a mano tiene
    // `WIDGET_MODAL(true|false)`.
    // ------------------------------------------------------------------ //
    const modalScript = `<script>
(function () {
  var abierto = false, pendiente = false;

  function tapaCasiTodo(r) {
    // 60% de cada eje. Un fondo con inset:0 da el 100%; un adorno fijo en una
    // esquina no llega, así que no se confunde con un modal.
    return r.width >= window.innerWidth * 0.6 && r.height >= window.innerHeight * 0.6;
  }

  function hayCapa() {
    if (!document.body) return false;
    var nodos = document.body.querySelectorAll('*');
    // Tope defensivo: un ZIP son unas decenas de nodos, no miles.
    var n = Math.min(nodos.length, 500);
    for (var i = 0; i < n; i++) {
      var el = nodos[i];
      var cs = window.getComputedStyle(el);
      if (cs.position !== 'fixed') continue;
      if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') continue;
      var r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;
      if (tapaCasiTodo(r)) return true;
    }
    return false;
  }

  function avisar(v) {
    if (v === abierto) return;
    abierto = v;
    try { parent.postMessage({ type: 'widget-modal', abierto: abierto }, '*'); } catch (e) {}
  }

  function revisar() { pendiente = false; avisar(hayCapa()); }

  function pedirRevision() {
    // Una pasada por fotograma como mucho: getComputedStyle en bucle es
    // barato con pocos nodos, pero no gratis en cada mutacion del DOM.
    // (Sin acentos graves aqui dentro: esto vive en un template literal y una
    //  comilla invertida cerraria la cadena.)
    if (pendiente) return;
    pendiente = true;
    requestAnimationFrame(revisar);
  }

  // Escotilla para el autor del widget que prefiera decirlo explícitamente.
  window.WIDGET_MODAL = function (v) { avisar(!!v); };

  new MutationObserver(pedirRevision).observe(document.documentElement, {
    subtree: true, childList: true, attributes: true,
    attributeFilter: ['hidden', 'style', 'class', 'open'],
  });
  document.addEventListener('click', pedirRevision, true);
  document.addEventListener('keyup', pedirRevision, true);
  window.addEventListener('resize', pedirRevision);
  window.addEventListener('load', pedirRevision);
})();
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
  /* EL BODY VA TRANSPARENTE, SIEMPRE.
   *
   * Aquí había 'background: var(--w-bg)', o sea el fondo del widget pintado
   * DOS VECES: una por el contenedor de WidgetRenderer (que lo hace para
   * todos los widgets, ZIP o no) y otra aquí dentro del iframe.
   *
   * Además no era ni consistente: '--w-bg' lo pone el bridge por
   * postMessage, y en un ZIP SIN widget.js el sandbox va sin
   * 'allow-scripts', así que el bridge no llega a ejecutarse y el body se
   * quedaba transparente. El mismo widget se pintaba distinto según llevara
   * .js o no, que es la clase de diferencia que vuelve loco a cualquiera.
   *
   * Ahora lo pinta el contenedor y punto. '--w-bg' sigue disponible como
   * variable para quien la quiera usar en su propio CSS, que es lo que
   * promete la documentación del ZIP. */
  body {
    display: flex;
    align-items: center;
    justify-content: center;
    background: transparent;
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
${modalScript}
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
        // A pantalla completa mientras el widget tenga un modal abierto. Es
        // el único modo de que su `position: fixed` cubra de verdad: el
        // iframe pasa a ser la ventana.
        // Medidas en PORCENTAJE, no `100vw/100vh` ni `inset: 0` a secas:
        //   · Un iframe es un elemento reemplazado, así que `left/right: 0`
        //     con `width: auto` NO lo estira — se queda en su tamaño
        //     intrínseco de 300×150. Hay que darle medidas.
        //   · Y `100vw` incluye el ancho de la barra de desplazamiento, con
        //     lo que sobresale y aparece una barra horizontal. El porcentaje
        //     se mide contra el bloque contenedor, que para un `fixed` es la
        //     ventana ya sin barras.
        ...(aPantallaCompleta
          ? {
              position: 'fixed' as const, left: 0, top: 0,
              width: '100%', height: '100%',
              // Por encima de todo lo de la aplicación (hoy el máximo es 100).
              zIndex: 1000,
            }
          : { width: '100%', height: '100%' }),
        border: 'none',

        // EL PUNTERO SOLO PASA CUANDO EL WIDGET SE ESTÁ OPERANDO.
        //
        // Estaba en 'none' fijo, y por eso un ZIP con un botón no reaccionaba
        // NUNCA — ni en la Vista previa. La razón de que estuviera apagado es
        // real, pero solo vale para el Diseñador: allí el arrastre sirve para
        // colocar el widget, y un iframe que se quede con el puntero lo deja
        // imposible de mover. En la Vista previa es justo al revés.
        pointerEvents: interactivo ? 'auto' : 'none',
        display: 'block',
        background: 'transparent',

        // ESTA LÍNEA ES LA QUE QUITA EL FONDO BLANCO. No es cosmética.
        //
        // Un iframe solo se dibuja transparente si el `color-scheme` del
        // documento de dentro COINCIDE con el del elemento que lo contiene.
        // Si no coinciden, el navegador le pinta un lienzo opaco debajo — y
        // opaco significa blanco.
        //
        // Y aquí no coincidían: la app declara `html.dark { color-scheme:
        // dark }` en index.css, el iframe hereda ese `dark` del contenedor,
        // pero el documento del ZIP no declara nada y sale `light`. Distintos
        // -> lienzo blanco, y se ve por donde el dibujo del ZIP no llega a
        // cubrir (las franjas que deja un SVG con preserveAspectRatio="meet").
        //
        // Se fuerza `light` en el elemento porque el documento del ZIP es
        // siempre `light` — no declara nada — así que así coinciden en los dos
        // temas de la app. Poner 'dark' NO vale: haría coincidir en oscuro y
        // romper en claro.
        //
        // Solo pasa con los ZIP porque son los únicos que van en iframe. Los
        // widgets del catálogo se dibujan en el mismo documento y por eso
        // nunca tuvieron este problema.
        colorScheme: 'light',
      }}
      title={zipWidget.meta.label}
    />
  );
}
