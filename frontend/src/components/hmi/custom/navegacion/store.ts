// =========================================================================
// custom/navegacion/store.ts
// Qué vista está abierta en cada grupo de navegación.
//
// EL PROBLEMA QUE RESUELVE
// El Sidebar y el Screen son dos widgets independientes del lienzo. Cada uno
// se dibuja desde `render()` con SU propio `HmiWidget` y nada más: no hay
// props compartidas, ni contexto común, ni forma de que uno le hable al otro.
//
// Este módulo es ese canal. Vive fuera de React, así que los dos widgets lo
// importan y ya está — sin tocar CanvasWidget, WidgetRenderer ni el árbol de
// componentes.
//
// EL "GRUPO"
// Un lienzo puede tener más de una navegación (un menú principal arriba y
// otro de detalle en un panel, por ejemplo). El grupo mantiene cada una
// aislada de la otra. Por defecto todos usan `principal`, así que si no lo
// tocas, un Sidebar y un Screen recién soltados se enlazan solos.
//
// LA PANTALLA MANDA SOBRE EL GRUPO
// El grupo NO basta como llave, y esto costó un bug feo. Las pestañas de
// arriba del Diseñador son pantallas distintas —proyectos distintos en el
// servidor, con sus propios widgets— pero todos los menús nacen con el
// grupo `principal`. Con el grupo como única llave, las tres pantallas de un
// HMI compartían UNA sola navegación:
//
//   * la pantalla 2, que no tiene menú, seguía viendo las secciones de la 1;
//   * un widget soltado en la 2 nacía con la sección abierta en la 1, y
//     desaparecía en cuanto se navegaba allá;
//   * y al borrar una sección, los widgets de OTRAS pantallas que la tenían
//     asignada quedaban huérfanos e invisibles.
//
// Por eso la llave real es `pantalla + grupo`. La composición es INTERNA: lo
// que se guarda en el diseño sigue siendo `config.grupo = 'principal'`, así
// que ningún proyecto guardado necesita migración y el campo «Grupo» sigue
// sirviendo para lo suyo — dos navegaciones independientes dentro de la
// MISMA pantalla.
//
// POR QUÉ NO SE PERSISTE
// La vista activa es estado de RUNTIME, no parte del diseño. Al abrir la
// Vista Previa siempre se empieza por la primera sección, como una web que
// abre en su portada. Lo que sí se guarda con el proyecto es a qué vista
// pertenece cada widget (`HmiWidget.vista`), que es otra cosa.
// =========================================================================
import { useSyncExternalStore } from 'react';

/** Grupo por defecto. Sidebar y Screen lo usan si no se cambia. */
export const GRUPO_POR_DEFECTO = 'principal';

/**
 * Id de vista que significa "en todas".
 *
 * Un widget con `vista` vacía se ve siempre, pase lo que pase. Es lo que
 * quieres para el propio Sidebar, para un logo o para una barra de estado:
 * cosas que acompañan a todas las pantallas.
 */
export const VISTA_TODAS = '';

/**
 * Kinds que SIEMPRE se ven, pase lo que pase.
 *
 * El propio menú y el panel de sección no pueden pertenecer a una sección: si
 * el menú desapareciera al navegar, te quedarías dentro de una sección sin
 * forma de salir. Se excluyen también del auto-asignado al soltarlos.
 */
/**
 * El widget que DECLARA las secciones.
 *
 * Se separa del set de arriba porque no es lo mismo: el Panel de Sección
 * también es de navegación, pero no publica nada. Quien quiera saber si
 * una pantalla tiene menú tiene que preguntar por este, no por los dos.
 */
export const KIND_MENU = 'custom:sidebar-navegacion';

export const KINDS_NAVEGACION = new Set<string>([
  KIND_MENU,
  'custom:pantalla-screen',
]);

export function esWidgetDeNavegacion(kind: string): boolean {
  return KINDS_NAVEGACION.has(kind);
}

// Pantalla que se está mirando ahora mismo. La ponen el Diseñador y la
// Vista Previa; los widgets no la conocen ni les hace falta.
let pantallaActual = '';

/**
 * Llave real de los mapas: pantalla + grupo.
 *
 * El separador es un carácter NUL, que no puede aparecer ni en un id de
 * pantalla (se genera con un slug de [a-z0-9_-]) ni en un nombre de grupo
 * escrito a mano. Con un separador «normal» como `::`, un grupo llamado
 * `a::b` podría colarse en la casilla de otra pantalla.
 */
const llave = (grupo: string): string => `${pantallaActual}\u0000${grupo}`;

/**
 * Dice qué pantalla se está mirando. Idempotente: repetir la misma no avisa
 * a nadie, así que se puede llamar en cada render sin coste.
 *
 * NO se borra lo de la pantalla anterior a propósito: al volver a ella se
 * recupera la sección en la que estabas, que es lo que espera cualquiera que
 * cambia de pestaña y vuelve.
 */
export function setPantalla(id: string): void {
  if (pantallaActual === id) return;
  pantallaActual = id;
  avisar();
}

export function getPantalla(): string {
  return pantallaActual;
}

// pantalla+grupo -> id de la vista abierta
const activas = new Map<string, string>();
const oyentes = new Set<() => void>();

function avisar() {
  // Copia antes de recorrer: un oyente podría darse de baja durante el aviso
  // y modificar el Set mientras se itera.
  for (const fn of Array.from(oyentes)) fn();
}

/** Vista abierta en ese grupo, EN LA PANTALLA ACTUAL. `''` si ninguna. */
export function getVistaActiva(grupo: string): string {
  return activas.get(llave(grupo)) ?? '';
}

/** Abre una vista. Es lo que hace el botón del Sidebar. */
export function setVistaActiva(grupo: string, vista: string): void {
  const k = llave(grupo);
  if (activas.get(k) === vista) return; // sin cambio, sin re-render
  activas.set(k, vista);
  avisar();
}

/**
 * Fija la vista inicial de un grupo SIN pisar la que el usuario ya eligió.
 *
 * La usa el Sidebar al montarse: sin esto, el lienzo arrancaría con todas las
 * capas ocultas y parecería vacío hasta el primer clic. Y al ser condicional,
 * un re-render no te devuelve a la portada a mitad de navegación.
 */
export function iniciarVista(grupo: string, vista: string): void {
  const k = llave(grupo);
  if (activas.has(k)) return;
  activas.set(k, vista);
  avisar();
}

/** Olvida la vista de un grupo de esta pantalla (o de TODAS las pantallas). */
export function reiniciar(grupo?: string): void {
  if (grupo === undefined) activas.clear();
  else activas.delete(llave(grupo));
  avisar();
}

function suscribir(fn: () => void): () => void {
  oyentes.add(fn);
  return () => oyentes.delete(fn);
}

/**
 * Hook de lectura. `useSyncExternalStore` es la forma correcta en React 18
 * de leer de un store externo: React se entera del cambio sin perderse
 * actualizaciones y sin avisos de "tearing" en modo concurrente.
 */
export function useVistaActiva(grupo: string): string {
  return useSyncExternalStore(
    suscribir,
    () => getVistaActiva(grupo),
    () => getVistaActiva(grupo) // valor en servidor: el mismo, no hay SSR
  );
}

// ─── Secciones declaradas ────────────────────────────────────────
//
// El Sidebar declara las secciones; el Screen necesita saber cuáles hay para
// poder mostrar el nombre de la que está abierta. En vez de obligar a
// escribir la lista dos veces, el Sidebar la publica aquí al dibujarse.
//
// Es una caché de conveniencia, no la fuente de verdad: esa sigue siendo el
// `config.secciones` del Sidebar, que es lo que se guarda con el proyecto.

export interface Seccion {
  id: string;
  label: string;

  /**
   * `nivel` = encabezado que agrupa a las secciones que vienen debajo
   * («GENERAL», «SECADOR»). No se puede pulsar y no abre ninguna vista.
   *
   * Ausente significa `seccion`, y eso es a propósito: los menús creados
   * antes de que existieran los niveles no traen el campo y se siguen
   * leyendo tal cual, sin migrar nada.
   *
   * NIVELES Y SECCIONES VIVEN EN LA MISMA LISTA, no anidados. El menú se
   * pinta en un solo recorrido de arriba abajo, que es exactamente lo que
   * se ve en pantalla, y reordenar sigue siendo mover un elemento en una
   * lista. Anidando harían falta dos estructuras, dos editores y dos
   * formas de reordenar para el mismo resultado visual.
   */
  tipo?: 'nivel' | 'seccion';

  /**
   * Icono de la sección: el SVG en crudo, ya saneado (ver limpiarSvg()).
   *
   * Se guarda el markup y no una ruta porque así el icono viaja dentro del
   * diseño: llega a la Vista Previa y al resto de equipos sin copiar
   * ningún archivo. Un icono son unos cientos de bytes.
   */
  icono?: string;

  /**
   * Id de la entrada que la contiene. Vacío o ausente = va en la raíz.
   *
   * ES LO QUE PERMITE ANIDAR SIN LÍMITE
   * «Proceso 1-1» dentro de «PANTALLA 1», y «SubProceso 1-1-1» dentro de
   * «Proceso 1-1», encadenando padres.
   *
   * SE MANTIENE UNA SOLA LISTA PLANA, igual que antes. El anidamiento va por
   * referencia y no metiendo arrays dentro de arrays: así reordenar sigue
   * siendo mover un elemento en una lista, y un menú guardado antes de que
   * esto existiera se sigue leyendo tal cual.
   *
   * AUSENTE NO ES LO MISMO QUE VACÍO. `undefined` significa «nadie lo ha
   * dicho todavía», y entonces manda la regla de siempre: la entrada cuelga
   * del último nivel que quede por encima en la lista. `''` significa «va en
   * la raíz», dicho a propósito. Ver `padreEfectivo()`.
   */
  padre?: string;

  /**
   * Pantalla del proyecto que se abre al pulsar esta sección.
   *
   * VACÍO O AUSENTE = EL COMPORTAMIENTO DE SIEMPRE: la sección solo decide
   * qué widgets de ESTE lienzo se ven (los que lleven su id en `vista`). No
   * cambia nada de lo que ya funcionaba.
   *
   * Con un `project_id` dentro, el Panel de Sección carga esa pantalla y la
   * dibuja dentro de su marco. Lo importante es lo que NO pasa: el menú no se
   * va. Sigue siendo un widget de la pantalla actual y nunca se sale de este
   * proyecto; lo único que cambia es el contenido del panel.
   *
   * SE GUARDA EL `project_id`, NO EL NOMBRE. El id es el nombre del fichero
   * en el servidor y no cambia nunca; el nombre visible sí (hay un
   * `PATCH /proyectos/{id}` para renombrar). Guardando el nombre, renombrar
   * una pantalla rompería en silencio todos los enlaces que apuntaran a ella.
   *
   * OPCIONAL A PROPÓSITO, igual que `tipo`, `icono` y `padre`: los menús
   * guardados antes de que esto existiera no traen el campo, se leen tal cual
   * y no hace falta migrar nada.
   *
   * SOLO TIENE SENTIDO EN LAS SECCIONES. Un nivel no navega —solo pliega y
   * despliega—, así que el Inspector no ofrece el desplegable en sus filas.
   */
  pantalla?: string;

}

/** ¿Esta entrada es un encabezado de nivel y no una sección navegable? */
export const esNivel = (s: Seccion): boolean => s.tipo === 'nivel';

/**
 * Las entradas que SÍ abren una vista.
 *
 * Lo usan el Screen y el arranque del menú: un encabezado no es un destino,
 * así que ni cuenta para «¿hay secciones?» ni puede ser la vista inicial.
 */
export const soloSecciones = (lista: Seccion[]): Seccion[] =>
  lista.filter((s) => !esNivel(s));

// ─── Anidamiento ─────────────────────────────────────────────────
//
// El árbol vive en la MISMA lista plana de siempre: cada entrada dice de
// quién cuelga con `padre`, y el orden de la lista es el orden en que se ven
// los hermanos. No hay arrays dentro de arrays.
//
// EL PUENTE CON LOS MENÚS QUE YA EXISTEN
// Antes de que existiera `padre`, agrupar era una cuestión de POSICIÓN: una
// sección pertenecía al último encabezado que quedara por encima de ella. Esa
// regla sigue viva para las entradas que no traen `padre`, así que un menú
// guardado en agosto se dibuja exactamente igual que siempre — solo que ahora
// esa jerarquía implícita se lee como un árbol de verdad.

/**
 * De quién cuelga la entrada `i`, resolviendo el caso de los menús viejos.
 *
 *   * `padre` escrito (aunque sea `''`) manda: es una decisión tomada.
 *   * sin `padre`, una sección cuelga del último NIVEL que haya por encima.
 *   * sin `padre`, un nivel va a la raíz: antes no podían anidarse.
 */
export function padreEfectivo(lista: Seccion[], i: number): string {
  const s = lista[i];
  if (!s) return '';
  if (s.padre !== undefined) return s.padre;
  if (esNivel(s)) return '';
  for (let k = i - 1; k >= 0; k--) {
    if (esNivel(lista[k])) return lista[k].id;
  }
  return '';
}

/** Índice de una entrada por su id, o -1. */
const indiceDe = (lista: Seccion[], id: string): number =>
  lista.findIndex((s) => s.id === id);

/**
 * La entrada y todo lo que cuelga de ella, en ids.
 *
 * Lleva un `vistos` por seguridad, no por elegancia: un menú editado a mano
 * podría traer un ciclo (A dentro de B y B dentro de A) y sin él esto se
 * quedaría dando vueltas y colgaría la pestaña.
 */
export function subarbolDe(lista: Seccion[], id: string): Set<string> {
  const salida = new Set<string>([id]);
  const pila = [id];
  while (pila.length) {
    const actual = pila.pop()!;
    lista.forEach((s, i) => {
      if (salida.has(s.id)) return;
      if (padreEfectivo(lista, i) !== actual) return;
      salida.add(s.id);
      pila.push(s.id);
    });
  }
  return salida;
}

/** Cadena de padres, del más cercano al más lejano. Para auto-desplegar. */
export function ancestrosDe(lista: Seccion[], id: string): string[] {
  const salida: string[] = [];
  const vistos = new Set<string>([id]);
  let actual = indiceDe(lista, id);
  while (actual >= 0) {
    const p = padreEfectivo(lista, actual);
    if (!p || vistos.has(p)) break;
    vistos.add(p);
    salida.push(p);
    actual = indiceDe(lista, p);
  }
  return salida;
}

/** Una entrada con lo que hace falta para dibujarla en su sitio. */
export interface EntradaArbol {
  seccion: Seccion;
  /** 0 = raíz. Es la sangría. */
  profundidad: number;
  /** Si tiene hijos, se le pinta la flechita de desplegar. */
  tieneHijos: boolean;
  /**
   * Su POSICIÓN en la lista original. Es la única identidad que no se puede
   * repetir.
   *
   * El id sí se repetía, y salía caro: se deriva del rótulo, así que dos
   * secciones llamadas igual acababan con el mismo id. Quien dibujaba usaba
   * `key={s.id}` y React se encontraba dos filas con la misma llave — al
   * plegar o desplegar, en vez de mover nodos, los duplicaba en pantalla.
   *
   * Con el índice, cada fila tiene una llave propia aunque el menú tenga
   * nombres repetidos, que es algo perfectamente legítimo.
   */
  indice: number;
}

/**
 * La lista en ORDEN DE ÁRBOL: cada entrada seguida de sus descendientes.
 *
 * Es lo que se dibuja, tanto en el menú como en el editor y en el selector
 * del Diseñador. Devolver esto ya calculado evita que cada sitio se invente
 * su propio recorrido y acaben discrepando.
 *
 * Las entradas cuyo padre no existe (se borró, o el menú venía roto) NO se
 * pierden: se recogen al final como si fueran de la raíz. Desaparecer en
 * silencio sería la peor opción posible — es justo el bug de los widgets
 * huérfanos, otra vez.
 */
export function arbolDe(lista: Seccion[]): EntradaArbol[] {
  const hijosDe = new Map<string, number[]>();
  lista.forEach((_, i) => {
    const p = padreEfectivo(lista, i);
    const actuales = hijosDe.get(p);
    if (actuales) actuales.push(i);
    else hijosDe.set(p, [i]);
  });

  const salida: EntradaArbol[] = [];
  const colocados = new Set<number>();

  const bajar = (padre: string, profundidad: number) => {
    for (const i of hijosDe.get(padre) ?? []) {
      if (colocados.has(i)) continue; // corta cualquier ciclo
      colocados.add(i);
      const id = lista[i].id;
      salida.push({
        seccion: lista[i],
        profundidad,
        tieneHijos: (hijosDe.get(id) ?? []).length > 0,
        indice: i,
      });
      bajar(id, profundidad + 1);
    }
  };

  bajar('', 0);

  // Las que se quedaron fuera cuelgan de un padre inexistente. Van al final,
  // a la raíz, para que se puedan ver y arreglar.
  lista.forEach((s, i) => {
    if (colocados.has(i)) return;
    colocados.add(i);
    salida.push({ seccion: s, profundidad: 0, tieneHijos: false, indice: i });
  });

  return salida;
}

/**
 * Deja la lista en forma canónica: todos los padres escritos y en orden de
 * árbol.
 *
 * Se llama antes de CUALQUIER cambio de estructura (indentar, mover, borrar).
 * El motivo: mientras los padres son implícitos dependen de dónde caiga cada
 * encabezado, así que mover una entrada podría cambiarle el padre a otra sin
 * que nadie lo pidiera. Escribiéndolos todos de golpe la primera vez que se
 * toca el menú, a partir de ahí cada entrada dice lo que es y nada se mueve
 * solo.
 *
 * Un menú al que no se le toque la estructura NUNCA pasa por aquí, así que se
 * queda tal cual estaba guardado.
 */
export function normalizarEstructura(lista: Seccion[]): Seccion[] {
  const padres = lista.map((_, i) => padreEfectivo(lista, i));
  const conPadre = lista.map((s, i) => ({ ...s, padre: padres[i] }));
  return arbolDe(conPadre).map((e) => e.seccion);
}

// ─── Ids que no se pisan ─────────────────────────────────────────
//
// EL ID NO PUEDE REPETIRSE, EL NOMBRE SÍ.
//
// El id se saca del rótulo (`Sección 7` -> `seccion-7`), y hasta aquí bien:
// es legible y estable. Lo que faltaba era comprobar que no lo tuviera ya
// otra entrada. Y llamar igual a dos secciones es de lo más normal —«Motor»
// dentro de dos líneas distintas, por ejemplo—, así que la colisión no era
// un caso raro sino el camino corto.
//
// Con dos entradas compartiendo id, el menú se rompía de cuatro maneras a la
// vez, porque el id ES la identidad en todo el módulo:
//
//   * `editar()` recorre con `s.id === id`, así que renombrar una renombraba
//     TODAS las que compartieran el id — parecía que se duplicaban solas;
//   * la sección abierta se marca con `s.id === activa`, y se encendían
//     varias a la vez;
//   * `padre` apunta por id, así que un subárbol colgaba de la primera que
//     coincidiera, no de la suya;
//   * y `key={s.id}` en React, con llaves repetidas, duplicaba filas en
//     pantalla al plegar y desplegar.
//
// De ahí que la unicidad se garantice al escribir (`idUnico`) y se pueda
// reparar lo ya guardado (`sanearIds`).

/**
 * El id libre más parecido a `propuesto`: `motor`, y si está cogido
 * `motor-2`, `motor-3`…
 *
 * `exceptoIndice` es la entrada que se está editando: su propio id no cuenta
 * como ocupado, o renombrar algo a lo que ya se llamaba le añadiría un `-2`.
 */
export function idUnico(
  lista: Seccion[],
  propuesto: string,
  exceptoIndice = -1
): string {
  const cogidos = new Set(
    lista.filter((_, i) => i !== exceptoIndice).map((s) => s.id)
  );
  if (!cogidos.has(propuesto)) return propuesto;
  let n = 2;
  while (cogidos.has(`${propuesto}-${n}`)) n++;
  return `${propuesto}-${n}`;
}

/**
 * Repara un menú que ya trae ids repetidos.
 *
 * LA PRIMERA APARICIÓN SE QUEDA CON EL ID. No es un capricho: ese id es lo
 * que hay escrito en `HmiWidget.vista` de los widgets, y es la primera la que
 * hoy se los queda (todo el módulo resuelve por `findIndex`). Renumerar las
 * siguientes deja las cosas donde ya estaban y solo separa lo que estaba
 * pegado.
 *
 * Devuelve la MISMA lista si no había nada repetido, para no provocar
 * re-dibujados ni marcar el proyecto como modificado sin motivo.
 */
export function sanearIds(lista: Seccion[]): Seccion[] {
  const vistos = new Set<string>();
  let hubo = false;

  const salida = lista.map((s) => {
    if (!vistos.has(s.id)) {
      vistos.add(s.id);
      return s;
    }
    hubo = true;
    // Se mira contra DOS sitios: los ids ya repartidos en esta pasada y los
    // originales que vienen más adelante. Solo con los originales, tres
    // entradas llamadas igual recibirían todas el mismo `-2`.
    let n = 2;
    while (vistos.has(`${s.id}-${n}`) || lista.some((o) => o.id === `${s.id}-${n}`)) n++;
    const nuevo = `${s.id}-${n}`;
    vistos.add(nuevo);
    return { ...s, id: nuevo };
  });

  return hubo ? salida : lista;
}

/** Hermanos de una entrada: los que cuelgan del mismo padre, en orden. */
export function hermanosDe(lista: Seccion[], id: string): string[] {
  const i = indiceDe(lista, id);
  if (i < 0) return [];
  const p = padreEfectivo(lista, i);
  return lista.filter((_, k) => padreEfectivo(lista, k) === p).map((s) => s.id);
}

/**
 * Mete una entrada dentro del hermano que tiene justo encima.
 *
 * Es lo que hace el Tab de cualquier lista de tareas: no se puede indentar el
 * primero de su grupo, porque no hay nadie encima de quien colgar.
 *
 * Devuelve la MISMA lista si no se puede, para que quien llama no guarde un
 * cambio que no existió.
 */
export function indentar(lista: Seccion[], id: string): Seccion[] {
  const base = normalizarEstructura(lista);
  const hermanos = hermanosDe(base, id);
  const pos = hermanos.indexOf(id);
  if (pos <= 0) return lista;

  const nuevoPadre = hermanos[pos - 1];
  const movida = base.map((s) => (s.id === id ? { ...s, padre: nuevoPadre } : s));
  return arbolDe(movida).map((e) => e.seccion);
}

/** Saca una entrada un nivel hacia afuera: pasa a ser hermana de su padre. */
export function desindentar(lista: Seccion[], id: string): Seccion[] {
  const base = normalizarEstructura(lista);
  const i = indiceDe(base, id);
  if (i < 0) return lista;

  const padre = padreEfectivo(base, i);
  if (!padre) return lista; // ya está en la raíz

  const iPadre = indiceDe(base, padre);
  const abuelo = iPadre >= 0 ? padreEfectivo(base, iPadre) : '';

  const movida = base.map((s) => (s.id === id ? { ...s, padre: abuelo } : s));
  return arbolDe(movida).map((e) => e.seccion);
}

/**
 * Sube o baja una entrada ENTRE SUS HERMANOS, llevándose lo que tenga dentro.
 *
 * Se mueve por hermanos y no por posición en la lista porque la lista está en
 * orden de árbol: la fila de arriba puede ser el último nieto del hermano
 * anterior, y colarse ahí en medio sería meterse en un grupo al que no
 * perteneces.
 */
export function moverEntreHermanos(
  lista: Seccion[],
  id: string,
  delta: number
): Seccion[] {
  const base = normalizarEstructura(lista);
  const hermanos = hermanosDe(base, id);
  const pos = hermanos.indexOf(id);
  const destino = pos + delta;
  if (pos < 0 || destino < 0 || destino >= hermanos.length) return lista;

  // Reordenar los hermanos y volver a recorrer el árbol: los descendientes
  // viajan solos porque siguen apuntando a su padre.
  const orden = [...hermanos];
  [orden[pos], orden[destino]] = [orden[destino], orden[pos]];
  const peso = new Map(orden.map((x, k) => [x, k]));

  const reordenada = [...base].sort((a, b) => {
    const pa = peso.get(a.id);
    const pb = peso.get(b.id);
    if (pa === undefined || pb === undefined) return 0;
    return pa - pb;
  });

  return arbolDe(reordenada).map((e) => e.seccion);
}

/**
 * Quita una entrada y SUBE A SUS HIJOS un nivel, en vez de llevárselos.
 *
 * Es la misma decisión que en los contenedores del lienzo: borrar un grupo de
 * un tecleo es la clase de error que arruina media hora de trabajo. Que los
 * hijos se queden cuesta un segundo de rehacer; que desaparezcan, mucho más.
 */
export function quitarEntrada(lista: Seccion[], id: string): Seccion[] {
  const base = normalizarEstructura(lista);
  const i = indiceDe(base, id);
  if (i < 0) return lista;

  const abuelo = padreEfectivo(base, i);
  const sinElla = base
    .filter((s) => s.id !== id)
    .map((s) => (s.padre === id ? { ...s, padre: abuelo } : s));

  return arbolDe(sinElla).map((e) => e.seccion);
}

const seccionesPorGrupo = new Map<string, Seccion[]>();

/**
 * Lista vacía COMPARTIDA para los grupos que aún no publicaron secciones.
 *
 * Tiene que ser una constante, no un `[]` recién creado en cada llamada.
 * `useSyncExternalStore` compara el snapshot anterior con el nuevo usando
 * `Object.is`, y dos arrays vacíos distintos nunca son el mismo objeto: React
 * creería que el store cambió en cada render, volvería a dibujar, obtendría
 * otro `[]` nuevo... y así hasta "Maximum update depth exceeded".
 *
 * Congelada para que nadie le haga push por accidente y contamine a todos los
 * grupos que la comparten.
 */
const SIN_SECCIONES: Seccion[] = [];
// El freeze va aparte: `Object.freeze([])` devuelve `readonly never[]` y
// TypeScript no lo acepta como `Seccion[]` en la misma línea.
Object.freeze(SIN_SECCIONES);

export function publicarSecciones(grupo: string, secciones: Seccion[]): void {
  const k = llave(grupo);
  const previas = seccionesPorGrupo.get(k);
  // Comparar por contenido evita un bucle infinito de render: el Sidebar
  // publica en cada dibujo, y avisar siempre lo volvería a dibujar.
  if (previas && JSON.stringify(previas) === JSON.stringify(secciones)) return;
  // Lista vacía y «nunca publicó» son lo mismo para quien lee, pero
  // guardarla importa: es lo que borra las secciones de una pantalla a la
  // que le quitaron el menú.
  if (!previas && secciones.length === 0) return;
  seccionesPorGrupo.set(k, secciones);
  avisar();
}

export function getSecciones(grupo: string): Seccion[] {
  return seccionesPorGrupo.get(llave(grupo)) ?? SIN_SECCIONES;
}

export function useSecciones(grupo: string): Seccion[] {
  return useSyncExternalStore(
    suscribir,
    () => getSecciones(grupo),
    () => getSecciones(grupo)
  );
}

/** Nombre legible de una vista, para las cabeceras. */
export function etiquetaDeVista(grupo: string, vistaId: string): string {
  if (!vistaId) return '';
  return getSecciones(grupo).find((s) => s.id === vistaId)?.label ?? vistaId;
}

// ─── Catálogo de pantallas del proyecto ──────────────────────────
//
// Qué pantallas existen, para que el Inspector del menú pueda ofrecerlas en
// un desplegable y cada sección diga a cuál salta.
//
// POR QUÉ PASA POR AQUÍ Y NO POR `useAppStore()`
// Sería lo natural —el AppStore ya publica `pantallas`— y sin embargo no se
// puede: el Inspector del menú vive en `custom/navegacion/inspector.tsx`, lo
// importa `SidebarNavegacion`, a ese lo importa `custom/registry`, y a ese lo
// importa el propio `AppStore`. Leer el AppStore desde el Inspector cerraría
// el círculo:
//
//     AppStore → registry → SidebarNavegacion → inspector → AppStore
//
// Un ciclo de imports en ESM no siempre revienta, pero cuando lo hace es de
// la peor manera: uno de los módulos se evalúa a medias y alguna referencia
// llega como `undefined` en el arranque, sin un error que apunte a la causa.
//
// Este módulo, en cambio, no importa NADA de la aplicación: solo React. Por
// eso es el sitio correcto para dejar el dato — exactamente el mismo papel
// que ya cumple con las secciones que publica el menú.
//
// Lo publica el Diseñador, que es quien tiene la lista y el único sitio donde
// se dibuja el Inspector.

/** Una pantalla entre las que puede elegir una sección. */
export interface PantallaDisponible {
  project_id: string;
  nombre: string;
}

/**
 * Lista vacía COMPARTIDA, por el mismo motivo que `SIN_SECCIONES`: devolver
 * un `[]` nuevo en cada lectura haría que `useSyncExternalStore` creyera que
 * el store cambió en cada render, y de ahí a "Maximum update depth exceeded".
 */
const SIN_PANTALLAS: PantallaDisponible[] = [];
Object.freeze(SIN_PANTALLAS);

let pantallasDisponibles: PantallaDisponible[] = SIN_PANTALLAS;

/**
 * Publica qué pantallas hay. Idempotente: si la lista es la misma no avisa a
 * nadie, así que se puede llamar en cada render sin coste.
 *
 * Se copia solo `project_id` y `nombre` a propósito. Lo que llega del
 * AppStore es un `ResumenPantalla` completo, con `version` y
 * `actualizado_en` dentro — campos que cambian en CADA guardado del
 * Diseñador. Comparando el objeto entero, mover un widget publicaría una
 * lista "nueva" cada 400 ms y repintaría el Inspector sin motivo.
 */
export function publicarPantallas(lista: PantallaDisponible[]): void {
  const limpia: PantallaDisponible[] = (lista ?? []).map((p) => ({
    project_id: p.project_id,
    nombre: p.nombre || p.project_id,
  }));

  const igual =
    limpia.length === pantallasDisponibles.length &&
    limpia.every(
      (p, i) =>
        p.project_id === pantallasDisponibles[i].project_id &&
        p.nombre === pantallasDisponibles[i].nombre
    );
  if (igual) return;

  pantallasDisponibles = limpia;
  avisar();
}

export function getPantallas(): PantallaDisponible[] {
  return pantallasDisponibles;
}

export function usePantallas(): PantallaDisponible[] {
  return useSyncExternalStore(suscribir, getPantallas, getPantallas);
}

/**
 * Pantalla que se está mirando, como hook.
 *
 * `getPantalla()` a secas serviría para leerla, pero no volvería a dibujar al
 * cambiar de pestaña: el Inspector marcaría «(actual)» sobre la pantalla
 * equivocada hasta el siguiente render por otro motivo.
 */
export function usePantallaAbierta(): string {
  return useSyncExternalStore(suscribir, getPantalla, getPantalla);
}

/** Nombre legible de una pantalla. `''` si ya no está en el catálogo. */
export function nombreDePantalla(projectId: string): string {
  if (!projectId) return '';
  return (
    pantallasDisponibles.find((p) => p.project_id === projectId)?.nombre ?? ''
  );
}

/**
 * ¿Este widget se ve con la vista que hay abierta?
 *
 * Las reglas, en orden:
 *   1. `vista` vacía  -> se ve SIEMPRE (el Sidebar, un logo, una barra fija)
 *   2. no hay ninguna vista abierta en su grupo -> se ve (todavía no hay
 *      navegación montada, y esconder cosas sin motivo desconcierta)
 *   3. si no, solo si su vista es la abierta
 */
export function visibleEnVista(
  vistaDelWidget: string | undefined,
  grupo: string = GRUPO_POR_DEFECTO
): boolean {
  const v = (vistaDelWidget ?? '').trim();
  if (!v) return true;
  const activa = getVistaActiva(grupo);
  if (!activa) return true;
  return v === activa;
}
