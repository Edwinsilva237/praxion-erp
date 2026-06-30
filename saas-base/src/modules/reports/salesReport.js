'use strict'

// Reporte de ventas con múltiples vistas (cliente, producto, metros, utilidad).
// Base de datos para análisis comercial. Todas las cifras en MXN.
//
// Costos: se calculan a partir de inventory_movements (que ya graba unit_cost
// en cada entrada de producción o compra). Usamos un promedio ponderado de
// los últimos 60 días — si el producto no tuvo entradas en ese periodo,
// el costo queda NULL y la utilidad como "n/d".

const { query } = require('../../db')
const { getSalesSnapshot } = require('./financialSnapshot')

const COST_WINDOW_DAYS = 60

// ─────────────────────────────────────────────────────────────────────────────
// Predicados "¿esta remisión/línea ya está facturada?" — reutilizables.
//
// Una remisión puede quedar facturada de TRES formas y todas deben contar como
// "facturada", o se misclasifica como "sin factura":
//   1) Factura INDIVIDUAL: liga directa (invoices.delivery_note_id = dn.id) y,
//      a nivel de línea, invoice_lines.delivery_note_line_id = dnl.id.
//   2) Factura CONSOLIDADA: deja delivery_note_id en NULL y NO guarda
//      delivery_note_line_id en sus líneas; la única liga es invoice_remissions
//      (mig 190). Sin chequear esa tabla, sus remisiones salían como "sin factura".
//   3) Venta ANTICIPADA: el pedido se factura DIRECTO (delivery_note_id NULL, NO
//      consolidada) y DESPUÉS se entregan remisiones; la liga es por
//      sales_order_line_id. Sin esta 3ª rama, la remisión de una venta anticipada
//      se contaba como "sin factura" además de su factura (mismo criterio que
//      listDeliveryNotes / getDeliveryNote).
//
// LINE_INVOICED: a nivel de LÍNEA de remisión (dnl). Requiere `dnl` en scope.
// DN_HAS_INVOICE: a nivel de REMISIÓN (dn). Requiere `dn` en scope. $1 = tenant.
// ─────────────────────────────────────────────────────────────────────────────
const LINE_INVOICED = `(
  EXISTS (
    SELECT 1 FROM invoice_lines il
     JOIN invoices inv ON inv.id = il.invoice_id
     WHERE il.delivery_note_line_id = dnl.id AND inv.status = 'stamped'
  ) OR EXISTS (
    SELECT 1 FROM invoice_remissions ir
     JOIN invoices inv2 ON inv2.id = ir.invoice_id
     WHERE ir.delivery_note_id = dnl.delivery_note_id AND inv2.status = 'stamped'
  ) OR EXISTS (
    SELECT 1 FROM invoice_lines il3
     JOIN invoices inv3 ON inv3.id = il3.invoice_id
     WHERE il3.sales_order_line_id = dnl.sales_order_line_id
       AND dnl.sales_order_line_id IS NOT NULL
       AND inv3.status = 'stamped'
       AND inv3.delivery_note_id IS NULL
       AND NOT EXISTS (SELECT 1 FROM invoice_remissions ir3 WHERE ir3.invoice_id = inv3.id)
  )
)`

const DN_HAS_INVOICE = `(
  EXISTS (
    SELECT 1 FROM invoices inv
     WHERE inv.tenant_id = $1 AND inv.delivery_note_id = dn.id AND inv.status = 'stamped'
  ) OR EXISTS (
    SELECT 1 FROM invoice_remissions ir
     JOIN invoices inv2 ON inv2.id = ir.invoice_id
     WHERE ir.delivery_note_id = dn.id AND inv2.status = 'stamped'
  ) OR EXISTS (
    SELECT 1 FROM invoices inv3
     JOIN invoice_lines il3        ON il3.invoice_id = inv3.id
     JOIN delivery_note_lines dnl3 ON dnl3.sales_order_line_id = il3.sales_order_line_id
     WHERE dnl3.delivery_note_id = dn.id
       AND inv3.status = 'stamped'
       AND inv3.delivery_note_id IS NULL
       AND NOT EXISTS (SELECT 1 FROM invoice_remissions ir3 WHERE ir3.invoice_id = inv3.id)
  )
)`

/**
 * Vista completa del reporte de ventas en un periodo.
 *
 * @param {object} params
 * @param {string} params.tenantId
 * @param {string} params.from 'YYYY-MM-DD' inclusivo
 * @param {string} params.to   'YYYY-MM-DD' exclusivo
 */
async function getSalesReport({ tenantId, from, to }) {
  // El "periodo previo" para comparativa: mismo número de días antes.
  const prev = previousPeriod(from, to)

  // UNIVERSO de ventas del periodo, MISMO método que el dashboard (sin IVA):
  // líneas de facturas timbradas (facturado) + líneas de remisiones NO facturadas
  // (sin factura). Cada venta UNA sola vez. De aquí se derivan todas las vistas,
  // así el reporte por cliente/producto suma al total del dashboard (sin IVA) y el
  // margen sigue siendo precio − costo por producto, sea anticipado o no.
  const universe = await getSalesUniverse(tenantId, from, to)
  const productIds = [...new Set(universe.map(r => r.product_id).filter(Boolean))]
  const costMap = await getProductCostMap(tenantId, productIds)

  const agg          = buildAggregates(universe, costMap)
  const weeklyTrend  = computeWeeklyTrend(universe)
  const prevRevenue  = await getPeriodRevenue(tenantId, prev.from, prev.to)

  // Snapshot del DASHBOARD (mismo método, CON IVA desglosado). Se devuelve aquí
  // para que pantalla/PDF/Excel muestren TODOS el mismo total del dashboard.
  const snap     = await getSalesSnapshot(tenantId, from, to)
  const snapPrev = await getSalesSnapshot(tenantId, prev.from, prev.to)

  return {
    period: { from, to, previous: prev },
    cost_window_days: COST_WINDOW_DAYS,
    sales_snapshot:      snap,
    sales_snapshot_prev: snapPrev,
    totals_current:   agg.totals,
    totals_previous:  { revenue: prevRevenue, estimated_cost: 0, estimated_margin: 0,
                        margin_pct: 0, deliveries: 0, customers: 0, cost_complete: true },
    by_customer:      agg.byCustomer,
    by_product:       agg.byProduct,
    top_customers:    agg.byCustomer.slice(0, 5).map(c => ({
                        partner_id: c.partner_id, partner_name: c.partner_name,
                        partner_legal_name: c.partner_legal_name,
                        revenue: c.revenue, deliveries: c.deliveries })),
    negative_margins: agg.negativeMargins,
    weekly_trend:     weeklyTrend,
    generated_at:     new Date().toISOString(),
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Universo de ventas del periodo (sin IVA, método dashboard, sin doble conteo)
// ─────────────────────────────────────────────────────────────────────────────
async function getSalesUniverse(tenantId, from, to) {
  const { rows } = await query(`
    WITH uni AS (
      -- FACTURADO: líneas de facturas de ingreso timbradas en el periodo.
      -- Subtotal MXN prorrateado (robusto a moneda y retenciones):
      -- total_mxn × (subtotal_línea / total_factura).
      SELECT 'facturado'::text AS src, true AS invoiced,
             inv.id AS doc_id, inv.partner_id, il.product_id,
             (inv.total_mxn * il.subtotal / NULLIF(inv.total, 0))::numeric AS subtotal_mxn,
             COALESCE(il.quantity, 0)::numeric                    AS qty_sale,
             COALESCE(il.quantity_base, il.quantity, 0)::numeric  AS qty_base,
             il.unit_price::numeric AS unit_price,
             to_char(inv.stamp_date, 'YYYY-MM-DD') AS eff_date
        FROM invoice_lines il
        JOIN invoices inv ON inv.id = il.invoice_id
       WHERE inv.tenant_id = $1 AND inv.cfdi_type = 'I' AND inv.status = 'stamped'
         AND inv.stamp_date >= $2 AND inv.stamp_date < $3
      UNION ALL
      -- SIN FACTURA: líneas de remisiones del periodo NO facturadas (3 ramas).
      SELECT 'sin_factura'::text AS src, false AS invoiced,
             dn.id AS doc_id, dn.partner_id, dnl.product_id,
             dnl.subtotal::numeric AS subtotal_mxn,
             COALESCE(dnl.quantity_delivered, 0)::numeric                    AS qty_sale,
             COALESCE(dnl.quantity_base, dnl.quantity_delivered, 0)::numeric AS qty_base,
             dnl.unit_price::numeric AS unit_price,
             to_char(COALESCE(dn.delivered_at, dn.issue_date), 'YYYY-MM-DD') AS eff_date
        FROM delivery_note_lines dnl
        JOIN delivery_notes dn ON dn.id = dnl.delivery_note_id
       WHERE dn.tenant_id = $1
         AND dn.status IN ('delivered','partially_delivered','issued','sent_by_email')
         AND COALESCE(dn.delivered_at, dn.issue_date) >= $2
         AND COALESCE(dn.delivered_at, dn.issue_date) <  $3
         AND NOT (${LINE_INVOICED})
    )
    SELECT uni.*,
           bp.name AS partner_name, bp.tax_name AS partner_legal_name, bp.rfc AS partner_rfc,
           p.sku, p.name AS product_name, p.type, p.length_mm, p.base_unit, p.sale_unit
      FROM uni
      LEFT JOIN business_partners bp ON bp.id = uni.partner_id
      LEFT JOIN products p           ON p.id = uni.product_id
  `, [tenantId, from, to])

  return rows.map(r => ({
    src: r.src, invoiced: r.invoiced, doc_id: r.doc_id,
    partner_id: r.partner_id, partner_name: r.partner_name,
    partner_legal_name: r.partner_legal_name, partner_rfc: r.partner_rfc,
    product_id: r.product_id, sku: r.sku, product_name: r.product_name, type: r.type,
    length_mm: r.length_mm != null ? parseFloat(r.length_mm) : null,
    base_unit: r.base_unit, sale_unit: r.sale_unit,
    subtotal_mxn: parseFloat(r.subtotal_mxn) || 0,
    qty_sale: parseFloat(r.qty_sale) || 0,
    qty_base: parseFloat(r.qty_base) || 0,
    unit_price: parseFloat(r.unit_price) || 0,
    eff_date: r.eff_date,
  }))
}

// Suma total del universo (para la comparativa del periodo anterior). Liviano.
async function getPeriodRevenue(tenantId, from, to) {
  const { rows } = await query(`
    SELECT (
      COALESCE((SELECT SUM(inv.total_mxn * il.subtotal / NULLIF(inv.total, 0))
                  FROM invoice_lines il JOIN invoices inv ON inv.id = il.invoice_id
                 WHERE inv.tenant_id = $1 AND inv.cfdi_type = 'I' AND inv.status = 'stamped'
                   AND inv.stamp_date >= $2 AND inv.stamp_date < $3), 0)
      +
      COALESCE((SELECT SUM(dnl.subtotal)
                  FROM delivery_note_lines dnl JOIN delivery_notes dn ON dn.id = dnl.delivery_note_id
                 WHERE dn.tenant_id = $1
                   AND dn.status IN ('delivered','partially_delivered','issued','sent_by_email')
                   AND COALESCE(dn.delivered_at, dn.issue_date) >= $2
                   AND COALESCE(dn.delivered_at, dn.issue_date) <  $3
                   AND NOT (${LINE_INVOICED})), 0)
    )::numeric AS revenue
  `, [tenantId, from, to])
  return parseFloat(rows[0].revenue) || 0
}

// Agrega el universo en by_customer / by_product / totals / negative_margins (JS).
function buildAggregates(rows, costMap) {
  const grand = rows.reduce((s, r) => s + r.subtotal_mxn, 0)

  // ── Por cliente ──
  const custMap = new Map()
  for (const r of rows) {
    const key = r.partner_id || 'null'
    let c = custMap.get(key)
    if (!c) {
      c = { partner_id: r.partner_id, partner_name: r.partner_name || '(sin cliente)',
            partner_legal_name: r.partner_legal_name, partner_rfc: r.partner_rfc,
            revenue: 0, invoiced: 0, uninvoiced: 0, cost: 0, costComplete: true, docs: new Set() }
      custMap.set(key, c)
    }
    c.revenue += r.subtotal_mxn
    if (r.invoiced) c.invoiced += r.subtotal_mxn; else c.uninvoiced += r.subtotal_mxn
    c.docs.add(r.doc_id)
    const cm = r.product_id ? costMap.get(r.product_id) : null
    if (cm) c.cost += r.qty_base * cm.avg_cost
    else if (r.qty_base > 0) c.costComplete = false
  }
  const byCustomer = [...custMap.values()].map(c => {
    const margin = c.revenue - c.cost
    return {
      partner_id: c.partner_id, partner_name: c.partner_name,
      partner_legal_name: c.partner_legal_name, partner_rfc: c.partner_rfc,
      revenue: c.revenue, invoiced_revenue: c.invoiced, uninvoiced_revenue: c.uninvoiced,
      pct_of_total: grand > 0 ? (c.revenue / grand) * 100 : 0,
      deliveries: c.docs.size, avg_ticket: c.docs.size > 0 ? c.revenue / c.docs.size : 0,
      estimated_cost: c.cost, estimated_margin: margin,
      margin_pct: c.revenue > 0 ? (margin / c.revenue) * 100 : 0,
      cost_complete: c.costComplete,
    }
  }).sort((a, b) => b.revenue - a.revenue)

  // ── Por producto ──
  const prodMap = new Map()
  for (const r of rows) {
    const key = r.product_id || 'null'
    let p = prodMap.get(key)
    if (!p) {
      p = { product_id: r.product_id, sku: r.sku || '—', name: r.product_name || '(sin producto)',
            type: r.type, length_mm: r.length_mm, base_unit: r.base_unit, sale_unit: r.sale_unit,
            revenue: 0, invoiced: 0, uninvoiced: 0, qty_sale: 0, qty_base: 0, priceSum: 0, priceN: 0 }
      prodMap.set(key, p)
    }
    p.revenue += r.subtotal_mxn
    if (r.invoiced) p.invoiced += r.subtotal_mxn; else p.uninvoiced += r.subtotal_mxn
    p.qty_sale += r.qty_sale
    p.qty_base += r.qty_base
    if (r.unit_price) { p.priceSum += r.unit_price; p.priceN++ }
  }
  const byProduct = [...prodMap.values()].map(p => {
    const cm = p.product_id ? costMap.get(p.product_id) : null
    const cost = cm ? cm.avg_cost * p.qty_base : null
    const margin = cost !== null ? p.revenue - cost : null
    const lengthMm = (p.length_mm && p.length_mm > 0) ? p.length_mm : null
    const meters = lengthMm ? (p.qty_base * lengthMm) / 1000 : null
    const looksLinear = p.type === 'corner_protector'
    return {
      product_id: p.product_id, sku: p.sku, name: p.name, type: p.type,
      length_mm: lengthMm, sale_unit: p.sale_unit, base_unit: p.base_unit,
      qty_sold: p.qty_sale, qty_base: p.qty_base,
      revenue: p.revenue, invoiced_revenue: p.invoiced, uninvoiced_revenue: p.uninvoiced,
      pct_of_total: grand > 0 ? (p.revenue / grand) * 100 : 0,
      avg_price: p.priceN > 0 ? p.priceSum / p.priceN : 0,
      unit_cost: cm ? cm.avg_cost : null,
      estimated_cost: cost, estimated_margin: margin,
      margin_pct: (margin !== null && p.revenue > 0) ? (margin / p.revenue) * 100 : null,
      meters, price_per_meter: (meters && meters > 0) ? p.revenue / meters : null,
      missing_length: looksLinear && !lengthMm,
    }
  }).sort((a, b) => b.revenue - a.revenue)

  // ── Totales ──
  let totalCost = 0, costComplete = true
  for (const p of byProduct) {
    if (p.estimated_cost !== null) totalCost += p.estimated_cost
    else if (p.qty_base > 0) costComplete = false
  }
  const margin = grand - totalCost
  const totals = {
    revenue: grand, estimated_cost: totalCost, estimated_margin: margin,
    margin_pct: grand > 0 ? (margin / grand) * 100 : 0,
    deliveries: new Set(rows.map(r => r.doc_id)).size,
    customers: new Set(rows.map(r => r.partner_id).filter(Boolean)).size,
    cost_complete: costComplete,
  }

  // ── Alertas de margen negativo ──
  const negativeMargins = byProduct
    .filter(p => p.estimated_margin !== null && p.estimated_margin < 0)
    .map(p => ({
      product_id: p.product_id, sku: p.sku, name: p.name, type: p.type,
      avg_price: p.avg_price, unit_cost: p.unit_cost, qty_base: p.qty_base,
      revenue: p.revenue, cost: p.estimated_cost, loss: Math.abs(p.estimated_margin),
    }))
    .sort((a, b) => b.loss - a.loss)

  return { byCustomer, byProduct, totals, negativeMargins }
}

// Tendencia semanal (lunes de la fecha efectiva: timbrado/entrega). JS.
function computeWeeklyTrend(rows) {
  const map = new Map()
  for (const r of rows) {
    const [y, m, d] = r.eff_date.split('-').map(Number)
    const dt = new Date(Date.UTC(y, m - 1, d))
    const dow = (dt.getUTCDay() + 6) % 7          // 0 = lunes
    const monday = new Date(dt); monday.setUTCDate(dt.getUTCDate() - dow)
    const key = monday.toISOString().slice(0, 10)
    let w = map.get(key)
    if (!w) { w = { week_start: key, revenue: 0, docs: new Set() }; map.set(key, w) }
    w.revenue += r.subtotal_mxn
    w.docs.add(r.doc_id)
  }
  return [...map.values()]
    .sort((a, b) => a.week_start < b.week_start ? -1 : 1)
    .map(w => ({ week_start: w.week_start, revenue: w.revenue, deliveries: w.docs.size }))
}

// ─────────────────────────────────────────────────────────────────────────────
// Costos
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Promedio ponderado de costo unitario por producto en los últimos N días.
 * Solo considera entradas (production_in, purchase_entry) con cantidad > 0.
 * Returns Map<productId, { avg_cost, sample_count }>.
 */
async function getProductCostMap(tenantId, productIds) {
  if (!productIds.length) return new Map()

  // Entradas al inventario de productos que aportan costo:
  //   - purchase_entry: producto comprado para reventa (lleva unit_cost)
  //   - production_pt_entry: producto terminado de manufactura
  // Excluimos production_wip_entry porque WIP no es "producto vendible".
  const { rows } = await query(`
    SELECT item_id AS product_id,
           SUM(unit_cost * quantity) / NULLIF(SUM(quantity), 0) AS avg_unit_cost,
           COUNT(*)::int AS sample_count
      FROM inventory_movements
     WHERE tenant_id = $1
       AND item_type = 'product'
       AND item_id  = ANY($2::uuid[])
       AND movement_type IN ('purchase_entry', 'production_pt_entry')
       AND quantity > 0
       AND unit_cost IS NOT NULL
       AND created_at >= NOW() - INTERVAL '${COST_WINDOW_DAYS} days'
     GROUP BY item_id
  `, [tenantId, productIds])

  const m = new Map()
  for (const r of rows) {
    m.set(r.product_id, {
      avg_cost:     parseFloat(r.avg_unit_cost),
      sample_count: r.sample_count,
    })
  }
  return m
}

// ─────────────────────────────────────────────────────────────────────────────

function previousPeriod(from, to) {
  // Mismo número de días que el actual, terminando justo antes de `from`.
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

/**
 * Detalle de facturas y remisiones para un cliente o producto en el periodo.
 *
 * @param {object} params
 * @param {string} params.tenantId
 * @param {'customer'|'product'} params.type
 * @param {string} params.id - partner_id o product_id según `type`
 * @param {string} params.from, params.to
 */
async function getSalesDetail({ tenantId, type, id, from, to }) {
  if (type === 'customer') return getCustomerDetail(tenantId, id, from, to)
  if (type === 'product')  return getProductDetail(tenantId, id, from, to)
  const err = new Error(`type debe ser 'customer' o 'product' (recibió '${type}')`)
  err.status = 400
  throw err
}

async function getCustomerDetail(tenantId, partnerId, from, to) {
  // Facturas timbradas del cliente en el periodo.
  const { rows: invoices } = await query(`
    SELECT inv.id, inv.document_number, inv.cfdi_uuid, inv.series, inv.folio,
           inv.stamp_date, inv.total_mxn, inv.status, inv.payment_method
      FROM invoices inv
     WHERE inv.tenant_id = $1
       AND inv.partner_id = $2
       AND inv.cfdi_type  = 'I'
       AND inv.stamp_date >= $3 AND inv.stamp_date < $4
     ORDER BY inv.stamp_date DESC
  `, [tenantId, partnerId, from, to])

  // Remisiones entregadas del cliente en el periodo + flag si tiene factura.
  const { rows: deliveries } = await query(`
    SELECT dn.id, dn.document_number, dn.delivered_at, dn.issue_date,
           dn.total_mxn, dn.status, dn.no_invoice,
           ${DN_HAS_INVOICE} AS has_invoice
      FROM delivery_notes dn
     WHERE dn.tenant_id = $1
       AND dn.partner_id = $2
       AND dn.status IN ('delivered','partially_delivered','issued','sent_by_email')
       AND COALESCE(dn.delivered_at, dn.issue_date) >= $3
       AND COALESCE(dn.delivered_at, dn.issue_date) <  $4
     ORDER BY COALESCE(dn.delivered_at, dn.issue_date) DESC
  `, [tenantId, partnerId, from, to])

  return { invoices, deliveries }
}

async function getProductDetail(tenantId, productId, from, to) {
  // Líneas de remisión del producto en el periodo, agrupadas por remisión.
  // Cada fila incluye partner_name + monto de esa línea + si la remisión
  // como un todo terminó en factura timbrada.
  const { rows: deliveries } = await query(`
    SELECT dn.id, dn.document_number, dn.delivered_at, dn.issue_date,
           dn.status, dn.no_invoice,
           bp.name AS partner_name,
           SUM(dnl.subtotal)::numeric AS subtotal,
           SUM(dnl.quantity_delivered)::numeric AS qty,
           ${DN_HAS_INVOICE} AS has_invoice
      FROM delivery_note_lines dnl
      JOIN delivery_notes dn ON dn.id = dnl.delivery_note_id
      JOIN business_partners bp ON bp.id = dn.partner_id
     WHERE dn.tenant_id = $1
       AND dnl.product_id = $2
       AND dn.status IN ('delivered','partially_delivered','issued','sent_by_email')
       AND COALESCE(dn.delivered_at, dn.issue_date) >= $3
       AND COALESCE(dn.delivered_at, dn.issue_date) <  $4
     GROUP BY dn.id, dn.document_number, dn.delivered_at, dn.issue_date,
              dn.status, dn.no_invoice, bp.name
     ORDER BY COALESCE(dn.delivered_at, dn.issue_date) DESC
  `, [tenantId, productId, from, to])

  // Líneas de factura del producto en el periodo (vía invoice_lines).
  const { rows: invoices } = await query(`
    SELECT inv.id, inv.document_number, inv.cfdi_uuid, inv.stamp_date, inv.status,
           bp.name AS partner_name,
           SUM(il.subtotal)::numeric AS subtotal,
           SUM(il.quantity)::numeric AS qty
      FROM invoice_lines il
      JOIN invoices inv ON inv.id = il.invoice_id
      JOIN business_partners bp ON bp.id = inv.partner_id
     WHERE inv.tenant_id = $1
       AND il.product_id = $2
       AND inv.cfdi_type = 'I'
       AND inv.stamp_date >= $3 AND inv.stamp_date < $4
     GROUP BY inv.id, inv.document_number, inv.cfdi_uuid, inv.stamp_date, inv.status, bp.name
     ORDER BY inv.stamp_date DESC
  `, [tenantId, productId, from, to])

  return { invoices, deliveries }
}

// ─────────────────────────────────────────────────────────────────────────────
// Conciliación: por qué el "Acumulado del mes" del dashboard ≠ "Ventas del
// periodo" del reporte. Descompone cada lado y el facturado del dashboard por
// origen (remisión del periodo / de periodos anteriores / factura directa), para
// aislar en pesos exactos las dos causas: IVA y diferencia de base/fecha.
//
//   - REPORTE  = remisiones ENTREGADAS en el periodo, SUBTOTAL sin IVA.
//   - DASHBOARD = facturas TIMBRADAS en el periodo (con IVA) + remisiones del
//     periodo sin factura (sin IVA). El facturado usa stamp_date; el sin-factura
//     usa delivered_at — exactamente como financialSnapshot.
// ─────────────────────────────────────────────────────────────────────────────
async function getSalesReconciliation({ tenantId, from, to }) {
  // 1) Lado REPORTE — remisiones del periodo (sin IVA), partido facturado/sin factura.
  const { rows: repRows } = await query(`
    SELECT
      COALESCE(SUM(dnl.subtotal), 0)::numeric AS total,
      COALESCE(SUM(CASE WHEN ${LINE_INVOICED} THEN dnl.subtotal ELSE 0 END), 0)::numeric AS invoiced,
      COALESCE(SUM(CASE WHEN NOT (${LINE_INVOICED}) THEN dnl.subtotal ELSE 0 END), 0)::numeric AS uninvoiced
      FROM delivery_note_lines dnl
      JOIN delivery_notes dn ON dn.id = dnl.delivery_note_id
     WHERE dn.tenant_id = $1
       AND dn.status IN ('delivered','partially_delivered','issued','sent_by_email')
       AND COALESCE(dn.delivered_at, dn.issue_date) >= $2
       AND COALESCE(dn.delivered_at, dn.issue_date) <  $3
  `, [tenantId, from, to])

  // 2) Lado DASHBOARD — facturado CON IVA (por stamp_date) + sin factura (remisiones).
  const { rows: dInv } = await query(`
    SELECT COALESCE(SUM(total_mxn), 0)::numeric AS total, COUNT(*)::int AS num
      FROM invoices
     WHERE tenant_id = $1 AND cfdi_type = 'I' AND status = 'stamped'
       AND stamp_date >= $2 AND stamp_date < $3
  `, [tenantId, from, to])

  const { rows: dUninv } = await query(`
    SELECT COALESCE(SUM(dn.total_mxn), 0)::numeric AS total, COUNT(*)::int AS num
      FROM delivery_notes dn
     WHERE dn.tenant_id = $1
       AND dn.status IN ('delivered','partially_delivered','issued','sent_by_email')
       AND dn.delivered_at >= $2 AND dn.delivered_at < $3
       AND NOT EXISTS (
         SELECT 1 FROM invoices inv
          WHERE inv.tenant_id = $1 AND inv.delivery_note_id = dn.id AND inv.status = 'stamped')
       AND NOT EXISTS (
         SELECT 1 FROM invoice_remissions ir
           JOIN invoices inv ON inv.id = ir.invoice_id
          WHERE ir.delivery_note_id = dn.id AND inv.status = 'stamped')
       AND NOT EXISTS (
         SELECT 1 FROM invoices inv
           JOIN invoice_lines il        ON il.invoice_id = inv.id
           JOIN delivery_note_lines dnl ON dnl.sales_order_line_id = il.sales_order_line_id
          WHERE dnl.delivery_note_id = dn.id
            AND inv.status = 'stamped'
            AND inv.delivery_note_id IS NULL
            AND NOT EXISTS (SELECT 1 FROM invoice_remissions ir2 WHERE ir2.invoice_id = inv.id))
  `, [tenantId, from, to])

  // 3) Desglose del FACTURADO del dashboard por ORIGEN. Subtotal en MXN prorrateado
  //    (robusto a moneda y retenciones): subtotal_mxn = total_mxn × subtotal/total.
  const { rows: buckets } = await query(`
    WITH stamped AS (
      SELECT i.id, i.total_mxn,
             (i.total_mxn * i.subtotal / NULLIF(i.total, 0)) AS subtotal_mxn
        FROM invoices i
       WHERE i.tenant_id = $1 AND i.cfdi_type = 'I' AND i.status = 'stamped'
         AND i.stamp_date >= $2 AND i.stamp_date < $3
    ),
    links AS (
      SELECT s.id AS invoice_id, COALESCE(dn.delivered_at, dn.issue_date) AS dnt
        FROM stamped s
        JOIN invoices i        ON i.id = s.id
        JOIN delivery_notes dn ON dn.id = i.delivery_note_id
      UNION
      SELECT s.id, COALESCE(dn.delivered_at, dn.issue_date)
        FROM stamped s
        JOIN invoice_remissions ir ON ir.invoice_id = s.id
        JOIN delivery_notes dn     ON dn.id = ir.delivery_note_id
      UNION
      -- Venta ANTICIPADA: factura directa del pedido ligada a sus remisiones por
      -- sales_order_line_id (delivery_note_id NULL y NO consolidada).
      SELECT s.id, COALESCE(dn.delivered_at, dn.issue_date)
        FROM stamped s
        JOIN invoices i              ON i.id = s.id AND i.delivery_note_id IS NULL
        JOIN invoice_lines il        ON il.invoice_id = s.id
        JOIN delivery_note_lines dnl ON dnl.sales_order_line_id = il.sales_order_line_id
        JOIN delivery_notes dn       ON dn.id = dnl.delivery_note_id
       WHERE NOT EXISTS (SELECT 1 FROM invoice_remissions ir WHERE ir.invoice_id = s.id)
    ),
    classified AS (
      SELECT s.id, s.total_mxn, s.subtotal_mxn,
        CASE
          WHEN NOT EXISTS (SELECT 1 FROM links l WHERE l.invoice_id = s.id) THEN 'directa'
          WHEN EXISTS (SELECT 1 FROM links l WHERE l.invoice_id = s.id AND l.dnt >= $2 AND l.dnt < $3) THEN 'mes'
          WHEN EXISTS (SELECT 1 FROM links l WHERE l.invoice_id = s.id AND l.dnt <  $2) THEN 'previa'
          ELSE 'posterior'
        END AS bucket
      FROM stamped s
    )
    SELECT bucket,
           COUNT(*)::int AS num,
           COALESCE(SUM(subtotal_mxn), 0)::numeric        AS subtotal_mxn,
           COALESCE(SUM(total_mxn - subtotal_mxn), 0)::numeric AS iva_mxn,
           COALESCE(SUM(total_mxn), 0)::numeric           AS total_mxn
      FROM classified
     GROUP BY bucket
  `, [tenantId, from, to])

  const byBucket = { directa: null, mes: null, previa: null, posterior: null }
  for (const b of buckets) {
    byBucket[b.bucket] = {
      num: b.num,
      subtotal_mxn: parseFloat(b.subtotal_mxn) || 0,
      iva_mxn:      parseFloat(b.iva_mxn) || 0,
      total_mxn:    parseFloat(b.total_mxn) || 0,
    }
  }
  const zero = () => ({ num: 0, subtotal_mxn: 0, iva_mxn: 0, total_mxn: 0 })

  return {
    period: { from, to },
    report: {
      total:      parseFloat(repRows[0].total) || 0,
      invoiced:   parseFloat(repRows[0].invoiced) || 0,
      uninvoiced: parseFloat(repRows[0].uninvoiced) || 0,
    },
    dashboard: {
      invoiced_with_iva: parseFloat(dInv[0].total) || 0,
      invoiced_count:    dInv[0].num,
      uninvoiced:        parseFloat(dUninv[0].total) || 0,
      uninvoiced_count:  dUninv[0].num,
    },
    invoiced_buckets: {
      mes:       byBucket.mes       || zero(),
      previa:    byBucket.previa    || zero(),
      directa:   byBucket.directa   || zero(),
      posterior: byBucket.posterior || zero(),
    },
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Integridad de CXC: detecta DOBLE COBRO — remisiones con una cuenta por cobrar
// de remisión ACTIVA (no cancelada) que ADEMÁS ya están facturadas por cualquiera
// de las 3 ligas (directa / consolidada / anticipada). En un sistema sano esto
// debe ser CERO: el saldo del cliente se representa una sola vez (por la factura o
// por la remisión, no ambas). Escanea TODO el histórico del tenant.
// ─────────────────────────────────────────────────────────────────────────────
async function getCxcIntegrity({ tenantId }) {
  const { rows: dbl } = await query(`
    SELECT dn.document_number AS remision,
           bp.name AS cliente,
           ar.amount_total::numeric            AS monto,
           (ar.amount_total - ar.amount_paid)::numeric AS saldo,
           ar.status AS cxc_status,
           iv.document_number AS factura
      FROM accounts_receivable ar
      JOIN delivery_notes dn     ON dn.id = ar.document_id
      JOIN business_partners bp  ON bp.id = dn.partner_id
      LEFT JOIN LATERAL (
        SELECT inv.document_number
          FROM invoices inv
         WHERE inv.status = 'stamped'
           AND ( inv.delivery_note_id = dn.id
                 OR EXISTS (SELECT 1 FROM invoice_remissions ir
                             WHERE ir.invoice_id = inv.id AND ir.delivery_note_id = dn.id)
                 OR ( inv.delivery_note_id IS NULL
                      AND NOT EXISTS (SELECT 1 FROM invoice_remissions ir2 WHERE ir2.invoice_id = inv.id)
                      AND EXISTS (SELECT 1 FROM invoice_lines il
                                    JOIN delivery_note_lines dnl ON dnl.sales_order_line_id = il.sales_order_line_id
                                   WHERE il.invoice_id = inv.id AND dnl.delivery_note_id = dn.id) ) )
         ORDER BY inv.stamp_date DESC NULLS LAST
         LIMIT 1
      ) iv ON true
     WHERE ar.tenant_id = $1
       AND ar.document_type = 'remission'
       AND ar.status <> 'cancelled'
       AND iv.document_number IS NOT NULL
     ORDER BY ar.amount_total DESC
  `, [tenantId])

  // Integridad inversa: facturas de ingreso timbradas SIN su cuenta por cobrar.
  const { rows: noar } = await query(`
    SELECT COUNT(*)::int AS n
      FROM invoices inv
     WHERE inv.tenant_id = $1 AND inv.cfdi_type = 'I' AND inv.status = 'stamped'
       AND NOT EXISTS (
         SELECT 1 FROM accounts_receivable ar
          WHERE ar.tenant_id = $1 AND ar.document_type = 'invoice' AND ar.document_id = inv.id)
  `, [tenantId])

  const doubleCounted = dbl.map(r => ({
    remision: r.remision,
    cliente:  r.cliente,
    factura:  r.factura,
    cxc_status: r.cxc_status,
    monto: parseFloat(r.monto) || 0,
    saldo: parseFloat(r.saldo) || 0,
  }))

  return {
    doubleCounted,
    doubleCountedCount: doubleCounted.length,
    doubleCountedSaldo: doubleCounted.reduce((s, r) => s + r.saldo, 0),
    invoicesWithoutAr: noar[0].n,
  }
}

module.exports = { getSalesReport, getSalesDetail, getSalesReconciliation, getCxcIntegrity }
