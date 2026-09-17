// =========================================================================
// custom/trend/historico.ts
// Traer del historizador lo que el Trend necesita para dibujar, y dejarlo
// con la forma exacta que quiere uPlot.
//
// POR QUÉ ESTO NO ES `buffer.ts`
// El búfer del modo en vivo es de EMPUJE: llega una muestra, se añade al final,
// se poda lo viejo. Aquí es al revés — se pide un rango cerrado de una vez y no
// cambia hasta que alguien recarga. Mezclar las dos cosas en la misma clase
// habría dejado un `if (historico)` en cada método; separarlas deja cada una
// con una sola forma de comportarse.
//
// ── EL PROBLEMA DE VERDAD: CADA SERIE TRAE SUS PROPIOS INSTANTES ────────
// uPlot no admite una línea de tiempo por serie. Quiere UN array de tiempos y
// una columna por serie, todas de la misma longitud:
//
//     [ [t0, t1, t2, ...], [s1_0, s1_1, ...], [s2_0, s2_1, ...] ]
//
// Y el historizador no garantiza que dos tags se escriban en el mismo
// instante: con banda muerta configurada, un tag que no cambia no se escribe.
// Así que las marcas de tiempo de dos series NO coinciden fila a fila.
//
// La salida es una UNIÓN de instantes: se juntan todos los `ts` de todas las
// series, se ordenan sin repetir, y cada serie rellena los suyos y deja `null`
// en los demás. El `null` no es un cero disfrazado — con `spanGaps: false` en
// el gráfico, un hueco se dibuja como un hueco, que es lo honesto: en ese
// instante no se guardó nada de esa variable.
//
// ── POR QUÉ NO SE INTERPOLA ─────────────────────────────────────────────
// Sería fácil rellenar el hueco con el último valor conocido (escalón) y la
// línea quedaría preciosa y continua. No se hace: en una tendencia de planta,
// una línea continua afirma que había dato, y quien la mire para explicar por
// qué se paró la línea a las 03:14 no tiene por qué saber que ese tramo se lo
// inventó el frontend. Si algún día hace falta, va como una opción explícita
// llamada por su nombre, no como un comportamiento silencioso.
// =========================================================================
import { useCallback, useEffect, useRef, useState } from 'react';
import { leerHistorico, type FilaHistorico } from '../../../../services/historicoApi';
import { partirId } from '../../../../services/escrituraApi';

/**
 * `partirId` vive en `escrituraApi` porque allí hizo falta primero, pero lo que
 * hace no es de escritura: parte el `"<plc>|<tag>"` con el que TODA la vista
 * identifica una variable. Se reutiliza en vez de escribir aquí un segundo
 * `indexOf('|')` — dos copias de la misma convención acaban divergiendo el día
 * que un `plc_id` traiga un carácter raro.
 */

/**
 * «De este tag, ¿cuál es el dato más reciente que hay guardado?»
 *
 * POR QUÉ EXISTE
 * «No hay nada guardado en este rango» es una respuesta honesta y totalmente
 * inútil. Las dos causas son indistinguibles desde fuera:
 *
 *   * el historizador nunca guardó ese tag  -> hay que arreglar el GRUPO;
 *   * lo guardó, pero en otra franja horaria -> hay que mover el RANGO.
 *
 * Y averiguar cuál es implica abrir SQL Server y escribir un SELECT. Así que lo
 * pregunta el widget solo: cuando la consulta sale vacía, repite la misma
 * lectura SIN filtros de fecha y con `limite: 1`, que devuelve la última fila
 * de cada tag. Es una consulta trivial —una fila por serie— y convierte «no hay
 * nada» en «hay, pero es de las 17:50».
 */
export interface Pista {
  tag: string;
  /** Segundos desde época del último dato, o `null` si nunca se guardó nada. */
  ultimo: number | null;
}

export interface DatosHistoricos {
  /** Lo que se le pasa a uPlot: `[tiempos, serie1, serie2, ...]`. */
  datos: any;
  /** Primer y último instante REALES que llegaron, en segundos. */
  rango: [number, number] | null;
  /** Puntos de la línea de tiempo unificada. */
  puntos: number;
  cargando: boolean;
  error: string;
  /** Alguna serie llegó recortada por el límite: falta tramo por el principio. */
  truncado: boolean;
  /** Series que no devolvieron ni una fila, por su etiqueta. */
  vacias: string[];
  /** Solo cuando NO llegó ni un punto: dónde sí hay datos de cada tag. */
  pistas: Pista[];
  recargar: () => void;
}

const VACIO: any = [[]];

/**
 * Segundos desde época a partir del `ts` ISO que manda el backend.
 *
 * El backend normaliza `ts` a UTC con 'Z' final antes de responder, así que lo
 * normal es que venga marcado. El cinturón está por si algún día una fila se
 * cuela sin zona: `Date.parse` de una cadena ISO SIN offset la interpreta como
 * hora LOCAL, y en Perú eso son cinco horas de desplazamiento silencioso en
 * todos los puntos a la vez. La tabla guarda UTC; si no lo dice, se asume UTC,
 * que es lo que es.
 */
function aSegundos(iso: string): number | null {
  if (!iso) return null;
  const marcado = /(?:Z|[+-]\d{2}:?\d{2})$/.test(iso);
  const ms = Date.parse(marcado ? iso : `${iso}Z`);
  return Number.isFinite(ms) ? ms / 1000 : null;
}

/**
 * Trae el histórico de N series y lo deja listo para el gráfico.
 *
 * `activo` en falso lo apaga entero: en modo «en vivo» este hook no debe pedir
 * nada. Va como parámetro y no como un `if` en quien llama porque un hook no se
 * puede llamar condicionalmente — y meterlo en un componente aparte por esto
 * solo habría partido el widget en dos por un detalle de React.
 */
export function useHistorico(
  activo: boolean,
  grupoId: string,
  /** `variableId` de cada serie (`"<plc>|<tag>"`), en el MISMO orden que uPlot. */
  ids: string[],
  desde: string,
  hasta: string,
  limitePorSerie: number
): DatosHistoricos {
  const [estado, setEstado] = useState<Omit<DatosHistoricos, 'recargar'>>({
    datos: VACIO,
    rango: null,
    puntos: 0,
    cargando: false,
    error: '',
    truncado: false,
    vacias: [],
    pistas: [],
  });

  // Sube al pulsar «recargar». Es lo único que vuelve a pedir los datos sin
  // que haya cambiado la configuración.
  const [revision, setRevision] = useState(0);
  const recargar = useCallback(() => setRevision((n) => n + 1), []);

  // Cada petición lleva su número. Si llegan dos respuestas desordenadas —muy
  // fácil con N llamadas en paralelo y un rango grande— solo se pinta la de la
  // última petición lanzada. Sin esto, cambiar el rango dos veces seguidas
  // podía dejar en pantalla el resultado del rango ANTERIOR.
  const turno = useRef(0);

  const clave = `${grupoId}|${ids.join(',')}|${desde}|${hasta}|${limitePorSerie}`;

  useEffect(() => {
    if (!activo || !grupoId || ids.length === 0) {
      setEstado({
        datos: VACIO,
        rango: null,
        puntos: 0,
        cargando: false,
        error: '',
        truncado: false,
        vacias: [],
        pistas: [],
      });
      return;
    }

    const mio = ++turno.current;
    setEstado((p) => ({ ...p, cargando: true, error: '' }));

    // UNA LLAMADA POR SERIE. El porqué está en `historicoApi.ts`: el límite del
    // endpoint es por CONSULTA, no por tag, así que pedirlas juntas repartiría
    // los puntos entre todas y recortaría el principio del rango en silencio.
    Promise.all(
      ids.map((id) =>
        leerHistorico(grupoId, {
          tag: partirId(id).tag,
          desde: desde || undefined,
          hasta: hasta || undefined,
          limite: limitePorSerie,
        }).catch((e: any) => ({
          ok: false,
          mensaje: e?.message ?? 'Error leyendo el histórico.',
        }))
      )
    ).then((respuestas) => {
      if (turno.current !== mio) return;

      const falló = respuestas.find((r) => r && r.ok === false);
      if (falló) {
        setEstado({
          datos: VACIO,
          rango: null,
          puntos: 0,
          cargando: false,
          error: falló.mensaje ?? 'No se pudo leer el histórico.',
          truncado: false,
          vacias: [],
          pistas: [],
        });
        return;
      }

      // ── Union de instantes ──────────────────────────────────────
      //
      // Un Map por serie (ts -> valor) y un Set con todos los ts. El Set evita
      // el O(n²) de buscar cada instante en un array, que con 4 series de 1000
      // puntos serían cuatro millones de comparaciones por recarga.
      const porSerie: Map<number, number | null>[] = [];
      const todos = new Set<number>();
      const vacias: string[] = [];
      let truncado = false;

      respuestas.forEach((r, i) => {
        const mapa = new Map<number, number | null>();
        const filas: FilaHistorico[] = (r as any).filas ?? [];
        if ((r as any).truncado) truncado = true;
        if (filas.length === 0) vacias.push(partirId(ids[i]).tag || ids[i]);
        for (const f of filas) {
          const t = aSegundos(f.ts);
          if (t === null) continue;
          // `valor_num` es null en tags de texto: se descarta el punto en vez
          // de meter un 0 que dibujaría una línea plana que nunca existió.
          const v = typeof f.valor_num === 'number' ? f.valor_num : null;
          if (v === null) continue;
          mapa.set(t, v);
          todos.add(t);
        }
        porSerie.push(mapa);
      });

      // El backend devuelve `ts DESC`. Aquí se ordena ASCENDENTE porque es lo
      // que uPlot necesita para dibujar de izquierda a derecha.
      const tiempos = Array.from(todos).sort((a, b) => a - b);

      const columnas = porSerie.map((mapa) =>
        tiempos.map((t) => (mapa.has(t) ? (mapa.get(t) as number) : null))
      );

      setEstado({
        datos: [tiempos, ...columnas],
        rango: tiempos.length ? [tiempos[0], tiempos[tiempos.length - 1]] : null,
        puntos: tiempos.length,
        cargando: false,
        error: '',
        truncado,
        vacias,
        pistas: [],
      });

      // NADA EN TODO EL RANGO -> se pregunta dónde sí hay. Va DESPUÉS de pintar
      // el vacío, no antes: así el mensaje sale ya y la pista aparece medio
      // segundo más tarde, en vez de retrasar los dos.
      if (tiempos.length === 0) {
        Promise.all(
          ids.map((id) =>
            leerHistorico(grupoId, { tag: partirId(id).tag, limite: 1 })
              .then((r) => {
                const f = (r?.filas ?? [])[0];
                return {
                  tag: partirId(id).tag || id,
                  ultimo: f ? aSegundos(f.ts) : null,
                };
              })
              .catch(() => ({ tag: partirId(id).tag || id, ultimo: null }))
          )
        ).then((pistas) => {
          if (turno.current !== mio) return;
          setEstado((prev) => ({ ...prev, pistas }));
        });
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activo, clave, revision]);

  return { ...estado, recargar };
}

// ─── Rangos de tiempo ────────────────────────────────────────────

export interface RangoPreset {
  v: string;
  t: string;
  /** Segundos hacia atrás desde ahora. 0 = el rango lo pone quien configura. */
  seg: number;
}

/**
 * Los atajos del desplegable.
 *
 * Son los que se piden de verdad en una sala de control: «lo del último turno»,
 * «lo de hoy», «la última semana». Un selector de fecha para todo obligaría a
 * teclear dos veces una fecha para la pregunta más frecuente, que es «¿qué ha
 * pasado esta mañana?».
 */
export const RANGOS: RangoPreset[] = [
  { v: '15m', t: 'Últimos 15 minutos', seg: 900 },
  { v: '1h', t: 'Última hora', seg: 3600 },
  { v: '8h', t: 'Último turno (8 h)', seg: 28800 },
  { v: '24h', t: 'Últimas 24 horas', seg: 86400 },
  { v: '7d', t: 'Últimos 7 días', seg: 604800 },
  { v: 'personalizado', t: 'Entre dos fechas…', seg: 0 },
];

// ─── Zona horaria: el fallo que hacía desaparecer los datos ──────
//
// ESTO ES LO QUE PASABA
// El `<input type="datetime-local">` da una cadena SIN zona: «2026-09-16T22:23».
// Escribir ahí «10:23 p. m.» significa las 22:23 DE AQUÍ (Perú, UTC-5).
//
// Esa cadena se mandaba tal cual al backend. Y `a_utc()` —la función que
// normaliza las fechas allí— dice, literalmente, que «una marca naive se asume
// UTC». Así que el backend consultaba las 22:23 **UTC**, que aquí son las
// 17:23 de la tarde: CINCO HORAS ANTES de lo que se pidió.
//
// Y para rematar, el gráfico encuadraba el eje con `Date.parse` de la MISMA
// cadena, que en el navegador sí la lee como hora local. Resultado:
//
//   * la base devolvía filas de las 17:23–17:24 (las había, por eso la leyenda
//     enseñaba valores);
//   * el eje X enseñaba las 22:23–22:24;
//   * los datos caían cinco horas fuera de la ventana dibujada.
//
// Un gráfico vacío con datos correctos dentro. El peor tipo de fallo: no da
// error, no avisa, y todo lo que se ve es coherente por separado.
//
// LA SOLUCIÓN
// No mandar nunca una fecha sin zona. Se convierte aquí a un INSTANTE absoluto
// en UTC («2026-09-17T03:23:00.000Z»), que es lo único que significa lo mismo a
// los dos lados del cable. `Date.parse` de esa cadena devuelve exactamente el
// mismo instante, así que lo que se consulta y lo que se encuadra vuelven a ser
// la misma cosa por construcción, no por casualidad.

/** ¿La cadena del `datetime-local` trae segundos? («…T22:24» vs «…T22:24:30») */
function traeSegundos(valor: string): boolean {
  return /T\d{2}:\d{2}:\d{2}/.test(valor);
}

/**
 * Pasa el valor de un `datetime-local` (hora local, sin zona) a ISO UTC.
 *
 * `finDeMinuto` es para el HASTA. Escribir «22:24» quiere decir «hasta las
 * 22:24», o sea ese minuto ENTERO — y sin esto el corte caía en 22:24:00.000 y
 * se perdía todo lo grabado en ese minuto. Con muestras cada 150 ms eso es
 * perder cuatrocientas filas por un cero implícito.
 */
export function aInstanteUtc(valor: string, finDeMinuto = false): string {
  if (!valor) return '';
  const ms = Date.parse(valor);
  if (!Number.isFinite(ms)) return '';
  const extra = finDeMinuto && !traeSegundos(valor) ? 59_999 : 0;
  return new Date(ms + extra).toISOString();
}

/** Un instante (ms) con el formato que quiere un `<input datetime-local>`. */
export function aValorLocal(ms: number): string {
  const d = new Date(ms);
  return new Date(ms - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

/**
 * La ventana tal como va a viajar a la base, en UTC y legible.
 *
 * Se enseña en el Inspector a propósito: la tabla guarda UTC, así que esto es
 * lo que hay que comparar contra lo que se ve en SQL Server. Sin ello, mirar
 * una hora en el HMI y otra distinta en SSMS parece un fallo cuando es solo la
 * diferencia horaria haciendo su trabajo.
 */
export function ventanaUtc(desde: string, hasta: string): string {
  const d = aInstanteUtc(desde);
  const h = aInstanteUtc(hasta, true);
  if (!d || !h) return '';
  const corto = (iso: string) => iso.slice(0, 19).replace('T', ' ');
  return `${corto(d)} → ${corto(h)}`;
}

/**
 * Traduce el rango configurado a las dos fechas ISO que quiere el endpoint.
 *
 * Los presets se calculan CONTRA EL RELOJ DEL NAVEGADOR en el momento de
 * pedir, no al configurar: «última hora» tiene que seguir siendo la última
 * hora seis días después de guardar la pantalla.
 *
 * Salga por donde salga, devuelve SIEMPRE instantes absolutos en UTC. Quien
 * llama puede usarlos para pedir y para encuadrar sin volver a pensar en zonas.
 */
export function resolverRango(
  rango: string,
  desde: string,
  hasta: string
): { desde: string; hasta: string } {
  if (rango === 'personalizado') {
    return { desde: aInstanteUtc(desde), hasta: aInstanteUtc(hasta, true) };
  }
  const seg = RANGOS.find((r) => r.v === rango)?.seg ?? 3600;
  const fin = new Date();
  const ini = new Date(fin.getTime() - seg * 1000);
  return { desde: ini.toISOString(), hasta: fin.toISOString() };
}
