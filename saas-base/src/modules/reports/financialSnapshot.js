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
  // FACTURADO: facturas timbradas del mes (vigentes, no canceladas).
  const { rows: invRows } = await query(`
    SELECT
      COALESCE(SUM(total_mxn), 0)::numeric AS total_invoiced,
      COUNT(*)::int AS count_invoiced
    FROM invoices
    WHERE tenant_id = $1
      AND cfdi_type = 'I'
      AND status = 'stamped'
      AND stamp_date >= $2 AND stamp_date < $3
  `, [tenantId, from, to])

  // SIN FACTURAR: remisiones entregadas en el mes que NO terminaron en
  // factura timbrada. Evita doble conteo: si la remisión generó factura
  // (delivery_note_id apunta a ella) ya cuenta en "invoiced".
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
  `, [tenantId, from, to])

  const invoiced   = parseFloat(invRows[0].total_invoiced)   || 0
  const uninvoiced = parseFloat(dnRows[0].total_uninvoiced) || 0
  const total      = invoiced + uninvoiced

  return {
    total,
    invoiced,
    uninvoiced,
    count_invoiced:   invRows[0].count_invoiced,
    count_uninvoiced: dnRows[0].count_uninvoiced,
    // Porcentajes para visualización (evitar divide-by-zero)
    pct_invoiced:   total > 0 ? (invoiced   / total) * 100 : 0,
    pct_uninvoiced: total > 0 ? (uninvoiced / total) * 100 : 0,
  }
}

async function getIvaSnapshot(tenantId, from, to) {
  // IVA TRASLADADO: cobrado en facturas timbradas del mes (vigentes).
  const { rows: trRows } = await query(`
    SELECT
      COALESCE(SUM(tax_transferred), 0)::numeric AS iva_transferred,
      COALESCE(SUM(tax_withheld),    0)::numeric AS iva_withheld
    FROM invoices
    WHERE tenant_id = $1
      AND cfdi_type = 'I'
      AND status = 'stamped'
      AND stamp_date >= $2 AND stamp_date < $3
  `, [tenantId, from, to])

  // IVA ACREDITABLE: pagado en CFDI recibidos del mes (con UUID SAT real,
  // excluye registros internos sin factura fiscal).
  const { rows: crRows } = await query(`
    SELECT COALESCE(SUM(tax), 0)::numeric AS iva_creditable
    FROM supplier_invoices
    WHERE tenant_id = $1
      AND uuid_sat IS NOT NULL
      AND status != 'cancelled'
      AND invoice_date >= $2 AND invoice_date < $3
  `, [tenantId, from, to])

  const transferred = parseFloat(trRows[0].iva_transferred) || 0
  const withheld    = parseFloat(trRows[0].iva_withheld)    || 0
  const creditable  = parseFloat(crRows[0].iva_creditable)  || 0
  const net         = transferred - creditable - withheld

  return {
    transferred,
    creditable,
    withheld,
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
