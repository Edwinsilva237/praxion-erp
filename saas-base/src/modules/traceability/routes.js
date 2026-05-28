'use strict'

/**
 * SaaS v2 — Endpoints de trazabilidad.
 *
 * Permiten contestar 3 preguntas críticas (recall, auditorías de calidad):
 *
 *   1. ¿Qué MP usé en este lote de PT? (backward)
 *   2. ¿A quién entregué este lote de PT? (forward, parte 1)
 *   3. ¿A qué clientes terminó llegando este lote de MP? (full chain, para recall)
 *
 * Solo aplica cuando el tenant tiene uses_lots=true. Si está apagado, los
 * endpoints devuelven listas vacías (no es un error — simplemente no hay
 * datos que rastrear).
 *
 * Permiso: production:read (mismo que consultar turnos).
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
 * GET /api/traceability/search?q=ABC&type=all|raw|product
 *   Busca lotes (MP o PT) por número.
 *   Devuelve {rawMaterialLots: [...], productLots: [...]}.
 */
router.get('/search', checkPermission('traceability', 'read'), async (req, res, next) => {
  try {
    const q = String(req.query.q || '').trim()
    const type = req.query.type || 'all'
    if (q.length < 2) return res.json({ rawMaterialLots: [], productLots: [] })

    const tenantId = req.tenant.id
    const pattern = `%${q.toLowerCase()}%`

    const result = { rawMaterialLots: [], productLots: [] }

    if (type === 'all' || type === 'raw') {
      const { rows } = await query(
        `SELECT rml.id, rml.lot_number, rml.manufacturer_lot,
                rml.received_at, rml.expiry_date,
                rml.quantity_received, rml.quantity_remaining,
                rml.status,
                rm.name AS raw_material_name, rm.item_kind,
                bp.name AS supplier_name
           FROM raw_material_lots rml
           JOIN raw_materials rm ON rm.id = rml.raw_material_id
           LEFT JOIN business_partners bp ON bp.id = rml.supplier_id
          WHERE rml.tenant_id = $1
            AND (LOWER(rml.lot_number) LIKE $2 OR LOWER(rml.manufacturer_lot) LIKE $2)
          ORDER BY rml.received_at DESC
          LIMIT 30`,
        [tenantId, pattern]
      )
      result.rawMaterialLots = rows
    }

    if (type === 'all' || type === 'product') {
      const { rows } = await query(
        `SELECT pl.id, pl.lot_number, pl.production_date, pl.expiry_date,
                pl.quantity_produced, pl.quantity_remaining, pl.status,
                p.name AS product_name, p.sku AS product_sku,
                qg.name AS quality_grade_name, qg.grade_number
           FROM product_lots pl
           JOIN products p ON p.id = pl.product_id
           LEFT JOIN tenant_quality_grades qg ON qg.id = pl.quality_grade_id
          WHERE pl.tenant_id = $1
            AND LOWER(pl.lot_number) LIKE $2
          ORDER BY pl.production_date DESC
          LIMIT 30`,
        [tenantId, pattern]
      )
      result.productLots = rows
    }

    res.json(result)
  } catch (err) { next(err) }
})

/**
 * GET /api/traceability/product-lot/:id
 *   Cadena completa de un lote de PT: backward (MP usada) + forward (clientes).
 */
router.get('/product-lot/:id', checkPermission('traceability', 'read'), async (req, res, next) => {
  try {
    const tenantId = req.tenant.id
    const lotId = req.params.id

    // El lote mismo
    const { rows: lotRows } = await query(
      `SELECT pl.*,
              p.name AS product_name, p.sku AS product_sku,
              po.order_number,
              ps.shift_number, ps.shift_date,
              qg.name AS quality_grade_name, qg.grade_number,
              op.full_name AS operator_name,
              w.name AS warehouse_name
         FROM product_lots pl
         JOIN products p ON p.id = pl.product_id
         LEFT JOIN production_orders po ON po.id = pl.production_order_id
         LEFT JOIN production_shifts ps ON ps.id = pl.shift_id
         LEFT JOIN users op ON op.id = ps.operator_id
         LEFT JOIN tenant_quality_grades qg ON qg.id = pl.quality_grade_id
         LEFT JOIN warehouses w ON w.id = pl.warehouse_id
        WHERE pl.id = $1 AND pl.tenant_id = $2`,
      [lotId, tenantId]
    )
    if (lotRows.length === 0) return res.status(404).json({ error: 'Lote no encontrado.' })
    const lot = lotRows[0]

    // Backward: qué MP entró
    const { rows: backward } = await query(
      `SELECT lc.id AS consumption_id,
              lc.quantity_consumed,
              lc.consumed_at,
              u.code AS unit_code, u.symbol AS unit_symbol,
              rml.id AS raw_material_lot_id,
              rml.lot_number AS raw_material_lot_number,
              rml.manufacturer_lot,
              rml.received_at, rml.expiry_date,
              rm.name AS raw_material_name, rm.item_kind,
              bp.name AS supplier_name,
              sr.receipt_number, sr.received_date
         FROM lot_consumption lc
         JOIN raw_material_lots rml ON rml.id = lc.raw_material_lot_id
         JOIN raw_materials rm     ON rm.id  = rml.raw_material_id
         LEFT JOIN tenant_units u  ON u.id   = lc.unit_id
         LEFT JOIN business_partners bp ON bp.id = rml.supplier_id
         LEFT JOIN supplier_receipts sr ON sr.id = rml.supplier_receipt_id
        WHERE lc.product_lot_id = $1 AND lc.tenant_id = $2
        ORDER BY lc.consumed_at DESC`,
      [lotId, tenantId]
    )

    // Forward: qué clientes recibieron este lote
    const { rows: forward } = await query(
      `SELECT dnl.id AS delivery_line_id,
              dnl.quantity_delivered, dnl.quantity_base, dnl.unit,
              dn.id AS delivery_note_id, dn.document_number,
              dn.issue_date, dn.delivered_at, dn.status,
              bp.id AS partner_id, bp.name AS partner_name
         FROM delivery_note_lines dnl
         JOIN delivery_notes dn ON dn.id = dnl.delivery_note_id
         JOIN business_partners bp ON bp.id = dn.partner_id
        WHERE dnl.product_lot_id = $1 AND dn.tenant_id = $2
          AND dn.status <> 'cancelled'
        ORDER BY dn.issue_date DESC`,
      [lotId, tenantId]
    )

    res.json({ lot, backward, forward })
  } catch (err) { next(err) }
})

/**
 * GET /api/traceability/raw-material-lot/:id
 *   Cadena hacia adelante: qué PTs se hicieron con este MP, y a qué clientes
 *   terminaron entregándose. Crítico para recall.
 */
router.get('/raw-material-lot/:id', checkPermission('traceability', 'read'), async (req, res, next) => {
  try {
    const tenantId = req.tenant.id
    const lotId = req.params.id

    // El lote MP mismo
    const { rows: lotRows } = await query(
      `SELECT rml.*,
              rm.name AS raw_material_name, rm.item_kind,
              bp.name AS supplier_name,
              sr.receipt_number, sr.received_date,
              w.name AS warehouse_name
         FROM raw_material_lots rml
         JOIN raw_materials rm ON rm.id = rml.raw_material_id
         LEFT JOIN business_partners bp ON bp.id = rml.supplier_id
         LEFT JOIN supplier_receipts sr ON sr.id = rml.supplier_receipt_id
         LEFT JOIN warehouses w ON w.id = rml.warehouse_id
        WHERE rml.id = $1 AND rml.tenant_id = $2`,
      [lotId, tenantId]
    )
    if (lotRows.length === 0) return res.status(404).json({ error: 'Lote de MP no encontrado.' })
    const lot = lotRows[0]

    // PTs que usaron este lote MP + total consumido
    const { rows: productLots } = await query(
      `SELECT pl.id, pl.lot_number, pl.production_date, pl.quantity_produced,
              pl.quantity_remaining, pl.status,
              p.name AS product_name, p.sku AS product_sku,
              SUM(lc.quantity_consumed)::numeric AS total_consumed_from_this_mp_lot
         FROM lot_consumption lc
         JOIN product_lots pl ON pl.id = lc.product_lot_id
         JOIN products p      ON p.id  = pl.product_id
        WHERE lc.raw_material_lot_id = $1 AND lc.tenant_id = $2
        GROUP BY pl.id, pl.lot_number, pl.production_date, pl.quantity_produced,
                 pl.quantity_remaining, pl.status, p.name, p.sku
        ORDER BY pl.production_date DESC`,
      [lotId, tenantId]
    )

    // Clientes finales — a través de los PTs producidos con este MP
    const { rows: customers } = await query(
      `SELECT DISTINCT bp.id AS partner_id, bp.name AS partner_name,
              dn.id AS delivery_note_id, dn.document_number, dn.issue_date,
              dnl.quantity_base, dnl.unit,
              pl.lot_number AS product_lot_number,
              p.name AS product_name
         FROM lot_consumption lc
         JOIN product_lots pl       ON pl.id = lc.product_lot_id
         JOIN products p            ON p.id  = pl.product_id
         JOIN delivery_note_lines dnl ON dnl.product_lot_id = pl.id
         JOIN delivery_notes dn     ON dn.id = dnl.delivery_note_id
         JOIN business_partners bp  ON bp.id = dn.partner_id
        WHERE lc.raw_material_lot_id = $1
          AND lc.tenant_id = $2
          AND dn.status <> 'cancelled'
        ORDER BY dn.issue_date DESC`,
      [lotId, tenantId]
    )

    res.json({ lot, productLots, customers })
  } catch (err) { next(err) }
})

module.exports = router
