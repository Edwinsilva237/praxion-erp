'use strict'

// Excel de la trazabilidad de compras: una fila por EVENTO de cada expediente
// (OC → recepción → factura → devoluciones/NC/cancelación/sustitución → pagos
// → REP), con folio interno + UUID fiscal en cada eslabón para que contabilidad
// lo relacione en sus sistemas y auditoría.

const ExcelJS = require('exceljs')
const { getPurchaseTraceability } = require('./purchaseTraceability')

const REP_LABEL = {
  not_required:    'No requiere (PUE)',
  pending_payment: 'Sin pagos aún',
  missing:         'FALTA REP',
  mismatch:        'REP NO CUADRA',
  ok:              'REP completo',
}

async function generatePurchaseTraceabilityWorkbook({ tenantId, from, to, tenantName, partnerId = null }) {
  const data = await getPurchaseTraceability({ tenantId, from, to, partnerId })

  const wb = new ExcelJS.Workbook()
  wb.creator = 'Praxion Systems'
  wb.created = new Date()

  // ── Resumen ──────────────────────────────────────────────────────────────
  const rs = wb.addWorksheet('Resumen')
  rs.columns = [{ width: 44 }, { width: 18 }]
  rs.addRow([`Trazabilidad de compras — ${tenantName}`]).font = { bold: true, size: 16 }
  rs.addRow([`Periodo: ${from} a ${to} (exclusivo)`]).font = { italic: true, color: { argb: 'FF606060' } }
  rs.addRow([])
  const s = data.summary
  const kpi = (label, val) => { const r = rs.addRow([label, val]); r.getCell(1).font = { bold: false }; return r }
  kpi('Expedientes (facturas del periodo)', s.chains)
  kpi('  · Pagados por completo', s.paid)
  kpi('  · Cancelados', s.cancelled)
  kpi('  · Con nota de crédito', s.with_nc)
  kpi('  · Con REP faltante o que no cuadra', s.rep_missing)
  kpi('OCs del periodo aún sin factura', s.pending_ocs)

  // ── Cadena documental (una fila por evento) ──────────────────────────────
  const ws = wb.addWorksheet('Cadena documental')
  ws.columns = [
    { header: 'Proveedor',        key: 'partner',   width: 34 },
    { header: 'RFC',              key: 'rfc',       width: 15 },
    { header: 'OC',               key: 'ocs',       width: 16 },
    { header: 'Recepción(es)',    key: 'receipts',  width: 20 },
    { header: 'Factura',          key: 'invoice',   width: 16 },
    { header: 'UUID factura',     key: 'inv_uuid',  width: 38 },
    { header: 'Evento',           key: 'event',     width: 26 },
    { header: 'Fecha',            key: 'date',      width: 12 },
    { header: 'Documento',        key: 'doc',       width: 18 },
    { header: 'UUID documento',   key: 'doc_uuid',  width: 38 },
    { header: 'Importe MXN',      key: 'amount',    width: 14 },
    { header: 'Detalle',          key: 'detail',    width: 40 },
    { header: 'Estado expediente', key: 'flags',    width: 22 },
  ]
  ws.getRow(1).font = { bold: true }
  ws.autoFilter = 'A1:M1'
  ws.views = [{ state: 'frozen', ySplit: 1 }]

  for (const c of data.chains) {
    const flagText = c.flags.cancelled ? 'CANCELADA'
      : `${c.flags.paid ? 'Pagada' : 'Con saldo'} · ${REP_LABEL[c.flags.rep_status]}`
    for (const e of c.events) {
      ws.addRow({
        partner:  c.partner.name,
        rfc:      c.partner.rfc || (c.partner.generic ? '(genérico)' : ''),
        ocs:      c.ocs.join(', '),
        receipts: c.receipts.join(', '),
        invoice:  c.invoice.number,
        inv_uuid: c.invoice.uuid || '',
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

  // ── OCs sin factura (expedientes abiertos) ───────────────────────────────
  const wo = wb.addWorksheet('OCs sin factura')
  wo.columns = [
    { header: 'OC',           key: 'oc',       width: 18 },
    { header: 'Fecha',        key: 'date',     width: 12 },
    { header: 'Proveedor',    key: 'partner',  width: 34 },
    { header: 'Estado',       key: 'status',   width: 20 },
    { header: 'Recepciones',  key: 'receipts', width: 26 },
    { header: 'Total MXN',    key: 'total',    width: 14 },
  ]
  wo.getRow(1).font = { bold: true }
  wo.autoFilter = 'A1:F1'
  for (const o of data.pending_ocs) {
    wo.addRow({
      oc: o.order_number, date: o.date ? String(o.date).slice(0, 10) : '',
      partner: o.partner_name, status: o.status,
      receipts: o.receipts || '(sin recepción)', total: o.total_mxn,
    })
  }
  wo.getColumn('total').numFmt = '#,##0.00'

  return wb.xlsx.writeBuffer()
}

module.exports = { generatePurchaseTraceabilityWorkbook }
