import { useState } from 'react'
import { useQuery, useMutation } from '@tanstack/react-query'
import { billingApi } from '@/api/billing'
import Spinner from '@/components/ui/Spinner'
import Can from '@/components/auth/Can'

export default function Planes() {
  const [error, setError] = useState(null)

  const { data: plans, isLoading: loadingPlans } = useQuery({
    queryKey: ['billing-plans'],
    queryFn:  billingApi.listPlans,
  })

  const { data: sub } = useQuery({
    queryKey: ['billing-subscription'],
    queryFn:  billingApi.getSubscription,
    retry: false,
  })

  const checkout = useMutation({
    mutationFn: billingApi.checkout,
    onSuccess: ({ url }) => {
      // Stripe redirige a su Checkout. Al volver el usuario cae en
      // /configuracion/suscripcion?status=success|cancel
      window.location.href = url
    },
    onError: (e) => setError(e.response?.data?.error || e.message),
  })

  // Filtramos planes no comprables (sin stripe_price_id, p.ej. 'free', 'owner').
  // Pero mostramos 'free' aparte arriba como "tu plan inicial".
  const visiblePlans = plans?.filter(p => p.slug !== 'owner') || []

  return (
    <div className="page-enter max-w-5xl mx-auto py-6 px-4 flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-ink-primary">Planes y precios</h1>
        <p className="text-sm text-ink-muted mt-1">
          Elige el plan que mejor se ajuste a tu operación. Puedes cambiar o cancelar cuando quieras.
        </p>
      </div>

      {error && <div className="alert-error text-sm">{error}</div>}

      {loadingPlans ? (
        <div className="flex justify-center py-10"><Spinner /></div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {visiblePlans.map(plan => {
            const isCurrent = sub?.plan_slug === plan.slug
            const price = plan.price_mxn_cents / 100

            return (
              <div key={plan.slug}
                   className={`card p-5 flex flex-col gap-4 ${isCurrent ? 'ring-2 ring-blue-500' : ''}`}>
                <div>
                  <h2 className="text-lg font-semibold text-ink-primary">{plan.name}</h2>
                  {plan.description && (
                    <p className="text-xs text-ink-muted mt-1">{plan.description}</p>
                  )}
                </div>

                <div className="text-3xl font-bold text-ink-primary">
                  {price === 0 ? 'Gratis' : (
                    <>
                      ${price.toLocaleString('es-MX', { maximumFractionDigits: 0 })}
                      <span className="text-sm font-normal text-ink-muted"> /mes</span>
                    </>
                  )}
                </div>

                <ul className="text-sm text-ink-secondary flex flex-col gap-2 flex-1">
                  <li>
                    {plan.max_users === null
                      ? 'Usuarios ilimitados'
                      : `Hasta ${plan.max_users} usuarios`}
                  </li>
                  <li>
                    {plan.max_invoices_per_month === null
                      ? 'Facturas (CFDI) ilimitadas'
                      : `${plan.max_invoices_per_month} facturas (CFDI) por mes`}
                  </li>
                </ul>

                {isCurrent ? (
                  <button className="btn-secondary" disabled>
                    Plan actual
                  </button>
                ) : !plan.purchasable ? (
                  <button className="btn-secondary" disabled title="Plan no disponible para contratar">
                    No disponible
                  </button>
                ) : (
                  <Can do="billing:manage" fallback={
                    <button className="btn-secondary" disabled title="Solo el dueño puede contratar planes">
                      Sin permiso
                    </button>
                  }>
                    <button
                      className="btn-primary"
                      disabled={checkout.isPending}
                      onClick={() => { setError(null); checkout.mutate(plan.slug) }}>
                      {checkout.isPending ? 'Conectando…' : 'Suscribirme'}
                    </button>
                  </Can>
                )}
              </div>
            )
          })}
        </div>
      )}

      <p className="text-xs text-ink-muted mt-2">
        Los cobros se procesan de forma segura por Stripe. Tu información de tarjeta nunca toca nuestros servidores.
      </p>
    </div>
  )
}
