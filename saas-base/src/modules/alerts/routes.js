'use strict'

/**
 * SaaS v2 §5h — Endpoints de alertas.
 *
 *   GET   /api/alerts                  — list (filtros: status, type, limit, offset)
 *   PATCH /api/alerts/:id/acknowledge  — marcar como reconocida
 *   PATCH /api/alerts/:id/resolve      — marcar como resuelta
 *
 * Permisos: alerts:read / alerts:acknowledge.
 */

const express = require('express')
const { tenantResolver }      = require('../../middleware/tenantResolver')
const { authGuard }           = require('../../middleware/authGuard')
const { requireActiveTenant } = require('../../middleware/requireActiveTenant')
const { checkPermission }     = require('../../middleware/checkPermission')
const svc                     = require('./alertService')

const router = express.Router()
router.use(tenantResolver)
router.use(authGuard)
router.use(requireActiveTenant)

const tid = (req) => req.tenant.id
const uid = (req) => req.auth.userId

router.get('/', checkPermission('alerts', 'read'), async (req, res, next) => {
  try {
    const { status, type, limit, offset } = req.query
    const items = await svc.listAlerts({
      tenantId: tid(req),
      status: status || null,
      type: type || null,
      limit: limit ? parseInt(limit) : 100,
      offset: offset ? parseInt(offset) : 0,
    })
    res.json(items)
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message })
    next(err)
  }
})

router.patch('/:id/acknowledge', checkPermission('alerts', 'acknowledge'), async (req, res, next) => {
  try {
    const alert = await svc.acknowledgeAlert({
      tenantId: tid(req), alertId: req.params.id, userId: uid(req),
    })
    res.json(alert)
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message })
    next(err)
  }
})

router.patch('/:id/resolve', checkPermission('alerts', 'acknowledge'), async (req, res, next) => {
  try {
    const alert = await svc.resolveAlert({
      tenantId: tid(req), alertId: req.params.id, userId: uid(req),
    })
    res.json(alert)
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message })
    next(err)
  }
})

module.exports = router
