// =========================================================================
// recetaEnlace.ts
// Enlazar un widget a un ELEMENTO de receta en vez de a un tag del PLC.
//
// QUÉ GUARDA EL WIDGET
//
//   `receta:<recetaId>:<elementoId>`, en el mismo sitio donde guardaría
//   `192.168.1.1|PLC_PRG.bVar16`: en `variableId` o en una variable con
//   nombre. Va por ID y no por nombre: renombrar `var_1` en la receta no
//   suelta el enlace.
//
// DE DÓNDE SALE EL VALOR
//
//   Del TAG que ese elemento tiene puesto en la vista de Recetas. La cadena
//   es: widget -> elemento -> tag -> valor en vivo. Si al elemento se le
//   cambia el tag, el widget sigue al nuevo sin tocar el diseño. Sin tag
//   (`<None>`), el widget pinta «—».
//
// POR QUÉ HAY UNA CACHÉ
//
//   Quien traduce (`idRealDeEnlace`) se llama en CADA dibujo de CADA widget,
//   y la respuesta vive en una base de datos. Así que se responde de memoria
//   y se refresca por detrás. Además se guarda en `localStorage`: si la base
//   no responde al abrir la pantalla, se usa el último tag que se vio en vez
//   de dejar el widget en blanco.
//
//   Se parece a `param:` de los faceplates —otro prefijo que se traduce a un
//   tag justo antes de buscar el valor— y se engancha en los mismos sitios.
// =========================================================================
import { useEffect, useState } from 'react';
import { listarCrud } from './crudApi';
import { getBasePreferida } from './authApi';
import { aElemento, cargarRecetas, getBaseRecetas } from './recetasApi';

export const PREFIJO_RECETA = 'receta:';

/** La caché cambió: quien dibuja valores tiene que volver a traducir. */
export const EVENTO_ENLACES_RECETA = 'hmi:recetas-enlace';
/** La vista de Recetas guardó algo: lo que hay en memoria puede estar viejo. */
export const EVENTO_RECETAS_EDITADAS = 'hmi:recetas-editadas';

const CLAVE_CACHE = 'hmi.recetas.enlaces';
/** Cada cuánto se vuelve a preguntar por los tags de una receta en uso. */
const VIGENCIA_MS = 15000;

/** Lo que se sabe de un elemento enlazado. */
export interface FichaElemento {
  /** `plc_id|tag`, o `''` si el elemento no tiene tag. */
  tag: string;
  nombre: string;
  /** Límites y decimales del elemento, como texto (`''` = sin límite). */
  min: string;
  max: string;
  decimales: string;
}

export interface ElementoDeReceta extends FichaElemento {
  id: number;
}

/** Lo que el widget guarda sobre su receta (campo `receta`). */
export interface CfgRecetaWidget {
  habilitada: boolean;
  id: number | null;
  /** Nombre de la receta al elegirla: se enseña aunque la base no responda. */
  nombre: string;
}

export const idElementoReceta = (recetaId: number, elementoId: number): string =>
  `${PREFIJO_RECETA}${recetaId}:${elementoId}`;

export const esEnlaceReceta = (id: unknown): id is string =>
  typeof id === 'string' && id.startsWith(PREFIJO_RECETA);

export function partirEnlaceReceta(
  id: string
): { recetaId: number; elementoId: number } | null {
  const [r, e] = id.slice(PREFIJO_RECETA.length).split(':');
  const recetaId = Number(r);
  const elementoId = Number(e);
  if (!Number.isInteger(recetaId) || !Number.isInteger(elementoId)) return null;
  return { recetaId, elementoId };
}

/** La configuración de receta de un widget, saneada. */
export function leerCfgReceta(widget: unknown): CfgRecetaWidget {
  const b = (widget as any)?.receta;
  const id = Number(b?.id);
  return {
    habilitada: !!b?.habilitada,
    id: b?.id != null && Number.isInteger(id) && id > 0 ? id : null,
    nombre: typeof b?.nombre === 'string' ? b.nombre : '',
  };
}

/** La base donde viven las recetas: la misma regla que la vista de Recetas. */
export const baseDeRecetas = (): string | undefined =>
  getBaseRecetas() || getBasePreferida() || undefined;

// ─── La caché ────────────────────────────────────────────────────

const fichas = new Map<string, FichaElemento>();
/** recetaId -> cuándo se leyó por última vez (o se intentó). */
const leidas = new Map<number, number>();
const enVuelo = new Set<number>();

(function cargarDeDisco() {
  try {
    const bruto = JSON.parse(localStorage.getItem(CLAVE_CACHE) ?? '{}');
    for (const [k, v] of Object.entries<any>(bruto ?? {})) {
      if (esEnlaceReceta(k) && v && typeof v.tag === 'string') {
        fichas.set(k, {
          tag: v.tag,
          nombre: String(v.nombre ?? ''),
          min: String(v.min ?? ''),
          max: String(v.max ?? ''),
          decimales: String(v.decimales ?? ''),
        });
      }
    }
  } catch {
    /* sin storage o JSON roto: se empieza de cero */
  }
})();

function guardarEnDisco(): void {
  try {
    localStorage.setItem(CLAVE_CACHE, JSON.stringify(Object.fromEntries(fichas)));
  } catch {
    /* sin storage: la caché vive solo en memoria */
  }
}

function avisar(): void {
  try {
    window.dispatchEvent(new CustomEvent(EVENTO_ENLACES_RECETA));
  } catch {
    /* sin `window` (pruebas) */
  }
}

/** Mete en la caché lo que se acaba de leer de una receta. */
function asentar(recetaId: number, elementos: ElementoDeReceta[]): void {
  const prefijo = `${PREFIJO_RECETA}${recetaId}:`;
  const nuevas = new Map<string, FichaElemento>();
  for (const e of elementos) {
    nuevas.set(idElementoReceta(recetaId, e.id), {
      tag: e.tag,
      nombre: e.nombre,
      min: e.min,
      max: e.max,
      decimales: e.decimales,
    });
  }

  let cambio = false;
  // Un elemento borrado de la receta deja de resolver: se quita.
  for (const k of [...fichas.keys()]) {
    if (k.startsWith(prefijo) && !nuevas.has(k)) {
      fichas.delete(k);
      cambio = true;
    }
  }
  for (const [k, f] of nuevas) {
    const previa = fichas.get(k);
    if (
      !previa ||
      previa.tag !== f.tag ||
      previa.nombre !== f.nombre ||
      previa.min !== f.min ||
      previa.max !== f.max ||
      previa.decimales !== f.decimales
    ) {
      fichas.set(k, f);
      cambio = true;
    }
  }
  leidas.set(recetaId, Date.now());
  if (cambio) {
    guardarEnDisco();
    avisar();
  }
}

/** Los elementos de una receta, leídos AHORA. Actualiza la caché de paso. */
export async function leerElementosDeReceta(
  recetaId: number
): Promise<ElementoDeReceta[]> {
  const { filas } = await listarCrud(
    'receta_elementos',
    { filtros: { receta_id: recetaId }, orden: 'orden', descendente: false, limite: 500 },
    baseDeRecetas()
  );
  const elementos = filas.map(aElemento).map((e) => ({
    id: e.id,
    nombre: e.name,
    tag: e.tag.trim(),
    min: e.minValue ?? '',
    max: e.maxValue ?? '',
    decimales: e.decimals ?? '',
  }));
  asentar(recetaId, elementos);
  return elementos;
}

function refrescar(recetaId: number): void {
  if (enVuelo.has(recetaId)) return;
  enVuelo.add(recetaId);
  leerElementosDeReceta(recetaId)
    .catch(() => {
      // La base no responde: se sigue con el último tag conocido y se
      // reintenta pasada la vigencia, no en cada dibujo.
      leidas.set(recetaId, Date.now());
    })
    .finally(() => enVuelo.delete(recetaId));
}

/** Lo que se sabe del elemento enlazado, de memoria. Refresca por detrás. */
export function fichaDeEnlace(id: string): FichaElemento | undefined {
  const p = partirEnlaceReceta(id);
  if (!p) return undefined;
  const cuando = leidas.get(p.recetaId) ?? 0;
  if (Date.now() - cuando > VIGENCIA_MS) refrescar(p.recetaId);
  return fichas.get(id);
}

/**
 * El id con el que hay que BUSCAR el valor.
 *
 * Un `receta:…` se cambia por el tag de su elemento (`''` si no tiene, y
 * entonces no se encuentra nada y el widget pinta «—»). Cualquier otra cosa
 * se devuelve tal cual.
 */
export function idRealDeEnlace(id: string | null | undefined): string {
  if (!id) return '';
  if (!esEnlaceReceta(id)) return id;
  return fichaDeEnlace(id)?.tag ?? '';
}

// La vista de Recetas guardó algo: se da todo por viejo. El siguiente dibujo
// vuelve a preguntar, y `avisar()` es lo que provoca ese dibujo.
try {
  window.addEventListener(EVENTO_RECETAS_EDITADAS, () => {
    leidas.clear();
    avisar();
  });
} catch {
  /* sin `window` (pruebas) */
}

// ─── Para React ──────────────────────────────────────────────────

/** Cambia cuando cambia la caché. Sirve para volver a dibujar. */
export function useRevisionEnlacesReceta(): number {
  const [rev, setRev] = useState(0);
  useEffect(() => {
    const subir = () => setRev((n) => n + 1);
    window.addEventListener(EVENTO_ENLACES_RECETA, subir);
    return () => window.removeEventListener(EVENTO_ENLACES_RECETA, subir);
  }, []);
  return rev;
}

/**
 * Lo que necesita el Inspector: la lista de recetas y los elementos de la
 * elegida. No pide nada mientras «Habilitar receta» esté apagado.
 */
export function useRecetasInspector(habilitada: boolean, recetaId: number | null) {
  const [recetas, setRecetas] = useState<{ id: number; nombre: string }[]>([]);
  const [elementos, setElementos] = useState<ElementoDeReceta[]>([]);
  const [error, setError] = useState('');
  const [cargando, setCargando] = useState(false);
  const [rev, setRev] = useState(0);

  useEffect(() => {
    const subir = () => setRev((n) => n + 1);
    window.addEventListener(EVENTO_RECETAS_EDITADAS, subir);
    return () => window.removeEventListener(EVENTO_RECETAS_EDITADAS, subir);
  }, []);

  useEffect(() => {
    if (!habilitada) {
      setRecetas([]);
      setError('');
      return;
    }
    let vivo = true;
    setCargando(true);
    cargarRecetas(baseDeRecetas())
      .then((lista) => {
        if (!vivo) return;
        setRecetas(
          lista.map((r) => ({
            id: r.id,
            nombre: r.name || r.displayName || `Receta ${r.number}`,
          }))
        );
        setError('');
      })
      .catch((e: any) => {
        if (!vivo) return;
        setRecetas([]);
        setError(
          `No se pudieron leer las recetas: ${e?.message ?? 'la base de datos no responde'}.`
        );
      })
      .finally(() => vivo && setCargando(false));
    return () => {
      vivo = false;
    };
  }, [habilitada, rev]);

  useEffect(() => {
    if (!habilitada || !recetaId) {
      setElementos([]);
      return;
    }
    let vivo = true;
    leerElementosDeReceta(recetaId)
      .then((l) => vivo && setElementos(l))
      .catch(() => vivo && setElementos([]));
    return () => {
      vivo = false;
    };
  }, [habilitada, recetaId, rev]);

  return { recetas, elementos, error, cargando };
}
