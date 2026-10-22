// =========================================================================
// trend/sesionTrend.ts
// Dónde se guarda, en el navegador, lo que graficó un Trend en vivo.
//
// LA REGLA (pedida así en planta)
//   * Cerrar el preview y volver a abrirlo NO borra nada: al retroceder se ve
//     lo que se grabó antes, con un hueco donde estuvo cerrado.
//   * Lo guardado dura lo que diga «Memoria para retroceder» del Trend, hasta
//     7 días. Lo más viejo se va borrando solo.
//
//   Antes era al revés: todo vivía con un id de SESIÓN en `sessionStorage`,
//   que muere al cerrar la ventana, y al abrir otra se borraba a propósito lo
//   de las anteriores. Ese id ya no forma parte de la llave.
//
// POR BLOQUES DE UNA HORA
//   La primera versión copiaba el búfer ENTERO cada 2 s. Con 30 minutos daba
//   igual; con días son cientos de miles de filas clonadas cada dos segundos,
//   y la pantalla se trabaría. Ahora cada Trend se guarda en trozos de una
//   hora, `[trend, hora]`, y solo se reescriben los que cambiaron (en la
//   práctica, el de la hora actual).
//
// ES DE ESTE NAVEGADOR, EN ESTE PC
//   IndexedDB no sale del equipo. Un visor en otra máquina no ve lo que grabó
//   esta. Para datos compartidos o de semanas está el historizador.
//
// DOS VENTANAS A LA VEZ
//   Las dos graban lo mismo (el mismo WebSocket) y escribirían los mismos
//   bloques. Con `navigator.locks` solo una escribe; la otra graba en memoria
//   y toma el relevo si la primera se cierra.
// =========================================================================

const BD = 'psicore-trend';
const VERSION_BD = 2;
/** v1: un registro por SESIÓN. Ya no se usa; se borra al actualizar. */
const ALMACEN_VIEJO = 'buffers';
/** v2: bloques de una hora, llave `[trend, hora]`. */
const ALMACEN = 'bloques';

/** El máximo que puede pedir «Memoria para retroceder». */
export const RETENCION_MAX_S = 7 * 86_400;
/** Segundos de un bloque. */
export const SEG_BLOQUE = 3600;

/** Columnas de un trozo de búfer: tiempos y una columna por variable. */
export interface RegistroBuffer {
  t: number[];
  cols: Record<string, (number | null)[]>;
}

/** La hora (número de bloque) de un instante en segundos. */
export const horaDe = (t: number): number => Math.floor(t / SEG_BLOQUE);

// ─── IndexedDB, lo mínimo ─────────────────────────────────────────

let abierta: Promise<IDBDatabase | null> | null = null;

function abrir(): Promise<IDBDatabase | null> {
  if (abierta) return abierta;
  abierta = new Promise((resolver) => {
    try {
      if (typeof indexedDB === 'undefined') return resolver(null);
      const pet = indexedDB.open(BD, VERSION_BD);
      pet.onupgradeneeded = () => {
        const db = pet.result;
        // Lo de la v1 era por sesión: no hay forma de saber a qué Trend de
        // hoy corresponde ni cuándo se grabó, así que no se migra.
        if (db.objectStoreNames.contains(ALMACEN_VIEJO)) db.deleteObjectStore(ALMACEN_VIEJO);
        if (!db.objectStoreNames.contains(ALMACEN)) db.createObjectStore(ALMACEN);
      };
      pet.onsuccess = () => {
        const db = pet.result;
        resolver(db);
        void limpiarCaducados(db);
      };
      pet.onerror = () => resolver(null);
      // Otra pestaña con la versión vieja abierta: no se espera para siempre.
      pet.onblocked = () => resolver(null);
    } catch {
      resolver(null);
    }
  });
  return abierta;
}

/** Todos los bloques guardados de un Trend, unidos y en orden. */
export async function leerBloques(trend: string): Promise<RegistroBuffer | null> {
  const db = await abrir();
  if (!db) return null;
  return new Promise((resolver) => {
    try {
      const rango = IDBKeyRange.bound([trend, -Infinity], [trend, Infinity]);
      const pet = db.transaction(ALMACEN, 'readonly').objectStore(ALMACEN).getAll(rango);
      pet.onsuccess = () => {
        const bloques = (pet.result as RegistroBuffer[]).filter(
          (b) => b && Array.isArray(b.t) && b.cols && typeof b.cols === 'object'
        );
        if (!bloques.length) return resolver(null);
        // `getAll` con llave `[trend, hora]` ya viene por hora, pero se ordena
        // por el primer instante para no depender de ello.
        bloques.sort((a, b) => (a.t[0] ?? 0) - (b.t[0] ?? 0));
        const ids = new Set<string>();
        for (const b of bloques) for (const id of Object.keys(b.cols)) ids.add(id);
        const t: number[] = [];
        const cols: Record<string, (number | null)[]> = {};
        for (const id of ids) cols[id] = [];
        let ultimo = -Infinity;
        for (const b of bloques) {
          for (let i = 0; i < b.t.length; i++) {
            // Por si dos bloques se solaparan: el tiempo debe crecer SIEMPRE.
            if (!(b.t[i] > ultimo)) continue;
            ultimo = b.t[i];
            t.push(b.t[i]);
            for (const id of ids) cols[id].push(b.cols[id]?.[i] ?? null);
          }
        }
        resolver({ t, cols });
      };
      pet.onerror = () => resolver(null);
    } catch {
      resolver(null);
    }
  });
}

/** Escribe (o reemplaza) el bloque de una hora. Silencioso si falla. */
export async function guardarBloque(
  trend: string,
  hora: number,
  datos: RegistroBuffer
): Promise<void> {
  const db = await abrir();
  if (!db) return;
  try {
    const almacen = db.transaction(ALMACEN, 'readwrite').objectStore(ALMACEN);
    if (datos.t.length) almacen.put(datos, [trend, hora]);
    else almacen.delete([trend, hora]);
  } catch {
    /* sin espacio o sin permiso: se sigue en memoria */
  }
}

/** Borra los bloques de un Trend anteriores a `hora` (lo que ya caducó). */
export async function borrarBloquesAntes(trend: string, hora: number): Promise<void> {
  const db = await abrir();
  if (!db) return;
  try {
    const rango = IDBKeyRange.bound([trend, -Infinity], [trend, hora], false, true);
    db.transaction(ALMACEN, 'readwrite').objectStore(ALMACEN).delete(rango);
  } catch {
    /* nada que borrar */
  }
}

/**
 * Al abrir: fuera todo lo de más de 7 días, de CUALQUIER Trend.
 *
 * Es lo que limpia a los huérfanos: un Trend borrado, o uno al que se le
 * cambiaron las variables (su llave lleva las variables, así que el viejo
 * nunca más se lee). Nadie los va a podar en vivo, así que se van aquí.
 */
async function limpiarCaducados(db: IDBDatabase): Promise<void> {
  try {
    const limite = horaDe(Date.now() / 1000 - RETENCION_MAX_S) - 1;
    const almacen = db.transaction(ALMACEN, 'readwrite').objectStore(ALMACEN);
    const pet = almacen.getAllKeys();
    pet.onsuccess = () => {
      for (const k of pet.result) {
        const hora = Array.isArray(k) ? Number(k[1]) : NaN;
        if (!Number.isFinite(hora) || hora < limite) almacen.delete(k);
      }
    };
  } catch {
    /* nada que limpiar */
  }
}

/**
 * Pide ser LA ventana que escribe este Trend. `alConseguirlo` se llama cuando
 * lo es —en seguida si no hay otra, o cuando la otra se cierre— y se sigue
 * siéndolo hasta cerrar la ventana. Sin `navigator.locks` (navegador viejo)
 * se escribe directamente.
 */
export function pedirEscritura(trend: string, alConseguirlo: () => void): void {
  try {
    const locks = (navigator as any).locks;
    if (!locks?.request) {
      alConseguirlo();
      return;
    }
    void locks.request(`psicore-trend|${trend}`, () => {
      alConseguirlo();
      // Una promesa que no termina: el candado se suelta al cerrar la ventana.
      return new Promise<void>(() => {});
    });
  } catch {
    alConseguirlo();
  }
}

// ─── Compatibilidad ───────────────────────────────────────────────

/**
 * Las etiquetas antes vivían en `localStorage` del navegador. Ahora están en
 * el servidor: lo que quedó de antes se borra una vez. (Se llama desde
 * `Etiquetas.tsx`; ya no hay «sesión» que crear.)
 */
export function sesionTrend(): void {
  limpiarEtiquetasViejas();
}

let etiquetasLimpias = false;
function limpiarEtiquetasViejas(): void {
  if (etiquetasLimpias) return;
  etiquetasLimpias = true;
  try {
    const fuera: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith('hmi.trend.etiquetas.')) fuera.push(k);
    }
    fuera.forEach((k) => localStorage.removeItem(k));
    // Y el id de sesión de la versión anterior, que ya no sirve.
    sessionStorage.removeItem('hmi.trend.sesion');
  } catch {
    /* sin almacenamiento */
  }
}
