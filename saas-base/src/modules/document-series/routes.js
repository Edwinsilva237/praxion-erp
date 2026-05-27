'use strict'

const express = require('express')
const { tenantResolver }      = require('../../middleware/tenantResolver')
const { authGuard }           = require('../../middleware/authGuard')
const { requireActiveTenant } = require('../../middleware/requireActiveTenant')
const { checkPermission }     = require('../../middleware/checkPermission')
const svc = require('./documentSeriesService')

const router = express.Router()
router.use(tenantResolver)
router.use(authGuard)
router.use(requireActiveTenant)

router.get('/', checkPermission('settings', 'read'), async (req, res, next) => {
  try {
    res.json(await svc.listSeries({
      tenantId: req.tenant.id,
      entityType: req.query.entityType || null,
      includeInactive: req.query.includeInactive === 'true',
    }))
  } catch (err) { next(err) }
})

/**
 * GET /api/document-series/meta
 * Devuelve los entity_types soportados, sus labels y agrupación —
 * lo usa el frontend para pintar los tabs/selectores sin hardcoded.
 */
router.get('/meta', checkPermission('settings', 'read'), (_req, res) => {
  res.json({
    entityTypes: svc.ENTITY_TYPES,
    labels:      svc.ENTITY_LABELS,
    groups:      svc.ENTITY_GROUPS,
  })
})

router.get('/:id', checkPermission('settings', 'read'), async (req, res, next) => {
  try {
    const row = await svc.getSeries({ tenantId: req.tenant.id, seriesId: req.params.id })
    if (!row) return res.status(404).json({ error: 'Serie no encontrada.' })
    res.json(row)
  } catch (err) { next(err) }
})

router.post('/', checkPermission('settings', 'update'), async (req, res, next) => {
  try {
    const { entityType, fiscalProfileId, serie, folioNext, cfdiType, isDefault, notes } = req.body
    if (!entityType || !serie) {
      return res.status(400).json({ error: 'entityType y serie son requeridos.' })
    }
    const row = await svc.createSeries({
      tenantId: req.tenant.id,
      entityType, fiscalProfileId, serie, folioNext, cfdiType, isDefault, notes,
      userId: req.auth.userId,
    })
    res.status(201).json(row)
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message })
    next(err)
  }
})

router.patch('/:id', checkPermission('settings', 'update'), async (req, res, next) => {
  try {
    res.json(await svc.updateSeries({
      tenantId: req.tenant.id,
      seriesId: req.params.id,
      ...req.body,
    }))
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message })
    next(err)
  }
})

router.delete('/:id', checkPermission('settings', 'update'), async (req, res, next) => {
  try {
    const ok = await svc.deleteSeries({ tenantId: req.tenant.id, seriesId: req.params.id })
    if (!ok) return res.status(404).json({ error: 'Serie no encontrada.' })
    res.json({ message: 'Serie eliminada.' })
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message })
    next(err)
  }
})

module.exports = router
