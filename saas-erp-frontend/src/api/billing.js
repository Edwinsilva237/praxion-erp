import api from './axios'

const B = '/billing'

export const billingApi = {
  listPlans: () =>
    api.get(`${B}/plans`).then(r => r.data),

  getSubscription: () =>
    api.get(`${B}/subscription`).then(r => r.data),

  // Inicia un Stripe Checkout. Devuelve { url } — redirigir window.location.
  checkout: (planSlug) =>
    api.post(`${B}/checkout`, { planSlug }).then(r => r.data),

  // Abre el Stripe Customer Portal (cambiar tarjeta, cancelar, ver facturas).
  openPortal: () =>
    api.post(`${B}/portal`).then(r => r.data),
}
