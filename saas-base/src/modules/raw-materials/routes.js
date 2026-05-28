'use strict'

const express = require('express')
const { tenantResolver }  = require('../../middleware/tenantResolver')
const { authGuard }       = require('../../middleware/authGuard')
const { requireActiveTenant } = require('../../middleware/requireActiveTenant')
const { checkPermission } = require('../../middleware/checkPermission')
const svc                 = require('./rawMaterialService')
const { query }           = require('../../db')

const router = express.Router()
router.use(tenantResolver)
router.use(authGuard)
router.use(requireActiveTenant)

// GET /api/raw-materials
router.get('/', checkPermission('products', 'read'), async (req, res, next) => {
  try {
    const { resinType, materialType, itemKind, isActive, search, withStock, page, limit } = req.query
    const result = await svc.listRawMaterials({
      tenantId: req.tenant.id,
      resinType, materialType, itemKind,
      isActive: isActive !== undefined ? isActive === 'true' : undefined,
      search,
      withStock: withStock === '1' || withStock === 'true',
      page:  parseInt(page  || 1,  10),
      limit: Math.min(parseInt(limit || 50, 10), 100),
    })
    res.json(result)
  } catch (err) { next(err) }
})

// GET /api/raw-materials/:id
router.get('/:id', checkPermission('products', 'read'), async (req, res, next) => {
  try {
    const item = await svc.getRawMaterial({ tenantId: req.tenant.id, id: req.params.id })
    if (!item) return res.status(404).json({ error: 'Materia prima no encontrada.' })
    res.json(item)
  } catch (err) { next(err) }
})

// POST /api/raw-materials
router.post('/', checkPermission('products', 'create'), async (req, res, next) => {
  try {
    const { name, code, resinType, materialType, itemKind, unit, maxRegrindPct, costPerKg, description, leadTimeDays } = req.body
    if (!name) return res.status(400).json({ error: 'name es requerido.' })
    // resin_type solo es obligatorio cuando el tenant maneja resinas
    // (uses_resin_types=true, típico de plástico) Y el item es 'raw_material'.
    // Para verticales como palomitas/pastelería/frituras (uses_resin_types=false)
    // o subtipos packaging/additive, viene como NULL y se acepta.
    const kind = itemKind || 'raw_material'
    if (kind === 'raw_material' && !resinType) {
      const { rows: cfgRows } = await query(
        `SELECT uses_resin_types FROM tenant_process_config WHERE tenant_id = $1`,
        [req.tenant.id]
      )
      if (cfgRows[0]?.uses_resin_types) {
        return res.status(400).json({ error: 'resinType es requerido para materia prima.' })
      }
    }
    const item = await svc.createRawMaterial({
      tenantId: req.tenant.id,
      name, code, resinType, materialType, itemKind: kind, unit, maxRegrindPct, costPerKg, description, leadTimeDays,
      userId: req.auth.userId, ipAddress: req.ip, userAgent: req.get('user-agent'),
    })
    res.status(201).json(item)
  } catch (err) {
    if (err.code === '23505') {
      const msg = err.constraint?.includes('code')
        ? 'Ya existe una materia prima con ese código.'
        : 'Ya existe una materia prima con ese nombre.'
      return res.status(409).json({ error: msg })
    }
    next(err)
  }
})

// PATCH /api/raw-materials/:id
router.patch('/:id', checkPermission('products', 'update'), async (req, res, next) => {
  try {
    const { name, code, materialType, unit, maxRegrindPct, costPerKg, description, isActive, leadTimeDays } = req.body
    const item = await svc.updateRawMaterial({
      tenantId: req.tenant.id, id: req.params.id,
      name, code, materialType, unit, maxRegrindPct, costPerKg, description, isActive, leadTimeDays,
      userId: req.auth.userId, ipAddress: req.ip, userAgent: req.get('user-agent'),
    })
    if (!item) return res.status(404).json({ error: 'Materia prima no encontrada.' })
    res.json(item)
  } catch (err) { next(err) }
})

module.exports = router
