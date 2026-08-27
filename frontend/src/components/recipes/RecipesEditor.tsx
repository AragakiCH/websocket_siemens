// =========================================================================
// RecipesEditor.tsx
// Editor de recetas, con la misma estructura que el de TIA Portal.
//
// SON TRES NIVELES, y esa es toda la idea:
//
//   Recipe        el contenedor. Dónde se guarda, cuántos registros caben,
//                 cómo se comunica con el PLC.
//     └ Elements       las COLUMNAS. Los ingredientes: limon, azucar, pisco.
//                      Cada uno apunta a un tag del PLC.
//     └ Data records   las FILAS. Cada una es una fórmula concreta con su
//                      valor para cada ingrediente.
//
// Puesto en tabla, una receta es esta matriz:
//
//                │ limon │ azucar │ pisco
//     ───────────┼───────┼────────┼───────
//     Clásico    │  30   │   20   │  60
//     Doble      │  30   │   20   │  90
//
// DÓNDE VIVE AHORA
//
//   En la base de datos, en las cuatro tablas de recetas. Antes esto se
//   guardaba en `localStorage`: una receta configurada en el PC de planta no
//   existía en el de oficina, y bastaba con que alguien limpiara el navegador
//   para perderla. Ahora cada celda es una fila de verdad, en la MISMA base
//   con la que se entró al sistema.
//
//   Se guarda solo, sin botón: los cambios de texto se agrupan y se mandan
//   tras una pausa (`RETARDO_GUARDADO`), y las altas y bajas van al momento.
//   El indicador de la barra superior dice en qué punto está — un "guardado
//   automático" sin señal visible es indistinguible de uno roto.
//
// LO QUE SIGUE FALTANDO
//
//   Escribir la receta EN EL PLC y leerla de vuelta. Ya hay dónde guardar las
//   tres capas y con qué identificarlas; lo que falta es cargar un
//   `receta_registro` en los tags de sus elementos. Ese paso, el día que
//   exista, necesita identidad y auditoría obligatorias: es la primera vez
//   que el HMI escribiría en una máquina.
//
// LAS CELDAS ROSADAS
//   Son el mismo código visual de TIA: un elemento SIN tag no tiene dónde
//   escribir su valor, así que su columna entera queda bloqueada en la
//   pestaña de registros hasta que se le asigne uno.
// =========================================================================
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { motion, AnimatePresence, useReducedMotion } from 'framer-motion';
import {
  BookOpenIcon,
  PlusIcon,
  Trash2Icon,
  CopyIcon,
  InfoIcon,
  LayersIcon,
  ListIcon,
  AlertTriangleIcon,
  FolderOpenIcon,
  Loader2Icon,
  CheckCircle2Icon,
  AlertCircleIcon,
  RefreshCwIcon,
} from 'lucide-react';
import {
  Th,
  Celda,
  CeldaLectura,
  CeldaSelect,
  CeldaCheck,
  IconoBoton,
  AccionesFila,
} from '../ui/TableBits';
import { apiGet, cargarTags, type TagRemoto } from '../flows/api';
import { SelectorBaseRecetas } from './SelectorBaseRecetas';
import { SelectorTagPlc } from './SelectorTagPlc';
import {
  fetchEstadoAuth,
  getBasePreferida,
  type BaseDatos,
} from '../../services/authApi';
import {
  actualizarCrud,
  borrarCrud,
  crearCrud,
  type RecursoCrud,
} from '../../services/crudApi';
import {
  COMM_TYPES,
  DATA_TYPES,
  LARGO_TIPO,
  RECIPE_TYPES,
  aElemento,
  aRecipe,
  aRegistro,
  cargarDetalle,
  cargarRecetas,
  claveValor,
  crearValor,
  getBaseRecetas,
  setBaseRecetas,
  nuevaRecetaDb,
  nuevoElementoDb,
  nuevoRegistroDb,
  patchElementoADb,
  patchRecetaADb,
  patchRegistroADb,
  valorADb,
  type CommType,
  type ElementDataType,
  type MapaValores,
  type Recipe,
  type RecipeDataRecord,
  type RecipeElement,
  type RecipeType,
} from '../../services/recetasApi';

export { RECIPE_TYPES, COMM_TYPES, DATA_TYPES };
export type {
  CommType,
  ElementDataType,
  Recipe,
  RecipeDataRecord,
  RecipeElement,
  RecipeType,
};

/**
 * Pausa antes de mandar los cambios de texto.
 *
 * Sin esto, escribir "azucar" serían seis PATCH. Con una pausa corta se manda
 * uno solo con el texto final, y sigue sintiéndose inmediato porque la vista
 * ya se actualizó — lo que se agrupa es la escritura, no lo que se ve.
 */
const RETARDO_GUARDADO = 600;

type Pestana = 'elements' | 'records';
type EstadoGuardado = 'limpio' | 'guardando' | 'guardado' | 'error';

/** Fecha corta, con el mismo aire que la columna Version de TIA. */
function fmtVersion(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  })}`;
}

// ═════════════════════════════════════════════════════════════════

export function RecipesEditor() {
  const [recetas, setRecetas] = useState<Recipe[]>([]);
  const [selId, setSelId] = useState<number | null>(null);
  const [pestana, setPestana] = useState<Pestana>('elements');
  const [cargando, setCargando] = useState(true);
  const [cargandoDetalle, setCargandoDetalle] = useState(false);
  const [error, setError] = useState('');
  const [guardado, setGuardado] = useState<EstadoGuardado>('limpio');
  const [ocupado, setOcupado] = useState(false);
  // Las variables de los PLCs, para poder ELEGIR el tag de un elemento en vez
  // de teclearlo de memoria. Vienen de `GET /tags`, que son los tags
  // descubiertos por browse OPC UA — o sea, los que existen de verdad.
  const [tagsPlc, setTagsPlc] = useState<TagRemoto[]>([]);
  const [cargandoTags, setCargandoTags] = useState(true);
  const [hayPlcs, setHayPlcs] = useState(true);
  const sinMovimiento = useReducedMotion();

  // ── En qué base se guardan las recetas ────────────────────────
  //
  // Las cuatro tablas viven en UNA base, y se puede elegir cuál: la local del
  // PC de planta o la del servidor. No es una propiedad de cada receta —una
  // fila ya está guardada en algún sitio, no puede "apuntar" a otra base—
  // sino de la pantalla entera: al cambiarla, todo lo que se lea y se escriba
  // a partir de ese momento va ahí.
  //
  // Se recuerda por navegador y arranca en la del login, que es lo que espera
  // quien no sepa que esto se puede cambiar.
  const [dbRecetas, setDbRecetas] = useState<string>(
    () => getBaseRecetas() || getBasePreferida()
  );
  const [bases, setBases] = useState<BaseDatos[]>([]);
  // En un ref además del estado: las funciones que guardan se crean una vez y
  // leyendo el estado capturarían el valor viejo. Con el ref, un cambio de
  // base no puede mandar una escritura a la base anterior.
  const dbRef = useRef(dbRecetas);
  dbRef.current = dbRecetas;

  // `receta_valores.id` de cada celda ya materializada. En un ref y no en el
  // estado porque cambiarlo no repinta nada: es fontanería.
  const valorIds = useRef<MapaValores>(new Map());
  // Último texto tecleado en cada celda. Sirve para un caso concreto: si
  // alguien sigue escribiendo mientras el POST que crea esa celda está en
  // vuelo, al volver hay que mandar lo ÚLTIMO, no lo que se envió al crearla.
  const ultimoValor = useRef(new Map<string, string>());
  const creandoValor = useRef(new Set<string>());
  const recargarRef = useRef<(id: number) => void>(() => {});
  const selIdRef = useRef<number | null>(null);
  selIdRef.current = selId;

  // ── Guardado diferido ─────────────────────────────────────────
  //
  // Una cola indexada por `recurso:id`: dos cambios seguidos en la misma fila
  // se funden en un PATCH, y filas distintas conviven sin pisarse.
  const cola = useRef(
    new Map<string, { recurso: RecursoCrud; id: number; patch: Record<string, any> }>()
  );
  const temporizador = useRef<number | null>(null);

  const vaciarCola = useCallback(async () => {
    temporizador.current = null;
    const items = [...cola.current.values()];
    cola.current.clear();
    if (items.length === 0) return;

    setGuardado('guardando');
    try {
      for (const it of items) {
        await actualizarCrud(it.recurso, it.id, it.patch, dbRef.current);
      }
      setGuardado('guardado');
      setError('');
    } catch (e: any) {
      setGuardado('error');
      setError(e?.message ?? 'No se pudo guardar el cambio.');
      // La vista ya había pintado el cambio y el servidor lo rechazó —por
      // ejemplo un mínimo mayor que el máximo, que el backend valida porque
      // esos números acaban en una máquina real. Se vuelve a leer, para que
      // lo que se ve sea lo que hay y no un valor que solo existe aquí.
      const id = selIdRef.current;
      if (id) recargarRef.current(id);
    }
  }, []);

  const programar = useCallback(
    (recurso: RecursoCrud, id: number, patch: Record<string, any>) => {
      if (!id || Object.keys(patch).length === 0) return;
      const clave = `${recurso}:${id}`;
      const previo = cola.current.get(clave);
      cola.current.set(clave, {
        recurso,
        id,
        patch: { ...(previo?.patch ?? {}), ...patch },
      });
      setGuardado('guardando');
      if (temporizador.current) window.clearTimeout(temporizador.current);
      temporizador.current = window.setTimeout(() => {
        void vaciarCola();
      }, RETARDO_GUARDADO);
    },
    [vaciarCola]
  );

  // Al salir de la pantalla no puede quedarse nada a medias en la cola.
  useEffect(() => {
    return () => {
      if (temporizador.current) window.clearTimeout(temporizador.current);
      const items = [...cola.current.values()];
      cola.current.clear();
      for (const it of items) {
        void actualizarCrud(it.recurso, it.id, it.patch, dbRef.current).catch(
          () => {}
        );
      }
    };
  }, []);

  /** Envuelve una operación que va al servidor al momento (altas y bajas). */
  const conServidor = useCallback(async (fn: () => Promise<void>) => {
    setOcupado(true);
    try {
      await fn();
      setError('');
      setGuardado('guardado');
    } catch (e: any) {
      setError(e?.message ?? 'La operación falló.');
      setGuardado('error');
    } finally {
      setOcupado(false);
    }
  }, []);

  // ── Carga inicial ─────────────────────────────────────────────
  const recargarTodo = useCallback(async () => {
    setCargando(true);
    try {
      const lista = await cargarRecetas(dbRef.current);
      valorIds.current = new Map();
      ultimoValor.current.clear();
      setRecetas(lista);
      setError('');
    } catch (e: any) {
      setError(e?.message ?? 'No se pudieron cargar las recetas.');
    } finally {
      setCargando(false);
    }
    // `dbRecetas` en las dependencias: cambiar de base tiene que volver a
    // leerlo todo, no quedarse con las recetas de la anterior.
  }, [dbRecetas]);

  useEffect(() => {
    void recargarTodo();
  }, [recargarTodo]);

  /**
   * Los tags de los PLCs.
   *
   * `GET /tags` viene VACÍO si ningún PLC ha conectado todavía: la lista se
   * llena tras un browse OPC UA correcto. Eso no es un error, pero son dos
   * situaciones muy distintas —no hay PLCs dados de alta, o los hay y están
   * apagados— y se arreglan de forma distinta, así que se pregunta también
   * por `GET /plcs` para poder decir cuál de las dos es.
   *
   * Un fallo aquí NO rompe la pantalla: el campo del tag sigue siendo de
   * texto libre, que es justo lo que permite configurar recetas en la
   * oficina con la máquina apagada.
   */
  const recargarTags = useCallback(async () => {
    setCargandoTags(true);
    try {
      const [lista, plcs] = await Promise.all([
        cargarTags(),
        apiGet<{ plcs?: string[] }>('/plcs').catch(() => ({ plcs: [] })),
      ]);
      setTagsPlc(lista);
      setHayPlcs((plcs?.plcs ?? []).length > 0);
    } catch {
      setTagsPlc([]);
    } finally {
      setCargandoTags(false);
    }
  }, []);

  useEffect(() => {
    void recargarTags();
  }, [recargarTags]);

  // El catálogo de bases dadas de alta. Se pide a `/auth/estado`, que es
  // público y NO devuelve host ni credenciales: aquí solo hace falta el
  // identificador y el nombre para poder elegir.
  useEffect(() => {
    let vivo = true;
    fetchEstadoAuth()
      .then((e) => {
        if (!vivo) return;
        const lista = e.bases ?? [];
        setBases(lista);
        // Si la base recordada ya no está dada de alta, no tiene sentido
        // seguir intentando escribir en ella: se cae a la del login.
        if (lista.length && !lista.some((b) => b.db_id === dbRef.current)) {
          const alternativa =
            lista.find((b) => b.db_id === getBasePreferida()) ??
            lista.find((b) => b.por_defecto) ??
            lista[0];
          setBaseRecetas(alternativa.db_id);
          setDbRecetas(alternativa.db_id);
        }
      })
      .catch(() => {
        /* sin catálogo se sigue usando la base actual */
      });
    return () => {
      vivo = false;
    };
  }, []);

  /**
   * Cambiar la base de esta pantalla.
   *
   * Lo primero es vaciar la cola: lo que esté pendiente pertenece a la base
   * ANTERIOR, y mandarlo después del cambio lo escribiría en la nueva, sobre
   * una fila que allí es otra cosa o no existe. Es el único punto de todo
   * esto donde el orden importa de verdad.
   */
  const cambiarBase = useCallback(
    async (nueva: string) => {
      if (!nueva || nueva === dbRef.current) return;
      if (temporizador.current) {
        window.clearTimeout(temporizador.current);
        temporizador.current = null;
      }
      await vaciarCola();

      setBaseRecetas(nueva);
      dbRef.current = nueva;
      valorIds.current = new Map();
      ultimoValor.current.clear();
      creandoValor.current.clear();
      setRecetas([]);
      setSelId(null);
      setError('');
      setGuardado('limpio');
      setDbRecetas(nueva);
    },
    [vaciarCola]
  );

  // Si no hay nada elegido (primera carga, o se borró la seleccionada), cae
  // sobre la primera: el panel de abajo nunca se queda vacío sin motivo.
  useEffect(() => {
    if (recetas.length === 0) {
      setSelId(null);
      return;
    }
    if (!selId || !recetas.some((r) => r.id === selId)) setSelId(recetas[0].id);
  }, [recetas, selId]);

  const receta = recetas.find((r) => r.id === selId) ?? null;

  // ── Detalle de la receta seleccionada ─────────────────────────
  //
  // Los elementos y registros NO se bajan con la lista: con veinte recetas
  // serían decenas de consultas para pintar una tabla de la que solo se mira
  // una fila. Se cargan al seleccionarla, una vez.
  const cargarDetalleDe = useCallback(async (id: number) => {
    setCargandoDetalle(true);
    try {
      const { elements, records, valorIds: mapa } = await cargarDetalle(
        id,
        dbRef.current
      );

      // Se FUNDE con lo que ya había, no se reemplaza. Los ids de registro
      // son únicos en toda la base, así que las claves de dos recetas nunca
      // chocan — y al volver a una receta ya cargada (que no se vuelve a
      // pedir) sus celdas seguirían sin id: el siguiente cambio crearía una
      // segunda fila para la misma celda y una de las dos quedaría
      // invisible. Antes se limpian las de ESTA receta, por si alguna se
      // borró desde otro sitio.
      const propios = new Set(records.map((r) => `${r.id}:`));
      for (const clave of [...valorIds.current.keys()]) {
        if ([...propios].some((p) => clave.startsWith(p))) {
          valorIds.current.delete(clave);
        }
      }
      for (const [k, v] of mapa) valorIds.current.set(k, v);
      ultimoValor.current.clear();
      setRecetas((prev) =>
        prev.map((r) => (r.id === id ? { ...r, elements, records, cargada: true } : r))
      );
      setError('');
    } catch (e: any) {
      setError(e?.message ?? 'No se pudo cargar el detalle de la receta.');
    } finally {
      setCargandoDetalle(false);
    }
  }, []);

  recargarRef.current = (id: number) => {
    void cargarDetalleDe(id);
  };

  useEffect(() => {
    if (selId && receta && !receta.cargada) void cargarDetalleDe(selId);
  }, [selId, receta, cargarDetalleDe]);

  /** Cambia la receta en memoria. No toca el servidor. */
  const parchearLocal = useCallback((id: number, patch: Partial<Recipe>) => {
    setRecetas((prev) =>
      prev.map((r) =>
        r.id === id ? { ...r, ...patch, version: new Date().toISOString() } : r
      )
    );
  }, []);

  // ── Recetas ───────────────────────────────────────────────────
  const editarReceta = useCallback(
    (id: number, patch: Partial<Recipe>) => {
      parchearLocal(id, patch);
      programar('recetas', id, patchRecetaADb(patch));
    },
    [parchearLocal, programar]
  );

  const agregarReceta = useCallback(() => {
    void conServidor(async () => {
      const n =
        recetas.length === 0 ? 1 : Math.max(...recetas.map((r) => r.number)) + 1;
      const { fila } = await crearCrud(
        'recetas',
        nuevaRecetaDb(n),
        dbRef.current
      );
      const nueva = { ...aRecipe(fila), cargada: true };
      setRecetas((prev) => [...prev, nueva]);
      setSelId(nueva.id);
      setPestana('elements');
    });
  }, [recetas, conServidor]);

  const borrarReceta = useCallback(
    (id: number) => {
      void conServidor(async () => {
        // El backend borra en orden lo que cuelga de ella (valores, registros
        // y elementos): ninguna FK del esquema lleva ON DELETE, porque SQL
        // Server no admite dos caminos en cascada hacia la misma tabla.
        await borrarCrud('recetas', id, dbRef.current);
        setRecetas((prev) => prev.filter((r) => r.id !== id));
      });
    },
    [conServidor]
  );

  const duplicarReceta = useCallback(
    (id: number) => {
      void conServidor(async () => {
        const orig = recetas.find((r) => r.id === id);
        if (!orig) return;
        // Duplicar necesita el detalle completo, y puede que esa receta nunca
        // se haya abierto en esta sesión.
        const detalle = orig.cargada
          ? { elements: orig.elements, records: orig.records }
          : await cargarDetalle(id, dbRef.current);

        const n = Math.max(...recetas.map((r) => r.number)) + 1;
        const { fila } = await crearCrud(
          'recetas',
          {
          ...nuevaRecetaDb(n),
          nombre: `${orig.name}_copia`,
          nombre_visible: `${orig.displayName || orig.name}_copia`,
          ruta: orig.path,
          tipo: orig.type,
          max_registros: Number(orig.maxRecords) || 0,
          tipo_comunicacion: orig.commType,
          comprobar_limites: orig.checkLimits ? 1 : 0,
          informacion_herramienta: orig.tooltip,
          },
          dbRef.current
        );
        const nuevaId = Number(fila.id);

        // Ids NUEVOS para elementos y registros: si se copiaran los del
        // original, las dos recetas compartirían filas y editar una movería
        // la otra. Por eso hace falta el mapa viejo -> nuevo antes de los
        // valores, que referencian a los dos.
        const mapaElem = new Map<number, number>();
        for (const [i, e] of detalle.elements.entries()) {
          const { id: nid } = await crearCrud(
            'receta_elementos',
            { ...nuevoElementoDb(nuevaId, i), ...patchElementoADb(e) },
            dbRef.current
          );
          mapaElem.set(e.id, nid);
        }

        for (const [i, rec] of detalle.records.entries()) {
          const { id: nid } = await crearCrud(
            'receta_registros',
            { ...nuevoRegistroDb(nuevaId, i + 1), ...patchRegistroADb(rec) },
            dbRef.current
          );
          for (const [elemId, texto] of Object.entries(rec.values)) {
            const destino = mapaElem.get(Number(elemId));
            if (!destino || texto === '') continue;
            await crearValor(nid, destino, texto, dbRef.current);
          }
        }

        const copia = { ...aRecipe(fila), cargada: false };
        const i = recetas.findIndex((r) => r.id === id);
        setRecetas((prev) => [...prev.slice(0, i + 1), copia, ...prev.slice(i + 1)]);
      });
    },
    [recetas, conServidor]
  );

  // ── Elementos ─────────────────────────────────────────────────
  const agregarElemento = useCallback(() => {
    if (!receta) return;
    const idReceta = receta.id;
    const orden = receta.elements.length;
    void conServidor(async () => {
      const { fila } = await crearCrud(
        'receta_elementos',
        nuevoElementoDb(idReceta, orden),
        dbRef.current
      );
      setRecetas((prev) =>
        prev.map((r) =>
          r.id === idReceta ? { ...r, elements: [...r.elements, aElemento(fila)] } : r
        )
      );
    });
  }, [receta, conServidor]);

  const editarElemento = useCallback(
    (elemId: number, patch: Partial<RecipeElement>) => {
      if (!receta) return;
      const idReceta = receta.id;
      setRecetas((prev) =>
        prev.map((r) =>
          r.id === idReceta
            ? {
                ...r,
                elements: r.elements.map((e) =>
                  e.id === elemId ? { ...e, ...patch } : e
                ),
              }
            : r
        )
      );
      programar('receta_elementos', elemId, patchElementoADb(patch));
    },
    [receta, programar]
  );

  /** Borra el elemento. El backend se lleva sus valores en los registros. */
  const borrarElemento = useCallback(
    (elemId: number) => {
      if (!receta) return;
      const idReceta = receta.id;
      void conServidor(async () => {
        await borrarCrud('receta_elementos', elemId, dbRef.current);
        setRecetas((prev) =>
          prev.map((r) => {
            if (r.id !== idReceta) return r;
            return {
              ...r,
              elements: r.elements.filter((e) => e.id !== elemId),
              records: r.records.map((rec) => {
                const { [String(elemId)]: _, ...resto } = rec.values;
                return { ...rec, values: resto };
              }),
            };
          })
        );
        for (const clave of [...valorIds.current.keys()]) {
          if (clave.endsWith(`:${elemId}`)) valorIds.current.delete(clave);
        }
      });
    },
    [receta, conServidor]
  );

  // ── Registros ─────────────────────────────────────────────────
  const agregarRegistro = useCallback(() => {
    if (!receta) return;
    const idReceta = receta.id;
    const n =
      receta.records.length === 0
        ? 1
        : Math.max(...receta.records.map((r) => r.number)) + 1;
    void conServidor(async () => {
      const { fila } = await crearCrud(
        'receta_registros',
        nuevoRegistroDb(idReceta, n),
        dbRef.current
      );
      // Sin celdas todavía: se crean cuando alguien escriba una. La rejilla
      // enseña mientras tanto el valor por defecto de cada elemento como
      // marcador —igual que TIA— y así `receta_valores` no se llena de filas
      // vacías que nadie pidió.
      setRecetas((prev) =>
        prev.map((r) =>
          r.id === idReceta ? { ...r, records: [...r.records, aRegistro(fila)] } : r
        )
      );
    });
  }, [receta, conServidor]);

  const editarRegistro = useCallback(
    (recId: number, patch: Partial<RecipeDataRecord>) => {
      if (!receta) return;
      const idReceta = receta.id;
      setRecetas((prev) =>
        prev.map((r) =>
          r.id === idReceta
            ? {
                ...r,
                records: r.records.map((rec) =>
                  rec.id === recId ? { ...rec, ...patch } : rec
                ),
              }
            : r
        )
      );
      programar('receta_registros', recId, patchRegistroADb(patch));
    },
    [receta, programar]
  );

  /**
   * Una celda de la rejilla.
   *
   * La primera vez que se escribe en ella hay que CREAR la fila de
   * `receta_valores`; después basta con actualizarla. El `creandoValor` evita
   * el caso feo: teclear rápido lanzaría dos POST y quedarían dos filas para
   * la misma celda, y a partir de ahí una de las dos sería invisible.
   */
  const editarValor = useCallback(
    (recId: number, elemId: number, valor: string) => {
      if (!receta) return;
      const idReceta = receta.id;
      const clave = claveValor(recId, elemId);

      setRecetas((prev) =>
        prev.map((r) =>
          r.id === idReceta
            ? {
                ...r,
                records: r.records.map((rec) =>
                  rec.id === recId
                    ? { ...rec, values: { ...rec.values, [String(elemId)]: valor } }
                    : rec
                ),
              }
            : r
        )
      );
      ultimoValor.current.set(clave, valor);

      const existente = valorIds.current.get(clave);
      if (existente) {
        programar('receta_valores', existente, valorADb(valor));
        return;
      }
      if (creandoValor.current.has(clave)) return;

      creandoValor.current.add(clave);
      setGuardado('guardando');
      void crearValor(recId, elemId, valor, dbRef.current)
        .then((nid) => {
          valorIds.current.set(clave, nid);
          // Puede haber seguido escribiendo mientras iba el POST.
          const ultimo = ultimoValor.current.get(clave);
          if (ultimo !== undefined && ultimo !== valor) {
            programar('receta_valores', nid, valorADb(ultimo));
          } else {
            setGuardado('guardado');
          }
        })
        .catch((e: any) => {
          setGuardado('error');
          setError(e?.message ?? 'No se pudo guardar el valor.');
        })
        .finally(() => {
          creandoValor.current.delete(clave);
        });
    },
    [receta, programar]
  );

  const borrarRegistro = useCallback(
    (recId: number) => {
      if (!receta) return;
      const idReceta = receta.id;
      void conServidor(async () => {
        await borrarCrud('receta_registros', recId, dbRef.current);
        setRecetas((prev) =>
          prev.map((r) =>
            r.id === idReceta
              ? { ...r, records: r.records.filter((rec) => rec.id !== recId) }
              : r
          )
        );
        for (const clave of [...valorIds.current.keys()]) {
          if (clave.startsWith(`${recId}:`)) valorIds.current.delete(clave);
        }
      });
    },
    [receta, conServidor]
  );

  const duplicarRegistro = useCallback(
    (recId: number) => {
      if (!receta) return;
      const idReceta = receta.id;
      const orig = receta.records.find((r) => r.id === recId);
      if (!orig) return;
      const n = Math.max(...receta.records.map((r) => r.number)) + 1;
      void conServidor(async () => {
        const { fila } = await crearCrud(
          'receta_registros',
          {
            ...nuevoRegistroDb(idReceta, n),
            nombre: `${orig.name}_copia`,
            nombre_visible: `${orig.displayName || orig.name}_copia`,
            comentario: orig.comment,
          },
          dbRef.current
        );
        const nuevo = aRegistro(fila);
        for (const [elemId, texto] of Object.entries(orig.values)) {
          if (texto === '') continue;
          const nid = await crearValor(
            nuevo.id,
            Number(elemId),
            texto,
            dbRef.current
          );
          valorIds.current.set(claveValor(nuevo.id, Number(elemId)), nid);
          nuevo.values[elemId] = texto;
        }
        setRecetas((prev) =>
          prev.map((r) => {
            if (r.id !== idReceta) return r;
            const i = r.records.findIndex((x) => x.id === recId);
            return {
              ...r,
              records: [...r.records.slice(0, i + 1), nuevo, ...r.records.slice(i + 1)],
            };
          })
        );
      });
    },
    [receta, conServidor]
  );

  // Elementos incompletos: sin ellos los registros no pueden guardar nada.
  const sinTag = useMemo(
    () => (receta ? receta.elements.filter((e) => !e.tag.trim()).length : 0),
    [receta]
  );

  const filaAnim = sinMovimiento
    ? {}
    : {
        initial: { opacity: 0, y: -6 },
        animate: { opacity: 1, y: 0 },
        exit: { opacity: 0, x: -12 },
        transition: { duration: 0.18 },
      };

  return (
    <div className="flex h-full flex-col overflow-hidden bg-slate-100 dark:bg-navy">

      {/* ══ Barra superior ══════════════════════════════════════ */}
      <div className="flex flex-wrap items-center gap-3 border-b border-slate-200 bg-white px-4 py-2.5 dark:border-navy-slate dark:bg-navy-soft">
        <div className="flex items-center gap-2">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-siemens-50 text-siemens dark:bg-siemens/15">
            <BookOpenIcon className="h-4 w-4" />
          </span>
          <div className="leading-tight">
            <p className="text-sm font-bold text-navy dark:text-slate-100">Recetas</p>
            <p className="text-[11px] text-slate-400">
              {cargando
                ? 'Cargando…'
                : recetas.length === 0
                  ? 'Ninguna configurada'
                  : `${recetas.length} receta${recetas.length === 1 ? '' : 's'}`}
            </p>
          </div>
        </div>

        <SelectorBaseRecetas
          valor={dbRecetas}
          bases={bases}
          deshabilitado={cargando || ocupado}
          onCambiar={(v) => void cambiarBase(v)}
        />

        {receta && (
          <div className="hidden items-center gap-1.5 md:flex">
            <Chip icon={<LayersIcon className="h-3 w-3" />}>
              {receta.elements.length} elemento{receta.elements.length === 1 ? '' : 's'}
            </Chip>
            <Chip icon={<ListIcon className="h-3 w-3" />}>
              {receta.records.length} registro{receta.records.length === 1 ? '' : 's'}
            </Chip>
            {sinTag > 0 && (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-700 ring-1 ring-amber-200 dark:bg-amber-500/15 dark:text-amber-300 dark:ring-amber-500/25">
                <AlertTriangleIcon className="h-3 w-3" />
                {sinTag} sin tag
              </span>
            )}
          </div>
        )}

        {/* Estado del guardado automático. Sin esta señal, "se guarda solo"
            es indistinguible de "no se guarda": el único momento en que se
            nota la diferencia es al recargar, y entonces ya es tarde. */}
        <EstadoAutoguardado estado={guardado} ocupado={ocupado} />

        <button
          onClick={() => {
            void recargarTodo();
            void recargarTags();
          }}
          disabled={cargando || ocupado}
          title="Volver a leer las recetas y los tags de los PLCs"
          className="ml-auto flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 outline-none transition hover:bg-slate-100 hover:text-slate-600 disabled:opacity-40 dark:hover:bg-navy-slate/40"
        >
          <RefreshCwIcon className={`h-4 w-4 ${cargando ? 'animate-spin' : ''}`} />
        </button>

        <button
          onClick={agregarReceta}
          disabled={ocupado}
          className="flex min-h-[34px] items-center gap-1.5 rounded-lg bg-siemens px-3 py-1.5 text-xs font-semibold text-white outline-none transition hover:bg-siemens-600 focus-visible:ring-2 focus-visible:ring-siemens/50 disabled:cursor-not-allowed disabled:opacity-60"
        >
          <PlusIcon className="h-3.5 w-3.5" />
          Agregar receta
        </button>
      </div>

      {/* El error del servidor, tal cual lo mandó. Se queda hasta que algo
          vuelva a salir bien: un fallo de guardado que se borra solo a los
          tres segundos es un fallo que nadie llega a leer. */}
      {error && (
        <div
          role="alert"
          className="flex items-start gap-2 border-b border-state-error/30 bg-state-error/5 px-4 py-2.5 text-xs leading-relaxed text-state-error"
        >
          <AlertCircleIcon className="mt-px h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 break-words">{error}</span>
          <button
            type="button"
            onClick={() => setError('')}
            className="ml-auto shrink-0 rounded px-1.5 font-semibold underline-offset-2 hover:underline"
          >
            Ocultar
          </button>
        </div>
      )}

      {/* ══ Cuerpo: maestro arriba, detalle abajo ═══════════════ */}
      <div className="flex flex-1 flex-col gap-3 overflow-hidden p-3">

        {/* ── Maestro: la lista de recetas ─────────────────────── */}
        <Panel titulo="Recipes" className="min-h-[130px] flex-[4]">
          {cargando ? (
            <Cargando texto="Leyendo las recetas de la base de datos…" />
          ) : recetas.length === 0 ? (
            <Vacio
              icono={<BookOpenIcon className="h-9 w-9" />}
              titulo="Todavía no hay recetas"
              texto="Una receta agrupa los ingredientes (elements) y las fórmulas concretas (data records) que se cargarán al PLC."
              accion="Crear la primera"
              onAccion={agregarReceta}
            />
          ) : (
            <table className="w-full min-w-[1180px] border-collapse">
              <thead className="sticky top-0 z-10">
                <tr className="bg-slate-100 dark:bg-navy">
                  <Th className="w-[190px]">Name</Th>
                  <Th className="w-[170px]">Display name</Th>
                  <Th className="w-[80px]">Number</Th>
                  <Th className="w-[150px]">Version</Th>
                  <Th className="w-[150px]">Path</Th>
                  <Th className="w-[120px]">Type</Th>
                  <Th className="w-[150px]">Max. data records</Th>
                  <Th className="w-[130px]">Communication type</Th>
                  <Th className="w-[100px] text-center">Check limits</Th>
                  <Th>Tooltip</Th>
                  <Th className="w-[76px]" />
                </tr>
              </thead>
              <tbody>
                <AnimatePresence initial={false}>
                  {recetas.map((r) => {
                    const activa = r.id === selId;
                    return (
                      <motion.tr
                        key={r.id}
                        layout={!sinMovimiento}
                        {...filaAnim}
                        onClick={() => setSelId(r.id)}
                        className={`group cursor-pointer border-t border-slate-100 transition-colors dark:border-navy-slate/70 ${
                          activa
                            ? 'bg-siemens-50/70 dark:bg-siemens/10'
                            : 'hover:bg-slate-50/80 dark:hover:bg-navy/40'
                        }`}
                      >
                        <td className="px-1 py-1">
                          <div className="flex items-center gap-1.5">
                            {/* Barra de selección: dice qué receta se está
                                viendo abajo sin robarle sitio a la columna. */}
                            <span
                              aria-hidden="true"
                              className={`h-6 w-1 shrink-0 rounded-full ${
                                activa ? 'bg-siemens' : 'bg-transparent'
                              }`}
                            />
                            <Celda
                              value={r.name}
                              onChange={(v) => editarReceta(r.id, { name: v })}
                              placeholder="Recipe_1"
                              aria-label={`Nombre de la receta ${r.number}`}
                              className="font-medium"
                            />
                          </div>
                        </td>
                        <td className="px-1 py-1">
                          <Celda
                            value={r.displayName}
                            onChange={(v) => editarReceta(r.id, { displayName: v })}
                            aria-label="Nombre visible"
                          />
                        </td>
                        <td className="px-1 py-1">
                          <Celda
                            value={String(r.number)}
                            onChange={(v) =>
                              editarReceta(r.id, { number: parseInt(v, 10) || 0 })
                            }
                            numerica
                            aria-label="Número"
                          />
                        </td>
                        <td className="px-1 py-1">
                          {/* La escribe el sistema en cada cambio. */}
                          <CeldaLectura title="Se actualiza sola al modificar la receta">
                            {fmtVersion(r.version)}
                          </CeldaLectura>
                        </td>
                        <td className="px-1 py-1">
                          <div className="relative">
                            <FolderOpenIcon className="pointer-events-none absolute left-2.5 top-1/2 h-3 w-3 -translate-y-1/2 text-slate-400" />
                            <Celda
                              value={r.path}
                              onChange={(v) => editarReceta(r.id, { path: v })}
                              placeholder="\Flash\Recipes"
                              // Es el campo Path de TIA: la carpeta DEL PANEL
                              // donde quedan los ficheros. No es dónde se
                              // guarda esto — eso se elige arriba, en
                              // "Guardar en".
                              title="Carpeta del panel HMI, como en TIA. La base de datos donde se guardan estas tablas se elige arriba, en «Guardar en»."
                              aria-label="Ruta de almacenamiento en el panel"
                              className="pl-7 font-mono"
                            />
                          </div>
                        </td>
                        <td className="px-1 py-1">
                          <CeldaSelect
                            value={r.type}
                            onChange={(v) =>
                              editarReceta(r.id, { type: v as RecipeType })
                            }
                            opciones={RECIPE_TYPES}
                            aria-label="Tipo de almacenamiento"
                          />
                        </td>
                        <td className="px-1 py-1">
                          <Celda
                            value={r.maxRecords}
                            onChange={(v) =>
                              editarReceta(r.id, {
                                maxRecords: v.replace(/[^0-9]/g, ''),
                              })
                            }
                            placeholder="500"
                            numerica
                            bloqueada={r.type === 'Unlimited'}
                            title={
                              r.type === 'Unlimited'
                                ? 'Sin límite: no aplica con Type = Unlimited'
                                : undefined
                            }
                            aria-label="Máximo de registros"
                          />
                        </td>
                        <td className="px-1 py-1">
                          <CeldaSelect
                            value={r.commType}
                            onChange={(v) =>
                              editarReceta(r.id, { commType: v as CommType })
                            }
                            opciones={COMM_TYPES}
                            aria-label="Tipo de comunicación"
                          />
                        </td>
                        <td className="px-1 py-1">
                          <CeldaCheck
                            checked={r.checkLimits}
                            onChange={(v) => editarReceta(r.id, { checkLimits: v })}
                            aria-label="Validar contra los límites de cada elemento"
                          />
                        </td>
                        <td className="px-1 py-1">
                          <Celda
                            value={r.tooltip}
                            onChange={(v) => editarReceta(r.id, { tooltip: v })}
                            placeholder="Ayuda para el operador"
                            aria-label="Tooltip"
                          />
                        </td>
                        <td className="px-1 py-1">
                          <AccionesFila>
                            <IconoBoton
                              onClick={() => duplicarReceta(r.id)}
                              titulo="Duplicar receta"
                              className="hover:bg-slate-100 hover:text-siemens dark:hover:bg-navy-slate/60"
                            >
                              <CopyIcon className="h-3.5 w-3.5" />
                            </IconoBoton>
                            <IconoBoton
                              onClick={() => borrarReceta(r.id)}
                              titulo="Eliminar receta"
                              className="hover:bg-red-50 hover:text-state-error dark:hover:bg-state-error/10"
                            >
                              <Trash2Icon className="h-3.5 w-3.5" />
                            </IconoBoton>
                          </AccionesFila>
                        </td>
                      </motion.tr>
                    );
                  })}
                </AnimatePresence>
              </tbody>
            </table>
          )}
        </Panel>

        {/* ── Detalle: elements / data records de la seleccionada ─ */}
        {receta && (
          <div className="flex flex-[6] flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-card dark:border-navy-slate dark:bg-navy-soft">

            {/* Pestañas del detalle */}
            <div className="flex flex-wrap items-center gap-2 border-b border-slate-200 px-3 py-2 dark:border-navy-slate">
              <div className="flex rounded-lg border border-slate-200 bg-slate-50 p-0.5 dark:border-navy-slate dark:bg-navy">
                <BotonPestana
                  activa={pestana === 'elements'}
                  onClick={() => setPestana('elements')}
                  icon={<LayersIcon className="h-3.5 w-3.5" />}
                  label="Elements"
                  contador={receta.elements.length}
                />
                <BotonPestana
                  activa={pestana === 'records'}
                  onClick={() => setPestana('records')}
                  icon={<ListIcon className="h-3.5 w-3.5" />}
                  label="Data records"
                  contador={receta.records.length}
                />
              </div>

              <p className="truncate text-[11px] text-slate-400">
                de <b className="font-semibold text-slate-500 dark:text-slate-300">{receta.name}</b>
              </p>

              <button
                onClick={pestana === 'elements' ? agregarElemento : agregarRegistro}
                disabled={pestana === 'records' && receta.elements.length === 0}
                className="ml-auto flex min-h-[30px] items-center gap-1.5 rounded-lg border border-siemens/30 bg-siemens-50 px-2.5 py-1 text-xs font-semibold text-siemens-700 outline-none transition hover:bg-siemens-100 focus-visible:ring-2 focus-visible:ring-siemens/40 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-siemens/10 dark:text-siemens-200 dark:hover:bg-siemens/20"
                title={
                  pestana === 'records' && receta.elements.length === 0
                    ? 'Primero define al menos un elemento'
                    : undefined
                }
              >
                <PlusIcon className="h-3.5 w-3.5" />
                {pestana === 'elements' ? 'Agregar elemento' : 'Agregar registro'}
              </button>
            </div>

            <div className="mp-scroll mp-scroll-dark flex-1 overflow-auto">
              {cargandoDetalle && !receta.cargada ? (
                <Cargando texto="Cargando elementos y registros…" />
              ) : pestana === 'elements' ? (
                receta.elements.length === 0 ? (
                  <Vacio
                    icono={<LayersIcon className="h-9 w-9" />}
                    titulo="Sin elementos"
                    texto="Los elementos son las columnas de la receta: un ingrediente por fila, cada uno apuntando al tag del PLC donde se escribirá su valor."
                    accion="Agregar el primero"
                    onAccion={agregarElemento}
                  />
                ) : (
                  <table className="w-full min-w-[1140px] border-collapse">
                    <thead className="sticky top-0 z-10">
                      <tr className="bg-slate-100 dark:bg-navy">
                        <Th className="w-[170px]">Name</Th>
                        <Th className="w-[160px]">Display name</Th>
                        <Th className="w-[190px]">Tag</Th>
                        <Th className="w-[120px]">Data type</Th>
                        <Th className="w-[90px]">Data length</Th>
                        <Th className="w-[110px]">Default value</Th>
                        <Th className="w-[120px]">Minimum value</Th>
                        <Th className="w-[120px]">Maximum value</Th>
                        <Th className="w-[110px]">Decimal places</Th>
                        <Th>Tooltip</Th>
                        <Th className="w-[76px]" />
                      </tr>
                    </thead>
                    <tbody>
                      <AnimatePresence initial={false}>
                        {receta.elements.map((e) => (
                          <motion.tr
                            key={e.id}
                            layout={!sinMovimiento}
                            {...filaAnim}
                            className="group border-t border-slate-100 transition-colors hover:bg-slate-50/80 dark:border-navy-slate/70 dark:hover:bg-navy/40"
                          >
                            <td className="px-1 py-1">
                              <Celda
                                value={e.name}
                                onChange={(v) => editarElemento(e.id, { name: v })}
                                placeholder="limon"
                                aria-label="Nombre del elemento"
                                className="font-medium"
                              />
                            </td>
                            <td className="px-1 py-1">
                              <Celda
                                value={e.displayName}
                                onChange={(v) => editarElemento(e.id, { displayName: v })}
                                aria-label="Nombre visible"
                              />
                            </td>
                            <td className="px-1 py-1">
                              {/* Texto libre CON ayuda, no un desplegable
                                  cerrado: la lista de tags solo existe tras
                                  un browse OPC UA correcto, y hay que poder
                                  configurar la receta con el PLC apagado. */}
                              <SelectorTagPlc
                                valor={e.tag}
                                tags={tagsPlc}
                                cargando={cargandoTags}
                                sinPlcs={!hayPlcs}
                                onElegir={(tag, tipoTia) =>
                                  editarElemento(e.id, {
                                    tag,
                                    // El tipo del tag solo se copia si el
                                    // elemento no tenía uno: una elección
                                    // hecha a mano manda sobre lo que diga
                                    // el servidor OPC.
                                    ...(tipoTia && !e.dataType
                                      ? { dataType: tipoTia as ElementDataType }
                                      : {}),
                                  })
                                }
                              />
                            </td>
                            <td className="px-1 py-1">
                              <CeldaSelect
                                value={e.dataType}
                                onChange={(v) =>
                                  editarElemento(e.id, {
                                    dataType: v as ElementDataType,
                                  })
                                }
                                opciones={DATA_TYPES}
                                aria-label="Tipo de dato"
                              />
                            </td>
                            <td className="px-1 py-1">
                              {/* Sale del tipo, no se escribe. */}
                              <CeldaLectura
                                title="Bytes que ocupa el tipo elegido"
                                className="text-right tabular-nums"
                              >
                                {LARGO_TIPO[e.dataType] ?? 0}
                              </CeldaLectura>
                            </td>
                            <td className="px-1 py-1">
                              <Celda
                                value={e.defaultValue}
                                onChange={(v) => editarElemento(e.id, { defaultValue: v })}
                                placeholder="0"
                                numerica
                                aria-label="Valor por defecto"
                              />
                            </td>
                            <td className="px-1 py-1">
                              <Celda
                                value={e.minValue}
                                onChange={(v) => editarElemento(e.id, { minValue: v })}
                                placeholder="—"
                                numerica
                                aria-label="Valor mínimo"
                              />
                            </td>
                            <td className="px-1 py-1">
                              <Celda
                                value={e.maxValue}
                                onChange={(v) => editarElemento(e.id, { maxValue: v })}
                                placeholder="—"
                                numerica
                                aria-label="Valor máximo"
                              />
                            </td>
                            <td className="px-1 py-1">
                              <Celda
                                value={e.decimals}
                                onChange={(v) =>
                                  editarElemento(e.id, {
                                    decimals: v.replace(/[^0-9]/g, ''),
                                  })
                                }
                                placeholder="0"
                                numerica
                                aria-label="Decimales"
                              />
                            </td>
                            <td className="px-1 py-1">
                              <Celda
                                value={e.tooltip}
                                onChange={(v) => editarElemento(e.id, { tooltip: v })}
                                placeholder="Ayuda para el operador"
                                aria-label="Tooltip"
                              />
                            </td>
                            <td className="px-1 py-1">
                              <AccionesFila>
                                <IconoBoton
                                  onClick={() => borrarElemento(e.id)}
                                  titulo="Eliminar elemento (y su columna en los registros)"
                                  className="hover:bg-red-50 hover:text-state-error dark:hover:bg-state-error/10"
                                >
                                  <Trash2Icon className="h-3.5 w-3.5" />
                                </IconoBoton>
                              </AccionesFila>
                            </td>
                          </motion.tr>
                        ))}
                      </AnimatePresence>
                    </tbody>
                  </table>
                )
              ) : receta.elements.length === 0 ? (
                <Vacio
                  icono={<LayersIcon className="h-9 w-9" />}
                  titulo="Primero los elementos"
                  texto="Un registro es una fila con un valor por elemento. Sin elementos definidos no hay columnas que llenar."
                  accion="Ir a Elements"
                  onAccion={() => setPestana('elements')}
                />
              ) : receta.records.length === 0 ? (
                <Vacio
                  icono={<ListIcon className="h-9 w-9" />}
                  titulo="Sin registros"
                  texto="Cada registro es una fórmula concreta: el conjunto de valores que se cargará al PLC de una sola vez."
                  accion="Agregar el primero"
                  onAccion={agregarRegistro}
                />
              ) : (
                <table className="w-full border-collapse">
                  <thead className="sticky top-0 z-10">
                    <tr className="bg-slate-100 dark:bg-navy">
                      <Th className="w-[200px]">Name</Th>
                      <Th className="w-[190px]">Display name</Th>
                      <Th className="w-[80px]">Number</Th>
                      {/* Una columna por elemento: la tabla crece con la receta */}
                      {receta.elements.map((e) => (
                        <Th key={e.id} className="w-[130px]">
                          <span className="flex items-center gap-1">
                            {!e.tag.trim() && (
                              <AlertTriangleIcon
                                className="h-3 w-3 shrink-0 text-amber-500"
                                aria-label="Sin tag asignado"
                              />
                            )}
                            <span className="truncate" title={e.name}>
                              {e.name || '—'}
                            </span>
                          </span>
                        </Th>
                      ))}
                      <Th className="w-[170px]">Comment</Th>
                      <Th className="w-[76px]" />
                    </tr>
                  </thead>
                  <tbody>
                    <AnimatePresence initial={false}>
                      {receta.records.map((rec) => (
                        <motion.tr
                          key={rec.id}
                          layout={!sinMovimiento}
                          {...filaAnim}
                          className="group border-t border-slate-100 transition-colors hover:bg-slate-50/80 dark:border-navy-slate/70 dark:hover:bg-navy/40"
                        >
                          <td className="px-1 py-1">
                            <Celda
                              value={rec.name}
                              onChange={(v) => editarRegistro(rec.id, { name: v })}
                              aria-label="Nombre del registro"
                              className="font-medium"
                            />
                          </td>
                          <td className="px-1 py-1">
                            <Celda
                              value={rec.displayName}
                              onChange={(v) => editarRegistro(rec.id, { displayName: v })}
                              aria-label="Nombre visible"
                            />
                          </td>
                          <td className="px-1 py-1">
                            <Celda
                              value={String(rec.number)}
                              onChange={(v) =>
                                editarRegistro(rec.id, {
                                  number: parseInt(v, 10) || 0,
                                })
                              }
                              numerica
                              aria-label="Número"
                            />
                          </td>

                          {/* Un valor por elemento. Rosa = el elemento no
                              tiene tag, así que no hay dónde escribirlo. */}
                          {/* Antes, un elemento sin tag bloqueaba su columna
                              entera —es lo que hace TIA— y no se podía ni
                              anotar el valor. Pero el orden real de trabajo
                              es el contrario: primero se conoce la fórmula y
                              después se cablea a qué tag va cada ingrediente.
                              Así que la celda se escribe siempre y el aviso
                              se queda como aviso: ámbar, con el porqué en el
                              tooltip y el ⚠ en la cabecera de la columna. */}
                          {receta.elements.map((e) => {
                            const sinTagAqui = !e.tag.trim();
                            return (
                              <td key={e.id} className="px-1 py-1">
                                <Celda
                                  value={rec.values[String(e.id)] ?? ''}
                                  onChange={(v) => editarValor(rec.id, e.id, v)}
                                  placeholder={e.defaultValue || '0'}
                                  numerica
                                  className={
                                    sinTagAqui
                                      ? 'ring-1 ring-inset ring-amber-400/40'
                                      : ''
                                  }
                                  title={
                                    sinTagAqui
                                      ? `El valor se guarda, pero «${e.name}» todavía no tiene tag: hasta que se lo asignes en Elements no hay dónde escribirlo en el PLC.`
                                      : undefined
                                  }
                                  aria-label={`${e.name} en ${rec.name}`}
                                />
                              </td>
                            );
                          })}

                          <td className="px-1 py-1">
                            <Celda
                              value={rec.comment}
                              onChange={(v) => editarRegistro(rec.id, { comment: v })}
                              placeholder="Nota"
                              aria-label="Comentario"
                            />
                          </td>
                          <td className="px-1 py-1">
                            <AccionesFila>
                              <IconoBoton
                                onClick={() => duplicarRegistro(rec.id)}
                                titulo="Duplicar registro"
                                className="hover:bg-slate-100 hover:text-siemens dark:hover:bg-navy-slate/60"
                              >
                                <CopyIcon className="h-3.5 w-3.5" />
                              </IconoBoton>
                              <IconoBoton
                                onClick={() => borrarRegistro(rec.id)}
                                titulo="Eliminar registro"
                                className="hover:bg-red-50 hover:text-state-error dark:hover:bg-state-error/10"
                              >
                                <Trash2Icon className="h-3.5 w-3.5" />
                              </IconoBoton>
                            </AccionesFila>
                          </td>
                        </motion.tr>
                      ))}
                    </AnimatePresence>
                  </tbody>
                </table>
              )}
            </div>

            {/* Pie honesto */}
            <div className="flex items-start gap-2 border-t border-slate-100 bg-slate-50/70 px-4 py-2.5 dark:border-navy-slate dark:bg-navy/40">
              <InfoIcon className="mt-px h-3.5 w-3.5 shrink-0 text-slate-400" />
              <p className="min-w-0 text-[11px] leading-relaxed text-slate-400">
                Se guarda solo en la base de datos, en las cuatro tablas de
                recetas. Lo que todavía no existe es «escribir en el PLC» ni
                «leer del PLC»: cargar un registro en los tags de sus
                elementos es lo que hace que una receta sirva de algo.
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════
// Piezas locales
// ═════════════════════════════════════════════════════════════════

function Panel({
  titulo,
  className = '',
  children,
}: {
  titulo: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <section
      className={`flex flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-card dark:border-navy-slate dark:bg-navy-soft ${className}`}
    >
      <p className="border-b border-slate-200 px-4 py-2 text-[10px] font-bold uppercase tracking-wider text-slate-400 dark:border-navy-slate">
        {titulo}
      </p>
      <div className="mp-scroll mp-scroll-dark flex-1 overflow-auto">{children}</div>
    </section>
  );
}

function BotonPestana({
  activa,
  onClick,
  icon,
  label,
  contador,
}: {
  activa: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  contador: number;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={activa}
      onClick={onClick}
      className={`flex items-center gap-1.5 rounded-md px-3 py-1 text-xs font-semibold outline-none transition focus-visible:ring-2 focus-visible:ring-siemens/50 ${
        activa
          ? 'bg-white text-navy shadow-sm dark:bg-navy-slate dark:text-slate-100'
          : 'text-slate-400 hover:text-slate-600 dark:hover:text-slate-300'
      }`}
    >
      {icon}
      {label}
      <span
        className={`rounded-full px-1.5 text-[10px] tabular-nums ${
          activa
            ? 'bg-siemens-50 text-siemens dark:bg-siemens/20 dark:text-siemens-200'
            : 'bg-slate-200/70 text-slate-400 dark:bg-navy-slate/60'
        }`}
      >
        {contador}
      </span>
    </button>
  );
}

/**
 * "Guardando… / Guardado / No se pudo guardar".
 *
 * Tres estados y ninguno más. `limpio` no dice nada a propósito: al abrir la
 * pantalla no se ha guardado nada, y un "guardado" ahí sería mentira.
 */
function EstadoAutoguardado({
  estado,
  ocupado,
}: {
  estado: 'limpio' | 'guardando' | 'guardado' | 'error';
  ocupado: boolean;
}) {
  if (estado === 'limpio' && !ocupado) return null;
  const trabajando = ocupado || estado === 'guardando';
  if (trabajando) {
    return (
      <span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-slate-400">
        <Loader2Icon className="h-3 w-3 animate-spin" />
        Guardando…
      </span>
    );
  }
  if (estado === 'error') {
    return (
      <span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-state-error">
        <AlertCircleIcon className="h-3 w-3" />
        No se pudo guardar
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-state-ok">
      <CheckCircle2Icon className="h-3 w-3" />
      Guardado
    </span>
  );
}

/** Espera con explicación: decir QUÉ se está cargando cuesta lo mismo. */
function Cargando({ texto }: { texto: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-12 text-center">
      <Loader2Icon className="h-6 w-6 animate-spin text-slate-300 dark:text-slate-600" />
      <p className="text-xs text-slate-400">{texto}</p>
    </div>
  );
}

function Chip({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-500 dark:bg-navy-slate/50 dark:text-slate-400">
      {icon}
      {children}
    </span>
  );
}

function Vacio({
  icono,
  titulo,
  texto,
  accion,
  onAccion,
}: {
  icono: React.ReactNode;
  titulo: string;
  texto: string;
  accion: string;
  onAccion: () => void;
}) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-12 text-center">
      <span className="mb-3 text-slate-300 dark:text-slate-600">{icono}</span>
      <p className="text-sm font-semibold text-slate-500 dark:text-slate-300">{titulo}</p>
      <p className="mt-1 max-w-md text-xs leading-relaxed text-slate-400">{texto}</p>
      <button
        onClick={onAccion}
        className="mt-5 flex items-center gap-1.5 rounded-lg bg-siemens px-3.5 py-2 text-xs font-semibold text-white transition hover:bg-siemens-600"
      >
        <PlusIcon className="h-3.5 w-3.5" />
        {accion}
      </button>
    </div>
  );
}
