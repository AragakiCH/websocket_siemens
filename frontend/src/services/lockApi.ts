// =========================================================================
// lockApi.ts
// Cliente del "lápiz" de edición (Fase 4).
//
// Idea: un solo usuario edita a la vez; el resto ve los cambios en vivo pero
// en modo lectura. Sin esto, dos personas arrastrando el mismo widget generan
// una pelea silenciosa que acaba en un 409 y en "¿por qué se me movió esto?".
//
// Ciclo de vida desde la vista:
//
//   1. Al ENTRAR al Diseñador  -> adquirirLock()
//   2. Mientras se edita       -> renovarLock() cada ~10 s  (lo hace useLock)
//   3. Al SALIR                -> liberarLock()
//
// Si el navegador desaparece sin liberar (se cierra el portátil, se cae la
// red), el backend lo suelta solo a los 30 s. Por eso el heartbeat: es lo que
// distingue "sigo aquí trabajando" de "me fui".
// =========================================================================
import { fetchAuth } from './authApi';

export interface Titular {
  recurso: string;
  usuario: string;
  categoria: string;
  adquirido: string;
  ultimo_latido: string;
  segundos_restantes: number;
}

export interface RespuestaLock {
  ok: boolean;
  concedido: boolean;
  recurso: string;
  titular?: Titular;
  heartbeat_s?: number;
  ttl_s?: number;
  mensaje?: string;
}

/** Nombre del lock de un proyecto. Debe coincidir con el del backend. */
export function recursoDisenador(projectId: string): string {
  return `designer:${projectId}`;
}

/**
 * Pide el control de edición.
 *
 * OJO: que devuelva `concedido: false` NO es un error — significa que lo tiene
 * otra persona. La vista pasa a modo lectura y sigue viendo los cambios en
 * vivo. Por eso se capturan los errores HTTP y se devuelve una respuesta
 * normal: un fallo de red tampoco debe romper la pantalla, solo dejarla en
 * lectura.
 */
export async function adquirirLock(recurso: string): Promise<RespuestaLock> {
  try {
    return await fetchAuth(`/locks/${encodeURIComponent(recurso)}/adquirir`, {
      method: 'POST',
    });
  } catch (e: any) {
    return {
      ok: false,
      concedido: false,
      recurso,
      mensaje: e?.message ?? 'No se pudo pedir el control de edición.',
    };
  }
}

/** Heartbeat. Si devuelve `concedido: false`, hay que pasar a lectura YA. */
export async function renovarLock(recurso: string): Promise<RespuestaLock> {
  try {
    return await fetchAuth(`/locks/${encodeURIComponent(recurso)}/renovar`, {
      method: 'POST',
    });
  } catch {
    // Un fallo de red puntual no debe quitarte el lápiz: el backend todavía
    // te lo guarda durante 30 s. Se reintenta en el siguiente latido.
    return { ok: false, concedido: true, recurso };
  }
}

export async function liberarLock(recurso: string): Promise<void> {
  try {
    await fetchAuth(`/locks/${encodeURIComponent(recurso)}/liberar`, {
      method: 'POST',
    });
  } catch {
    /* si falla, caduca solo a los 30 s */
  }
}

/** Toma de control. Solo Supervisor; el backend lo comprueba. */
export async function forzarLock(recurso: string): Promise<RespuestaLock> {
  return fetchAuth(`/locks/${encodeURIComponent(recurso)}/forzar`, {
    method: 'POST',
  });
}

export async function listarLocks(): Promise<Titular[]> {
  const d = await fetchAuth('/locks');
  return d.locks ?? [];
}

/**
 * Envía la liberación aunque la pestaña se esté cerrando.
 *
 * `fetch` normal se cancela cuando el navegador descarga la página, así que en
 * `beforeunload` no llega. `sendBeacon` está pensado exactamente para esto: el
 * navegador lo entrega en segundo plano. No admite cabeceras, por eso el token
 * va en el query string (el backend lo acepta ahí por el WebSocket).
 */
export function liberarLockAlCerrar(recurso: string, token: string): void {
  const url =
    `/locks/${encodeURIComponent(recurso)}/liberar` +
    (token ? `?token=${encodeURIComponent(token)}` : '');
  try {
    if (navigator.sendBeacon) {
      navigator.sendBeacon(url, new Blob([], { type: 'text/plain' }));
      return;
    }
  } catch {
    /* cae al fetch de abajo */
  }
  void fetch(url, { method: 'POST', keepalive: true }).catch(() => {});
}
