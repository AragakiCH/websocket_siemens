// =========================================================================
// adoptarTema.ts
// Engancha al tema los widgets que YA estaban guardados.
//
// EL PROBLEMA QUE RESUELVE
// Un widget nuevo nace con `var(--psi-primary)` y sigue al tema. Los que ya
// existen guardan su literal (`#009999`) y no lo siguen: el Gestor de Temas
// funcionaría perfectamente y no movería ni uno de los que hay en planta.
// Abrirlos de uno en uno y reelegir el color es la alternativa, y con cinco
// pantallas ya no es razonable.
//
// LA REGLA, Y POR QUÉ ES TAN ESTRECHA
// Solo se sustituye un literal cuando es EXACTAMENTE igual a un color del
// tema. Nada de "parecido", nada de buscar el más cercano.
//
// Es a propósito. Esto reescribe el diseño de una instalación en marcha, y el
// coste de los dos errores no es el mismo: dejar sin enganchar un widget que
// podría haberlo estado se arregla con dos clics en el Inspector; cambiarle
// el color a un widget que lo tenía elegido a mano es una pantalla de planta
// que amanece distinta y nadie sabe por qué. Ante la duda, no se toca.
//
// Y ES REVERSIBLE ANTES DE APLICARSE: `planificar()` solo LEE y devuelve lo
// que cambiaría, para poder enseñarlo y que alguien lo apruebe. Nada se
// escribe hasta `aplicar()`.
// =========================================================================
import type { HmiWidget } from '../models/widget';
import type { ModoColor, Tema } from '../models/tema';
import { esToken, tokenDeRol } from '../models/tema';
import {
  cargarProyecto,
  guardarProyecto,
  listarProyectos,
} from './designStorage';

/** Las propiedades de estilo que llevan un color. */
const PROPS_COLOR = ['color', 'background', 'borderColor'] as const;

export interface CambioPrevisto {
  pantalla: string;
  widget: string;
  donde: string;
  de: string;
  a: string;
}

export interface Plan {
  cambios: CambioPrevisto[];
  /** Las pantallas tocadas, ya con los widgets reescritos, listas para subir. */
  pendientes: {
    projectId: string;
    version: number;
    widgets: HmiWidget[];
    canvas: { width: number; height: number };
  }[];
  /** Pantallas que no se pudieron leer. Se avisa en vez de callarlo. */
  ilegibles: string[];
}

/**
 * Del color a su rol. Si dos roles comparten el mismo valor —pasa: `onPrimary`
 * y `surface` suelen ser los dos blancos— gana el que antes aparezca en el
 * orden del tema, que es el orden en que se escribieron. Da igual cuál: los
 * dos resuelven al mismo color hoy. Lo que importa es que la elección sea
 * ESTABLE, para que ejecutar esto dos veces dé el mismo resultado.
 */
function indice(tema: Tema, modo: ModoColor): Map<string, string> {
  const m = new Map<string, string>();
  for (const [rol, valor] of Object.entries(tema.colores[modo] ?? {})) {
    const clave = valor.trim().toLowerCase();
    if (!m.has(clave)) m.set(clave, rol);
  }
  return m;
}

/**
 * Qué se cambiaría. NO escribe nada.
 *
 * El cotejo se hace contra la paleta CLARA. Es la que corresponde a lo que
 * hay guardado: los widgets se diseñaron mirando la pantalla en claro, y un
 * mismo literal no puede apuntar a dos roles a la vez.
 */
export async function planificar(tema: Tema): Promise<Plan> {
  const roles = indice(tema, 'light');
  const cambios: CambioPrevisto[] = [];
  const pendientes: Plan['pendientes'] = [];
  const ilegibles: string[] = [];

  const pantallas = await listarProyectos();

  for (const p of pantallas) {
    let doc;
    try {
      doc = await cargarProyecto(p.project_id);
    } catch {
      doc = null;
    }
    // `cargarProyecto` puede devolver la CACHÉ local cuando el servidor falla.
    // Reescribir a partir de una copia posiblemente vieja y subirla es la
    // forma de perder el trabajo de otro, así que se descarta.
    if (!doc || doc.desdeCache) {
      ilegibles.push(p.nombre || p.project_id);
      continue;
    }

    let tocada = false;
    const widgets = doc.widgets.map((w) => {
      const copia: HmiWidget = JSON.parse(JSON.stringify(w));
      const nombre = w.name || w.id;

      const traducir = (valor: any, donde: string): any => {
        if (typeof valor !== 'string') return valor;
        // Un token ya enganchado no se toca, y `transparent` significa "sin
        // fondo": engancharlo a un rol le pondría un color que nadie pidió.
        if (esToken(valor) || valor === 'transparent') return valor;
        const rol = roles.get(valor.trim().toLowerCase());
        if (!rol) return valor;
        tocada = true;
        const token = tokenDeRol(rol);
        cambios.push({
          pantalla: doc!.nombre || doc!.project_id,
          widget: nombre,
          donde,
          de: valor,
          a: token,
        });
        return token;
      };

      for (const prop of PROPS_COLOR) {
        if (copia.style && prop in copia.style) {
          (copia.style as any)[prop] = traducir((copia.style as any)[prop], prop);
        }
      }

      // Las partes (`icon.color`, `boton.background`, `seccion.color`…). Se
      // recorre lo que haya en vez de una lista fija: así una parte nueva
      // queda cubierta sin volver aquí.
      if (copia.partes) {
        for (const [parte, estilo] of Object.entries(copia.partes)) {
          if (!estilo || typeof estilo !== 'object') continue;
          for (const prop of PROPS_COLOR) {
            if (prop in (estilo as any)) {
              (estilo as any)[prop] = traducir(
                (estilo as any)[prop],
                `${parte}.${prop}`
              );
            }
          }
        }
      }

      return copia;
    });

    if (tocada) {
      pendientes.push({
        projectId: doc.project_id,
        version: doc.version,
        widgets,
        canvas: doc.canvas,
      });
    }
  }

  return { cambios, pendientes, ilegibles };
}

/**
 * Escribe el plan.
 *
 * Con la versión que se leyó, no forzando: si alguien guardó esa pantalla
 * entre el análisis y la confirmación, esta escritura se rechaza con un 409 y
 * se informa de qué pantalla fue, en vez de pisar su trabajo. Las demás sí se
 * aplican —una pantalla en conflicto no es motivo para dejar las otras cuatro
 * a medias— y quien lo lance puede volver a ejecutarlo para la que falte.
 */
export async function aplicar(
  plan: Plan
): Promise<{ hechas: string[]; fallidas: { pantalla: string; motivo: string }[] }> {
  const hechas: string[] = [];
  const fallidas: { pantalla: string; motivo: string }[] = [];

  for (const p of plan.pendientes) {
    try {
      await guardarProyecto(
        { widgets: p.widgets, canvas: p.canvas },
        p.version,
        p.projectId
      );
      hechas.push(p.projectId);
    } catch (e: any) {
      fallidas.push({
        pantalla: p.projectId,
        motivo:
          e?.status === 409
            ? 'alguien la guardó mientras tanto; no se tocó'
            : e?.message ?? 'error desconocido',
      });
    }
  }

  return { hechas, fallidas };
}
