import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Sentry, initSentry } from './config/sentry'
import './index.css'
import App from './App'

// Sentry: inicializa antes de montar React para capturar errores tempranos.
// Si VITE_SENTRY_DSN no está set, todo lo siguiente es no-op.
initSentry()

function FallbackUI({ error, resetError }) {
  return (
    <div style={{
      minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: 24, fontFamily: '-apple-system, BlinkMacSystemFont, sans-serif',
    }}>
      <div style={{
        maxWidth: 480, padding: 24, borderRadius: 12,
        background: '#fff', boxShadow: '0 1px 3px rgba(0,0,0,0.08)',
      }}>
        <h2 style={{ margin: 0, color: '#111827', fontSize: 18 }}>Algo salió mal</h2>
        <p style={{ marginTop: 8, color: '#6b7280', fontSize: 14 }}>
          El equipo ya recibió un reporte automático. Mientras tanto, puedes
          recargar la página o volver al inicio.
        </p>
        {error?.message && (
          <pre style={{
            marginTop: 12, padding: 10, background: '#f9fafb', borderRadius: 6,
            fontSize: 12, color: '#374151', overflowX: 'auto',
          }}>{String(error.message)}</pre>
        )}
        <div style={{ marginTop: 16, display: 'flex', gap: 8 }}>
          <button onClick={resetError} style={btnStyle('primary')}>Reintentar</button>
          <button onClick={() => { window.location.href = '/' }} style={btnStyle('secondary')}>
            Ir al inicio
          </button>
        </div>
      </div>
    </div>
  )
}

function btnStyle(variant) {
  return {
    padding: '8px 14px', borderRadius: 8, fontSize: 14, fontWeight: 500,
    cursor: 'pointer', border: 'none',
    background: variant === 'primary' ? '#1a3a5c' : '#e5e7eb',
    color:      variant === 'primary' ? '#ffffff' : '#374151',
  }
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <Sentry.ErrorBoundary fallback={FallbackUI} showDialog={false}>
      <App />
    </Sentry.ErrorBoundary>
  </StrictMode>
)
