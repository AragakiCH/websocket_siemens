// =========================================================================
// components/hmi/historial.ts
// Deshacer y rehacer en el Diseñador.
//
// ── POR QUÉ INSTANTÁNEAS Y NO «COMANDOS» ────────────────────────────────
// El otro camino sería que cada acción supiera deshacerse a sí misma: mover
// guarda la posición anterior, borrar guarda el widget, agrupar guarda el
// árbol… Es lo que hacen los editores grandes, y es también donde se meten
// los fallos: basta que UNA acción de quince se olvide de registrar su
// inversa para que Ctrl+Z deje el lienzo en un estado imposible. Y quien
// añada la acción número dieciséis dentro de seis meses no va a saberlo.
//
// Aquí se guarda el diseño ENTERO antes de cada cambio. Suena caro y no lo
// es, porque todo el Diseñador trabaja de forma inmutable: `setWidgets` nunca
// toca el array, siempre construye uno nuevo. Así que quedarse con la
// referencia del array anterior ES la instantánea, y cuesta ocho bytes. Los
// widgets que no cambiaron son literalmente los mismos objetos compartidos.
//
// ⚠️ Eso es lo único que hay que respetar: NADIE puede modificar un widget en
// su sitio (`w.x = 10`). Si algún día alguien lo hace, las instantáceas
// pasadas cambiarían solas y deshacer dejaría de funcionar sin dar la cara.
// Hoy no ocurre en ningún sitio: todo va por `{ ...w, ... }`.
//
// ── EL PROBLEMA DE VERDAD: ARRASTRAR SON SESENTA CAMBIOS POR SEGUNDO ────
// Guardar uno por movimiento del ratón haría que Ctrl+Z deshiciera un píxel.
// Habría que pulsarlo trescientas veces para devolver un widget a su sitio,
// que es exactamente igual de inútil que no tener deshacer.
//
// Se agrupan por PAUSA: mientras los cambios se encadenan sin respiro se
// consideran el mismo gesto, y la entrada se cierra cuando pasan unos cientos
// de milisegundos sin tocar nada. Un arrastre entero es UNA entrada. Escribir
// un nombre en el Inspector, también.
//
// Se eligió la pausa y no «engancharse al inicio y fin del arrastre» a
// propósito: enganchado a los gestos habría que acordarse de marcar el
// principio y el final en cada sitio que modifique el lienzo —y volvemos al
// problema de la acción número dieciséis—. La pausa no se puede olvidar,
// porque no hay que ponerla en ningún sitio.
// =========================================================================
import { useCallback, useEffect, useRef, useState } from 'react';
import type { HmiWidget } from '../../models/widget';

/** El diseño completo en un instante. */
export interface Instantanea {
  widgets: HmiWidget[];
  canvasW: number;
  canvasH: number;
  canvasBg: string;
  /** Lo que estaba seleccionado. Se restaura para no perder de vista qué cambió. */
  seleccion: string[];
}

/** Milisegundos sin cambios que cierran una entrada del historial. */
const PAUSA = 350;

/**
 * Cuántas entradas se guardan.
 *
 * No es por memoria —cada una son referencias, no copias— sino por criterio:
 * más allá de cincuenta pasos ya no se está deshaciendo, se está buscando, y
 * para eso está recargar la pantalla.
 */
const TOPE = 50;

export interface Historial {
  deshacer: () => void;
  rehacer: () => void;
  puedeDeshacer: boolean;
  puedeRehacer: boolean;
  /** Cuántos pasos hay guardados. Solo para el título de los botones. */
  pasos: number;
}

export interface OpcionesHistorial {
  /** En falso no se registra nada (hidratación, otra pestaña de la app). */
  activo: boolean;
  /** Cambiar de pantalla tira la historia: la de la anterior no aplica aquí. */
  clave: string;
  widgets: HmiWidget[];
  canvasW: number;
  canvasH: number;
  canvasBg: string;
  /**
   * La selección, por referencia.
   *
   * Va en un ref y no como valor para que seleccionar un widget NO cree una
   * entrada del historial. Marcar cosas no es editar, y un Ctrl+Z que
   * deshiciera «haber hecho clic» sería desesperante.
   */
  seleccionRef: { current: string[] };
  /** Vuelca una instantánea en el estado del Diseñador. */
  aplicar: (s: Instantanea) => void;
}

export function useHistorial(o: OpcionesHistorial): Historial {
  const pasado = useRef<Instantanea[]>([]);
  const futuro = useRef<Instantanea[]>([]);
  /** Lo último que se sabe que está en pantalla. */
  const ultimo = useRef<Instantanea | null>(null);
  /** El estado ANTERIOR a la ráfaga que está abierta ahora mismo. */
  const pendiente = useRef<Instantanea | null>(null);
  const reloj = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** En true mientras se aplica un deshacer: ese cambio no se registra. */
  const aplicando = useRef(false);

  // Solo existe para repintar los botones cuando cambian las pilas. Las pilas
  // van en refs porque el listener de teclado tiene que verlas al día sin
  // volver a engancharse en cada pulsación.
  const [, repintar] = useState(0);
  const avisar = useCallback(() => repintar((n) => n + 1), []);

  const foto = useCallback(
    (): Instantanea => ({
      widgets: o.widgets,
      canvasW: o.canvasW,
      canvasH: o.canvasH,
      canvasBg: o.canvasBg,
      seleccion: o.seleccionRef.current,
    }),
    [o.widgets, o.canvasW, o.canvasH, o.canvasBg, o.seleccionRef]
  );

  /** Cierra la ráfaga abierta y la mete en el pasado. */
  const cerrarRafaga = useCallback(() => {
    if (reloj.current) {
      clearTimeout(reloj.current);
      reloj.current = null;
    }
    const antes = pendiente.current;
    pendiente.current = null;
    if (!antes) return false;
    pasado.current.push(antes);
    if (pasado.current.length > TOPE) pasado.current.shift();
    // Un cambio nuevo invalida lo rehacible: la línea del tiempo se bifurcó y
    // lo que había por delante ya no encaja con lo que hay ahora.
    futuro.current = [];
    return true;
  }, []);

  // ── Cambio de pantalla: historia nueva ──────────────────────────
  useEffect(() => {
    pasado.current = [];
    futuro.current = [];
    pendiente.current = null;
    ultimo.current = null;
    if (reloj.current) {
      clearTimeout(reloj.current);
      reloj.current = null;
    }
    avisar();
  }, [o.clave, avisar]);

  // ── Detección de cambios ────────────────────────────────────────
  useEffect(() => {
    if (!o.activo) return;
    const ahora = foto();

    // Primer paso con la pantalla ya cargada: es el punto de partida, no un
    // cambio. Sin esto, el primer Ctrl+Z devolvería a un lienzo vacío.
    if (ultimo.current === null) {
      ultimo.current = ahora;
      return;
    }

    // El cambio lo provocó un deshacer/rehacer: ya está contabilizado.
    if (aplicando.current) {
      aplicando.current = false;
      ultimo.current = ahora;
      return;
    }

    const prev = ultimo.current;
    // Comparación por REFERENCIA. Es correcta justamente porque nada se
    // modifica en su sitio: si el array es el mismo objeto, no cambió nada.
    // Y es O(1), que importa cuando esto corre en cada render de un arrastre.
    if (
      prev.widgets === ahora.widgets &&
      prev.canvasW === ahora.canvasW &&
      prev.canvasH === ahora.canvasH &&
      prev.canvasBg === ahora.canvasBg
    ) {
      return;
    }

    // Se abre una ráfaga si no había ninguna. Lo que se guarda es el estado
    // de ANTES del primer cambio del gesto, no el de antes del último: eso es
    // lo que hace que un arrastre entero se deshaga de una vez.
    if (pendiente.current === null) pendiente.current = prev;
    ultimo.current = ahora;

    if (reloj.current) clearTimeout(reloj.current);
    reloj.current = setTimeout(() => {
      if (cerrarRafaga()) avisar();
    }, PAUSA);
  }, [o.activo, foto, cerrarRafaga, avisar]);

  // Al desmontar, el temporizador no debe quedar suelto.
  useEffect(
    () => () => {
      if (reloj.current) clearTimeout(reloj.current);
    },
    []
  );

  const deshacer = useCallback(() => {
    if (!o.activo) return;
    // Si se pulsa Ctrl+Z justo al soltar el ratón, la ráfaga todavía está
    // abierta. Se cierra ANTES: si no, el arrastre recién hecho no estaría en
    // la pila y se desharía el cambio anterior, que es de lo más confuso.
    cerrarRafaga();
    const anterior = pasado.current.pop();
    if (!anterior) return;
    if (ultimo.current) futuro.current.push(ultimo.current);
    aplicando.current = true;
    ultimo.current = anterior;
    o.aplicar(anterior);
    avisar();
  }, [o, cerrarRafaga, avisar]);

  const rehacer = useCallback(() => {
    if (!o.activo) return;
    cerrarRafaga();
    const siguiente = futuro.current.pop();
    if (!siguiente) return;
    if (ultimo.current) pasado.current.push(ultimo.current);
    aplicando.current = true;
    ultimo.current = siguiente;
    o.aplicar(siguiente);
    avisar();
  }, [o, cerrarRafaga, avisar]);

  return {
    deshacer,
    rehacer,
    // La ráfaga abierta cuenta: acabas de mover algo y el botón tiene que
    // estar vivo, aunque la entrada no se haya cerrado todavía.
    puedeDeshacer: pasado.current.length > 0 || pendiente.current !== null,
    puedeRehacer: futuro.current.length > 0,
    pasos: pasado.current.length + (pendiente.current ? 1 : 0),
  };
}
