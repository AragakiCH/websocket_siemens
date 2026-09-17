// =========================================================================
// historicoApi.ts
// Leer lo que el historizador guardó en la base de datos.
//
// QUÉ ES UN GRUPO
// El historizador no guarda tags sueltos: guarda GRUPOS. Un grupo es «estos N
// tags, en esta conexión, en esta tabla, cada tantos ms». Se crean desde el
// Editor de Flujos; aquí sólo se leen, para que el widget de tendencia pueda
// ofrecerlos en un desplegable en vez de obligar a teclear el id.
//
// LA TABLA ES DE FORMATO LARGO
// Una fila por tag y por muestra: `ts | plc | tag | valor_num | valor_texto |
// tipo`. NO hay una columna por variable. Un mismo instante genera N filas, una
// por tag del grupo, intercaladas.
//
// ── EL LÍMITE ES GLOBAL, Y ESO DECIDE CÓMO SE PIDE ──────────────────────
// `GET /historian/{grupo}/datos` ordena por `ts DESC` y recorta a `limite`
// FILAS, no a `limite` puntos por variable (el recorte lo hace el driver con
// un `fetchmany`, no un LIMIT por tag). Consecuencias, con un grupo de 4 tags
// y `limite=1000`:
//
//   * llegan ~250 puntos de cada una, no 1000;
//   * y como recorta lo más ANTIGUO, el gráfico enseña sólo el tramo final
//     del rango aunque se haya pedido «desde ayer» — sin que se note.
//
// Con un grupo de 200 tags, el máximo de 10000 filas son 50 puntos por
// variable: inservible para una tendencia.
//
// Por eso el widget pide UNA LLAMADA POR SERIE, con `?tag=`. Son N peticiones
// en vez de una, y a cambio cada serie se lleva su propio límite y cubre el
// rango entero. Es la diferencia entre un gráfico correcto y uno que miente
// callando. Si algún día hace falta una sola llamada, lo que toca no es
// quitar el `?tag=` sino que el backend recorte POR TAG (una ventana
// `ROW_NUMBER() OVER (PARTITION BY tag ...)`) o devuelva datos diezmados.
// =========================================================================
import { fetchAuth } from './authApi';

/** Un grupo de historización, tal como lo devuelve `GET /historian`. */
export interface GrupoHistorico {
  grupo_id: string;
  nombre: string;
  db_id: string;
  tabla: string;
  activo: boolean;
  num_tags: number;
  tags: string[];
  todos_los_tags: boolean;
  filas_escritas: number;
  ultima_escritura: string;
  ultimo_error: string;
}

/** Los grupos configurados, con sus contadores. */
export async function listarGrupos(): Promise<GrupoHistorico[]> {
  const d = await fetchAuth('/historian');
  return Array.isArray(d?.grupos) ? d.grupos : [];
}

/** Una fila del histórico. `valor_num` es `null` en tags de texto. */
export interface FilaHistorico {
  ts: string;
  ts_local?: string;
  plc: string;
  tag: string;
  valor_num: number | null;
  valor_texto: string | null;
  tipo: string;
}

export interface RespuestaHistorico {
  ok: boolean;
  grupo_id?: string;
  tabla?: string;
  filas?: FilaHistorico[];
  num_filas?: number;
  /** `true` = había más filas de las que cabían en `limite`. */
  truncado?: boolean;
  ms?: number;
  mensaje?: string;
}

export interface OpcionesHistorico {
  /** Tag SIN el prefijo del PLC. Sin él vienen todos los del grupo. */
  tag?: string;
  /** ISO 8601. */
  desde?: string;
  hasta?: string;
  limite?: number;
}

/**
 * Lee el histórico de un grupo.
 *
 * Devuelve las filas ordenadas por `ts` DESCENDENTE (lo más reciente primero).
 * Para dibujar una línea hay que invertirlas — lo hace `historico.ts`.
 *
 * Si la tabla todavía no existe —grupo recién creado, nada escrito— el backend
 * responde `ok: true` con `filas: []` y un `mensaje`, no un error. El widget
 * debe pintar «sin datos», que es lo que pasa de verdad.
 */
export async function leerHistorico(
  grupoId: string,
  o: OpcionesHistorico = {}
): Promise<RespuestaHistorico> {
  const q = new URLSearchParams();
  if (o.tag) q.set('tag', o.tag);
  if (o.desde) q.set('desde', o.desde);
  if (o.hasta) q.set('hasta', o.hasta);
  q.set('limite', String(Math.max(1, Math.min(10000, o.limite ?? 1000))));
  return fetchAuth(
    `/historian/${encodeURIComponent(grupoId)}/datos?${q.toString()}`
  );
}
