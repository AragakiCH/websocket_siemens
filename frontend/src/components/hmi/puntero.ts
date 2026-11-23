// =========================================================================
// puntero.ts
// Quién se queda con el clic cuando un widget de adorno pisa a otro.
//
// EL FALLO QUE ARREGLA
// En el lienzo los widgets van uno encima de otro, en el orden en que se
// colocaron, y cada uno ocupa su CAJA entera aunque dentro solo haya un
// dibujo con aire alrededor. Ese aire no se ve, pero se queda con el
// puntero: un panel de adorno cuya caja llega un poco más abajo de lo que
// pinta tapa —para el ratón, no para la vista— lo que tenga debajo.
//
// Así se quedó sin poder pulsarse el «Ver todas» del widget de Alarmas en
// las pantallas de Línea de un proyecto real: justo encima caía la franja
// vacía del panel «Registro de operación». El botón se veía perfectamente
// y no respondía; desde fuera, «la aplicación lo bloquea».
//
// LA REGLA
// Un widget que es SOLO DIBUJO no le quita el puntero a un widget cuyos
// mandos tienen que estar siempre a mano (`siempreAlcanzable` en su
// definición; hoy, el de Alarmas). Mientras lo pise, el dibujo deja pasar
// el puntero: se sigue viendo igual, en su sitio y en su orden, pero el
// clic —y con él el cursor y el resaltado— llega a lo de abajo.
//
// QUÉ ES «SOLO DIBUJO»
// Tres cosas a la vez. Las dos primeras se leen en el código del ZIP:
//
//   1. LO DICE SU AUTOR. Su CSS apaga `pointer-events` y no lo vuelve a
//      encender en ningún sitio. Es lo que escribe quien hace un rótulo, un
//      logotipo o un sinóptico «para no estorbar».
//   2. Y ES VERDAD. No trae nada que pueda reaccionar a un puntero: ni
//      botones, campos o enlaces, ni zonas con barra de desplazamiento, ni
//      un script que escuche el ratón, el teclado o el dedo, ni `escribir()`.
//   3. Y, tal como está colocado, no tiene ACCIÓN configurada: con acción,
//      pulsarlo hace algo, y se queda con su clic como siempre.
//
// Ante la duda NO es solo dibujo, y todo sigue como estaba.
//
// Los widgets de fábrica (rectángulo, texto, línea…) se quedan fuera aunque
// no hagan nada al pulsarlos: no declaran qué quieren del puntero, y poner
// un rectángulo encima de un mando es también la forma de TAPARLO a
// propósito. Un ZIP que apaga `pointer-events` ha dicho lo contrario.
//
// POR QUÉ NO SE APLICA A CUALQUIER PAR DE WIDGETS
// Que un dibujo deje pasar el puntero a lo que tenga debajo SIEMPRE sería
// lo coherente, y este módulo ya sabe decidirlo (`esSoloDibujo`). Pero eso
// cambia cómo responden pantallas que ya están en planta —zonas que hoy no
// hacen nada pasarían a pulsar lo que tienen debajo—, y esa decisión es de
// quien las diseñó. Aquí solo se garantiza lo que no puede fallar nunca:
// llegar a las alarmas.
//
// DÓNDE SE USA
// En los dos sitios que dibujan widgets para OPERARLOS: la vista previa
// (`pages/Preview.tsx`) y la pantalla empotrada (`PantallaEmbebida.tsx`).
// En el Diseñador no: allí el puntero sirve para colocar, y ningún widget
// lo recibe.
// =========================================================================
import type { HmiWidget } from '../../models/widget';
import { EVENTO_WIDGETS, type ZipWidget } from '../../services/zipWidgetLoader';
import { customByKind, zipByKind } from './custom/registry';
import { leerAccion, tieneAccion } from './acciones';

// ─── ¿Este ZIP es solo dibujo? ────────────────────────────────────

/**
 * Lo que, en el HTML de un ZIP, reacciona por sí solo a un puntero o a un
 * foco: los elementos de formulario y de navegación, los manejadores
 * escritos en la etiqueta (`onclick="…"`) y lo que se puede enfocar,
 * editar o arrastrar.
 */
const HTML_QUE_REACCIONA =
  /<(?:a|button|input|select|textarea|details|summary|dialog|video|audio|iframe|embed|object|form)\b|\son[a-z]+\s*=|\b(?:contenteditable|tabindex|draggable)\s*=/i;

/** Una zona con barra de desplazamiento necesita el puntero para moverse. */
const CSS_CON_DESPLAZAMIENTO = /overflow(?:-[xy])?\s*:\s*(?:auto|scroll)/i;

/**
 * Un script que escucha al operador (ratón, dedo, teclado, formularios),
 * que escribe en el PLC, que abre una capa a pantalla completa o que toca
 * `pointer-events` por su cuenta. Se busca el NOMBRE del evento entre
 * comillas —así es como llega a `addEventListener`— y la forma `.onclick =`.
 */
const JS_QUE_ESCUCHA =
  /["'`](?:click|dblclick|auxclick|contextmenu|wheel|scroll|input|change|submit|keydown|keyup|keypress|focus|focusin|focusout|blur|drop|(?:mouse|pointer|touch|drag|gesture)[a-z]*)["'`]|\.on(?:click|dblclick|contextmenu|wheel|scroll|input|change|submit|key[a-z]+|focus|blur|drop|(?:mouse|pointer|touch|drag)[a-z]+)\s*=|\bescribir\s*\(|pointer-?events|WIDGET_MODAL/i;

/** Todos los valores que el ZIP le da a `pointer-events`, en CSS o en línea. */
function valoresDePuntero(texto: string): string[] {
  const valores: string[] = [];
  const patron = /pointer-events\s*:\s*([a-z-]+)/gi;
  let m: RegExpExecArray | null;
  while ((m = patron.exec(texto)) !== null) valores.push(m[1].toLowerCase());
  return valores;
}

/** Un veredicto por ZIP: es su código lo que se mira, y no cambia solo. */
const veredictos = new Map<string, boolean>();

/**
 * ¿Este ZIP es solo dibujo? Mira su código, una vez por ZIP.
 *
 * Conservador a propósito: tiene que DECLARARLO (apaga `pointer-events` y no
 * lo enciende en ningún sitio) y además no traer nada que reaccione. Un ZIP
 * que no dice nada sobre el puntero no se toca, por decorativo que parezca.
 */
export function esZipSoloDibujo(zip: ZipWidget): boolean {
  const css = zip.css ?? '';
  const html = zip.html ?? '';
  const js = zip.js ?? '';
  const clave = `${zip.meta.kind}|${zip.actualizado_en ?? ''}|${html.length}|${css.length}|${js.length}`;
  const previo = veredictos.get(clave);
  if (previo !== undefined) return previo;

  const valores = valoresDePuntero(`${css}\n${html}`);
  const loDeclara = valores.length > 0 && valores.every((v) => v === 'none');
  const reacciona =
    HTML_QUE_REACCIONA.test(html) ||
    CSS_CON_DESPLAZAMIENTO.test(css) ||
    JS_QUE_ESCUCHA.test(js);

  const veredicto = loDeclara && !reacciona;
  veredictos.set(clave, veredicto);
  return veredicto;
}

/**
 * ¿Este widget, tal como está colocado, es solo dibujo?
 *
 * Solo los importados en ZIP pueden serlo: son los únicos que declaran qué
 * hacen con el puntero. Y con una acción configurada ya no es un dibujo:
 * pulsarlo hace algo.
 */
export function esSoloDibujo(widget: HmiWidget): boolean {
  if (tieneAccion(leerAccion(widget.config))) return false;
  // El mismo orden que `WidgetRenderer`: si el kind es de un widget hecho en
  // React, se dibuja ese, y lo que diga un ZIP con el mismo nombre no cuenta.
  if (customByKind(widget.kind)) return false;
  const zip = zipByKind(widget.kind);
  return !!zip && esZipSoloDibujo(zip);
}

// ─── ¿Quién pisa a quién? ─────────────────────────────────────────

/** Las cajas de dos widgets comparten algún punto del lienzo. */
function sePisan(a: HmiWidget, b: HmiWidget): boolean {
  return (
    a.x < b.x + b.width &&
    b.x < a.x + a.width &&
    a.y < b.y + b.height &&
    b.y < a.y + a.height
  );
}

const NINGUNO: ReadonlySet<string> = new Set<string>();

/**
 * Sube cada vez que cambia el catálogo de ZIP. Mientras el catálogo no ha
 * llegado no se sabe si un widget es solo dibujo (se contesta que no), así
 * que lo calculado antes deja de valer en cuanto llega.
 */
let version = 0;
if (typeof window !== 'undefined') {
  window.addEventListener(EVENTO_WIDGETS, () => {
    version += 1;
    veredictos.clear();
  });
}

/** Lo ya calculado para una lista, mientras sea la misma y el catálogo también. */
const calculado = new WeakMap<object, { version: number; pasan: ReadonlySet<string> }>();

/**
 * De los widgets que se están dibujando —en su orden de pintado: el último
 * queda encima—, los ids de los que tienen que DEJAR PASAR el puntero: son
 * solo dibujo y pisan, por encima, a un widget `siempreAlcanzable`.
 *
 * Barato a propósito: se llama en cada redibujado. En una pantalla sin
 * widget de alarmas es un recorrido de la lista y nada más; y para una
 * misma lista (la pantalla empotrada conserva la suya entre lecturas del
 * PLC) el resultado se guarda.
 */
export function dejanPasarElPuntero(dibujados: readonly HmiWidget[]): ReadonlySet<string> {
  const previo = calculado.get(dibujados);
  if (previo && previo.version === version) return previo.pasan;

  let pasan: Set<string> | null = null;
  for (let i = 0; i < dibujados.length; i++) {
    const abajo = dibujados[i];
    if (!customByKind(abajo.kind)?.siempreAlcanzable) continue;
    for (let j = i + 1; j < dibujados.length; j++) {
      const arriba = dibujados[j];
      if (pasan?.has(arriba.id) || !sePisan(abajo, arriba)) continue;
      if (!esSoloDibujo(arriba)) continue;
      if (!pasan) pasan = new Set<string>();
      pasan.add(arriba.id);
    }
  }

  const resultado: ReadonlySet<string> = pasan ?? NINGUNO;
  calculado.set(dibujados, { version, pasan: resultado });
  return resultado;
}
