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
}
// A positioned, draggable, selectable widget on the canvas.
export function CanvasWidget({
  widget,
  variable,
  selected,
  onSelect,
  onMove,
  onResize,
  canvasRef
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
  const handlePointerDown = (e: React.PointerEvent) => {
    e.stopPropagation();
    onSelect(widget.id);
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
    onMove(widget.id, Math.round(nx), Math.round(ny));
  };
  const handlePointerUp = () => {
    drag.current = null;
    window.removeEventListener('pointermove', handlePointerMove);
    window.removeEventListener('pointerup', handlePointerUp);
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
    onResize(
      widget.id,
      Math.max(32, Math.round(resize.current.origW + dw)),
      Math.max(24, Math.round(resize.current.origH + dh))
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
        position: 'absolute'
      }}
      className={`group cursor-move touch-none select-none rounded-sm outline-offset-2 transition-shadow ${selected ? 'outline outline-2 outline-siemens' : 'outline-none hover:outline hover:outline-1 hover:outline-siemens/40'}`}>
      
      <WidgetRenderer widget={widget} variable={variable} />

      {selected &&
      <>
          <span className="pointer-events-none absolute -top-6 left-0 rounded bg-siemens px-1.5 py-0.5 text-[10px] font-semibold text-white">
            {widget.name}
          </span>
          <div
          onPointerDown={handleResizeDown}
          className="absolute -bottom-1.5 -right-1.5 h-3.5 w-3.5 cursor-nwse-resize rounded-full border-2 border-white bg-siemens shadow" />
        
        </>
      }
    </div>);

}