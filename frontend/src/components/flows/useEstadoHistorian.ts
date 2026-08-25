import { useCallback, useEffect, useRef, useState } from 'react';
import { GrupoRemoto, cargarGrupos } from './api';

/**
 * Estado EN VIVO de los grupos del historizador.
 *
 * Existe porque el lienzo es solo un dibujo en localStorage: un nodo puede
 * mostrar un check verde de hace tres días mientras el grupo real ya se detuvo
 * (o al revés, seguir capturando aunque nadie lo dibuje). Este hook trae la
 * verdad del servidor cada pocos segundos para que la UI no mienta.
 *
 * Se usa para dos cosas:
 *   * el badge de "capturando / detenido" en los nodos Historian, y
 *   * la confirmación al borrar un nodo cuyo grupo sigue activo.
 */
export function useEstadoHistorian(intervaloMs = 8000) {
  const [grupos, setGrupos] = useState<Map<string, GrupoRemoto>>(new Map());
  const [error, setError] = useState('');
  // Evita pisar el estado si el componente se desmonta a mitad del fetch.
  const vivoRef = useRef(true);

  const refrescar = useCallback(async () => {
    try {
      const lista = await cargarGrupos();
      if (!vivoRef.current) return;
      setGrupos(new Map(lista.map((g) => [g.grupo_id, g])));
      setError('');
    } catch (err: any) {
      if (!vivoRef.current) return;
      // Se conserva el último estado conocido: es más útil mostrar datos de
      // hace 8 segundos que vaciar los badges cada vez que hay un hipo de red.
      setError(err?.message || 'No se pudo leer el estado del historizador.');
    }
  }, []);

  useEffect(() => {
    vivoRef.current = true;
    refrescar();

    const tick = () => {
      // Si la pestaña está en segundo plano no tiene sentido sondear:
      // nadie está mirando los badges.
      if (!document.hidden) refrescar();
    };
    const id = window.setInterval(tick, intervaloMs);

    // Al volver a la pestaña, refresco inmediato en vez de esperar el ciclo.
    const alVolver = () => { if (!document.hidden) refrescar(); };
    document.addEventListener('visibilitychange', alVolver);

    return () => {
      vivoRef.current = false;
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', alVolver);
    };
  }, [intervaloMs, refrescar]);

  return { grupos, error, refrescar };
}
