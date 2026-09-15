// =========================================================================
// descargas.ts
// Entregar un fichero al navegador para que la persona lo guarde donde
// quiera. Lo usan exportar un proyecto, exportar una pantalla y la copia
// de seguridad de la configuracion.
//
// OJO CON EL `revokeObjectURL`: en la aplicacion de escritorio hay un
// dialogo modal de por medio y soltar el blob antes de tiempo entrega un
// fichero vacio. Esta explicado en `MS_ANTES_DE_SOLTAR`.
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
/**
 * Cuanto se espera antes de soltar el blob, en milisegundos.
 *
 * NO es un numero al azar ni "por si acaso". En el navegador, `a.click()`
 * arranca la descarga al instante y revocar justo despues funciona. En la
 * APLICACION DE ESCRITORIO no: pywebview intercepta la descarga y abre un
 * `SaveFileDialog` de Windows, que es MODAL — el fichero no empieza a
 * escribirse hasta que la persona elige carpeta y pulsa Guardar, y eso puede
 * tardar medio minuto si se pone a navegar entre carpetas.
 *
 * Revocando en el `finally`, como estaba, el blob desaparecia mientras el
 * dialogo seguia abierto y lo que se guardaba era un fichero vacio o una
 * descarga fallida. Un minuto cubre de sobra elegir una carpeta; pasado ese
 * tiempo la memoria se libera igual.
 */
const MS_ANTES_DE_SOLTAR = 60_000;

/**
 * Entrega un Blob al navegador como fichero descargable.
 *
 * Es el unico sitio del proyecto que crea un enlace de descarga, a proposito:
 * la sutileza del revoke de arriba se aprendio una vez y no deberia tener que
 * volver a aprenderse en cada pantalla que exporte algo.
 */
export function descargarBlob(blob: Blob, nombre: string): string {
  const url = URL.createObjectURL(blob);

  const a = document.createElement('a');
  a.href = url;
  a.download = nombre;
  a.rel = 'noopener';
  // Insertado en el documento a proposito: un ancla suelta funciona en
  // Chromium, pero no en todos los motores, y esto tiene que valer tambien
  // para el WebView de la aplicacion.
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();

  // El blob se suelta TARDE (ver arriba), nunca en un `finally`.
  window.setTimeout(() => URL.revokeObjectURL(url), MS_ANTES_DE_SOLTAR);
  return nombre;
}

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
  return descargarBlob(
    new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' }),
    nombre
  );
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
