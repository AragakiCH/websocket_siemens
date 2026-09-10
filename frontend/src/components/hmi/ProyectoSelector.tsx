// =========================================================================
// ProyectoSelector.tsx
// El selector de PROYECTO del Diseñador: la cabecera, arriba a la izquierda.
//
// QUÉ ES UN PROYECTO Y POR QUÉ NO ES UNA PESTAÑA MÁS
// Un proyecto agrupa pantallas: es un HMI distinto, con su numeración
// empezando por 1. Se cambia de proyecto pocas veces al día; de pantalla, a
// cada rato. Por eso las pantallas son pestañas —siempre visibles, un clic— y
// el proyecto es un desplegable: una segunda fila de pestañas se comería una
// franja de alto permanente para algo que casi nunca se toca, y con cinco
// proyectos ya se llenaría.
//
// El nombre del proyecto activo SÍ está siempre a la vista, junto al título.
// Es lo que contesta a "¿dónde estoy?" antes de arrastrar nada, y sin eso dos
// proyectos con pantallas parecidas son indistinguibles.
//
// LO QUE SE PUEDE Y LO QUE NO
//   crear / renombrar  -> rol Administradores
//   eliminar           -> rol Supervisor
//   el proyecto por defecto no se borra NUNCA (lo impide el backend: el
//   Diseñador necesita siempre uno al que volver)
//
// EXPORTAR E IMPORTAR
// Exportar baja un `.json` con el proyecto entero —pantallas, widgets y la
// definición de los widgets personalizados que use— para guardarlo donde uno
// quiera y llevárselo a otro equipo. Importar crea un proyecto NUEVO a partir
// de ese fichero: nunca sobrescribe lo que ya hay, así que reimportar el
// mismo fichero deja los dos, no pisa el primero.
//
// Borrar un proyecto SE LLEVA EL DISEÑO DE TODAS SUS PANTALLAS. Por eso el
// diálogo dice cuántas son y obliga a escribir el nombre: es el único botón
// de esta vista que puede tirar una tarde de trabajo, y no debe poder
// pulsarse de pasada.
// =========================================================================
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  FolderIcon,
  FolderPlusIcon,
  ChevronDownIcon,
  CheckIcon,
  PencilIcon,
  DownloadIcon,
  UploadIcon,
  Trash2Icon,
  AlertTriangleIcon,
  Loader2Icon,
} from 'lucide-react';
import { useAppStore } from '../../context/AppStore';
import {
  crearProyectoHmi,
  renombrarProyectoHmi,
  borrarProyectoHmi,
  descargarProyecto,
  leerFicheroDeProyecto,
  importarProyecto,
  PROYECTO_HMI_POR_DEFECTO,
} from '../../utils/proyectoStorage';
import { olvidarCache } from '../../utils/designStorage';

export function ProyectoSelector() {
  const {
    t,
    proyectos,
    proyectoId,
    proyectoActivo,
    abrirProyecto,
    refrescarProyectos,
    permisos,
  } = useAppStore();

  const [abierto, setAbierto] = useState(false);
  const [ocupado, setOcupado] = useState(false);
  const [error, setError] = useState('');
  // Un aviso de que algo SALIÓ BIEN. Hace falta uno propio porque importar
  // tiene cosas que contar aunque funcione: cuántas pantallas entraron, si
  // alguna se renombró y qué widgets ya estaban. Sin esto, el proyecto
  // aparecería con nombres distintos a los del fichero sin explicación.
  const [aviso, setAviso] = useState('');
  const ficheroRef = useRef<HTMLInputElement>(null);
  const [renombrando, setRenombrando] = useState<string | null>(null);
  const [borrar, setBorrar] = useState<{
    id: string;
    nombre: string;
    pantallas: number;
  } | null>(null);

  // `permisos === null` significa que el backend corre sin identidad: ahí
  // todo el mundo puede todo, que es el comportamiento de una instalación de
  // una sola persona.
  const puedeCrear = !permisos || permisos.editar_diseño;
  const puedeBorrar = !permisos || permisos.gestionar_usuarios;

  useEffect(() => {
    if (!error) return;
    const id = setTimeout(() => setError(''), 6000);
    return () => clearTimeout(id);
  }, [error]);

  // Más tiempo que el error: el resumen de una importación tiene varias
  // frases y se lee más despacio que un "no tienes permiso".
  useEffect(() => {
    if (!aviso) return;
    const id = setTimeout(() => setAviso(''), 12000);
    return () => clearTimeout(id);
  }, [aviso]);

  // Escape cierra el desplegable. Sin esto hay que ir a buscar el ratón para
  // salir de un menú que se abrió sin querer.
  useEffect(() => {
    if (!abierto) return;
    const alTeclear = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !renombrando) setAbierto(false);
    };
    window.addEventListener('keydown', alTeclear);
    return () => window.removeEventListener('keydown', alTeclear);
  }, [abierto, renombrando]);

  const conError = useCallback(async (fn: () => Promise<void>) => {
    setOcupado(true);
    setError('');
    setAviso('');
    try {
      await fn();
    } catch (e: any) {
      setError(mensajeDeError(e));
    } finally {
      setOcupado(false);
    }
  }, []);

  // ── Acciones ──────────────────────────────────────────────────
  const nuevoProyecto = () =>
    conError(async () => {
      const n = proyectos.length + 1;
      const creado = await crearProyectoHmi(
        `${t('projects.defaultName')} ${n}`,
        `${t('screens.defaultName')} 1`
      );
      await refrescarProyectos();
      abrirProyecto(creado.proyecto_id);
      // Se entra directo a renombrarlo: el nombre por defecto es un marcador
      // de posición, no una decisión.
      setRenombrando(creado.proyecto_id);
    });

  const aplicarNombre = (id: string, nombre: string) => {
    setRenombrando(null);
    const actual = proyectos.find((p) => p.proyecto_id === id);
    const limpio = nombre.trim();
    if (!limpio || limpio === actual?.nombre) return;
    void conError(async () => {
      await renombrarProyectoHmi(id, limpio);
      await refrescarProyectos();
    });
  };

  const exportar = (id: string, nombre: string) =>
    conError(async () => {
      const fichero = await descargarProyecto(id, nombre);
      setAviso(`${t('projects.exported')} ${fichero}`);
    });

  /**
   * Importar. El `value = ''` del final no es un detalle: sin él, elegir el
   * MISMO fichero dos veces seguidas no dispara `change` y parece que el
   * botón se ha quedado colgado.
   */
  const alElegirFichero = (e: React.ChangeEvent<HTMLInputElement>) => {
    const archivo = e.target.files?.[0];
    e.target.value = '';
    if (!archivo) return;
    void conError(async () => {
      const doc = await leerFicheroDeProyecto(archivo);
      const r = await importarProyecto(doc);
      await refrescarProyectos();
      abrirProyecto(r.proyecto_id);
      setAbierto(false);

      const partes = [
        `«${r.nombre}»: ${r.num_pantallas} ${t('projects.importedScreens')}.`,
      ];
      const renombradas = Object.keys(r.renombradas).length;
      if (renombradas > 0) {
        partes.push(`${renombradas} ${t('projects.importedRenamed')}`);
      }
      if (r.widgets_importados.length > 0) {
        partes.push(
          `${r.widgets_importados.length} ${t('projects.importedWidgets')}`
        );
      }
      if (r.widgets_ya_existentes.length > 0) {
        partes.push(
          `${r.widgets_ya_existentes.length} ${t('projects.importedWidgetsKept')}`
        );
      }
      setAviso(partes.join(' '));
    });
  };

  const confirmarBorrado = () => {
    if (!borrar) return;
    const id = borrar.id;
    setBorrar(null);
    void conError(async () => {
      const pantallasBorradas = await borrarProyectoHmi(id);
      // Sus diseños ya no existen en ningún servidor: dejar la caché local
      // los haría reaparecer en el siguiente arranque como fantasmas.
      pantallasBorradas.forEach(olvidarCache);
      await refrescarProyectos();
      // El WebSocket también avisa, pero no se espera a él: quien pulsó
      // Eliminar tiene que ver el efecto ya.
      if (id === proyectoId) abrirProyecto(PROYECTO_HMI_POR_DEFECTO);
    });
  };

  const nombreActivo =
    proyectoActivo?.nombre ?? proyectoId ?? t('projects.none');

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setAbierto((v) => !v)}
        aria-expanded={abierto}
        aria-haspopup="menu"
        title={t('projects.switchHint')}
        className={`flex items-center gap-1.5 rounded-lg border py-1 pl-2 pr-1.5 text-xs font-semibold outline-none transition focus-visible:ring-2 focus-visible:ring-siemens/40 ${
          abierto
            ? 'border-siemens/40 bg-siemens-50 text-siemens dark:border-siemens/30 dark:bg-siemens/15 dark:text-siemens-200'
            : 'border-slate-200 bg-slate-50 text-navy hover:border-siemens/30 hover:bg-white dark:border-navy-slate dark:bg-navy dark:text-slate-100 dark:hover:bg-navy-slate'
        }`}
      >
        <FolderIcon className="h-3.5 w-3.5 shrink-0 text-siemens" />
        {/* Ancho máximo: sin él, un proyecto con nombre largo empuja las
            pestañas del Diseñador fuera de sitio. */}
        <span className="max-w-[150px] truncate">{nombreActivo}</span>
        {proyectoActivo && (
          <span className="rounded bg-slate-200/70 px-1 text-[10px] tabular-nums text-slate-500 dark:bg-navy-slate/70 dark:text-slate-400">
            {proyectoActivo.num_pantallas}
          </span>
        )}
        {ocupado ? (
          <Loader2Icon className="h-3 w-3 shrink-0 animate-spin text-slate-400" />
        ) : (
          <ChevronDownIcon
            className={`h-3 w-3 shrink-0 text-slate-400 transition-transform ${
              abierto ? 'rotate-180' : ''
            }`}
          />
        )}
      </button>

      {abierto && (
        <>
          {/* Capa que cierra al pulsar fuera. Va detrás del menú (z-40 vs
              z-50) para que los clics dentro sigan llegando. */}
          <div className="fixed inset-0 z-40" onClick={() => setAbierto(false)} />

          <div
            role="menu"
            className="absolute left-0 top-full z-50 mt-1.5 w-80 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-xl dark:border-navy-slate dark:bg-navy-soft"
          >
            <p className="px-3 pb-1 pt-2 text-[10px] font-bold uppercase tracking-wide text-slate-400">
              {t('projects.title')}
            </p>

            <div className="mp-scroll mp-scroll-dark max-h-[300px] overflow-y-auto py-0.5">
              {proyectos.map((p) => {
                const activo = p.proyecto_id === proyectoId;
                const editando = renombrando === p.proyecto_id;
                const esPorDefecto = p.proyecto_id === PROYECTO_HMI_POR_DEFECTO;

                if (editando) {
                  return (
                    <div key={p.proyecto_id} className="px-2 py-1">
                      <EntradaNombre
                        inicial={p.nombre}
                        onAceptar={(v) => aplicarNombre(p.proyecto_id, v)}
                        onCancelar={() => setRenombrando(null)}
                      />
                    </div>
                  );
                }

                return (
                  <div
                    key={p.proyecto_id}
                    className={`group flex items-center transition-colors ${
                      activo
                        ? 'bg-siemens-50 dark:bg-siemens/15'
                        : 'hover:bg-slate-50 dark:hover:bg-navy-slate/50'
                    }`}
                  >
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        abrirProyecto(p.proyecto_id);
                        setAbierto(false);
                      }}
                      title={`${p.nombre} · ${p.proyecto_id}`}
                      className="flex min-w-0 flex-1 items-center gap-2 py-2 pl-3 pr-1 text-left text-xs outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-siemens/40"
                    >
                      <CheckIcon
                        className={`h-3.5 w-3.5 shrink-0 ${
                          activo ? 'text-siemens' : 'text-transparent'
                        }`}
                      />
                      <span
                        className={`min-w-0 flex-1 truncate ${
                          activo
                            ? 'font-semibold text-siemens dark:text-siemens-200'
                            : 'text-slate-600 dark:text-slate-300'
                        }`}
                      >
                        {p.nombre}
                      </span>
                      {/* Cuántas pantallas tiene. Con cuatro proyectos es lo
                          que distingue el que estás montando del que abriste
                          para probar y dejaste con una. */}
                      <span className="shrink-0 rounded-full bg-slate-200/70 px-1.5 text-[10px] tabular-nums text-slate-400 dark:bg-navy-slate/60">
                        {p.num_pantallas}
                      </span>
                    </button>

                    <div className="flex shrink-0 items-center pr-1.5">
                      {/* Exportar no exige rol: es leer el diseño, que
                          cualquiera con acceso a la vista ya puede hacer. */}
                      <button
                        type="button"
                        disabled={ocupado}
                        onClick={() => void exportar(p.proyecto_id, p.nombre)}
                        title={t('projects.export')}
                        aria-label={`${t('projects.export')}: ${p.nombre}`}
                        className="flex h-6 w-6 items-center justify-center rounded text-slate-400 opacity-0 outline-none transition hover:bg-white hover:text-siemens focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-siemens/40 disabled:cursor-not-allowed group-hover:opacity-100 dark:hover:bg-navy-slate"
                      >
                        <DownloadIcon className="h-3 w-3" />
                      </button>
                      {puedeCrear && (
                        <button
                          type="button"
                          onClick={() => setRenombrando(p.proyecto_id)}
                          title={t('projects.rename')}
                          aria-label={`${t('projects.rename')}: ${p.nombre}`}
                          className="flex h-6 w-6 items-center justify-center rounded text-slate-400 opacity-0 outline-none transition hover:bg-white hover:text-siemens focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-siemens/40 group-hover:opacity-100 dark:hover:bg-navy-slate"
                        >
                          <PencilIcon className="h-3 w-3" />
                        </button>
                      )}
                      {puedeBorrar && (
                        <button
                          type="button"
                          disabled={esPorDefecto || ocupado}
                          onClick={() =>
                            setBorrar({
                              id: p.proyecto_id,
                              nombre: p.nombre,
                              pantallas: p.num_pantallas,
                            })
                          }
                          title={
                            esPorDefecto
                              ? t('projects.cantDeleteMain')
                              : t('projects.delete')
                          }
                          aria-label={`${t('projects.delete')}: ${p.nombre}`}
                          className={`flex h-6 w-6 items-center justify-center rounded outline-none transition focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-siemens/40 ${
                            esPorDefecto
                              ? 'cursor-not-allowed text-slate-300 opacity-0 group-hover:opacity-60 dark:text-slate-600'
                              : 'text-slate-400 opacity-0 hover:bg-red-50 hover:text-state-error group-hover:opacity-100 dark:hover:bg-state-error/10'
                          }`}
                        >
                          <Trash2Icon className="h-3 w-3" />
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}

              {proyectos.length === 0 && (
                <p className="px-3 py-3 text-xs text-slate-400">
                  {t('projects.loading')}
                </p>
              )}
            </div>

            {puedeCrear && (
              <div className="flex border-t border-slate-200 dark:border-navy-slate">
                <button
                  type="button"
                  onClick={() => void nuevoProyecto()}
                  disabled={ocupado}
                  className="flex flex-1 items-center gap-2 px-3 py-2.5 text-xs font-semibold text-slate-500 outline-none transition hover:bg-slate-50 hover:text-siemens focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-siemens/40 disabled:cursor-not-allowed disabled:opacity-40 dark:hover:bg-navy-slate/50"
                >
                  <FolderPlusIcon className="h-3.5 w-3.5" />
                  {t('projects.new')}
                </button>

                {/* Importar va aquí, al lado de Crear, porque las dos
                    responden a lo mismo: "quiero un proyecto que ahora no
                    tengo". Una lo hace vacío y la otra desde un fichero. */}
                <button
                  type="button"
                  onClick={() => ficheroRef.current?.click()}
                  disabled={ocupado}
                  title={t('projects.importHint')}
                  className="flex items-center gap-2 border-l border-slate-200 px-3 py-2.5 text-xs font-semibold text-slate-500 outline-none transition hover:bg-slate-50 hover:text-siemens focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-siemens/40 disabled:cursor-not-allowed disabled:opacity-40 dark:border-navy-slate dark:hover:bg-navy-slate/50"
                >
                  <UploadIcon className="h-3.5 w-3.5" />
                  {t('projects.import')}
                </button>
              </div>
            )}
          </div>
        </>
      )}

      {/* El input vive FUERA del desplegable: si estuviera dentro, cerrar el
          menú mientras el diálogo del sistema está abierto lo desmontaría y
          el `change` no llegaría a ninguna parte. */}
      <input
        ref={ficheroRef}
        type="file"
        accept=".json,application/json"
        onChange={alElegirFichero}
        className="hidden"
      />

      {/* ── Aviso de que algo salió bien ─────────────────────── */}
      {aviso && !error && (
        <div
          role="status"
          className="absolute left-0 top-full z-50 mt-1.5 flex w-80 items-start gap-2 rounded-lg border border-siemens/30 bg-siemens-50 px-3 py-2 text-[11px] leading-relaxed text-siemens shadow-lg dark:bg-siemens/15 dark:text-siemens-200"
        >
          <CheckIcon className="mt-px h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0">{aviso}</span>
        </div>
      )}

      {/* ── Error ────────────────────────────────────────────── */}
      {error && (
        <div
          role="alert"
          className="absolute left-0 top-full z-50 mt-1.5 flex w-80 items-start gap-2 rounded-lg border border-state-error/20 bg-state-error/5 px-3 py-2 text-[11px] leading-relaxed text-state-error shadow-lg"
        >
          <AlertTriangleIcon className="mt-px h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0">{error}</span>
        </div>
      )}

      {borrar && (
        <ConfirmarBorrarProyecto
          nombre={borrar.nombre}
          pantallas={borrar.pantallas}
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

/** Renombrado en el sitio. Enter acepta, Escape cancela, salir acepta. */
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
      aria-label="Nombre del proyecto"
      className="w-full rounded-md border border-siemens bg-white px-2 py-1 text-xs font-semibold text-navy outline-none ring-2 ring-siemens/20 dark:bg-navy-soft dark:text-slate-100"
    />
  );
}

/**
 * Confirmación de borrado.
 *
 * Pide ESCRIBIR el nombre, que es más que lo que pide borrar una pantalla, y
 * a propósito: aquí no se pierde un diseño sino todos los del proyecto. Un
 * "¿Estás seguro?" con el botón rojo enfocado se contesta sin leerlo.
 */
function ConfirmarBorrarProyecto({
  nombre,
  pantallas,
  onCancelar,
  onConfirmar,
  t,
}: {
  nombre: string;
  pantallas: number;
  onCancelar: () => void;
  onConfirmar: () => void;
  t: (k: string) => string;
}) {
  const [escrito, setEscrito] = useState('');
  const coincide = escrito.trim() === nombre.trim();

  useEffect(() => {
    const alTeclear = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancelar();
    };
    window.addEventListener('keydown', alTeclear);
    return () => window.removeEventListener('keydown', alTeclear);
  }, [onCancelar]);

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-navy/50 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="borrar-proyecto-titulo"
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
            id="borrar-proyecto-titulo"
            className="text-sm font-bold text-navy dark:text-slate-100"
          >
            {t('projects.deleteTitle')}
          </h2>
        </div>

        <p className="mb-3 text-[13px] leading-relaxed text-slate-500 dark:text-slate-400">
          {t('projects.deleteBody1')}{' '}
          <b className="font-semibold text-navy dark:text-slate-200">{nombre}</b>{' '}
          {t('projects.deleteBody2')}{' '}
          <b className="font-semibold text-state-error">
            {pantallas} {t('projects.deleteScreens')}
          </b>
          {t('projects.deleteBody3')}
        </p>

        <label className="mb-1.5 block text-[11px] font-semibold text-slate-500 dark:text-slate-400">
          {t('projects.deleteTypeName')}
        </label>
        <input
          type="text"
          autoFocus
          value={escrito}
          onChange={(e) => setEscrito(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && coincide) onConfirmar();
          }}
          placeholder={nombre}
          className="mb-4 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-navy outline-none focus-visible:ring-2 focus-visible:ring-state-error/40 dark:border-navy-slate dark:bg-navy dark:text-slate-100"
        />

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancelar}
            className="rounded-lg px-3 py-2 text-xs font-semibold text-slate-500 outline-none transition hover:bg-slate-100 focus-visible:ring-2 focus-visible:ring-siemens/40 dark:hover:bg-navy-slate/40"
          >
            {t('projects.cancel')}
          </button>
          <button
            type="button"
            disabled={!coincide}
            onClick={onConfirmar}
            className="rounded-lg bg-state-error px-3 py-2 text-xs font-semibold text-white outline-none transition hover:brightness-110 focus-visible:ring-2 focus-visible:ring-state-error/50 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {t('projects.deleteConfirm')}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Traduce el error del backend a algo accionable. */
function mensajeDeError(e: any): string {
  const status = e?.status;
  if (status === 403) {
    return 'Tu categoría no permite esta acción. Crear y renombrar proyectos ' +
      'exige rol Administradores; eliminarlos, Supervisor.';
  }
  if (status === 400) {
    return e?.message || 'El proyecto por defecto no se puede borrar.';
  }
  return e?.message || 'No se pudo completar la operación.';
}
