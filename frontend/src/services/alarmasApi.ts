// =========================================================================
// alarmasApi.ts
// Las alarmas, traducidas entre la base de datos y la vista.
//
// SON DOS TABLAS, Y ESTA ES LA PRIMERA
//
//   alarmas_def   la CONFIGURACIÓN: qué se vigila. "Si DB1.temperatura pasa
//                 de 80, es un Error y dice «Temperatura alta»". Se escribe
//                 una vez y no cambia en meses. Es lo que edita esta vista.
//
//   alarmas       los EVENTOS: qué pasó y cuándo. Una fila por disparo, y
//                 crecen sin parar. Las escribe el motor de alarmas, NO
//                 una persona — por eso esta vista no las toca.
//
// QUÉ EDITA LA VISTA Y QUÉ NO
//
//   Las cinco primeras columnas son las de "Discrete alarms" de TIA Portal,
//   que es el vocabulario con el que se trabaja en el proyecto:
//
//     ID → id · Name → nombre · Alarm text → texto
//     Alarm class → clase · Trigger tag → tag
//
//   Y la CONDICIÓN, que es lo que el motor necesita para evaluar:
//
//     Condición → comparador (+ bit_disparo o valor_limite)
//     Banda → banda_muerta · On → activo
//
//   Qué condiciones se ofrecen depende del TIPO del tag (`comparadoresPara`):
//   un Bool solo admite bit activo / inactivo, un decimal solo comparaciones.
//
//   Lo que sigue sin tener dónde editarse (`tag_reconocimiento`,
//   `bit_reconocimiento`, `area`) se crea en NULL a propósito: una columna
//   vacía se ve vacía, mientras que un valor inventado —un área "General"—
//   parece configurado y se comportaría como si alguien lo hubiera decidido.
//
//   `eliminado_en` es la PAPELERA: no la escribe la vista con un PATCH, sino
//   el servidor por su propio camino (`eliminarAlarma` / `restaurarAlarma`).
//
// POR QUÉ EXISTE ESTE ARCHIVO Y NO SE LLAMA AL CRUD DIRECTAMENTE
//
//   Las columnas de la base están en español y la vista usa el inglés de
//   TIA. Traducir en un solo sitio evita que cada celda de la tabla tenga
//   que saber cómo se llama su columna, y deja UN lugar donde mirar el día
//   que se añada una de las que faltan.
// =========================================================================
import { crearCrud, listarCrud, type FilaCrud } from './crudApi';
import { fetchAuth, getBasePreferida } from './authApi';
import { mapOpcType } from './plcAdapter';
import { API_BASE, apiPost } from '../components/flows/api';

/**
 * Las cinco clases de TIA, de más a menos grave.
 *
 * En inglés a propósito: es como aparecen en TIA, como las valida el backend
 * (`CLASES_ALARMA` en crud_manager.py) y como se guardan en la columna
 * `clase`. Traducirlas obligaría a traducir de vuelta al comparar.
 */
export const ALARM_CLASS_IDS = [
  'Critical',
  'Error',
  'Warning',
  'Maintenance',
  'Information',
] as const;

export type AlarmClassId = (typeof ALARM_CLASS_IDS)[number];

/** Clase por defecto de una alarma nueva: es la más frecuente. */
export const CLASE_DEFECTO: AlarmClassId = 'Error';

/**
 * Cómo se evalúa la condición. Mismos valores que `COMPARADORES` en
 * `crud_manager.py` y que lee el motor en `alarm_engine.py`.
 *
 * `bit` es la alarma DISCRETA de TIA: mira un bit concreto del tag y salta
 * cuando está a 1. `!bit` es la misma al revés —salta cuando el bit está a
 * 0—, que es la alarma de «falta la señal»: el permisivo que se cae, la
 * marcha que no llega. El resto son analógicas y comparan contra
 * `valor_limite`.
 *
 * EL ORDEN ES EL DEL DESPLEGABLE, y la primera es la de arranque: una alarma
 * nueva nace en «Bit activo».
 */
export const COMPARADORES = [
  'bit', '!bit', '>', '>=', '<', '<=', '==', '!=',
] as const;
export type Comparador = (typeof COMPARADORES)[number];

/** Etiqueta legible de cada comparador, para el desplegable del editor. */
export const ETIQUETA_COMPARADOR: Record<Comparador, string> = {
  bit: 'Bit activo (TRUE / 1)',
  '!bit': 'Bit inactivo (FALSE / 0)',
  '>': 'Mayor que',
  '>=': 'Mayor o igual',
  '<': 'Menor que',
  '<=': 'Menor o igual',
  '==': 'Igual a',
  '!=': 'Distinto de',
};

/** Los dos que miran un bit. */
const DE_BIT: readonly Comparador[] = ['bit', '!bit'];
/** Los seis que comparan contra el límite. */
const ANALOGICOS: readonly Comparador[] = ['>', '>=', '<', '<=', '==', '!='];

/** ¿Este comparador mira un bit del tag (activo o inactivo)? */
export const esDeBit = (c: Comparador | string): boolean =>
  c === 'bit' || c === '!bit';

/** ¿Este comparador necesita `valor_limite`, o mira un bit? */
export const esAnalogico = (c: Comparador | string): boolean => !esDeBit(c);

// ─── Qué condición admite cada tipo de tag ───────────────────────
//
// No todas las condiciones tienen sentido para todos los tags, y ofrecerlas
// todas siempre era invitar a configurar alarmas que no pueden saltar:
//
//   Bool      Es UN bit. Solo «Bit activo» / «Bit inactivo», y sin elegir
//             cuál: no hay más que uno.
//   Entero    Todo vale. Como palabra de estado se mira un bit —y ahí sí se
//             elige cuál—; como contador o consigna, se compara.
//   Decimal   No tiene bits que mirar: solo las comparaciones.
//
// Cuando el tipo NO se sabe (el tag se escribió a mano, el PLC está apagado y
// todavía no se ha hecho el browse) no se restringe nada: configurar alarmas
// desde la oficina con la máquina parada tiene que seguir siendo posible.

/** El tipo del Trigger tag, a efectos de qué condición se le puede poner. */
export type TipoTag = 'bool' | 'entero' | 'decimal' | 'otro';

/**
 * Del tipo que anuncia el PLC (OPC UA, S7, CIP…) al que importa aquí.
 *
 * Reutiliza `mapOpcType`, el mismo traductor con el que el resto de la
 * aplicación decide si una variable es booleana, entera o decimal: así una
 * variable no puede ser «entera» en el Diseñador y «decimal» en esta tabla.
 * Si el tag no trae tipo, el último valor recibido al menos delata a un
 * booleano.
 */
export function tipoDeTag(
  tipoPlc: string | null | undefined,
  ultimoValor?: unknown
): TipoTag {
  const t = String(tipoPlc ?? '').trim();
  if (t) {
    const d = mapOpcType(t);
    if (d === 'bool') return 'bool';
    if (d === 'int') return 'entero';
    if (d === 'double') return 'decimal';
    return 'otro';
  }
  return typeof ultimoValor === 'boolean' ? 'bool' : 'otro';
}

/** Las condiciones que se ofrecen para ese tipo, en el orden del desplegable. */
export function comparadoresPara(tipo: TipoTag): readonly Comparador[] {
  if (tipo === 'bool') return DE_BIT;
  if (tipo === 'decimal') return ANALOGICOS;
  return COMPARADORES;
}

/**
 * ¿Hay que elegir QUÉ bit se mira?
 *
 * Solo con una condición de bit, y solo si el tag puede tener más de uno: en
 * un Bool no hay nada que elegir, y un decimal no tiene bits.
 */
export function admiteElegirBit(tipo: TipoTag, c: Comparador | string): boolean {
  return esDeBit(c) && tipo !== 'bool' && tipo !== 'decimal';
}

/**
 * Una alarma tal como la pinta la vista.
 *
 * `id` es el de la base de datos, no un correlativo del navegador: es la
 * única forma de volver a apuntar a la misma fila en la siguiente petición.
 * Por eso tampoco se renumera al borrar — si la 3 desaparece, la 4 sigue
 * siendo la 4, y el día que un evento de `alarmas` apunte a ella seguirá
 * significando lo mismo.
 */
export interface Alarm {
  id: number;
  name: string;
  text: string;
  alarmClass: AlarmClassId;
  /** Tag que la dispara, en formato `<plc>|<tag>`. `''` se muestra `<No tag>`. */
  triggerTag: string;

  // ── Lo que el MOTOR necesita para poder evaluar ──────────────────
  //
  // Estas cuatro estuvieron en la tabla desde el principio pero sin dónde
  // editarlas: se creaban en NULL y ahí se quedaban. Mientras no hubo motor
  // daba igual; ahora no, porque una alarma sin condición no salta nunca y
  // desde la vista era indistinguible de una que sí funciona.

  /** `bit` / `!bit` (discreta) o un comparador analógico contra `limite`. */
  comparador: Comparador;
  /** Qué bit del tag se mira en una condición de bit. Un Bool es el 0. */
  bitDisparo: number;
  /** Contra qué se compara en las analógicas. `null` = sin configurar. */
  limite: number | null;
  /**
   * Histéresis: cuánto tiene que volver el valor para darla por normalizada.
   *
   * Solo se aplica para APAGAR, nunca para disparar (ver `evaluar()` en
   * `alarm_engine.py`). Sin ella, un valor oscilando en el límite genera
   * cientos de eventos por minuto.
   */
  bandaMuerta: number;
  /** `false` silencia la regla sin borrarla: se conserva y se puede reactivar. */
  activo: boolean;
  /**
   * LA PAPELERA. `null` = la alarma está en uso. Con fecha = alguien la
   * eliminó ese día: baja a la tabla de eliminadas, el motor deja de
   * vigilarla y se puede restaurar. La fila sigue en la base con su mismo
   * `id`, que es lo que mantiene el histórico apuntando a ella.
   */
  eliminadoEn: string | null;
}

/** Tope de filas por lectura. El backend corta en 500 de todos modos. */
const TOPE = 500;
/** Tope de cordura al leer página a página. */
const MAX_FILAS = 20000;

const txt = (v: any): string => (v === null || v === undefined ? '' : String(v));

function aClase(v: any): AlarmClassId {
  const s = txt(v);
  return (ALARM_CLASS_IDS as readonly string[]).includes(s)
    ? (s as AlarmClassId)
    : CLASE_DEFECTO;
}

function aComparador(v: any): Comparador {
  const s = txt(v);
  return (COMPARADORES as readonly string[]).includes(s)
    ? (s as Comparador)
    : 'bit';
}

/**
 * Número, o `null` si la columna viene vacía.
 *
 * `Number(null)` es 0, y ese 0 sería mentira: significaría "el límite es
 * cero" cuando la verdad es "nadie configuró un límite". El motor distingue
 * los dos casos —con `null` no evalúa— y la vista tiene que poder también.
 */
function num(v: any): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// ─── De la base a la vista ───────────────────────────────────────

export function aAlarma(f: FilaCrud): Alarm {
  return {
    id: Number(f.id),
    name: txt(f.nombre),
    text: txt(f.texto),
    alarmClass: aClase(f.clase),
    triggerTag: txt(f.tag),
    comparador: aComparador(f.comparador),
    bitDisparo: num(f.bit_disparo) ?? 0,
    limite: num(f.valor_limite),
    bandaMuerta: num(f.banda_muerta) ?? 0,
    // La columna es NOT NULL DEFAULT 1, pero una base vieja sin migrar podría
    // no traerla: se asume que vigila, que es lo que espera quien la creó.
    activo: f.activo === undefined || f.activo === null ? true : Boolean(Number(f.activo)),
    // Una base de antes de la papelera no trae la columna: ninguna alarma
    // suya está eliminada, que es justo lo que da `null`.
    eliminadoEn: txt(f.eliminado_en) || null,
  };
}

// ─── De la vista a la base ───────────────────────────────────────

/**
 * PATCH parcial: solo las columnas que el usuario tocó.
 *
 * Un tag vacío viaja como `null`, no como `''`: la columna admite NULL y en
 * la base "sin tag" y "tag vacío" tienen que ser lo mismo, o filtrar por
 * `tag IS NULL` dejaría fuera la mitad de las alarmas sin configurar.
 */
export function patchAlarmaADb(p: Partial<Alarm>): FilaCrud {
  const d: FilaCrud = {};
  if (p.name !== undefined) d.nombre = p.name;
  if (p.text !== undefined) d.texto = p.text;
  if (p.alarmClass !== undefined) d.clase = p.alarmClass;
  if (p.triggerTag !== undefined) d.tag = p.triggerTag.trim() || null;
  if (p.comparador !== undefined) d.comparador = p.comparador;
  if (p.bitDisparo !== undefined) d.bit_disparo = p.bitDisparo;
  // `null` explícito y no `|| null`: un límite de 0 es perfectamente válido
  // ("si el caudal baja de 0") y `0 || null` lo convertiría en "sin límite",
  // desactivando la alarma en silencio.
  if (p.limite !== undefined) d.valor_limite = p.limite;
  if (p.bandaMuerta !== undefined) d.banda_muerta = p.bandaMuerta;
  if (p.activo !== undefined) d.activo = p.activo ? 1 : 0;
  return d;
}

/**
 * Fila de una alarma NUEVA, con las ocho columnas que la vista no edita
 * puestas en NULL.
 *
 * `texto` no puede ir vacío: el backend lo exige (`obligatorias` de
 * `alarmas_def`) y con razón — una alarma sin mensaje no le dice nada a
 * quien la ve saltar. Se arranca con el ejemplo de su clase, que es el mismo
 * texto que la celda ya enseñaba como sugerencia; se borra o se reescribe
 * encima, y a partir de ahí el PATCH sí acepta dejarlo vacío.
 */
export function nuevaAlarmaDb(
  nombre: string,
  texto: string,
  clase: AlarmClassId = CLASE_DEFECTO,
  tag: string = ''
): FilaCrud {
  return {
    // --- lo que llena la vista ---
    nombre,
    texto,
    clase,
    tag: tag.trim() || null,
    // --- la condición, ya editable desde la tabla ---
    //
    // Arranca como alarma DISCRETA sobre el bit 0, que es el caso más común
    // y el único que funciona sin configurar nada más: un Bool del PLC
    // dispara en cuanto se pone a true. Una analógica necesita además un
    // límite, y ese no se puede inventar.
    comparador: 'bit',
    bit_disparo: 0,
    valor_limite: null,
    banda_muerta: 0,
    activo: 1,
    // --- lo que sigue sin tener dónde editarse ---
    // El reconocimiento DESDE el PLC exige escribir en el autómata, que es
    // otra conversación. `area` espera a que haya agrupación por zonas.
    tag_reconocimiento: null,
    bit_reconocimiento: null,
    area: null,
  };
}

// ─── Avisar al motor ─────────────────────────────────────────────

/**
 * Le dice al backend que relea `alarmas_def`.
 *
 * El motor tiene las reglas en MEMORIA (es lo que le permite evaluar miles
 * de valores por segundo sin tocar la base), así que editar una fila no le
 * llega solo. Tiene un barrido de seguridad cada minuto, pero un minuto es
 * mucho cuando acabas de configurar una alarma y quieres ver si salta.
 *
 * Falla en silencio a propósito: si el motor está apagado o la sesión no
 * llega a Administradores, la alarma se guardó igual — que es lo que el
 * usuario pidió— y el barrido la recogerá. Molestar con un error rojo por
 * esto sería confundir "no se aplicó todavía" con "no se guardó".
 */
export async function recargarMotor(): Promise<void> {
  try {
    await fetchAuth('/alarmas/recargar', { method: 'POST' });
  } catch {
    /* el barrido periódico del motor la recogerá igualmente */
  }
}

// ─── Lectura ─────────────────────────────────────────────────────

/**
 * Todas las definiciones, en orden de id. TODAS: las que están en uso y las
 * de la papelera (`eliminadoEn`), que el editor reparte en sus dos tablas.
 *
 * SIN filtrar por `activo`: una alarma silenciada (`activo = 0`) sigue
 * existiendo y hay que poder verla y editarla. Esconder filas que sí están en
 * la base sería la peor forma de no enseñarlas — el usuario buscaría una
 * alarma que existe y concluiría que se borró sola.
 *
 * Se lee PÁGINA A PÁGINA. El backend corta cada lectura en 500 filas, y con
 * una sola petición la alarma 501 no aparecería nunca, sin ningún aviso.
 * Importa más desde que hay papelera: lo eliminado también ocupa sitio en
 * esa cuenta.
 */
export async function cargarAlarmas(dbId?: string): Promise<Alarm[]> {
  const todas: Alarm[] = [];
  for (let offset = 0; offset < MAX_FILAS; offset += TOPE) {
    const { filas } = await listarCrud(
      'alarmas_def',
      { orden: 'id', descendente: false, limite: TOPE, offset },
      dbId
    );
    todas.push(...filas.map(aAlarma));
    if (filas.length < TOPE) break;
  }
  return todas;
}

// ─── La papelera ─────────────────────────────────────────────────
//
// Eliminar una alarma NO la borra: la manda a la papelera, de donde se puede
// restaurar. Va por un endpoint propio y no por el CRUD porque no es solo
// apuntar la fecha: el motor tiene que dejar de vigilarla en ese momento y
// cerrar la alarma que tuviera activa (ver `alarm_routes.py`). Los dos piden
// rol Administradores, igual que el borrado de siempre.
//
// El borrado DEFINITIVO sigue siendo `borrarCrud('alarmas_def', id)`.

function conBase(ruta: string, dbId?: string): string {
  const db = (dbId ?? '').trim() || getBasePreferida();
  return db ? `${ruta}?db_id=${encodeURIComponent(db)}` : ruta;
}

/**
 * La base de datos no tiene papelera, y el servidor no pudo creársela.
 *
 * Pasa donde el HMI se conecta con un usuario de solo datos (lo que crea el
 * asistente en SQL Server): la papelera es una columna de `alarmas_def`, y
 * ese usuario no puede añadir columnas. Tiene arreglo, y por eso es un error
 * con nombre: trae en `sql` la sentencia exacta que hay que ejecutar una vez,
 * para que el editor la enseñe con su botón de copiar y ofrezca mientras
 * tanto el borrado definitivo, en vez de un «no se pudo» sin salida.
 */
export class PapeleraNoDisponible extends Error {
  readonly sql: string;

  constructor(mensaje: string, sql: string) {
    super(mensaje);
    this.name = 'PapeleraNoDisponible';
    this.sql = sql;
    // Sin esto, `instanceof` falla si el código se compila a ES5.
    Object.setPrototypeOf(this, PapeleraNoDisponible.prototype);
  }
}

/** Manda la alarma a la papelera. Devuelve cuándo quedó eliminada. */
export async function eliminarAlarma(id: number, dbId?: string): Promise<string> {
  let r: { fila?: FilaCrud } | null;
  try {
    // `fetchAuth` y no `apiPost`: conserva el cuerpo del error, que aquí
    // viene con estructura (ver el `catch`). Con `API_BASE` delante, que es
    // lo que `apiPost` pone por su cuenta.
    r = await fetchAuth(
      API_BASE + conBase(`/alarmas/definiciones/${id}/eliminar`, dbId),
      { method: 'POST' }
    );
  } catch (e: any) {
    const detalle = e?.data?.detail;
    if (
      detalle &&
      typeof detalle === 'object' &&
      detalle.codigo === 'papelera_no_disponible'
    ) {
      throw new PapeleraNoDisponible(txt(detalle.mensaje), txt(detalle.sql));
    }
    throw e;
  }
  // La fecha la pone el servidor. Si por lo que sea no viniera, la de ahora
  // es la mejor aproximación: lo que importa en la vista es que NO sea null.
  return txt(r?.fila?.eliminado_en) || new Date().toISOString();
}

/** Saca la alarma de la papelera: vuelve tal como estaba. */
export async function restaurarAlarma(id: number, dbId?: string): Promise<void> {
  await apiPost(conBase(`/alarmas/definiciones/${id}/restaurar`, dbId));
}

/** Crea una alarma y devuelve la fila completa ya traducida. */
export async function crearAlarma(
  datos: FilaCrud,
  dbId?: string
): Promise<Alarm> {
  const { id, fila } = await crearCrud('alarmas_def', datos, dbId);
  // El backend devuelve la fila entera —con los valores por defecto que la
  // vista no conoce—, pero si no pudo releerla se arma con lo que se mandó:
  // más vale una fila correcta que un parpadeo.
  return Object.keys(fila).length > 1
    ? aAlarma(fila)
    : aAlarma({ ...datos, id });
}

/**
 * Siguiente nombre libre de la serie `Alarma_N`.
 *
 * Se calcula sobre los NOMBRES, no sobre los ids: los ids los da la base y
 * pueden venir de otra pantalla o de otro PC, así que `Alarma_47` con solo
 * tres alarmas en la tabla sería desconcertante. Lo que importa es que no se
 * repita el nombre en la lista que se está viendo.
 *
 * `tambienOcupados` son las de la papelera: no cuentan para el número de
 * arranque, pero su nombre tampoco se reutiliza — si luego se restaura una,
 * no puede encontrarse con otra que se llama igual.
 */
export function siguienteNombre(
  alarmas: Alarm[],
  tambienOcupados: Alarm[] = []
): string {
  const usados = new Set(
    [...alarmas, ...tambienOcupados].map((a) => a.name.trim())
  );
  let n = alarmas.length + 1;
  while (usados.has(`Alarma_${n}`)) n += 1;
  return `Alarma_${n}`;
}

// ─── En qué base se guardan ──────────────────────────────────────
//
// Se recuerda por navegador, igual que en recetas: el PC de planta y el de
// oficina pueden trabajar contra bases distintas a propósito. Arranca en la
// del login, que es lo que espera quien no sepa que esto se puede cambiar.

const CLAVE_BASE_ALARMAS = 'hmi.alarmas.db';

export function getBaseAlarmas(): string {
  try {
    return localStorage.getItem(CLAVE_BASE_ALARMAS) ?? '';
  } catch {
    return '';
  }
}

export function setBaseAlarmas(dbId: string): void {
  try {
    if (dbId) localStorage.setItem(CLAVE_BASE_ALARMAS, dbId);
    else localStorage.removeItem(CLAVE_BASE_ALARMAS);
  } catch {
    /* sin storage: se usará la del login en cada arranque */
  }
}

// ─── Lo que quedó guardado en el navegador ───────────────────────
//
// Hasta ahora esta pantalla guardaba en `localStorage`. Esas alarmas no se
// borran ni se suben solas: subirlas sin preguntar duplicaría las que ya
// estén en la base, y borrarlas sin avisar perdería el trabajo de alguien.
// Se ofrecen para importar, una vez, y se olvidan cuando ya están arriba.

const CLAVE_VIEJA = 'hmi.alarms';

export function leerAlarmasLocales(): Alarm[] {
  try {
    const raw = localStorage.getItem(CLAVE_VIEJA);
    if (!raw) return [];
    const datos = JSON.parse(raw);
    if (!Array.isArray(datos)) return [];
    return datos
      .filter((a) => a && typeof a === 'object')
      .map((a: any) => ({
        id: Number(a.id ?? 0),
        name: txt(a.name),
        text: txt(a.text),
        alarmClass: aClase(a.alarmClass),
        triggerTag: txt(a.triggerTag),
        // Lo guardado en el navegador es de ANTES de que existiera la
        // condición: solo tenía las cinco columnas de TIA. Se completa con
        // el mismo arranque que una alarma nueva, no con lo que hubiera en
        // el JSON viejo, porque allí no había nada que leer.
        comparador: 'bit' as Comparador,
        bitDisparo: 0,
        limite: null,
        bandaMuerta: 0,
        activo: true,
        eliminadoEn: null,
      }));
  } catch {
    return [];
  }
}

export function olvidarAlarmasLocales(): void {
  try {
    localStorage.removeItem(CLAVE_VIEJA);
  } catch {
    /* nada que olvidar */
  }
}
