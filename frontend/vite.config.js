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
      // Los DOS niveles del diseño: '/proyectos' agrupa pantallas y
      // '/pantallas' es cada diseño. Son prefijos distintos, así que hacen
      // falta las dos líneas: con solo '/proyectos', Vite se quedaba las
      // peticiones de pantallas y devolvía el index.html, y la barra de
      // pestañas se veía vacía con un 404 que parecía del backend.
      '/proyectos': BACKEND,
      '/pantallas': BACKEND,
      // Paleta y tipografías (el Gestor de Temas). SIN esta línea el GET
      // /temas no sale de Vite: el servidor de desarrollo responde el
      // index.html de la aplicación, así que el fetch recibe HTML donde
      // esperaba JSON, el catálogo se queda vacío y el Gestor enseña «No hay
      // ningún tema seleccionado» — con el backend funcionando perfectamente.
      '/temas': BACKEND,
      '/locks': BACKEND,
      '/auditoria': BACKEND,
      // Flow Editor: conexiones a BD y grupos del historizador.
      // El proxy matchea por PREFIJO, así que '/historian' ya cubre
      // /historian/{id}/start, /stop, /datos, flush y el DELETE.
      '/db': BACKEND,
      '/historian': BACKEND,
      // CRUD del esquema del HMI: alarmas, definiciones de alarma y los
      // cuatro niveles de recetas. Sin esta línea, `GET /crud/recetas`
      // se lo queda Vite y responde el index.html de la SPA con un 404,
      // que en la consola se ve como "el backend no tiene ese endpoint"
      // cuando en realidad la petición nunca salió de aquí.
      '/crud': BACKEND,
      // Alarmas EN EJECUCIÓN: pendientes, histórico y reconocimiento. Es
      // distinto de '/crud/alarmas', que es la tabla en crudo. Sin esta
      // línea el banner del operador no vería nunca una alarma: Vite
      // devolvería el index.html y el fetch fallaría al parsearlo.
      '/alarmas': BACKEND,
      // Carpeta de datos de la aplicación instalada (ver §11) y copia zip.
      '/sistema': BACKEND,
      // Exportaciones (CSV/XLSX) y el asistente de IA.
      '/export': BACKEND,
      '/ai': BACKEND,
      '/widgets': BACKEND
      
    },
  },
  build: {
    outDir: 'dist',
  },
})
