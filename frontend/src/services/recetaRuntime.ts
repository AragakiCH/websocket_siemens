// =========================================================================
// recetaRuntime.ts
// Lo que pasa en la Vista Previa con las recetas: qué campos hay en pantalla,
// cuál es la receta actual, y guardar un data record con lo que muestran.
//
// QUIÉN HABLA CON QUIÉN
//
//   Los «Campo de receta» y el botón «Nueva receta» son widgets sueltos: no
//   se conocen. Lo que los une es este módulo.
//
//   * Cada campo, al dibujarse, se APUNTA aquí: «soy el elemento 12 de la
//     receta 5 y este es mi valor». Al desaparecer de pantalla, se borra.
//   * El botón pregunta por los campos de SU receta y guarda sus valores.
//
//   Se hace por registro y no recorriendo el diseño porque lo que cuenta es
//   lo que hay EN PANTALLA: los campos de otra sección, o de una pantalla
//   embebida que no está abierta, no se están viendo y no deben guardarse.
//
// QUÉ SE GUARDA
//
//   Lo que muestran los campos BLANCOS (lectura y escritura): lo que el
//   operario escribió, o el valor en vivo si no ha tocado ese campo. Los
//   negros (sólo lectura) no se guardan. Un campo vacío no guarda nada.
//
//   Guardar y enviar al PLC son dos cosas distintas, y quien sabe enviar es
//   el propio campo (CampoReceta.tsx): conoce su tag, su tipo y sus límites.
//   «Nueva receta» solo guarda. «Guardar receta» guarda y, además, pide a
//   cada campo con un valor escrito y sin enviar (los de borde ámbar) que lo
//   envíe — para no tener que ir dando Enter campo por campo.
//
// CARGAR ES EL CAMINO DE VUELTA
//
//   «Cargar receta» lee un data record, pone cada valor en el campo blanco
//   de su elemento y lo envía al PLC, uno por uno. Lo que no se pudo enviar
//   se queda escrito en el campo, marcado en ámbar, y se dice por qué.
//
// LO ESCRITO SE QUEDA EN EL CAMPO
//
//   Un valor tecleado y todavía no enviado al PLC es un «borrador». Vive
//   aquí y no en el campo para que sobreviva a cambiar de sección, y para
//   que dos campos del mismo elemento enseñen lo mismo. Se pierde al
//   recargar la página: lo que no se guardó, no está guardado.
//
//   Va a las mismas tablas y por el mismo CRUD que la vista de Recetas
//   (`receta_registros`, `receta_valores`), así que lo creado aquí se ve
//   allí tal cual, en Data records.
// =========================================================================
import { useEffect, useState } from 'react';
import { actualizarCrud, borrarCrud, crearCrud, listarCrud } from './crudApi';
import {
  aElemento,
  aRegistro,
  aValorCelda,
  cargarRecetas,
  crearValor,
  nuevoRegistroDb,
  valorADb,
} from './recetasApi';
import { baseDeRecetas, EVENTO_RECETAS_EDITADAS } from './recetaEnlace';

// ─── Los campos que hay en pantalla ──────────────────────────────

interface CampoEnPantalla {
  recetaId: number;
  elementoId: number;
  /** ¿Es un campo blanco (lectura y escritura)? Solo esos se guardan. */
  escritura: boolean;
  /** El valor que muestra AHORA. `null`/`undefined` = sin valor («—»). */
  leer: () => unknown;
  /** Cómo se llama su elemento, para nombrarlo en los avisos. */
  nombre: () => string;
  /** ¿Tiene un valor escrito y todavía no enviado al PLC (borde ámbar)? */
  pendiente: () => boolean;
  /**
   * Envía al PLC su valor pendiente, igual que al pulsar Enter en él.
   * Devuelve `''` si se envió, o el motivo por el que no.
   */
  enviar: () => Promise<string>;
  /**
   * Pone en el campo un valor venido de una receta, SIN enviarlo: queda como
   * valor escrito (ámbar) salvo que el PLC ya tenga justo ese valor.
   */
  cargar: (texto: string) => void;
}

const campos = new Map<symbol, CampoEnPantalla>();
/** Entró o salió un campo de la pantalla (lo escucha «Aplicar todos»). */
const EVENTO_CAMPOS = 'hmi:receta-campos';

function avisarCampos(): void {
  try {
    window.dispatchEvent(new CustomEvent(EVENTO_CAMPOS));
  } catch {
    /* sin `window` (pruebas) */
  }
}

/** Apunta un campo. Devuelve cómo borrarlo (para el `useEffect`). */
export function apuntarCampo(campo: CampoEnPantalla): () => void {
  const llave = Symbol('campo-receta');
  campos.set(llave, campo);
  avisarCampos();
  return () => {
    campos.delete(llave);
    avisarCampos();
  };
}

/**
 * Los valores que se guardarían: los de los campos BLANCOS de esa receta
 * que están en pantalla.
 *
 * `elementoId -> valor`. Dos campos del mismo elemento comparten borrador y
 * tag, así que da igual cuál gane.
 */
export function valoresEnPantalla(recetaId: number): Map<number, unknown> {
  const r = new Map<number, unknown>();
  for (const c of campos.values()) {
    if (c.recetaId !== recetaId || !c.escritura) continue;
    const v = c.leer();
    if (v === null || v === undefined || v === '') continue;
    r.set(c.elementoId, v);
  }
  return r;
}

/** Cuántos campos BLANCOS de esa receta hay en pantalla, con valor o sin él. */
export function camposEnPantalla(recetaId: number): number {
  const vistos = new Set<number>();
  for (const c of campos.values()) {
    if (c.recetaId === recetaId && c.escritura) vistos.add(c.elementoId);
  }
  return vistos.size;
}

/** Los campos blancos de la receta en pantalla, uno por elemento. */
function camposBlancos(recetaId: number): CampoEnPantalla[] {
  const porElemento = new Map<number, CampoEnPantalla>();
  for (const c of campos.values()) {
    if (c.recetaId !== recetaId || !c.escritura) continue;
    if (!porElemento.has(c.elementoId)) porElemento.set(c.elementoId, c);
  }
  return [...porElemento.values()];
}

/** Los campos blancos de la receta con algo escrito y sin enviar, sin repetir elemento. */
function camposPendientes(recetaId: number): CampoEnPantalla[] {
  return camposBlancos(recetaId).filter((c) => c.pendiente());
}

/** Cuántos valores se enviarían al PLC ahora mismo (los de borde ámbar). */
export function pendientesDeEnviar(recetaId: number): number {
  return camposPendientes(recetaId).length;
}

export interface ResultadoEnvio {
  enviados: number;
  /** Los que NO se enviaron, con el porqué. Siguen marcados en ámbar. */
  fallos: { nombre: string; motivo: string }[];
}

/**
 * Envía al PLC, UNO POR UNO, los valores escritos y sin enviar.
 *
 * Uno por uno y no en bloque a propósito: en bloque el servidor es «todo o
 * nada», y un solo campo sin tag o sin permiso de escritura dejaría sin
 * enviar a todos los demás. Así pasa lo que puede pasar, y lo que no, se
 * dice con su motivo.
 */
export async function enviarPendientes(
  recetaId: number,
  /** Si se pasa, solo estos elementos (lo usa «Cargar»: envía lo que cargó). */
  soloElementos?: Set<number>
): Promise<ResultadoEnvio> {
  const r: ResultadoEnvio = { enviados: 0, fallos: [] };
  for (const c of camposPendientes(recetaId)) {
    if (soloElementos && !soloElementos.has(c.elementoId)) continue;
    let motivo: string;
    try {
      motivo = await c.enviar();
    } catch (e: any) {
      motivo = e?.message ?? 'no se pudo enviar';
    }
    if (motivo) r.fallos.push({ nombre: c.nombre() || 'elemento', motivo });
    else r.enviados += 1;
  }
  return r;
}

// ─── Lo escrito y no enviado (borradores) ────────────────────────

const borradores = new Map<string, string>();
/** Recetas con algo escrito en sus campos que todavía no se ha guardado. */
const conCambios = new Set<number>();
const EVENTO_CAMBIOS = 'hmi:receta-cambios';

/** Marca (o desmarca) una receta como «con cambios sin guardar», y avisa. */
function marcarCambios(recetaId: number, hay: boolean): void {
  if (conCambios.has(recetaId) === hay) return;
  if (hay) conCambios.add(recetaId);
  else conCambios.delete(recetaId);
  try {
    window.dispatchEvent(new CustomEvent(EVENTO_CAMBIOS));
  } catch {
    /* sin `window` (pruebas) */
  }
}
const EVENTO_BORRADOR = 'hmi:receta-borrador';

function avisarBorrador(): void {
  try {
    window.dispatchEvent(new CustomEvent(EVENTO_BORRADOR));
  } catch {
    /* sin `window` (pruebas) */
  }
}

/** La llave del borrador de un elemento de receta. */
export const llaveBorrador = (recetaId: number, elementoId: number): string =>
  `${recetaId}:${elementoId}`;

export function borradorDe(llave: string): string | undefined {
  return borradores.get(llave);
}

/**
 * El operario escribió un valor en un campo.
 *
 * `recetaId` marca esa receta como «con cambios sin guardar». Un campo que
 * no es de ninguna receta pasa 0 y no marca nada.
 */
export function fijarBorrador(llave: string, texto: string, recetaId = 0): void {
  if (borradores.get(llave) === texto) return;
  borradores.set(llave, texto);
  if (recetaId) marcarCambios(recetaId, true);
  avisarBorrador();
}

/** El valor ya está en el PLC (o se descartó): el campo vuelve a lo vivo. */
export function quitarBorrador(llave: string): void {
  if (borradores.delete(llave)) avisarBorrador();
}

/**
 * Se envió al PLC un valor escrito a mano.
 *
 * El borrador desaparece —el PLC ya lo tiene—, pero para la RECETA sigue
 * siendo un cambio sin guardar: el data record aún tiene el valor de antes.
 */
export function enviadoAlPlc(llave: string, recetaId = 0): void {
  if (recetaId) marcarCambios(recetaId, true);
  quitarBorrador(llave);
}

/**
 * Deja la marca «cambios sin guardar» como estaba antes de una edición.
 * La usa Escape en el campo: deshacer lo tecleado no es un cambio.
 */
export function restaurarCambios(recetaId: number, hay: boolean): void {
  if (recetaId) marcarCambios(recetaId, hay);
}

/**
 * Cuántos campos de la receta están en ámbar AHORA en la pantalla, vivo:
 * se recalcula al escribir, al enviar y cuando entra o sale un campo.
 */
export function usePendientesDeEnviar(recetaId: number | null): number {
  const [n, setN] = useState(0);
  useEffect(() => {
    const contar = () => setN(recetaId ? pendientesDeEnviar(recetaId) : 0);
    contar();
    window.addEventListener(EVENTO_BORRADOR, contar);
    window.addEventListener(EVENTO_CAMPOS, contar);
    return () => {
      window.removeEventListener(EVENTO_BORRADOR, contar);
      window.removeEventListener(EVENTO_CAMPOS, contar);
    };
  }, [recetaId]);
  return n;
}

/** ¿Se cambió algún campo de esa receta desde la última vez que se guardó? */
export function hayCambiosSinGuardar(recetaId: number): boolean {
  return conCambios.has(recetaId);
}

/** El borrador de una llave, vivo: vuelve a dibujar cuando cambia. */
export function useBorrador(llave: string): string | undefined {
  const [, setRev] = useState(0);
  useEffect(() => {
    const subir = () => setRev((n) => n + 1);
    window.addEventListener(EVENTO_BORRADOR, subir);
    return () => window.removeEventListener(EVENTO_BORRADOR, subir);
  }, []);
  return borradores.get(llave);
}

// ─── Límites ─────────────────────────────────────────────────────

const aNumero = (t: string | null | undefined): number | null => {
  const s = String(t ?? '').trim().replace(',', '.');
  if (s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

/**
 * ¿El valor se sale de los límites del elemento?
 *
 * Devuelve el motivo, o `''` si vale. Un mínimo o máximo vacío es «sin
 * límite por ese lado», que es como se lee una celda en blanco.
 */
export function fueraDeLimite(valor: number, minimo: string, maximo: string): string {
  const min = aNumero(minimo);
  const max = aNumero(maximo);
  if (min !== null && valor < min) return `${valor} es menor que el mínimo (${min})`;
  if (max !== null && valor > max) return `${valor} supera el máximo (${max})`;
  return '';
}

// ─── Datos de la receta (¿comprueba límites?) ────────────────────

export interface MetaReceta {
  nombre: string;
  comprobarLimites: boolean;
  /** Tope de data records. 0 = sin tope. */
  maxRegistros: number;
}

const metas = new Map<number, { cuando: number; meta: MetaReceta }>();
const VIGENCIA_META_MS = 15000;

/**
 * Lo que hace falta saber de la receta para validar.
 *
 * Si no se puede leer, se devuelve «comprueba límites»: ante la duda se
 * valida, que es el lado seguro cuando el valor acaba en una máquina.
 */
export async function metaDeReceta(recetaId: number, fresca = false): Promise<MetaReceta> {
  const previa = metas.get(recetaId);
  if (!fresca && previa && Date.now() - previa.cuando < VIGENCIA_META_MS) {
    return previa.meta;
  }
  try {
    const r = (await cargarRecetas(baseDeRecetas())).find((x) => x.id === recetaId);
    if (!r) throw new Error('La receta ya no existe.');
    const meta: MetaReceta = {
      nombre: r.name || r.displayName || `Receta ${r.number}`,
      comprobarLimites: r.checkLimits,
      maxRegistros: r.type === 'Limited' ? Number(r.maxRecords) || 0 : 0,
    };
    metas.set(recetaId, { cuando: Date.now(), meta });
    return meta;
  } catch (e) {
    if (fresca) throw e;
    return previa?.meta ?? { nombre: '', comprobarLimites: true, maxRegistros: 0 };
  }
}

// ─── La receta actual ────────────────────────────────────────────
//
// El último data record creado o escrito desde esta pantalla, por receta.
// Se recuerda en ESTE equipo: es lo que el operario tiene delante, no
// configuración compartida.

export interface RecetaActual {
  registroId: number;
  nombre: string;
}

const CLAVE_ACTUAL = 'hmi.recetas.actual';
const EVENTO_ACTUAL = 'hmi:receta-actual';

function leerActuales(): Record<string, RecetaActual> {
  try {
    const b = JSON.parse(localStorage.getItem(CLAVE_ACTUAL) ?? '{}');
    return b && typeof b === 'object' ? b : {};
  } catch {
    return {};
  }
}

export function recetaActual(recetaId: number): RecetaActual | null {
  const a = leerActuales()[String(recetaId)];
  return a && typeof a.nombre === 'string' ? a : null;
}

export function fijarRecetaActual(recetaId: number, actual: RecetaActual): void {
  try {
    const todas = leerActuales();
    todas[String(recetaId)] = actual;
    localStorage.setItem(CLAVE_ACTUAL, JSON.stringify(todas));
  } catch {
    /* sin storage: se verá hasta recargar */
  }
  try {
    window.dispatchEvent(new CustomEvent(EVENTO_ACTUAL));
  } catch {
    /* sin `window` (pruebas) */
  }
}

/** Ya no hay receta actual (se eliminó la que lo era). */
export function quitarRecetaActual(recetaId: number): void {
  try {
    const todas = leerActuales();
    delete todas[String(recetaId)];
    localStorage.setItem(CLAVE_ACTUAL, JSON.stringify(todas));
  } catch {
    /* sin storage */
  }
  try {
    window.dispatchEvent(new CustomEvent(EVENTO_ACTUAL));
  } catch {
    /* sin `window` (pruebas) */
  }
}

export function useRecetaActual(recetaId: number | null): RecetaActual | null {
  const [, setRev] = useState(0);
  useEffect(() => {
    const subir = () => setRev((n) => n + 1);
    window.addEventListener(EVENTO_ACTUAL, subir);
    return () => window.removeEventListener(EVENTO_ACTUAL, subir);
  }, []);
  return recetaId ? recetaActual(recetaId) : null;
}

/**
 * Lo que enseña el bloque «Receta actual»: cuál es y si le faltan cambios
 * por guardar. Vivo: vuelve a dibujar cuando cambia cualquiera de las dos.
 */
export function useEstadoReceta(
  recetaId: number | null
): { actual: RecetaActual | null; sinGuardar: boolean } {
  const [, setRev] = useState(0);
  useEffect(() => {
    const subir = () => setRev((n) => n + 1);
    window.addEventListener(EVENTO_ACTUAL, subir);
    window.addEventListener(EVENTO_CAMBIOS, subir);
    return () => {
      window.removeEventListener(EVENTO_ACTUAL, subir);
      window.removeEventListener(EVENTO_CAMBIOS, subir);
    };
  }, []);
  if (!recetaId) return { actual: null, sinGuardar: false };
  const actual = recetaActual(recetaId);
  return { actual, sinGuardar: !!actual && conCambios.has(recetaId) };
}

// ─── Guardar un data record ──────────────────────────────────────

export interface RegistroExistente {
  id: number;
  nombre: string;
  numero: number;
  /** Cuándo se guardó por última vez, tal como lo da la base. Puede faltar. */
  fecha?: string;
}

/** Los data records que ya tiene la receta (para la ventana). */
export async function listarRegistros(recetaId: number): Promise<RegistroExistente[]> {
  const { filas } = await listarCrud(
    'receta_registros',
    { filtros: { receta_id: recetaId }, orden: 'numero', descendente: false, limite: 500 },
    baseDeRecetas()
  );
  return filas.map((f) => {
    const r = aRegistro(f);
    const fecha = f.actualizado_en ?? f.creado_en;
    return {
      id: r.id,
      nombre: r.name,
      numero: r.number,
      fecha: fecha ? String(fecha) : undefined,
    };
  });
}

/** Cómo se guarda un valor leído del PLC: igual que una celda tecleada. */
export function valorATexto(v: unknown): string {
  if (typeof v === 'boolean') return v ? '1' : '0';
  if (typeof v === 'number') return String(v);
  // Lo tecleado: «3,5» se guarda como el número 3.5, no como texto.
  if (typeof v === 'string') {
    const t = v.trim();
    const n = t.replace(',', '.');
    return n !== '' && Number.isFinite(Number(n)) ? n : t;
  }
  return JSON.stringify(v);
}

const mismoNombre = (a: string, b: string) =>
  a.trim().toLowerCase() === b.trim().toLowerCase();

export interface ResultadoGuardar {
  ok: boolean;
  /** Por qué no se guardó. Con `avisos`, es una lista de límites. */
  error?: string;
  avisos?: string[];
  registroId?: number;
  nombre?: string;
  creado?: boolean;
  guardados?: number;
  /** Solo si se pidió enviar al PLC: qué pasó con cada valor pendiente. */
  envio?: ResultadoEnvio;
}

/**
 * Guarda en un data record los valores de los campos blancos en pantalla.
 *
 *   * `'crear'`  — uno NUEVO llamado `nombre`. Si ya hay uno con ese nombre
 *     no se crea: pisar una receta por escribir un nombre repetido es
 *     perderla sin querer. Para eso está `'actual'`.
 *   * `'actual'` — escribe encima de la receta actual. `nombre` se ignora.
 *
 * EL ORDEN IMPORTA: primero se comprueba TODO y solo después se toca la
 * base. Si un valor se sale de sus límites no puede quedar un data record a
 * medio llenar.
 *
 * Con `enviarAlPlc`, DESPUÉS de guardar se envían al PLC los valores
 * escritos y sin enviar. Después y no antes: la receta se guarda siempre,
 * falle o no el envío. Lo que no se pudo enviar vuelve en `envio.fallos`.
 */
export async function guardarDataRecord(
  recetaId: number,
  nombre: string,
  modo: 'crear' | 'actual' = 'crear',
  enviarAlPlc = false
): Promise<ResultadoGuardar> {
  const limpio = nombre.trim();
  const actual = modo === 'actual' ? recetaActual(recetaId) : null;
  if (modo === 'actual' && !actual) {
    return { ok: false, error: 'No hay una receta actual que modificar. Guárdala como nueva.' };
  }
  if (modo === 'crear' && !limpio) {
    return { ok: false, error: 'Ponle un nombre a la receta.' };
  }

  const db = baseDeRecetas();
  const enPantalla = valoresEnPantalla(recetaId);

  let meta: MetaReceta;
  let elementos: ReturnType<typeof aElemento>[];
  let registros: RegistroExistente[];
  try {
    const [m, e, r] = await Promise.all([
      metaDeReceta(recetaId, true),
      listarCrud(
        'receta_elementos',
        { filtros: { receta_id: recetaId }, orden: 'orden', descendente: false, limite: 500 },
        db
      ),
      listarRegistros(recetaId),
    ]);
    meta = m;
    elementos = e.filas.map(aElemento);
    registros = r;
  } catch (e: any) {
    return {
      ok: false,
      error: `No se pudo leer la receta: ${e?.message ?? 'la base de datos no responde'}.`,
    };
  }

  // Solo los campos cuyo elemento sigue existiendo en la receta.
  const aGuardar = elementos
    .filter((e) => enPantalla.has(e.id))
    .map((e) => ({ elemento: e, valor: enPantalla.get(e.id) }));

  if (aGuardar.length === 0) {
    return {
      ok: false,
      error:
        camposEnPantalla(recetaId) === 0
          ? 'En esta pantalla no hay ningún campo blanco (lectura y escritura) enlazado a un elemento de esta receta.'
          : 'Los campos blancos de esta receta están vacíos: escribe algún valor antes de guardar.',
    };
  }

  // ── Límites ──
  if (meta.comprobarLimites) {
    const avisos: string[] = [];
    for (const { elemento, valor } of aGuardar) {
      const n =
        typeof valor === 'boolean'
          ? valor ? 1 : 0
          : Number(String(valor).trim().replace(',', '.'));
      if (!Number.isFinite(n)) continue; // un texto no tiene mínimo ni máximo
      const motivo = fueraDeLimite(n, elemento.minValue, elemento.maxValue);
      if (motivo) avisos.push(`${elemento.name || 'elemento'}: ${motivo}`);
    }
    if (avisos.length > 0) {
      return { ok: false, error: 'Hay valores fuera de sus límites.', avisos };
    }
  }

  // ── A la base ──
  try {
    let existente: RegistroExistente | undefined;
    if (modo === 'actual') {
      existente = registros.find((r) => r.id === actual!.registroId);
      if (!existente) {
        return {
          ok: false,
          error: `La receta actual «${actual!.nombre}» ya no existe en la base. Guárdala como nueva.`,
        };
      }
    } else if (registros.some((r) => mismoNombre(r.nombre, limpio))) {
      return {
        ok: false,
        error: `Ya existe una receta llamada «${limpio}». Usa otro nombre, o «Guardar receta» → «Modificar receta actual» para escribir encima.`,
      };
    }
    let registroId: number;
    const celdas = new Map<number, number>(); // elementoId -> receta_valores.id

    if (existente) {
      registroId = existente.id;
      const { filas } = await listarCrud(
        'receta_valores',
        { filtros: { receta_registro_id: registroId }, limite: 500 },
        db
      );
      for (const f of filas) celdas.set(Number(f.receta_elemento_id), Number(f.id));
    } else {
      if (meta.maxRegistros > 0 && registros.length >= meta.maxRegistros) {
        return {
          ok: false,
          error: `La receta ya tiene el máximo de data records (${meta.maxRegistros}).`,
        };
      }
      const numero =
        registros.length === 0 ? 1 : Math.max(...registros.map((r) => r.numero)) + 1;
      const { id } = await crearCrud(
        'receta_registros',
        { ...nuevoRegistroDb(recetaId, numero), nombre: limpio, nombre_visible: limpio },
        db
      );
      registroId = id;
    }

    for (const { elemento, valor } of aGuardar) {
      const texto = valorATexto(valor);
      const celda = celdas.get(elemento.id);
      if (celda) await actualizarCrud('receta_valores', celda, valorADb(texto), db);
      else await crearValor(registroId, elemento.id, texto, db);
    }

    const nombreFinal = existente ? existente.nombre : limpio;
    fijarRecetaActual(recetaId, { registroId, nombre: nombreFinal });
    // Lo que había en los campos ya está en la base: no quedan cambios.
    marcarCambios(recetaId, false);

    // Ahora sí, al PLC. Lo que se envía es lo mismo que se acaba de guardar,
    // así que enviarlo no deja «cambios sin guardar».
    let envio: ResultadoEnvio | undefined;
    if (enviarAlPlc) {
      envio = await enviarPendientes(recetaId);
      marcarCambios(recetaId, false);
    }
    try {
      window.dispatchEvent(new CustomEvent(EVENTO_RECETAS_EDITADAS));
    } catch {
      /* sin `window` (pruebas) */
    }
    return {
      ok: true,
      registroId,
      nombre: nombreFinal,
      creado: !existente,
      guardados: aGuardar.length,
      envio,
    };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? 'No se pudo guardar el data record.' };
  }
}

// ─── Cargar un data record ───────────────────────────────────────

export interface ResultadoCargar {
  ok: boolean;
  error?: string;
  nombre?: string;
  /** Campos que recibieron valor. */
  cargados?: number;
  /** Qué pasó al enviarlos al PLC. */
  envio?: ResultadoEnvio;
}

/**
 * Carga un data record: pone sus valores en los campos blancos que hay en
 * pantalla y los envía al PLC, uno por uno.
 *
 *   * Solo los campos de ESTA pantalla: un elemento sin campo se ignora.
 *   * Un campo cuyo elemento no tiene valor en la receta se deja como está.
 *   * Un valor que el PLC ya tiene no se vuelve a enviar.
 *   * Lo que no se pudo enviar se queda en su campo, en ámbar, con su motivo
 *     en `envio.fallos`.
 *
 * No se carga encima de cambios sin guardar: se perderían sin avisar.
 */
export async function cargarDataRecord(
  recetaId: number,
  registro: RegistroExistente
): Promise<ResultadoCargar> {
  const actual = recetaActual(recetaId);
  if (actual && hayCambiosSinGuardar(recetaId)) {
    return {
      ok: false,
      error: `Hay cambios sin guardar en «${actual.nombre}». Guárdalos primero con «Guardar receta».`,
    };
  }

  const blancos = camposBlancos(recetaId);
  if (blancos.length === 0) {
    return {
      ok: false,
      error:
        'En esta pantalla no hay ningún campo blanco (lectura y escritura) enlazado a un elemento de esta receta.',
    };
  }

  const valores = new Map<number, string>();
  try {
    const { filas } = await listarCrud(
      'receta_valores',
      { filtros: { receta_registro_id: registro.id }, limite: 500 },
      baseDeRecetas()
    );
    for (const f of filas) {
      const texto = aValorCelda(f);
      if (texto !== '') valores.set(Number(f.receta_elemento_id), texto);
    }
  } catch (e: any) {
    return {
      ok: false,
      error: `No se pudo leer la receta: ${e?.message ?? 'la base de datos no responde'}.`,
    };
  }

  const cargados = new Set<number>();
  for (const c of blancos) {
    const texto = valores.get(c.elementoId);
    if (texto === undefined) continue; // sin valor en esta receta: se deja como está
    c.cargar(texto);
    cargados.add(c.elementoId);
  }
  if (cargados.size === 0) {
    return {
      ok: false,
      error: `«${registro.nombre}» no tiene valores para ninguno de los campos de esta pantalla.`,
    };
  }

  fijarRecetaActual(recetaId, { registroId: registro.id, nombre: registro.nombre });

  // Al PLC, solo lo que se acaba de cargar.
  const envio = await enviarPendientes(recetaId, cargados);

  // Los campos tienen exactamente lo que está guardado: no hay cambios.
  marcarCambios(recetaId, false);

  return { ok: true, nombre: registro.nombre, cargados: cargados.size, envio };
}

// ─── Eliminar un data record ─────────────────────────────────────

/**
 * Elimina un data record con todos sus valores (los valores se los lleva
 * el servidor al borrar el registro).
 *
 * No toca el PLC ni los campos: lo que hay en pantalla se queda como está.
 * Si era la receta actual deja de haberla — y con ella los «cambios sin
 * guardar», que ya no tienen dónde guardarse.
 */
export async function eliminarDataRecord(
  recetaId: number,
  registro: RegistroExistente
): Promise<{ ok: boolean; error?: string; eraActual?: boolean }> {
  try {
    await borrarCrud('receta_registros', registro.id, baseDeRecetas());
  } catch (e: any) {
    return { ok: false, error: e?.message ?? 'No se pudo eliminar la receta.' };
  }
  const eraActual = recetaActual(recetaId)?.registroId === registro.id;
  if (eraActual) {
    quitarRecetaActual(recetaId);
    marcarCambios(recetaId, false);
  }
  try {
    window.dispatchEvent(new CustomEvent(EVENTO_RECETAS_EDITADAS));
  } catch {
    /* sin `window` (pruebas) */
  }
  return { ok: true, eraActual };
}

// ─── Cuántas recetas hay guardadas ───────────────────────────────

/** Cada cuánto se vuelve a contar, por si alguien creó o borró desde otro equipo. */
const REFRESCO_CONTEO_MS = 15000;

/**
 * Cuántos data records tiene la receta. `null` = todavía no se sabe, o la
 * base no responde: quien lo pinta enseña «—», no un cero de mentira.
 *
 * Se vuelve a contar al crear, guardar o eliminar desde esta pantalla (todas
 * avisan con `EVENTO_RECETAS_EDITADAS`) y, además, cada pocos segundos.
 */
export function useConteoRecetas(recetaId: number | null): number | null {
  const [conteo, setConteo] = useState<number | null>(null);
  useEffect(() => {
    if (!recetaId) {
      setConteo(null);
      return;
    }
    let vivo = true;
    const contar = () => {
      listarRegistros(recetaId)
        .then((l) => vivo && setConteo(l.length))
        .catch(() => vivo && setConteo(null));
    };
    contar();
    const reloj = window.setInterval(contar, REFRESCO_CONTEO_MS);
    window.addEventListener(EVENTO_RECETAS_EDITADAS, contar);
    return () => {
      vivo = false;
      window.clearInterval(reloj);
      window.removeEventListener(EVENTO_RECETAS_EDITADAS, contar);
    };
  }, [recetaId]);
  return conteo;
}
