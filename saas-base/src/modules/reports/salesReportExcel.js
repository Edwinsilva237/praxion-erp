'use strict'

// Reporte de ventas exportado a Excel. Pensado para análisis financiero —
// hojas con filtros automáticos y formato monetario que el contador/analista
// puede pivotear directamente.

const ExcelJS = require('exceljs')
const { getSalesReport, getSalesReconciliation, getCxcIntegrity } = require('./salesReport')

async function generateSalesWorkbook({ tenantId, from, to, tenantName }) {
  const wb = new ExcelJS.Workbook()
  wb.creator = 'Praxion Systems'
  wb.created = new Date()

  const data      = await getSalesReport({ tenantId, from, to })
  const recon     = await getSalesReconciliation({ tenantId, from, to })
  const integrity = await getCxcIntegrity({ tenantId })

  addResumenSheet(wb, { from, to, tenantName, data })
  addClientesSheet(wb, data)
  addProductosSheet(wb, data)
  addEsquinerosSheet(wb, data)
  addUtilidadesSheet(wb, data)
  addAlertasSheet(wb, data)
  addTendenciaSheet(wb, data)
  addConciliacionSheet(wb, { from, to, recon, integrity })

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

// ─── Conciliación Dashboard vs Reporte ───────────────────────────────────────
function addConciliacionSheet(wb, { from, to, recon, integrity }) {
  const ws = wb.addWorksheet('Conciliación')
  ws.columns = [{ width: 52 }, { width: 18 }, { width: 16 }, { width: 18 }, { width: 14 }]

  const r = recon.report
  const d = recon.dashboard
  const b = recon.invoiced_buckets
  const dashTotal = d.invoiced_with_iva + d.uninvoiced

  // Fecha final inclusiva (to es exclusivo).
  const toIncl = new Date(to + 'T00:00:00Z'); toIncl.setUTCDate(toIncl.getUTCDate() - 1)
  const toInclStr = toIncl.toISOString().slice(0, 10)

  ws.addRow(['Conciliación: Dashboard "Acumulado del mes"  vs  Reporte "Ventas del periodo"'])
    .font = { bold: true, size: 14 }
  ws.addRow([`Periodo: ${from} al ${toInclStr}`]).font = { italic: true, color: { argb: 'FF606060' } }
  ws.addRow([])

  // ── A) Reporte ──
  crow(ws, '— REPORTE (remisiones entregadas en el periodo · SIN IVA) —', null, { bold: true })
  crow(ws, 'Ventas remisionadas (sin IVA)',          r.total,      { bold: true })
  crow(ws, '   · Facturado (sin IVA)',               r.invoiced)
  crow(ws, '   · Sin factura (sin IVA)',             r.uninvoiced)
  ws.addRow([])

  // ── B) Dashboard (con IVA desglosado) ──
  const facSub = b.mes.subtotal_mxn + b.previa.subtotal_mxn + b.directa.subtotal_mxn + b.posterior.subtotal_mxn
  const facIva = b.mes.iva_mxn + b.previa.iva_mxn + b.directa.iva_mxn + b.posterior.iva_mxn
  crow(ws, '— DASHBOARD "Acumulado del mes" —', null, { bold: true })
  crow(ws, `Facturado (CON IVA · ${d.invoiced_count} facturas timbradas)`, d.invoiced_with_iva, { bold: true })
  crow(ws, '   · Subtotal (sin IVA)',                facSub)
  crow(ws, '   · IVA',                               facIva)
  crow(ws, `Sin factura (sin IVA · ${d.uninvoiced_count} remisiones)`,     d.uninvoiced)
  crow(ws, 'Total dashboard',                        dashTotal,    { bold: true })
  ws.addRow([])

  // ── C) Desglose del facturado del dashboard por origen ──
  crow(ws, '— DESGLOSE DEL FACTURADO DEL DASHBOARD (facturas timbradas en el periodo) —', null, { bold: true })
  const hdr = ws.addRow(['Origen de la factura', '# Facturas', 'Subtotal (sin IVA)', 'IVA / impuestos', 'Total (con IVA)'])
  hdr.font = { bold: true }
  hdr.eachCell(c => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F2937' } }; c.font = { bold: true, color: { argb: 'FFFFFFFF' } } })

  const bucketRow = (label, x) => {
    const rr = ws.addRow([label, x.num, x.subtotal_mxn, x.iva_mxn, x.total_mxn])
    rr.getCell(3).numFmt = '"$"#,##0.00'
    rr.getCell(4).numFmt = '"$"#,##0.00'
    rr.getCell(5).numFmt = '"$"#,##0.00'
  }
  bucketRow('Facturas de remisiones DEL PERIODO',          b.mes)
  bucketRow('Facturas de remisiones de PERIODOS ANTERIORES', b.previa)
  bucketRow('Facturas DIRECTAS (sin remisión)',            b.directa)
  bucketRow('Facturas de remisiones de PERIODOS POSTERIORES', b.posterior)
  const tot = ws.addRow([
    'TOTAL FACTURADO (= facturado del dashboard)',
    b.mes.num + b.previa.num + b.directa.num + b.posterior.num,
    b.mes.subtotal_mxn + b.previa.subtotal_mxn + b.directa.subtotal_mxn + b.posterior.subtotal_mxn,
    b.mes.iva_mxn + b.previa.iva_mxn + b.directa.iva_mxn + b.posterior.iva_mxn,
    b.mes.total_mxn + b.previa.total_mxn + b.directa.total_mxn + b.posterior.total_mxn,
  ])
  tot.font = { bold: true }
  ;[3, 4, 5].forEach(i => { tot.getCell(i).numFmt = '"$"#,##0.00' })
  ws.addRow([])

  // ── D) Puente Dashboard → Reporte ──
  crow(ws, '— PUENTE: del total del dashboard al total del reporte —', null, { bold: true })
  crow(ws, 'Total dashboard',                                          dashTotal)
  crow(ws, '(−) IVA / impuestos del facturado',                       -(b.mes.iva_mxn + b.previa.iva_mxn + b.directa.iva_mxn + b.posterior.iva_mxn))
  crow(ws, '(−) Facturado de remisiones de periodos ANTERIORES (sin IVA)', -b.previa.subtotal_mxn)
  crow(ws, '(−) Facturas DIRECTAS sin remisión (sin IVA)',            -b.directa.subtotal_mxn)
  crow(ws, '(−) Facturado de remisiones de periodos POSTERIORES (sin IVA)', -b.posterior.subtotal_mxn)
  const equiv = b.mes.subtotal_mxn + d.uninvoiced
  crow(ws, '= Equivalente al reporte (facturado del periodo + sin factura, sin IVA)', equiv, { bold: true })
  crow(ws, 'Reporte real — Ventas remisionadas (sin IVA)',            r.total, { bold: true })
  const resid = r.total - equiv
  crow(ws, 'Diferencia por conciliar (correcciones de precio, facturación parcial, etc.)', resid,
       { color: Math.abs(resid) < 1 ? 'FF166534' : 'FFB45309', bold: true })
  ws.addRow([])

  ws.addRow(['Notas:']).font = { bold: true }
  ;[
    '· "Ventas" del reporte = subtotal SIN IVA de las remisiones entregadas en el periodo.',
    '· El "Facturado" del dashboard incluye IVA y cuenta facturas por su fecha de TIMBRADO (no por la entrega de la remisión).',
    '· "Remisiones de periodos posteriores" = remisiones de este periodo cuya factura se timbró DESPUÉS (el reporte ya las cuenta como facturadas).',
    '· La "Diferencia por conciliar" recoge diferencias de precio factura-vs-remisión, facturación parcial y remisiones del periodo facturadas en otro periodo.',
  ].forEach(t => { ws.addRow([t]).font = { italic: true, size: 9, color: { argb: 'FF808080' } } })

  // ── E) Integridad de CXC (todo el histórico) ──
  if (integrity) {
    ws.addRow([])
    crow(ws, '— INTEGRIDAD DE CXC (todo el histórico, no solo el periodo) —', null, { bold: true })
    const dc = integrity.doubleCountedCount
    const ok = dc === 0
    const verdict = ws.addRow([
      ok
        ? '✓ Sin doble cobro: ninguna remisión facturada conserva una CXC de remisión activa.'
        : `⚠ ${dc} remisión(es) cobradas DOBLE (CXC de remisión activa + ya facturadas)`,
      ok ? '' : integrity.doubleCountedSaldo,
    ])
    verdict.font = { bold: true, color: { argb: ok ? 'FF166534' : 'FFB45309' } }
    if (!ok) verdict.getCell(2).numFmt = '"$"#,##0.00'
    crow(ws, 'Facturas timbradas sin CXC (debe ser 0)', integrity.invoicesWithoutAr === 0 ? '' : integrity.invoicesWithoutAr)
      .getCell(2).numFmt = '#,##0'

    if (dc > 0) {
      ws.addRow([])
      const hh = ws.addRow(['Remisión (doble cobro)', 'Cliente', 'Factura', 'Estado CXC', 'Saldo'])
      hh.font = { bold: true }
      hh.eachCell(c => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFB45309' } }; c.font = { bold: true, color: { argb: 'FFFFFFFF' } } })
      integrity.doubleCounted.forEach(r => {
        const rr = ws.addRow([r.remision, r.cliente, r.factura, r.cxc_status, r.saldo])
        rr.getCell(5).numFmt = '"$"#,##0.00'
      })
    }
    ws.addRow(['· "Doble cobro" = la misma venta tiene saldo por la factura Y por la remisión. En un sistema sano = 0 (la CXC de la remisión se cancela o no se crea al facturar).'])
      .font = { italic: true, size: 9, color: { argb: 'FF808080' } }
  }
}

function crow(ws, label, value, opts = {}) {
  const r = ws.addRow([label, value == null ? '' : value])
  if (opts.bold)  r.font = { bold: true }
  if (opts.color) r.font = { ...(r.font || {}), bold: true, color: { argb: opts.color } }
  if (typeof value === 'number') r.getCell(2).numFmt = '"$"#,##0.00'
  return r
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
