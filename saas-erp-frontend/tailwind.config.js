/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        // ── Paleta Praxion Systems ────────────────────────────────────────
        // Fondos grafito (65%), superficies oscuras (20%), texto claro (10%),
        // verde industrial (5% como acento). Ver praxion_frontend_style_guide.
        bg: {
          primary:   '#0B0F12',
          secondary: '#111820',
          tertiary:  '#18222C',
        },
        surface: {
          primary:  '#121820',
          secondary:'#1A232D',
          elevated: '#202B36',
        },
        // ── Acento verde Praxion ──────────────────────────────────────────
        // Mantenemos 'brand' y 'accent' por compatibilidad con código que ya
        // las usa (.bg-brand-600, etc.) — apuntan al verde nuevo.
        brand: {
          50:  '#EAF5DE',
          100: '#D2EBBE',
          200: '#A8D88C',
          300: '#7ABF45',  // green-secondary Praxion
          400: '#6DAE3A',
          500: '#5E9F32',  // green-primary
          600: '#5E9F32',  // botón primario
          700: '#4D8629',
          800: '#3F7324',  // green-dark
          900: '#2C5418',
        },
        accent: {
          50:  '#EAF5DE',
          100: '#D2EBBE',
          200: '#A8D88C',
          300: '#7ABF45',
          400: '#6DAE3A',
          500: '#5E9F32',
          600: '#4D8629',
          700: '#3F7324',
          800: '#2C5418',
          900: '#1E3A10',
        },
        // ── Texto Praxion ─────────────────────────────────────────────────
        ink: {
          primary:   '#F4F7F8',
          secondary: '#B7C0C7',
          muted:     '#7E8A94',
        },
        // ── Bordes Praxion ────────────────────────────────────────────────
        line: {
          subtle: '#2A3540',
          strong: '#3A4652',
        },
        // ── Estados (uso moderado) ────────────────────────────────────────
        status: {
          success: '#5E9F32',
          warning: '#D8A23A',
          danger:  '#D95C5C',
          info:    '#4C8CCF',
        },
      },
      fontFamily: {
        sans: ['Sora', '"DM Sans"', 'Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        display: ['Sora', 'Inter', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'SFMono-Regular', 'monospace'],
      },
      borderRadius: {
        sm: '6px',
        md: '10px',
        lg: '16px',
        xl: '24px',
      },
      boxShadow: {
        soft: '0 12px 32px rgba(0, 0, 0, 0.28)',
        card: '0 8px 24px rgba(0, 0, 0, 0.18)',
      },
      transitionTimingFunction: {
        praxion: 'cubic-bezier(0.4, 0, 0.2, 1)',
      },
    },
  },
  plugins: [],
}
