// =========================================================================
// inspectores/imagen.tsx
// Panel del widget «Imagen»: subir un archivo desde el disco.
//
// DÓNDE SE GUARDA LA IMAGEN
// Dentro del propio proyecto, como texto (data URI) en `config.src`. No hay
// endpoint de subida en el backend, y esta vía tiene una ventaja real: la
// imagen viaja sola con el diseño — llega a la Vista Previa, al PC de la
// oficina y al del turno de noche sin nada más que hacer.
//
// EL PRECIO, Y POR QUÉ SE REDUCE LA IMAGEN
// El proyecto entero se guarda en el servidor cada vez que mueves un widget
// (PUT con 400 ms de espera). Si dentro va una foto de 4 MB del móvil, cada
// arrastre reenvía 5,3 MB — base64 abulta un tercio más que el binario. Con
// dos o tres imágenes el editor se arrastra y el disco del servidor crece sin
// motivo.
//
// Por eso el archivo se reescala en el navegador ANTES de guardarlo: se
// limita el lado largo y se recomprime. Un logo o un esquema de planta no
// necesita más de 1280 px — se va a ver en un widget de 300 px de ancho.
//
// LOS SVG NO SE TOCAN
// Ya son texto y suelen pesar unos pocos KB. Rasterizarlos sería empeorarlos:
// perderían la nitidez que los hace útiles justo para logos y esquemas.
// =========================================================================
import { useRef, useState, type ChangeEvent } from 'react';
import { UploadIcon, Trash2Icon, ImageIcon, AlertTriangleIcon } from 'lucide-react';
import type { InspectorCtx } from '../custom/types';

/** Lado largo máximo. Por encima, el widget no gana nitidez y sí peso. */
const LADO_MAX = 1280;

/**
 * Tope de lo que se acepta guardar, ya procesado.
 *
 * No es un capricho: por encima de esto el guardado automático del diseño
 * empieza a notarse al arrastrar widgets.
 */
const MAX_BYTES = 1_200_000;

export interface ConfigImagen {
  /** data URI. Vacío = todavía no hay imagen. */
  src: string;
  /** Nombre del archivo original, solo para enseñarlo en el panel. */
  nombre: string;
  ajuste: 'contain' | 'cover' | 'fill';
}

export const CONFIG_IMAGEN: ConfigImagen = {
  src: '',
  nombre: '',
  ajuste: 'contain',
};

export function leerConfigImagen(config: any): ConfigImagen {
  const c = config ?? {};
  const ajuste = c.ajuste === 'cover' || c.ajuste === 'fill' ? c.ajuste : 'contain';
  return {
    src: typeof c.src === 'string' ? c.src : '',
    nombre: typeof c.nombre === 'string' ? c.nombre : '',
    ajuste,
  };
}

/** Tamaño aproximado del binario detrás de un data URI base64. */
function bytesDe(dataUri: string): number {
  const i = dataUri.indexOf(',');
  if (i < 0) return 0;
  return Math.round((dataUri.length - i - 1) * 0.75);
}

function fmtPeso(bytes: number): string {
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  return `${Math.round(bytes / 1000)} KB`;
}

function leerComoDataUri(file: File): Promise<string> {
  return new Promise((ok, mal) => {
    const fr = new FileReader();
    fr.onload = () => ok(String(fr.result));
    fr.onerror = () => mal(new Error('No se pudo leer el archivo.'));
    fr.readAsDataURL(file);
  });
}

/**
 * Reduce la imagen y la vuelve a comprimir.
 *
 * Se conserva PNG cuando el original lo era, porque es el formato que trae
 * transparencia: un logo pasado a JPEG saldría con un rectángulo blanco
 * detrás, que es justo lo que no se quiere encima de un esquema.
 */
async function procesar(file: File): Promise<{ src: string; bytes: number }> {
  const original = await leerComoDataUri(file);

  // Los SVG se guardan tal cual: ya son texto, pesan poco y rasterizarlos
  // solo los empeoraría.
  if (file.type === 'image/svg+xml') {
    return { src: original, bytes: bytesDe(original) };
  }

  const img = await new Promise<HTMLImageElement>((ok, mal) => {
    const el = new Image();
    el.onload = () => ok(el);
    el.onerror = () => mal(new Error('El archivo no parece una imagen válida.'));
    el.src = original;
  });

  const escala = Math.min(1, LADO_MAX / Math.max(img.width, img.height));
  const w = Math.max(1, Math.round(img.width * escala));
  const h = Math.max(1, Math.round(img.height * escala));

  const lienzo = document.createElement('canvas');
  lienzo.width = w;
  lienzo.height = h;
  const ctx = lienzo.getContext('2d');
  if (!ctx) throw new Error('El navegador no pudo procesar la imagen.');
  ctx.drawImage(img, 0, 0, w, h);

  const conAlfa = file.type === 'image/png' || file.type === 'image/webp';
  const src = conAlfa
    ? lienzo.toDataURL('image/png')
    : lienzo.toDataURL('image/jpeg', 0.85);

  return { src, bytes: bytesDe(src) };
}

// ─── Panel ───────────────────────────────────────────────────────

export function InspectorImagen({ config, setConfig }: InspectorCtx) {
  const cfg = leerConfigImagen(config);
  const fileRef = useRef<HTMLInputElement>(null);
  const [cargando, setCargando] = useState(false);
  const [error, setError] = useState('');

  const set = (patch: Partial<ConfigImagen>) => setConfig({ ...cfg, ...patch });

  const alElegir = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    // Se limpia el input para poder volver a elegir el MISMO archivo si el
    // primer intento falló; si no, el change no se dispara otra vez.
    e.target.value = '';
    if (!file) return;

    setCargando(true);
    setError('');
    try {
      const { src, bytes } = await procesar(file);
      if (bytes > MAX_BYTES) {
        throw new Error(
          `La imagen sigue pesando ${fmtPeso(bytes)} después de reducirla. ` +
          `El diseño se guarda entero en cada cambio, así que por encima de ` +
          `${fmtPeso(MAX_BYTES)} el editor se vuelve lento. Prueba a recortarla ` +
          `o a exportarla con menos calidad.`
        );
      }
      set({ src, nombre: file.name });
    } catch (err: any) {
      setError(err?.message ?? 'No se pudo cargar la imagen.');
    } finally {
      setCargando(false);
    }
  };

  const peso = cfg.src ? bytesDe(cfg.src) : 0;

  return (
    <>
      <input
        ref={fileRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/svg+xml,image/gif"
        onChange={alElegir}
        className="hidden"
      />

      {cfg.src ? (
        <div className="space-y-2">
          {/* Miniatura sobre damero: sin él, una imagen con transparencia
              parecería tener fondo blanco y no se sabría si lo tiene. */}
          <div
            className="flex h-24 items-center justify-center overflow-hidden rounded-lg border border-slate-200 dark:border-navy-slate"
            style={{
              backgroundImage:
                'linear-gradient(45deg,#e2e8f0 25%,transparent 25%,transparent 75%,#e2e8f0 75%),' +
                'linear-gradient(45deg,#e2e8f0 25%,transparent 25%,transparent 75%,#e2e8f0 75%)',
              backgroundSize: '12px 12px',
              backgroundPosition: '0 0, 6px 6px',
            }}
          >
            <img
              src={cfg.src}
              alt={cfg.nombre || 'Imagen del widget'}
              className="max-h-full max-w-full object-contain"
            />
          </div>

          <div className="flex items-center gap-1.5 text-[11px] text-slate-400">
            <ImageIcon className="h-3 w-3 shrink-0" />
            <span className="min-w-0 flex-1 truncate" title={cfg.nombre}>
              {cfg.nombre || 'imagen'}
            </span>
            <span className="shrink-0 tabular-nums">{fmtPeso(peso)}</span>
          </div>

          <div className="flex gap-1.5">
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              disabled={cargando}
              className="flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-slate-200 py-1.5 text-xs font-semibold text-slate-500 transition hover:border-siemens hover:text-siemens disabled:opacity-50 dark:border-navy-slate dark:text-slate-400"
            >
              <UploadIcon className="h-3.5 w-3.5" />
              {cargando ? 'Cargando…' : 'Cambiar'}
            </button>
            <button
              type="button"
              onClick={() => set({ src: '', nombre: '' })}
              title="Quitar la imagen"
              aria-label="Quitar la imagen"
              className="rounded-lg border border-slate-200 px-2 py-1.5 text-slate-400 transition hover:border-state-error hover:text-state-error dark:border-navy-slate"
            >
              <Trash2Icon className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          disabled={cargando}
          className="flex w-full flex-col items-center gap-1.5 rounded-lg border border-dashed border-slate-300 px-3 py-5 text-center transition hover:border-siemens hover:text-siemens disabled:opacity-50 dark:border-navy-slate"
        >
          <UploadIcon className="h-5 w-5 text-slate-400" />
          <span className="text-xs font-semibold text-slate-500 dark:text-slate-400">
            {cargando ? 'Procesando…' : 'Subir imagen'}
          </span>
          <span className="text-[10px] leading-relaxed text-slate-400">
            PNG, JPG, WEBP, SVG o GIF
          </span>
        </button>
      )}

      {error && (
        <p className="flex items-start gap-1.5 rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-2 text-[11px] leading-relaxed text-amber-700 dark:border-amber-500/20 dark:bg-amber-500/5 dark:text-amber-400">
          <AlertTriangleIcon className="mt-px h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0">{error}</span>
        </p>
      )}

      <label className="block">
        <span className="mb-1 block text-xs font-medium text-slate-500 dark:text-slate-400">
          Ajuste
        </span>
        <select
          value={cfg.ajuste}
          onChange={(e) => set({ ajuste: e.target.value as ConfigImagen['ajuste'] })}
          className="w-full rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-navy outline-none transition focus:border-siemens focus:ring-2 focus:ring-siemens/20 dark:border-navy-slate dark:bg-navy dark:text-slate-100"
        >
          <option value="contain">Encajar entera</option>
          <option value="cover">Rellenar y recortar</option>
          <option value="fill">Estirar</option>
        </select>
        <span className="mt-1 block text-[10px] leading-relaxed text-slate-400">
          {cfg.ajuste === 'contain' && 'Se ve completa, con margen si las proporciones no coinciden.'}
          {cfg.ajuste === 'cover' && 'Llena el widget recortando lo que sobra por los lados.'}
          {cfg.ajuste === 'fill' && 'Llena el widget deformando la imagen. Úsalo solo si la proporción ya coincide.'}
        </span>
      </label>

      {cfg.src && (
        <p className="rounded-lg bg-slate-100 px-2.5 py-2 text-[11px] leading-relaxed text-slate-500 dark:bg-navy-slate/40 dark:text-slate-400">
          La imagen se guarda dentro del diseño, así que se ve también en la
          Vista Previa y en los demás equipos sin copiar ningún archivo.
        </p>
      )}
    </>
  );
}
