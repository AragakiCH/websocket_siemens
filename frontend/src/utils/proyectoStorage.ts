// =========================================================================
// proyectoStorage.ts
// Los PROYECTOS del HMI: el nivel que agrupa pantallas.
//
// EL LIO DE NOMBRES, DICHO DE FRENTE
// Cuando solo habia un nivel, a cada PANTALLA se la llamaba "proyecto": de
// ahi `projectId`, `hmi.design.<projectId>` y el evento `project.updated`.
// Al aparecer un nivel de verdad por encima se decidio no renombrar aquello
// —esta escrito en el lock, en el WebSocket y en la cache de cada
// navegador— y poner la frontera donde se lee, que es la API:
//
//   /pantallas   -> una pantalla   (designStorage.ts, `projectId`)
//   /proyectos   -> un PROYECTO    (este fichero,     `proyectoId`)
//
// QUE ES UN PROYECTO
// Un HMI distinto: sus pantallas, su numeracion empezando por 1, y nada que
// ver con las del de al lado. Flujos, alarmas y recetas NO se separan: no
// cuelgan del diseno sino de los tags del PLC.
//
// UN PROYECTO NUNCA ESTA VACIO
// Al crearlo, el servidor crea tambien su primera pantalla, y no deja borrar
// la ultima que le quede. Un proyecto sin pantallas seria una pestana en la
// que no se puede ni soltar un widget.
// =========================================================================
import { fetchAuth } from '../services/authApi';
import { descargarJson, hoy, leerJsonDeFichero } from './descargas';
import { RealPLCService } from '../services/RealPLCService';

/** Proyecto que el backend garantiza que existe. No se puede borrar. */
export const PROYECTO_HMI_POR_DEFECTO = 'principal';

export interface ProyectoHmi {
  proyecto_id: string;
  nombre: string;
  /** Cuando se creo. Es lo que da el orden del selector. */
  creado_en?: string;
  actualizado_en: string;
  actualizado_por: string;
  /** Cuantas pantallas tiene. Lo calcula el servidor al listar. */
  num_pantallas: number;
}

// ===================================================================== //
// Preferencia local: en que proyecto estaba
// ===================================================================== //
//
// Es una preferencia de ESTE navegador, no configuracion compartida: dos
// personas pueden estar trabajando en proyectos distintos de la misma
// instalacion, y al recargar cada una debe volver al suyo. Por eso no vive
// en el servidor.
const PROYECTO_KEY = 'hmi.proyecto.ultimo';

export function getUltimoProyecto(): string {
  try {
    return localStorage.getItem(PROYECTO_KEY) ?? PROYECTO_HMI_POR_DEFECTO;
  } catch {
    return PROYECTO_HMI_POR_DEFECTO;
  }
}

export function setUltimoProyecto(proyectoId: string): void {
  try {
    if (proyectoId) localStorage.setItem(PROYECTO_KEY, proyectoId);
  } catch {
    /* sin storage: se abrira el proyecto por defecto */
  }
}

/**
 * Convierte un nombre escrito por una persona en un `proyecto_id` valido.
 *
 * El backend valida contra `^[A-Za-z0-9_-]{1,64}$`, y ademas este id se
 * antepone al de cada pantalla del proyecto, asi que se recorta a 32: un id
 * larguisimo dejaria sin sitio al nombre de la pantalla.
 */
export function idDesdeNombreProyecto(nombre: string): string {
  const base = (nombre || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')   // quita acentos
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 32);
  return base || `proyecto_${Date.now().toString(36)}`;
}

// ===================================================================== //
// Servidor
// ===================================================================== //
/** Todos los proyectos, ordenados como los pinta el selector. */
export async function listarProyectosHmi(): Promise<ProyectoHmi[]> {
  const d = await fetchAuth('/proyectos');
  return d.proyectos ?? [];
}

/**
 * Crea un proyecto y su primera pantalla, en una sola llamada.
 *
 * Si el id derivado del nombre ya existe se le anade un sufijo en vez de
 * fallar: llamar "Linea 2" a dos proyectos es perfectamente razonable, y que
 * el segundo rebote con "ya existe" seria hacerle pagar al usuario un detalle
 * de implementacion que no eligio.
 */
export async function crearProyectoHmi(
  nombre: string,
  pantallaNombre = 'Pantalla 1'
): Promise<ProyectoHmi & { pantalla?: { project_id: string; nombre: string } }> {
  const base = idDesdeNombreProyecto(nombre);
  let intento = base;
  for (let i = 2; i <= 50; i++) {
    try {
      const d = await fetchAuth('/proyectos', {
        method: 'POST',
        body: JSON.stringify({
          proyecto_id: intento,
          nombre,
          pantalla_nombre: pantallaNombre,
        }),
      });
      return {
        proyecto_id: d.proyecto_id,
        nombre: d.nombre,
        creado_en: d.creado_en,
        actualizado_en: d.actualizado_en,
        actualizado_por: d.actualizado_por,
        num_pantallas: d.num_pantallas ?? 1,
        pantalla: d.pantalla,
      };
    } catch (e: any) {
      // 409 = id repetido. Cualquier otro error (403, 503...) se propaga:
      // reintentar con otro nombre no lo arreglaria y solo haria 50 llamadas.
      if (e?.status !== 409) throw e;
      intento = `${base}_${i}`.slice(0, 32);
    }
  }
  throw new Error('No se pudo encontrar un identificador libre para el proyecto.');
}

/** Cambia la etiqueta visible. El `proyecto_id` no cambia nunca. */
export async function renombrarProyectoHmi(
  proyectoId: string,
  nombre: string
): Promise<ProyectoHmi> {
  const d = await fetchAuth(`/proyectos/${encodeURIComponent(proyectoId)}`, {
    method: 'PATCH',
    body: JSON.stringify({ nombre }),
  });
  return d as ProyectoHmi;
}

/**
 * Borra un proyecto Y TODAS SUS PANTALLAS. Exige rol Supervisor.
 *
 * Devuelve los ids de las pantallas que se llevo por delante, para poder
 * limpiar sus caches locales: si no, reaparecerian en el siguiente arranque
 * como fantasmas de un diseno que ya no existe en ningun servidor.
 */
export async function borrarProyectoHmi(proyectoId: string): Promise<string[]> {
  const d = await fetchAuth(`/proyectos/${encodeURIComponent(proyectoId)}`, {
    method: 'DELETE',
  });
  const borradas: string[] = d.pantallas_borradas ?? [];
  try {
    localStorage.removeItem(`hmi.design.ultima.${proyectoId}`);
  } catch {
    /* la preferencia local es prescindible */
  }
  return borradas;
}

// ===================================================================== //
// Exportar / importar
// ===================================================================== //
//
// QUE VIAJA EN EL FICHERO
// El proyecto, sus pantallas con sus widgets y la DEFINICION de los widgets
// personalizados que use. Sin lo ultimo, abrir el proyecto en otro equipo
// dejaria cajas vacias donde habia un widget, sin ningun error que lo
// explicara.
//
// SI viajan TODAS las variables INTERNAS del equipo (no solo las enlazadas:
// quien disena alli las va a necesitar), y los PLC con su catalogo de
// variables y su lista de escritura con limites. Los VALORES del PLC no
// viajan: existen porque existe el automata. Y viaja la seleccion de
// variables de Configuracion, que vive en este navegador (localStorage) y
// por eso la pone y la lee la vista, no el servidor.
//
// NO viajan alarmas, recetas, flujos ni conexiones a base de datos: son de la
// instalacion, no del diseno. Para mover una instalacion entera esta la copia
// de seguridad de Configuracion.

export interface ProyectoExportado {
  formato: string;
  version: number;
  exportado_en?: string;
  exportado_por?: string;
  proyecto: { proyecto_id: string; nombre: string };
  pantallas: unknown[];
  widgets_personalizados: unknown[];
  /**
   * Las variables INTERNAS a las que estan enlazados los widgets.
   *
   * Opcional a proposito: un fichero exportado antes de que existieran no lo
   * trae, y tiene que seguir importandose igual.
   */
  variables_internas?: unknown[];
  /** PLC dados de alta (sin contrasenas), con `tags` y `escritura`. */
  plcs?: unknown[];
  /** Carpetas de la barra de pestanas y en cual cae cada pantalla. */
  grupos?: { grupos?: unknown[]; asignaciones?: Record<string, string> };
  /**
   * Seleccion de variables de Configuracion (`<plc>|<tag>` -> marcada).
   * La pone la vista al descargar y la aplica al importar: el servidor no la
   * conoce, vive en el navegador.
   */
  seleccion_variables?: Record<string, boolean>;
}

/** Un PLC del fichero que no se pudo dar de alta, y por que. */
export interface PlcOmitido {
  plc_id: string;
  motivo: string;
}

/** Una variable del fichero cuyo tipo NO coincide con el de aqui. */
export interface ConflictoVariable {
  nombre: string;
  tipo_aqui?: string;
  tipo_del_fichero?: string;
  error?: string;
}

export interface ResultadoImportacion {
  proyecto_id: string;
  nombre: string;
  num_pantallas: number;
  /** Pantallas que cambiaron de id porque ya habia una con el suyo. */
  renombradas: Record<string, string>;
  widgets_importados: string[];
  widgets_ya_existentes: string[];
  widgets_con_error: string[];
  /** Variables internas que no habia aqui y se han creado. */
  variables_importadas: string[];
  /** Las que ya existian: se respeta la de este equipo, no se pisa. */
  variables_ya_existentes: string[];
  /**
   * Las que existen aqui con OTRO tipo.
   *
   * Hay que ensenarlas. El widget se enlaza igual —la clave es el nombre— y
   * mostrara algo sin sentido sin dar ningun error: una consigna que alli era
   * un decimal y aqui es un si/no. Es el unico caso de la importacion en que
   * callarse hace dano.
   */
  variables_en_conflicto: ConflictoVariable[];
  /** PLC dados de alta a partir del fichero. */
  plcs_creados: string[];
  /** PLC que ya estaban aqui (mismo endpoint) y se reutilizan. */
  plcs_ya_existentes: string[];
  /** PLC que no se pudieron crear (un Rexroth sin contrasena, p. ej.). */
  plcs_omitidos: PlcOmitido[];
  /** Ids de PLC que cambiaron (ya habia otro con ese id). Enlaces reescritos. */
  plcs_renombrados: Record<string, string>;
  /** Cuantos PLC adoptaron el catalogo de variables del fichero. */
  catalogos_importados: number;
  /** Tags habilitados para escritura que no lo estaban aqui. */
  escritura_habilitada: number;
  /** Carpetas de la barra recreadas en el proyecto importado. */
  grupos_importados: number;
  /** Pantallas colocadas en su carpeta. */
  pantallas_agrupadas: number;
}

/** Pide el documento del proyecto. Es el contenido del fichero. */
export async function exportarProyecto(
  proyectoId: string
): Promise<ProyectoExportado> {
  return fetchAuth(`/proyectos/${encodeURIComponent(proyectoId)}/exportar`);
}

/** Nombre del fichero: reconocible en la carpeta de Descargas dentro de un mes. */
export function nombreDeFichero(nombreProyecto: string): string {
  return `proyecto-${idDesdeNombreProyecto(nombreProyecto)}-${hoy()}.json`;
}

/**
 * Descarga el proyecto como fichero, donde el usuario elija guardarlo.
 *
 * Devuelve el nombre con el que se guardo.
 */
export async function descargarProyecto(
  proyectoId: string,
  nombreProyecto: string
): Promise<string> {
  const doc = await exportarProyecto(proyectoId);
  // La seleccion de Configuracion es de este navegador: el servidor no la
  // tiene, asi que se anade aqui, justo antes de escribir el fichero.
  doc.seleccion_variables = RealPLCService.seleccionActual();
  return descargarJson(doc, nombreDeFichero(nombreProyecto || proyectoId));
}

/**
 * Lee un fichero elegido por el usuario y comprueba que sea un proyecto.
 *
 * Las comprobaciones se hacen AQUI ademas de en el servidor a proposito: es
 * la diferencia entre "ese fichero no es un proyecto" al instante y esperar a
 * que suban 8 MB para recibir un 400.
 */
export function leerFicheroDeProyecto(archivo: File): Promise<ProyectoExportado> {
  return leerJsonDeFichero<ProyectoExportado>(
    archivo,
    'psicore.proyecto',
    'Este fichero no es un proyecto exportado desde la aplicacion. Debe ser ' +
      'el .json que genera «Exportar proyecto».'
  );
}

/** Crea un proyecto nuevo a partir del documento. Nunca sobrescribe nada. */
export async function importarProyecto(
  doc: ProyectoExportado,
  nombre?: string
): Promise<ResultadoImportacion> {
  const q = nombre ? `?nombre=${encodeURIComponent(nombre)}` : '';
  const d = await fetchAuth(`/proyectos/importar${q}`, {
    method: 'POST',
    body: JSON.stringify(doc),
  });
  return {
    proyecto_id: d.proyecto_id,
    nombre: d.nombre,
    num_pantallas: d.num_pantallas ?? 0,
    renombradas: d.renombradas ?? {},
    widgets_importados: d.widgets_importados ?? [],
    widgets_ya_existentes: d.widgets_ya_existentes ?? [],
    widgets_con_error: d.widgets_con_error ?? [],
    variables_importadas: d.variables_importadas ?? [],
    variables_ya_existentes: d.variables_ya_existentes ?? [],
    variables_en_conflicto: d.variables_en_conflicto ?? [],
    plcs_creados: d.plcs_creados ?? [],
    plcs_ya_existentes: d.plcs_ya_existentes ?? [],
    plcs_omitidos: d.plcs_omitidos ?? [],
    plcs_renombrados: d.plcs_renombrados ?? {},
    catalogos_importados: d.catalogos_importados ?? 0,
    escritura_habilitada: d.escritura_habilitada ?? 0,
    grupos_importados: d.grupos_importados ?? 0,
    pantallas_agrupadas: d.pantallas_agrupadas ?? 0,
  };
}

/**
 * Aplica en este navegador la seleccion de variables que traia el fichero,
 * con los ids de PLC ya traducidos si el servidor los renombro. Devuelve
 * cuantas marcas cambiaron. Se llama DESPUES de importar, cuando ya se
 * sabe que ids tienen los PLC aqui.
 */
export function aplicarSeleccionImportada(
  doc: ProyectoExportado,
  renombrados: Record<string, string>
): number {
  const origen = doc.seleccion_variables;
  if (!origen || typeof origen !== 'object') return 0;
  const traducida: Record<string, boolean> = {};
  for (const [clave, sel] of Object.entries(origen)) {
    const sep = clave.indexOf('|');
    if (sep < 0) continue;
    const plc = clave.slice(0, sep);
    const tag = clave.slice(sep + 1);
    traducida[`${renombrados[plc] ?? plc}|${tag}`] = sel;
  }
  return RealPLCService.aplicarSeleccion(traducida);
}
