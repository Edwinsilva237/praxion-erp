/**
 * Overlay fullscreen que aparece cuando el usuario entra al ERP por la
 * URL antigua de Render (`praxion-web.onrender.com`) en lugar del dominio
 * oficial. Muestra mensaje + botón para ir a la URL correcta.
 *
 * Estrategia "soft redirect": no usamos window.location.replace automático
 * porque si el usuario tiene un bookmark viejo o lo recibió por email, un
 * redirect silencioso lo deja confundido sobre por qué cambió la URL. Mejor
 * mostrarle el cambio explícito 1 vez.
 *
 * Se monta en App.jsx ANTES del Router, así no consume rutas ni queries.
 */

const LEGACY_HOST = 'praxion-web.onrender.com'
const OFFICIAL_URL = 'https://app.praxionops.com'

export default function LegacyHostnameNotice() {
  const host = typeof window !== 'undefined'
    ? (window.location.hostname || '').toLowerCase()
    : ''

  if (host !== LEGACY_HOST) return null

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-[100000] flex items-center justify-center bg-black/80 p-4"
    >
      <div className="bg-surface-primary border border-line-subtle rounded-2xl max-w-md w-full p-6 shadow-2xl">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 rounded-full bg-status-warning/15 flex items-center justify-center text-status-warning text-xl">
            ⚠
          </div>
          <h2 className="text-lg font-semibold text-ink-primary">
            Esta dirección ya no es la oficial
          </h2>
        </div>

        <p className="text-sm text-ink-secondary mb-3">
          El ERP ahora vive en su propio dominio. La dirección{' '}
          <span className="font-mono text-[12px] bg-surface-elevated px-1.5 py-0.5 rounded">
            praxion-web.onrender.com
          </span>{' '}
          es temporal y será deshabilitada.
        </p>

        <p className="text-sm text-ink-secondary mb-4">
          Actualiza tus marcadores y entra a:
        </p>

        <div className="bg-brand-500/10 border border-brand-500/30 rounded-lg p-3 mb-4">
          <p className="font-mono text-sm text-brand-300 font-semibold text-center">
            {OFFICIAL_URL}
          </p>
        </div>

        <p className="text-[11px] text-ink-muted mb-5">
          Si tu empresa tiene su propio subdominio (ej.{' '}
          <span className="font-mono">acme.praxionops.com</span>), úsalo
          directamente para entrar más rápido a tu cuenta.
        </p>

        <div className="flex gap-2">
          <a
            href={OFFICIAL_URL}
            className="flex-1 btn-primary justify-center"
          >
            Ir a la nueva dirección
          </a>
        </div>
      </div>
    </div>
  )
}
