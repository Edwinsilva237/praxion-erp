'use strict'

// Handlers para eventos de Stripe. El endpoint en routes.js valida la firma
// HMAC y llama a `handleEvent(event)` con el evento ya parseado.
//
// Eventos cubiertos en esta sesión:
//   - checkout.session.completed → tenant terminó de pagar por primera vez.
//     Guardamos stripe_customer_id, stripe_subscription_id, status=active.
//   - customer.subscription.updated → cambio de plan, renovación, etc.
//   - customer.subscription.deleted → cancelación efectiva.
//   - invoice.payment_failed → cobro rechazado → status=past_due.

const { query, withTransaction } = require('../../db')
const logger = require('../../config/logger')

async function handleEvent(event) {
  logger.info('[billing:webhook] evento recibido', { type: event.type, id: event.id })

  switch (event.type) {
    case 'checkout.session.completed':
      return onCheckoutCompleted(event.data.object)

    case 'customer.subscription.updated':
      return onSubscriptionUpdated(event.data.object)

    case 'customer.subscription.deleted':
      return onSubscriptionDeleted(event.data.object)

    case 'invoice.payment_failed':
      return onPaymentFailed(event.data.object)

    case 'invoice.payment_succeeded':
      return onPaymentSucceeded(event.data.object)

    default:
      logger.debug(`[billing:webhook] evento ignorado: ${event.type}`)
      return { ignored: true }
  }
}

// ─────────────────────────────────────────────────────────────────────────────

async function onCheckoutCompleted(session) {
  const tenantId  = session.metadata?.tenant_id
  const planSlug  = session.metadata?.plan_slug
  const subId     = session.subscription
  const customerId = session.customer

  if (!tenantId || !planSlug) {
    logger.warn('[billing:webhook] checkout.completed sin metadata.tenant_id', { sessionId: session.id })
    return { skipped: true, reason: 'sin_tenant_metadata' }
  }

  await withTransaction(async (client) => {
    const { rows: pRows } = await client.query(
      `SELECT id FROM plans WHERE slug = $1`, [planSlug]
    )
    if (!pRows.length) throw new Error(`Plan no encontrado: ${planSlug}`)
    const planId = pRows[0].id

    await client.query(
      `UPDATE subscriptions SET
         plan_id                = $1,
         stripe_customer_id     = $2,
         stripe_subscription_id = $3,
         status                 = 'active',
         cancel_at_period_end   = FALSE,
         canceled_at            = NULL
       WHERE tenant_id = $4`,
      [planId, customerId, subId, tenantId]
    )
  })

  logger.info('[billing] tenant activó plan via Checkout', { tenantId, planSlug, subId })
  return { ok: true, tenantId, planSlug }
}

async function onSubscriptionUpdated(sub) {
  // sub.metadata.tenant_id viene del subscription_data.metadata que pasamos
  // al crear el Checkout. Si por alguna razón no está (subs antiguas),
  // fallback a buscar por stripe_subscription_id.
  const tenantId = sub.metadata?.tenant_id
    || await findTenantBySubId(sub.id)

  if (!tenantId) {
    logger.warn('[billing:webhook] subscription.updated sin tenant', { subId: sub.id })
    return { skipped: true }
  }

  const status = mapStripeStatus(sub.status)
  const cancelAtPeriodEnd = !!sub.cancel_at_period_end

  await query(
    `UPDATE subscriptions SET
       status                 = $1,
       current_period_start   = to_timestamp($2),
       current_period_end     = to_timestamp($3),
       cancel_at_period_end   = $4
     WHERE tenant_id = $5`,
    [status, sub.current_period_start, sub.current_period_end,
     cancelAtPeriodEnd, tenantId]
  )

  // Auto-reactivación: si el tenant está suspendido por pago vencido
  // (suspended_reason = 'payment') y Stripe acaba de marcar la suscripción
  // como activa, levantamos la suspensión. Las suspensiones manuales NO se
  // tocan — esas siguen requiriendo intervención del platform admin.
  if (status === 'active') {
    const reactivated = await reactivateIfPaymentSuspended(tenantId)
    if (reactivated) {
      logger.info('[billing] tenant auto-reactivado tras pago', { tenantId })
    }
  }

  // Auto-suspensión: si Stripe marca la sub como 'unpaid' (todos los retries
  // fallaron pero la sub sigue existiendo), o como 'canceled' (Stripe la
  // cerró), suspendemos al tenant con motivo 'payment'. Solo afecta planes
  // de cobro real — el plan 'owner' nunca se suspende vía billing.
  if (status === 'past_due' && mapStripeStatus(sub.status) === 'past_due'
      && (sub.status === 'unpaid')) {
    const suspended = await autoSuspendForPayment(tenantId)
    if (suspended) {
      logger.warn('[billing] tenant auto-suspendido (status=unpaid)', { tenantId })
    }
  }

  return { ok: true, tenantId, status }
}

/**
 * Si el tenant está suspendido con reason='payment', lo reactiva y devuelve
 * true. Para reason='manual' o si no está suspendido, no hace nada.
 */
async function reactivateIfPaymentSuspended(tenantId) {
  const { rows } = await query(
    `UPDATE tenants
        SET is_active        = TRUE,
            suspended_reason = NULL,
            suspended_at     = NULL,
            updated_at       = NOW()
      WHERE id = $1
        AND is_active = FALSE
        AND suspended_reason = 'payment'
      RETURNING id`,
    [tenantId]
  )
  return rows.length > 0
}

/**
 * Suspende al tenant con reason='payment' si actualmente está activo Y el
 * plan es de cobro real (≠ 'owner'). Idempotente: si ya está suspendido
 * (por cualquier motivo) no hace nada.
 *
 * Llamado desde el webhook al detectar que Stripe se rindió en los retries
 * o canceló la suscripción.
 */
async function autoSuspendForPayment(tenantId) {
  const { rows } = await query(
    `UPDATE tenants t
        SET is_active        = FALSE,
            suspended_reason = 'payment',
            suspended_at     = NOW(),
            updated_at       = NOW()
       FROM subscriptions s
       JOIN plans p ON p.id = s.plan_id
      WHERE t.id = $1
        AND s.tenant_id = t.id
        AND t.is_active = TRUE
        AND p.slug <> 'owner'
      RETURNING t.id`,
    [tenantId]
  )
  return rows.length > 0
}

async function onSubscriptionDeleted(sub) {
  const tenantId = sub.metadata?.tenant_id || await findTenantBySubId(sub.id)
  if (!tenantId) return { skipped: true }

  await query(
    `UPDATE subscriptions SET
       status      = 'canceled',
       canceled_at = NOW()
     WHERE tenant_id = $1`,
    [tenantId]
  )

  // Stripe se rindió tras agotar los reintentos: suspendemos al tenant con
  // motivo 'payment'. Si el cliente actualiza su tarjeta luego y paga, el
  // webhook de invoice.payment_succeeded / subscription.updated reactiva sola.
  const suspended = await autoSuspendForPayment(tenantId)
  if (suspended) {
    logger.warn('[billing] tenant auto-suspendido (subscription.deleted)', { tenantId })
  }

  return { ok: true, tenantId, autoSuspended: suspended }
}

/**
 * Cobro exitoso — para el caso "el cliente actualizó la tarjeta en el portal
 * y Stripe ya cobró". Aquí ya marcamos la suscripción como 'active' desde
 * onSubscriptionUpdated, pero atrapamos también este evento por si llega
 * primero (Stripe no garantiza orden).
 */
async function onPaymentSucceeded(invoice) {
  const subId = invoice.subscription
  if (!subId) return { skipped: true, reason: 'sin_subscription' }
  const tenantId = await findTenantBySubId(subId)
  if (!tenantId) return { skipped: true }

  await query(
    `UPDATE subscriptions SET status = 'active' WHERE tenant_id = $1 AND status = 'past_due'`,
    [tenantId]
  )

  const reactivated = await reactivateIfPaymentSuspended(tenantId)
  if (reactivated) {
    logger.info('[billing] tenant auto-reactivado tras pago (invoice.payment_succeeded)', { tenantId })
  }
  return { ok: true, tenantId, reactivated }
}

async function onPaymentFailed(invoice) {
  const subId = invoice.subscription
  if (!subId) return { skipped: true, reason: 'sin_subscription' }
  const tenantId = await findTenantBySubId(subId)
  if (!tenantId) return { skipped: true }

  await query(
    `UPDATE subscriptions SET status = 'past_due' WHERE tenant_id = $1`,
    [tenantId]
  )

  logger.warn('[billing] cobro rechazado → past_due', { tenantId, invoiceId: invoice.id })
  return { ok: true, tenantId, status: 'past_due' }
}

// ─────────────────────────────────────────────────────────────────────────────

async function findTenantBySubId(stripeSubId) {
  const { rows } = await query(
    `SELECT tenant_id FROM subscriptions WHERE stripe_subscription_id = $1`,
    [stripeSubId]
  )
  return rows[0]?.tenant_id || null
}

/**
 * Mapea status de Stripe (active/trialing/past_due/canceled/incomplete/...)
 * a nuestro enum local. Stripe tiene además 'paused' que tratamos como past_due.
 */
function mapStripeStatus(stripeStatus) {
  switch (stripeStatus) {
    case 'active':    return 'active'
    case 'trialing':  return 'trialing'
    case 'past_due':  return 'past_due'
    case 'unpaid':    return 'past_due'
    case 'canceled':  return 'canceled'
    case 'incomplete':         return 'incomplete'
    case 'incomplete_expired': return 'incomplete_expired'
    case 'paused':    return 'past_due'
    default:          return 'active'  // fallback conservador
  }
}

module.exports = { handleEvent }
