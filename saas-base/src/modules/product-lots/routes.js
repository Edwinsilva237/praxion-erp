'use strict'

/**
 * SaaS v2 — Endpoints de consulta de product_lots.
 *
 * El frontend los consume al despachar remisiones para mostrar selector de
 * lote por línea cuando el tenant tiene `uses_lots=true`. Si `uses_fefo=true`,
 * el orden ya viene FEFO (primero los más próximos a vencer).
 *
 * GET /api/product-lots?productId=X&status=active&warehouseId=Y
 *   Devuelve lotes con quantity_remaining > 0 del producto solicitado.
 *   Ordenados FEFO (expiry_date ASC NULLS LAST → production_date ASC).
 */

const express = require('express')
const { query } = require('../../db')
const { tenantResolver }      = require('../../middleware/tenantResolver')
const { authGuard }           = require('../../middleware/authGuard')
const { requireActiveTenant } = require('../../middleware/requireActiveTenant')
const { checkPermission }     = require('../../middleware/checkPermission')

const router = express.Router()
router.use(tenantResolver)
router.use(authGuard)
router.use(requireActiveTenant)

/**
 * GET /api/product-lots
 *   ?productId=UUID         (recomendado — sin este filtro devuelve todos)
 *   ?warehouseId=UUID       (opcional — filtrar por almacén específico)
 *   ?status=active          (default 'active'; pass 'all' para incluir agotados/cuarentena)
 *   ?onlyAvailable=true     (default true — solo lotes con quantity_remaining > 0)
 */
router.get('/', checkPermission('sales', 'read'), async (req, res, next) => {
  try {
    const { productId, warehouseId, status, onlyAvailable } = req.query
    const params = [req.tenant.id]
    const filters = ['pl.tenant_id = $1']

    if (productId) {
      params.push(productId)
      filters.push(`pl.product_id = $${params.length}`)
    }
    if (warehouseId) {
      params.push(warehouseId)
      filters.push(`pl.warehouse_id = $${params.length}`)
    }
    const statusFilter = status || 'active'
    if (statusFilter !== 'all') {
      params.push(statusFilter)
      filters.push(`pl.status = $${params.length}`)
    }
    if (onlyAvailable !== 'false') {
      filters.push(`pl.quantity_remaining > 0`)
    }

    const where = filters.join(' AND ')

    const { rows } = await query(
      `SELECT pl.id, pl.lot_number, pl.product_id,
              pl.quantity_produced, pl.quantity_remaining,
              pl.production_date, pl.expiry_date, pl.best_before_date,
              pl.status, pl.warehouse_id, pl.quality_grade_id,
              p.sku AS product_sku, p.name AS product_name,
              w.name AS warehouse_name,
              qg.name AS quality_grade_name, qg.grade_number,
              -- días hasta vencimiento (para indicador FEFO)
              CASE
                WHEN pl.expiry_date IS NULL THEN NULL
                ELSE (pl.expiry_date - CURRENT_DATE)
              END AS days_to_expiry
         FROM product_lots pl
         JOIN products p ON p.id = pl.product_id
         LEFT JOIN warehouses w ON w.id = pl.warehouse_id
         LEFT JOIN tenant_quality_grades qg ON qg.id = pl.quality_grade_id
        WHERE ${where}
        ORDER BY
          pl.expiry_date ASC NULLS LAST,  -- FEFO: primero vence, primero sale
          pl.production_date ASC,
          pl.created_at ASC
        LIMIT 200`,
      params
    )

    res.json(rows)
  } catch (err) { next(err) }
})

module.exports = router
