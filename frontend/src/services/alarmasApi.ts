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
//                 crecen sin parar. Las escribirá el motor de alarmas, NO
//                 una persona — por eso esta vista no las toca.
//
// LA VISTA USA CINCO COLUMNAS, LA TABLA TIENE TRECE
//
//   Las cinco son las de "Discrete alarms" de TIA Portal, que es el
//   vocabulario con el que se trabaja en el proyecto:
//
//     ID → id · Name → nombre · Alarm text → texto
//     Alarm class → clase · Trigger tag → tag
//
//   Las otras ocho existen en la tabla porque el motor de alarmas las va a
//   necesitar (`comparador`, `valor_limite`, `banda_muerta`,
//   `tag_reconocimiento`…), pero no hay dónde escribirlas todavía. Se crean
//   en NULL a propósito: una columna vacía se ve vacía, mientras que un
//   valor inventado —un límite de 0, un área "General"— parece configurado y
//   el día que el motor exista se comportaría como si alguien lo hubiera
//   decidido.
//
//   Las TRES excepciones son las columnas `NOT NULL` de la tabla, que un
//   NULL rechazaría en el INSERT: `clase` (la elige la vista), `comparador`
//   (queda en 'bit', la alarma discreta de TIA, que es justo lo que
//   describen estas cinco columnas) y `activo` (1: una alarma recién creada
//   vigila; silenciarla es poner 0, y eso todavía no tiene control en la
//   vista).
//
// POR QUÉ EXISTE ESTE ARCHIVO Y NO SE LLAMA AL CRUD DIRECTAMENTE
//
//   Las columnas de la base están en español y la vista usa el inglés de
//   TIA. Traducir en un solo sitio evita que cada celda de la tabla tenga
//   que saber cómo se llama su columna, y deja UN lugar donde mirar el día
//   que se añada una de las ocho que faltan.
// =========================================================================
import { crearCrud, listarCrud, type FilaCrud } from './crudApi';
import { fetchAuth } from './authApi';

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
 * `bit` es la alarma DISCRETA de TIA: mira un bit concreto del tag. El resto
 * son analógicas y comparan contra `valor_limite`.
 */
export const COMPARADORES = ['bit', '>', '>=', '<', '<=', '==', '!='] as const;
export type Comparador = (typeof COMPARADORES)[number];

/** Etiqueta legible de cada comparador, para el desplegable del editor. */
export const ETIQUETA_COMPARADOR: Record<Comparador, string> = {
  bit: 'Bit activo',
  '>': 'Mayor que',
  '>=': 'Mayor o igual',
  '<': 'Menor que',
  '<=': 'Menor o igual',
  '==': 'Igual a',
  '!=': 'Distinto de',
};

/** ¿Este comparador necesita `valor_limite`, o mira un bit? */
export const esAnalogico = (c: Comparador | string): boolean => c !== 'bit';

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

  /** `bit` (discreta) o un comparador analógico contra `limite`. */
  comparador: Comparador;
  /** Qué bit del tag se mira cuando `comparador === 'bit'`. Un Bool es el 0. */
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
}

/** Tope de filas por lectura. El backend corta en 500 de todos modos. */
const TOPE = 500;

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
 * Todas las definiciones, en orden de id.
 *
 * SIN filtrar por `activo`: una alarma silenciada (`activo = 0`) sigue
 * existiendo y hay que poder verla y editarla. Esta vista no tiene columna
 * para ese campo todavía, y esconder filas que sí están en la base sería la
 * peor forma de no tenerla — el usuario buscaría una alarma que existe y
 * concluiría que se borró sola.
 */
export async function cargarAlarmas(dbId?: string): Promise<Alarm[]> {
  const { filas } = await listarCrud(
    'alarmas_def',
    { orden: 'id', descendente: false, limite: TOPE },
    dbId
  );
  return filas.map(aAlarma);
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
 */
export function siguienteNombre(alarmas: Alarm[]): string {
  const usados = new Set(alarmas.map((a) => a.name.trim()));
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
