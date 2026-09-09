// =========================================================================
// AlarmsEditor.tsx
// Tabla de configuración de alarmas, al estilo del editor de TIA Portal.
//
// DÓNDE VIVE AHORA
//
//   En la base de datos, en `alarmas_def`, a través del CRUD genérico
//   (`/crud/alarmas_def`). Antes se guardaba en `localStorage`: una alarma
//   configurada en el PC de planta no existía en el de oficina, y bastaba
//   con que alguien limpiara el navegador para perderla.
//
//   Se guarda solo, sin botón: los cambios de texto se agrupan y se mandan
//   tras una pausa (`RETARDO_GUARDADO`), y las altas y bajas van al momento.
//   El indicador de la barra superior dice en qué punto está — un "guardado
//   automático" sin señal visible es indistinguible de uno roto.
//
//   La base se elige arriba, igual que en Recetas. No es una propiedad de
//   cada alarma —una fila ya está guardada en algún sitio, no puede
//   "apuntar" a otra base— sino de la pantalla entera.
//
// ⚠️ LO QUE SIGUE FALTANDO: EL MOTOR
//
//   Esto es la CONFIGURACIÓN, no los eventos. Nada evalúa todavía los
//   `Trigger tag`: no hay quien lea el valor del PLC, lo compare y escriba
//   una fila en `alarmas`. Lo que sí hay ya es dónde guardar las reglas, con
//   qué identificarlas y contra qué compararlas el día que ese motor exista.
//
// LAS CINCO COLUMNAS
//
//   Son las de la tabla "Discrete alarms" de TIA y se dejan con su nombre en
//   inglés a propósito: es el vocabulario con el que se trabaja en el
//   proyecto y así se reconocen al lado del editor de Siemens.
//
//     ID           el de la base de datos, no editable
//     Name         nombre corto de la alarma          -> nombre
//     Alarm text   el mensaje que ve el operador      -> texto
//     Alarm class  categoría (desplegable)            -> clase
//     Trigger tag  variable que la dispara            -> tag
//
//   La tabla tiene ocho columnas más (`comparador`, `valor_limite`,
//   `banda_muerta`, `tag_reconocimiento`…) que esta vista no edita: se crean
//   en NULL. El porqué, y las tres excepciones NOT NULL, están en
//   `services/alarmasApi.ts`.
// =========================================================================
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { motion, AnimatePresence, useReducedMotion } from 'framer-motion';
import {
  BellIcon,
  PlusIcon,
  Trash2Icon,
  SearchIcon,
  CopyIcon,
  AlertOctagonIcon,
  AlertCircleIcon,
  AlertTriangleIcon,
  WrenchIcon,
  InfoIcon,
  BellOffIcon,
  ChevronDownIcon,
  RefreshCwIcon,
  UploadCloudIcon,
  UserIcon,
  UserXIcon,
} from 'lucide-react';
import {
  Th,
  Celda,
  IconoBoton,
  AccionesFila,
  Cargando,
  EstadoAutoguardado,
  type EstadoGuardado,
} from '../ui/TableBits';
import { SelectorBaseDatos } from '../ui/SelectorBaseDatos';
import { useAppStore } from '../../context/AppStore';
import {
  fetchEstadoAuth,
  getBasePreferida,
  type BaseDatos,
} from '../../services/authApi';
import { actualizarCrud, borrarCrud } from '../../services/crudApi';
import {
  ALARM_CLASS_IDS,
  CLASE_DEFECTO,
  COMPARADORES,
  ETIQUETA_COMPARADOR,
  cargarAlarmas,
  crearAlarma,
  esAnalogico,
  getBaseAlarmas,
  leerAlarmasLocales,
  nuevaAlarmaDb,
  olvidarAlarmasLocales,
  patchAlarmaADb,
  recargarMotor,
  setBaseAlarmas,
  siguienteNombre,
  type Alarm,
  type AlarmClassId,
  type Comparador,
} from '../../services/alarmasApi';
// El MISMO selector que usa el editor de recetas. No se duplica: el formato
// `plc|tag`, el filtrado por PLC y el "último valor recibido" ya están
// resueltos ahí, y dos copias se separarían a la primera corrección.
import { SelectorTagPlc } from '../recipes/SelectorTagPlc';
import { apiGet, cargarTags, type TagRemoto } from '../flows/api';

export type { Alarm, AlarmClassId };

/**
 * Pausa antes de mandar los cambios de texto.
 *
 * Sin esto, escribir "Temperatura alta" serían dieciséis PATCH. Con una
 * pausa corta se manda uno solo con el texto final, y sigue sintiéndose
 * inmediato porque la vista ya se actualizó — lo que se agrupa es la
 * escritura, no lo que se ve.
 */
const RETARDO_GUARDADO = 600;

// ─── Clases de alarma ────────────────────────────────────────────
//
// Los identificadores viven en `alarmasApi.ts` porque son datos que van a la
// base y que el backend valida. Acá queda solo cómo se ven: el icono, el
// color y el texto de ejemplo.
//
// Ordenadas de más grave a menos, que es como conviene leerlas en el
// desplegable. `ejemplo` es el texto con el que arranca una alarma nueva:
// `texto` es obligatorio en la base, así que la fila no puede nacer vacía —
// y es más útil arrancar de algo que de una fila en blanco.

interface AlarmClassDef {
  id: AlarmClassId;
  icon: typeof BellIcon;
  ejemplo: string;
  /** Punto de color de la fila. */
  punto: string;
  /** Insignia: fondo + texto, en claro y oscuro. */
  insignia: string;
}

export const ALARM_CLASSES: AlarmClassDef[] = [
  {
    id: 'Critical',
    icon: AlertOctagonIcon,
    ejemplo: 'Parada de emergencia activada',
    punto: 'bg-rose-600',
    insignia:
      'bg-rose-100 text-rose-700 ring-rose-200 dark:bg-rose-500/15 dark:text-rose-300 dark:ring-rose-500/25',
  },
  {
    id: 'Error',
    icon: AlertCircleIcon,
    ejemplo: 'Fallo de comunicación con PLC',
    punto: 'bg-red-500',
    insignia:
      'bg-red-100 text-red-700 ring-red-200 dark:bg-red-500/15 dark:text-red-300 dark:ring-red-500/25',
  },
  {
    id: 'Warning',
    icon: AlertTriangleIcon,
    ejemplo: 'Temperatura superior a 80 °C',
    punto: 'bg-amber-500',
    insignia:
      'bg-amber-100 text-amber-700 ring-amber-200 dark:bg-amber-500/15 dark:text-amber-300 dark:ring-amber-500/25',
  },
  {
    id: 'Maintenance',
    icon: WrenchIcon,
    ejemplo: 'Se requiere mantenimiento preventivo',
    punto: 'bg-violet-500',
    insignia:
      'bg-violet-100 text-violet-700 ring-violet-200 dark:bg-violet-500/15 dark:text-violet-300 dark:ring-violet-500/25',
  },
  {
    id: 'Information',
    icon: InfoIcon,
    ejemplo: 'Sistema iniciado',
    punto: 'bg-sky-500',
    insignia:
      'bg-sky-100 text-sky-700 ring-sky-200 dark:bg-sky-500/15 dark:text-sky-300 dark:ring-sky-500/25',
  },
];

const claseDe = (id: AlarmClassId): AlarmClassDef =>
  ALARM_CLASSES.find((c) => c.id === id) ?? ALARM_CLASSES[1];

// ═════════════════════════════════════════════════════════════════

export function AlarmsEditor() {
  const [alarmas, setAlarmas] = useState<Alarm[]>([]);
  const [filtro, setFiltro] = useState('');
  const [recienCreada, setRecienCreada] = useState<number | null>(null);
  const [cargando, setCargando] = useState(true);
  const [ocupado, setOcupado] = useState(false);
  const [error, setError] = useState('');
  const [guardado, setGuardado] = useState<EstadoGuardado>('limpio');
  const sinMovimiento = useReducedMotion();
  const cuerpoRef = useRef<HTMLDivElement>(null);

  // Quién firma lo que se escriba. El id NO se manda: lo pone el servidor a
  // partir del token (`CrudManager._sellar_autor`), y se ignora si viaja en
  // el cuerpo. Esto es solo para poder DECIRLO — sin sesión las filas se
  // guardan con `usuario_id` a NULL, y descubrir eso dentro de un mes,
  // cuando haga falta saber quién cambió un umbral, es demasiado tarde.
  const { sesion, authRequerida } = useAppStore();

  // Lo que quedó guardado en este navegador de la versión anterior. No se
  // sube solo: duplicaría lo que ya esté en la base.
  const [locales, setLocales] = useState<Alarm[]>(() => leerAlarmasLocales());

  // ── Las variables de los PLCs, para el Trigger tag ────────────
  //
  // Son las descubiertas por browse OPC UA: las que existen DE VERDAD, en
  // todos los PLCs conectados a la vez. Viene VACÍO si ninguno ha conectado
  // todavía, y eso no es un error — el selector deja escribir el tag a mano,
  // que es como se configura una alarma desde la oficina con la máquina
  // apagada.
  const [tagsPlc, setTagsPlc] = useState<TagRemoto[]>([]);
  const [cargandoTags, setCargandoTags] = useState(true);
  const [hayPlcs, setHayPlcs] = useState(true);

  useEffect(() => {
    let vivo = true;
    void (async () => {
      try {
        const [lista, plcs] = await Promise.all([
          cargarTags(),
          apiGet<{ plcs?: string[] }>('/plcs').catch(() => ({ plcs: [] })),
        ]);
        if (!vivo) return;
        setTagsPlc(lista);
        // Distinguir "no hay PLCs dados de alta" de "hay, pero apagados"
        // importa: uno se arregla en el Diseñador y el otro encendiendo la
        // máquina, y el mensaje del selector cambia según cuál sea.
        setHayPlcs((plcs?.plcs ?? []).length > 0);
      } catch {
        if (vivo) setTagsPlc([]);
      } finally {
        if (vivo) setCargandoTags(false);
      }
    })();
    return () => {
      vivo = false;
    };
  }, []);

  // ── En qué base se guardan las alarmas ────────────────────────
  const [dbAlarmas, setDbAlarmas] = useState<string>(
    () => getBaseAlarmas() || getBasePreferida()
  );
  const [bases, setBases] = useState<BaseDatos[]>([]);
  // En un ref además del estado: las funciones que guardan se crean una vez
  // y leyendo el estado capturarían el valor viejo. Con el ref, un cambio de
  // base no puede mandar una escritura a la base anterior.
  const dbRef = useRef(dbAlarmas);
  dbRef.current = dbAlarmas;

  // ── Guardado diferido ─────────────────────────────────────────
  //
  // Una cola indexada por id: dos cambios seguidos en la misma fila se
  // funden en un PATCH, y filas distintas conviven sin pisarse.
  const cola = useRef(new Map<number, Record<string, any>>());
  const temporizador = useRef<number | null>(null);
  const recargarRef = useRef<() => void>(() => {});

  const vaciarCola = useCallback(async () => {
    temporizador.current = null;
    const items = [...cola.current.entries()];
    cola.current.clear();
    if (items.length === 0) return;

    setGuardado('guardando');
    try {
      for (const [id, patch] of items) {
        await actualizarCrud('alarmas_def', id, patch, dbRef.current);
      }
      setGuardado('guardado');
      setError('');
    } catch (e: any) {
      setGuardado('error');
      setError(e?.message ?? 'No se pudo guardar el cambio.');
      // La vista ya había pintado el cambio y el servidor lo rechazó. Se
      // vuelve a leer, para que lo que se ve sea lo que hay y no un valor
      // que solo existe en esta pantalla.
      recargarRef.current();
    }
  }, []);

  const programar = useCallback(
    (id: number, patch: Record<string, any>) => {
      if (!id || Object.keys(patch).length === 0) return;
      cola.current.set(id, { ...(cola.current.get(id) ?? {}), ...patch });
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
      const items = [...cola.current.entries()];
      cola.current.clear();
      for (const [id, patch] of items) {
        void actualizarCrud('alarmas_def', id, patch, dbRef.current).catch(
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

  // ── Carga ─────────────────────────────────────────────────────
  const recargarTodo = useCallback(async () => {
    setCargando(true);
    try {
      setAlarmas(await cargarAlarmas(dbRef.current));
      setError('');
    } catch (e: any) {
      setError(e?.message ?? 'No se pudieron cargar las alarmas.');
    } finally {
      setCargando(false);
    }
    // `dbAlarmas` en las dependencias: cambiar de base tiene que volver a
    // leerlo todo, no quedarse con las alarmas de la anterior.
  }, [dbAlarmas]);

  useEffect(() => {
    void recargarTodo();
  }, [recargarTodo]);

  recargarRef.current = () => {
    void recargarTodo();
  };

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
          setBaseAlarmas(alternativa.db_id);
          setDbAlarmas(alternativa.db_id);
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

      setBaseAlarmas(nueva);
      dbRef.current = nueva;
      setAlarmas([]);
      setFiltro('');
      setError('');
      setGuardado('limpio');
      setDbAlarmas(nueva);
    },
    [vaciarCola]
  );

  // ── Alta ──────────────────────────────────────────────────────
  const agregar = useCallback(() => {
    void conServidor(async () => {
      const clase = claseDe(CLASE_DEFECTO);
      const nueva = await crearAlarma(
        nuevaAlarmaDb(siguienteNombre(alarmas), clase.ejemplo, clase.id),
        dbRef.current
      );
      setAlarmas((prev) => [...prev, nueva]);
      setRecienCreada(nueva.id);
      setFiltro('');
      // Deja ver la fila nueva sin que el usuario tenga que buscarla.
      requestAnimationFrame(() => {
        cuerpoRef.current?.scrollTo({
          top: cuerpoRef.current.scrollHeight,
          behavior: sinMovimiento ? 'auto' : 'smooth',
        });
      });
    });
  }, [alarmas, conServidor, sinMovimiento]);

  // ── Edición ───────────────────────────────────────────────────
  const editar = useCallback(
    (id: number, patch: Partial<Alarm>) => {
      setAlarmas((prev) => prev.map((a) => (a.id === id ? { ...a, ...patch } : a)));
      programar(id, patchAlarmaADb(patch));
      // El motor tiene las reglas en memoria: sin este aviso, el cambio no se
      // aplicaría hasta su barrido de seguridad (un minuto). Va sin `await`
      // y traga sus propios errores — guardar la alarma ya funcionó, y esto
      // solo adelanta cuándo empieza a vigilarse.
      void recargarMotor();
    },
    [programar]
  );

  // ── Baja ──────────────────────────────────────────────────────
  //
  // Borra la REGLA, no los eventos que ya provocó: el backend pone a NULL
  // `alarmas.alarma_def_id` antes de borrarla, así que el historial de lo
  // que pasó sigue estando. Requiere rol Administradores.
  const borrar = useCallback(
    (id: number) => {
      void conServidor(async () => {
        await borrarCrud('alarmas_def', id, dbRef.current);
        setAlarmas((prev) => prev.filter((a) => a.id !== id));
      });
    },
    [conServidor]
  );

  // ── Duplicar ──────────────────────────────────────────────────
  const duplicar = useCallback(
    (id: number) => {
      const orig = alarmas.find((a) => a.id === id);
      if (!orig) return;
      void conServidor(async () => {
        const copia = await crearAlarma(
          {
            ...nuevaAlarmaDb(
              `${orig.name}_copia`,
              orig.text || claseDe(orig.alarmClass).ejemplo,
              orig.alarmClass,
              orig.triggerTag
            ),
            // La CONDICIÓN también se copia. Duplicar existe justamente para
            // hacer la alarma de al lado —el mismo umbral en otro tag—, y una
            // copia que perdiera el límite volvería a arrancar como alarma de
            // bit sin avisar: parecería configurada y no saltaría nunca.
            ...patchAlarmaADb({
              comparador: orig.comparador,
              bitDisparo: orig.bitDisparo,
              limite: orig.limite,
              bandaMuerta: orig.bandaMuerta,
              activo: orig.activo,
            }),
          },
          dbRef.current
        );
        void recargarMotor();
        // Justo debajo de la original, no al final: es donde el ojo la
        // busca después de pulsar "duplicar".
        setAlarmas((prev) => {
          const i = prev.findIndex((a) => a.id === id);
          if (i < 0) return [...prev, copia];
          return [...prev.slice(0, i + 1), copia, ...prev.slice(i + 1)];
        });
        setRecienCreada(copia.id);
      });
    },
    [alarmas, conServidor]
  );

  // ── Traer lo que había en este navegador ──────────────────────
  const importarLocales = useCallback(() => {
    void conServidor(async () => {
      const creadas: Alarm[] = [];
      for (const a of locales) {
        creadas.push(
          await crearAlarma(
            nuevaAlarmaDb(
              a.name.trim() || 'Alarma',
              a.text.trim() || claseDe(a.alarmClass).ejemplo,
              a.alarmClass,
              a.triggerTag
            ),
            dbRef.current
          )
        );
      }
      // Solo se olvidan una vez que TODAS están arriba: si el servidor
      // falla a la mitad, lo que quedó en el navegador sigue ahí y se puede
      // reintentar. Se duplicarán las ya subidas, y borrar un duplicado es
      // reparable; perder la lista, no.
      olvidarAlarmasLocales();
      setLocales([]);
      setAlarmas((prev) => [...prev, ...creadas]);
    });
  }, [conServidor, locales]);

  const descartarLocales = useCallback(() => {
    olvidarAlarmasLocales();
    setLocales([]);
  }, []);

  // ── Filtro ────────────────────────────────────────────────────
  const visibles = useMemo(() => {
    const q = filtro.trim().toLowerCase();
    if (!q) return alarmas;
    return alarmas.filter((a) =>
      `${a.id} ${a.name} ${a.text} ${a.alarmClass} ${a.triggerTag}`
        .toLowerCase()
        .includes(q)
    );
  }, [alarmas, filtro]);

  // Cuántas están configuradas pero NO se evalúan.
  //
  // Es el fallo silencioso de esta pantalla: una alarma sin Trigger tag se ve
  // idéntica a una que funciona —tiene nombre, texto y clase— y el motor la
  // ignora por completo. Sin este contador, la forma de enterarse es que un
  // día no salte.
  const sinTag = useMemo(
    () => alarmas.filter((a) => a.activo && !a.triggerTag.trim()).length,
    [alarmas]
  );

  // Cuántas hay de cada clase, para la leyenda de arriba.
  const conteos = useMemo(() => {
    const m = new Map<AlarmClassId, number>();
    for (const a of alarmas) m.set(a.alarmClass, (m.get(a.alarmClass) ?? 0) + 1);
    return m;
  }, [alarmas]);

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
            <BellIcon className="h-4 w-4" />
          </span>
          <div className="leading-tight">
            <p className="text-sm font-bold text-navy dark:text-slate-100">Alarmas</p>
            <p className="text-[11px] text-slate-400">
              {cargando
                ? 'Cargando…'
                : alarmas.length === 0
                  ? 'Ninguna configurada'
                  : `${alarmas.length} configurada${alarmas.length === 1 ? '' : 's'}`}
            </p>
          </div>
        </div>

        <SelectorBaseDatos
          valor={dbAlarmas}
          bases={bases}
          deshabilitado={cargando || ocupado}
          onCambiar={(v) => void cambiarBase(v)}
          titulo="Guardar las alarmas en"
          ayuda="Base de datos donde vive la tabla de definiciones de alarma"
          nota={
            <>
              Cambia dónde se leen y se guardan las definiciones de alarma
              (<span className="font-mono">alarmas_def</span>). Los eventos
              que dispare cada regla se guardarán en la misma base.
            </>
          }
        />

        {/* Leyenda con el conteo por clase */}
        {alarmas.length > 0 && (
          <div className="hidden flex-wrap items-center gap-1.5 md:flex">
            {ALARM_CLASSES.filter((c) => conteos.get(c.id)).map((c) => (
              <span
                key={c.id}
                className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1 ${c.insignia}`}
              >
                <span className={`h-1.5 w-1.5 rounded-full ${c.punto}`} />
                {c.id}
                <span className="opacity-60">{conteos.get(c.id)}</span>
              </span>
            ))}
          </div>
        )}

        <Firma sesion={sesion} authRequerida={authRequerida} />

        <EstadoAutoguardado estado={guardado} ocupado={ocupado} />

        <div className="ml-auto flex items-center gap-2">
          {alarmas.length > 0 && (
            <div className="relative">
              <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
              <input
                type="search"
                value={filtro}
                onChange={(e) => setFiltro(e.target.value)}
                // El placeholder enumera las columnas a propósito: la búsqueda
                // barre las cinco a la vez y no hay forma de adivinarlo mirando
                // una caja que solo diga "Buscar…".
                placeholder="Buscar por ID, nombre, texto, clase o tag…"
                aria-label="Buscar alarmas por ID, nombre, texto, clase o tag"
                className="w-44 rounded-lg border border-slate-200 bg-white py-1.5 pl-8 pr-2.5 text-xs text-navy outline-none transition placeholder:text-slate-400 focus:border-siemens focus:ring-2 focus:ring-siemens/20 dark:border-navy-slate dark:bg-navy dark:text-slate-100 sm:w-72"
              />
            </div>
          )}

          <button
            onClick={() => void recargarTodo()}
            disabled={cargando || ocupado}
            title="Volver a leer las alarmas de la base de datos"
            className="flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 outline-none transition hover:bg-slate-100 hover:text-slate-600 disabled:opacity-40 dark:hover:bg-navy-slate/40"
          >
            <RefreshCwIcon className={`h-4 w-4 ${cargando ? 'animate-spin' : ''}`} />
          </button>

          <button
            onClick={agregar}
            disabled={cargando || ocupado}
            className="flex min-h-[34px] items-center gap-1.5 rounded-lg bg-siemens px-3 py-1.5 text-xs font-semibold text-white outline-none transition hover:bg-siemens-600 focus-visible:ring-2 focus-visible:ring-siemens/50 disabled:cursor-not-allowed disabled:opacity-60"
          >
            <PlusIcon className="h-3.5 w-3.5" />
            Agregar alarma
          </button>
        </div>
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

      {/* Las alarmas de la versión anterior, que siguen en este navegador.
          Se ofrecen; no se suben solas, porque subirlas sin preguntar
          duplicaría las que ya estén en la base. */}
      {locales.length > 0 && !cargando && (
        <div className="flex flex-wrap items-center gap-2 border-b border-amber-200 bg-amber-50 px-4 py-2.5 text-xs text-amber-800 dark:border-amber-500/25 dark:bg-amber-500/10 dark:text-amber-200">
          <UploadCloudIcon className="h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0">
            Hay {locales.length} alarma{locales.length === 1 ? '' : 's'} guardada
            {locales.length === 1 ? '' : 's'} en este navegador, de antes de que
            esta pantalla usara la base de datos.
          </span>
          <button
            type="button"
            onClick={importarLocales}
            disabled={ocupado}
            className="ml-auto shrink-0 rounded-lg bg-amber-600 px-2.5 py-1 font-semibold text-white transition hover:bg-amber-700 disabled:opacity-60"
          >
            Subirlas a esta base
          </button>
          <button
            type="button"
            onClick={descartarLocales}
            disabled={ocupado}
            className="shrink-0 rounded px-1.5 font-semibold underline-offset-2 hover:underline disabled:opacity-60"
          >
            Descartar
          </button>
        </div>
      )}

      {/* ══ Tabla ═══════════════════════════════════════════════ */}
      <div className="flex-1 overflow-hidden p-4">
        <div className="mx-auto flex h-full max-w-6xl flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-card dark:border-navy-slate dark:bg-navy-soft">

          {/* El contenedor scrollea en los dos ejes: en pantallas angostas la
              tabla no se comprime, se desplaza. Así ninguna columna se
              vuelve ilegible. */}
          <div ref={cuerpoRef} className="mp-scroll mp-scroll-dark flex-1 overflow-auto">
            {cargando ? (
              <Cargando texto="Leyendo las alarmas de la base de datos…" />
            ) : (
              <>
                <table className="w-full min-w-[1240px] border-collapse text-left">
                  <thead className="sticky top-0 z-10">
                    <tr className="bg-slate-100 dark:bg-navy">
                      <Th className="w-[72px] text-center">ID</Th>
                      <Th className="w-[180px]">Name</Th>
                      <Th>Alarm text</Th>
                      <Th className="w-[170px]">Alarm class</Th>
                      <Th className="w-[250px]">Trigger tag</Th>
                      {/* Las tres columnas de la CONDICIÓN. Estaban en la
                          tabla desde el principio pero sin dónde editarlas:
                          mientras no hubo motor daba igual, ahora deciden si
                          la alarma salta o no. */}
                      <Th className="w-[210px]">Condición</Th>
                      <Th className="w-[96px]">
                        <span title="Histéresis: cuánto tiene que volver el valor para darla por normalizada. Solo en analógicas.">
                          Banda
                        </span>
                      </Th>
                      <Th className="w-[64px] text-center">
                        <span title="Desactivar silencia la regla sin borrarla.">On</span>
                      </Th>
                      <Th className="w-[76px] text-center">
                        <span className="sr-only">Acciones</span>
                      </Th>
                    </tr>
                  </thead>

                  <tbody>
                    <AnimatePresence initial={false}>
                      {visibles.map((a) => {
                        const clase = claseDe(a.alarmClass);
                        const Icono = clase.icon;
                        return (
                          <motion.tr
                            key={a.id}
                            layout={!sinMovimiento}
                            {...filaAnim}
                            className="group border-t border-slate-100 transition-colors hover:bg-slate-50/80 dark:border-navy-slate/70 dark:hover:bg-navy/40"
                          >
                            {/* ID — el de la base de datos, no editable */}
                            <td className="px-2 py-1.5">
                              <div className="flex items-center justify-center gap-1.5">
                                <Icono className={`h-3.5 w-3.5 ${textoDe(clase)}`} />
                                <span className="font-mono text-xs tabular-nums text-slate-500 dark:text-slate-400">
                                  {a.id}
                                </span>
                              </div>
                            </td>

                            {/* Name */}
                            <td className="px-1 py-1">
                              <Celda
                                value={a.name}
                                onChange={(v) => editar(a.id, { name: v })}
                                placeholder="Nombre de la alarma"
                                autoFocus={recienCreada === a.id}
                                onFocus={() => setRecienCreada(null)}
                                aria-label={`Nombre de la alarma ${a.id}`}
                                className="font-medium"
                              />
                            </td>

                            {/* Alarm text */}
                            <td className="px-1 py-1">
                              <Celda
                                value={a.text}
                                onChange={(v) => editar(a.id, { text: v })}
                                placeholder={clase.ejemplo}
                                aria-label={`Texto de la alarma ${a.id}`}
                              />
                            </td>

                            {/* Alarm class — el desplegable.
                                Sin fondo de color a propósito: el <select> pinta
                                la lista desplegable NATIVA con su mismo fondo, y
                                un fondo claro con el texto claro del modo oscuro
                                dejaba las opciones ilegibles. El color de la clase
                                vive en el punto de la izquierda, que no arrastra
                                ese problema. */}
                            <td className="px-1 py-1">
                              <div className="relative">
                                <select
                                  value={a.alarmClass}
                                  onChange={(e) =>
                                    editar(a.id, {
                                      alarmClass: e.target.value as AlarmClassId,
                                    })
                                  }
                                  aria-label={`Clase de la alarma ${a.id}`}
                                  className="w-full cursor-pointer appearance-none rounded-md border border-transparent bg-transparent py-1.5 pl-7 pr-7 text-xs font-medium text-navy outline-none transition hover:border-slate-200 hover:bg-white focus:border-siemens focus:bg-white focus:ring-2 focus:ring-siemens/20 dark:text-slate-100 dark:hover:border-navy-slate dark:hover:bg-navy dark:focus:bg-navy"
                                >
                                  {ALARM_CLASS_IDS.map((c) => (
                                    <option key={c} value={c}>
                                      {c}
                                    </option>
                                  ))}
                                </select>
                                <span
                                  aria-hidden="true"
                                  className={`pointer-events-none absolute left-2.5 top-1/2 h-2 w-2 -translate-y-1/2 rounded-full ${clase.punto}`}
                                />
                                <ChevronDownIcon
                                  aria-hidden="true"
                                  className="pointer-events-none absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400"
                                />
                              </div>
                            </td>

                            {/* Trigger tag — las variables REALES del PLC.
                                Antes era texto libre: había que saberse de
                                memoria el nombre exacto del tag y escribirlo
                                sin una errata, y una errata no daba ningún
                                error, simplemente la alarma no saltaba nunca.
                                Ahora se elige de la lista descubierta por
                                browse, con el último valor al lado para
                                confirmar que es el tag correcto — y se sigue
                                pudiendo teclear con el PLC apagado. */}
                            <td className="px-1 py-1">
                              <SelectorTagPlc
                                valor={a.triggerTag}
                                tags={tagsPlc}
                                cargando={cargandoTags}
                                sinPlcs={!hayPlcs}
                                onElegir={(tag) => editar(a.id, { triggerTag: tag })}
                              />
                            </td>

                            {/* Condición: comparador + el valor que lleva.
                                Los dos controles van juntos porque son UNA
                                decisión: "bit 3" y "mayor que 80" se leen de
                                corrido, y separarlos en dos columnas obligaba
                                a mirar a dos sitios para saber qué vigila. */}
                            <td className="px-1 py-1">
                              <div className="flex items-center gap-1">
                                <select
                                  value={a.comparador}
                                  onChange={(e) =>
                                    editar(a.id, {
                                      comparador: e.target.value as Comparador,
                                    })
                                  }
                                  aria-label={`Cómo se evalúa la alarma ${a.id}`}
                                  className="w-[122px] shrink-0 cursor-pointer rounded-md border border-transparent bg-transparent py-1.5 pl-2 pr-1 text-xs text-navy outline-none transition hover:border-slate-200 hover:bg-white focus:border-siemens focus:bg-white focus:ring-2 focus:ring-siemens/20 dark:text-slate-100 dark:hover:border-navy-slate dark:hover:bg-navy dark:focus:bg-navy"
                                >
                                  {COMPARADORES.map((c) => (
                                    <option key={c} value={c}>
                                      {ETIQUETA_COMPARADOR[c]}
                                    </option>
                                  ))}
                                </select>

                                {esAnalogico(a.comparador) ? (
                                  <input
                                    type="number"
                                    // `?? ''` y no `|| ''`: un límite de 0 es
                                    // válido ("si el caudal baja de 0") y con
                                    // `||` se vería el campo vacío, como si
                                    // nadie lo hubiera configurado.
                                    value={a.limite ?? ''}
                                    onChange={(e) =>
                                      editar(a.id, {
                                        limite:
                                          e.target.value === ''
                                            ? null
                                            : Number(e.target.value),
                                      })
                                    }
                                    placeholder="límite"
                                    aria-label={`Valor límite de la alarma ${a.id}`}
                                    className="w-full min-w-0 rounded-md border border-transparent bg-transparent py-1.5 px-2 text-right font-mono text-xs tabular-nums text-navy outline-none transition placeholder:text-slate-300 hover:border-slate-200 hover:bg-white focus:border-siemens focus:bg-white focus:ring-2 focus:ring-siemens/20 dark:text-slate-100 dark:placeholder:text-slate-600 dark:hover:border-navy-slate dark:hover:bg-navy dark:focus:bg-navy"
                                  />
                                ) : (
                                  <div className="flex w-full min-w-0 items-center gap-1">
                                    <span className="shrink-0 text-[10px] text-slate-400">bit</span>
                                    <input
                                      type="number"
                                      min={0}
                                      max={63}
                                      value={a.bitDisparo}
                                      onChange={(e) =>
                                        editar(a.id, {
                                          bitDisparo: Math.max(
                                            0,
                                            Math.min(63, Number(e.target.value) || 0)
                                          ),
                                        })
                                      }
                                      aria-label={`Bit que dispara la alarma ${a.id}`}
                                      // Un Bool del PLC es el bit 0, que es el
                                      // valor de arranque: vigilar un Bool no
                                      // obliga a tocar esto.
                                      title="Qué bit del tag se vigila. Un Bool es el bit 0."
                                      className="w-full min-w-0 rounded-md border border-transparent bg-transparent py-1.5 px-2 text-right font-mono text-xs tabular-nums text-navy outline-none transition hover:border-slate-200 hover:bg-white focus:border-siemens focus:bg-white focus:ring-2 focus:ring-siemens/20 dark:text-slate-100 dark:hover:border-navy-slate dark:hover:bg-navy dark:focus:bg-navy"
                                    />
                                  </div>
                                )}
                              </div>
                            </td>

                            {/* Banda muerta — solo tiene sentido en analógicas */}
                            <td className="px-1 py-1">
                              <input
                                type="number"
                                min={0}
                                step="any"
                                value={a.bandaMuerta || ''}
                                disabled={!esAnalogico(a.comparador)}
                                onChange={(e) =>
                                  editar(a.id, {
                                    bandaMuerta: Math.abs(Number(e.target.value) || 0),
                                  })
                                }
                                placeholder={esAnalogico(a.comparador) ? '0' : '—'}
                                aria-label={`Banda muerta de la alarma ${a.id}`}
                                title={
                                  esAnalogico(a.comparador)
                                    ? 'Histéresis, solo para APAGAR. Con «mayor que 80» y ' +
                                      'banda 2: dispara al pasar de 80, pero no se ' +
                                      'normaliza hasta bajar de 78. Sin ella, un valor ' +
                                      'oscilando en el límite genera cientos de eventos.'
                                    : 'No aplica a las alarmas de bit: un bit está a 1 o a 0, ' +
                                      'no oscila alrededor de un umbral.'
                                }
                                className="w-full rounded-md border border-transparent bg-transparent py-1.5 px-2 text-right font-mono text-xs tabular-nums text-navy outline-none transition placeholder:text-slate-300 hover:border-slate-200 hover:bg-white focus:border-siemens focus:bg-white focus:ring-2 focus:ring-siemens/20 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-transparent disabled:hover:bg-transparent dark:text-slate-100 dark:placeholder:text-slate-600 dark:hover:border-navy-slate dark:hover:bg-navy dark:focus:bg-navy"
                              />
                            </td>

                            {/* Activo — silenciar sin borrar */}
                            <td className="px-1 py-1">
                              <div className="flex justify-center">
                                <button
                                  onClick={() => editar(a.id, { activo: !a.activo })}
                                  role="switch"
                                  aria-checked={a.activo}
                                  aria-label={`${a.activo ? 'Silenciar' : 'Reactivar'} la alarma ${a.id}`}
                                  title={
                                    a.activo
                                      ? 'Vigilando. Pulsa para silenciarla sin borrarla: ' +
                                        'la regla se conserva y deja de evaluarse.'
                                      : 'Silenciada: el motor no la evalúa. La regla sigue ' +
                                        'guardada tal cual.'
                                  }
                                  className={`relative h-4 w-8 shrink-0 rounded-full outline-none transition focus-visible:ring-2 focus-visible:ring-siemens/40 ${
                                    a.activo
                                      ? 'bg-siemens'
                                      : 'bg-slate-300 dark:bg-navy-slate'
                                  }`}
                                >
                                  <span
                                    className={`absolute top-0.5 h-3 w-3 rounded-full bg-white shadow transition-all ${
                                      a.activo ? 'left-[18px]' : 'left-0.5'
                                    }`}
                                  />
                                </button>
                              </div>
                            </td>

                            {/* Acciones — aparecen al pasar por encima */}
                            <td className="px-1 py-1">
                              <AccionesFila>
                                <IconoBoton
                                  onClick={() => duplicar(a.id)}
                                  titulo="Duplicar"
                                  className="hover:bg-slate-100 hover:text-siemens dark:hover:bg-navy-slate/60"
                                >
                                  <CopyIcon className="h-3.5 w-3.5" />
                                </IconoBoton>
                                <IconoBoton
                                  onClick={() => borrar(a.id)}
                                  titulo="Eliminar"
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

                {/* Sin alarmas todavía */}
                {alarmas.length === 0 && (
                  <div className="flex flex-col items-center justify-center px-6 py-16 text-center">
                    <BellOffIcon className="mb-3 h-10 w-10 text-slate-300 dark:text-slate-600" />
                    <p className="text-sm font-semibold text-slate-500 dark:text-slate-300">
                      Todavía no hay alarmas
                    </p>
                    <p className="mt-1 max-w-sm text-xs leading-relaxed text-slate-400">
                      Cada alarma necesita un nombre, el texto que verá el operador,
                      su clase y el tag que la dispara.
                    </p>
                    <button
                      onClick={agregar}
                      disabled={ocupado}
                      className="mt-5 flex items-center gap-1.5 rounded-lg bg-siemens px-3.5 py-2 text-xs font-semibold text-white transition hover:bg-siemens-600 disabled:opacity-60"
                    >
                      <PlusIcon className="h-3.5 w-3.5" />
                      Crear la primera
                    </button>
                  </div>
                )}

                {/* Hay alarmas pero ninguna pasa el filtro */}
                {alarmas.length > 0 && visibles.length === 0 && (
                  <div className="px-6 py-12 text-center">
                    <p className="text-sm text-slate-400">
                      Ninguna alarma coincide con «{filtro}».
                    </p>
                    <button
                      onClick={() => setFiltro('')}
                      className="mt-2 text-xs font-semibold text-siemens hover:underline"
                    >
                      Limpiar búsqueda
                    </button>
                  </div>
                )}
              </>
            )}
          </div>

          {/* Pie: qué pasa con esto una vez guardado.
              Antes decía que no había motor. Ahora lo hay, y lo que hace
              falta advertir es lo contrario: que una regla sin tag se ve
              exactamente igual que una que funciona, y no salta nunca. */}
          <div className="flex items-start gap-2 border-t border-slate-100 bg-slate-50/70 px-4 py-2.5 dark:border-navy-slate dark:bg-navy/40">
            <InfoIcon className="mt-px h-3.5 w-3.5 shrink-0 text-slate-400" />
            <p className="min-w-0 text-[11px] leading-relaxed text-slate-400">
              Se guarda en <span className="font-mono">alarmas_def</span> de la
              base elegida arriba, y el motor del servidor la vigila desde ese
              momento: cuando la condición se cumple escribe el evento en{' '}
              <span className="font-mono">alarmas</span> y avisa a todas las
              pantallas abiertas.{' '}
              {sinTag > 0 ? (
                <span className="font-semibold text-state-warn">
                  {sinTag === 1
                    ? 'Hay 1 alarma sin Trigger tag: no se evalúa nunca.'
                    : `Hay ${sinTag} alarmas sin Trigger tag: no se evalúan nunca.`}
                </span>
              ) : (
                <>Vigila aunque no haya nadie con el navegador abierto.</>
              )}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════
// Piezas
// ═════════════════════════════════════════════════════════════════

/**
 * Quién queda registrado como autor de los cambios.
 *
 * Con sesión: el nombre, discreto — es información de contexto, no una
 * alarma. Sin sesión: un aviso, porque lo que se está perdiendo no se ve
 * hasta que alguien pregunta "¿quién subió este umbral?" y la respuesta es
 * una columna vacía.
 *
 * No bloquea nada. Con `PLC_AUTH_REQUERIDA=false` escribir sin identificarse
 * es una decisión legítima (un PC de planta con un solo operario), y la
 * vista no está para discutirla; está para que no sea una sorpresa.
 */
function Firma({
  sesion,
  authRequerida,
}: {
  sesion: { usuario: string; usuario_id?: number } | null;
  authRequerida: boolean;
}) {
  if (sesion) {
    return (
      <span
        title={`Los cambios se guardan a tu nombre (usuario_id ${
          sesion.usuario_id ?? '—'
        }), tomado de tu token de sesión.`}
        className="inline-flex items-center gap-1.5 rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-500 dark:bg-navy-slate/50 dark:text-slate-400"
      >
        <UserIcon className="h-3 w-3" />
        {sesion.usuario}
      </span>
    );
  }
  // Con el login exigido esto no debería verse: RutaProtegida manda al login
  // antes de llegar. Si aparece, es el instante entre que caduca la sesión y
  // la vista se entera, y decirlo es mejor que fingir que todo va bien.
  return (
    <span
      title={
        authRequerida
          ? 'Tu sesión no está activa. Los cambios serán rechazados por el servidor.'
          : 'Nadie ha iniciado sesión, así que estos cambios se guardan sin autor ' +
            '(usuario_id queda vacío). Activa PLC_AUTH_REQUERIDA=true para exigir ' +
            'identificarse.'
      }
      className="inline-flex items-center gap-1.5 rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-700 ring-1 ring-amber-200 dark:bg-amber-500/15 dark:text-amber-300 dark:ring-amber-500/25"
    >
      <UserXIcon className="h-3 w-3" />
      Sin identificar
    </span>
  );
}

/** Color de texto del icono de la fila, derivado de la insignia de la clase. */
function textoDe(c: AlarmClassDef): string {
  const m = c.insignia.match(/text-[a-z]+-\d+/);
  return m ? m[0] : 'text-slate-400';
}
