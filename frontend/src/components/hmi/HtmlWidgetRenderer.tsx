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
//
// VARIAS VARIABLES, NO UNA
// Además de la principal, el widget recibe las que haya declarado en su
// `widget.json` y que el Diseñador le haya enlazado. Llegan como
// `WIDGET.vars.<id>` y, sobre todo, como variables CSS
// —`--w-<id>-on`, `--w-<id>-frac`, `--w-<id>-value`—, que es lo que permite
// animar sin escribir una línea de JavaScript: un motor que gira a una
// velocidad sacada de `--w-velocidad-frac` es una regla de CSS.
//
// Con una sola variable no se puede representar un equipo. Un motor es
// marcha, fallo y velocidad A LA VEZ, y lo que el operario lee de un vistazo
// es la combinación.
//
// Y PUEDE ESCRIBIR
// `escribir(valor, 'variable')` manda al PLC. No escribe él: se lo pide al
// anfitrión, que usa el MISMO `POST /escritura` que todo lo demás — con su
// lista blanca, sus límites y su auditoría. Un widget importado es código de
// fuera; que pudiera hablar con el autómata por su cuenta sería justo lo que
// no debe pasar. Y en el Diseñador no escribe nunca: allí el clic es para
// colocarlo.
// =========================================================================
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { HmiWidget, WidgetStyle } from '../../models/widget';
import type { PlcVariable } from '../../models/plc';
import type { ZipWidget } from '../../services/zipWidgetLoader';
import { formatValue, valueFraction, isTruthy } from '../../utils/format';
import { escribir, partirId } from '../../services/escrituraApi';
import { permiteEscritura } from './acciones';

interface Props {
  zipWidget: ZipWidget;
  widget: HmiWidget;
  variable?: PlcVariable;
  /**
   * Las variables CON NOMBRE que declara el widget, ya resueltas.
   *
   * Dentro de un faceplate llegan traducidas a los tags de esa instancia, así
   * que el widget nunca ve un `param:` — ni tiene que saber que existen.
   */
  enlaces?: Record<string, PlcVariable | undefined>;
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
  /**
   * Alguien pulsó dentro del widget.
   *
   * ── POR QUÉ NO SE EJECUTA LA ACCIÓN AQUÍ ─────────────────────────────
   * Un iframe SE COME los eventos de ratón: el `onClick` del contenedor de
   * fuera no se entera de nada de lo que pasa dentro. Por eso el clic tiene
   * que salir por el puente de `postMessage`, como ya salen `escribir()` y el
   * aviso de modal.
   *
   * Pero una vez fuera, ejecutar la acción es exactamente lo mismo que hace
   * un botón normal: misma función, misma confirmación, mismo aviso de error.
   * Duplicarlo aquí habría sido tener dos sitios donde arreglar el mismo
   * fallo. Así que esto solo AVISA, y `WidgetRenderer` —que ya tiene el
   * `pulsar()` del botón montado— hace el trabajo.
   */
  onClic?: () => void;
  /** Hay acción configurada: el puntero dentro del iframe pasa a ser mano. */
  clicable?: boolean;
}

export function HtmlWidgetRenderer({
  zipWidget, widget, variable, enlaces, style, interactivo = false, onModal,
  onClic, clicable = false,
}: Props) {
  // Sólo lectura / Lectura y escritura. Es del widget, no de la acción; se
  // edita en el panel de Acción y lo comparten todos (ver `acciones.ts`).
  const escrituraOk = permiteEscritura(widget.config);
  // La unidad que escribió quien monta la pantalla. El mismo campo que usa
  // «Valor con Unidad»; aquí sólo se le pasa al widget, que decide si la pinta.
  const unidad =
    typeof (widget.config as any)?.unidad === 'string'
      ? ((widget.config as any).unidad as string)
      : '';
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

  /**
   * Lo que el manejador de mensajes necesita saber AHORA.
   *
   * El listener se registra una sola vez —añadir y quitar un oyente de
   * `message` en cada lectura, por cada widget de la pantalla, es ruido que
   * no hace falta—, y con `[]` se quedaría con los valores del primer
   * render. Esta referencia es la que lo mantiene al día.
   */
  const vivo = useRef({ interactivo, variable, enlaces, widget, onClic, escrituraOk });
  useEffect(() => {
    vivo.current = { interactivo, variable, enlaces, widget, onClic, escrituraOk };
  });

  useEffect(() => {
    const responder = (cuerpo: Record<string, unknown>) => {
      try {
        iframeRef.current?.contentWindow?.postMessage(cuerpo, '*');
      } catch {
        /* el iframe se fue */
      }
    };

    /** El widget pide escribir en el PLC. */
    const escrituraPedida = async (d: any) => {
      const nombre = typeof d.variable === 'string' ? d.variable : '';
      const fin = (ok: boolean, error = '') =>
        responder({ type: 'widget-escrito', ok, error, variable: nombre });

      const ctx = vivo.current;
      // En el lienzo NO. Allí el puntero sirve para colocar el widget, y una
      // orden a una máquina mientras se diseña la pantalla es lo contrario de
      // lo que espera cualquiera.
      if (!ctx.interactivo) return fin(false, 'En el Diseñador no se escribe.');

      // Y el hermano del de arriba: si el widget está en sólo lectura, aquí
      // se acaba. TIENE que estar en el anfitrión y no dentro del ZIP: allí
      // sería decoración —el widget puede poner `readOnly` en su campo y
      // llamar a `escribir()` igual, por descuido o por capricho—. El único
      // sitio donde el modo se puede hacer cumplir es este, que es por donde
      // pasan todas las escrituras de todos los ZIP.
      if (!ctx.escrituraOk) {
        return fin(false, 'Este widget está en sólo lectura.');
      }

      // Qué tag: el de la variable con nombre que pida, o el principal. Se usa
      // la variable YA RESUELTA para que dentro de un faceplate escriba en el
      // tag de SU instancia y no en el de la plantilla.
      const v = nombre ? ctx.enlaces?.[nombre] : ctx.variable;
      const enCrudo = String(ctx.widget.variableId ?? '');
      const id =
        v?.id ?? (!nombre && !enCrudo.startsWith('param:') ? enCrudo : '');
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
        // El mismo camino que todo lo demás: lista blanca, límites, tipo y
        // auditoría los comprueba el servidor. Aquí no se duplica ninguna de
        // esas reglas — un widget importado no puede saltárselas porque no es
        // él quien llama.
        await escribir([{ plc_id, tag, valor: d.valor }]);
        fin(true);
      } catch (e: any) {
        fin(false, e?.message ?? 'No se pudo escribir.');
      }
    };

    const alMensaje = (e: MessageEvent) => {
      // Solo se escucha a NUESTRO iframe. Con varios widgets ZIP en la misma
      // pantalla, sin esta comprobación el modal de uno agrandaría a todos.
      if (e.source !== iframeRef.current?.contentWindow) return;
      const d = e.data;
      if (!d) return;
      if (d.type === 'widget-modal') {
        setModalAbierto(!!d.abierto);
        return;
      }
      if (d.type === 'widget-escribir') {
        void escrituraPedida(d);
        return;
      }
      if (d.type === 'widget-clic') {
        // En el Diseñador NO. Allí el puntero sirve para colocar el widget, y
        // el iframe ya va con `pointerEvents: none`; esto es el segundo
        // cerrojo, por si alguien cambia aquello algún día.
        if (!vivo.current.interactivo) return;
        vivo.current.onClic?.();
      }
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

  // Las variables CON NOMBRE, cada una con las suyas. Con esto se anima en
  // CSS puro: rotar con --w-velocidad-frac es una regla, no un script.
  var vars = d.widget.vars || {};
  for (var k in vars) {
    if (!Object.prototype.hasOwnProperty.call(vars, k)) continue;
    r.setProperty('--w-' + k + '-on', vars[k].on ? '1' : '0');
    r.setProperty('--w-' + k + '-frac', String(vars[k].frac));
    r.setProperty('--w-' + k + '-value', String(vars[k].value));
    document.querySelectorAll('[data-w-var="' + k + '"]').forEach(function (el) {
      el.textContent = String(vars[k].label);
    });
  }

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

// Respuesta a una escritura pedida por el widget.
window.addEventListener('message', function (e) {
  var d = e.data;
  if (!d || d.type !== 'widget-escrito') return;
  if (typeof window.onWidgetEscrito === 'function') {
    window.onWidgetEscrito(d);
  }
});

/**
 * EL CLIC, HACIA FUERA.
 *
 * Va sobre el DOCUMENTO y en fase de CAPTURA, las dos cosas a proposito.
 *
 * Sobre el documento porque muchos widgets llevan pointer-events:none en su
 * contenido para no estorbar, y entonces el clic no tiene ningun elemento
 * como destino: aterriza en el body. Escuchando aqui se recoge igual, lleve
 * el widget lo que lleve dentro.
 *
 * En captura para enterarse ANTES que cualquier manejador propio del widget,
 * y aunque ese manejador pare la propagacion.
 *
 * Lo que sale es solo un aviso de "me han pulsado". Ni que accion, ni que
 * valor: eso lo decide el anfitrion, que es el unico que conoce la
 * configuracion y el unico que puede hablar con el PLC.
 */
document.addEventListener('click', function () {
  try { parent.postMessage({ type: 'widget-clic' }, '*'); } catch (e) {}
}, true);

/* El puntero: mano si hay accion configurada, el de siempre si no. */
window.addEventListener('message', function (e) {
  var d = e.data;
  if (!d || d.type !== 'widget-update') return;
  var cur = d.clicable ? 'pointer' : '';
  document.documentElement.style.cursor = cur;
  if (document.body) document.body.style.cursor = cur;
});

/**
 * Manda un valor al PLC.
 *
 *   escribir(1)                 -> a la variable principal
 *   escribir(true, 'marcha')    -> a la variable con nombre 'marcha'
 *
 * No escribe aqui: se lo pide al anfitrion, que pasa por el endpoint de
 * siempre con su lista blanca y su auditoria. La respuesta llega a
 * window.onWidgetEscrito({ ok, error, variable }) si la defines.
 */
window.escribir = function (valor, variable) {
  try {
    parent.postMessage({
      type: 'widget-escribir',
      variable: variable || '',
      valor: valor
    }, '*');
  } catch (e) {}
};
</script>`;

    // Script de inicialización con datos placeholder (se pisan con el primer postMessage)
    const initScript = `<script>
window.WIDGET = {
  value: '', on: false, frac: 0, label: '', name: '',
  color: '#009999', bg: 'transparent', borderColor: '#94a3b8',
  fontSize: 14, bold: false, opacity: 1,
  /* Sólo lectura hasta que el anfitrión diga lo contrario. Un widget que
     arranca abierto y se cierra un instante después es peor que uno que
     arranca cerrado: el operario ya pudo teclear. */
  escritura: false,
  unidad: '',
  vars: {}
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

  // Solo interesan los cambios que pueden hacer aparecer o desaparecer un
  // elemento: atributos, o nodos ELEMENTO que entran o salen. Un cambio de
  // texto (el bridge escribiendo el valor del PLC en un span, varias veces
  // por segundo) no puede abrir un modal, y sin este filtro cada uno de esos
  // cambios recorria hasta 500 nodos con getComputedStyle. Con un widget no
  // se nota; con cien en la misma pantalla, si.
  function relevante(registros) {
    for (var i = 0; i < registros.length; i++) {
      var m = registros[i];
      if (m.type === 'attributes') return true;
      var j;
      for (j = 0; j < m.addedNodes.length; j++) {
        if (m.addedNodes[j].nodeType === 1) return true;
      }
      for (j = 0; j < m.removedNodes.length; j++) {
        if (m.removedNodes[j].nodeType === 1) return true;
      }
    }
    return false;
  }

  new MutationObserver(function (registros) {
    if (relevante(registros)) pedirRevision();
  }).observe(document.documentElement, {
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
      // Fuera de `widget` porque no es un dato del proceso: es cómo se
      // comporta el puntero. Si fuera dentro, aparecería en `WIDGET.clicable`
      // y parecería algo que el autor del ZIP puede usar.
      clicable: clicable && interactivo,
      widget: {
        // DENTRO de `widget`, al revés que `clicable`. Ese se esconde porque
        // es cosa del puntero y el autor del ZIP no pinta nada con él; éste
        // es justo lo contrario: el widget TIENE que leerlo para saber si
        // enseña su campo abierto o bloqueado. En el Diseñador va siempre
        // false, como el propio cerrojo del anfitrión.
        escritura: escrituraOk && interactivo,
        unidad,
        // Las variables con nombre, ya masticadas igual que la principal: el
        // widget no tiene que saber formatear ni normalizar nada.
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
  }, [enlaces, rawValue, on, frac, label, widget.name,
      style.color, style.background, style.borderColor,
      style.fontSize, style.bold, style.opacity,
      clicable, interactivo, escrituraOk, unidad]);

  return (
    <iframe
      ref={iframeRef}
      srcDoc={srcDoc}
      /**
       * SIEMPRE con scripts, lleve el ZIP su .js o no.
       *
       * El puente que reparte los valores —las variables CSS, `WIDGET`,
       * `escribir()`— es NUESTRO y va en el srcDoc, así que sin
       * `allow-scripts` no corre. Antes se ataba a que el autor hubiera
       * incluido un `widget.js`, y el resultado era que un motor animado en
       * CSS puro no recibía ni un valor: se quedaba clavado en su estado
       * inicial sin decir por qué. El mismo widget funcionaba o no según
       * llevara un fichero que ni siquiera usaba.
       *
       * Lo que de verdad aísla sigue puesto: SIN `allow-same-origin`, el
       * iframe vive en un origen opaco. No puede leer la sesión, ni el
       * almacenamiento, ni llamar a la API por su cuenta; para escribir en el
       * PLC tiene que pedírselo al anfitrión, que es quien decide.
       */
      sandbox="allow-scripts"
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
