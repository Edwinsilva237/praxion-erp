'use strict'

const { query, withTransaction } = require('../../db')
const { audit }                  = require('../../utils/audit')
const { buildOrderBy }           = require('../../utils/sortOrder')
const { LOCAL_TODAY }            = require('../../utils/sqlTime')
const { getRateForDate }         = require('../exchange-rates/exchangeRateService')
const { enqueueEmail }           = require('../../queues/emailQueue')
const { expenseInvoiceRequestEmail } = require('../email/templates/sales')
const partnerService             = require('../business-partners/partnerService')
const documentParserService      = require('./documentParserService')
const attachmentService          = require('../attachments/attachmentService')
const storage                    = require('../../utils/storage')

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
  receiptLineIds = [],                 // facturación parcial por LÍNEA (mig 202)
  purchaseOrderId,
  creditDays = 0, notes,
  xmlContent = null,
  isExpense = false, expenseCategoryId = null,  // módulo de Gastos (Fase 1)
  paymentMethod = null,                         // forma de pago del gasto (mig 183)
  userId, ipAddress, userAgent,
  client: existingClient,   // permite reusar la txn (p.ej. sustitución de devolución)
}) {
  const exec = async (client) => {
    // Validaciones básicas
    if (!documentNumber) throw createError(400, 'documentNumber es requerido.')
    if (!total || total <= 0) throw createError(400, 'total debe ser mayor a cero.')
    if (!supplierId && !genericSupplier) throw createError(400, 'supplierId o genericSupplier es requerido.')
    if (paymentMethod && !['transfer', 'cash', 'check', 'credit_card'].includes(paymentMethod)) {
      throw createError(400, 'paymentMethod inválido (transfer | cash | check | credit_card).')
    }

    // Verificar duplicado por UUID SAT — las CANCELADAS no cuentan (se permite
    // recargar una factura que se canceló por estar mal cargada).
    if (uuidSat) {
      const { rows: dup } = await client.query(
        `SELECT id FROM supplier_invoices WHERE uuid_sat = $1 AND status <> 'cancelled'`,
        [uuidSat]
      )
      if (dup.length > 0) throw createError(409, `Ya existe una factura registrada con UUID ${uuidSat}.`)
    }

    // Normalizar lista de recepciones
    const allReceiptIds = [...new Set([
      ...(receiptIds || []),
      ...(supplierReceiptId ? [supplierReceiptId] : []),
    ])].filter(Boolean)

    // ── Facturación parcial por LÍNEA (mig 202) ──────────────────────────────
    // Resolver qué líneas de recepción cubre esta factura:
    //  - receiptLineIds explícitas → esas (no cubiertas ya por factura REAL activa).
    //  - solo receiptIds → todas las líneas de esas recepciones NO cubiertas por
    //    factura REAL activa (una remisión-CXP no bloquea: se reabre en la sustitución).
    let linesToInvoice = []  // [{ id, receiptId, subtotal }] (subtotal en moneda del doc/recepción)
    if (Array.isArray(receiptLineIds) && receiptLineIds.length > 0) {
      const ph = receiptLineIds.map((_, i) => `$${i + 2}`).join(',')
      const { rows } = await client.query(
        `SELECT srl.id, srl.supplier_receipt_id, srl.subtotal,
                ci.type AS cover_type, ci.status AS cover_status
           FROM supplier_receipt_lines srl
           JOIN supplier_receipts sr ON sr.id = srl.supplier_receipt_id AND sr.tenant_id = $1
           LEFT JOIN supplier_invoices ci ON ci.id = srl.invoiced_by_invoice_id
          WHERE srl.id IN (${ph})`,
        [tenantId, ...receiptLineIds]
      )
      if (rows.length !== receiptLineIds.length) {
        throw createError(400, 'Alguna línea seleccionada no existe o no pertenece a este tenant.')
      }
      for (const l of rows) {
        if (l.cover_type === 'invoice' && l.cover_status !== 'cancelled') {
          throw createError(409, 'Alguna línea seleccionada ya está cubierta por otra factura activa.')
        }
      }
      linesToInvoice = rows.map(l => ({ id: l.id, receiptId: l.supplier_receipt_id, subtotal: parseFloat(l.subtotal || 0) }))
    } else if (allReceiptIds.length > 0) {
      const ph = allReceiptIds.map((_, i) => `$${i + 2}`).join(',')
      const { rows } = await client.query(
        `SELECT srl.id, srl.supplier_receipt_id, srl.subtotal
           FROM supplier_receipt_lines srl
           JOIN supplier_receipts sr ON sr.id = srl.supplier_receipt_id AND sr.tenant_id = $1
           LEFT JOIN supplier_invoices ci ON ci.id = srl.invoiced_by_invoice_id
          WHERE srl.supplier_receipt_id IN (${ph})
            AND (srl.invoiced_by_invoice_id IS NULL OR ci.status = 'cancelled' OR ci.type = 'remission')`,
        [tenantId, ...allReceiptIds]
      )
      linesToInvoice = rows.map(l => ({ id: l.id, receiptId: l.supplier_receipt_id, subtotal: parseFloat(l.subtotal || 0) }))
    }
    // Recepciones efectivamente afectadas + cobertura (subtotal de las líneas) + monto por recepción.
    const affectedReceiptIds = [...new Set(linesToInvoice.map(l => l.receiptId))]
    const coverageSubtotal = parseFloat(linesToInvoice.reduce((s, l) => s + l.subtotal, 0).toFixed(2))
    const amountByReceipt = {}
    for (const l of linesToInvoice) amountByReceipt[l.receiptId] = (amountByReceipt[l.receiptId] || 0) + l.subtotal

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
      // El crédito de COMPRA es `supplier_credit_days` (los días que el PROVEEDOR te
      // concede), NO `credit_days` (que es el crédito que TÚ le das al socio como
      // CLIENTE). Usar el de cliente daba vencimientos y "contado" equivocados.
      const { rows: partner } = await client.query(
        `SELECT supplier_credit_days FROM business_partners WHERE id = $1 AND tenant_id = $2`,
        [supplierId, tenantId]
      )
      if (partner.length > 0 && partner[0].supplier_credit_days > 0) {
        resolvedCreditDays = partner[0].supplier_credit_days
      }
    }
    if (resolvedCreditDays > 0) {
      const due = new Date(issueDate)
      due.setDate(due.getDate() + resolvedCreditDays)
      dueDate = due.toISOString().split('T')[0]
    }

    // Conciliación SIN IVA: subtotal de la factura vs subtotal de las LÍNEAS cubiertas
    // (facturación parcial → solo las líneas de este documento, no la recepción completa).
    const totalReceipts = coverageSubtotal
    const reconDiff   = parseFloat((subtotalMxn - totalReceipts).toFixed(2))
    const reconStatus = affectedReceiptIds.length === 0 ? 'pending'
                      : Math.abs(reconDiff) < 0.01  ? 'reconciled'
                      : 'with_diff'

    // Validar categoría de gasto si viene (debe pertenecer al tenant).
    if (expenseCategoryId) {
      const { rows: catRows } = await client.query(
        `SELECT 1 FROM tenant_expense_categories WHERE id = $1 AND tenant_id = $2`,
        [expenseCategoryId, tenantId]
      )
      if (catRows.length === 0) throw createError(400, 'La categoría de gasto no existe en este tenant.')
    }

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
          is_expense, expense_category_id,
          xml_content, notes, created_by, payment_method)
       VALUES ($1,$2,$3,'pending',$4,$5,$6,$7,$8::uuid,$8::varchar,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$18,$19::date,$20::date,$19::date,$21,$22,$23,$24,$25,$26,$27,$28)
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
       !!isExpense, expenseCategoryId || null,
       xmlContent || null, notes || null, userId, paymentMethod || null]
    )
    const invoice = invRows[0]

    // Links N:N con recepciones (amount_applied = subtotal de las líneas cubiertas)
    // + marcar las LÍNEAS cubiertas (mig 202). `invoiced_at` de la recepción se
    // recomputa más abajo (solo si TODAS sus líneas quedan cubiertas).
    for (const rcptId of affectedReceiptIds) {
      await client.query(
        `INSERT INTO invoice_receipt_links
           (tenant_id, supplier_invoice_id, supplier_receipt_id, amount_applied)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (supplier_invoice_id, supplier_receipt_id) DO NOTHING`,
        [tenantId, invoice.id, rcptId, (amountByReceipt[rcptId] || 0).toFixed(2)]
      )
    }
    if (linesToInvoice.length > 0) {
      await client.query(
        `UPDATE supplier_receipt_lines SET invoiced_by_invoice_id = $1 WHERE id = ANY($2::uuid[])`,
        [invoice.id, linesToInvoice.map(l => l.id)]
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
      // Criterio: "contado" cuando el PROVEEDOR no te da crédito → supplier_credit_days
      // = 0/NULL. (Antes leía credit_days = el crédito que TÚ le das al socio como
      // CLIENTE; campo equivocado para el contexto de COMPRA → no detectaba contado en
      // socios que también son clientes con crédito.)
      const { rows: bpRows } = await client.query(
        `SELECT supplier_credit_days FROM business_partners WHERE id = $1 AND tenant_id = $2`,
        [supplierId, tenantId]
      )
      const bp = bpRows[0]
      partnerCreditType = bp
        ? ((bp.supplier_credit_days == null || parseInt(bp.supplier_credit_days, 10) === 0) ? 'cash' : 'credit')
        : null
    }

    // ── Sustitución Fase 2: factura real reemplaza la remisión-CXP ────────────
    // Si este documento es una FACTURA (no remisión) y alguna recepción ligada ya
    // tenía una REMISIÓN-CXP activa (generada con "no se espera factura"), se anula
    // esa remisión y se enlaza replaced_by_invoice_id → evita doble CXP. Si la
    // remisión ya tiene pagos aplicados, NO se anula sola (orfandaría el pago):
    // se aborta pidiendo reversar el pago primero.
    let replacedRemissionIds = []
    if (documentType !== 'remission' && affectedReceiptIds.length > 0) {
      const ph = affectedReceiptIds.map((_, i) => `$${i + 3}`).join(',')
      const { rows: rems } = await client.query(
        `SELECT DISTINCT si.id, si.invoice_number
           FROM supplier_invoices si
           JOIN invoice_receipt_links irl ON irl.supplier_invoice_id = si.id
          WHERE si.tenant_id = $1 AND si.type = 'remission' AND si.status <> 'cancelled'
            AND si.id <> $2
            AND irl.supplier_receipt_id IN (${ph})`,
        [tenantId, invoice.id, ...affectedReceiptIds]
      )
      for (const rem of rems) {
        const { rows: apr } = await client.query(
          `SELECT amount_paid FROM accounts_payable
            WHERE tenant_id = $1 AND document_type = 'remission' AND document_id = $2`,
          [tenantId, rem.id]
        )
        if (parseFloat(apr[0]?.amount_paid || 0) > 0) {
          throw createError(409,
            `La CXP sin factura ${rem.invoice_number} de esta recepción ya tiene pagos aplicados. Reversa el pago antes de registrar la factura (o aplica el pago a la factura nueva).`)
        }
        await client.query(
          `UPDATE supplier_invoices
              SET status = 'cancelled', replaced_by_invoice_id = $1, updated_at = NOW()
            WHERE id = $2 AND tenant_id = $3`,
          [invoice.id, rem.id, tenantId]
        )
        await client.query(
          `UPDATE accounts_payable SET status = 'cancelled'
            WHERE tenant_id = $1 AND document_type = 'remission' AND document_id = $2`,
          [tenantId, rem.id]
        )
        // Reabrir las líneas que cubría la remisión y NO tomó esta factura (ya
        // re-marcadas arriba con invoice.id) → quedan pendientes de facturar.
        await client.query(
          `UPDATE supplier_receipt_lines SET invoiced_by_invoice_id = NULL WHERE invoiced_by_invoice_id = $1`,
          [rem.id]
        )
        replacedRemissionIds.push(rem.id)
      }
    }

    // Recomputar invoiced_at: una recepción está "totalmente facturada" SOLO si
    // todas sus líneas están cubiertas por un documento activo. Si queda alguna
    // pendiente (factura parcial / línea reabierta) → NULL (reaparece en el selector).
    for (const rcptId of affectedReceiptIds) {
      await client.query(
        `UPDATE supplier_receipts sr
            SET invoiced_at = CASE WHEN NOT EXISTS (
                  SELECT 1 FROM supplier_receipt_lines srl
                   LEFT JOIN supplier_invoices ci ON ci.id = srl.invoiced_by_invoice_id
                  WHERE srl.supplier_receipt_id = sr.id
                    AND (srl.invoiced_by_invoice_id IS NULL OR ci.status = 'cancelled')
                ) THEN COALESCE(sr.invoiced_at, NOW()) ELSE NULL END
          WHERE sr.id = $1 AND sr.tenant_id = $2`,
        [rcptId, tenantId]
      )
    }

    await audit({
      tenantId, userId, action: 'supplier_invoice.registered',
      resource: 'supplier_invoices', resourceId: invoice.id,
      payload: { documentNumber, documentType, uuidSat, total, totalMxn, supplierId, reconStatus, reconDiff,
                 replacedRemissionIds },
      ipAddress, userAgent,
    })

    return {
      ...invoice,
      total_mxn: totalMxn, due_date: dueDate,
      reconciliation_status: reconStatus, reconciliation_diff: reconDiff,
      ap_id: apId,
      partner_credit_type: partnerCreditType,
      replaced_remission_ids: replacedRemissionIds,
    }
  }
  return existingClient ? exec(existingClient) : withTransaction(exec)
}

/**
 * Fase 2 — Genera una CXP "sin factura" desde una recepción confirmada.
 *
 * Caso: el proveedor NO va a emitir CFDI (o aún no), pero ya recibiste la
 * mercancía y quieres reconocer la cuenta por pagar. Crea un documento de
 * proveedor tipo 'remission' (NO fiscal, SIN IVA) por el valor de la recepción,
 * con vencimiento por supplier_credit_days, ligado a la recepción. Reusa
 * registerInvoice. Si después llega el CFDI real, registrar la factura de esa
 * recepción anula esta remisión automáticamente (replaced_by_invoice_id).
 */
async function generateReceiptRemission({ tenantId, receiptId, notes, userId, ipAddress, userAgent }) {
  return withTransaction(async (client) => {
    const { rows: rcptRows } = await client.query(
      `SELECT sr.id, sr.receipt_number, sr.partner_id, sr.purchase_order_id,
              sr.status, sr.invoiced_at,
              COALESCE(po.currency, 'MXN') AS currency,
              COALESCE((SELECT SUM(srl.subtotal) FROM supplier_receipt_lines srl
                         WHERE srl.supplier_receipt_id = sr.id), 0) AS subtotal
         FROM supplier_receipts sr
         LEFT JOIN purchase_orders po ON po.id = sr.purchase_order_id
        WHERE sr.id = $1 AND sr.tenant_id = $2
        FOR UPDATE OF sr`,
      [receiptId, tenantId]
    )
    if (!rcptRows[0]) throw createError(404, 'Recepción no encontrada.')
    const rcpt = rcptRows[0]

    if (rcpt.status !== 'confirmed') {
      throw createError(409, 'Solo se puede generar la CXP de una recepción CONFIRMADA.')
    }
    if (rcpt.invoiced_at) {
      throw createError(409, 'Esta recepción ya tiene un documento (factura o remisión).')
    }
    // Doble candado: ¿hay un supplier_invoice activo ligado?
    const { rows: existing } = await client.query(
      `SELECT 1 FROM invoice_receipt_links irl
         JOIN supplier_invoices si ON si.id = irl.supplier_invoice_id
        WHERE irl.supplier_receipt_id = $1 AND si.status <> 'cancelled' LIMIT 1`,
      [receiptId]
    )
    if (existing[0]) throw createError(409, 'Esta recepción ya tiene un documento activo.')
    if (!rcpt.partner_id) {
      throw createError(400, 'La recepción no tiene un proveedor del catálogo; asígnalo antes de generar la CXP.')
    }
    const subtotal = parseFloat(rcpt.subtotal)
    if (!(subtotal > 0)) {
      throw createError(400, 'La recepción no tiene importe (líneas sin precio). Captura los precios primero.')
    }

    return registerInvoice({
      tenantId, supplierId: rcpt.partner_id,
      documentType: 'remission',
      documentNumber: `S/F-${rcpt.receipt_number}`,
      currency: rcpt.currency,
      subtotal, tax: 0, total: subtotal,
      receiptIds: [receiptId],
      purchaseOrderId: rcpt.purchase_order_id || null,
      creditDays: 0, // registerInvoice resuelve supplier_credit_days
      notes: notes || `CXP sin factura generada desde la recepción ${rcpt.receipt_number}.`,
      userId, ipAddress, userAgent,
      client, // misma transacción
    })
  })
}

// Orden de las listas de facturas de proveedor y gastos (default por creación).
const SI_SORT_COLUMNS = {
  folio:     'si.invoice_number',
  fecha:     'si.created_at',
  proveedor: 'bp.name',
  emision:   'si.invoice_date',
  estatus:   'si.status',
  total:     'si.total_mxn',
}

/**
 * Lista facturas/remisiones de proveedor con filtros.
 */
async function listInvoices({ tenantId, type, status, supplierId, from, to, sortBy, sortDir, page = 1, limit = 50 }) {
  const offset = (page - 1) * limit
  const params = [tenantId]
  const filters = []
  const orderBy = buildOrderBy({ sortBy, sortDir, columns: SI_SORT_COLUMNS, defaultKey: 'fecha', tiebreaker: 'si.id DESC' })

  if (type)       { params.push(type);       filters.push(`si.type = $${params.length}`) }
  else            { filters.push(`si.type <> 'credit_note'`) }   // las NC recibidas no son facturas por pagar
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
            CASE WHEN si.due_date < ${LOCAL_TODAY}
                  AND si.status NOT IN ('paid','cancelled')
                 THEN true ELSE false END AS is_overdue
     FROM supplier_invoices si
     LEFT JOIN business_partners bp ON bp.id = si.partner_id
     LEFT JOIN purchase_orders po   ON po.id = si.purchase_order_id
     LEFT JOIN supplier_receipts sr ON sr.id = si.supplier_receipt_id
     LEFT JOIN users u              ON u.id  = si.created_by
     LEFT JOIN accounts_payable ap  ON ap.document_id = si.id AND ap.tenant_id = si.tenant_id
     WHERE si.tenant_id = $1 ${where}
     ORDER BY ${orderBy}
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
  creditCardId = null,
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

    if (creditCardId) {
      const { rows: ccRows } = await client.query(
        `SELECT id FROM credit_cards WHERE id = $1 AND tenant_id = $2 AND active = TRUE`,
        [creditCardId, tenantId]
      )
      if (!ccRows.length) throw createError(400, 'La tarjeta de crédito seleccionada no existe o está inactiva.')
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
          bank_account_id, credit_card_id, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       RETURNING *`,
      [tenantId, supplierId || null, genericSupplier || null,
       paymentDate || new Date().toISOString().split('T')[0],
       method, reference || null, amount, currency, exchangeRateValue, amountMxn,
       bankAccountId || null, creditCardId || null, notes || null, userId]
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
 * Reversa un pago a proveedor (supplier_payments). Deshace su efecto en las CXP
 * que liquidó: restaura amount_paid/status de cada accounts_payable y el balance/
 * status de cada supplier_invoice. El pago NO se borra: queda marcado
 * (reversed_at/by/reason) para auditoría y se excluye de saldos e historial.
 *
 * Espejo de cxcService.reversePayment. Para corregir un pago mal aplicado, el
 * operador lo reversa y vuelve a registrarlo en el documento correcto.
 *
 * Si el sobrante del pago se guardó como ANTICIPO y este YA se aplicó a otras
 * facturas, se aborta pidiendo reversar esas aplicaciones primero (el anticipo
 * sin aplicar se elimina al reversar).
 */
async function reverseSupplierPayment({ tenantId, paymentId, reason, userId, ipAddress, userAgent }) {
  if (!reason || !String(reason).trim()) {
    throw createError(400, 'La razón de la reversa es requerida.')
  }
  const reasonTrim = String(reason).trim()

  return withTransaction(async (client) => {
    const { rows: payRows } = await client.query(
      `SELECT id, amount, reversed_at FROM supplier_payments
        WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
      [paymentId, tenantId]
    )
    if (!payRows.length) throw createError(404, 'Pago no encontrado.')
    if (payRows[0].reversed_at) throw createError(409, 'Este pago ya fue reversado.')

    // Anticipo nacido del sobrante de este pago. Si ya se aplicó → bloquear.
    const { rows: adv } = await client.query(
      `SELECT id, amount_applied FROM ap_advances
        WHERE supplier_payment_id = $1 AND tenant_id = $2 FOR UPDATE`,
      [paymentId, tenantId]
    )
    for (const a of adv) {
      if (parseFloat(a.amount_applied || 0) > 0) {
        throw createError(409,
          'El sobrante de este pago se guardó como anticipo y ya fue aplicado a otras facturas. Reversa esas aplicaciones antes.')
      }
    }

    // Revertir cada aplicación: CXP (accounts_payable) + factura (supplier_invoices).
    const { rows: apps } = await client.query(
      `SELECT supplier_invoice_id, amount_applied
         FROM supplier_payment_applications WHERE supplier_payment_id = $1`,
      [paymentId]
    )
    for (const app of apps) {
      const applied = parseFloat(app.amount_applied)
      const { rows: apRows } = await client.query(
        `SELECT id, amount_total, amount_paid FROM accounts_payable
          WHERE tenant_id = $1 AND document_id = $2 FOR UPDATE`,
        [tenantId, app.supplier_invoice_id]
      )
      if (apRows.length) {
        const ap = apRows[0]
        const newPaid = Math.max(0, +(parseFloat(ap.amount_paid) - applied).toFixed(2))
        const total = parseFloat(ap.amount_total)
        const newStatus = newPaid <= 0.001 ? 'pending' : (newPaid >= total - 0.001 ? 'paid' : 'partial')
        await client.query(
          `UPDATE accounts_payable SET amount_paid = $1, status = $2 WHERE id = $3`,
          [newPaid, newStatus, ap.id]
        )
      }
      // balance se recompone (cap a total_mxn por el CHECK si_balance_valid).
      await client.query(
        `UPDATE supplier_invoices
            SET balance = LEAST(total_mxn, balance + $1),
                status = CASE
                  WHEN status = 'cancelled' THEN status
                  WHEN LEAST(total_mxn, balance + $1) >= total_mxn - 0.001 THEN 'pending'::supplier_invoice_status
                  WHEN LEAST(total_mxn, balance + $1) <= 0.001            THEN 'paid'::supplier_invoice_status
                  ELSE 'partial'::supplier_invoice_status END,
                updated_at = NOW()
          WHERE id = $2 AND tenant_id = $3`,
        [applied, app.supplier_invoice_id, tenantId]
      )
    }

    // El anticipo sin aplicar nacido de este pago se elimina.
    if (adv.length) {
      await client.query(
        `DELETE FROM ap_advances WHERE supplier_payment_id = $1 AND tenant_id = $2`,
        [paymentId, tenantId]
      )
    }

    await client.query(
      `UPDATE supplier_payments
          SET reversed_at = NOW(), reversed_by = $1, reversal_reason = $2
        WHERE id = $3`,
      [userId, reasonTrim, paymentId]
    )

    await audit({
      tenantId, userId, action: 'supplier_payment.reversed',
      resource: 'supplier_payments', resourceId: paymentId,
      payload: { reason: reasonTrim, reversedApplications: apps.length, advanceRemoved: adv.length },
      ipAddress, userAgent,
    })

    return { reversed: true, paymentId, reversedApplications: apps.length, advanceRemoved: adv.length }
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
            CASE WHEN ap.due_date < ${LOCAL_TODAY} AND ap.status NOT IN ('paid','cancelled')
              THEN true ELSE false END AS is_overdue
     FROM accounts_payable ap
     LEFT JOIN supplier_invoices si ON si.id = ap.document_id
     WHERE ap.tenant_id = $1 AND ap.partner_id = $2 AND ap.status <> 'cancelled' ${where}
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
       COUNT(*) FILTER (WHERE due_date < ${LOCAL_TODAY} AND status NOT IN ('paid','cancelled')) AS invoices_overdue
     FROM accounts_payable
     WHERE tenant_id = $1 AND partner_id = $2 AND status <> 'cancelled'`,
    [tenantId, supplierId]
  )

  return { documents: cxp, summary: totals[0] }
}

/**
 * Lista GASTOS (supplier_invoices con is_expense=true) con su categoría y los
 * dos semáforos: CFDI (¿tiene uuid_sat?) y pago (status del CXP).
 * Filtros: categoryId, status (pago), hasCfdi ('yes'|'no'), from, to, search.
 */
async function listExpenses({ tenantId, categoryId, status, hasCfdi, from, to, search, sortBy, sortDir, page = 1, limit = 50 }) {
  const offset = (page - 1) * limit
  const params = [tenantId]
  const filters = ['si.is_expense = true']
  const orderBy = buildOrderBy({ sortBy, sortDir, columns: SI_SORT_COLUMNS, defaultKey: 'fecha', tiebreaker: 'si.id DESC' })

  if (categoryId) { params.push(categoryId); filters.push(`si.expense_category_id = $${params.length}`) }
  if (status)     { params.push(status);     filters.push(`si.status = $${params.length}`) }
  if (hasCfdi === 'yes') filters.push(`si.uuid_sat IS NOT NULL`)
  if (hasCfdi === 'no')  filters.push(`si.uuid_sat IS NULL`)
  if (from)       { params.push(from);       filters.push(`si.invoice_date >= $${params.length}`) }
  if (to)         { params.push(to);         filters.push(`si.invoice_date <= $${params.length}`) }
  if (search) {
    params.push(`%${search}%`)
    const s = params.length
    filters.push(`(si.invoice_number ILIKE $${s} OR bp.name ILIKE $${s} OR si.generic_supplier ILIKE $${s})`)
  }

  const where = `WHERE si.tenant_id = $1 AND ${filters.join(' AND ')}`
  params.push(limit, offset)

  const { rows } = await query(
    `SELECT si.id, si.invoice_number, si.status,
            si.uuid_sat, si.invoice_date, si.due_date,
            si.currency, si.subtotal, si.tax, si.total, si.total_mxn,
            si.generic_supplier, si.notes,
            si.expense_category_id, si.payment_method,
            ec.name AS expense_category_name,
            bp.name AS partner_name, bp.rfc AS partner_rfc,
            ap.id AS ap_id, ap.status AS ap_status,
            ap.amount_paid AS ap_amount_paid, ap.amount_pending AS ap_amount_pending,
            (si.uuid_sat IS NOT NULL) AS has_cfdi,
            CASE WHEN si.due_date < ${LOCAL_TODAY} AND si.status NOT IN ('paid','cancelled')
                 THEN true ELSE false END AS is_overdue
     FROM supplier_invoices si
     LEFT JOIN business_partners bp ON bp.id = si.partner_id
     LEFT JOIN tenant_expense_categories ec ON ec.id = si.expense_category_id
     LEFT JOIN accounts_payable ap ON ap.document_id = si.id AND ap.tenant_id = si.tenant_id
     ${where}
     ORDER BY ${orderBy}
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  )

  const { rows: countRows } = await query(
    `SELECT COUNT(*) FROM supplier_invoices si
     LEFT JOIN business_partners bp ON bp.id = si.partner_id
     ${where}`,
    params.slice(0, params.length - 2)
  )

  return { data: rows, total: parseInt(countRows[0].count, 10), page, limit }
}

/**
 * Resumen de GASTOS por categoría para "¿en qué se va el dinero?" — agrupa por
 * categoría (total_mxn desc) + total del período + total sin CFDI (lo deducible
 * pendiente). EXCLUYE cancelados (= gasto real). Respeta los mismos filtros que
 * el listado (categoría, CFDI, from/to por invoice_date, search).
 */
async function listExpensesSummary({ tenantId, categoryId, hasCfdi, from, to, search }) {
  const params = [tenantId]
  const filters = ['si.is_expense = true', `si.status <> 'cancelled'`]
  if (categoryId) { params.push(categoryId); filters.push(`si.expense_category_id = $${params.length}`) }
  if (hasCfdi === 'yes') filters.push(`si.uuid_sat IS NOT NULL`)
  if (hasCfdi === 'no')  filters.push(`si.uuid_sat IS NULL`)
  if (from)       { params.push(from);       filters.push(`si.invoice_date >= $${params.length}`) }
  if (to)         { params.push(to);         filters.push(`si.invoice_date <= $${params.length}`) }
  if (search) {
    params.push(`%${search}%`); const s = params.length
    filters.push(`(si.invoice_number ILIKE $${s} OR bp.name ILIKE $${s} OR si.generic_supplier ILIKE $${s})`)
  }
  const where = `WHERE si.tenant_id = $1 AND ${filters.join(' AND ')}`

  const { rows: cats } = await query(
    `SELECT si.expense_category_id AS category_id,
            COALESCE(ec.name, 'Sin categoría') AS category_name,
            COUNT(*)::int AS count,
            COALESCE(SUM(si.total_mxn), 0)::numeric AS total_mxn
       FROM supplier_invoices si
       LEFT JOIN business_partners bp ON bp.id = si.partner_id
       LEFT JOIN tenant_expense_categories ec ON ec.id = si.expense_category_id
       ${where}
       GROUP BY si.expense_category_id, ec.name
       ORDER BY total_mxn DESC`,
    params
  )
  const { rows: tot } = await query(
    `SELECT COALESCE(SUM(si.total_mxn), 0)::numeric AS total_mxn,
            COUNT(*)::int AS count,
            COALESCE(SUM(si.total_mxn) FILTER (WHERE si.uuid_sat IS NULL), 0)::numeric AS sin_cfdi_mxn
       FROM supplier_invoices si
       LEFT JOIN business_partners bp ON bp.id = si.partner_id
       ${where}`,
    params
  )
  return {
    total_mxn:    parseFloat(tot[0].total_mxn),
    count:        tot[0].count,
    sin_cfdi_mxn: parseFloat(tot[0].sin_cfdi_mxn),
    by_category:  cats.map(c => ({
      category_id:   c.category_id,
      category_name: c.category_name,
      count:         c.count,
      total_mxn:     parseFloat(c.total_mxn),
    })),
  }
}

/**
 * Detalle de UN gasto (supplier_invoice is_expense=true): todos los campos +
 * categoría + proveedor + los dos semáforos (CFDI por uuid_sat, pago por el CXP).
 */
async function getExpense({ tenantId, id }) {
  const { rows } = await query(
    `SELECT si.id, si.partner_id, si.invoice_number, si.type, si.status,
            si.uuid_sat, si.invoice_date, si.due_date,
            si.currency, si.exchange_rate_value,
            si.subtotal, si.tax, si.total, si.total_mxn,
            si.generic_supplier, si.rfc_emisor, si.notes, si.is_expense,
            si.expense_category_id, si.payment_method, si.invoice_requested_at,
            ec.name AS expense_category_name,
            bp.name AS partner_name, bp.rfc AS partner_rfc,
            ap.id AS ap_id, ap.status AS ap_status,
            ap.amount_paid AS ap_amount_paid, ap.amount_pending AS ap_amount_pending,
            (si.uuid_sat IS NOT NULL) AS has_cfdi,
            CASE WHEN ap.due_date < ${LOCAL_TODAY} AND ap.status NOT IN ('paid','cancelled')
                 THEN true ELSE false END AS is_overdue
       FROM supplier_invoices si
       LEFT JOIN business_partners bp ON bp.id = si.partner_id
       LEFT JOIN tenant_expense_categories ec ON ec.id = si.expense_category_id
       LEFT JOIN accounts_payable ap ON ap.document_id = si.id AND ap.tenant_id = si.tenant_id
      WHERE si.id = $1 AND si.tenant_id = $2 AND si.is_expense = true`,
    [id, tenantId]
  )
  return rows[0] || null
}

/**
 * Liquida un GASTO de contado en un solo paso: registra un pago por el TOTAL
 * pendiente y lo aplica a la CXP del gasto, dejándolo "Pagado" sin tener que ir
 * al módulo de Cuentas por pagar. Pensado para las facturas que entran por correo
 * y se pagan al contado.
 *
 * Requiere un proveedor del catálogo (es quien tiene CXP — `ap_id`). Un gasto
 * genérico no tiene CXP; primero hay que asignarle proveedor (assignExpenseSupplier).
 * Si ya hay un pago parcial, se manda a Cuentas por pagar (no adivinamos el resto).
 *
 * @returns el gasto actualizado (mismo shape que getExpense).
 */
async function payExpense({
  tenantId, id, method = 'cash', reference = null, paymentDate = null,
  bankAccountId = null, creditCardId = null,
  userId, ipAddress, userAgent,
}) {
  const exp = await getExpense({ tenantId, id })
  if (!exp) throw createError(404, 'Gasto no encontrado.')
  if (exp.status === 'cancelled') throw createError(409, 'El gasto está cancelado.')
  if (!exp.ap_id) {
    throw createError(409, 'Este gasto no tiene cuenta por pagar (asigna un proveedor del catálogo primero).')
  }
  if (exp.ap_status === 'paid') throw createError(409, 'El gasto ya está pagado.')
  if (exp.ap_status === 'partial') {
    throw createError(409, 'El gasto ya tiene un pago parcial; liquídalo desde Cuentas por pagar.')
  }

  // El pendiente vive en la CXP (MXN). En un gasto sin pagos, pendiente == total_mxn.
  const pendingMxn = parseFloat(exp.ap_amount_pending ?? exp.total_mxn)
  await registerPayment({
    tenantId,
    supplierId: exp.partner_id,
    // Pago de contado: por default se registra hoy (cuando se captura el pago);
    // registerPayment cae a la fecha de hoy si no se manda una.
    paymentDate: paymentDate || undefined,
    method,
    reference,
    amount: parseFloat(exp.total),            // monto en la moneda del documento
    currency: exp.currency || 'MXN',
    bankAccountId, creditCardId,              // asociación opcional (transfer→cuenta, tarjeta→credit_card)
    applications: [{ apId: exp.ap_id, amountApplied: pendingMxn }],
    notes: 'Pago de contado del gasto',
    userId, ipAddress, userAgent,
  })
  return getExpense({ tenantId, id })
}

/**
 * Crea (o reusa) un PROVEEDOR a partir de un GASTO genérico — típicamente uno que
 * llegó por correo cuyo emisor no estaba en el catálogo (`partner_id IS NULL`,
 * `generic_supplier` = razón social del CFDI). Usa el RFC + nombre que ya trae el
 * gasto, vincula el gasto al proveedor y **genera la CXP que faltaba** (los gastos
 * genéricos no tienen `accounts_payable`: `registerInvoice` solo la crea si hay
 * `supplierId`).
 *
 * Dedup por RFC: si ya existe un socio con ese RFC se REUSA (un 'customer' se
 * PROMUEVE a 'both' para que aparezca como proveedor — mismo gotcha que el match
 * por RFC del inbound). Si no hay match, se crea uno nuevo.
 *
 * @returns {{ outcome: 'created'|'linked'|'promoted', partner: {id,name,type}, expense }}
 */
async function assignExpenseSupplier({
  tenantId, id, userId, ipAddress, userAgent,
  name, rfc, partnerType = 'supplier',
  isOccasional = true,   // por default = proveedor EVENTUAL (fuera del catálogo); el
                         // usuario marca "es recurrente" para crearlo formal.
}) {
  if (!['supplier', 'both'].includes(partnerType)) {
    throw createError(400, 'partnerType inválido (supplier | both).')
  }
  return withTransaction(async (client) => {
    // 1. Cargar el gasto (debe ser un gasto, no cancelado, SIN proveedor).
    const { rows } = await client.query(
      `SELECT * FROM supplier_invoices
        WHERE id = $1 AND tenant_id = $2 AND is_expense = true
        FOR UPDATE`,
      [id, tenantId]
    )
    if (!rows.length) throw createError(404, 'Gasto no encontrado.')
    const exp = rows[0]
    if (exp.status === 'cancelled') throw createError(409, 'No se puede asignar proveedor a un gasto cancelado.')
    if (exp.partner_id) throw createError(409, 'Este gasto ya tiene un proveedor asignado.')

    // 2. Datos del proveedor: overrides del form, o lo que trae el CFDI.
    const resolvedName = (name || exp.generic_supplier || '').trim()
    const resolvedRfc  = ((rfc != null ? rfc : exp.rfc_emisor) || '')
      .toUpperCase().replace(/\s+/g, '').trim()
    if (!resolvedName) throw createError(400, 'El nombre del proveedor es requerido.')

    // 3. Dedup por RFC: ¿ya existe un socio con ese RFC en el tenant?
    let partner = null, outcome = 'created'
    if (resolvedRfc) {
      const { rows: existing } = await client.query(
        `SELECT id, name, type FROM business_partners
          WHERE tenant_id = $1 AND UPPER(REPLACE(rfc, ' ', '')) = $2
          ORDER BY (type IN ('supplier','both')) DESC, created_at
          LIMIT 1`,
        [tenantId, resolvedRfc]
      )
      if (existing[0]) {
        partner = existing[0]
        if (partner.type === 'customer') {
          // Promover a 'both' para que funcione como proveedor.
          await client.query(
            `UPDATE business_partners SET type = 'both', updated_at = now()
              WHERE id = $1 AND tenant_id = $2`,
            [partner.id, tenantId]
          )
          partner.type = 'both'
          outcome = 'promoted'
        } else {
          outcome = 'linked'
        }
      }
    }

    // 4. Sin match → crear el proveedor (reusa createPartner en la MISMA txn).
    //    Eventual por default; formal solo si el usuario lo marcó como recurrente.
    if (!partner) {
      partner = await partnerService.createPartner({
        tenantId, type: partnerType,
        name: resolvedName, rfc: resolvedRfc || null,
        isOccasional: isOccasional !== false,
        userId, ipAddress, userAgent,
        client,
      })
      outcome = 'created'
    }

    // 5. Vincular el gasto al proveedor (deja de ser genérico).
    await client.query(
      `UPDATE supplier_invoices
          SET partner_id = $1, generic_supplier = NULL, updated_at = now()
        WHERE id = $2 AND tenant_id = $3`,
      [partner.id, id, tenantId]
    )

    // 6. Generar la CXP que faltaba (gasto genérico nunca tuvo accounts_payable).
    //    Mismo INSERT que registerInvoice; ON CONFLICT por si ya existiera.
    await client.query(
      `INSERT INTO accounts_payable
         (tenant_id, partner_id, document_type, document_id, document_number,
          currency, exchange_rate, amount_total, issue_date, due_date, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (tenant_id, document_type, document_id) DO NOTHING`,
      [tenantId, partner.id,
       exp.type === 'remission' ? 'remission' : 'invoice',
       exp.id, exp.invoice_number,
       exp.currency, exp.exchange_rate_value || 1, exp.total_mxn,
       exp.invoice_date, exp.due_date, userId]
    )

    await audit({
      tenantId, userId, action: 'expense.supplier_assigned',
      resource: 'supplier_invoices', resourceId: id,
      payload: { partnerId: partner.id, outcome, rfc: resolvedRfc || null },
      ipAddress, userAgent,
    })

    return { outcome, partner: { id: partner.id, name: partner.name || resolvedName, type: partner.type || partnerType } }
  })
}

/**
 * Edita un GASTO (supplier_invoice is_expense=true). Mantiene en sync su CXP.
 *
 * Reglas de seguridad:
 *   - No se edita un gasto cancelado.
 *   - Campos NO monetarios (categoría, proveedor, fecha, forma de pago, folio,
 *     UUID, notas) se editan siempre.
 *   - subtotal/tax (→ total) SOLO si el CXP no tiene pagos (amount_paid = 0),
 *     para no romper un CXP ya pagado (CHECK amount_paid <= amount_total).
 *   - UUID nuevo pasa por el anti-duplicado (uuid_sat es único).
 */
async function updateExpense({
  tenantId, id, userId,
  expenseCategoryId, supplierId, invoiceDate,
  subtotal, tax, paymentMethod, documentNumber, uuidSat, notes, currency,
  ipAddress, userAgent,
}) {
  return withTransaction(async (client) => {
    const { rows: invRows } = await client.query(
      `SELECT si.*, ap.id AS ap_id, ap.amount_paid AS ap_amount_paid
         FROM supplier_invoices si
         LEFT JOIN accounts_payable ap ON ap.document_id = si.id AND ap.tenant_id = si.tenant_id
        WHERE si.id = $1 AND si.tenant_id = $2 AND si.is_expense = true
        FOR UPDATE OF si`,
      [id, tenantId]
    )
    if (!invRows.length) throw createError(404, 'Gasto no encontrado.')
    const inv = invRows[0]
    if (inv.status === 'cancelled') throw createError(409, 'No se puede editar un gasto cancelado.')

    const amountPaid = parseFloat(inv.ap_amount_paid || 0)
    if (currency !== undefined && !['MXN', 'USD'].includes(currency)) {
      throw createError(400, 'currency inválido (MXN | USD).')
    }
    const newCurrency = (currency !== undefined) ? currency : inv.currency
    const wantsCurrencyChange = newCurrency !== inv.currency
    const wantsAmountChange = subtotal !== undefined || tax !== undefined
    // Cambiar la moneda recalcula total_mxn (y la CXP), igual que cambiar el importe.
    const affectsMxn = wantsAmountChange || wantsCurrencyChange
    if (affectsMxn && amountPaid > 0) {
      throw createError(409, 'No se puede cambiar el monto o la moneda de un gasto con un pago aplicado. Reversa el pago primero.')
    }

    if (paymentMethod && !['transfer', 'cash', 'check', 'credit_card'].includes(paymentMethod)) {
      throw createError(400, 'paymentMethod inválido (transfer | cash | check | credit_card).')
    }
    if (expenseCategoryId) {
      const { rows } = await client.query(
        `SELECT 1 FROM tenant_expense_categories WHERE id = $1 AND tenant_id = $2`,
        [expenseCategoryId, tenantId])
      if (!rows.length) throw createError(400, 'La categoría de gasto no existe en este tenant.')
    }
    if (supplierId) {
      const { rows } = await client.query(
        `SELECT 1 FROM business_partners WHERE id = $1 AND tenant_id = $2`,
        [supplierId, tenantId])
      if (!rows.length) throw createError(400, 'El proveedor no existe en este tenant.')
    }

    // UUID nuevo → anti-duplicado (excluye este mismo gasto y las canceladas)
    const newUuid = uuidSat !== undefined ? (uuidSat ? String(uuidSat).trim() : null) : undefined
    if (newUuid) {
      const { rows: dup } = await client.query(
        `SELECT id FROM supplier_invoices WHERE uuid_sat = $1 AND id <> $2 AND status <> 'cancelled'`,
        [newUuid, id])
      if (dup.length) throw createError(409, `Ya existe una factura registrada con UUID ${newUuid}.`)
    }

    // Fecha + vencimiento (preserva la ventana de crédito original).
    // Se calcula ANTES del tipo de cambio porque, si la moneda pasa a USD,
    // el TC se resuelve para la fecha del documento.
    let newIssue = inv.invoice_date
    let newDue   = inv.due_date
    if (invoiceDate !== undefined && invoiceDate) {
      const oldIssue = new Date(inv.invoice_date)
      const oldDue   = inv.due_date ? new Date(inv.due_date) : oldIssue
      const creditMs = oldDue.getTime() - oldIssue.getTime()
      newIssue = invoiceDate
      const d = new Date(invoiceDate); d.setTime(d.getTime() + creditMs)
      newDue = d.toISOString().split('T')[0]
    }

    // Recalcular montos. El `total` vive en la moneda del documento; `total_mxn`
    // es su conversión a pesos. Un gasto típico es MXN (rate=1).
    let newSubtotal = parseFloat(inv.subtotal || 0)
    let newTax      = parseFloat(inv.tax || 0)
    if (subtotal !== undefined) newSubtotal = parseFloat(subtotal) || 0
    if (tax !== undefined)      newTax      = parseFloat(tax) || 0
    const newTotal = parseFloat((newSubtotal + newTax).toFixed(2))
    if (affectsMxn && newTotal <= 0) throw createError(400, 'El total del gasto debe ser mayor a cero.')

    // Tipo de cambio según la moneda RESULTANTE. MXN → sin TC (rate=1). USD →
    // si cambió la moneda (o estaba en USD sin TC guardado) se resuelve el TC del
    // día del documento; si sigue en USD sin tocar la moneda, se preserva el TC.
    let newExchangeRateId    = inv.exchange_rate_id || null
    let newExchangeRateValue = inv.exchange_rate_value || null
    if (newCurrency === 'MXN') {
      newExchangeRateId = null
      newExchangeRateValue = null
    } else if (wantsCurrencyChange || !newExchangeRateValue) {
      const rate = await getRateForDate({ tenantId, date: newIssue, currency: 'USD' })
      if (!rate) throw createError(400, 'No hay tipo de cambio USD disponible para la fecha del documento.')
      newExchangeRateId    = rate.id
      newExchangeRateValue = parseFloat(rate.rate_mxn)
    }
    const rate = newCurrency === 'USD' ? parseFloat(newExchangeRateValue || 1) : 1
    const newTotalMxn = parseFloat((newTotal * rate).toFixed(2))

    const set = []; const p = []; let i = 1
    if (expenseCategoryId !== undefined) { set.push(`expense_category_id = $${i++}`); p.push(expenseCategoryId || null) }
    if (supplierId !== undefined)        { set.push(`partner_id = $${i++}`);          p.push(supplierId || null) }
    if (paymentMethod !== undefined)     { set.push(`payment_method = $${i++}`);      p.push(paymentMethod || null) }
    if (documentNumber !== undefined)    { set.push(`invoice_number = $${i++}`);      p.push(documentNumber || inv.invoice_number) }
    if (newUuid !== undefined)           { set.push(`uuid_sat = $${i}::uuid`, `xml_uuid = $${i}::varchar`); i++; p.push(newUuid) }
    if (notes !== undefined)             { set.push(`notes = $${i++}`);               p.push(notes || null) }
    if (invoiceDate !== undefined) {
      set.push(`invoice_date = $${i++}::date`); p.push(newIssue)
      set.push(`due_date = $${i++}::date`);     p.push(newDue)
    }
    if (wantsCurrencyChange) {
      set.push(`currency = $${i++}`);            p.push(newCurrency)
      set.push(`exchange_rate_id = $${i++}`);    p.push(newExchangeRateId)
      set.push(`exchange_rate_value = $${i++}`); p.push(newExchangeRateValue)
    }
    if (wantsAmountChange) {
      set.push(`subtotal = $${i++}`);  p.push(newSubtotal)
      set.push(`tax = $${i++}`);       p.push(newTax)
      set.push(`total = $${i++}`);     p.push(newTotal)
    }
    if (affectsMxn) {
      set.push(`total_mxn = $${i++}`); p.push(newTotalMxn)
      set.push(`balance = $${i++}`);   p.push(newTotalMxn)   // sin pagos → balance = total
    }
    if (set.length === 0) throw createError(400, 'No hay campos para actualizar.')
    set.push(`updated_at = NOW()`)
    p.push(id, tenantId)
    const { rows: upd } = await client.query(
      `UPDATE supplier_invoices SET ${set.join(', ')} WHERE id = $${i++} AND tenant_id = $${i} RETURNING *`,
      p
    )

    // Sync del CXP (monto, proveedor, folio, fechas)
    if (inv.ap_id) {
      const apSet = []; const ap = []; let j = 1
      if (affectsMxn)                   { apSet.push(`amount_total = $${j++}`);    ap.push(newTotalMxn) }
      if (wantsCurrencyChange) {
        apSet.push(`currency = $${j++}`);      ap.push(newCurrency)
        apSet.push(`exchange_rate = $${j++}`); ap.push(newExchangeRateValue || 1)
      }
      if (supplierId !== undefined)     { apSet.push(`partner_id = $${j++}`);      ap.push(supplierId || null) }
      if (documentNumber !== undefined) { apSet.push(`document_number = $${j++}`); ap.push(documentNumber || inv.invoice_number) }
      if (invoiceDate !== undefined) {
        apSet.push(`issue_date = $${j++}::date`); ap.push(newIssue)
        apSet.push(`due_date = $${j++}::date`);   ap.push(newDue)
      }
      if (apSet.length) {
        ap.push(inv.ap_id, tenantId)
        await client.query(
          `UPDATE accounts_payable SET ${apSet.join(', ')} WHERE id = $${j++} AND tenant_id = $${j}`, ap)
      }
    } else if (upd[0].partner_id) {
      // El gasto era genérico (sin CXP) y ahora tiene proveedor → generar la CXP
      // que faltaba (registerInvoice solo la crea cuando hay supplierId). Deja
      // este camino consistente con assignExpenseSupplier.
      await client.query(
        `INSERT INTO accounts_payable
           (tenant_id, partner_id, document_type, document_id, document_number,
            currency, exchange_rate, amount_total, issue_date, due_date, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         ON CONFLICT (tenant_id, document_type, document_id) DO NOTHING`,
        [tenantId, upd[0].partner_id,
         upd[0].type === 'remission' ? 'remission' : 'invoice',
         id, upd[0].invoice_number,
         upd[0].currency, upd[0].exchange_rate_value || 1, upd[0].total_mxn,
         upd[0].invoice_date, upd[0].due_date, userId]
      )
    }

    await audit({
      tenantId, userId, action: 'supplier_expense.updated',
      resource: 'supplier_invoices', resourceId: id,
      payload: { wantsAmountChange, newTotal }, ipAddress, userAgent,
    })
    return upd[0]
  })
}

/**
 * Cancela un GASTO (supplier_invoice is_expense=true) + su CXP. NO se permite si
 * ya tiene un pago aplicado (orfandaría el pago — la reversa de pago de proveedor
 * es una pieza aparte aún no construida). No borra el registro (status=cancelled);
 * el listado y el saldo de CXP ya excluyen los cancelados.
 */
async function cancelExpense({ tenantId, id, userId, reason, ipAddress, userAgent }) {
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT si.id, si.status, si.invoice_number,
              ap.id AS ap_id, ap.amount_paid AS ap_amount_paid
         FROM supplier_invoices si
         LEFT JOIN accounts_payable ap ON ap.document_id = si.id AND ap.tenant_id = si.tenant_id
        WHERE si.id = $1 AND si.tenant_id = $2 AND si.is_expense = true
        FOR UPDATE OF si`,
      [id, tenantId]
    )
    if (!rows.length) throw createError(404, 'Gasto no encontrado.')
    const inv = rows[0]
    if (inv.status === 'cancelled') return { ...inv, status: 'cancelled' } // idempotente
    if (parseFloat(inv.ap_amount_paid || 0) > 0) {
      throw createError(409, 'El gasto tiene un pago aplicado. Reversa el pago antes de cancelar.')
    }

    await client.query(
      `UPDATE supplier_invoices
          SET status = 'cancelled', updated_at = NOW(),
              notes = COALESCE(notes, '') || $3
        WHERE id = $1 AND tenant_id = $2`,
      [id, tenantId, reason ? `\n[Cancelado] ${reason}` : '\n[Cancelado]']
    )
    if (inv.ap_id) {
      await client.query(
        `UPDATE accounts_payable SET status = 'cancelled' WHERE id = $1 AND tenant_id = $2`,
        [inv.ap_id, tenantId])
    }

    await audit({
      tenantId, userId, action: 'supplier_expense.cancelled',
      resource: 'supplier_invoices', resourceId: id,
      payload: { reason: reason || null }, ipAddress, userAgent,
    })
    return { ...inv, status: 'cancelled' }
  })
}

/**
 * Vincular un GASTO existente a una recepción → reclasificarlo EN SU LUGAR como
 * FACTURA DE COMPRA ligada (mitad manual de la Fase 5A; corazón de la 5B). Útil
 * cuando un CFDI de mercancía entró por correo como gasto suelto y debe amarrarse
 * a su recepción (evita doble CXP).
 *
 * Reusa EXACTAMENTE el enlace + sustitución de `registerInvoice` (ver ahí la
 * fuente de verdad) pero aplicado a una supplier_invoice que YA existe (no crea
 * una nueva → no choca con el anti-dup por UUID). Si las dos divergen, cuadrarlas.
 */
async function linkExpenseToReceipt({ tenantId, expenseId, receiptId, receiptLineIds = [], receipts = null, userId, ipAddress, userAgent }) {
  // Normalizar a una LISTA de recepciones. Compat hacia atrás: si llega
  // `receiptId`/`receiptLineIds` (una sola), se envuelve. `receipts` es
  // [{ receiptId, lineIds? }] para vincular a VARIAS de una vez.
  const requested = Array.isArray(receipts) && receipts.length
    ? receipts
    : (receiptId ? [{ receiptId, lineIds: receiptLineIds }] : [])
  const seenReceipt = new Set()
  const reqReceipts = []
  for (const r of requested) {
    if (!r || !r.receiptId || seenReceipt.has(r.receiptId)) continue
    seenReceipt.add(r.receiptId)
    reqReceipts.push({ receiptId: r.receiptId, lineIds: Array.isArray(r.lineIds) ? r.lineIds : [] })
  }
  if (!reqReceipts.length) throw createError(400, 'Debe indicar al menos una recepción.')

  return withTransaction(async (client) => {
    // 1. El gasto: existe, no cancelado, con proveedor. (Pagado SÍ se permite:
    //    la reclasificación es sobre el mismo registro, su pago viaja con él.)
    const { rows: exp } = await client.query(
      `SELECT si.id, si.status, si.partner_id, si.currency, si.subtotal,
              si.total_mxn, si.exchange_rate_value, si.invoice_number
         FROM supplier_invoices si
        WHERE si.id = $1 AND si.tenant_id = $2 AND si.is_expense = true
        FOR UPDATE OF si`,
      [expenseId, tenantId]
    )
    if (!exp.length) throw createError(404, 'Gasto no encontrado.')
    const e = exp[0]
    if (e.status === 'cancelled') throw createError(409, 'El gasto está cancelado.')
    if (!e.partner_id) throw createError(400, 'El gasto no tiene proveedor del catálogo; no se puede vincular a una recepción.')

    // Subtotal del gasto en MXN (para cobertura por monto y conciliación).
    const round2 = (n) => parseFloat(Number(n || 0).toFixed(2))
    const expenseSubtotalMxn = e.currency === 'USD'
      ? round2(parseFloat(e.subtotal || 0) * parseFloat(e.exchange_rate_value || 1))
      : round2(e.subtotal)
    // Cobertura por MONTO (varias facturas dividen el mismo material) SÓLO aplica al
    // caso de UNA recepción; con varias (una factura cubre N recepciones completas) se
    // mantiene la cobertura por líneas pendientes.
    const singleReceipt = reqReceipts.length === 1

    // 2. Por cada recepción: validar (confirmada, mismo proveedor) y recolectar
    //    las líneas / el monto a cubrir.
    const perReceipt = []
    for (const rr of reqReceipts) {
      const { rows: rc } = await client.query(
        `SELECT sr.id, sr.partner_id, sr.status FROM supplier_receipts sr
          WHERE sr.id = $1 AND sr.tenant_id = $2 FOR UPDATE OF sr`,
        [rr.receiptId, tenantId]
      )
      if (!rc.length) throw createError(404, 'Recepción no encontrada.')
      if (rc[0].status !== 'confirmed') throw createError(409, 'Una recepción seleccionada no está confirmada.')
      if (rc[0].partner_id !== e.partner_id) throw createError(400, 'Una recepción seleccionada es de otro proveedor.')

      if (rr.lineIds.length > 0) {
        // ── Cobertura por LÍNEAS explícitas (materiales distintos) ──
        const { rows } = await client.query(
          `SELECT srl.id, srl.subtotal, ci.type AS cover_type, ci.status AS cover_status
             FROM supplier_receipt_lines srl
             LEFT JOIN supplier_invoices ci ON ci.id = srl.invoiced_by_invoice_id
            WHERE srl.supplier_receipt_id = $1 AND srl.id = ANY($2::uuid[])`,
          [rr.receiptId, rr.lineIds]
        )
        if (rows.length !== rr.lineIds.length) {
          throw createError(400, 'Alguna línea seleccionada no pertenece a su recepción.')
        }
        for (const l of rows) {
          if (l.cover_type === 'invoice' && l.cover_status !== 'cancelled') {
            throw createError(409, 'Alguna línea seleccionada ya está cubierta por otra factura activa.')
          }
        }
        if (!rows.length) continue
        const coverage = round2(rows.reduce((s, l) => s + parseFloat(l.subtotal || 0), 0))
        perReceipt.push({ receiptId: rr.receiptId, lineIds: rows.map(l => l.id), coverage })
      } else if (singleReceipt) {
        // ── Cobertura por MONTO (una recepción, factura parcial) ──
        // Permite que 2+ facturas dividan el MISMO material: cada factura cubre
        // min(su subtotal, saldo por facturar). Los renglones se bloquean SÓLO al
        // completar el 100%, así la recepción reaparece para la siguiente factura.
        const { rows: allLines } = await client.query(
          `SELECT srl.id, srl.subtotal,
                  (srl.invoiced_by_invoice_id IS NULL OR ci.status = 'cancelled' OR ci.type = 'remission') AS pending
             FROM supplier_receipt_lines srl
             LEFT JOIN supplier_invoices ci ON ci.id = srl.invoiced_by_invoice_id
            WHERE srl.supplier_receipt_id = $1`,
          [rr.receiptId]
        )
        const receiptSubtotal = round2(allLines.reduce((s, l) => s + parseFloat(l.subtotal || 0), 0))
        const { rows: cov } = await client.query(
          `SELECT COALESCE(SUM(irl.amount_applied), 0)::numeric AS covered
             FROM invoice_receipt_links irl
             JOIN supplier_invoices si ON si.id = irl.supplier_invoice_id
            WHERE irl.supplier_receipt_id = $1 AND si.tenant_id = $2
              AND si.type = 'invoice' AND si.status <> 'cancelled'`,
          [rr.receiptId, tenantId]
        )
        const alreadyCovered = round2(cov[0].covered)
        const remaining = round2(receiptSubtotal - alreadyCovered)
        if (remaining <= 0.01) continue   // recepción ya facturada por completo
        const cover = Math.min(expenseSubtotalMxn, remaining)
        const fully = (alreadyCovered + cover) >= receiptSubtotal - 0.01
        const pendingLineIds = allLines.filter(l => l.pending).map(l => l.id)
        perReceipt.push({
          receiptId: rr.receiptId,
          lineIds: fully ? pendingLineIds : [],   // sólo se bloquean líneas al completar
          coverage: round2(cover),
        })
      } else {
        // ── Multi-recepción sin líneas: cubre TODAS las pendientes de cada una ──
        const { rows } = await client.query(
          `SELECT srl.id, srl.subtotal
             FROM supplier_receipt_lines srl
             LEFT JOIN supplier_invoices ci ON ci.id = srl.invoiced_by_invoice_id
            WHERE srl.supplier_receipt_id = $1
              AND (srl.invoiced_by_invoice_id IS NULL OR ci.status = 'cancelled' OR ci.type = 'remission')`,
          [rr.receiptId]
        )
        if (!rows.length) continue
        const coverage = round2(rows.reduce((s, l) => s + parseFloat(l.subtotal || 0), 0))
        perReceipt.push({ receiptId: rr.receiptId, lineIds: rows.map(l => l.id), coverage })
      }
    }
    if (!perReceipt.length) {
      throw createError(409, 'Ninguna de las recepciones seleccionadas tiene saldo pendiente de facturar.')
    }
    const affectedReceiptIds = perReceipt.map(p => p.receiptId)
    const coverageSubtotal = round2(perReceipt.reduce((s, p) => s + p.coverage, 0))

    // 3. Reclasificar el gasto → factura de compra. supplier_receipt_id = la 1ª
    //    (campo legado "principal"); la liga real N:N vive en invoice_receipt_links.
    const subtotalMxn = expenseSubtotalMxn
    const reconDiff = round2(subtotalMxn - coverageSubtotal)
    const reconStatus = Math.abs(reconDiff) < 0.01 ? 'reconciled' : 'with_diff'

    await client.query(
      `UPDATE supplier_invoices
          SET is_expense = false, expense_category_id = NULL,
              supplier_receipt_id = $3,
              reconciliation_status = $4, reconciliation_diff = $5, updated_at = NOW()
        WHERE id = $1 AND tenant_id = $2`,
      [expenseId, tenantId, perReceipt[0].receiptId, reconStatus, reconDiff]
    )
    for (const p of perReceipt) {
      await client.query(
        `INSERT INTO invoice_receipt_links (tenant_id, supplier_invoice_id, supplier_receipt_id, amount_applied)
         VALUES ($1,$2,$3,$4) ON CONFLICT (supplier_invoice_id, supplier_receipt_id) DO NOTHING`,
        [tenantId, expenseId, p.receiptId, p.coverage.toFixed(2)]
      )
      await client.query(
        `UPDATE supplier_receipt_lines SET invoiced_by_invoice_id = $1 WHERE id = ANY($2::uuid[])`,
        [expenseId, p.lineIds]
      )
    }

    // 4. Sustitución: anular las REMISIONES-CXP activas de las recepciones
    //    afectadas (guard de pago) → evita doble CXP.
    const { rows: rems } = await client.query(
      `SELECT DISTINCT si.id, si.invoice_number
         FROM supplier_invoices si
         JOIN invoice_receipt_links irl ON irl.supplier_invoice_id = si.id
        WHERE si.tenant_id = $1 AND si.type = 'remission' AND si.status <> 'cancelled'
          AND si.id <> $2 AND irl.supplier_receipt_id = ANY($3::uuid[])`,
      [tenantId, expenseId, affectedReceiptIds]
    )
    const replacedRemissionIds = []
    for (const rem of rems) {
      const { rows: apr } = await client.query(
        `SELECT amount_paid FROM accounts_payable
          WHERE tenant_id = $1 AND document_type = 'remission' AND document_id = $2`,
        [tenantId, rem.id]
      )
      if (parseFloat(apr[0]?.amount_paid || 0) > 0) {
        throw createError(409, `La CXP sin factura ${rem.invoice_number} de una recepción ya tiene pagos aplicados. Reversa el pago antes de vincular.`)
      }
      await client.query(
        `UPDATE supplier_invoices SET status = 'cancelled', replaced_by_invoice_id = $1, updated_at = NOW()
          WHERE id = $2 AND tenant_id = $3`, [expenseId, rem.id, tenantId])
      await client.query(
        `UPDATE accounts_payable SET status = 'cancelled'
          WHERE tenant_id = $1 AND document_type = 'remission' AND document_id = $2`, [tenantId, rem.id])
      await client.query(
        `UPDATE supplier_receipt_lines SET invoiced_by_invoice_id = NULL WHERE invoiced_by_invoice_id = $1`, [rem.id])
      replacedRemissionIds.push(rem.id)
    }

    // 5. Recomputar invoiced_at de cada recepción afectada.
    for (const rid of affectedReceiptIds) {
      await client.query(
        `UPDATE supplier_receipts sr
            SET invoiced_at = CASE WHEN NOT EXISTS (
                  SELECT 1 FROM supplier_receipt_lines srl
                   LEFT JOIN supplier_invoices ci ON ci.id = srl.invoiced_by_invoice_id
                  WHERE srl.supplier_receipt_id = sr.id
                    AND (srl.invoiced_by_invoice_id IS NULL OR ci.status = 'cancelled')
                ) THEN COALESCE(sr.invoiced_at, NOW()) ELSE NULL END
          WHERE sr.id = $1 AND sr.tenant_id = $2`,
        [rid, tenantId]
      )
    }

    await audit({
      tenantId, userId, action: 'supplier_expense.linked_to_receipt',
      resource: 'supplier_invoices', resourceId: expenseId,
      payload: { receiptIds: affectedReceiptIds, coverageSubtotal, reconStatus, reconDiff, replacedRemissionIds },
      ipAddress, userAgent,
    })

    return {
      id: expenseId,
      receiptId: perReceipt[0].receiptId,   // compat
      receiptIds: affectedReceiptIds,
      reconciliation_status: reconStatus, reconciliation_diff: reconDiff,
      replacedRemissionIds,
    }
  })
}

/**
 * DESVINCULA una factura de compra de su(s) recepción(es) y la revierte a GASTO
 * — el inverso de linkExpenseToReceipt. Útil cuando se vinculó a la recepción
 * EQUIVOCADA: se desvincula y luego se vuelve a vincular a la correcta.
 *
 * Deshace todo lo que hizo el enlace:
 *   - libera las líneas que cubría (invoiced_by_invoice_id → NULL),
 *   - RESTAURA las remisiones-CXP que el enlace había sustituido (las re-activa y
 *     re-marca las líneas de su recepción),
 *   - borra los invoice_receipt_links de la factura,
 *   - vuelve el registro a gasto (is_expense=true, sin recepción, sin conciliación),
 *   - recomputa invoiced_at de las recepciones afectadas.
 *
 * El pago (si lo hubiera) viaja con el MISMO registro, igual que al vincular.
 */
async function unlinkInvoiceFromReceipt({ tenantId, expenseId, userId, ipAddress, userAgent }) {
  return withTransaction(async (client) => {
    const { rows: invRows } = await client.query(
      `SELECT id, status FROM supplier_invoices
        WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
      [expenseId, tenantId]
    )
    if (!invRows.length) throw createError(404, 'Factura no encontrada.')
    if (invRows[0].status === 'cancelled') throw createError(409, 'La factura está cancelada.')

    const { rows: links } = await client.query(
      `SELECT supplier_receipt_id FROM invoice_receipt_links
        WHERE tenant_id = $1 AND supplier_invoice_id = $2`,
      [tenantId, expenseId]
    )
    if (!links.length) throw createError(409, 'Esta factura no está vinculada a ninguna recepción.')
    const affectedReceiptIds = links.map(l => l.supplier_receipt_id)

    // 1. Liberar las líneas que cubría esta factura.
    await client.query(
      `UPDATE supplier_receipt_lines SET invoiced_by_invoice_id = NULL WHERE invoiced_by_invoice_id = $1`,
      [expenseId]
    )

    // 2. Restaurar las remisiones-CXP que ESTA factura había sustituido al vincularse
    //    — PERO sólo si la recepción de la remisión ya NO tiene otra factura real
    //    activa cubriéndola. Con facturación parcial por monto (varias facturas al
    //    mismo material), al desvincular una puede quedar otra vigente → revivir la
    //    remisión duplicaría la CXP.
    const { rows: rems } = await client.query(
      `SELECT r.id, irl.supplier_receipt_id
         FROM supplier_invoices r
         JOIN invoice_receipt_links irl ON irl.supplier_invoice_id = r.id
        WHERE r.tenant_id = $1 AND r.type = 'remission'
          AND r.replaced_by_invoice_id = $2 AND r.status = 'cancelled'`,
      [tenantId, expenseId]
    )
    const restoredRemissionIds = []
    for (const rem of rems) {
      const { rows: others } = await client.query(
        `SELECT 1 FROM invoice_receipt_links irl
           JOIN supplier_invoices si ON si.id = irl.supplier_invoice_id
          WHERE irl.supplier_receipt_id = $1 AND si.tenant_id = $2
            AND si.type = 'invoice' AND si.status <> 'cancelled' AND si.id <> $3
          LIMIT 1`,
        [rem.supplier_receipt_id, tenantId, expenseId]
      )
      if (others.length) continue   // otra factura sigue cubriendo → NO revivir la remisión
      await client.query(
        `UPDATE supplier_invoices SET status = 'pending', replaced_by_invoice_id = NULL, updated_at = NOW()
          WHERE id = $1 AND tenant_id = $2`, [rem.id, tenantId])
      await client.query(
        `UPDATE accounts_payable SET status = 'pending'
          WHERE tenant_id = $1 AND document_type = 'remission' AND document_id = $2`, [tenantId, rem.id])
      // La remisión vuelve a cubrir las líneas (ahora libres) de su recepción.
      await client.query(
        `UPDATE supplier_receipt_lines srl
            SET invoiced_by_invoice_id = $1
           FROM invoice_receipt_links irl
          WHERE irl.supplier_invoice_id = $1
            AND irl.supplier_receipt_id = srl.supplier_receipt_id
            AND srl.invoiced_by_invoice_id IS NULL`, [rem.id])
      restoredRemissionIds.push(rem.id)
    }

    // 3. Quitar los enlaces de la factura.
    await client.query(
      `DELETE FROM invoice_receipt_links WHERE tenant_id = $1 AND supplier_invoice_id = $2`,
      [tenantId, expenseId]
    )

    // 4. Revertir el registro → GASTO (el usuario lo re-vincula o reclasifica).
    await client.query(
      `UPDATE supplier_invoices
          SET is_expense = true, supplier_receipt_id = NULL,
              reconciliation_status = 'pending', reconciliation_diff = NULL, updated_at = NOW()
        WHERE id = $1 AND tenant_id = $2`, [expenseId, tenantId]
    )

    // 5. Recomputar invoiced_at de cada recepción afectada.
    for (const rid of affectedReceiptIds) {
      await client.query(
        `UPDATE supplier_receipts sr
            SET invoiced_at = CASE WHEN NOT EXISTS (
                  SELECT 1 FROM supplier_receipt_lines srl
                   LEFT JOIN supplier_invoices ci ON ci.id = srl.invoiced_by_invoice_id
                  WHERE srl.supplier_receipt_id = sr.id
                    AND (srl.invoiced_by_invoice_id IS NULL OR ci.status = 'cancelled')
                ) THEN COALESCE(sr.invoiced_at, NOW()) ELSE NULL END
          WHERE sr.id = $1 AND sr.tenant_id = $2`,
        [rid, tenantId]
      )
    }

    await audit({
      tenantId, userId, action: 'supplier_expense.unlinked_from_receipt',
      resource: 'supplier_invoices', resourceId: expenseId,
      payload: { receiptIds: affectedReceiptIds, restoredRemissionIds },
      ipAddress, userAgent,
    })

    return { id: expenseId, receiptIds: affectedReceiptIds, restoredRemissionIds }
  })
}

// Tolerancia de monto para SUGERIR que un gasto cuadra con una recepción (±2%).
const RECEIPT_SUGGEST_TOLERANCE = 0.02

/**
 * SUGIERE (no liga) la recepción pendiente de factura que corresponde a un gasto
 * de mercancía. Reemplaza al auto-link de la 5A: como vincular es IRREVERSIBLE y
 * toca CXP/inventario, no se hace solo — se sugiere y el humano confirma con
 * `linkExpenseToReceipt`. Mismo criterio: mismo proveedor + MXN + subtotal dentro
 * de ±2% del saldo por facturar + recibida en ventana [fecha −90d, +7d]. Devuelve
 * la recepción SOLO si hay EXACTAMENTE una coincidencia (0/varias → sin sugerencia).
 */
async function suggestReceiptForExpense({ tenantId, expenseId }) {
  const { rows: exp } = await query(
    `SELECT si.partner_id, si.currency, si.subtotal, si.invoice_date, si.is_expense, si.status,
            ap.amount_paid AS ap_amount_paid
       FROM supplier_invoices si
       LEFT JOIN accounts_payable ap ON ap.document_id = si.id AND ap.tenant_id = si.tenant_id
      WHERE si.id = $1 AND si.tenant_id = $2`,
    [expenseId, tenantId])
  if (!exp.length) throw createError(404, 'Gasto no encontrado.')
  const e = exp[0]
  const subtotal = parseFloat(e.subtotal || 0)
  // Gastos vivos (incluso ya pagados — se pueden vincular), MXN, con proveedor y
  // subtotal > 0. El pago no impide vincular (viaja con el registro).
  if (!e.is_expense || e.status === 'cancelled'
      || e.currency !== 'MXN' || !e.partner_id || !(subtotal > 0)) {
    return { suggestion: null, candidateCount: 0 }
  }
  const { rows } = await query(
    `SELECT sr.id, sr.receipt_number, sr.received_date,
            COALESCE((
              SELECT SUM(srl.subtotal) FROM supplier_receipt_lines srl
                LEFT JOIN supplier_invoices ci ON ci.id = srl.invoiced_by_invoice_id
               WHERE srl.supplier_receipt_id = sr.id
                 AND (srl.invoiced_by_invoice_id IS NULL OR ci.status = 'cancelled' OR ci.type = 'remission')
            ), 0)::numeric AS total_mxn
       FROM supplier_receipts sr
       LEFT JOIN purchase_orders po ON po.id = sr.purchase_order_id
      WHERE sr.tenant_id = $1
        AND sr.partner_id = $2
        AND sr.status = 'confirmed'
        AND COALESCE(po.currency, 'MXN') = 'MXN'
        AND sr.received_date >= (COALESCE($3::date, CURRENT_DATE) - INTERVAL '90 days')
        AND sr.received_date <= (COALESCE($3::date, CURRENT_DATE) + INTERVAL '7 days')
        AND EXISTS (
          SELECT 1 FROM supplier_receipt_lines srl
            LEFT JOIN supplier_invoices ci ON ci.id = srl.invoiced_by_invoice_id
           WHERE srl.supplier_receipt_id = sr.id
             AND (srl.invoiced_by_invoice_id IS NULL OR ci.status = 'cancelled' OR ci.type = 'remission')
        )`,
    [tenantId, e.partner_id, e.invoice_date])
  const tol = subtotal * RECEIPT_SUGGEST_TOLERANCE
  const close = rows.filter(r => Math.abs(parseFloat(r.total_mxn) - subtotal) <= tol)
  return { suggestion: close.length === 1 ? close[0] : null, candidateCount: close.length }
}

/**
 * Solicita al proveedor (por correo) la factura de un gasto registrado SIN CFDI.
 * Manda un correo a los contactos del proveedor con email y marca
 * invoice_requested_at. Reusa enqueueEmail + el template de Gastos.
 */
async function requestExpenseInvoice({ tenantId, id, userId, ipAddress, userAgent }) {
  const { rows } = await query(
    `SELECT si.id, si.status, si.uuid_sat, si.partner_id, si.invoice_number,
            si.total, si.currency, si.invoice_date, si.notes, si.is_expense,
            bp.name AS partner_name, bp.tax_name AS partner_tax_name,
            ec.name AS category_name,
            t.name AS tenant_name, t.brand_color_primary, t.notification_email
       FROM supplier_invoices si
       LEFT JOIN business_partners bp ON bp.id = si.partner_id
       LEFT JOIN tenant_expense_categories ec ON ec.id = si.expense_category_id
       LEFT JOIN tenants t ON t.id = si.tenant_id
      WHERE si.id = $1 AND si.tenant_id = $2 AND si.is_expense = true`,
    [id, tenantId]
  )
  if (!rows.length) throw createError(404, 'Gasto no encontrado.')
  const exp = rows[0]
  if (exp.status === 'cancelled') throw createError(409, 'El gasto está cancelado.')
  if (exp.uuid_sat) throw createError(400, 'Este gasto ya tiene factura (CFDI).')
  if (!exp.partner_id) throw createError(400, 'El gasto no tiene un proveedor del catálogo a quien solicitarle la factura.')

  // Correos del proveedor (contactos con email; primario primero)
  const { rows: contacts } = await query(
    `SELECT email FROM business_partner_contacts
      WHERE business_partner_id = $1 AND email IS NOT NULL AND email <> ''
      ORDER BY is_primary DESC NULLS LAST, id ASC`,
    [exp.partner_id]
  )
  const recipients = contacts.map(c => c.email).filter(Boolean)
  if (!recipients.length) {
    throw createError(400, 'El proveedor no tiene contactos con correo. Captura uno en Socios para poder solicitar la factura.')
  }

  // Copia/responder-a: notification_email del tenant, o el correo del usuario.
  let senderEmail = exp.notification_email || null
  if (!senderEmail && userId) {
    const { rows: u } = await query(`SELECT email FROM users WHERE id = $1 AND tenant_id = $2`, [userId, tenantId])
    senderEmail = u[0]?.email || null
  }
  if (senderEmail && recipients.includes(senderEmail)) senderEmail = null

  const tenantName = exp.tenant_name || 'Emisor'
  const html = expenseInvoiceRequestEmail({
    tenantName, brandColor: exp.brand_color_primary || null,
    supplierName: exp.partner_tax_name || exp.partner_name || '',
    concept: exp.category_name || exp.notes || 'Gasto',
    folio: exp.invoice_number,
    total: exp.total, currency: exp.currency || 'MXN',
    expenseDate: exp.invoice_date,
  })

  await enqueueEmail({
    tenantId, to: recipients,
    bcc: senderEmail || undefined, replyTo: senderEmail || undefined,
    subject: `Solicitud de factura — ${tenantName}`,
    html, fromName: tenantName,
  })

  const { rows: upd } = await query(
    `UPDATE supplier_invoices SET invoice_requested_at = NOW(), updated_at = NOW()
      WHERE id = $1 AND tenant_id = $2 RETURNING invoice_requested_at`,
    [id, tenantId]
  )

  await audit({
    tenantId, userId, action: 'supplier_expense.invoice_requested',
    resource: 'supplier_invoices', resourceId: id,
    payload: { sentTo: recipients }, ipAddress, userAgent,
  })

  return { requested_at: upd[0].invoice_requested_at, sentTo: recipients }
}

function createError(status, message) {
  const err = new Error(message)
  err.status = status
  return err
}

/**
 * Obtiene el XML del CFDI guardado de un gasto/factura. Fuente, en orden:
 *   1. `supplier_invoices.xml_content` (lo guarda el alta por "Cargar XML").
 *   2. el adjunto categoría 'cfdi' tipo XML (lo guarda el buzón de correo, mig 213).
 * Devuelve el string XML o null (gasto manual o sólo PDF).
 */
async function loadStoredCfdiXml({ tenantId, id, xmlContent }) {
  let xml = xmlContent || null
  if (!xml) {
    const atts = await attachmentService.listAttachments({
      tenantId, entityType: 'supplier_invoice', entityId: id, category: 'cfdi',
    })
    const xmlAtt = (atts || []).find(a =>
      /xml/i.test(a.mime_type || '') || /\.xml$/i.test(a.filename || ''))
    if (xmlAtt) {
      const info = await attachmentService.getAttachmentInfo({ tenantId, attachmentId: xmlAtt.id })
      if (info?.storage_path) {
        try {
          const buf = await storage.fetchBuffer(info.storage_path)
          if (buf) xml = buf.toString('utf8')
        } catch { /* sin XML descargable → null */ }
      }
    }
  }
  return xml
}

/**
 * Devuelve los CONCEPTOS (líneas) del CFDI de un gasto/factura para
 * previsualizarlos, parseando el XML guardado (ver loadStoredCfdiXml).
 * Si no hay XML (gasto manual o sólo PDF) → lines vacío + hasXml=false.
 */
async function getExpenseConceptos({ tenantId, id }) {
  const { rows } = await query(
    `SELECT xml_content FROM supplier_invoices WHERE id = $1 AND tenant_id = $2`,
    [id, tenantId]
  )
  if (!rows.length) throw createError(404, 'Documento no encontrado.')

  const xml = await loadStoredCfdiXml({ tenantId, id, xmlContent: rows[0].xml_content })
  if (!xml) return { lines: [], hasXml: false }

  try {
    const parsed = await documentParserService.parseSupplierDocument(
      Buffer.from(xml), 'application/xml', 'cfdi.xml')
    return { lines: parsed?.lines || [], hasXml: true }
  } catch {
    return { lines: [], hasXml: false }
  }
}

/**
 * Vuelve a leer el CFDI (XML guardado) de un gasto y recupera los datos del EMISOR
 * (razón social + RFC) que la ingesta por PDF pudo perder — el caso "Proveedor
 * (correo)" cuando el correo trajo XML+PDF separados y el PDF se procesó primero.
 * Si el gasto sigue GENÉRICO (sin proveedor, sin CXP) también refresca los totales
 * desde el XML (arregla desgloses mal leídos, ej. subtotal/IVA en $0).
 *
 * NO auto-vincula a un proveedor del catálogo: si el RFC ya existe, el detalle del
 * gasto genérico ofrece "Crear proveedor con estos datos" (dedup por RFC). Sólo toca
 * los totales cuando NO hay CXP → nunca desincroniza una cuenta por pagar. Idempotente:
 * releer el mismo XML no cambia nada si el gasto ya estaba correcto.
 *
 * @returns {{ updated:boolean, changed:object, name?:string, rfc?:string }}
 */
async function reReadExpenseFromXml({ tenantId, id, userId, ipAddress, userAgent }) {
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT si.*, ap.id AS ap_id, ap.amount_paid AS ap_amount_paid
         FROM supplier_invoices si
         LEFT JOIN accounts_payable ap ON ap.document_id = si.id AND ap.tenant_id = si.tenant_id
        WHERE si.id = $1 AND si.tenant_id = $2 AND si.is_expense = true
        FOR UPDATE OF si`,
      [id, tenantId]
    )
    if (!rows.length) throw createError(404, 'Gasto no encontrado.')
    const exp = rows[0]
    if (exp.status === 'cancelled') throw createError(409, 'No se puede releer un gasto cancelado.')

    const xml = await loadStoredCfdiXml({ tenantId, id, xmlContent: exp.xml_content })
    if (!xml) throw createError(400, 'Este gasto no tiene un XML guardado para releer.')

    let parsed
    try {
      parsed = await documentParserService.parseSupplierDocument(
        Buffer.from(xml), 'application/xml', 'cfdi.xml')
    } catch {
      throw createError(422, 'No se pudo leer el XML guardado.')
    }

    const emisorName = (parsed?.emisor?.name || '').trim()
    const emisorRfc  = (parsed?.emisor?.rfc || '').toUpperCase().replace(/\s+/g, '').trim()

    const set = []; const p = []; let i = 1
    const changed = {}

    // Identidad del emisor: sólo si el gasto sigue genérico (sin proveedor asignado).
    if (!exp.partner_id) {
      if (emisorName && emisorName !== (exp.generic_supplier || '')) {
        set.push(`generic_supplier = $${i++}`); p.push(emisorName); changed.name = emisorName
      }
      if (emisorRfc && emisorRfc !== (exp.rfc_emisor || '')) {
        set.push(`rfc_emisor = $${i++}`); p.push(emisorRfc); changed.rfc = emisorRfc
      }
    }

    // Serie, folio y número de factura visible: identificadores del documento, SIN
    // impacto contable → se corrigen SIEMPRE (aunque el proveedor ya esté
    // identificado o haya CXP/pago). El "folio" que ve el usuario es invoice_number,
    // que la ingesta arma como "SERIE-FOLIO"; lo re-derivamos igual desde el CFDI.
    const pSerie = (parsed?.serie || '').toString().trim()
    const pFolio = (parsed?.folio || '').toString().trim()
    if (pSerie && pSerie !== (exp.serie || '')) {
      set.push(`serie = $${i++}`); p.push(pSerie.slice(0, 10)); changed.serie = pSerie
    }
    if (pFolio && pFolio !== (exp.folio || '')) {
      set.push(`folio = $${i++}`); p.push(pFolio.slice(0, 20)); changed.folio = pFolio
    }
    const xmlDocNumber = [pSerie, pFolio].filter(Boolean).join('-')
    let newInvoiceNumber = null
    if (xmlDocNumber && xmlDocNumber !== (exp.invoice_number || '')) {
      newInvoiceNumber = xmlDocNumber
      set.push(`invoice_number = $${i++}`); p.push(xmlDocNumber); changed.folioNumber = xmlDocNumber
    }

    // Totales: re-sincronizan sólo si NO hay CXP ni pagos → no desincroniza nada.
    // Si difieren pero el gasto ya tiene CXP/pago, no se tocan (rompería la
    // contabilidad) pero se REPORTA el desfase para que el usuario decida.
    const amountPaid = parseFloat(exp.ap_amount_paid || 0)
    const pSub = Number(parsed?.subtotal || 0)
    const pTax = Number(parsed?.tax || 0)
    const pTot = Number(parsed?.total || (pSub + pTax))
    const totalsDiffer = pTot > 0 && (
      Math.abs(pTot - parseFloat(exp.total || 0)) > 0.005 ||
      Math.abs(pSub - parseFloat(exp.subtotal || 0)) > 0.005)
    if (totalsDiffer) {
      if (!exp.ap_id && amountPaid === 0) {
        const rate = exp.currency === 'USD' ? parseFloat(exp.exchange_rate_value || 1) : 1
        const totMxn = parseFloat((pTot * rate).toFixed(2))
        set.push(`subtotal = $${i++}`);  p.push(pSub)
        set.push(`tax = $${i++}`);       p.push(pTax)
        set.push(`total = $${i++}`);     p.push(pTot)
        set.push(`total_mxn = $${i++}`); p.push(totMxn)
        set.push(`balance = $${i++}`);   p.push(totMxn)
        changed.totals = { subtotal: pSub, tax: pTax, total: pTot }
      } else {
        // No se aplica: hay CXP o pagos. Solo aviso (no altera `set`).
        changed.totalsBlocked = { xmlTotal: pTot, current: parseFloat(exp.total || 0) }
      }
    }

    if (!set.length) {
      // Puede traer `totalsBlocked` como aviso aunque no se actualice nada.
      return { updated: false, changed, name: exp.generic_supplier, rfc: exp.rfc_emisor }
    }

    set.push(`updated_at = NOW()`)
    p.push(id, tenantId)
    let upd
    try {
      const r = await client.query(
        `UPDATE supplier_invoices SET ${set.join(', ')} WHERE id = $${i++} AND tenant_id = $${i} RETURNING *`,
        p
      )
      upd = r.rows
    } catch (e) {
      // Unique (tenant_id, partner_id, invoice_number) excl. canceladas (mig 215):
      // el folio corregido choca con otra factura activa del mismo proveedor.
      if (e.code === '23505' && newInvoiceNumber) {
        throw createError(409,
          `Ya existe otra factura activa de este proveedor con folio ${newInvoiceNumber}. ` +
          `Revisa si es un duplicado antes de re-leer el XML.`)
      }
      throw e
    }

    // Mantener el folio de la CXP en sync con el nuevo invoice_number (mismo
    // criterio que updateExpense). El monto no cambia aquí.
    if (newInvoiceNumber && exp.ap_id) {
      await client.query(
        `UPDATE accounts_payable SET document_number = $1 WHERE id = $2 AND tenant_id = $3`,
        [newInvoiceNumber, exp.ap_id, tenantId])
    }

    await audit({
      tenantId, userId, action: 'supplier_expense.reread_xml',
      resource: 'supplier_invoices', resourceId: id,
      payload: changed, ipAddress, userAgent,
    })

    return {
      updated: true, changed,
      name: upd[0].generic_supplier, rfc: upd[0].rfc_emisor,
    }
  })
}

module.exports = {
  registerInvoice, generateReceiptRemission, listInvoices, getInvoice, listExpenses,
  listExpensesSummary, getExpense, updateExpense, cancelExpense, linkExpenseToReceipt,
  assignExpenseSupplier, payExpense, getExpenseConceptos, reReadExpenseFromXml,
  suggestReceiptForExpense, requestExpenseInvoice, registerPayment, reverseSupplierPayment, getSupplierStatement,
  unlinkInvoiceFromReceipt,
}
