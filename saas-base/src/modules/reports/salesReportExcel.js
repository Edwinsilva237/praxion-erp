'use strict'

// Reporte de ventas exportado a Excel. Pensado para análisis financiero —
// hojas con filtros automáticos y formato monetario que el contador/analista
// puede pivotear directamente.

const ExcelJS = require('exceljs')
const { getSalesReport } = require('./salesReport')

async function generateSalesWorkbook({ tenantId, from, to, tenantName }) {
  const wb = new ExcelJS.Workbook()
  wb.creator = 'Praxion Systems'
  wb.created = new Date()

  const data = await getSalesReport({ tenantId, from, to })

  addResumenSheet(wb, { from, to, tenantName, data })
  addClientesSheet(wb, data)
  addProductosSheet(wb, data)
  addEsquinerosSheet(wb, data)
  addUtilidadesSheet(wb, data)
  addAlertasSheet(wb, data)
  addTendenciaSheet(wb, data)

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

function addResumenSheet(wb, { from, to, tenantName, data }) {
  const ws = wb.addWorksheet('Resumen')
  ws.columns = [{ width: 42 }, { width: 22 }, { width: 22 }]
  ws.addRow([`Reporte de Ventas — ${tenantName}`]).font = { bold: true, size: 16 }
  ws.addRow([`Periodo: ${from} al ${to} (exclusivo)`]).font = { italic: true, color: { argb: 'FF606060' } }
  ws.addRow([])

  const c = data.totals_current
  const p = data.totals_previous
  const delta = c.revenue - p.revenue
  const deltaPct = p.revenue > 0 ? (delta / p.revenue) * 100 : null

  row(ws, '— VENTAS —', null, null, { bold: true })
  row(ws, 'Total del periodo',           c.revenue,           'currency')
  row(ws, 'Total periodo anterior',      p.revenue,           'currency')
  row(ws, 'Diferencia',                  delta,               'currency',
      { color: delta > 0 ? 'FF166534' : delta < 0 ? 'FF991B1B' : 'FF606060' })
  if (deltaPct != null) row(ws, '% cambio', deltaPct / 100, 'pct')
  ws.addRow([])

  row(ws, '— OPERACIÓN —', null, null, { bold: true })
  row(ws, 'Entregas (remisiones)',       c.deliveries,        'count')
  row(ws, 'Clientes únicos',             c.customers,         'count')
  row(ws, 'Productos vendidos',          data.by_product.length, 'count')
  ws.addRow([])

  row(ws, '— UTILIDAD ESTIMADA —', null, null, { bold: true })
  row(ws, 'Ventas',                      c.revenue,           'currency')
  row(ws, 'Costo estimado',              c.estimated_cost,    'currency')
  row(ws, 'Utilidad bruta',              c.estimated_margin,  'currency',
      { color: c.estimated_margin > 0 ? 'FF166534' : 'FF991B1B', bold: true })
  row(ws, 'Margen',                      c.margin_pct / 100,  'pct')
  ws.addRow([])

  ws.addRow([`Generado: ${new Date().toLocaleString('es-MX')} · Costos: promedio de últimos ${data.cost_window_days} días`])
    .font = { italic: true, size: 9, color: { argb: 'FF808080' } }
}

function addClientesSheet(wb, data) {
  const ws = wb.addWorksheet('Por cliente')
  ws.columns = [
    { header: 'Cliente',          key: 'partner_name',        width: 36 },
    { header: 'Razón social',     key: 'partner_legal_name',  width: 36 },
    { header: 'RFC',              key: 'partner_rfc',         width: 16 },
    { header: 'En factura',       key: 'invoiced_revenue',    width: 16, style: { numFmt: '"$"#,##0.00' } },
    { header: 'Sin factura',      key: 'uninvoiced_revenue',  width: 16, style: { numFmt: '"$"#,##0.00' } },
    { header: 'Total',            key: 'revenue',             width: 16, style: { numFmt: '"$"#,##0.00' } },
    { header: '% del total',      key: 'pct_of_total',        width: 12, style: { numFmt: '0.0"%"' } },
    { header: 'Entregas',         key: 'deliveries',          width: 11 },
    { header: 'Ticket promedio',  key: 'avg_ticket',          width: 16, style: { numFmt: '"$"#,##0.00' } },
    { header: 'Costo estimado',   key: 'estimated_cost',      width: 16, style: { numFmt: '"$"#,##0.00' } },
    { header: 'Utilidad estimada',key: 'estimated_margin',    width: 16, style: { numFmt: '"$"#,##0.00' } },
    { header: 'Margen %',         key: 'margin_pct',          width: 11, style: { numFmt: '0.0"%"' } },
  ]
  styleHeader(ws)
  data.by_customer.forEach(r => ws.addRow(r))
}

function addProductosSheet(wb, data) {
  const ws = wb.addWorksheet('Por producto')
  ws.columns = [
    { header: 'SKU',              key: 'sku',                 width: 22 },
    { header: 'Producto',         key: 'name',                width: 40 },
    { header: 'Tipo',             key: 'type',                width: 16 },
    { header: 'Cantidad',         key: 'qty_sold',            width: 12, style: { numFmt: '#,##0.00' } },
    { header: 'Unidad',           key: 'sale_unit',           width: 10 },
    { header: 'Precio promedio',  key: 'avg_price',           width: 16, style: { numFmt: '"$"#,##0.00' } },
    { header: 'En factura',       key: 'invoiced_revenue',    width: 16, style: { numFmt: '"$"#,##0.00' } },
    { header: 'Sin factura',      key: 'uninvoiced_revenue',  width: 16, style: { numFmt: '"$"#,##0.00' } },
    { header: 'Total',            key: 'revenue',             width: 16, style: { numFmt: '"$"#,##0.00' } },
    { header: '% del total',      key: 'pct_of_total',        width: 12, style: { numFmt: '0.0"%"' } },
    { header: 'Costo unit.',      key: 'unit_cost',           width: 14, style: { numFmt: '"$"#,##0.00' } },
    { header: 'Utilidad estimada',key: 'estimated_margin',    width: 16, style: { numFmt: '"$"#,##0.00' } },
    { header: 'Margen %',         key: 'margin_pct',          width: 11, style: { numFmt: '0.0"%"' } },
  ]
  styleHeader(ws)
  data.by_product.forEach(r => ws.addRow(r))
}

function addEsquinerosSheet(wb, data) {
  const ws = wb.addWorksheet('Esquineros (metros)')
  ws.columns = [
    { header: 'SKU',              key: 'sku',                 width: 22 },
    { header: 'Producto',         key: 'name',                width: 40 },
    { header: 'Longitud (mm)',    key: 'length_mm',           width: 14, style: { numFmt: '#,##0' } },
    { header: 'Piezas',           key: 'qty_base',            width: 12, style: { numFmt: '#,##0.00' } },
    { header: 'Metros lineales',  key: 'meters',              width: 16, style: { numFmt: '#,##0.00' } },
    { header: 'Ventas',           key: 'revenue',             width: 16, style: { numFmt: '"$"#,##0.00' } },
    { header: '$ por metro',      key: 'price_per_meter',     width: 14, style: { numFmt: '"$"#,##0.00' } },
    { header: '⚠ Falta longitud', key: 'missing_length',      width: 18 },
  ]
  styleHeader(ws)
  data.by_product
    .filter(p => (p.meters != null && p.meters > 0) || p.missing_length)
    .forEach(p => ws.addRow({
      ...p,
      missing_length: p.missing_length ? 'SÍ — capturar en catálogo' : '',
    }))
}

function addUtilidadesSheet(wb, data) {
  const ws = wb.addWorksheet('Utilidad por cliente')
  ws.columns = [
    { header: 'Cliente',          key: 'partner_name',        width: 36 },
    { header: 'Ventas',           key: 'revenue',             width: 16, style: { numFmt: '"$"#,##0.00' } },
    { header: 'Costo estimado',   key: 'estimated_cost',      width: 16, style: { numFmt: '"$"#,##0.00' } },
    { header: 'Utilidad',         key: 'estimated_margin',    width: 16, style: { numFmt: '"$"#,##0.00' } },
    { header: 'Margen %',         key: 'margin_pct',          width: 11, style: { numFmt: '0.0"%"' } },
  ]
  styleHeader(ws)
  data.by_customer.forEach(r => ws.addRow(r))
}

function addAlertasSheet(wb, data) {
  const ws = wb.addWorksheet('Alertas de margen')
  ws.columns = [
    { header: 'SKU',          key: 'sku',         width: 22 },
    { header: 'Producto',     key: 'name',        width: 40 },
    { header: 'Tipo',         key: 'type',        width: 16 },
    { header: 'Precio venta', key: 'avg_price',   width: 14, style: { numFmt: '"$"#,##0.00' } },
    { header: 'Costo unit.',  key: 'unit_cost',   width: 14, style: { numFmt: '"$"#,##0.00' } },
    { header: 'Cantidad',     key: 'qty_base',    width: 12, style: { numFmt: '#,##0.00' } },
    { header: 'Ventas',       key: 'revenue',     width: 16, style: { numFmt: '"$"#,##0.00' } },
    { header: 'Costo total',  key: 'cost',        width: 16, style: { numFmt: '"$"#,##0.00' } },
    { header: 'Pérdida',      key: 'loss',        width: 16, style: { numFmt: '"$"#,##0.00' } },
  ]
  styleHeader(ws)
  if (data.negative_margins.length === 0) {
    ws.addRow(['(sin productos con margen negativo)']).font = { italic: true, color: { argb: 'FF606060' } }
  } else {
    data.negative_margins.forEach(r => ws.addRow(r))
  }
}

function addTendenciaSheet(wb, data) {
  const ws = wb.addWorksheet('Tendencia semanal')
  ws.columns = [
    { header: 'Semana (inicio)', key: 'week_start', width: 16, style: { numFmt: 'yyyy-mm-dd' } },
    { header: 'Ventas',          key: 'revenue',    width: 16, style: { numFmt: '"$"#,##0.00' } },
    { header: 'Entregas',        key: 'deliveries', width: 12 },
  ]
  styleHeader(ws)
  data.weekly_trend.forEach(r => ws.addRow(r))
}

function row(ws, label, value, kind, opts = {}) {
  const r = ws.addRow([label, value])
  if (opts.bold)  r.font = { bold: true }
  if (opts.color) r.font = { ...(r.font || {}), bold: true, color: { argb: opts.color } }
  if (kind === 'currency' && typeof value === 'number') r.getCell(2).numFmt = '"$"#,##0.00'
  else if (kind === 'count' && typeof value === 'number') r.getCell(2).numFmt = '#,##0'
  else if (kind === 'pct'   && typeof value === 'number') r.getCell(2).numFmt = '0.0%'
  return r
}

module.exports = { generateSalesWorkbook }
