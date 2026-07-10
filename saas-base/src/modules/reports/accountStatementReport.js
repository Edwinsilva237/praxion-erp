'use strict'

// Estado de cuenta — Cuentas por cobrar (direction='in') o por pagar ('out').
// Es un SNAPSHOT al día de hoy: lista todos los documentos con saldo abierto
// (pending/partial), clasifica cada uno según fecha de vencimiento, y agrega
// saldos a favor en anticipos (y notas de crédito para CXC).
//
// No hay concepto de "periodo": el estado de cuenta refleja deudas vigentes,
// no actividad histórica.

const { query } = require('../../db')
const { LOCAL_TODAY } = require('../../utils/sqlTime')

const DUE_SOON_DAYS = 7

// ─────────────────────────────────────────────────────────────────────────────
// Configuración por dirección
// ─────────────────────────────────────────────────────────────────────────────

function getConfig(direction) {
  if (direction === 'in') {
    return {
      docsTable:        'accounts_receivable',
      advancesTable:    'ar_advances',
      advancesDateCol:  'receipt_date',     // ar_advances usa receipt_date
      hasCreditNotes:   true,
      partnerNoun:      'cliente',
      partnerNounPlural:'clientes',
      // OC del cliente: vive en la factura/remisión origen del documento CXC.
      poSelect:         `COALESCE(inv.po_number, dn.po_number)`,
      poJoins:          `
        LEFT JOIN invoices       inv ON inv.id = d.document_id AND d.document_type = 'invoice'
        LEFT JOIN delivery_notes dn  ON dn.id  = d.document_id AND d.document_type = 'remission'
      `,
    }
  }
  if (direction === 'out') {
    return {
      docsTable:        'accounts_payable',
      advancesTable:    'ap_advances',
      advancesDateCol:  'payment_date',     // ap_advances usa payment_date
      hasCreditNotes:   false,
      partnerNoun:      'proveedor',
      partnerNounPlural:'proveedores',
      // CXP no referencia una OC de cliente.
      poSelect:         `NULL::varchar`,
      poJoins:          ``,
    }
  }
  const err = new Error(`direction debe ser 'in' u 'out' (recibió '${direction}')`)
  err.status = 400
  throw err
}

// Cláusula SQL que clasifica un documento por estado de vencimiento.
// Se usa idéntica en varias queries.
const STATUS_CASE = `
  CASE
    WHEN d.due_date IS NULL                                 THEN 'no_due'
    WHEN d.due_date <  ${LOCAL_TODAY}                         THEN 'overdue'
    WHEN d.due_date <= ${LOCAL_TODAY} + INTERVAL '${DUE_SOON_DAYS} days' THEN 'due_soon'
    ELSE 'current'
  END
`

/**
 * Snapshot completo del estado de cuenta (todos los partners).
 *
 * @param {object} params
 * @param {string} params.tenantId
 * @param {'in'|'out'} params.direction
 * @param {object} [params.filters] — partnerId, statusFilter, search
 */
async function getAccountStatement({ tenantId, direction, filters = {} }) {
  const cfg = getConfig(direction)

  const [documents, byPartner, advances, creditNotes] = await Promise.all([
    getOpenDocuments(tenantId, cfg, filters),
    getByPartner(tenantId, cfg, filters),
    getAvailableAdvances(tenantId, cfg, filters.partnerId),
    cfg.hasCreditNotes ? getApplicableCreditNotes(tenantId, filters.partnerId) : Promise.resolve([]),
  ])

  const summary = buildSummary(documents, advances, creditNotes)

  return {
    direction,
    snapshot_date: new Date().toISOString().slice(0, 10),
    due_soon_days: DUE_SOON_DAYS,
    summary,
    by_partner: byPartner,
    documents,
    advances,
    credit_notes: creditNotes,
    generated_at:  new Date().toISOString(),
  }
}

/**
 * Estado de cuenta de UN partner — para PDF individual / envío por correo.
 */
async function getPartnerStatement({ tenantId, direction, partnerId }) {
  const cfg = getConfig(direction)

  const [partnerRows, documents, advances, creditNotes, contacts] = await Promise.all([
    query(`
      SELECT id, name, tax_name, rfc, type
        FROM business_partners
       WHERE id = $1 AND tenant_id = $2
    `, [partnerId, tenantId]),
    getOpenDocuments(tenantId, cfg, { partnerId }),
    getAvailableAdvances(tenantId, cfg, partnerId),
    cfg.hasCreditNotes ? getApplicableCreditNotes(tenantId, partnerId) : Promise.resolve([]),
    query(`
      SELECT id, name, position, email, phone, is_primary
        FROM business_partner_contacts
       WHERE business_partner_id = $1
       ORDER BY is_primary DESC, name
    `, [partnerId]),
  ])

  if (partnerRows.rows.length === 0) {
    const err = new Error('Socio de negocio no encontrado.')
    err.status = 404
    throw err
  }

  const summary = buildSummary(documents, advances, creditNotes)

  return {
    direction,
    snapshot_date: new Date().toISOString().slice(0, 10),
    due_soon_days: DUE_SOON_DAYS,
    partner:   partnerRows.rows[0],
    contacts:  contacts.rows,
    summary,
    documents,
    advances,
    credit_notes: creditNotes,
    generated_at: new Date().toISOString(),
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Queries
// ─────────────────────────────────────────────────────────────────────────────

async function getOpenDocuments(tenantId, cfg, filters) {
  const conditions = [
    'd.tenant_id = $1',
    `d.status IN ('pending','partial')`,
  ]
  const params = [tenantId]
  let idx = 2

  if (filters.partnerId) {
    conditions.push(`d.partner_id = $${idx++}`)
    params.push(filters.partnerId)
  }
  if (filters.search) {
    conditions.push(`(d.document_number ILIKE $${idx} OR bp.name ILIKE $${idx} OR bp.rfc ILIKE $${idx})`)
    params.push(`%${filters.search}%`)
    idx++
  }

  const { rows } = await query(`
    SELECT d.id, d.document_type, d.document_number,
           d.partner_id, bp.name AS partner_name, bp.rfc AS partner_rfc,
           d.issue_date, d.due_date,
           d.amount_total, d.amount_paid, d.amount_pending,
           d.status AS doc_status,
           ${cfg.poSelect} AS po_number,
           ${STATUS_CASE} AS aging_status,
           (CASE
             WHEN d.due_date IS NULL THEN NULL
             ELSE (${LOCAL_TODAY} - d.due_date)
           END)::int AS days_overdue
      FROM ${cfg.docsTable} d
      JOIN business_partners bp ON bp.id = d.partner_id
      ${cfg.poJoins}
     WHERE ${conditions.join(' AND ')}
     ORDER BY
       CASE ${STATUS_CASE}
         WHEN 'overdue'  THEN 1
         WHEN 'due_soon' THEN 2
         WHEN 'current'  THEN 3
         WHEN 'no_due'   THEN 4
       END,
       d.due_date ASC NULLS LAST,
       d.issue_date ASC
  `, params)

  let documents = rows.map(r => ({
    id:              r.id,
    document_type:   r.document_type,
    document_number: r.document_number,
    partner_id:      r.partner_id,
    partner_name:    r.partner_name,
    partner_rfc:     r.partner_rfc,
    issue_date:      r.issue_date,
    due_date:        r.due_date,
    amount_total:    parseFloat(r.amount_total)   || 0,
    amount_paid:     parseFloat(r.amount_paid)    || 0,
    amount_pending:  parseFloat(r.amount_pending) || 0,
    doc_status:      r.doc_status,
    po_number:       r.po_number || null,
    aging_status:    r.aging_status,
    days_overdue:    r.days_overdue,
  }))

  // Filtro adicional aging_status si se pidió.
  if (filters.statusFilter) {
    documents = documents.filter(d => d.aging_status === filters.statusFilter)
  }

  return documents
}

async function getByPartner(tenantId, cfg, filters) {
  const conditions = [
    'd.tenant_id = $1',
    `d.status IN ('pending','partial')`,
  ]
  const params = [tenantId]
  let idx = 2

  if (filters.partnerId) {
    conditions.push(`d.partner_id = $${idx++}`)
    params.push(filters.partnerId)
  }

  const { rows } = await query(`
    SELECT bp.id AS partner_id, bp.name AS partner_name,
           bp.rfc AS partner_rfc, bp.tax_name AS partner_legal_name,
           COUNT(*)::int                            AS docs_count,
           COALESCE(SUM(d.amount_pending),0)::numeric AS pending_amount,
           COUNT(*) FILTER (WHERE ${STATUS_CASE} = 'overdue')::int            AS overdue_count,
           COALESCE(SUM(d.amount_pending) FILTER (WHERE ${STATUS_CASE} = 'overdue'),0)::numeric AS overdue_amount,
           COUNT(*) FILTER (WHERE ${STATUS_CASE} = 'due_soon')::int           AS due_soon_count,
           COALESCE(SUM(d.amount_pending) FILTER (WHERE ${STATUS_CASE} = 'due_soon'),0)::numeric AS due_soon_amount,
           COUNT(*) FILTER (WHERE ${STATUS_CASE} = 'current')::int            AS current_count,
           COALESCE(SUM(d.amount_pending) FILTER (WHERE ${STATUS_CASE} = 'current'),0)::numeric AS current_amount,
           COUNT(*) FILTER (WHERE ${STATUS_CASE} = 'no_due')::int             AS no_due_count,
           COALESCE(SUM(d.amount_pending) FILTER (WHERE ${STATUS_CASE} = 'no_due'),0)::numeric  AS no_due_amount,
           MAX(${LOCAL_TODAY} - d.due_date) FILTER (WHERE d.due_date IS NOT NULL AND d.due_date < ${LOCAL_TODAY})::int AS max_days_overdue
      FROM ${cfg.docsTable} d
      JOIN business_partners bp ON bp.id = d.partner_id
     WHERE ${conditions.join(' AND ')}
     GROUP BY bp.id, bp.name, bp.rfc, bp.tax_name
     ORDER BY overdue_amount DESC, pending_amount DESC
  `, params)

  return rows.map(r => ({
    partner_id:         r.partner_id,
    partner_name:       r.partner_name,
    partner_rfc:        r.partner_rfc,
    partner_legal_name: r.partner_legal_name,
    docs_count:         r.docs_count,
    pending_amount:     parseFloat(r.pending_amount) || 0,
    overdue_count:      r.overdue_count,
    overdue_amount:     parseFloat(r.overdue_amount) || 0,
    due_soon_count:     r.due_soon_count,
    due_soon_amount:    parseFloat(r.due_soon_amount) || 0,
    current_count:      r.current_count,
    current_amount:     parseFloat(r.current_amount) || 0,
    no_due_count:       r.no_due_count,
    no_due_amount:      parseFloat(r.no_due_amount) || 0,
    max_days_overdue:   r.max_days_overdue,
  }))
}

async function getAvailableAdvances(tenantId, cfg, partnerId) {
  const conditions = [
    'a.tenant_id = $1',
    'a.amount_available > 0',
  ]
  const params = [tenantId]
  if (partnerId) {
    conditions.push('a.partner_id = $2')
    params.push(partnerId)
  }
  // Aliasamos la fecha a `receipt_date` en la respuesta para mantener un solo
  // shape público (la columna física se llama distinto en cada lado).
  const { rows } = await query(`
    SELECT a.id, a.partner_id, bp.name AS partner_name, bp.rfc AS partner_rfc,
           a.amount, a.amount_applied, a.amount_available,
           a.payment_method, a.reference,
           a.${cfg.advancesDateCol} AS receipt_date,
           a.notes
      FROM ${cfg.advancesTable} a
      JOIN business_partners bp ON bp.id = a.partner_id
     WHERE ${conditions.join(' AND ')}
     ORDER BY a.${cfg.advancesDateCol} DESC
  `, params)
  return rows.map(r => ({
    id:               r.id,
    partner_id:       r.partner_id,
    partner_name:     r.partner_name,
    partner_rfc:      r.partner_rfc,
    amount:           parseFloat(r.amount)           || 0,
    amount_applied:   parseFloat(r.amount_applied)   || 0,
    amount_available: parseFloat(r.amount_available) || 0,
    payment_method:   r.payment_method,
    reference:        r.reference,
    receipt_date:     r.receipt_date,
    notes:            r.notes,
  }))
}

async function getApplicableCreditNotes(tenantId, partnerId) {
  // NCs timbradas que aún tienen saldo aplicable. El modelo no tiene
  // amount_applied/available — para simplificar las traemos todas las que
  // estén con status='stamped' y se muestran como "saldo a favor".
  const conditions = [
    'cn.tenant_id = $1',
    `cn.status = 'stamped'`,
  ]
  const params = [tenantId]
  if (partnerId) {
    conditions.push('cn.partner_id = $2')
    params.push(partnerId)
  }
  const { rows } = await query(`
    SELECT cn.id, cn.document_number, cn.partner_id, bp.name AS partner_name,
           cn.amount, cn.total, cn.issue_date, cn.reason, cn.cfdi_uuid
      FROM credit_notes cn
      JOIN business_partners bp ON bp.id = cn.partner_id
     WHERE ${conditions.join(' AND ')}
     ORDER BY cn.issue_date DESC
  `, params)
  return rows.map(r => ({
    id:              r.id,
    document_number: r.document_number,
    partner_id:      r.partner_id,
    partner_name:    r.partner_name,
    amount:          parseFloat(r.amount) || 0,
    total:           parseFloat(r.total)  || 0,
    issue_date:      r.issue_date,
    reason:          r.reason,
    cfdi_uuid:       r.cfdi_uuid,
  }))
}

// ─────────────────────────────────────────────────────────────────────────────
// Resumen — sumas y saldo neto
// ─────────────────────────────────────────────────────────────────────────────

function buildSummary(documents, advances, creditNotes) {
  const groups = { overdue: [], due_soon: [], current: [], no_due: [] }
  for (const d of documents) groups[d.aging_status]?.push(d)

  const sum = arr => arr.reduce((s, d) => s + d.amount_pending, 0)
  const advancesAmount = advances.reduce((s, a) => s + a.amount_available, 0)
  const creditNotesAmount = creditNotes.reduce((s, c) => s + c.total, 0)
  const totalPending = sum(documents)

  return {
    total_pending_amount: totalPending,
    total_pending_count:  documents.length,
    overdue:  { amount: sum(groups.overdue),  count: groups.overdue.length },
    due_soon: { amount: sum(groups.due_soon), count: groups.due_soon.length },
    current:  { amount: sum(groups.current),  count: groups.current.length },
    no_due:   { amount: sum(groups.no_due),   count: groups.no_due.length },
    advances_available:     { amount: advancesAmount,    count: advances.length },
    credit_notes_available: { amount: creditNotesAmount, count: creditNotes.length },
    net_balance: totalPending - advancesAmount - creditNotesAmount,
  }
}

/**
 * Líneas (productos + precios) de UN documento del estado de cuenta, para
 * expandir in-line y "recordar qué se está pagando/cobrando". Recibe el id de la
 * cuenta (accounts_payable/receivable) + dirección; resuelve el documento origen:
 *   - out (CxP): supplier_receipt_lines (por factura; fallback recepción).
 *   - in  (CxC): invoice_lines (factura) o delivery_note_lines (remisión).
 * Documentos sin líneas (CFDI de gasto sin recepción) → { lines: [] }.
 */
async function getDocumentLines({ tenantId, direction, docId }) {
  const cfg = getConfig(direction)  // valida direction ('in'|'out')
  const { rows: dr } = await query(
    `SELECT document_id, document_type FROM ${cfg.docsTable} WHERE id = $1 AND tenant_id = $2`,
    [docId, tenantId]
  )
  if (!dr[0] || !dr[0].document_id) return { lines: [] }
  const { document_id, document_type } = dr[0]

  if (direction === 'out') {
    const LINE_SELECT = `
      SELECT srl.id, srl.unit, srl.unit_price, srl.subtotal,
             srl.quantity_received AS quantity,
             COALESCE(p.name, rm.name, srl.description) AS item_name, p.sku AS item_sku
        FROM supplier_receipt_lines srl
        LEFT JOIN products p       ON p.id  = srl.item_id AND srl.item_type = 'product'
        LEFT JOIN raw_materials rm ON rm.id = srl.item_id AND srl.item_type = 'raw_material'`
    let { rows } = await query(
      `${LINE_SELECT} WHERE srl.invoiced_by_invoice_id = $1 ORDER BY srl.line_number`, [document_id])
    if (rows.length === 0) {
      const { rows: rc } = await query(
        `SELECT supplier_receipt_id FROM supplier_invoices WHERE id = $1 AND tenant_id = $2`,
        [document_id, tenantId])
      if (rc[0]?.supplier_receipt_id) {
        rows = (await query(
          `${LINE_SELECT} WHERE srl.supplier_receipt_id = $1 ORDER BY srl.line_number`,
          [rc[0].supplier_receipt_id])).rows
      }
    }
    return { lines: rows }
  }

  // direction === 'in' (CxC)
  if (document_type === 'invoice') {
    const { rows } = await query(
      `SELECT il.id, il.unit, il.unit_price, il.subtotal, il.quantity,
              COALESCE(p.name, il.description) AS item_name, p.sku AS item_sku
         FROM invoice_lines il LEFT JOIN products p ON p.id = il.product_id
        WHERE il.invoice_id = $1 ORDER BY il.line_number`, [document_id])
    return { lines: rows }
  }
  if (document_type === 'remission') {
    const { rows } = await query(
      `SELECT dnl.id, dnl.unit, dnl.unit_price, dnl.subtotal,
              dnl.quantity_delivered AS quantity,
              p.name AS item_name, p.sku AS item_sku
         FROM delivery_note_lines dnl LEFT JOIN products p ON p.id = dnl.product_id
        WHERE dnl.delivery_note_id = $1 ORDER BY dnl.line_number`, [document_id])
    return { lines: rows }
  }
  return { lines: [] }
}

/**
 * Pagos aplicados a un documento del estado de cuenta (para ver desde el detalle
 * qué cobro/pago cubrió ese documento). Excluye pagos reversados.
 *   - CxC (in):  ar_payments ligados por ar_id al documento (accounts_receivable).
 *   - CxP (out): supplier_payments vía supplier_payment_applications → accounts_payable.
 */
async function getDocumentPayments({ tenantId, direction, docId }) {
  getConfig(direction) // valida direction ('in'|'out')

  if (direction === 'in') {
    const { rows } = await query(
      `SELECT arp.id, arp.payment_date, arp.amount, arp.payment_method, arp.reference,
              arp.notes, arp.created_at, ar.currency,
              ba.bank_name, ba.alias AS bank_alias, ba.account_number AS bank_account_number,
              u.full_name AS created_by_name, pc.cfdi_uuid AS complement_uuid
         FROM ar_payments arp
         JOIN accounts_receivable ar ON ar.id = arp.ar_id
         LEFT JOIN bank_accounts ba  ON ba.id = arp.bank_account_id
         LEFT JOIN users u           ON u.id  = arp.created_by
         LEFT JOIN payment_complements pc ON pc.id = arp.payment_complement_id
        WHERE arp.tenant_id = $1 AND arp.ar_id = $2 AND arp.reversed_at IS NULL
        ORDER BY arp.payment_date ASC, arp.created_at ASC`,
      [tenantId, docId]
    )
    return { payments: rows }
  }

  // direction === 'out' (CxP)
  const { rows } = await query(
    `SELECT sp.id, sp.payment_date, spa.amount_applied AS amount, sp.method AS payment_method,
            sp.reference, sp.currency, sp.notes, sp.created_at,
            ba.bank_name, ba.alias AS bank_alias, ba.account_number AS bank_account_number,
            u.full_name AS created_by_name
       FROM supplier_payment_applications spa
       JOIN supplier_payments sp   ON sp.id = spa.supplier_payment_id
       JOIN accounts_payable ap2   ON ap2.document_id = spa.supplier_invoice_id
       LEFT JOIN bank_accounts ba  ON ba.id = sp.bank_account_id
       LEFT JOIN users u           ON u.id  = sp.created_by
      WHERE ap2.tenant_id = $1 AND ap2.id = $2 AND sp.reversed_at IS NULL
      ORDER BY sp.payment_date ASC, sp.created_at ASC`,
    [tenantId, docId]
  )
  return { payments: rows }
}

module.exports = { getAccountStatement, getPartnerStatement, getDocumentLines, getDocumentPayments, DUE_SOON_DAYS }
