// =========================================================================
// acciones.ts
// Qué hace un widget cuando el operario lo pulsa.
//
// EL AGUJERO QUE TAPA
// Hasta ahora el HMI sólo leía. El backend sabía escribir desde hace tiempo
// (`POST /escritura`, con lista blanca y auditoría), pero ningún widget lo
// llamaba: el botón no tenía acciones y el interruptor sólo se pintaba — se
// movía en pantalla y el PLC ni se enteraba. Un HMI que no puede mandar nada
// no es un HMI, es un visor.
//
// LAS TRES PRIMERAS, Y POR QUÉ ESTAS
// `escribir`, `alternar` e `incrementar` cubren de una vez casi todo lo que
// TIA Portal reparte en funciones distintas —SetValue, SetBit, ResetBit,
// InvertBit, IncreaseTag, DecreaseTag— y lo que WebIQ llama `write-item`,
// `item-toggle` e `increment-item-value`. Con estas tres, un panel puede
// operar.
//
// LO QUE NO SE INVENTA AQUÍ
// La validación de verdad la hace el servidor: lista blanca, límites, tipo
// del tag y auditoría de quién escribió qué. Este módulo no la duplica, sólo
// arma la petición. Duplicar reglas de seguridad en el cliente es la forma
// segura de que las dos versiones se separen.
// =========================================================================
import { escribir, partirId } from '../../services/escrituraApi';
import type { PlcVariable } from '../../models/plc';

export type TipoAccion = 'ninguna' | 'escribir' | 'alternar' | 'incrementar';

export interface AccionWidget {
  tipo: TipoAccion;
  /** `plc|tag`, el mismo id que usan las variables de la vista. */
  tag: string;
  /** Para `escribir`: lo que se manda. Texto, número o booleano. */
  valor?: string | number | boolean;
  /** Para `incrementar`: cuánto. Negativo para restar. */
  paso?: number;
  /** Pedir confirmación antes de mandar. */
  confirmar?: boolean;
  /** El texto de esa confirmación. Vacío = uno genérico. */
  mensaje?: string;
}

export const ACCION_VACIA: AccionWidget = {
  tipo: 'ninguna',
  tag: '',
  paso: 1,
  confirmar: false,
  mensaje: '',
};

export function leerAccion(config: any): AccionWidget {
  const a = config?.accion ?? {};
  const tipo: TipoAccion = ['escribir', 'alternar', 'incrementar'].includes(a.tipo)
    ? a.tipo
    : 'ninguna';
  return {
    tipo,
    tag: typeof a.tag === 'string' ? a.tag : '',
    valor: a.valor,
    paso: typeof a.paso === 'number' && Number.isFinite(a.paso) ? a.paso : 1,
    confirmar: !!a.confirmar,
    mensaje: typeof a.mensaje === 'string' ? a.mensaje : '',
  };
}

/** ¿Este widget hace algo al pulsarlo? */
export const tieneAccion = (a: AccionWidget): boolean =>
  a.tipo !== 'ninguna' && !!a.tag;

/**
 * El valor que hay que mandar, a partir del que hay ahora.
 *
 * Separado de la ejecución para poder razonarlo —y probarlo— sin red de por
 * medio. Devuelve `null` cuando no hay nada que mandar, que NO es lo mismo
 * que mandar cero.
 */
export function valorAEscribir(
  accion: AccionWidget,
  actual: PlcVariable | undefined
): unknown | null {
  switch (accion.tipo) {
    case 'escribir':
      return accion.valor ?? null;

    case 'alternar': {
      // Sin lectura previa no se alterna: escribir «true» a ciegas sobre un
      // bit que ya estaba en true no es alternar, es imponer. Y en un mando
      // de planta esa diferencia importa.
      if (!actual) return null;
      const v = actual.value;
      if (typeof v === 'boolean') return !v;
      return Number(v) ? 0 : 1;
    }

    case 'incrementar': {
      if (!actual) return null;
      const n = typeof actual.value === 'number' ? actual.value : Number(actual.value);
      if (!Number.isFinite(n)) return null;
      return n + (accion.paso ?? 1);
    }

    default:
      return null;
  }
}

/** Lo que se le pregunta al operario antes de mandar. */
export function textoConfirmacion(
  accion: AccionWidget,
  valor: unknown,
  etiqueta: string
): string {
  if (accion.mensaje) return accion.mensaje;
  const nombre = etiqueta || accion.tag;
  return `¿Escribir ${JSON.stringify(valor)} en «${nombre}»?`;
}

export interface ResultadoAccion {
  ok: boolean;
  /** Qué se mandó, para poder decirlo. */
  valor?: unknown;
  error?: string;
}

/**
 * Ejecuta la acción.
 *
 * Devuelve el resultado en vez de lanzar: quien llama es un manejador de
 * clic, y una excepción ahí se pierde en la consola sin que el operario se
 * entere de que su orden no salió.
 */
export async function ejecutarAccion(
  accion: AccionWidget,
  actual: PlcVariable | undefined,
  etiqueta = ''
): Promise<ResultadoAccion> {
  if (!tieneAccion(accion)) return { ok: false, error: 'Sin acción configurada.' };

  const valor = valorAEscribir(accion, actual);
  if (valor === null) {
    return {
      ok: false,
      error:
        accion.tipo === 'escribir'
          ? 'La acción no tiene valor que escribir.'
          : 'No hay lectura del tag todavía, así que no se puede calcular el ' +
            'valor nuevo. Comprueba que el PLC está en línea.',
    };
  }

  const { plc_id, tag } = partirId(accion.tag);
  if (!plc_id) {
    return {
      ok: false,
      error: `«${accion.tag}» no identifica un PLC, así que no se puede escribir.`,
    };
  }

  if (accion.confirmar) {
    // `confirm` y no un modal propio: esto es una orden a una máquina y el
    // diálogo del navegador BLOQUEA de verdad. Un modal casero se puede
    // esquivar con un segundo clic mientras aparece.
    if (!window.confirm(textoConfirmacion(accion, valor, etiqueta))) {
      return { ok: false, error: '' };
    }
  }

  try {
    await escribir([{ plc_id, tag, valor }]);
    return { ok: true, valor };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? 'No se pudo escribir.' };
  }
}
