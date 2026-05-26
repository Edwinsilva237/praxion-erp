'use strict'

const express             = require('express')
const { tenantResolver }  = require('../../middleware/tenantResolver')
const { authGuard }       = require('../../middleware/authGuard')
const { requireActiveTenant } = require('../../middleware/requireActiveTenant')
const { checkPermission } = require('../../middleware/checkPermission')
const service             = require('./service')

const router = express.Router()
router.use(tenantResolver)
router.use(authGuard)
router.use(requireActiveTenant)

/**
 * GET /api/bank-accounts?includeInactive=1
 */
router.get('/', checkPermission('financials', 'read'), async (req, res, next) => {
  try {
    const rows = await service.list({
      tenantId: req.tenant.id,
      includeInactive: req.query.includeInactive === '1' || req.query.includeInactive === 'true',
    })
    res.json(rows)
  } catch (err) { next(err) }
})

router.get('/:id', checkPermission('financials', 'read'), async (req, res, next) => {
  try {
    const row = await service.get({ tenantId: req.tenant.id, id: req.params.id })
    if (!row) return res.status(404).json({ error: 'Cuenta bancaria no encontrada.' })
    res.json(row)
  } catch (err) { next(err) }
})

router.post('/', checkPermission('financials', 'create'), async (req, res, next) => {
  try {
    const row = await service.create({
      tenantId: req.tenant.id, userId: req.auth.userId,
      body: req.body, ipAddress: req.ip, userAgent: req.get('user-agent'),
    })
    res.status(201).json(row)
  } catch (err) { next(err) }
})

router.patch('/:id', checkPermission('financials', 'update'), async (req, res, next) => {
  try {
    const row = await service.update({
      tenantId: req.tenant.id, userId: req.auth.userId,
      id: req.params.id, body: req.body,
      ipAddress: req.ip, userAgent: req.get('user-agent'),
    })
    res.json(row)
  } catch (err) { next(err) }
})

router.delete('/:id', checkPermission('financials', 'delete'), async (req, res, next) => {
  try {
    const row = await service.remove({
      tenantId: req.tenant.id, userId: req.auth.userId,
      id: req.params.id, ipAddress: req.ip, userAgent: req.get('user-agent'),
    })
    res.json(row)
  } catch (err) { next(err) }
})

module.exports = router
