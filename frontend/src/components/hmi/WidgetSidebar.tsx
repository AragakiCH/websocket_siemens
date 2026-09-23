// =========================================================================
// WidgetSidebar.tsx
// La paleta del Diseñador: de dónde se arrastran los widgets al lienzo.
//
// LAS SECCIONES YA NO SON CUATRO FIJAS
// Eran un array escrito aquí mismo. Ahora vienen del servidor, por proyecto, y
// se pueden crear, renombrar y borrar (ver `services/categoriasApi.ts`). Las
// cuatro de fábrica siguen ahí y no se borran: los 28 widgets del código las
// declaran como suyas.
//
// AQUÍ SE AGRUPA POR `categoriaId`, NO POR `category`
// `category` es lo que DECLARA la definición del widget —la opinión de su
// autor— y `categoriaId` es dónde cae de verdad en ESTE proyecto, con la
// asignación ya aplicada. Agrupar por el primero ignoraría todo lo que el
// usuario haya movido.
//
// LAS CATEGORÍAS VACÍAS SE ENSEÑAN, Y NO ES UN DESCUIDO
// Antes se escondían (`if (items.length === 0) return null`). Con categorías
// creadas a mano eso las mata: una sección recién creada está vacía, así que
// desaparecería al instante y no habría dónde soltar el primer widget. Se
// pintan con su hueco punteado.
// =========================================================================
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useAutoScrollArrastre } from '../../hooks/useAutoScrollArrastre';
import {
  UploadIcon,
  Trash2Icon,
  AlertCircleIcon,
  CheckCircle2Icon,
  PlusIcon,
  PencilIcon,
  CheckIcon,
  XIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  RotateCcwIcon,
} from 'lucide-react';
import { getWidgetCatalog, CatalogItem } from './widgetCatalog';
import { useAppStore } from '../../context/AppStore';
import {
  parseWidgetZip,
  addZipWidget,
  removeZipWidget,
  loadZipWidgets,
  fullKind,
  EVENTO_WIDGETS,
} from '../../services/zipWidgetLoader';
import {
  cargarCategorias,
  categoriasDe,
  crearCategoria,
  renombrarCategoria,
  borrarCategoria,
  moverWidgets,
  reordenarCategorias,
  idCategoria,
  asignacionesDe,
  CATEGORIAS_BASE,
  EVENTO_CATEGORIAS,
  type Categoria,
} from '../../services/categoriasApi';

/** Lo que viaja en el arrastre. El lienzo del Diseñador lee esta misma clave. */
const TIPO_ARRASTRE = 'widget-kind';

/**
 * Y esta la que lleva una SECCIÓN cuando se arrastra para reordenar.
 *
 * Son dos claves distintas a propósito: el mismo `drop` recibe las dos cosas y
 * tiene que saber si le están soltando un widget (moverlo de sección) o una
 * sección (reordenar). Mirando `dataTransfer.types` se distingue sin heurística.
 * Además el lienzo solo escucha la primera, así que arrastrar una cabecera
 * hasta el lienzo no crea ningún widget.
 */
const TIPO_SECCION = 'psi-categoria';

/** Qué secciones están plegadas, por proyecto. Es comodidad de este navegador. */
const CLAVE_PLEGADAS = 'psi.hmi.categorias-plegadas';

function leerPlegadas(proyectoId: string): Set<string> {
  try {
    const bruto = JSON.parse(localStorage.getItem(CLAVE_PLEGADAS) || '{}');
    return new Set<string>(bruto[proyectoId] ?? []);
  } catch {
    // Sin localStorage (ventana privada, almacenamiento bloqueado) se ven
    // todas desplegadas, que es el estado útil. Nunca es motivo de error.
    return new Set();
  }
}

function guardarPlegadas(proyectoId: string, plegadas: Set<string>): void {
  try {
    const bruto = JSON.parse(localStorage.getItem(CLAVE_PLEGADAS) || '{}');
    bruto[proyectoId] = [...plegadas];
    localStorage.setItem(CLAVE_PLEGADAS, JSON.stringify(bruto));
  } catch {
    /* que no se pueda recordar no puede impedir plegarla ahora */
  }
}

export function WidgetSidebar() {
  const { t, widgetLabel, proyectoId } = useAppStore();
  const fileRef = useRef<HTMLInputElement>(null);
  const [catalog, setCatalog] = useState(() => getWidgetCatalog());
  const [categorias, setCategorias] = useState<Categoria[]>(() => categoriasDe());
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null);

  // Qué sección está resaltada porque hay algo encima arrastrándose.
  const [encima, setEncima] = useState<string | null>(null);
  // Qué secciones están plegadas, y cuál se está arrastrando para reordenar.
  const [plegadas, setPlegadas] = useState<Set<string>>(() => new Set());
  const arrastrando = useRef<string | null>(null);

  // ── ARRASTRAR HASTA UNA CATEGORÍA QUE NO SE VE ──
  //
  // El catálogo es más alto que el panel: con las cuatro secciones abiertas,
  // «Datos» queda fuera de pantalla. Y el arrastre nativo del navegador no
  // desplaza nada por su cuenta, así que llevar un widget de abajo del todo a
  // «Básicos» era imposible — al llegar al borde el ratón se salía y el
  // arrastre se cancelaba.
  //
  // Es el MISMO hook que usa la barra de pestañas, en el otro eje. Ver
  // `hooks/useAutoScrollArrastre.ts`.
  const autoScroll = useAutoScrollArrastre<HTMLElement>('y');
  // Qué categoría se está renombrando, y con qué texto.
  const [editando, setEditando] = useState<string | null>(null);
  const [borrador, setBorrador] = useState('');
  // La de crear, que es su propio campo.
  const [creando, setCreando] = useState(false);
  // Segundo clic del borrado: `null` o el id que espera confirmación.
  const [confirmando, setConfirmando] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);

  // El catálogo se recalcula ENTERO, no solo las categorías: `categoriaId` se
  // resuelve al construirlo, así que mover un widget sin rehacerlo dejaría la
  // paleta enseñándolo donde estaba.
  const refrescar = useCallback(() => {
    setCatalog(getWidgetCatalog());
    setCategorias(categoriasDe());
  }, []);

  // Cambios que llegan de FUERA de este panel: importar un proyecto trae sus
  // widgets, y otro usuario puede crear una categoría desde otra pantalla.
  useEffect(() => {
    window.addEventListener(EVENTO_WIDGETS, refrescar);
    window.addEventListener(EVENTO_CATEGORIAS, refrescar);
    return () => {
      window.removeEventListener(EVENTO_WIDGETS, refrescar);
      window.removeEventListener(EVENTO_CATEGORIAS, refrescar);
    };
  }, [refrescar]);

  // Al abrir, y cada vez que se cambia de proyecto: las secciones son de cada
  // uno. Sin esto, abrir otro proyecto seguiría enseñando las del anterior.
  useEffect(() => {
    void cargarCategorias(proyectoId);
    setPlegadas(leerPlegadas(proyectoId));
    setEditando(null);
    setCreando(false);
    setConfirmando(null);
  }, [proyectoId]);

  const plegar = useCallback(
    (catId: string) => {
      setPlegadas((previas) => {
        const siguiente = new Set(previas);
        if (siguiente.has(catId)) siguiente.delete(catId);
        else siguiente.add(catId);
        guardarPlegadas(proyectoId, siguiente);
        return siguiente;
      });
    },
    [proyectoId]
  );

  const showToast = (msg: string, ok: boolean) => {
    setToast({ msg, ok });
    setTimeout(() => setToast(null), 3000);
  };

  /**
   * El nombre que se lee en la cabecera.
   *
   * Solo las cuatro de fábrica SIN renombrar pasan por el diccionario, porque
   * son las únicas con clave (`cat.Básicos`…). `t()` devuelve la clave cruda
   * cuando no la encuentra, así que una categoría «Paneles» se vería
   * literalmente como «cat.Paneles». Y si el usuario renombró «Datos» a
   * «Lecturas», manda lo suyo: traducirlo sería deshacérselo.
   */
  const etiqueta = useCallback(
    (c: Categoria): string => {
      const base = CATEGORIAS_BASE.find((b) => b.id === c.id);
      return base && base.nombre === c.nombre ? t(`cat.${c.nombre}`) : c.nombre;
    },
    [t]
  );

  const porCategoria = useMemo(() => {
    const mapa = new Map<string, CatalogItem[]>();
    for (const c of categorias) mapa.set(c.id, []);
    for (const w of catalog) {
      // Un widget cuya sección ya no existe no se pierde de vista: cae en la
      // primera, que siempre es Básicos. Un widget que no sale en la paleta
      // es, para quien lo busca, un widget roto.
      const destino = mapa.has(w.categoriaId) ? w.categoriaId : categorias[0]?.id;
      if (destino) mapa.get(destino)!.push(w);
    }
    return mapa;
  }, [catalog, categorias]);

  const handleUpload = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    // Limpiar el input para poder subir el mismo archivo otra vez
    e.target.value = '';
    try {
      const widget = await parseWidgetZip(file);
      // Se espera al guardado: si el servidor lo rechaza hay que decirlo,
      // no dejar creer que quedó guardado (se perdería al cerrar).
      await addZipWidget(widget);

      // LA SECCIÓN QUE DECLARA EL widget.json, SI NO EXISTE, SE CREA.
      //
      // Se compara por id —sin tildes ni mayúsculas— contra las que ya hay, y
      // por eso un ZIP que dice «paneles» teniendo ya «Paneles» NO crea una
      // segunda sección casi idéntica: cae en la de siempre. Los widgets
      // repartidos entre dos secciones que se leen igual es el fallo que esta
      // comparación existe para evitar.
      //
      // Y se AVISA cuando se crea. Sin el aviso, un typo en el widget.json
      // («Panelees») monta una sección nueva y nadie se entera hasta que ve
      // dos casi iguales y no sabe de dónde salió la segunda.
      const declarada = widget.meta.category;
      const idDeclarada = idCategoria(declarada);
      let creada = '';
      if (idDeclarada && !categoriasDe(proyectoId).some((c) => c.id === idDeclarada)) {
        const nueva = await crearCategoria(declarada, proyectoId);
        creada = nueva.nombre;
      }

      refrescar();
      showToast(
        creada
          ? `"${widget.meta.label}" cargado — se creó la categoría «${creada}»`
          : `"${widget.meta.label}" cargado`,
        true
      );
    } catch (err: any) {
      showToast(err?.message || 'Error al cargar el ZIP', false);
    }
  }, [refrescar, proyectoId]);

  const handleRemoveZip = useCallback(async (kind: string, label: string) => {
    await removeZipWidget(kind);
    refrescar();
    showToast(`"${label}" eliminado`, true);
  }, [refrescar]);

  // ── Mover un widget de sección ──────────────────────────────────
  const soltar = useCallback(
    async (destino: Categoria, e: React.DragEvent) => {
      e.preventDefault();
      setEncima(null);
      const kind = e.dataTransfer.getData(TIPO_ARRASTRE);
      if (!kind) return;

      // Soltarlo donde ya estaba no es un error, es que no pasa nada: se sale
      // sin gastar una petición ni enseñar un aviso que no dice nada.
      //
      // Se busca el item del catálogo en vez de usar el `kind` suelto porque
      // el `dataTransfer` devuelve texto plano y `widgetLabel` quiere un
      // `WidgetKind`. Y de paso se comprueba que ese widget siga existiendo:
      // se pudo borrar su ZIP a mitad del arrastre.
      const item = catalog.find((w) => w.kind === kind);
      if (!item || item.categoriaId === destino.id) return;

      try {
        await moverWidgets([{ kind: item.kind, categoria: destino.id }], proyectoId);
        refrescar();
        showToast(`«${widgetLabel(item.kind)}» → ${etiqueta(destino)}`, true);
      } catch (err: any) {
        showToast(err?.message || 'No se pudo mover el widget', false);
      }
    },
    [catalog, proyectoId, refrescar, widgetLabel, etiqueta]
  );

  // ── Reordenar las secciones ─────────────────────────────────────
  const reordenarSoltando = useCallback(
    async (destinoId: string) => {
      const origenId = arrastrando.current;
      arrastrando.current = null;
      if (!origenId || origenId === destinoId) return;

      // Se arma la lista ENTERA con el origen ya colocado en el hueco del
      // destino, y se manda así. Mandar «mueve el 3 al 1» obligaría al
      // servidor a compartir índices con un cliente que puede tener una lista
      // distinta; una lista de ids dice el resultado y no hay nada que
      // interpretar.
      const ids = categorias.map((c) => c.id).filter((id) => id !== origenId);
      const donde = ids.indexOf(destinoId);
      ids.splice(donde < 0 ? ids.length : donde, 0, origenId);

      try {
        await reordenarCategorias(ids, proyectoId);
        refrescar();
      } catch (err: any) {
        showToast(err?.message || 'No se pudo reordenar', false);
      }
    },
    [categorias, proyectoId, refrescar]
  );

  // ── Volver a la categoría del autor ─────────────────────────────
  const devolver = useCallback(
    async (w: CatalogItem) => {
      try {
        // `null`, no la categoría declarada: quitar la asignación es distinto
        // de asignarlo a donde su autor lo puso HOY. Si mañana se corrige el
        // widget.json, este widget se entera y el otro se habría quedado
        // clavado donde estaba.
        await moverWidgets([{ kind: w.kind, categoria: null }], proyectoId);
        refrescar();
        showToast(`«${widgetLabel(w.kind)}» volvió a «${w.category}»`, true);
      } catch (err: any) {
        showToast(err?.message || 'No se pudo devolver', false);
      }
    },
    [proyectoId, refrescar, widgetLabel]
  );

  // ── Crear / renombrar / borrar ──────────────────────────────────
  const guardarNombre = useCallback(async () => {
    const nombre = borrador.trim();
    if (!nombre) {
      setEditando(null);
      setCreando(false);
      return;
    }
    setOcupado(true);
    try {
      if (creando) {
        const c = await crearCategoria(nombre, proyectoId);
        showToast(`Categoría «${c.nombre}» creada`, true);
      } else if (editando) {
        const c = await renombrarCategoria(editando, nombre, proyectoId);
        showToast(`Ahora se llama «${c.nombre}»`, true);
      }
      setEditando(null);
      setCreando(false);
      setBorrador('');
      refrescar();
    } catch (err: any) {
      showToast(err?.message || 'No se pudo guardar', false);
    } finally {
      setOcupado(false);
    }
  }, [borrador, creando, editando, proyectoId, refrescar]);

  const quitar = useCallback(
    async (c: Categoria) => {
      setConfirmando(null);
      setOcupado(true);
      try {
        await borrarCategoria(c.id, proyectoId);
        showToast(`Categoría «${etiqueta(c)}» borrada`, true);
        refrescar();
      } catch (err: any) {
        // El 409 del servidor («todavía tiene N widgets dentro») llega aquí
        // tal cual y es justo lo que hay que leer: dice cuántos quedan.
        showToast(err?.message || 'No se pudo borrar', false);
      } finally {
        setOcupado(false);
      }
    },
    [proyectoId, refrescar, etiqueta]
  );

  // Qué widgets se movieron a mano: son los únicos que pueden «volver a la
  // del autor», y ofrecerle ese botón a uno que nunca se tocó sería ofrecer
  // deshacer algo que no se hizo.
  const asignados = asignacionesDe(proyectoId);

  // Identifica qué kinds son ZIP widgets para mostrar botón de eliminar
  const zipKinds: Set<string> = new Set(loadZipWidgets().map((z) => fullKind(z.meta.kind)));

  const CAMPO =
    'w-full rounded-md border border-siemens/50 bg-white px-2 py-1 text-[11px] text-navy outline-none focus:ring-2 focus:ring-siemens/25 dark:border-siemens/40 dark:bg-navy dark:text-slate-100';

  return (
    <aside
      ref={autoScroll.ref}
      // Va en el `aside` y no en cada sección porque es ESTE el que tiene el
      // scroll (`overflow-auto`). El manejador solo mide dónde está el
      // puntero; quién acepta el drop lo siguen decidiendo las secciones.
      //
      // Sin `onDragLeave`/`onDrop` el bucle seguiría corriendo después de
      // soltar: `dragover` deja de dispararse, pero el `requestAnimationFrame`
      // no se entera solo.
      onDragOver={autoScroll.vigilarBordes}
      onDragLeave={autoScroll.detener}
      onDrop={autoScroll.detener}
      className="mp-scroll mp-scroll-dark flex w-60 shrink-0 flex-col overflow-auto border-r border-slate-200 bg-white dark:border-navy-slate dark:bg-navy-soft"
    >
      <div className="border-b border-slate-100 px-4 py-3 dark:border-navy-slate">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-sm font-bold text-navy dark:text-slate-100">
              {t('sidebar.title')}
            </h2>
            <p className="text-xs text-slate-400">{t('sidebar.hint')}</p>
          </div>
          <button
            onClick={() => {
              setCreando(true);
              setEditando(null);
              setBorrador('');
            }}
            title="Nueva categoría"
            className="flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 transition hover:bg-siemens-50 hover:text-siemens dark:hover:bg-siemens/15"
          >
            <PlusIcon className="h-4 w-4" />
          </button>
          <button
            onClick={() => fileRef.current?.click()}
            title={t('sidebar.uploadZip')}
            className="flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 transition hover:bg-siemens-50 hover:text-siemens dark:hover:bg-siemens/15"
          >
            <UploadIcon className="h-4 w-4" />
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".zip"
            className="hidden"
            onChange={handleUpload}
          />
        </div>

        {creando && (
          <div className="mt-2 flex items-center gap-1">
            <input
              autoFocus
              value={borrador}
              disabled={ocupado}
              maxLength={32}
              placeholder="Nombre de la categoría"
              onChange={(e) => setBorrador(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void guardarNombre();
                else if (e.key === 'Escape') setCreando(false);
              }}
              className={CAMPO}
            />
            <button onClick={() => void guardarNombre()} title="Crear"
              className="shrink-0 rounded-md p-1 text-siemens hover:bg-siemens-50 dark:hover:bg-siemens/15">
              <CheckIcon className="h-3.5 w-3.5" />
            </button>
            <button onClick={() => setCreando(false)} title="Cancelar"
              className="shrink-0 rounded-md p-1 text-slate-400 hover:bg-slate-100 dark:hover:bg-navy">
              <XIcon className="h-3.5 w-3.5" />
            </button>
          </div>
        )}
      </div>

      <div className="p-3">
        {categorias.map((cat) => {
          const items = porCategoria.get(cat.id) ?? [];
          const resaltada = encima === cat.id;
          return (
            <div
              key={cat.id}
              // La zona de soltar es la SECCIÓN ENTERA, cabecera incluida: en
              // una categoría vacía no hay ninguna tarjeta sobre la que
              // apuntar, y en una llena obligar a acertar entre dos tarjetas
              // sería un juego de puntería.
              onDragOver={(e) => {
                // Dos cosas distintas pueden venir encima: un widget (moverlo
                // aquí) o otra sección (reordenar). Cualquier otra cosa —un
                // fichero del escritorio, texto de otra pestaña— no se acepta.
                const tipos = e.dataTransfer.types;
                if (!tipos.includes(TIPO_ARRASTRE) && !tipos.includes(TIPO_SECCION)) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                if (encima !== cat.id) setEncima(cat.id);
              }}
              onDragLeave={(e) => {
                // Solo cuando se sale de la sección de verdad. Sin esto, pasar
                // de la cabecera a una tarjeta de dentro apaga el resalte y
                // parece que se ha soltado el destino.
                if (!e.currentTarget.contains(e.relatedTarget as Node)) {
                  setEncima((s) => (s === cat.id ? null : s));
                }
              }}
              onDrop={(e) => {
                e.preventDefault();
                setEncima(null);
                if (e.dataTransfer.types.includes(TIPO_SECCION)) {
                  void reordenarSoltando(cat.id);
                } else {
                  void soltar(cat, e);
                }
              }}
              className={`mb-3 rounded-lg p-1 transition ${
                resaltada
                  ? 'bg-siemens-50 ring-2 ring-siemens/40 dark:bg-siemens/10'
                  : ''
              }`}
            >
              <div className="group/cab mb-2 flex items-center gap-1 px-1">
                {editando === cat.id ? (
                  <>
                    <input
                      autoFocus
                      value={borrador}
                      disabled={ocupado}
                      maxLength={32}
                      onChange={(e) => setBorrador(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') void guardarNombre();
                        else if (e.key === 'Escape') setEditando(null);
                      }}
                      className={CAMPO}
                    />
                    <button onClick={() => void guardarNombre()} title="Guardar"
                      className="shrink-0 rounded-md p-1 text-siemens hover:bg-siemens-50 dark:hover:bg-siemens/15">
                      <CheckIcon className="h-3.5 w-3.5" />
                    </button>
                    <button onClick={() => setEditando(null)} title="Cancelar"
                      className="shrink-0 rounded-md p-1 text-slate-400 hover:bg-slate-100 dark:hover:bg-navy">
                      <XIcon className="h-3.5 w-3.5" />
                    </button>
                  </>
                ) : confirmando === cat.id ? (
                  <>
                    <span className="flex-1 truncate text-[11px] font-semibold text-red-500">
                      ¿Borrar «{etiqueta(cat)}»?
                    </span>
                    <button onClick={() => void quitar(cat)} title="Sí, borrar"
                      className="shrink-0 rounded-md bg-red-500 px-1.5 py-0.5 text-[10px] font-semibold text-white hover:bg-red-600">
                      Sí
                    </button>
                    <button onClick={() => setConfirmando(null)} title="No"
                      className="shrink-0 rounded-md p-1 text-slate-400 hover:bg-slate-100 dark:hover:bg-navy">
                      <XIcon className="h-3.5 w-3.5" />
                    </button>
                  </>
                ) : (
                  <>
                    {/* La cabecera hace las dos cosas: se arrastra para
                        reordenar y se pulsa para plegar. Van juntas porque es
                        el único trozo de la sección que no es un widget, y
                        separarlas pediría dos agarres de cuatro píxeles. */}
                    <p
                      draggable
                      onDragStart={(e) => {
                        e.dataTransfer.setData(TIPO_SECCION, cat.id);
                        e.dataTransfer.effectAllowed = 'move';
                        arrastrando.current = cat.id;
                      }}
                      onDragEnd={() => {
                        arrastrando.current = null;
                        setEncima(null);
                        // `dragend` llega también cuando el arrastre se
                        // CANCELA (Escape, o soltar fuera de la ventana), que
                        // es justo cuando no hay ningún `drop` que pare el
                        // bucle.
                        autoScroll.detener();
                      }}
                      onClick={() => plegar(cat.id)}
                      title="Arrástrala para reordenar · púlsala para plegar"
                      className="flex flex-1 cursor-grab select-none items-center gap-1 truncate text-[11px] font-semibold uppercase tracking-wide text-slate-400 active:cursor-grabbing"
                    >
                      {plegadas.has(cat.id) ? (
                        <ChevronRightIcon className="h-3 w-3 shrink-0" />
                      ) : (
                        <ChevronDownIcon className="h-3 w-3 shrink-0" />
                      )}
                      <span className="truncate">{etiqueta(cat)}</span>
                      <span className="normal-case tracking-normal text-slate-300 dark:text-slate-600">
                        {items.length}
                      </span>
                    </p>
                    <button
                      onClick={() => {
                        setEditando(cat.id);
                        setCreando(false);
                        setBorrador(etiqueta(cat));
                      }}
                      title="Renombrar"
                      className="hidden shrink-0 rounded-md p-1 text-slate-400 transition hover:bg-slate-100 hover:text-siemens group-hover/cab:block dark:hover:bg-navy"
                    >
                      <PencilIcon className="h-3 w-3" />
                    </button>
                    {/* Las cuatro de fábrica no llevan papelera: el servidor
                        las rechaza igual, pero ofrecer un botón que siempre
                        falla es peor que no ofrecerlo. */}
                    {!cat.fija && (
                      <button
                        onClick={() => setConfirmando(cat.id)}
                        title="Borrar categoría (tiene que estar vacía)"
                        className="hidden shrink-0 rounded-md p-1 text-slate-400 transition hover:bg-red-50 hover:text-red-500 group-hover/cab:block dark:hover:bg-red-500/15"
                      >
                        <Trash2Icon className="h-3 w-3" />
                      </button>
                    )}
                  </>
                )}
              </div>

              {/* Plegada: se esconde el contenido pero la sección SIGUE
                  siendo zona de soltar. Así se puede mandar un widget a una
                  sección plegada sin desplegarla, y el contador de la cabecera
                  confirma que llegó. */}
              {plegadas.has(cat.id) ? null : items.length === 0 ? (
                <div className="rounded-lg border border-dashed border-slate-300 px-2 py-4 text-center text-[10px] leading-relaxed text-slate-400 dark:border-navy-slate">
                  Arrastra widgets aquí
                </div>
              ) : (
                <div className="grid grid-cols-2 gap-2">
                  {items.map((w) => {
                    const Icon = w.icon;
                    const isZip = zipKinds.has(w.kind);
                    return (
                      <motion.div
                        key={w.kind}
                        draggable
                        onDragStart={(e) => {
                          (e as unknown as React.DragEvent).dataTransfer.setData(
                            TIPO_ARRASTRE,
                            w.kind
                          );
                        }}
                        onDragEnd={() => autoScroll.detener()}
                        whileHover={{ scale: 1.04 }}
                        whileTap={{ scale: 0.96 }}
                        className="group relative flex cursor-grab flex-col items-center gap-1.5 rounded-lg border border-slate-200 bg-slate-50 p-2.5 text-center transition hover:border-siemens/40 hover:bg-siemens-50 active:cursor-grabbing dark:border-navy-slate dark:bg-navy dark:hover:border-siemens/50 dark:hover:bg-siemens/10"
                      >
                        <Icon className="h-5 w-5 text-siemens" />
                        <span className="text-[11px] font-medium leading-tight text-navy dark:text-slate-200">
                          {widgetLabel(w.kind)}
                        </span>
                        {asignados[w.kind] && (
                          <button
                            onClick={(ev) => {
                              ev.stopPropagation();
                              ev.preventDefault();
                              void devolver(w);
                            }}
                            className="absolute -left-1 -top-1 hidden h-5 w-5 items-center justify-center rounded-full bg-slate-500 text-white shadow group-hover:flex"
                            title={`Volver a «${w.category}», la categoría de su autor`}
                          >
                            <RotateCcwIcon className="h-3 w-3" />
                          </button>
                        )}
                        {isZip && (
                          <button
                            onClick={(ev) => {
                              ev.stopPropagation();
                              ev.preventDefault();
                              handleRemoveZip(
                                w.kind.replace('custom:', ''),
                                w.label
                              );
                            }}
                            className="absolute -right-1 -top-1 hidden h-5 w-5 items-center justify-center rounded-full bg-red-500 text-white shadow group-hover:flex"
                            title={t('sidebar.removeWidget')}
                          >
                            <Trash2Icon className="h-3 w-3" />
                          </button>
                        )}
                      </motion.div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Toast de feedback */}
      <AnimatePresence>
        {toast && (
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 10 }}
            className={`fixed bottom-4 left-4 z-50 flex items-center gap-2 rounded-xl px-4 py-2.5 text-xs font-medium text-white shadow-xl ${
              toast.ok ? 'bg-state-ok' : 'bg-red-500'
            }`}
          >
            {toast.ok ? (
              <CheckCircle2Icon className="h-4 w-4" />
            ) : (
              <AlertCircleIcon className="h-4 w-4" />
            )}
            {toast.msg}
          </motion.div>
        )}
      </AnimatePresence>
    </aside>
  );
}
