'use strict'

// Reporte de producción exportado a Excel.
// Mismo estilo y patrón que salesReportExcel: hojas con filtros automáticos
// y formato numérico listo para análisis.

const ExcelJS = require('exceljs')
const { getProductionReport } = require('./productionReport')

async function generateProductionWorkbook({ tenantId, from, to, tenantName }) {
  const wb = new ExcelJS.Workbook()
  wb.creator = 'Praxion Systems'
  wb.created = new Date()

  const data = await getProductionReport({ tenantId, from, to })

  addResumenSheet(wb, { from, to, tenantName, data })
  addByProductSheet(wb, data)
  addByOperatorSheet(wb, data)
  addScrapSheet(wb, data)
  addCostosSheet(wb, data)
  addEficienciaSheet(wb, data)
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
  ws.addRow([`Reporte de Producción — ${tenantName}`]).font = { bold: true, size: 16 }
  ws.addRow([`Periodo: ${from} al ${to} (exclusivo)`]).font = { italic: true, color: { argb: 'FF606060' } }
  ws.addRow([])

  const c = data.totals_current
  const p = data.totals_previous
  const deltaUnits = c.pt_units - p.pt_units
  const deltaPct   = p.pt_units > 0 ? (deltaUnits / p.pt_units) * 100 : null

  row(ws, '— PRODUCCIÓN —', null, null, { bold: true })
  row(ws, 'Piezas producidas',           c.pt_units,         'count')
  row(ws, 'Piezas periodo anterior',     p.pt_units,         'count')
  row(ws, 'Diferencia',                  deltaUnits,         'count',
      { color: deltaUnits > 0 ? 'FF166534' : deltaUnits < 0 ? 'FF991B1B' : 'FF606060' })
  if (deltaPct != null) row(ws, '% cambio', deltaPct / 100, 'pct')
  ws.addRow([])

  row(ws, '— OPERACIÓN —', null, null, { bold: true })
  row(ws, 'Turnos cerrados',              c.shifts,            'count')
  row(ws, 'Órdenes con producción',       c.orders_started,    'count')
  row(ws, 'Órdenes completadas',          c.orders_completed,  'count')
  row(ws, 'Operadores únicos',            c.operators,         'count')
  row(ws, 'Horas trabajadas',             c.hours,             'count', { fmt: '#,##0.00' })
  ws.addRow([])

  row(ws, '— MATERIA PRIMA —', null, null, { bold: true })
  row(ws, 'MP consumida (kg)',            c.mp_kg,             'count', { fmt: '#,##0.000' })
  row(ws, 'PT producido (kg)',            c.pt_kg,             'count', { fmt: '#,##0.000' })
  row(ws, 'Scrap (kg)',                   c.scrap_kg,          'count', { fmt: '#,##0.000' })
  row(ws, 'Rendimiento (yield)',          c.yield_pct / 100,   'pct')
  ws.addRow([])

  row(ws, '— COSTOS —', null, null, { bold: true })
  row(ws, 'Costo total de producción',    c.total_cost,        'currency')
  row(ws, 'Costo unitario estimado',      c.unit_cost,         'currency')
  if (c.avg_cost_per_meter != null) {
    row(ws, 'Costo / metro (esquineros)', c.avg_cost_per_meter, 'currency')
    row(ws, 'Metros lineales producidos', c.meters,             'count', { fmt: '#,##0.00' })
  }
  ws.addRow([])

  ws.addRow([`Generado: ${new Date().toLocaleString('es-MX')}`])
    .font = { italic: true, size: 9, color: { argb: 'FF808080' } }
}

function addByProductSheet(wb, data) {
  const ws = wb.addWorksheet('Por producto')
  ws.columns = [
    { header: 'SKU',                key: 'sku',              width: 22 },
    { header: 'Producto',           key: 'name',             width: 40 },
    { header: 'Tipo',               key: 'type',             width: 16 },
    { header: 'Materia prima',      key: 'raw_material',     width: 28 },
    { header: 'Resina',             key: 'resin_type',       width: 8 },
    { header: 'Piezas',             key: 'pt_units',         width: 12, style: { numFmt: '#,##0' } },
    { header: 'Turnos',             key: 'shifts',           width: 10 },
    { header: 'Órdenes',            key: 'orders',           width: 10 },
    { header: 'PT (kg)',            key: 'pt_kg',            width: 14, style: { numFmt: '#,##0.000' } },
    { header: 'Scrap (kg)',         key: 'scrap_kg',         width: 14, style: { numFmt: '#,##0.000' } },
    { header: 'MP consumida (kg)',  key: 'mp_kg',            width: 16, style: { numFmt: '#,##0.000' } },
    { header: 'Yield %',            key: 'yield_pct',        width: 11, style: { numFmt: '0.0"%"' } },
    { header: 'Metros lineales',    key: 'meters',           width: 14, style: { numFmt: '#,##0.00' } },
    { header: 'Costo total',        key: 'total_cost',       width: 16, style: { numFmt: '"$"#,##0.00' } },
    { header: 'Costo unitario',     key: 'unit_cost',        width: 14, style: { numFmt: '"$"#,##0.00' } },
    { header: 'Costo / metro',      key: 'cost_per_meter',   width: 14, style: { numFmt: '"$"#,##0.00' } },
    { header: 'Precio venta prom.', key: 'avg_sale_price',   width: 16, style: { numFmt: '"$"#,##0.00' } },
    { header: 'Margen fab. %',      key: 'margin_pct',       width: 12, style: { numFmt: '0.0"%"' } },
  ]
  styleHeader(ws)
  data.by_product.forEach(r => ws.addRow(r))
}

function addByOperatorSheet(wb, data) {
  const ws = wb.addWorksheet('Por operador')
  ws.columns = [
    { header: 'Operador',         key: 'operator_name',    width: 32 },
    { header: 'Turnos',           key: 'shifts',           width: 10 },
    { header: 'Órdenes',          key: 'orders',           width: 10 },
    { header: 'Piezas',           key: 'pt_units',         width: 12, style: { numFmt: '#,##0' } },
    { header: 'Horas',            key: 'hours',            width: 12, style: { numFmt: '#,##0.00' } },
    { header: 'Piezas / hora',    key: 'units_per_hour',   width: 13, style: { numFmt: '#,##0.00' } },
    { header: 'PT (kg)',          key: 'pt_kg',            width: 14, style: { numFmt: '#,##0.000' } },
    { header: 'Scrap (kg)',       key: 'scrap_kg',         width: 14, style: { numFmt: '#,##0.000' } },
    { header: 'MP (kg)',          key: 'mp_kg',            width: 14, style: { numFmt: '#,##0.000' } },
    { header: 'Yield %',          key: 'yield_pct',        width: 10, style: { numFmt: '0.0"%"' } },
    { header: 'Scrap %',          key: 'scrap_pct',        width: 10, style: { numFmt: '0.0"%"' } },
  ]
  styleHeader(ws)
  data.by_operator.forEach(r => ws.addRow(r))
}

function addScrapSheet(wb, data) {
  const ws = wb.addWorksheet('Mermas y scrap')
  ws.columns = [{ width: 22 }, { width: 40 }, { width: 14 }, { width: 14 }, { width: 16 }, { width: 12 }]

  ws.addRow(['MERMAS POR PRODUCTO']).font = { bold: true, size: 12 }
  ws.addRow(['SKU', 'Producto', 'PT (kg)', 'Scrap (kg)', 'MP consumida (kg)', 'Scrap %'])
    .font = { bold: true }
  data.scrap_analysis.by_product.forEach(r => {
    const row = ws.addRow([r.sku, r.name, r.pt_kg, r.scrap_kg, r.mp_kg, r.scrap_pct / 100])
    row.getCell(3).numFmt = '#,##0.000'
    row.getCell(4).numFmt = '#,##0.000'
    row.getCell(5).numFmt = '#,##0.000'
    row.getCell(6).numFmt = '0.0%'
  })

  ws.addRow([])
  ws.addRow(['MERMAS POR OPERADOR']).font = { bold: true, size: 12 }
  ws.addRow(['Operador', 'Turnos', 'PT (kg)', 'Scrap (kg)', 'MP consumida (kg)', 'Scrap %'])
    .font = { bold: true }
  data.scrap_analysis.by_operator.forEach(r => {
    const row = ws.addRow([r.operator_name, r.shifts, r.pt_kg, r.scrap_kg, r.mp_kg, r.scrap_pct / 100])
    row.getCell(3).numFmt = '#,##0.000'
    row.getCell(4).numFmt = '#,##0.000'
    row.getCell(5).numFmt = '#,##0.000'
    row.getCell(6).numFmt = '0.0%'
  })
}

function addCostosSheet(wb, data) {
  const ws = wb.addWorksheet('Costos de MP')
  ws.columns = [
    { header: 'Materia prima',     key: 'raw_material_name', width: 32 },
    { header: 'Resina',            key: 'resin_type',        width: 8 },
    { header: 'Tipo',              key: 'material_type',     width: 12 },
    { header: 'Costo / kg',        key: 'cost_per_kg',       width: 14, style: { numFmt: '"$"#,##0.0000' } },
    { header: 'Kg consumidos',     key: 'kg_consumed',       width: 14, style: { numFmt: '#,##0.000' } },
    { header: 'Costo total',       key: 'total_cost',        width: 16, style: { numFmt: '"$"#,##0.00' } },
  ]
  styleHeader(ws)
  data.cost_analysis.by_material.forEach(r => ws.addRow(r))
}

function addEficienciaSheet(wb, data) {
  const ws = wb.addWorksheet('Eficiencia')
  ws.columns = [{ width: 42 }, { width: 18 }]

  ws.addRow(['RESUMEN DE EFICIENCIA']).font = { bold: true, size: 12 }
  const s = data.efficiency.summary
  ws.addRow(['Órdenes completadas con datos', s.orders])
  const absRow = ws.addRow(['Desviación absoluta promedio', s.avg_abs_deviation_pct / 100])
  absRow.getCell(2).numFmt = '0.0%'
  const sgnRow = ws.addRow(['Desviación firmada promedio', s.avg_signed_deviation_pct / 100])
  sgnRow.getCell(2).numFmt = '0.0%'
  ws.addRow(['Órdenes que excedieron lo teórico (>5%)', s.over_theoretical_count])
  ws.addRow(['Órdenes que ahorraron MP (<-5%)',          s.under_theoretical_count])
  ws.addRow(['Órdenes dentro de tolerancia (±5%)',       s.within_tolerance_count])
  ws.addRow([])

  ws.addRow(['DETALLE POR ORDEN']).font = { bold: true, size: 12 }
  const header = ws.addRow(['Orden', 'Producto', 'SKU', 'Piezas', 'Teórico (kg)', 'Real (kg)', 'Desviación (kg)', 'Desviación %', 'Completada'])
  header.font = { bold: true }
  data.efficiency.by_order.forEach(r => {
    const row = ws.addRow([
      r.order_number,
      r.product_name,
      r.product_sku,
      r.quantity_units,
      r.theoretical_mp_kg,
      r.real_mp_kg,
      r.deviation_kg,
      r.deviation_pct / 100,
      r.completed_at,
    ])
    row.getCell(5).numFmt = '#,##0.000'
    row.getCell(6).numFmt = '#,##0.000'
    row.getCell(7).numFmt = '#,##0.000'
    row.getCell(8).numFmt = '0.0%'
    row.getCell(9).numFmt = 'yyyy-mm-dd hh:mm'
  })
}

function addTendenciaSheet(wb, data) {
  const ws = wb.addWorksheet('Tendencia semanal')
  ws.columns = [
    { header: 'Semana (inicio)', key: 'week_start', width: 16, style: { numFmt: 'yyyy-mm-dd' } },
    { header: 'Piezas',          key: 'pt_units',   width: 14, style: { numFmt: '#,##0' } },
    { header: 'PT (kg)',         key: 'pt_kg',      width: 14, style: { numFmt: '#,##0.000' } },
    { header: 'Scrap (kg)',      key: 'scrap_kg',   width: 14, style: { numFmt: '#,##0.000' } },
    { header: 'MP (kg)',         key: 'mp_kg',      width: 14, style: { numFmt: '#,##0.000' } },
    { header: 'Turnos',          key: 'shifts',     width: 10 },
  ]
  styleHeader(ws)
  data.weekly_trend.forEach(r => ws.addRow(r))
}

function row(ws, label, value, kind, opts = {}) {
  const r = ws.addRow([label, value])
  if (opts.bold)  r.font = { bold: true }
  if (opts.color) r.font = { ...(r.font || {}), bold: true, color: { argb: opts.color } }
  if (opts.fmt) {
    r.getCell(2).numFmt = opts.fmt
  } else if (kind === 'currency' && typeof value === 'number') r.getCell(2).numFmt = '"$"#,##0.00'
  else if (kind === 'count' && typeof value === 'number') r.getCell(2).numFmt = '#,##0'
  else if (kind === 'pct'   && typeof value === 'number') r.getCell(2).numFmt = '0.0%'
  return r
}

module.exports = { generateProductionWorkbook }
