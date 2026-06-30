'use strict'

// Reporte de ventas con múltiples vistas (cliente, producto, metros, utilidad).
// Base de datos para análisis comercial. Todas las cifras en MXN.
//
// Costos: se calculan a partir de inventory_movements (que ya graba unit_cost
// en cada entrada de producción o compra). Usamos un promedio ponderado de
// los últimos 60 días — si el producto no tuvo entradas en ese periodo,
// el costo queda NULL y la utilidad como "n/d".

const { query } = require('../../db')

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

  // Costos: primero traemos los IDs de producto que aparecieron en el periodo
  // para optimizar el cálculo (no calcular costos de productos que no se vendieron).
  const productIdsInPeriod = await getProductIdsInPeriod(tenantId, from, to)
  const costMap = await getProductCostMap(tenantId, productIdsInPeriod)

  const [
    byCustomer,
    byProduct,
    topCustomers,
    negativeMargins,
    currentTotals,
    previousTotals,
    weeklyTrend,
  ] = await Promise.all([
    getByCustomer(tenantId, from, to, costMap),
    getByProduct(tenantId, from, to, costMap),
    getTopCustomers(tenantId, from, to),
    getNegativeMargins(tenantId, from, to, costMap),
    getPeriodTotals(tenantId, from, to, costMap),
    getPeriodTotals(tenantId, prev.from, prev.to, costMap),
    getWeeklyTrend(tenantId, from, to),
  ])

  return {
    period: { from, to, previous: prev },
    cost_window_days: COST_WINDOW_DAYS,
    totals_current:   currentTotals,
    totals_previous:  previousTotals,
    by_customer:      byCustomer,
    by_product:       byProduct,
    top_customers:    topCustomers,
    negative_margins: negativeMargins,
    weekly_trend:     weeklyTrend,
    generated_at:     new Date().toISOString(),
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Costos
// ─────────────────────────────────────────────────────────────────────────────

async function getProductIdsInPeriod(tenantId, from, to) {
  const { rows } = await query(`
    SELECT DISTINCT dnl.product_id
      FROM delivery_note_lines dnl
      JOIN delivery_notes dn ON dn.id = dnl.delivery_note_id
     WHERE dn.tenant_id = $1
       AND dn.status IN ('delivered','partially_delivered','issued','sent_by_email')
       AND COALESCE(dn.delivered_at, dn.issue_date) >= $2
       AND COALESCE(dn.delivered_at, dn.issue_date) <  $3
  `, [tenantId, from, to])
  return rows.map(r => r.product_id)
}

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
// Vistas
// ─────────────────────────────────────────────────────────────────────────────

async function getByCustomer(tenantId, from, to, costMap) {
  // Una línea de remisión cuenta como "facturada" si tiene una invoice_line
  // que la referencia (via delivery_note_line_id) y la factura está timbrada.
  const { rows } = await query(`
    SELECT bp.id AS partner_id, bp.name AS partner_name, bp.tax_name AS partner_legal_name,
           bp.rfc AS partner_rfc,
           SUM(dnl.subtotal)::numeric AS revenue,
           SUM(CASE WHEN ${LINE_INVOICED} THEN dnl.subtotal ELSE 0 END)::numeric AS invoiced_revenue,
           SUM(CASE WHEN NOT (${LINE_INVOICED}) THEN dnl.subtotal ELSE 0 END)::numeric AS uninvoiced_revenue,
           COUNT(DISTINCT dn.id)::int AS deliveries,
           json_agg(json_build_object(
             'product_id', dnl.product_id,
             'quantity',   dnl.quantity_delivered,
             'subtotal',   dnl.subtotal
           )) AS lines_raw
      FROM delivery_note_lines dnl
      JOIN delivery_notes dn ON dn.id = dnl.delivery_note_id
      JOIN business_partners bp ON bp.id = dn.partner_id
     WHERE dn.tenant_id = $1
       AND dn.status IN ('delivered','partially_delivered','issued','sent_by_email')
       AND COALESCE(dn.delivered_at, dn.issue_date) >= $2
       AND COALESCE(dn.delivered_at, dn.issue_date) <  $3
     GROUP BY bp.id, bp.name, bp.tax_name, bp.rfc
     ORDER BY revenue DESC
  `, [tenantId, from, to])

  const grandTotal = rows.reduce((s, r) => s + (parseFloat(r.revenue) || 0), 0)

  return rows.map(r => {
    const revenue = parseFloat(r.revenue) || 0
    let cost = 0
    let costComplete = true
    for (const l of r.lines_raw || []) {
      const c = costMap.get(l.product_id)
      if (c) cost += (parseFloat(l.quantity) || 0) * c.avg_cost
      else   costComplete = false
    }
    const margin = revenue - cost
    const marginPct = revenue > 0 ? (margin / revenue) * 100 : 0
    return {
      partner_id:         r.partner_id,
      partner_name:       r.partner_name,
      partner_legal_name: r.partner_legal_name,
      partner_rfc:        r.partner_rfc,
      revenue,
      invoiced_revenue:   parseFloat(r.invoiced_revenue)   || 0,
      uninvoiced_revenue: parseFloat(r.uninvoiced_revenue) || 0,
      pct_of_total:       grandTotal > 0 ? (revenue / grandTotal) * 100 : 0,
      deliveries:         r.deliveries,
      avg_ticket:         r.deliveries > 0 ? revenue / r.deliveries : 0,
      estimated_cost:     cost,
      estimated_margin:   margin,
      margin_pct:         marginPct,
      cost_complete:      costComplete,
    }
  })
}

async function getByProduct(tenantId, from, to, costMap) {
  const { rows } = await query(`
    SELECT p.id AS product_id, p.sku, p.name, p.type, p.length_mm,
           p.base_unit, p.sale_unit,
           SUM(dnl.quantity_delivered)::numeric AS qty_sold,
           SUM(dnl.quantity_base)::numeric      AS qty_base,
           SUM(dnl.subtotal)::numeric           AS revenue,
           SUM(CASE WHEN ${LINE_INVOICED} THEN dnl.subtotal ELSE 0 END)::numeric AS invoiced_revenue,
           SUM(CASE WHEN NOT (${LINE_INVOICED}) THEN dnl.subtotal ELSE 0 END)::numeric AS uninvoiced_revenue,
           AVG(dnl.unit_price)::numeric         AS avg_price,
           COUNT(*)::int                         AS line_count
      FROM delivery_note_lines dnl
      JOIN delivery_notes dn ON dn.id = dnl.delivery_note_id
      JOIN products p        ON p.id = dnl.product_id
     WHERE dn.tenant_id = $1
       AND dn.status IN ('delivered','partially_delivered','issued','sent_by_email')
       AND COALESCE(dn.delivered_at, dn.issue_date) >= $2
       AND COALESCE(dn.delivered_at, dn.issue_date) <  $3
     GROUP BY p.id, p.sku, p.name, p.type, p.length_mm, p.base_unit, p.sale_unit
     ORDER BY revenue DESC
  `, [tenantId, from, to])

  const grandTotal = rows.reduce((s, r) => s + (parseFloat(r.revenue) || 0), 0)

  return rows.map(r => {
    const c = costMap.get(r.product_id)
    const revenue = parseFloat(r.revenue) || 0
    const qtyBase = parseFloat(r.qty_base) || 0
    const cost    = c ? c.avg_cost * qtyBase : null
    const margin  = (cost !== null) ? revenue - cost : null
    const marginPct = (margin !== null && revenue > 0) ? (margin / revenue) * 100 : null

    // Metros lineales: aplica a cualquier producto con length_mm definido en el catálogo.
    // (Antes solo se calculaba para type='corner_protector'; ahora cualquier producto
    // con longitud capturada — esquineros, tubos, perfiles, etc.)
    const lengthMm = r.length_mm ? parseFloat(r.length_mm) : null
    const meters = (lengthMm && lengthMm > 0)
      ? (qtyBase * lengthMm) / 1000
      : null
    const pricePerMeter = (meters && meters > 0) ? revenue / meters : null

    // Flag para la UI: producto que parece ser de tipo lineal (legacy corner_protector
    // o tiene "lineal" en el sale_unit) pero le falta length_mm en catálogo.
    const looksLinear = r.type === 'corner_protector'
    const missingLength = looksLinear && !lengthMm

    return {
      product_id:   r.product_id,
      sku:          r.sku,
      name:         r.name,
      type:         r.type,
      length_mm:    lengthMm,
      sale_unit:    r.sale_unit,
      base_unit:    r.base_unit,
      qty_sold:     parseFloat(r.qty_sold) || 0,
      qty_base:     qtyBase,
      revenue,
      invoiced_revenue:   parseFloat(r.invoiced_revenue)   || 0,
      uninvoiced_revenue: parseFloat(r.uninvoiced_revenue) || 0,
      pct_of_total:       grandTotal > 0 ? (revenue / grandTotal) * 100 : 0,
      avg_price:    parseFloat(r.avg_price) || 0,
      unit_cost:    c ? c.avg_cost : null,
      estimated_cost:   cost,
      estimated_margin: margin,
      margin_pct:       marginPct,
      meters,
      price_per_meter:  pricePerMeter,
      missing_length:   missingLength,
    }
  })
}

async function getTopCustomers(tenantId, from, to, limit = 5) {
  const { rows } = await query(`
    SELECT bp.id, bp.name, bp.tax_name,
           SUM(dnl.subtotal)::numeric AS revenue,
           COUNT(DISTINCT dn.id)::int AS deliveries
      FROM delivery_note_lines dnl
      JOIN delivery_notes dn    ON dn.id = dnl.delivery_note_id
      JOIN business_partners bp ON bp.id = dn.partner_id
     WHERE dn.tenant_id = $1
       AND dn.status IN ('delivered','partially_delivered','issued','sent_by_email')
       AND COALESCE(dn.delivered_at, dn.issue_date) >= $2
       AND COALESCE(dn.delivered_at, dn.issue_date) <  $3
     GROUP BY bp.id, bp.name, bp.tax_name
     ORDER BY revenue DESC
     LIMIT $4
  `, [tenantId, from, to, limit])

  return rows.map(r => ({
    partner_id:   r.id,
    partner_name: r.name,
    partner_legal_name: r.tax_name,
    revenue:      parseFloat(r.revenue) || 0,
    deliveries:   r.deliveries,
  }))
}

async function getNegativeMargins(tenantId, from, to, costMap) {
  // Buscar productos del periodo cuyo margen unitario es negativo o cuyo
  // precio promedio está por debajo del costo.
  const { rows } = await query(`
    SELECT p.id AS product_id, p.sku, p.name, p.type,
           AVG(dnl.unit_price)::numeric AS avg_price,
           SUM(dnl.quantity_base)::numeric AS qty_base,
           SUM(dnl.subtotal)::numeric AS revenue
      FROM delivery_note_lines dnl
      JOIN delivery_notes dn ON dn.id = dnl.delivery_note_id
      JOIN products p        ON p.id = dnl.product_id
     WHERE dn.tenant_id = $1
       AND dn.status IN ('delivered','partially_delivered','issued','sent_by_email')
       AND COALESCE(dn.delivered_at, dn.issue_date) >= $2
       AND COALESCE(dn.delivered_at, dn.issue_date) <  $3
     GROUP BY p.id, p.sku, p.name, p.type
  `, [tenantId, from, to])

  const alerts = []
  for (const r of rows) {
    const c = costMap.get(r.product_id)
    if (!c) continue
    const revenue = parseFloat(r.revenue) || 0
    const qtyBase = parseFloat(r.qty_base) || 0
    const cost = c.avg_cost * qtyBase
    const margin = revenue - cost
    if (margin < 0) {
      alerts.push({
        product_id: r.product_id,
        sku:        r.sku,
        name:       r.name,
        type:       r.type,
        avg_price:  parseFloat(r.avg_price) || 0,
        unit_cost:  c.avg_cost,
        qty_base:   qtyBase,
        revenue,
        cost,
        loss:       Math.abs(margin),
      })
    }
  }
  // Ordenar por mayor pérdida.
  alerts.sort((a, b) => b.loss - a.loss)
  return alerts
}

async function getPeriodTotals(tenantId, from, to, costMap) {
  const { rows } = await query(`
    SELECT
      COALESCE(SUM(dnl.subtotal), 0)::numeric AS revenue,
      COUNT(DISTINCT dn.id)::int             AS deliveries,
      COUNT(DISTINCT dn.partner_id)::int     AS customers,
      json_agg(json_build_object(
        'product_id', dnl.product_id,
        'qty_base',   dnl.quantity_base
      )) AS lines_raw
      FROM delivery_note_lines dnl
      JOIN delivery_notes dn ON dn.id = dnl.delivery_note_id
     WHERE dn.tenant_id = $1
       AND dn.status IN ('delivered','partially_delivered','issued','sent_by_email')
       AND COALESCE(dn.delivered_at, dn.issue_date) >= $2
       AND COALESCE(dn.delivered_at, dn.issue_date) <  $3
  `, [tenantId, from, to])

  const r = rows[0]
  const revenue = parseFloat(r.revenue) || 0
  let cost = 0
  let costComplete = true
  for (const l of r.lines_raw || []) {
    if (!l.product_id) continue
    const c = costMap.get(l.product_id)
    if (c) cost += (parseFloat(l.qty_base) || 0) * c.avg_cost
    else   costComplete = false
  }
  const margin = revenue - cost
  return {
    revenue,
    estimated_cost:    cost,
    estimated_margin:  margin,
    margin_pct:        revenue > 0 ? (margin / revenue) * 100 : 0,
    deliveries:        r.deliveries,
    customers:         r.customers,
    cost_complete:     costComplete,
  }
}

async function getWeeklyTrend(tenantId, from, to) {
  // Agrupamos por ISO week. PG: date_trunc('week', ...) devuelve el lunes.
  const { rows } = await query(`
    SELECT
      date_trunc('week', COALESCE(dn.delivered_at, dn.issue_date))::date AS week_start,
      COALESCE(SUM(dnl.subtotal), 0)::numeric AS revenue,
      COUNT(DISTINCT dn.id)::int              AS deliveries
      FROM delivery_note_lines dnl
      JOIN delivery_notes dn ON dn.id = dnl.delivery_note_id
     WHERE dn.tenant_id = $1
       AND dn.status IN ('delivered','partially_delivered','issued','sent_by_email')
       AND COALESCE(dn.delivered_at, dn.issue_date) >= $2
       AND COALESCE(dn.delivered_at, dn.issue_date) <  $3
     GROUP BY 1
     ORDER BY 1
  `, [tenantId, from, to])

  return rows.map(r => ({
    week_start: r.week_start,
    revenue:    parseFloat(r.revenue) || 0,
    deliveries: r.deliveries,
  }))
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

module.exports = { getSalesReport, getSalesDetail, getSalesReconciliation }
