'use strict'

// Excel del cuadre fiscal: el resumen del universo CFDI del periodo + una fila
// por incidencia, con su efecto fiscal y la acción a tomar en texto plano.
// Pensado para mandárselo al contador tal cual antes de declarar.

const ExcelJS = require('exceljs')
const { getFiscalReconciliation } = require('./fiscalReconciliation')

const SEVERITY_LABEL = { danger: 'BLOQUEA', warn: 'REVISAR', info: 'INFORMATIVO' }
const SEVERITY_COLOR = { danger: 'FF9E3232', warn: 'FFB45309', info: 'FF606060' }
const SIDE_LABEL     = { issued: 'Emitidos', received: 'Recibidos', both: 'Ambos' }

async function generateFiscalReconciliationWorkbook({ tenantId, from, to, tenantName }) {
  const data = await getFiscalReconciliation({ tenantId, from, to })

  const wb = new ExcelJS.Workbook()
  wb.creator = 'Praxion Systems'
  wb.created = new Date()

  // ── Resumen ──────────────────────────────────────────────────────────────
  const rs = wb.addWorksheet('Resumen')
  rs.columns = [{ width: 48 }, { width: 18 }]
  rs.addRow([`Cuadre fiscal — ${tenantName}`]).font = { bold: true, size: 16 }
  rs.addRow([`Periodo: ${from} a ${to} (exclusivo)`]).font = { italic: true, color: { argb: 'FF606060' } }
  rs.addRow([])

  const kpi = (label, val, money = false, color = null) => {
    const r = rs.addRow([label, val])
    if (money) r.getCell(2).numFmt = '$#,##0.00'
    if (color) { r.getCell(1).font = { bold: true, color: { argb: color } }
                 r.getCell(2).font = { bold: true, color: { argb: color } } }
    return r
  }
  const head = (t) => rs.addRow([t]).font = { bold: true }

  head('— CFDI EMITIDOS —')
  kpi('Facturas vigentes', data.universe.issued.invoices)
  kpi('Notas de crédito vigentes', data.universe.issued.credit_notes)
  kpi('Complementos de pago timbrados', data.universe.issued.complements)
  kpi('Documentos cancelados', data.universe.issued.cancelled)
  kpi('Ingreso neto facturado', data.universe.issued.total_mxn, true)
  rs.addRow([])

  head('— CFDI RECIBIDOS —')
  kpi('Facturas de proveedor vigentes', data.universe.received.invoices)
  kpi('Notas de crédito recibidas', data.universe.received.credit_notes)
  kpi('Complementos de pago recibidos', data.universe.received.complements)
  kpi('Documentos cancelados', data.universe.received.cancelled)
  kpi('Compra neta del periodo', data.universe.received.total_mxn, true)
  rs.addRow([])

  head('— IVA DEL PERIODO —')
  kpi('IVA trasladado (ventas vigentes menos NC)', data.iva.trasladado, true)
  kpi('IVA acreditable (compras vigentes menos NC)', data.iva.acreditable, true)
  kpi('  · En riesgo por falta de REP del proveedor', data.iva.en_riesgo, true,
      data.iva.en_riesgo > 0.005 ? SEVERITY_COLOR.danger : null)
  kpi(data.iva.neto >= 0 ? 'IVA a pagar' : 'IVA a favor', Math.abs(data.iva.neto), true)
  kpi(data.iva.neto_en_firme >= 0 ? 'IVA a pagar descontando el que no es acreditable aún'
                                  : 'IVA a favor descontando el que no es acreditable aún',
      Math.abs(data.iva.neto_en_firme), true,
      data.iva.en_riesgo > 0.005 ? SEVERITY_COLOR.warn : null)
  rs.addRow([])

  head('— INCIDENCIAS —')
  kpi('Bloquean el cierre', data.issues.danger, false,
      data.issues.danger ? SEVERITY_COLOR.danger : null)
  kpi('Por revisar', data.issues.warn, false, data.issues.warn ? SEVERITY_COLOR.warn : null)
  kpi('Informativas', data.issues.info)
  kpi('Total', data.issues.total)
  rs.addRow([])
  rs.addRow(['Los criterios de corte son los mismos del Reporte Contable y del paquete ZIP del periodo.'])
    .font = { italic: true, size: 10, color: { argb: 'FF606060' } }

  // ── Incidencias ──────────────────────────────────────────────────────────
  const ws = wb.addWorksheet('Incidencias')
  ws.columns = [
    { header: 'Prioridad',    key: 'severity', width: 13 },
    { header: 'Lado',         key: 'side',     width: 11 },
    { header: 'Incidencia',   key: 'group',    width: 42 },
    { header: 'Documento',    key: 'doc',      width: 20 },
    { header: 'UUID',         key: 'uuid',     width: 38 },
    { header: 'Fecha',        key: 'date',     width: 12 },
    { header: 'Contraparte',  key: 'partner',  width: 34 },
    { header: 'RFC',          key: 'rfc',      width: 15 },
    { header: 'Importe MXN',  key: 'amount',   width: 14 },
    { header: 'Detalle',      key: 'detail',   width: 52 },
    { header: 'Qué significa', key: 'meaning', width: 70 },
    { header: 'Qué hacer',    key: 'action',   width: 52 },
  ]
  ws.getRow(1).font = { bold: true }
  ws.autoFilter = 'A1:L1'
  ws.views = [{ state: 'frozen', ySplit: 1 }]

  for (const g of data.groups) {
    for (const r of g.rows) {
      const row = ws.addRow({
        severity: SEVERITY_LABEL[g.severity],
        side:     SIDE_LABEL[g.side],
        group:    g.label,
        doc:      r.doc || '',
        uuid:     r.uuid || '',
        date:     r.date || '',
        partner:  r.partner || '',
        rfc:      r.rfc || '',
        amount:   r.amount != null ? r.amount : '',
        detail:   r.detail || '',
        meaning:  g.meaning,
        action:   g.action,
      })
      row.getCell('severity').font = { bold: true, color: { argb: SEVERITY_COLOR[g.severity] } }
    }
  }
  ws.getColumn('amount').numFmt = '#,##0.00'

  if (!data.groups.length) {
    ws.addRow({ severity: '', group: 'Sin incidencias: el periodo cuadra.' })
      .font = { italic: true, color: { argb: 'FF166534' } }
  }

  return wb.xlsx.writeBuffer()
}

module.exports = { generateFiscalReconciliationWorkbook }
