// =========================================================================
// trend/sesionTrend.ts
// La «sesión» del preview para los Trends: qué se conserva al RECARGAR y qué
// se pierde al CERRAR la ventana.
//
// LA REGLA (pedida así en planta)
//   * Recargar el preview (F5): los datos graficados y las etiquetas siguen.
//   * Cerrar la ventana del preview y volver a lanzarlo: todo empieza nuevo.
//
// CÓMO SE CONSIGUE
//   `sessionStorage` es justo eso: sobrevive a recargar y muere al cerrar la
//   ventana (y una ventana nueva, abierta con `noopener`, nace vacía). Ahí se
//   guarda un id de sesión.
//
//   Los datos de un Trend pueden ser horas de muestras: no caben en los ~5 MB
//   de `sessionStorage`. Van a IndexedDB, con la llave `<sesión>|<trend>`. Al
//   empezar una sesión NUEVA se borra lo de las anteriores, así que en la
//   práctica IndexedDB solo guarda la sesión viva.
//
//   Las etiquetas pesan poco y van directamente en `sessionStorage`.
// =========================================================================

const CLAVE_SESION = 'hmi.trend.sesion';
const BD = 'psicore-trend';
const ALMACEN = 'buffers';

let sesion: string | null = null;

/** El id de la sesión de esta ventana. La primera vez en una ventana nueva, limpia lo viejo. */
export function sesionTrend(): string {
  if (sesion) return sesion;
  let nueva = false;
  try {
    const s = sessionStorage.getItem(CLAVE_SESION);
    if (s) sesion = s;
    else {
      sesion = `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
      sessionStorage.setItem(CLAVE_SESION, sesion);
      nueva = true;
    }
  } catch {
    sesion = `s${Date.now().toString(36)}`;
    nueva = true;
  }
  if (nueva) void borrarOtrasSesiones(sesion);
  limpiarEtiquetasViejas();
  return sesion;
}

// ─── IndexedDB, lo mínimo ─────────────────────────────────────────

let abierta: Promise<IDBDatabase | null> | null = null;

function abrir(): Promise<IDBDatabase | null> {
  if (abierta) return abierta;
  abierta = new Promise((resolver) => {
    try {
      if (typeof indexedDB === 'undefined') return resolver(null);
      const pet = indexedDB.open(BD, 1);
      pet.onupgradeneeded = () => {
        if (!pet.result.objectStoreNames.contains(ALMACEN)) pet.result.createObjectStore(ALMACEN);
      };
      pet.onsuccess = () => resolver(pet.result);
      pet.onerror = () => resolver(null);
    } catch {
      resolver(null);
    }
  });
  return abierta;
}

export interface RegistroBuffer {
  t: number[];
  cols: Record<string, (number | null)[]>;
}

/** Guarda los datos de un Trend de esta sesión. Silencioso si falla. */
export async function guardarBuffer(trend: string, datos: RegistroBuffer): Promise<void> {
  const db = await abrir();
  if (!db) return;
  try {
    const tx = db.transaction(ALMACEN, 'readwrite');
    tx.objectStore(ALMACEN).put(datos, `${sesionTrend()}|${trend}`);
  } catch {
    /* sin espacio o sin permiso: se sigue en memoria */
  }
}

/** Los datos guardados de un Trend en esta sesión, o null. */
export async function leerBuffer(trend: string): Promise<RegistroBuffer | null> {
  const db = await abrir();
  if (!db) return null;
  return new Promise((resolver) => {
    try {
      const pet = db
        .transaction(ALMACEN, 'readonly')
        .objectStore(ALMACEN)
        .get(`${sesionTrend()}|${trend}`);
      pet.onsuccess = () => {
        const r = pet.result as RegistroBuffer | undefined;
        resolver(r && Array.isArray(r.t) && r.cols ? r : null);
      };
      pet.onerror = () => resolver(null);
    } catch {
      resolver(null);
    }
  });
}

/** Sesión nueva: fuera todo lo que no sea de ella. */
async function borrarOtrasSesiones(actual: string): Promise<void> {
  const db = await abrir();
  if (!db) return;
  try {
    const almacen = db.transaction(ALMACEN, 'readwrite').objectStore(ALMACEN);
    const pet = almacen.getAllKeys();
    pet.onsuccess = () => {
      for (const k of pet.result) {
        if (!String(k).startsWith(`${actual}|`)) almacen.delete(k);
      }
    };
  } catch {
    /* nada que limpiar */
  }
}

/**
 * Las etiquetas antes vivían en `localStorage` (para siempre). Ahora son de
 * la sesión: lo que quedó de antes se borra una vez.
 */
function limpiarEtiquetasViejas(): void {
  try {
    const fuera: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith('hmi.trend.etiquetas.')) fuera.push(k);
    }
    fuera.forEach((k) => localStorage.removeItem(k));
  } catch {
    /* sin almacenamiento */
  }
}
