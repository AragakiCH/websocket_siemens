
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
      },
      boxShadow: {
        card: '0 4px 24px -8px rgba(15, 23, 42, 0.15)',
        cardHover: '0 20px 48px -12px rgba(0, 153, 153, 0.35)',
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
      },
    },
  },
}
