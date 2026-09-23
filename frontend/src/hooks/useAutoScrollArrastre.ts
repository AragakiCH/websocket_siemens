// =========================================================================
// useAutoScrollArrastre.ts
// Desplazar un contenedor mientras se arrastra algo contra sus bordes.
//
// EL PROBLEMA
// El arrastre nativo del navegador NO desplaza contenedores por su cuenta.
// Sin esto, un elemento que está al final de una lista con scroll no se puede
// llevar al principio: no hay forma de llegar, el ratón se sale por el borde
// y el arrastre se cancela a mitad.
//
// Pasa en los dos sitios donde este editor deja reordenar arrastrando:
//
//   * la barra de PESTAÑAS, en horizontal — llevar una pantalla del final a
//     un grupo del principio;
//   * el catálogo de WIDGETS, en vertical — llevar un widget de «Datos»,
//     abajo del todo, a una categoría de arriba.
//
// POR QUÉ UN HOOK Y NO DOS COPIAS
// Empezó viviendo dentro de `PantallasBar`. Cuando hizo falta lo mismo en el
// catálogo había dos opciones: copiarlo cambiando `scrollLeft` por `scrollTop`,
// o compartirlo. Dos copias de la misma lógica acaban divergiendo el día que
// alguien ajuste la velocidad en una y no en la otra, y el que use la que no
// se tocó no entenderá por qué va distinto.
//
// EL BUCLE VA EN `requestAnimationFrame`, NO EN EL `dragover`
// Esto es lo que más se equivoca al implementarlo. El navegador solo dispara
// `dragover` cuando el ratón SE MUEVE. Y dejar el puntero quieto contra el
// borde es justo lo que uno hace mientras espera a que llegue el destino, así
// que atado al evento no se desplazaría nada: habría que menear el ratón para
// que avanzara.
// =========================================================================
import { useCallback, useEffect, useRef } from 'react';

/**
 * Franja del borde que, al arrastrar sobre ella, desplaza el contenedor.
 *
 * 84 px es lo que salió de probarlo: menos y cuesta acertar sin querer, más y
 * la zona muerta del centro se queda pequeña en un panel estrecho.
 */
export const BORDE_AUTOSCROLL = 84;

/** Píxeles por fotograma pegado al canto. A 60 fps son ~1080 px/s. */
export const VELOCIDAD_AUTOSCROLL = 18;

export type EjeAutoScroll = 'x' | 'y';

export interface AutoScrollArrastre<T extends HTMLElement = HTMLDivElement> {
  /** Va en el contenedor QUE TIENE EL SCROLL, no en el que recibe el drop. */
  ref: React.RefObject<T>;
  /** Manejador para `onDragOver`. Mira dónde está el puntero y decide. */
  vigilarBordes: (e: React.DragEvent) => void;
  /** Para el bucle. Va en `onDrop` y en `onDragLeave` del contenedor. */
  detener: () => void;
}

/**
 * Auto-desplazamiento por bordes durante un arrastre.
 *
 * `eje` decide qué se mueve: `'x'` mira `clientX` contra los bordes izquierdo
 * y derecho y toca `scrollLeft`; `'y'` mira `clientY` contra arriba y abajo y
 * toca `scrollTop`.
 */
export function useAutoScrollArrastre<T extends HTMLElement = HTMLDivElement>(
  eje: EjeAutoScroll = 'x'
): AutoScrollArrastre<T> {
  const ref = useRef<T>(null);
  /** Píxeles por fotograma. 0 = parado. */
  const velocidad = useRef(0);
  const marco = useRef<number | null>(null);

  // El eje en un ref: el bucle se crea una vez y no puede quedarse con el
  // valor del primer render si algún día alguien lo cambia en caliente.
  const ejeRef = useRef(eje);
  ejeRef.current = eje;

  const detener = useCallback(() => {
    velocidad.current = 0;
    if (marco.current !== null) {
      cancelAnimationFrame(marco.current);
      marco.current = null;
    }
  }, []);

  const desplazar = useCallback(() => {
    const caja = ref.current;
    if (!caja || velocidad.current === 0) {
      marco.current = null;
      return;
    }
    const vertical = ejeRef.current === 'y';
    const antes = vertical ? caja.scrollTop : caja.scrollLeft;
    if (vertical) caja.scrollTop = antes + velocidad.current;
    else caja.scrollLeft = antes + velocidad.current;

    // Tope alcanzado: se para el bucle en vez de gastar un fotograma por
    // frame empujando contra una pared.
    const ahora = vertical ? caja.scrollTop : caja.scrollLeft;
    if (ahora === antes) {
      marco.current = null;
      velocidad.current = 0;
      return;
    }
    marco.current = requestAnimationFrame(desplazar);
  }, []);

  /**
   * Mira dónde está el puntero y decide si hay que desplazar.
   *
   * La velocidad sube con lo cerca que esté del borde: rozando la franja se
   * mueve despacio —se puede soltar con precisión— y pegado al canto va
   * rápido, para cruzar la lista entera sin esperar.
   */
  const vigilarBordes = useCallback(
    (e: React.DragEvent) => {
      const caja = ref.current;
      if (!caja) return;
      const r = caja.getBoundingClientRect();
      const vertical = ejeRef.current === 'y';
      const antes = vertical ? e.clientY - r.top : e.clientX - r.left;
      const despues = vertical ? r.bottom - e.clientY : r.right - e.clientX;

      let v = 0;
      if (antes < BORDE_AUTOSCROLL) {
        v = -Math.ceil(
          ((BORDE_AUTOSCROLL - antes) / BORDE_AUTOSCROLL) * VELOCIDAD_AUTOSCROLL
        );
      } else if (despues < BORDE_AUTOSCROLL) {
        v = Math.ceil(
          ((BORDE_AUTOSCROLL - despues) / BORDE_AUTOSCROLL) * VELOCIDAD_AUTOSCROLL
        );
      }

      velocidad.current = v;
      if (v !== 0 && marco.current === null) {
        marco.current = requestAnimationFrame(desplazar);
      } else if (v === 0) {
        detener();
      }
    },
    [desplazar, detener]
  );

  // Si el componente se va con un arrastre a medias, el bucle se quedaría
  // corriendo contra un nodo que ya no existe.
  useEffect(() => detener, [detener]);

  return { ref, vigilarBordes, detener };
}
