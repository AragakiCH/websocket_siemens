// =========================================================================
// PantallasBar.tsx
// Barra de pestañas de las PANTALLAS del HMI, dentro del Diseñador.
//
// SOLO SE VEN LAS PANTALLAS DEL PROYECTO ABIERTO
// Un PROYECTO agrupa pantallas (ver `ProyectoSelector.tsx`). La barra pinta
// `pantallas`, que el AppStore pide ya filtradas por el proyecto activo: por
// eso la numeración empieza por 1 en cada proyecto y por eso no aparece aquí
// nada del proyecto de al lado.
//
// CADA PESTAÑA ES UN DOCUMENTO DEL BACKEND
// No hay un modelo nuevo: cada pestaña es un documento de `/pantallas/<id>`.
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
//   exportar                      -> cualquiera (es leer el diseño)
//   importar                      -> rol Administradores
//   la ÚLTIMA de un proyecto      -> tampoco: un proyecto sin pantallas es
//                                    una pestaña en la que no se puede ni
//                                    soltar un widget. Para deshacerse de él
//                                    está el borrado de proyectos.
//
// Renombrar exige además tener el LÁPIZ de esa pantalla, porque sube su
// versión: si lo hiciera alguien de fuera, quien está editando recibiría un
// 409 al guardar sin haber tocado nada.
// =========================================================================
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  PlusIcon,
  XIcon,
  CopyIcon,
  DownloadIcon,
  UploadIcon,
  MonitorIcon,
  AlertTriangleIcon,
  Loader2Icon,
  FolderIcon,
  FolderOpenIcon,
  FolderPlusIcon,
  ChevronDownIcon,
} from 'lucide-react';
import { useAppStore } from '../../context/AppStore';
import {
  crearPantalla,
  duplicarPantalla,
  renombrarPantalla,
  borrarPantalla,
  descargarPantalla,
  leerFicheroDePantalla,
  importarPantalla,
  PANTALLA_POR_DEFECTO,
} from '../../utils/designStorage';
import { sincronizarWidgets } from '../../services/zipWidgetLoader';
import {
  Grupo,
  EVENTO_GRUPOS,
  MAX_DE_GOLPE,
  cargarGrupos,
  gruposDe,
  asignacionesDe,
  crearGrupo,
  renombrarGrupo,
  borrarGrupo,
  moverPantallas,
} from '../../services/gruposApi';
import type { ResumenPantalla } from '../../utils/designStorage';
import { kindsSinDefinicion } from './custom/registry';
import { PilaDeAvisos } from '../ui/Avisos';

interface Props {
  /** Si esta persona tiene el lápiz de la pantalla activa. */
  puedeEditar: boolean;
}

/**
 * El tipo MIME del arrastre de una pestaña.
 *
 * Tiene que ser un tipo propio y no `text/plain`: con `text/plain` cualquier
 * texto arrastrado desde fuera del navegador —una celda de Excel, una URL—
 * contaría como una pantalla y acabaría intentando meter basura en un grupo.
 */
const TIPO_PANTALLA = 'psi-pantalla';

/** Alto máximo del desplegable de un grupo. Por encima, scroll. */
const ALTO_DESPLEGABLE = 'max-h-[280px]';

/**
 * Franja de los bordes de la barra que, al arrastrar sobre ella, la desplaza.
 *
 * Existe porque el arrastre nativo del navegador NO desplaza contenedores por
 * su cuenta: sin esto, una pestaña del final de la barra no se puede llevar a
 * un grupo del principio — no hay forma de llegar, el ratón se sale por el
 * borde y el arrastre se cancela.
 */
const BORDE_AUTOSCROLL = 84;

/** Píxeles por fotograma pegado al borde. A 60 fps son ~1080 px/s. */
const VELOCIDAD_AUTOSCROLL = 18;

export function PantallasBar({ puedeEditar }: Props) {
  const {
    t,
    pantallas,
    estadoPantallas,
    proyectoId,
    projectId,
    pantallaCargada,
    abrirPantalla,
    refrescarPantallas,
    refrescarProyectos,
    setProjectVersion,
    permisos,
  } = useAppStore();

  const [ocupado, setOcupado] = useState(false);
  const [error, setError] = useState('');
  // Confirmación de lo que salió bien. Importar tiene cosas que contar aunque
  // funcione: cuántos widgets entraron y qué enlaces se quedaron sin destino.
  const [aviso, setAviso] = useState('');
  const ficheroRef = useRef<HTMLInputElement>(null);
  const [renombrando, setRenombrando] = useState<string | null>(null);
  const [borrar, setBorrar] = useState<{ id: string; nombre: string } | null>(null);
  const barraRef = useRef<HTMLDivElement>(null);
  /** Píxeles por fotograma del auto-desplazamiento. 0 = parado. */
  const velocidadRef = useRef(0);
  const marcoRef = useRef<number | null>(null);

  // `permisos === null` significa que el backend corre sin identidad
  // (`auth_requerida=false`): ahí todo el mundo puede todo, que es el
  // comportamiento histórico y el de una instalación de una sola persona.
  const puedeCrear = !permisos || permisos.editar_diseño;
  const puedeBorrar = !permisos || permisos.gestionar_usuarios;

  // ── Grupos ────────────────────────────────────────────────────
  // Viven en su propio almacén, NO dentro del documento de la pantalla: meter
  // una pestaña en un grupo con un PATCH sobre ella exigiría el lápiz y
  // devolvería 423 en cuanto otra persona la tuviera abierta. Arrastrar una
  // pestaña es organizar, no editar. Ver `app/db/grupos_store.py`.
  const [grupos, setGrupos] = useState<Grupo[]>([]);
  const [asignaciones, setAsignaciones] = useState<Record<string, string>>({});
  /** El grupo con el desplegable abierto. Solo uno a la vez. */
  const [abierto, setAbierto] = useState<string | null>(null);
  /**
   * A qué altura horizontal se pinta el desplegable.
   *
   * Los paneles flotantes NO pueden vivir dentro de la tira de pestañas: esa
   * tira es `overflow-x-auto`, y un contenedor con overflow en un eje recorta
   * también en el otro — el desplegable saldría cortado a la altura de la
   * barra. Así que se pintan a nivel de la raíz y se les mide aquí la `x` del
   * botón que los abrió.
   */
  const [anclaX, setAnclaX] = useState(0);
  const raizRef = useRef<HTMLDivElement>(null);
  const [creandoGrupo, setCreandoGrupo] = useState(false);
  const [renombrandoGrupo, setRenombrandoGrupo] = useState<string | null>(null);
  const [borrarGrupoId, setBorrarGrupoId] =
    useState<{ id: string; nombre: string } | null>(null);
  /** El `project_id` que va en el aire ahora mismo, o `null`. */
  const [arrastrando, setArrastrando] = useState<string | null>(null);
  /** La zona de soltar resaltada: el id del grupo, o `'sueltas'`. */
  const [sobre, setSobre] = useState<string | null>(null);
  const [menuNueva, setMenuNueva] = useState(false);

  // La caché de `gruposApi` es la fuente; aquí solo se copia a estado para
  // que React repinte. El evento lo dispara CUALQUIER cambio —propio o de
  // otra pestaña del navegador vía WebSocket—, así que con esto basta.
  useEffect(() => {
    let vivo = true;
    const sincronizar = () => {
      if (!vivo) return;
      setGrupos(gruposDe(proyectoId));
      setAsignaciones(asignacionesDe(proyectoId));
    };
    void cargarGrupos(proyectoId).then(sincronizar).catch(sincronizar);
    window.addEventListener(EVENTO_GRUPOS, sincronizar);
    return () => {
      vivo = false;
      window.removeEventListener(EVENTO_GRUPOS, sincronizar);
    };
  }, [proyectoId]);

  // Al cambiar de proyecto no tiene sentido seguir con un grupo del anterior
  // desplegado: su id no existe aquí y el panel saldría vacío.
  useEffect(() => {
    setAbierto(null);
    setCreandoGrupo(false);
    setRenombrandoGrupo(null);
  }, [proyectoId]);

  /**
   * Las pantallas repartidas: las de cada grupo y las que van sueltas.
   *
   * Una asignación que apunta a un grupo que ya no existe NO esconde la
   * pantalla: cae a las sueltas. Perder una pestaña por un dato viejo sería,
   * a ojos de quien la busca, haber perdido su diseño.
   */
  const { porGrupo, sueltas } = useMemo(() => {
    const m = new Map<string, ResumenPantalla[]>();
    grupos.forEach((g) => m.set(g.id, []));
    const fuera: ResumenPantalla[] = [];
    pantallas.forEach((p) => {
      const destino = m.get(asignaciones[p.project_id] ?? '');
      if (destino) destino.push(p);
      else fuera.push(p);
    });
    return { porGrupo: m, sueltas: fuera };
  }, [grupos, asignaciones, pantallas]);

  // Cerrar el desplegable al pulsar fuera o con Escape. Sin esto se queda
  // abierto tapando el lienzo mientras se trabaja.
  useEffect(() => {
    if (!abierto && !menuNueva) return;
    const fuera = (e: MouseEvent) => {
      const el = e.target as HTMLElement | null;
      if (el?.closest('[data-psi-flotante]')) return;
      setAbierto(null);
      setMenuNueva(false);
    };
    const tecla = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setAbierto(null);
        setMenuNueva(false);
      }
    };
    document.addEventListener('mousedown', fuera);
    window.addEventListener('keydown', tecla);
    return () => {
      document.removeEventListener('mousedown', fuera);
      window.removeEventListener('keydown', tecla);
    };
  }, [abierto, menuNueva]);

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
  const nuevaPantalla = () =>
    conError(async () => {
      // El contador se reinicia en cada proyecto porque `pantallas` ya viene
      // filtrada: la segunda pantalla del proyecto nuevo es su "Pantalla 2",
      // aunque en el servidor haya otras seis.
      const n = pantallas.length + 1;
      const creada = await crearPantalla(
        `${t('screens.defaultName')} ${n}`,
        proyectoId
      );
      await refrescarPantallas();
      // El contador del selector de proyectos también cambió.
      await refrescarProyectos();
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
        `${actual?.nombre ?? projectId} ${t('screens.copySuffix')}`,
        proyectoId
      );
      await refrescarPantallas();
      await refrescarProyectos();
      abrirPantalla(copia.project_id);
    });

  const exportar = () =>
    conError(async () => {
      const actual = pantallas.find((p) => p.project_id === projectId);
      const fichero = await descargarPantalla(
        projectId,
        actual?.nombre ?? projectId
      );
      setAviso(`${t('screens.exported')} ${fichero}`);
    });

  /**
   * Importar una pantalla en el proyecto abierto.
   *
   * El `value = ''` del final no es un detalle: sin él, elegir el MISMO
   * fichero dos veces seguidas no dispara `change` y parece que el botón se
   * ha quedado colgado.
   */
  const alElegirFichero = (e: React.ChangeEvent<HTMLInputElement>) => {
    const archivo = e.target.files?.[0];
    e.target.value = '';
    if (!archivo) return;
    void conError(async () => {
      const doc = await leerFicheroDePantalla(archivo);
      const r = await importarPantalla(doc, proyectoId);

      // Los widgets personalizados del fichero acaban de entrar en el
      // SERVIDOR, pero el lienzo los resuelve contra una caché local que solo
      // se llena al arrancar. Sin esto, la pantalla importada se abre con
      // cajas vacías hasta recargar la página.
      await sincronizarWidgets();

      await refrescarPantallas();
      await refrescarProyectos();
      abrirPantalla(r.project_id);

      const partes = [
        `«${r.nombre}»: ${r.num_widgets} ${t('screens.importedWidgets')}.`,
      ];
      if (r.enlaces_sueltos.length > 0) {
        partes.push(
          `${r.enlaces_sueltos.length} ${t('screens.importedLinks')}`
        );
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

      if (r.variables_importadas.length > 0) {
        partes.push(
          `${r.variables_importadas.length} ${t('projects.importedVars')}`
        );
      }
      if (r.variables_ya_existentes.length > 0) {
        partes.push(
          `${r.variables_ya_existentes.length} ${t('projects.importedVarsKept')}`
        );
      }

      // Los dos avisos de problema se juntan en UNO.
      //
      // Antes cada uno llamaba a `setError` por su cuenta, así que si una
      // importación traía las dos cosas —widgets que faltan y una variable
      // con el tipo cambiado— la segunda llamada borraba a la primera y el
      // usuario solo veía la mitad de lo que le pasaba.
      const problemas: string[] = [];

      // Las variables de tipo distinto van aquí y no al aviso de «salió
      // bien». El widget se enlaza igual —la clave es el nombre— y enseñará
      // algo sin sentido sin dar ningún fallo: una consigna que allí era un
      // decimal y aquí es un sí/no. Es el único caso en que callarse hace
      // daño.
      if (r.variables_en_conflicto.length > 0) {
        const detalle = r.variables_en_conflicto
          .map((c) =>
            c.error
              ? `${c.nombre} (${c.error})`
              : `${c.nombre} (aquí ${c.tipo_aqui}, en el fichero ${c.tipo_del_fichero})`
          )
          .join(', ');
        problemas.push(`${t('projects.importedVarsConflict')} ${detalle}.`);
      }

      // Lo que no se va a poder dibujar: la pantalla está importada, pero se
      // verá incompleta.
      const faltan = kindsSinDefinicion((doc.pantalla?.widgets ?? []) as any[]);
      if (faltan.length > 0) {
        problemas.push(`${t('projects.importedMissing')} ${faltan.join(', ')}.`);
      }

      if (problemas.length > 0) setError(problemas.join(' '));
      setAviso(partes.join(' '));
    });
  };

  const confirmarBorrado = () => {
    if (!borrar) return;
    const id = borrar.id;
    setBorrar(null);
    void conError(async () => {
      await borrarPantalla(id);
      const lista = await refrescarPantallas();
      await refrescarProyectos();
      // El WebSocket también avisa, pero no se espera a él: quien pulsó
      // Eliminar tiene que ver el efecto ya, no dentro de un instante.
      //
      // Se salta a otra pantalla DEL MISMO proyecto, no a la principal: si
      // estabas en el proyecto "Línea 2", acabar en la pantalla principal del
      // proyecto de al lado sería un salto que nadie pidió. El servidor no
      // deja borrar la última, así que siempre queda alguna.
      if (id === projectId) {
        const destino = lista?.[0];
        if (destino) abrirPantalla(destino.project_id);
      }
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

  // ── Acciones sobre los grupos ─────────────────────────────────
  //
  // Van por `conErrorDeGrupo` y no por `conError`: los mensajes del servidor
  // aquí ya están escritos para leerse («todavía tiene 3 pantallas dentro»).
  // `mensajeDeError` traduce el 409 a «otra persona guardó cambios», que es
  // verdad para una pantalla y mentira para un grupo.
  const conErrorDeGrupo = useCallback(async (fn: () => Promise<void>) => {
    setOcupado(true);
    setError('');
    setAviso('');
    try {
      await fn();
    } catch (e: any) {
      setError(
        e?.status === 403
          ? 'Tu categoría no permite esta acción. Organizar las pestañas ' +
            'exige rol Administradores.'
          : e?.message || 'No se pudo completar la operación.'
      );
    } finally {
      setOcupado(false);
    }
  }, []);

  const aplicarNombreGrupo = (nombre: string) => {
    const id = renombrandoGrupo;
    setRenombrandoGrupo(null);
    const actual = grupos.find((g) => g.id === id);
    const limpio = nombre.trim();
    if (!id || !limpio || limpio === actual?.nombre) return;
    void conErrorDeGrupo(async () => {
      await renombrarGrupo(id, limpio, proyectoId);
    });
  };

  const aplicarGrupoNuevo = (nombre: string) => {
    setCreandoGrupo(false);
    const limpio = nombre.trim();
    if (!limpio) return;
    void conErrorDeGrupo(async () => {
      const g = await crearGrupo(limpio, proyectoId);
      // Se abre recién creado: está vacío, y lo siguiente que va a hacer
      // quien lo creó es meterle pantallas.
      setAbierto(g.id);
    });
  };

  const confirmarBorrarGrupo = () => {
    if (!borrarGrupoId) return;
    const id = borrarGrupoId.id;
    setBorrarGrupoId(null);
    void conErrorDeGrupo(async () => {
      await borrarGrupo(id, proyectoId);
      setAbierto((a) => (a === id ? null : a));
    });
  };

  /**
   * Mete una pantalla en un grupo, o la saca (`grupo = null`).
   *
   * No toca el documento de la pantalla: ni sube su versión ni pide el
   * lápiz. Por eso se puede arrastrar una pestaña que otra persona tiene
   * abierta sin estorbarle.
   */
  const cambiarGrupo = (pantalla: string, grupo: string | null) => {
    if (!pantalla) return;
    // Soltar una pestaña donde ya estaba no gasta una petición ni pinta un
    // «ocupado» de medio segundo por nada.
    if ((asignaciones[pantalla] ?? '') === (grupo ?? '')) return;
    void conErrorDeGrupo(async () => {
      await moverPantallas([{ pantalla, grupo }], proyectoId);
      if (grupo) setAbierto(grupo);
    });
  };

  /**
   * Crea N pantallas de una tacada, opcionalmente dentro de un grupo.
   *
   * Las asignaciones van en UNA sola petición al final, no una por pantalla:
   * si fallara la tercera, la mitad quedaría dentro del grupo y la otra
   * mitad suelta, sin nada en la pantalla que lo explicara.
   */
  const crearVarias = (cuantas: number, grupo: string) =>
    conError(async () => {
      const n = Math.max(1, Math.min(MAX_DE_GOLPE, Math.floor(cuantas || 1)));
      const base = pantallas.length;
      const creadas: string[] = [];
      for (let i = 1; i <= n; i++) {
        const c = await crearPantalla(
          `${t('screens.defaultName')} ${base + i}`,
          proyectoId
        );
        creadas.push(c.project_id);
      }
      if (grupo) {
        await moverPantallas(
          creadas.map((pantalla) => ({ pantalla, grupo })),
          proyectoId
        );
      }
      await refrescarPantallas();
      await refrescarProyectos();
      if (creadas[0]) abrirPantalla(creadas[0]);
      if (grupo) setAbierto(grupo);
      setAviso(`${n} ${t('screens.createdMany')}`);
    });

  /**
   * Abre o cierra el desplegable de un grupo, midiendo dónde ponerlo.
   *
   * Se mide en el momento de abrir y no en cada render: si se recalculara
   * mientras está abierto, arrastrar una pestaña dentro lo movería bajo el
   * cursor.
   */
  const alternarGrupo = (gid: string, chip: HTMLElement | null) => {
    setMenuNueva(false);
    if (abierto === gid) {
      setAbierto(null);
      return;
    }
    const raiz = raizRef.current;
    if (chip && raiz) {
      setAnclaX(
        chip.getBoundingClientRect().left - raiz.getBoundingClientRect().left
      );
    }
    setAbierto(gid);
  };

  /** Lo mismo para el menú de «crear varias». */
  const alternarMenuNueva = (boton: HTMLElement | null) => {
    setAbierto(null);
    if (menuNueva) {
      setMenuNueva(false);
      return;
    }
    const raiz = raizRef.current;
    if (boton && raiz) {
      setAnclaX(
        boton.getBoundingClientRect().left - raiz.getBoundingClientRect().left
      );
    }
    setMenuNueva(true);
  };

  // ── Arrastrar hasta el otro extremo de la barra ────────────────
  //
  // El bucle vive en un `requestAnimationFrame` y no en el propio `dragover`:
  // el navegador solo dispara `dragover` cuando el ratón SE MUEVE, así que
  // dejar el puntero quieto contra el borde —que es justo lo que uno hace
  // mientras espera a que llegue el grupo del principio— no desplazaría nada.

  const detenerDesplazamiento = useCallback(() => {
    velocidadRef.current = 0;
    if (marcoRef.current !== null) {
      cancelAnimationFrame(marcoRef.current);
      marcoRef.current = null;
    }
  }, []);

  const desplazar = useCallback(() => {
    const barra = barraRef.current;
    if (!barra || velocidadRef.current === 0) {
      marcoRef.current = null;
      return;
    }
    const antes = barra.scrollLeft;
    barra.scrollLeft = antes + velocidadRef.current;
    // Tope alcanzado: se para el bucle en vez de gastar un fotograma por
    // frame contra una pared.
    if (barra.scrollLeft === antes) {
      marcoRef.current = null;
      velocidadRef.current = 0;
      return;
    }
    marcoRef.current = requestAnimationFrame(desplazar);
  }, []);

  /**
   * Mira dónde está el puntero y decide si hay que desplazar.
   *
   * La velocidad sube con lo cerca que esté del borde: rozando la franja se
   * mueve despacio (se puede soltar con precisión) y pegado al canto va
   * rápido (se cruza la barra entera sin esperar).
   */
  const vigilarBordes = useCallback((e: React.DragEvent) => {
    const barra = barraRef.current;
    if (!barra) return;
    const caja = barra.getBoundingClientRect();
    const izquierda = e.clientX - caja.left;
    const derecha = caja.right - e.clientX;

    let v = 0;
    if (izquierda < BORDE_AUTOSCROLL) {
      v = -Math.ceil(((BORDE_AUTOSCROLL - izquierda) / BORDE_AUTOSCROLL) * VELOCIDAD_AUTOSCROLL);
    } else if (derecha < BORDE_AUTOSCROLL) {
      v = Math.ceil(((BORDE_AUTOSCROLL - derecha) / BORDE_AUTOSCROLL) * VELOCIDAD_AUTOSCROLL);
    }

    velocidadRef.current = v;
    if (v !== 0 && marcoRef.current === null) {
      marcoRef.current = requestAnimationFrame(desplazar);
    } else if (v === 0) {
      detenerDesplazamiento();
    }
  }, [desplazar, detenerDesplazamiento]);

  // Si el componente se va con un arrastre a medias, el bucle se quedaría
  // corriendo contra un nodo que ya no existe.
  useEffect(() => detenerDesplazamiento, [detenerDesplazamiento]);

  /**
   * Vuelve a medir dónde cuelga el desplegable abierto.
   *
   * Se llama al desplazar la barra. Antes esto CERRABA el panel, que era lo
   * fácil pero dejaba tirado a quien estaba arrastrando una pantalla desde
   * dentro de un grupo hasta el otro extremo.
   */
  const reanclar = useCallback(() => {
    const raiz = raizRef.current;
    const barra = barraRef.current;
    if (!raiz || !barra) return;
    const selector = abierto
      ? `[data-grupo="${CSS.escape(abierto)}"]`
      : menuNueva
        ? '[data-nueva]'
        : '';
    if (!selector) return;
    const ancla = barra.querySelector(selector) as HTMLElement | null;
    if (ancla) {
      setAnclaX(ancla.getBoundingClientRect().left - raiz.getBoundingClientRect().left);
    }
  }, [abierto, menuNueva]);

  // Tras soltar una pantalla en un grupo, el panel se abre solo: hay que
  // medirlo aquí porque nadie pulsó su ficha.
  useEffect(() => {
    if (abierto || menuNueva) reanclar();
  }, [abierto, menuNueva, reanclar]);

  /** ¿Este arrastre trae una pestaña nuestra? */
  const esNuestro = (e: React.DragEvent) =>
    e.dataTransfer.types.includes(TIPO_PANTALLA);

  /**
   * Una pestaña de pantalla.
   *
   * La MISMA pieza sirve en la tira y dentro del desplegable de un grupo;
   * `enPanel` cambia la forma, no el comportamiento. Si fueran dos
   * componentes distintos, arreglar un fallo en uno dejaría el otro roto —
   * que es exactamente como se separan las cosas con el tiempo.
   */
  const pestana = (p: ResumenPantalla, enPanel: boolean) => {
    const activa = p.project_id === projectId;
    const editando = renombrando === p.project_id;
    // Solo se renombra la pantalla ACTIVA y con el lápiz en la mano: el
    // PATCH sube la versión y el backend exige el lock.
    const renombrable = activa && puedeEditar && puedeCrear;
    // Dos pantallas no se dejan borrar, y el backend rechaza las dos: la
    // principal (destino de rescate global) y la última que le quede a un
    // proyecto. Se cuentan TODAS las del proyecto, no las de este grupo.
    const esUltima = pantallas.length <= 1;
    const protegida = p.project_id === PANTALLA_POR_DEFECTO || esUltima;
    const enVuelo = arrastrando === p.project_id;

    return (
      // Un `div` pelado, NO un `motion.div` con `layout`.
      //
      // Esto fue un fallo real: framer-motion mide las posiciones de `layout`
      // en coordenadas de la VENTANA, y esta tira es `overflow-x-auto`. Al
      // sacar una pestaña —meterla en un grupo— las hermanas se quedaban con
      // el `transform` de la posición vieja: un hueco enorme en medio de la
      // barra que no se iba solo. El reflujo normal de flex las recoloca al
      // instante y sin nada que se pueda quedar a medias.
      <div
        key={p.project_id}
        draggable={puedeCrear && !editando && !ocupado}
        onDragStart={(e: any) => {
          e.dataTransfer.setData(TIPO_PANTALLA, p.project_id);
          e.dataTransfer.effectAllowed = 'move';
          setArrastrando(p.project_id);
        }}
        onDragEnd={() => {
          setArrastrando(null);
          setSobre(null);
          detenerDesplazamiento();
        }}
        className={`group flex shrink-0 items-center rounded-lg border transition-colors ${
          enPanel ? 'w-full' : ''
        } ${enVuelo ? 'opacity-40' : ''} ${
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
            onClick={() => {
              abrirPantalla(p.project_id);
              // Abrir desde el desplegable lo cierra: el lienzo que se
              // acaba de pedir está justo debajo del panel.
              if (enPanel) setAbierto(null);
            }}
            onDoubleClick={() => renombrable && setRenombrando(p.project_id)}
            title={
              renombrable ? t('screens.renameHint') : `${p.nombre} · ${p.project_id}`
            }
            className={`flex min-h-[32px] items-center gap-2 rounded-lg pl-3 pr-2 text-xs font-semibold outline-none transition-colors focus-visible:ring-2 focus-visible:ring-siemens/40 ${
              enPanel ? 'min-w-0 flex-1' : 'max-w-[220px]'
            } ${
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

            {/* El contador dice si la pantalla tiene algo dentro. Con seis
                pestañas es la diferencia entre encontrar la que buscas y
                abrirlas todas una por una. */}
            <span
              className={`ml-auto shrink-0 rounded-full px-1.5 text-[10px] tabular-nums ${
                activa
                  ? 'bg-siemens-50 text-siemens dark:bg-siemens/20 dark:text-siemens-200'
                  : 'bg-slate-200/70 text-slate-400 dark:bg-navy-slate/60'
              }`}
            >
              {p.num_widgets}
            </span>

            {/* Indicador de carga: al cambiar de pestaña hay un instante en
                que los widgets todavía son los de la anterior. Decirlo evita
                que parezca que no pasó nada. */}
            {activa && pantallaCargada !== projectId && (
              <Loader2Icon className="h-3 w-3 shrink-0 animate-spin text-slate-400" />
            )}
          </button>
        )}

        {/* Cerrar = eliminar. `principal` no se puede borrar, y en vez de
            esconder el botón se deshabilita explicando por qué: un control
            que desaparece sin motivo confunde más. */}
        {!editando && puedeBorrar && (
          <button
            type="button"
            disabled={protegida || ocupado}
            onClick={() => setBorrar({ id: p.project_id, nombre: p.nombre })}
            title={
              protegida
                ? esUltima
                  ? t('screens.cantDeleteLast')
                  : t('screens.cantDeleteMain')
                : t('screens.delete')
            }
            aria-label={`${t('screens.delete')}: ${p.nombre}`}
            className={`mr-1 flex h-6 w-6 shrink-0 items-center justify-center rounded outline-none transition focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-siemens/40 ${
              activa || enPanel ? 'opacity-60' : 'opacity-0 group-hover:opacity-60'
            } ${
              protegida
                ? 'cursor-not-allowed text-slate-300 dark:text-slate-600'
                : 'text-slate-400 hover:bg-red-50 hover:text-state-error hover:opacity-100 dark:hover:bg-state-error/10'
            }`}
          >
            <XIcon className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
    );
  };

  return (
    <div
      ref={raizRef}
      className="relative border-b border-slate-200 bg-slate-50 dark:border-navy-slate dark:bg-navy"
    >
      <div className="flex items-stretch gap-1 px-2">

        {/* ── Las pestañas ────────────────────────────────── */}
        <div
          ref={barraRef}
          role="tablist"
          aria-label={t('screens.barLabel')}
          className="mp-scroll mp-scroll-dark flex min-w-0 flex-1 items-stretch gap-1 overflow-x-auto py-1.5"
          // El panel se ancló a una `x` medida al abrirlo; al desplazar la
          // tira se vuelve a medir para que siga colgando de su ficha.
          //
          // Antes esto CERRABA lo que hubiera abierto, y era peor de lo que
          // parecía: el navegador desplaza la barra solo al enfocar un botón
          // que queda fuera de la vista, así que abrir el menú de «varias»
          // podía cerrarlo en el mismo gesto.
          onScroll={reanclar}
          // Arrastrar contra un borde desplaza la barra. Va en la TIRA y no en
          // cada zona: así funciona también sobre los huecos entre pestañas.
          onDragOver={vigilarBordes}
          onDragLeave={(e) => {
            if (e.currentTarget.contains(e.relatedTarget as Node)) return;
            detenerDesplazamiento();
          }}
          onDrop={detenerDesplazamiento}
        >
          {/* ── Fichas de grupo ──────────────────────────────
              Van SIEMPRE antes que las pantallas sueltas. Si cada ficha
              ocupara el sitio de la primera pantalla que se metió dentro,
              los grupos se moverían solos al borrar pantallas y habría que
              buscarlos cada vez. Aquí están donde uno los dejó. */}
          {grupos.map((g) => {
            const dentro = porGrupo.get(g.id) ?? [];
            const activo = dentro.some((p) => p.project_id === projectId);
            const desplegado = abierto === g.id;
            const editandoG = renombrandoGrupo === g.id;
            const encima = sobre === g.id;
            const renombrableG = puedeCrear && !ocupado;

            return (
              <div
                key={g.id}
                data-grupo={g.id}
                className="relative shrink-0"
                data-psi-flotante
              >
                <div
                  onDragOver={(e) => {
                    if (!esNuestro(e) || !puedeCrear) return;
                    e.preventDefault();
                    e.dataTransfer.dropEffect = 'move';
                    setSobre(g.id);
                  }}
                  onDragLeave={(e) => {
                    // SIN este guardia, pasar por encima de un hijo dispara
                    // el `dragleave` del padre y el resaltado parpadea aunque
                    // no se haya salido de la ficha.
                    if (e.currentTarget.contains(e.relatedTarget as Node)) return;
                    setSobre((z) => (z === g.id ? null : z));
                  }}
                  onDrop={(e) => {
                    if (!esNuestro(e)) return;
                    e.preventDefault();
                    setSobre(null);
                    cambiarGrupo(e.dataTransfer.getData(TIPO_PANTALLA), g.id);
                  }}
                  className={`group flex items-center rounded-lg border transition-colors ${
                    encima
                      ? 'border-siemens bg-siemens-50 ring-2 ring-siemens/30 dark:bg-siemens/15'
                      : activo || desplegado
                        ? 'border-siemens/40 bg-white shadow-sm dark:border-siemens/30 dark:bg-navy-soft'
                        : 'border-transparent hover:bg-white/70 dark:hover:bg-navy-soft/60'
                  }`}
                >
                  {editandoG ? (
                    <EntradaNombre
                      inicial={g.nombre}
                      onAceptar={aplicarNombreGrupo}
                      onCancelar={() => setRenombrandoGrupo(null)}
                    />
                  ) : (
                    <button
                      type="button"
                      aria-expanded={desplegado}
                      onClick={(e) => alternarGrupo(g.id, e.currentTarget.parentElement)}
                      onDoubleClick={() => renombrableG && setRenombrandoGrupo(g.id)}
                      title={
                        renombrableG
                          ? t('groups.renameHint')
                          : `${g.nombre} · ${dentro.length} ${t('groups.screensInside')}`
                      }
                      className={`flex min-h-[32px] max-w-[220px] items-center gap-2 rounded-lg pl-3 pr-2 text-xs font-semibold outline-none transition-colors focus-visible:ring-2 focus-visible:ring-siemens/40 ${
                        activo || desplegado
                          ? 'text-navy dark:text-slate-100'
                          : 'text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200'
                      }`}
                    >
                      {desplegado ? (
                        <FolderOpenIcon className="h-3.5 w-3.5 shrink-0 text-siemens" />
                      ) : (
                        <FolderIcon
                          className={`h-3.5 w-3.5 shrink-0 ${
                            activo ? 'text-siemens' : 'text-slate-400'
                          }`}
                        />
                      )}
                      <span className="truncate">{g.nombre}</span>

                      {/* Cuántas pantallas tiene dentro. Es lo que dice si
                          merece la pena abrirlo. */}
                      <span
                        className={`shrink-0 rounded-full px-1.5 text-[10px] tabular-nums ${
                          activo || desplegado
                            ? 'bg-siemens-50 text-siemens dark:bg-siemens/20 dark:text-siemens-200'
                            : 'bg-slate-200/70 text-slate-400 dark:bg-navy-slate/60'
                        }`}
                      >
                        {dentro.length}
                      </span>

                      <ChevronDownIcon
                        className={`h-3 w-3 shrink-0 text-slate-400 transition-transform ${
                          desplegado ? 'rotate-180' : ''
                        }`}
                      />
                    </button>
                  )}

                  {/* Borrar el grupo. Se deshabilita mientras tenga algo
                      dentro en vez de esconderse, y el título dice por qué y
                      que NO se pierde ninguna pantalla — que es la duda real
                      de quien se lo piensa. */}
                  {!editandoG && puedeCrear && (
                    <button
                      type="button"
                      disabled={dentro.length > 0 || ocupado}
                      onClick={() => setBorrarGrupoId({ id: g.id, nombre: g.nombre })}
                      title={
                        dentro.length > 0 ? t('groups.cantDeleteFull') : t('groups.delete')
                      }
                      aria-label={`${t('groups.delete')}: ${g.nombre}`}
                      className={`mr-1 flex h-6 w-6 shrink-0 items-center justify-center rounded outline-none transition focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-siemens/40 ${
                        activo || desplegado ? 'opacity-60' : 'opacity-0 group-hover:opacity-60'
                      } ${
                        dentro.length > 0
                          ? 'cursor-not-allowed text-slate-300 dark:text-slate-600'
                          : 'text-slate-400 hover:bg-red-50 hover:text-state-error hover:opacity-100 dark:hover:bg-state-error/10'
                      }`}
                    >
                      <XIcon className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>

              </div>
            );
          })}

          {/* Crear un grupo: el nombre se escribe en la propia barra, en el
              hueco que va a ocupar la ficha. Un diálogo aparte para pedir una
              palabra es fricción que no compra nada. */}
          {creandoGrupo && (
            <div className="flex shrink-0 items-center self-center">
              <EntradaNombre
                inicial={`${t('groups.defaultName')} ${grupos.length + 1}`}
                onAceptar={aplicarGrupoNuevo}
                onCancelar={() => setCreandoGrupo(false)}
              />
            </div>
          )}

          {puedeCrear && !creandoGrupo && (
            <button
              type="button"
              onClick={() => setCreandoGrupo(true)}
              disabled={ocupado}
              title={t('groups.newHint')}
              aria-label={t('groups.new')}
              className="flex h-[32px] w-[32px] shrink-0 items-center justify-center self-center rounded-lg text-slate-400 outline-none transition hover:bg-white hover:text-siemens focus-visible:ring-2 focus-visible:ring-siemens/40 disabled:cursor-not-allowed disabled:opacity-40 dark:hover:bg-navy-soft"
            >
              <FolderPlusIcon className="h-4 w-4" />
            </button>
          )}

          {/* Separador. Sin él, la primera pantalla suelta se lee como una
              ficha de grupo más. */}
          {grupos.length > 0 && (
            <span className="my-2 w-px shrink-0 self-stretch bg-slate-200 dark:bg-navy-slate" />
          )}

          {/* ── Las pantallas sueltas ────────────────────────
              Esta tira es ADEMÁS la zona de «sacar del grupo»: soltar aquí
              una pestaña que venía de un grupo la devuelve a la barra. Ocupa
              todo el ancho que sobra para que acertar sea fácil incluso con
              el proyecto casi vacío. */}
          <div
            onDragOver={(e) => {
              if (!esNuestro(e) || !puedeCrear) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = 'move';
              setSobre('sueltas');
            }}
            onDragLeave={(e) => {
              if (e.currentTarget.contains(e.relatedTarget as Node)) return;
              setSobre((z) => (z === 'sueltas' ? null : z));
            }}
            onDrop={(e) => {
              if (!esNuestro(e)) return;
              e.preventDefault();
              setSobre(null);
              cambiarGrupo(e.dataTransfer.getData(TIPO_PANTALLA), null);
            }}
            // `grow shrink-0` (= `flex: 1 0 auto`), NUNCA `flex-1`.
            //
            // `flex-1` es `flex: 1 1 0%`: la tira medía CERO y luego crecía
            // solo hasta el ancho VISIBLE, así que con doce pestañas dentro
            // el contenedor creía que cabía todo y el desplazamiento se
            // quedaba corto. Con base `auto` la tira mide lo que miden sus
            // pestañas —y sigue creciendo para llenar el hueco sobrante, que
            // es lo que hace grande la zona de «soltar aquí para sacarla».
            className={`flex shrink-0 grow items-stretch gap-1 rounded-lg transition-colors ${
              sobre === 'sueltas'
                ? 'bg-siemens-50 ring-2 ring-inset ring-siemens/30 dark:bg-siemens/10'
                : ''
            }`}
          >
            {sueltas.map((p) => pestana(p, false))}

            {/* Cuando se arrastra desde dentro de un grupo y no queda
                ninguna pantalla suelta, la tira estaría vacía y no habría
                nada que señalar dónde soltar. */}
            {arrastrando && sueltas.length === 0 && (
              <p className="flex items-center self-center px-3 text-[11px] text-slate-400">
                {t('groups.dropOut')}
              </p>
            )}
            {/* Barra vacía. El servidor no deja que un proyecto se quede
                sin pantallas, así que si aquí no hay ninguna es que la lista
                no llegó: lo normal es que el backend esté caído o que la
                petición no salga de la máquina (en desarrollo, un prefijo que
                falta en el proxy de `vite.config.js`). Decirlo ahorra buscar
                el fallo en el sitio equivocado.

                Se mira `pantallas`, no `sueltas`: con todas metidas en grupos
                la tira suelta está vacía y eso NO es un error. */}
            {pantallas.length === 0 && (
              <p className="flex items-center gap-2 self-center px-2 text-xs text-slate-400">
                {estadoPantallas === 'cargando' ? (
                  <>
                    <Loader2Icon className="h-3.5 w-3.5 animate-spin" />
                    {t('screens.loading')}
                  </>
                ) : (
                  <>
                    <AlertTriangleIcon className="h-3.5 w-3.5 text-state-error" />
                    {t('screens.loadFailed')}
                  </>
                )}
              </p>
            )}

            {/* ── Nueva pantalla ────────────────────────────
                Vive DENTRO de la tira, pegado a la última pestaña, y no en
                el bloque de acciones de la derecha. Es donde se busca: la
                pestaña nueva va a salir justo ahí, así que el botón que la
                crea señala el hueco que va a ocupar.

                Un solo clic sigue creando UNA pantalla, como siempre. El
                menú de «varias» se abre con la flecha, aparte: si el botón
                entero abriera un menú, la acción de todos los días pasaría a
                costar dos clics por culpa de la que se usa una vez al mes. */}
            {puedeCrear && (
              <div
                data-nueva
                className="relative flex shrink-0 self-center"
                data-psi-flotante
              >
                <button
                  type="button"
                  onClick={nuevaPantalla}
                  disabled={ocupado}
                  title={t('screens.new')}
                  aria-label={t('screens.new')}
                  className="flex h-[32px] w-[28px] items-center justify-center rounded-l-lg pl-1 text-slate-400 outline-none transition hover:bg-white hover:text-siemens focus-visible:ring-2 focus-visible:ring-siemens/40 disabled:cursor-not-allowed disabled:opacity-40 dark:hover:bg-navy-soft"
                >
                  {ocupado ? (
                    <Loader2Icon className="h-4 w-4 animate-spin" />
                  ) : (
                    <PlusIcon className="h-4 w-4" />
                  )}
                </button>
                <button
                  type="button"
                  onClick={(e) => alternarMenuNueva(e.currentTarget.parentElement)}
                  disabled={ocupado}
                  title={t('screens.newMany')}
                  aria-label={t('screens.newMany')}
                  aria-expanded={menuNueva}
                  className="flex h-[32px] w-[18px] items-center justify-center rounded-r-lg pr-1 text-slate-400 outline-none transition hover:bg-white hover:text-siemens focus-visible:ring-2 focus-visible:ring-siemens/40 disabled:cursor-not-allowed disabled:opacity-40 dark:hover:bg-navy-soft"
                >
                  <ChevronDownIcon
                    className={`h-3 w-3 transition-transform ${
                      menuNueva ? 'rotate-180' : ''
                    }`}
                  />
                </button>

              </div>
            )}
          </div>
        </div>


        {/* ── Acciones ───────────────────────────────────────
            Las tres hacen lo mismo visto de lejos —conseguir otra pantalla—
            así que van juntas: duplicar la de al lado, traerla de un fichero,
            o guardarla en uno. */}
        <div className="flex shrink-0 items-center gap-1 border-l border-slate-200 py-1.5 pl-2 dark:border-navy-slate">
          {/* Exportar no exige rol: es leer el diseño, que cualquiera con
              acceso a la vista ya puede hacer. */}
          <button
            type="button"
            onClick={() => void exportar()}
            disabled={ocupado || !projectId}
            title={t('screens.exportHint')}
            className="flex h-[32px] items-center gap-1.5 rounded-lg px-2.5 text-xs font-semibold text-slate-500 outline-none transition hover:bg-white hover:text-siemens focus-visible:ring-2 focus-visible:ring-siemens/40 disabled:cursor-not-allowed disabled:opacity-40 dark:hover:bg-navy-soft"
          >
            <DownloadIcon className="h-3.5 w-3.5" />
            <span className="hidden lg:inline">{t('screens.export')}</span>
          </button>

          {puedeCrear && (
            <>
              <button
                type="button"
                onClick={() => ficheroRef.current?.click()}
                disabled={ocupado}
                title={t('screens.importHint')}
                className="flex h-[32px] items-center gap-1.5 rounded-lg px-2.5 text-xs font-semibold text-slate-500 outline-none transition hover:bg-white hover:text-siemens focus-visible:ring-2 focus-visible:ring-siemens/40 disabled:cursor-not-allowed disabled:opacity-40 dark:hover:bg-navy-soft"
              >
                <UploadIcon className="h-3.5 w-3.5" />
                <span className="hidden lg:inline">{t('screens.import')}</span>
              </button>

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
            </>
          )}
        </div>
      </div>

      {/* ── Paneles flotantes ──────────────────────────────
          Viven aquí, hijos de la raíz, y NO dentro de la tira de pestañas.
          La tira es `overflow-x-auto`, y un contenedor con overflow en un eje
          recorta también en el otro: dentro de ella el desplegable salía
          cortado justo a la altura de la barra. Se posicionan con la `x` que
          se midió al abrirlos. */}
      {abierto && (
        <div
          data-psi-flotante
          style={{ left: Math.max(8, anclaX) }}
          className={`absolute top-full z-40 mt-1 w-[260px] overflow-y-auto rounded-xl border border-slate-200 bg-white p-1 shadow-card dark:border-navy-slate dark:bg-navy-soft ${ALTO_DESPLEGABLE} mp-scroll mp-scroll-dark`}
          onDragOver={(e) => {
            if (!esNuestro(e) || !puedeCrear) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            setSobre(abierto);
          }}
          onDrop={(e) => {
            if (!esNuestro(e)) return;
            e.preventDefault();
            setSobre(null);
            cambiarGrupo(e.dataTransfer.getData(TIPO_PANTALLA), abierto);
          }}
        >
          {(porGrupo.get(abierto) ?? []).length === 0 ? (
            <p className="px-3 py-4 text-center text-[11px] leading-relaxed text-slate-400">
              {t('groups.empty')}
            </p>
          ) : (
            <div className="flex flex-col gap-0.5">
              {(porGrupo.get(abierto) ?? []).map((p) => pestana(p, true))}
            </div>
          )}
        </div>
      )}

      {menuNueva && (
        <div
          data-psi-flotante
          style={{ left: Math.max(8, anclaX - 180) }}
          className="absolute top-full z-40 mt-1"
        >
          <CrearVarias
            grupos={grupos}
            max={MAX_DE_GOLPE}
            t={t}
            onCancelar={() => setMenuNueva(false)}
            onCrear={(n, grupo) => {
              setMenuNueva(false);
              void crearVarias(n, grupo);
            }}
          />
        </div>
      )}

      {/* El input vive FUERA de cualquier menú: si estuviera dentro de algo
          que se cierra, el diálogo del sistema lo desmontaría y el `change`
          no llegaría a ninguna parte. */}
      <input
        ref={ficheroRef}
        type="file"
        accept=".json,application/json"
        onChange={alElegirFichero}
        className="hidden"
      />

      {/* Los avisos van abajo a la derecha, no en una franja aquí: esta
          empujaba el lienzo hacia abajo cada vez que aparecía, y el resumen
          de una importación ocupa varias líneas. */}
      <PilaDeAvisos
        error={error}
        aviso={aviso}
        onCerrarError={() => setError('')}
        onCerrarAviso={() => setAviso('')}
      />

      {/* ── Confirmación de borrado ────────────────────────── */}
      {borrar && (
        <ConfirmarBorrarPantalla
          nombre={borrar.nombre}
          onCancelar={() => setBorrar(null)}
          onConfirmar={confirmarBorrado}
          t={t}
        />
      )}

      {/* Borrar un grupo solo llega aquí si está VACÍO: el botón está
          deshabilitado mientras tenga algo dentro. Aun así se confirma,
          porque la ficha y su nombre también son trabajo de alguien. */}
      {borrarGrupoId && (
        <ConfirmarBorrarGrupo
          nombre={borrarGrupoId.nombre}
          onCancelar={() => setBorrarGrupoId(null)}
          onConfirmar={confirmarBorrarGrupo}
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
 * Confirmación de borrado de un GRUPO.
 *
 * Dice lo único que importa aquí: que no se pierde ninguna pantalla. Sin esa
 * frase, «¿Eliminar este grupo?» da miedo justo cuando no debería — el grupo
 * está vacío por definición, el botón no se habilita de otra manera.
 */
function ConfirmarBorrarGrupo({
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
      aria-labelledby="borrar-grupo-titulo"
      onClick={onCancelar}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-sm rounded-xl border border-slate-200 bg-white p-5 shadow-card dark:border-navy-slate dark:bg-navy-soft"
      >
        <div className="mb-3 flex items-center gap-2.5">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-state-error/10 text-state-error">
            <FolderIcon className="h-4 w-4" />
          </span>
          <h2
            id="borrar-grupo-titulo"
            className="text-sm font-bold text-navy dark:text-slate-100"
          >
            {t('groups.deleteTitle')}
          </h2>
        </div>

        <p className="mb-5 text-[13px] leading-relaxed text-slate-500 dark:text-slate-400">
          {t('groups.deleteBody1')}
          <b className="font-semibold text-navy dark:text-slate-200">{nombre}</b>
          {t('groups.deleteBody2')}
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
 * El popover de «crear varias pantallas».
 *
 * Dos campos y ya: cuántas y dónde. El tope no es una limitación técnica —
 * es que nadie quiere enterarse DESPUÉS de que acaba de crear doscientas
 * pestañas, y deshacerlo es borrarlas una por una.
 */
function CrearVarias({
  grupos,
  max,
  t,
  onCrear,
  onCancelar,
}: {
  grupos: Grupo[];
  max: number;
  t: (k: string) => string;
  onCrear: (cuantas: number, grupo: string) => void;
  onCancelar: () => void;
}) {
  const [cuantas, setCuantas] = useState('3');
  const [grupo, setGrupo] = useState('');
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);

  const n = Math.max(1, Math.min(max, Math.floor(Number(cuantas) || 1)));

  return (
    <div
      data-psi-flotante
      className="w-[230px] rounded-xl border border-slate-200 bg-white p-3 shadow-card dark:border-navy-slate dark:bg-navy-soft"
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          onCrear(n, grupo);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          onCancelar();
        }
      }}
    >
      <label className="mb-1 block text-[11px] font-semibold text-slate-500 dark:text-slate-400">
        {t('screens.howMany')}
      </label>
      <input
        ref={ref}
        type="number"
        min={1}
        max={max}
        value={cuantas}
        onChange={(e) => setCuantas(e.target.value)}
        className="mb-1 w-full rounded-md border border-slate-200 bg-white px-2 py-1.5 text-xs font-semibold text-navy outline-none focus:border-siemens focus:ring-2 focus:ring-siemens/20 dark:border-navy-slate dark:bg-navy dark:text-slate-100"
      />
      <p className="mb-3 text-[10px] text-slate-400">{t('screens.maxAtOnce')}</p>

      <label className="mb-1 block text-[11px] font-semibold text-slate-500 dark:text-slate-400">
        {t('screens.intoGroup')}
      </label>
      <select
        value={grupo}
        onChange={(e) => setGrupo(e.target.value)}
        className="mb-3 w-full rounded-md border border-slate-200 bg-white px-2 py-1.5 text-xs font-semibold text-navy outline-none focus:border-siemens focus:ring-2 focus:ring-siemens/20 dark:border-navy-slate dark:bg-navy dark:text-slate-100"
      >
        <option value="">{t('screens.loose')}</option>
        {grupos.map((g) => (
          <option key={g.id} value={g.id}>
            {g.nombre}
          </option>
        ))}
      </select>

      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancelar}
          className="rounded-lg px-2.5 py-1.5 text-[11px] font-semibold text-slate-500 outline-none transition hover:bg-slate-100 focus-visible:ring-2 focus-visible:ring-siemens/40 dark:hover:bg-navy-slate/40"
        >
          {t('screens.cancel')}
        </button>
        <button
          type="button"
          onClick={() => onCrear(n, grupo)}
          className="rounded-lg bg-siemens px-2.5 py-1.5 text-[11px] font-semibold text-white outline-none transition hover:brightness-110 focus-visible:ring-2 focus-visible:ring-siemens/50"
        >
          {t('screens.createMany')} {n}
        </button>
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
