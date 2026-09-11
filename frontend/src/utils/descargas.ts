// =========================================================================
// descargas.ts
// Entregar un fichero al navegador para que la persona lo guarde donde
// quiera. Lo usan exportar un proyecto y exportar una pantalla.
//
// POR QUE `fetch` + blob Y NO UN `<a href>` DIRECTO
// Los endpoints van autenticados, y un enlace normal no lleva la cabecera
// `Authorization`: con la sesion activada devolveria un 401 y el usuario
// veria una pestana en blanco. Por eso el documento se pide con `fetchAuth`
// (que si manda el token) y el fichero se arma aqui, ya en memoria.
// =========================================================================

/**
 * Guarda un objeto como fichero `.json`.
 *
 * Con sangria de 2 espacios a proposito: lo exportado se puede abrir con
 * cualquier editor para ver que trae antes de meterlo en un equipo de planta,
 * y se versiona en git como cualquier otro fichero de texto.
 *
 * Devuelve el nombre con el que se guardo.
 */
export function descargarJson(doc: unknown, nombre: string): string {
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
 * Fecha de hoy en `AAAA-MM-DD`, para el nombre del fichero.
 *
 * Lo normal es exportar lo mismo varias veces segun avanza el trabajo, y tres
 * ficheros llamados igual con "(1)" y "(2)" detras no dicen cual es el bueno.
 */
export function hoy(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Tope de lo que se acepta importar. Un diseno normal no pasa de unos MB. */
export const MAX_BYTES_IMPORTAR = 25 * 1024 * 1024;

/**
 * Lee un fichero elegido por el usuario y comprueba que sea del tipo que se
 * espera.
 *
 * Las comprobaciones se hacen AQUI ademas de en el servidor a proposito: es
 * la diferencia entre "ese fichero no es lo que crees" al instante y esperar
 * a que suban 8 MB para recibir un 400.
 *
 * `queEs` describe lo que deberia ser, para que el mensaje de error diga algo
 * util ("debe ser el .json que genera «Exportar pantalla»").
 */
export async function leerJsonDeFichero<T>(
  archivo: File,
  formatoEsperado: string,
  queEs: string
): Promise<T> {
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
  if (!doc || typeof doc !== 'object') {
    throw new Error('El fichero esta vacio o no tiene el formato esperado.');
  }
  if (doc.formato !== formatoEsperado) {
    // Decir QUE es lo que se abrio ahorra el viaje de ir a mirarlo: el caso
    // frecuente es confundir el fichero de un proyecto con el de una pantalla.
    const tiene =
      doc.formato === 'psicore.proyecto'
        ? ' Este fichero es un PROYECTO entero.'
        : doc.formato === 'psicore.pantalla'
          ? ' Este fichero es una PANTALLA suelta.'
          : '';
    throw new Error(`${queEs}${tiene}`);
  }
  return doc as T;
}
