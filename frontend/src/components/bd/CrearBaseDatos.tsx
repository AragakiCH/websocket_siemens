// =========================================================================
// CrearBaseDatos.tsx — el paso que faltaba entre "no existe" y "conectada"
//
// CUÁNDO APARECE
//   Tras un diagnóstico que se pueda arreglar CREANDO algo. Son dos:
//
//     base_no_existe / ruta_no_existe -> falta la base de datos
//     credenciales / sin_permisos     -> puede faltar el USUARIO
//
//   El segundo caso importa más de lo que parece: el usuario de la base no
//   tiene por qué llamarse `hmi_app`. Cada instalación elige el nombre que
//   quiera, y si escribe uno que todavía no existe, lo razonable es ofrecer
//   crearlo — no obligarle a abrir SSMS.
//
//   Fuera de esos códigos no aparece: proponer "crear algo" ante un fallo de
//   red o de certificado mandaría a alguien por el camino equivocado.
//
// POR QUÉ PIDE OTRAS CREDENCIALES
//   Crear una base de datos exige privilegios de administrador del servidor
//   (`sa`, `root`, `postgres`). El HMI no los tiene ni debe tenerlos: opera
//   con un usuario que solo lee y escribe filas.
//
//   Así que se piden aparte, se usan para esta operación, y se descartan. No
//   se guardan en `conexiones.json`, ni en el log, ni en la auditoría. Lo que
//   queda guardado es la conexión con el usuario limitado.
//
//   Es la diferencia entre instalar y operar. Aquí se instala.
//
// EL USUARIO DEL HMI SALE DEL FORMULARIO
//   Si en la conexión escribiste `hmi_app` y una contraseña, la casilla de
//   "crear también el usuario" los reutiliza. Es lo que uno espera: acabas de
//   declarar con qué cuenta quieres conectarte, no tiene sentido volver a
//   escribirla.
// =========================================================================
import React, { useState } from 'react';
import {
  AlertCircleIcon,
  CheckCircle2Icon,
  DatabaseZapIcon,
  KeyRoundIcon,
  Loader2Icon,
  MinusCircleIcon,
  ShieldAlertIcon,
  WandSparklesIcon,
} from 'lucide-react';
import { provisionarBase, type PasoProvision } from '../flows/api';

/** Administrador habitual de cada motor, para no dejar el campo en blanco. */
const ADMIN_SUGERIDO: Record<string, string> = {
  mssql: 'sa',
  mysql: 'root',
  postgresql: 'postgres',
};

export function CrearBaseDatos({
  config,
  codigo,
  onCreada,
}: {
  /** La conexión que se intentó guardar: de ahí salen host, puerto y base. */
  config: Record<string, any>;
  /** Código del diagnóstico. Decide qué se ofrece y cómo se explica. */
  codigo?: string;
  /** Se llama al terminar bien, para reintentar la conexión. */
  onCreada: () => void;
}) {
  const motor = String(config.motor || 'mssql');
  const esSqlite = motor === 'sqlite';

  // Qué motivó el panel. Cambia el titular y qué viene marcado de salida:
  // si el problema es el usuario, la casilla de crearlo no debería estar
  // apagada — es justo lo que la persona viene a hacer.
  const porUsuario = codigo === 'credenciales' || codigo === 'sin_permisos';

  const [adminUsuario, setAdminUsuario] = useState(ADMIN_SUGERIDO[motor] ?? '');
  const [adminPassword, setAdminPassword] = useState('');
  // Solo SQL Server. Preferida cuando está disponible: evita tener que
  // activar `sa`, que en una instalación en modo "solo Windows" viene
  // deshabilitado y no se reactiva al pasar a modo mixto.
  const [adminWindows, setAdminWindows] = useState(motor === 'mssql');
  const [crearEsquema, setCrearEsquema] = useState(true);
  const [crearUsuario, setCrearUsuario] = useState(porUsuario);

  const [trabajando, setTrabajando] = useState(false);
  const [error, setError] = useState('');
  const [pasos, setPasos] = useState<PasoProvision[]>([]);
  const [listo, setListo] = useState(false);

  // Solo se puede ofrecer crear el usuario si el formulario trae con cuál.
  const puedeCrearUsuario =
    !esSqlite &&
    !!String(config.usuario || '').trim() &&
    String(config.password || '').length >= 8;

  const crear = async () => {
    setTrabajando(true);
    setError('');
    setPasos([]);
    try {
      const r = await provisionarBase({
        motor,
        base_datos: config.base_datos,
        host: config.host,
        puerto: config.puerto,
        opciones: config.opciones ?? {},
        admin_usuario: adminWindows ? '' : adminUsuario,
        admin_password: adminWindows ? '' : adminPassword,
        admin_windows: adminWindows,
        crear_esquema: crearEsquema,
        usuario_hmi: crearUsuario ? config.usuario : '',
        password_hmi: crearUsuario ? config.password : '',
        // Siempre, se cree o no el usuario: al final se comprueba que ESA
        // cuenta entra de verdad. Que `sa` pueda no demuestra nada sobre si
        // `hmi_app` puede, y es justo lo que falla en la práctica.
        usuario_verificar: config.usuario ?? '',
        password_verificar: config.password ?? '',
      });
      setPasos(r.pasos ?? []);
      setListo(true);
      // Un respiro para leer el parte antes de reintentar la conexión.
      setTimeout(onCreada, 1200);
    } catch (e: any) {
      setError(e?.message ?? 'No se pudo crear la base de datos.');
      setPasos(e?.data?.pasos ?? []);
    } finally {
      setTrabajando(false);
    }
  };

  return (
    <div className="mt-3 rounded-xl border border-siemens/30 bg-siemens/5 p-3.5">
      <div className="flex items-start gap-2.5">
        <WandSparklesIcon className="mt-px h-4 w-4 shrink-0 text-siemens" />
        <div className="min-w-0">
          <p className="text-[13px] font-semibold text-siemens-700 dark:text-siemens-200">
            {porUsuario
              ? `¿El usuario «${String(config.usuario || '')}» todavía no existe?`
              : `Crear «${String(config.base_datos || '')}» ahora`}
          </p>
          <p className="mt-1 text-xs leading-relaxed text-slate-600 dark:text-slate-300">
            {esSqlite
              ? 'Se creará la carpeta si falta, el fichero de la base y sus tablas.'
              : porUsuario
                ? 'Se puede crear ahora con permisos sobre esta base. Hace falta una cuenta de administrador del servidor: se usa solo para esto y no se guarda en ningún sitio.'
                : 'Crear una base de datos necesita una cuenta de administrador del servidor. Se usa solo para esto y no se guarda en ningún sitio.'}
          </p>
        </div>
      </div>

      {!esSqlite && !listo && motor === 'mssql' && (
        <label className="mt-3.5 flex items-start gap-2 text-xs text-slate-600 dark:text-slate-300">
          <input
            type="checkbox"
            checked={adminWindows}
            onChange={(e) => setAdminWindows(e.target.checked)}
            className="mt-0.5 rounded border-slate-300 text-siemens focus:ring-siemens"
          />
          <span className="min-w-0">
            Usar la autenticación de Windows del servidor
            <span className="block text-[11px] text-slate-400">
              Entra con la cuenta de Windows con la que corre el backend. Si
              esa cuenta ya es administradora de SQL Server, no hace falta
              activar «sa» ni escribir ninguna contraseña.
            </span>
          </span>
        </label>
      )}

      {!esSqlite && !listo && !adminWindows && (
        <div className="mt-3.5 grid grid-cols-2 gap-3">
          <Campo etiqueta="Administrador">
            <input
              type="text"
              value={adminUsuario}
              onChange={(e) => setAdminUsuario(e.target.value)}
              placeholder={ADMIN_SUGERIDO[motor] ?? 'admin'}
              className="input-field"
            />
          </Campo>
          <Campo etiqueta="Su contraseña">
            <input
              type="password"
              value={adminPassword}
              onChange={(e) => setAdminPassword(e.target.value)}
              autoComplete="off"
              className="input-field"
            />
          </Campo>
        </div>
      )}

      {!listo && (
        <div className="mt-3 space-y-2">
          <label className="flex items-start gap-2 text-xs text-slate-600 dark:text-slate-300">
            <input
              type="checkbox"
              checked={crearEsquema}
              onChange={(e) => setCrearEsquema(e.target.checked)}
              className="mt-0.5 rounded border-slate-300 text-siemens focus:ring-siemens"
            />
            <span className="min-w-0">
              {porUsuario ? 'Comprobar también las tablas del HMI' : 'Crear también las tablas del HMI'}
              <span className="block text-[11px] text-slate-400">
                usuarios, plc_prg, alarmas y recetas — el mismo DDL que genera
                el script .sql
              </span>
            </span>
          </label>

          {!esSqlite && (
            <label
              className={`flex items-start gap-2 text-xs ${
                puedeCrearUsuario
                  ? 'text-slate-600 dark:text-slate-300'
                  : 'cursor-not-allowed text-slate-400'
              }`}
            >
              <input
                type="checkbox"
                checked={crearUsuario && puedeCrearUsuario}
                disabled={!puedeCrearUsuario}
                onChange={(e) => setCrearUsuario(e.target.checked)}
                className="mt-0.5 rounded border-slate-300 text-siemens focus:ring-siemens"
              />
              <span className="min-w-0">
                Crear el usuario «{String(config.usuario || '—')}» con permisos
                <span className="block text-[11px] text-slate-400">
                  {puedeCrearUsuario
                    ? 'Solo leer y escribir filas. Nunca modificar la estructura. Si ya existe, no se le cambia la contraseña: solo se le aplican los permisos.'
                    : 'Rellena usuario y una contraseña de 8+ caracteres arriba para habilitarlo.'}
                </span>
              </span>
            </label>
          )}
        </div>
      )}

      {/* Parte de lo ocurrido, paso a paso */}
      {pasos.length > 0 && (
        <ul className="mt-3 space-y-1.5 rounded-lg bg-slate-100/80 px-3 py-2.5 dark:bg-navy/60">
          {pasos.map((p, i) => (
            <li key={i} className="flex items-start gap-2 text-xs leading-relaxed">
              {p.omitido ? (
                <MinusCircleIcon className="mt-px h-3.5 w-3.5 shrink-0 text-slate-400" />
              ) : (
                <CheckCircle2Icon className="mt-px h-3.5 w-3.5 shrink-0 text-state-ok" />
              )}
              <span
                className={`min-w-0 ${
                  p.omitido
                    ? 'text-slate-400'
                    : 'text-slate-600 dark:text-slate-300'
                }`}
              >
                {p.mensaje}
              </span>
            </li>
          ))}
        </ul>
      )}

      {error && (
        <p className="mt-3 flex items-start gap-2 text-xs leading-relaxed text-state-error">
          <AlertCircleIcon className="mt-px h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 break-words">{error}</span>
        </p>
      )}

      {!listo && (
        <>
          <button
            type="button"
            onClick={() => void crear()}
            disabled={trabajando || (!esSqlite && !adminWindows && !adminUsuario)}
            className="mt-3.5 flex w-full items-center justify-center gap-2 rounded-lg bg-siemens px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-siemens-600 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {trabajando ? (
              <>
                <Loader2Icon className="h-4 w-4 animate-spin" />
                Creando…
              </>
            ) : (
              <>
                <DatabaseZapIcon className="h-4 w-4" />
                {porUsuario ? 'Crear el usuario' : 'Crear la base de datos'}
              </>
            )}
          </button>

          <p className="mt-2 flex items-start gap-1.5 text-[11px] leading-relaxed text-slate-400">
            <ShieldAlertIcon className="mt-px h-3 w-3 shrink-0" />
            <span className="min-w-0">
              Nunca borra nada. Si la base o las tablas ya existen, las deja
              como están.
            </span>
          </p>
        </>
      )}

      {listo && (
        <p className="mt-3 flex items-start gap-2 text-xs font-medium text-state-ok">
          <KeyRoundIcon className="mt-px h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0">Listo. Reintentando la conexión…</span>
        </p>
      )}
    </div>
  );
}

function Campo({
  etiqueta,
  children,
}: {
  etiqueta: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="mb-1 block text-[11px] font-semibold text-slate-500 dark:text-slate-400">
        {etiqueta}
      </label>
      {children}
    </div>
  );
}
