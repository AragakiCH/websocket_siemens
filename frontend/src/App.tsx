import React from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { AppStoreProvider } from './context/AppStore';
import { Login } from './pages/Login';
import { Actividad } from './pages/Actividad';
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
        <div className="h-full w-full">
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
      </BrowserRouter>
    </AppStoreProvider>);

}