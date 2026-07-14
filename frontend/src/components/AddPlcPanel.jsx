// Panel para agregar un PLC escribiendo su IP (o endpoint opc.tcp://...)
// y para re-escanear la subred en busca de PLCs nuevos.
import { useState } from 'react'

export default function AddPlcPanel() {
  const [host, setHost] = useState('')
  const [puerto, setPuerto] = useState(4840)
  const [ocupado, setOcupado] = useState(false)
  const [aviso, setAviso] = useState(null) // { ok, texto }

  const mostrar = (ok, texto) => setAviso({ ok, texto })

  const agregar = async (e) => {
    e.preventDefault()
    if (!host.trim() || ocupado) return
    setOcupado(true)
    setAviso(null)
    try {
      const r = await fetch('/plcs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ host: host.trim(), puerto: Number(puerto) || 4840 }),
      })
      const data = await r.json()
      mostrar(data.ok, data.mensaje ?? (data.ok ? 'PLC añadido.' : 'No se pudo añadir.'))
      if (data.ok) setHost('')
    } catch {
      mostrar(false, 'Error de red hablando con el backend.')
    } finally {
      setOcupado(false)
    }
  }

  const escanear = async () => {
    if (ocupado) return
    setOcupado(true)
    setAviso({ ok: true, texto: 'Escaneando la subred…' })
    try {
      const r = await fetch('/discover', { method: 'POST' })
      const data = await r.json()
      mostrar(data.ok, data.mensaje ?? 'Escaneo terminado.')
    } catch {
      mostrar(false, 'Error de red durante el escaneo.')
    } finally {
      setOcupado(false)
    }
  }

  return (
    <form className="add-plc" onSubmit={agregar}>
      <input
        type="text"
        placeholder="IP del PLC  (ej. 192.168.50.1 o opc.tcp://…)"
        value={host}
        onChange={(e) => setHost(e.target.value)}
        disabled={ocupado}
      />
      <input
        type="number"
        className="puerto"
        title="Puerto OPC UA"
        min="1"
        max="65535"
        value={puerto}
        onChange={(e) => setPuerto(e.target.value)}
        disabled={ocupado}
      />
      <button type="submit" disabled={ocupado || !host.trim()}>
        Conectar PLC
      </button>
      <button type="button" className="secundario" onClick={escanear} disabled={ocupado}>
        {ocupado ? 'Trabajando…' : 'Escanear red'}
      </button>
      {aviso && (
        <span className={`aviso ${aviso.ok ? 'ok' : 'ko'}`}>{aviso.texto}</span>
      )}
    </form>
  )
}
