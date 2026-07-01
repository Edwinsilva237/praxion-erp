'use strict'

// Reporte de inventario a Excel multi-hoja: resumen + por almacén + por tipo +
// detalle de existencias + alertas (costo $0, negativos).

const ExcelJS = require('exceljs')
const { getInventoryReport } = require('./inventoryReport')

async function generateInventoryWorkbook({ tenantId, tenantName, countId = null }) {
  const wb = new ExcelJS.Workbook()
  wb.creator = 'Praxion Systems'
  wb.created = new Date()

  const data = await getInventoryReport({ tenantId, countId })

  addResumen(wb, { tenantName, data })
  addPorAlmacen(wb, data)
  addPorTipo(wb, data)
  addDetalle(wb, data)
  addAlertas(wb, data)

  return wb.xlsx.writeBuffer()
}

const MONEY = '"$"#,##0.00'
const NUM2  = '#,##0.00'

function styleHeader(ws) {
  const h = ws.getRow(1)
  h.font = { bold: true, color: { argb: 'FFFFFFFF' } }
  h.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F2937' } }
  h.alignment = { vertical: 'middle' }
  h.height = 22
  ws.views = [{ state: 'frozen', ySplit: 1 }]
  ws.autoFilter = { from: 'A1', to: { row: 1, column: ws.columns.length } }
}

function row(ws, label, value, kind, opts = {}) {
  const r = ws.addRow([label, value == null ? '' : value])
  if (opts.bold)  r.font = { bold: true }
  if (opts.color) r.font = { ...(r.font || {}), bold: true, color: { argb: opts.color } }
  if (kind === 'money' && typeof value === 'number') r.getCell(2).numFmt = MONEY
  else if (kind === 'count' && typeof value === 'number') r.getCell(2).numFmt = '#,##0'
  return r
}

function addResumen(wb, { tenantName, data }) {
  const isClose = data.meta?.mode === 'month_close'
  const ws = wb.addWorksheet('Resumen')
  ws.columns = [{ width: 40 }, { width: 22 }, { width: 16 }]
  ws.addRow([`Reporte de Inventario${isClose ? ' al cierre de mes' : ''} — ${tenantName}`]).font = { bold: true, size: 16 }
  ws.addRow([data.meta?.as_of_label || `Generado: ${new Date().toLocaleString('es-MX')}`])
    .font = { italic: true, color: { argb: 'FF606060' } }
  if (isClose && data.meta?.partial_scope) {
    ws.addRow(['⚠ Conteo parcial: la valuación cubre solo los artículos incluidos en el conteo, no todo el inventario.'])
      .font = { italic: true, color: { argb: 'FFB45309' } }
  }
  ws.addRow([])

  row(ws, '— VALOR DEL INVENTARIO —', null, null, { bold: true })
  row(ws, 'Valor total (existencias × costo prom.)', data.totals.total_value, 'money', { bold: true })
  row(ws, 'Artículos distintos',  data.totals.distinct_items, 'count')
  row(ws, 'Almacenes con stock',  data.totals.warehouses, 'count')
  row(ws, 'Renglones de stock',   data.totals.lines, 'count')
  ws.addRow([])

  row(ws, '— ALERTAS —', null, null, { bold: true })
  row(ws, 'Renglones con costo $0 (con existencia)', data.totals.zero_cost_count, 'count',
      { color: data.totals.zero_cost_count ? 'FFB45309' : undefined })
  row(ws, 'Renglones con existencia NEGATIVA', data.totals.negative_count, 'count',
      { color: data.totals.negative_count ? 'FF991B1B' : undefined })
  ws.addRow([])

  row(ws, '— VALOR POR TIPO DE ALMACÉN —', null, null, { bold: true })
  data.by_warehouse_type.forEach(g => row(ws, `${g.label}`, g.value, 'money'))
  ws.addRow([])
  ws.addRow(['Nota: el valor usa el costo promedio ponderado de cada artículo. Los renglones a costo $0 subvalúan el total.'])
    .font = { italic: true, size: 9, color: { argb: 'FF808080' } }
}

function addPorAlmacen(wb, data) {
  const ws = wb.addWorksheet('Por almacén')
  ws.columns = [
    { header: 'Almacén',   key: 'name',  width: 30 },
    { header: 'Tipo',      key: 'label', width: 22 },
    { header: 'Artículos', key: 'items', width: 12 },
    { header: 'Valor',     key: 'value', width: 18, style: { numFmt: MONEY } },
    { header: '% del total', key: 'pct', width: 12, style: { numFmt: '0.0"%"' } },
  ]
  styleHeader(ws)
  data.by_warehouse.forEach(w => ws.addRow(w))
  const tot = ws.addRow({ name: 'TOTAL', label: '', items: data.totals.distinct_items, value: data.totals.total_value, pct: 100 })
  tot.font = { bold: true }
}

function addPorTipo(wb, data) {
  const ws = wb.addWorksheet('Por tipo')
  ws.columns = [
    { header: 'Tipo de almacén', key: 'label', width: 26 },
    { header: 'Artículos',       key: 'items', width: 12 },
    { header: 'Valor',           key: 'value', width: 18, style: { numFmt: MONEY } },
    { header: '% del total',     key: 'pct',   width: 12, style: { numFmt: '0.0"%"' } },
  ]
  styleHeader(ws)
  data.by_warehouse_type.forEach(g => ws.addRow(g))
}

function addDetalle(wb, data) {
  const ws = wb.addWorksheet('Detalle')
  ws.columns = [
    { header: 'Código',    key: 'code',          width: 16 },
    { header: 'Artículo',  key: 'name',          width: 40 },
    { header: 'Clase',     key: 'clase',         width: 14 },
    { header: 'Almacén',   key: 'warehouse_name', width: 26 },
    { header: 'Estado',    key: 'status_label',  width: 14 },
    { header: 'Existencia', key: 'quantity',     width: 14, style: { numFmt: NUM2 } },
    { header: 'Unidad',    key: 'unit',          width: 10 },
    { header: 'Costo prom.', key: 'avg_cost',    width: 14, style: { numFmt: MONEY } },
    { header: 'Valor',     key: 'value',         width: 18, style: { numFmt: MONEY } },
  ]
  styleHeader(ws)
  data.items.forEach(i => ws.addRow({
    ...i, clase: i.item_type === 'raw_material' ? 'Materia prima' : 'Producto',
  }))
}

function addAlertas(wb, data) {
  const ws = wb.addWorksheet('Alertas')
  ws.columns = [
    { header: 'Alerta',     key: 'alerta',         width: 22 },
    { header: 'Código',     key: 'code',           width: 16 },
    { header: 'Artículo',   key: 'name',           width: 40 },
    { header: 'Almacén',    key: 'warehouse_name', width: 26 },
    { header: 'Existencia', key: 'quantity',       width: 14, style: { numFmt: NUM2 } },
    { header: 'Costo prom.', key: 'avg_cost',      width: 14, style: { numFmt: MONEY } },
    { header: 'Valor',      key: 'value',          width: 18, style: { numFmt: MONEY } },
  ]
  styleHeader(ws)
  data.alerts.zero_cost.forEach(i => ws.addRow({ ...i, alerta: 'Costo $0' }))
  data.alerts.negative.forEach(i => ws.addRow({ ...i, alerta: 'Existencia negativa' }))
  if (!data.alerts.zero_cost.length && !data.alerts.negative.length) {
    ws.addRow({ alerta: 'Sin alertas — inventario consistente.' }).font = { italic: true, color: { argb: 'FF166534' } }
  }
}

module.exports = { generateInventoryWorkbook }
