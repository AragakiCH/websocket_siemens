// Tarjeta de estado de un PLC. Click = filtrar la vista a ese PLC.
// El botón ✕ lo quita del backend (deja de conectarse a él).
export default function PlcCard({ id, plc, activo, onSelect }) {
  const quitar = async (e) => {
    e.stopPropagation()
    if (!window.confirm(`¿Quitar el PLC "${id}" del monitoreo?`)) return
    try {
      await fetch(`/plcs/${encodeURIComponent(id)}`, { method: 'DELETE' })
      // La vista se actualiza sola con el mensaje WS 'plc_removed'.
    } catch {
      /* si falla la red, el estado WS seguirá mostrando el PLC */
    }
  }

  return (
    <div
      role="button"
      tabIndex={0}
      className={`plc-card ${plc.conectado ? 'ok' : 'ko'} ${activo ? 'activo' : ''}`}
      onClick={onSelect}
      onKeyDown={(e) => e.key === 'Enter' && onSelect()}
      title={activo ? 'Quitar filtro' : `Ver solo ${id}`}
    >
      <div className="plc-head">
        <strong>{plc.nombre || id}</strong>
        <span className="plc-head-der">
          <span className={`estado ${plc.conectado ? 'ok' : 'ko'}`}>
            {plc.estado ?? 'desconocido'}
          </span>
          <button type="button" className="quitar" onClick={quitar} title="Quitar PLC">
            ✕
          </button>
        </span>
      </div>
      <div className="plc-endpoint">{plc.endpoint}</div>
      {plc.sampling_interval_ms != null && (
        <div className="plc-meta">
          sampling {plc.sampling_interval_ms} ms · publishing {plc.publishing_interval_ms} ms
        </div>
      )}
    </div>
  )
}
