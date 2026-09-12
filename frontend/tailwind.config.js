
export default {content: [
  './index.html',
  './src/**/*.{js,ts,jsx,tsx}'
],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        siemens: {
          DEFAULT: '#009999',
          50: '#e6f5f5',
          100: '#c0e8e8',
          200: '#8fd6d6',
          300: '#4dbdbd',
          400: '#1aa8a8',
          500: '#009999',
          600: '#007a7a',
          700: '#006363',
          800: '#004d4d',
          900: '#003838',
        },
        navy: {
          DEFAULT: '#0f172a',
          soft: '#1e293b',
          slate: '#334155',
        },
        state: {
          ok: '#22c55e',
          error: '#ef4444',
          warn: '#f59e0b',
        },
        // Los colores del GESTOR DE TEMAS. Apuntan a las variables que
        // `TemaProvider` escribe en <html>, así que cambian en caliente y sin
        // recompilar nada — al revés que `siemens` o `navy`, que se resuelven
        // al compilar y por eso sólo obedecen al interruptor claro/oscuro.
        //
        // OJO con las transparencias: `bg-tema-ok/10` NO funciona. Tailwind
        // necesita los canales sueltos para inyectar la opacidad, y aquí la
        // variable trae el color entero. Para los fondos suaves están los
        // roles «contenedor» del propio tema.
        tema: {
          fondo: 'var(--psi-background)',
          'sobre-fondo': 'var(--psi-on-background)',
          superficie: 'var(--psi-surface)',
          'sobre-superficie': 'var(--psi-on-surface)',
          'superficie-alt': 'var(--psi-surface-variant)',
          'sobre-superficie-alt': 'var(--psi-on-surface-variant)',
          borde: 'var(--psi-outline)',
          'borde-suave': 'var(--psi-outline-variant)',
          primario: 'var(--psi-primary)',
          'sobre-primario': 'var(--psi-on-primary)',
          ok: 'var(--psi-success)',
          'ok-fondo': 'var(--psi-success-container)',
          'sobre-ok-fondo': 'var(--psi-on-success-container)',
          error: 'var(--psi-error)',
          'error-fondo': 'var(--psi-error-container)',
          'sobre-error-fondo': 'var(--psi-on-error-container)',
          aviso: 'var(--psi-warning)',
          'aviso-fondo': 'var(--psi-warning-container)',
          'sobre-aviso-fondo': 'var(--psi-on-warning-container)',
        },
        // Los colores del GESTOR DE TEMAS. Apuntan a las variables que
        // `TemaProvider` escribe en <html>, así que cambian en caliente y sin
        // recompilar nada — al revés que `siemens` o `navy`, que se resuelven
        // al compilar y por eso sólo obedecen al interruptor claro/oscuro.
        //
        // OJO con las transparencias: `bg-tema-ok/10` NO funciona. Tailwind
        // necesita los canales sueltos para inyectar la opacidad, y aquí la
        // variable trae el color entero. Para los fondos suaves están los
        // roles «contenedor» del propio tema.
        tema: {
          fondo: 'var(--psi-background)',
          'sobre-fondo': 'var(--psi-on-background)',
          superficie: 'var(--psi-surface)',
          'sobre-superficie': 'var(--psi-on-surface)',
          'superficie-alt': 'var(--psi-surface-variant)',
          'sobre-superficie-alt': 'var(--psi-on-surface-variant)',
          borde: 'var(--psi-outline)',
          'borde-suave': 'var(--psi-outline-variant)',
          primario: 'var(--psi-primary)',
          'sobre-primario': 'var(--psi-on-primary)',
          ok: 'var(--psi-success)',
          'ok-fondo': 'var(--psi-success-container)',
          'sobre-ok-fondo': 'var(--psi-on-success-container)',
          error: 'var(--psi-error)',
          'error-fondo': 'var(--psi-error-container)',
          'sobre-error-fondo': 'var(--psi-on-error-container)',
          aviso: 'var(--psi-warning)',
          'aviso-fondo': 'var(--psi-warning-container)',
          'sobre-aviso-fondo': 'var(--psi-on-warning-container)',
        },
      },
      boxShadow: {
        card: '0 4px 24px -8px rgba(15, 23, 42, 0.15)',
        cardHover: '0 20px 48px -12px rgba(0, 153, 153, 0.35)',
      },
      fontFamily: {
        // La familia la decide el TEMA (Gestor de Temas → Tipografías). El
        // respaldo va DENTRO del var() para que `font-sans` siga valiendo
        // aunque no haya tema cargado: sin él, la declaración sería inválida
        // y el texto heredaría la fuente del navegador.
        sans: ['var(--psi-fuente-cuerpo, Inter)', 'system-ui', 'sans-serif'],
      },
    },
  },
}
