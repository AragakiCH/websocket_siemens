// =========================================================================
// components/hmi/portapapeles.ts
// Copiar y pegar widgets en el Diseñador.
//
// POR QUÉ NO ES EL PORTAPAPELES DEL SISTEMA
// Se podría enganchar a los eventos `copy`/`paste` del navegador y meter JSON
// en el portapapeles real. Se descartó por tres motivos concretos:
//
//   * leerlo exige permiso del navegador y es asíncrono, así que pegar podría
//     fallar con un diálogo en mitad de un diseño;
//   * pisaría el Ctrl+C de texto — copiar el nombre de un tag del Inspector
//     dejaría de funcionar;
//   * y un JSON de widgets suelto en el portapapeles se pega por accidente en
//     un chat o en un correo.
//
// Un portapapeles PROPIO no tiene ninguno de esos problemas y hace justo lo
// que se espera. Se guarda además en `localStorage`, así que sobrevive a un F5
// y funciona entre pestañas del navegador: se copia en una y se pega en otra.
//
// ── LAS TRES COSAS QUE HAY QUE HACER BIEN ───────────────────────────────
//
// 1. COPIAR EL BLOQUE ENTERO, NO LO MARCADO. Si hay un contenedor marcado,
//    sus hijos van con él aunque nadie los marcara. Copiar un grupo y que
//    llegue vacío sería lo peor que podría pasar aquí.
//
// 2. IDS NUEVOS, Y `padre` REMAPEADO. Cada copia estrena id. Y el `padre` de
//    un hijo tiene que apuntar al id NUEVO de su contenedor, no al viejo: si
//    no, al pegar un grupo los hijos quedarían colgando del ORIGINAL y mover
//    el original arrastraría a la copia. Por eso se pasa por una tabla de
//    equivalencias en vez de generar ids sobre la marcha.
//
// 3. COORDENADAS RELATIVAS. Lo copiado se guarda respecto a la esquina de la
//    caja que lo envuelve, no en coordenadas del lienzo. Así pegar es «pon el
//    bloque AQUÍ» y las posiciones relativas entre los widgets se respetan
//    solas, vayan donde vayan.
// =========================================================================
import type { HmiWidget } from '../../models/widget';
import { bloqueDe, raicesDeSeleccion } from './grupo';

/** Lo copiado, tal como se guarda. */
export interface Portapapeles {
  /** Sube si la forma cambia; lo guardado con otra versión se descarta. */
  version: 1;
  /** Pantalla de la que salió. Decide si al pegar hace falta desplazar. */
  origen: string;
  /** Esquina superior izquierda que tenía el bloque al copiarlo. */
  ancla: { x: number; y: number };
  /** Los widgets, con `x`/`y` RELATIVOS al ancla. */
  widgets: HmiWidget[];
}

const CLAVE = 'psi.hmi.portapapeles';

// Copia en memoria. Es la que manda: `localStorage` solo la respalda, y leer
// y parsear JSON en cada pulsación de tecla para saber si el menú puede
// ofrecer «Pegar» sería trabajo tirado.
let memoria: Portapapeles | null = null;
let leidoDelDisco = false;

/**
 * Copia profunda.
 *
 * NO es opcional: `config`, `dinamicas`, `enlaces` y `style` son objetos. Sin
 * clonarlos, el widget pegado compartiría el MISMO objeto con el original y
 * cambiarle el color a la copia se lo cambiaría también al de al lado. Es el
 * clásico fallo de «pegar» que aparece dos semanas después y no hay quien lo
 * relacione con el pegado.
 */
function clonar<T>(v: T): T {
  try {
    return structuredClone(v);
  } catch {
    return JSON.parse(JSON.stringify(v));
  }
}

function valido(d: any): d is Portapapeles {
  return (
    !!d &&
    d.version === 1 &&
    typeof d.origen === 'string' &&
    !!d.ancla &&
    Array.isArray(d.widgets) &&
    d.widgets.length > 0
  );
}

/** Lo que hay copiado ahora mismo, o `null`. */
export function leerPortapapeles(): Portapapeles | null {
  if (memoria) return memoria;
  // El disco se mira UNA vez por carga de página: si no había nada, no hay
  // razón para volver a preguntarle en cada render.
  if (leidoDelDisco) return null;
  leidoDelDisco = true;
  try {
    const crudo = localStorage.getItem(CLAVE);
    if (!crudo) return null;
    const d = JSON.parse(crudo);
    if (!valido(d)) return null;
    memoria = d;
    return memoria;
  } catch {
    // Modo privado, cuota llena, JSON corrupto. Nada de esto debe impedir
    // diseñar: simplemente no hay nada copiado.
    return null;
  }
}

/**
 * Guarda la selección en el portapapeles.
 *
 * Devuelve lo copiado, o `null` si no había nada que copiar.
 */
export function copiar(
  widgets: HmiWidget[],
  seleccion: string[],
  origen: string
): Portapapeles | null {
  const raices = raicesDeSeleccion(widgets, seleccion);
  if (raices.length === 0) return null;

  const dentro = new Set<string>();
  for (const raiz of raices) {
    for (const id of bloqueDe(widgets, raiz)) dentro.add(id);
  }

  // Se filtra sobre `widgets` y no sobre `dentro` para CONSERVAR EL ORDEN del
  // array, que es el orden de pintado. Recorriendo el Set, la copia saldría
  // con las capas cambiadas respecto al original.
  const copiados = widgets.filter((w) => dentro.has(w.id)).map(clonar);
  if (copiados.length === 0) return null;

  const x0 = Math.min(...copiados.map((w) => w.x));
  const y0 = Math.min(...copiados.map((w) => w.y));

  const doc: Portapapeles = {
    version: 1,
    origen,
    ancla: { x: x0, y: y0 },
    widgets: copiados.map((w) => ({ ...w, x: w.x - x0, y: w.y - y0 })),
  };

  memoria = doc;
  try {
    localStorage.setItem(CLAVE, JSON.stringify(doc));
  } catch {
    // Se queda solo en memoria. Copiar y pegar sigue funcionando en esta
    // pestaña, que es el 99 % de las veces.
  }
  return doc;
}

export interface OpcionesPegar {
  /** Generador de ids del Diseñador. Se llama una vez por widget. */
  nuevoId: () => string;
  /** Esquina donde debe quedar el bloque. Se ajusta si no cabe. */
  x: number;
  y: number;
  lienzo: { width: number; height: number };
  /** Secciones que EXISTEN en la pantalla destino. */
  seccionesValidas: Set<string>;
  /** Sección abierta ahora, para lo que no encaje en ninguna. */
  vistaActiva: string;
  vistaTodas: string;
  esNavegacion: (kind: string) => boolean;
  /** Nombres ya ocupados en la pantalla destino. */
  nombresUsados: Set<string>;
}

/**
 * Un nombre que no choque con los que ya hay.
 *
 * Se recorta cualquier « copia» previa antes de añadir la nueva: sin eso, a la
 * cuarta vez el widget se llamaría «Tanque copia copia copia», que no dice
 * nada y encima no cabe en el panel de capas.
 */
function nombreLibre(base: string, usados: Set<string>): string {
  if (!usados.has(base)) return base;
  const raiz = base.replace(/ copia(\s+\d+)?$/i, '');
  let candidato = `${raiz} copia`;
  let n = 1;
  while (usados.has(candidato)) {
    n += 1;
    candidato = `${raiz} copia ${n}`;
  }
  return candidato;
}

/**
 * Convierte lo copiado en widgets nuevos, listos para añadir al lienzo.
 *
 * No toca el estado: devuelve el array y quien llama decide qué hacer con él.
 */
export function pegar(doc: Portapapeles, o: OpcionesPegar): HmiWidget[] {
  // Tamaño del bloque, para no dejarlo medio fuera del lienzo. Un widget
  // pegado fuera del borde no se ve, no se puede seleccionar y parece que
  // «pegar no hizo nada».
  const ancho = Math.max(...doc.widgets.map((w) => w.x + w.width));
  const alto = Math.max(...doc.widgets.map((w) => w.y + w.height));
  const x = Math.max(0, Math.min(o.x, Math.max(0, o.lienzo.width - ancho)));
  const y = Math.max(0, Math.min(o.y, Math.max(0, o.lienzo.height - alto)));

  // TODOS los ids nuevos PRIMERO. Hace falta la tabla completa antes de
  // remapear `padre`, porque un hijo puede ir antes que su contenedor en el
  // array (el orden es de pintado, no de parentesco).
  const mapa = new Map<string, string>();
  for (const w of doc.widgets) mapa.set(w.id, o.nuevoId());

  const usados = new Set(o.nombresUsados);

  return doc.widgets.map((w) => {
    const c = clonar(w);
    const nombre = nombreLibre(c.name, usados);
    usados.add(nombre);

    // La sección. Pegar en OTRA pantalla puede traer un id de sección que allí
    // no existe, y eso deja al widget huérfano: no se dibuja, no se puede
    // seleccionar y no se puede borrar. Se evita antes de que ocurra.
    const v = (c.vista ?? '').trim();
    let vista: string;
    if (o.esNavegacion(c.kind)) {
      // Un menú metido en una sección desaparecería al salir de ella.
      vista = o.vistaTodas;
    } else if (!v || v === o.vistaTodas || o.seccionesValidas.has(v)) {
      vista = v || o.vistaTodas;
    } else {
      vista = o.vistaActiva;
    }

    return {
      ...c,
      id: mapa.get(w.id)!,
      name: nombre,
      x: x + w.x,
      y: y + w.y,
      // `mapa.get` devuelve undefined si el padre NO se copió — el caso de
      // copiar un hijo suelto sacándolo de su grupo. La copia nace libre, que
      // es lo correcto: colgarla del contenedor original sería una sorpresa.
      padre: c.padre ? mapa.get(c.padre) : undefined,
      vista,
    };
  });
}
