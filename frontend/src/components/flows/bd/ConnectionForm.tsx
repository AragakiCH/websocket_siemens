import React, { useEffect, useState } from 'react';
import { ChevronRightIcon, ListIcon, PlusIcon } from 'lucide-react';
import { MOTOR_PORTS } from '../types';
import {
  cargarConexiones,
  cargarDriversOdbc,
  type ConexionRemota,
} from '../api';

interface Props {
  config: Record<string, any>;
  onChange: (patch: Record<string, any>) => void;
  /**
   * Ofrecer las conexiones que YA existen en el backend.
   *
   * Solo tiene sentido en el editor de flujos: ahí un nodo "Conexión BD"
   * normalmente quiere APUNTAR a una conexión que ya está dada de alta, no
   * declararla otra vez. En el asistente de primer arranque y en el alta de
   * Configuración se está creando una nueva por definición, así que va
   * apagado.
   */
  permitirExistente?: boolean;
}

const MOTORS = [
  { value: 'mysql', label: 'MySQL' },
  { value: 'postgresql', label: 'PostgreSQL' },
  { value: 'mssql', label: 'SQL Server' },
  { value: 'sqlite', label: 'SQLite' },
];

export function ConnectionForm({
  config,
  onChange,
  permitirExistente = false,
}: Props) {
  const motor = config.motor || 'mysql';
  const isSqlite = motor === 'sqlite';
  const isMssql = motor === 'mssql';
  // Nombre de instancia y puerto a la vez: se pisan. Ver el comentario de
  // `handleMotorChange`.
  const instanciaConPuerto =
    String(config.host || '').includes('\\') && !!config.puerto;

  // ── Drivers ODBC REALES de la máquina del backend ──────────────
  //
  // Antes este desplegable ofrecía "Driver 17" y "Driver 18" escritos a mano.
  // Elegir uno que no está instalado no da un error que lo diga: da
  //
  //   IM002 · No se encuentra el nombre del origen de datos y no se
  //   especificó ningún controlador predeterminado
  //
  // ...que suena a que la base de datos no existe, cuando el problema es que
  // falta un componente de Windows. Preguntándole al backend qué tiene
  // instalado, ese error deja de ser posible.
  // ── Conexiones ya dadas de alta ────────────────────────────────
  //
  // Reescribir host, puerto, base, usuario y contraseña para apuntar a algo
  // que el backend YA conoce es trabajo repetido y una fuente de errores: dos
  // sitios donde editar lo mismo, y una contraseña de más viajando y
  // guardándose en el diseño. El nodo debería REFERENCIAR la conexión.
  const [existentes, setExistentes] = useState<ConexionRemota[]>([]);
  const usarExistente = !!config.usar_existente;

  useEffect(() => {
    if (!permitirExistente) return;
    void cargarConexiones()
      .then(setExistentes)
      .catch(() => setExistentes([]));
  }, [permitirExistente]);

  const elegirExistente = (dbId: string) => {
    const c = existentes.find((x) => x.db_id === dbId);
    if (!c) return;
    onChange({
      usar_existente: true,
      db_id: c.db_id,
      motor: c.motor,
      nombre: c.nombre ?? '',
      host: c.host ?? '',
      puerto: c.puerto ?? null,
      base_datos: c.base_datos ?? '',
      usuario: c.usuario ?? '',
      // La contraseña NO se copia: `GET /db` nunca la devuelve, y el nodo no
      // la necesita — al guardar solo comprueba la conexión, no la recrea.
      password: '',
      autoconectar: c.autoconectar ?? true,
    });
  };

  const seleccionada = existentes.find((c) => c.db_id === config.db_id);

  const [drivers, setDrivers] = useState<string[]>([]);
  const [avisoDriver, setAvisoDriver] = useState('');
  const [consultado, setConsultado] = useState(false);

  useEffect(() => {
    if (!isMssql || consultado) return;
    setConsultado(true);
    void cargarDriversOdbc().then(({ drivers: lista, mensaje }) => {
      setDrivers(lista);
      setAvisoDriver(mensaje);
      // Si el driver preseleccionado no está instalado, se cambia por uno que
      // sí lo esté. Dejarlo puesto sería que el usuario pulse "Probar" y
      // reciba un error sobre algo que nunca eligió.
      const actual = config.opciones?.driver;
      if (lista.length > 0 && (!actual || !lista.includes(actual))) {
        onChange({ opciones: { ...config.opciones, driver: lista[0] } });
      }
    });
  }, [isMssql, consultado, config.opciones, onChange]);

  /**
   * Valores de partida para un motor. Un solo sitio, porque hacen falta en
   * dos momentos: al cambiar de motor y al empezar una conexión nueva.
   */
  const porDefecto = (newMotor: string) => ({
    motor: newMotor,
    puerto: MOTOR_PORTS[newMotor] ?? 3306,
    // ANTES, para mssql se proponía `localhost\SQLEXPRESS` Y ADEMÁS puerto
    // 1433. Los dos juntos no funcionan: ODBC ignora el nombre de instancia
    // cuando hay puerto, así que la URL apuntaba a `localhost,1433` y fallaba
    // con "Login timeout expired" en cualquier SQL Express (puerto dinámico).
    // Hay que elegir uno de los dos, y `localhost` + puerto fijo falla menos.
    host: 'localhost',
    // ODBC Driver 18 es el que instala Microsoft hoy. Cifra por defecto, y
    // como los certificados de un contenedor o de una instancia local son
    // autofirmados, sin TrustServerCertificate rechaza la conexión. Se marca
    // de salida para que la primera prueba funcione; quien tenga certificado
    // de verdad puede desmarcarlo.
    opciones:
      newMotor === 'mssql'
        ? { driver: 'ODBC Driver 18 for SQL Server', TrustServerCertificate: 'yes' }
        : {},
  });

  /**
   * Empezar una conexión NUEVA de verdad.
   *
   * Antes esto solo apagaba `usar_existente` y dejaba en pantalla los datos de
   * la conexión que estaba seleccionada: nombre, host, base y usuario de OTRA
   * conexión, esperando a que alguien los tomara por buenos. "Nueva" tiene que
   * significar en blanco.
   */
  const empezarNueva = () => {
    onChange({
      usar_existente: false,
      db_id: '',
      nombre: '',
      base_datos: '',
      usuario: '',
      password: '',
      autoconectar: true,
      ...porDefecto(motor),
    });
  };

  const handleMotorChange = (newMotor: string) => onChange(porDefecto(newMotor));

  // ── Modo "usar una existente" ─────────────────────────────────
  if (permitirExistente && existentes.length > 0 && usarExistente) {
    return (
      <div className="space-y-3">
        <Field label="Conexión" required>
          <select
            value={config.db_id || ''}
            onChange={(e) => elegirExistente(e.target.value)}
            className="input-field"
          >
            <option value="">— elige una —</option>
            {existentes.map((c) => (
              <option key={c.db_id} value={c.db_id}>
                {c.db_id}
                {c.nombre && c.nombre !== c.db_id ? ` · ${c.nombre}` : ''}
                {c.conectado ? '' : '  (sin conexión)'}
              </option>
            ))}
          </select>
        </Field>

        {/* Los datos, de solo lectura. Enseñarlos editables sería mentir:
            cambiarlos aquí no cambiaría nada en el backend. Para eso está
            Configuración → Bases de datos. */}
        {seleccionada && (
          <div className="space-y-1.5 rounded-md border border-slate-200 bg-slate-50 px-3 py-2.5 dark:border-navy-slate dark:bg-navy/40">
            <Dato etiqueta="Motor" valor={seleccionada.etiqueta_motor || seleccionada.motor} />
            {seleccionada.motor !== 'sqlite' && (
              <Dato
                etiqueta="Servidor"
                valor={`${seleccionada.host ?? ''}${seleccionada.puerto ? ':' + seleccionada.puerto : ''}`}
              />
            )}
            <Dato etiqueta="Base" valor={seleccionada.base_datos ?? ''} />
            {seleccionada.usuario && (
              <Dato etiqueta="Usuario" valor={seleccionada.usuario} />
            )}
            <Dato
              etiqueta="Estado"
              valor={seleccionada.conectado ? 'conectada' : 'sin conexión'}
              tono={seleccionada.conectado ? 'ok' : 'error'}
            />
          </div>
        )}

        <p className="text-[11px] leading-relaxed text-slate-400">
          El nodo apunta a esta conexión: no vuelve a pedir la contraseña ni la
          duplica. Al guardar solo se comprueba que responda. Para cambiar sus
          datos, ve a Configuración → Bases de datos.
        </p>

        <button
          type="button"
          onClick={empezarNueva}
          className="flex w-full items-center justify-center gap-1.5 rounded-md border border-slate-200 px-3 py-2 text-[11px] font-semibold text-slate-500 transition hover:border-siemens/40 hover:text-siemens dark:border-navy-slate dark:text-slate-400"
        >
          <PlusIcon className="h-3.5 w-3.5" />
          Declarar una conexión nueva
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* Volver a la lista, si hay alguna dada de alta */}
      {permitirExistente && existentes.length > 0 && (
        <button
          type="button"
          onClick={() => onChange({ usar_existente: true })}
          className="flex w-full items-center gap-2 rounded-md border border-siemens/40 bg-siemens/10 px-3 py-2.5 text-left text-[11px] font-semibold text-siemens transition hover:bg-siemens/20"
        >
          <ListIcon className="h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 flex-1">
            Elegir una de las {existentes.length} conexiones ya configuradas
          </span>
          <ChevronRightIcon className="h-3.5 w-3.5 shrink-0" />
        </button>
      )}

      {/* db_id */}
      <Field label="ID Conexión" required>
        <input
          type="text"
          value={config.db_id || ''}
          onChange={(e) => onChange({ db_id: e.target.value })}
          placeholder="ej: mes_produccion"
          className="input-field"
        />
      </Field>

      {/* Motor */}
      <Field label="Motor">
        <div className="grid grid-cols-2 gap-1">
          {MOTORS.map((m) => (
            <button
              key={m.value}
              onClick={() => handleMotorChange(m.value)}
              className={`rounded-md px-2 py-1.5 text-xs font-medium transition ${
                motor === m.value
                  ? 'bg-siemens text-white'
                  : 'bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-navy-slate/40 dark:text-slate-400 dark:hover:bg-navy-slate/60'
              }`}
            >
              {m.label}
            </button>
          ))}
        </div>
      </Field>

      {/* Nombre */}
      <Field label="Nombre (etiqueta)">
        <input
          type="text"
          value={config.nombre || ''}
          onChange={(e) => onChange({ nombre: e.target.value })}
          placeholder="Opcional"
          className="input-field"
        />
      </Field>

      {!isSqlite && (
        <>
          {/* Host */}
          <Field label="Host">
            <input
              type="text"
              value={config.host || ''}
              onChange={(e) => onChange({ host: e.target.value })}
              placeholder="localhost"
              className="input-field"
            />
            {isMssql && instanciaConPuerto && (
              <p className="mt-1 text-[11px] leading-relaxed text-amber-600 dark:text-amber-400">
                Con un nombre de instancia (<code>\SQLEXPRESS</code>) hay que
                dejar el puerto vacío: ODBC ignora la instancia si hay puerto.
                O usa <code>localhost</code> con el puerto 1433.
              </p>
            )}
          </Field>

          {/* Puerto */}
          <Field label="Puerto">
            <input
              type="number"
              value={config.puerto ?? ''}
              onChange={(e) => onChange({ puerto: parseInt(e.target.value) || 0 })}
              placeholder={String(MOTOR_PORTS[motor] || 3306)}
              className="input-field"
            />
          </Field>
        </>
      )}

      {/* Base de datos / Ruta SQLite */}
      <Field label={isSqlite ? 'Ruta archivo .db' : 'Base de datos'}>
        <input
          type="text"
          value={config.base_datos || ''}
          onChange={(e) => onChange({ base_datos: e.target.value })}
          placeholder={isSqlite ? '/ruta/datos.db' : 'nombre_bd'}
          className="input-field"
        />
      </Field>

      {!isSqlite && (
        <>
          {/* Usuario */}
          <Field label="Usuario">
            <input
              type="text"
              value={config.usuario || ''}
              onChange={(e) => onChange({ usuario: e.target.value })}
              className="input-field"
            />
          </Field>

          {/* Password */}
          <Field label="Contraseña">
            <input
              type="password"
              value={config.password || ''}
              onChange={(e) => onChange({ password: e.target.value })}
              className="input-field"
            />
          </Field>
        </>
      )}

      {/* Driver ODBC (solo SQL Server) */}
      {isMssql && (
        <Field label="Driver ODBC">
          <select
            value={config.opciones?.driver || ''}
            onChange={(e) =>
              onChange({ opciones: { ...config.opciones, driver: e.target.value } })
            }
            className="input-field"
          >
            {drivers.length > 0 ? (
              drivers.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))
            ) : (
              // Sin lista (backend caído, o pyodbc ausente): los nombres de
              // siempre, para que el formulario siga siendo usable.
              <>
                <option value="ODBC Driver 18 for SQL Server">ODBC Driver 18</option>
                <option value="ODBC Driver 17 for SQL Server">ODBC Driver 17</option>
              </>
            )}
          </select>
          {drivers.length > 0 ? (
            <p className="mt-1 text-[11px] text-slate-400">
              {drivers.length === 1
                ? 'Es el único instalado en el servidor.'
                : `${drivers.length} instalados en el servidor.`}
            </p>
          ) : (
            avisoDriver && (
              <p className="mt-1 text-[11px] leading-relaxed text-amber-600 dark:text-amber-400">
                {avisoDriver}
              </p>
            )
          )}
        </Field>
      )}

      {/* Confiar en el certificado (solo SQL Server).

          No es un ajuste esotérico: es el motivo #1 por el que una conexión
          correcta falla con el Driver 18. El driver cifra por defecto, y un
          SQL Server local o en contenedor presenta un certificado
          autofirmado que la cadena de confianza de Windows rechaza. */}
      {isMssql && (
        <label className="flex items-start gap-2 text-xs text-slate-600 dark:text-slate-400">
          <input
            type="checkbox"
            checked={config.opciones?.TrustServerCertificate === 'yes'}
            onChange={(e) => {
              const { TrustServerCertificate: _, ...resto } =
                config.opciones ?? {};
              onChange({
                opciones: e.target.checked
                  ? { ...resto, TrustServerCertificate: 'yes' }
                  : resto,
              });
            }}
            className="mt-0.5 rounded border-slate-300 text-siemens focus:ring-siemens"
          />
          <span className="min-w-0">
            Confiar en el certificado del servidor
            <span className="block text-[11px] text-slate-400">
              Necesario con el Driver 18 si el certificado es autofirmado
              (contenedor o instancia local).
            </span>
          </span>
        </label>
      )}

      {/* Autoconectar */}
      <label className="flex items-center gap-2 text-xs text-slate-600 dark:text-slate-400">
        <input
          type="checkbox"
          checked={config.autoconectar ?? true}
          onChange={(e) => onChange({ autoconectar: e.target.checked })}
          className="rounded border-slate-300 text-siemens focus:ring-siemens"
        />
        Autoconectar al iniciar
      </label>
    </div>
  );
}

// ── Helpers ─────────────────────────────────────────────────────
function Dato({
  etiqueta,
  valor,
  tono,
}: {
  etiqueta: string;
  valor: string;
  tono?: 'ok' | 'error';
}) {
  const color =
    tono === 'ok'
      ? 'text-state-ok'
      : tono === 'error'
        ? 'text-state-error'
        : 'text-slate-600 dark:text-slate-300';
  return (
    <div className="flex items-baseline justify-between gap-2 text-[11px]">
      <span className="shrink-0 text-slate-400">{etiqueta}</span>
      <span className={`min-w-0 truncate font-medium ${color}`} title={valor}>
        {valor || '—'}
      </span>
    </div>
  );
}

function Field({ label, required, children }: { label: string; required?: boolean; children: React.ReactNode }) {
  return (
    <div>
      <label className="mb-1 block text-[11px] font-semibold text-slate-500 dark:text-slate-400">
        {label}
        {required && <span className="ml-0.5 text-red-400">*</span>}
      </label>
      {children}
    </div>
  );
}
