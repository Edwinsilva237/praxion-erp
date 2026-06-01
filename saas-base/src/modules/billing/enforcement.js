'use strict'

// Helpers para hacer cumplir los límites del plan + estado de la suscripción.
// Las funciones lanzan errores con `status = 402 Payment Required` cuando
// algo está bloqueado — el frontend puede atrapar ese código y mostrar UI
// específica de "necesitas un plan mejor".

const { query } = require('../../db')
const config = require('../../config')
const logger = require('../../config/logger')

/**
 * Verifica que el tenant tenga una suscripción activa (o trial vigente,
 * o past_due dentro del grace period). Si no, lanza 402.
 *
 * Estados permitidos:
 *   - 'active'      → OK
 *   - 'trialing' y trial_end > NOW() → OK
 *   - 'past_due' dentro de los STRIPE_GRACE_DAYS desde current_period_end → OK
 *   - resto → bloqueado
 *
 * El plan 'owner' bypasea todo (no usa Stripe).
 */
async function assertSubscriptionActive(tenantId) {
  const { rows } = await query(
    `SELECT s.status, s.trial_end, s.current_period_end, p.slug AS plan_slug
       FROM subscriptions s
       JOIN plans p ON p.id = s.plan_id
      WHERE s.tenant_id = $1`,
    [tenantId]
  )
  if (!rows.length) {
    // Sin suscripción: bloqueamos. Backfill (097) cubre tenants existentes,
    // así que esto solo pasa con datos inconsistentes.
    throwPaymentRequired('Tu cuenta no tiene una suscripción activa.')
  }

  const sub = rows[0]

  // Owner plan: siempre OK, sin importar status.
  if (sub.plan_slug === 'owner') return

  const now = Date.now()

  if (sub.status === 'active') return

  if (sub.status === 'trialing') {
    const trialEnd = sub.trial_end ? new Date(sub.trial_end).getTime() : 0
    if (trialEnd > now) return
    throwPaymentRequired(
      'Tu periodo de prueba terminó. Elige un plan para seguir usando el sistema.'
    )
  }

  if (sub.status === 'past_due') {
    // Grace period: cuántos ms desde current_period_end (cuando se intentó
    // cobrar y falló) hasta el corte.
    const periodEnd = sub.current_period_end ? new Date(sub.current_period_end).getTime() : 0
    const graceMs   = config.stripe.graceDays * 24 * 60 * 60 * 1000
    if (now < periodEnd + graceMs) return
    throwPaymentRequired(
      `Tu cobro falló y pasaron más de ${config.stripe.graceDays} días. ` +
      `Actualiza tu tarjeta para reactivar el servicio.`
    )
  }

  // canceled / incomplete / incomplete_expired → bloqueado
  throwPaymentRequired(
    sub.status === 'canceled'
      ? 'Tu suscripción está cancelada. Reactívala para seguir usando el sistema.'
      : 'Tu cuenta no tiene una suscripción activa.'
  )
}

/**
 * Verifica que el tenant pueda tener un usuario ACTIVO más sin exceder el
 * límite de su plan. Si max_users del plan es NULL → ilimitado, siempre OK.
 *
 * Modelo de "asientos activos": solo cuentan los usuarios `is_active = true`.
 * Desactivar un usuario libera su lugar; reactivarlo (o invitar uno nuevo)
 * vuelve a consumir uno, y por eso pasa por aquí.
 *
 * @param {string} tenantId
 * @param {number} [addCount=1] - cuántos usuarios activos se van a agregar (default 1)
 */
async function assertCanCreateUser(tenantId, addCount = 1) {
  const sub = await getSubAndPlan(tenantId)
  if (!sub) return // sin sub: lo deja pasar — assertSubscriptionActive lo bloqueará
  if (sub.max_users === null) return // ilimitado

  const { rows: cnt } = await query(
    `SELECT COUNT(*)::int AS n FROM users WHERE tenant_id = $1 AND is_active = true`,
    [tenantId]
  )
  const current = cnt[0].n
  if (current + addCount > sub.max_users) {
    throwPaymentRequired(
      `Tu plan "${sub.plan_name}" permite hasta ${sub.max_users} usuario(s) activo(s). ` +
      `Ya tienes ${current}. Desactiva otro usuario o cambia a un plan superior.`
    )
  }
}

/**
 * Verifica que el tenant pueda timbrar otro CFDI este mes calendario sin
 * exceder max_invoices_per_month del plan. NULL = ilimitado.
 */
async function assertCanStampInvoice(tenantId) {
  const sub = await getSubAndPlan(tenantId)
  if (!sub) return
  if (sub.max_invoices_per_month === null) return // ilimitado

  // Mes calendario (de día 1 a último día del mes en curso, en UTC).
  // Suficiente granularidad — los CFDI se cuentan por fecha de timbrado.
  const { rows: cnt } = await query(
    `SELECT COUNT(*)::int AS n
       FROM invoices
      WHERE tenant_id = $1
        AND status = 'stamped'
        AND stamp_date >= date_trunc('month', NOW())
        AND stamp_date <  date_trunc('month', NOW()) + INTERVAL '1 month'`,
    [tenantId]
  )
  const used = cnt[0].n
  if (used >= sub.max_invoices_per_month) {
    throwPaymentRequired(
      `Tu plan "${sub.plan_name}" permite ${sub.max_invoices_per_month} factura(s) timbrada(s) por mes. ` +
      `Llevas ${used} este mes. Cambia a un plan superior para timbrar más.`
    )
  }
}

// ─────────────────────────────────────────────────────────────────────────────

async function getSubAndPlan(tenantId) {
  const { rows } = await query(
    `SELECT s.status, p.slug AS plan_slug, p.name AS plan_name,
            p.max_users, p.max_invoices_per_month
       FROM subscriptions s
       JOIN plans p ON p.id = s.plan_id
      WHERE s.tenant_id = $1`,
    [tenantId]
  )
  return rows[0] || null
}

function throwPaymentRequired(message) {
  const err = new Error(message)
  err.status = 402
  err.code = 'PAYMENT_REQUIRED'
  throw err
}

module.exports = {
  assertSubscriptionActive,
  assertCanCreateUser,
  assertCanStampInvoice,
}
