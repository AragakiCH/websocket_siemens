// =========================================================================
// custom/trend/Regla.tsx
// La REGLA: la línea vertical que se pasea por el gráfico y la caja que dice
// qué valía cada serie en ese instante.
//
// QUÉ FALTABA
// El cursor ya existía —uPlot pinta su línea y el índice llegaba por el hook
// `setCursor`— y el valor señalado salía en la leyenda de abajo. Pero leer un
// número que está a 200 px del sitio donde tienes el ojo obliga a mirar dos
// veces y a acordarse de qué color era cuál. En una sala de control, a un metro
// de la pantalla, eso no se hace: se deja de usar.
//
// La caja va PEGADA a la línea, lleva los colores de las series y la hora
// exacta. Es lo que convierte «vi un pico hace dos minutos» en «a las 14:32:07
// la temperatura era 78,4».
//
// POR QUÉ NO ES LA LEYENDA DE uPlot
// La suya es una tabla debajo del canvas, con su propio CSS, que no se puede
// mover ni pegar al cursor. Se desactiva (`legend: { show: false }`) desde el
// primer día por eso mismo.
//
// ── LA CAJA SE APARTA SOLA ─────────────────────────────────────────────
// Cerca del borde derecho se pone a la IZQUIERDA de la línea. Sin eso, los
// últimos valores —los que más se miran, porque son los recientes— quedaban
// medio fuera del widget, y es justo donde el cursor pasa más tiempo.
//
// Y NO INTERCEPTA EL RATÓN
// `pointerEvents: 'none'` en todo. Si la caja capturara el puntero, al pasar
// por debajo de ella el cursor de uPlot dejaría de actualizarse y la regla se
// congelaría exactamente donde se está mirando.
// =========================================================================
import type { TemaGrafico } from './paleta';

/** Dónde está la línea, en píxeles dentro del contenedor del gráfico. */
export interface PosRegla {
  /** Centro de la línea. */
  x: number;
  /** Borde superior del área de dibujo. */
  top: number;
  /** Alto del área de dibujo. */
  alto: number;
  /** Ancho del contenedor, para decidir a qué lado va la caja. */
  ancho: number;
}

export interface FilaRegla {
  clave: string;
  nombre: string;
  color: string;
  valor: string;
}

interface Props {
  pos: PosRegla;
  instante: string;
  filas: FilaRegla[];
  tema: TemaGrafico;
  fuerte: string;
  /** Tamaño de letra de la leyenda, para que la caja lo acompañe. */
  tam: number;
}

/** Ancho estimado de la caja. Con esto se decide el lado antes de pintarla. */
const ANCHO_CAJA = 186;
/** Separación entre la línea y la caja. */
const AIRE = 10;

export function Regla({ pos, instante, filas, tema, fuerte, tam }: Props) {
  // A la derecha si cabe; si no, al otro lado. Se compara contra el ancho del
  // contenedor y no contra el del canvas: la caja puede salirse por encima del
  // eje Y sin problema, pero no del widget.
  const aLaDerecha = pos.x + AIRE + ANCHO_CAJA <= pos.ancho;
  const izquierda = aLaDerecha ? pos.x + AIRE : pos.x - AIRE - ANCHO_CAJA;

  return (
    <>
      {/* La línea. Discontinua a propósito: así se distingue de las líneas de
          datos y de la rejilla incluso en una captura en blanco y negro. */}
      <div
        style={{
          position: 'absolute',
          left: pos.x,
          top: pos.top,
          height: pos.alto,
          width: 0,
          borderLeft: `1px dashed ${tema.tinta}`,
          opacity: 0.85,
          pointerEvents: 'none',
          zIndex: 3,
        }}
      />

      <div
        style={{
          position: 'absolute',
          left: Math.max(2, izquierda),
          top: pos.top + 8,
          width: ANCHO_CAJA,
          maxHeight: Math.max(60, pos.alto - 16),
          overflow: 'hidden',
          pointerEvents: 'none',
          zIndex: 4,
          borderRadius: 8,
          border: `1px solid ${tema.borde}`,
          // `superficie` y NO `chapa`: la chapa es translúcida —vale para una
          // barra pegada al fondo— y aquí la caja va ENCIMA de las líneas. Con
          // un fondo semitransparente se leen los datos a través del número y
          // el valor deja de distinguirse justo donde hay más líneas.
          background: tema.superficie,
          // La sombra es lo que la despega de las líneas que tiene detrás. Sin
          // ella, sobre una zona con cuatro series encima, la caja se lee mal.
          boxShadow: '0 6px 20px -6px rgba(0,0,0,.45)',
          padding: '6px 8px',
          fontSize: tam,
          lineHeight: 1.5,
        }}
      >
        <div
          style={{
            color: fuerte,
            fontWeight: 700,
            fontSize: Math.max(9.5, tam - 1),
            fontVariantNumeric: 'tabular-nums',
            paddingBottom: 4,
            marginBottom: 4,
            borderBottom: `1px solid ${tema.borde}`,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {instante}
        </div>

        {filas.map((f) => (
          <div
            key={f.clave}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              minWidth: 0,
            }}
          >
            <span
              style={{
                width: 10,
                height: 3,
                borderRadius: 2,
                background: f.color,
                flexShrink: 0,
              }}
            />
            <span
              style={{
                flex: 1,
                minWidth: 0,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                color: tema.tintaSuave,
              }}
            >
              {f.nombre}
            </span>
            <b
              style={{
                flexShrink: 0,
                fontWeight: 600,
                color: fuerte,
                fontVariantNumeric: 'tabular-nums',
              }}
            >
              {f.valor}
            </b>
          </div>
        ))}
      </div>
    </>
  );
}
