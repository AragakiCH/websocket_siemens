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
import { reconocerTodas } from '../../services/alarmasRuntimeApi';
import { logout } from '../../services/authApi';
import { leerTemas, guardarTemas } from '../../services/temaApi';
import { setVistaActiva, GRUPO_POR_DEFECTO } from './custom/navegacion/store';

export type TipoAccion =
  | 'ninguna'
  // Escriben en el PLC.
  | 'escribir'
  | 'alternar'
  | 'incrementar'
  // No escriben: mandan sobre la propia aplicación.
  | 'reconocer-alarmas'
  | 'ir-a-seccion'
  | 'modo-color'
  | 'tema'
  | 'aviso'
  | 'salir';

/** Las que tocan el PLC. Son las que piden tag y lista blanca. */
export const ACCIONES_DE_PLC: TipoAccion[] = ['escribir', 'alternar', 'incrementar'];

/**
 * Lo que la acción necesita de React y no puede importar.
 *
 * Cambiar el modo de color es del contexto de la aplicación, no una función
 * suelta. Pasándolo aquí, este módulo sigue siendo una función normal —que se
 * puede leer y razonar sin montar nada— en vez de un hook.
 */
export interface EntornoAccion {
  setModoColor?: (modo: 'light' | 'dark' | 'auto') => void;
}

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
  /** El texto de esa confirmación, o el aviso de la acción `aviso`. */
  mensaje?: string;
  /** Para `ir-a-seccion`. */
  seccion?: string;
  grupo?: string;
  /** Para `modo-color`. */
  modo?: 'light' | 'dark' | 'auto';
  /** Para `tema`: el id del tema que pasa a estar activo. */
  temaId?: string;
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
  const conocidas: TipoAccion[] = [
    'escribir', 'alternar', 'incrementar',
    'reconocer-alarmas', 'ir-a-seccion', 'modo-color', 'tema', 'aviso', 'salir',
  ];
  const tipo: TipoAccion = conocidas.includes(a.tipo) ? a.tipo : 'ninguna';
  return {
    tipo,
    tag: typeof a.tag === 'string' ? a.tag : '',
    valor: a.valor,
    paso: typeof a.paso === 'number' && Number.isFinite(a.paso) ? a.paso : 1,
    confirmar: !!a.confirmar,
    mensaje: typeof a.mensaje === 'string' ? a.mensaje : '',
    seccion: typeof a.seccion === 'string' ? a.seccion : '',
    grupo: typeof a.grupo === 'string' && a.grupo ? a.grupo : GRUPO_POR_DEFECTO,
    modo: ['light', 'dark', 'auto'].includes(a.modo) ? a.modo : 'auto',
    temaId: typeof a.temaId === 'string' ? a.temaId : '',
  };
}

/**
 * ¿Este widget hace algo al pulsarlo?
 *
 * Las de PLC necesitan tag; `ir-a-seccion` necesita sección. Las demás se
 * bastan solas. Sin esta distinción, un botón de «Reconocer alarmas» se
 * quedaría mudo por no tener un tag que no le hace ninguna falta.
 */
export const tieneAccion = (a: AccionWidget): boolean => {
  if (a.tipo === 'ninguna') return false;
  if (ACCIONES_DE_PLC.includes(a.tipo)) return !!a.tag;
  if (a.tipo === 'ir-a-seccion') return !!a.seccion;
  return true;
};

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
  if (ACCIONES_DE_PLC.includes(accion.tipo)) {
    const nombre = etiqueta || accion.tag;
    return `¿Escribir ${JSON.stringify(valor)} en «${nombre}»?`;
  }
  if (accion.tipo === 'reconocer-alarmas') {
    return '¿Reconocer TODAS las alarmas pendientes?';
  }
  if (accion.tipo === 'salir') return '¿Cerrar la sesión?';
  return '¿Continuar?';
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
  etiqueta = '',
  entorno: EntornoAccion = {}
): Promise<ResultadoAccion> {
  if (!tieneAccion(accion)) return { ok: false, error: 'Sin acción configurada.' };

  // La confirmación se pregunta ANTES de nada, y es común a todas. Antes sólo
  // la tenían las escrituras; reconocer todas las alarmas de golpe o cerrar
  // la sesión de un panel en marcha merecen la misma pregunta.
  //
  // `confirm` y no un modal propio: es una orden, y el diálogo del navegador
  // bloquea de verdad; uno casero se esquiva con un segundo clic.
  if (accion.confirmar && accion.tipo !== 'aviso') {
    const previo = ACCIONES_DE_PLC.includes(accion.tipo)
      ? valorAEscribir(accion, actual)
      : null;
    if (!window.confirm(textoConfirmacion(accion, previo, etiqueta))) {
      return { ok: false, error: '' };
    }
  }

  // ── Las que NO escriben en el PLC ────────────────────────────
  try {
    switch (accion.tipo) {
      case 'aviso':
        window.alert(accion.mensaje || 'Aviso');
        return { ok: true };

      case 'ir-a-seccion':
        // La MISMA función que el menú, las pestañas de la barra y la
        // Tarjeta de Acceso: cuatro mandos de una sola navegación, que se
        // sincronizan solos porque comparten estado.
        setVistaActiva(accion.grupo || GRUPO_POR_DEFECTO, accion.seccion || '');
        return { ok: true };

      case 'modo-color':
        if (!entorno.setModoColor) {
          return { ok: false, error: 'El modo de color no está disponible aquí.' };
        }
        entorno.setModoColor(accion.modo ?? 'auto');
        return { ok: true };

      case 'tema': {
        // Cambiar el tema ACTIVO de la instalación. Se relee antes de
        // escribir para mandar la versión buena: si otro lo tocó mientras
        // tanto, el servidor responde 409 y este botón no tiene forma de
        // preguntarle nada a nadie.
        const doc = await leerTemas();
        if (!doc.temas.some((x) => x.id === accion.temaId)) {
          return { ok: false, error: `El tema «${accion.temaId}» ya no existe.` };
        }
        await guardarTemas(doc.temas, accion.temaId!, doc.version);
        return { ok: true };
      }

      case 'reconocer-alarmas':
        await reconocerTodas();
        return { ok: true };

      case 'salir':
        await logout();
        // Recargar y no navegar: cerrar sesión tiene que dejar la aplicación
        // como recién abierta, sin estado de la sesión anterior en memoria.
        window.location.href = '/';
        return { ok: true };
    }
  } catch (e: any) {
    return { ok: false, error: e?.message ?? 'No se pudo completar la acción.' };
  }

  // ── Las que escriben en el PLC ───────────────────────────────
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

  try {
    await escribir([{ plc_id, tag, valor }]);
    return { ok: true, valor };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? 'No se pudo escribir.' };
  }
}
