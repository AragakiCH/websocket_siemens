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
