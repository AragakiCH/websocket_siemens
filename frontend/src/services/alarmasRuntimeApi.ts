// =========================================================================
// alarmasRuntimeApi.ts
// Las alarmas EN EJECUCIÓN: lo que está pasando, no lo que está configurado.
//
// LA DIFERENCIA CON `alarmasApi.ts`
//
//   alarmasApi          la CONFIGURACIÓN (`alarmas_def`). Qué vigilar. Se
//                       escribe una vez y no cambia en meses. Va por el CRUD.
//   alarmasRuntimeApi   los EVENTOS (`alarmas`). Qué pasó. Los escribe el
//                       motor del servidor, nunca una persona, y aquí solo
//                       se leen y se reconocen.
//
// QUÉ SIGNIFICA "PENDIENTE"
//
//   SIN RECONOCER. No es "sigue activa", y confundirlo es el error clásico
//   al hacer esta pantalla. Una alarma que saltó de madrugada y se normalizó
//   sola sigue pendiente por la mañana: si desapareciera al normalizarse,
//   quien entra al turno no sabría que hubo un problema, que es justo la
//   información que hace falta.
//
//   Por eso el backend filtra por `ts_reconocimiento IS NULL` y no por
//   `estado`. `estado` cuenta la última transición, que es otra pregunta.
//
// POR QUÉ NO SE HACE POLLING
//
//   Los eventos llegan por el MISMO WebSocket que ya tiene abierto el
//   RealPLCService, reemitidos como evento del navegador (`hmi:ws`). Pedir
//   la lista cada dos segundos con cinco PCs abiertos serían 150 consultas
//   por minuto contra la base para, casi siempre, recibir lo mismo.
//
//   El backend manda el evento COMPLETO, no un "algo cambió": así el banner
//   se actualiza sin una sola petición extra. La recarga por REST queda para
//   el arranque y para el botón de refrescar.
// =========================================================================
import { fetchAuth } from './authApi';

/** Un evento de la tabla `alarmas`, tal como lo devuelve la API. */
export interface EventoAlarma {
  id: number;
  alarma_def_id: number | null;
  plc_prg_id: number | null;
  usuario_id: number | null;
  tipo: string;                 // proceso | equipo | comunicacion | sistema
  area: string | null;
  /** 1 = Critical … 5 = Information. Ordenar por texto no daría gravedad. */
  severidad: number;
  mensaje: string;
  tag: string | null;
  valor_disparo: number | null;
  estado: string;               // activa | reconocida | normalizada
  ts_activacion: string;
  ts_reconocimiento: string | null;
  ts_normalizacion: string | null;
}

export interface Pendientes {
  alarmas: EventoAlarma[];
  total: number;
  /** Cuántas hay de cada severidad. Lo calcula el backend para el banner. */
  por_severidad: Record<string, number>;
  /** La más grave y más antigua. `null` si no hay nada pendiente. */
  peor: EventoAlarma | null;
}

/** Diagnóstico del motor, para la pantalla de configuración. */
export interface EstadoMotor {
  reglas_total: number;
  reglas_activas: number;
  /** Configuradas pero SIN tag: no se evalúan nunca. El número que más importa. */
  reglas_sin_tag: number;
  disparadas_ahora: number;
  tags_vigilados: number;
  valores_evaluados: number;
  eventos_abiertos: number;
  eventos_cerrados: number;
  en_cola: number;
  ultima_recarga: string;
  ultimo_error: string;
  db_id: string;
}

// ─── Presentación ────────────────────────────────────────────────

/**
 * Severidad numérica -> la clase de TIA con la que se configuró.
 *
 * La tabla `alarmas` guarda el número porque ordenar y filtrar por gravedad
 * con texto obligaría a un CASE en cada consulta. La vuelta se hace aquí, y
 * es exacta: el motor usa la misma tabla al escribir (`SEVERIDAD_DE_CLASE`
 * en `alarm_engine.py`).
 */
export const CLASE_DE_SEVERIDAD: Record<number, string> = {
  1: 'Critical',
  2: 'Error',
  3: 'Warning',
  4: 'Maintenance',
  5: 'Information',
};

/**
 * Colores por severidad.
 *
 * Rojo solo para las dos primeras. Si todo fuera rojo, el rojo dejaría de
 * significar nada: una pantalla con quince avisos informativos en rojo
 * entrena al operador a ignorar el color, y el día que salte una crítica de
 * verdad la va a ignorar igual.
 */
export function tonoSeveridad(s: number): {
  texto: string; fondo: string; borde: string; punto: string; banner: string;
} {
  if (s <= 1) {
    return {
      texto: 'text-white',
      fondo: 'bg-state-error',
      borde: 'border-state-error',
      punto: 'bg-white',
      banner: 'bg-state-error text-white',
    };
  }
  if (s === 2) {
    return {
      texto: 'text-state-error',
      fondo: 'bg-state-error/10',
      borde: 'border-state-error/30',
      punto: 'bg-state-error',
      banner: 'bg-state-error/95 text-white',
    };
  }
  if (s === 3) {
    return {
      texto: 'text-state-warn',
      fondo: 'bg-state-warn/10',
      borde: 'border-state-warn/30',
      punto: 'bg-state-warn',
      banner: 'bg-state-warn text-white',
    };
  }
  if (s === 4) {
    return {
      texto: 'text-siemens',
      fondo: 'bg-siemens/10',
      borde: 'border-siemens/30',
      punto: 'bg-siemens',
      banner: 'bg-siemens text-white',
    };
  }
  return {
    texto: 'text-slate-500 dark:text-slate-300',
    fondo: 'bg-slate-100 dark:bg-navy-slate/40',
    borde: 'border-slate-200 dark:border-navy-slate',
    punto: 'bg-slate-400',
    banner: 'bg-slate-600 text-white',
  };
}

/**
 * En qué situación está el evento, en una palabra.
 *
 * Son TRES situaciones y no dos, y la del medio es la que suele faltar en
 * estas pantallas: una alarma puede haberse arreglado sola y seguir
 * esperando a que alguien la vea.
 */
export function situacion(a: EventoAlarma): {
  clave: 'activa' | 'sin_ver' | 'cerrada';
  etiqueta: string;
  ayuda: string;
} {
  if (!a.ts_normalizacion) {
    return {
      clave: 'activa',
      etiqueta: a.ts_reconocimiento ? 'Activa · vista' : 'Activa',
      ayuda: a.ts_reconocimiento
        ? 'La condición sigue cumpliéndose, pero alguien ya la reconoció.'
        : 'La condición se sigue cumpliendo ahora mismo.',
    };
  }
  if (!a.ts_reconocimiento) {
    return {
      clave: 'sin_ver',
      etiqueta: 'Se fue sola',
      ayuda:
        'El valor volvió a la normalidad sin que nadie la reconociera. Sigue ' +
        'pendiente a propósito: es la prueba de que hubo un problema.',
    };
  }
  return {
    clave: 'cerrada',
    etiqueta: 'Cerrada',
    ayuda: 'Normalizada y reconocida.',
  };
}

/** "hace 3 min". Para la columna que se escanea de un vistazo. */
export function haceCuanto(iso: string | null): string {
  if (!iso) return '—';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '—';
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return `hace ${Math.floor(s)} s`;
  if (s < 3600) return `hace ${Math.floor(s / 60)} min`;
  if (s < 86400) return `hace ${Math.floor(s / 3600)} h`;
  return `hace ${Math.floor(s / 86400)} d`;
}

/** Fecha y hora locales completas, para el histórico. */
export function fechaHora(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString(undefined, {
    day: '2-digit', month: '2-digit', year: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

/** El tag sin el prefijo del PLC, para cuando ya se muestra el PLC aparte. */
export function partesTag(tag: string | null): { plc: string; tag: string } {
  const t = (tag ?? '').trim();
  const i = t.indexOf('|');
  return i < 0 ? { plc: '', tag: t } : { plc: t.slice(0, i), tag: t.slice(i + 1) };
}

// ─── Lectura ─────────────────────────────────────────────────────

export async function fetchPendientes(limite = 200): Promise<Pendientes> {
  const d = await fetchAuth(`/alarmas/pendientes?limite=${limite}`);
  return {
    alarmas: d.alarmas ?? [],
    total: d.total ?? 0,
    por_severidad: d.por_severidad ?? {},
    peor: d.peor ?? null,
  };
}

export interface FiltrosHistorico {
  estado?: string;
  severidad?: number;
  tag?: string;
  desde?: string;
  hasta?: string;
  limite?: number;
  offset?: number;
}

export async function fetchHistorico(
  f: FiltrosHistorico = {}
): Promise<{ filas: EventoAlarma[]; total: number }> {
  const q = new URLSearchParams();
  if (f.estado) q.set('estado', f.estado);
  if (f.severidad) q.set('severidad', String(f.severidad));
  if (f.tag) q.set('tag', f.tag);
  if (f.desde) q.set('desde', f.desde);
  if (f.hasta) q.set('hasta', f.hasta);
  q.set('limite', String(f.limite ?? 100));
  q.set('offset', String(f.offset ?? 0));

  const d = await fetchAuth(`/alarmas/historico?${q.toString()}`);
  return { filas: d.filas ?? [], total: d.total ?? 0 };
}

export async function fetchEstadoMotor(): Promise<EstadoMotor> {
  return fetchAuth('/alarmas/estado');
}

// ─── Acciones ────────────────────────────────────────────────────

export async function reconocer(id: number): Promise<any> {
  return fetchAuth(`/alarmas/${id}/reconocer`, { method: 'POST' });
}

export async function reconocerTodas(): Promise<any> {
  return fetchAuth('/alarmas/reconocer-todas', { method: 'POST' });
}

// ─── Eventos en vivo ─────────────────────────────────────────────

/** Los tres tipos que difunde el motor por WebSocket. */
export type TipoEventoWs =
  | 'alarma.activada'
  | 'alarma.normalizada'
  | 'alarma.reconocida';

/**
 * Se suscribe a los eventos de alarma del WebSocket ya abierto.
 *
 * Devuelve la función para darse de baja: hay que llamarla al desmontar, o
 * cada visita a la pantalla dejaría un listener más y el mismo evento se
 * procesaría N veces.
 */
export function alRecibirAlarma(
  cb: (tipo: TipoEventoWs, alarma: any) => void
): () => void {
  const manejar = (ev: Event) => {
    const msg = (ev as CustomEvent).detail;
    const t = msg?.type;
    if (t !== 'alarma.activada' && t !== 'alarma.normalizada' &&
        t !== 'alarma.reconocida') {
      return;
    }
    cb(t, msg.alarma ?? {});
  };
  window.addEventListener('hmi:ws', manejar as EventListener);
  return () => window.removeEventListener('hmi:ws', manejar as EventListener);
}
