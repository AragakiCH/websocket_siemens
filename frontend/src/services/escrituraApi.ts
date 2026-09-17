// =========================================================================
// escrituraApi.ts
// Mandar valores al PLC desde la vista.
//
// POR QUÉ NO EXISTÍA
// Hasta ahora el HMI sólo LEÍA. El backend sabía escribir desde hace tiempo
// (`POST /escritura`, con lista blanca y auditoría), pero ningún widget lo
// llamaba: el botón no tenía acciones y el interruptor sólo se pintaba — se
// movía en pantalla y el PLC ni se enteraba.
//
// LA LISTA BLANCA NO ES UN ADORNO
// El backend sólo escribe tags dados de alta en `/escritura/permitidos`, con
// sus límites. Aquí se lee esa lista para OFRECER sólo lo habilitado: dejar
// configurar un botón contra un tag que el servidor va a rechazar es un fallo
// que no se descubre en el Diseñador sino en planta, pulsando.
//
// La comprobación de verdad la sigue haciendo el servidor. Esto es comodidad,
// no seguridad: quien llame al endpoint a mano se topa con la misma barrera.
// =========================================================================
import { fetchAuth } from './authApi';

/** Un tag habilitado para escritura, con sus límites. */
export interface TagPermitido {
  plc_id: string;
  tag: string;
  minimo?: number | null;
  maximo?: number | null;
  descripcion?: string;
}

export interface RespuestaPermitidos {
  tags: TagPermitido[];
  num_tags: number;
  por_plc?: Record<string, number>;
}

/** Los tags que el servidor acepta escribir. */
export async function listarPermitidos(): Promise<TagPermitido[]> {
  const d: RespuestaPermitidos = await fetchAuth('/escritura/permitidos');
  return d.tags ?? [];
}

export interface UnaEscritura {
  plc_id: string;
  tag: string;
  valor: unknown;
}

/**
 * Escribe uno o varios tags.
 *
 * Varios a la vez son ATÓMICOS del lado del servidor: si uno falla, los ya
 * escritos se restauran. Por eso conviene mandarlos juntos cuando forman una
 * misma orden —una consigna y su bit de validación— en vez de encadenar dos
 * llamadas y arriesgarse a dejar el PLC a medias.
 */
export async function escribir(escrituras: UnaEscritura[]): Promise<any> {
  return fetchAuth('/escritura', {
    method: 'POST',
    body: JSON.stringify({ escrituras }),
  });
}

/**
 * El id que usa la vista para un tag (`plc|tag`), partido en sus dos mitades.
 *
 * `RealPLCService` guarda los valores bajo `${plc}|${tag}` y ése es el
 * `variableId` que llevan los widgets. El endpoint, en cambio, quiere los dos
 * campos por separado. Esta función es la costura entre ambos.
 *
 * Un id sin `|` se devuelve con el PLC vacío en lugar de reventar: así el
 * Inspector puede avisar de que ese enlace no sirve para escribir, que es más
 * útil que una excepción a mitad de un clic.
 */
export function partirId(variableId: string): { plc_id: string; tag: string } {
  const i = variableId.indexOf('|');
  if (i < 0) return { plc_id: '', tag: variableId };
  return { plc_id: variableId.slice(0, i), tag: variableId.slice(i + 1) };
}

/** El id de la vista a partir de las dos mitades. */
export const unirId = (plc_id: string, tag: string) => `${plc_id}|${tag}`;

// =========================================================================
// LA CACHÉ DE LA LISTA BLANCA
//
// Vive aquí y no en el widget que la estrenó. Un sinóptico puede llevar veinte
// campos de entrada; sin caché serían veinte peticiones idénticas al abrir la
// pantalla, por la misma red que lleva los datos del proceso. Se pide una vez
// y la comparten todos.
//
// Y al estar aquí la comparten TAMBIÉN los demás: el inspector de acciones y
// la pantalla de configuración. Con una caché por fichero, habilitar un tag
// dejaba al widget enseñando la lista vieja hasta que alguien recargaba.
//
// Aunque quedara vieja no se rompe nada: el servidor valida cada escritura por
// su cuenta. Lo único que se perdería es el aviso anticipado.
// =========================================================================
let cachePermitidos: TagPermitido[] | null = null;
let enVuelo: Promise<TagPermitido[]> | null = null;

/** La lista blanca, de la caché si está; si no, del servidor. */
export function permitidosCacheados(): Promise<TagPermitido[]> {
  if (cachePermitidos) return Promise.resolve(cachePermitidos);
  if (!enVuelo) {
    enVuelo = listarPermitidos()
      .then((l) => {
        cachePermitidos = l;
        return l;
      })
      .finally(() => {
        enVuelo = null;
      });
  }
  return enVuelo;
}

/**
 * Tira la caché y avisa a quien la esté usando.
 *
 * Lo llama la pantalla de Configuración después de habilitar o deshabilitar.
 * Sin esto, el Diseñador seguía diciendo «este tag no admite escritura» sobre
 * un tag recién habilitado hasta que alguien pulsaba F5 — y el fallo parecía
 * del backend, que era justo el único que estaba bien.
 *
 * El evento va por `window` a propósito: quien escucha son componentes de
 * módulos que no importan a este de vuelta, y un evento no crea esa
 * dependencia. Es el mismo canal que ya usa `RealPLCService` con `hmi:ws`.
 */
export const EVENTO_PERMITIDOS = 'hmi:permitidos';

export function olvidarPermitidos(): void {
  cachePermitidos = null;
  enVuelo = null;
  try {
    window.dispatchEvent(new CustomEvent(EVENTO_PERMITIDOS));
  } catch {
    /* sin `window` (pruebas, SSR): la caché ya está limpia, que es lo que importa */
  }
}

// =========================================================================
// LISTA BLANCA: administrarla
//
// Los tres endpoints que faltaban. Los usa la sección «Escritura» de
// Configuración; ningún widget los llama —ni debe—: un widget opera la planta,
// no decide en qué se puede escribir.
//
// Los tres exigen rol `Administradores` en el servidor. La interfaz los
// esconde de quien no lo tiene, pero eso es cortesía: la barrera es el 403.
// =========================================================================

/** Un tag del PLC que PODRÍA habilitarse, y si ya lo está. */
export interface TagCandidato {
  tag: string;
  node_id: string;
  data_type: string;
  db_name: string;
  habilitado: boolean;
  minimo: number | null;
  maximo: number | null;
  descripcion: string;
}

export interface RespuestaCandidatos {
  plc_id: string;
  num_candidatos: number;
  /** `false` = el driver de ese PLC no sabe escribir. Nada de esto servirá. */
  soporta_escritura: boolean;
  candidatos: TagCandidato[];
}

/** Los tags de un PLC cuyo tipo admite escritura. `GET /escritura/candidatos` */
export async function candidatos(plcId: string): Promise<RespuestaCandidatos> {
  return fetchAuth(`/escritura/candidatos?plc_id=${encodeURIComponent(plcId)}`);
}

/**
 * Habilita un tag, o cambia sus límites si ya lo estaba. `PUT`.
 *
 * `minimo`/`maximo` van como `null` cuando no hay tope — que es distinto de 0.
 * En tags booleanos o de texto el servidor los ignora.
 */
export async function habilitar(entrada: {
  plc_id: string;
  tag: string;
  minimo: number | null;
  maximo: number | null;
  descripcion: string;
}): Promise<any> {
  const r = await fetchAuth('/escritura/permitidos', {
    method: 'PUT',
    body: JSON.stringify(entrada),
  });
  olvidarPermitidos();
  return r;
}

/**
 * Saca un tag de la lista blanca. `DELETE`.
 *
 * Los dos trozos van codificados por separado: un tag es `PLC_PRG.rSetPoint` y
 * un `plc_id` puede ser una IP — los dos llevan puntos, y alguno podría traer
 * algo peor. Sin codificar, el tag se comería un segmento de la ruta.
 */
export async function deshabilitar(plcId: string, tag: string): Promise<any> {
  const r = await fetchAuth(
    `/escritura/permitidos/${encodeURIComponent(plcId)}/${encodeURIComponent(tag)}`,
    { method: 'DELETE' }
  );
  olvidarPermitidos();
  return r;
}
