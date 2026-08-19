import React from 'react';
import { MOTOR_PORTS } from '../types';

interface Props {
  config: Record<string, any>;
  onChange: (patch: Record<string, any>) => void;
}

const MOTORS = [
  { value: 'mysql', label: 'MySQL' },
  { value: 'postgresql', label: 'PostgreSQL' },
  { value: 'mssql', label: 'SQL Server' },
  { value: 'sqlite', label: 'SQLite' },
];

export function ConnectionForm({ config, onChange }: Props) {
  const motor = config.motor || 'mysql';
  const isSqlite = motor === 'sqlite';
  const isMssql = motor === 'mssql';

  const handleMotorChange = (newMotor: string) => {
    onChange({
      motor: newMotor,
      puerto: MOTOR_PORTS[newMotor] ?? 3306,
      host: newMotor === 'mssql' ? 'localhost\\SQLEXPRESS' : 'localhost',
      opciones: newMotor === 'mssql' ? { driver: 'ODBC Driver 17 for SQL Server' } : {},
    });
  };

  return (
    <div className="space-y-3">
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
              placeholder={isMssql ? 'localhost\\SQLEXPRESS' : 'localhost'}
              className="input-field"
            />
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
            value={config.opciones?.driver || 'ODBC Driver 17 for SQL Server'}
            onChange={(e) =>
              onChange({ opciones: { ...config.opciones, driver: e.target.value } })
            }
            className="input-field"
          >
            <option value="ODBC Driver 17 for SQL Server">ODBC Driver 17</option>
            <option value="ODBC Driver 18 for SQL Server">ODBC Driver 18</option>
          </select>
        </Field>
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

// ── Helper ──────────────────────────────────────────────────────
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
