// =========================================================================
// trend/FiltroHistorico.tsx
// «Filtrar histórico»: el modal que lleva el trend de la VISTA PREVIA a lo
// que el historizador guardó en un rango de fechas, sin tocar el diseño.
//
// Rango y puntos por serie, en tiempo de ejecución: lo que se elige aquí vive
// en la sesión de esa ventana, no en el proyecto. Mientras se filtra, el trend
// sigue grabando el en vivo por detrás; «Volver a en vivo» lo vuelve a dibujar.
//
// EL GRUPO NO SE ELIGE AQUÍ
//   Lo fija quien diseña la pantalla, en el Inspector del Trend. Antes se
//   elegía en este modal, y eso dejaba al operario delante de una lista de
//   grupos que no tiene por qué conocer —y que puede llevarle a uno que no
//   graba sus variables—. El grupo es parte del DISEÑO del widget, como sus
//   variables: aquí solo se enseña, con cuántas de ellas cubre.
//
// LAS FECHAS SE FIJAN AL APLICAR
//   «Última hora» se convierte en dos instantes absolutos al pulsar Aplicar
//   y así se guarda: recargar (F5) enseña el MISMO tramo, no otra hora.
// =========================================================================
import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import type { TemaGrafico } from './paleta';
import { RANGOS, aInstanteUtc, aValorLocal } from './historico';
import { listarGrupos, type GrupoHistorico } from '../../../../services/historicoApi';

/** El filtro aplicado, tal como se guarda en la sesión. */
export interface FiltroTrend {
  grupoId: string;
  /** El atajo elegido (`1h`, `8h`… o `personalizado`), para reabrir igual. */
  rango: string;
  /** Lo tecleado en «Entre dos fechas» (hora local), para reabrir igual. */
  desdeLocal: string;
  hastaLocal: string;
  /** Los instantes de verdad, en UTC. */
  desde: string;
  hasta: string;
  limite: number;
}

const claveFiltro = (widgetId: string) => `hmi.trend.filtro.${widgetId}`;

export function leerFiltro(widgetId: string): FiltroTrend | null {
  try {
    const d = JSON.parse(sessionStorage.getItem(claveFiltro(widgetId)) ?? 'null');
    if (!d || typeof d !== 'object' || !d.grupoId || !d.desde || !d.hasta) return null;
    return {
      grupoId: String(d.grupoId),
      rango: String(d.rango ?? 'personalizado'),
      desdeLocal: String(d.desdeLocal ?? ''),
      hastaLocal: String(d.hastaLocal ?? ''),
      desde: String(d.desde),
      hasta: String(d.hasta),
      limite: Number(d.limite) > 0 ? Number(d.limite) : 1000,
    };
  } catch {
    return null;
  }
}

export function guardarFiltro(widgetId: string, f: FiltroTrend | null): void {
  try {
    if (f) sessionStorage.setItem(claveFiltro(widgetId), JSON.stringify(f));
    else sessionStorage.removeItem(claveFiltro(widgetId));
  } catch {
    /* sin almacenamiento: vale para esta pantalla */
  }
}

/** Cuántas de las variables del trend graba ese grupo. */
export function cubiertas(g: GrupoHistorico, ids: string[]): string[] {
  return g.todos_los_tags ? ids : ids.filter((id) => g.tags.includes(id));
}

const LIMITES = [500, 1000, 2500, 5000, 10000];

export function ModalFiltroHistorico({
  tema,
  fuerte,
  ids,
  nombreDe,
  inicial,
  grupoId,
  limitePorDefecto,
  onAplicar,
  onCerrar,
}: {
  tema: TemaGrafico;
  fuerte: string;
  /** Las variables del trend (`plc|tag`). */
  ids: string[];
  nombreDe: (id: string) => string;
  /** Lo que se reabre (el filtro aplicado, o uno propuesto). */
  inicial: Partial<FiltroTrend> | null;
  /** El grupo del historizador del Trend: el del Inspector. No se cambia aquí. */
  grupoId: string;
  limitePorDefecto: number;
  onAplicar: (f: FiltroTrend) => void;
  onCerrar: () => void;
}) {
  const ahora = Date.now();
  const [grupos, setGrupos] = useState<GrupoHistorico[] | null>(null);
  const [errorGrupos, setErrorGrupos] = useState('');
  const [rango, setRango] = useState(inicial?.rango || '1h');
  const [desdeLocal, setDesdeLocal] = useState(inicial?.desdeLocal || aValorLocal(ahora - 3600_000));
  const [hastaLocal, setHastaLocal] = useState(inicial?.hastaLocal || aValorLocal(ahora));
  const [limite, setLimite] = useState(inicial?.limite || limitePorDefecto || 1000);

  useEffect(() => {
    let vivo = true;
    listarGrupos()
      // Solo para ENSEÑAR el grupo (nombre, si está pausado, qué cubre).
      .then((l) => vivo && setGrupos(l))
      .catch((e: any) => vivo && setErrorGrupos(e?.message ?? 'No se pudieron leer los grupos.'));
    return () => {
      vivo = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const tecla = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCerrar();
    };
    window.addEventListener('keydown', tecla);
    return () => window.removeEventListener('keydown', tecla);
  }, [onCerrar]);

  const grupo = grupos?.find((g) => g.grupo_id === grupoId) ?? null;
  const cubre = grupo ? cubiertas(grupo, ids) : [];
  const faltan = grupo ? ids.filter((id) => !cubre.includes(id)) : [];

  // Los dos instantes que se van a pedir, en UTC.
  const ventana = useMemo(() => {
    if (rango === 'personalizado') {
      return { desde: aInstanteUtc(desdeLocal), hasta: aInstanteUtc(hastaLocal, true) };
    }
    const seg = RANGOS.find((r) => r.v === rango)?.seg ?? 3600;
    const fin = Date.now();
    return {
      desde: new Date(fin - seg * 1000).toISOString(),
      hasta: new Date(fin).toISOString(),
    };
    // `rango`/fechas mandan; el reloj se vuelve a mirar al aplicar.
  }, [rango, desdeLocal, hastaLocal]);

  const problema = !grupoId
    ? 'Este trend no tiene grupo del historizador. Elígelo en el Inspector del Diseñador.'
    : grupos !== null && !grupo
    ? `El grupo «${grupoId}» ya no existe en el historizador. Elige otro en el Inspector.`
    : !ventana.desde || !ventana.hasta
    ? 'Pon la fecha y hora de inicio y de fin.'
    : Date.parse(ventana.desde) >= Date.parse(ventana.hasta)
    ? '«Desde» tiene que ser antes que «Hasta».'
    : grupo && cubre.length === 0
    ? 'El historizador no graba ninguna de las variables de este trend.'
    : '';

  const aplicar = () => {
    if (problema) return;
    // Los atajos se fijan AHORA, al pulsar: así F5 enseña el mismo tramo.
    let { desde, hasta } = ventana;
    if (rango !== 'personalizado') {
      const seg = RANGOS.find((r) => r.v === rango)?.seg ?? 3600;
      const fin = Date.now();
      desde = new Date(fin - seg * 1000).toISOString();
      hasta = new Date(fin).toISOString();
    }
    onAplicar({ grupoId, rango, desdeLocal, hastaLocal, desde, hasta, limite });
  };

  const campo: React.CSSProperties = {
    display: 'block',
    width: '100%',
    boxSizing: 'border-box',
    marginTop: 5,
    padding: '7px 9px',
    borderRadius: 6,
    border: `1px solid ${tema.borde}`,
    background: tema.superficie,
    color: fuerte,
    fontSize: 13,
    outline: 'none',
    colorScheme: 'light dark',
  };
  const rotulo: React.CSSProperties = { display: 'block', fontSize: 12, fontWeight: 600, marginTop: 12 };
  const boton = (primario: boolean, apagado = false): React.CSSProperties => ({
    padding: '7px 14px',
    borderRadius: 6,
    border: `1px solid ${primario ? '#6883c4' : tema.borde}`,
    background: primario ? '#6883c4' : tema.superficie,
    color: primario ? '#fff' : fuerte,
    fontSize: 13,
    fontWeight: primario ? 600 : 500,
    cursor: apagado ? 'not-allowed' : 'pointer',
    opacity: apagado ? 0.5 : 1,
  });
  const utc = (iso: string) => (iso ? iso.slice(0, 19).replace('T', ' ') : '—');

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
        aria-label="Filtrar histórico"
        style={{
          width: 'min(500px, 100%)',
          maxHeight: '90vh',
          overflowY: 'auto',
          padding: '20px 24px',
          boxSizing: 'border-box',
          borderRadius: 10,
          background: tema.superficie,
          border: `1px solid ${tema.borde}`,
          boxShadow: '0 20px 50px rgba(15,23,42,0.35)',
          color: fuerte,
        }}
      >
        <h3 style={{ margin: 0, fontSize: 17, fontWeight: 700 }}>Filtrar histórico</h3>
        <p style={{ margin: '4px 0 0', fontSize: 12, lineHeight: 1.5, color: tema.tintaSuave }}>
          Muestra lo que guardó el historizador en ese rango. El en vivo se sigue grabando por
          detrás; «Volver a en vivo» lo vuelve a enseñar.
        </p>

        {/* EL GRUPO NO SE ENSEÑA. Es del diseño (Inspector del Trend), y al
            operario no le dice nada. Solo queda lo que le sirve: si alguna de
            sus líneas va a salir vacía. Los fallos que impiden filtrar (sin
            grupo, grupo borrado, no graba ninguna) salen abajo, en `problema`. */}
        {errorGrupos && <p style={{ margin: '12px 0 0', fontSize: 11, color: tema.pausa }}>{errorGrupos}</p>}
        {grupo && faltan.length > 0 && cubre.length > 0 && (
          <p style={{ margin: '12px 0 0', fontSize: 11, lineHeight: 1.45, color: tema.pausa }}>
            No se graban en el historizador: {faltan.map(nombreDe).join(', ')}. Esas líneas saldrán vacías.
          </p>
        )}

        <label style={rotulo}>
          Rango
          <select value={rango} onChange={(e) => setRango(e.target.value)} style={{ ...campo, cursor: 'pointer' }}>
            {RANGOS.map((r) => (
              <option key={r.v} value={r.v}>
                {r.t}
              </option>
            ))}
          </select>
        </label>

        {rango === 'personalizado' && (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <label style={rotulo}>
              Desde
              <input type="datetime-local" value={desdeLocal} onChange={(e) => setDesdeLocal(e.target.value)} style={campo} />
            </label>
            <label style={rotulo}>
              Hasta
              <input type="datetime-local" value={hastaLocal} onChange={(e) => setHastaLocal(e.target.value)} style={campo} />
            </label>
          </div>
        )}

        <div
          style={{
            marginTop: 10,
            padding: '7px 10px',
            borderRadius: 6,
            background: tema.chapa,
            fontSize: 11,
            fontFamily: 'monospace',
            color: tema.tintaSuave,
          }}
        >
          En la tabla (UTC): {utc(ventana.desde)} → {utc(ventana.hasta)}
        </div>

        <label style={rotulo}>
          Puntos por serie
          <select value={String(limite)} onChange={(e) => setLimite(Number(e.target.value))} style={{ ...campo, cursor: 'pointer' }}>
            {LIMITES.map((n) => (
              <option key={n} value={n}>
                {n}
                {n === 10000 ? ' (máximo)' : ''}
              </option>
            ))}
          </select>
        </label>

        {problema && (grupos !== null || !grupoId) && (
          <p style={{ margin: '12px 0 0', fontSize: 12, color: tema.pausa, fontWeight: 600 }}>{problema}</p>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 18 }}>
          <button type="button" onClick={onCerrar} style={boton(false)}>
            Cancelar
          </button>
          <button type="button" onClick={aplicar} disabled={!!problema} style={boton(true, !!problema)}>
            Aplicar filtro
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
