// Tabla de tags con su último valor recibido por WebSocket.
function formatoValor(v) {
  if (v === null || v === undefined) return '—'
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE'
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(3)
  return String(v)
}

function formatoHora(ts) {
  if (!ts) return '—'
  const d = new Date(ts)
  return Number.isNaN(d.getTime()) ? ts : d.toLocaleTimeString()
}

export default function TagsTable({ tags }) {
  if (tags.length === 0) {
    return <p className="empty">Sin tags todavía. Llegarán con el snapshot inicial.</p>
  }
  return (
    <div className="table-wrap">
      <table className="tags-table">
        <thead>
          <tr>
            <th>PLC</th>
            <th>Tag</th>
            <th>Valor</th>
            <th>Tipo</th>
            <th>Última act.</th>
            <th>Δ ms</th>
          </tr>
        </thead>
        <tbody>
          {tags.map((t) => (
            <tr key={`${t.plc}|${t.tag}`}>
              <td className="mono">{t.plc}</td>
              <td className="mono">{t.tag}</td>
              <td className="valor">{formatoValor(t.value)}</td>
              <td>{t.type ?? '—'}</td>
              <td>{formatoHora(t.timestamp)}</td>
              <td>{t.delta_ms ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
