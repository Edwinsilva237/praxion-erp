'use strict'

// Snapshot financiero en tiempo real del mes en curso. Devuelve cifras
// agregadas para mostrar en el Dashboard.
//
// Tres bloques:
//   - sales:     ventas facturadas vs sin factura (remisiones no facturadas)
//   - iva:       IVA trasladado (de ventas) vs acreditable (de compras) vs neto
//   - period:    metadatos del mes calculado

const { query } = require('../../db')

/**
 * @param {object} params
 * @param {string} params.tenantId
 * @param {string} [params.month]   - 'YYYY-MM'. Default: mes en curso.
 * @returns {Promise<object>}
 */
async function getFinancialSnapshot({ tenantId, month }) {
  const { from, to, label } = monthRange(month)

  const [sales, iva] = await Promise.all([
    getSalesSnapshot(tenantId, from, to),
    getIvaSnapshot(tenantId, from, to),
  ])

  return {
    period: { month: label, from, to },
    sales,
    iva,
    generated_at: new Date().toISOString(),
  }
}

// ─────────────────────────────────────────────────────────────────────────────

async function getSalesSnapshot(tenantId, from, to) {
  // FACTURADO: facturas timbradas del mes (vigentes, no canceladas). Se desglosa
  // el IVA: subtotal (sin IVA) + IVA = total. El subtotal en MXN se prorratea
  // (robusto a moneda y retenciones): subtotal_mxn = total_mxn × subtotal/total.
  const { rows: invRows } = await query(`
    SELECT
      COALESCE(SUM(total_mxn), 0)::numeric AS total_invoiced,
      COALESCE(SUM(total_mxn * subtotal / NULLIF(total, 0)), 0)::numeric AS subtotal_invoiced,
      COALESCE(SUM(total_mxn - total_mxn * subtotal / NULLIF(total, 0)), 0)::numeric AS iva_invoiced,
      COUNT(*)::int AS count_invoiced
    FROM invoices
    WHERE tenant_id = $1
      AND cfdi_type = 'I'
      AND status = 'stamped'
      AND stamp_date >= $2 AND stamp_date < $3
  `, [tenantId, from, to])

  // SIN FACTURAR: remisiones entregadas en el mes que NO terminaron en
  // factura timbrada. Evita doble conteo de las TRES formas en que una remisión
  // puede quedar facturada:
  //   1) Factura INDIVIDUAL → inv.delivery_note_id apunta a la remisión.
  //   2) Factura CONSOLIDADA (varias remisiones en una) → delivery_note_id NULL y
  //      la liga vive en invoice_remissions (mig 190).
  //   3) Venta ANTICIPADA: el pedido se factura DIRECTO (delivery_note_id NULL, NO
  //      consolidada) y DESPUÉS se entregan remisiones; la liga es por
  //      sales_order_line_id (la factura cubre la línea del pedido). Sin esta 3ª
  //      rama, la remisión de una venta anticipada se contaba en "sin factura"
  //      ADEMÁS de su factura → doble conteo (mismo criterio que listDeliveryNotes).
  const { rows: dnRows } = await query(`
    SELECT
      COALESCE(SUM(dn.total_mxn), 0)::numeric AS total_uninvoiced,
      COUNT(*)::int AS count_uninvoiced
    FROM delivery_notes dn
    WHERE dn.tenant_id = $1
      AND dn.status IN ('delivered','partially_delivered','issued','sent_by_email')
      AND dn.delivered_at >= $2 AND dn.delivered_at < $3
      AND NOT EXISTS (
        SELECT 1 FROM invoices inv
         WHERE inv.tenant_id = $1
           AND inv.delivery_note_id = dn.id
           AND inv.status = 'stamped'
      )
      AND NOT EXISTS (
        SELECT 1 FROM invoice_remissions ir
          JOIN invoices inv ON inv.id = ir.invoice_id
         WHERE ir.delivery_note_id = dn.id
           AND inv.status = 'stamped'
      )
      AND NOT EXISTS (
        SELECT 1 FROM invoices inv
          JOIN invoice_lines il        ON il.invoice_id = inv.id
          JOIN delivery_note_lines dnl ON dnl.sales_order_line_id = il.sales_order_line_id
         WHERE dnl.delivery_note_id = dn.id
           AND inv.status = 'stamped'
           AND inv.delivery_note_id IS NULL
           AND NOT EXISTS (SELECT 1 FROM invoice_remissions ir2 WHERE ir2.invoice_id = inv.id)
      )
  `, [tenantId, from, to])

  const invoiced          = parseFloat(invRows[0].total_invoiced)    || 0
  const invoiced_subtotal = parseFloat(invRows[0].subtotal_invoiced) || 0
  const invoiced_iva      = parseFloat(invRows[0].iva_invoiced)      || 0
  const uninvoiced        = parseFloat(dnRows[0].total_uninvoiced)   || 0
  const total      = invoiced + uninvoiced

  return {
    total,
    invoiced,
    invoiced_subtotal,   // facturado SIN IVA
    invoiced_iva,        // IVA del facturado (desglosado)
    uninvoiced,
    count_invoiced:   invRows[0].count_invoiced,
    count_uninvoiced: dnRows[0].count_uninvoiced,
    // Porcentajes para visualización (evitar divide-by-zero)
    pct_invoiced:   total > 0 ? (invoiced   / total) * 100 : 0,
    pct_uninvoiced: total > 0 ? (uninvoiced / total) * 100 : 0,
  }
}

async function getIvaSnapshot(tenantId, from, to) {
  // AL COBRO (Ley del IVA art. 1-B): el IVA se causa cuando se COBRA / se PAGA,
  // NO al facturar. Por eso el "IVA cobrado/pagado del mes" se calcula sobre los
  // PAGOS del mes, prorrateando la porción de IVA de cada pago según la proporción
  // IVA/total de su factura. (Antes se sumaba el IVA de las facturas EMITIDAS, lo
  // que inflaba el "cobrado" cuando había facturas timbradas aún no pagadas.)
  //
  // Bonus: las notas de crédito y los descuentos quedan considerados solos —
  // simplemente se cobra menos, y el prorrateo del pago real lo refleja.

  // IVA COBRADO: porción de IVA de los cobros recibidos este mes, sobre facturas de
  // ingreso timbradas. Cada cobro (ar_payments) apunta a UN AR vía ar_id.
  const { rows: trRows } = await query(`
    SELECT COALESCE(SUM(ap.amount * (inv.tax_transferred / NULLIF(inv.total, 0))), 0)::numeric AS iva_cobrado
      FROM ar_payments ap
      JOIN accounts_receivable ar ON ar.id = ap.ar_id
      JOIN invoices inv           ON inv.id = ar.document_id
     WHERE ap.tenant_id = $1
       AND ar.document_type = 'invoice'
       AND inv.cfdi_type = 'I'
       AND inv.status = 'stamped'
       AND ap.payment_date >= $2 AND ap.payment_date < $3
  `, [tenantId, from, to])

  // IVA PAGADO: porción de IVA de los pagos a proveedor aplicados este mes, sobre
  // CFDI recibidos (con UUID SAT). Un pago puede aplicarse a varias facturas
  // (supplier_payment_applications.amount_applied por factura).
  const { rows: crRows } = await query(`
    SELECT COALESCE(SUM(spa.amount_applied * (si.tax / NULLIF(si.total, 0))), 0)::numeric AS iva_pagado
      FROM supplier_payment_applications spa
      JOIN supplier_payments sp ON sp.id = spa.supplier_payment_id
      JOIN supplier_invoices  si ON si.id = spa.supplier_invoice_id
     WHERE sp.tenant_id = $1
       AND si.uuid_sat IS NOT NULL
       AND si.status <> 'cancelled'
       AND sp.method <> 'credit_note'
       AND sp.payment_date >= $2 AND sp.payment_date < $3
  `, [tenantId, from, to])

  const transferred = parseFloat(trRows[0].iva_cobrado) || 0
  const creditable  = parseFloat(crRows[0].iva_pagado)  || 0
  const net         = transferred - creditable

  return {
    transferred,
    creditable,
    withheld: 0,  // en base al cobro la retención se realiza al cobrar; no se modela aquí
    net,
    // Bandera útil para el frontend
    direction: net > 0 ? 'to_pay' : net < 0 ? 'in_favor' : 'balanced',
  }
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Convierte 'YYYY-MM' (o vacío para mes en curso) en { from, to } donde
 * `to` es el día 1 del mes siguiente (exclusivo). Todas las fechas en UTC.
 */
function monthRange(month) {
  const now = new Date()
  let year  = now.getUTCFullYear()
  let mIdx  = now.getUTCMonth()
  if (typeof month === 'string' && /^\d{4}-\d{2}$/.test(month)) {
    const [y, m] = month.split('-').map(Number)
    year = y
    mIdx = m - 1
  }
  const from  = new Date(Date.UTC(year, mIdx, 1))
  const to    = new Date(Date.UTC(year, mIdx + 1, 1))
  const fmt = (d) => d.toISOString().slice(0, 10)
  return { from: fmt(from), to: fmt(to), label: `${year}-${String(mIdx + 1).padStart(2, '0')}` }
}

module.exports = { getFinancialSnapshot }
