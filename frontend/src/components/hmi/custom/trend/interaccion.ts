// =========================================================================
// custom/trend/interaccion.ts
// Desplazar y hacer zoom en el eje del tiempo.
//
// QUÉ HACE CADA GESTO, Y POR QUÉ ESE Y NO OTRO
//
//   arrastrar         desplaza en el tiempo (atrás / adelante)
//   rueda             zoom
//   dos dedos         zoom (pellizco)
//   doble clic        vuelve a «en vivo»
//
// uPlot trae de fábrica el zoom por CAJA: arrastras y encuadras un trozo. Se
// desactiva a propósito y el arrastre se usa para desplazar. En un HMI el gesto
// que se hace mil veces es «déjame ver lo de hace un minuto», y en un panel
// táctil de planta arrastrar para moverse es lo que espera cualquiera que haya
// usado un mapa. Encuadrar una caja es lo raro, y para eso están los botones.
//
// EL ZOOM NO TE SACA DEL PRESENTE  ← esto estaba mal antes
// La primera versión centraba el zoom en el medio de la vista SIEMPRE. Al
// acercar, el borde derecho se despegaba del último dato, y como «seguir en
// vivo» significa justamente tener ese borde pegado al presente, el gráfico se
// pausaba solo. Es lo contrario de lo que uno espera: acercar es querer ver
// MEJOR lo que está pasando, no dejar de verlo.
//
// Ahora el ancla depende del estado:
//   siguiendo en vivo -> ancla el BORDE DERECHO. El zoom cambia el ancho de la
//                        ventana y se sigue viendo el presente.
//   pausado           -> ancla el cursor (rueda) o el centro (botones), que es
//                        lo que se espera cuando estás inspeccionando el pasado.
//
// EL SEGUIMIENTO SE ROMPE AL PRIMER GESTO, NO AL PRIMER CLIC
// Tocar el gráfico no debe pausarlo: en un panel táctil se roza sin querer. Se
// pausa cuando el arrastre supera el umbral de unos píxeles, que es la
// diferencia entre apoyar el dedo y moverlo.
//
// Y SE REANUDA SOLO AL LLEGAR AL BORDE DERECHO
// Si desplazas hacia adelante hasta el presente, el widget vuelve a seguir en
// vivo sin que haya que pulsar nada. Es lo contrario del caso clásico de
// quedarse «pausado sin darse cuenta» mirando datos viejos, que en una planta
// es exactamente el fallo que no puede pasar.
// =========================================================================
import type uPlot from 'uplot';

/** Zoom máximo: no tiene sentido bajar de un segundo de ventana. */
export const SPAN_MINIMO = 1;
/** Zoom mínimo: tampoco tiene sentido pasar de un día. */
export const SPAN_MAXIMO = 86400;
/** Píxeles de arrastre a partir de los cuales se considera un gesto. */
const UMBRAL_PX = 4;
/** Margen para considerar que la vista está pegada al último dato. */
const TOLERANCIA_BORDE = 0.25;

export interface OpcionesInteraccion {
  /** Rango total guardado en el búfer, en segundos. `null` si está vacío. */
  limites: () => [number, number] | null;
  /** ¿Está el gráfico pegado al presente ahora mismo? */
  siguiendo: () => boolean;
  /** El usuario tomó el control: hay que dejar de seguir en vivo. */
  alTomarControl: () => void;
  /** Volvió al extremo derecho: se puede seguir en vivo otra vez. */
  alVolverAlBorde: () => void;
}

function acotarSpan(span: number): number {
  return Math.min(SPAN_MAXIMO, Math.max(SPAN_MINIMO, span));
}

/**
 * Encaja un rango dentro de los límites del búfer conservando su duración.
 *
 * Conservar la duración importa: si al llegar al principio se recortara el
 * rango en vez de empujarlo, la ventana se iría encogiendo sola mientras
 * arrastras y el gráfico daría un tirón de zoom que nadie pidió.
 */
export function encajar(
  min: number,
  max: number,
  limites: [number, number] | null
): { min: number; max: number } {
  const span = acotarSpan(max - min);
  if (!limites) return { min, max: min + span };
  const [lo, hi] = limites;

  // La ventana es más ancha que todo lo que hay guardado: se enseña todo,
  // pegado a la DERECHA. Alineado a la izquierda dejaría el dato más reciente
  // en mitad del gráfico y un hueco al lado, que es donde uno mira primero.
  if (span >= hi - lo) return { min: hi - span, max: hi };

  if (min < lo) return { min: lo, max: lo + span };
  if (max > hi) return { min: hi - span, max: hi };
  return { min, max: min + span };
}

/** ¿El borde derecho de la vista está pegado al último dato? */
export function enElBorde(max: number, limites: [number, number] | null): boolean {
  if (!limites) return true;
  return max >= limites[1] - TOLERANCIA_BORDE;
}

function aplicar(
  u: uPlot,
  min: number,
  max: number,
  o: OpcionesInteraccion
): void {
  const lim = o.limites();
  const r = encajar(min, max, lim);
  u.setScale('x', r);
  if (enElBorde(r.max, lim)) o.alVolverAlBorde();
}

// ─── Acciones sueltas, para los botones de la barra ───────────────

/**
 * Zoom por factor (>1 aleja, <1 acerca).
 *
 * Si se está siguiendo en vivo, ancla el borde derecho al último dato: cambia
 * el ancho de la ventana sin salirse del presente. Si está pausado, ancla el
 * centro de lo que se está mirando.
 */
export function zoom(u: uPlot, factor: number, o: OpcionesInteraccion): void {
  const { min, max } = u.scales.x;
  if (min == null || max == null) return;
  const span = acotarSpan((max - min) * factor);

  if (o.siguiendo()) {
    const lim = o.limites();
    const fin = lim ? lim[1] : max;
    aplicar(u, fin - span, fin, o);
    return;
  }
  const centro = (min + max) / 2;
  aplicar(u, centro - span / 2, centro + span / 2, o);
}

/** Desplaza una fracción de la ventana: negativo = atrás, positivo = adelante. */
export function desplazar(
  u: uPlot,
  fraccion: number,
  o: OpcionesInteraccion
): void {
  const { min, max } = u.scales.x;
  if (min == null || max == null) return;
  const d = (max - min) * fraccion;
  o.alTomarControl();
  aplicar(u, min + d, max + d, o);
}

/** Encuadra TODO lo que hay en el búfer. */
export function ajustar(u: uPlot, o: OpcionesInteraccion): void {
  const lim = o.limites();
  if (!lim) return;
  const span = acotarSpan(lim[1] - lim[0]);
  // Ver todo incluye ver el presente, así que esto no pausa: deja el borde
  // derecho en el último dato y el seguimiento se mantiene.
  aplicar(u, lim[1] - span, lim[1], o);
}

// ─── El plugin ────────────────────────────────────────────────────

export function pluginInteraccion(o: OpcionesInteraccion): uPlot.Plugin {
  return {
    hooks: {
      init: (u: uPlot) => {
        const over = u.over;
        // Sin esto el navegador se queda el gesto para hacer scroll de la
        // página y el arrastre nunca llega al gráfico en un panel táctil.
        over.style.touchAction = 'none';
        over.style.cursor = 'grab';

        // ---- Rueda: zoom ------------------------------------------- //
        const alaRueda = (e: WheelEvent) => {
          e.preventDefault();
          const { min, max } = u.scales.x;
          if (min == null || max == null) return;
          const factor = e.deltaY < 0 ? 1 / 1.25 : 1.25;
          const span = acotarSpan((max - min) * factor);

          if (o.siguiendo()) {
            // En vivo el ancla es el presente, no el cursor: acercar para ver
            // mejor lo que pasa AHORA no puede echarte del ahora.
            const lim = o.limites();
            const fin = lim ? lim[1] : max;
            aplicar(u, fin - span, fin, o);
            return;
          }

          // Pausado: se ancla el punto bajo el cursor, que es lo que uno está
          // señalando cuando inspecciona el pasado.
          const rect = over.getBoundingClientRect();
          const valor = u.posToVal(e.clientX - rect.left, 'x');
          const prop = (max - min) > 0 ? (valor - min) / (max - min) : 0.5;
          aplicar(u, valor - span * prop, valor + span * (1 - prop), o);
        };
        over.addEventListener('wheel', alaRueda, { passive: false });

        // ---- Arrastre y pellizco ------------------------------------ //
        const punteros = new Map<number, { x: number }>();
        let inicio: { x: number; min: number; max: number } | null = null;
        let pellizco: { dist: number; min: number; max: number } | null = null;
        let gesto = false;

        const abajo = (e: PointerEvent) => {
          if (e.pointerType === 'mouse' && e.button !== 0) return;
          punteros.set(e.pointerId, { x: e.clientX });
          try {
            over.setPointerCapture(e.pointerId);
          } catch {
            /* algunos navegadores lo rechazan en el primer toque */
          }

          const { min, max } = u.scales.x;
          if (min == null || max == null) return;

          if (punteros.size === 1) {
            inicio = { x: e.clientX, min, max };
            gesto = false;
            over.style.cursor = 'grabbing';
          } else if (punteros.size === 2) {
            const [a, b] = Array.from(punteros.values());
            pellizco = { dist: Math.abs(a.x - b.x) || 1, min, max };
            inicio = null;
          }
        };

        const mover = (e: PointerEvent) => {
          if (!punteros.has(e.pointerId)) return;
          punteros.set(e.pointerId, { x: e.clientX });
          const ancho = over.clientWidth || 1;

          if (pellizco && punteros.size >= 2) {
            const [a, b] = Array.from(punteros.values());
            const dist = Math.abs(a.x - b.x) || 1;
            const span = acotarSpan(
              (pellizco.max - pellizco.min) * (pellizco.dist / dist)
            );
            if (o.siguiendo()) {
              const lim = o.limites();
              const fin = lim ? lim[1] : pellizco.max;
              aplicar(u, fin - span, fin, o);
              return;
            }
            const centro = (pellizco.min + pellizco.max) / 2;
            aplicar(u, centro - span / 2, centro + span / 2, o);
            return;
          }

          if (!inicio) return;
          const dx = e.clientX - inicio.x;
          if (!gesto) {
            if (Math.abs(dx) < UMBRAL_PX) return;
            gesto = true;
            // Desplazarse SÍ es salirse del presente: aquí sí se pausa.
            o.alTomarControl();
          }
          // Arrastrar a la DERECHA trae el pasado, como mover una hoja de
          // papel: el contenido sigue al dedo, no al revés.
          const dt = (dx * (inicio.max - inicio.min)) / ancho;
          aplicar(u, inicio.min - dt, inicio.max - dt, o);
        };

        const arriba = (e: PointerEvent) => {
          punteros.delete(e.pointerId);
          try {
            over.releasePointerCapture(e.pointerId);
          } catch {
            /* el navegador ya lo soltó */
          }
          if (punteros.size < 2) pellizco = null;
          if (punteros.size === 0) {
            inicio = null;
            gesto = false;
            over.style.cursor = 'grab';
          }
        };

        const doble = () => o.alVolverAlBorde();

        over.addEventListener('pointerdown', abajo);
        over.addEventListener('pointermove', mover);
        over.addEventListener('pointerup', arriba);
        over.addEventListener('pointercancel', arriba);
        over.addEventListener('dblclick', doble);

        (u as any).__limpiarInteraccion = () => {
          over.removeEventListener('wheel', alaRueda);
          over.removeEventListener('pointerdown', abajo);
          over.removeEventListener('pointermove', mover);
          over.removeEventListener('pointerup', arriba);
          over.removeEventListener('pointercancel', arriba);
          over.removeEventListener('dblclick', doble);
        };
      },

      destroy: (u: uPlot) => {
        (u as any).__limpiarInteraccion?.();
      },
    },
  };
}
