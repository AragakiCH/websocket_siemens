// =========================================================================
// utils/dinamicas.ts
// Que el sinóptico esté VIVO: el aspecto de un widget según lo que lee.
//
// QUÉ RESUELVE
// Hasta ahora un widget se pintaba siempre igual y como mucho movía su
// aguja. Lo que hace que una pantalla de planta sirva es lo contrario: la
// bomba en rojo cuando falla, el aviso que aparece solo cuando hay que
// hacer algo, el piloto parpadeando mientras la orden está pendiente. En TIA
// Portal son las Animaciones; en WebIQ, estilos enlazados a datos.
//
// UNA REGLA ES: CUANDO <condición>, ENTONCES <efecto>
// Y nada más. Ni expresiones, ni scripts, ni encadenar condiciones con Y/O.
// Con `fuente + operador + valor` se cubre lo que se hace el 95% de las
// veces, se configura en un panel de 288 px y —sobre todo— se puede leer
// dentro de seis meses. Una expresión libre obligaría a un analizador, a
// decidir qué pasa cuando está mal escrita y a explicárselo al que la
// escribió; y en cuanto exista, se acabará usando para cosas que deberían
// estar en el PLC.
//
// EL ORDEN MANDA: gana la ÚLTIMA que se cumple. Así se puede poner una regla
// general arriba («azul si está en marcha») y las excepciones debajo («rojo
// si falla»), que es como se lee una lista de arriba abajo.
//
// SIN LECTURA NO SE APLICA NADA
// Si el tag de una regla no está leyendo —no hay PLC, el enlace está sin
// asignar, el parámetro del faceplate no se rellenó— la condición NO se
// cumple. Nunca se inventa un valor. En un panel de planta, pintar de verde
// «todo correcto» porque no llega el dato es la peor forma posible de
// fallar; el widget se queda como lo dejó el diseñador.
// =========================================================================
import type { HmiWidget } from '../models/widget';
import type { PlcVariable } from '../models/plc';
import { isTruthy } from './format';

export type TipoDinamica = 'visibilidad' | 'color' | 'fondo' | 'borde' | 'parpadeo';

export type OperadorDinamica =
  | 'verdadero'
  | 'falso'
  | '=='
  | '!='
  | '>'
  | '>='
  | '<'
  | '<='
  | 'entre';

export interface Dinamica {
  /** Identidad dentro de la lista. Sirve para la `key` de React y para borrar. */
  id: string;
  tipo: TipoDinamica;
  /** `''` = la variable principal del widget. Si no, el nombre de un enlace. */
  fuente: string;
  operador: OperadorDinamica;
  /** El valor contra el que se compara. No lo usan `verdadero` ni `falso`. */
  valor?: number | string | boolean;
  /** El segundo extremo de `entre`. */
  valor2?: number;
  /** Para `color`, `fondo` y `borde`. Admite un rol del tema. */
  color?: string;
  /** Para `visibilidad`: qué pasa CUANDO SE CUMPLE. */
  efecto?: 'mostrar' | 'ocultar';
}

/** El aspecto que toca pintar, ya resuelto. */
export interface Efectos {
  visible: boolean;
  color?: string;
  background?: string;
  borderColor?: string;
  parpadea: boolean;
}

const TIPOS: TipoDinamica[] = ['visibilidad', 'color', 'fondo', 'borde', 'parpadeo'];
const OPERADORES: OperadorDinamica[] = [
  'verdadero', 'falso', '==', '!=', '>', '>=', '<', '<=', 'entre',
];

/** Las reglas del widget, saneadas. Viene de un fichero de proyecto. */
export function leerDinamicas(widget: HmiWidget | null | undefined): Dinamica[] {
  const bruto = (widget as any)?.dinamicas;
  if (!Array.isArray(bruto)) return [];
  const r: Dinamica[] = [];
  for (const d of bruto) {
    if (!d || typeof d !== 'object') continue;
    if (!TIPOS.includes(d.tipo) || !OPERADORES.includes(d.operador)) continue;
    r.push({
      id: typeof d.id === 'string' && d.id ? d.id : `d${r.length}`,
      tipo: d.tipo,
      fuente: typeof d.fuente === 'string' ? d.fuente : '',
      operador: d.operador,
      valor: d.valor,
      valor2: typeof d.valor2 === 'number' ? d.valor2 : undefined,
      color: typeof d.color === 'string' ? d.color : undefined,
      efecto: d.efecto === 'ocultar' ? 'ocultar' : 'mostrar',
    });
  }
  return r;
}

/**
 * ¿Hay dato de esta variable ahora mismo?
 *
 * Predicado de tipo (`v is PlcVariable`) y no un booleano a secas: así quien
 * lo use puede leer `v.value` a continuación sin volver a comprobarlo ni
 * forzar el tipo a mano.
 */
export const hayLectura = (v: PlcVariable | undefined): v is PlcVariable =>
  !!v && v.value !== null && v.value !== undefined;

/**
 * ¿Se cumple la condición?
 *
 * Sin variable, NO. Ver la nota de la cabecera: un hueco no es «falso», es
 * «no se sabe», y de las dos maneras de equivocarse la que no cambia nada es
 * la buena.
 */
export function cumple(d: Dinamica, v: PlcVariable | undefined): boolean {
  if (!hayLectura(v)) return false;

  if (d.operador === 'verdadero') return isTruthy(v);
  if (d.operador === 'falso') return !isTruthy(v);

  // La comparación se hace en el tipo de LA VARIABLE, no en el de lo que se
  // escribió en el Inspector. Un campo de texto siempre devuelve texto, y
  // `"10" > "9"` es falso: comparadas como cadenas, «9» va después.
  const actual = v.value;

  if (typeof actual === 'boolean') {
    const esperado =
      typeof d.valor === 'boolean'
        ? d.valor
        : String(d.valor).trim().toLowerCase() === 'true' ||
          String(d.valor).trim() === '1';
    if (d.operador === '==') return actual === esperado;
    if (d.operador === '!=') return actual !== esperado;
    return false; // «mayor que» no significa nada en un booleano
  }

  const n = typeof actual === 'number' ? actual : Number(actual);
  if (Number.isFinite(n)) {
    const a = Number(d.valor);
    switch (d.operador) {
      case '==': return Number.isFinite(a) && n === a;
      case '!=': return Number.isFinite(a) && n !== a;
      case '>': return Number.isFinite(a) && n > a;
      case '>=': return Number.isFinite(a) && n >= a;
      case '<': return Number.isFinite(a) && n < a;
      case '<=': return Number.isFinite(a) && n <= a;
      case 'entre': {
        const b = Number(d.valor2);
        if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
        // Los extremos ENTRAN, y da igual en qué orden se escribieran: «entre
        // 90 y 40» quiere decir lo mismo que «entre 40 y 90» para cualquiera
        // que no esté pensando en el código.
        return n >= Math.min(a, b) && n <= Math.max(a, b);
      }
      default: return false;
    }
  }

  // Texto.
  const s = String(actual);
  const e = String(d.valor ?? '');
  if (d.operador === '==') return s === e;
  if (d.operador === '!=') return s !== e;
  return false;
}

/**
 * El aspecto resultante, o `null` si este widget no tiene reglas.
 *
 * `null` y no unos efectos «neutros» a propósito: con él, quien dibuja sabe
 * que no tiene que hacer NADA —ni derivar un widget nuevo, ni comparar
 * estilos— y el camino de los millones de widgets que no usan dinámicas
 * queda exactamente como estaba.
 */
export function evaluarDinamicas(
  widget: HmiWidget,
  principal: PlcVariable | undefined,
  enlaces: Record<string, PlcVariable | undefined> | undefined
): Efectos | null {
  const reglas = leerDinamicas(widget);
  if (reglas.length === 0) return null;

  const ef: Efectos = { visible: true, parpadea: false };
  for (const d of reglas) {
    const v = d.fuente ? enlaces?.[d.fuente] : principal;

    // LA VISIBILIDAD TIENE DOS LADOS, y por eso se trata aparte.
    //
    // «Se ve cuando hay fallo» quiere decir también «no se ve cuando no lo
    // hay»; si la regla solo actuara al cumplirse, el widget aparecería con
    // el fallo y ya no se iría nunca. Las demás dinámicas sí son de un solo
    // lado: al dejar de cumplirse, el widget recupera su color de diseño
    // porque nadie se lo cambió.
    //
    // Sin lectura no se toca: un panel cuyo PLC se acaba de caer no puede
    // quedarse en blanco porque todas las condiciones hayan pasado a ser
    // falsas. Se queda lo que el diseñador dejó.
    if (d.tipo === 'visibilidad') {
      if (!hayLectura(v)) continue;
      ef.visible = cumple(d, v) ? d.efecto !== 'ocultar' : d.efecto === 'ocultar';
      continue;
    }

    if (!cumple(d, v)) continue;
    switch (d.tipo) {
      case 'color': ef.color = d.color; break;
      case 'fondo': ef.background = d.color; break;
      case 'borde': ef.borderColor = d.color; break;
      case 'parpadeo': ef.parpadea = true; break;
    }
  }
  return ef;
}

/**
 * El widget tal y como hay que pintarlo ahora.
 *
 * Se devuelve un widget entero y no solo el estilo porque hay dos formas de
 * leer el aspecto —`widget.style` y `estiloDeParte(widget, …)`, que mira
 * dentro del widget— y los widgets custom usan la segunda. Cambiando el
 * estilo aquí, las dos ven lo mismo y ningún widget necesita enterarse de
 * que existen las dinámicas.
 */
export function aplicarDinamicas(widget: HmiWidget, ef: Efectos | null): HmiWidget {
  if (!ef) return widget;
  if (ef.color === undefined && ef.background === undefined && ef.borderColor === undefined) {
    return widget;
  }
  return {
    ...widget,
    style: {
      ...widget.style,
      ...(ef.color !== undefined ? { color: ef.color } : {}),
      ...(ef.background !== undefined ? { background: ef.background } : {}),
      ...(ef.borderColor !== undefined ? { borderColor: ef.borderColor } : {}),
    },
  };
}

/** Una regla recién creada, con algo razonable puesto. */
export function dinamicaNueva(tipo: TipoDinamica = 'color'): Dinamica {
  return {
    id: `d_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    tipo,
    fuente: '',
    operador: 'verdadero',
    valor: '',
    color: tipo === 'visibilidad' || tipo === 'parpadeo' ? undefined : 'var(--psi-error)',
    efecto: 'mostrar',
  };
}

/** Los operadores que piden un valor escrito. */
export const PIDE_VALOR = (op: OperadorDinamica): boolean =>
  op !== 'verdadero' && op !== 'falso';
