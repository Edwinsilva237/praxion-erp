'use strict'

// Reporte de producción por periodo.
//
// IMPORTANTE — Fuentes correctas:
// En la operación real `production_shifts.mp_real_kg` y `scrap_estimated_kg`
// están desactualizados (deuda técnica). Por eso aquí derivamos las cifras
// directamente de las tablas fuente:
//   - PT producido en kg = SUM(shift_progress.real_weight_kg)
//   - Scrap en kg        = SUM(shift_scrap.kg)
//   - MP consumida en kg = PT + scrap (paquetes + merma).
//
// Costos: usamos `production_shifts.cost_per_unit` que se calcula al validar
// el turno (Modelo D — peso_PT × avg_cost_per_kg + costos fijos del catálogo).
// Total del turno = cost_per_unit × pt_units_produced.
//
// Otras fuentes:
//   - production_orders.theoretical_mp_kg: se llena al liberar la orden.
//   - production_orders.real_mp_kg: NUNCA se llena — lo calculamos agregando
//     los turnos para el tab de "Eficiencia".
//   - inventory_movements (production_mp_consumption): kg de MP consumida
//     valorizada por costo del catálogo en el momento — útil para el tab
//     de "Costos por raw material".

const { query } = require('../../db')

const SHIFT_BASE_CTE = `
  WITH shift_data AS (
    SELECT
      ps.id,
      ps.production_order_id,
      ps.operator_id,
      ps.shift_date,
      ps.started_at,
      ps.closed_at,
      ps.pt_units_produced,
      ps.cost_per_unit,
      (COALESCE(ps.cost_per_unit, 0) * COALESCE(ps.pt_units_produced, 0))::numeric AS total_cost,
      COALESCE((SELECT SUM(real_weight_kg)
                  FROM shift_progress WHERE shift_id = ps.id), 0)::numeric AS pt_kg,
      COALESCE((SELECT SUM(kg)
                  FROM shift_scrap    WHERE shift_id = ps.id), 0)::numeric AS scrap_kg
      FROM production_shifts ps
     WHERE ps.tenant_id = $1
       AND ps.status IN ('closed','reviewed')
       AND COALESCE(ps.closed_at::date, ps.shift_date) >= $2
       AND COALESCE(ps.closed_at::date, ps.shift_date) <  $3
  )
`

/**
 * Vista completa del reporte de producción en un periodo.
 *
 * @param {object} params
 * @param {string} params.tenantId
 * @param {string} params.from 'YYYY-MM-DD' inclusivo
 * @param {string} params.to   'YYYY-MM-DD' exclusivo
 */
async function getProductionReport({ tenantId, from, to }) {
  const prev = previousPeriod(from, to)

  const [
    currentTotals,
    previousTotals,
    byProduct,
    byOperator,
    scrapAnalysis,
    costAnalysis,
    efficiency,
    weeklyTrend,
  ] = await Promise.all([
    getPeriodTotals(tenantId, from, to),
    getPeriodTotals(tenantId, prev.from, prev.to),
    getByProduct(tenantId, from, to),
    getByOperator(tenantId, from, to),
    getScrapAnalysis(tenantId, from, to),
    getCostAnalysis(tenantId, from, to),
    getEfficiencyAnalysis(tenantId, from, to),
    getWeeklyTrend(tenantId, from, to),
  ])

  return {
    period: { from, to, previous: prev },
    totals_current:  currentTotals,
    totals_previous: previousTotals,
    by_product:      byProduct,
    by_operator:     byOperator,
    scrap_analysis:  scrapAnalysis,
    cost_analysis:   costAnalysis,
    efficiency,
    weekly_trend:    weeklyTrend,
    generated_at:    new Date().toISOString(),
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// KPIs del periodo
// ─────────────────────────────────────────────────────────────────────────────

async function getPeriodTotals(tenantId, from, to) {
  const { rows: shiftRows } = await query(`
    ${SHIFT_BASE_CTE}
    SELECT
      COUNT(*)::int                              AS shifts,
      COUNT(DISTINCT production_order_id)::int   AS orders,
      COUNT(DISTINCT operator_id)::int           AS operators,
      COALESCE(SUM(pt_units_produced), 0)::int   AS pt_units,
      COALESCE(SUM(pt_kg),    0)::numeric        AS pt_kg,
      COALESCE(SUM(scrap_kg), 0)::numeric        AS scrap_kg,
      COALESCE(SUM(total_cost), 0)::numeric      AS total_cost,
      COALESCE(SUM(EXTRACT(EPOCH FROM (closed_at - started_at)) / 3600),
               0)::numeric                       AS hours
      FROM shift_data
  `, [tenantId, from, to])

  // Metros lineales y costo agregado por esquinero (solo productos con
  // length_mm definido). Sirve para sacar el costo promedio por metro
  // del periodo.
  const { rows: meterRows } = await query(`
    ${SHIFT_BASE_CTE}
    SELECT
      COALESCE(SUM(sd.pt_units_produced * p.length_mm / 1000.0), 0)::numeric AS meters,
      COALESCE(SUM(sd.total_cost), 0)::numeric                                AS total_cost
      FROM shift_data sd
      JOIN production_orders po ON po.id = sd.production_order_id
      JOIN products          p  ON p.id  = po.product_id
     WHERE p.length_mm IS NOT NULL
       AND p.length_mm > 0
  `, [tenantId, from, to])

  // Órdenes completadas en el periodo.
  const { rows: orderRows } = await query(`
    SELECT COUNT(*)::int AS orders_completed
      FROM production_orders
     WHERE tenant_id = $1
       AND status = 'completed'
       AND completed_at >= $2
       AND completed_at <  $3
  `, [tenantId, from, to])

  const s = shiftRows[0]
  const ptUnits   = parseInt(s.pt_units, 10) || 0
  const ptKg      = parseFloat(s.pt_kg) || 0
  const scrapKg   = parseFloat(s.scrap_kg) || 0
  const mpKg      = ptKg + scrapKg
  const totalCost = parseFloat(s.total_cost) || 0
  const hours     = parseFloat(s.hours) || 0
  const yieldPct  = mpKg > 0 ? (ptKg / mpKg) * 100 : 0

  const meters         = parseFloat(meterRows[0]?.meters) || 0
  const metersCost     = parseFloat(meterRows[0]?.total_cost) || 0
  const avgCostPerMeter = meters > 0 ? metersCost / meters : null

  return {
    shifts:           s.shifts,
    orders_started:   s.orders,
    orders_completed: orderRows[0].orders_completed,
    operators:        s.operators,
    pt_units:         ptUnits,
    pt_kg:            ptKg,
    mp_kg:            mpKg,
    scrap_kg:         scrapKg,
    yield_pct:        yieldPct,
    total_cost:       totalCost,
    unit_cost:        ptUnits > 0 ? totalCost / ptUnits : 0,
    meters,
    avg_cost_per_meter: avgCostPerMeter,
    hours,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Por producto
// ─────────────────────────────────────────────────────────────────────────────

async function getByProduct(tenantId, from, to) {
  // Costo del turno (cost_per_unit × pt_units_produced) ya se agrega en el CTE.
  const { rows: shiftRows } = await query(`
    ${SHIFT_BASE_CTE}
    SELECT p.id        AS product_id,
           p.sku, p.name, p.type, p.length_mm,
           p.base_unit, p.sale_unit,
           rm.name     AS raw_material_name,
           rm.resin_type,
           COUNT(sd.id)::int                          AS shifts,
           COUNT(DISTINCT sd.production_order_id)::int AS orders,
           COALESCE(SUM(sd.pt_units_produced),0)::int AS pt_units,
           COALESCE(SUM(sd.pt_kg),     0)::numeric AS pt_kg,
           COALESCE(SUM(sd.scrap_kg),  0)::numeric AS scrap_kg,
           COALESCE(SUM(sd.total_cost),0)::numeric AS total_cost
      FROM shift_data sd
      JOIN production_orders po ON po.id = sd.production_order_id
      JOIN products          p  ON p.id  = po.product_id
      LEFT JOIN raw_materials rm ON rm.id = po.raw_material_id
     GROUP BY p.id, p.sku, p.name, p.type, p.length_mm, p.base_unit, p.sale_unit,
              rm.name, rm.resin_type
     ORDER BY pt_units DESC
  `, [tenantId, from, to])

  // Precio promedio de venta del producto en el mismo periodo.
  const { rows: priceRows } = await query(`
    SELECT dnl.product_id,
           AVG(dnl.unit_price)::numeric AS avg_price,
           SUM(dnl.quantity_base)::numeric AS qty_sold
      FROM delivery_note_lines dnl
      JOIN delivery_notes dn ON dn.id = dnl.delivery_note_id
     WHERE dn.tenant_id = $1
       AND dn.status IN ('delivered','partially_delivered','issued','sent_by_email')
       AND COALESCE(dn.delivered_at, dn.issue_date) >= $2
       AND COALESCE(dn.delivered_at, dn.issue_date) <  $3
     GROUP BY dnl.product_id
  `, [tenantId, from, to])
  const priceByProduct = new Map(priceRows.map(r => [r.product_id, {
    avg_price: parseFloat(r.avg_price) || 0,
    qty_sold:  parseFloat(r.qty_sold)  || 0,
  }]))

  return shiftRows.map(r => {
    const ptUnits   = parseInt(r.pt_units, 10) || 0
    const ptKg      = parseFloat(r.pt_kg) || 0
    const scrapKg   = parseFloat(r.scrap_kg) || 0
    const mpKg      = ptKg + scrapKg
    const totalCost = parseFloat(r.total_cost) || 0
    const unitCost  = ptUnits > 0 ? totalCost / ptUnits : null

    const price     = priceByProduct.get(r.product_id)
    const avgPrice  = price?.avg_price || null
    const marginPct = (avgPrice && unitCost) ? ((avgPrice - unitCost) / avgPrice) * 100 : null

    const yieldPct = mpKg > 0 ? (ptKg    / mpKg) * 100 : 0
    const scrapPct = mpKg > 0 ? (scrapKg / mpKg) * 100 : 0

    // Metros lineales: aplica a cualquier producto con longitud capturada (no solo esquineros).
    const lengthMm = r.length_mm ? parseFloat(r.length_mm) : null
    const meters = (lengthMm && lengthMm > 0)
      ? (ptUnits * lengthMm) / 1000
      : null
    const costPerMeter = (meters && meters > 0) ? totalCost / meters : null

    return {
      product_id:     r.product_id,
      sku:            r.sku,
      name:           r.name,
      type:           r.type,
      length_mm:      lengthMm,
      base_unit:      r.base_unit,
      sale_unit:      r.sale_unit,
      raw_material:   r.raw_material_name,
      resin_type:     r.resin_type,
      shifts:         r.shifts,
      orders:         r.orders,
      pt_units:       ptUnits,
      pt_kg:          ptKg,
      mp_kg:          mpKg,
      scrap_kg:       scrapKg,
      yield_pct:      yieldPct,
      scrap_pct:      scrapPct,
      total_cost:     totalCost,
      unit_cost:      unitCost,
      meters,
      cost_per_meter: costPerMeter,
      avg_sale_price: avgPrice,
      qty_sold:       price?.qty_sold || 0,
      margin_pct:     marginPct,
    }
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// Por operador
// ─────────────────────────────────────────────────────────────────────────────

async function getByOperator(tenantId, from, to) {
  const { rows } = await query(`
    ${SHIFT_BASE_CTE}
    SELECT u.id           AS operator_id,
           u.full_name    AS operator_name,
           COUNT(sd.id)::int                          AS shifts,
           COUNT(DISTINCT sd.production_order_id)::int AS orders,
           COALESCE(SUM(sd.pt_units_produced),0)::int AS pt_units,
           COALESCE(SUM(sd.pt_kg),    0)::numeric     AS pt_kg,
           COALESCE(SUM(sd.scrap_kg), 0)::numeric     AS scrap_kg,
           COALESCE(SUM(EXTRACT(EPOCH FROM (sd.closed_at - sd.started_at)) / 3600),
                    0)::numeric                       AS hours
      FROM shift_data sd
      JOIN users u ON u.id = sd.operator_id
     GROUP BY u.id, u.full_name
     ORDER BY pt_units DESC
  `, [tenantId, from, to])

  return rows.map(r => {
    const ptUnits = parseInt(r.pt_units, 10) || 0
    const ptKg    = parseFloat(r.pt_kg) || 0
    const scrapKg = parseFloat(r.scrap_kg) || 0
    const mpKg    = ptKg + scrapKg
    const hours   = parseFloat(r.hours) || 0
    return {
      operator_id:    r.operator_id,
      operator_name:  r.operator_name,
      shifts:         r.shifts,
      orders:         r.orders,
      pt_units:       ptUnits,
      pt_kg:          ptKg,
      mp_kg:          mpKg,
      scrap_kg:       scrapKg,
      hours,
      units_per_hour: hours > 0 ? ptUnits / hours : 0,
      scrap_pct:      mpKg > 0 ? (scrapKg / mpKg) * 100 : 0,
      yield_pct:      mpKg > 0 ? (ptKg    / mpKg) * 100 : 0,
    }
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// Mermas y scrap
// ─────────────────────────────────────────────────────────────────────────────

async function getScrapAnalysis(tenantId, from, to) {
  const { rows: topProducts } = await query(`
    ${SHIFT_BASE_CTE}
    SELECT p.id AS product_id, p.sku, p.name,
           COALESCE(SUM(sd.pt_kg),    0)::numeric AS pt_kg,
           COALESCE(SUM(sd.scrap_kg), 0)::numeric AS scrap_kg
      FROM shift_data sd
      JOIN production_orders po ON po.id = sd.production_order_id
      JOIN products p           ON p.id  = po.product_id
     GROUP BY p.id, p.sku, p.name
    HAVING COALESCE(SUM(sd.scrap_kg),0) > 0
     ORDER BY SUM(sd.scrap_kg) DESC
     LIMIT 20
  `, [tenantId, from, to])

  const { rows: topOperators } = await query(`
    ${SHIFT_BASE_CTE}
    SELECT u.id AS operator_id, u.full_name AS operator_name,
           COALESCE(SUM(sd.pt_kg),    0)::numeric AS pt_kg,
           COALESCE(SUM(sd.scrap_kg), 0)::numeric AS scrap_kg,
           COUNT(sd.id)::int                       AS shifts
      FROM shift_data sd
      JOIN users u ON u.id = sd.operator_id
     GROUP BY u.id, u.full_name
    HAVING COALESCE(SUM(sd.pt_kg + sd.scrap_kg),0) > 0
     ORDER BY (COALESCE(SUM(sd.scrap_kg),0)
              / NULLIF(SUM(sd.pt_kg + sd.scrap_kg),0)) DESC
     LIMIT 10
  `, [tenantId, from, to])

  return {
    by_product: topProducts.map(r => {
      const scrap = parseFloat(r.scrap_kg) || 0
      const pt    = parseFloat(r.pt_kg)    || 0
      const mp    = pt + scrap
      return {
        product_id: r.product_id,
        sku:        r.sku,
        name:       r.name,
        scrap_kg:   scrap,
        pt_kg:      pt,
        mp_kg:      mp,
        scrap_pct:  mp > 0 ? (scrap / mp) * 100 : 0,
      }
    }),
    by_operator: topOperators.map(r => {
      const scrap = parseFloat(r.scrap_kg) || 0
      const pt    = parseFloat(r.pt_kg)    || 0
      const mp    = pt + scrap
      return {
        operator_id:   r.operator_id,
        operator_name: r.operator_name,
        shifts:        r.shifts,
        scrap_kg:      scrap,
        pt_kg:         pt,
        mp_kg:         mp,
        scrap_pct:     mp > 0 ? (scrap / mp) * 100 : 0,
      }
    }),
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Costos y márgenes
// ─────────────────────────────────────────────────────────────────────────────

async function getCostAnalysis(tenantId, from, to) {
  // Consumo de MP por raw_material y su costo total (de inventory_movements).
  // Incluye item_kind para desglosar costos por tipo (materia prima / empaque / aditivo).
  const { rows: byMaterial } = await query(`
    SELECT rm.id   AS raw_material_id,
           rm.name AS raw_material_name,
           rm.resin_type,
           rm.material_type,
           rm.item_kind,
           rm.cost_per_kg,
           COALESCE(SUM(im.quantity),   0)::numeric AS kg_consumed,
           COALESCE(SUM(im.total_cost), 0)::numeric AS total_cost
      FROM inventory_movements im
      JOIN raw_materials rm ON rm.id = im.item_id
     WHERE im.tenant_id = $1
       AND im.item_type = 'raw_material'
       AND im.movement_type = 'production_mp_consumption'
       AND im.created_at >= $2
       AND im.created_at <  $3
     GROUP BY rm.id, rm.name, rm.resin_type, rm.material_type, rm.item_kind, rm.cost_per_kg
     ORDER BY total_cost DESC
  `, [tenantId, from, to])

  // Resumen por item_kind para que el frontend muestre desglose MP/Empaque/Aditivos.
  const byKind = byMaterial.reduce((acc, r) => {
    const k = r.item_kind || 'raw_material'
    if (!acc[k]) acc[k] = { kind: k, kg_consumed: 0, total_cost: 0, items_count: 0 }
    acc[k].kg_consumed += parseFloat(r.kg_consumed) || 0
    acc[k].total_cost  += parseFloat(r.total_cost)  || 0
    acc[k].items_count += 1
    return acc
  }, {})

  return {
    by_material: byMaterial.map(r => ({
      raw_material_id:   r.raw_material_id,
      raw_material_name: r.raw_material_name,
      resin_type:        r.resin_type,
      material_type:     r.material_type,
      item_kind:         r.item_kind || 'raw_material',
      cost_per_kg:       parseFloat(r.cost_per_kg) || 0,
      kg_consumed:       parseFloat(r.kg_consumed) || 0,
      total_cost:        parseFloat(r.total_cost)  || 0,
    })),
    by_kind: Object.values(byKind),
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Eficiencia: teórico vs real
// ─────────────────────────────────────────────────────────────────────────────

async function getEfficiencyAnalysis(tenantId, from, to) {
  // production_orders.real_mp_kg está siempre vacío en el sistema actual,
  // así que lo calculamos: real_mp_kg de cada orden = suma del PT+scrap de
  // todos sus turnos cerrados.
  const { rows: byOrder } = await query(`
    SELECT po.id           AS order_id,
           po.order_number,
           po.theoretical_mp_kg,
           po.quantity_units,
           po.completed_at,
           p.sku, p.name AS product_name,
           COALESCE((SELECT SUM(real_weight_kg)
                       FROM shift_progress sp
                       JOIN production_shifts ps ON ps.id = sp.shift_id
                      WHERE ps.production_order_id = po.id), 0)::numeric AS pt_kg,
           COALESCE((SELECT SUM(ss.kg)
                       FROM shift_scrap ss
                       JOIN production_shifts ps ON ps.id = ss.shift_id
                      WHERE ps.production_order_id = po.id), 0)::numeric AS scrap_kg
      FROM production_orders po
      JOIN products p ON p.id = po.product_id
     WHERE po.tenant_id = $1
       AND po.status = 'completed'
       AND po.completed_at >= $2
       AND po.completed_at <  $3
       AND po.theoretical_mp_kg IS NOT NULL
     ORDER BY po.completed_at DESC
  `, [tenantId, from, to])

  const rowsWithDev = byOrder.map(r => {
    const theoretical = parseFloat(r.theoretical_mp_kg) || 0
    const ptKg        = parseFloat(r.pt_kg) || 0
    const scrapKg     = parseFloat(r.scrap_kg) || 0
    const real        = ptKg + scrapKg
    const deviationKg = real - theoretical
    const deviationPct = theoretical > 0 ? (deviationKg / theoretical) * 100 : 0
    return {
      order_id:     r.order_id,
      order_number: r.order_number,
      product_sku:  r.sku,
      product_name: r.product_name,
      quantity_units:    r.quantity_units,
      theoretical_mp_kg: theoretical,
      real_mp_kg:        real,
      deviation_kg:      deviationKg,
      deviation_pct:     deviationPct,
      completed_at:      r.completed_at,
    }
  })

  const total = rowsWithDev.length
  const sumAbsPct    = rowsWithDev.reduce((s, r) => s + Math.abs(r.deviation_pct), 0)
  const sumSignedPct = rowsWithDev.reduce((s, r) => s + r.deviation_pct, 0)
  const overTheoretical  = rowsWithDev.filter(r => r.deviation_pct > 5).length
  const underTheoretical = rowsWithDev.filter(r => r.deviation_pct < -5).length

  return {
    summary: {
      orders:                   total,
      avg_abs_deviation_pct:    total > 0 ? sumAbsPct / total : 0,
      avg_signed_deviation_pct: total > 0 ? sumSignedPct / total : 0,
      over_theoretical_count:   overTheoretical,
      under_theoretical_count:  underTheoretical,
      within_tolerance_count:   total - overTheoretical - underTheoretical,
    },
    by_order: rowsWithDev,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Tendencia semanal
// ─────────────────────────────────────────────────────────────────────────────

async function getWeeklyTrend(tenantId, from, to) {
  const { rows } = await query(`
    ${SHIFT_BASE_CTE}
    SELECT
      date_trunc('week', COALESCE(closed_at::date, shift_date))::date AS week_start,
      COALESCE(SUM(pt_units_produced),0)::int      AS pt_units,
      COALESCE(SUM(pt_kg),    0)::numeric          AS pt_kg,
      COALESCE(SUM(scrap_kg), 0)::numeric          AS scrap_kg,
      COUNT(*)::int                                AS shifts
      FROM shift_data
     GROUP BY 1
     ORDER BY 1
  `, [tenantId, from, to])

  return rows.map(r => {
    const ptKg    = parseFloat(r.pt_kg) || 0
    const scrapKg = parseFloat(r.scrap_kg) || 0
    return {
      week_start: r.week_start,
      pt_units:   parseInt(r.pt_units, 10) || 0,
      pt_kg:      ptKg,
      mp_kg:      ptKg + scrapKg,
      scrap_kg:   scrapKg,
      shifts:     r.shifts,
    }
  })
}

// ─────────────────────────────────────────────────────────────────────────────

function previousPeriod(from, to) {
  const fromD = new Date(from + 'T00:00:00Z')
  const toD   = new Date(to   + 'T00:00:00Z')
  const days  = Math.round((toD - fromD) / (24 * 60 * 60 * 1000))
  const prevFromD = new Date(fromD)
  prevFromD.setUTCDate(prevFromD.getUTCDate() - days)
  return {
    from: prevFromD.toISOString().slice(0, 10),
    to:   from,
  }
}

module.exports = { getProductionReport }
