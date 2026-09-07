// =========================================================================
// BannerAlarmas.tsx
// La franja que aparece cuando hay algo que atender.
//
// POR QUÉ UNA FRANJA Y NO UN AVISO QUE SE VA SOLO
//
//   Un toast desaparece a los cinco segundos. Si el operador estaba mirando
//   la máquina en vez de la pantalla —que es lo normal— la alarma pasó y no
//   queda nada. La franja se queda hasta que alguien la reconoce: ese es
//   todo el punto de reconocer.
//
// NO SE MONTA SI NO HAY NADA
//
//   Cuando no hay pendientes, el componente no ocupa ni un píxel. Un hueco
//   permanente "reservado por si acaso" movería toda la interfaz hacia abajo
//   el día que salte algo, que es el peor momento para que se mueva.
//
// DE DÓNDE SALE LA INFORMACIÓN
//
//   Una lectura al montar y, a partir de ahí, los eventos del WebSocket que
//   ya está abierto. No hay polling: con cinco PCs, preguntar cada dos
//   segundos serían 150 consultas por minuto contra la base para recibir lo
//   mismo casi siempre.
//
//   Lo que sí se hace al recibir un evento es RECARGAR la lista en vez de
//   modificarla en memoria. Suena a lo contrario de lo eficiente, pero:
//   normalizar una alarma no la quita de pendientes (sigue sin reconocer),
//   reconocerla sí, y el orden depende de la severidad. Reimplementar esas
//   tres reglas aquí es garantizar que un día se separen de las del backend
//   y el banner muestre algo distinto de lo que dice la pantalla de alarmas.
//   Una consulta por evento de alarma es baratísima: no saltan cien por
//   segundo.
// =========================================================================
import { useCallback, useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import {
  AlertTriangleIcon,
  CheckIcon,
  ChevronRightIcon,
  Loader2Icon,
} from 'lucide-react';
import {
  CLASE_DE_SEVERIDAD,
  alRecibirAlarma,
  fetchPendientes,
  haceCuanto,
  partesTag,
  reconocer,
  tonoSeveridad,
  type EventoAlarma,
} from '../../services/alarmasRuntimeApi';

/**
 * Dónde NO se muestra.
 *
 *   `/`          el acceso. Todavía no hay sesión: la consulta daría 401 y,
 *                sobre todo, avisar de una alarma a quien aún no ha entrado
 *                no sirve de nada.
 *   `/alarmas`   la pantalla de alarmas. La franja repetiría, encima de la
 *                lista completa, la primera fila de esa misma lista.
 */
const RUTAS_SIN_BANNER = ['/', '/alarmas'];

export function BannerAlarmas() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const oculto = RUTAS_SIN_BANNER.includes(pathname);
  const [peor, setPeor] = useState<EventoAlarma | null>(null);
  const [total, setTotal] = useState(0);
  const [ocupado, setOcupado] = useState(false);
  // Un fallo aquí NO se enseña. Si el motor está apagado o la base no
  // responde, el banner simplemente no aparece: una franja de error
  // permanente sobre el HMI sería peor que no tener banner, y el problema
  // ya se ve, explicado, en la pantalla de alarmas.
  const [silenciado, setSilenciado] = useState(false);

  const refrescar = useCallback(async () => {
    try {
      const p = await fetchPendientes(50);
      setPeor(p.peor);
      setTotal(p.total);
      setSilenciado(false);
    } catch {
      setSilenciado(true);
      setPeor(null);
      setTotal(0);
    }
  }, []);

  useEffect(() => {
    // En las rutas ocultas no se pide nada: el componente sigue montado
    // (está por encima del router), pero no debe generar tráfico ni un 401
    // en la consola de quien está en la pantalla de acceso.
    if (oculto) return;
    void refrescar();
    return alRecibirAlarma(() => {
      void refrescar();
    });
  }, [refrescar, oculto]);

  // El "hace X" se queda congelado si nadie vuelve a dibujar. Un minuto es
  // suficiente: la unidad más pequeña que se muestra son los segundos, y
  // ver "hace 45 s" cuando van 70 no engaña a nadie sobre lo importante.
  const [, tick] = useState(0);
  useEffect(() => {
    if (!peor) return;
    const t = window.setInterval(() => tick((n) => n + 1), 30000);
    return () => window.clearInterval(t);
  }, [peor]);

  const reconocerPeor = async () => {
    if (!peor) return;
    setOcupado(true);
    try {
      await reconocer(peor.id);
      await refrescar();
    } catch {
      // Casi siempre es un 403: hace falta al menos `Usuarios` para firmar
      // el reconocimiento. Se manda a la pantalla, que sí lo explica.
      navigate('/alarmas');
    } finally {
      setOcupado(false);
    }
  };

  if (oculto || silenciado || !peor) return null;

  const tono = tonoSeveridad(peor.severidad);
  const { plc, tag } = partesTag(peor.tag);
  const otras = Math.max(0, total - 1);
  // Solo las dos clases más graves parpadean. Si todo parpadeara, el
  // parpadeo dejaría de significar "mira esto ahora".
  const urgente = peor.severidad <= 2 && !peor.ts_reconocimiento;

  return (
    <AnimatePresence>
      <motion.div
        initial={{ height: 0, opacity: 0 }}
        animate={{ height: 'auto', opacity: 1 }}
        exit={{ height: 0, opacity: 0 }}
        transition={{ duration: 0.18 }}
        role="alert"
        aria-live="assertive"
        className="shrink-0 overflow-hidden"
      >
        <div className={`flex items-center gap-3 px-4 py-2 ${tono.banner}`}>
          <AlertTriangleIcon
            className={`h-4 w-4 shrink-0 ${urgente ? 'animate-pulse' : ''}`}
          />

          <div className="flex min-w-0 flex-1 items-baseline gap-2">
            <span className="shrink-0 rounded bg-white/20 px-1.5 py-px text-[10px] font-bold uppercase tracking-wide">
              {CLASE_DE_SEVERIDAD[peor.severidad] ?? 'Alarma'}
            </span>
            <span className="truncate text-[13px] font-semibold">
              {peor.mensaje}
            </span>
            {tag && (
              <span className="hidden shrink-0 font-mono text-[11px] opacity-75 sm:inline">
                {plc ? `${plc} · ` : ''}{tag}
                {peor.valor_disparo !== null && ` = ${peor.valor_disparo}`}
              </span>
            )}
            <span className="shrink-0 text-[11px] opacity-75">
              {haceCuanto(peor.ts_activacion)}
            </span>
            {/* Se avisa cuando la condición ya pasó: cambia por completo lo
                que el operador tiene que hacer con esto. */}
            {peor.ts_normalizacion && (
              <span
                className="hidden shrink-0 rounded bg-white/20 px-1.5 py-px text-[10px] font-semibold sm:inline"
                title="El valor ya volvió a la normalidad. Sigue aquí porque nadie la ha reconocido."
              >
                ya normalizada
              </span>
            )}
          </div>

          {otras > 0 && (
            <button
              onClick={() => navigate('/alarmas')}
              className="hidden shrink-0 rounded-md bg-white/20 px-2 py-1 text-[11px] font-semibold transition hover:bg-white/30 md:block"
            >
              +{otras} más
            </button>
          )}

          <button
            onClick={() => void reconocerPeor()}
            disabled={ocupado}
            title="Reconocer: dejar constancia de que la has visto. Queda firmado con tu nombre."
            className="flex shrink-0 items-center gap-1 rounded-md bg-white/20 px-2.5 py-1 text-[11px] font-semibold transition hover:bg-white/30 disabled:opacity-50"
          >
            {ocupado ? (
              <Loader2Icon className="h-3 w-3 animate-spin" />
            ) : (
              <CheckIcon className="h-3 w-3" />
            )}
            Reconocer
          </button>

          <button
            onClick={() => navigate('/alarmas')}
            aria-label="Ver todas las alarmas"
            className="flex shrink-0 items-center gap-0.5 rounded-md px-1.5 py-1 text-[11px] font-semibold transition hover:bg-white/20"
          >
            Ver todas
            <ChevronRightIcon className="h-3.5 w-3.5" />
          </button>
        </div>
      </motion.div>
    </AnimatePresence>
  );
}
