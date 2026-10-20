// =========================================================================
// trend/Etiquetas.tsx
// Las ETIQUETAS del Trend: marcas con nombre que el operario deja sobre una
// curva en un instante, con la foto de lo que valían todas las variables en
// ese momento.
//
// CÓMO SE CREA UNA
//   «Agregar etiqueta» pausa la vista (los datos se siguen guardando) y abre
//   el cuadro del nombre arriba a la derecha del gráfico. Al pasar el ratón,
//   un punto se pega a la curva más cercana; con un clic se guarda ahí. Lo
//   que se guarda NO depende de que el dato siga en memoria después: la
//   etiqueta lleva su propia copia de los valores.
//
// DÓNDE VIVEN
//   En `sessionStorage`, una lista por widget: sobreviven a RECARGAR el
//   preview y desaparecen al CERRAR su ventana (ver sesionTrend.ts). No van a
//   la base de datos ni se comparten entre equipos.
//
// LO QUE SE DIBUJA
//   Va dentro de `.u-over` (el área de dibujo de uPlot) con un portal, igual
//   que la regla: en ese sistema de coordenadas `valToPos` cae exacto, se
//   escale como se escale el lienzo.
//
//   `data-trend-ui` marca lo que se puede pulsar dentro del área: el plugin
//   de gestos lo respeta y no empieza un arrastre al pulsarlo.
// =========================================================================
import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import type { TemaGrafico } from './paleta';
import { sesionTrend } from './sesionTrend';

export interface LecturaEtiqueta {
  nombre: string;
  color: string;
  valor: number | null;
  unidad?: string;
}

export interface EtiquetaTrend {
  id: string;
  nombre: string;
  /** Instante, en segundos (como el eje X). */
  t: number;
  /** Valor de la curva elegida en ese instante (donde va el punto). */
  y: number;
  /** Color de la curva elegida. */
  color: string;
  /** Nombre de la curva elegida, para el texto de ayuda. */
  curva: string;
  lecturas: LecturaEtiqueta[];
  visible: boolean;
  expandida: boolean;
}

// ─── Guardado en el navegador ─────────────────────────────────────

const claveDe = (widgetId: string) => `hmi.trend.etiquetas.${widgetId}`;

function leer(widgetId: string): EtiquetaTrend[] {
  sesionTrend(); // de paso, borra las que quedaron en localStorage de antes
  try {
    const crudo = JSON.parse(sessionStorage.getItem(claveDe(widgetId)) ?? '[]');
    if (!Array.isArray(crudo)) return [];
    return crudo
      .filter((e) => e && typeof e.id === 'string' && Number.isFinite(e.t) && Number.isFinite(e.y))
      .map((e) => ({
        id: e.id,
        nombre: String(e.nombre ?? ''),
        t: Number(e.t),
        y: Number(e.y),
        color: String(e.color ?? '#6883c4'),
        curva: String(e.curva ?? ''),
        lecturas: Array.isArray(e.lecturas)
          ? e.lecturas.map((l: any) => ({
              nombre: String(l?.nombre ?? ''),
              color: String(l?.color ?? '#999'),
              valor: Number.isFinite(l?.valor) ? Number(l.valor) : null,
              unidad: typeof l?.unidad === 'string' ? l.unidad : undefined,
            }))
          : [],
        visible: e.visible !== false,
        expandida: e.expandida === true,
      }));
  } catch {
    return [];
  }
}

/** Las etiquetas de un widget, guardadas en el navegador al cambiar. */
export function useEtiquetasGuardadas(
  widgetId: string
): [EtiquetaTrend[], React.Dispatch<React.SetStateAction<EtiquetaTrend[]>>] {
  const [estado, setEstado] = useState(() => ({ id: widgetId, lista: leer(widgetId) }));
  // Otro widget en el mismo sitio del árbol: se cargan las suyas.
  const lista = estado.id === widgetId ? estado.lista : leer(widgetId);
  useEffect(() => {
    if (estado.id !== widgetId) setEstado({ id: widgetId, lista: leer(widgetId) });
  }, [widgetId, estado.id]);

  const setLista: React.Dispatch<React.SetStateAction<EtiquetaTrend[]>> = (accion) =>
    setEstado((prev) => {
      const base = prev.id === widgetId ? prev.lista : leer(widgetId);
      const nueva = typeof accion === 'function' ? accion(base) : accion;
      try {
        sessionStorage.setItem(claveDe(widgetId), JSON.stringify(nueva));
      } catch {
        /* sin almacenamiento: quedan en memoria */
      }
      return { id: widgetId, lista: nueva };
    });
  return [lista, setLista];
}

/** El siguiente «etiqueta_N» libre. */
export function siguienteNombre(lista: EtiquetaTrend[]): string {
  let n = 0;
  for (const e of lista) {
    const m = /^etiqueta_(\d+)$/.exec(e.nombre);
    if (m) n = Math.max(n, Number(m[1]));
  }
  return `etiqueta_${Math.max(n, lista.length) + 1}`;
}

// ─── Formato ──────────────────────────────────────────────────────

const dos = (n: number) => String(n).padStart(2, '0');

/** «19/10/2026 03:20:46.9 PM», como el ejemplo de planta. */
export function fmtInstanteEtiqueta(t: number): string {
  const d = new Date(t * 1000);
  const h = d.getHours();
  const h12 = h % 12 === 0 ? 12 : h % 12;
  const decima = Math.floor(d.getMilliseconds() / 100);
  return (
    `${dos(d.getDate())}/${dos(d.getMonth() + 1)}/${d.getFullYear()} ` +
    `${dos(h12)}:${dos(d.getMinutes())}:${dos(d.getSeconds())}.${decima} ${h < 12 ? 'AM' : 'PM'}`
  );
}

function fmtValor(v: number | null): string {
  if (v === null || !Number.isFinite(v)) return '—';
  return v.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}

// ─── La capa dentro del gráfico ───────────────────────────────────

export interface PosEtiqueta {
  x: number;
  y: number;
}

/**
 * Las etiquetas visibles, con su línea punteada, su punto y su chip. Las
 * cajas se reparten para no taparse unas a otras (abajo, arriba, a un lado).
 */
export function CapaEtiquetas({
  area,
  etiquetas,
  posDe,
  tema,
  fuerte,
  onAlternar,
}: {
  area: HTMLDivElement;
  etiquetas: EtiquetaTrend[];
  /** Posición en píxeles del área de dibujo, o null si cae fuera de la vista. */
  posDe: (t: number, y: number) => PosEtiqueta | null;
  tema: TemaGrafico;
  fuerte: string;
  onAlternar: (id: string) => void;
}) {
  const ancho = area.clientWidth;
  const alto = area.clientHeight;

  const colocadas = useMemo(() => {
    const ocupado: { l: number; t: number; w: number; h: number }[] = [];
    const salida: { e: EtiquetaTrend; p: PosEtiqueta; l: number; t: number }[] = [];
    for (const e of etiquetas) {
      if (!e.visible) continue;
      const p = posDe(e.t, e.y);
      if (!p) continue;
      // Medidas estimadas: el chip cerrado crece con el nombre; abierto,
      // con el número de variables.
      const w = e.expandida ? 232 : Math.min(240, 44 + e.nombre.length * 7);
      const h = e.expandida ? 50 + 17 * e.lecturas.length : 26;
      const maxX = Math.max(3, ancho - w - 3);
      const maxY = Math.max(3, alto - h - 3);
      const cl = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
      // A la derecha del punto si cabe; si no (borde derecho), a su
      // IZQUIERDA. Recortarla contra el borde la ponía encima del punto.
      const px = p.x + 13 + w <= ancho - 3 ? p.x + 13 : cl(p.x - 13 - w, 3, maxX);
      const py = cl(p.y - 12, 3, maxY);
      const libre = (l: number, t: number) =>
        !ocupado.some(
          (o) => l < o.l + o.w + 5 && l + w + 5 > o.l && t < o.t + o.h + 5 && t + h + 5 > o.t
        );
      let bx = px;
      let by = py;
      if (!libre(bx, by)) {
        for (let paso = 1; paso <= 10; paso++) {
          const d = paso * (h + 7);
          const opciones: [number, number][] = [
            [px, cl(py + d, 3, maxY)],
            [px, cl(py - d, 3, maxY)],
            [cl(px - w - 10, 3, maxX), cl(py + d, 3, maxY)],
            [cl(px + w + 10, 3, maxX), cl(py + d, 3, maxY)],
          ];
          const ok = opciones.find(([l, t]) => libre(l, t));
          if (ok) {
            [bx, by] = ok;
            break;
          }
        }
      }
      ocupado.push({ l: bx, t: by, w, h });
      salida.push({ e, p, l: bx, t: by });
    }
    return salida;
  }, [etiquetas, posDe, ancho, alto]);

  return createPortal(
    <>
      {colocadas.map(({ e, p, l, t }) => (
        <div key={e.id}>
          {/* Línea punteada del instante */}
          <span
            aria-hidden
            style={{
              position: 'absolute',
              // Línea de 1 px CENTRADA en p.x (de p.x−0.5 a p.x+0.5): así
              // el círculo, centrado también en p.x, queda atravesado justo
              // por el medio.
              left: p.x - 0.5,
              top: 0,
              height: alto,
              width: 0,
              borderLeft: `1px dashed ${tema.tintaSuave}`,
              pointerEvents: 'none',
              zIndex: 3,
            }}
          />
          {/* El punto sobre la curva */}
          <span
            aria-hidden
            style={{
              position: 'absolute',
              left: p.x - 5,
              top: p.y - 5,
              width: 10,
              height: 10,
              boxSizing: 'border-box',
              borderRadius: 999,
              background: '#fff',
              border: `2.5px solid ${e.color}`,
              pointerEvents: 'none',
              zIndex: 4,
            }}
          />
          {/* El chip (y su detalle) */}
          <div
            data-trend-ui
            style={{
              position: 'absolute',
              left: l,
              top: t,
              zIndex: 5,
              minWidth: e.expandida ? 220 : undefined,
              maxWidth: 240,
              borderRadius: 6,
              border: `1px solid ${tema.borde}`,
              background: tema.superficie,
              boxShadow: '0 4px 14px rgba(15,23,42,0.18)',
              fontFamily: 'Inter, system-ui, Arial, sans-serif',
              color: fuerte,
              overflow: 'hidden',
            }}
          >
            <button
              type="button"
              onClick={() => onAlternar(e.id)}
              aria-expanded={e.expandida}
              title={e.expandida ? 'Ocultar los datos' : 'Ver los datos guardados'}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                width: '100%',
                padding: '4px 9px',
                border: 'none',
                borderBottom: e.expandida ? `1px solid ${tema.borde}` : 'none',
                background: 'transparent',
                color: fuerte,
                fontSize: 11.5,
                fontWeight: 700,
                cursor: 'pointer',
                whiteSpace: 'nowrap',
                textAlign: 'left',
              }}
            >
              <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{e.nombre}</span>
              <span style={{ fontSize: 8, color: tema.tintaSuave }}>{e.expandida ? '▲' : '▼'}</span>
            </button>
            {e.expandida && (
              <div style={{ padding: '5px 9px 7px', fontSize: 10.5 }}>
                <div style={{ fontWeight: 700, marginBottom: 3 }}>{fmtInstanteEtiqueta(e.t)}</div>
                {e.lecturas.map((r, i) => (
                  <div
                    key={i}
                    style={{ display: 'flex', alignItems: 'center', gap: 6, lineHeight: 1.55 }}
                  >
                    <i
                      style={{
                        width: 9,
                        height: 3,
                        borderRadius: 2,
                        background: r.color,
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
                      title={r.nombre}
                    >
                      {r.nombre}
                    </span>
                    <b style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>
                      {fmtValor(r.valor)}
                      {r.unidad ? ` ${r.unidad}` : ''}
                    </b>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      ))}
    </>,
    area
  );
}

/** El punto que sigue a la curva mientras se elige dónde poner la etiqueta. */
export function PuntoEtiqueta({
  area,
  x,
  y,
  color,
}: {
  area: HTMLDivElement;
  x: number;
  y: number;
  color: string;
}) {
  return createPortal(
    <span
      aria-hidden
      style={{
        position: 'absolute',
        left: x - 6,
        top: y - 6,
        width: 12,
        height: 12,
        boxSizing: 'border-box',
        borderRadius: 999,
        background: '#fff',
        border: `2.5px solid ${color}`,
        boxShadow: `0 0 0 3px ${color}33`,
        pointerEvents: 'none',
        zIndex: 6,
      }}
    />,
    area
  );
}

// ─── El cuadro del nombre (arriba a la derecha del gráfico) ───────

export function CuadroNombre({
  tema,
  fuerte,
  valor,
  onCambiar,
  ayuda,
  onCancelar,
}: {
  tema: TemaGrafico;
  fuerte: string;
  valor: string;
  onCambiar: (v: string) => void;
  ayuda: string;
  onCancelar: () => void;
}) {
  return (
    <div
      data-trend-ui
      style={{
        position: 'absolute',
        top: 8,
        right: 10,
        zIndex: 20,
        width: 250,
        padding: '10px 12px',
        borderRadius: 8,
        border: `1px solid ${tema.borde}`,
        background: tema.superficie,
        boxShadow: '0 8px 24px rgba(15,23,42,0.2)',
        fontFamily: 'Inter, system-ui, Arial, sans-serif',
      }}
    >
      <label style={{ display: 'block', fontSize: 11, fontWeight: 700, color: fuerte, marginBottom: 5 }}>
        Nombre de la etiqueta
        <input
          autoFocus
          value={valor}
          onChange={(e) => onCambiar(e.target.value)}
          maxLength={60}
          spellCheck={false}
          style={{
            display: 'block',
            width: '100%',
            boxSizing: 'border-box',
            marginTop: 5,
            padding: '5px 8px',
            borderRadius: 5,
            border: `1.5px solid ${fuerte}`,
            background: tema.superficie,
            color: fuerte,
            fontSize: 12,
            outline: 'none',
          }}
        />
      </label>
      <p style={{ margin: '6px 0 7px', fontSize: 10.5, lineHeight: 1.4, color: tema.tintaSuave }}>{ayuda}</p>
      <button
        type="button"
        onClick={onCancelar}
        style={{
          padding: '3px 9px',
          borderRadius: 5,
          border: `1px solid ${tema.borde}`,
          background: tema.chapa,
          color: fuerte,
          fontSize: 10.5,
          cursor: 'pointer',
        }}
      >
        Cancelar (Esc)
      </button>
    </div>
  );
}

// ─── Los modales: Mostrar / Ocultar y Eliminar ────────────────────

export function ModalEtiquetas({
  modo,
  etiquetas,
  tema,
  fuerte,
  onAceptar,
  onCerrar,
}: {
  modo: 'mostrar' | 'eliminar';
  etiquetas: EtiquetaTrend[];
  tema: TemaGrafico;
  fuerte: string;
  /** Los ids marcados. */
  onAceptar: (ids: Set<string>) => void;
  onCerrar: () => void;
}) {
  const [marcadas, setMarcadas] = useState<Set<string>>(
    () => new Set(modo === 'mostrar' ? etiquetas.filter((e) => e.visible).map((e) => e.id) : [])
  );
  useEffect(() => {
    const tecla = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCerrar();
    };
    window.addEventListener('keydown', tecla);
    return () => window.removeEventListener('keydown', tecla);
  }, [onCerrar]);

  const alternar = (id: string) =>
    setMarcadas((prev) => {
      const s = new Set(prev);
      if (s.has(id)) s.delete(id);
      else s.add(id);
      return s;
    });

  const boton = (primario: boolean): React.CSSProperties => ({
    padding: '7px 14px',
    borderRadius: 6,
    border: `1px solid ${primario ? '#6883c4' : tema.borde}`,
    background: primario ? '#6883c4' : tema.superficie,
    color: primario ? '#fff' : fuerte,
    fontSize: 13,
    fontWeight: primario ? 600 : 500,
    cursor: 'pointer',
  });
  const chico: React.CSSProperties = {
    padding: '4px 9px',
    borderRadius: 5,
    border: `1px solid ${tema.borde}`,
    background: tema.chapa,
    color: fuerte,
    fontSize: 11.5,
    cursor: 'pointer',
  };

  return createPortal(
    <div
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCerrar();
      }}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9999,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 16,
        background: 'rgba(15,23,42,0.45)',
        fontFamily: 'Inter, system-ui, Arial, sans-serif',
      }}
    >
      <div
        role="dialog"
        aria-label={modo === 'mostrar' ? 'Mostrar / Ocultar etiquetas' : 'Eliminar etiqueta'}
        style={{
          width: 'min(480px, 100%)',
          maxHeight: '85vh',
          display: 'flex',
          flexDirection: 'column',
          padding: '20px 24px',
          boxSizing: 'border-box',
          borderRadius: 10,
          background: tema.superficie,
          border: `1px solid ${tema.borde}`,
          boxShadow: '0 20px 50px rgba(15,23,42,0.35)',
          color: fuerte,
        }}
      >
        <h3 style={{ margin: '0 0 10px', fontSize: 17, fontWeight: 700 }}>
          {modo === 'mostrar' ? 'Mostrar / Ocultar etiquetas' : 'Eliminar etiqueta'}
        </h3>

        {etiquetas.length === 0 ? (
          <>
            <p style={{ margin: '4px 0 16px', fontSize: 13, color: tema.tintaSuave }}>
              Aún no hay etiquetas guardadas.
            </p>
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <button type="button" onClick={onCerrar} style={boton(true)}>
                Cerrar
              </button>
            </div>
          </>
        ) : (
          <>
            {modo === 'mostrar' && (
              <>
                <p style={{ margin: '0 0 12px', fontSize: 12.5, lineHeight: 1.5, color: tema.tintaSuave }}>
                  Marca las etiquetas que quieres mostrar. Aplicar llevará el gráfico a una o dos
                  etiquetas elegidas, o a las tres más recientes si marcas más.
                </p>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                  <button
                    type="button"
                    style={chico}
                    onClick={() => setMarcadas(new Set(etiquetas.map((e) => e.id)))}
                  >
                    Seleccionar todas
                  </button>
                  <button type="button" style={chico} onClick={() => setMarcadas(new Set())}>
                    Deseleccionar todas
                  </button>
                  <span style={{ marginLeft: 'auto', fontSize: 11.5, color: tema.tintaSuave }}>
                    {marcadas.size} de {etiquetas.length} seleccionadas
                  </span>
                </div>
              </>
            )}
            <div style={{ overflowY: 'auto', minHeight: 0 }}>
              {etiquetas.map((e) => (
                <label
                  key={e.id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    padding: '10px 4px',
                    borderBottom: `1px solid ${tema.borde}`,
                    fontSize: 12.5,
                    cursor: 'pointer',
                  }}
                >
                  <input
                    type="checkbox"
                    checked={marcadas.has(e.id)}
                    onChange={() => alternar(e.id)}
                    style={{ width: 15, height: 15, cursor: 'pointer' }}
                  />
                  <span style={{ minWidth: 0 }}>
                    {e.nombre} · {fmtInstanteEtiqueta(e.t)}
                  </span>
                </label>
              ))}
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
              <button type="button" onClick={onCerrar} style={boton(false)}>
                Cancelar
              </button>
              <button
                type="button"
                onClick={() => onAceptar(marcadas)}
                disabled={modo === 'eliminar' && marcadas.size === 0}
                style={{
                  ...boton(true),
                  opacity: modo === 'eliminar' && marcadas.size === 0 ? 0.5 : 1,
                  cursor: modo === 'eliminar' && marcadas.size === 0 ? 'not-allowed' : 'pointer',
                }}
              >
                {modo === 'mostrar' ? 'Aplicar' : 'Eliminar'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>,
    document.body
  );
}
