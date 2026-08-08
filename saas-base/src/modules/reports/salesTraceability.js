'use strict'

// Trazabilidad de ventas: el EXPEDIENTE de cada factura emitida del periodo —
// pedido → remisiones que la formaron → factura → devoluciones del cliente y su
// nota de crédito → cancelación/sustitución → cobros (y reversas) → complementos
// de pago emitidos.
//
// Espejo de purchaseTraceability.js, con una diferencia de fondo: aquí el REP
// que falta es una obligación NUESTRA (el SAT lo exige al día 5 del mes
// siguiente al cobro y sin él el cliente no puede acreditar su IVA), no un
// pendiente del proveedor.
//
// Ancla del expediente: la factura de ingreso (invoices cfdi_type='I') con
// stamp_date en [from, to) — mismo corte que el reporte contable. Aparte se
// listan las remisiones del periodo que aún no se facturan.
//
// Solo LEE. Sin migraciones.

const { query } = require('../../db')

const CENTS = 0.005
const round2 = (n) => Math.round(n * 100) / 100
const amountsClose = (a, b) => Math.abs(a - b) <= Math.max(1, Math.abs(b) * 0.005)

// Formas de cobro que exigen complemento (dinero real). Las notas de crédito y
// las aplicaciones de anticipo no generan CFDI de pago.
const REP_METHODS = new Set(['cash', 'transfer', 'check'])

const METHOD_LABEL = {
  cash: 'Efectivo', transfer: 'Transferencia', check: 'Cheque',
  advance_application: 'Aplicación de anticipo', credit_note: 'Nota de crédito',
}

// Motivos de cancelación del SAT (invoices.cancellation_reason).
const CANCEL_MOTIVE = {
  '01': 'Comprobante emitido con errores CON relación',
  '02': 'Comprobante emitido con errores SIN relación',
  '03': 'No se llevó a cabo la operación',
  '04': 'Operación nominativa relacionada en la factura global',
}

const EVENT_LABELS = {
  order:            'Pedido confirmado',
  remission:        'Remisión entregada',
  invoice:          'Factura timbrada',
  sales_return:     'Devolución del cliente',
  credit_note:      'Nota de crédito emitida',
  cancelled:        'Factura cancelada',
  substituted:      'Sustituida por otra factura',
  substitutes:      'Sustituye a factura cancelada',
  payment:          'Cobro aplicado',
  payment_reversed: 'Cobro reversado',
  rep:              'Complemento de pago timbrado',
}

async function getSalesTraceability({ tenantId, from, to, partnerId = null, onlyIssues = false }) {
  // ── 1. Anclas: facturas de ingreso timbradas en el periodo ───────────────
  const params = [tenantId, from, to]
  let partnerFilter = ''
  if (partnerId) { params.push(partnerId); partnerFilter = `AND i.partner_id = $${params.length}` }

  const { rows: invoices } = await query(`
    SELECT i.id, i.document_number, i.series, i.folio, i.cfdi_uuid, i.status,
           i.issue_date, i.stamp_date::date AS stamp_day, i.cancellation_date::date AS cancelled_date,
           i.cancellation_reason, i.payment_method, i.use_cfdi, i.source,
           i.subtotal, i.tax_transferred, i.total, i.total_mxn, i.delivery_note_id,
           COALESCE(bp.tax_name, bp.name) AS partner_name, bp.rfc AS partner_rfc, i.partner_id,
           ar.amount_pending, ar.status AS ar_status, ar.due_date
      FROM invoices i
      JOIN business_partners bp ON bp.id = i.partner_id
      LEFT JOIN accounts_receivable ar ON ar.tenant_id = i.tenant_id
                                      AND ar.document_type = 'invoice' AND ar.document_id = i.id
     WHERE i.tenant_id = $1 AND i.type = 'issued' AND i.cfdi_type = 'I'
       AND i.status IN ('stamped', 'cancelled')
       AND i.stamp_date IS NOT NULL
       AND i.stamp_date >= $2 AND i.stamp_date < $3
       ${partnerFilter}
     ORDER BY i.stamp_date ASC, i.document_number ASC
  `, params)

  const invoiceIds = invoices.map(i => i.id)
  const uuids = invoices.map(i => i.cfdi_uuid).filter(Boolean)
  const empty = { rows: [] }

  // ── 2. Eslabones (consultas en lote sobre las anclas) ────────────────────
  const [remissions, returns, creditNotes, payments, reps, cancels] = await Promise.all([
    // Remisiones: liga directa (factura individual) + tabla N:N (consolidada).
    invoiceIds.length ? query(`
      SELECT ir.invoice_id, dn.document_number, dn.issue_date, dn.delivered_at::date AS delivered_date,
             dn.total_mxn, dn.status, so.order_number,
             COALESCE(so.confirmed_at, so.created_at)::date AS order_date
        FROM invoice_remissions ir
        JOIN delivery_notes dn ON dn.id = ir.delivery_note_id
        LEFT JOIN sales_orders so ON so.id = dn.sales_order_id
       WHERE ir.invoice_id = ANY($2::uuid[])
      UNION
      SELECT i.id, dn.document_number, dn.issue_date, dn.delivered_at::date,
             dn.total_mxn, dn.status, so.order_number,
             COALESCE(so.confirmed_at, so.created_at)::date
        FROM invoices i
        JOIN delivery_notes dn ON dn.id = i.delivery_note_id
        LEFT JOIN sales_orders so ON so.id = dn.sales_order_id
       WHERE i.tenant_id = $1 AND i.id = ANY($2::uuid[])
    `, [tenantId, invoiceIds]) : empty,

    // Devoluciones del cliente ligadas a estas facturas.
    invoiceIds.length ? query(`
      SELECT sr.source_invoice_id, sr.return_number, sr.status, sr.total_mxn,
             sr.return_date, sr.confirmed_at::date AS confirmed_date,
             sr.credit_status, sr.credit_note_invoice_id,
             dn.document_number AS remission_number
        FROM sales_returns sr
        LEFT JOIN delivery_notes dn ON dn.id = sr.source_delivery_note_id
       WHERE sr.tenant_id = $1 AND sr.status <> 'cancelled'
         AND sr.source_invoice_id = ANY($2::uuid[])
    `, [tenantId, invoiceIds]) : empty,

    // Notas de crédito emitidas contra estas facturas (CFDI de egreso).
    invoiceIds.length ? query(`
      SELECT nc.related_invoice_id, nc.document_number, nc.cfdi_uuid, nc.total_mxn,
             nc.status, COALESCE(nc.stamp_date::date, nc.issue_date) AS nc_date,
             sr.return_number
        FROM invoices nc
        LEFT JOIN sales_returns sr ON sr.credit_note_invoice_id = nc.id
       WHERE nc.tenant_id = $1 AND nc.type = 'issued' AND nc.cfdi_type = 'E'
         AND nc.related_invoice_id = ANY($2::uuid[])
    `, [tenantId, invoiceIds]) : empty,

    // Cobros (y reversas) con banco.
    invoiceIds.length ? query(`
      SELECT ar.document_id AS invoice_id, ap.id AS payment_id, ap.amount, ap.payment_date,
             ap.payment_method, ap.reference, ap.reversed_at::date AS reversed_date,
             ap.reversal_reason, ba.bank_name, ba.alias AS bank_alias
        FROM ar_payments ap
        JOIN accounts_receivable ar ON ar.id = ap.ar_id
        LEFT JOIN bank_accounts ba ON ba.id = ap.bank_account_id
       WHERE ap.tenant_id = $1 AND ar.document_type = 'invoice'
         AND ar.document_id = ANY($2::uuid[])
       ORDER BY ap.payment_date ASC
    `, [tenantId, invoiceIds]) : empty,

    // Complementos de pago timbrados por cada factura.
    invoiceIds.length ? query(`
      SELECT pc.invoice_id, pc.cfdi_uuid, pc.payment_date, pc.amount, pc.payment_form, pc.status
        FROM payment_complements pc
       WHERE pc.tenant_id = $1 AND pc.invoice_id = ANY($2::uuid[])
       ORDER BY pc.payment_date ASC
    `, [tenantId, invoiceIds]) : empty,

    // Sustituciones. El UUID de la factura sustituta NO se guarda en la
    // factura: viaja en el payload de la bitácora de la cancelación ante el
    // SAT (motivo 01). Desde ahí se resuelve el folio en los dos sentidos.
    invoiceIds.length ? query(`
      SELECT al.resource_id AS cancelled_invoice_id,
             (al.payload->>'substitution')::uuid AS substitute_uuid,
             sub.id AS substitute_id, sub.document_number AS substitute_number,
             old.document_number AS cancelled_number, old.cfdi_uuid AS cancelled_uuid,
             al.created_at::date AS cancelled_date
        FROM audit_logs al
        JOIN invoices old ON old.id = al.resource_id
        LEFT JOIN invoices sub ON sub.tenant_id = al.tenant_id
                              AND sub.cfdi_uuid = (al.payload->>'substitution')::uuid
       WHERE al.tenant_id = $1 AND al.action = 'invoice.cancelled_sat'
         AND al.payload->>'substitution' IS NOT NULL
         AND (al.resource_id = ANY($2::uuid[])
           OR (al.payload->>'substitution')::uuid = ANY($3::uuid[]))
    `, [tenantId, invoiceIds, uuids.length ? uuids : [null]]) : empty,
  ])

  // ── 3. Armar expedientes ────────────────────────────────────────────────
  const group = (rows, key) => {
    const m = new Map()
    for (const r of rows) {
      const k = r[key]
      if (!k) continue
      if (!m.has(k)) m.set(k, [])
      m.get(k).push(r)
    }
    return m
  }
  const remBy     = group(remissions.rows, 'invoice_id')
  const retBy     = group(returns.rows, 'source_invoice_id')
  const ncBy      = group(creditNotes.rows, 'related_invoice_id')
  const payBy     = group(payments.rows, 'invoice_id')
  const repBy     = group(reps.rows, 'invoice_id')
  const cancelBy  = group(cancels.rows, 'cancelled_invoice_id')
  const substitutesBy = group(cancels.rows.filter(c => c.substitute_id), 'substitute_id')

  const chains = invoices.map(inv => {
    const events = []
    const push = (type, date, doc, uuid, amount, detail) =>
      events.push({ type, label: EVENT_LABELS[type], date: toISODate(date), doc: doc || null,
                    uuid: uuid || null, amount: amount != null ? parseFloat(amount) : null,
                    detail: detail || null })

    // Pedidos y remisiones (dedupe por folio).
    const orders = new Map(), rems = new Map()
    for (const r of (remBy.get(inv.id) || [])) {
      if (r.order_number && !orders.has(r.order_number)) {
        orders.set(r.order_number, r)
        push('order', r.order_date, r.order_number, null, null, null)
      }
      if (!rems.has(r.document_number)) {
        rems.set(r.document_number, r)
        push('remission', r.delivered_date || r.issue_date, r.document_number, null, r.total_mxn,
             r.delivered_date ? null : 'Sin acuse de entrega capturado')
      }
    }

    // La factura misma.
    const ppd = inv.payment_method === 'PPD'
    push('invoice', inv.stamp_day || inv.issue_date, inv.document_number, inv.cfdi_uuid, inv.total_mxn,
         `${ppd ? 'PPD — pago en parcialidades' : 'PUE — una sola exhibición'}`
         + (inv.source === 'imported' ? ' · importada de otro sistema' : ''))

    // ¿Esta factura sustituye a una cancelada?
    for (const s of (substitutesBy.get(inv.id) || [])) {
      push('substitutes', inv.stamp_day, s.cancelled_number, s.cancelled_uuid, null, null)
    }

    // Devoluciones del cliente y su nota de crédito.
    let hasNc = false
    for (const r of (retBy.get(inv.id) || [])) {
      push('sales_return', r.confirmed_date || r.return_date, r.return_number, null, r.total_mxn,
           r.credit_status === 'pending' ? 'Nota de crédito pendiente de emitir'
             : r.remission_number ? `De la remisión ${r.remission_number}` : null)
    }
    for (const nc of (ncBy.get(inv.id) || [])) {
      if (nc.status === 'cancelled') continue
      hasNc = true
      push('credit_note', nc.nc_date, nc.document_number, nc.cfdi_uuid, nc.total_mxn,
           nc.return_number ? `Por la devolución ${nc.return_number}` : null)
    }

    // Cancelación y sustitución.
    if (inv.status === 'cancelled') {
      const sub = (cancelBy.get(inv.id) || [])[0]
      if (sub && sub.substitute_number) {
        push('substituted', inv.cancelled_date, sub.substitute_number, sub.substitute_uuid, null,
             CANCEL_MOTIVE[inv.cancellation_reason] || null)
      } else {
        push('cancelled', inv.cancelled_date, inv.document_number, inv.cfdi_uuid, null,
             CANCEL_MOTIVE[inv.cancellation_reason]
               || (inv.cancellation_reason ? `Motivo ${inv.cancellation_reason}` : null))
      }
    }

    // Cobros y reversas.
    let cashCollected = 0
    for (const p of (payBy.get(inv.id) || [])) {
      const bank = p.bank_name ? ` · ${p.bank_name}${p.bank_alias ? ` (${p.bank_alias})` : ''}` : ''
      push('payment', p.payment_date, p.reference || METHOD_LABEL[p.payment_method], null, p.amount,
           `${METHOD_LABEL[p.payment_method] || p.payment_method}${bank}`)
      if (p.reversed_date) {
        push('payment_reversed', p.reversed_date, p.reference, null, -parseFloat(p.amount),
             p.reversal_reason || null)
      } else if (REP_METHODS.has(p.payment_method)) {
        // Solo el dinero real exige complemento.
        cashCollected += parseFloat(p.amount)
      }
    }

    // Complementos emitidos.
    let repTotal = 0
    for (const rep of (repBy.get(inv.id) || [])) {
      const live = rep.status === 'stamped'
      if (live) repTotal += parseFloat(rep.amount)
      push('rep', rep.payment_date, null, rep.cfdi_uuid, rep.amount,
           live ? 'Timbrado' : `Complemento ${rep.status}`)
    }

    // Semáforo de complemento (solo PPD vigentes).
    let repStatus = 'not_required'
    if (ppd && inv.status !== 'cancelled') {
      if (cashCollected <= CENTS) repStatus = 'pending_payment'
      else if (repTotal <= CENTS) repStatus = 'missing'
      else repStatus = amountsClose(repTotal, cashCollected) ? 'ok' : 'mismatch'
    }

    events.sort((a, b) => (a.date || '9999-12-31').localeCompare(b.date || '9999-12-31'))

    return {
      invoice: {
        id: inv.id, number: inv.document_number, uuid: inv.cfdi_uuid, status: inv.status,
        issue_date: toISODate(inv.stamp_day || inv.issue_date), due_date: toISODate(inv.due_date),
        total_mxn: parseFloat(inv.total_mxn || 0),
        balance: parseFloat(inv.amount_pending || 0),
        tax_mxn: ivaMxn(inv),
        metodo_pago: inv.payment_method, use_cfdi: inv.use_cfdi,
        imported: inv.source === 'imported',
      },
      partner: { id: inv.partner_id, name: inv.partner_name, rfc: inv.partner_rfc || null },
      remissions: [...rems.keys()],
      orders: [...orders.keys()],
      flags: {
        paid: inv.status !== 'cancelled' && parseFloat(inv.amount_pending || 0) <= CENTS,
        cancelled: inv.status === 'cancelled',
        has_nc: hasNc,
        has_return: (retBy.get(inv.id) || []).length > 0,
        rep_status: repStatus,
      },
      events,
    }
  })

  // ── 4. Remisiones del periodo aún sin facturar ──────────────────────────
  const remParams = [tenantId, from, to]
  let remPartnerFilter = ''
  if (partnerId) { remParams.push(partnerId); remPartnerFilter = `AND dn.partner_id = $${remParams.length}` }
  const { rows: pendingRemissions } = await query(`
    SELECT dn.document_number, dn.issue_date, dn.status, dn.total_mxn,
           COALESCE(bp.tax_name, bp.name) AS partner_name,
           so.order_number
      FROM delivery_notes dn
      JOIN business_partners bp ON bp.id = dn.partner_id
      LEFT JOIN sales_orders so ON so.id = dn.sales_order_id
     WHERE dn.tenant_id = $1 AND dn.status NOT IN ('cancelled', 'invoiced')
       AND dn.issue_date >= $2 AND dn.issue_date < $3
       ${remPartnerFilter}
       AND NOT EXISTS (
         SELECT 1 FROM invoices i
          WHERE i.tenant_id = dn.tenant_id AND i.delivery_note_id = dn.id
            AND i.status <> 'cancelled')
       AND NOT EXISTS (
         SELECT 1 FROM invoice_remissions ir
           JOIN invoices i2 ON i2.id = ir.invoice_id AND i2.status <> 'cancelled'
          WHERE ir.delivery_note_id = dn.id)
     ORDER BY dn.issue_date ASC, dn.document_number ASC
  `, remParams)

  // Totales: solo expedientes VIGENTES. Lo facturado neto descuenta las notas
  // de crédito emitidas, que es lo que realmente quedó a cargo del cliente.
  const live = chains.filter(c => !c.flags.cancelled)
  const ncTotal = live.reduce((s, c) =>
    s + c.events.filter(e => e.type === 'credit_note').reduce((x, e) => x + (e.amount || 0), 0), 0)
  const grossTotal = live.reduce((s, c) => s + c.invoice.total_mxn, 0)
  const ivaPendingRep = live
    .filter(c => ['missing', 'mismatch'].includes(c.flags.rep_status))
    .reduce((s, c) => s + c.invoice.tax_mxn, 0)

  const summary = {
    chains: chains.length,
    paid: chains.filter(c => c.flags.paid).length,
    cancelled: chains.filter(c => c.flags.cancelled).length,
    with_nc: chains.filter(c => c.flags.has_nc).length,
    rep_missing: chains.filter(c => ['missing', 'mismatch'].includes(c.flags.rep_status)).length,
    pending_remissions: pendingRemissions.length,
    net_invoiced_mxn: round2(grossTotal - ncTotal),
    credit_notes_mxn:  round2(ncTotal),
    iva_pending_rep_mxn: round2(ivaPendingRep),
  }

  // El filtro se aplica AL FINAL: los totales del periodo no cambian por mirar
  // solo los expedientes con incidencia.
  const visible = onlyIssues ? chains.filter(hasIssue) : chains

  return {
    period: { from, to },
    summary,
    filtered: Boolean(onlyIssues),
    chains: visible,
    pending_remissions: pendingRemissions.map(r => ({
      document_number: r.document_number, date: toISODate(r.issue_date), status: r.status,
      total_mxn: parseFloat(r.total_mxn || 0), partner_name: r.partner_name,
      order_number: r.order_number || null,
    })),
  }
}

/** Un expediente "con incidencia" es el que el contador tiene que mirar. */
function hasIssue(c) {
  return c.flags.cancelled
    || c.flags.has_nc
    || c.flags.has_return
    || ['missing', 'mismatch'].includes(c.flags.rep_status)
    || !c.flags.paid
}

/**
 * IVA trasladado en MXN. `tax_transferred`/`total` van en la moneda del CFDI:
 * se prorratean sobre total_mxn para no inflar el IVA de una factura en USD.
 */
function ivaMxn(inv) {
  const tax = parseFloat(inv.tax_transferred || 0)
  if (!tax) return 0
  const total = parseFloat(inv.total || 0)
  const totalMxn = parseFloat(inv.total_mxn || 0)
  if (!total || Math.abs(total - totalMxn) < CENTS) return round2(tax)
  return round2(totalMxn * (tax / total))
}

/**
 * Normaliza a 'YYYY-MM-DD'. Las columnas DATE llegan como Date a medianoche
 * LOCAL: toISOString() las correría un día atrás en zonas negativas. Sin esto,
 * además, el orden cronológico se haría por texto ("Mon Jun 29…").
 */
function toISODate(v) {
  if (!v) return null
  if (typeof v === 'string') return v.slice(0, 10)
  const d = v instanceof Date ? v : new Date(v)
  if (Number.isNaN(d.getTime())) return null
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

module.exports = { getSalesTraceability, EVENT_LABELS, CANCEL_MOTIVE }
