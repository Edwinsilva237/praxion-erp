'use strict'

// Excel del estado de cuenta. Una hoja por cada vista:
//   - Resumen (KPIs)
//   - Documentos pendientes (todos, con código de colores por aging)
//   - Por cliente/proveedor (agregado)
//   - Anticipos disponibles
//   - Notas de crédito (solo CXC)

const ExcelJS = require('exceljs')
const { getAccountStatement } = require('./accountStatementReport')

// Colores de fondo para clasificación por vencimiento.
const FILL = {
  overdue:  { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEE2E2' } }, // rojo claro
  due_soon: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEF3C7' } }, // amarillo claro
  current:  { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD1FAE5' } }, // verde claro
  no_due:   { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE5E7EB' } }, // gris claro
}

async function generateAccountStatementWorkbook({ tenantId, tenantName, direction, filters }) {
  const wb = new ExcelJS.Workbook()
  wb.creator = 'Praxion Systems'
  wb.created = new Date()

  const data = await getAccountStatement({ tenantId, direction, filters })
  const labels = direction === 'in'
    ? { title: 'Cuentas por cobrar', partnerCol: 'Cliente',   action: 'Cobrar' }
    : { title: 'Cuentas por pagar',  partnerCol: 'Proveedor', action: 'Pagar' }

  addResumenSheet(wb, { tenantName, data, labels })
  addDocsSheet(wb, data, labels)
  addByPartnerSheet(wb, data, labels)
  if (data.advances.length > 0) addAdvancesSheet(wb, data, labels)
  if (data.credit_notes.length > 0) addCreditNotesSheet(wb, data)

  return wb.xlsx.writeBuffer()
}

function styleHeader(ws) {
  const h = ws.getRow(1)
  h.font = { bold: true, color: { argb: 'FFFFFFFF' } }
  h.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F2937' } }
  h.alignment = { vertical: 'middle' }
  h.height = 22
  ws.views = [{ state: 'frozen', ySplit: 1 }]
  ws.autoFilter = { from: 'A1', to: { row: 1, column: ws.columns.length } }
}

function addResumenSheet(wb, { tenantName, data, labels }) {
  const ws = wb.addWorksheet('Resumen')
  ws.columns = [{ width: 38 }, { width: 22 }, { width: 18 }]

  ws.addRow([`${labels.title} — ${tenantName}`]).font = { bold: true, size: 16 }
  ws.addRow([`Snapshot al ${data.snapshot_date} · Próximo a vencer = dentro de ${data.due_soon_days} días`])
    .font = { italic: true, color: { argb: 'FF606060' } }
  ws.addRow([])

  const s = data.summary
  row(ws, '— TOTALES —', null, null, { bold: true })
  rowMoney(ws, 'Total pendiente',         s.total_pending_amount)
  rowCount(ws, '# documentos pendientes', s.total_pending_count)
  ws.addRow([])

  row(ws, '— CLASIFICACIÓN POR VENCIMIENTO —', null, null, { bold: true })
  const aging = [
    ['Vencido',           s.overdue,  FILL.overdue],
    ['Próximo a vencer',  s.due_soon, FILL.due_soon],
    ['Al corriente',      s.current,  FILL.current],
    ['Sin fecha pactada', s.no_due,   FILL.no_due],
  ]
  for (const [label, bucket, fill] of aging) {
    const r = ws.addRow([label, bucket.amount, bucket.count])
    r.getCell(1).fill = fill
    r.getCell(2).numFmt = '"$"#,##0.00'
    r.getCell(2).fill = fill
    r.getCell(3).fill = fill
  }
  ws.addRow([])

  row(ws, '— SALDO A FAVOR —', null, null, { bold: true })
  rowMoney(ws, 'Anticipos disponibles',  s.advances_available.amount)
  rowCount(ws, '# de anticipos',         s.advances_available.count)
  if (data.direction === 'in') {
    rowMoney(ws, 'Notas de crédito',       s.credit_notes_available.amount)
    rowCount(ws, '# notas de crédito',     s.credit_notes_available.count)
  }
  ws.addRow([])

  const netRow = ws.addRow(['SALDO NETO (pendiente − anticipos − NCs)', s.net_balance])
  netRow.font = { bold: true, size: 12 }
  netRow.getCell(2).numFmt = '"$"#,##0.00'
  netRow.getCell(2).font = { bold: true, size: 12, color: { argb: s.net_balance > 0 ? 'FF991B1B' : 'FF166534' } }
  ws.addRow([])

  ws.addRow([`Generado: ${new Date().toLocaleString('es-MX')}`])
    .font = { italic: true, size: 9, color: { argb: 'FF808080' } }
}

function addDocsSheet(wb, data, labels) {
  const ws = wb.addWorksheet('Documentos pendientes')
  // La OC es del cliente: solo aplica a cuentas por cobrar.
  const showPO = data.direction === 'in'
  ws.columns = [
    { header: 'Estado',          key: 'aging_status',     width: 18 },
    { header: 'Documento',       key: 'document_number',  width: 22 },
    { header: 'Tipo',            key: 'document_type',    width: 14 },
    ...(showPO ? [{ header: 'Orden de compra', key: 'po_number', width: 20 }] : []),
    { header: labels.partnerCol, key: 'partner_name',     width: 36 },
    { header: 'RFC',             key: 'partner_rfc',      width: 16 },
    { header: 'F. emisión',      key: 'issue_date',       width: 14, style: { numFmt: 'yyyy-mm-dd' } },
    { header: 'F. vencimiento',  key: 'due_date',         width: 14, style: { numFmt: 'yyyy-mm-dd' } },
    { header: 'Días vencido',    key: 'days_overdue',     width: 13 },
    { header: 'Total',           key: 'amount_total',     width: 14, style: { numFmt: '"$"#,##0.00' } },
    { header: 'Pagado',          key: 'amount_paid',      width: 14, style: { numFmt: '"$"#,##0.00' } },
    { header: 'Pendiente',       key: 'amount_pending',   width: 14, style: { numFmt: '"$"#,##0.00' } },
  ]
  styleHeader(ws)

  const STATUS_LABEL = {
    overdue:  'Vencido',
    due_soon: 'Próximo a vencer',
    current:  'Al corriente',
    no_due:   'Sin fecha pactada',
  }

  for (const d of data.documents) {
    const r = ws.addRow({
      ...d,
      aging_status: STATUS_LABEL[d.aging_status] || d.aging_status,
    })
    const fill = FILL[d.aging_status]
    if (fill) {
      for (let c = 1; c <= ws.columns.length; c++) r.getCell(c).fill = fill
    }
  }

  // Total al pie.
  if (data.documents.length > 0) {
    const r = ws.addRow({
      aging_status: 'TOTAL',
      amount_total:   data.documents.reduce((s, d) => s + d.amount_total, 0),
      amount_paid:    data.documents.reduce((s, d) => s + d.amount_paid, 0),
      amount_pending: data.documents.reduce((s, d) => s + d.amount_pending, 0),
    })
    r.font = { bold: true }
  }
}

function addByPartnerSheet(wb, data, labels) {
  const ws = wb.addWorksheet(`Por ${labels.partnerCol.toLowerCase()}`)
  ws.columns = [
    { header: labels.partnerCol,    key: 'partner_name',     width: 36 },
    { header: 'RFC',                key: 'partner_rfc',      width: 16 },
    { header: 'Razón social',       key: 'partner_legal_name', width: 36 },
    { header: '# docs',             key: 'docs_count',       width: 10 },
    { header: 'Pendiente',          key: 'pending_amount',   width: 16, style: { numFmt: '"$"#,##0.00' } },
    { header: 'Vencido',            key: 'overdue_amount',   width: 16, style: { numFmt: '"$"#,##0.00' } },
    { header: '# vencidos',         key: 'overdue_count',    width: 12 },
    { header: 'Próx. a vencer',     key: 'due_soon_amount',  width: 16, style: { numFmt: '"$"#,##0.00' } },
    { header: 'Al corriente',       key: 'current_amount',   width: 16, style: { numFmt: '"$"#,##0.00' } },
    { header: 'Días máx. vencido',  key: 'max_days_overdue', width: 16 },
  ]
  styleHeader(ws)
  for (const p of data.by_partner) {
    const r = ws.addRow(p)
    if (p.overdue_amount > 0)        r.getCell(6).fill = FILL.overdue
    else if (p.due_soon_amount > 0)  r.getCell(8).fill = FILL.due_soon
  }
}

function addAdvancesSheet(wb, data, labels) {
  const ws = wb.addWorksheet('Anticipos a favor')
  ws.columns = [
    { header: labels.partnerCol,  key: 'partner_name',     width: 36 },
    { header: 'RFC',              key: 'partner_rfc',      width: 16 },
    { header: 'Fecha',            key: 'receipt_date',     width: 14, style: { numFmt: 'yyyy-mm-dd' } },
    { header: 'Método',           key: 'payment_method',   width: 14 },
    { header: 'Referencia',       key: 'reference',        width: 18 },
    { header: 'Monto original',   key: 'amount',           width: 14, style: { numFmt: '"$"#,##0.00' } },
    { header: 'Aplicado',         key: 'amount_applied',   width: 14, style: { numFmt: '"$"#,##0.00' } },
    { header: 'Disponible',       key: 'amount_available', width: 14, style: { numFmt: '"$"#,##0.00' } },
  ]
  styleHeader(ws)
  data.advances.forEach(a => ws.addRow(a))
}

function addCreditNotesSheet(wb, data) {
  const ws = wb.addWorksheet('Notas de crédito')
  ws.columns = [
    { header: 'NC',           key: 'document_number', width: 18 },
    { header: 'Cliente',      key: 'partner_name',    width: 36 },
    { header: 'F. emisión',   key: 'issue_date',      width: 14, style: { numFmt: 'yyyy-mm-dd' } },
    { header: 'Motivo',       key: 'reason',          width: 14 },
    { header: 'UUID SAT',     key: 'cfdi_uuid',       width: 38 },
    { header: 'Subtotal',     key: 'amount',          width: 14, style: { numFmt: '"$"#,##0.00' } },
    { header: 'Total',        key: 'total',           width: 14, style: { numFmt: '"$"#,##0.00' } },
  ]
  styleHeader(ws)
  data.credit_notes.forEach(c => ws.addRow(c))
}

function row(ws, label, value, kind, opts = {}) {
  const r = ws.addRow([label, value])
  if (opts.bold)  r.font = { bold: true }
  return r
}
function rowMoney(ws, label, value) {
  const r = ws.addRow([label, value])
  r.getCell(2).numFmt = '"$"#,##0.00'
  return r
}
function rowCount(ws, label, value) {
  const r = ws.addRow([label, value])
  r.getCell(2).numFmt = '#,##0'
  return r
}

module.exports = { generateAccountStatementWorkbook }
