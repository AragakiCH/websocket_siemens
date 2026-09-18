// =========================================================================
// VariablesInternas.tsx
// Las variables que viven en el servidor y no en ningun PLC.
//
// PARA QUE SIRVE ESTA PANTALLA
//   Tres cosas que antes no tenian donde vivir:
//     * Probar una pantalla sin planta: enlazas un widget a `interno|nivel`
//       y mueves el valor a mano para ver si la animacion funciona.
//     * Estado propio del HMI: «modo mantenimiento», el turno, un rotulo.
//       Meterlo en un DB del PLC obliga a recompilar para cambiar un texto.
//     * Un valor compartido entre pantallas. `localStorage` no sirve: es de
//       un navegador; esto lo ven los cinco paneles de la linea.
//
// LA COLUMNA «VALOR AHORA» ES DE VERDAD
//   No es un campo de formulario: es el valor vivo. Se lee de la misma lista
//   de tags que alimenta a los widgets (`useAppStore().variables`), asi que
//   si otro panel mueve la variable, aqui se ve moverse. Y al tocarlo se
//   manda al servidor y lo ven todos.
//
// LO QUE SE APRENDIO DE ALARMAS Y RECETAS, APLICADO AQUI
//   Mismo esqueleto: barra superior con estado del guardado, tabla de celdas
//   editables sin bordes en reposo (estilo TIA), PATCH agrupado tras una
//   pausa, altas y bajas al momento, y el error del servidor tal cual lo
//   mando. Que las tres pantallas de configuracion se comporten igual no es
//   estetica: es que aprender una sea aprender las tres.
//
// POR QUE EL ALTA TIENE FORMULARIO Y ALARMAS NO
//   En Alarmas, «Agregar» crea una fila y se edita encima. Aqui no vale: el
//   NOMBRE es la clave con la que los widgets se enlazan (`interno|nombre`),
//   asi que crear `variable_1` y renombrarla despues seria fabricar el
//   problema que la propia pantalla avisa de no cometer. Se pide el nombre
//   antes de que exista nada.
// =========================================================================
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { motion, AnimatePresence, useReducedMotion } from 'framer-motion';
import {
  VariableIcon,
  PlusIcon,
  Trash2Icon,
  SearchIcon,
  AlertCircleIcon,
  InfoIcon,
  RefreshCwIcon,
  CopyIcon,
  CheckIcon,
  ToggleLeftIcon,
  HashIcon,
  GaugeIcon,
  TypeIcon,
  XIcon,
  PinIcon,
} from 'lucide-react';
import {
  Th,
  Celda,
  CeldaSelect,
  IconoBoton,
  AccionesFila,
  Cargando,
  EstadoAutoguardado,
  type EstadoGuardado,
} from '../ui/TableBits';
import { useAppStore } from '../../context/AppStore';
import {
  TIPOS_INTERNA,
  actualizarInterna,
  borrarInterna,
  claveInterna,
  crearInterna,
  esNumerica,
  etiquetaTipo,
  fijarValorInterna,
  listarInternas,
  type TipoInterna,
  type VariableInterna,
} from '../../services/internasApi';

/** Misma pausa que en Recetas y Alarmas: escribir no son N peticiones. */
const RETARDO_GUARDADO = 600;

// ─── Aspecto de cada tipo ────────────────────────────────────────
//
// El icono y el color viven aqui y no en el servicio a proposito: el
// servicio describe DATOS que van a la base, esto describe como se ven.
const ASPECTO: Record<TipoInterna, { icon: typeof VariableIcon; insignia: string; punto: string }> = {
  bool: {
    icon: ToggleLeftIcon,
    insignia:
      'bg-emerald-100 text-emerald-700 ring-emerald-200 dark:bg-emerald-500/15 dark:text-emerald-300 dark:ring-emerald-500/25',
    punto: 'bg-emerald-500',
  },
  int: {
    icon: HashIcon,
    insignia:
      'bg-sky-100 text-sky-700 ring-sky-200 dark:bg-sky-500/15 dark:text-sky-300 dark:ring-sky-500/25',
    punto: 'bg-sky-500',
  },
  double: {
    icon: GaugeIcon,
    insignia:
      'bg-violet-100 text-violet-700 ring-violet-200 dark:bg-violet-500/15 dark:text-violet-300 dark:ring-violet-500/25',
    punto: 'bg-violet-500',
  },
  string: {
    icon: TypeIcon,
    insignia:
      'bg-amber-100 text-amber-700 ring-amber-200 dark:bg-amber-500/15 dark:text-amber-300 dark:ring-amber-500/25',
    punto: 'bg-amber-500',
  },
};

const ETIQUETAS = TIPOS_INTERNA.map((t) => t.etiqueta);
const tipoDeEtiqueta = (e: string): TipoInterna =>
  TIPOS_INTERNA.find((t) => t.etiqueta === e)?.id ?? 'bool';

// ═════════════════════════════════════════════════════════════════

export function VariablesInternas() {
  const [variables, setVariables] = useState<VariableInterna[]>([]);
  const [filtro, setFiltro] = useState('');
  const [cargando, setCargando] = useState(true);
  const [ocupado, setOcupado] = useState(false);
  const [error, setError] = useState('');
  const [aviso, setAviso] = useState('');
  const [guardado, setGuardado] = useState<EstadoGuardado>('limpio');
  const [creando, setCreando] = useState(false);
  const [confirmar, setConfirmar] = useState('');
  const sinMovimiento = useReducedMotion();

  // Los valores VIVOS. La misma lista que alimenta a los widgets: si otro
  // panel mueve la variable, esta tabla lo refleja sin preguntar nada.
  const { variables: tags } = useAppStore();
  const vivosDelServidor = useMemo(() => {
    const m = new Map<string, unknown>();
    for (const t of tags) m.set(t.id, t.value);
    return m;
  }, [tags]);

  // ── LO QUE ACABAS DE ESCRIBIR, MIENTRAS EL SERVIDOR LO CONFIRMA ───
  //
  // La columna «Valor ahora» enseña el valor VIVO (el que llega por el
  // WebSocket), y eso es correcto: es lo que ven los demás paneles. Pero
  // entre que pulsas el interruptor y el servidor devuelve el eco hay un
  // viaje de ida y vuelta, y durante ese viaje el interruptor seguía
  // enseñando el valor viejo. Un segundo clic en ese momento mandaba
  // OTRA VEZ el contrario —o sea, lo deshacía—, y el control parecía roto.
  //
  // Aquí se guarda lo que se acaba de mandar y se enseña en su lugar hasta
  // que el valor vivo lo alcanza (o hasta que el envío falla). Es lo que
  // hace cualquier interruptor de una app decente: obedece al dedo y se
  // corrige solo si el servidor dice otra cosa.
  const [pendientes, setPendientes] = useState<Map<string, unknown>>(new Map());

  useEffect(() => {
    if (pendientes.size === 0) return;
    let cambio = false;
    const siguiente = new Map(pendientes);
    for (const [nombre, valor] of pendientes) {
      const vivo = vivosDelServidor.get(claveInterna(nombre));
      // Se compara como texto: el servidor puede devolver 12 donde se mandó
      // "12", y los dos son el mismo valor para quien mira la pantalla.
      if (vivo !== undefined && String(vivo) === String(valor)) {
        siguiente.delete(nombre);
        cambio = true;
      }
    }
    if (cambio) setPendientes(siguiente);
  }, [vivosDelServidor, pendientes]);

  const vivos = useMemo(() => {
    if (pendientes.size === 0) return vivosDelServidor;
    const m = new Map(vivosDelServidor);
    for (const [nombre, valor] of pendientes) m.set(claveInterna(nombre), valor);
    return m;
  }, [vivosDelServidor, pendientes]);

  // ── Guardado diferido de la DEFINICION ────────────────────────
  const cola = useRef(new Map<string, Record<string, unknown>>());
  const temporizador = useRef<number | null>(null);
  const recargarRef = useRef<() => void>(() => {});

  const vaciarCola = useCallback(async () => {
    temporizador.current = null;
    const items = [...cola.current.entries()];
    cola.current.clear();
    if (items.length === 0) return;
    setGuardado('guardando');
    try {
      for (const [nombre, cambios] of items) {
        const r = await actualizarInterna(nombre, cambios);
        if (r.renombrada) setAviso(r.mensaje);
      }
      setGuardado('guardado');
      setError('');
      // Tras un cambio de definicion se relee: el servidor puede haber
      // reinterpretado el valor (cambiar de Texto a Decimal) y lo que se ve
      // tiene que ser lo que hay, no lo que se pidio.
      recargarRef.current();
    } catch (e: any) {
      setGuardado('error');
      setError(e?.message ?? 'No se pudo guardar el cambio.');
      recargarRef.current();
    }
  }, []);

  const programar = useCallback(
    (nombre: string, cambios: Record<string, unknown>) => {
      if (!nombre || Object.keys(cambios).length === 0) return;
      cola.current.set(nombre, { ...(cola.current.get(nombre) ?? {}), ...cambios });
      setGuardado('guardando');
      if (temporizador.current) window.clearTimeout(temporizador.current);
      temporizador.current = window.setTimeout(() => void vaciarCola(), RETARDO_GUARDADO);
    },
    [vaciarCola]
  );

  useEffect(() => {
    return () => {
      if (temporizador.current) window.clearTimeout(temporizador.current);
      const items = [...cola.current.entries()];
      cola.current.clear();
      for (const [nombre, cambios] of items) {
        void actualizarInterna(nombre, cambios).catch(() => {});
      }
    };
  }, []);

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
  const recargar = useCallback(async () => {
    setCargando(true);
    try {
      setVariables(await listarInternas());
      setError('');
    } catch (e: any) {
      setError(e?.message ?? 'No se pudieron cargar las variables internas.');
    } finally {
      setCargando(false);
    }
  }, []);

  useEffect(() => { void recargar(); }, [recargar]);
  recargarRef.current = () => { void recargar(); };

  // ── Edicion de la definicion ──────────────────────────────────
  const editar = useCallback(
    (nombre: string, cambios: Partial<VariableInterna>) => {
      setVariables((prev) =>
        prev.map((v) => (v.nombre === nombre ? { ...v, ...cambios } : v))
      );
      programar(nombre, cambios as Record<string, unknown>);
    },
    [programar]
  );

  // ── El VALOR: va al momento, no espera ────────────────────────
  //
  // Un interruptor que tarda seis decimas en obedecer se siente roto, y
  // ademas el valor es lo que ven los demas paneles: agruparlo no ahorra
  // nada porque no se teclea letra a letra.
  const ponerValor = useCallback(
    (v: VariableInterna, valor: unknown) => {
      setVariables((prev) =>
        prev.map((x) => (x.nombre === v.nombre ? { ...x, valor } : x))
      );
      // Se enseña ya, sin esperar al eco (ver `pendientes`).
      setPendientes((prev) => new Map(prev).set(v.nombre, valor));
      void conServidor(async () => {
        try {
          await fijarValorInterna(v.nombre, valor);
        } catch (e) {
          // Si el servidor lo rechazó, el valor optimista era mentira: se
          // quita y vuelve a verse el vivo, que es el que hay de verdad.
          setPendientes((prev) => {
            const m = new Map(prev);
            m.delete(v.nombre);
            return m;
          });
          throw e;
        }
      });
    },
    [conServidor]
  );

  const borrar = useCallback(
    (nombre: string) => {
      setConfirmar('');
      void conServidor(async () => {
        await borrarInterna(nombre);
        setVariables((prev) => prev.filter((v) => v.nombre !== nombre));
      });
    },
    [conServidor]
  );

  const crear = useCallback(
    (datos: { nombre: string; tipo: TipoInterna; descripcion: string }) =>
      conServidor(async () => {
        const { variable } = await crearInterna(datos);
        // `?? ''` en la comparacion: ordenar es lo ultimo por lo que deberia
        // caerse una pantalla. Si alguna fila llegara sin nombre, queda la
        // primera y se ve — que es infinitamente mejor que un TypeError
        // dentro del render, porque ese se lleva la aplicacion entera.
        setVariables((prev) =>
          [...prev, variable].sort((a, b) =>
            (a?.nombre ?? '').localeCompare(b?.nombre ?? '')
          )
        );
        setCreando(false);
      }),
    [conServidor]
  );

  // ── Filtro y conteos ──────────────────────────────────────────
  const visibles = useMemo(() => {
    const q = filtro.trim().toLowerCase();
    if (!q) return variables;
    return variables.filter((v) =>
      `${v.nombre} ${v.descripcion} ${etiquetaTipo(v.tipo)} ${v.unidad}`
        .toLowerCase()
        .includes(q)
    );
  }, [variables, filtro]);

  const conteos = useMemo(() => {
    const m = new Map<TipoInterna, number>();
    for (const v of variables) m.set(v.tipo, (m.get(v.tipo) ?? 0) + 1);
    return m;
  }, [variables]);

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
            <VariableIcon className="h-4 w-4" />
          </span>
          <div className="leading-tight">
            <p className="text-sm font-bold text-navy dark:text-slate-100">
              Variables internas
            </p>
            <p className="text-[11px] text-slate-400">
              {cargando
                ? 'Cargando…'
                : variables.length === 0
                  ? 'Ninguna definida'
                  : `${variables.length} definida${variables.length === 1 ? '' : 's'}`}
            </p>
          </div>
        </div>

        {variables.length > 0 && (
          <div className="hidden flex-wrap items-center gap-1.5 md:flex">
            {TIPOS_INTERNA.filter((t) => conteos.get(t.id)).map((t) => (
              <span
                key={t.id}
                title={t.ayuda}
                className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1 ${ASPECTO[t.id].insignia}`}
              >
                <span className={`h-1.5 w-1.5 rounded-full ${ASPECTO[t.id].punto}`} />
                {t.etiqueta}
                <span className="opacity-60">{conteos.get(t.id)}</span>
              </span>
            ))}
          </div>
        )}

        <EstadoAutoguardado estado={guardado} ocupado={ocupado} />

        <div className="ml-auto flex items-center gap-2">
          {variables.length > 0 && (
            <div className="relative">
              <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
              <input
                type="search"
                value={filtro}
                onChange={(e) => setFiltro(e.target.value)}
                placeholder="Buscar por nombre, descripción o tipo…"
                aria-label="Buscar variables internas"
                className="w-44 rounded-lg border border-slate-200 bg-white py-1.5 pl-8 pr-2.5 text-xs text-navy outline-none transition placeholder:text-slate-400 focus:border-siemens focus:ring-2 focus:ring-siemens/20 dark:border-navy-slate dark:bg-navy dark:text-slate-100 sm:w-64"
              />
            </div>
          )}

          <button
            onClick={() => void recargar()}
            disabled={cargando || ocupado}
            title="Volver a leer las variables del servidor"
            className="flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 outline-none transition hover:bg-slate-100 hover:text-slate-600 disabled:opacity-40 dark:hover:bg-navy-slate/40"
          >
            <RefreshCwIcon className={`h-4 w-4 ${cargando ? 'animate-spin' : ''}`} />
          </button>

          <button
            onClick={() => setCreando((x) => !x)}
            disabled={cargando || ocupado}
            className="flex min-h-[34px] items-center gap-1.5 rounded-lg bg-siemens px-3 py-1.5 text-xs font-semibold text-white outline-none transition hover:bg-siemens-600 focus-visible:ring-2 focus-visible:ring-siemens/50 disabled:cursor-not-allowed disabled:opacity-60"
          >
            <PlusIcon className="h-3.5 w-3.5" />
            Nueva variable
          </button>
        </div>
      </div>

      {error && (
        <Banda tono="error" onCerrar={() => setError('')}>
          {error}
        </Banda>
      )}
      {aviso && (
        <Banda tono="aviso" onCerrar={() => setAviso('')}>
          {aviso}
        </Banda>
      )}

      {/* ══ Cuerpo ══════════════════════════════════════════════ */}
      <div className="flex-1 overflow-hidden p-4">
        <div className="mx-auto flex h-full max-w-[1180px] flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-card dark:border-navy-slate dark:bg-navy-soft">

          <AnimatePresence initial={false}>
            {creando && (
              <motion.div
                key="alta"
                initial={sinMovimiento ? false : { height: 0, opacity: 0 }}
                animate={sinMovimiento ? {} : { height: 'auto', opacity: 1 }}
                exit={sinMovimiento ? {} : { height: 0, opacity: 0 }}
                transition={{ duration: 0.18 }}
                className="overflow-hidden border-b border-slate-200 dark:border-navy-slate"
              >
                <FormularioAlta
                  ocupado={ocupado}
                  existentes={variables.map((v) => v.nombre)}
                  onCrear={crear}
                  onCancelar={() => setCreando(false)}
                />
              </motion.div>
            )}
          </AnimatePresence>

          <div className="mp-scroll mp-scroll-dark flex-1 overflow-auto">
            {cargando ? (
              <Cargando texto="Leyendo las variables internas del servidor…" />
            ) : (
              <>
                <table className="w-full min-w-[980px] border-collapse text-left">
                  <thead className="sticky top-0 z-10">
                    <tr className="bg-slate-100 dark:bg-navy">
                      <Th className="w-[260px]">Nombre</Th>
                      <Th className="w-[130px]">Tipo</Th>
                      <Th>Descripción</Th>
                      <Th className="w-[170px]">Rango · unidad</Th>
                      <Th className="w-[210px]">Valor ahora</Th>
                      <Th className="w-[60px] text-center">
                        <span className="sr-only">Acciones</span>
                      </Th>
                    </tr>
                  </thead>
                  <tbody>
                    <AnimatePresence initial={false}>
                      {visibles.map((v) => (
                        <Fila
                          key={v.nombre}
                          v={v}
                          anim={filaAnim}
                          layout={!sinMovimiento}
                          vivo={vivos.get(claveInterna(v.nombre))}
                          confirmando={confirmar === v.nombre}
                          onEditar={editar}
                          onValor={ponerValor}
                          onPedirBorrar={() =>
                            setConfirmar(confirmar === v.nombre ? '' : v.nombre)
                          }
                          onBorrar={() => borrar(v.nombre)}
                        />
                      ))}
                    </AnimatePresence>
                  </tbody>
                </table>

                {variables.length === 0 && !creando && (
                  <Vacio onCrear={() => setCreando(true)} />
                )}

                {variables.length > 0 && visibles.length === 0 && (
                  <div className="px-6 py-12 text-center">
                    <p className="text-sm text-slate-400">
                      Ninguna variable coincide con «{filtro}».
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

          {/* Pie: como se usan. Es la pregunta siguiente a crear la primera. */}
          <div className="flex items-start gap-2 border-t border-slate-100 bg-slate-50/70 px-4 py-2.5 dark:border-navy-slate dark:bg-navy/40">
            <InfoIcon className="mt-px h-3.5 w-3.5 shrink-0 text-slate-400" />
            <p className="min-w-0 text-[11px] leading-relaxed text-slate-400">
              Para usarlas: en el Diseñador, selecciona un widget y elige la
              variable en el inspector — aparecen junto a las de los PLCs, bajo{' '}
              <span className="font-mono text-slate-500 dark:text-slate-300">
                interno
              </span>
              . El valor que pongas aquí lo ven todos los paneles al instante.
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

/** Una fila de la tabla. */
function Fila({
  v,
  anim,
  layout,
  vivo,
  confirmando,
  onEditar,
  onValor,
  onPedirBorrar,
  onBorrar,
}: {
  v: VariableInterna;
  anim: Record<string, unknown>;
  layout: boolean;
  vivo: unknown;
  confirmando: boolean;
  onEditar: (nombre: string, cambios: Partial<VariableInterna>) => void;
  onValor: (v: VariableInterna, valor: unknown) => void;
  onPedirBorrar: () => void;
  onBorrar: () => void;
}) {
  // `?? ASPECTO.string`: un tipo desconocido pinta como texto en vez de
  // reventar en `aspecto.icon`. Un dato raro degrada la fila, no la pantalla.
  const aspecto = ASPECTO[v.tipo] ?? ASPECTO.string;
  const Icono = aspecto.icon;
  // El valor vivo manda sobre el de la lista: viene del mismo flujo que los
  // widgets, asi que es el que de verdad tienen los demas paneles.
  const valor = vivo !== undefined ? vivo : v.valor;

  return (
    <motion.tr
      layout={layout}
      {...anim}
      className="group border-t border-slate-100 align-top transition-colors hover:bg-slate-50/80 dark:border-navy-slate/70 dark:hover:bg-navy/40"
    >
      {/* Nombre + la clave con la que se enlaza */}
      <td className="px-2 py-1.5">
        <div className="flex items-start gap-1.5">
          <Icono className={`mt-2 h-3.5 w-3.5 shrink-0 ${colorDe(aspecto.insignia)}`} />
          <div className="min-w-0 flex-1">
            <Celda
              value={v.nombre}
              onChange={(x) => onEditar(v.nombre, { nombre: x })}
              placeholder="nombre_variable"
              aria-label={`Nombre de la variable ${v.nombre}`}
              title="Renombrarla cambia la clave: los widgets enlazados se quedan sin variable."
              className="font-mono font-medium"
            />
            <ClaveCopiable nombre={v.nombre} />
          </div>
        </div>
      </td>

      {/* Tipo */}
      <td className="px-1 py-1.5">
        <CeldaSelect
          value={etiquetaTipo(v.tipo)}
          onChange={(e) => onEditar(v.nombre, { tipo: tipoDeEtiqueta(e) })}
          opciones={ETIQUETAS}
          aria-label={`Tipo de ${v.nombre}`}
        />
      </td>

      {/* Descripcion */}
      <td className="px-1 py-1.5">
        <Celda
          value={v.descripcion}
          onChange={(x) => onEditar(v.nombre, { descripcion: x })}
          placeholder="Para qué sirve"
          aria-label={`Descripción de ${v.nombre}`}
        />
      </td>

      {/* Rango y unidad: solo tienen sentido en las numericas */}
      <td className="px-1 py-1.5">
        {esNumerica(v.tipo) ? (
          <div className="flex items-center gap-1">
            <Celda
              value={v.minimo === null ? '' : String(v.minimo)}
              onChange={(x) =>
                onEditar(v.nombre, { minimo: x.trim() === '' ? null : Number(x.replace(',', '.')) })
              }
              placeholder="mín"
              numerica
              aria-label={`Mínimo de ${v.nombre}`}
              className="w-14"
            />
            <span className="text-[11px] text-slate-300 dark:text-slate-600">–</span>
            <Celda
              value={v.maximo === null ? '' : String(v.maximo)}
              onChange={(x) =>
                onEditar(v.nombre, { maximo: x.trim() === '' ? null : Number(x.replace(',', '.')) })
              }
              placeholder="máx"
              numerica
              aria-label={`Máximo de ${v.nombre}`}
              className="w-14"
            />
            <Celda
              value={v.unidad}
              onChange={(x) => onEditar(v.nombre, { unidad: x })}
              placeholder="ud."
              aria-label={`Unidad de ${v.nombre}`}
              className="w-12"
            />
          </div>
        ) : (
          // Ni vacio ni un campo desactivado: una raya dice «aqui no aplica»
          // sin invitar a pulsar.
          <span className="block px-2.5 py-1.5 text-xs text-slate-300 dark:text-slate-600">
            —
          </span>
        )}
      </td>

      {/* El valor vivo */}
      <td className="px-2 py-1.5">
        <ControlValor v={v} valor={valor} onValor={(x) => onValor(v, x)} />
      </td>

      {/* Acciones */}
      <td className="px-1 py-1.5">
        {confirmando ? (
          <div className="flex items-center justify-center gap-1">
            <button
              onClick={onBorrar}
              className="rounded-md bg-state-error px-2 py-1 text-[10px] font-bold text-white"
            >
              Borrar
            </button>
            <IconoBoton onClick={onPedirBorrar} titulo="Cancelar">
              <XIcon className="h-3.5 w-3.5" />
            </IconoBoton>
          </div>
        ) : (
          <AccionesFila>
            {!v.retentiva && (
              <span
                title="No retentiva: al reiniciar el servicio vuelve a su valor inicial."
                className="flex h-7 w-7 items-center justify-center text-slate-300 dark:text-slate-600"
              >
                <PinIcon className="h-3.5 w-3.5" />
              </span>
            )}
            <IconoBoton
              onClick={onPedirBorrar}
              titulo="Eliminar"
              className="hover:bg-red-50 hover:text-state-error dark:hover:bg-state-error/10"
            >
              <Trash2Icon className="h-3.5 w-3.5" />
            </IconoBoton>
          </AccionesFila>
        )}
      </td>
    </motion.tr>
  );
}

/**
 * El control del valor, distinto para cada tipo.
 *
 * Un `<input type="text">` para todo seria mas corto y peor: forzar un
 * booleano escribiendo «true» es pedirle a quien usa el panel que sepa como
 * se guarda el dato por dentro.
 */
function ControlValor({
  v,
  valor,
  onValor,
}: {
  v: VariableInterna;
  valor: unknown;
  onValor: (valor: unknown) => void;
}) {
  const [borrador, setBorrador] = useState('');
  const [editando, setEditando] = useState(false);

  // Mientras no se este escribiendo, lo que se ve es el valor vivo. En
  // cuanto alguien teclea manda el borrador, o el valor de otro panel le
  // borraria las letras a media palabra.
  const texto = editando
    ? borrador
    : valor === null || valor === undefined
      ? ''
      : String(valor);

  if (v.tipo === 'bool') {
    const on = valor === true;
    return (
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-label={`Valor de ${v.nombre}`}
        onClick={() => onValor(!on)}
        className={`flex h-7 w-[92px] items-center gap-2 rounded-full px-1 text-[11px] font-bold transition ${
          on
            ? 'bg-emerald-500 text-white'
            : 'bg-slate-200 text-slate-500 dark:bg-navy-slate dark:text-slate-400'
        }`}
      >
        <span
          className={`flex h-5 w-5 items-center justify-center rounded-full bg-white shadow transition-transform ${
            on ? 'translate-x-[58px]' : 'translate-x-0'
          }`}
        />
        <span className={`flex-1 text-center ${on ? '-ml-5' : 'ml-0'}`}>
          {on ? 'SÍ' : 'NO'}
        </span>
      </button>
    );
  }

  const enviar = () => {
    setEditando(false);
    if (borrador !== String(valor ?? '')) onValor(borrador);
  };

  return (
    <div className="relative">
      <input
        type="text"
        value={texto}
        onFocus={() => {
          setBorrador(valor === null || valor === undefined ? '' : String(valor));
          setEditando(true);
        }}
        onChange={(e) => setBorrador(e.target.value)}
        onBlur={enviar}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          if (e.key === 'Escape') {
            setEditando(false);
            (e.target as HTMLInputElement).blur();
          }
        }}
        aria-label={`Valor de ${v.nombre}`}
        placeholder={v.tipo === 'string' ? 'texto' : '0'}
        className={`w-full rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-xs outline-none transition focus:border-siemens focus:ring-2 focus:ring-siemens/20 dark:border-navy-slate dark:bg-navy dark:text-slate-100 ${
          v.tipo === 'string' ? '' : 'pr-12 text-right tabular-nums'
        }`}
      />
      {v.tipo !== 'string' && v.unidad && (
        <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-[10px] font-semibold text-slate-400">
          {v.unidad}
        </span>
      )}
    </div>
  );
}

/**
 * La clave, con un clic para copiarla.
 *
 * Es el puente entre esta pantalla y el Disenador: enlazar un widget exige
 * escribir `interno|velocidad` exactamente, y una letra de mas es un enlace
 * que no falla — simplemente no ensena nada.
 */
function ClaveCopiable({ nombre }: { nombre: string }) {
  const [copiado, setCopiado] = useState(false);
  const clave = claveInterna(nombre);

  const copiar = async () => {
    try {
      await navigator.clipboard.writeText(clave);
    } catch {
      // Sin permiso de portapapeles (o sin HTTPS) se cae a lo de siempre.
      const ta = document.createElement('textarea');
      ta.value = clave;
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); } catch { /* nada que hacer */ }
      ta.remove();
    }
    setCopiado(true);
    window.setTimeout(() => setCopiado(false), 1400);
  };

  return (
    <button
      type="button"
      onClick={copiar}
      title="Copiar la clave para enlazarla a un widget"
      className="ml-2.5 flex items-center gap-1 rounded px-0.5 text-[10px] font-mono text-slate-400 transition hover:text-siemens"
    >
      {copiado ? (
        <CheckIcon className="h-3 w-3 text-state-ok" />
      ) : (
        <CopyIcon className="h-3 w-3 opacity-0 transition-opacity group-hover:opacity-100" />
      )}
      {copiado ? 'copiada' : clave}
    </button>
  );
}

/** Alta: nombre y tipo antes de que la variable exista. */
function FormularioAlta({
  ocupado,
  existentes,
  onCrear,
  onCancelar,
}: {
  ocupado: boolean;
  existentes: string[];
  onCrear: (d: { nombre: string; tipo: TipoInterna; descripcion: string }) => Promise<void>;
  onCancelar: () => void;
}) {
  const [nombre, setNombre] = useState('');
  const [tipo, setTipo] = useState<TipoInterna>('bool');
  const [descripcion, setDescripcion] = useState('');
  const campo = useRef<HTMLInputElement>(null);

  useEffect(() => { campo.current?.focus(); }, []);

  // El nombre definitivo, calculado EN VIVO con las mismas reglas que el
  // servidor. Ensenarlo mientras se escribe evita la sorpresa de teclear
  // «Nivel Deposito 1» y que aparezca otra cosa en la tabla.
  const normalizado = useMemo(
    () =>
      nombre
        .trim()
        .toLowerCase()
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .replace(/^(\d)/, 'v_$1')
        .slice(0, 48),
    [nombre]
  );
  const repetido = existentes.includes(normalizado);
  const valido = normalizado.length > 0 && !repetido;

  const enviar = () => {
    if (!valido || ocupado) return;
    void onCrear({ nombre: normalizado, tipo, descripcion });
  };

  return (
    <div className="bg-siemens-50/40 px-4 py-3 dark:bg-siemens/5">
      <div className="flex flex-wrap items-end gap-3">
        <label className="min-w-[200px] flex-1">
          <span className="mb-1 block text-[10px] font-bold uppercase tracking-wider text-slate-400">
            Nombre
          </span>
          <input
            ref={campo}
            value={nombre}
            onChange={(e) => setNombre(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') enviar();
              if (e.key === 'Escape') onCancelar();
            }}
            placeholder="Nivel Depósito 1"
            className="w-full rounded-lg border border-slate-200 bg-white px-2.5 py-2 text-xs text-navy outline-none transition focus:border-siemens focus:ring-2 focus:ring-siemens/20 dark:border-navy-slate dark:bg-navy dark:text-slate-100"
          />
        </label>

        <label className="w-[150px]">
          <span className="mb-1 block text-[10px] font-bold uppercase tracking-wider text-slate-400">
            Tipo
          </span>
          <select
            value={tipo}
            onChange={(e) => setTipo(e.target.value as TipoInterna)}
            className="w-full cursor-pointer rounded-lg border border-slate-200 bg-white px-2.5 py-2 text-xs text-navy outline-none transition focus:border-siemens focus:ring-2 focus:ring-siemens/20 dark:border-navy-slate dark:bg-navy dark:text-slate-100"
          >
            {TIPOS_INTERNA.map((t) => (
              <option key={t.id} value={t.id}>{t.etiqueta}</option>
            ))}
          </select>
        </label>

        <label className="min-w-[220px] flex-[2]">
          <span className="mb-1 block text-[10px] font-bold uppercase tracking-wider text-slate-400">
            Descripción
          </span>
          <input
            value={descripcion}
            onChange={(e) => setDescripcion(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') enviar(); }}
            placeholder="Para qué sirve"
            className="w-full rounded-lg border border-slate-200 bg-white px-2.5 py-2 text-xs text-navy outline-none transition focus:border-siemens focus:ring-2 focus:ring-siemens/20 dark:border-navy-slate dark:bg-navy dark:text-slate-100"
          />
        </label>

        <button
          onClick={enviar}
          disabled={!valido || ocupado}
          className="flex min-h-[34px] items-center gap-1.5 rounded-lg bg-siemens px-3.5 py-2 text-xs font-semibold text-white transition hover:bg-siemens-600 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <PlusIcon className="h-3.5 w-3.5" />
          Crear
        </button>
        <button
          onClick={onCancelar}
          className="rounded-lg px-2 py-2 text-xs font-semibold text-slate-400 transition hover:text-slate-600"
        >
          Cancelar
        </button>
      </div>

      <p className="mt-2 text-[11px] text-slate-400">
        {repetido ? (
          <span className="font-semibold text-state-error">
            Ya existe una variable llamada «{normalizado}».
          </span>
        ) : normalizado ? (
          <>
            Se enlazará a los widgets como{' '}
            <span className="font-mono font-semibold text-siemens">
              {claveInterna(normalizado)}
            </span>
            {normalizado !== nombre.trim() && ' — el nombre se normaliza solo.'}
          </>
        ) : (
          TIPOS_INTERNA.find((t) => t.id === tipo)?.ayuda
        )}
      </p>
    </div>
  );
}

function Vacio({ onCrear }: { onCrear: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-16 text-center">
      <VariableIcon className="mb-3 h-10 w-10 text-slate-300 dark:text-slate-600" />
      <p className="text-sm font-semibold text-slate-500 dark:text-slate-300">
        Todavía no hay variables internas
      </p>
      <p className="mt-1 max-w-md text-xs leading-relaxed text-slate-400">
        No existen en ningún PLC: viven en el servidor y las ven todos los
        paneles. Sirven para probar una pantalla con la máquina apagada, para
        el estado propio del HMI y para compartir un valor entre pantallas.
      </p>
      <button
        onClick={onCrear}
        className="mt-5 flex items-center gap-1.5 rounded-lg bg-siemens px-3.5 py-2 text-xs font-semibold text-white transition hover:bg-siemens-600"
      >
        <PlusIcon className="h-3.5 w-3.5" />
        Crear la primera
      </button>
    </div>
  );
}

/** Banda de error o de aviso, con el mismo aire en los dos casos. */
function Banda({
  tono,
  children,
  onCerrar,
}: {
  tono: 'error' | 'aviso';
  children: React.ReactNode;
  onCerrar: () => void;
}) {
  const esError = tono === 'error';
  return (
    <div
      role="alert"
      className={`flex items-start gap-2 border-b px-4 py-2.5 text-xs leading-relaxed ${
        esError
          ? 'border-state-error/30 bg-state-error/5 text-state-error'
          : 'border-amber-300/40 bg-amber-50 text-amber-800 dark:bg-amber-500/10 dark:text-amber-200'
      }`}
    >
      {esError ? (
        <AlertCircleIcon className="mt-px h-3.5 w-3.5 shrink-0" />
      ) : (
        <InfoIcon className="mt-px h-3.5 w-3.5 shrink-0" />
      )}
      <span className="min-w-0 break-words">{children}</span>
      <button
        type="button"
        onClick={onCerrar}
        className="ml-auto shrink-0 rounded px-1.5 font-semibold underline-offset-2 hover:underline"
      >
        Ocultar
      </button>
    </div>
  );
}

/** Color de texto del icono, derivado de la insignia del tipo. */
function colorDe(insignia: string): string {
  const m = insignia.match(/text-[a-z]+-\d+/);
  return m ? m[0] : 'text-slate-400';
}
