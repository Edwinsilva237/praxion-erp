'use strict'

const express = require('express')
const { authGuard } = require('../../middleware/authGuard')
const { tenantResolver } = require('../../middleware/tenantResolver')
const { requirePlatformAdmin } = require('../../middleware/requirePlatformAdmin')
const svc = require('./systemMessagesService')
const { audit } = require('../../utils/audit')
const logger = require('../../config/logger')

const router = express.Router()

// ─── Endpoint público para tenants ────────────────────────────────────
// Devuelve los mensajes vigentes para mostrar el banner. Requiere sesión
// (cualquier usuario autenticado) pero NO requiere ser platform admin —
// los tenants normales lo consumen para pintar el banner.
router.get('/active', tenantResolver, authGuard, async (_req, res, next) => {
  try {
    const messages = await svc.listActive()
    res.json(messages)
  } catch (err) { next(err) }
})

// ─── Endpoints super-admin ────────────────────────────────────────────
router.use('/admin', authGuard, requirePlatformAdmin)

router.get('/admin', async (req, res, next) => {
  try {
    const includeCancelled = req.query.includeCancelled === 'true'
    const messages = await svc.list({ includeCancelled })
    res.json(messages)
  } catch (err) { next(err) }
})

router.get('/admin/:id', async (req, res, next) => {
  try {
    const m = await svc.getOne(req.params.id)
    if (!m) return res.status(404).json({ error: 'Mensaje no encontrado.' })
    res.json(m)
  } catch (err) { next(err) }
})

router.post('/admin', async (req, res, next) => {
  try {
    const m = await svc.create(req.body || {}, req.auth.userId)
    await audit({
      userId: req.auth.userId,
      action: 'platform_admin.system_message_created',
      resource: 'system_message',
      resourceId: m.id,
      payload: { kind: m.kind, title: m.title, severity: m.severity },
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
    }).catch((e) => logger.warn('audit failed', { error: e.message }))
    res.status(201).json(m)
  } catch (err) { next(err) }
})

router.patch('/admin/:id', async (req, res, next) => {
  try {
    const m = await svc.update(req.params.id, req.body || {})
    await audit({
      userId: req.auth.userId,
      action: 'platform_admin.system_message_updated',
      resource: 'system_message',
      resourceId: req.params.id,
      payload: { fields: Object.keys(req.body || {}) },
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
    }).catch((e) => logger.warn('audit failed', { error: e.message }))
    res.json(m)
  } catch (err) { next(err) }
})

router.post('/admin/:id/cancel', async (req, res, next) => {
  try {
    const m = await svc.cancel(req.params.id, {
      reason: req.body?.reason || null,
      userId: req.auth.userId,
    })
    await audit({
      userId: req.auth.userId,
      action: 'platform_admin.system_message_cancelled',
      resource: 'system_message',
      resourceId: req.params.id,
      payload: { reason: req.body?.reason },
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
    }).catch((e) => logger.warn('audit failed', { error: e.message }))
    res.json(m)
  } catch (err) { next(err) }
})

module.exports = router
