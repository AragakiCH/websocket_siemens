// =========================================================================
// AsistenteArranque.tsx — configurar la base de datos desde el login
//
// EL PROBLEMA QUE RESUELVE (la paradoja del arranque)
//
//   Para entrar hace falta una base de datos: es donde vive la tabla
//   `usuarios`. Pero el formulario para dar de alta esa base vivía dentro del
//   editor de flujos... que está detrás del login. Sin una terminal a mano, un
//   usuario nuevo se quedaba encerrado fuera de su propia aplicación.
//
// POR QUÉ ES SEGURO ENSEÑARLO SIN SESIÓN
//
//   El backend ya abre esta ventana a propósito: mientras `contar_en_todas()`
//   devuelve 0 —o sea, mientras no exista NINGUNA cuenta en NINGUNA base—
//   `exigir_rol()` deja pasar los endpoints de administración. Es la misma
//   ventana que tiene un router recién sacado de la caja, y se cierra sola en
//   cuanto se crea la primera cuenta.
//
//   Este componente no inventa ningún permiso: solo usa esa ventana. Si ya hay
//   cuentas, `POST /db` responde 401/403 y aquí se muestra ese mensaje tal
//   cual, que es la respuesta correcta.
//
// LO QUE **NO** HACE
//
//   No crea la base de datos ni las tablas. Eso lo hace un `.sql`
//   (`sql/local_hmi_psi_mssql.sql`), y es deliberado: una aplicación con
//   permisos para alterar la estructura de la base de producción es una
//   aplicación que puede romperla. Aquí solo se declara dónde está una base
//   que ya existe.
//
// EL ENCADENADO
//
//   Al guardar no navega a ningún sitio: le dice al login CUÁL es la conexión
//   recién creada y este se cambia a ella. Con la base conectada,
//   `bd_disponible` pasa a true y `hay_usuarios` a false, así que el login
//   abre solo la pestaña "Crear cuenta" con la categoría fija en Supervisor.
//   Dos pantallas y estás dentro.
//
//   El `db_id` se devuelve a propósito, y no basta con avisar "ya está".
//   Antes se avisaba a secas, el login recargaba el estado de la base que
//   tuviera SELECCIONADA —que era justo la que no funcionaba, por eso se veía
//   este asistente— y volvía a pintar el formulario vacío. Guardar parecía no
//   haber hecho nada.
// =========================================================================
import { useState } from 'react';
import {
  CheckCircle2Icon,
  DatabaseIcon,
  InfoIcon,
  Loader2Icon,
  PlugZapIcon,
} from 'lucide-react';
import { ConnectionForm } from '../flows/bd/ConnectionForm';
import { guardarConexion, type Diagnostico } from '../flows/api';
import { PanelDiagnostico } from '../bd/PanelDiagnostico';
import { CrearBaseDatos } from '../bd/CrearBaseDatos';

/**
 * Valores de partida.
 *
 * SQL Server con Driver 18 y `TrustServerCertificate`, porque es lo que se
 * encuentra hoy en una máquina Windows recién preparada: el instalador de
 * Microsoft trae el 18, que cifra por defecto, y una instancia local presenta
 * un certificado autofirmado. Con el 17 y sin la casilla, la primera prueba
 * falla y el mensaje (`certificate chain ... not trusted`) no le dice nada a
 * quien no ha visto antes ese error.
 */
const INICIAL: Record<string, any> = {
  db_id: 'local',
  motor: 'mssql',
  nombre: 'HMI local',
  host: 'localhost',
  puerto: 1433,
  base_datos: '',
  usuario: '',
  password: '',
  opciones: {
    driver: 'ODBC Driver 18 for SQL Server',
    TrustServerCertificate: 'yes',
  },
  autoconectar: true,
};

export function AsistenteArranque({
  onListo,
  motivo,
}: {
  /**
   * Se llama tras guardar bien, con el `db_id` de la conexión creada, para
   * que el login se cambie a ELLA y no recargue la que estaba seleccionada.
   */
  onListo: (dbId: string) => void;
  /** El error exacto que devolvió el backend. Se muestra tal cual. */
  motivo?: string;
}) {
  const [config, setConfig] = useState<Record<string, any>>(INICIAL);
  const [probando, setProbando] = useState(false);
  const [error, setError] = useState('');
  const [diagnostico, setDiagnostico] = useState<Diagnostico | undefined>();
  const [ok, setOk] = useState('');

  const cambiar = (patch: Record<string, any>) => {
    setConfig((c) => ({ ...c, ...patch }));
    setError('');
    setDiagnostico(undefined);
    setOk('');
  };

  const faltan = (): string => {
    if (!String(config.db_id || '').trim()) return 'Ponle un identificador a la conexión.';
    if (!String(config.base_datos || '').trim()) {
      return config.motor === 'sqlite'
        ? 'Indica la ruta del archivo .db.'
        : 'Indica el nombre de la base de datos.';
    }
    if (config.motor !== 'sqlite' && !String(config.host || '').trim()) {
      return 'Indica el host del servidor.';
    }
    return '';
  };

  const probar = async () => {
    const falta = faltan();
    if (falta) {
      setError(falta);
      return;
    }
    setProbando(true);
    setError('');
    setDiagnostico(undefined);
    setOk('');
    try {
      // `POST /db` VERIFICA la conexión antes de guardarla: si responde bien,
      // la base contesta de verdad. Por eso no hace falta un endpoint aparte
      // de "probar" — probar y guardar son la misma operación.
      const r = await guardarConexion(config);
      setOk(r?.mensaje || 'Conexión verificada y guardada.');
      const creada = r?.db_id || String(config.db_id || '').trim();
      // Un respiro para que se lea el mensaje antes de que la pantalla cambie.
      setTimeout(() => onListo(creada), 700);
    } catch (e: any) {
      setError(e?.message ?? 'No se pudo guardar la conexión.');
      setDiagnostico(e?.diagnostico);
    } finally {
      setProbando(false);
    }
  };

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-card dark:border-navy-slate dark:bg-navy-soft">
      <div className="mb-4 flex items-start gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-siemens/10 text-siemens">
          <DatabaseIcon className="h-5 w-5" />
        </span>
        <div className="min-w-0">
          <h2 className="text-lg font-bold text-navy dark:text-slate-100">
            Conecta tu base de datos
          </h2>
          <p className="mt-1 text-sm leading-relaxed text-slate-500 dark:text-slate-400">
            Las cuentas de Psi Core viven en una base de datos. Indica dónde
            está la tuya y creamos el primer acceso a continuación.
          </p>
        </div>
      </div>

      {motivo && (
        <p className="mb-4 flex items-start gap-2 rounded-lg border border-slate-200 bg-slate-100/70 px-3 py-2.5 text-xs leading-relaxed text-slate-500 dark:border-navy-slate dark:bg-navy/60 dark:text-slate-400">
          <InfoIcon className="mt-px h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0">{motivo}</span>
        </p>
      )}

      <ConnectionForm config={config} onChange={cambiar} />

      {/* Lo que este asistente NO hace. Decirlo aquí evita la pregunta
          "¿por qué no me creó la base?" cuando el error sea 'Cannot open
          database'. */}
      <p className="mt-4 flex items-start gap-2 text-[11px] leading-relaxed text-slate-400">
        <InfoIcon className="mt-px h-3 w-3 shrink-0" />
        <span className="min-w-0">
          La base de datos y sus tablas tienen que existir ya. Si aún no las has
          creado, ejecuta <code>sql/local_hmi_psi_mssql.sql</code> en tu
          servidor — esta pantalla solo declara dónde encontrarlas.
        </span>
      </p>

      {(error || diagnostico) && (
        <PanelDiagnostico diagnostico={diagnostico} mensajeCrudo={error} />
      )}

      {/* Solo ante lo que se puede arreglar CREANDO algo: falta la base, o
          falta el usuario. Ante un fallo de red o de certificado no aparece:
          proponer "crear" ahí despistaría. */}
      {['base_no_existe', 'ruta_no_existe', 'credenciales', 'sin_permisos'].includes(
        diagnostico?.codigo ?? ''
      ) && (
        <CrearBaseDatos
          config={config}
          codigo={diagnostico?.codigo}
          onCreada={() => void probar()}
        />
      )}

      {ok && (
        <p
          role="status"
          className="mt-4 flex items-start gap-2 rounded-lg border border-state-ok/30 bg-state-ok/5 px-3 py-2.5 text-xs leading-relaxed text-state-ok"
        >
          <CheckCircle2Icon className="mt-px h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0">{ok}</span>
        </p>
      )}

      <button
        type="button"
        onClick={probar}
        disabled={probando}
        className="mt-5 flex min-h-[48px] w-full items-center justify-center gap-2 rounded-xl bg-siemens px-4 text-sm font-semibold text-white shadow-card outline-none transition hover:bg-siemens-600 focus-visible:ring-2 focus-visible:ring-siemens/50 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60 dark:focus-visible:ring-offset-navy"
      >
        {probando ? (
          <>
            <Loader2Icon className="h-4 w-4 animate-spin" />
            Probando la conexión…
          </>
        ) : (
          <>
            <PlugZapIcon className="h-4 w-4" />
            Probar y guardar conexión
          </>
        )}
      </button>
    </div>
  );
}
