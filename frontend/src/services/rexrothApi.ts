// =========================================================================
// rexrothApi.ts
// Cliente de los endpoints REST específicos de Bosch Rexroth ctrlX CORE.
//
// Se usan en la pantalla de Login, ANTES de dar de alta el PLC: el backend
// abre una sesión OPC UA temporal con las credenciales que se escriben y
// devuelve qué hay publicado en el controlador, para que el usuario elija.
//
//   POST /rexroth/apps     -> apps bajo Datalayer/plc/app
//   POST /rexroth/programs -> programas (POUs) bajo <app>/sym
//
// Las URLs son RELATIVAS: en dev el proxy de Vite las reenvía al backend
// (8000) y en producción las sirve el propio FastAPI.
// =========================================================================

export interface RexrothCreds {
  ip: string;
  puerto?: number;
  usuario: string;
  password: string;
}

/** Cuerpo común que espera el backend. */
function toBody(creds: RexrothCreds, extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    host: creds.ip.trim(),
    puerto: creds.puerto ?? 4840,
    usuario: creds.usuario.trim(),
    password: creds.password,
    ...extra,
  });
}

/**
 * Lanza un Error con el mensaje que manda FastAPI en `detail`, que ya viene
 * redactado en español y explica si fue de credenciales (401) o de proyecto
 * no publicado (404).
 */
async function parse(r: Response) {
  const data = await r.json().catch(() => null);
  if (!r.ok) {
    const detalle =
      typeof data?.detail === 'string'
        ? data.detail
        : data?.detail
          ? JSON.stringify(data.detail)
          : `HTTP ${r.status}`;
    throw new Error(detalle);
  }
  return data;
}

/** Lista las aplicaciones PLC publicadas en el ctrlX. */
export async function fetchRexrothApps(creds: RexrothCreds): Promise<string[]> {
  const r = await fetch('/rexroth/apps', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: toBody(creds),
  });
  const data = await parse(r);
  return Array.isArray(data?.apps) ? data.apps : [];
}

/** Lista los programas (POUs) de una aplicación del ctrlX. */
export async function fetchRexrothPrograms(
  creds: RexrothCreds,
  app: string
): Promise<string[]> {
  const r = await fetch('/rexroth/programs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: toBody(creds, { app }),
  });
  const data = await parse(r);
  return Array.isArray(data?.programas) ? data.programas : [];
}
