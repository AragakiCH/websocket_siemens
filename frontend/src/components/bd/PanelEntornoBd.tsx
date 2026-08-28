// =========================================================================
// PanelEntornoBd.tsx
// "¿Qué me falta instalar para poder crear la base de datos?"
//
// POR QUÉ EXISTE, SI YA HAY UN DIAGNÓSTICO
//
//   `PanelDiagnostico` explica un error de conexión. Pero para tener un error
//   hay que haber rellenado host, usuario y contraseña de algo que quizá ni
//   está instalado. Quien estrena Psi Core en un PC nuevo no tiene un problema
//   de credenciales: no tiene SQL Server. Y «no se pudo conectar a
//   localhost:1433» no se lo dice — parece que hizo algo mal.
//
//   Esto se pregunta ANTES, sin datos y sin intentar nada, y responde lo único
//   que sirve en ese momento: qué falta, por qué hace falta y cómo se instala.
//
// LA DISTINCIÓN QUE MÁS TIEMPO AHORRA
//
//   El driver ODBC **no es un paquete de pip**. Es un componente de Windows.
//   `pip install pyodbc` no lo instala nunca, y ese malentendido es el que
//   convierte un `IM002` en una tarde perdida.
// =========================================================================
import React, { useEffect, useState } from 'react';
import {
  AlertCircleIcon,
  CheckCircle2Icon,
  ExternalLinkIcon,
  HardDriveDownloadIcon,
  InfoIcon,
  Loader2Icon,
  RefreshCwIcon,
} from 'lucide-react';
import { apiGet } from '../flows/api';

export interface FaltanteEntorno {
  que: string;
  por_que: string;
  como: string;
  enlace?: string;
  /** `false` = recomendación, no requisito. SSMS, por ejemplo. */
  critico: boolean;
}

export interface EntornoBd {
  ok: boolean;
  motor: string;
  etiqueta: string;
  listo: boolean;
  es_windows: boolean;
  instalado: {
    paquete?: boolean;
    drivers_odbc?: string[];
    drivers_compatibles?: string[];
    instancias?: string[];
    puerto?: number;
    puerto_abierto?: boolean;
    host?: string;
  };
  faltantes: FaltanteEntorno[];
  mensaje: string;
}

export function PanelEntornoBd({
  motor,
  host,
  puerto,
}: {
  motor: string;
  host?: string;
  puerto?: number | null;
}) {
  const [datos, setDatos] = useState<EntornoBd | null>(null);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState('');

  const consultar = React.useCallback(async () => {
    setCargando(true);
    try {
      const p = new URLSearchParams({ motor });
      if (host) p.set('host', host);
      if (puerto) p.set('puerto', String(puerto));
      setDatos(await apiGet<EntornoBd>(`/db/entorno?${p}`));
      setError('');
    } catch (e: any) {
      setError(e?.message ?? 'No se pudo revisar este equipo.');
    } finally {
      setCargando(false);
    }
  }, [motor, host, puerto]);

  useEffect(() => {
    void consultar();
  }, [consultar]);

  if (cargando && !datos) {
    return (
      <p className="mt-3 flex items-center gap-2 text-xs text-slate-400">
        <Loader2Icon className="h-3.5 w-3.5 animate-spin" />
        Revisando qué hay instalado en este equipo…
      </p>
    );
  }

  if (error) {
    return (
      <p className="mt-3 flex items-start gap-2 text-xs leading-relaxed text-state-error">
        <AlertCircleIcon className="mt-px h-3.5 w-3.5 shrink-0" />
        <span className="min-w-0">{error}</span>
      </p>
    );
  }

  if (!datos) return null;

  const criticos = datos.faltantes.filter((f) => f.critico);
  const sugerencias = datos.faltantes.filter((f) => !f.critico);

  return (
    <div className="mt-3 rounded-xl border border-slate-200 bg-slate-50/60 p-3.5 dark:border-navy-slate dark:bg-navy/40">
      <div className="flex items-start gap-2.5">
        <span
          className={`mt-px flex h-6 w-6 shrink-0 items-center justify-center rounded-md ${
            datos.listo
              ? 'bg-state-ok/10 text-state-ok'
              : 'bg-amber-500/10 text-amber-600 dark:text-amber-400'
          }`}
        >
          {datos.listo ? (
            <CheckCircle2Icon className="h-3.5 w-3.5" />
          ) : (
            <HardDriveDownloadIcon className="h-3.5 w-3.5" />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-semibold text-navy dark:text-slate-100">
            {datos.listo
              ? `Este equipo ya tiene lo necesario para ${datos.etiqueta}`
              : `Falta instalar algo para poder usar ${datos.etiqueta}`}
          </p>
          <p className="mt-0.5 text-[11.5px] leading-relaxed text-slate-500 dark:text-slate-400">
            {datos.mensaje}
          </p>
        </div>
        <button
          type="button"
          onClick={() => void consultar()}
          title="Volver a revisar"
          className="shrink-0 rounded-md p-1 text-slate-400 transition hover:bg-slate-200/70 hover:text-slate-600 dark:hover:bg-navy-slate/50"
        >
          <RefreshCwIcon className={`h-3.5 w-3.5 ${cargando ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {/* Lo que hay. Va arriba y en corto: saber qué SÍ está evita repetir
          una instalación que ya se hizo. */}
      <Estado datos={datos} />

      {criticos.length > 0 && (
        <ol className="mt-3 space-y-2.5">
          {criticos.map((f, i) => (
            <Paso key={f.que} numero={i + 1} f={f} />
          ))}
        </ol>
      )}

      {sugerencias.length > 0 && (
        <div className="mt-3 space-y-2">
          {sugerencias.map((f) => (
            <p
              key={f.que}
              className="flex items-start gap-2 text-[11px] leading-relaxed text-slate-400"
            >
              <InfoIcon className="mt-px h-3 w-3 shrink-0" />
              <span className="min-w-0">
                <b className="font-semibold">{f.que}.</b> {f.por_que}{' '}
                {f.enlace && <Enlace href={f.enlace}>Descargar</Enlace>}
              </span>
            </p>
          ))}
        </div>
      )}

      {/* La frase que evita la pregunta "¿por qué no lo instalas tú?". */}
      {criticos.length > 0 && (
        <p className="mt-3 border-t border-slate-200 pt-2.5 text-[11px] leading-relaxed text-slate-400 dark:border-navy-slate">
          Psi Core no descarga ni instala nada por su cuenta: son cientos de
          megas, hace falta ser administrador y una instalación a medias
          dejaría este equipo en un estado que el programa no sabría arreglar.
          Cuando termines, pulsa el botón de recargar de aquí arriba.
        </p>
      )}
    </div>
  );
}

/** Lo que sí está. Tres líneas como mucho: es contexto, no la acción. */
function Estado({ datos }: { datos: EntornoBd }) {
  const i = datos.instalado;
  const filas: Array<[string, boolean, string]> = [];

  if (datos.motor === 'mssql') {
    filas.push([
      'Driver ODBC',
      (i.drivers_compatibles?.length ?? 0) > 0,
      i.drivers_compatibles?.[0] ?? 'ninguno instalado',
    ]);
    if (datos.es_windows) {
      filas.push([
        'SQL Server en este equipo',
        (i.instancias?.length ?? 0) > 0,
        i.instancias?.length ? i.instancias.join(', ') : 'ninguna instancia',
      ]);
    }
  }
  filas.push([
    `Puerto ${i.puerto ?? ''}`,
    !!i.puerto_abierto,
    i.puerto_abierto ? 'responde' : 'sin respuesta',
  ]);

  return (
    <ul className="mt-2.5 space-y-1">
      {filas.map(([etiqueta, ok, detalle]) => (
        <li key={etiqueta} className="flex items-center gap-2 text-[11px]">
          <span
            aria-hidden="true"
            className={`h-1.5 w-1.5 shrink-0 rounded-full ${
              ok ? 'bg-state-ok' : 'bg-state-error'
            }`}
          />
          <span className="shrink-0 text-slate-500 dark:text-slate-400">
            {etiqueta}
          </span>
          <span className="min-w-0 truncate font-mono text-slate-400">
            {detalle}
          </span>
        </li>
      ))}
    </ul>
  );
}

/**
 * Un paso. Numerado porque el ORDEN importa: instalar el driver ODBC sin
 * tener SQL Server no arregla nada, y saltarse el primero hace que el
 * segundo parezca roto.
 */
function Paso({ numero, f }: { numero: number; f: FaltanteEntorno }) {
  return (
    <li className="flex items-start gap-2.5 rounded-lg border border-slate-200 bg-white p-2.5 dark:border-navy-slate dark:bg-navy-soft">
      <span className="mt-px flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-siemens-50 text-[11px] font-bold text-siemens dark:bg-siemens/15 dark:text-siemens-200">
        {numero}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-xs font-semibold text-navy dark:text-slate-100">
          {f.que}
        </p>
        <p className="mt-0.5 text-[11px] leading-relaxed text-slate-500 dark:text-slate-400">
          {f.por_que}
        </p>
        <p className="mt-1.5 text-[11px] leading-relaxed text-slate-400">
          {f.como}
        </p>
        {f.enlace && (
          <p className="mt-1.5">
            <Enlace href={f.enlace}>Página oficial de descarga</Enlace>
          </p>
        )}
      </div>
    </li>
  );
}

function Enlace({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      className="inline-flex items-center gap-1 text-[11px] font-semibold text-siemens underline-offset-2 transition hover:underline"
    >
      {children}
      <ExternalLinkIcon className="h-3 w-3" />
    </a>
  );
}
