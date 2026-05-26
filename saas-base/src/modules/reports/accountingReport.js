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
    SELECT inv.document_number, inv.cfdi_uuid, inv.folio, inv.series,
           inv.issue_date, inv.stamp_date,
           bp.tax_name AS partner_legal_name, bp.name AS partner_commercial,
           bp.rfc AS partner_rfc,
           inv.currency, inv.exchange_rate_value,
           inv.subtotal, inv.tax_transferred, inv.tax_withheld,
           inv.total, inv.total_mxn,
           inv.payment_method, inv.payment_form, inv.use_cfdi,
           inv.status, inv.cancellation_date, inv.cancellation_reason,
           inv.po_number, inv.notes
      FROM invoices inv
      JOIN business_partners bp ON bp.id = inv.partner_id
     WHERE inv.tenant_id = $1
       AND inv.cfdi_type = 'I'
       ${fiscalFilter}
       AND ${dateCol} >= $2 AND ${dateCol} < $3
     ORDER BY ${dateCol} ASC, inv.document_number ASC
  `, [tenantId, from, to])
  return rows
}

async function fetchCreditNotes(tenantId, from, to, fiscalOnly = true) {
  // Modo fiscal: solo NC con valor SAT (timbradas o canceladas ante el SAT).
  // Se excluyen borradores locales (status='draft').
  const fiscalFilter = fiscalOnly ? `AND cn.status IN ('stamped', 'cancelled')` : ''

  const { rows } = await query(`
    SELECT cn.document_number, cn.cfdi_uuid, cn.issue_date,
           bp.tax_name AS partner_legal_name, bp.name AS partner_commercial,
           bp.rfc AS partner_rfc,
           cn.amount, cn.tax_amount, cn.total,
           cn.reason, cn.status, cn.notes,
           inv.document_number AS original_invoice_number,
           inv.cfdi_uuid       AS original_invoice_uuid
      FROM credit_notes cn
      JOIN business_partners bp ON bp.id = cn.partner_id
      LEFT JOIN invoices inv ON inv.id = cn.original_doc_id AND cn.original_doc_type = 'invoice'
     WHERE cn.tenant_id = $1
       ${fiscalFilter}
       AND cn.issue_date >= $2 AND cn.issue_date < $3
     ORDER BY cn.issue_date ASC
  `, [tenantId, from, to])
  return rows
}

async function fetchPaymentsIn(tenantId, from, to) {
  const { rows } = await query(`
    SELECT ap.payment_date, ap.amount, ap.payment_method, ap.reference,
           ap.notes,
           ar.document_type, ar.document_number AS ar_document_number,
           bp.name AS partner_commercial, bp.tax_name AS partner_legal_name,
           bp.rfc AS partner_rfc,
           ba.alias AS bank_account_alias, ba.bank_name AS bank_name,
           pc.cfdi_uuid AS complement_uuid
      FROM ar_payments ap
      LEFT JOIN accounts_receivable ar ON ar.id = ap.ar_id
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
    SELECT si.invoice_number, si.uuid_sat, si.folio, si.serie, si.rfc_emisor,
           si.invoice_date, si.due_date, si.received_date,
           bp.name AS partner_name, bp.tax_name AS partner_legal_name,
           si.generic_supplier,
           si.currency, si.exchange_rate_value,
           si.subtotal, si.tax, si.total, si.total_mxn, si.balance,
           si.status, si.notes
      FROM supplier_invoices si
      LEFT JOIN business_partners bp ON bp.id = si.partner_id
     WHERE si.tenant_id = $1
       ${fiscalFilter}
       AND si.invoice_date >= $2 AND si.invoice_date < $3
     ORDER BY si.invoice_date ASC
  `, [tenantId, from, to])
  return rows
}

async function fetchPaymentsOut(tenantId, from, to) {
  const { rows } = await query(`
    SELECT sp.payment_date, sp.amount, sp.amount_mxn, sp.currency,
           sp.exchange_rate_value, sp.method, sp.reference, sp.notes,
           bp.name AS partner_name, bp.tax_name AS partner_legal_name,
           bp.rfc AS partner_rfc,
           sp.generic_supplier,
           ba.alias AS bank_account_alias, ba.bank_name AS bank_name
      FROM supplier_payments sp
      LEFT JOIN business_partners bp ON bp.id = sp.partner_id
      LEFT JOIN bank_accounts ba     ON ba.id = sp.bank_account_id
     WHERE sp.tenant_id = $1
       AND sp.payment_date >= $2 AND sp.payment_date < $3
     ORDER BY sp.payment_date ASC
  `, [tenantId, from, to])
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
    { header: 'Motivo cancel.',    key: 'cancellation_reason',  width: 14 },
    { header: 'OC cliente',        key: 'po_number',            width: 16 },
  ]
  styleHeader(ws)
  rows.forEach(r => ws.addRow(r))
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
  ]
  styleHeader(ws)
  rows.forEach(r => ws.addRow(r))
  ws.autoFilter = { from: 'A1', to: { row: 1, column: ws.columns.length } }
}

function addPaymentsOutSheet(wb, rows) {
  const ws = wb.addWorksheet('Pagos a proveedores')
  ws.columns = [
    { header: 'Fecha',           key: 'payment_date',         width: 13, style: { numFmt: 'yyyy-mm-dd' } },
    { header: 'Proveedor',       key: 'partner_legal_name',   width: 36 },
    { header: 'RFC',             key: 'partner_rfc',          width: 16 },
    { header: 'Genérico',        key: 'generic_supplier',     width: 24 },
    { header: 'Método',          key: 'method',               width: 14 },
    { header: 'Referencia',      key: 'reference',            width: 16 },
    { header: 'Monto',           key: 'amount',               width: 14, style: { numFmt: '#,##0.00' } },
    { header: 'Moneda',          key: 'currency',             width: 8 },
    { header: 'TC',              key: 'exchange_rate_value',  width: 10, style: { numFmt: '0.0000' } },
    { header: 'Monto MXN',       key: 'amount_mxn',           width: 14, style: { numFmt: '#,##0.00' } },
    { header: 'Banco',           key: 'bank_name',            width: 18 },
    { header: 'Cuenta',          key: 'bank_account_alias',   width: 18 },
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
