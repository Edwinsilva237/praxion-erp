'use strict'

// Trazabilidad de compras: reconstruye el EXPEDIENTE completo de cada factura
// de compra del periodo — OC → recepciones → factura → devoluciones y su
// resolución (NC / cancelación / sustitución / reposición) → pagos (y
// reversas) → REP (recibidos, correcciones y su estado de cruce).
//
// Pensado para contabilidad/auditoría: cada evento lleva folio interno estable
// + documento fiscal (UUID) cuando existe, para relacionarlo en sistemas
// contables externos. Todo sale de las ligas que ya guarda la operación —
// este módulo solo LEE.
//
// Ancla del expediente: la factura/remisión-CxP (supplier_invoices tipo
// invoice|remission) con invoice_date en [from, to). Aparte se listan las OCs
// del periodo que aún no tienen factura (expedientes abiertos).

const { query } = require('../../db')

// Misma tolerancia que el auto-cruce de REPs (supplierComplementService).
const amountsClose = (a, b) => Math.abs(a - b) <= Math.max(1, Math.abs(b) * 0.005)

// Normaliza una fecha a 'YYYY-MM-DD'. Las columnas DATE llegan como objetos Date
// (a medianoche LOCAL): usar toISOString() las correría un día hacia atrás en
// zonas negativas, así que se formatea con los componentes locales. Además, sin
// esta normalización el orden cronológico se hacía por texto ("Mon Jun 29…").
function toISODate(v) {
  if (!v) return null
  if (typeof v === 'string') return v.slice(0, 10)
  const d = v instanceof Date ? v : new Date(v)
  if (Number.isNaN(d.getTime())) return null
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

const EVENT_LABELS = {
  oc:               'OC emitida',
  receipt:          'Recepción confirmada',
  invoice:          'Factura registrada',
  remission_cxp:    'CxP sin factura (remisión)',
  return:           'Devolución a proveedor',
  replacement:      'Reposición recibida',
  credit_note:      'Nota de crédito recibida',
  cancelled:        'Factura cancelada',
  substituted:      'Sustituida por otra factura',
  substitutes:      'Sustituye a factura cancelada',
  payment:          'Pago aplicado',
  payment_reversed: 'Pago reversado',
  rep_requested:    'REP solicitado al proveedor',
  rep:              'REP recibido',
}

async function getPurchaseTraceability({ tenantId, from, to, partnerId = null }) {
  // ── 1. Anclas: facturas / remisiones-CxP del periodo ─────────────────────
  const params = [tenantId, from, to]
  let partnerFilter = ''
  if (partnerId) { params.push(partnerId); partnerFilter = `AND si.partner_id = $${params.length}` }

  const { rows: invoices } = await query(`
    SELECT si.id, si.invoice_number, si.type, si.status, si.uuid_sat, si.serie, si.folio,
           si.invoice_date, si.due_date, si.total_mxn, si.total, si.tax, si.balance, si.metodo_pago_sat,
           si.is_expense, si.replaced_by_invoice_id, si.partner_id, si.generic_supplier,
           si.supplier_receipt_id, si.purchase_order_id,
           bp.name AS partner_name, bp.tax_name AS partner_tax_name, bp.rfc AS partner_rfc,
           ec.name AS expense_category,
           rep_by.invoice_number AS replaced_by_number, rep_by.uuid_sat AS replaced_by_uuid
      FROM supplier_invoices si
      LEFT JOIN business_partners bp ON bp.id = si.partner_id
      LEFT JOIN tenant_expense_categories ec ON ec.id = si.expense_category_id
      LEFT JOIN supplier_invoices rep_by ON rep_by.id = si.replaced_by_invoice_id
     WHERE si.tenant_id = $1 AND si.type IN ('invoice', 'remission')
       AND si.invoice_date >= $2 AND si.invoice_date < $3
       ${partnerFilter}
     ORDER BY si.invoice_date ASC, si.invoice_number ASC
  `, params)

  const invoiceIds = invoices.map(i => i.id)
  const empty = { rows: [] }

  // ── 2. Contexto y eventos (consultas en lote sobre las anclas) ───────────
  const [links, returns, payments, sustituyeA] = await Promise.all([
    // Recepciones ligadas (N:N + columna legacy) con su OC.
    invoiceIds.length ? query(`
      SELECT irl.supplier_invoice_id, sr.id AS receipt_id, sr.receipt_number,
             sr.received_date, sr.status AS receipt_status, sr.document_number AS supplier_doc,
             po.order_number, po.created_at::date AS oc_date, po.status AS oc_status, po.total_mxn AS oc_total
        FROM invoice_receipt_links irl
        JOIN supplier_receipts sr ON sr.id = irl.supplier_receipt_id
        LEFT JOIN purchase_orders po ON po.id = sr.purchase_order_id
       WHERE irl.tenant_id = $1 AND irl.supplier_invoice_id = ANY($2::uuid[])
      UNION
      SELECT si.id, sr.id, sr.receipt_number, sr.received_date, sr.status, sr.document_number,
             po.order_number, po.created_at::date, po.status, po.total_mxn
        FROM supplier_invoices si
        JOIN supplier_receipts sr ON sr.id = si.supplier_receipt_id
        LEFT JOIN purchase_orders po ON po.id = sr.purchase_order_id
       WHERE si.tenant_id = $1 AND si.id = ANY($2::uuid[])
    `, [tenantId, invoiceIds]) : empty,

    // Devoluciones que tocan estas facturas (origen o resolución), con NC /
    // sustituta / reposición ligadas.
    invoiceIds.length ? query(`
      SELECT r.id, r.return_number, r.status, r.confirmed_at::date AS confirmed_date,
             r.updated_at::date AS resolved_date, r.total_mxn, r.fiscal_resolution,
             r.credit_status, r.replacement_expected, r.replacement_completed_at::date AS replacement_date,
             r.supplier_invoice_id, r.cancelled_invoice_id, r.substitute_invoice_id, r.source_receipt_id,
             cn.invoice_number AS cn_number, cn.uuid_sat AS cn_uuid,
             cn.invoice_date AS cn_date, cn.total_mxn AS cn_total,
             sub.invoice_number AS sub_number, sub.uuid_sat AS sub_uuid,
             rr.receipt_number AS replacement_receipt
        FROM supplier_returns r
        LEFT JOIN supplier_invoices cn  ON cn.id  = r.credit_note_invoice_id
        LEFT JOIN supplier_invoices sub ON sub.id = r.substitute_invoice_id
        LEFT JOIN supplier_receipts rr  ON rr.replacement_return_id = r.id
       WHERE r.tenant_id = $1 AND r.status <> 'cancelled'
         AND (r.supplier_invoice_id  = ANY($2::uuid[])
           OR r.cancelled_invoice_id = ANY($2::uuid[]))
    `, [tenantId, invoiceIds]) : empty,

    // Pagos aplicados (y reversas) + banco.
    invoiceIds.length ? query(`
      SELECT spa.supplier_invoice_id, spa.amount_applied,
             sp.id AS payment_id, sp.payment_date, sp.method, sp.reference,
             sp.reversed_at::date AS reversed_date, sp.reversal_reason, sp.rep_requested_at::date AS rep_requested_date,
             ba.bank_name, ba.alias AS bank_alias
        FROM supplier_payment_applications spa
        JOIN supplier_payments sp ON sp.id = spa.supplier_payment_id
        LEFT JOIN bank_accounts ba ON ba.id = sp.bank_account_id
       WHERE sp.tenant_id = $1 AND spa.supplier_invoice_id = ANY($2::uuid[])
       ORDER BY sp.payment_date ASC
    `, [tenantId, invoiceIds]) : empty,

    // Anclas que SUSTITUYEN a una factura cancelada (la liga vive en la vieja).
    invoiceIds.length ? query(`
      SELECT old.replaced_by_invoice_id AS anchor_id,
             old.invoice_number AS old_number, old.uuid_sat AS old_uuid
        FROM supplier_invoices old
       WHERE old.tenant_id = $1 AND old.replaced_by_invoice_id = ANY($2::uuid[])
    `, [tenantId, invoiceIds]) : empty,
  ])

  // REPs de los pagos involucrados.
  const paymentIds = [...new Set(payments.rows.map(p => p.payment_id))]
  const { rows: reps } = paymentIds.length ? await query(`
    SELECT spc.supplier_payment_id, spc.cfdi_uuid, spc.serie, spc.folio,
           spc.issue_date, spc.payment_date, spc.amount, spc.currency, spc.match_status, spc.source
      FROM supplier_payment_complements spc
     WHERE spc.tenant_id = $1 AND spc.supplier_payment_id = ANY($2::uuid[])
     ORDER BY spc.created_at ASC
  `, [tenantId, paymentIds]) : empty

  // ── 3. Armar expedientes ─────────────────────────────────────────────────
  const byInvoice = (rows, key = 'supplier_invoice_id') => {
    const m = new Map()
    for (const r of rows) {
      const k = r[key]
      if (!m.has(k)) m.set(k, [])
      m.get(k).push(r)
    }
    return m
  }
  const linksBy    = byInvoice(links.rows)
  const paymentsBy = byInvoice(payments.rows)
  const sustBy     = byInvoice(sustituyeA.rows, 'anchor_id')
  const repsByPayment = byInvoice(reps, 'supplier_payment_id')

  // Devoluciones: pueden ligar por factura origen o por factura cancelada.
  const returnsBy = new Map()
  for (const r of returns.rows) {
    for (const k of [r.supplier_invoice_id, r.cancelled_invoice_id]) {
      if (!k) continue
      if (!returnsBy.has(k)) returnsBy.set(k, [])
      if (!returnsBy.get(k).includes(r)) returnsBy.get(k).push(r)
    }
  }

  const chains = invoices.map(inv => {
    const events = []
    const push = (type, date, doc, uuid, amount, detail) =>
      events.push({ type, label: EVENT_LABELS[type], date: toISODate(date), doc: doc || null,
                    uuid: uuid || null, amount: amount != null ? parseFloat(amount) : null,
                    detail: detail || null })

    // OC(s) y recepciones (dedupe por folio).
    const ctx = linksBy.get(inv.id) || []
    const ocs = new Map(), receipts = new Map()
    for (const l of ctx) {
      if (l.order_number && !ocs.has(l.order_number)) {
        ocs.set(l.order_number, l)
        push('oc', l.oc_date, l.order_number, null, l.oc_total, `Estado: ${l.oc_status}`)
      }
      if (!receipts.has(l.receipt_number)) {
        receipts.set(l.receipt_number, l)
        push('receipt', l.received_date, l.receipt_number, null, null,
             l.supplier_doc ? `Documento del proveedor: ${l.supplier_doc}` : null)
      }
    }

    // La factura misma.
    push(inv.type === 'remission' ? 'remission_cxp' : 'invoice',
         inv.invoice_date, inv.invoice_number, inv.uuid_sat, inv.total_mxn,
         inv.is_expense ? `Gasto${inv.expense_category ? ` · ${inv.expense_category}` : ''}` : null)

    // ¿Esta factura sustituye a una cancelada?
    for (const s of (sustBy.get(inv.id) || [])) {
      push('substitutes', inv.invoice_date, s.old_number, s.old_uuid, null, null)
    }

    // Devoluciones y su resolución.
    let hasNc = false
    for (const r of (returnsBy.get(inv.id) || [])) {
      push('return', r.confirmed_date, r.return_number, null, r.total_mxn,
           r.replacement_expected ? 'Espera reposición en especie' : null)
      if (r.replacement_receipt) {
        push('replacement', r.replacement_date, r.replacement_receipt, null, null,
             `Reposición de ${r.return_number}`)
      }
      if (r.fiscal_resolution === 'credit_note' && r.cn_number) {
        hasNc = true
        push('credit_note', r.cn_date, r.cn_number, r.cn_uuid, r.cn_total, `Por devolución ${r.return_number}`)
      }
      if (r.fiscal_resolution === 'cancellation' && r.cancelled_invoice_id === inv.id) {
        push('cancelled', r.resolved_date, inv.invoice_number, inv.uuid_sat, null,
             `Por devolución ${r.return_number}`)
      }
      if (r.fiscal_resolution === 'substitution' && r.cancelled_invoice_id === inv.id) {
        push('substituted', r.resolved_date, r.sub_number, r.sub_uuid, null,
             `Por devolución ${r.return_number}`)
      }
    }
    // Cancelada/sustituida sin devolución de por medio (u otra vía).
    if (inv.status === 'cancelled' && !events.some(e => e.type === 'cancelled' || e.type === 'substituted')) {
      if (inv.replaced_by_invoice_id) {
        push('substituted', null, inv.replaced_by_number, inv.replaced_by_uuid, null, null)
      } else {
        push('cancelled', null, inv.invoice_number, inv.uuid_sat, null, null)
      }
    }

    // Pagos, reversas, solicitudes y REPs.
    let paidTotal = 0
    const seenPayments = new Set()
    for (const p of (paymentsBy.get(inv.id) || [])) {
      const bank = p.bank_name ? ` · ${p.bank_name}${p.bank_alias ? ` (${p.bank_alias})` : ''}` : ''
      push('payment', p.payment_date, p.reference, null, p.amount_applied,
           `${METHOD_LABEL[p.method] || p.method}${bank}`)
      if (p.reversed_date) {
        push('payment_reversed', p.reversed_date, p.reference, null, -parseFloat(p.amount_applied),
             p.reversal_reason || null)
      } else if (REP_METHODS.has(p.method)) {
        // Solo el dinero real exige REP — las notas de crédito y aplicaciones
        // de anticipo no generan complemento de pago del proveedor.
        paidTotal += parseFloat(p.amount_applied)
      }
      if (seenPayments.has(p.payment_id)) continue
      seenPayments.add(p.payment_id)
      if (p.rep_requested_date) {
        push('rep_requested', p.rep_requested_date, p.reference, null, null, null)
      }
      for (const rep of (repsByPayment.get(p.payment_id) || [])) {
        push('rep', rep.payment_date || rep.issue_date,
             [rep.serie, rep.folio].filter(Boolean).join('-') || null, rep.cfdi_uuid, rep.amount,
             rep.match_status === 'matched' ? 'Cruzado con el pago' : 'En revisión — no cuadra aún')
      }
    }

    // Semáforo REP del expediente (solo facturas PPD vigentes).
    let repStatus = 'not_required'
    if (inv.metodo_pago_sat === 'PPD' && inv.status !== 'cancelled') {
      const repTotal = paymentIdsOf(paymentsBy.get(inv.id)).reduce((s, pid) =>
        s + (repsByPayment.get(pid) || [])
              .filter(r => r.match_status === 'matched')
              .reduce((x, r) => x + parseFloat(r.amount), 0), 0)
      if (paidTotal <= 0.005) repStatus = 'pending_payment'
      else if (repTotal <= 0.005) repStatus = 'missing'
      else repStatus = amountsClose(repTotal, paidTotal) ? 'ok' : 'mismatch'
    }

    // Cronológico; los eventos sin fecha (raros) al final, preservando su orden.
    events.sort((a, b) => (a.date || '9999-12-31').localeCompare(b.date || '9999-12-31'))

    return {
      invoice: {
        id: inv.id, number: inv.invoice_number, type: inv.type, status: inv.status,
        uuid: inv.uuid_sat, invoice_date: toISODate(inv.invoice_date), due_date: toISODate(inv.due_date),
        total_mxn: parseFloat(inv.total_mxn || 0), balance: parseFloat(inv.balance || 0),
        // IVA en MXN: `tax` viene en la moneda del CFDI, se prorratea igual que
        // en el reporte contable para que cuadre en facturas en USD.
        tax_mxn: ivaMxn(inv),
        metodo_pago: inv.metodo_pago_sat, is_expense: inv.is_expense,
        expense_category: inv.expense_category || null,
      },
      partner: {
        id: inv.partner_id,
        name: inv.partner_tax_name || inv.partner_name || inv.generic_supplier || '—',
        rfc: inv.partner_rfc || null,
        generic: !inv.partner_id,
      },
      ocs: [...ocs.keys()],
      receipts: [...receipts.keys()],
      flags: {
        paid: parseFloat(inv.balance || 0) <= 0.005 && inv.status !== 'cancelled',
        cancelled: inv.status === 'cancelled',
        has_nc: hasNc,
        rep_status: repStatus,
      },
      events,
    }
  })

  // ── 4. OCs del periodo aún sin factura (expedientes abiertos) ────────────
  const ocParams = [tenantId, from, to]
  let ocPartnerFilter = ''
  if (partnerId) { ocParams.push(partnerId); ocPartnerFilter = `AND po.partner_id = $${ocParams.length}` }
  const { rows: pendingOcs } = await query(`
    SELECT po.order_number, po.created_at::date AS oc_date, po.status, po.total_mxn,
           COALESCE(bp.tax_name, bp.name, po.generic_supplier, '—') AS partner_name,
           COALESCE((SELECT string_agg(sr.receipt_number, ', ' ORDER BY sr.receipt_number)
              FROM supplier_receipts sr
             WHERE sr.purchase_order_id = po.id AND sr.status = 'confirmed'), '') AS receipts
      FROM purchase_orders po
      LEFT JOIN business_partners bp ON bp.id = po.partner_id
     WHERE po.tenant_id = $1 AND po.status NOT IN ('cancelled')
       AND po.created_at >= $2 AND po.created_at < $3
       ${ocPartnerFilter}
       AND NOT EXISTS (
         SELECT 1 FROM supplier_receipts sr
           JOIN invoice_receipt_links irl ON irl.supplier_receipt_id = sr.id
           JOIN supplier_invoices si ON si.id = irl.supplier_invoice_id AND si.status <> 'cancelled'
          WHERE sr.purchase_order_id = po.id)
       AND NOT EXISTS (
         SELECT 1 FROM supplier_invoices si2
          WHERE si2.purchase_order_id = po.id AND si2.status <> 'cancelled')
     ORDER BY po.created_at ASC
  `, ocParams)

  // Totales del periodo: solo expedientes VIGENTES (una factura cancelada no
  // compra ni acredita IVA). A lo comprado se le restan las notas de crédito
  // recibidas, que es lo que realmente quedó a cargo del proveedor.
  const live = chains.filter(c => !c.flags.cancelled)
  const ncTotal = live.reduce((s, c) =>
    s + c.events.filter(e => e.type === 'credit_note').reduce((x, e) => x + (e.amount || 0), 0), 0)
  const grossTotal = live.reduce((s, c) => s + c.invoice.total_mxn, 0)
  const ivaPendingRep = live
    .filter(c => ['missing', 'mismatch'].includes(c.flags.rep_status))
    .reduce((s, c) => s + c.invoice.tax_mxn, 0)

  return {
    period: { from, to },
    summary: {
      chains: chains.length,
      paid: chains.filter(c => c.flags.paid).length,
      cancelled: chains.filter(c => c.flags.cancelled).length,
      with_nc: chains.filter(c => c.flags.has_nc).length,
      rep_missing: chains.filter(c => ['missing', 'mismatch'].includes(c.flags.rep_status)).length,
      pending_ocs: pendingOcs.length,
      net_purchased_mxn: round2(grossTotal - ncTotal),
      credit_notes_mxn:  round2(ncTotal),
      iva_pending_rep_mxn: round2(ivaPendingRep),
    },
    chains,
    pending_ocs: pendingOcs.map(o => ({
      order_number: o.order_number, date: toISODate(o.oc_date), status: o.status,
      total_mxn: parseFloat(o.total_mxn || 0), partner_name: o.partner_name,
      receipts: o.receipts || null,
    })),
  }
}

const METHOD_LABEL = {
  transfer: 'Transferencia', cash: 'Efectivo', check: 'Cheque',
  credit_card: 'Tarjeta de crédito', credit_note: 'Nota de crédito',
  advance_application: 'Aplicación de anticipo',
}

// Métodos de pago que exigen REP (dinero real; NC y anticipos no).
const REP_METHODS = new Set(['transfer', 'cash', 'check', 'credit_card'])

function paymentIdsOf(apps) {
  return [...new Set((apps || []).filter(p => !p.reversed_date).map(p => p.payment_id))]
}

// IVA del comprobante en MXN. `tax`/`total` están en la moneda del CFDI, así que
// se prorratea sobre total_mxn (mismo criterio que el reporte contable) para no
// inflar el IVA de una factura en USD.
function ivaMxn(inv) {
  const tax      = parseFloat(inv.tax || 0)
  const total    = parseFloat(inv.total || 0)
  const totalMxn = parseFloat(inv.total_mxn || 0)
  if (!tax) return 0
  if (!total || Math.abs(total - totalMxn) < 0.005) return round2(tax)
  return round2(totalMxn * (tax / total))
}

const round2 = (n) => Math.round(n * 100) / 100

module.exports = { getPurchaseTraceability, EVENT_LABELS }
