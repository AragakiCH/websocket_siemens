import React, { useCallback, useEffect, useLayoutEffect, useMemo, useState, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowLeftIcon,
  MousePointer2Icon,
  ActivityIcon,
  Trash2Icon,
  EyeIcon,
  LayoutDashboardIcon,
  WorkflowIcon,
  BellIcon,
  BookOpenIcon,
  FileSpreadsheetIcon,
  LayersIcon,
  MenuIcon,
  PlayIcon,
  ChevronDownIcon,
  ChevronsUpIcon,
  ChevronUpIcon,
  ChevronsDownIcon,
  UsersIcon } from
'lucide-react';
import { useAppStore } from '../context/AppStore';
import { HmiWidget, WidgetKind, defaultStyle } from '../models/widget';
import { catalogByKind } from '../components/hmi/widgetCatalog';
import { customByKind } from '../components/hmi/custom/registry';
import { WidgetSidebar } from '../components/hmi/WidgetSidebar';
import { CanvasWidget } from '../components/hmi/CanvasWidget';
import {
  esContenedor,
  contenedorBajo,
  hijosDe,
  moverBloque,
  reasignarPadre,
  soltarHijos,
  reordenar,
  puedeReordenar,
  type AccionOrden } from
'../components/hmi/grupo';
import { PropertyInspector } from '../components/hmi/PropertyInspector';
import { UPDATE_RATE_OPTIONS } from '../models/plc';
import {
  saveDesign,
  loadDesign,
  guardarProyecto,
  borrarWidget as apiBorrarWidget } from
'../utils/designStorage';
import { useLock } from '../hooks/useLock';
import { recursoDisenador } from '../services/lockApi';
import { FlowEditor } from '../components/flows/FlowEditor';
import { AlarmsEditor } from '../components/alarms/AlarmsEditor';
import { RecipesEditor } from '../components/recipes/RecipesEditor';
import { PanelExportar } from '../components/export/PanelExportar';
import { PantallasBar } from '../components/hmi/PantallasBar';
import {
  useVistaActiva,
  useSecciones,
  setVistaActiva,
  setPantalla,
  publicarSecciones,
  arbolDe,
  esWidgetDeNavegacion,
  KIND_MENU,
  GRUPO_POR_DEFECTO,
  VISTA_TODAS } from
'../components/hmi/custom/navegacion/store';

type DesignerTab = 'designer' | 'flows' | 'alarms' | 'recipes' | 'export';

let counter = 1;

// Límites razonables para el tamaño del lienzo (px).
const CANVAS_MIN = 200;
const CANVAS_MAX = 4000;
const clampCanvas = (n: number) =>
Math.max(CANVAS_MIN, Math.min(CANVAS_MAX, Math.round(n || 0)));

/** Fila de estado dentro del menú: icono + texto, sin ruido. */
function FilaMenu({
  icono,
  texto,
  titulo



}: {icono: React.ReactNode;texto: string;titulo?: string;}) {
  return (
    <p
      title={titulo}
      className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
      <span className="shrink-0">{icono}</span>
      <span className="min-w-0 truncate">{texto}</span>
    </p>);

}

export function Designer() {
  const navigate = useNavigate();
  const {
    widgets,
    projectId,
    projectVersion,
    setProjectVersion,
    pantallaCargada,
    permisos,
    presentes,
    setWidgets,
    variables,
    selectedVariables,
    config,
    isDark,
    t
  } = useAppStore();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const [activeTab, setActiveTab] = useState<DesignerTab>('designer');

  // Vista abierta en la navegación del lienzo. Solo se usa para atenuar los
  // widgets de otras vistas; no cambia nada de lo que se guarda.
  // ── QUÉ PANTALLA ESTÁ MIRANDO LA NAVEGACIÓN ───────────────────
  //
  // Sin esto, las pestañas de arriba comparten una sola navegación: la
  // pantalla 2 ve las secciones de la 1, y un widget soltado allí nace con
  // la sección abierta acá.
  //
  // Va en `useLayoutEffect` y no en `useEffect` a propósito. Los dos corren
  // DESPUÉS del render, así que la primera pasada de una pantalla nueva lee
  // todavía lo de la anterior; la diferencia es que el de layout corre antes
  // de pintar, así que ese estado intermedio no llega a verse.
  useLayoutEffect(() => {
    setPantalla(projectId);
  }, [projectId]);

  const vistaActiva = useVistaActiva(GRUPO_POR_DEFECTO);
  const secciones = useSecciones(GRUPO_POR_DEFECTO);

  // Con esto en `true` el lienzo enseña SOLO la sección abierta, igual que la
  // Vista Previa. Es lo que se espera al pulsar una sección, y sin ello el
  // atenuado pasaba desapercibido y parecía que la navegación no hacía nada.
  // Se puede apagar para ver todo junto y mover widgets entre secciones.
  const [aislarSeccion, setAislarSeccion] = useState(true);

  // Menú de la barra. Guarda lo que se consulta de vez en cuando (medidas,
  // estado, limpiar) para que la barra quede con lo que se usa de verdad:
  // las secciones, el play y este botón.
  const [menuAbierto, setMenuAbierto] = useState(false);

  // Id del widget que se esta arrastrando ahora mismo, o null.
  //
  // Solo sirve para resaltar el contenedor de destino mientras arrastras.
  // Sin esa pista, meter algo en un grupo es a ciegas: sueltas y a ver que
  // paso. Con ella se ve el marco encenderse antes de soltar.
  const [arrastrando, setArrastrando] = useState<string | null>(null);

  // Desplegable del selector de sección.
  const [selectorAbierto, setSelectorAbierto] = useState(false);

  // Menú del clic derecho: qué widget y en qué punto de la pantalla.
  const [menuOrden, setMenuOrden] = useState<{
    id: string;
    x: number;
    y: number;
  } | null>(null);

  // Fase 4: el "lápiz". Solo una persona edita a la vez; el resto ve los
  // cambios en vivo en modo lectura. Se pide al entrar y se suelta al salir.
  // Solo se toma en la pestaña del Diseñador: estar mirando Flujos o Alarmas
  // no debe bloquear el lienzo a los demás.
  const lock = useLock(recursoDisenador(projectId), activeTab === 'designer');

  // Se puede editar si el rol lo permite Y se tiene el lápiz. Son dos cosas
  // distintas: el rol dice si PUEDES, el lápiz si te toca AHORA.
  const puedeEditar =
  (!permisos || permisos.editar_diseño) && lock.puedeEditar;

  

  // ---- Tamaño del lienzo (px) ------------------------------------------
  // Es POR PANTALLA: cada HMI puede estar pensado para una resolución
  // distinta (un panel de 7\" y un puesto de 24\" no comparten lienzo). Se
  // reajusta en el efecto de hidratación de más abajo, cada vez que se cambia
  // de pestaña.
  // Solo para el primer render: a partir de ahí manda el efecto de
  // hidratación, que relee el lienzo cada vez que se cambia de pantalla.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const inicial = useMemo(() => loadDesign(projectId), []);
  const [canvasW, setCanvasW] = useState<number>(inicial?.canvas.width ?? 1280);
  const [canvasH, setCanvasH] = useState<number>(inicial?.canvas.height ?? 760);

  // Texto que se escribe en los inputs (se aplica al salir / dar Enter).
  const [wInput, setWInput] = useState(String(canvasW));
  const [hInput, setHInput] = useState(String(canvasH));

  const commitW = () => {
    const v = clampCanvas(parseInt(wInput, 10) || canvasW);
    setCanvasW(v);
    setWInput(String(v));
  };
  const commitH = () => {
    const v = clampCanvas(parseInt(hInput, 10) || canvasH);
    setCanvasH(v);
    setHInput(String(v));
  };

  // La hidratación de los widgets la hace el AppStore (es quien sabe qué
  // pantalla está abierta). Aquí solo queda lo que es del lienzo.

  // ── Cambiar de pantalla, y las dos trampas que esconde ────────────────
  //
  // Cambiar de pestaña no es instantáneo, y en la ventana que dura hay dos
  // formas distintas de corromper el diseño. Por eso hacen falta DOS señales
  // y no una:
  //
  //   `cargada`  los WIDGETS en memoria ya son los de esta pantalla. Lo dice
  //              el AppStore, que es quien los pide al servidor.
  //   `listo`    además, el LIENZO ya es el de esta pantalla.
  //
  // Sin lo primero, guardar escribiría los widgets de la pantalla anterior
  // encima de la nueva. Sin lo segundo, la pantalla nueva heredaría en
  // silencio las medidas de la anterior — porque el efecto que vuelca la
  // caché correría antes de que el lienzo se hubiera adoptado, y el efecto de
  // hidratación leería justo eso.
  const [errorGuardado, setErrorGuardado] = useState<string>('');
  const cargada = pantallaCargada === projectId;
  const [lienzoDe, setLienzoDe] = useState<string>('');
  const listo = cargada && lienzoDe === projectId;

  // Firma de lo último que se sabe guardado (o recién cargado). Sin ella,
  // hidratar una pantalla dispararía un guardado inmediato que solo sirve
  // para subirle la versión y difundir un cambio que no existe.
  const firmaGuardada = useRef<string>('');
  const firmaActual = JSON.stringify({
    widgets,
    canvas: { width: canvasW, height: canvasH },
  });

  // Adopción del lienzo de la pantalla recién cargada. Corre UNA vez por
  // pantalla: en cuanto `lienzoDe` la señala, la guarda de arriba lo impide.
  useEffect(() => {
    if (!cargada || lienzoDe === projectId) return;
    const c = loadDesign(projectId)?.canvas;
    const w = clampCanvas(c?.width || 1280);
    const h = clampCanvas(c?.height || 760);
    setCanvasW(w);
    setCanvasH(h);
    setWInput(String(w));
    setHInput(String(h));
    firmaGuardada.current = JSON.stringify({
      widgets,
      canvas: { width: w, height: h },
    });
    setSelectedId(null);
    setErrorGuardado('');
    setLienzoDe(projectId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cargada, lienzoDe, projectId]);

  // Caché local, inmediata: si se recarga la página no se pierde nada.
  useEffect(() => {
    if (!listo) return;
    saveDesign({ widgets, canvas: { width: canvasW, height: canvasH } }, projectId);
  }, [listo, widgets, canvasW, canvasH, projectId]);

  // Guardado al SERVIDOR, con debounce de 400 ms: es lo que ven los demás.
  //
  // El debounce importa. Arrastrar un widget dos segundos genera decenas de
  // renders; sin él serían decenas de escrituras a disco y decenas de
  // broadcasts a todos los clientes conectados. Con él, se manda una vez al
  // soltar (o cada 400 ms si el arrastre es largo).
  useEffect(() => {
    if (!listo) return;
    // Sin permiso de edición no se intenta escribir: el backend respondería
    // 403 y saldría un error por cada movimiento del ratón.
    if (permisos && !permisos.editar_diseño) return;
    // Sin el lápiz no se escribe: el backend responderia 423 en cada
    // movimiento del raton.
    if (!lock.puedeEditar) return;
    // Nada cambió desde lo último guardado: no hay nada que mandar.
    if (firmaActual === firmaGuardada.current) return;

    const id = setTimeout(async () => {
      try {
        const v = await guardarProyecto(
          { widgets, canvas: { width: canvasW, height: canvasH } },
          projectVersion,
          projectId
        );
        firmaGuardada.current = firmaActual;
        setProjectVersion(v);
        setErrorGuardado('');
      } catch (e: any) {
        if (e?.status === 409) {
          // Otro usuario guardó mientras editabas. No se pisa su trabajo: se
          // avisa y se deja que decida.
          setErrorGuardado(
            'Otro usuario guardó cambios. Recarga la pantalla para verlos ' +
            'antes de seguir editando.'
          );
        } else {
          setErrorGuardado(e?.message ?? 'No se pudo guardar en el servidor.');
        }
      }
    }, 400);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listo, firmaActual, projectId, lock.puedeEditar]);

  // Lo que se esconde no puede desaparecer sin dejar rastro: si no puedes
  // editar o hay un conflicto de guardado, el botón del menú lo marca con un
  // punto ámbar aunque esté cerrado.
  const hayAviso = !!errorGuardado || (!lock.cargando && !lock.puedeEditar);

  // ── Teclado del lienzo ────────────────────────────────────────
  //
  // Suprimir / Retroceso borran el widget seleccionado, y Escape lo
  // deselecciona. Es lo que espera cualquiera que haya usado un editor.
  //
  // La guarda de los campos de texto es imprescindible: sin ella, borrar una
  // letra del nombre en el Inspector borraría el widget entero.
  useEffect(() => {
    if (activeTab !== 'designer') return;

    const alPulsar = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      const etiqueta = el?.tagName;
      if (
      etiqueta === 'INPUT' ||
      etiqueta === 'TEXTAREA' ||
      etiqueta === 'SELECT' ||
      el?.isContentEditable)
      return;

      if (e.key === 'Escape') {
        setSelectedId(null);
        return;
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (!selectedId) return;
        e.preventDefault(); // Retroceso navegaría atrás en algunos navegadores
        deleteWidget(selectedId);
      }
    };

    window.addEventListener('keydown', alPulsar);
    return () => window.removeEventListener('keydown', alPulsar);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, selectedId, puedeEditar]);

  // ── Meter en el lienzo lo que se haya quedado fuera ───────────
  //
  // Estirar un widget ya no deja salirse, pero puede haber diseños guardados
  // de antes, o alguien pudo achicar el lienzo con widgets ya colocados. Al
  // cargar y al cambiar las medidas se recolocan los que sobresalen.
  useEffect(() => {
    if (!listo || !puedeEditar) return;
    setWidgets((prev) => {
      let cambio = false;
      const dentro = prev.map((w) => {
        const width = Math.min(w.width, canvasW);
        const height = Math.min(w.height, canvasH);
        const x = Math.max(0, Math.min(w.x, canvasW - width));
        const y = Math.max(0, Math.min(w.y, canvasH - height));
        if (width === w.width && height === w.height && x === w.x && y === w.y) return w;
        cambio = true;
        return { ...w, x, y, width, height };
      });
      // Devolver el mismo array si nada cambió: si no, este efecto se
      // dispararía a sí mismo en bucle.
      return cambio ? dentro : prev;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listo, canvasW, canvasH, puedeEditar]);

  // Escape cierra el menú. Es lo que espera cualquiera con un desplegable
  // abierto, y evita quedarse atrapado si el clic-fuera falla.
  useEffect(() => {
    if (!menuAbierto && !selectorAbierto && !menuOrden) return;
    const alPulsar = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setMenuAbierto(false);
      setSelectorAbierto(false);
      setMenuOrden(null);
    };
    window.addEventListener('keydown', alPulsar);
    return () => window.removeEventListener('keydown', alPulsar);
  }, [menuAbierto, selectorAbierto, menuOrden]);

  const selected = widgets.find((w) => w.id === selectedId) ?? null;

  // ── Grupos ────────────────────────────────────────────────────
  //
  // Contenedor sobre el que caeria ahora mismo lo que se arrastra. Se
  // recalcula solo mientras hay arrastre; el resto del tiempo es null y no
  // cuesta nada. `widgets` ya cambia en cada movimiento, asi que esto se
  // mantiene al dia sin ningun listener extra.
  const destinoGrupo = useMemo(() => {
    if (!arrastrando) return null;
    const w = widgets.find((x) => x.id === arrastrando);
    return w ? contenedorBajo(widgets, w) : null;
  }, [arrastrando, widgets]);

  /**
   * Coletilla de la etiqueta del widget seleccionado.
   *
   * Es donde se ve el parentesco. Un contenedor dice cuantos lleva dentro y
   * un widget agrupado dice de quien depende, que es justo la duda que
   * aparece al mover algo y ver que se mueve otra cosa con el.
   */
  /** Aplica una acción de orden al widget del menú y lo cierra. */
  const aplicarOrden = (id: string, accion: AccionOrden) => {
    setMenuOrden(null);
    if (!puedeEditar) return;
    setWidgets((prev) => reordenar(prev, id, accion));
  };

  // ── Secciones fantasma ────────────────────────────────────────
  //
  // Las secciones las publica el propio Menú Lateral al dibujarse. Si se
  // borra el menú, nadie las retira y la barra sigue ofreciendo secciones de
  // una navegación que ya no existe. Aquí se limpia cuando la pantalla se ha
  // quedado sin ningún menú.
  //
  // Espera a `cargada`: durante la hidratación `widgets` todavía puede traer
  // lo de la pantalla anterior, y limpiar con esa foto borraría secciones
  // buenas.
  useEffect(() => {
    if (!cargada) return;
    const hayMenu = widgets.some((w) => w.kind === KIND_MENU);
    if (!hayMenu) publicarSecciones(GRUPO_POR_DEFECTO, []);
  }, [cargada, widgets]);

  // ── Secciones huérfanas ───────────────────────────────────────
  //
  // Un widget guarda su sección por id (`w.vista`). Si esa sección se borra
  // del menú, el id se queda escrito y ya no hay forma de abrirla: el widget
  // no se dibuja, no se puede seleccionar y no se puede borrar. Queda
  // atrapado, y en la Vista Previa reaparece mezclado con todo lo demás.
  //
  // Se detectan aquí para poder ofrecerlas en el selector y rescatarlas.
  const idsDeSeccion = useMemo(
    () => new Set(secciones.map((s) => s.id)),
    [secciones]
  );

  const huerfanas = useMemo(() => {
    const cuenta = new Map<string, number>();
    for (const w of widgets) {
      const v = (w.vista ?? '').trim();
      if (!v || idsDeSeccion.has(v)) continue;
      cuenta.set(v, (cuenta.get(v) ?? 0) + 1);
    }
    return Array.from(cuenta, ([id, n]) => ({ id, n })).sort((a, b) =>
      a.id.localeCompare(b.id)
    );
  }, [widgets, idsDeSeccion]);

  /**
   * Devuelve a «En todas» los widgets de una sección que ya no existe.
   *
   * Es la salida del atasco: pasan a verse siempre, y desde ahí se borran o
   * se reasignan como cualquier otro. Se prefiere esto a borrarlos porque
   * perder trabajo por un id que ya no está sería el peor final posible.
   */
  const rescatarHuerfana = (id: string) => {
    if (!puedeEditar) return;
    setWidgets((prev) =>
      prev.map((w) =>
        (w.vista ?? '').trim() === id ? { ...w, vista: VISTA_TODAS } : w
      )
    );
    if (vistaActiva === id) {
      setVistaActiva(GRUPO_POR_DEFECTO, secciones[0]?.id ?? VISTA_TODAS);
    }
  };

  const insigniaDe = (w: HmiWidget): string | undefined => {
    if (esContenedor(w.kind)) {
      const n = hijosDe(widgets, w.id).length;
      return n ? `${n} dentro` : 'vacío';
    }
    if (w.padre) {
      const p = widgets.find((x) => x.id === w.padre);
      if (p) return `en ${p.name}`;
    }
    return undefined;
  };

  const createWidget = useCallback(
    (kind: WidgetKind, x: number, y: number): HmiWidget | null => {
      const cat = catalogByKind(kind);
      if (!cat) {
        console.warn(`[Designer] widget kind sin registrar: ${kind}`);
        return null;
      }
      const style = defaultStyle();
      if (kind === 'rectangle' || kind === 'circle') {
        style.background = '#cbd5e1';
        style.borderColor = '#94a3b8';
        style.borderWidth = 1;
      }
      return {
        id: `w_${Date.now()}_${counter}`,
        kind,
        name: `${cat.label} ${counter++}`,
        x,
        y,
        width: cat.defaultWidth,
        height: cat.defaultHeight,
        text: cat.label,
        style,
        visible: true,
        enabled: true,
        variableId: null,
        // LO QUE SUELTAS PERTENECE A LA SECCIÓN ABIERTA.
        //
        // Antes todo nacía "en todas" y había que ir al Inspector a asignarle
        // la sección a mano; el que no lo supiera veía sus widgets repetidos
        // en las tres secciones y la navegación parecía rota. Ahora se hereda
        // la sección en la que estás, que es lo que hace cualquier editor por
        // capas, y quien quiera un widget fijo lo cambia a "En todas".
        //
        // El menú y el panel de sección quedan fuera: si el menú se metiera
        // en una sección, desaparecería al salir de ella.
        vista: esWidgetDeNavegacion(kind) ? VISTA_TODAS : vistaActiva,
        // Ajustes iniciales del tipo, si los declara. El Menú Lateral nace
        // así con sus tres secciones de ejemplo en vez de con una caja vacía
        // que no dice qué hacer con ella.
        config: customByKind(kind)?.defaultConfig
          ? { ...customByKind(kind)!.defaultConfig }
          : undefined
      };
    },
    [vistaActiva]
  );

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    if (!puedeEditar) return;
    const kind = e.dataTransfer.getData('widget-kind') as WidgetKind;
    if (!kind) return;
    const bounds = canvasRef.current?.getBoundingClientRect();
    if (!bounds) return;
    const cat = catalogByKind(kind);
    if (!cat) return;
    const x = Math.max(
      0,
      Math.round(e.clientX - bounds.left - cat.defaultWidth / 2)
    );
    const y = Math.max(
      0,
      Math.round(e.clientY - bounds.top - cat.defaultHeight / 2)
    );
    const w = createWidget(kind, x, y);
    if (!w) return;

    setWidgets((prev) => {
      // Si cae encima de un contenedor, entra en el grupo desde el primer
      // momento. Obligar a soltarlo y arrastrarlo otra vez para agruparlo
      // seria un paso de mas que nadie adivina.
      const nuevo = { ...w, padre: contenedorBajo(prev, w) ?? undefined };
      if (!esContenedor(nuevo.kind)) return [...prev, nuevo];

      // UN CONTENEDOR SE COLOCA DETRAS DEL RESTO.
      //
      // El orden del array es el orden de pintado, y los widgets van en
      // absoluto: el ultimo tapa a los anteriores. Un contenedor soltado al
      // final cubriria los widgets que quieres meter dentro y ya no podrias
      // ni seleccionarlos.
      //
      // Se mete al final del bloque de contenedores, no al principio del
      // todo: asi queda detras de los widgets normales pero DELANTE de los
      // contenedores anteriores, que es lo que hace falta para poder anidar
      // un contenedor dentro de otro y seguir viendolo.
      const i = prev.findIndex((x) => !esContenedor(x.kind));
      return i < 0 ?
      [...prev, nuevo] :
      [...prev.slice(0, i), nuevo, ...prev.slice(i)];
    });
    setSelectedId(w.id);
  };

  const patchWidget = (id: string, patch: Partial<HmiWidget>) => {
    if (!puedeEditar) return;
    setWidgets((prev) => prev.map((w) => w.id === id ? { ...w, ...patch } : w));
  };

  const patchStyle = (id: string, patch: Partial<HmiWidget['style']>) => {
    if (!puedeEditar) return;
    setWidgets((prev) =>
    prev.map((w) =>
    w.id === id ? { ...w, style: { ...w.style, ...patch } } : w
    )
    );
  };

  const deleteWidget = (id: string) => {
    if (!puedeEditar) return;
    // Borrar un contenedor NO borra lo que lleva dentro: se sueltan y se
    // quedan donde estan. Ver soltarHijos() en grupo.ts — no hay deshacer
    // en este editor y un borrado en cadena por una tecla seria brutal.
    setWidgets((prev) => soltarHijos(prev, id).filter((w) => w.id !== id));
    setSelectedId(null);
    // El PUT con debounce ya lo reflejaría, pero un borrado conviene
    // propagarlo de inmediato: es la operación que más molesta ver con
    // retraso en la pantalla de otro.
    void apiBorrarWidget(id, null, projectId)
      .then(setProjectVersion)
      .catch(() => {/* el guardado con debounce lo reintentará */});
  };

  // Abre la vista previa en una pestaña nueva (guarda antes por si acaso).
  const openPreview = () => {
    saveDesign({ widgets, canvas: { width: canvasW, height: canvasH } }, projectId);
    // La pantalla activa viaja en la URL: abrir la vista previa desde la
    // pestaña "Horno 2" tiene que enseñar el Horno 2, no la principal.
    window.open(
      `/preview?pantalla=${encodeURIComponent(projectId)}`,
      '_blank',
      'noopener'
    );
  };

  const rawRate = UPDATE_RATE_OPTIONS.find((o) => o.value === config.updateRate);
  const rateLabel =
  rawRate && rawRate.value >= 1000 ?
  t(`rate.${rawRate.value}`) :
  rawRate?.label;

  return (
    <div className="flex h-full max-h-full w-full flex-col overflow-hidden bg-slate-100 dark:bg-navy">
      {/* Top toolbar */}
      <header className="flex items-center justify-between border-b border-slate-200 bg-white px-4 py-2.5 dark:border-navy-slate dark:bg-navy-soft">
        <div className="flex items-center gap-3">
          <button
            onClick={() => navigate('/menu')}
            className="flex h-8 w-8 items-center justify-center rounded-lg text-slate-500 transition hover:bg-slate-100 dark:hover:bg-navy-slate/40">
            <ArrowLeftIcon className="h-4 w-4" />
          </button>
          <div>
            <h1 className="text-sm font-bold text-navy dark:text-slate-100">
              {t('designer.title')}
            </h1>
            <p className="text-[11px] text-slate-400">
              {t('designer.mainView')}
            </p>
          </div>

          {/* ── Pestañas ── */}
          <div className="ml-4 flex rounded-lg border border-slate-200 bg-slate-50 p-0.5 dark:border-navy-slate dark:bg-navy">
            <button
              onClick={() => setActiveTab('designer')}
              className={`flex items-center gap-1.5 rounded-md px-3 py-1 text-xs font-semibold transition ${
                activeTab === 'designer'
                  ? 'bg-white text-navy shadow-sm dark:bg-navy-slate dark:text-slate-100'
                  : 'text-slate-400 hover:text-slate-600 dark:hover:text-slate-300'
              }`}
            >
              <LayoutDashboardIcon className="h-3.5 w-3.5" />
              Diseñador
            </button>
            <button
              onClick={() => setActiveTab('flows')}
              className={`flex items-center gap-1.5 rounded-md px-3 py-1 text-xs font-semibold transition ${
                activeTab === 'flows'
                  ? 'bg-white text-navy shadow-sm dark:bg-navy-slate dark:text-slate-100'
                  : 'text-slate-400 hover:text-slate-600 dark:hover:text-slate-300'
              }`}
            >
              <WorkflowIcon className="h-3.5 w-3.5" />
              Flujos
            </button>
            <button
              onClick={() => setActiveTab('alarms')}
              className={`flex items-center gap-1.5 rounded-md px-3 py-1 text-xs font-semibold transition ${
                activeTab === 'alarms'
                  ? 'bg-white text-navy shadow-sm dark:bg-navy-slate dark:text-slate-100'
                  : 'text-slate-400 hover:text-slate-600 dark:hover:text-slate-300'
              }`}
            >
              <BellIcon className="h-3.5 w-3.5" />
              Alarmas
            </button>
            <button
              onClick={() => setActiveTab('recipes')}
              className={`flex items-center gap-1.5 rounded-md px-3 py-1 text-xs font-semibold transition ${
                activeTab === 'recipes'
                  ? 'bg-white text-navy shadow-sm dark:bg-navy-slate dark:text-slate-100'
                  : 'text-slate-400 hover:text-slate-600 dark:hover:text-slate-300'
              }`}
            >
              <BookOpenIcon className="h-3.5 w-3.5" />
              Recetas
            </button>
            <button
              onClick={() => setActiveTab('export')}
              className={`flex items-center gap-1.5 rounded-md px-3 py-1 text-xs font-semibold transition ${
                activeTab === 'export'
                  ? 'bg-white text-navy shadow-sm dark:bg-navy-slate dark:text-slate-100'
                  : 'text-slate-400 hover:text-slate-600 dark:hover:text-slate-300'
              }`}
            >
              <FileSpreadsheetIcon className="h-3.5 w-3.5" />
              Exportar
            </button>
          </div>
        </div>

        {activeTab === 'designer' &&
        <div className="flex items-center gap-2">

          {/* ── SECCIONES ───────────────────────────────────────
              Se queda FUERA del menú a propósito: es un control de trabajo,
              se pulsa cada dos por tres mientras editas. Lo que se guardó
              dentro es estado y ajustes, que se miran de vez en cuando. */}
          {(secciones.length > 0 || huerfanas.length > 0) &&
          <div className="flex items-center gap-1 rounded-lg border border-slate-200 bg-slate-50 p-0.5 dark:border-navy-slate dark:bg-navy">

            {/* SELECTOR DE SECCIÓN: DESPLEGABLE, NO UNA FILA DE BOTONES.
                Antes cada sección era un botón en la barra. Con tres cabía;
                con doce, la barra se comía la pantalla y acababa empujando al
                play y al menú fuera de sitio. Y el ancho cambiaba cada vez que
                renombrabas una sección, así que los botones bailaban.
                Un desplegable ocupa lo mismo con 3 que con 30. */}
            <div className="relative">
              <button
                onClick={() => setSelectorAbierto((v) => !v)}
                title="Elegir la sección que estás editando"
                aria-expanded={selectorAbierto}
                className={`flex items-center gap-1.5 rounded-md py-1 pl-2 pr-1.5 text-xs font-semibold outline-none transition focus-visible:ring-2 focus-visible:ring-siemens/40 ${
                selectorAbierto ?
                'bg-white text-navy shadow-sm dark:bg-navy-slate dark:text-slate-100' :
                'text-navy hover:bg-white dark:text-slate-100 dark:hover:bg-navy-slate'}`
                }>
                <LayersIcon className="h-3.5 w-3.5 shrink-0 text-slate-400" />
                {/* Ancho fijo: sin él, la barra entera se ensancha y se encoge
                    al cambiar de sección y el resto de botones se mueven. */}
                <span className="max-w-[130px] truncate">
                  {secciones.find((s) => s.id === vistaActiva)?.label ||
                    (vistaActiva ? vistaActiva : 'Sin sección')}
                </span>
                {/* El contador solo tiene sentido dentro del menú. Estando en
                    una huérfana no hay «de cuántas», así que se marca. */}
                {secciones.some((s) => s.id === vistaActiva) ?
                <span className="rounded bg-slate-200/70 px-1 text-[10px] tabular-nums text-slate-500 dark:bg-navy-slate/70 dark:text-slate-400">
                  {secciones.findIndex((s) => s.id === vistaActiva) + 1}/{secciones.length}
                </span> :
                vistaActiva ?
                <span className="rounded bg-amber-500/15 px-1 text-[10px] font-semibold text-amber-600 dark:text-amber-400">
                  huérfana
                </span> : null
                }
                <ChevronDownIcon
                  className={`h-3 w-3 shrink-0 text-slate-400 transition-transform ${selectorAbierto ? 'rotate-180' : ''}`} />
              </button>

              {selectorAbierto &&
              <>
                <div className="fixed inset-0 z-40" onClick={() => setSelectorAbierto(false)} />

                <div className="absolute left-0 top-full z-50 mt-1.5 max-h-[320px] w-56 overflow-y-auto rounded-xl border border-slate-200 bg-white py-1 shadow-xl dark:border-navy-slate dark:bg-navy-soft">
                  {/* Con sangría: el selector tiene que leerse como el menú.
                      `secciones` ya viene sin encabezados —solo lo navegable—
                      así que un subproceso podría salir pegado a su padre y
                      parecer que están al mismo nivel. */}
                  {arbolDe(secciones).map(({ seccion: s, profundidad }) => {
                    // Cuántos widgets viven en cada sección. Con muchas
                    // secciones es el dato que buscas: dice cuál está vacía y
                    // cuál te olvidaste de rellenar, sin ir abriéndolas una a
                    // una.
                    const cuantos = widgets.filter((w) => (w.vista ?? '') === s.id).length;
                    const activa = vistaActiva === s.id;
                    return (
                      <button
                        key={s.id}
                        onClick={() => {
                          setVistaActiva(GRUPO_POR_DEFECTO, s.id);
                          setSelectorAbierto(false);
                        }}
                        style={{ paddingLeft: 12 + profundidad * 12 }}
                        className={`flex w-full items-center gap-2 py-1.5 pr-3 text-left text-xs transition ${
                        activa ?
                        'bg-siemens-50 font-semibold text-siemens dark:bg-siemens/15 dark:text-siemens-200' :
                        'text-slate-600 hover:bg-slate-50 dark:text-slate-300 dark:hover:bg-navy-slate/50'}`
                        }>
                        <span className="min-w-0 flex-1 truncate">{s.label || s.id}</span>
                        <span className="shrink-0 text-[10px] tabular-nums text-slate-400">
                          {cuantos}
                        </span>
                      </button>);

                  })}

                  {/* ── HUÉRFANAS ────────────────────────────────
                      Secciones que algún widget todavía dice tener pero que
                      ya no están en el menú, casi siempre porque se borró la
                      sección con widgets dentro.

                      Sin esto quedan atrapados: no se dibujan, así que no se
                      pueden ni seleccionar ni borrar, y en la Vista Previa
                      de una pantalla sin navegación reaparecen mezclados con
                      todo lo demás. Aquí se pueden abrir para verlos, o
                      devolverlos a «En todas» de un clic. */}
                  {huerfanas.length > 0 &&
                  <>
                    <div className="mt-1 border-t border-slate-100 px-3 pb-1 pt-1.5 dark:border-navy-slate">
                      <p className="text-[10px] font-bold uppercase tracking-wider text-amber-600 dark:text-amber-400">
                        Sin sección en el menú
                      </p>
                      <p className="mt-0.5 text-[10px] leading-snug text-slate-400">
                        Su sección ya no existe. Ábrela para verlos, o
                        devuélvelos a «En todas».
                      </p>
                    </div>
                    {huerfanas.map((h) =>
                    <div
                      key={h.id}
                      className={`flex w-full items-center gap-1 pl-3 pr-1.5 transition ${
                      vistaActiva === h.id ?
                      'bg-amber-500/10' :
                      'hover:bg-slate-50 dark:hover:bg-navy-slate/50'}`
                      }>
                      <button
                        onClick={() => {
                          setVistaActiva(GRUPO_POR_DEFECTO, h.id);
                          setSelectorAbierto(false);
                        }}
                        title={`Abrir «${h.id}» para ver sus ${h.n} widget(s)`}
                        className={`flex min-w-0 flex-1 items-center gap-2 py-1.5 text-left text-xs ${
                        vistaActiva === h.id ?
                        'font-semibold text-amber-700 dark:text-amber-300' :
                        'text-slate-600 dark:text-slate-300'}`
                        }>
                        <span className="min-w-0 flex-1 truncate font-mono text-[11px]">{h.id}</span>
                        <span className="shrink-0 text-[10px] tabular-nums text-slate-400">{h.n}</span>
                      </button>
                      <button
                        onClick={() => rescatarHuerfana(h.id)}
                        disabled={!puedeEditar}
                        title={`Devolver sus ${h.n} widget(s) a «En todas», donde se ven siempre`}
                        className="shrink-0 rounded px-1.5 py-1 text-[10px] font-semibold text-siemens outline-none transition hover:bg-siemens/10 disabled:cursor-not-allowed disabled:opacity-40">
                        Rescatar
                      </button>
                    </div>
                    )}
                  </>
                  }

                  {/* Los widgets fijos no son una sección y no se pueden
                      "abrir", pero saber cuántos hay explica por qué algunos
                      no desaparecen nunca al cambiar de sección. */}
                  <div className="mt-1 flex items-center gap-2 border-t border-slate-100 px-3 pb-0.5 pt-1.5 text-[10px] text-slate-400 dark:border-navy-slate">
                    <span className="min-w-0 flex-1">En todas las secciones</span>
                    <span className="tabular-nums">
                      {widgets.filter((w) => !(w.vista ?? '').trim()).length}
                    </span>
                  </div>
                </div>
              </>
              }
            </div>

            <div className="mx-0.5 h-4 w-px bg-slate-200 dark:bg-navy-slate" />
            <button
              onClick={() => setAislarSeccion((v) => !v)}
              title={
              aislarSeccion ?
              'Viendo solo la sección abierta. Púlsalo para ver todas a la vez y poder mover widgets entre ellas.' :
              'Viendo todas las secciones. Púlsalo para aislar la abierta.'
              }
              className={`flex items-center gap-1 rounded-md px-2 py-1 text-xs font-semibold transition ${
              aislarSeccion ?
              'text-siemens hover:bg-siemens-50 dark:hover:bg-siemens/15' :
              'text-slate-400 hover:text-slate-600 dark:hover:text-slate-300'}`
              }>
              {aislarSeccion ?
              <EyeIcon className="h-3.5 w-3.5" /> :
              <LayersIcon className="h-3.5 w-3.5" />}
              {aislarSeccion ? 'Solo esta' : 'Todas'}
            </button>
          </div>
          }

          {/* ── Vista previa: solo el play ─────────────────────── */}
          <button
            onClick={openPreview}
            title="Vista previa en una pestaña nueva"
            aria-label="Vista previa"
            className="flex h-8 w-8 items-center justify-center rounded-lg bg-siemens text-white outline-none transition hover:bg-siemens-600 focus-visible:ring-2 focus-visible:ring-siemens/50">
            <PlayIcon className="h-4 w-4" />
          </button>

          {/* ── Menú ───────────────────────────────────────────── */}
          <div className="relative">
            <button
              onClick={() => setMenuAbierto((v) => !v)}
              title="Lienzo, estado y acciones"
              aria-label="Menú del diseñador"
              aria-expanded={menuAbierto}
              className={`relative flex h-8 w-8 items-center justify-center rounded-lg outline-none transition focus-visible:ring-2 focus-visible:ring-siemens/40 ${
              menuAbierto ?
              'bg-slate-100 text-navy dark:bg-navy-slate dark:text-slate-100' :
              'text-slate-500 hover:bg-slate-100 dark:hover:bg-navy-slate/40'}`
              }>
              <MenuIcon className="h-4 w-4" />
              {/* Punto de aviso: lo que se esconde no puede desaparecer sin
                  dejar rastro. Si no puedes editar o hay un conflicto de
                  guardado, el botón lo delata con el menú cerrado. */}
              {hayAviso &&
              <span className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full bg-state-warn ring-2 ring-white dark:ring-navy-soft" />
              }
            </button>

            {menuAbierto &&
            <>
              {/* Capa invisible para cerrar al pulsar fuera. */}
              <div
                className="fixed inset-0 z-40"
                onClick={() => setMenuAbierto(false)} />

              <div className="absolute right-0 top-full z-50 mt-1.5 w-64 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-xl dark:border-navy-slate dark:bg-navy-soft">

                {/* Lienzo */}
                <div className="border-b border-slate-100 px-3 py-2.5 dark:border-navy-slate">
                  <p className="mb-1.5 text-[10px] font-bold uppercase tracking-wider text-slate-400">
                    Lienzo
                  </p>
                  <div className="flex items-center gap-1.5">
                    <input
                      type="text"
                      inputMode="numeric"
                      value={wInput}
                      onChange={(e) => setWInput(e.target.value.replace(/[^0-9]/g, ''))}
                      onBlur={commitW}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                      }}
                      className="w-full rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-center text-xs text-navy outline-none transition focus:border-siemens focus:ring-2 focus:ring-siemens/20 dark:border-navy-slate dark:bg-navy dark:text-slate-100"
                      title="Ancho (px)" />
                    <span className="text-xs text-slate-400">×</span>
                    <input
                      type="text"
                      inputMode="numeric"
                      value={hInput}
                      onChange={(e) => setHInput(e.target.value.replace(/[^0-9]/g, ''))}
                      onBlur={commitH}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                      }}
                      className="w-full rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-center text-xs text-navy outline-none transition focus:border-siemens focus:ring-2 focus:ring-siemens/20 dark:border-navy-slate dark:bg-navy dark:text-slate-100"
                      title="Alto (px)" />
                    <span className="text-[11px] text-slate-400">px</span>
                  </div>
                </div>

                {/* Estado */}
                <div className="space-y-1.5 border-b border-slate-100 px-3 py-2.5 dark:border-navy-slate">
                  <p className="mb-1.5 text-[10px] font-bold uppercase tracking-wider text-slate-400">
                    Estado
                  </p>

                  <FilaMenu
                    icono={<ActivityIcon className="h-3.5 w-3.5 text-state-ok" />}
                    texto={`${t('designer.live')} · ${rateLabel}`} />

                  <FilaMenu
                    icono={<LayoutDashboardIcon className="h-3.5 w-3.5 text-slate-400" />}
                    texto={`${widgets.length} ${t('designer.widgets')}`} />

                  {presentes.length > 1 &&
                  <FilaMenu
                    icono={<UsersIcon className="h-3.5 w-3.5 text-siemens" />}
                    texto={`${presentes.length} conectados`}
                    titulo={presentes.map((pp) => `${pp.usuario} (${pp.categoria})`).join('\n')} />
                  }

                  {!lock.cargando && (lock.puedeEditar ?
                  <FilaMenu
                    icono={<MousePointer2Icon className="h-3.5 w-3.5 text-state-ok" />}
                    texto="Editando"
                    titulo="Tienes el control de edición. Se libera al salir de esta pantalla." /> :

                  <div className="rounded-lg bg-state-warn/15 px-2 py-1.5">
                    <p className="flex items-center gap-1.5 text-xs font-semibold text-state-warn">
                      <EyeIcon className="h-3.5 w-3.5 shrink-0" />
                      {lock.titular ?
                      `Solo lectura · edita ${lock.titular.usuario}` :
                      'Solo lectura'}
                    </p>
                    <div className="mt-1.5 flex gap-1.5">
                      {/* La toma de control solo tiene sentido ofrecerla a
                          quien puede usarla. El backend lo verifica igual. */}
                      {permisos?.gestionar_usuarios &&
                      <button
                        onClick={() => void lock.tomarControl()}
                        title="Quitarle el control de edición (queda registrado en la auditoría)"
                        className="rounded bg-state-warn/20 px-1.5 py-0.5 text-[11px] font-bold text-state-warn hover:bg-state-warn/30">
                        Tomar control
                      </button>
                      }
                      {!lock.titular &&
                      <button
                        onClick={() => void lock.reintentar()}
                        className="rounded bg-state-warn/20 px-1.5 py-0.5 text-[11px] font-bold text-state-warn hover:bg-state-warn/30">
                        Reintentar
                      </button>
                      }
                    </div>
                  </div>
                  )}

                  {/* Conflicto de versión: otro usuario guardó mientras
                      editabas. No se pisa su trabajo; se avisa y se deja
                      decidir. */}
                  {errorGuardado &&
                  <p className="rounded-lg bg-state-warn/15 px-2 py-1.5 text-[11px] leading-relaxed text-state-warn">
                    {errorGuardado}
                  </p>
                  }
                </div>

                {/* Acciones */}
                {widgets.length > 0 &&
                <button
                  onClick={() => {
                    setWidgets([]);
                    setSelectedId(null);
                    setMenuAbierto(false);
                  }}
                  className="flex w-full items-center gap-2 px-3 py-2.5 text-xs font-medium text-slate-500 transition hover:bg-red-50 hover:text-state-error dark:hover:bg-state-error/10">
                  <Trash2Icon className="h-3.5 w-3.5" />
                  {t('designer.clear')}
                </button>
                }
              </div>
            </>
            }
          </div>
        </div>
        }
      </header>

      {/* ═══ Contenido según pestaña activa ═══ */}
      {activeTab === 'alarms' ? (
        <AlarmsEditor />
      ) : activeTab === 'recipes' ? (
        <RecipesEditor />
      ) : activeTab === 'export' ? (
        <PanelExportar />
      ) : activeTab === 'designer' ? (
      <div className="flex flex-1 flex-col overflow-hidden">
        {/* Las pantallas del HMI. Van a ancho completo, sobre las tres
            columnas: la paleta de widgets y el inspector son los MISMOS para
            todas las pantallas, lo único que cambia debajo es el lienzo. */}
        <PantallasBar puedeEditar={puedeEditar} />

        <div className="flex flex-1 overflow-hidden">
        <WidgetSidebar />

        {/* Canvas */}
        <main className="mp-scroll mp-scroll-dark relative flex-1 overflow-auto p-8">
          <div
            ref={canvasRef}
            onDragOver={(e) => e.preventDefault()}
            onDrop={handleDrop}
            onPointerDown={() => setSelectedId(null)}
            className={`relative mx-auto rounded-xl border shadow-inner ${isDark ? 'border-navy-slate bg-navy-soft' : 'border-slate-300 bg-white'}`}
            style={{
              width: canvasW,
              height: canvasH
            }}>
            {widgets.length === 0 &&
            <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-slate-400">
                <MousePointer2Icon className="mb-3 h-10 w-10" />
                <p className="text-sm font-medium">{t('designer.dragHere')}</p>
                <p className="text-xs">{t('designer.designHint')}</p>
              </div>
            }
            {widgets.map((w) => {
            // En el Diseñador NO se oculta lo de otras vistas: se atenúa.
            // Si se ocultara habría que ir cambiando de sección para poder
            // tocar cada widget, y mover algo entre vistas sería un
            // suplicio. Atenuado se sigue viendo dónde está todo y se puede
            // seleccionar y arrastrar con normalidad.
            // "En todas" (vista vacía) se ve siempre; el resto solo si es
            // la sección abierta. Sin navegación montada, todo se ve.
            const suya = !(w.vista ?? '').trim() || !vistaActiva || w.vista === vistaActiva;

            // Con "Solo esta" se oculta de verdad, como en la Vista Previa:
            // es la única forma de ver una sección vacía y entender que la
            // navegación SÍ está funcionando. Con "Todas" se atenúa, para
            // poder arrastrar widgets de una sección a otra.
            if (!suya && aislarSeccion) return null;

            return (
            <div
              key={w.id}
              style={{ opacity: suya ? 1 : 0.28, transition: 'opacity 0.15s' }}
              title={suya ? undefined : `Pertenece a la sección «${w.vista}»`}>
            <CanvasWidget
              widget={w}
              variable={
              w.variableId ?
              variables.find((v) => v.id === w.variableId) :
              undefined
              }
              selected={w.id === selectedId}
              onSelect={setSelectedId}
              // Mover pasa SIEMPRE por moverBloque, tambien un widget
              // suelto: para el es un bloque de uno, y asi no hay dos
              // caminos distintos que puedan acabar comportandose distinto.
              onMove={(id, x, y) => {
                if (!puedeEditar) return;
                setWidgets((prev) =>
                moverBloque(prev, id, x, y, canvasW, canvasH)
                );
              }}
              onMoveStart={setArrastrando}
              onMoveEnd={(id) => {
                setArrastrando(null);
                if (!puedeEditar) return;
                // Al soltar se decide si entro o salio de un contenedor.
                // Solo aqui: hacerlo durante el arrastre haria que un widget
                // entrara y saliera de un grupo al pasar por encima.
                setWidgets((prev) => reasignarPadre(prev, id));
              }}
              onResize={(id, width, height) => patchWidget(id, { width, height })}
              onContextMenu={(id, x, y) => setMenuOrden({ id, x, y })}
              insignia={insigniaDe(w)}
              resaltado={destinoGrupo === w.id}
              canvasRef={canvasRef} />
            </div>
            );
            })}
          </div>
        </main>

        {/* ── MENÚ DEL CLIC DERECHO: ORDEN ─────────────────────
            Va aquí, fuera del lienzo, y con `position: fixed`. Dentro del
            lienzo lo recortaría el `overflow:auto` del contenedor en
            cuanto el widget estuviera cerca de un borde, que es justo
            donde más falta hace subir o bajar algo. */}
        {menuOrden && (() => {
          const w = widgets.find((x) => x.id === menuOrden.id);
          if (!w) return null;

          const acciones: {
            accion: AccionOrden;
            label: string;
            Icono: typeof ChevronsUpIcon;
          }[] = [
          { accion: 'frente', label: 'Traer al frente', Icono: ChevronsUpIcon },
          { accion: 'adelante', label: 'Traer adelante', Icono: ChevronUpIcon },
          { accion: 'atras', label: 'Enviar atrás', Icono: ChevronDownIcon },
          { accion: 'fondo', label: 'Enviar al fondo', Icono: ChevronsDownIcon }];

          // Que no se salga por el borde. Un menú medio fuera de pantalla
          // con la última opción cortada es peor que no tenerlo.
          const ANCHO = 200;
          const ALTO = 190;
          const x = Math.min(menuOrden.x, window.innerWidth - ANCHO - 8);
          const y = Math.min(menuOrden.y, window.innerHeight - ALTO - 8);

          return (
            <>
              <div
                className="fixed inset-0 z-[60]"
                onPointerDown={() => setMenuOrden(null)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setMenuOrden(null);
                }} />

              <div
                style={{ left: x, top: y, width: ANCHO }}
                className="fixed z-[61] overflow-hidden rounded-xl border border-slate-200 bg-white py-1 shadow-xl dark:border-navy-slate dark:bg-navy-soft">

                <div className="border-b border-slate-100 px-3 pb-1.5 pt-1 dark:border-navy-slate">
                  <p className="truncate text-[11px] font-semibold text-navy dark:text-slate-100">
                    {w.name}
                  </p>
                  {/* En qué posición está de la pila. Sin esto no se sabe si
                      «traer adelante» va a hacer algo. */}
                  <p className="text-[10px] text-slate-400">
                    Capa {widgets.findIndex((x) => x.id === w.id) + 1} de {widgets.length}
                  </p>
                </div>

                {acciones.map(({ accion, label, Icono }) => {
                  // Deshabilitado cuando ya está en ese extremo: pulsarlo y
                  // que no pase nada haría dudar de si funciona.
                  const puede = puedeEditar && puedeReordenar(widgets, w.id, accion);
                  return (
                    <button
                      key={accion}
                      disabled={!puede}
                      onClick={() => aplicarOrden(w.id, accion)}
                      className="flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-xs text-slate-600 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-35 disabled:hover:bg-transparent dark:text-slate-300 dark:hover:bg-navy-slate/50">
                      <Icono className="h-3.5 w-3.5 shrink-0 text-slate-400" />
                      {label}
                    </button>);

                })}

                {/* Un contenedor arrastra a los suyos: conviene decirlo antes
                    de pulsar, no después de ver moverse cinco widgets. */}
                {esContenedor(w.kind) && hijosDe(widgets, w.id).length > 0 &&
                <p className="border-t border-slate-100 px-3 pb-0.5 pt-1.5 text-[10px] leading-relaxed text-slate-400 dark:border-navy-slate">
                  Se mueve con sus {hijosDe(widgets, w.id).length} widgets dentro.
                </p>
                }
              </div>
            </>);

        })()}

        <PropertyInspector
          widget={selected}
          selectedVariables={selectedVariables}
          onChange={(patch) => selected && patchWidget(selected.id, patch)}
          onStyleChange={(patch) => selected && patchStyle(selected.id, patch)}
          onDelete={() => selected && deleteWidget(selected.id)} />
        </div>
      </div>
      ) : (
        <FlowEditor />
      )}
    </div>);

}
