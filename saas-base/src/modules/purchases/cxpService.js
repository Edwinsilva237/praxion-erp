'use strict'

const { query } = require('../../db')

/**
 * Listado de Cuentas por Pagar (CXP) — espejo de cxcService.listCXC pero del
 * lado del proveedor. Devuelve filas centradas en accounts_payable con datos
 * del proveedor y del documento origen (supplier_invoices).
 */
async function listCXP({ tenantId, status, partnerId, from, to, page = 1, limit = 50 }) {
  const offset = (page - 1) * limit
  const params = [tenantId]
  const filters = []

  if (status) {
    params.push(status); filters.push(`ap.status = $${params.length}`)
  } else {
    filters.push(`ap.status <> 'cancelled'`)
  }
  if (partnerId) { params.push(partnerId); filters.push(`ap.partner_id = $${params.length}`) }
  if (from)      { params.push(from);      filters.push(`ap.issue_date >= $${params.length}`) }
  if (to)        { params.push(to);        filters.push(`ap.issue_date <= $${params.length}`) }

  const where = filters.length ? `AND ${filters.join(' AND ')}` : ''
  params.push(limit, offset)

  const { rows } = await query(
    `SELECT ap.id, ap.document_type, ap.document_number,
            ap.issue_date, ap.due_date, ap.status,
            ap.currency, ap.exchange_rate,
            ap.amount_total, ap.amount_paid, ap.amount_pending,
            bp.name AS partner_name, bp.rfc AS partner_rfc,
            si.uuid_sat, si.type AS invoice_type, si.status AS invoice_status,
            si.reconciliation_status,
            COALESCE((
              SELECT COUNT(*) FROM attachments a
               WHERE a.tenant_id = ap.tenant_id
                 AND a.entity_type = 'supplier_invoice'
                 AND a.entity_id   = ap.document_id
            ), 0)::int AS attachment_count,
            COALESCE((
              SELECT SUM(amount_available) FROM ap_advances apa
               WHERE apa.tenant_id  = ap.tenant_id
                 AND apa.partner_id = ap.partner_id
                 AND apa.amount_applied < apa.amount
            ), 0)::numeric AS partner_advance_available,
            CASE WHEN ap.due_date < CURRENT_DATE AND ap.status NOT IN ('paid','cancelled')
              THEN true ELSE false END AS is_overdue
     FROM accounts_payable ap
     JOIN business_partners bp     ON bp.id = ap.partner_id
     LEFT JOIN supplier_invoices si ON si.id = ap.document_id
     WHERE ap.tenant_id = $1 ${where}
     ORDER BY ap.due_date ASC, ap.issue_date ASC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  )

  const { rows: countRows } = await query(
    `SELECT COUNT(*) FROM accounts_payable ap WHERE ap.tenant_id = $1 ${where}`,
    params.slice(0, params.length - 2)
  )

  return { data: rows, total: parseInt(countRows[0].count, 10), page, limit }
}

/**
 * Detalle de un CXP: AP + datos del proveedor + documento origen + pagos aplicados.
 */
async function getCXP({ tenantId, apId }) {
  const { rows } = await query(
    `SELECT ap.*,
            bp.name AS partner_name, bp.rfc AS partner_rfc,
            bp.credit_days, bp.credit_type,
            bp.supplier_credit_days, bp.supplier_bank_name,
            bp.supplier_account_holder, bp.supplier_account_number,
            bp.supplier_clabe, bp.supplier_swift,
            CASE WHEN ap.due_date < CURRENT_DATE AND ap.status NOT IN ('paid','cancelled')
              THEN true ELSE false END AS is_overdue
       FROM accounts_payable ap
       JOIN business_partners bp ON bp.id = ap.partner_id
      WHERE ap.id = $1 AND ap.tenant_id = $2`,
    [apId, tenantId]
  )
  if (!rows.length) return null
  const ap = rows[0]

  // Documento origen (factura/remisión de proveedor)
  let sourceDoc = null
  const { rows: invRows } = await query(
    `SELECT si.id, si.invoice_number, si.type, si.status,
            si.uuid_sat, si.serie, si.folio, si.rfc_emisor,
            si.subtotal, si.tax, si.total, si.total_mxn,
            si.invoice_date, si.due_date, si.received_date,
            si.reconciliation_status, si.reconciliation_diff,
            si.notes,
            po.order_number AS purchase_order_number,
            sr.receipt_number AS receipt_number, sr.received_date AS receipt_date
       FROM supplier_invoices si
       LEFT JOIN purchase_orders po   ON po.id = si.purchase_order_id
       LEFT JOIN supplier_receipts sr ON sr.id = si.supplier_receipt_id
      WHERE si.id = $1 AND si.tenant_id = $2`,
    [ap.document_id, tenantId]
  )
  sourceDoc = invRows[0] || null

  // Pagos aplicados al AP — vía supplier_payments + supplier_payment_applications
  const { rows: payments } = await query(
    `SELECT sp.id, sp.payment_date, sp.method AS payment_method, sp.reference,
            sp.currency, sp.amount_mxn,
            spa.amount_applied AS amount,
            sp.notes, sp.created_at,
            sp.bank_account_id,
            ba.bank_name      AS bank_name,
            ba.alias          AS bank_alias,
            ba.account_number AS bank_account_number,
            u.full_name AS created_by_name
       FROM supplier_payment_applications spa
       JOIN supplier_payments sp ON sp.id = spa.supplier_payment_id
       LEFT JOIN users u         ON u.id = sp.created_by
       LEFT JOIN bank_accounts ba ON ba.id = sp.bank_account_id
       JOIN accounts_payable ap2 ON ap2.document_id = spa.supplier_invoice_id
      WHERE ap2.id = $1
      ORDER BY sp.payment_date ASC, sp.created_at ASC`,
    [apId]
  )

  // Evidencias (attachments) ligadas a la factura del proveedor.
  let attachments = []
  if (ap.document_id) {
    const { rows: atRows } = await query(
      `SELECT a.id, a.filename, a.mime_type, a.file_size_bytes, a.description,
              a.created_at, u.full_name AS uploaded_by_name
         FROM attachments a
         LEFT JOIN users u ON u.id = a.uploaded_by
        WHERE a.tenant_id = $1
          AND a.entity_type = 'supplier_invoice'
          AND a.entity_id   = $2
        ORDER BY a.created_at DESC`,
      [tenantId, ap.document_id]
    )
    attachments = atRows
  }

  // Anticipos disponibles del proveedor (con saldo > 0).
  const { rows: advances } = await query(
    `SELECT id, amount, amount_applied, amount_available, currency,
            payment_method, reference, payment_date, notes, created_at
       FROM ap_advances
      WHERE tenant_id = $1 AND partner_id = $2 AND amount_applied < amount
      ORDER BY payment_date ASC, created_at ASC`,
    [tenantId, ap.partner_id]
  )

  return { ...ap, sourceDoc, payments, attachments, availableAdvances: advances }
}

/**
 * Historial de PAGOS EMITIDOS (a proveedor): lista cronológica de supplier_payments,
 * un registro por pago, con los documentos a los que se aplicó (agregados).
 */
async function listPayments({ tenantId, partnerId, from, to, method, page = 1, limit = 50 }) {
  const offset = (page - 1) * limit
  const params = [tenantId]
  const filters = []
  if (partnerId) { params.push(partnerId); filters.push(`sp.partner_id = $${params.length}`) }
  if (from)      { params.push(from);      filters.push(`sp.payment_date >= $${params.length}`) }
  if (to)        { params.push(to);        filters.push(`sp.payment_date <= $${params.length}`) }
  if (method)    { params.push(method);    filters.push(`sp.method = $${params.length}`) }
  const where = filters.length ? `AND ${filters.join(' AND ')}` : ''
  params.push(limit, offset)

  const { rows } = await query(
    `SELECT sp.id, sp.payment_date, sp.method AS payment_method, sp.reference,
            sp.amount, sp.amount_mxn, sp.currency, sp.notes, sp.created_at,
            sp.generic_supplier,
            bp.id AS partner_id, bp.name AS partner_name, bp.tax_name AS partner_tax_name,
            ba.bank_name, ba.alias AS bank_alias,
            u.full_name AS created_by_name,
            (SELECT string_agg(DISTINCT si.invoice_number, ', ')
               FROM supplier_payment_applications spa
               JOIN supplier_invoices si ON si.id = spa.supplier_invoice_id
              WHERE spa.supplier_payment_id = sp.id) AS applied_docs
       FROM supplier_payments sp
       LEFT JOIN business_partners bp ON bp.id = sp.partner_id
       LEFT JOIN bank_accounts ba     ON ba.id = sp.bank_account_id
       LEFT JOIN users u              ON u.id  = sp.created_by
      WHERE sp.tenant_id = $1 ${where}
      ORDER BY sp.payment_date DESC, sp.created_at DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  )

  const { rows: countRows } = await query(
    `SELECT COUNT(*) AS n, COALESCE(SUM(sp.amount_mxn),0) AS total
       FROM supplier_payments sp
      WHERE sp.tenant_id = $1 ${where}`,
    params.slice(0, params.length - 2)
  )

  return {
    data: rows,
    total: parseInt(countRows[0].n, 10),
    totalAmount: parseFloat(countRows[0].total) || 0,
    page, limit,
  }
}

module.exports = { listCXP, getCXP, listPayments }
