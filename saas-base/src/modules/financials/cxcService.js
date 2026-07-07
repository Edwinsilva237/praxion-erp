'use strict'

const { query, withTransaction } = require('../../db')
const { audit }                  = require('../../utils/audit')
const { stampPaymentComplement, stampPaymentComplementGroup, cancelComplement, maybeAutoSendComplement } = require('../invoicing/paymentComplementService')
const { buildOrderBy } = require('../../utils/sortOrder')
const { LOCAL_TODAY } = require('../../utils/sqlTime')
const logger = require('../../config/logger')

// Orden de la lista CXC (default: vencimiento más próximo arriba = cobranza).
const CXC_SORT_COLUMNS = {
  vencimiento: 'ar.due_date',
  fecha:    'ar.issue_date',
  folio:    'ar.document_number',
  cliente:  'bp.name',
  estatus:  'ar.status',
  total:    'ar.amount_total',
  pendiente:'ar.amount_pending',
}

// Orden del historial de cobros (default: pago más reciente arriba).
const AR_PAYMENT_SORT_COLUMNS = {
  fecha:   'arp.payment_date',
  cliente: 'bp.name',
  folio:   'ar.document_number',
  metodo:  'arp.payment_method',
  monto:   'arp.amount',
}

// Mapeo método de pago interno (modal CXC) → forma de pago SAT (CFDI tipo P)
const METHOD_TO_SAT_FORM = {
  cash:     '01',
  check:    '02',
  transfer: '03',
}

// ─── CXC — Estado de cuenta de cliente ───────────────────────────────────────

/**
 * Estado de cuenta de un cliente.
 * Incluye documentos pendientes, pagos y resumen.
 */
async function getCustomerStatement({ tenantId, partnerId, from, to }) {
  const params = [tenantId, partnerId]
  const filters = []
  if (from) { params.push(from); filters.push(`ar.issue_date >= $${params.length}`) }
  if (to)   { params.push(to);   filters.push(`ar.issue_date <= $${params.length}`) }
  const where = filters.length ? `AND ${filters.join(' AND ')}` : ''

  const { rows: documents } = await query(
    `SELECT ar.id, ar.document_type, ar.document_number,
            ar.issue_date, ar.due_date, ar.status,
            ar.amount_total, ar.amount_paid, ar.amount_pending,
            CASE WHEN ar.due_date < ${LOCAL_TODAY} AND ar.status NOT IN ('paid','cancelled')
              THEN true ELSE false END AS is_overdue,
            -- Datos fiscales del documento origen (solo cuando es factura).
            -- Sirven para que el modal de pago bloquee las PPD timbradas
            -- (que deben cobrarse por el flujo de complemento de pago).
            inv.payment_method AS invoice_payment_method,
            inv.status         AS invoice_status,
            inv.id             AS invoice_id
     FROM accounts_receivable ar
     LEFT JOIN invoices inv ON inv.id = ar.document_id AND ar.document_type = 'invoice'
     WHERE ar.tenant_id = $1 AND ar.partner_id = $2 ${where}
     ORDER BY ar.due_date ASC, ar.issue_date ASC`,
    params
  )

  const { rows: totals } = await query(
    `SELECT
       COALESCE(SUM(amount_total),   0) AS total_invoiced,
       COALESCE(SUM(amount_paid),    0) AS total_paid,
       COALESCE(SUM(amount_pending), 0) AS total_pending,
       COUNT(*) FILTER (WHERE status = 'pending')                                          AS docs_pending,
       COUNT(*) FILTER (WHERE status = 'partial')                                          AS docs_partial,
       COUNT(*) FILTER (WHERE due_date < ${LOCAL_TODAY} AND status NOT IN ('paid','cancelled')) AS docs_overdue
     FROM accounts_receivable
     WHERE tenant_id = $1 AND partner_id = $2`,
    [tenantId, partnerId]
  )

  // Anticipos disponibles
  const { rows: advances } = await query(
    `SELECT id, amount, amount_applied, amount_available, receipt_date, payment_method, reference
     FROM ar_advances
     WHERE tenant_id = $1 AND partner_id = $2 AND amount_applied < amount
     ORDER BY receipt_date ASC`,
    [tenantId, partnerId]
  )

  return { documents, summary: totals[0], advances }
}

/**
 * Lista CXC con filtros.
 *
 * `complement_status` se calcula por documento:
 *   - 'not_applicable' → no es factura (remisión, NC, etc.)
 *   - 'not_required'   → factura PUE (no necesita complemento)
 *   - 'cancelled'      → factura cancelada
 *   - 'draft'          → factura PPD sin timbrar todavía
 *   - 'pending'        → factura PPD timbrada, aún sin complementos
 *   - 'partial'        → suma de complementos < amount_paid
 *   - 'complete'       → suma de complementos cubre amount_paid (con tolerancia 0.01)
 */
async function listCXC({ tenantId, status, partnerId, from, to, search, sortBy, sortDir, page = 1, limit = 50 }) {
  const offset = (page - 1) * limit
  const params = [tenantId]
  const filters = []
  const orderBy = buildOrderBy({
    sortBy, sortDir, columns: CXC_SORT_COLUMNS, defaultKey: 'vencimiento', defaultDir: 'asc', tiebreaker: 'ar.id DESC',
  })

  if (status) {
    params.push(status); filters.push(`ar.status = $${params.length}`)
  } else {
    // Sin filtro explícito, ocultar cancelados — quedan accesibles eligiendo
    // "Cancelado" en el dropdown del listado.
    filters.push(`ar.status <> 'cancelled'`)
  }
  if (partnerId) { params.push(partnerId); filters.push(`ar.partner_id = $${params.length}`) }
  if (from)      { params.push(from);      filters.push(`ar.issue_date >= $${params.length}`) }
  if (to)        { params.push(to);        filters.push(`ar.issue_date <= $${params.length}`) }
  // Búsqueda libre server-side (folio / cliente / RFC) sobre TODA la cartera,
  // no solo la página cargada.
  if (search && String(search).trim()) {
    params.push(`%${String(search).trim()}%`)
    filters.push(`(ar.document_number ILIKE $${params.length}
                   OR bp.name ILIKE $${params.length}
                   OR bp.rfc ILIKE $${params.length})`)
  }

  const where = filters.length ? `AND ${filters.join(' AND ')}` : ''
  params.push(limit, offset)

  const { rows } = await query(
    `SELECT ar.id, ar.document_type, ar.document_number,
            ar.issue_date, ar.due_date, ar.status,
            ar.amount_total, ar.amount_paid, ar.amount_pending,
            bp.name AS partner_name, bp.rfc AS partner_rfc,
            inv.payment_method AS invoice_payment_method,
            inv.status         AS invoice_status,
            COALESCE(pc.complement_total, 0) AS complement_total,
            CASE
              WHEN ar.document_type <> 'invoice' THEN 'not_applicable'
              WHEN inv.status = 'cancelled'      THEN 'cancelled'
              WHEN inv.payment_method = 'PUE'    THEN 'not_required'
              WHEN inv.status <> 'stamped'       THEN 'draft'
              WHEN ar.amount_paid <= 0.01        THEN 'pending'
              WHEN COALESCE(pc.complement_total, 0) >= ar.amount_paid - 0.01 THEN 'complete'
              ELSE 'partial'
            END AS complement_status,
            CASE WHEN ar.due_date < ${LOCAL_TODAY} AND ar.status NOT IN ('paid','cancelled')
              THEN true ELSE false END AS is_overdue
     FROM accounts_receivable ar
     JOIN business_partners bp ON bp.id = ar.partner_id
     LEFT JOIN invoices inv ON inv.id = ar.document_id AND ar.document_type = 'invoice'
     LEFT JOIN (
       SELECT invoice_id, SUM(amount) AS complement_total
         FROM payment_complements
        WHERE tenant_id = $1 AND status <> 'cancelled'
        GROUP BY invoice_id
     ) pc ON pc.invoice_id = inv.id
     WHERE ar.tenant_id = $1 ${where}
     ORDER BY ${orderBy}
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  )

  // Conteo + agregados sobre TODO el conjunto filtrado (no solo la página),
  // para que las tarjetas de resumen reflejen la cartera completa.
  const { rows: countRows } = await query(
    `SELECT COUNT(*)                                                            AS count,
            COALESCE(SUM(ar.amount_total),   0)                                 AS total_invoiced,
            COALESCE(SUM(ar.amount_paid),    0)                                 AS total_paid,
            COALESCE(SUM(ar.amount_pending), 0)                                 AS total_pending,
            COUNT(*) FILTER (WHERE ar.due_date < ${LOCAL_TODAY}
                               AND ar.status NOT IN ('paid','cancelled'))       AS docs_overdue
       FROM accounts_receivable ar
       JOIN business_partners bp ON bp.id = ar.partner_id
      WHERE ar.tenant_id = $1 ${where}`,
    params.slice(0, params.length - 2)
  )
  const c = countRows[0]

  return {
    data: rows,
    total: parseInt(c.count, 10),
    summary: {
      total_invoiced: parseFloat(c.total_invoiced) || 0,
      total_paid:     parseFloat(c.total_paid)     || 0,
      total_pending:  parseFloat(c.total_pending)  || 0,
      docs_overdue:   parseInt(c.docs_overdue, 10) || 0,
    },
    page, limit,
  }
}

// ─── Pagos de clientes ────────────────────────────────────────────────────────

/**
 * Registra un pago de cliente y lo aplica a documentos CXC.
 *
 * @param {object} params
 * @param {string} params.partnerId
 * @param {string} params.paymentDate
 * @param {string} params.method        - 'cash' | 'transfer' | 'check' | 'advance_application'
 * @param {string} params.reference     - Requerido para transfer y check
 * @param {number} params.amount
 * @param {string} params.currency
 * @param {string} [params.bankAccountId] - Cuenta bancaria del tenant donde se recibió el dinero
 * @param {Array}  params.applications  - [{ arId, amountApplied }]
 * @param {string} params.notes
 */
async function registerPayment({
  tenantId, partnerId, paymentDate, method, reference,
  amount, currency = 'MXN', bankAccountId = null, applications = [], notes,
  userId, ipAddress, userAgent,
}) {
  const txResult = await withTransaction(async (client) => {
    if (!amount || amount <= 0) throw createError(400, 'amount debe ser mayor a cero.')
    if (!partnerId) throw createError(400, 'partnerId es requerido.')
    if (method === 'check' && !reference) {
      throw createError(400, 'El número de cheque es requerido.')
    }

    // Validar que la cuenta bancaria existe y pertenece al tenant (si se envía).
    if (bankAccountId) {
      const { rows: baRows } = await client.query(
        `SELECT id FROM bank_accounts WHERE id = $1 AND tenant_id = $2 AND active = TRUE`,
        [bankAccountId, tenantId]
      )
      if (!baRows.length) throw createError(400, 'La cuenta bancaria seleccionada no existe o está inactiva.')
    }

    let totalApplied = 0
    const complementsSkipped = []
    // Complementos a timbrar DESPUÉS de confirmar el cobro (fuera de esta
    // transacción). Así una caída de Facturapi NO tira abajo el pago.
    const pendingStamps = []

    // Aplicar pago a documentos CXC
    for (const app of applications) {
      if (!app.arId || !app.amountApplied) continue

      const { rows: arRows } = await client.query(
        `SELECT ar.id, ar.document_type, ar.document_id, ar.document_number,
                ar.currency,
                ar.amount_total, ar.amount_paid, ar.amount_pending, ar.status,
                inv.status              AS invoice_status,
                inv.payment_method      AS invoice_payment_method,
                inv.exchange_rate_value AS invoice_exchange_rate,
                inv.notes               AS invoice_notes
         FROM accounts_receivable ar
         LEFT JOIN invoices inv ON inv.id = ar.document_id AND ar.document_type = 'invoice'
         WHERE ar.id = $1 AND ar.tenant_id = $2 AND ar.partner_id = $3`,
        [app.arId, tenantId, partnerId]
      )
      if (!arRows.length) continue
      const ar = arRows[0]
      if (ar.status === 'paid') continue

      const toApply = Math.min(parseFloat(app.amountApplied), parseFloat(ar.amount_pending))
      if (toApply <= 0) continue

      // Insertar pago en ar_payments
      const { rows: payIns } = await client.query(
        `INSERT INTO ar_payments
           (tenant_id, ar_id, amount, payment_method, reference, payment_date, notes, created_by, bank_account_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         RETURNING id`,
        [tenantId, app.arId, toApply, method, reference || null,
         paymentDate || new Date().toISOString().split('T')[0],
         notes || null, userId, bankAccountId]
      )
      const arPaymentId = payIns[0].id

      // Actualizar CXC
      const newPaid   = parseFloat(ar.amount_paid) + toApply
      const newStatus = newPaid >= parseFloat(ar.amount_total) ? 'paid' : 'partial'
      await client.query(
        `UPDATE accounts_receivable SET amount_paid = $1, status = $2 WHERE id = $3`,
        [newPaid, newStatus, app.arId]
      )

      totalApplied += toApply

      // Decisión de complemento — solo factura PPD timbrada genera CFDI tipo P.
      // Si NO aplica (PUE, draft, remisión) lo dejamos asentado en
      // `complementsSkipped` con la razón para que el frontend pueda explicar
      // qué pasó por cada documento. Si SÍ aplica, NO se timbra aquí: se
      // encola en `pendingStamps` y se timbra DESPUÉS del COMMIT (ver abajo).
      // De esa forma una caída transitoria de Facturapi/PAC no hace rollback
      // del cobro ya recibido — el complemento queda "pendiente" y el operador
      // lo puede timbrar luego con el botón de "Timbrar complemento faltante".
      const skipReasonByCase = (() => {
        if (ar.document_type !== 'invoice')      return 'no es factura (no requiere complemento)'
        if (ar.invoice_status === 'cancelled')   return 'factura cancelada'
        if (ar.invoice_status !== 'stamped')     return 'factura en borrador (timbrarla primero)'
        if (ar.invoice_payment_method !== 'PPD') return 'factura PUE (no requiere complemento)'
        return null
      })()

      if (skipReasonByCase) {
        complementsSkipped.push({
          ar_id:           ar.id,
          document_number: ar.document_number,
          amount:          toApply,
          reason:          skipReasonByCase,
        })
      } else {
        const satForm = METHOD_TO_SAT_FORM[method] || '03'
        pendingStamps.push({
          arPaymentId,
          arId:           ar.id,
          documentNumber: ar.document_number,
          params: {
            tenantId,
            invoiceId:   ar.document_id,
            paymentDate: paymentDate || new Date().toISOString().split('T')[0],
            paymentForm: satForm,
            amount:      toApply,
            currency:    ar.currency || 'MXN',
            reference,
            exchangeRate: ar.currency === 'USD' ? parseFloat(ar.invoice_exchange_rate || 1) : undefined,
            userId,
          },
        })
      }
    }

    // Si hay monto sin aplicar → generar anticipo
    const sinAplicar = parseFloat(amount) - totalApplied
    let advanceId = null
    if (sinAplicar > 0.01) {
      const { rows: advRows } = await client.query(
        `INSERT INTO ar_advances
           (tenant_id, partner_id, amount, payment_method, reference, receipt_date, notes, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         RETURNING id`,
        [tenantId, partnerId, sinAplicar, method, reference || null,
         paymentDate || new Date().toISOString().split('T')[0],
         notes || null, userId]
      )
      advanceId = advRows[0].id
    }

    // El cobro queda COMMITeado aquí. El timbrado de complementos se hace
    // fuera de esta transacción (ver más abajo).
    return { totalApplied, sinAplicar, advanceId, pendingStamps, complementsSkipped }
  })

  // ── Post-commit: timbrar complementos (best-effort) ─────────────────────────
  // El cobro YA quedó registrado. Como un mismo pago puede liquidar VARIAS
  // facturas PPD, las que comparten moneda se agrupan en UN solo REP (CFDI tipo
  // P con un DoctoRelacionado por factura). Cada grupo se timbra en su propia
  // transacción para que un fallo en uno no afecte a los demás ni al cobro.
  // Si Facturapi falla (transitorio o por datos), el grupo queda PENDIENTE y se
  // reporta al operador, que puede timbrarlo luego con "Timbrar complemento
  // faltante".
  const { totalApplied, sinAplicar, advanceId, pendingStamps, complementsSkipped } = txResult
  const complementsIssued = []
  const complementsPending = []

  // Agrupar por moneda — un REP no puede mezclar monedas en su Pago.
  const groupsByCurrency = new Map()
  for (const job of pendingStamps) {
    const cur = job.params.currency || 'MXN'
    if (!groupsByCurrency.has(cur)) groupsByCurrency.set(cur, [])
    groupsByCurrency.get(cur).push(job)
  }

  for (const [currency, jobs] of groupsByCurrency) {
    const first = jobs[0].params
    try {
      const rows = await withTransaction(async (client) => {
        const res = await stampPaymentComplementGroup(client, {
          tenantId,
          documents:    jobs.map(j => ({ invoiceId: j.params.invoiceId, amount: j.params.amount })),
          paymentDate:  first.paymentDate,
          paymentForm:  first.paymentForm,
          currency,
          reference:    first.reference,
          exchangeRate: first.exchangeRate,
          userId,
        })
        // Liga determinista cada cobro ↔ su fila de complemento (reversa precisa).
        const rowByInvoice = new Map(res.map(r => [r.invoice_id, r]))
        for (const j of jobs) {
          const row = rowByInvoice.get(j.params.invoiceId)
          if (row) {
            await client.query(
              `UPDATE ar_payments SET payment_complement_id = $1 WHERE id = $2`,
              [row.id, j.arPaymentId]
            )
          }
        }
        return res
      })
      complementsIssued.push(...rows)

      // Auto-envío del complemento si el cliente lo tiene activado (espejo del
      // auto-send de facturas). Un grupo = un REP = un facturapi_id. Best-effort.
      if (rows.length) {
        try {
          await maybeAutoSendComplement({
            tenantId, partnerId,
            complementFacturapiId: rows[0].facturapi_id,
            userId, ipAddress, userAgent,
          })
        } catch (err) {
          logger.warn('Auto-envío de complemento falló', {
            tenantId, facturapi_id: rows[0].facturapi_id, error: err.message,
          })
        }
      }
    } catch (err) {
      for (const j of jobs) {
        complementsPending.push({
          ar_id:           j.arId,
          document_number: j.documentNumber,
          amount:          j.params.amount,
          reason:          err.message,
          transient:       !!err.transient,
        })
      }
      logger.warn('Complemento de pago (grupo) quedó PENDIENTE tras registrar el cobro', {
        tenantId, currency, documents: jobs.map(j => j.documentNumber),
        transient: !!err.transient, error: err.message,
      })
    }
  }

  await audit({
    tenantId, userId, action: 'ar_payment.registered',
    resource: 'accounts_receivable', resourceId: partnerId,
    payload: {
      amount, method, reference, totalApplied, advanceId, bankAccountId,
      applications,
      complementsIssued: complementsIssued.map(c => ({
        invoice_number: c.invoice_number, uuid: c.uuid, amount: c.amount,
      })),
      complementsPending,
      complementsSkipped,
    },
    ipAddress, userAgent,
  })

  return {
    amount,
    totalApplied,
    advanceGenerated: sinAplicar > 0.01 ? sinAplicar : 0,
    advanceId,
    complementsIssued,
    complementsPending,
    complementsSkipped,
  }
}

/**
 * Aplica un anticipo existente a documentos CXC.
 */
async function applyAdvance({
  tenantId, partnerId, advanceId, applications = [],
  userId, ipAddress, userAgent,
}) {
  return withTransaction(async (client) => {
    // Verificar anticipo
    const { rows: advRows } = await client.query(
      `SELECT id, amount, amount_applied, amount_available
       FROM ar_advances WHERE id = $1 AND tenant_id = $2 AND partner_id = $3`,
      [advanceId, tenantId, partnerId]
    )
    if (!advRows.length) throw createError(404, 'Anticipo no encontrado.')
    const advance = advRows[0]
    if (parseFloat(advance.amount_available) <= 0) throw createError(400, 'El anticipo no tiene saldo disponible.')

    let totalApplied = 0

    for (const app of applications) {
      if (!app.arId || !app.amountApplied) continue

      const { rows: arRows } = await client.query(
        `SELECT id, amount_total, amount_paid, amount_pending, status
         FROM accounts_receivable WHERE id = $1 AND tenant_id = $2`,
        [app.arId, tenantId]
      )
      if (!arRows.length) continue
      const ar = arRows[0]
      if (ar.status === 'paid') continue

      const available = parseFloat(advance.amount_available) - totalApplied
      const toApply   = Math.min(parseFloat(app.amountApplied), parseFloat(ar.amount_pending), available)
      if (toApply <= 0) continue

      // Insertar pago tipo advance_application
      await client.query(
        `INSERT INTO ar_payments
           (tenant_id, ar_id, amount, payment_method, advance_id, payment_date, notes, created_by)
         VALUES ($1,$2,$3,'advance_application',$4,CURRENT_DATE,$5,$6)`,
        [tenantId, app.arId, toApply, advanceId, `Aplicación de anticipo`, userId]
      )

      // Actualizar CXC
      const newPaid   = parseFloat(ar.amount_paid) + toApply
      const newStatus = newPaid >= parseFloat(ar.amount_total) ? 'paid' : 'partial'
      await client.query(
        `UPDATE accounts_receivable SET amount_paid = $1, status = $2 WHERE id = $3`,
        [newPaid, newStatus, app.arId]
      )

      // Actualizar anticipo
      await client.query(
        `UPDATE ar_advances SET amount_applied = amount_applied + $1 WHERE id = $2`,
        [toApply, advanceId]
      )

      totalApplied += toApply
    }

    await audit({
      tenantId, userId, action: 'ar_advance.applied',
      resource: 'ar_advances', resourceId: advanceId,
      payload: { totalApplied, applications },
      ipAddress, userAgent,
    })

    return { advanceId, totalApplied }
  })
}

/**
 * Detalle de un documento CXC con sus pagos aplicados y datos del documento origen.
 */
async function getCXC({ tenantId, arId }) {
  const { rows } = await query(
    `SELECT ar.*,
            bp.name AS partner_name, bp.rfc AS partner_rfc,
            bp.cfdi_use, bp.payment_method AS partner_payment_method,
            bp.credit_type, bp.credit_days, bp.billing_notes,
            CASE WHEN ar.due_date < ${LOCAL_TODAY} AND ar.status NOT IN ('paid','cancelled')
              THEN true ELSE false END AS is_overdue
       FROM accounts_receivable ar
       JOIN business_partners bp ON bp.id = ar.partner_id
      WHERE ar.id = $1 AND ar.tenant_id = $2`,
    [arId, tenantId]
  )
  if (!rows.length) return null
  const ar = rows[0]

  // Pagos aplicados
  const { rows: payments } = await query(
    `SELECT arp.id, arp.amount, arp.payment_method, arp.reference,
            arp.payment_date, arp.advance_id, arp.notes, arp.created_at,
            arp.bank_account_id,
            arp.reversed_at, arp.reversal_reason, arp.payment_complement_id,
            ba.bank_name      AS bank_name,
            ba.alias          AS bank_alias,
            ba.account_number AS bank_account_number,
            u.full_name  AS created_by_name,
            ru.full_name AS reversed_by_name
       FROM ar_payments arp
       LEFT JOIN users u  ON u.id  = arp.created_by
       LEFT JOIN users ru ON ru.id = arp.reversed_by
       LEFT JOIN bank_accounts ba ON ba.id = arp.bank_account_id
      WHERE arp.ar_id = $1
      ORDER BY arp.payment_date ASC, arp.created_at ASC`,
    [arId]
  )

  // Info del documento origen + total complementado (si es factura PPD)
  let sourceDoc = null
  let complementTotal = 0
  let paymentComplements = []
  if (ar.document_type === 'invoice') {
    const { rows: inv } = await query(
      `SELECT id, document_number, cfdi_uuid, payment_method, payment_form,
              status, stamp_date, cancellation_date, delivery_note_id
         FROM invoices WHERE id = $1 AND tenant_id = $2`,
      [ar.document_id, tenantId]
    )
    sourceDoc = inv[0] || null
    if (sourceDoc) {
      const { rows: pcRows } = await query(
        `SELECT id, facturapi_id, cfdi_uuid, payment_date, payment_form,
                amount, currency, reference, status, created_at
           FROM payment_complements
          WHERE invoice_id = $1 AND tenant_id = $2
          ORDER BY payment_date DESC, created_at DESC`,
        [sourceDoc.id, tenantId]
      )
      paymentComplements = pcRows
      complementTotal = pcRows
        .filter(p => p.status !== 'cancelled')
        .reduce((s, p) => s + parseFloat(p.amount || 0), 0)
    }
  } else if (ar.document_type === 'remission') {
    const { rows: rem } = await query(
      `SELECT dn.id, dn.document_number, dn.status, dn.delivered_at,
              dn.receiver_name, dn.sales_order_id,
              so.order_number AS sales_order_number
         FROM delivery_notes dn
         LEFT JOIN sales_orders so ON so.id = dn.sales_order_id
        WHERE dn.id = $1 AND dn.tenant_id = $2`,
      [ar.document_id, tenantId]
    )
    sourceDoc = rem[0] || null
  }

  return {
    ...ar, payments, sourceDoc,
    complement_total:   complementTotal,
    paymentComplements,
  }
}

function createError(status, message) {
  const err = new Error(message)
  err.status = status
  return err
}

/**
 * Timbra un complemento de pago para una factura PPD ya cobrada pero cuyo
 * pago no generó el CFDI tipo P (por ejemplo, pagos registrados antes de
 * que el auto-timbrado funcionara, o fallas previas en Facturapi).
 *
 * Calcula el monto faltante de complementos:
 *   faltante = SUM(ar_payments.amount) - SUM(payment_complements activos)
 * y timbra UN solo complemento por ese monto.
 *
 * Si el operador quiere fraccionar el complemento, puede mandar `amount`
 * explícito menor al faltante. No se permite exceder el faltante.
 */
async function stampMissingComplement({
  tenantId, arId,
  paymentDate, paymentForm, amount, reference, exchangeRate,
  userId, ipAddress, userAgent,
}) {
  const result = await withTransaction(async (client) => {
    const { rows: arRows } = await client.query(
      `SELECT ar.id, ar.partner_id, ar.document_type, ar.document_id, ar.document_number,
              ar.currency, ar.amount_paid,
              inv.status              AS invoice_status,
              inv.payment_method      AS invoice_payment_method,
              inv.exchange_rate_value AS invoice_exchange_rate
       FROM accounts_receivable ar
       LEFT JOIN invoices inv ON inv.id = ar.document_id AND ar.document_type = 'invoice'
       WHERE ar.id = $1 AND ar.tenant_id = $2`,
      [arId, tenantId]
    )
    if (!arRows.length) throw createError(404, 'CXC no encontrado.')
    const ar = arRows[0]

    if (ar.document_type !== 'invoice') throw createError(400, 'Solo aplica a facturas.')
    if (ar.invoice_status !== 'stamped') throw createError(400, 'La factura debe estar timbrada.')
    if (ar.invoice_payment_method !== 'PPD') throw createError(400, 'Solo aplica a facturas PPD.')

    const { rows: totals } = await client.query(
      `SELECT
         (SELECT COALESCE(SUM(amount),0) FROM ar_payments        WHERE ar_id = $1) AS total_paid,
         (SELECT COALESCE(SUM(amount),0) FROM payment_complements
            WHERE invoice_id = $2 AND status <> 'cancelled')                       AS total_complemented`,
      [arId, ar.document_id]
    )
    const totalPaid          = parseFloat(totals[0].total_paid)
    const totalComplemented  = parseFloat(totals[0].total_complemented)
    const missing            = +(totalPaid - totalComplemented).toFixed(2)

    if (missing <= 0.01) {
      throw createError(400, 'No hay monto pendiente de complementar para esta factura.')
    }

    // Si el operador pidió un monto explícito, validar que no exceda el faltante.
    const toStamp = amount ? Math.min(parseFloat(amount), missing) : missing
    if (toStamp <= 0.01) throw createError(400, 'Monto inválido.')

    const comp = await stampPaymentComplement(client, {
      tenantId,
      invoiceId:   ar.document_id,
      paymentDate: paymentDate || new Date().toISOString().split('T')[0],
      paymentForm: paymentForm || '03',
      amount:      toStamp,
      currency:    ar.currency || 'MXN',
      reference,
      exchangeRate: ar.currency === 'USD'
        ? parseFloat(exchangeRate || ar.invoice_exchange_rate || 1)
        : undefined,
      userId,
    })

    await audit({
      tenantId, userId, action: 'payment_complement.stamped_manual',
      resource: 'invoices', resourceId: ar.document_id,
      payload: {
        ar_id: arId, uuid: comp.uuid, amount: toStamp,
        missing_before: missing, payment_form: paymentForm || '03',
      },
      ipAddress, userAgent,
    })

    return {
      uuid:           comp.uuid,
      facturapi_id:   comp.facturapi_id,
      amount:         toStamp,
      missing_before: missing,
      missing_after:  +(missing - toStamp).toFixed(2),
      partner_id:     ar.partner_id,
    }
  })

  // Auto-envío post-commit si el cliente lo tiene activado. Best-effort.
  try {
    await maybeAutoSendComplement({
      tenantId, partnerId: result.partner_id,
      complementFacturapiId: result.facturapi_id,
      userId, ipAddress, userAgent,
    })
  } catch (err) {
    logger.warn('Auto-envío de complemento (timbrado manual) falló', {
      tenantId, facturapi_id: result.facturapi_id, error: err.message,
    })
  }

  return result
}

/**
 * Historial de PAGOS RECIBIDOS (cobros): lista cronológica de ar_payments, no de
 * cuentas por cobrar. Cada fila es un cobro real con su documento, socio y método.
 */
async function listPayments({ tenantId, partnerId, from, to, method, sortBy, sortDir, page = 1, limit = 50 }) {
  const offset = (page - 1) * limit
  const params = [tenantId]
  // Los cobros reversados no son movimientos reales de dinero → fuera del historial.
  const filters = ['arp.reversed_at IS NULL']
  const orderBy = buildOrderBy({
    sortBy, sortDir, columns: AR_PAYMENT_SORT_COLUMNS, defaultKey: 'fecha',
    tiebreaker: 'arp.created_at DESC, arp.id DESC',
  })
  if (partnerId) { params.push(partnerId); filters.push(`ar.partner_id = $${params.length}`) }
  if (from)      { params.push(from);      filters.push(`arp.payment_date >= $${params.length}`) }
  if (to)        { params.push(to);        filters.push(`arp.payment_date <= $${params.length}`) }
  if (method)    { params.push(method);    filters.push(`arp.payment_method = $${params.length}`) }
  const where = filters.length ? `AND ${filters.join(' AND ')}` : ''
  params.push(limit, offset)

  const { rows } = await query(
    `SELECT arp.id, arp.amount, arp.payment_method, arp.reference, arp.payment_date,
            arp.notes, arp.created_at, arp.advance_id,
            ar.id AS ar_id, ar.document_type, ar.document_number,
            bp.id AS partner_id, bp.name AS partner_name, bp.tax_name AS partner_tax_name,
            ba.bank_name, ba.alias AS bank_alias,
            u.full_name AS created_by_name,
            -- Complemento de pago (CFDI tipo P) ligado al cobro, si lo hubo y
            -- sigue vigente. Permite que la lista ofrezca su PDF+XML en vez del
            -- recibo no fiscal del sistema.
            pc.facturapi_id AS complement_facturapi_id,
            pc.cfdi_uuid    AS complement_uuid,
            pc.status       AS complement_status
       FROM ar_payments arp
       JOIN accounts_receivable ar ON ar.id = arp.ar_id
       JOIN business_partners bp   ON bp.id = ar.partner_id
       LEFT JOIN bank_accounts ba  ON ba.id = arp.bank_account_id
       LEFT JOIN users u           ON u.id  = arp.created_by
       LEFT JOIN payment_complements pc
              ON pc.id = arp.payment_complement_id AND pc.status <> 'cancelled'
      WHERE arp.tenant_id = $1 ${where}
      ORDER BY ${orderBy}
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  )

  const { rows: countRows } = await query(
    `SELECT COUNT(*) AS n, COALESCE(SUM(arp.amount),0) AS total
       FROM ar_payments arp
       JOIN accounts_receivable ar ON ar.id = arp.ar_id
      WHERE arp.tenant_id = $1 ${where}`,
    params.slice(0, params.length - 2)
  )

  return {
    data: rows,
    total: parseInt(countRows[0].n, 10),
    totalAmount: parseFloat(countRows[0].total) || 0,
    page, limit,
  }
}

/**
 * Detalle de un cobro recibido (ar_payments) para el panel que abre al hacer
 * clic en una fila de "Pagos recibidos": datos del cobro, documento al que se
 * aplicó, cliente y el complemento de pago (CFDI tipo P) ligado, si lo hubo.
 */
async function getPaymentDetail({ tenantId, paymentId }) {
  const { rows } = await query(
    `SELECT arp.id, arp.amount, arp.payment_method, arp.reference, arp.payment_date,
            arp.notes, arp.created_at, arp.advance_id,
            arp.reversed_at, arp.reversal_reason,
            ar.id AS ar_id, ar.document_type, ar.document_id, ar.document_number,
            ar.currency, ar.amount_total, ar.amount_paid, ar.amount_pending, ar.status AS ar_status,
            bp.id AS partner_id, bp.name AS partner_name, bp.tax_name AS partner_tax_name,
            bp.rfc AS partner_rfc,
            ba.bank_name, ba.alias AS bank_alias, ba.account_number AS bank_account_number,
            u.full_name AS created_by_name,
            pc.id           AS complement_id,
            pc.facturapi_id AS complement_facturapi_id,
            pc.cfdi_uuid    AS complement_uuid,
            pc.amount       AS complement_amount,
            pc.currency     AS complement_currency,
            pc.payment_form AS complement_payment_form,
            pc.payment_date AS complement_payment_date,
            pc.status       AS complement_status
       FROM ar_payments arp
       JOIN accounts_receivable ar ON ar.id = arp.ar_id
       JOIN business_partners bp   ON bp.id = ar.partner_id
       LEFT JOIN bank_accounts ba  ON ba.id = arp.bank_account_id
       LEFT JOIN users u           ON u.id  = arp.created_by
       LEFT JOIN payment_complements pc ON pc.id = arp.payment_complement_id
      WHERE arp.id = $1 AND arp.tenant_id = $2`,
    [paymentId, tenantId]
  )
  if (!rows.length) return null
  return rows[0]
}

/**
 * Reversa un cobro aplicado (ar_payments). Deshace su efecto en la CXC y, si el
 * cobro timbró un complemento de pago (CFDI tipo P), lo CANCELA ante el SAT
 * (motivo '02' — comprobante con errores sin relación).
 *
 * El cobro NO se borra: queda marcado (reversed_at/by/reason) para auditoría y
 * se excluye de saldos e historial. Para corregir un cobro mal aplicado, el
 * operador lo reversa y vuelve a registrarlo en el documento correcto.
 *
 * Atómico: si Facturapi falla al cancelar el complemento, se revierte TODO (el
 * saldo no se toca y el complemento sigue timbrado).
 */
async function reversePayment({ tenantId, paymentId, reason, userId, ipAddress, userAgent }) {
  if (!reason || !String(reason).trim()) {
    throw createError(400, 'La razón de la reversa es requerida.')
  }
  const reasonTrim = String(reason).trim()

  return withTransaction(async (client) => {
    // Cargar el cobro + su CXC (lock del cobro para evitar dobles reversas).
    const { rows: payRows } = await client.query(
      `SELECT arp.id, arp.ar_id, arp.amount, arp.payment_method, arp.advance_id,
              arp.reversed_at, arp.payment_complement_id,
              ar.document_type, ar.document_id, ar.document_number,
              ar.amount_total, ar.amount_paid
         FROM ar_payments arp
         JOIN accounts_receivable ar ON ar.id = arp.ar_id
        WHERE arp.id = $1 AND arp.tenant_id = $2
        FOR UPDATE OF arp`,
      [paymentId, tenantId]
    )
    if (!payRows.length) throw createError(404, 'Cobro no encontrado.')
    const pay = payRows[0]
    if (pay.reversed_at) throw createError(409, 'Este cobro ya fue reversado.')

    const amount = parseFloat(pay.amount)

    // 1. Resolver el complemento timbrado a cancelar (si lo hay).
    //    Preferir el link directo; para cobros previos a la mig 205 (sin link),
    //    match best-effort por (factura, monto) sobre complementos vivos.
    let complementId = pay.payment_complement_id
    if (!complementId && pay.document_type === 'invoice') {
      const { rows: pcRows } = await client.query(
        `SELECT id FROM payment_complements
          WHERE tenant_id = $1 AND invoice_id = $2
            AND status = 'stamped'
            AND ROUND(amount, 2) = ROUND($3::numeric, 2)
          ORDER BY created_at DESC
          LIMIT 1`,
        [tenantId, pay.document_id, amount]
      )
      if (pcRows.length) complementId = pcRows[0].id
    }

    let complementCancelled = null
    // Si el complemento cancelado cubría OTRAS facturas (REP agrupado, mig 214),
    // esas quedan sin complemento vigente → requieren re-timbrado. Se informa.
    let complementDocsAffected = 0
    if (complementId) {
      const res = await cancelComplement(client, { tenantId, complementId, motive: '02' })
      if (res?.cancelled || res?.alreadyCancelled) complementCancelled = res.cfdi_uuid
      if (Array.isArray(res?.cancelledRows) && res.cancelledRows.length > 1) {
        // Filas hermanas distintas a la factura de ESTE cobro.
        complementDocsAffected = res.cancelledRows
          .filter(r => r.invoice_id !== pay.document_id).length
      }
    }

    // 2. Revertir el saldo de la CXC (amount_pending es columna generada).
    const newPaid   = +(parseFloat(pay.amount_paid) - amount).toFixed(2)
    const safePaid  = newPaid < 0 ? 0 : newPaid
    const total     = parseFloat(pay.amount_total)
    const newStatus = safePaid <= 0.001 ? 'pending'
                    : safePaid >= total - 0.001 ? 'paid'
                    : 'partial'
    await client.query(
      `UPDATE accounts_receivable SET amount_paid = $1, status = $2 WHERE id = $3`,
      [safePaid, newStatus, pay.ar_id]
    )

    // 3. Si el cobro fue aplicación de anticipo, devolver el saldo al anticipo.
    if (pay.payment_method === 'advance_application' && pay.advance_id) {
      await client.query(
        `UPDATE ar_advances
            SET amount_applied = GREATEST(amount_applied - $1, 0)
          WHERE id = $2 AND tenant_id = $3`,
        [amount, pay.advance_id, tenantId]
      )
    }

    // 4. Marcar el cobro como reversado (no se borra).
    await client.query(
      `UPDATE ar_payments
          SET reversed_at = NOW(), reversed_by = $1, reversal_reason = $2
        WHERE id = $3`,
      [userId, reasonTrim, paymentId]
    )

    await audit({
      tenantId, userId, action: 'ar_payment.reversed',
      resource: 'ar_payments', resourceId: paymentId,
      payload: {
        ar_id: pay.ar_id, document_number: pay.document_number,
        amount, method: pay.payment_method, reason: reasonTrim,
        new_status: newStatus, complement_cancelled: complementCancelled,
        complement_docs_affected: complementDocsAffected,
      },
      ipAddress, userAgent,
    })

    return {
      reversed: true,
      paymentId,
      amount,
      newStatus,
      complementCancelled,
      complementDocsAffected,
    }
  })
}

module.exports = {
  listCXC, getCXC, getCustomerStatement, listPayments, getPaymentDetail,
  registerPayment, applyAdvance, stampMissingComplement, reversePayment,
}
