// =========================================================================
// useRecetasEditor.ts
// TODA la lógica del editor de recetas: estado, cola de guardado y las
// operaciones sobre las cuatro tablas.
//
// POR QUÉ SE SACÓ DE `RecipesEditor.tsx`
// Hacía falta la MISMA pantalla con otra piel: una como pestaña del
// Diseñador y otra como widget del lienzo, con los colores del sinóptico.
// Había dos caminos y uno era malo: copiar el componente —y acabar con dos
// copias de mil quinientas líneas que se separan a la primera corrección—
// o separar lo que piensa de lo que se ve.
//
// Aquí está lo que piensa. No sabe nada de Tailwind, ni de iconos, ni de
// tablas: recibe nada y devuelve datos y acciones. Las dos vistas lo
// consumen igual, así que un fallo del guardado se arregla una vez.
//
// LO QUE NO ESTÁ AQUÍ
// La animación de las filas (`useReducedMotion`, `filaAnim`) se quedó en la
// vista: es presentación, y cada piel puede querer la suya — un widget de
// planta normalmente no anima nada.
//
// EL CONTRATO CON LA VISTA
// Lo que devuelve es exactamente lo que el JSX del editor ya usaba, con los
// mismos nombres. Esa fue la condición del refactor: el JSX no se tocó, así
// que la pantalla de Recetas no puede haber cambiado de comportamiento.
// =========================================================================
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { type EstadoGuardado } from '../components/ui/TableBits';
import { apiGet, cargarTags, type TagRemoto } from '../components/flows/api';
import {
  fetchEstadoAuth,
  getBasePreferida,
  type BaseDatos,
} from '../services/authApi';
import {
  actualizarCrud,
  borrarCrud,
  crearCrud,
  type RecursoCrud,
} from '../services/crudApi';
import {
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
  type MapaValores,
  type Recipe,
  type RecipeDataRecord,
  type RecipeElement,
} from '../services/recetasApi';

/** Las dos pestañas de detalle de una receta. */
export type Pestana = 'elements' | 'records';

/**
 * Pausa antes de mandar los cambios de texto.
 *
 * Sin esto, escribir "azucar" serían seis PATCH. Con una pausa corta se manda
 * uno solo con el texto final, y sigue sintiéndose inmediato porque la vista
 * ya se actualizó — lo que se agrupa es la escritura, no lo que se ve.
 */
const RETARDO_GUARDADO = 600;

export function useRecetasEditor() {
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

  return {
    recetas,
    selId,
    setSelId,
    pestana,
    setPestana,
    cargando,
    cargandoDetalle,
    error,
    setError,
    guardado,
    ocupado,
    tagsPlc,
    cargandoTags,
    hayPlcs,
    dbRecetas,
    bases,
    recargarTodo,
    recargarTags,
    cambiarBase,
    receta,
    editarReceta,
    agregarReceta,
    borrarReceta,
    duplicarReceta,
    agregarElemento,
    editarElemento,
    borrarElemento,
    agregarRegistro,
    editarRegistro,
    editarValor,
    borrarRegistro,
    duplicarRegistro,
    sinTag,
  };
}
