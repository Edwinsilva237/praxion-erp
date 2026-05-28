'use strict'

const router = require('express').Router()
const { authGuard }       = require('../../middleware/authGuard')
const { requireActiveTenant } = require('../../middleware/requireActiveTenant')
const { checkPermission } = require('../../middleware/checkPermission')
const { tenantResolver }  = require('../../middleware/tenantResolver')
const requireModule       = require('../../middleware/requireModule')
const warehouseService    = require('./warehouseService')

router.use(tenantResolver)
router.use(authGuard)
router.use(requireActiveTenant)
router.use(requireModule('inventory'))

// ── GET /api/warehouses ────────────────────────────────────────────────────
router.get('/', checkPermission('warehouses', 'read'), async (req, res, next) => {
  try {
    const { type, include_inactive } = req.query
    const data = await warehouseService.list({
      tenantId: req.tenant.id,
      type:     type || null,
      includeInactive: include_inactive === 'true' || include_inactive === '1',
    })
    res.json(data)
  } catch (err) { next(err) }
})

// ── GET /api/warehouses/:id ────────────────────────────────────────────────
router.get('/:id', checkPermission('warehouses', 'read'), async (req, res, next) => {
  try {
    const w = await warehouseService.getById({ tenantId: req.tenant.id, id: req.params.id })
    if (!w) return res.status(404).json({ error: 'Almacén no encontrado.' })
    res.json(w)
  } catch (err) { next(err) }
})

// ── POST /api/warehouses ───────────────────────────────────────────────────
router.post('/', checkPermission('warehouses', 'create'), async (req, res, next) => {
  try {
    const { name, type, resin_type, description, is_active, make_default } = req.body
    const w = await warehouseService.create({
      tenantId:    req.tenant.id,
      name,
      type,
      resinType:   resin_type   || null,
      description: description  || null,
      isActive:    is_active !== false,
      makeDefault: make_default === true,
    })
    res.status(201).json(w)
  } catch (err) { next(err) }
})

// ── PATCH /api/warehouses/:id ──────────────────────────────────────────────
router.patch('/:id', checkPermission('warehouses', 'update'), async (req, res, next) => {
  try {
    const patch = {}
    if ('name'        in req.body) patch.name        = req.body.name
    if ('resin_type'  in req.body) patch.resin_type  = req.body.resin_type || null
    if ('description' in req.body) patch.description = req.body.description || null
    if ('is_active'   in req.body) patch.is_active   = !!req.body.is_active
    if ('type'        in req.body) patch.type        = req.body.type   // se rechaza en service

    const w = await warehouseService.update({
      tenantId: req.tenant.id,
      id:       req.params.id,
      patch,
    })
    res.json(w)
  } catch (err) { next(err) }
})

// ── POST /api/warehouses/:id/set-default ──────────────────────────────────
router.post('/:id/set-default', checkPermission('warehouses', 'update'), async (req, res, next) => {
  try {
    const w = await warehouseService.setDefault({
      tenantId: req.tenant.id,
      id:       req.params.id,
    })
    res.json(w)
  } catch (err) { next(err) }
})

// ── DELETE /api/warehouses/:id ────────────────────────────────────────────
router.delete('/:id', checkPermission('warehouses', 'delete'), async (req, res, next) => {
  try {
    const r = await warehouseService.remove({
      tenantId: req.tenant.id,
      id:       req.params.id,
    })
    res.json(r)
  } catch (err) { next(err) }
})

module.exports = router
