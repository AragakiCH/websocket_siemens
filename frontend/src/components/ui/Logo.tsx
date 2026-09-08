// =========================================================================
// components/ui/Logo.tsx
// El wordmark de la aplicación, en un solo sitio.
//
// POR QUÉ VIVE AQUÍ Y NO EN LA PANTALLA DE ACCESO
// Nació dentro de `Login.tsx`, que era el único sitio donde se veía. Al
// quererlo también en la cabecera del menú había dos caminos: copiarlo, o
// sacarlo. Copiado serían dos sitios con la ruta del archivo, dos con el
// tratamiento de la placa y dos con el respaldo si la imagen falla — y el día
// que cambies el logo, uno de los dos se quedaría atrás. Aquí hay uno.
//
// PARA CAMBIAR EL LOGO
// Reemplaza `frontend/public/logo.png`. Si prefieres otra extensión, cámbiala
// en `LOGO_SRC` y ya.
//
// EL LOGO ES UN WORDMARK HORIZONTAL (~5.3:1), NO UN ICONO CUADRADO
// Por eso se escala por ALTURA (`h-… w-auto`) y no dentro de una caja
// cuadrada: metido en un cuadrado, `object-contain` lo encoge al ancho de la
// caja y queda una estampilla diminuta con aire arriba y abajo.
//
// LA PLACA BLANCA NO ES UN PARCHE
// La imagen trae fondo blanco y letras azul marino. Sobre una superficie
// oscura, sin placa, se vería un rectángulo blanco sucio recortado contra el
// navy. Apoyarlo en una placa es lo que se hace con un logo de fondo sólido.
//
// `public/logo.png` (900×170) es el `logo.jpeg` original recortado: el JPEG
// traía el blanco METIDO DENTRO — la tinta ocupaba apenas el 52% del alto, y
// el margen inferior (183px) era casi cuatro veces el superior (50px). Eso
// hacía dos cosas: la placa salía altísima con las letras chiquitas, y el logo
// quedaba visualmente descentrado hacia arriba. Ahora el archivo va justo a la
// tinta y el aire lo pone el padding de la placa, que sí se ajusta desde aquí.
// =========================================================================
import { useState } from 'react';

export const LOGO_SRC = '/logo.png';
export const APP_NAME = 'Psi Core';

/**
 * Dónde se está usando el logo. Cada sitio necesita un tamaño distinto:
 *
 *   marca     el panel de la pantalla de acceso. Es el protagonista.
 *   compacto  la cabecera de ese mismo panel cuando colapsa en móvil.
 *   barra     la barra superior de una vista (menú, etc.). Tiene que caber
 *             en una fila de ~48 px sin empujar el resto de la cabecera.
 */
export type VarianteLogo = 'marca' | 'compacto' | 'barra';

const ALTO: Record<VarianteLogo, string> = {
  // El logo recortado es 5.29:1, así que la altura decide el ancho:
  //   h-14 (56px) -> 296px   h-16 (64px) -> 338px   h-10 (40px) -> 212px
  // A `lg` el panel deja ~365px útiles, por eso h-16 se reserva para `xl`.
  marca: 'h-14 xl:h-16',
  compacto: 'h-9 sm:h-10',
  barra: 'h-7',
};

// Padding proporcional al logo (~0.3× su altura). Con el archivo ya recortado,
// este es el único aire que se ve: si se sube, la placa vuelve a parecer
// inflada como cuando el margen venía dentro del JPEG.
const PLACA: Record<VarianteLogo, string> = {
  marca: 'rounded-2xl px-6 py-4 shadow-2xl ring-1 ring-white/25',
  // En claro la placa blanca se confundiría con el fondo slate-50: el borde le
  // devuelve el contorno. En oscuro no hace falta, contrasta sola.
  compacto: 'rounded-2xl px-4 py-2.5 shadow-card ring-1 ring-slate-200 dark:ring-0',
  barra: 'rounded-xl px-3 py-1.5 shadow-sm ring-1 ring-slate-200 dark:ring-0',
};

const TEXTO_RESPALDO: Record<VarianteLogo, string> = {
  marca: 'text-4xl xl:text-[2.75rem]',
  compacto: 'text-xl',
  barra: 'text-base',
};

/**
 * Wordmark de la aplicación, sobre una placa blanca.
 *
 * Se escala por ALTURA y el ancho sale solo (`w-auto`), que es como se trata un
 * logo horizontal: fijar el ancho lo deformaría o lo encogería.
 *
 * Si `LOGO_SRC` no existe, `onError` cambia a un wordmark dibujado con las
 * mismas proporciones, así la pantalla nunca se ve rota ni da un salto de
 * layout. En `npm run dev` un 404 devuelve el index.html de la SPA, que el
 * navegador tampoco puede decodificar como imagen: también dispara onError.
 */
export function Logo({ variante }: { variante: VarianteLogo }) {
  const [falló, setFalló] = useState(false);

  const placa = `inline-flex items-center justify-center bg-white ${PLACA[variante]}`;

  if (falló) {
    return (
      <span className={placa} role="img" aria-label={APP_NAME}>
        <span
          className={`flex items-baseline gap-2 font-extrabold leading-none tracking-tight text-navy ${TEXTO_RESPALDO[variante]}`}
        >
          PsiCore
          <span className="text-siemens">Ψ</span>
        </span>
      </span>
    );
  }

  return (
    <span className={placa}>
      <img
        src={LOGO_SRC}
        alt={APP_NAME}
        onError={() => setFalló(true)}
        // w-auto: la altura manda, el ancho lo calcula el navegador con la
        // proporción real del archivo. Sin esto el logo se aplasta.
        className={`${ALTO[variante]} w-auto`}
      />
    </span>
  );
}
