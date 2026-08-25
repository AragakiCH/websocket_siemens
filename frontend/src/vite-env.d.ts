/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * Origen del backend para el Flow Editor (ver flows/api.ts).
   *
   * Normalmente NO se define: sin ella las rutas son relativas y las resuelve
   * el proxy de Vite en desarrollo, o el propio FastAPI en producción. Solo
   * hace falta si el backend vive en una máquina distinta a la del navegador.
   *
   *   frontend/.env  ->  VITE_API_BASE=http://192.168.1.50:8000
   */
  readonly VITE_API_BASE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
