import React, { useRef } from 'react';
import { HmiWidget } from '../../models/widget';
import { PlcVariable } from '../../models/plc';
import { WidgetRenderer } from './WidgetRenderer';
interface Props {
  widget: HmiWidget;
  variable?: PlcVariable;
  selected: boolean;
  onSelect: (id: string) => void;
  onMove: (id: string, x: number, y: number) => void;
  onResize: (id: string, w: number, h: number) => void;
  canvasRef: React.RefObject<HTMLDivElement>;

  /**
   * Avisos de arrastre, para los grupos.
   *
   * `onMove` no vale para esto: se dispara decenas de veces por segundo y
   * no distingue "empezo" de "sigue". El Disenador necesita el principio
   * para resaltar el contenedor de destino, y el final para decidir si el
   * widget entro o salio de el, que es una cuenta que solo tiene sentido
   * hacer una vez, al soltar.
   */
  onMoveStart?: (id: string) => void;
  onMoveEnd?: (id: string) => void;

  /** Texto extra en la etiqueta al seleccionar: «3 dentro», «en Grupo». */
  insignia?: string;

  /** Este es el contenedor donde caeria lo que se esta arrastrando. */
  resaltado?: boolean;
}
// A positioned, draggable, selectable widget on the canvas.
export function CanvasWidget({
  widget,
  variable,
  selected,
  onSelect,
  onMove,
  onResize,
  canvasRef,
  onMoveStart,
  onMoveEnd,
  insignia,
  resaltado
}: Props) {
  const drag = useRef<{
    startX: number;
    startY: number;
    origX: number;
    origY: number;
  } | null>(null);
  const resize = useRef<{
    startX: number;
    startY: number;
    origW: number;
    origH: number;
  } | null>(null);

  // Un clic simple tambien pasa por pointerdown/pointerup. Sin esta marca,
  // seleccionar un widget contaria como arrastre y dispararia el recalculo
  // de a que contenedor pertenece, ademas de parpadear el resaltado.
  const movido = useRef(false);

  const handlePointerDown = (e: React.PointerEvent) => {
    e.stopPropagation();
    onSelect(widget.id);
    movido.current = false;
    drag.current = {
      startX: e.clientX,
      startY: e.clientY,
      origX: widget.x,
      origY: widget.y
    };
    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
  };
  const handlePointerMove = (e: PointerEvent) => {
    if (!drag.current) return;
    const dx = e.clientX - drag.current.startX;
    const dy = e.clientY - drag.current.startY;
    const bounds = canvasRef.current?.getBoundingClientRect();
    const maxX = bounds ? bounds.width - widget.width : 99999;
    const maxY = bounds ? bounds.height - widget.height : 99999;
    const nx = Math.max(0, Math.min(maxX, drag.current.origX + dx));
    const ny = Math.max(0, Math.min(maxY, drag.current.origY + dy));
    if (!movido.current) {
      movido.current = true;
      onMoveStart?.(widget.id);
    }
    onMove(widget.id, Math.round(nx), Math.round(ny));
  };
  const handlePointerUp = () => {
    drag.current = null;
    window.removeEventListener('pointermove', handlePointerMove);
    window.removeEventListener('pointerup', handlePointerUp);
    if (movido.current) {
      movido.current = false;
      onMoveEnd?.(widget.id);
    }
  };
  const handleResizeDown = (e: React.PointerEvent) => {
    e.stopPropagation();
    resize.current = {
      startX: e.clientX,
      startY: e.clientY,
      origW: widget.width,
      origH: widget.height
    };
    window.addEventListener('pointermove', handleResizeMove);
    window.addEventListener('pointerup', handleResizeUp);
  };
  const handleResizeMove = (e: PointerEvent) => {
    if (!resize.current) return;
    const dw = e.clientX - resize.current.startX;
    const dh = e.clientY - resize.current.startY;

    // TOPE CONTRA EL BORDE DEL LIENZO.
    //
    // Arrastrar ya estaba limitado, pero estirar no: se podía dejar un widget
    // más alto que el lienzo y sobresalía por abajo. El HMI real tiene la
    // resolución del panel, así que lo que se sale del lienzo simplemente no
    // existe en la pantalla del operador.
    //
    // El tope se mide desde la esquina superior izquierda del widget, que es
    // la que no se mueve al estirar por la esquina de abajo a la derecha.
    const bounds = canvasRef.current?.getBoundingClientRect();
    const maxW = bounds ? Math.max(32, bounds.width - widget.x) : 99999;
    const maxH = bounds ? Math.max(24, bounds.height - widget.y) : 99999;

    onResize(
      widget.id,
      Math.min(maxW, Math.max(32, Math.round(resize.current.origW + dw))),
      Math.min(maxH, Math.max(24, Math.round(resize.current.origH + dh)))
    );
  };
  const handleResizeUp = () => {
    resize.current = null;
    window.removeEventListener('pointermove', handleResizeMove);
    window.removeEventListener('pointerup', handleResizeUp);
  };
  if (!widget.visible) return null;
  return (
    <div
      onPointerDown={handlePointerDown}
      style={{
        left: widget.x,
        top: widget.y,
        width: widget.width,
        height: widget.height,
        position: 'absolute',
        // Resaltado del contenedor de destino. Va en `boxShadow` y no en
        // `outline` porque el outline ya lo usa la seleccion, y un
        // contenedor puede estar resaltado y seleccionado a la vez.
        boxShadow: resaltado
          ? '0 0 0 2px #009999, 0 0 0 7px rgba(0,153,153,0.18)'
          : undefined
      }}
      className={`group cursor-move touch-none select-none rounded-sm outline-offset-2 transition-shadow ${selected ? 'outline outline-2 outline-siemens' : 'outline-none hover:outline hover:outline-1 hover:outline-siemens/40'}`}>
      
      <WidgetRenderer widget={widget} variable={variable} />

      {selected &&
      <>
          <span className="pointer-events-none absolute -top-6 left-0 rounded bg-siemens px-1.5 py-0.5 text-[10px] font-semibold text-white">
            {widget.name}
            {insignia && <span className="opacity-70"> · {insignia}</span>}
          </span>
          <div
          onPointerDown={handleResizeDown}
          className="absolute -bottom-1.5 -right-1.5 h-3.5 w-3.5 cursor-nwse-resize rounded-full border-2 border-white bg-siemens shadow" />
        
        </>
      }
    </div>);

}