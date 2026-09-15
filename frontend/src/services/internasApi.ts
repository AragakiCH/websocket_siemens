// =========================================================================
// internasApi.ts
// Cliente de las variables internas (`/internas`).
//
// QUE SON
//   Variables que no existen en ningun PLC: viven en el servidor y las ven
//   todos los paneles. Se usan para probar una pantalla sin planta, para
//   estado propio del HMI (modo mantenimiento, turno) y para compartir un
//   valor entre pantallas.
//
// LA CLAVE ES LO QUE IMPORTA
//   El backend las publica con `plc = "interno"`, asi que su clave es
//   `interno|<nombre>` — la misma forma que `PLC_2|DB_Datos.Temperatura`.
//   Eso es lo que hace que un widget se pueda enlazar a una variable interna
//   sin que nadie haya escrito una linea para ello: entran por `GET /tags`
//   junto a las de campo y el inspector no las distingue.
//
//   Consecuencia directa: RENOMBRAR una variable rompe los widgets que la
//   usaban, porque el nombre ES la clave. El backend lo avisa en la
//   respuesta y la vista lo enseña.
// =========================================================================
import { apiDelete, apiGet, apiPatch, apiPost, apiPut } from '../components/flows/api';

/** Los cuatro tipos. Coincide con `TIPOS` en app/core/internas_store.py. */
export type TipoInterna = 'bool' | 'int' | 'double' | 'string';

export interface VariableInterna {
  nombre: string;
  tipo: TipoInterna;
  descripcion: string;
  unidad: string;
  minimo: number | null;
  maximo: number | null;
  valor: unknown;
  valor_inicial: unknown;
  retentiva: boolean;
  creado_en: string;
  actualizado_en: string;
}

/** Lo que se manda al crear. Todo menos el nombre y el tipo es opcional. */
export interface NuevaInterna {
  nombre: string;
  tipo: TipoInterna;
  descripcion?: string;
  unidad?: string;
  minimo?: number | null;
  maximo?: number | null;
  valor_inicial?: unknown;
  retentiva?: boolean;
}

/** El PLC reservado con el que se publican. */
export const PLC_INTERNO = 'interno';

/**
 * La clave con la que un widget se enlaza a esta variable.
 *
 * Existe como funcion y no como plantilla suelta porque aparece en tres
 * sitios (la vista, el boton de copiar y el selector del inspector) y los
 * tres tienen que decir exactamente lo mismo.
 */
export function claveInterna(nombre: string): string {
  return `${PLC_INTERNO}|${nombre}`;
}

/** ¿Este tipo admite unidad y rango? */
export function esNumerica(tipo: TipoInterna): boolean {
  return tipo === 'int' || tipo === 'double';
}

/** Etiquetas de los tipos, en el orden en que conviene ofrecerlos. */
export const TIPOS_INTERNA: { id: TipoInterna; etiqueta: string; ayuda: string }[] = [
  { id: 'bool', etiqueta: 'Sí / no', ayuda: 'Un interruptor: marcha, alarma, permiso.' },
  { id: 'int', etiqueta: 'Entero', ayuda: 'Cuentas y numeros sin decimales: piezas, turno.' },
  { id: 'double', etiqueta: 'Decimal', ayuda: 'Magnitudes: consignas, temperaturas, caudales.' },
  { id: 'string', etiqueta: 'Texto', ayuda: 'Rotulos y estados escritos: «Turno B», «En pausa».' },
];

export function etiquetaTipo(tipo: TipoInterna): string {
  return TIPOS_INTERNA.find((t) => t.id === tipo)?.etiqueta ?? tipo;
}

// ─── Operaciones ─────────────────────────────────────────────────

export async function listarInternas(): Promise<VariableInterna[]> {
  const r = await apiGet<{ variables?: VariableInterna[] }>('/internas');
  return Array.isArray(r?.variables) ? r.variables : [];
}

/**
 * ¿Lo que devolvio el servidor tiene la forma de una variable?
 *
 * NO ES PARANOIA: esta comprobacion nacio de un fallo real. El POST devolvia
 * la variable en formato TAG (`plc`, `tag`, `type`, `value`) en vez de en
 * formato definicion (`nombre`, `tipo`, ...). Un 200 perfectamente valido
 * con las claves equivocadas. La vista lo metia en la tabla, hacia
 * `variable.nombre.localeCompare(...)` con `nombre` a undefined, y React
 * desmontaba la aplicacion ENTERA: pantalla en negro despues de crear la
 * variable, que ademas si se habia creado.
 *
 * El arreglo de verdad esta en el backend. Esto es el cinturon: que una
 * respuesta inesperada cueste un mensaje de error y no la pantalla.
 */
function esVariable(x: any): x is VariableInterna {
  return !!x && typeof x.nombre === 'string' && typeof x.tipo === 'string';
}

export async function crearInterna(
  datos: NuevaInterna
): Promise<{ variable: VariableInterna; clave: string }> {
  const r = await apiPost<{ variable?: any; clave?: string }>('/internas', datos);
  if (!esVariable(r?.variable)) {
    throw new Error(
      `La variable '${datos.nombre}' se creo, pero el servidor devolvio una ` +
        `respuesta con un formato que no se reconoce. Actualiza la vista ` +
        `para verla.`
    );
  }
  return {
    variable: r.variable,
    clave: r?.clave ?? claveInterna(datos.nombre),
  };
}

/**
 * Cambia la DEFINICION (nombre, tipo, rango, descripcion).
 *
 * Devuelve `renombrada` cuando el nombre cambio, para que la vista pueda
 * avisar de que los widgets enlazados se quedaron sin variable. No es un
 * detalle: es la unica pista de que algo se rompio en otra pantalla.
 */
export async function actualizarInterna(
  nombre: string,
  cambios: Partial<NuevaInterna>
): Promise<{ mensaje: string; renombrada?: { antes: string; ahora: string } }> {
  const r = await apiPatch<{ mensaje?: string; renombrada?: any }>(
    `/internas/${encodeURIComponent(nombre)}`,
    cambios
  );
  return { mensaje: r?.mensaje ?? '', renombrada: r?.renombrada };
}

/**
 * Fuerza el VALOR. Es la operacion del dia a dia.
 *
 * Endpoint aparte del de la definicion a proposito: mover un interruptor lo
 * hace cualquiera que use el panel; cambiarle el tipo a la variable, no.
 */
export async function fijarValorInterna(
  nombre: string,
  valor: unknown
): Promise<unknown> {
  const r = await apiPut<{ valor?: unknown }>(
    `/internas/${encodeURIComponent(nombre)}/valor`,
    { valor }
  );
  return r?.valor;
}

export async function borrarInterna(nombre: string): Promise<void> {
  await apiDelete(`/internas/${encodeURIComponent(nombre)}`);
}
