// =========================================================================
// PanelCarpetaDatos.tsx — dónde están mis datos, y cómo me los llevo
//
// Responde tres preguntas que aparecen siempre y que nadie debería tener que
// buscar en un manual: dónde han quedado mis cosas, cómo las paso al otro
// equipo, y cómo las recupero después de actualizar.
//
// La copia en .zip es además la respuesta a "quiero verlo en Documentos": la
// carpeta de trabajo vive donde tiene que vivir —compartida entre usuarios de
// Windows y fuera del alcance del desinstalador— y el respaldo se guarda donde
// a cada uno le convenga.
// =========================================================================
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertCircleIcon,
  CheckCircle2Icon,
  DownloadIcon,
  FolderOpenIcon,
  HardDriveIcon,
  Loader2Icon,
  RotateCcwIcon,
} from 'lucide-react';
import { apiGet, apiPost, API_BASE } from '../flows/api';
import { getToken } from '../../services/authApi';

interface EstadoDatos {
  ruta: string;
  origen: string;
  empaquetado: boolean;
  escribible: boolean;
  num_ficheros: number;
  bytes: number;
}

function tamano(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function PanelCarpetaDatos() {
  const [estado, setEstado] = useState<EstadoDatos | null>(null);
  const [mensaje, setMensaje] = useState('');
  const [error, setError] = useState('');
  const [trabajando, setTrabajando] = useState('');
  const inputZip = useRef<HTMLInputElement>(null);

  const cargar = useCallback(async () => {
    try {
      setEstado(await apiGet<EstadoDatos>('/sistema/datos'));
      setError('');
    } catch (e: any) {
      setError(e?.message ?? 'No se pudo consultar la carpeta de datos.');
    }
  }, []);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  const abrir = async () => {
    setTrabajando('abrir');
    setMensaje('');
    setError('');
    try {
      const r = await apiPost<{ ok: boolean; mensaje: string }>(
        '/sistema/datos/abrir'
      );
      if (r.ok) setMensaje(r.mensaje);
      else setError(r.mensaje);
    } catch (e: any) {
      setError(e?.message ?? 'No se pudo abrir la carpeta.');
    } finally {
      setTrabajando('');
    }
  };

  // La descarga no puede ir por `apiGet`: la respuesta es un binario y hace
  // falta el token en la cabecera, que un <a href> no sabe poner.
  const descargar = async () => {
    setTrabajando('backup');
    setMensaje('');
    setError('');
    try {
      const token = getToken();
      const r = await fetch(`${API_BASE}/sistema/datos/backup`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!r.ok) throw new Error(`El servidor respondió ${r.status}.`);
      const blob = await r.blob();
      const cd = r.headers.get('Content-Disposition') || '';
      const nombre =
        /filename="([^"]+)"/.exec(cd)?.[1] ?? 'psicore-config.zip';
      const url = URL.createObjectURL(blob);
      Object.assign(document.createElement('a'), {
        href: url,
        download: nombre,
      }).click();
      URL.revokeObjectURL(url);
      setMensaje(`Copia descargada: ${nombre}`);
    } catch (e: any) {
      setError(e?.message ?? 'No se pudo generar la copia.');
    } finally {
      setTrabajando('');
    }
  };

  const restaurar = async (archivo: File) => {
    setTrabajando('restaurar');
    setMensaje('');
    setError('');
    try {
      const cuerpo = new FormData();
      cuerpo.append('archivo', archivo);
      const token = getToken();
      const r = await fetch(`${API_BASE}/sistema/datos/restaurar`, {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: cuerpo,
      });
      const d = await r.json().catch(() => null);
      if (!r.ok || d?.ok === false) {
        throw new Error(d?.detail ?? d?.mensaje ?? `HTTP ${r.status}`);
      }
      setMensaje(d.mensaje);
      await cargar();
    } catch (e: any) {
      setError(e?.message ?? 'No se pudo restaurar.');
    } finally {
      setTrabajando('');
      if (inputZip.current) inputZip.current.value = '';
    }
  };

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-card dark:border-navy-slate dark:bg-navy-soft">
      <div className="flex items-start gap-2.5">
        <HardDriveIcon className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" />
        <div className="min-w-0 flex-1">
          <p className="break-all font-mono text-[12px] font-semibold text-navy dark:text-slate-100">
            {estado?.ruta ?? '…'}
          </p>
          <p className="mt-0.5 text-[11px] text-slate-400">
            {estado
              ? `${estado.origen} · ${estado.num_ficheros} fichero(s) · ${tamano(estado.bytes)}`
              : 'Consultando…'}
          </p>
        </div>
      </div>

      {/* Sin permiso de escritura el servicio arranca igual y pierde todo lo
          que se haga en él. Eso no es una advertencia menor. */}
      {estado && !estado.escribible && (
        <p className="mt-3 flex items-start gap-2 rounded-lg border border-state-error/30 bg-state-error/5 px-3 py-2.5 text-xs leading-relaxed text-state-error">
          <AlertCircleIcon className="mt-px h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0">
            <strong>No se puede escribir en esa carpeta.</strong> El servicio
            funciona, pero todo lo que configures se perderá al cerrarlo.
            Ejecuta como administrador, o define <code>PLC_DATOS_DIR</code> en
            el <code>.env</code> apuntando a una carpeta con permisos.
          </span>
        </p>
      )}

      <p className="mt-3 text-[11px] leading-relaxed text-slate-400">
        Aquí viven los PLCs, las pantallas del diseñador, las conexiones a base
        de datos y las cuentas. Esta carpeta <strong>no se borra</strong> al
        desinstalar ni al instalar una versión nueva, y la comparten todos los
        usuarios de Windows del equipo.
      </p>

      <div className="mt-4 flex flex-wrap gap-2">
        <button
          onClick={() => void abrir()}
          disabled={!!trabajando}
          className="flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-600 transition hover:border-siemens/40 hover:text-siemens disabled:opacity-50 dark:border-navy-slate dark:text-slate-300"
        >
          {trabajando === 'abrir' ? (
            <Loader2Icon className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <FolderOpenIcon className="h-3.5 w-3.5" />
          )}
          Abrir carpeta
        </button>

        <button
          onClick={() => void descargar()}
          disabled={!!trabajando}
          className="flex items-center gap-1.5 rounded-lg bg-siemens px-3 py-2 text-xs font-semibold text-white transition hover:bg-siemens-600 disabled:opacity-50"
        >
          {trabajando === 'backup' ? (
            <Loader2Icon className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <DownloadIcon className="h-3.5 w-3.5" />
          )}
          Descargar copia
        </button>

        <button
          onClick={() => inputZip.current?.click()}
          disabled={!!trabajando}
          className="flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-600 transition hover:border-amber-400 hover:text-amber-600 disabled:opacity-50 dark:border-navy-slate dark:text-slate-300"
        >
          {trabajando === 'restaurar' ? (
            <Loader2Icon className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <RotateCcwIcon className="h-3.5 w-3.5" />
          )}
          Restaurar…
        </button>
        <input
          ref={inputZip}
          type="file"
          accept=".zip"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void restaurar(f);
          }}
        />
      </div>

      <p className="mt-2.5 text-[11px] leading-relaxed text-slate-400">
        La copia incluye la clave que descifra las contraseñas de base de datos:
        guárdala como guardarías una contraseña. Al restaurar hay que{' '}
        <strong>reiniciar el servicio</strong>, y la configuración anterior se
        conserva en una carpeta con fecha por si hiciera falta volver.
      </p>

      {mensaje && (
        <p className="mt-3 flex items-start gap-2 rounded-lg border border-state-ok/30 bg-state-ok/5 px-3 py-2.5 text-xs leading-relaxed text-state-ok">
          <CheckCircle2Icon className="mt-px h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0">{mensaje}</span>
        </p>
      )}

      {error && (
        <p className="mt-3 flex items-start gap-2 rounded-lg border border-state-error/30 bg-state-error/5 px-3 py-2.5 text-xs leading-relaxed text-state-error">
          <AlertCircleIcon className="mt-px h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 break-words">{error}</span>
        </p>
      )}
    </div>
  );
}
