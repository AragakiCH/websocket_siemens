// =========================================================================
// trend/ColumnaTrend.tsx
// La columna DERECHA del Trend: arriba un hueco para el logo y debajo el
// panel de herramientas (Eje X, Eje Y, Etiquetas).
//
// EL LOGO NO SE PONE AQUÍ
//   Solo se reserva el espacio, con el ancho y alto del Inspector. El logo
//   es un widget de Imagen que se coloca encima en el lienzo. En el
//   Diseñador el hueco lleva un borde punteado para saber dónde va; en la
//   Vista Previa es transparente.
//
// LAS HERRAMIENTAS
//   EJE X: ◀ ▶, Zoom X − / + (pausan), X −1 h / X +1 h y Restablecer X
//   (vuelve a EN VIVO). EJE Y: zoom, ▼ ▲ y Restablecer Y (no pausan).
//   ETIQUETAS: agregar, mostrar/ocultar y eliminar (ver Etiquetas.tsx).
//   DETENER / REANUDAR: congela la vista (se sigue grabando). Todo lo que
//   pausa (zoom X, deslizar, etiquetas) lo deja en «Reanudar», que vuelve al
//   último dato CONSERVANDO el zoom X e Y que haya.
//
// Va SEPARADA del gráfico (el `gap` lo pone Trend.tsx): no es parte del
// área de dibujo, es un panel al lado.
// =========================================================================
import { useState } from 'react';
import {
  ZoomInIcon,
  ZoomOutIcon,
  RotateCcwIcon,
  EyeIcon,
  Trash2Icon,
} from 'lucide-react';
import type { TemaGrafico } from './paleta';

const FUENTE = 'Inter, system-ui, Arial, sans-serif';
const PROXIMAMENTE = 'Próximamente';

// ── Iconos que no existen en la versión de lucide del proyecto ──────
// Dibujados aquí para no depender de un nombre que quizá no esté.

function Svg({ children, tam = 14 }: { children: React.ReactNode; tam?: number }) {
  return (
    <svg
      width={tam}
      height={tam}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ flexShrink: 0 }}
    >
      {children}
    </svg>
  );
}

const AMBAR = '#d97706';

const IcoPausa = () => (
  <Svg>
    <path d="M9 5v14M15 5v14" />
  </Svg>
);
const IcoPlay = () => (
  <Svg>
    <path d="M7 5l12 7-12 7z" />
  </Svg>
);
const IcoDobleIzq = () => (
  <Svg>
    <path d="m11 17-5-5 5-5M18 17l-5-5 5-5" />
  </Svg>
);
const IcoDobleDer = () => (
  <Svg>
    <path d="m6 17 5-5-5-5M13 17l5-5-5-5" />
  </Svg>
);
const IcoMasCirculo = () => (
  <Svg tam={15}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 8v8M8 12h8" />
  </Svg>
);
/** Triángulo relleno: ◀ ▶ ▼ ▲ */
function Triangulo({ dir }: { dir: 'izq' | 'der' | 'abajo' | 'arriba' }) {
  const d = {
    izq: 'M16 5 7 12l9 7z',
    der: 'M8 5l9 7-9 7z',
    abajo: 'M5 8h14l-7 9z',
    arriba: 'M5 16h14L12 7z',
  }[dir];
  return (
    <svg width={13} height={13} viewBox="0 0 24 24" style={{ flexShrink: 0 }}>
      <path d={d} fill="currentColor" />
    </svg>
  );
}

// ── Un botón del panel ─────────────────────────────────────────────

function Boton({
  tema,
  icono,
  texto,
  vertical,
  ancho,
  onClick,
  titulo,
  activo,
  aviso,
}: {
  tema: TemaGrafico;
  /** Resaltado en ámbar (p. ej. «Reanudar» mientras está pausado). */
  aviso?: boolean;
  /** Pulsado (p. ej. «Agregar etiqueta» mientras se coloca). */
  activo?: boolean;
  /** Sin él, el botón es solo diseño («Próximamente»). */
  onClick?: () => void;
  titulo?: string;
  icono?: React.ReactNode;
  texto?: string;
  /** Icono arriba y texto abajo (los de zoom), como el diseño. */
  vertical?: boolean;
  /** Ocupa las dos columnas de la rejilla. */
  ancho?: boolean;
}) {
  const [encima, setEncima] = useState(false);
  return (
    <button
      type="button"
      title={onClick ? titulo : PROXIMAMENTE}
      onClick={onClick}
      aria-pressed={activo || undefined}
      onPointerEnter={() => setEncima(true)}
      onPointerLeave={() => setEncima(false)}
      style={{
        gridColumn: ancho ? '1 / -1' : undefined,
        display: 'flex',
        flexDirection: vertical ? 'column' : 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: vertical ? 2 : 7,
        minWidth: 0,
        minHeight: vertical ? 44 : 34,
        padding: vertical ? '5px 4px' : '0 8px',
        boxSizing: 'border-box',
        borderRadius: 6,
        border: `1px solid ${aviso ? AMBAR : tema.borde}`,
        background: aviso
          ? encima ? 'rgba(217,119,6,0.22)' : 'rgba(217,119,6,0.12)'
          : activo ? tema.superficie : encima && onClick ? tema.superficie : tema.chapa,
        boxShadow: activo ? `inset 0 0 0 1.5px ${tema.tinta}` : undefined,
        color: aviso ? AMBAR : tema.tinta,
        fontWeight: aviso ? 600 : 500,
        fontFamily: FUENTE,
        fontSize: 12,
        lineHeight: 1.15,
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        cursor: onClick ? 'pointer' : 'default',
        opacity: onClick ? 1 : 0.6,
        transition: 'background .12s',
      }}
    >
      {icono}
      {texto && (
        <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{texto}</span>
      )}
    </button>
  );
}

function Rotulo({ tema, children }: { tema: TemaGrafico; children: React.ReactNode }) {
  return (
    <div
      style={{
        gridColumn: '1 / -1',
        marginTop: 6,
        fontSize: 10.5,
        fontWeight: 700,
        letterSpacing: 0.6,
        textTransform: 'uppercase',
        color: tema.tintaSuave,
      }}
    >
      {children}
    </div>
  );
}

export interface AccionesEjeY {
  alejar: () => void;
  acercar: () => void;
  bajar: () => void;
  subir: () => void;
  restablecer: () => void;
}

export interface AccionesEtiquetas {
  agregar: () => void;
  mostrar: () => void;
  eliminar: () => void;
  /** Se está colocando una: el botón se ve pulsado. */
  agregando: boolean;
}

export interface AccionesDetener {
  /** En vivo → «Detener»; pausado → «Reanudar». */
  siguiendo: boolean;
  alternar: () => void;
}

export interface AccionesEjeX {
  atras: () => void;
  adelante: () => void;
  alejar: () => void;
  acercar: () => void;
  menosHora: () => void;
  masHora: () => void;
  restablecer: () => void;
}

function PanelHerramientas({
  tema,
  detener,
  ejeX,
  ejeY,
  etiquetas,
}: {
  tema: TemaGrafico;
  detener?: AccionesDetener;
  ejeX?: AccionesEjeX;
  ejeY?: AccionesEjeY;
  etiquetas?: AccionesEtiquetas;
}) {
  return (
    <div
      className="mp-scroll"
      style={{
        flex: 1,
        minHeight: 0,
        overflowY: 'auto',
        display: 'grid',
        gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)',
        alignContent: 'start',
        gap: 5,
        paddingRight: 2,
      }}
    >
      {detener && !detener.siguiendo ? (
        <Boton tema={tema} ancho aviso icono={<IcoPlay />} texto="Reanudar"
          onClick={detener.alternar}
          titulo="Volver al último dato y seguir en vivo, con el zoom que tengas" />
      ) : (
        <Boton tema={tema} ancho icono={<IcoPausa />} texto="Detener"
          onClick={detener?.alternar}
          titulo="Congelar la vista (los datos se siguen grabando)" />
      )}

      <Rotulo tema={tema}>Eje X</Rotulo>
      <Boton tema={tema} vertical icono={<ZoomOutIcon size={15} />} texto="Zoom X −"
        onClick={ejeX?.alejar} titulo="Alejar (ver más tiempo)" />
      <Boton tema={tema} vertical icono={<ZoomInIcon size={15} />} texto="Zoom X +"
        onClick={ejeX?.acercar} titulo="Acercar (ver menos tiempo)" />
      <Boton tema={tema} icono={<IcoDobleIzq />} texto="X −1 h"
        onClick={ejeX?.menosHora} titulo="Retroceder 1 hora" />
      <Boton tema={tema} icono={<IcoDobleDer />} texto="X +1 h"
        onClick={ejeX?.masHora} titulo="Adelantar 1 hora" />
      <Boton tema={tema} icono={<Triangulo dir="izq" />}
        onClick={ejeX?.atras} titulo="Atrás en el tiempo" />
      <Boton tema={tema} icono={<Triangulo dir="der" />}
        onClick={ejeX?.adelante} titulo="Adelante en el tiempo" />
      <Boton tema={tema} ancho icono={<RotateCcwIcon size={14} />} texto="Restablecer X"
        onClick={ejeX?.restablecer} titulo="Volver a EN VIVO, con la ventana normal" />

      <Rotulo tema={tema}>Eje Y</Rotulo>
      <Boton tema={tema} vertical icono={<ZoomOutIcon size={15} />} texto="Zoom Y −"
        onClick={ejeY?.alejar} titulo="Alejar en Y (ver más rango de valores)" />
      <Boton tema={tema} vertical icono={<ZoomInIcon size={15} />} texto="Zoom Y +"
        onClick={ejeY?.acercar} titulo="Acercar en Y (ver menos rango de valores)" />
      <Boton tema={tema} icono={<Triangulo dir="abajo" />}
        onClick={ejeY?.bajar} titulo="Bajar el rango de valores" />
      <Boton tema={tema} icono={<Triangulo dir="arriba" />}
        onClick={ejeY?.subir} titulo="Subir el rango de valores" />
      <Boton tema={tema} ancho icono={<RotateCcwIcon size={14} />} texto="Restablecer Y"
        onClick={ejeY?.restablecer} titulo="Volver a la escala Y de la configuración" />

      <Rotulo tema={tema}>Etiquetas</Rotulo>
      <Boton tema={tema} ancho icono={<IcoMasCirculo />} texto="Agregar etiqueta"
        onClick={etiquetas?.agregar} activo={etiquetas?.agregando}
        titulo={etiquetas?.agregando ? 'Cancelar la etiqueta' : 'Poner una etiqueta en el gráfico'} />
      <Boton tema={tema} ancho icono={<EyeIcon size={15} />} texto="Mostrar/Ocultar"
        onClick={etiquetas?.mostrar} titulo="Elegir qué etiquetas se ven" />
      <Boton tema={tema} ancho icono={<Trash2Icon size={14} />} texto="Eliminar etiqueta"
        onClick={etiquetas?.eliminar} titulo="Borrar etiquetas" />
    </div>
  );
}

/** Ancho de la columna: lo mayor entre el logo y las herramientas. */
export function anchoColumna(o: {
  logo: boolean;
  logoAncho: number;
  herramientas: boolean;
  herramientasAncho: number;
}): number {
  return Math.max(o.logo ? o.logoAncho : 0, o.herramientas ? o.herramientasAncho : 0);
}

export function ColumnaTrend({
  tema,
  interactivo,
  logo,
  logoAncho,
  logoAlto,
  herramientas,
  herramientasAncho,
  detener,
  ejeX,
  ejeY,
  etiquetas,
}: {
  tema: TemaGrafico;
  interactivo: boolean;
  detener?: AccionesDetener;
  ejeX?: AccionesEjeX;
  ejeY?: AccionesEjeY;
  etiquetas?: AccionesEtiquetas;
  logo: boolean;
  logoAncho: number;
  logoAlto: number;
  herramientas: boolean;
  herramientasAncho: number;
}) {
  const ancho = anchoColumna({ logo, logoAncho, herramientas, herramientasAncho });
  return (
    <div
      style={{
        width: ancho,
        flexShrink: 0,
        height: '100%',
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        fontFamily: FUENTE,
        // En el Diseñador el clic es para seleccionar y mover el widget.
        pointerEvents: interactivo ? 'auto' : 'none',
      }}
    >
      {logo && (
        <div
          style={{
            width: Math.min(logoAncho, ancho),
            height: logoAlto,
            alignSelf: 'flex-end',
            flexShrink: 0,
            boxSizing: 'border-box',
            borderRadius: 6,
            // Solo se marca en el Diseñador: en planta es un hueco para el
            // widget de Imagen que va encima.
            border: interactivo ? 'none' : `1.5px dashed ${tema.tintaSuave}`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            textAlign: 'center',
            fontSize: 10.5,
            lineHeight: 1.4,
            color: tema.tintaSuave,
            overflow: 'hidden',
          }}
        >
          {!interactivo && (
            <span>
              Espacio para logo
              <br />
              {logoAncho} × {logoAlto} px
            </span>
          )}
        </div>
      )}
      {herramientas && (
        <PanelHerramientas tema={tema} detener={detener} ejeX={ejeX} ejeY={ejeY} etiquetas={etiquetas} />
      )}
    </div>
  );
}
