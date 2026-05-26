'use strict'

// Lógica de suscripciones. Tres puntas:
//   1) listPlans()        — catálogo público para mostrar en "Planes y precios"
//   2) getSubscription()  — estado actual de la suscripción del tenant
//   3) createCheckoutSession() — inicia el flujo de pago (genera URL Stripe)
//
// Nota: la creación de la subscription en BD al provisionar tenant vive en
// `tenantService.provisionTenant` (sesión 17) — aquí no la duplicamos.

const { query } = require('../../db')
const { requireStripe } = require('../../utils/stripe')
const config = require('../../config')
const logger = require('../../config/logger')

async function listPlans() {
  const { rows } = await query(
    `SELECT id, slug, name, description, price_mxn_cents, currency,
            max_users, max_invoices_per_month, stripe_price_id IS NOT NULL AS purchasable
       FROM plans
      WHERE active = TRUE
      ORDER BY sort_order ASC`
  )
  return rows
}

async function getSubscription(tenantId) {
  const { rows } = await query(
    `SELECT s.tenant_id, s.status, s.current_period_start, s.current_period_end,
            s.trial_end, s.cancel_at_period_end, s.canceled_at,
            s.stripe_customer_id, s.stripe_subscription_id,
            p.id AS plan_id, p.slug AS plan_slug, p.name AS plan_name,
            p.price_mxn_cents, p.max_users, p.max_invoices_per_month
       FROM subscriptions s
       JOIN plans p ON p.id = s.plan_id
      WHERE s.tenant_id = $1`,
    [tenantId]
  )
  return rows[0] || null
}

/**
 * Crea un Stripe Checkout Session para que el tenant compre un plan.
 * Si ya tiene stripe_customer_id, se reusa. Si no, Stripe crea uno nuevo
 * durante el Checkout y nos lo devuelve por webhook.
 *
 * Devuelve { url } — el frontend hace redirect a esta URL.
 */
async function createCheckoutSession({ tenantId, planSlug, userEmail }) {
  const stripe = requireStripe()

  const { rows: pRows } = await query(
    `SELECT id, slug, stripe_price_id, name FROM plans
      WHERE slug = $1 AND active = TRUE`,
    [planSlug]
  )
  if (!pRows.length) throwHttp(404, `Plan no encontrado: ${planSlug}`)
  const plan = pRows[0]

  if (!plan.stripe_price_id) {
    throwHttp(400, `El plan "${plan.name}" todavía no está conectado con Stripe. ` +
                   `Crea el price en el dashboard y guárdalo en plans.stripe_price_id.`)
  }

  // Reusar customer existente si lo hay (segunda compra, upgrade, etc).
  const { rows: sRows } = await query(
    `SELECT stripe_customer_id FROM subscriptions WHERE tenant_id = $1`,
    [tenantId]
  )
  const existingCustomer = sRows[0]?.stripe_customer_id || null

  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    line_items: [{ price: plan.stripe_price_id, quantity: 1 }],
    // Pasamos el tenantId como metadata — el webhook lo lee para saber
    // a quién aplicar el resultado.
    metadata:           { tenant_id: tenantId, plan_slug: plan.slug },
    subscription_data:  { metadata: { tenant_id: tenantId, plan_slug: plan.slug } },
    // Si existe customer, reusar. Si no, dejar que Stripe cree uno (incluye
    // customer_email para pre-rellenar el formulario).
    ...(existingCustomer
      ? { customer: existingCustomer }
      : { customer_email: userEmail }),
    success_url: `${config.stripe.appUrl}/configuracion/suscripcion?status=success&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url:  `${config.stripe.appUrl}/configuracion/suscripcion?status=cancel`,
    // El periodo de prueba (trial) ya lo manejamos en BD por nosotros mismos
    // — no le pedimos a Stripe que lo aplique. Si el tenant llega aquí ya
    // pasó su trial o eligió pagar antes; cobramos de inmediato.
  })

  logger.info('[billing] Checkout session creada', {
    tenantId, planSlug, sessionId: session.id,
  })

  return { url: session.url, sessionId: session.id }
}

function throwHttp(status, message) {
  const err = new Error(message)
  err.status = status
  throw err
}

/**
 * Genera URL del Stripe Customer Portal. El cliente puede ahí cambiar
 * tarjeta, ver facturas, cancelar suscripción. Es una pantalla 100%
 * manejada por Stripe — nosotros solo damos el link.
 */
async function createPortalSession(tenantId) {
  const stripe = requireStripe()
  const { rows } = await query(
    `SELECT stripe_customer_id FROM subscriptions WHERE tenant_id = $1`,
    [tenantId]
  )
  const customerId = rows[0]?.stripe_customer_id
  if (!customerId) {
    throwHttp(400, 'Aún no tienes un cliente en Stripe. Primero contrata un plan.')
  }

  const session = await stripe.billingPortal.sessions.create({
    customer: customerId,
    return_url: `${config.stripe.appUrl}/configuracion/suscripcion`,
  })

  return { url: session.url }
}

module.exports = { listPlans, getSubscription, createCheckoutSession, createPortalSession }
