'use strict'

const express = require('express')
const { tenantResolver } = require('../../middleware/tenantResolver')
const { authGuard } = require('../../middleware/authGuard')
const { checkPermission } = require('../../middleware/checkPermission')
const { query, withBypass } = require('../../db')
const subscriptionService = require('./subscriptionService')
const webhookService = require('./webhookService')
const config = require('../../config')
const logger = require('../../config/logger')
const { stripe, enabled } = require('../../utils/stripe')

const router = express.Router()

// ── Webhook (público, validado por firma HMAC) ──────────────────────────────
// IMPORTANTE: Stripe necesita el body RAW (sin parsear) para validar la
// firma. Por eso usamos express.raw aquí — express.json() ya está montado
// globalmente en app.js, pero para esta ruta sobreescribimos.
//
// Se monta ANTES del tenantResolver/authGuard para que sea públicamente
// alcanzable. La autenticidad la garantiza la firma del header
// 'stripe-signature'.
router.post('/webhook',
  express.raw({ type: 'application/json', limit: '1mb' }),
  async (req, res) => {
    if (!enabled) return res.status(503).json({ error: 'Pagos deshabilitados.' })

    const sig = req.headers['stripe-signature']
    if (!sig) return res.status(400).json({ error: 'Falta firma de Stripe.' })
    if (!config.stripe.webhookSecret) {
      logger.error('[billing:webhook] STRIPE_WEBHOOK_SECRET no configurado')
      return res.status(500).json({ error: 'Webhook no configurado.' })
    }

    let event
    try {
      event = stripe.webhooks.constructEvent(req.body, sig, config.stripe.webhookSecret)
    } catch (err) {
      logger.warn('[billing:webhook] firma inválida', { error: err.message })
      return res.status(400).json({ error: `Firma inválida: ${err.message}` })
    }

    try {
      // RLS bypass: el webhook no viene con tenant en el header — el handler
      // identifica el tenant del payload de Stripe y hace queries cross-tenant.
      const result = await withBypass(() => webhookService.handleEvent(event))
      res.json({ received: true, result })
    } catch (err) {
      logger.error('[billing:webhook] error procesando evento', { error: err.message, type: event.type })
      // Devolvemos 500 para que Stripe reintente automáticamente.
      res.status(500).json({ error: err.message })
    }
  }
)

// ── Rutas autenticadas ──────────────────────────────────────────────────────
router.use(tenantResolver)
router.use(authGuard)

/**
 * GET /api/billing/plans
 * Catálogo de planes. Público entre los tenants autenticados.
 */
router.get('/plans', async (_req, res, next) => {
  try {
    const plans = await subscriptionService.listPlans()
    res.json(plans)
  } catch (err) { next(err) }
})

/**
 * GET /api/billing/subscription
 * Suscripción actual del tenant.
 */
router.get('/subscription', checkPermission('settings', 'read'), async (req, res, next) => {
  try {
    const sub = await subscriptionService.getSubscription(req.tenant.id)
    if (!sub) return res.status(404).json({ error: 'Sin suscripción.' })
    res.json(sub)
  } catch (err) { next(err) }
})

/**
 * POST /api/billing/checkout  body: { planSlug }
 * Crea una Stripe Checkout Session y devuelve la URL para redirigir.
 */
router.post('/checkout', checkPermission('settings', 'update'), async (req, res, next) => {
  try {
    const { planSlug } = req.body || {}
    if (!planSlug) return res.status(400).json({ error: 'planSlug requerido.' })

    // Recuperar email del usuario para pre-rellenar en Checkout.
    const { rows: uRows } = await query(
      `SELECT email FROM users WHERE id = $1`, [req.auth.userId]
    )
    const userEmail = uRows[0]?.email

    const result = await subscriptionService.createCheckoutSession({
      tenantId:  req.tenant.id,
      planSlug,
      userEmail,
    })
    res.json(result)
  } catch (err) { next(err) }
})

/**
 * POST /api/billing/portal
 * Genera URL del Stripe Customer Portal (gestión de tarjeta, cancelar, etc).
 */
router.post('/portal', checkPermission('settings', 'update'), async (req, res, next) => {
  try {
    const result = await subscriptionService.createPortalSession(req.tenant.id)
    res.json(result)
  } catch (err) { next(err) }
})

module.exports = router
