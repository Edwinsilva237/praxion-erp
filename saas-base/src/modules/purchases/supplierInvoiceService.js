'use strict'

const { query, withTransaction } = require('../../db')
const { audit }                  = require('../../utils/audit')
const { getRateForDate }         = require('../exchange-rates/exchangeRateService')

/**
 * Registra una factura o remisión de proveedor y genera CXP automáticamente.
 *
 * @param {object} params
 * @param {string} params.tenantId
 * @param {string} params.supplierId        - ID del business_partner (proveedor)
 * @param {string} params.genericSupplier   - Nombre libre si no está en catálogo
 * @param {string} params.documentType      - 'invoice' | 'remission'
 * @param {string} params.documentNumber    - Número de factura o remisión
 * @param {string} params.uuidSat           - UUID del timbre fiscal (solo facturas)
 * @param {string} params.serie
 * @param {string} params.folio
 * @param {string} params.rfcEmisor
 * @param {string} params.invoiceDate       - Fecha del documento YYYY-MM-DD
 * @param {string} params.currency          - 'MXN' | 'USD'
 * @param {number} params.subtotal
 * @param {number} params.tax
 * @param {number} params.total
 * @param {string} params.supplierReceiptId - Recepción vinculada (opcional)
 * @param {string} params.purchaseOrderId   - OC vinculada (opcional)
 * @param {number} params.creditDays        - Días de crédito para calcular vencimiento
 * @param {string} params.notes
 */
async function registerInvoice({
  tenantId, supplierId, genericSupplier,
  documentType = 'invoice', documentNumber,
  uuidSat, serie, folio, rfcEmisor,
  invoiceDate, currency = 'MXN',
  subtotal, tax, total,
  supplierReceiptId, receiptIds = [],  // acepta uno o varios
  purchaseOrderId,
  creditDays = 0, notes,
  xmlContent = null,
  userId, ipAddress, userAgent,
}) {
  return withTransaction(async (client) => {
    // Validaciones básicas
    if (!documentNumber) throw createError(400, 'documentNumber es requerido.')
    if (!total || total <= 0) throw createError(400, 'total debe ser mayor a cero.')
    if (!supplierId && !genericSupplier) throw createError(400, 'supplierId o genericSupplier es requerido.')

    // Verificar duplicado por UUID SAT
    if (uuidSat) {
      const { rows: dup } = await client.query(
        `SELECT id FROM supplier_invoices WHERE uuid_sat = $1`,
        [uuidSat]
      )
      if (dup.length > 0) throw createError(409, `Ya existe una factura registrada con UUID ${uuidSat}.`)
    }

    // Normalizar lista de recepciones
    const allReceiptIds = [...new Set([
      ...(receiptIds || []),
      ...(supplierReceiptId ? [supplierReceiptId] : []),
    ])].filter(Boolean)

    // Resolver tipo de cambio si es USD
    let exchangeRateId = null
    let exchangeRateValue = 1
    let totalMxn = total
    // Para conciliar contra las recepciones (que son SIN IVA) usamos el SUBTOTAL
    // de la factura, no el total con IVA. Si no viene subtotal, lo derivamos de
    // (total - tax) — para una factura sin IVA, subtotal == total.
    const invoiceSubtotal = subtotal || parseFloat((total - (tax || 0)).toFixed(2))
    let subtotalMxn = invoiceSubtotal
    if (currency === 'USD') {
      const date = invoiceDate || new Date().toISOString().split('T')[0]
      const rate = await getRateForDate({ tenantId, date, currency: 'USD' })
      if (!rate) throw createError(400, 'No hay tipo de cambio disponible para la fecha del documento.')
      exchangeRateId  = rate.id
      exchangeRateValue = parseFloat(rate.rate_mxn)
      totalMxn = parseFloat((total * exchangeRateValue).toFixed(2))
      subtotalMxn = parseFloat((invoiceSubtotal * exchangeRateValue).toFixed(2))
    }

    // Calcular fecha de vencimiento
    const issueDate = invoiceDate || new Date().toISOString().split('T')[0]
    let dueDate = issueDate
    let resolvedCreditDays = creditDays
    if (supplierId && creditDays === 0) {
      const { rows: partner } = await client.query(
        `SELECT credit_days FROM business_partners WHERE id = $1 AND tenant_id = $2`,
        [supplierId, tenantId]
      )
      if (partner.length > 0 && partner[0].credit_days > 0) {
        resolvedCreditDays = partner[0].credit_days
      }
    }
    if (resolvedCreditDays > 0) {
      const due = new Date(issueDate)
      due.setDate(due.getDate() + resolvedCreditDays)
      dueDate = due.toISOString().split('T')[0]
    }

    // Calcular conciliación — suma de totales de recepciones ligadas
    let totalReceipts = 0
    if (allReceiptIds.length > 0) {
      const placeholders = allReceiptIds.map((_, i) => `$${i + 2}`).join(',')
      // El total de una recepción se calcula desde sus líneas
      // (subtotal generated = quantity_received * unit_price).
      const { rows: rcpts } = await client.query(
        `SELECT COALESCE(SUM(srl.subtotal), 0) AS total
           FROM supplier_receipt_lines srl
           JOIN supplier_receipts sr ON sr.id = srl.supplier_receipt_id
          WHERE sr.tenant_id = $1 AND sr.id IN (${placeholders})`,
        [tenantId, ...allReceiptIds]
      )
      totalReceipts = parseFloat(rcpts[0].total || 0)
    }
    // Comparar SIN IVA contra SIN IVA: subtotal de la factura vs subtotal de las recepciones.
    const reconDiff   = parseFloat((subtotalMxn - totalReceipts).toFixed(2))
    const reconStatus = allReceiptIds.length === 0 ? 'pending'
                      : Math.abs(reconDiff) < 0.01  ? 'reconciled'
                      : 'with_diff'

    // Insertar factura
    const { rows: invRows } = await client.query(
      `INSERT INTO supplier_invoices
         (tenant_id, invoice_number, type, status,
          partner_id, generic_supplier,
          supplier_receipt_id, purchase_order_id,
          uuid_sat, xml_uuid, rfc_emisor, serie, folio,
          currency, exchange_rate_id, exchange_rate_value,
          subtotal, tax, total, total_mxn, balance,
          invoice_date, due_date, received_date,
          reconciliation_status, reconciliation_diff,
          xml_content, notes, created_by)
       VALUES ($1,$2,$3,'pending',$4,$5,$6,$7,$8::uuid,$8::varchar,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$18,$19::date,$20::date,$19::date,$21,$22,$23,$24,$25)
       RETURNING *`,
      [tenantId, documentNumber,
       documentType === 'remission' ? 'remission' : 'invoice',
       supplierId || null, genericSupplier || null,
       allReceiptIds[0] || null, purchaseOrderId || null,
       uuidSat || null, rfcEmisor || null, serie || null, folio || null,
       currency, exchangeRateId, currency === 'USD' ? exchangeRateValue : null,
       subtotal || 0, tax || 0, total, totalMxn,
       issueDate, dueDate,
       reconStatus, reconDiff,
       xmlContent || null, notes || null, userId]
    )
    const invoice = invRows[0]

    // Crear links N:N con recepciones
    for (const rcptId of allReceiptIds) {
      await client.query(
        `INSERT INTO invoice_receipt_links
           (tenant_id, supplier_invoice_id, supplier_receipt_id, amount_applied)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (supplier_invoice_id, supplier_receipt_id) DO NOTHING`,
        [tenantId, invoice.id, rcptId, totalMxn / Math.max(allReceiptIds.length, 1)]
      )
      // Marcar recepción como facturada
      await client.query(
        `UPDATE supplier_receipts SET invoiced_at = NOW() WHERE id = $1 AND tenant_id = $2`,
        [rcptId, tenantId]
      )
    }

    // Generar CXP en accounts_payable y recuperar el ap_id para el response
    let apId = null
    let partnerCreditType = null
    if (supplierId) {
      const { rows: apRows } = await client.query(
        `INSERT INTO accounts_payable
           (tenant_id, partner_id, document_type, document_id, document_number,
            currency, exchange_rate, amount_total, issue_date, due_date, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         ON CONFLICT (tenant_id, document_type, document_id) DO NOTHING
         RETURNING id`,
        [tenantId, supplierId,
         documentType === 'remission' ? 'remission' : 'invoice',
         invoice.id, documentNumber,
         currency, exchangeRateValue, totalMxn,
         issueDate, dueDate, userId]
      )
      apId = apRows[0]?.id || null

      // Para que el frontend pueda sugerir "marcar como pagada de contado".
      // Criterio: inferimos "contado" cuando credit_days = 0 (el UI del
      // catálogo solo expone días de crédito; ese es el único input real
      // del usuario). credit_type queda como derivado.
      const { rows: bpRows } = await client.query(
        `SELECT credit_type, credit_days FROM business_partners WHERE id = $1 AND tenant_id = $2`,
        [supplierId, tenantId]
      )
      const bp = bpRows[0]
      partnerCreditType = bp
        ? ((bp.credit_days == null || parseInt(bp.credit_days, 10) === 0) ? 'cash' : 'credit')
        : null
    }

    await audit({
      tenantId, userId, action: 'supplier_invoice.registered',
      resource: 'supplier_invoices', resourceId: invoice.id,
      payload: { documentNumber, documentType, uuidSat, total, totalMxn, supplierId, reconStatus, reconDiff },
      ipAddress, userAgent,
    })

    return {
      ...invoice,
      total_mxn: totalMxn, due_date: dueDate,
      reconciliation_status: reconStatus, reconciliation_diff: reconDiff,
      ap_id: apId,
      partner_credit_type: partnerCreditType,
    }
  })
}

/**
 * Lista facturas/remisiones de proveedor con filtros.
 */
async function listInvoices({ tenantId, type, status, supplierId, from, to, page = 1, limit = 50 }) {
  const offset = (page - 1) * limit
  const params = [tenantId]
  const filters = []

  if (type)       { params.push(type);       filters.push(`si.type = $${params.length}`) }
  if (status)     { params.push(status);     filters.push(`si.status = $${params.length}`) }
  if (supplierId) { params.push(supplierId); filters.push(`si.partner_id = $${params.length}`) }
  if (from)       { params.push(from);       filters.push(`si.invoice_date >= $${params.length}`) }
  if (to)         { params.push(to);         filters.push(`si.invoice_date <= $${params.length}`) }

  const where = filters.length ? `AND ${filters.join(' AND ')}` : ''
  params.push(limit, offset)

  const { rows } = await query(
    `SELECT si.id, si.invoice_number, si.type, si.status,
            si.uuid_sat, si.serie, si.folio,
            si.invoice_date, si.due_date,
            si.currency, si.subtotal, si.tax, si.total, si.total_mxn, si.balance,
            si.reconciliation_status, si.reconciliation_diff,
            si.generic_supplier,
            bp.name AS partner_name, bp.rfc AS partner_rfc,
            po.order_number AS purchase_order_number,
            sr.receipt_number,
            u.full_name AS created_by_name,
            ap.id              AS ap_id,
            ap.status          AS ap_status,
            ap.amount_paid     AS ap_amount_paid,
            ap.amount_pending  AS ap_amount_pending,
            COALESCE((
              SELECT COUNT(*) FROM attachments a
               WHERE a.tenant_id = si.tenant_id
                 AND a.entity_type = 'supplier_invoice'
                 AND a.entity_id   = si.id
            ), 0)::int AS attachment_count,
            CASE WHEN si.due_date < CURRENT_DATE
                  AND si.status NOT IN ('paid','cancelled')
                 THEN true ELSE false END AS is_overdue
     FROM supplier_invoices si
     LEFT JOIN business_partners bp ON bp.id = si.partner_id
     LEFT JOIN purchase_orders po   ON po.id = si.purchase_order_id
     LEFT JOIN supplier_receipts sr ON sr.id = si.supplier_receipt_id
     LEFT JOIN users u              ON u.id  = si.created_by
     LEFT JOIN accounts_payable ap  ON ap.document_id = si.id AND ap.tenant_id = si.tenant_id
     WHERE si.tenant_id = $1 ${where}
     ORDER BY si.invoice_date DESC, si.created_at DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  )

  const { rows: countRows } = await query(
    `SELECT COUNT(*) FROM supplier_invoices si WHERE si.tenant_id = $1 ${where}`,
    params.slice(0, params.length - 2)
  )

  return { data: rows, total: parseInt(countRows[0].count, 10), page, limit }
}

/**
 * Detalle de una factura de proveedor.
 */
async function getInvoice({ tenantId, invoiceId }) {
  const { rows } = await query(
    `SELECT si.*,
            bp.name AS partner_name, bp.rfc AS partner_rfc,
            bp.credit_days, bp.credit_type,
            po.order_number AS purchase_order_number,
            sr.receipt_number,
            u.full_name AS created_by_name,
            ap.id AS ap_id, ap.amount_paid, ap.amount_pending, ap.status AS ap_status
     FROM supplier_invoices si
     LEFT JOIN business_partners bp ON bp.id = si.partner_id
     LEFT JOIN purchase_orders po   ON po.id = si.purchase_order_id
     LEFT JOIN supplier_receipts sr ON sr.id = si.supplier_receipt_id
     LEFT JOIN users u              ON u.id  = si.created_by
     LEFT JOIN accounts_payable ap  ON ap.document_id = si.id
     WHERE si.id = $1 AND si.tenant_id = $2`,
    [invoiceId, tenantId]
  )
  return rows.length ? rows[0] : null
}

/**
 * Registra un pago a proveedor y lo aplica a una o más facturas.
 *
 * @param {object} params
 * @param {string} params.supplierId
 * @param {string} params.paymentDate
 * @param {string} params.method         - 'transfer' | 'cash' | 'check'
 * @param {string} params.reference      - Requerido para transfer y check
 * @param {number} params.amount
 * @param {string} params.currency
 * @param {Array}  params.applications   - [{ apId, amountApplied }]
 */
async function registerPayment({
  tenantId, supplierId, genericSupplier,
  paymentDate, method, reference, amount, currency = 'MXN',
  bankAccountId = null,
  applications = [],
  saveSurplusAsAdvance = false,  // si true y sobra dinero, crea ap_advance
  notes,
  userId, ipAddress, userAgent,
}) {
  return withTransaction(async (client) => {
    if (!amount || amount <= 0) throw createError(400, 'amount debe ser mayor a cero.')
    // Cheque requiere número (es su folio). Transferencia: SPEI opcional.
    if (method === 'check' && !reference) {
      throw createError(400, 'El número de cheque es requerido.')
    }

    if (bankAccountId) {
      const { rows: baRows } = await client.query(
        `SELECT id FROM bank_accounts WHERE id = $1 AND tenant_id = $2 AND active = TRUE`,
        [bankAccountId, tenantId]
      )
      if (!baRows.length) throw createError(400, 'La cuenta bancaria seleccionada no existe o está inactiva.')
    }

    // Resolver TC si es USD
    let exchangeRateValue = 1
    let amountMxn = amount
    if (currency === 'USD') {
      const date = paymentDate || new Date().toISOString().split('T')[0]
      const rate = await getRateForDate({ tenantId, date, currency: 'USD' })
      if (!rate) throw createError(400, 'No hay tipo de cambio disponible para la fecha del pago.')
      exchangeRateValue = parseFloat(rate.rate_mxn)
      amountMxn = parseFloat((amount * exchangeRateValue).toFixed(2))
    }

    // Insertar pago
    const { rows: payRows } = await client.query(
      `INSERT INTO supplier_payments
         (tenant_id, partner_id, generic_supplier, payment_date,
          method, reference, amount, currency, exchange_rate_value, amount_mxn,
          bank_account_id, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       RETURNING *`,
      [tenantId, supplierId || null, genericSupplier || null,
       paymentDate || new Date().toISOString().split('T')[0],
       method, reference || null, amount, currency, exchangeRateValue, amountMxn,
       bankAccountId || null, notes || null, userId]
    )
    const payment = payRows[0]

    // Aplicar pago a facturas
    let totalApplied = 0
    for (const app of applications) {
      if (!app.apId || !app.amountApplied) continue

      // Verificar saldo disponible en CXP
      const { rows: apRows } = await client.query(
        `SELECT id, amount_total, amount_paid, amount_pending, status
         FROM accounts_payable WHERE id = $1 AND tenant_id = $2`,
        [app.apId, tenantId]
      )
      if (!apRows.length) continue
      const ap = apRows[0]

      if (ap.status === 'paid') continue
      const toApply = Math.min(app.amountApplied, parseFloat(ap.amount_pending))
      if (toApply <= 0) continue

      // Registrar aplicación en supplier_payment_applications
      await client.query(
        `INSERT INTO supplier_payment_applications
           (supplier_payment_id, supplier_invoice_id, amount_applied, created_by)
         SELECT $1, si.id, $2, $3
         FROM supplier_invoices si
         JOIN accounts_payable ap ON ap.document_id = si.id
         WHERE ap.id = $4`,
        [payment.id, toApply, userId, app.apId]
      )

      // Actualizar CXP
      const newPaid    = parseFloat(ap.amount_paid) + toApply
      const newStatus  = newPaid >= parseFloat(ap.amount_total) ? 'paid' : 'partial'
      await client.query(
        `UPDATE accounts_payable SET amount_paid = $1, status = $2 WHERE id = $3`,
        [newPaid, newStatus, app.apId]
      )

      // Actualizar balance en supplier_invoices
      await client.query(
        `UPDATE supplier_invoices
         SET balance = balance - $1,
             status  = CASE WHEN balance - $1 <= 0 THEN 'paid'::supplier_invoice_status ELSE 'partial'::supplier_invoice_status END
         WHERE id = (SELECT document_id FROM accounts_payable WHERE id = $2)`,
        [toApply, app.apId]
      )

      totalApplied += toApply
    }

    // Sobrante → anticipo (si el operador lo pidió). Solo cuando hay partner
    // del catálogo (los genéricos no admiten anticipo).
    let advanceGenerated = null
    const surplus = +(amount - totalApplied).toFixed(2)
    if (saveSurplusAsAdvance && surplus > 0.01 && supplierId) {
      const apAdvanceService = require('./apAdvanceService')
      advanceGenerated = await apAdvanceService.registerAdvance({
        tenantId, partnerId: supplierId,
        amount: surplus, currency,
        paymentMethod: method, reference: reference || null,
        bankAccountId, paymentDate,
        supplierPaymentId: payment.id,
        notes: `Sobrante del pago ${payment.id.slice(0,8)}`,
        userId, ipAddress, userAgent,
        client,  // reusa la misma transacción
      })
    }

    await audit({
      tenantId, userId, action: 'supplier_payment.registered',
      resource: 'supplier_payments', resourceId: payment.id,
      payload: { amount, amountMxn, method, reference, totalApplied, applications,
                 advance_generated: advanceGenerated?.id, surplus },
      ipAddress, userAgent,
    })

    return {
      ...payment,
      total_applied: totalApplied,
      advance_generated: advanceGenerated,
    }
  })
}

/**
 * Estado de cuenta de un proveedor.
 */
async function getSupplierStatement({ tenantId, supplierId, from, to }) {
  const params = [tenantId, supplierId]
  const filters = []
  if (from) { params.push(from); filters.push(`ap.issue_date >= $${params.length}`) }
  if (to)   { params.push(to);   filters.push(`ap.issue_date <= $${params.length}`) }
  const where = filters.length ? `AND ${filters.join(' AND ')}` : ''

  const { rows: cxp } = await query(
    `SELECT ap.id, ap.document_type, ap.document_number,
            ap.issue_date, ap.due_date, ap.status,
            ap.amount_total, ap.amount_paid, ap.amount_pending,
            si.uuid_sat, si.rfc_emisor,
            CASE WHEN ap.due_date < CURRENT_DATE AND ap.status NOT IN ('paid','cancelled')
              THEN true ELSE false END AS is_overdue
     FROM accounts_payable ap
     LEFT JOIN supplier_invoices si ON si.id = ap.document_id
     WHERE ap.tenant_id = $1 AND ap.partner_id = $2 ${where}
     ORDER BY ap.due_date ASC, ap.issue_date ASC`,
    params
  )

  const { rows: totals } = await query(
    `SELECT
       COALESCE(SUM(amount_total), 0)   AS total_debt,
       COALESCE(SUM(amount_paid), 0)    AS total_paid,
       COALESCE(SUM(amount_pending), 0) AS total_pending,
       COUNT(*) FILTER (WHERE status = 'pending') AS invoices_pending,
       COUNT(*) FILTER (WHERE status = 'partial')  AS invoices_partial,
       COUNT(*) FILTER (WHERE due_date < CURRENT_DATE AND status NOT IN ('paid','cancelled')) AS invoices_overdue
     FROM accounts_payable
     WHERE tenant_id = $1 AND partner_id = $2`,
    [tenantId, supplierId]
  )

  return { documents: cxp, summary: totals[0] }
}

function createError(status, message) {
  const err = new Error(message)
  err.status = status
  return err
}

module.exports = {
  registerInvoice, listInvoices, getInvoice,
  registerPayment, getSupplierStatement,
}
