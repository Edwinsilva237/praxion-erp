'use strict'

/**
 * SaaS v2 §Fase3 — Servicio de reporte de varianza de overhead.
 *
 * Genera el reporte comparativo estimado vs real para un mes cerrado.
 * Requiere que los períodos del mes estén finalizados.
 */

const { query, withBypass } = require('../../db')

const MONTH_NAMES_ES = [
  'Enero','Febrero','Marzo','Abril','Mayo','Junio',
  'Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre',
]

/**
 * Construye el reporte de varianza de overhead para un mes.
 *
 * @param {string} tenantId
 * @param {number} year
 * @param {number} month   1-12
 * @returns {object}  Ver estructura completa abajo.
 */
async function buildVarianceReport(tenantId, year, month) {
  const y = parseInt(year)
  const m = parseInt(month)
  if (!y || !m || m < 1 || m > 12) {
    const err = new Error('year y month deben ser números válidos (month: 1-12).')
    err.status = 400; throw err
  }

  const label = `${MONTH_NAMES_ES[m - 1]} ${y}`

  // ── 1. Períodos del mes ──────────────────────────────────────────────────
  const { rows: periods } = await withBypass(() =>
    query(
      `SELECT top.*,
              toi.name AS item_name,
              toi.code AS item_code,
              toi.allocation_base
       FROM tenant_overhead_periods top
       JOIN tenant_overhead_items toi ON toi.id = top.overhead_item_id
       WHERE top.tenant_id = $1
         AND EXTRACT(YEAR  FROM top.period_start) = $2
         AND EXTRACT(MONTH FROM top.period_start) = $3
       ORDER BY toi.sort_order, toi.name`,
      [tenantId, y, m]
    )
  )

  // ── 2. Resumen por ítem ──────────────────────────────────────────────────
  const ALERT_THRESHOLD_PCT = 10  // varianza >= 10% = hasAlert

  const items = periods.map(p => {
    const estimated   = parseFloat(p.estimated_amount) || 0
    const real        = p.real_amount !== null ? parseFloat(p.real_amount) : null
    const variance    = real !== null ? real - estimated : null
    const variancePct = (variance !== null && estimated > 0)
      ? (variance / estimated) * 100
      : null
    const hasAlert = variancePct !== null && Math.abs(variancePct) >= ALERT_THRESHOLD_PCT

    return {
      itemId:          p.overhead_item_id,
      periodId:        p.id,
      code:            p.item_code,
      name:            p.item_name,
      allocationBase:  p.allocation_base,
      isFinalized:     p.is_finalized,
      estimated,
      real,
      variance,
      variancePct:     variancePct !== null ? parseFloat(variancePct.toFixed(2)) : null,
      hasAlert,
    }
  })

  // ── 3. Totales ───────────────────────────────────────────────────────────
  const totalEstimated = items.reduce((s, i) => s + i.estimated, 0)
  const totalReal      = items.every(i => i.real !== null)
    ? items.reduce((s, i) => s + (i.real || 0), 0)
    : null
  const totalVariance    = totalReal !== null ? totalReal - totalEstimated : null
  const totalVariancePct = (totalVariance !== null && totalEstimated > 0)
    ? parseFloat(((totalVariance / totalEstimated) * 100).toFixed(2))
    : null

  // ── 4. Productos re-costeados en el mes ─────────────────────────────────
  const { rows: snapshots } = await withBypass(() =>
    query(
      `SELECT ocs.*,
              po.order_number,
              p.id     AS product_id,
              p.name   AS product_name,
              p.sku,
              est.unit_cost_grade_1 AS estimated_unit_cost
       FROM order_cost_snapshots ocs
       JOIN production_orders po ON po.id = ocs.order_id
       JOIN products p           ON p.id  = po.product_id
       LEFT JOIN order_cost_snapshots est
              ON est.order_id = ocs.order_id AND est.snapshot_type = 'estimated'
       WHERE po.tenant_id = $1
         AND ocs.snapshot_type = 'recosted'
         AND EXTRACT(YEAR  FROM ocs.created_at) = $2
         AND EXTRACT(MONTH FROM ocs.created_at) = $3`,
      [tenantId, y, m]
    )
  )

  const products = snapshots.map(s => {
    const estCost     = parseFloat(s.estimated_unit_cost) || 0
    const recostedCost = parseFloat(s.unit_cost_grade_1)  || 0
    const delta       = recostedCost - estCost
    const deltaPct    = estCost > 0
      ? parseFloat(((delta / estCost) * 100).toFixed(2))
      : null
    return {
      orderId:           s.order_id,
      orderNumber:       s.order_number,
      productId:         s.product_id,
      sku:               s.sku,
      name:              s.product_name,
      estimatedUnitCost: estCost,
      recostedUnitCost:  recostedCost,
      overheadCost:      parseFloat(s.overhead_cost) || 0,
      delta,
      deltaPct,
    }
  })

  // ── 5. Varianza de volumen (basis) ───────────────────────────────────────
  const volumeVariance = periods.map(p => {
    const planned  = parseFloat(p.expected_basis_divisor) || 0
    const actual   = parseFloat(p.actual_basis_divisor)   || 0
    const variance = actual - planned
    const variancePct = planned > 0
      ? parseFloat(((variance / planned) * 100).toFixed(2))
      : null
    return {
      itemId:       p.overhead_item_id,
      itemName:     p.item_name,
      base:         p.allocation_base,
      planned,
      actual,
      variance,
      variancePct,
    }
  }).filter(v => v.planned > 0 || v.actual > 0)

  return {
    period: { year: y, month: m, label },
    items,
    totals: {
      estimated:   totalEstimated,
      real:        totalReal,
      variance:    totalVariance,
      variancePct: totalVariancePct,
    },
    products,
    volumeVariance,
  }
}

module.exports = { buildVarianceReport }
