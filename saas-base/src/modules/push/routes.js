'use strict'

/**
 * Endpoints de notificaciones push.
 *
 *   POST /api/push/register     — la app registra su token FCM (self-service).
 *   POST /api/push/unregister   — la app borra su token al cerrar sesión.
 *   POST /api/push/broadcast    — anuncio manual a la empresa (permiso push:broadcast).
 *
 * Stack de middleware igual que alerts (módulo core): tenantResolver → authGuard
 * → requireActiveTenant. register/unregister son self-service (sin permiso);
 * solo broadcast está protegido.
 */

const express = require('express')
const { tenantResolver }      = require('../../middleware/tenantResolver')
const { authGuard }           = require('../../middleware/authGuard')
const { requireActiveTenant } = require('../../middleware/requireActiveTenant')
const { checkPermission }     = require('../../middleware/checkPermission')
const deviceTokens            = require('./deviceTokenService')
const pushService             = require('./pushService')

const router = express.Router()
router.use(tenantResolver)
router.use(authGuard)
router.use(requireActiveTenant)

const tid = (req) => req.tenant.id
const uid = (req) => req.auth.userId

// La app envía su token tras loguearse. Idempotente (UPSERT por token).
router.post('/register', async (req, res, next) => {
  try {
    const { token, platform, deviceInfo } = req.body || {}
    if (!token) return res.status(400).json({ error: 'token requerido.' })
    const row = await deviceTokens.registerToken(tid(req), uid(req), { token, platform, deviceInfo })
    res.status(201).json({ id: row.id, platform: row.platform })
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message })
    next(err)
  }
})

// La app borra su token al cerrar sesión.
router.post('/unregister', async (req, res, next) => {
  try {
    const { token } = req.body || {}
    if (!token) return res.status(400).json({ error: 'token requerido.' })
    const removed = await deviceTokens.unregisterToken(tid(req), uid(req), token)
    res.json({ removed })
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message })
    next(err)
  }
})

// Anuncio manual: push a toda la empresa (o a una audiencia dada).
router.post('/broadcast', checkPermission('push', 'broadcast'), async (req, res, next) => {
  try {
    const { title, body, data, audience } = req.body || {}
    if (!title) return res.status(400).json({ error: 'title requerido.' })
    const result = await pushService.notify(tid(req), {
      audience: audience || 'all',
      title,
      body: body || '',
      data: { type: 'broadcast', ...(data || {}) },
    })
    res.json(result)
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message })
    next(err)
  }
})

module.exports = router
