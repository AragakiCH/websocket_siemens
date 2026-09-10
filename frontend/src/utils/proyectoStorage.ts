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
// NO viajan alarmas, recetas, flujos ni conexiones a base de datos: son de la
// instalacion, no del diseno. Para mover una instalacion entera esta la copia
// de seguridad de Configuracion.

/** Tope del fichero a importar. Un proyecto normal no pasa de unos pocos MB. */
const MAX_BYTES_IMPORTAR = 25 * 1024 * 1024;

export interface ProyectoExportado {
  formato: string;
  version: number;
  exportado_en?: string;
  exportado_por?: string;
  proyecto: { proyecto_id: string; nombre: string };
  pantallas: unknown[];
  widgets_personalizados: unknown[];
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
}

/** Pide el documento del proyecto. Es el contenido del fichero. */
export async function exportarProyecto(
  proyectoId: string
): Promise<ProyectoExportado> {
  return fetchAuth(`/proyectos/${encodeURIComponent(proyectoId)}/exportar`);
}

/**
 * Nombre del fichero: reconocible en la carpeta de Descargas dentro de un mes.
 *
 * Lleva la fecha porque lo normal es exportar el mismo proyecto varias veces
 * segun avanza, y tres ficheros llamados igual con "(1)" y "(2)" detras no
 * dicen cual es el bueno.
 */
export function nombreDeFichero(nombreProyecto: string): string {
  const dia = new Date().toISOString().slice(0, 10);
  return `proyecto-${idDesdeNombreProyecto(nombreProyecto)}-${dia}.json`;
}

/**
 * Descarga el proyecto como fichero, donde el usuario elija guardarlo.
 *
 * POR QUE `fetch` + blob Y NO UN `<a href>` DIRECTO
 * El endpoint va autenticado y un enlace normal no lleva la cabecera
 * `Authorization`: con la sesion activada devolveria un 401 y el usuario
 * veria una pestana en blanco. Es el mismo camino que ya usan la copia de
 * seguridad y los Excel de exportacion.
 *
 * Devuelve el nombre con el que se guardo.
 */
export async function descargarProyecto(
  proyectoId: string,
  nombreProyecto: string
): Promise<string> {
  const doc = await exportarProyecto(proyectoId);
  const nombre = nombreDeFichero(nombreProyecto || proyectoId);

  // Con sangria (2 espacios): el fichero se puede abrir con cualquier editor
  // para ver que trae antes de meterlo en un equipo de planta.
  const blob = new Blob([JSON.stringify(doc, null, 2)], {
    type: 'application/json',
  });

  // El objeto URL se revoca SIEMPRE, aunque el clic falle: cada blob sin
  // revocar se queda en memoria hasta que se recargue la pestana.
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = nombre;
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    URL.revokeObjectURL(url);
  }
  return nombre;
}

/**
 * Lee un fichero elegido por el usuario y comprueba que sea un proyecto.
 *
 * Las comprobaciones se hacen AQUI ademas de en el servidor a proposito: es
 * la diferencia entre "ese fichero no es un proyecto" al instante y esperar a
 * que suban 8 MB para recibir un 400.
 */
export async function leerFicheroDeProyecto(
  archivo: File
): Promise<ProyectoExportado> {
  if (archivo.size > MAX_BYTES_IMPORTAR) {
    throw new Error(
      `El fichero ocupa ${Math.round(archivo.size / 1024 / 1024)} MB y el ` +
        `maximo son ${MAX_BYTES_IMPORTAR / 1024 / 1024} MB.`
    );
  }
  let doc: any;
  try {
    doc = JSON.parse(await archivo.text());
  } catch {
    throw new Error(
      'El fichero no se puede leer: no es un JSON valido. ¿Se eligio el ' +
        'fichero correcto?'
    );
  }
  if (!doc || doc.formato !== 'psicore.proyecto') {
    throw new Error(
      'Este fichero no es un proyecto exportado desde la aplicacion. Debe ' +
        'ser el .json que genera «Exportar proyecto».'
    );
  }
  return doc as ProyectoExportado;
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
  };
}
