'use strict'

// Cliente Stripe singleton + helpers. Si STRIPE_SECRET_KEY está vacío,
// `enabled=false` y los módulos de billing deben responder 503 sin crash.

const Stripe = require('stripe')
const config = require('../config')
const logger = require('../config/logger')

const enabled = !!config.stripe.secretKey

let stripe = null
if (enabled) {
  stripe = new Stripe(config.stripe.secretKey, {
    apiVersion: '2024-12-18.acacia',
    typescript: false,
    maxNetworkRetries: 2,
    timeout: 15_000,
  })
  logger.info('[stripe] habilitado')
} else {
  logger.info('[stripe] STRIPE_SECRET_KEY vacío — billing deshabilitado')
}

function requireStripe() {
  if (!enabled) {
    const err = new Error('Pagos no configurados. STRIPE_SECRET_KEY ausente.')
    err.status = 503
    throw err
  }
  return stripe
}

module.exports = { enabled, stripe, requireStripe }
