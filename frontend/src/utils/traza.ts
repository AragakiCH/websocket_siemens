// =========================================================================
// utils/traza.ts
// Marcas de tiempo del runtime, mandadas al servidor en lotes.
//
// PARA QUÉ
// «La pantalla tarda» no se puede arreglar sin saber en QUÉ tarda: ¿en
// pedirla al servidor?, ¿en analizar el JSON?, ¿en montar los widgets?,
// ¿en que el navegador los pinte?, ¿en algo que bloquea el hilo mientras
// tanto? Cada punto crítico deja aquí una marca con `performance.now()`, y
// el backend las guarda en `traza_rendimiento.log` (carpeta de datos). Se
// leen con cualquier editor, o con `tools/ver_traza.py`.
//
// COSTE
// Despreciable: una `push` a un array por marca y un `sendBeacon` cada
// segundo y medio si hay algo que mandar. `sendBeacon` no bloquea ni espera
// respuesta, y el servidor solo acepta lotes de la propia máquina.
//
// Se apaga con `localStorage.setItem('psi.traza', '0')` y se vuelve a
// encender quitando esa clave.
// =========================================================================

interface Marca {
  t: number;
  evento: string;
  [k: string]: unknown;
}

const cola: Marca[] = [];
let temporizador = 0;
let activa = true;

try {
  activa = localStorage.getItem('psi.traza') !== '0';
} catch {
  /* sin storage: activa */
}

function enviar(): void {
  temporizador = 0;
  for (const [evento, c] of contadores) {
    cola.push({ t: Math.round(performance.now()), evento, n: c.n, dato: c.ultimo });
  }
  contadores.clear();
  if (cola.length === 0) return;
  const lote = cola.splice(0, cola.length);
  const cuerpo = JSON.stringify({ pagina: location.pathname, lote });
  try {
    if (typeof navigator.sendBeacon === 'function') {
      navigator.sendBeacon('/sistema/traza', new Blob([cuerpo], { type: 'application/json' }));
    } else {
      void fetch('/sistema/traza', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: cuerpo,
        keepalive: true,
      }).catch(() => undefined);
    }
  } catch {
    /* sin red: se pierde el lote, no pasa nada */
  }
}

function programar(): void {
  if (temporizador) return;
  temporizador = window.setTimeout(enviar, 1500);
}

/** Deja una marca. `datos` va tal cual al fichero: nombres cortos. */
export function traza(evento: string, datos: Record<string, unknown> = {}): void {
  if (!activa) return;
  cola.push({ t: Math.round(performance.now()), evento, ...datos });
  programar();
}

// Contadores: para lo que pasa muchas veces por segundo (las lecturas del
// PLC). Una marca por lectura sería ruido; un recuento por lote, no.
const contadores = new Map<string, { n: number; ultimo: unknown }>();

/** Suma uno a un contador; se vuelca con el siguiente lote. */
export function contar(evento: string, dato?: unknown): void {
  if (!activa) return;
  const c = contadores.get(evento);
  if (c) {
    c.n += 1;
    c.ultimo = dato;
  } else {
    contadores.set(evento, { n: 1, ultimo: dato });
  }
  programar();
}

/** `performance.now()` redondeado, para medir tramos a mano. */
export function ahora(): number {
  return performance.now();
}

/**
 * Marca cuando el navegador haya PINTADO lo que se acaba de montar: dos
 * fotogramas después del commit. Es la medida que importa al operador.
 */
export function trazaTrasPintar(evento: string, datos: Record<string, unknown> = {}): void {
  if (!activa) return;
  const inicio = performance.now();
  requestAnimationFrame(() =>
    requestAnimationFrame(() =>
      traza(evento, { ...datos, hasta_pintar_ms: Math.round(performance.now() - inicio) })
    )
  );
}

// Tareas largas: cualquier tramo de más de 50 ms con el hilo principal
// ocupado. Son los «se queda pensando» que el operador nota como tirones.
if (activa && typeof PerformanceObserver !== 'undefined') {
  try {
    new PerformanceObserver((lista) => {
      for (const e of lista.getEntries()) {
        traza('bloqueo', { ms: Math.round(e.duration) });
      }
    }).observe({ type: 'longtask', buffered: false } as PerformanceObserverInit);
  } catch {
    /* navegador sin longtask: sin esta marca */
  }
}

// Lo que quede en cola al cerrar la pestaña.
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', enviar);
}
