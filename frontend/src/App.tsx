import React from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { AppStoreProvider } from './context/AppStore';
import { Login } from './pages/Login';
import { Actividad } from './pages/Actividad';
import { Usuarios } from './pages/Usuarios';
import { Alarmas } from './pages/Alarmas';
import { BannerAlarmas } from './components/alarms/BannerAlarmas';
import { RutaProtegida } from './components/auth/RutaProtegida';
import { MainMenu } from './pages/MainMenu';
import { Configuracion } from './pages/Configuracion';
import { Designer } from './pages/Designer';

import { Preview } from './pages/Preview';   

function Page({ children }: {children: React.ReactNode;}) {
  return (
    <motion.div
      initial={{
        opacity: 0
      }}
      animate={{
        opacity: 1
      }}
      exit={{
        opacity: 0
      }}
      transition={{
        duration: 0.25
      }}
      className="h-full w-full">
      
      {children}
    </motion.div>);

}
export function App() {
  return (
    <AppStoreProvider>
      <BrowserRouter>
        {/* `flex-col` y no el `h-full` de antes: el banner de alarmas es un
            hermano de las páginas, no un elemento flotante encima. Así,
            cuando aparece, EMPUJA la pantalla hacia abajo en vez de taparle
            los primeros píxeles — que en el Diseñador serían la barra de
            herramientas y en la Vista Previa, widgets del operador. */}
        <div className="flex h-full w-full flex-col">
          {/* Fuera de <Routes> a propósito: así sobrevive a los cambios de
              pantalla sin desmontarse ni volver a consultar, y una alarma que
              salta mientras navegas no se pierde. Él decide en qué rutas no
              pintarse (ver RUTAS_SIN_BANNER). */}
          <BannerAlarmas />
          <div className="min-h-0 flex-1">
          <AnimatePresence mode="wait">
            <Routes>
              {/* La raíz es el acceso; el menú se mudó a /menu. */}
              <Route
                path="/"
                element={
                <Page>
                    <Login />
                  </Page>
                } />

              <Route
                path="/menu"
                element={
                <RutaProtegida>
                    <Page>
                      <MainMenu />
                    </Page>
                  </RutaProtegida>
                } />

              <Route
                path="/config"
                element={
                <RutaProtegida>
                    <Page>
                      <Configuracion />
                    </Page>
                  </RutaProtegida>
                } />
              
              <Route
                path="/designer"
                element={
                <RutaProtegida>
                    <Page>
                      <Designer />
                    </Page>
                  </RutaProtegida>
                } />

              {/* Actividad: quién está trabajando y qué se ha hecho. El
                  permiso real lo aplica el backend en cada endpoint; esta
                  ruta solo evita mostrar una pantalla vacía a quien no debe
                  verla. */}
              <Route
                path="/actividad"
                element={
                <RutaProtegida rolMinimo="Administradores">
                    <Page>
                      <Actividad />
                    </Page>
                  </RutaProtegida>
                } />

              {/* Alarmas en ejecución. SIN `rolMinimo`: en una planta, el
                  estado de las alarmas es lo primero que cualquiera tiene
                  que poder ver, y esconderlo detrás de un rol no protege
                  nada (los valores del PLC ya viajan por el WebSocket).
                  Reconocer sí pide sesión, y lo aplica el backend. */}
              <Route
                path="/alarmas"
                element={
                <RutaProtegida>
                    <Page>
                      <Alarmas />
                    </Page>
                  </RutaProtegida>
                } />

              {/* Cuentas. La ruta pide `Administradores` —lo mismo que hace
                  falta para LEER el listado—, no `Supervisor`. Poner aquí el
                  rol de escritura dejaría al Administrador fuera de una
                  pantalla que sí tiene derecho a consultar; la propia vista
                  se presenta en modo consulta y deshabilita los botones que
                  el backend le rechazaría con un 403. */}
              <Route
                path="/usuarios"
                element={
                <RutaProtegida rolMinimo="Administradores">
                    <Page>
                      <Usuarios />
                    </Page>
                  </RutaProtegida>
                } />

                <Route
            path="/preview"
            element={
            <Page>
                <Preview />
              </Page>
            } />
              
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </AnimatePresence>
          </div>
        </div>
      </BrowserRouter>
    </AppStoreProvider>);

}