import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Backend FastAPI (uvicorn app.main:app --port 8000)
const BACKEND = 'http://localhost:8000'

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
    },
  },
  build: {
    outDir: 'dist',
  },
})
