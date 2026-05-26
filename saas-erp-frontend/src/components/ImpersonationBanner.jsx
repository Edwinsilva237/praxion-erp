import { useNavigate } from 'react-router-dom'
import { useState } from 'react'
import useAuthStore from '@/store/useAuthStore'
import Spinner from '@/components/ui/Spinner'

/**
 * Banner rojo que aparece en TODA la app cuando estás impersonando un tenant.
 * Muestra que NO eres el usuario real y permite volver a tu cuenta de un click.
 */
export default function ImpersonationBanner() {
  const navigate = useNavigate()
  const impersonation = useAuthStore((s) => s.impersonation)
  const tenant        = useAuthStore((s) => s.tenant)
  const endImpersonation = useAuthStore((s) => s.endImpersonation)
  const [exiting, setExiting] = useState(false)

  if (!impersonation) return null

  const handleEnd = async () => {
    setExiting(true)
    try {
      await endImpersonation()
      navigate('/superadmin', { replace: true })
    } finally {
      setExiting(false)
    }
  }

  return (
    <div className="bg-status-danger text-white text-xs sm:text-sm font-medium
                    px-3 sm:px-4 py-2 flex items-center justify-between gap-3
                    flex-wrap shadow-sm relative z-30">
      <div className="flex items-center gap-2 min-w-0">
        <svg className="w-4 h-4 shrink-0" fill="currentColor" viewBox="0 0 20 20">
          <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm.75-13a.75.75 0 00-1.5 0v5c0 .414.336.75.75.75h4a.75.75 0 000-1.5h-3.25V5z" clipRule="evenodd"/>
        </svg>
        <span className="truncate">
          <strong>MODO IMPERSONACIÓN</strong>
          {' · '}
          Estás viendo <strong>{tenant?.name}</strong> como su admin
          {' · '}
          Tus acciones quedan registradas
        </span>
      </div>
      <button
        onClick={handleEnd}
        disabled={exiting}
        className="shrink-0 bg-white/15 hover:bg-white/25 disabled:opacity-60
                   text-white text-xs font-semibold px-3 py-1 rounded-md
                   flex items-center gap-1.5 transition-colors"
      >
        {exiting ? <Spinner size="sm" className="text-white" /> : <span>↩</span>}
        Volver a mi cuenta
      </button>
    </div>
  )
}
