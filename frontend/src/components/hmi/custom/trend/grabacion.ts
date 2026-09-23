// =========================================================================
// custom/trend/grabacion.ts
// Sacar a Excel lo que el Trend está enseñando en vivo.
//
// QUÉ ES ESTO Y QUÉ NO ES
// No exporta lo que ya está pintado. El búfer del gráfico (`buffer.ts`) vive
// en la memoria de ESTA pestaña y el servidor nunca lo vio, así que no hay
// forma de pedirle un Excel de los últimos treinta minutos.
//
// Lo que hace es lo mismo que la pestaña «Exportar» del Diseñador: le pide al
// backend que EMPIECE a muestrear ahora, a intervalo fijo, y cuando se para se
// descarga el fichero. Pulsas grabar, pasa lo que tenga que pasar, paras y te
// llevas el .xlsx.
//
// LO QUE APORTA HACERLO DESDE AQUÍ
// En la pestaña «Exportar» hay que marcar las variables a mano de una lista
// que puede tener cuarenta. Aquí no: las series del Trend YA están
// configuradas y su `variableId` ya es la clave `"<plc>|<tag>"` que espera el
// endpoint. Pulsas grabar y está grabando exactamente las líneas que ves.
//
// POR QUÉ ESTÁ EN UN FICHERO APARTE
// Para que un fallo de la exportación no pueda tumbar el gráfico. Este módulo
// no sabe nada de uPlot, ni del búfer, ni de la escala: solo recibe una lista
// de tags y habla con `services/exportApi`. Si el backend no contesta, lo peor
// que pasa es que el botón enseñe un error.
//
// LA GRABACIÓN VIVE EN EL SERVIDOR, NO AQUÍ
// Eso decide dos comportamientos que parecen detalles y no lo son:
//
//   * Cerrar la pantalla NO la para. Sigue corriendo. Al volver a abrir, este
//     hook la busca y se reengancha (ver `adoptar`). Sin eso quedarían
//     grabaciones zombis acumulando muestras en la memoria del backend que
//     nadie podría parar ni descargar desde la vista.
//   * Dos operadores mirando la misma pantalla ven LA MISMA grabación, porque
//     el id sale del widget. No son dos capturas distintas del mismo proceso.
// =========================================================================
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  borrarGrabacion,
  descargarExcelGrabacion,
  descargarExcelHistorico,
  iniciarGrabacion,
  listarGrabaciones,
  pararGrabacion,
  type Grabacion,
} from '../../../../services/exportApi';

/**
 * Cada cuánto se le pregunta al servidor por el estado mientras graba.
 *
 * Un segundo, y NO el intervalo de muestreo: con 100 ms serían diez
 * peticiones por segundo por la misma red que lleva los datos del proceso,
 * para refrescar un contador que nadie lee tan rápido.
 */
const POLL_MS = 1000;

export type FaseGrabacion =
  | 'inactiva'    // no hay nada grabado
  | 'trabajando'  // iniciando, parando o borrando
  | 'grabando'    // en curso
  | 'lista'       // terminada o detenida, con muestras que descargar
  | 'bajando';    // generando y descargando el .xlsx

export interface EstadoGrabacionTrend {
  fase: FaseGrabacion;
  /** La grabación tal como la ve el backend. `null` si no hay ninguna. */
  grabacion: Grabacion | null;
  /** Filas capturadas hasta ahora. */
  muestras: number;
  /** Fallo que hay que enseñar. Vacío = todo bien. */
  error: string;
  /**
   * Aviso que NO es un fallo: el backend aceptó la grabación pero alguno de
   * los tags no existe ahora mismo y saldrá vacío. Casi siempre es una serie
   * enlazada a un PLC que está desconectado, y decirlo a tiempo evita
   * descubrirlo al abrir el Excel.
   */
  aviso: string;
  /** El .xlsx se puede pedir: terminada y con al menos una muestra. */
  descargable: boolean;
  iniciar: () => void;
  parar: () => void;
  descargar: () => void;
  descartar: () => void;
  /** Quita el error o el aviso de la vista sin tocar la grabación. */
  limpiarMensajes: () => void;
}

export interface OpcionesGrabacion {
  /** Con `false` el hook no pide nada ni monta temporizadores. */
  activo: boolean;
  /** Id del widget. De aquí sale el id de la grabación. */
  widgetId: string;
  /** Etiqueta legible; acaba en la hoja «Información» del Excel. */
  nombre: string;
  /** Claves `"<plc>|<tag>"` de las series dibujables. */
  tags: string[];
  intervaloMs: number;
  duracionS: number;
}

/**
 * El id de la grabación de un widget.
 *
 * Sale del `widget.id` y no de la pantalla: dos Trends en el mismo sinóptico
 * graban cosas distintas, y con un id por pantalla el segundo recibiría «ya
 * está en curso» sin entender por qué.
 *
 * Se sanea porque viaja dentro de la URL (`/export/grabaciones/{id}/excel`) y
 * acaba en el nombre del fichero descargado.
 */
export function idDeGrabacion(widgetId: string): string {
  const limpio = String(widgetId || '').replace(/[^A-Za-z0-9_-]+/g, '_');
  return `trend_${limpio || 'sin_id'}`.slice(0, 64);
}

/** La fase que le corresponde a una grabación del backend. */
function faseDe(g: Grabacion | null): FaseGrabacion {
  if (!g) return 'inactiva';
  if (g.estado === 'grabando') return 'grabando';
  return 'lista';
}

export function useGrabacionTrend(
  o: OpcionesGrabacion
): EstadoGrabacionTrend {
  const [grabacion, setGrabacion] = useState<Grabacion | null>(null);
  const [fase, setFase] = useState<FaseGrabacion>('inactiva');
  const [error, setError] = useState('');
  const [aviso, setAviso] = useState('');

  const id = idDeGrabacion(o.widgetId);

  // Las opciones en un ref: los callbacks las leen al pulsar, no al crearse.
  // Sin esto habría que rehacerlos —y con ellos el efecto del sondeo— cada
  // vez que alguien toca una serie en el Inspector.
  const opts = useRef(o);
  opts.current = o;

  // Evita pintar el resultado de una petición que llega después de
  // desmontarse el widget (cambiar de pantalla mientras se para una
  // grabación es suficiente para provocarlo).
  const vivo = useRef(true);
  useEffect(() => {
    vivo.current = true;
    return () => {
      vivo.current = false;
    };
  }, []);

  /** Deja el estado como dice el backend. `null` = ya no existe. */
  const adoptar = useCallback((g: Grabacion | null) => {
    if (!vivo.current) return;
    setGrabacion(g);
    setFase(faseDe(g));
  }, []);

  /** Busca NUESTRA grabación entre las del servidor. */
  const consultar = useCallback(async (): Promise<Grabacion | null> => {
    const r = await listarGrabaciones();
    return r.grabaciones.find((g) => g.grabacion_id === id) ?? null;
  }, [id]);

  // ── Reenganche al montar ──────────────────────────────────────
  //
  // Es lo que hace que cerrar la pantalla y volver no deje una grabación
  // corriendo sin dueño. Si el servidor no contesta se calla: no poder
  // preguntar no es un error que el operador tenga que ver, y el botón de
  // grabar sigue funcionando.
  useEffect(() => {
    if (!o.activo) return;
    let cancelado = false;
    void (async () => {
      try {
        const g = await consultar();
        if (!cancelado && g) adoptar(g);
      } catch {
        /* el servidor no contesta: se arranca sin grabación previa */
      }
    })();
    return () => {
      cancelado = true;
    };
  }, [o.activo, consultar, adoptar]);

  // ── Sondeo mientras graba ─────────────────────────────────────
  //
  // Solo mientras está en curso. Una grabación terminada no cambia sola, así
  // que seguir preguntando sería tráfico por nada.
  useEffect(() => {
    if (!o.activo || fase !== 'grabando') return;
    const reloj = setInterval(() => {
      void (async () => {
        try {
          const g = await consultar();
          // Desapareció del servidor (alguien la borró desde la pestaña
          // Exportar, o se reinició el backend): se vuelve a cero en vez de
          // dejar un contador congelado que parece que sigue grabando.
          adoptar(g);
        } catch {
          /* un sondeo fallido no rompe nada: el siguiente lo reintenta */
        }
      })();
    }, POLL_MS);
    return () => clearInterval(reloj);
  }, [o.activo, fase, consultar, adoptar]);

  // ── Acciones ──────────────────────────────────────────────────
  const iniciar = useCallback(() => {
    const { tags, nombre, intervaloMs, duracionS } = opts.current;
    setError('');
    setAviso('');

    // Sin series no hay nada que grabar. El endpoint trata la lista vacía
    // como «TODOS los tags del sistema», que aquí sería justo lo contrario
    // de lo que espera quien pulsa el botón de un gráfico concreto.
    if (tags.length === 0) {
      setError('Este gráfico no tiene ninguna variable enlazada.');
      return;
    }

    setFase('trabajando');
    void (async () => {
      try {
        const r = await iniciarGrabacion({
          grabacion_id: id,
          tags,
          intervalo_ms: intervaloMs,
          duracion_s: duracionS,
          nombre: nombre || id,
        });
        if (!vivo.current) return;
        if (!r.ok) {
          // El caso normal: quedó una grabación en curso de antes. Se adopta
          // en vez de dar un error, que es lo que el operador espera al ver
          // que «ya estaba grabando».
          setError(r.mensaje || 'No se pudo iniciar la grabación.');
          const g = await consultar().catch(() => null);
          adoptar(g);
          return;
        }
        if (r.tags_desconocidos?.length) {
          setAviso(
            `${r.tags_desconocidos.length} variable(s) no se están leyendo ` +
              `ahora mismo y saldrán vacías en el Excel.`
          );
        }

        // El POST ya dijo que sí, así que a partir de aquí la grabación EXISTE
        // en el servidor pase lo que pase con esta consulta. Por eso el fallo
        // se traga y se pasa a «grabando» igualmente: dejar la vista en
        // «inactiva» con una grabación corriendo es el peor resultado posible
        // —el botón volvería a ofrecer grabar, y el segundo intento chocaría
        // con un «ya está en curso» que no habría forma de entender—. El
        // sondeo que arranca con esta fase pondrá el contador al día en un
        // segundo.
        try {
          adoptar(await consultar());
        } catch {
          if (vivo.current) setFase('grabando');
        }
      } catch (e: any) {
        if (!vivo.current) return;
        setError(e?.message ?? 'No se pudo iniciar la grabación.');
        setFase('inactiva');
      }
    })();
  }, [id, consultar, adoptar]);

  const parar = useCallback(() => {
    setError('');
    setFase('trabajando');
    void (async () => {
      try {
        await pararGrabacion(id);
        if (!vivo.current) return;
        adoptar(await consultar());
      } catch (e: any) {
        if (!vivo.current) return;
        setError(e?.message ?? 'No se pudo parar la grabación.');
        setFase('grabando');
      }
    })();
  }, [id, consultar, adoptar]);

  const descargar = useCallback(() => {
    setError('');
    setFase('bajando');
    void (async () => {
      try {
        await descargarExcelGrabacion(id);
        if (!vivo.current) return;
        setFase('lista');
      } catch (e: any) {
        if (!vivo.current) return;
        // Los 404 de aquí traen el mensaje del backend ya escrito para
        // leerse («la grabación todavía no tiene muestras»), así que se
        // enseña tal cual.
        setError(e?.message ?? 'No se pudo descargar el Excel.');
        setFase('lista');
      }
    })();
  }, [id]);

  const descartar = useCallback(() => {
    setError('');
    setAviso('');
    setFase('trabajando');
    void (async () => {
      try {
        await borrarGrabacion(id);
      } catch (e: any) {
        if (vivo.current) setError(e?.message ?? 'No se pudo descartar.');
      } finally {
        // Se vuelve a cero pase lo que pase: si el borrado falló porque ya no
        // existía, el resultado que quiere el operador es el mismo.
        if (vivo.current) adoptar(null);
      }
    })();
  }, [id, adoptar]);

  const limpiarMensajes = useCallback(() => {
    setError('');
    setAviso('');
  }, []);

  return {
    fase,
    grabacion,
    muestras: grabacion?.num_muestras ?? 0,
    error,
    aviso,
    descargable: !!grabacion?.descargable,
    iniciar,
    parar,
    descargar,
    descartar,
    limpiarMensajes,
  };
}

// =========================================================================
// EL OTRO CAMINO: EL HISTÓRICO
//
// En modo histórico no se graba nada — los datos ya están en la base, puestos
// ahí por el historizador. Así que no hay ciclo que llevar (iniciar, sondear,
// parar): es pedir el fichero y ya.
//
// Por eso es un hook aparte y no una fase más del de arriba. Mezclarlos
// habría dejado un `if (esHistorico)` en cada una de las cinco acciones para
// que cuatro no hicieran nada.
//
// LAS FECHAS LLEGAN YA RESUELTAS, Y ESO IMPORTA
// Este hook NO toca las fechas: recibe las mismas que el gráfico usó para
// pedir sus puntos (`resolverRango()`, que devuelve instantes absolutos en
// UTC). De ahí sale la única garantía que de verdad se quería: el Excel y lo
// que se ve en pantalla cubren el mismo rango POR CONSTRUCCIÓN, no porque
// alguien se acuerde de mantener dos cálculos iguales.
//
// La pestaña «Exportar» del Diseñador, en cambio, manda lo que el usuario
// escribió en un `datetime-local`, que va sin zona; y el backend trata una
// marca sin zona como UTC. En Perú eso son cinco horas de desfase silencioso.
// Aquí ese fallo no puede darse.
// =========================================================================

export interface EstadoDescargaHistorico {
  bajando: boolean;
  error: string;
  /** Falta algo para poder pedir el fichero (grupo o series). */
  motivoBloqueo: string;
  descargar: () => void;
  limpiarError: () => void;
}

export interface OpcionesDescargaHistorico {
  activo: boolean;
  grupoId: string;
  /** Tags SIN el prefijo del PLC: es lo que espera el endpoint. */
  tags: string[];
  /** Instantes ISO en UTC, tal como los devuelve `resolverRango()`. */
  desde: string;
  hasta: string;
  limite: number;
}

export function useDescargaHistorico(
  o: OpcionesDescargaHistorico
): EstadoDescargaHistorico {
  const [bajando, setBajando] = useState(false);
  const [error, setError] = useState('');

  const opts = useRef(o);
  opts.current = o;

  const vivo = useRef(true);
  useEffect(() => {
    vivo.current = true;
    return () => {
      vivo.current = false;
    };
  }, []);

  // Por qué no se puede pedir el fichero, si es que no se puede. Se calcula
  // aparte del `descargar()` para que el botón pueda decirlo en su tooltip
  // ANTES de pulsarlo, en vez de dar un error después.
  const motivoBloqueo = !o.grupoId
    ? 'Elige un grupo del historizador en Propiedades.'
    : o.tags.length === 0
    ? 'Este gráfico no tiene ninguna variable enlazada.'
    : '';

  const descargar = useCallback(() => {
    const { grupoId, tags, desde, hasta, limite } = opts.current;
    if (!grupoId || tags.length === 0) return;
    setError('');
    setBajando(true);
    void (async () => {
      try {
        await descargarExcelHistorico({ grupoId, tags, desde, hasta, limite });
      } catch (e: any) {
        // Los 404 de este endpoint no son fallos técnicos: son «no hay datos
        // en ese rango», y el backend ya los redacta para leerse. Se pasan
        // tal cual en vez de traducirlos a un «HTTP 404» que no ayuda.
        if (vivo.current) {
          setError(e?.message ?? 'No se pudo descargar el histórico.');
        }
      } finally {
        if (vivo.current) setBajando(false);
      }
    })();
  }, []);

  const limpiarError = useCallback(() => setError(''), []);

  return {
    bajando: o.activo && bajando,
    error: o.activo ? error : '',
    motivoBloqueo,
    descargar,
    limpiarError,
  };
}
