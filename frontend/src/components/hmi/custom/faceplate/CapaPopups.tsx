// =========================================================================
// custom/faceplate/CapaPopups.tsx
// Dibuja los faceplates que hay abiertos encima del sinóptico.
//
// LO QUE NO HAY AQUÍ
// Ni un motor de pintado, ni un cargador de pantallas, ni resolución de
// parámetros. Todo eso lo hace ya `PantallaEmbebida`, que es lo que dibuja un
// faceplate incrustado en el lienzo. Una ventana es esa MISMA pieza con un
// marco alrededor y `position: fixed`. Si el popup tuviera su propio camino
// de dibujo, un tipo de faceplate se vería de dos maneras distintas según
// dónde se abriera, y sólo se descubriría en planta.
//
// SE PUEDE ARRASTRAR
// Porque un faceplate no modal se abre justo para poder seguir mirando el
// proceso de debajo, y el sitio donde estorba depende de dónde esté el equipo
// en el sinóptico. Sin poder moverla, la ventana tapa precisamente lo que se
// quería vigilar.
//
// SE CIERRAN AL NAVEGAR
// Un faceplate pertenece a la pantalla desde la que se abrió. Dejarlo
// flotando sobre otra sección deja al operario mirando los datos de un equipo
// que ya no está en pantalla, creyendo que son del que sí está. Eso es peor
// que cerrar de más.
// =========================================================================
import { Suspense, lazy, useCallback, useEffect, useRef, useState } from 'react';
import { XIcon, Loader2Icon } from 'lucide-react';
import { usePopups, cerrarPopup, cerrarTodos, type PopupAbierto } from './popups';
import { useVistaActiva, GRUPO_POR_DEFECTO } from '../navegacion/store';
import { useTamanoPantalla } from '../navegacion/PantallaEmbebida';

const PantallaEmbebida = lazy(() => import('../navegacion/PantallaEmbebida'));

/** Alto de la barra de título, en px. Hace falta para las cuentas del arrastre. */
const BARRA = 36;
/** Lo que queda de ventana visible como mínimo al arrastrarla fuera. */
const ASIDERO = 90;

function Ventana({ popup, indice }: { popup: PopupAbierto; indice: number }) {
  const tam = useTamanoPantalla(popup.tipo);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const agarre = useRef<{ dx: number; dy: number } | null>(null);

  // El tamaño con el que se DIBUJÓ el tipo, salvo que la acción diga otro.
  // Es lo que uno espera: la ventana sale como la dibujaste, no encogida a
  // una medida genérica que obliga a mirar todo escalado.
  const ancho = popup.ancho || tam?.ancho || 520;
  const alto = (popup.alto || tam?.alto || 380) + BARRA;

  const bajar = (e: React.PointerEvent) => {
    const r = ref.current?.getBoundingClientRect();
    if (!r) return;
    agarre.current = { dx: e.clientX - r.left, dy: e.clientY - r.top };
    // Al empezar a arrastrar se pasa de «centrada» a coordenadas fijas, y hay
    // que sembrarlas con las que tiene AHORA MISMO: sin esto la ventana da un
    // salto al primer movimiento.
    setPos({ x: r.left, y: r.top });
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const mover = (e: React.PointerEvent) => {
    const g = agarre.current;
    if (!g) return;
    const maxX = window.innerWidth - ASIDERO;
    const maxY = window.innerHeight - BARRA;
    setPos({
      x: Math.min(Math.max(e.clientX - g.dx, ASIDERO - ancho), maxX),
      y: Math.min(Math.max(e.clientY - g.dy, 0), maxY),
    });
  };

  const soltar = (e: React.PointerEvent) => {
    agarre.current = null;
    if (e.currentTarget.hasPointerCapture?.(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  };

  const z = 1000 + indice * 2;

  return (
    <>
      {popup.modal && (
        // El velo se cierra al pulsarlo. Es una ventana de consulta, no una
        // confirmación: las órdenes que hay dentro ya preguntan por su cuenta,
        // así que salir por descuido no ejecuta nada.
        <div
          onPointerDown={() => cerrarPopup(popup.id)}
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: z,
            background: 'rgba(15,23,42,0.45)',
            backdropFilter: 'blur(1px)',
          }}
        />
      )}

      {/* `data-faceplate` y `data-tags`: qué tipo es y con qué tags se abrió,
          a la vista en el DOM. Cuando alguien avisa de que «el faceplate
          enseña otro equipo», eso se resuelve mirando el elemento, sin tener
          que reproducir nada. */}
      <div
        ref={ref}
        role="dialog"
        aria-modal={popup.modal}
        aria-label={popup.titulo || 'Faceplate'}
        data-faceplate={popup.tipo}
        data-tags={JSON.stringify(popup.params)}
        className="overflow-hidden rounded-xl border border-tema-borde-suave bg-tema-superficie shadow-[0_24px_64px_-16px_rgba(15,23,42,0.45)]"
        style={{
          position: 'fixed',
          zIndex: z + 1,
          width: ancho,
          height: alto,
          maxWidth: 'calc(100vw - 24px)',
          maxHeight: 'calc(100vh - 24px)',
          boxSizing: 'border-box',
          display: 'flex',
          flexDirection: 'column',
          ...(pos
            ? { left: pos.x, top: pos.y }
            : { left: '50%', top: '50%', transform: 'translate(-50%, -50%)' }),
        }}
      >
        <div
          onPointerDown={bajar}
          onPointerMove={mover}
          onPointerUp={soltar}
          onPointerCancel={soltar}
          className="flex shrink-0 select-none items-center justify-between gap-2 border-b border-tema-borde-suave bg-tema-superficie-alt px-3"
          style={{ height: BARRA, cursor: agarre.current ? 'grabbing' : 'grab', touchAction: 'none' }}
        >
          <span className="truncate text-xs font-bold text-tema-sobre-superficie">
            {popup.titulo || 'Faceplate'}
          </span>
          <button
            type="button"
            // El cierre va en `pointerup`: en `click` el arrastre que empieza
            // sobre la X y termina fuera acaba cerrando igual.
            onPointerDown={(e) => {
              e.stopPropagation();
              cerrarPopup(popup.id);
            }}
            aria-label="Cerrar"
            className="rounded-md p-1 text-tema-sobre-superficie-alt transition hover:bg-tema-superficie"
          >
            <XIcon className="h-3.5 w-3.5" />
          </button>
        </div>

        <div style={{ position: 'relative', flex: 1, minHeight: 0 }}>
          <Suspense
            fallback={
              <div className="flex h-full items-center justify-center gap-2 text-xs text-tema-sobre-superficie-alt">
                <Loader2Icon className="h-3.5 w-3.5 animate-spin" />
                Cargando…
              </div>
            }
          >
            {/* La `key` lleva los tags: dos ventanas del mismo tipo con
                equipos distintos no pueden compartir estado de dibujo. */}
            <PantallaEmbebida
              key={`${popup.tipo}|${JSON.stringify(popup.params)}`}
              projectId={popup.tipo}
              modo="ajustar"
              interactivo
              mapaTags={popup.params}
            />
          </Suspense>
        </div>
      </div>
    </>
  );
}

export default function CapaPopups() {
  const popups = usePopups();
  const vista = useVistaActiva(GRUPO_POR_DEFECTO);
  const hay = popups.length > 0;

  // Cambiar de sección cierra lo que hubiera abierto. Ver la cabecera.
  useEffect(() => {
    cerrarTodos();
  }, [vista]);

  const alTeclado = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Escape') cerrarPopup();
  }, []);

  useEffect(() => {
    if (!hay) return;
    window.addEventListener('keydown', alTeclado);
    return () => window.removeEventListener('keydown', alTeclado);
  }, [hay, alTeclado]);

  if (!hay) return null;

  return (
    <>
      {popups.map((p, i) => (
        <Ventana key={p.id} popup={p} indice={i} />
      ))}
    </>
  );
}
