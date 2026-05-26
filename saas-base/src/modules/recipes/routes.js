'use strict'

/**
 * SaaS v2 — Rutas de recetas.
 *
 * GET    /api/recipes                  — list (filtros: productId, vigentOnly, isActive)
 * GET    /api/recipes/:id              — get con componentes incluidos
 * POST   /api/recipes                  — crea nueva versión (cierra anterior si existe)
 * PATCH  /api/recipes/:id              — solo metadata (name, is_active)
 *
 * Permisos: recipes:read / recipes:update.
 */

const express = require('express')
const { tenantResolver }      = require('../../middleware/tenantResolver')
const { authGuard }           = require('../../middleware/authGuard')
const { requireActiveTenant } = require('../../middleware/requireActiveTenant')
const { checkPermission }     = require('../../middleware/checkPermission')
const svc                     = require('./recipesService')

const router = express.Router()
router.use(tenantResolver)
router.use(authGuard)
router.use(requireActiveTenant)

const tid = (req) => req.tenant.id
const uid = (req) => req.auth.userId
const ip  = (req) => req.ip
const ua  = (req) => req.get('user-agent')

const handleSvcError = (err, res, next) => {
  if (err.status) return res.status(err.status).json({ error: err.message })
  next(err)
}

/** GET /api/recipes?productId=...&vigentOnly=true&isActive=true */
router.get('/', checkPermission('recipes', 'read'), async (req, res, next) => {
  try {
    const { productId, vigentOnly, isActive } = req.query
    const items = await svc.listRecipes({
      tenantId: tid(req),
      productId,
      vigentOnly: vigentOnly === 'true',
      isActive: isActive !== undefined ? isActive === 'true' : undefined,
    })
    res.json(items)
  } catch (err) { next(err) }
})

/** GET /api/recipes/:id */
router.get('/:id', checkPermission('recipes', 'read'), async (req, res, next) => {
  try {
    const r = await svc.getRecipe({ tenantId: tid(req), id: req.params.id })
    if (!r) return res.status(404).json({ error: 'Receta no encontrada.' })
    res.json(r)
  } catch (err) { next(err) }
})

/**
 * POST /api/recipes
 * body: {
 *   product_id, name?, yield_quantity, yield_unit_id, expected_scrap_pct?,
 *   components: [{ raw_material_id, quantity, unit_id, is_optional?, substitute_group?, notes?, sort_order? }]
 * }
 */
router.post('/', checkPermission('recipes', 'update'), async (req, res, next) => {
  try {
    const components = Array.isArray(req.body.components) ? req.body.components : []
    const normalizedComponents = components.map(c => ({
      rawMaterialId:   c.raw_material_id   ?? c.rawMaterialId,
      quantity:        c.quantity,
      unitId:          c.unit_id           ?? c.unitId,
      isOptional:      c.is_optional       ?? c.isOptional,
      substituteGroup: c.substitute_group  ?? c.substituteGroup,
      notes:           c.notes,
      sortOrder:       c.sort_order        ?? c.sortOrder,
    }))

    const recipe = await svc.createRecipe({
      tenantId: tid(req),
      userId:   uid(req),
      ipAddress: ip(req),
      userAgent: ua(req),
      productId:         req.body.product_id          ?? req.body.productId,
      name:              req.body.name,
      yieldQuantity:     req.body.yield_quantity      ?? req.body.yieldQuantity,
      yieldUnitId:       req.body.yield_unit_id       ?? req.body.yieldUnitId,
      expectedScrapPct:  req.body.expected_scrap_pct  ?? req.body.expectedScrapPct ?? null,
      components: normalizedComponents,
    })
    res.status(201).json(recipe)
  } catch (err) { handleSvcError(err, res, next) }
})

/** PATCH /api/recipes/:id  — solo name, is_active */
router.patch('/:id', checkPermission('recipes', 'update'), async (req, res, next) => {
  try {
    const r = await svc.updateRecipe({
      tenantId: tid(req),
      userId:   uid(req),
      id:       req.params.id,
      ipAddress: ip(req),
      userAgent: ua(req),
      name:     req.body.name,
      isActive: req.body.is_active ?? req.body.isActive,
    })
    res.json(r)
  } catch (err) { handleSvcError(err, res, next) }
})

module.exports = router
