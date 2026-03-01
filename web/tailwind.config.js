/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        surface: {
          950: '#070b14',
          900: '#0f172a',
          850: '#131d34',
          800: '#18243f',
          700: '#223051'
        },
        accent: {
          400: '#60a5fa',
          500: '#3b82f6',
          600: '#2563eb'
        }
      },
      boxShadow: {
        soft: '0 10px 30px rgba(8, 15, 30, 0.35)',
        panel: '0 4px 20px rgba(2, 8, 23, 0.35)'
      },
      keyframes: {
        fadeUp: {
          '0%': { opacity: '0', transform: 'translateY(6px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' }
        }
      },
      animation: {
        fadeUp: 'fadeUp 240ms ease-out'
      }
    }
  },
  plugins: []
};
