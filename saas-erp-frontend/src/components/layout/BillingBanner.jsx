import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { billingApi } from '@/api/billing'

/**
 * Banner global que alerta sobre el estado de la suscripción.
 * Se muestra cuando:
 *   - Trial vence en ≤ 3 días → azul, llamado a elegir plan
 *   - status=past_due → naranja, llamado a actualizar tarjeta
 *   - status=canceled → rojo, llamado a reactivar
 *
 * El plan 'owner' bypasea — nunca mostrar nada.
 * Si el endpoint falla (sin sub, billing deshabilitado), no mostrar nada.
 */
export default function BillingBanner() {
  const { data: sub } = useQuery({
    queryKey: ['billing-subscription'],
    queryFn:  billingApi.getSubscription,
    retry: false,
    staleTime: 60_000,
  })

  if (!sub || sub.plan_slug === 'owner') return null

  // Trial: solo banner cuando faltan ≤3 días para que termine
  if (sub.status === 'trialing' && sub.trial_end) {
    const ms = new Date(sub.trial_end).getTime() - Date.now()
    const days = Math.ceil(ms / (24 * 60 * 60 * 1000))
    if (days > 3 || days < 0) return null
    return (
      <Banner color="blue">
        <span>Tu periodo de prueba termina en {days === 0 ? '<1 día' : `${days} día${days === 1 ? '' : 's'}`}.</span>
        <Link to="/configuracion/planes" className="underline ml-2 font-semibold">Elegir plan</Link>
      </Banner>
    )
  }

  if (sub.status === 'past_due') {
    return (
      <Banner color="orange">
        <span>Tu último cobro falló. Actualiza tu tarjeta para evitar que se suspenda el servicio.</span>
        <Link to="/configuracion/suscripcion" className="underline ml-2 font-semibold">Gestionar</Link>
      </Banner>
    )
  }

  if (sub.status === 'canceled' || sub.status === 'incomplete_expired') {
    return (
      <Banner color="red">
        <span>Tu suscripción no está activa. Reactívala para seguir usando el sistema.</span>
        <Link to="/configuracion/planes" className="underline ml-2 font-semibold">Ver planes</Link>
      </Banner>
    )
  }

  return null
}

function Banner({ color, children }) {
  const colors = {
    blue:   'bg-blue-500',
    orange: 'bg-orange-500',
    red:    'bg-red-600',
  }
  return (
    <div className={`${colors[color]} text-white text-center text-xs font-medium py-1.5 px-3 flex items-center justify-center gap-1 shadow-sm`}>
      {children}
    </div>
  )
}
