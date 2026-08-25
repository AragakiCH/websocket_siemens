// =========================================================================
// useLock.ts
// Hook que gestiona el "lápiz" de edición de un recurso.
//
// Encapsula todo el ciclo para que la vista no tenga que pensarlo:
//
//   * Al montar: pide el control.
//   * Mientras lo tiene: heartbeat cada `heartbeat_s` (lo dice el backend).
//   * Al desmontar: lo libera.
//   * Si la pestaña se cierra: lo libera con `sendBeacon` (un fetch normal se
//     cancela al descargar la página y no llegaría).
//   * Escucha `lock.changed` por WebSocket: si otro toma el control, esta
//     vista pasa a lectura al INSTANTE, sin esperar al siguiente latido.
//
// Devuelve `puedeEditar`, que es lo único que la vista necesita saber.
// =========================================================================
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  adquirirLock,
  renovarLock,
  liberarLock,
  liberarLockAlCerrar,
  forzarLock,
  Titular } from
'../services/lockApi';
import { getToken } from '../services/authApi';

export interface EstadoLock {
  /** True si esta pestaña tiene el control de edición. */
  puedeEditar: boolean;
  /** Quién lo tiene, si no soy yo. */
  titular: Titular | null;
  /** Mensaje explicativo para la barra superior. */
  mensaje: string;
  /** Todavía preguntando al servidor. */
  cargando: boolean;
  /** Toma de control (solo Supervisor; el backend lo verifica). */
  tomarControl: () => Promise<void>;
  /** Reintenta pedirlo (cuando el otro lo suelta). */
  reintentar: () => Promise<void>;
}

export function useLock(recurso: string, activo: boolean = true): EstadoLock {
  const [puedeEditar, setPuedeEditar] = useState(false);
  const [titular, setTitular] = useState<Titular | null>(null);
  const [mensaje, setMensaje] = useState('');
  const [cargando, setCargando] = useState(true);

  // En un ref además del estado: el intervalo del heartbeat lo lee sin
  // volver a crearse en cada render.
  const loTengo = useRef(false);
  const intervalo = useRef<ReturnType<typeof setInterval> | null>(null);

  const aplicar = useCallback((r: any) => {
    const concedido = !!r?.concedido;
    loTengo.current = concedido;
    setPuedeEditar(concedido);
    setTitular(concedido ? null : r?.titular ?? null);
    setMensaje(r?.mensaje ?? '');
  }, []);

  const pedir = useCallback(async () => {
    setCargando(true);
    const r = await adquirirLock(recurso);
    aplicar(r);
    setCargando(false);
  }, [recurso, aplicar]);

  const tomarControl = useCallback(async () => {
    try {
      const r = await forzarLock(recurso);
      aplicar(r);
    } catch (e: any) {
      setMensaje(e?.message ?? 'No se pudo tomar el control.');
    }
  }, [recurso, aplicar]);

  // ---- Ciclo de vida --------------------------------------------------- //
  useEffect(() => {
    if (!activo) return;
    let vivo = true;

    void (async () => {
      await pedir();
      if (!vivo) return;

      // Heartbeat. Si el backend responde `concedido: false`, alguien tomó el
      // control o caducó: se pasa a lectura sin esperar a fallar al guardar.
      intervalo.current = setInterval(async () => {
        if (!loTengo.current) return;
        const r = await renovarLock(recurso);
        if (!r.concedido) aplicar(r);
      }, 10_000);
    })();

    // Cierre de pestaña: `fetch` normal no llega, `sendBeacon` sí.
    const alCerrar = () => {
      if (loTengo.current) liberarLockAlCerrar(recurso, getToken());
    };
    window.addEventListener('beforeunload', alCerrar);

    return () => {
      vivo = false;
      window.removeEventListener('beforeunload', alCerrar);
      if (intervalo.current) clearInterval(intervalo.current);
      // Salir del Diseñador suelta el lápiz de inmediato, sin esperar los 30 s.
      if (loTengo.current) {
        loTengo.current = false;
        void liberarLock(recurso);
      }
    };
  }, [recurso, activo, pedir, aplicar]);

  // ---- Cambios de otros, por WebSocket --------------------------------- //
  useEffect(() => {
    if (!activo) return;
    const alEvento = (ev: Event) => {
      const msg = (ev as CustomEvent).detail;
      if (!msg || msg.type !== 'lock.changed' || msg.recurso !== recurso) return;

      if (msg.accion === 'liberado' || msg.accion === 'caducado') {
        // Quedó libre: se avisa, pero NO se toma solo. Tomarlo automáticamente
        // haría que la primera pestaña que reaccione gane sin que nadie lo
        // pidiera, y el usuario vería su pantalla cambiar de modo sola.
        if (!loTengo.current) {
          setTitular(null);
          setMensaje('El control quedó libre. Pulsa "Tomar control" para editar.');
        }
        return;
      }

      const nuevoTitular: Titular | null = msg.titular ?? null;
      const yo = loTengo.current;
      if (yo && nuevoTitular && msg.accion === 'forzado') {
        // Me quitaron el lápiz. A lectura, y con un mensaje claro: es la
        // situación en la que un usuario más se confundiría.
        loTengo.current = false;
        setPuedeEditar(false);
        setTitular(nuevoTitular);
        setMensaje(
          `${nuevoTitular.usuario} tomó el control de edición. ` +
          `Tus cambios guardados se conservan.`
        );
      } else if (!yo && nuevoTitular) {
        setTitular(nuevoTitular);
        setMensaje(`${nuevoTitular.usuario} está editando.`);
      }
    };
    window.addEventListener('hmi:ws', alEvento as EventListener);
    return () => window.removeEventListener('hmi:ws', alEvento as EventListener);
  }, [recurso, activo]);

  return { puedeEditar, titular, mensaje, cargando, tomarControl, reintentar: pedir };
}
