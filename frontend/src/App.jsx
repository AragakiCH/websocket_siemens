// =========================================================================
// App.jsx — Dashboard en tiempo real OPC UA -> WebSocket (Siemens S7-1500)
// Reemplaza al antiguo test_client.html con una base React ordenada.
// =========================================================================
import { useMemo, useState } from 'react'
import { useWebSocket } from './hooks/useWebSocket'
import PlcCard from './components/PlcCard'
import TagsTable from './components/TagsTable'
import AddPlcPanel from './components/AddPlcPanel'
import './App.css'

export default function App() {
  const [plcFilter, setPlcFilter] = useState(null) // null = todos los PLCs
  const { estado, plcs, tags } = useWebSocket(plcFilter)
  const [busqueda, setBusqueda] = useState('')

  const listaTags = useMemo(() => {
    const arr = Object.values(tags)
    const q = busqueda.trim().toLowerCase()
    const filtrados = q
      ? arr.filter((t) => t.tag.toLowerCase().includes(q) || t.plc.toLowerCase().includes(q))
      : arr
    return filtrados.sort((a, b) => a.tag.localeCompare(b.tag))
  }, [tags, busqueda])

  return (
    <div className="app">
      <header className="app-header">
        <div>
          <h1>Monitor S7-1500</h1>
          <span className="subtitle">OPC UA → WebSocket en tiempo real</span>
        </div>
        <div className={`ws-badge ws-${estado}`}>
          <span className="dot" /> {estado}
        </div>
      </header>

      <AddPlcPanel />

      <section className="plc-grid">
        {Object.entries(plcs).map(([id, plc]) => (
          <PlcCard
            key={id}
            id={id}
            plc={plc}
            activo={plcFilter === id}
            onSelect={() => setPlcFilter(plcFilter === id ? null : id)}
          />
        ))}
        {Object.keys(plcs).length === 0 && (
          <p className="empty">
            Sin PLCs todavía. Escribe la IP arriba o pulsa “Escanear red”.
          </p>
        )}
      </section>

      <section className="tags-section">
        <div className="tags-toolbar">
          <h2>Tags ({listaTags.length})</h2>
          <input
            type="search"
            placeholder="Filtrar por tag o PLC…"
            value={busqueda}
            onChange={(e) => setBusqueda(e.target.value)}
          />
        </div>
        <TagsTable tags={listaTags} />
      </section>
    </div>
  )
}
