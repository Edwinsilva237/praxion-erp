'use strict'

/**
 * SaaS v2 §5h — Endpoints operativos de lotes.
 *
 *   POST /api/lots/run-expiration-check    — Trigger manual de markExpiredLots.
 *                                           Idempotente. Útil si no se quiere
 *                                           depender del cron interno o para
 *                                           tests/ops one-shot.
 *
 *   GET  /api/lots/expiring?days=30        — Lotes (MP y PT) que vencen en N días.
 *                                           Default: tenant_process_config.expiry_alert_days.
 *                                           Si dispatch=true, además crea alertas.
 *
 * Permisos: usa los mismos que para gestionar lotes/inventario (production:read
 * y production:update son los más cercanos hoy; podemos crear permisos
 * específicos lots:* más adelante).
 */

const express = require('express')
const { tenantResolver }      = require('../../middleware/tenantResolver')
const { authGuard }           = require('../../middleware/authGuard')
const { requireActiveTenant } = require('../../middleware/requireActiveTenant')
const { checkPermission }     = require('../../middleware/checkPermission')
const { markExpiredLots, getExpiringLots } = require('../production/expirationService')

const router = express.Router()
router.use(tenantResolver)
router.use(authGuard)
router.use(requireActiveTenant)

const tid = (req) => req.tenant.id

router.post('/run-expiration-check', checkPermission('production', 'update'), async (req, res, next) => {
  try {
    const result = await markExpiredLots({ tenantId: tid(req) })
    res.json(result)
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message })
    next(err)
  }
})

router.get('/expiring', checkPermission('production', 'read'), async (req, res, next) => {
  try {
    const days = req.query.days ? parseInt(req.query.days) : null
    const dispatch = req.query.dispatch === 'true'
    const result = await getExpiringLots({
      tenantId: tid(req), daysAhead: days, dispatch,
    })
    res.json(result)
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message })
    next(err)
  }
})

module.exports = router
