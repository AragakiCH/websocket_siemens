// =========================================================================
// temaApi.ts
// Hablar con `/temas`. Leer, guardar, restaurar, exportar e importar.
// =========================================================================
import { fetchAuth } from './authApi';
import type { DocumentoTemas, Tema } from '../models/tema';

/** Los temas del servidor. No pide sesión: es el aspecto, no los datos. */
export async function leerTemas(): Promise<DocumentoTemas> {
  const r = await fetch('/temas/proyecto');
  if (!r.ok) throw new Error(`No se pudieron leer los temas (HTTP ${r.status}).`);
  return r.json();
}

/**
 * Guarda la lista entera.
 *
 * `version` es la que se leyó al abrir el gestor. Si el servidor va por otra,
 * responde 409 y aquí NO se reintenta a la fuerza: la decisión de pisar el
 * trabajo de otro la toma quien está delante, no el código.
 */
export async function guardarTemas(
  temas: Tema[],
  activo: string,
  version: number | null,
  forzar = false
): Promise<DocumentoTemas> {
  return fetchAuth('/temas/proyecto', {
    method: 'PUT',
    body: JSON.stringify({ temas, activo, version, forzar }),
  });
}

export async function restaurarTemas(): Promise<DocumentoTemas> {
  return fetchAuth('/temas/restaurar', { method: 'POST' });
}

// ─── Llevarse un tema a otra instalación ─────────────────────────
//
// Un tema es un objeto pequeño y autocontenido, así que esto se resuelve en
// el navegador con un fichero JSON: no hace falta ruta en el servidor ni ZIP,
// al contrario que exportar un proyecto (que arrastra widgets propios).

const EXT = '.psitema';

export function exportarTema(tema: Tema): void {
  const paquete = {
    formato: 'psicore.tema',
    version: 1,
    exportado_en: new Date().toISOString(),
    tema,
  };
  const blob = new Blob([JSON.stringify(paquete, null, 2)], {
    type: 'application/json',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${tema.id}${EXT}`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Sin esto el blob se queda en memoria hasta recargar la página.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Lee un `.psitema` y devuelve el tema que trae.
 *
 * Comprueba la forma antes de devolverlo, pero NO valida los colores: eso lo
 * hace el servidor al guardar, y es donde tiene que hacerse —una validación
 * en el navegador la salta cualquiera que llame al endpoint directamente.
 * Aquí solo se trata de dar un mensaje claro al que se equivoca de archivo.
 */
export async function importarTema(archivo: File): Promise<Tema> {
  let paquete: any;
  try {
    paquete = JSON.parse(await archivo.text());
  } catch {
    throw new Error(
      `«${archivo.name}» no es un archivo de tema: no se puede leer como JSON.`
    );
  }
  const tema = paquete?.tema ?? paquete;
  if (!tema || typeof tema !== 'object' || !tema.id || !tema.colores) {
    throw new Error(
      `«${archivo.name}» no parece un tema de PsiCore. Debe tener al menos ` +
        `'id' y 'colores'.`
    );
  }
  return tema as Tema;
}
