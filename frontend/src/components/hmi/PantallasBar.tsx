// =========================================================================
// PantallasBar.tsx
// Barra de pestañas de las PANTALLAS del HMI, dentro del Diseñador.
//
// UNA PANTALLA ES UN PROYECTO DEL BACKEND
// No hay un modelo nuevo: cada pestaña es un documento de `/proyectos/<id>`.
// Esa decisión no es de comodidad, es lo que hace que funcione el resto:
//
//   * el lápiz de edición ya es POR RECURSO (`designer:<project_id>`), así
//     que dos personas pueden editar dos pantallas a la vez sin estorbarse;
//   * el control de versiones (409) también es por pantalla;
//   * el `project.updated` del WebSocket ya viaja con su `project_id`, así
//     que cada cliente sabe si el cambio le toca o no.
//
// Todo eso ya estaba escrito. Aquí solo se le pone una interfaz encima.
//
// LO QUE SE PUEDE Y LO QUE NO
//   crear / renombrar / duplicar  -> rol Administradores
//   eliminar                      -> rol Supervisor
//   `principal`                   -> no se borra NUNCA (lo impide el backend:
//                                    la vista siempre necesita una que abrir)
//
// Renombrar exige además tener el LÁPIZ de esa pantalla, porque sube su
// versión: si lo hiciera alguien de fuera, quien está editando recibiría un
// 409 al guardar sin haber tocado nada.
// =========================================================================
import { useCallback, useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence, useReducedMotion } from 'framer-motion';
import {
  PlusIcon,
  XIcon,
  CopyIcon,
  MonitorIcon,
  AlertTriangleIcon,
  Loader2Icon,
} from 'lucide-react';
import { useAppStore } from '../../context/AppStore';
import {
  crearPantalla,
  duplicarPantalla,
  renombrarPantalla,
  borrarPantalla,
  PROYECTO_POR_DEFECTO,
} from '../../utils/designStorage';

interface Props {
  /** Si esta persona tiene el lápiz de la pantalla activa. */
  puedeEditar: boolean;
}

export function PantallasBar({ puedeEditar }: Props) {
  const {
    t,
    pantallas,
    projectId,
    pantallaCargada,
    abrirPantalla,
    refrescarPantallas,
    setProjectVersion,
    permisos,
  } = useAppStore();

  const sinMovimiento = useReducedMotion();
  const [ocupado, setOcupado] = useState(false);
  const [error, setError] = useState('');
  const [renombrando, setRenombrando] = useState<string | null>(null);
  const [borrar, setBorrar] = useState<{ id: string; nombre: string } | null>(null);
  const barraRef = useRef<HTMLDivElement>(null);

  // `permisos === null` significa que el backend corre sin identidad
  // (`auth_requerida=false`): ahí todo el mundo puede todo, que es el
  // comportamiento histórico y el de una instalación de una sola persona.
  const puedeCrear = !permisos || permisos.editar_diseño;
  const puedeBorrar = !permisos || permisos.gestionar_usuarios;

  // Un error de permisos o de red se muestra unos segundos y se va solo: es
  // información puntual, no un estado en el que haya que quedarse.
  useEffect(() => {
    if (!error) return;
    const id = setTimeout(() => setError(''), 6000);
    return () => clearTimeout(id);
  }, [error]);

  const conError = useCallback(async (fn: () => Promise<void>) => {
    setOcupado(true);
    setError('');
    try {
      await fn();
    } catch (e: any) {
      setError(mensajeDeError(e));
    } finally {
      setOcupado(false);
    }
  }, []);

  // ── Acciones ──────────────────────────────────────────────────
  const nuevaPantalla = () =>
    conError(async () => {
      const n = pantallas.length + 1;
      const creada = await crearPantalla(`${t('screens.defaultName')} ${n}`);
      await refrescarPantallas();
      abrirPantalla(creada.project_id);
      // Se entra directo a renombrarla: el nombre por defecto es un marcador
      // de posición, no una decisión, y pedirlo en un diálogo aparte antes de
      // ver la pantalla es una fricción que no compra nada.
      setRenombrando(creada.project_id);
    });

  const duplicar = () =>
    conError(async () => {
      const actual = pantallas.find((p) => p.project_id === projectId);
      const copia = await duplicarPantalla(
        projectId,
        `${actual?.nombre ?? projectId} ${t('screens.copySuffix')}`
      );
      await refrescarPantallas();
      abrirPantalla(copia.project_id);
    });

  const confirmarBorrado = () => {
    if (!borrar) return;
    const id = borrar.id;
    setBorrar(null);
    void conError(async () => {
      await borrarPantalla(id);
      await refrescarPantallas();
      // El WebSocket también avisa, pero no se espera a él: quien pulsó
      // Eliminar tiene que ver el efecto ya, no dentro de un instante.
      if (id === projectId) abrirPantalla(PROYECTO_POR_DEFECTO);
    });
  };

  const aplicarNombre = (id: string, nombre: string) => {
    setRenombrando(null);
    const actual = pantallas.find((p) => p.project_id === id);
    const limpio = nombre.trim();
    if (!limpio || limpio === actual?.nombre) return;
    void conError(async () => {
      const v = await renombrarPantalla(id, limpio);
      if (id === projectId) setProjectVersion(v);
      await refrescarPantallas();
    });
  };

  return (
    <div className="relative border-b border-slate-200 bg-slate-50 dark:border-navy-slate dark:bg-navy">
      <div className="flex items-stretch gap-1 px-2">

        {/* ── Las pestañas ────────────────────────────────── */}
        <div
          ref={barraRef}
          role="tablist"
          aria-label={t('screens.barLabel')}
          className="mp-scroll mp-scroll-dark flex min-w-0 flex-1 items-stretch gap-1 overflow-x-auto py-1.5"
        >
          <AnimatePresence initial={false}>
            {pantallas.map((p) => {
              const activa = p.project_id === projectId;
              const editando = renombrando === p.project_id;
              // Solo se renombra la pantalla ACTIVA y con el lápiz en la mano:
              // el PATCH sube la versión y el backend exige el lock.
              const renombrable = activa && puedeEditar && puedeCrear;
              const esPrincipal = p.project_id === PROYECTO_POR_DEFECTO;

              return (
                <motion.div
                  key={p.project_id}
                  layout={!sinMovimiento}
                  initial={sinMovimiento ? undefined : { opacity: 0, y: -6 }}
                  animate={sinMovimiento ? undefined : { opacity: 1, y: 0 }}
                  exit={sinMovimiento ? undefined : { opacity: 0, scale: 0.96 }}
                  transition={{ duration: 0.16 }}
                  className={`group flex shrink-0 items-center rounded-lg border transition-colors ${
                    activa
                      ? 'border-siemens/40 bg-white shadow-sm dark:border-siemens/30 dark:bg-navy-soft'
                      : 'border-transparent hover:bg-white/70 dark:hover:bg-navy-soft/60'
                  }`}
                >
                  {editando ? (
                    <EntradaNombre
                      inicial={p.nombre}
                      onAceptar={(v) => aplicarNombre(p.project_id, v)}
                      onCancelar={() => setRenombrando(null)}
                    />
                  ) : (
                    <button
                      type="button"
                      role="tab"
                      aria-selected={activa}
                      onClick={() => abrirPantalla(p.project_id)}
                      onDoubleClick={() =>
                        renombrable && setRenombrando(p.project_id)
                      }
                      title={
                        renombrable
                          ? t('screens.renameHint')
                          : `${p.nombre} · ${p.project_id}`
                      }
                      className={`flex min-h-[32px] max-w-[220px] items-center gap-2 rounded-lg pl-3 pr-2 text-xs font-semibold outline-none transition-colors focus-visible:ring-2 focus-visible:ring-siemens/40 ${
                        activa
                          ? 'text-navy dark:text-slate-100'
                          : 'text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200'
                      }`}
                    >
                      <MonitorIcon
                        className={`h-3.5 w-3.5 shrink-0 ${
                          activa ? 'text-siemens' : 'text-slate-400'
                        }`}
                      />
                      <span className="truncate">{p.nombre}</span>

                      {/* El contador dice si la pantalla tiene algo dentro.
                          Con seis pestañas es la diferencia entre encontrar la
                          que buscas y abrirlas todas una por una. */}
                      <span
                        className={`shrink-0 rounded-full px-1.5 text-[10px] tabular-nums ${
                          activa
                            ? 'bg-siemens-50 text-siemens dark:bg-siemens/20 dark:text-siemens-200'
                            : 'bg-slate-200/70 text-slate-400 dark:bg-navy-slate/60'
                        }`}
                      >
                        {p.num_widgets}
                      </span>

                      {/* Indicador de carga: al cambiar de pestaña hay un
                          instante en que los widgets todavía son los de la
                          anterior. Decirlo evita que parezca que no pasó nada. */}
                      {activa && pantallaCargada !== projectId && (
                        <Loader2Icon className="h-3 w-3 shrink-0 animate-spin text-slate-400" />
                      )}
                    </button>
                  )}

                  {/* Cerrar = eliminar. `principal` no se puede borrar, y en
                      vez de esconder el botón se deshabilita explicando por
                      qué: un control que desaparece sin motivo confunde más. */}
                  {!editando && puedeBorrar && (
                    <button
                      type="button"
                      disabled={esPrincipal || ocupado}
                      onClick={() =>
                        setBorrar({ id: p.project_id, nombre: p.nombre })
                      }
                      title={
                        esPrincipal
                          ? t('screens.cantDeleteMain')
                          : t('screens.delete')
                      }
                      aria-label={`${t('screens.delete')}: ${p.nombre}`}
                      className={`mr-1 flex h-6 w-6 shrink-0 items-center justify-center rounded outline-none transition focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-siemens/40 ${
                        activa ? 'opacity-60' : 'opacity-0 group-hover:opacity-60'
                      } ${
                        esPrincipal
                          ? 'cursor-not-allowed text-slate-300 dark:text-slate-600'
                          : 'text-slate-400 hover:bg-red-50 hover:text-state-error hover:opacity-100 dark:hover:bg-state-error/10'
                      }`}
                    >
                      <XIcon className="h-3.5 w-3.5" />
                    </button>
                  )}
                </motion.div>
              );
            })}
          </AnimatePresence>

          {/* ── Nueva pantalla ──────────────────────────────
              Vive DENTRO de la tira, pegado a la última pestaña, y no en
              el bloque de acciones de la derecha. Es donde se busca: la
              pestaña nueva va a salir justo ahí, así que el botón que la
              crea señala el hueco que va a ocupar. Al otro lado de la
              barra había que cruzar la pantalla entera para volver.

              Solo el icono: al lado de pestañas con nombre, una palabra
              más se leería como otra pestaña. */}
          {puedeCrear &&
          <button
            type="button"
            onClick={nuevaPantalla}
            disabled={ocupado}
            title={t('screens.new')}
            aria-label={t('screens.new')}
            className="flex h-[32px] w-[32px] shrink-0 items-center justify-center self-center rounded-lg text-slate-400 outline-none transition hover:bg-white hover:text-siemens focus-visible:ring-2 focus-visible:ring-siemens/40 disabled:cursor-not-allowed disabled:opacity-40 dark:hover:bg-navy-soft">
              {ocupado ?
            <Loader2Icon className="h-4 w-4 animate-spin" /> :
            <PlusIcon className="h-4 w-4" />
            }
            </button>
          }
        </div>

        {/* ── Acciones ─────────────────────────────────────── */}
        {puedeCrear && (
          <div className="flex shrink-0 items-center gap-1 border-l border-slate-200 py-1.5 pl-2 dark:border-navy-slate">
            <button
              type="button"
              onClick={duplicar}
              disabled={ocupado || pantallas.length === 0}
              title={t('screens.duplicateHint')}
              className="flex h-[32px] items-center gap-1.5 rounded-lg px-2.5 text-xs font-semibold text-slate-500 outline-none transition hover:bg-white hover:text-siemens focus-visible:ring-2 focus-visible:ring-siemens/40 disabled:cursor-not-allowed disabled:opacity-40 dark:hover:bg-navy-soft"
            >
              <CopyIcon className="h-3.5 w-3.5" />
              <span className="hidden lg:inline">{t('screens.duplicate')}</span>
            </button>
          </div>
        )}
      </div>

      {/* ── Error ──────────────────────────────────────────── */}
      {error && (
        <div
          role="alert"
          className="flex items-start gap-2 border-t border-state-error/20 bg-state-error/5 px-4 py-2 text-[11px] leading-relaxed text-state-error"
        >
          <AlertTriangleIcon className="mt-px h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0">{error}</span>
        </div>
      )}

      {/* ── Confirmación de borrado ────────────────────────── */}
      {borrar && (
        <ConfirmarBorrarPantalla
          nombre={borrar.nombre}
          onCancelar={() => setBorrar(null)}
          onConfirmar={confirmarBorrado}
          t={t}
        />
      )}
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════
// Piezas
// ═════════════════════════════════════════════════════════════════

/**
 * Renombrado en el sitio.
 *
 * Enter acepta, Escape cancela y salir del campo acepta también — que es lo
 * que espera cualquiera que haya renombrado una pestaña o un archivo. El
 * `select()` inicial permite escribir el nombre nuevo de una sin borrar antes.
 */
function EntradaNombre({
  inicial,
  onAceptar,
  onCancelar,
}: {
  inicial: string;
  onAceptar: (v: string) => void;
  onCancelar: () => void;
}) {
  const [valor, setValor] = useState(inicial);
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);

  return (
    <input
      ref={ref}
      type="text"
      value={valor}
      maxLength={80}
      onChange={(e) => setValor(e.target.value)}
      onBlur={() => onAceptar(valor)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          onAceptar(valor);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          onCancelar();
        }
      }}
      aria-label="Nombre de la pantalla"
      className="mx-1 my-0.5 w-40 rounded-md border border-siemens bg-white px-2 py-1 text-xs font-semibold text-navy outline-none ring-2 ring-siemens/20 dark:bg-navy-soft dark:text-slate-100"
    />
  );
}

/**
 * Diálogo de confirmación.
 *
 * Dice qué se va a perder y que no hay vuelta atrás, en vez de un "¿Estás
 * seguro?" que no informa de nada. Borrar una pantalla se lleva su diseño
 * entero del servidor.
 */
function ConfirmarBorrarPantalla({
  nombre,
  onCancelar,
  onConfirmar,
  t,
}: {
  nombre: string;
  onCancelar: () => void;
  onConfirmar: () => void;
  t: (k: string) => string;
}) {
  useEffect(() => {
    const alTeclear = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancelar();
    };
    window.addEventListener('keydown', alTeclear);
    return () => window.removeEventListener('keydown', alTeclear);
  }, [onCancelar]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-navy/50 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="borrar-pantalla-titulo"
      onClick={onCancelar}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-sm rounded-xl border border-slate-200 bg-white p-5 shadow-card dark:border-navy-slate dark:bg-navy-soft"
      >
        <div className="mb-3 flex items-center gap-2.5">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-state-error/10 text-state-error">
            <AlertTriangleIcon className="h-4 w-4" />
          </span>
          <h2
            id="borrar-pantalla-titulo"
            className="text-sm font-bold text-navy dark:text-slate-100"
          >
            {t('screens.deleteTitle')}
          </h2>
        </div>

        <p className="mb-5 text-[13px] leading-relaxed text-slate-500 dark:text-slate-400">
          {t('screens.deleteBody1')} <b className="font-semibold text-navy dark:text-slate-200">{nombre}</b>
          {t('screens.deleteBody2')}
        </p>

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancelar}
            className="rounded-lg px-3 py-2 text-xs font-semibold text-slate-500 outline-none transition hover:bg-slate-100 focus-visible:ring-2 focus-visible:ring-siemens/40 dark:hover:bg-navy-slate/40"
          >
            {t('screens.cancel')}
          </button>
          <button
            type="button"
            autoFocus
            onClick={onConfirmar}
            className="rounded-lg bg-state-error px-3 py-2 text-xs font-semibold text-white outline-none transition hover:brightness-110 focus-visible:ring-2 focus-visible:ring-state-error/50"
          >
            {t('screens.deleteConfirm')}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Traduce el error del backend a algo accionable.
 *
 * Los dos que se van a ver de verdad son el 403 (no tienes rol) y el 423 (otra
 * persona tiene el lápiz), y ninguno de los dos se entiende leyendo el JSON
 * crudo que devuelve FastAPI.
 */
function mensajeDeError(e: any): string {
  const status = e?.status;
  if (status === 403) {
    return 'Tu categoría no permite esta acción. Crear y renombrar pantallas ' +
      'exige rol Administradores; eliminarlas, Supervisor.';
  }
  if (status === 423) {
    return 'Otra persona tiene el control de edición de esta pantalla. ' +
      'Espera a que lo suelte o pide a un Supervisor que lo fuerce.';
  }
  if (status === 409) {
    return 'Otra persona guardó cambios mientras tanto. Vuelve a intentarlo.';
  }
  return e?.message || 'No se pudo completar la operación.';
}
