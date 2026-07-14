// =========================================================================
// useWebSocket.js
// Hook que gestiona la conexión al endpoint /ws del backend FastAPI.
//
// Protocolo del backend:
//   * snapshot    : { type:"snapshot", timestamp, plcs:{id:{...}}, tags:{"plc|tag":{...}} }
//   * status      : { type:"status", plc, status:"conectado"|"reconectando", timestamp }
//   * plc_removed : { type:"plc_removed", plc_removed:"<id>" }
//   * cambio      : { plc, tag, value, type(<- tipo de dato), timestamp,
//                     source_ts, server_ts, delta_ms }
//
// Reconexión automática con backoff simple.
// =========================================================================
import { useCallback, useEffect, useRef, useState } from 'react'

const RETRY_MS = 3000

export function useWebSocket(plcFilter = null) {
  const [estado, setEstado] = useState('conectando') // conectando | conectado | desconectado
  const [plcs, setPlcs] = useState({})               // { plcId: {nombre, endpoint, estado, conectado, ...} }
  const [tags, setTags] = useState({})               // { "plc|tag": {plc, tag, value, type, timestamp, delta_ms, ...} }
  const [ultimoMensaje, setUltimoMensaje] = useState(null)
  const wsRef = useRef(null)
  const timerRef = useRef(null)
  const cerradoManualRef = useRef(false)

  const conectar = useCallback(() => {
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
    const query = plcFilter ? `?plc=${encodeURIComponent(plcFilter)}` : ''
    const url = `${proto}://${window.location.host}/ws${query}`

    setEstado('conectando')
    const ws = new WebSocket(url)
    wsRef.current = ws

    ws.onopen = () => setEstado('conectado')

    ws.onmessage = (ev) => {
      let msg
      try {
        msg = JSON.parse(ev.data)
      } catch {
        return
      }
      setUltimoMensaje(msg)

      if (msg.type === 'snapshot') {
        // Si esta conexión filtra por PLC, quedarse solo con lo suyo
        // (los snapshots por broadcast traen todos los PLCs).
        const plcsIn = msg.plcs ?? {}
        const tagsIn = msg.tags ?? {}
        if (plcFilter) {
          setPlcs(plcsIn[plcFilter] ? { [plcFilter]: plcsIn[plcFilter] } : {})
          setTags(
            Object.fromEntries(
              Object.entries(tagsIn).filter(([, t]) => t.plc === plcFilter)
            )
          )
        } else {
          setPlcs(plcsIn)
          setTags(tagsIn)
        }
      } else if (msg.type === 'plc_removed') {
        // Un PLC fue eliminado desde algún cliente: limpiar su estado.
        const id = msg.plc_removed
        setPlcs((prev) => {
          const { [id]: _omitido, ...resto } = prev
          return resto
        })
        setTags((prev) =>
          Object.fromEntries(Object.entries(prev).filter(([, t]) => t.plc !== id))
        )
      } else if (msg.type === 'status') {
        // Estado de conexión de un PLC
        setPlcs((prev) => ({
          ...prev,
          [msg.plc]: {
            ...(prev[msg.plc] ?? {}),
            estado: msg.status,
            conectado: msg.status === 'conectado',
          },
        }))
      } else if (msg.tag) {
        // Cambio de valor de un tag (msg.type aquí es el TIPO DE DATO)
        const clave = `${msg.plc}|${msg.tag}`
        setTags((prev) => ({ ...prev, [clave]: msg }))
      }
    }

    ws.onclose = () => {
      setEstado('desconectado')
      if (!cerradoManualRef.current) {
        timerRef.current = setTimeout(conectar, RETRY_MS)
      }
    }

    ws.onerror = () => ws.close()
  }, [plcFilter])

  useEffect(() => {
    cerradoManualRef.current = false
    conectar()
    return () => {
      cerradoManualRef.current = true
      clearTimeout(timerRef.current)
      wsRef.current?.close()
    }
  }, [conectar])

  return { estado, plcs, tags, ultimoMensaje }
}
