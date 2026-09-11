// =========================================================================
// Avisos.tsx
// Los avisos de "salió bien" / "no se pudo", abajo a la derecha.
//
// POR QUÉ ABAJO Y NO JUNTO AL BOTÓN QUE LOS PROVOCA
// Porque los de arriba caen encima de la barra de pestañas, y el resumen de
// una importación ocupa cuatro líneas: tapaba precisamente las pantallas que
// uno acaba de importar y quiere abrir. Un aviso que te obliga a esperar a
// que se vaya para seguir trabajando es un diálogo modal disfrazado.
//
// Aquí no estorban a nada —debajo solo hay lienzo—, se van solos y se pueden
// cerrar en el acto. Es el mismo sitio y el mismo gesto que los avisos del
// panel de widgets y de Configuración.
//
// SE COMPARTE entre el selector de proyectos y la barra de pantallas: las dos
// cuentan lo mismo (qué se exportó, qué se importó, qué no se pudo) y tener
// dos maneras de decirlo era la forma segura de que una se quedara atrás.
// =========================================================================
import { useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { AlertTriangleIcon, CheckIcon, XIcon } from 'lucide-react';

interface Props {
  /** Mensaje de error, o cadena vacía. */
  error: string;
  /** Mensaje de confirmación, o cadena vacía. */
  aviso: string;
  onCerrarError: () => void;
  onCerrarAviso: () => void;
}

/** Cuánto se quedan en pantalla, en milisegundos. */
const DURACION_ERROR = 8000;
const DURACION_AVISO = 7000;

export function PilaDeAvisos({
  error,
  aviso,
  onCerrarError,
  onCerrarAviso,
}: Props) {
  // Se van solos. El error dura un poco más porque suele pedir hacer algo; el
  // aviso es solo una confirmación de lo que acabas de pulsar.
  useEffect(() => {
    if (!error) return;
    const id = setTimeout(onCerrarError, DURACION_ERROR);
    return () => clearTimeout(id);
  }, [error, onCerrarError]);

  useEffect(() => {
    if (!aviso) return;
    const id = setTimeout(onCerrarAviso, DURACION_AVISO);
    return () => clearTimeout(id);
  }, [aviso, onCerrarAviso]);

  return (
    // El contenedor está siempre, para que `AnimatePresence` vea entrar y
    // salir a sus hijos (si desapareciera con ellos, no habría animación de
    // salida). Con `pointer-events-none` no intercepta ni un clic cuando está
    // vacío; cada aviso los recupera para su botón.
    <div className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-[22rem] max-w-[calc(100vw-2rem)] flex-col gap-2">
      <AnimatePresence initial={false}>
        {error && (
          <Aviso key="error" tono="error" texto={error} onCerrar={onCerrarError} />
        )}
        {aviso && (
          <Aviso key="aviso" tono="ok" texto={aviso} onCerrar={onCerrarAviso} />
        )}
      </AnimatePresence>
    </div>
  );
}

/**
 * Un aviso suelto.
 *
 * Entra desde abajo, no desde el lado: el movimiento hacia arriba se ve por
 * el rabillo del ojo sin robar la atención, que es lo que se quiere de algo
 * que solo confirma lo que acabas de hacer.
 */
function Aviso({
  tono,
  texto,
  onCerrar,
}: {
  tono: 'ok' | 'error';
  texto: string;
  onCerrar: () => void;
}) {
  const esError = tono === 'error';
  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 12 }}
      transition={{ duration: 0.18 }}
      role={esError ? 'alert' : 'status'}
      className={`pointer-events-auto flex items-start gap-2.5 rounded-xl border px-3.5 py-3 text-[11.5px] leading-relaxed shadow-xl backdrop-blur ${
        esError
          ? 'border-state-error/30 bg-state-error/10 text-state-error'
          : 'border-siemens/30 bg-white text-navy dark:bg-navy-soft dark:text-slate-100'
      }`}
    >
      {esError ? (
        <AlertTriangleIcon className="mt-px h-4 w-4 shrink-0" />
      ) : (
        <CheckIcon className="mt-px h-4 w-4 shrink-0 text-siemens" />
      )}
      <span className="min-w-0 flex-1">{texto}</span>
      <button
        type="button"
        onClick={onCerrar}
        aria-label="Cerrar aviso"
        className={`-mr-1 -mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded outline-none transition hover:bg-black/10 focus-visible:ring-2 focus-visible:ring-siemens/40 dark:hover:bg-white/10 ${
          esError ? 'text-state-error' : 'text-slate-400'
        }`}
      >
        <XIcon className="h-3.5 w-3.5" />
      </button>
    </motion.div>
  );
}
