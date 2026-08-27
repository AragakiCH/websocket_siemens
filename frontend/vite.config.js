import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Backend FastAPI (uvicorn app.main:app --port 8000).
// El puerto se puede sobrescribir con la variable de entorno BACKEND_PORT;
// `tools/dev.py` la define sola cuando se arranca con --puerto, para que el
// proxy siga apuntando al backend correcto.
const BACKEND_PORT = process.env.BACKEND_PORT || '8000'
const BACKEND = `http://localhost:${BACKEND_PORT}`

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // WebSocket en tiempo real
      '/ws': { target: BACKEND, ws: true },
      // Endpoints REST del backend
      '/health': BACKEND,
      '/plcs': BACKEND,
      '/tags': BACKEND,
      '/browse': BACKEND,
      '/discover': BACKEND,
      // Exploración del ctrlX de Rexroth (apps y programas) desde el Login
      '/rexroth': BACKEND,
      // Multiusuario: identidad, diseño compartido, bloqueo de edición y
      // auditoría. OJO: si falta alguno de estos, Vite responde el index.html
      // de la SPA en vez de reenviar al backend, y la vista lo interpreta
      // como un fallo — por ejemplo, el Diseñador se queda en "Solo lectura"
      // porque no consigue pedir el lápiz.
      '/auth': BACKEND,
      '/proyectos': BACKEND,
      '/locks': BACKEND,
      '/auditoria': BACKEND,
      // Flow Editor: conexiones a BD y grupos del historizador.
      // El proxy matchea por PREFIJO, así que '/historian' ya cubre
      // /historian/{id}/start, /stop, /datos, flush y el DELETE.
      '/db': BACKEND,
      '/historian': BACKEND,
    },
  },
  build: {
    outDir: 'dist',
  },
})
