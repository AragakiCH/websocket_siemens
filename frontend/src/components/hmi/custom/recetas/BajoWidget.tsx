// =========================================================================
// BajoWidget.tsx
// Pinta algo pegado a un widget —debajo o a su derecha— sin que lo recorte.
//
// POR QUÉ UN PORTAL
//
//   El contenedor de todo widget (`WidgetRenderer`) lleva `overflow: hidden`:
//   lo que un widget dibuje fuera de su caja no se ve. Para enseñar la franja
//   «Receta actual» bajo el botón, o el aviso bajo un campo, hay que salir de
//   esa caja.
//
//   Se sale al contenedor de la PANTALLA —el padre de la caja con posición
//   absoluta de cada widget— y no a `document.body`, a propósito: ese
//   contenedor es el que la Vista Previa escala. Dentro de él las medidas
//   son las del diseño, así que esto cae en su sitio con cualquier zoom sin
//   convertir píxeles de pantalla a píxeles de maquetación.
// =========================================================================
import { useLayoutEffect, useState, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';

interface Sitio {
  destino: HTMLElement;
  left: number;
  top: number;
  ancho: number;
  alto: number;
}

export function BajoWidget({
  ancla,
  separacion = 6,
  lado = 'abajo',
  children,
}: {
  /** Cualquier elemento de DENTRO del widget. */
  ancla: RefObject<HTMLElement>;
  separacion?: number;
  /** `'derecha'`: al costado, en la misma fila y con su misma altura. */
  lado?: 'abajo' | 'derecha';
  /** Recibe el ancho y el alto del widget, por si quiere igualarlos. */
  children: (ancho: number, alto: number) => ReactNode;
}) {
  const [sitio, setSitio] = useState<Sitio | null>(null);

  // Sin dependencias: el widget se pudo mover o redimensionar. No entra en
  // bucle porque solo se cambia el estado cuando las medidas cambian.
  useLayoutEffect(() => {
    let caja: HTMLElement | null = ancla.current;
    while (caja && getComputedStyle(caja).position !== 'absolute') {
      caja = caja.parentElement;
    }
    const destino = caja?.parentElement ?? null;
    if (!caja || !destino) {
      if (sitio) setSitio(null);
      return;
    }
    const nuevo: Sitio = {
      destino,
      left: lado === 'derecha' ? caja.offsetLeft + caja.offsetWidth + separacion : caja.offsetLeft,
      top: lado === 'derecha' ? caja.offsetTop : caja.offsetTop + caja.offsetHeight + separacion,
      ancho: caja.offsetWidth,
      alto: caja.offsetHeight,
    };
    if (
      !sitio ||
      sitio.destino !== nuevo.destino ||
      sitio.left !== nuevo.left ||
      sitio.top !== nuevo.top ||
      sitio.ancho !== nuevo.ancho ||
      sitio.alto !== nuevo.alto
    ) {
      setSitio(nuevo);
    }
  });

  if (!sitio) return null;
  return createPortal(
    <div
      style={{
        position: 'absolute',
        left: sitio.left,
        top: sitio.top,
        zIndex: 40,
        pointerEvents: 'none',
      }}
    >
      {children(sitio.ancho, sitio.alto)}
    </div>,
    sitio.destino
  );
}
