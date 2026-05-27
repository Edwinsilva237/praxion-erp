'use strict'

const express = require('express')
const { tenantResolver }      = require('../../middleware/tenantResolver')
const { authGuard }           = require('../../middleware/authGuard')
const { requireActiveTenant } = require('../../middleware/requireActiveTenant')
const { checkPermission }     = require('../../middleware/checkPermission')
const svc = require('./codeFormatService')

const router = express.Router()
router.use(tenantResolver)
router.use(authGuard)
router.use(requireActiveTenant)

router.get('/', checkPermission('settings', 'read'), async (req, res, next) => {
  try {
    res.json(await svc.listFormats({ tenantId: req.tenant.id }))
  } catch (err) { next(err) }
})

/**
 * GET /api/code-formats/preview-next/:entity
 * Lo usan los forms de captura. Requiere solo 'read' porque no muta nada.
 */
router.get('/preview-next/:entity', checkPermission('settings', 'read'), async (req, res, next) => {
  try {
    res.json(await svc.previewNext({
      tenantId: req.tenant.id,
      entityType: req.params.entity,
    }))
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message })
    next(err)
  }
})

router.put('/:entity', checkPermission('settings', 'update'), async (req, res, next) => {
  try {
    const row = await svc.upsertFormat({
      tenantId: req.tenant.id,
      entityType: req.params.entity,
      ...req.body,
      userId: req.auth.userId,
    })
    res.json(row)
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message })
    next(err)
  }
})

router.patch('/:id', checkPermission('settings', 'update'), async (req, res, next) => {
  try {
    const row = await svc.updateFormat({
      tenantId: req.tenant.id,
      formatId: req.params.id,
      ...req.body,
    })
    if (!row) return res.status(404).json({ error: 'Formato no encontrado.' })
    res.json(row)
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message })
    next(err)
  }
})

router.delete('/:id', checkPermission('settings', 'update'), async (req, res, next) => {
  try {
    const ok = await svc.deleteFormat({ tenantId: req.tenant.id, formatId: req.params.id })
    if (!ok) return res.status(404).json({ error: 'Formato no encontrado.' })
    res.json({ message: 'Formato eliminado.' })
  } catch (err) { next(err) }
})

module.exports = router
