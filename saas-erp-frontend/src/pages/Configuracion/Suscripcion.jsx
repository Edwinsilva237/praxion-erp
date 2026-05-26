import { useEffect, useState } from 'react'
import { useQuery, useMutation } from '@tanstack/react-query'
import { useSearchParams, Link } from 'react-router-dom'
import { billingApi } from '@/api/billing'
import Spinner from '@/components/ui/Spinner'
import Can from '@/components/auth/Can'

const STATUS_LABELS = {
  trialing:           { label: 'Periodo de prueba', color: 'bg-status-info/15 text-status-info' },
  active:             { label: 'Activa',            color: 'bg-status-success/15 text-status-success' },
  past_due:           { label: 'Cobro pendiente',   color: 'bg-status-warning/15 text-status-warning' },
  canceled:           { label: 'Cancelada',         color: 'bg-status-danger/15 text-status-danger' },
  incomplete:         { label: 'Incompleta',        color: 'bg-surface-elevated/60 text-ink-primary' },
  incomplete_expired: { label: 'Expirada',          color: 'bg-surface-elevated/60 text-ink-primary' },
}

export default function Suscripcion() {
  const [searchParams] = useSearchParams()
  const [postCheckoutMsg, setPostCheckoutMsg] = useState(null)
  const [error, setError] = useState(null)

  // Mensaje post-Stripe Checkout (?status=success|cancel)
  useEffect(() => {
    const status = searchParams.get('status')
    if (status === 'success') {
      setPostCheckoutMsg({
        type: 'success',
        text: 'Pago procesado. Tu suscripción se está activando — puede tardar unos segundos en reflejarse.',
      })
    } else if (status === 'cancel') {
      setPostCheckoutMsg({
        type: 'info',
        text: 'Cancelaste el proceso de pago. Tu plan sigue igual.',
      })
    }
  }, [searchParams])

  const { data: sub, isLoading, refetch } = useQuery({
    queryKey: ['billing-subscription'],
    queryFn:  billingApi.getSubscription,
    retry: false,
    // Si acabamos de pagar, refrescar más seguido por unos segundos.
    refetchInterval: postCheckoutMsg?.type === 'success' ? 3000 : false,
  })

  const portal = useMutation({
    mutationFn: billingApi.openPortal,
    onSuccess: ({ url }) => { window.location.href = url },
    onError: (e) => setError(e.response?.data?.error || e.message),
  })

  if (isLoading) {
    return <div className="flex justify-center py-10"><Spinner /></div>
  }

  if (!sub) {
    return (
      <div className="page-enter max-w-3xl mx-auto py-6 px-4">
        <h1 className="text-xl font-semibold text-ink-primary">Mi suscripción</h1>
        <div className="alert-info mt-4">
          Aún no tienes suscripción. <Link to="/configuracion/planes" className="text-status-info underline">Ver planes</Link>
        </div>
      </div>
    )
  }

  const status = STATUS_LABELS[sub.status] || { label: sub.status, color: 'bg-surface-elevated/60' }
  const isOwner = sub.plan_slug === 'owner'

  return (
    <div className="page-enter max-w-3xl mx-auto py-6 px-4 flex flex-col gap-5">
      <div>
        <h1 className="text-xl font-semibold text-ink-primary">Mi suscripción</h1>
        <p className="text-sm text-ink-muted mt-1">
          Información de tu plan y opciones para gestionarlo.
        </p>
      </div>

      {postCheckoutMsg && (
        <div className={postCheckoutMsg.type === 'success' ? 'alert-success' : 'alert-info'}>
          {postCheckoutMsg.text}
        </div>
      )}
      {error && <div className="alert-error">{error}</div>}

      <section className="card p-5 flex flex-col gap-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-xs text-ink-muted uppercase tracking-wide">Plan actual</div>
            <div className="text-2xl font-semibold text-ink-primary mt-1">{sub.plan_name}</div>
          </div>
          <span className={`text-xs px-2 py-1 rounded ${status.color}`}>{status.label}</span>
        </div>

        <div className="grid grid-cols-2 gap-4 text-sm">
          <div>
            <div className="text-ink-muted">Usuarios incluidos</div>
            <div className="font-medium">{sub.max_users === null ? 'Ilimitado' : sub.max_users}</div>
          </div>
          <div>
            <div className="text-ink-muted">Facturas (CFDI) por mes</div>
            <div className="font-medium">{sub.max_invoices_per_month === null ? 'Ilimitado' : sub.max_invoices_per_month}</div>
          </div>
        </div>

        {sub.status === 'trialing' && sub.trial_end && (
          <div className="bg-status-info/10 border border-status-info/40 rounded p-3 text-sm">
            <strong>Tu prueba termina el {new Date(sub.trial_end).toLocaleDateString('es-MX', { day: 'numeric', month: 'long', year: 'numeric' })}.</strong><br/>
            Después de esa fecha necesitas elegir un plan para seguir usando el sistema.
          </div>
        )}

        {sub.status === 'past_due' && (
          <div className="bg-status-warning/10 border border-status-warning/40 rounded p-3 text-sm">
            <strong>Tu último cobro falló.</strong> Tienes unos días de gracia para actualizar tu tarjeta antes de que el servicio se suspenda.
          </div>
        )}

        {sub.status === 'active' && sub.current_period_end && (
          <div className="text-sm text-ink-secondary">
            Próxima fecha de cobro: <strong>{new Date(sub.current_period_end).toLocaleDateString('es-MX', { day: 'numeric', month: 'long', year: 'numeric' })}</strong>
          </div>
        )}

        {sub.cancel_at_period_end && (
          <div className="bg-orange-50 border border-orange-200 rounded p-3 text-sm">
            <strong>Tu suscripción se cancelará al final del periodo actual.</strong> Puedes reactivarla en el portal de Stripe antes de esa fecha.
          </div>
        )}
      </section>

      <section className="card p-5 flex flex-col gap-3">
        <h2 className="font-semibold text-ink-primary">Acciones</h2>
        <div className="flex flex-wrap gap-2">
          <Can do="billing:manage">
            <Link to="/configuracion/planes" className="btn-secondary">
              Cambiar de plan
            </Link>
          </Can>
          {!isOwner && sub.stripe_customer_id && (
            <Can do="billing:manage">
              <button
                className="btn-secondary"
                disabled={portal.isPending}
                onClick={() => { setError(null); portal.mutate() }}>
                {portal.isPending ? 'Abriendo portal…' : 'Gestionar tarjeta y facturas'}
              </button>
            </Can>
          )}
          <button className="btn-secondary" onClick={() => refetch()}>
            Actualizar estado
          </button>
        </div>
        {isOwner && (
          <p className="text-xs text-ink-muted">
            Cuenta interna sin cobros. La gestión en Stripe no aplica.
          </p>
        )}
      </section>
    </div>
  )
}
