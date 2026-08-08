'use strict'

// Excel de la trazabilidad de ventas: una fila por EVENTO de cada expediente
// (pedido → remisiones → factura → devolución/NC → cancelación/sustitución →
// cobros → complementos), con folio interno y UUID en cada eslabón.

const ExcelJS = require('exceljs')
const { getSalesTraceability } = require('./salesTraceability')

const REP_LABEL = {
  not_required:    'No requiere (PUE)',
  pending_payment: 'Sin cobros aún',
  missing:         'FALTA COMPLEMENTO',
  mismatch:        'COMPLEMENTO NO CUADRA',
  ok:              'Complemento completo',
}

async function generateSalesTraceabilityWorkbook({ tenantId, from, to, tenantName, partnerId = null }) {
  // El Excel siempre lleva TODOS los expedientes: el filtro de pantalla es para
  // revisar, el archivo es el respaldo del periodo.
  const data = await getSalesTraceability({ tenantId, from, to, partnerId, onlyIssues: false })

  const wb = new ExcelJS.Workbook()
  wb.creator = 'Praxion Systems'
  wb.created = new Date()

  // ── Resumen ──────────────────────────────────────────────────────────────
  const rs = wb.addWorksheet('Resumen')
  rs.columns = [{ width: 48 }, { width: 18 }]
  rs.addRow([`Trazabilidad de ventas — ${tenantName}`]).font = { bold: true, size: 16 }
  rs.addRow([`Periodo: ${from} a ${to} (exclusivo)`]).font = { italic: true, color: { argb: 'FF606060' } }
  rs.addRow([])
  const s = data.summary
  const kpi = (label, val, money = false) => {
    const r = rs.addRow([label, val])
    if (money) r.getCell(2).numFmt = '$#,##0.00'
    return r
  }
  kpi('Expedientes (facturas timbradas del periodo)', s.chains)
  kpi('  · Cobrados por completo', s.paid)
  kpi('  · Cancelados', s.cancelled)
  kpi('  · Con nota de crédito', s.with_nc)
  kpi('  · Con complemento faltante o que no cuadra', s.rep_missing)
  kpi('Remisiones del periodo sin facturar', s.pending_remissions)
  rs.addRow([])
  kpi('Facturado neto (vigente, menos notas de crédito)', s.net_invoiced_mxn, true)
  kpi('  · Notas de crédito emitidas', s.credit_notes_mxn, true)
  const ivaRow = kpi('IVA trasladado de facturas cobradas sin complemento', s.iva_pending_rep_mxn, true)
  if (s.iva_pending_rep_mxn > 0.005) {
    ivaRow.getCell(1).font = { bold: true, color: { argb: 'FF9E3232' } }
    ivaRow.getCell(2).font = { bold: true, color: { argb: 'FF9E3232' } }
  }
  rs.addRow([])
  rs.addRow(['Los importes cancelados no suman: una factura cancelada no es ingreso ni traslada IVA.'])
    .font = { italic: true, size: 10, color: { argb: 'FF606060' } }
  rs.addRow(['El complemento de pago se timbra a más tardar el día 5 del mes siguiente al cobro.'])
    .font = { italic: true, size: 10, color: { argb: 'FF606060' } }

  // ── Cadena documental ────────────────────────────────────────────────────
  const ws = wb.addWorksheet('Cadena documental')
  ws.columns = [
    { header: 'Cliente',          key: 'partner',   width: 34 },
    { header: 'RFC',              key: 'rfc',       width: 15 },
    { header: 'Pedido(s)',        key: 'orders',    width: 18 },
    { header: 'Remisión(es)',     key: 'rems',      width: 22 },
    { header: 'Factura',          key: 'invoice',   width: 16 },
    { header: 'UUID factura',     key: 'inv_uuid',  width: 38 },
    { header: 'Método SAT',       key: 'metodo',    width: 11 },
    { header: 'Evento',           key: 'event',     width: 28 },
    { header: 'Fecha',            key: 'date',      width: 12 },
    { header: 'Documento',        key: 'doc',       width: 20 },
    { header: 'UUID documento',   key: 'doc_uuid',  width: 38 },
    { header: 'Importe MXN',      key: 'amount',    width: 14 },
    { header: 'Detalle',          key: 'detail',    width: 42 },
    { header: 'Estado expediente', key: 'flags',    width: 26 },
  ]
  ws.getRow(1).font = { bold: true }
  ws.autoFilter = 'A1:N1'
  ws.views = [{ state: 'frozen', ySplit: 1 }]

  for (const c of data.chains) {
    const flagText = c.flags.cancelled ? 'CANCELADA'
      : `${c.flags.paid ? 'Cobrada' : 'Con saldo'} · ${REP_LABEL[c.flags.rep_status]}`
    for (const e of c.events) {
      ws.addRow({
        partner:  c.partner.name,
        rfc:      c.partner.rfc || '',
        orders:   c.orders.join(', '),
        rems:     c.remissions.join(', '),
        invoice:  c.invoice.number,
        inv_uuid: c.invoice.uuid || '',
        metodo:   c.invoice.metodo_pago || '',
        event:    e.label,
        date:     e.date ? String(e.date).slice(0, 10) : '',
        doc:      e.doc || '',
        doc_uuid: e.uuid || '',
        amount:   e.amount != null ? e.amount : '',
        detail:   e.detail || '',
        flags:    flagText,
      })
    }
  }
  ws.getColumn('amount').numFmt = '#,##0.00'

  // ── Remisiones sin facturar ──────────────────────────────────────────────
  const wr = wb.addWorksheet('Remisiones sin facturar')
  wr.columns = [
    { header: 'Remisión',  key: 'doc',      width: 18 },
    { header: 'Fecha',     key: 'date',     width: 12 },
    { header: 'Cliente',   key: 'partner',  width: 34 },
    { header: 'Pedido',    key: 'order',    width: 18 },
    { header: 'Estado',    key: 'status',   width: 20 },
    { header: 'Total MXN', key: 'total',    width: 14 },
  ]
  wr.getRow(1).font = { bold: true }
  wr.autoFilter = 'A1:F1'
  for (const r of data.pending_remissions) {
    wr.addRow({
      doc: r.document_number, date: r.date ? String(r.date).slice(0, 10) : '',
      partner: r.partner_name, order: r.order_number || '', status: r.status,
      total: r.total_mxn,
    })
  }
  wr.getColumn('total').numFmt = '#,##0.00'

  return wb.xlsx.writeBuffer()
}

module.exports = { generateSalesTraceabilityWorkbook }
