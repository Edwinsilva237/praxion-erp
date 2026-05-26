import { useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { billingApi } from '@/api/billing'
import { tenantsApi } from '@/api/tenants'
import useAuthStore from '@/store/useAuthStore'

// Pantalla a la que aterriza un usuario cuyo tenant está suspendido.
// Cambia el mensaje según el motivo:
//   - suspended_reason='payment' → invita a pagar; promete auto-reactivación
//   - suspended_reason='manual'  → pide contactar soporte (no se auto-reactiva)
export default function Suspendido() {
  const { user, tenant, logout } = useAuthStore()
  const [error, setError] = useState(null)

  const { data: t } = useQuery({
    queryKey: ['tenant', 'current'],
    queryFn:  tenantsApi.getCurrent,
    staleTime: 30 * 1000,
  })
  const reason = t?.suspended_reason || 'manual'
  const isPayment = reason === 'payment'

  const portal = useMutation({
    mutationFn: billingApi.openPortal,
    onSuccess: ({ url }) => { window.location.href = url },
    onError: (e) => setError(e.response?.data?.error || e.message),
  })

  return (
    <div className="min-h-screen flex items-center justify-center bg-bg-primary p-4">
      <div className="max-w-md w-full card p-6 flex flex-col gap-5">

        <div className="flex items-center gap-3">
          <div className="w-12 h-12 rounded-full bg-status-danger/15 text-status-danger flex items-center justify-center shrink-0">
            <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
          </div>
          <div>
            <h1 className="text-xl font-semibold text-ink-primary">Cuenta suspendida</h1>
            <p className="text-sm text-ink-muted">
              {tenant?.name || tenant?.slug || 'Tu organización'} no está activa en este momento
            </p>
          </div>
        </div>

        <div className="bg-surface-elevated/50 border border-line-subtle rounded-lg p-4 text-sm text-ink-secondary space-y-2">
          <p>
            Hola <strong className="text-ink-primary">{user?.fullName}</strong>,
          </p>
          {isPayment ? (
            <>
              <p>
                Tu organización está suspendida por un <strong className="text-status-warning">cobro pendiente</strong>.
              </p>
              <p className="text-xs">
                Actualiza tu método de pago en el botón de abajo. <strong>En cuanto Stripe
                confirme el cobro, tu cuenta se reactivará automáticamente</strong> — no
                tienes que esperar a que nadie te apruebe.
              </p>
            </>
          ) : (
            <>
              <p>
                Tu organización fue <strong>suspendida por el administrador de Praxion</strong>.
              </p>
              <p className="text-xs">
                Para reactivarla necesitas contactar al equipo de soporte. Si tu duda es
                de pago, también puedes abrir el portal por si necesitas actualizar
                información.
              </p>
            </>
          )}
        </div>

        {error && <div className="alert-error text-xs">{error}</div>}

        <div className="flex flex-col gap-2">
          <button
            onClick={() => { setError(null); portal.mutate() }}
            disabled={portal.isPending}
            className={isPayment ? 'btn-primary w-full justify-center' : 'btn-secondary w-full justify-center'}>
            <svg className="w-4 h-4 mr-1.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z" />
            </svg>
            {portal.isPending ? 'Abriendo portal...' : 'Actualizar método de pago'}
          </button>

          <a href="mailto:soporte@praxionops.com?subject=Cuenta suspendida"
            className={isPayment ? 'btn-ghost w-full justify-center text-center' : 'btn-primary w-full justify-center text-center'}>
            Contactar a soporte
          </a>

          <button onClick={() => logout()} className="btn-ghost w-full justify-center text-ink-muted">
            Cerrar sesión
          </button>
        </div>

        <p className="text-[11px] text-ink-muted text-center">
          Si crees que es un error, escríbenos a{' '}
          <a href="mailto:soporte@praxionops.com" className="text-status-info hover:underline">
            soporte@praxionops.com
          </a>
          .
        </p>
      </div>
    </div>
  )
}
