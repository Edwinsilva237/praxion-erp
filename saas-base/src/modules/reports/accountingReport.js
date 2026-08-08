'use strict'

// Generador del Reporte Contable mensual. Devuelve un workbook .xlsx con
// 5 hojas: Ventas, Cobros, Compras, Pagos a proveedores, Notas de crédito.
// Más una hoja de Resumen IVA al inicio.
//
// El contador típico abre este archivo en Excel y trabaja con sus filtros
// nativos para conciliar contra lo descargado del SAT.

const ExcelJS = require('exceljs')
const { query } = require('../../db')

/**
 * @param {object} params
 * @param {string} params.tenantId
 * @param {string} params.from   - 'YYYY-MM-DD'
 * @param {string} params.to     - 'YYYY-MM-DD'  (exclusivo)
 * @param {string} params.tenantName - para mostrar en la hoja
 * @param {boolean} [params.fiscalOnly=true] - true: solo documentos con valor fiscal
 *   (CFDI timbrados y CFDI recibidos con UUID SAT). false: incluye borradores
 *   y registros internos sin CFDI (útil para análisis no fiscal).
 * @returns {Promise<Buffer>}
 */
async function generateAccountingWorkbook({ tenantId, from, to, tenantName, fiscalOnly = true }) {
  const wb = new ExcelJS.Workbook()
  wb.creator = 'Praxion Systems'
  wb.created = new Date()

  const [sales, paymentsIn, purchases, paymentsOut, creditNotes] = await Promise.all([
    fetchSales(tenantId, from, to, fiscalOnly),
    fetchPaymentsIn(tenantId, from, to),
    fetchPurchases(tenantId, from, to, fiscalOnly),
    fetchPaymentsOut(tenantId, from, to),
    fetchCreditNotes(tenantId, from, to, fiscalOnly),
  ])

  // Hoja de resumen primero
  addSummarySheet(wb, { from, to, tenantName, fiscalOnly, sales, purchases, creditNotes, paymentsIn, paymentsOut })

  addSalesSheet(wb, sales)
  addCreditNotesSheet(wb, creditNotes)
  addPaymentsInSheet(wb, paymentsIn)
  addPurchasesSheet(wb, purchases)
  addPaymentsOutSheet(wb, paymentsOut)

  return wb.xlsx.writeBuffer()
}

// ─────────────────────────────────────────────────────────────────────────────
// Queries
// ─────────────────────────────────────────────────────────────────────────────

async function fetchSales(tenantId, from, to, fiscalOnly = true) {
  // En modo fiscal: solo facturas que llegaron al SAT (tienen stamp_date).
  // Borradores se excluyen implícitamente porque stamp_date IS NULL.
  // En modo análisis (fiscalOnly=false): se filtra por issue_date e incluye
  // borradores también.
  const dateCol = fiscalOnly ? 'inv.stamp_date' : 'inv.issue_date'
  const fiscalFilter = fiscalOnly ? `AND inv.stamp_date IS NOT NULL` : ''

  const { rows } = await query(`
    SELECT inv.id, inv.document_number, inv.cfdi_uuid, inv.folio, inv.series,
           inv.issue_date, inv.stamp_date,
           bp.tax_name AS partner_legal_name, bp.name AS partner_commercial,
           bp.rfc AS partner_rfc,
           inv.currency, inv.exchange_rate_value,
           inv.subtotal, inv.tax_transferred, inv.tax_withheld,
           inv.total, inv.total_mxn,
           inv.payment_method, inv.payment_form, inv.use_cfdi,
           inv.status, inv.cancellation_date, inv.cancellation_reason,
           inv.po_number, inv.notes,
           ar.amount_pending AS balance
      FROM invoices inv
      JOIN business_partners bp ON bp.id = inv.partner_id
      LEFT JOIN accounts_receivable ar ON ar.tenant_id = inv.tenant_id
                                      AND ar.document_type = 'invoice' AND ar.document_id = inv.id
     WHERE inv.tenant_id = $1
       AND inv.cfdi_type = 'I'
       ${fiscalFilter}
       AND ${dateCol} >= $2 AND ${dateCol} < $3
     ORDER BY ${dateCol} ASC, inv.document_number ASC
  `, [tenantId, from, to])

  await attachSalesTrace(tenantId, rows)
  return rows
}

// -----------------------------------------------------------------------------
// Rastro de conciliacion por documento
//
// El contador necesita cruzar cada CFDI contra el estado de cuenta del banco sin
// salir de la hoja: cuando se cobro/pago, a que banco entro (o con que tarjeta
// salio), que complemento lo ampara y si el documento sigue vigente. Todo esto ya
// esta ligado en la operacion; aqui solo se agrega por factura.
// -----------------------------------------------------------------------------

const AR_METHOD_LABEL = {
  cash: 'Efectivo', transfer: 'Transferencia', check: 'Cheque',
  advance_application: 'Anticipo aplicado', credit_note: 'Nota de credito',
}
const AP_METHOD_LABEL = {
  transfer: 'Transferencia', cash: 'Efectivo', check: 'Cheque',
  credit_card: 'Tarjeta de credito',
  advance_application: 'Anticipo aplicado', credit_note: 'Nota de credito',
}
// Solo el dinero real exige complemento de pago; las NC y los anticipos no.
const AR_CASH = new Set(['cash', 'transfer', 'check'])
const AP_CASH = new Set(['cash', 'transfer', 'check', 'credit_card'])

const CANCEL_MOTIVE = {
  '01': '01 con relacion', '02': '02 sin relacion',
  '03': '03 no se realizo', '04': '04 factura global',
}

// Las columnas DATE llegan como Date a medianoche LOCAL: toISOString() las
// correria un dia atras en zonas negativas.
const d10 = (v) => {
  if (!v) return ''
  if (typeof v === 'string') return v.slice(0, 10)
  const x = v instanceof Date ? v : new Date(v)
  if (Number.isNaN(x.getTime())) return ''
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`
}

const groupBy = (rows, key) => {
  const m = new Map()
  for (const r of rows) {
    if (!r[key]) continue
    if (!m.has(r[key])) m.set(r[key], [])
    m.get(r[key]).push(r)
  }
  return m
}

const joinUniq = (arr) => [...new Set(arr.filter(Boolean))].join(' | ')

/** Cobros, complementos emitidos, NC y cancelacion de cada factura de venta. */
async function attachSalesTrace(tenantId, rows) {
  const ids = rows.map(r => r.id).filter(Boolean)
  if (!ids.length) return

  const [pays, reps, ncs, subs] = await Promise.all([
    query(`
      SELECT ar.document_id AS invoice_id, ap.payment_date, ap.amount, ap.payment_method,
             ap.reference, ba.bank_name, ba.alias AS bank_alias
        FROM ar_payments ap
        JOIN accounts_receivable ar ON ar.id = ap.ar_id
        LEFT JOIN bank_accounts ba ON ba.id = ap.bank_account_id
       WHERE ap.tenant_id = $1 AND ap.reversed_at IS NULL
         AND ar.document_type = 'invoice' AND ar.document_id = ANY($2::uuid[])
       ORDER BY ap.payment_date`, [tenantId, ids]),
    query(`
      SELECT pc.invoice_id, pc.cfdi_uuid, pc.payment_date
        FROM payment_complements pc
       WHERE pc.tenant_id = $1 AND pc.status = 'stamped'
         AND pc.invoice_id = ANY($2::uuid[])
       ORDER BY pc.payment_date`, [tenantId, ids]),
    query(`
      SELECT nc.related_invoice_id, nc.document_number, nc.cfdi_uuid, nc.total_mxn
        FROM invoices nc
       WHERE nc.tenant_id = $1 AND nc.type = 'issued' AND nc.cfdi_type = 'E'
         AND nc.status = 'stamped' AND nc.related_invoice_id = ANY($2::uuid[])`, [tenantId, ids]),
    // El folio de la factura sustituta no se guarda en la cancelada: viaja en el
    // payload de la bitacora de la cancelacion ante el SAT (motivo 01).
    query(`
      SELECT al.resource_id AS invoice_id, sub.document_number, sub.cfdi_uuid
        FROM audit_logs al
        JOIN invoices sub ON sub.tenant_id = al.tenant_id
                         AND sub.cfdi_uuid = (al.payload->>'substitution')::uuid
       WHERE al.tenant_id = $1 AND al.action = 'invoice.cancelled_sat'
         AND al.payload->>'substitution' IS NOT NULL
         AND al.resource_id = ANY($2::uuid[])`, [tenantId, ids]),
  ])

  const payBy = groupBy(pays.rows, 'invoice_id')
  const repBy = groupBy(reps.rows, 'invoice_id')
  const ncBy  = groupBy(ncs.rows, 'related_invoice_id')
  const subBy = groupBy(subs.rows, 'invoice_id')

  for (const r of rows) {
    const ps = payBy.get(r.id) || []
    r.payment_dates   = ps.map(p => d10(p.payment_date)).join(' | ')
    r.payment_banks   = joinUniq(ps.map(p =>
      p.bank_name ? `${p.bank_name}${p.bank_alias ? ` (${p.bank_alias})` : ''}` : '(sin banco)'))
    r.payment_methods = joinUniq(ps.map(p => AR_METHOD_LABEL[p.payment_method] || p.payment_method))
    r.payment_refs    = joinUniq(ps.map(p => p.reference))
    r.collected       = ps.reduce((s, p) => s + parseFloat(p.amount || 0), 0)

    const rs = repBy.get(r.id) || []
    r.rep_uuids = rs.map(x => x.cfdi_uuid).join(' | ')
    r.rep_dates = rs.map(x => d10(x.payment_date)).join(' | ')
    const cashPaid = ps.filter(p => AR_CASH.has(p.payment_method))
                       .reduce((s, p) => s + parseFloat(p.amount || 0), 0)
    r.rep_status = r.payment_method !== 'PPD' ? 'No aplica (PUE)'
      : cashPaid <= 0.005 ? 'Sin cobros'
      : rs.length === 0   ? 'FALTA REP'
      : 'Timbrado'

    const ns = ncBy.get(r.id) || []
    r.nc_numbers = ns.map(n => n.document_number).join(' | ')
    r.nc_uuids   = ns.map(n => n.cfdi_uuid).join(' | ')
    r.nc_total   = ns.reduce((s, n) => s + parseFloat(n.total_mxn || 0), 0)

    const sb = (subBy.get(r.id) || [])[0]
    r.substituted_by      = sb ? sb.document_number : ''
    r.substituted_by_uuid = sb ? sb.cfdi_uuid : ''
    r.cancel_motive = r.status === 'cancelled'
      ? (CANCEL_MOTIVE[r.cancellation_reason] || r.cancellation_reason || 'Si')
      : ''
  }
}

async function fetchCreditNotes(tenantId, from, to, fiscalOnly = true) {
  // Las NC emitidas viven en `invoices` con cfdi_type='E' (creditNoteService las
  // timbra ahí y mig 237 les dio `related_invoice_id`). La tabla `credit_notes`
  // es el modelo LEGACY: se sigue leyendo para no perder las de tenants viejos,
  // descartando por UUID las que ya vengan del modelo actual.
  // Modo fiscal: solo NC con valor SAT (timbradas o canceladas ante el SAT).
  const fiscalFilter    = fiscalOnly ? `AND i.status IN ('stamped', 'cancelled')` : ''
  const fiscalFilterLeg = fiscalOnly ? `AND cn.status IN ('stamped', 'cancelled')` : ''

  const { rows } = await query(`
    SELECT i.document_number, i.cfdi_uuid,
           COALESCE(i.stamp_date::date, i.issue_date) AS issue_date,
           bp.tax_name AS partner_legal_name, bp.name AS partner_commercial,
           bp.rfc AS partner_rfc,
           i.subtotal AS amount, i.tax_transferred AS tax_amount, i.total_mxn AS total,
           NULL::text AS reason, i.status::text AS status, i.notes,
           orig.document_number AS original_invoice_number,
           orig.cfdi_uuid       AS original_invoice_uuid
      FROM invoices i
      JOIN business_partners bp ON bp.id = i.partner_id
      LEFT JOIN invoices orig ON orig.id = i.related_invoice_id
     WHERE i.tenant_id = $1 AND i.type = 'issued' AND i.cfdi_type = 'E'
       ${fiscalFilter}
       AND COALESCE(i.stamp_date, i.issue_date::timestamptz) >= $2
       AND COALESCE(i.stamp_date, i.issue_date::timestamptz) <  $3

    UNION ALL

    SELECT cn.document_number, cn.cfdi_uuid, cn.issue_date,
           bp.tax_name, bp.name, bp.rfc,
           cn.amount, cn.tax_amount, cn.total,
           cn.reason::text, cn.status::text, cn.notes,
           inv.document_number, inv.cfdi_uuid
      FROM credit_notes cn
      JOIN business_partners bp ON bp.id = cn.partner_id
      LEFT JOIN invoices inv ON inv.id = cn.original_doc_id AND cn.original_doc_type = 'invoice'
     WHERE cn.tenant_id = $1
       ${fiscalFilterLeg}
       AND cn.issue_date >= $2 AND cn.issue_date < $3
       AND NOT EXISTS (
         SELECT 1 FROM invoices i2
          WHERE i2.tenant_id = cn.tenant_id AND i2.cfdi_type = 'E'
            AND i2.cfdi_uuid IS NOT NULL AND i2.cfdi_uuid = cn.cfdi_uuid)

     ORDER BY 3 ASC
  `, [tenantId, from, to])
  return rows
}

async function fetchPaymentsIn(tenantId, from, to) {
  const { rows } = await query(`
    SELECT ap.payment_date, ap.amount, ap.payment_method, ap.reference,
           ap.notes,
           ar.document_type, ar.document_number AS ar_document_number,
           inv.cfdi_uuid AS invoice_uuid,
           bp.name AS partner_commercial, bp.tax_name AS partner_legal_name,
           bp.rfc AS partner_rfc,
           ba.alias AS bank_account_alias, ba.bank_name AS bank_name,
           pc.cfdi_uuid AS complement_uuid
      FROM ar_payments ap
      LEFT JOIN accounts_receivable ar ON ar.id = ap.ar_id
      LEFT JOIN invoices inv ON inv.id = ar.document_id AND ar.document_type = 'invoice'
      LEFT JOIN business_partners bp   ON bp.id = ar.partner_id
      LEFT JOIN bank_accounts ba       ON ba.id = ap.bank_account_id
      LEFT JOIN payment_complements pc ON pc.invoice_id = ar.document_id
                                       AND ar.document_type = 'invoice'
                                       AND pc.payment_date::date = ap.payment_date::date
     WHERE ap.tenant_id = $1
       AND ap.payment_date >= $2 AND ap.payment_date < $3
     ORDER BY ap.payment_date ASC
  `, [tenantId, from, to])
  return rows
}

async function fetchPurchases(tenantId, from, to, fiscalOnly = true) {
  // Modo fiscal: solo CFDI reales (con UUID SAT). Registros de gasto
  // internos sin CFDI (ticket, recibo informal) NO son deducibles y se
  // excluyen del reporte para el contador.
  // uuid_sat es de tipo UUID en BD: solo IS NOT NULL, no comparar contra ''.
  const fiscalFilter = fiscalOnly ? `AND si.uuid_sat IS NOT NULL` : ''

  const { rows } = await query(`
    SELECT si.id, si.invoice_number, si.uuid_sat, si.folio, si.serie, si.rfc_emisor,
           si.invoice_date, si.due_date, si.received_date,
           bp.name AS partner_name, bp.tax_name AS partner_legal_name,
           bp.rfc AS partner_rfc,
           si.generic_supplier,
           si.currency, si.exchange_rate_value,
           si.subtotal, si.tax, si.total, si.total_mxn, si.balance,
           si.status, si.notes, si.type, si.metodo_pago_sat,
           rep_by.invoice_number AS substituted_by,
           rep_by.uuid_sat       AS substituted_by_uuid
      FROM supplier_invoices si
      LEFT JOIN business_partners bp ON bp.id = si.partner_id
      LEFT JOIN supplier_invoices rep_by ON rep_by.id = si.replaced_by_invoice_id
     WHERE si.tenant_id = $1
       ${fiscalFilter}
       AND si.invoice_date >= $2 AND si.invoice_date < $3
     ORDER BY si.invoice_date ASC
  `, [tenantId, from, to])

  await attachPurchaseTrace(tenantId, rows)
  return rows
}

/**
 * Pagos (con banco o tarjeta), REP recibidos, NC de proveedor y sustitucion de
 * cada CFDI recibido. El REP de compras cuelga del PAGO, no de la factura.
 */
async function attachPurchaseTrace(tenantId, rows) {
  const ids = rows.map(r => r.id).filter(Boolean)
  if (!ids.length) return

  const { rows: pays } = await query(`
    SELECT spa.supplier_invoice_id AS invoice_id, spa.amount_applied,
           sp.id AS payment_id, sp.payment_date, sp.method, sp.reference,
           ba.bank_name, ba.alias AS bank_alias,
           cc.bank_name AS card_bank, cc.alias AS card_alias, cc.last_four
      FROM supplier_payment_applications spa
      JOIN supplier_payments sp ON sp.id = spa.supplier_payment_id
      LEFT JOIN bank_accounts ba ON ba.id = sp.bank_account_id
      LEFT JOIN credit_cards  cc ON cc.id = sp.credit_card_id
     WHERE sp.tenant_id = $1 AND sp.reversed_at IS NULL
       AND spa.supplier_invoice_id = ANY($2::uuid[])
     ORDER BY sp.payment_date`, [tenantId, ids])

  const paymentIds = [...new Set(pays.map(p => p.payment_id))]
  const [reps, ncs] = await Promise.all([
    paymentIds.length ? query(`
      SELECT spc.supplier_payment_id, spc.cfdi_uuid, spc.serie, spc.folio,
             COALESCE(spc.payment_date, spc.issue_date) AS rep_date, spc.match_status
        FROM supplier_payment_complements spc
       WHERE spc.tenant_id = $1 AND spc.supplier_payment_id = ANY($2::uuid[])`,
      [tenantId, paymentIds]) : { rows: [] },
    query(`
      SELECT r.supplier_invoice_id, cn.invoice_number, cn.uuid_sat, cn.total_mxn
        FROM supplier_returns r
        JOIN supplier_invoices cn ON cn.id = r.credit_note_invoice_id
       WHERE r.tenant_id = $1 AND r.status <> 'cancelled'
         AND cn.status <> 'cancelled'
         AND r.supplier_invoice_id = ANY($2::uuid[])`, [tenantId, ids]),
  ])

  const payBy = groupBy(pays, 'invoice_id')
  const repByPayment = groupBy(reps.rows, 'supplier_payment_id')
  const ncBy = groupBy(ncs.rows, 'supplier_invoice_id')

  for (const r of rows) {
    const ps = payBy.get(r.id) || []
    r.payment_dates = ps.map(p => d10(p.payment_date)).join(' | ')
    r.payment_methods = joinUniq(ps.map(p => AP_METHOD_LABEL[p.method] || p.method))
    // De donde salio el dinero: cuenta bancaria o tarjeta de credito.
    r.payment_banks = joinUniq(ps.map(p => {
      if (p.card_bank || p.card_alias) {
        return `${p.card_bank || 'Tarjeta'}${p.last_four ? ` ****${p.last_four}` : ''}`
             + `${p.card_alias ? ` (${p.card_alias})` : ''}`
      }
      if (p.bank_name) return `${p.bank_name}${p.bank_alias ? ` (${p.bank_alias})` : ''}`
      return p.method === 'cash' ? 'Caja / efectivo' : '(sin banco)'
    }))
    r.payment_refs = joinUniq(ps.map(p => p.reference))
    r.paid = ps.reduce((s, p) => s + parseFloat(p.amount_applied || 0), 0)

    const rs = [...new Set(ps.map(p => p.payment_id))]
      .flatMap(pid => repByPayment.get(pid) || [])
    r.rep_folios = joinUniq(rs.map(x => [x.serie, x.folio].filter(Boolean).join('-')))
    r.rep_uuids  = rs.map(x => x.cfdi_uuid).join(' | ')
    r.rep_dates  = rs.map(x => d10(x.rep_date)).join(' | ')
    const cashPaid = ps.filter(p => AP_CASH.has(p.method))
                       .reduce((s, p) => s + parseFloat(p.amount_applied || 0), 0)
    r.rep_status = r.metodo_pago_sat !== 'PPD' ? 'No aplica (PUE)'
      : cashPaid <= 0.005 ? 'Sin pagos'
      : rs.length === 0   ? 'FALTA REP DEL PROVEEDOR'
      : rs.some(x => x.match_status !== 'matched') ? 'Recibido, en revision'
      : 'Recibido'

    const ns = ncBy.get(r.id) || []
    r.nc_numbers = ns.map(n => n.invoice_number).join(' | ')
    r.nc_uuids   = ns.map(n => n.uuid_sat).filter(Boolean).join(' | ')
    r.nc_total   = ns.reduce((s, n) => s + parseFloat(n.total_mxn || 0), 0)

    r.cancel_motive = r.status === 'cancelled' ? 'Si' : ''
  }
}

async function fetchPaymentsOut(tenantId, from, to) {
  const { rows } = await query(`
    SELECT sp.payment_date, sp.amount, sp.amount_mxn, sp.currency,
           sp.exchange_rate_value, sp.method, sp.reference, sp.notes,
           bp.name AS partner_name, bp.tax_name AS partner_legal_name,
           bp.rfc AS partner_rfc,
           sp.generic_supplier,
           ba.alias AS bank_account_alias, ba.bank_name AS bank_name,
           cc.bank_name AS card_bank, cc.alias AS card_alias, cc.last_four AS card_last_four,
           sp.reversed_at::date AS reversed_date,
           -- A que CFDI se aplico este pago (folio + UUID). Sin esto el egreso
           -- se ve en el banco pero no se sabe que documento liquido.
           (SELECT string_agg(si.invoice_number, ' | ' ORDER BY si.invoice_number)
              FROM supplier_payment_applications spa
              JOIN supplier_invoices si ON si.id = spa.supplier_invoice_id
             WHERE spa.supplier_payment_id = sp.id) AS applied_to,
           (SELECT string_agg(si.uuid_sat::text, ' | ' ORDER BY si.invoice_number)
              FROM supplier_payment_applications spa
              JOIN supplier_invoices si ON si.id = spa.supplier_invoice_id
             WHERE spa.supplier_payment_id = sp.id AND si.uuid_sat IS NOT NULL) AS applied_to_uuids,
           -- REP que ampara este pago (los REP de compras cuelgan del pago).
           (SELECT string_agg(COALESCE(NULLIF(CONCAT_WS('-', spc.serie, spc.folio), ''),
                                       LEFT(spc.cfdi_uuid::text, 8)), ' | ')
              FROM supplier_payment_complements spc
             WHERE spc.supplier_payment_id = sp.id) AS rep_folios
      FROM supplier_payments sp
      LEFT JOIN business_partners bp ON bp.id = sp.partner_id
      LEFT JOIN bank_accounts ba     ON ba.id = sp.bank_account_id
      LEFT JOIN credit_cards  cc     ON cc.id = sp.credit_card_id
     WHERE sp.tenant_id = $1
       AND sp.payment_date >= $2 AND sp.payment_date < $3
     ORDER BY sp.payment_date ASC
  `, [tenantId, from, to])

  for (const r of rows) {
    r.bank_or_card = r.card_bank || r.card_alias
      ? `${r.card_bank || 'Tarjeta'}${r.card_last_four ? ` ****${r.card_last_four}` : ''}`
        + `${r.card_alias ? ` (${r.card_alias})` : ''}`
      : (r.bank_name
          ? `${r.bank_name}${r.bank_account_alias ? ` (${r.bank_account_alias})` : ''}`
          : (r.method === 'cash' ? 'Caja / efectivo' : '(sin banco)'))
    r.method_label = AP_METHOD_LABEL[r.method] || r.method
    r.reversed_label = r.reversed_date ? `REVERSADO ${d10(r.reversed_date)}` : ''
  }
  return rows
}

// ─────────────────────────────────────────────────────────────────────────────
// Hojas
// ─────────────────────────────────────────────────────────────────────────────

function addSummarySheet(wb, { from, to, tenantName, fiscalOnly, sales, purchases, creditNotes, paymentsIn, paymentsOut }) {
  const ws = wb.addWorksheet('Resumen')
  ws.columns = [{ width: 40 }, { width: 22 }, { width: 22 }]

  const titleRow = ws.addRow([`Reporte Contable — ${tenantName}`])
  titleRow.font = { bold: true, size: 16 }
  ws.addRow([`Periodo: ${from} a ${to} (exclusivo)`]).font = { italic: true, color: { argb: 'FF606060' } }
  const modeRow = ws.addRow([
    fiscalOnly
      ? 'Modo: SOLO DOCUMENTOS FISCALES (CFDI timbrados y CFDI recibidos)'
      : 'Modo: TODOS LOS DOCUMENTOS (incluye borradores y registros internos sin CFDI)'
  ])
  modeRow.font = { italic: true, color: { argb: fiscalOnly ? 'FF166534' : 'FFB45309' } }
  ws.addRow([])

  // Totales de ventas (solo vigentes para sumar IVA)
  const salesActive = sales.filter(r => r.status === 'stamped')
  const ivaTrasladado = sumNum(salesActive, 'tax_transferred')
  const subtotalVentas = sumNum(salesActive, 'subtotal')
  const totalVentas = sumNum(salesActive, 'total_mxn')

  // IVA acreditable (compras vigentes)
  const purchasesActive = purchases.filter(r => r.status !== 'cancelled')
  const ivaAcreditable = sumNum(purchasesActive, 'tax')
  const totalCompras = sumNum(purchasesActive, 'total_mxn')

  // Notas de crédito (egresos que reducen IVA trasladado)
  const totalNotasCredito = sumNum(creditNotes.filter(c => c.status === 'stamped'), 'total')

  const totalCobros = sumNum(paymentsIn, 'amount')
  const totalPagos  = sumNum(paymentsOut, 'amount_mxn')

  addKpiRow(ws, '— VENTAS —', null, null, { bold: true })
  addKpiRow(ws, 'Subtotal de ventas (vigentes)', subtotalVentas, 'currency')
  addKpiRow(ws, 'IVA trasladado (vigentes)',     ivaTrasladado,  'currency')
  addKpiRow(ws, 'Total facturas vigentes',       totalVentas,    'currency')
  addKpiRow(ws, '  · Facturas emitidas',         sales.length,   'count')
  addKpiRow(ws, '  · Facturas vigentes',         salesActive.length, 'count')
  addKpiRow(ws, '  · Facturas canceladas',       sales.length - salesActive.length, 'count')
  ws.addRow([])

  addKpiRow(ws, '— NOTAS DE CRÉDITO —', null, null, { bold: true })
  addKpiRow(ws, 'Total notas de crédito',        totalNotasCredito, 'currency')
  addKpiRow(ws, '  · Cantidad emitidas',         creditNotes.length, 'count')
  ws.addRow([])

  addKpiRow(ws, '— COMPRAS —', null, null, { bold: true })
  addKpiRow(ws, 'IVA acreditable (vigentes)',    ivaAcreditable, 'currency')
  addKpiRow(ws, 'Total compras vigentes',        totalCompras,   'currency')
  addKpiRow(ws, '  · Facturas recibidas',        purchases.length, 'count')
  ws.addRow([])

  addKpiRow(ws, '— IVA NETO DEL PERIODO —', null, null, { bold: true })
  const ivaNeto = ivaTrasladado - ivaAcreditable
  addKpiRow(ws, 'IVA trasladado',                ivaTrasladado,   'currency')
  addKpiRow(ws, '(−) IVA acreditable',           ivaAcreditable,  'currency')
  const ivaResultRow = addKpiRow(ws,
    ivaNeto >= 0 ? 'IVA a pagar' : 'IVA a favor',
    Math.abs(ivaNeto), 'currency',
    { bold: true, color: ivaNeto >= 0 ? 'FFB45309' : 'FF166534' }
  )
  ws.addRow([])

  addKpiRow(ws, '— FLUJO —', null, null, { bold: true })
  addKpiRow(ws, 'Cobros recibidos',              totalCobros,     'currency')
  addKpiRow(ws, 'Pagos realizados a proveedores',totalPagos,      'currency')

  // Pie con timestamp
  ws.addRow([])
  const footer = ws.addRow([`Generado: ${new Date().toLocaleString('es-MX')} · Praxion Systems`])
  footer.font = { italic: true, size: 9, color: { argb: 'FF808080' } }
}

/** Pinta en rojo la celda de estado REP cuando falta el complemento. */
function flagMissingRep(ws, key) {
  const col = ws.getColumn(key)
  ws.eachRow((row, i) => {
    if (i === 1) return
    const v = String(row.getCell(col.number).value || '')
    if (v.startsWith('FALTA')) {
      row.getCell(col.number).font = { bold: true, color: { argb: 'FF9E3232' } }
    }
  })
}

function addSalesSheet(wb, rows) {
  const ws = wb.addWorksheet('Ventas (Facturas)')
  ws.columns = [
    { header: 'Folio interno',     key: 'document_number',      width: 16 },
    { header: 'Serie',             key: 'series',               width: 8 },
    { header: 'Folio CFDI',        key: 'folio',                width: 12 },
    { header: 'UUID SAT',          key: 'cfdi_uuid',            width: 38 },
    { header: 'Fecha emisión',     key: 'issue_date',           width: 13, style: { numFmt: 'yyyy-mm-dd' } },
    { header: 'Fecha timbrado',    key: 'stamp_date',           width: 19, style: { numFmt: 'yyyy-mm-dd hh:mm' } },
    { header: 'Cliente (razón)',   key: 'partner_legal_name',   width: 36 },
    { header: 'RFC',               key: 'partner_rfc',          width: 16 },
    { header: 'Moneda',            key: 'currency',             width: 8 },
    { header: 'TC',                key: 'exchange_rate_value',  width: 10, style: { numFmt: '0.0000' } },
    { header: 'Subtotal',          key: 'subtotal',             width: 14, style: { numFmt: '#,##0.00' } },
    { header: 'IVA traslad.',      key: 'tax_transferred',      width: 14, style: { numFmt: '#,##0.00' } },
    { header: 'IVA retenido',      key: 'tax_withheld',         width: 14, style: { numFmt: '#,##0.00' } },
    { header: 'Total',             key: 'total',                width: 14, style: { numFmt: '#,##0.00' } },
    { header: 'Total MXN',         key: 'total_mxn',            width: 14, style: { numFmt: '#,##0.00' } },
    { header: 'Mét. pago',         key: 'payment_method',       width: 10 },
    { header: 'Forma pago',        key: 'payment_form',         width: 12 },
    { header: 'Uso CFDI',          key: 'use_cfdi',             width: 10 },
    { header: 'Status',            key: 'status',               width: 13 },
    { header: 'Cancelada',         key: 'cancellation_date',    width: 13, style: { numFmt: 'yyyy-mm-dd' } },
    { header: 'Motivo cancel.',    key: 'cancel_motive',        width: 22 },
    { header: 'OC cliente',        key: 'po_number',            width: 16 },
    // ── Rastro para conciliar contra el banco ──
    { header: 'Fecha(s) de cobro', key: 'payment_dates',        width: 24 },
    { header: 'Banco / cuenta',    key: 'payment_banks',        width: 28 },
    { header: 'Forma de cobro',    key: 'payment_methods',      width: 20 },
    { header: 'Referencia cobro',  key: 'payment_refs',         width: 20 },
    { header: 'Cobrado',           key: 'collected',            width: 14, style: { numFmt: '#,##0.00' } },
    { header: 'Saldo',             key: 'balance',              width: 14, style: { numFmt: '#,##0.00' } },
    { header: 'Estado REP',        key: 'rep_status',           width: 20 },
    { header: 'Fecha(s) REP',      key: 'rep_dates',            width: 24 },
    { header: 'UUID REP',          key: 'rep_uuids',            width: 38 },
    { header: 'Sustituida por',    key: 'substituted_by',       width: 16 },
    { header: 'UUID sustituta',    key: 'substituted_by_uuid',  width: 38 },
    { header: 'NC aplicadas',      key: 'nc_numbers',           width: 20 },
    { header: 'UUID de las NC',    key: 'nc_uuids',             width: 38 },
    { header: 'Total NC',          key: 'nc_total',             width: 14, style: { numFmt: '#,##0.00' } },
  ]
  styleHeader(ws)
  rows.forEach(r => ws.addRow(r))
  flagMissingRep(ws, 'rep_status')
  ws.autoFilter = { from: 'A1', to: { row: 1, column: ws.columns.length } }
}

function addCreditNotesSheet(wb, rows) {
  const ws = wb.addWorksheet('Notas de crédito')
  ws.columns = [
    { header: 'Folio interno',         key: 'document_number',        width: 16 },
    { header: 'UUID SAT',              key: 'cfdi_uuid',              width: 38 },
    { header: 'Fecha',                 key: 'issue_date',             width: 13, style: { numFmt: 'yyyy-mm-dd' } },
    { header: 'Cliente (razón)',      key: 'partner_legal_name',     width: 36 },
    { header: 'RFC',                   key: 'partner_rfc',            width: 16 },
    { header: 'Subtotal',              key: 'amount',                 width: 14, style: { numFmt: '#,##0.00' } },
    { header: 'IVA',                   key: 'tax_amount',             width: 14, style: { numFmt: '#,##0.00' } },
    { header: 'Total',                 key: 'total',                  width: 14, style: { numFmt: '#,##0.00' } },
    { header: 'Status',                key: 'status',                 width: 12 },
    { header: 'Motivo',                key: 'reason',                 width: 32 },
    { header: 'Factura original',      key: 'original_invoice_number',width: 16 },
    { header: 'UUID factura original', key: 'original_invoice_uuid',  width: 38 },
  ]
  styleHeader(ws)
  rows.forEach(r => ws.addRow(r))
  ws.autoFilter = { from: 'A1', to: { row: 1, column: ws.columns.length } }
}

function addPaymentsInSheet(wb, rows) {
  const ws = wb.addWorksheet('Cobros recibidos')
  ws.columns = [
    { header: 'Fecha',              key: 'payment_date',         width: 13, style: { numFmt: 'yyyy-mm-dd' } },
    { header: 'Cliente',            key: 'partner_legal_name',   width: 36 },
    { header: 'RFC',                key: 'partner_rfc',          width: 16 },
    { header: 'Tipo documento',     key: 'document_type',        width: 14 },
    { header: 'Documento',          key: 'ar_document_number',   width: 18 },
    { header: 'UUID factura',       key: 'invoice_uuid',         width: 38 },
    { header: 'Forma pago',         key: 'payment_method',       width: 14 },
    { header: 'Referencia',         key: 'reference',            width: 16 },
    { header: 'Monto',              key: 'amount',               width: 14, style: { numFmt: '#,##0.00' } },
    { header: 'Banco',              key: 'bank_name',            width: 18 },
    { header: 'Cuenta',             key: 'bank_account_alias',   width: 18 },
    { header: 'Complemento UUID',   key: 'complement_uuid',      width: 38 },
    { header: 'Notas',              key: 'notes',                width: 32 },
  ]
  styleHeader(ws)
  rows.forEach(r => ws.addRow(r))
  ws.autoFilter = { from: 'A1', to: { row: 1, column: ws.columns.length } }
}

function addPurchasesSheet(wb, rows) {
  const ws = wb.addWorksheet('Compras (CFDI recibidos)')
  ws.columns = [
    { header: 'Folio interno',  key: 'invoice_number',       width: 18 },
    { header: 'UUID SAT',       key: 'uuid_sat',             width: 38 },
    { header: 'Serie',          key: 'serie',                width: 8 },
    { header: 'Folio',          key: 'folio',                width: 10 },
    { header: 'RFC emisor',     key: 'rfc_emisor',           width: 16 },
    { header: 'RFC catálogo',   key: 'partner_rfc',          width: 16 },
    { header: 'Proveedor',      key: 'partner_legal_name',   width: 36 },
    { header: 'Fecha factura',  key: 'invoice_date',         width: 13, style: { numFmt: 'yyyy-mm-dd' } },
    { header: 'Vencimiento',    key: 'due_date',             width: 13, style: { numFmt: 'yyyy-mm-dd' } },
    { header: 'Recibida',       key: 'received_date',        width: 13, style: { numFmt: 'yyyy-mm-dd' } },
    { header: 'Moneda',         key: 'currency',             width: 8 },
    { header: 'TC',             key: 'exchange_rate_value',  width: 10, style: { numFmt: '0.0000' } },
    { header: 'Subtotal',       key: 'subtotal',             width: 14, style: { numFmt: '#,##0.00' } },
    { header: 'IVA acred.',     key: 'tax',                  width: 14, style: { numFmt: '#,##0.00' } },
    { header: 'Total',          key: 'total',                width: 14, style: { numFmt: '#,##0.00' } },
    { header: 'Total MXN',      key: 'total_mxn',            width: 14, style: { numFmt: '#,##0.00' } },
    { header: 'Saldo',          key: 'balance',              width: 14, style: { numFmt: '#,##0.00' } },
    { header: 'Status',         key: 'status',               width: 13 },
    { header: 'Mét. pago SAT',  key: 'metodo_pago_sat',      width: 13 },
    // ── Rastro para conciliar contra el banco ──
    { header: 'Fecha(s) de pago', key: 'payment_dates',      width: 24 },
    { header: 'Forma de pago',    key: 'payment_methods',    width: 22 },
    { header: 'Banco / tarjeta',  key: 'payment_banks',      width: 30 },
    { header: 'Referencia pago',  key: 'payment_refs',       width: 20 },
    { header: 'Pagado',           key: 'paid',               width: 14, style: { numFmt: '#,##0.00' } },
    { header: 'Estado REP',       key: 'rep_status',         width: 24 },
    { header: 'Folio REP',        key: 'rep_folios',         width: 16 },
    { header: 'Fecha(s) REP',     key: 'rep_dates',          width: 24 },
    { header: 'UUID REP',         key: 'rep_uuids',          width: 38 },
    { header: 'Cancelada',        key: 'cancel_motive',      width: 12 },
    { header: 'Sustituida por',   key: 'substituted_by',     width: 18 },
    { header: 'UUID sustituta',   key: 'substituted_by_uuid',width: 38 },
    { header: 'NC recibidas',     key: 'nc_numbers',         width: 20 },
    { header: 'UUID de las NC',   key: 'nc_uuids',           width: 38 },
    { header: 'Total NC',         key: 'nc_total',           width: 14, style: { numFmt: '#,##0.00' } },
  ]
  styleHeader(ws)
  rows.forEach(r => ws.addRow(r))
  flagMissingRep(ws, 'rep_status')
  ws.autoFilter = { from: 'A1', to: { row: 1, column: ws.columns.length } }
}

function addPaymentsOutSheet(wb, rows) {
  const ws = wb.addWorksheet('Pagos a proveedores')
  ws.columns = [
    { header: 'Fecha',           key: 'payment_date',         width: 13, style: { numFmt: 'yyyy-mm-dd' } },
    { header: 'Proveedor',       key: 'partner_legal_name',   width: 36 },
    { header: 'RFC',             key: 'partner_rfc',          width: 16 },
    { header: 'Genérico',        key: 'generic_supplier',     width: 24 },
    { header: 'Método',          key: 'method_label',         width: 20 },
    { header: 'Referencia',      key: 'reference',            width: 16 },
    { header: 'Monto',           key: 'amount',               width: 14, style: { numFmt: '#,##0.00' } },
    { header: 'Moneda',          key: 'currency',             width: 8 },
    { header: 'TC',              key: 'exchange_rate_value',  width: 10, style: { numFmt: '0.0000' } },
    { header: 'Monto MXN',       key: 'amount_mxn',           width: 14, style: { numFmt: '#,##0.00' } },
    { header: 'Banco / tarjeta', key: 'bank_or_card',         width: 30 },
    { header: 'Cuenta',          key: 'bank_account_alias',   width: 18 },
    { header: 'Aplicado a',      key: 'applied_to',           width: 26 },
    { header: 'UUID facturas',   key: 'applied_to_uuids',     width: 38 },
    { header: 'REP recibido',    key: 'rep_folios',           width: 18 },
    { header: 'Reversado',       key: 'reversed_label',       width: 18 },
    { header: 'Notas',           key: 'notes',                width: 32 },
  ]
  styleHeader(ws)
  rows.forEach(r => ws.addRow(r))
  ws.autoFilter = { from: 'A1', to: { row: 1, column: ws.columns.length } }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers de estilo / formato
// ─────────────────────────────────────────────────────────────────────────────

function styleHeader(ws) {
  const header = ws.getRow(1)
  header.font = { bold: true, color: { argb: 'FFFFFFFF' } }
  header.fill = {
    type: 'pattern', pattern: 'solid',
    fgColor: { argb: 'FF1F2937' },
  }
  header.alignment = { vertical: 'middle' }
  header.height = 22
  ws.views = [{ state: 'frozen', ySplit: 1 }]
}

function addKpiRow(ws, label, value, kind, opts = {}) {
  const row = ws.addRow([label, value])
  if (opts.bold) row.font = { bold: true }
  if (opts.color) row.font = { ...(row.font || {}), bold: true, color: { argb: opts.color } }
  if (kind === 'currency' && typeof value === 'number') {
    row.getCell(2).numFmt = '"$"#,##0.00'
  } else if (kind === 'count' && typeof value === 'number') {
    row.getCell(2).numFmt = '#,##0'
  }
  return row
}

function sumNum(rows, field) {
  let total = 0
  for (const r of rows) {
    const v = parseFloat(r[field] || 0)
    if (Number.isFinite(v)) total += v
  }
  return total
}

module.exports = { generateAccountingWorkbook }
