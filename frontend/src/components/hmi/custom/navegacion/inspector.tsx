// =========================================================================
// custom/navegacion/inspector.tsx
// Piezas del Inspector que comparten el Sidebar y el Screen.
//
// Están aquí y no dentro de cada widget porque el campo "Grupo" y el aviso de
// la vista propia tienen que decir exactamente lo mismo en los dos sitios: si
// se explican distinto, el usuario cree que son dos cosas diferentes.
// =========================================================================
import { useRef, useState, type ChangeEvent } from 'react';
import {
  PlusIcon,
  Trash2Icon,
  AlertTriangleIcon,
  FolderPlusIcon,
  ImageIcon,
  UploadIcon,
  XIcon,
  PaletteIcon,
  IndentIncreaseIcon,
  IndentDecreaseIcon,
} from 'lucide-react';
import {
  esNivel,
  arbolDe,
  indentar,
  desindentar,
  moverEntreHermanos,
  quitarEntrada,
  normalizarEstructura,
  type Seccion } from
'./store';

const INPUT =
  'w-full rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-navy outline-none transition focus:border-siemens focus:ring-2 focus:ring-siemens/20 dark:border-navy-slate dark:bg-navy dark:text-slate-100';

/**
 * Convierte un rótulo en un id utilizable: "Gráficos de línea" -> "graficos-de-linea".
 *
 * El id es lo que se guarda en `HmiWidget.vista`, así que conviene que sea
 * estable y legible: si un día hay que revisar el JSON del proyecto a mano,
 * "graficos" se entiende y "v3" no.
 */
export function idDesdeEtiqueta(texto: string): string {
  return texto
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // quita tildes
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

// ─── Iconos SVG ──────────────────────────────────────────────────

/** Tope del markup de un icono. Un icono de línea son 300-800 bytes. */
const MAX_SVG = 8000;

/**
 * Sanea el SVG que pega el usuario y lo deja listo para escalar.
 *
 * ACEPTA EL ARCHIVO TAL CUAL SALE DEL EXPORTADOR
 * Un .svg de verdad casi nunca empieza por «<svg». Illustrator y Figma meten
 * delante `<?xml version="1.0"?>`, algunos añaden un `<!DOCTYPE`, y las
 * librerías de iconos (Tabler, Lucide…) suelen llevar un comentario con sus
 * etiquetas y su versión. Exigir que la primera letra fuera «<» era una regla
 * que rechazaba justo los archivos normales.
 *
 * Así que primero se tira todo lo que envuelve al dibujo y luego se busca el
 * tramo `<svg>…</svg>` esté donde esté. Da igual lo que venga delante o
 * detrás: si hay un SVG ahí dentro, se saca.
 *
 * POR QUÉ SE SANEA SI LO PEGA EL PROPIO DISEÑADOR
 * Porque no se queda en su navegador. El icono se guarda en el proyecto, el
 * proyecto viaja al servidor, y lo abre CUALQUIERA que entre a esa pantalla
 * — el operador del turno de noche incluido. Un `<script>` o un `onload=`
 * dentro del SVG se ejecutaría en el navegador de todos ellos. Un SVG bajado
 * de internet y pegado sin mirarlo es exactamente el caso que esto ataja.
 *
 * También se le quitan `width` y `height` del `<svg>` raíz: con ellos el
 * icono saldría del tamaño con que lo exportaron (24 px, 512 px…) en vez de
 * ajustarse al botón. Quitados, manda el `viewBox` y escala solo.
 */
export function limpiarSvg(bruto: string): { svg: string; error: string } {
  const crudo = (bruto ?? '').trim();
  if (!crudo) return { svg: '', error: '' };

  if (crudo.length > MAX_SVG) {
    return {
      svg: '',
      error:
        `Ese SVG ocupa ${Math.round(crudo.length / 1000)} KB. Un icono no pasa de 1 KB, ` +
        `así que probablemente sea un dibujo entero. El diseño se guarda completo ` +
        `en cada cambio, y con iconos así el editor se vuelve lento.`,
    };
  }

  // 1. Fuera el envoltorio: cabecera XML, DOCTYPE y comentarios.
  let s = crudo.
  replace(/<\?xml[\s\S]*?\?>/gi, '').
  replace(/<!DOCTYPE[\s\S]*?>/gi, '').
  replace(/<!--[\s\S]*?-->/g, '');

  // 2. Quedarse solo con el dibujo, venga rodeado de lo que venga.
  const ini = s.search(/<svg[\s>]/i);
  const fin = s.toLowerCase().lastIndexOf('</svg>');
  if (ini < 0 || fin < 0 || fin < ini) {
    return {
      svg: '',
      error:
        'No encuentro ninguna etiqueta <svg>…</svg>. Abre el archivo .svg con el ' +
        'Bloc de notas y pega todo su contenido; la cabecera y los comentarios ' +
        'sobran pero no molestan, se quitan solos.',
    };
  }
  s = s.slice(ini, fin + 6);

  // 3. Saneado.
  s = s.
  replace(/<script[\s\S]*?<\/script>/gi, '').
  replace(/<foreignObject[\s\S]*?<\/foreignObject>/gi, '').
  // Cualquier manejador onX="..." (onload, onclick, onmouseover…)
  replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '').
  replace(/(href|xlink:href)\s*=\s*("|')\s*javascript:[^"']*\2/gi, '').
  trim();

  // 4. Fuera el tamaño fijo del <svg> raíz; lo pone el botón.
  s = s.replace(/^<svg([^>]*)>/i, (_m, attrs: string) => {
    const limpio = attrs.replace(/\s(width|height)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');
    return `<svg${limpio}>`;
  });

  return { svg: s, error: '' };
}

/**
 * ¿Este icono va a salir con un color que no es el del texto?
 *
 * Hay dos formas de que pase, y la segunda es la que pilla desprevenido:
 *
 *   1. Trae un color escrito dentro (`stroke="#607d8b"`). Se queda con ese
 *      color también sobre el fondo de la sección activa.
 *   2. NO trae ninguno. Suena inofensivo y es el peor caso: sin `fill`
 *      declarado el navegador pinta NEGRO por defecto, así que en un menú
 *      oscuro el icono desaparece del todo y parece que no se guardó.
 *
 * Un icono que ya usa `currentColor` en algún sitio está bien aunque su
 * `fill` sea `none`: los iconos de trazo (Lucide, Tabler) son exactamente
 * eso — `fill="none"` y el dibujo entero en el `stroke`.
 */
export function tieneColorFijo(svg: string): boolean {
  if (!svg) return false;

  let fijo = false;         // hay un color escrito a mano
  let sigueTexto = false;   // hay algún currentColor
  let fillPintado = false;  // hay un fill que no es `none`

  const mirar = (attr: string, valor: string) => {
    const v = (valor || '').trim().toLowerCase();
    if (attr === 'fill' && v && v !== 'none') fillPintado = true;
    if (v === 'currentcolor') sigueTexto = true;
    else if (v && v !== 'none' && !v.startsWith('url(')) fijo = true;
  };

  const attrs = /\s(fill|stroke)\s*=\s*("|')([^"']*)\2/gi;
  let m: RegExpExecArray | null;
  while ((m = attrs.exec(svg))) mirar(m[1].toLowerCase(), m[3]);

  const enStyle = /(fill|stroke)\s*:\s*([^;"']+)/gi;
  while ((m = enStyle.exec(svg))) mirar(m[1].toLowerCase(), m[2]);

  if (fijo) return true;
  if (sigueTexto) return false;
  return !fillPintado; // ningún fill declarado = negro por defecto
}

/**
 * Pasa los colores fijos del icono a `currentColor`.
 *
 * Con esto el icono se tiñe del color del texto de su sección y cambia solo
 * al activarse, que es lo que hace que un menú se vea de una pieza. Sin esto,
 * un icono exportado en gris se queda gris sobre el fondo petrol de la
 * sección activa, y uno sin `fill` sale negro — invisible en un menú oscuro.
 *
 * VA A BOTÓN Y NO AUTOMÁTICO. Un icono de una sola tinta mejora siempre, pero
 * un logo a varios colores se quedaría plano de un golpe y sin aviso. Que lo
 * decida quien mira el resultado.
 *
 * Los degradados y patrones (`url(#…)`) se respetan: apuntan a una definición
 * de dentro del propio SVG y cambiarlos lo rompería.
 */
export function adaptarAlColorDelTexto(svg: string): string {
  if (!svg) return svg;

  const aCurrentColor = (texto: string, attr: 'fill' | 'stroke') =>
  texto.replace(
    new RegExp(`\\s${attr}\\s*=\\s*("|')([^"']*)\\1`, 'gi'),
    (m, _q, val: string) => {
      const v = (val || '').trim().toLowerCase();
      if (!v || v === 'none' || v === 'currentcolor' || v.startsWith('url(')) return m;
      return ` ${attr}="currentColor"`;
    }
  );

  let s = aCurrentColor(aCurrentColor(svg, 'fill'), 'stroke');

  // Lo mismo dentro de style="fill:#333;stroke:#666", que es como lo exporta
  // Illustrator.
  s = s.replace(/style\s*=\s*("|')([^"']*)\1/gi, (_m, q: string, css: string) => {
    const nuevo = css.replace(
      /(fill|stroke)\s*:\s*([^;]+)/gi,
      (d, prop: string, val: string) => {
        const v = (val || '').trim().toLowerCase();
        if (!v || v === 'none' || v === 'currentcolor' || v.startsWith('url(')) return d;
        return `${prop}:currentColor`;
      }
    );
    return `style=${q}${nuevo}${q}`;
  });

  // Si NADIE declara un fill, el navegador pinta negro. Se declara en la raíz
  // para que herede todo el dibujo.
  if (!/\sfill\s*=/i.test(s) && !/fill\s*:/i.test(s)) {
    s = s.replace(/^<svg([^>]*)>/i, (_m, attrs: string) => `<svg${attrs} fill="currentColor">`);
  }

  return s;
}

// ─── Campos compartidos ──────────────────────────────────────────

/** El campo "Grupo", idéntico en los dos widgets. */
export function CampoGrupo({
  valor,
  onChange,
}: {
  valor: string;
  onChange: (v: string) => void;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-slate-500 dark:text-slate-400">
        Grupo de navegación
      </span>
      <input
        type="text"
        value={valor}
        onChange={(e) => onChange(e.target.value)}
        placeholder="principal"
        className={INPUT}
      />
      <span className="mt-1 block text-[10px] leading-relaxed text-slate-400">
        El menú manda sobre los contenedores de su mismo grupo. Déjalo en
        «principal» salvo que quieras dos navegaciones independientes en el
        mismo lienzo.
      </span>
    </label>
  );
}

/**
 * Aviso cuando el propio widget de navegación tiene una vista asignada.
 *
 * Es el error que más se comete: le pones "Vista: Inicio" al menú, navegas a
 * Gráficos, y el menú desaparece contigo dentro. Sin salida.
 */
export function AvisoVistaPropia({ vista }: { vista?: string }) {
  if (!vista || !vista.trim()) return null;
  return (
    <div className="flex items-start gap-1.5 rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-2 text-[11px] leading-relaxed text-amber-700 dark:border-amber-500/20 dark:bg-amber-500/5 dark:text-amber-400">
      <AlertTriangleIcon className="mt-px h-3.5 w-3.5 shrink-0" />
      <span className="min-w-0">
        Este widget tiene la sección «{vista}» asignada, así que desaparecerá
        al navegar a otra. Ponle <b>En todas</b> arriba del todo.
      </span>
    </div>
  );
}

// ─── Editor de la estructura del menú ────────────────────────────

/**
 * Alta, baja, reordenado, renombrado e iconos del menú.
 *
 * Trabaja sobre UNA lista donde conviven encabezados y secciones, en el mismo
 * orden en que se ven. Lo que hace que se entienda es la sangría: los niveles
 * van a ras y las secciones metidas hacia dentro, igual que en el menú.
 */
export function EditorEstructura({
  secciones,
  onChange,
}: {
  secciones: Seccion[];
  onChange: (s: Seccion[]) => void;
}) {
  // Qué fila tiene el editor de icono abierto. Solo una a la vez: el panel de
  // propiedades es estrecho y con varios abiertos no se ve nada.
  const [iconoAbierto, setIconoAbierto] = useState<string | null>(null);

  // Se trabaja SOBRE EL ÁRBOL, no sobre índices de la lista. Con
  // anidamiento, la fila de arriba puede ser el último nieto del hermano
  // anterior, y moverse ahí sería colarse dentro de un grupo ajeno.
  const filas = arbolDe(secciones);

  const editar = (id: string, patch: Partial<Seccion>) =>
  onChange(secciones.map((s) => s.id === id ? { ...s, ...patch } : s));

  // Quitar SUBE a los hijos un nivel en vez de llevárselos: borrar una rama
  // entera de un tecleo es la clase de error que arruina media hora.
  const borrar = (id: string) => onChange(quitarEntrada(secciones, id));

  const mover = (id: string, delta: number) =>
  onChange(moverEntreHermanos(secciones, id, delta));

  const meter = (id: string) => onChange(indentar(secciones, id));
  const sacar = (id: string) => onChange(desindentar(secciones, id));

  /** Id libre con ese prefijo: seccion-4, seccion-5… */
  const idLibre = (prefijo: string) => {
    let n = secciones.length + 1;
    let id = `${prefijo}-${n}`;
    while (secciones.some((s) => s.id === id)) id = `${prefijo}-${++n}`;
    return { id, n };
  };

  const agregarNivel = () => {
    const { id, n } = idLibre('nivel');
    onChange([
    ...normalizarEstructura(secciones),
    { id, label: `Nivel ${n}`, tipo: 'nivel', padre: '' }]);

  };

  /**
   * Agrega una entrada. Con `dentroDe` la cuelga de esa otra, que es lo que
   * espera quien pulsa el «+» de una fila.
   *
   * SIN `dentroDe` VA DENTRO DEL ÚLTIMO ENCABEZADO DE LA RAÍZ, no suelta.
   * Es la regla de siempre —una sección pertenecía al último encabezado que
   * quedara por encima— y es lo que espera quien acaba de crear un nivel y
   * pulsa «Sección»: que caiga dentro, no al lado. Sin esto la sección nace
   * hermana del encabezado y parece un fallo del anidamiento.
   *
   * Se normaliza antes de insertar: mientras los padres son implícitos
   * dependen de dónde caiga cada encabezado, y meter una fila en medio podría
   * cambiarle el padre a otra sin que nadie lo pidiera.
   */
  const agregarSeccion = (dentroDe?: string) => {
    const base = normalizarEstructura(secciones);
    const ultimoNivelRaiz = [...base]
      .reverse()
      .find((s) => esNivel(s) && !s.padre)?.id;

    const { id, n } = idLibre('seccion');
    const nueva: Seccion = {
      id,
      label: `Sección ${n}`,
      tipo: 'seccion',
      padre: dentroDe ?? ultimoNivelRaiz ?? '',
    };
    onChange([...base, nueva]);
  };

  const cuantasSecciones = secciones.filter((s) => !esNivel(s)).length;

  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-xs font-medium text-slate-500 dark:text-slate-400">
          Estructura del menú
        </span>
        <span className="text-[10px] text-slate-400">
          {cuantasSecciones} {cuantasSecciones === 1 ? 'sección' : 'secciones'}
        </span>
      </div>

      <div className="space-y-1">
        {filas.map(({ seccion: s, profundidad, tieneHijos }) => {
          const nivel = esNivel(s);
          const abierto = iconoAbierto === s.id;

          return (
            <div
              key={s.id}
              // La sangría ES la jerarquía: sin ella, un menú de tres niveles
              // se lee como una lista plana y no hay forma de saber qué
              // cuelga de qué.
              style={{ marginLeft: profundidad * 14 }}>
              <div
                className={`group flex items-center gap-1 rounded-lg border p-1 ${
                nivel ?
                'border-slate-300 bg-slate-100 dark:border-navy-slate dark:bg-navy-slate/40' :
                'border-slate-200 bg-white dark:border-navy-slate dark:bg-navy'}`
                }>

                {/* Reordenar. Con flechas y no arrastrando: dentro de un panel
                    estrecho el arrastre pelea con el scroll. */}
                <div className="flex shrink-0 flex-col">
                  <button
                    type="button"
                    onClick={() => mover(s.id, -1)}
                    title="Subir, con todo lo que lleve dentro"
                    aria-label={`Subir ${s.label}`}
                    className="px-1 text-[9px] leading-none text-slate-400 transition hover:text-siemens">
                    ▲
                  </button>
                  <button
                    type="button"
                    onClick={() => mover(s.id, 1)}
                    title="Bajar, con todo lo que lleve dentro"
                    aria-label={`Bajar ${s.label}`}
                    className="px-1 text-[9px] leading-none text-slate-400 transition hover:text-siemens">
                    ▼
                  </button>
                </div>

                {/* Icono: solo las secciones lo llevan. Un encabezado es un
                    rótulo de agrupación, no un destino al que se navega. */}
                {!nivel &&
                <button
                  type="button"
                  onClick={() => setIconoAbierto(abierto ? null : s.id)}
                  title={s.icono ? 'Cambiar el icono' : 'Poner un icono SVG'}
                  aria-label={`Icono de ${s.label}`}
                  className={`flex h-6 w-6 shrink-0 items-center justify-center rounded border transition ${
                  abierto ?
                  'border-siemens text-siemens' :
                  'border-dashed border-slate-300 text-slate-400 hover:border-siemens hover:text-siemens dark:border-navy-slate'}`
                  }>
                    {s.icono ?
                  <span
                    className="icono-svg h-3.5 w-3.5"
                    // Ya pasó por limpiarSvg() al guardarse.
                    dangerouslySetInnerHTML={{ __html: s.icono }} /> :

                  <ImageIcon className="h-3 w-3" />
                  }
                  </button>
                }

                <div className="min-w-0 flex-1">
                  <input
                    type="text"
                    value={s.label}
                    onChange={(e) => {
                      const label = e.target.value;
                      // El id sigue al rótulo solo mientras no se haya tocado a
                      // mano. Si ya hay widgets apuntando a este id, cambiarlo
                      // los dejaría huérfanos, así que solo se recalcula cuando
                      // el id todavía era el derivado del rótulo anterior.
                      const idEraDerivado = s.id === idDesdeEtiqueta(s.label);
                      const nuevoId = idDesdeEtiqueta(label);
                      editar(s.id, {
                        label,
                        ...(idEraDerivado && nuevoId ? { id: nuevoId } : {})
                      });
                    }}
                    placeholder={nivel ? 'GENERAL' : 'Inicio'}
                    className={`w-full rounded border-none bg-transparent px-1 py-0.5 outline-none focus:ring-1 focus:ring-siemens/40 dark:text-slate-100 ${
                    nivel ?
                    'text-[11px] font-bold uppercase tracking-wide text-slate-500 dark:text-slate-400' :
                    'text-xs font-medium text-navy'}`
                    } />

                  {/* El id solo importa en las secciones: es lo que se guarda
                      en cada widget. El de un nivel no lo usa nadie. */}
                  {!nivel &&
                  <input
                    type="text"
                    value={s.id}
                    onChange={(e) => editar(s.id, { id: idDesdeEtiqueta(e.target.value) })}
                    placeholder="inicio"
                    title="Id interno de la sección. Es lo que se guarda en cada widget."
                    className="w-full rounded border-none bg-transparent px-1 py-0.5 font-mono text-[10px] text-slate-400 outline-none focus:ring-1 focus:ring-siemens/40" />
                  }

                </div>

                {/* Meter y sacar, como el Tab de una lista de tareas. Es la
                    forma de anidar sin cortar y pegar: metes una entrada
                    dentro de la que tiene justo encima. */}
                <div className="flex shrink-0 items-center">
                  <button
                    type="button"
                    onClick={() => sacar(s.id)}
                    disabled={profundidad === 0}
                    title="Sacar un nivel hacia afuera"
                    aria-label={`Sacar ${s.label}`}
                    className="rounded p-0.5 text-slate-400 transition hover:bg-siemens-50 hover:text-siemens disabled:opacity-20 disabled:hover:bg-transparent dark:hover:bg-siemens/10">
                    <IndentDecreaseIcon className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => meter(s.id)}
                    title="Meter dentro de la entrada de arriba"
                    aria-label={`Meter ${s.label}`}
                    className="rounded p-0.5 text-slate-400 transition hover:bg-siemens-50 hover:text-siemens dark:hover:bg-siemens/10">
                    <IndentIncreaseIcon className="h-3.5 w-3.5" />
                  </button>
                </div>

                {/* «+» cuelga una entrada nueva de ESTA. Ahora está en todas
                    las filas, no solo en los niveles: con anidamiento,
                    cualquier entrada puede tener hijos. */}
                <button
                  type="button"
                  onClick={() => agregarSeccion(s.id)}
                  title={`Agregar una entrada dentro de «${s.label}»`}
                  aria-label={`Agregar dentro de ${s.label}`}
                  className="shrink-0 rounded p-1 text-slate-400 transition hover:bg-siemens-50 hover:text-siemens dark:hover:bg-siemens/10">
                  <PlusIcon className="h-3.5 w-3.5" />
                </button>

                <button
                  type="button"
                  onClick={() => borrar(s.id)}
                  title={
                  tieneHijos ?
                  'Quitar esta entrada (lo que lleva dentro sube un nivel)' :
                  'Quitar'}
                  aria-label={`Quitar ${s.label}`}
                  className="shrink-0 rounded p-1 text-slate-400 opacity-0 transition hover:bg-red-50 hover:text-state-error focus-visible:opacity-100 group-hover:opacity-100 dark:hover:bg-state-error/10">
                  <Trash2Icon className="h-3.5 w-3.5" />
                </button>
              </div>

              {!nivel && abierto &&
              <EditorIcono
                valor={s.icono ?? ''}
                onChange={(icono) => editar(s.id, { icono })}
                onCerrar={() => setIconoAbierto(null)} />
              }
            </div>);

        })}
      </div>

      <div className="mt-2 grid grid-cols-2 gap-1.5">
        <button
          type="button"
          onClick={agregarNivel}
          title="Un encabezado que agrupa las secciones de debajo"
          className="flex items-center justify-center gap-1.5 rounded-lg border border-dashed border-slate-300 py-1.5 text-xs font-semibold text-slate-500 transition hover:border-siemens hover:text-siemens dark:border-navy-slate dark:text-slate-400">
          <FolderPlusIcon className="h-3.5 w-3.5" />
          Nivel
        </button>
        <button
          type="button"
          onClick={() => agregarSeccion()}
          className="flex items-center justify-center gap-1.5 rounded-lg border border-dashed border-slate-300 py-1.5 text-xs font-semibold text-slate-500 transition hover:border-siemens hover:text-siemens dark:border-navy-slate dark:text-slate-400">
          <PlusIcon className="h-3.5 w-3.5" />
          Sección
        </button>
      </div>

      {secciones.length > 0 &&
      <p className="mt-2 rounded-lg bg-slate-100 px-2.5 py-2 text-[11px] leading-relaxed text-slate-500 dark:bg-navy-slate/40 dark:text-slate-400">
          Con <b>▸</b> metes una entrada dentro de la que tiene justo encima, y
          con <b>◂</b> la sacas. Se puede anidar cuantas veces haga falta.
          Un <b>nivel</b> es un encabezado que agrupa y no se pulsa; una{' '}
          <b>sección</b> sí se abre. Al quitar una entrada, lo que lleve dentro
          sube un nivel en vez de irse con ella.
        </p>
      }
    </div>);

}

// ─── Editor de un icono ──────────────────────────────────────────

function EditorIcono({
  valor,
  onChange,
  onCerrar,
}: {
  valor: string;
  onChange: (svg: string) => void;
  onCerrar: () => void;
}) {
  const [texto, setTexto] = useState(valor);
  const [error, setError] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  // Lo que se va a dibujar de verdad: el markup ya saneado, no lo que hay
  // escrito en el cuadro. Mientras se pega a medias, se sigue viendo lo
  // último bueno en vez de parpadear.
  const [svgOk, setSvgOk] = useState(valor);

  const aplicar = (bruto: string) => {
    setTexto(bruto);
    const { svg, error } = limpiarSvg(bruto);
    setError(error);
    // Un texto a medio pegar da error y no se guarda: se avisa y ya. Guardar
    // markup roto dejaría el menú con un hueco sin explicación.
    if (!error) {
      setSvgOk(svg);
      onChange(svg);
    }
  };

  const alSubir = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // permite volver a elegir el mismo archivo
    if (!file) return;
    try {
      aplicar(await file.text());
    } catch {
      setError('No se pudo leer el archivo.');
    }
  };

  const adaptar = () => {
    const s = adaptarAlColorDelTexto(svgOk);
    setTexto(s);
    setSvgOk(s);
    setError('');
    onChange(s);
  };

  const colorFijo = tieneColorFijo(svgOk);

  return (
    <div className="mt-1 rounded-lg border border-slate-200 bg-slate-50 p-2 dark:border-navy-slate dark:bg-navy-slate/30">
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-[11px] font-semibold text-slate-500 dark:text-slate-400">
          Icono SVG
        </span>
        <button
          type="button"
          onClick={onCerrar}
          title="Cerrar"
          aria-label="Cerrar el editor de icono"
          className="rounded p-0.5 text-slate-400 transition hover:text-siemens">
          <XIcon className="h-3 w-3" />
        </button>
      </div>

      <input
        ref={fileRef}
        type="file"
        accept=".svg,image/svg+xml"
        onChange={alSubir}
        className="hidden" />

      {/* PRUEBA SOBRE LOS DOS FONDOS REALES.
          Un icono se ve perfecto aquí, en un panel claro, y desaparece en el
          menú porque este es oscuro. Enseñarlo tal como va a salir —apagado y
          activo— es la única forma de detectarlo antes de guardarlo, y es
          justo donde fallan los iconos exportados sin `fill` (negro por
          defecto) o con un gris fijo dentro. */}
      {!!svgOk &&
      <div className="mb-1.5 flex items-center gap-1.5">
        <div className="flex flex-1 items-center gap-2 rounded border border-slate-200 bg-[#0f172a] px-2 py-1.5 dark:border-navy-slate">
          <span
            className="icono-svg h-4 w-4 shrink-0"
            style={{ color: 'rgba(100,116,139,1)' }}
            dangerouslySetInnerHTML={{ __html: svgOk }} />
          <span className="text-[10px] text-slate-500">Apagada</span>
        </div>
        <div className="flex flex-1 items-center gap-2 rounded border border-slate-200 bg-siemens px-2 py-1.5 dark:border-navy-slate">
          <span
            className="icono-svg h-4 w-4 shrink-0"
            style={{ color: '#fff' }}
            dangerouslySetInnerHTML={{ __html: svgOk }} />
          <span className="text-[10px] font-semibold text-white">Activa</span>
        </div>
      </div>
      }

      <textarea
        value={texto}
        onChange={(e) => aplicar(e.target.value)}
        rows={3}
        spellCheck={false}
        placeholder='<svg viewBox="0 0 24 24">…</svg>'
        className="w-full resize-y rounded border border-slate-200 bg-white px-2 py-1 font-mono text-[10px] leading-snug text-navy outline-none transition focus:border-siemens focus:ring-1 focus:ring-siemens/30 dark:border-navy-slate dark:bg-navy dark:text-slate-100" />

      <div className="mt-1.5 flex gap-1.5">
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          className="flex flex-1 items-center justify-center gap-1.5 rounded border border-slate-200 py-1 text-[11px] font-semibold text-slate-500 transition hover:border-siemens hover:text-siemens dark:border-navy-slate dark:text-slate-400">
          <UploadIcon className="h-3 w-3" />
          Subir .svg
        </button>
        {!!texto &&
        <button
          type="button"
          onClick={() => {
            setTexto('');
            setSvgOk('');
            setError('');
            onChange('');
          }}
          title="Quitar el icono"
          aria-label="Quitar el icono"
          className="rounded border border-slate-200 px-2 py-1 text-slate-400 transition hover:border-state-error hover:text-state-error dark:border-navy-slate">
          <Trash2Icon className="h-3 w-3" />
        </button>
        }
      </div>

      {colorFijo && !error &&
      <button
        type="button"
        onClick={adaptar}
        className="mt-1.5 flex w-full items-center justify-center gap-1.5 rounded border border-siemens/40 bg-siemens-50 py-1 text-[11px] font-semibold text-siemens transition hover:bg-siemens hover:text-white dark:bg-siemens/10 dark:text-siemens-200">
        <PaletteIcon className="h-3 w-3" />
        Adaptar al color del texto
      </button>
      }

      {error ?
      <p className="mt-1.5 flex items-start gap-1.5 text-[10px] leading-relaxed text-amber-600 dark:text-amber-400">
        <AlertTriangleIcon className="mt-px h-3 w-3 shrink-0" />
        <span className="min-w-0">{error}</span>
      </p> :
      colorFijo ?
      <p className="mt-1.5 text-[10px] leading-relaxed text-slate-400">
        Este icono trae su propio color, así que no cambiará al activarse la
        sección — y si no trae ninguno, sale negro. Con el botón de arriba
        pasa a seguir al texto.
      </p> :

      <p className="mt-1.5 text-[10px] leading-relaxed text-slate-400">
        Pega el contenido del archivo .svg, con cabecera y comentarios si los
        trae. Este icono ya sigue al color del texto de su sección.
      </p>
      }
    </div>);

}
