'use strict'

// Reporte de ventas en PDF. Portada con marca del tenant, resumen ejecutivo con
// KPIs, y DESGLOSE COMPLETO por cliente y por producto (facturado vs sin factura,
// utilidad y margen), tendencia semanal y alertas de margen.
//
// Definición de cifras (consistente con la pantalla y el Excel):
//   - "Ventas" = subtotal SIN IVA de las remisiones ENTREGADAS en el periodo
//     (delivery_note_lines). No incluye facturas directas sin remisión.
//   - "En factura" / "Sin factura" = parte de esas ventas que ya quedó amparada
//     por un CFDI timbrado (incluye facturas consolidadas vía invoice_remissions)
//     vs. la que aún no.
//   - Costo/Utilidad = promedio ponderado de costo de los últimos N días; si a un
//     producto le falta costo histórico, se marca y el margen mostrado es PARCIAL.

const PDFDocument = require('pdfkit')
const { getSalesReport } = require('./salesReport')
const storage = require('../../utils/storage')
const { query } = require('../../db')
const { addPraxionFooterAllPagesPDF } = require('../../utils/praxionWitnessMark')

const MONTHS_ES = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre']

const fmtMXN  = (n) => new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 }).format(n || 0)
const fmtMXNf = (n) => new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' }).format(n || 0)
const fmtPct  = (n) => n == null ? 'n/d' : `${n.toFixed(1)}%`
const fmtNum  = (n, d = 0) => new Intl.NumberFormat('es-MX', { minimumFractionDigits: d, maximumFractionDigits: d }).format(n || 0)

const INK = '#1F2937', SUB = '#606060', LINE = '#E5E7EB', ZEBRA = '#F9FAFB'
const POS = '#166534', NEG = '#991B1B'
const MARGIN = 40
const BOTTOM_LIMIT_OFFSET = 60   // espacio reservado para el pie de página

async function generateSalesPdf({ tenantId, from, to }) {
  const { rows: tRows } = await query(
    `SELECT name, display_name, logo_storage_path,
            brand_color_primary, brand_color_secondary
       FROM tenants WHERE id = $1`, [tenantId]
  )
  const t = tRows[0] || {}
  const tenantName  = t.display_name || t.name || 'Empresa'
  const primary     = t.brand_color_primary   || '#5E9F32'
  const secondary   = t.brand_color_secondary || '#3F7324'
  const logoBuffer  = t.logo_storage_path ? await storage.fetchBuffer(t.logo_storage_path) : null

  const data = await getSalesReport({ tenantId, from, to })
  // Mismo método que el dashboard (lo devuelve getSalesReport): Facturado + Sin factura.
  const snap     = data.sales_snapshot
  const snapPrev = data.sales_snapshot_prev

  const doc = new PDFDocument({
    size: 'LETTER', margin: MARGIN, info: {
      Title: `Reporte de Ventas — ${tenantName}`,
      Author: 'Praxion Systems',
    },
  })

  const chunks = []
  doc.on('data', c => chunks.push(c))
  const finished = new Promise(resolve => doc.on('end', resolve))

  const ctx = { tenantName, primary, secondary, logoBuffer }

  // Página 1: Portada
  drawCover(doc, { tenantName, from, to, primary, secondary, logoBuffer })

  // Página 2+: resumen ejecutivo
  newContentPage(doc, ctx)
  drawKpis(doc, data, primary, secondary, snap, snapPrev)

  // Desglose por cliente (TODOS)
  drawCustomerTable(doc, ctx, data)

  // Desglose por producto (TODOS)
  drawProductTable(doc, ctx, data)

  // Utilidad por cliente
  drawCustomerProfit(doc, ctx, data)

  // Tendencia + alertas
  drawTrend(doc, ctx, data)
  drawAlerts(doc, ctx, data)

  drawFooterAllPages(doc, { tenantName, from, to })
  addPraxionFooterAllPagesPDF(doc)

  doc.end()
  await finished
  return Buffer.concat(chunks)
}

// ─── Helpers de layout / paginación ──────────────────────────────────────────
function bottomLimit(doc) { return doc.page.height - BOTTOM_LIMIT_OFFSET }

function newContentPage(doc, ctx) {
  doc.addPage()
  drawHeader(doc, ctx)
}

// Garantiza `needed` px de alto; si no caben, salta de página (con header).
function ensureSpace(doc, ctx, needed) {
  if (doc.y + needed > bottomLimit(doc)) {
    newContentPage(doc, ctx)
    return true
  }
  return false
}

function sectionTitle(doc, text, color) {
  doc.fillColor(color).font('Helvetica-Bold').fontSize(9)
     .text(text, MARGIN, doc.y, { characterSpacing: 2 })
  doc.moveDown(0.5)
}

// ─── Portada ────────────────────────────────────────────────────────────────
function drawCover(doc, { tenantName, from, to, primary, secondary, logoBuffer }) {
  const W = doc.page.width, H = doc.page.height

  doc.rect(0, 0, W, 140).fill(primary)

  if (logoBuffer) {
    try { doc.image(logoBuffer, 40, 30, { fit: [120, 80], align: 'left' }) }
    catch (_) {}
  }

  doc.fillColor('white').font('Helvetica-Bold').fontSize(28)
     .text('REPORTE DE VENTAS', 180, 50)
  doc.font('Helvetica').fontSize(14)
     .text(tenantName.toUpperCase(), 180, 88)

  doc.fillColor(INK).font('Helvetica').fontSize(11)
     .text(`PERIODO`, 40, 200)
  doc.font('Helvetica-Bold').fontSize(20).fillColor(primary)
     .text(formatPeriod(from, to), 40, 218)

  doc.rect(40, 270, W - 80, 4).fill(secondary)

  // Nota metodológica en la portada (transparencia de las cifras).
  doc.fillColor(SUB).font('Helvetica').fontSize(9)
     .text('"Ventas del periodo" usa el MISMO método que el dashboard: Facturado (facturas timbradas en el periodo, CON IVA) + '
         + 'Sin factura (remisiones entregadas aún no facturadas). El detalle por cliente/producto y la utilidad son un análisis '
         + 'OPERATIVO sobre las remisiones entregadas (subtotal sin IVA) y pueden no sumar el total de arriba; la pestaña '
         + '"Conciliación" del Excel explica la diferencia. La utilidad usa costo promedio ponderado y es estimada.',
       40, 300, { width: W - 80, align: 'left', lineGap: 2 })

  doc.fillColor(SUB).font('Helvetica').fontSize(9)
     .text(`Generado el ${new Date().toLocaleString('es-MX')}`, 40, H - 80)
  doc.fillColor('#9CA3AF').font('Helvetica').fontSize(8)
     .text('Documento confidencial · Solo para socios y administración', 40, H - 65)
}

// ─── Header en páginas internas ─────────────────────────────────────────────
function drawHeader(doc, { tenantName, primary, logoBuffer }) {
  const W = doc.page.width
  doc.rect(0, 0, W, 50).fill(primary)
  if (logoBuffer) {
    try { doc.image(logoBuffer, 30, 8, { fit: [50, 34] }) }
    catch (_) {}
  }
  doc.fillColor('white').font('Helvetica-Bold').fontSize(11)
     .text(tenantName.toUpperCase(), 90, 18)
  doc.font('Helvetica').fontSize(8)
     .text('Reporte de ventas', 90, 32)
  doc.fillColor(INK)
  doc.y = 70
}

// ─── KPIs grandes ───────────────────────────────────────────────────────────
// El ENCABEZADO usa el MISMO método que el dashboard (snapshot): Ventas del
// periodo = Facturado (facturas timbradas, CON IVA) + Sin factura (remisiones no
// facturadas). El detalle por cliente/producto/margen de abajo es por remisión
// entregada (sin IVA) — análisis operativo; ver la pestaña Conciliación del Excel.
function drawKpis(doc, data, primary, secondary, snap, snapPrev) {
  const c = data.totals_current
  const total     = snap.total
  const prevTotal = snapPrev ? snapPrev.total : 0
  const delta     = total - prevTotal
  const deltaPct  = prevTotal > 0 ? (delta / prevTotal) * 100 : null

  sectionTitle(doc, 'RESUMEN EJECUTIVO', primary)
  doc.fillColor(INK).font('Helvetica-Bold').fontSize(22)
     .text('Ventas del periodo', MARGIN, doc.y)
  doc.fillColor(SUB).font('Helvetica').fontSize(8)
     .text('Facturado (con IVA) + por facturar — mismo método que el dashboard', MARGIN, doc.y + 2)
  doc.moveDown(0.6)

  doc.fillColor(primary).font('Helvetica-Bold').fontSize(40)
     .text(fmtMXNf(total), MARGIN, doc.y)

  if (prevTotal > 0) {
    const sign  = delta > 0 ? '+' : delta < 0 ? '-' : ''
    const color = delta > 0 ? POS : delta < 0 ? NEG : SUB
    const pctTxt = deltaPct != null ? ` (${deltaPct > 0 ? '+' : deltaPct < 0 ? '-' : ''}${Math.abs(deltaPct).toFixed(1)}%)` : ''
    doc.fillColor(color).font('Helvetica-Bold').fontSize(11)
       .text(`${sign}${fmtMXN(Math.abs(delta))} vs periodo anterior${pctTxt}`, MARGIN, doc.y)
  }
  doc.moveDown(1.0)

  const cards = [
    { label: 'Facturado (con IVA)', value: fmtMXN(snap.invoiced),   accent: primary },
    { label: 'Sin factura',         value: fmtMXN(snap.uninvoiced), accent: snap.uninvoiced > 0 ? '#B45309' : SUB },
    { label: 'Facturas',            value: fmtNum(snap.count_invoiced) },
    { label: 'Remisiones s/factura',value: fmtNum(snap.count_uninvoiced) },
  ]
  drawKpiGrid(doc, cards)

  // Desglose del IVA del facturado (igual que el dashboard).
  doc.fillColor(SUB).font('Helvetica').fontSize(8)
     .text(`Facturado: subtotal ${fmtMXNf(snap.invoiced_subtotal)} + IVA ${fmtMXNf(snap.invoiced_iva)}`,
       MARGIN, doc.y + 2)
  doc.moveDown(1.0)

  // Análisis operativo (sobre remisiones entregadas, sin IVA).
  doc.fillColor(SUB).font('Helvetica-Bold').fontSize(8)
     .text('ANÁLISIS OPERATIVO · remisiones entregadas en el periodo (sin IVA)', MARGIN, doc.y, { characterSpacing: 1 })
  doc.moveDown(0.4)
  const cards2 = [
    { label: 'Remisionado',    value: fmtMXN(c.revenue) },
    { label: 'Utilidad bruta', value: fmtMXN(c.estimated_margin), accent: c.estimated_margin >= 0 ? primary : NEG },
    { label: 'Margen %',       value: fmtPct(c.margin_pct), accent: c.margin_pct > 20 ? primary : c.margin_pct < 0 ? NEG : SUB },
    { label: 'Entregas',       value: fmtNum(c.deliveries) },
  ]
  drawKpiGrid(doc, cards2)

  if (!c.cost_complete) {
    doc.moveDown(0.4)
    doc.fillColor('#B45309').font('Helvetica-Oblique').fontSize(8)
       .text('(!) Algunos productos no tienen costo histórico en el rango de cálculo; la utilidad y el margen son PARCIALES (el margen real puede ser mayor).',
         MARGIN, doc.y, { width: doc.page.width - 2 * MARGIN })
  }
  doc.moveDown(1.2)
}

function drawKpiGrid(doc, cards) {
  const startX = MARGIN, y = doc.y
  const totalW = doc.page.width - 2 * MARGIN
  const gap = 12
  const cardW = (totalW - gap * (cards.length - 1)) / cards.length
  const cardH = 64

  cards.forEach((c, i) => {
    const x = startX + i * (cardW + gap)
    doc.roundedRect(x, y, cardW, cardH, 6).fillAndStroke(ZEBRA, LINE)
    doc.fillColor(SUB).font('Helvetica').fontSize(8)
       .text(c.label.toUpperCase(), x + 10, y + 10, { characterSpacing: 1, width: cardW - 20 })
    doc.fillColor(c.accent || INK).font('Helvetica-Bold').fontSize(15)
       .text(c.value, x + 10, y + 30, { width: cardW - 20 })
  })
  doc.y = y + cardH + 4
}

// ─── Renderer genérico de tablas con paginación ──────────────────────────────
// columns: [{ label, width, align, render(row)->string|{text,color}, color }]
function drawTable(doc, ctx, { columns, rows, totalRow, rowH = 16, primary }) {
  const startX = MARGIN

  const drawHeaderRow = () => {
    const y = doc.y
    doc.fillColor(SUB).font('Helvetica-Bold').fontSize(7.5)
    let x = startX
    for (const col of columns) {
      doc.text(col.label.toUpperCase(), x, y, { width: col.width, align: col.align || 'left' })
      x += col.width
    }
    doc.moveTo(startX, y + 12).lineTo(startX + columns.reduce((s, c) => s + c.width, 0), y + 12)
       .strokeColor(LINE).stroke()
    doc.y = y + 16
  }

  const drawCells = (row, { bold = false, zebra = false } = {}) => {
    const y = doc.y
    const tableW = columns.reduce((s, c) => s + c.width, 0)
    if (zebra) doc.rect(startX, y - 2, tableW, rowH).fill(ZEBRA)
    let x = startX
    for (const col of columns) {
      const v = col.render(row)
      const text  = typeof v === 'object' && v ? v.text  : v
      const color = (typeof v === 'object' && v && v.color) ? v.color : (col.color || INK)
      // height acota a UNA línea: con width + height + ellipsis, PDFKit trunca con
      // "…" en vez de envolver a 2 líneas (que se encimaban con la fila siguiente).
      doc.fillColor(color).font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(8)
         .text(text == null ? '' : String(text), x, y,
               { width: col.width, height: 11, align: col.align || 'left', ellipsis: true, lineBreak: true })
      x += col.width
    }
    doc.y = y + rowH
  }

  drawHeaderRow()
  let i = 0
  for (const row of rows) {
    if (doc.y + rowH > bottomLimit(doc)) {
      newContentPage(doc, ctx)
      drawHeaderRow()
    }
    drawCells(row, { zebra: i % 2 === 1 })
    i++
  }

  if (totalRow) {
    if (doc.y + rowH + 4 > bottomLimit(doc)) { newContentPage(doc, ctx); drawHeaderRow() }
    const tableW = columns.reduce((s, c) => s + c.width, 0)
    doc.moveTo(startX, doc.y).lineTo(startX + tableW, doc.y).strokeColor('#9CA3AF').lineWidth(1).stroke()
    doc.lineWidth(1)
    doc.y += 3
    drawCells(totalRow, { bold: true })
  }
}

function marginColor(pct) {
  if (pct == null) return SUB
  if (pct > 20) return POS
  if (pct < 0)  return NEG
  return INK
}

// ─── Desglose por cliente (todos) ────────────────────────────────────────────
function drawCustomerTable(doc, ctx, data) {
  ensureSpace(doc, ctx, 60)
  sectionTitle(doc, `DESGLOSE POR CLIENTE  ·  ${data.by_customer.length} cliente(s)`, ctx.primary)

  if (!data.by_customer.length) {
    doc.fillColor(SUB).font('Helvetica').fontSize(10).text('Sin ventas en el periodo.', MARGIN, doc.y)
    doc.moveDown(1)
    return
  }

  const tInvoiced   = data.by_customer.reduce((s, c) => s + (c.invoiced_revenue   || 0), 0)
  const tUninvoiced = data.by_customer.reduce((s, c) => s + (c.uninvoiced_revenue || 0), 0)
  const tRevenue    = data.totals_current?.revenue || data.by_customer.reduce((s, c) => s + c.revenue, 0)

  drawTable(doc, ctx, {
    primary: ctx.primary,
    columns: [
      { label: 'Cliente',     width: 168, render: r => r.partner_name },
      { label: 'RFC',         width: 78,  render: r => r.partner_rfc || '—' },
      { label: 'En factura',  width: 66,  align: 'right', render: r => fmtMXN(r.invoiced_revenue) },
      { label: 'Sin factura', width: 66,  align: 'right', render: r => ({ text: fmtMXN(r.uninvoiced_revenue), color: r.uninvoiced_revenue > 0 ? '#B45309' : INK }) },
      { label: 'Total',       width: 62,  align: 'right', render: r => fmtMXN(r.revenue) },
      { label: '%',           width: 32,  align: 'right', render: r => `${(r.pct_of_total || 0).toFixed(0)}%` },
      { label: 'Margen',      width: 60,  align: 'right', render: r => ({ text: fmtPct(r.margin_pct), color: marginColor(r.margin_pct) }) },
    ],
    rows: data.by_customer,
    totalRow: {
      partner_name: 'TOTAL', partner_rfc: '',
      invoiced_revenue: tInvoiced, uninvoiced_revenue: tUninvoiced,
      revenue: tRevenue, pct_of_total: 100, margin_pct: null,
    },
  })
  doc.moveDown(1)
}

// ─── Desglose por producto (todos) ───────────────────────────────────────────
function drawProductTable(doc, ctx, data) {
  ensureSpace(doc, ctx, 60)
  sectionTitle(doc, `DESGLOSE POR PRODUCTO  ·  ${data.by_product.length} producto(s)`, ctx.primary)

  if (!data.by_product.length) {
    doc.fillColor(SUB).font('Helvetica').fontSize(10).text('Sin ventas en el periodo.', MARGIN, doc.y)
    doc.moveDown(1)
    return
  }

  const tInvoiced   = data.by_product.reduce((s, p) => s + (p.invoiced_revenue   || 0), 0)
  const tUninvoiced = data.by_product.reduce((s, p) => s + (p.uninvoiced_revenue || 0), 0)
  const tRevenue    = data.totals_current?.revenue || data.by_product.reduce((s, p) => s + p.revenue, 0)

  drawTable(doc, ctx, {
    primary: ctx.primary,
    columns: [
      { label: 'SKU',         width: 58,  render: p => p.sku },
      { label: 'Producto',    width: 150, render: p => p.name },
      { label: 'Cantidad',    width: 56,  align: 'right', render: p => `${fmtNum(p.qty_sold)} ${p.sale_unit || ''}`.trim() },
      { label: 'En factura',  width: 64,  align: 'right', render: p => fmtMXN(p.invoiced_revenue) },
      { label: 'Sin factura', width: 64,  align: 'right', render: p => ({ text: fmtMXN(p.uninvoiced_revenue), color: p.uninvoiced_revenue > 0 ? '#B45309' : INK }) },
      { label: 'Total',       width: 56,  align: 'right', render: p => fmtMXN(p.revenue) },
      { label: 'Margen',      width: 44,  align: 'right', render: p => ({ text: fmtPct(p.margin_pct), color: marginColor(p.margin_pct) }) },
    ],
    rows: data.by_product,
    totalRow: {
      sku: 'TOTAL', name: '', qty_sold: null, sale_unit: '',
      invoiced_revenue: tInvoiced, uninvoiced_revenue: tUninvoiced,
      revenue: tRevenue, margin_pct: null,
    },
  })
  doc.moveDown(1)
}

// ─── Utilidad por cliente ────────────────────────────────────────────────────
function drawCustomerProfit(doc, ctx, data) {
  ensureSpace(doc, ctx, 70)
  sectionTitle(doc, 'UTILIDAD ESTIMADA POR CLIENTE', ctx.primary)

  if (!data.by_customer.length) {
    doc.fillColor(SUB).font('Helvetica').fontSize(10).text('Sin ventas en el periodo.', MARGIN, doc.y)
    doc.moveDown(1)
    return
  }

  const tRevenue = data.by_customer.reduce((s, c) => s + c.revenue, 0)
  const tCost    = data.by_customer.reduce((s, c) => s + (c.estimated_cost || 0), 0)
  const tMargin  = data.by_customer.reduce((s, c) => s + (c.estimated_margin || 0), 0)
  const tPct     = tRevenue > 0 ? (tMargin / tRevenue) * 100 : null

  drawTable(doc, ctx, {
    primary: ctx.primary,
    columns: [
      { label: 'Cliente',     width: 200, render: c => c.partner_name },
      { label: 'Ventas',      width: 88,  align: 'right', render: c => fmtMXN(c.revenue) },
      { label: 'Costo est.',  width: 88,  align: 'right', render: c => fmtMXN(c.estimated_cost) },
      { label: 'Utilidad',    width: 80,  align: 'right', render: c => ({ text: fmtMXN(c.estimated_margin), color: c.estimated_margin >= 0 ? POS : NEG }) },
      { label: 'Margen',      width: 76,  align: 'right', render: c => ({ text: fmtPct(c.margin_pct), color: marginColor(c.margin_pct) }) },
    ],
    rows: data.by_customer,
    totalRow: {
      partner_name: 'TOTAL', revenue: tRevenue, estimated_cost: tCost,
      estimated_margin: tMargin, margin_pct: tPct,
    },
  })

  doc.moveDown(0.4)
  doc.fillColor(SUB).font('Helvetica').fontSize(8)
     .text('Utilidad bruta = Ventas - Costo de producción/compra (promedio ponderado). Antes de gastos operativos.',
       MARGIN, doc.y, { width: doc.page.width - 2 * MARGIN })
  if (!data.totals_current?.cost_complete) {
    doc.fillColor('#B45309').font('Helvetica-Oblique').fontSize(8)
       .text('(!) Costos incompletos para algunos productos: el margen mostrado es parcial.',
         MARGIN, doc.y + 2, { width: doc.page.width - 2 * MARGIN })
  }
  doc.moveDown(1)
}

// ─── Tendencia semanal ──────────────────────────────────────────────────────
function drawTrend(doc, ctx, data) {
  const { primary } = ctx
  ensureSpace(doc, ctx, 280)
  sectionTitle(doc, 'TENDENCIA SEMANAL', primary)
  doc.fillColor(INK).font('Helvetica-Bold').fontSize(14)
     .text('Ventas por semana', MARGIN, doc.y)
  doc.moveDown(0.8)

  if (!data.weekly_trend.length) {
    doc.fillColor(SUB).font('Helvetica').fontSize(10).text('Sin datos en el periodo.', MARGIN, doc.y)
    doc.moveDown(1)
    return
  }

  const startX = 50, startY = doc.y
  const chartW = doc.page.width - 100
  const chartH = 170
  const max = Math.max(...data.weekly_trend.map(w => w.revenue), 1)
  const barW = (chartW - 40) / data.weekly_trend.length - 8

  doc.moveTo(startX, startY + chartH).lineTo(startX + chartW, startY + chartH)
     .strokeColor(LINE).stroke()

  data.weekly_trend.forEach((w, i) => {
    const h = (w.revenue / max) * (chartH - 20)
    const x = startX + 20 + i * (barW + 8)
    const y = startY + chartH - h
    doc.rect(x, y, barW, h).fill(primary)
    if (w.revenue > 0) {
      doc.fillColor('#374151').font('Helvetica').fontSize(7)
         .text(fmtMXN(w.revenue), x - 5, y - 12, { width: barW + 10, align: 'center' })
    }
    doc.fillColor(SUB).font('Helvetica').fontSize(7)
       .text(new Date(w.week_start).toLocaleDateString('es-MX', { day: '2-digit', month: 'short' }),
             x - 5, startY + chartH + 6, { width: barW + 10, align: 'center' })
  })

  doc.y = startY + chartH + 40
}

// ─── Alertas de margen ──────────────────────────────────────────────────────
function drawAlerts(doc, ctx, data) {
  ensureSpace(doc, ctx, 80)
  sectionTitle(doc, 'ALERTAS DE MARGEN', NEG)

  if (!data.negative_margins.length) {
    doc.fillColor(POS).font('Helvetica').fontSize(10)
       .text('Sin productos vendidos por debajo del costo en este periodo.', MARGIN, doc.y)
    return
  }

  doc.fillColor('#374151').font('Helvetica').fontSize(10)
     .text(`${data.negative_margins.length} producto(s) cuya VENTA total quedó por debajo de su COSTO total:`, MARGIN, doc.y)
  doc.moveDown(0.5)

  data.negative_margins.forEach(p => {
    if (doc.y + 28 > bottomLimit(doc)) newContentPage(doc, ctx)
    const y = doc.y
    doc.fillColor(INK).font('Helvetica-Bold').fontSize(9)
       .text(p.sku + ' - ' + p.name, MARGIN, y, { width: 380, height: 11, ellipsis: true })
    doc.fillColor(NEG).font('Helvetica-Bold').fontSize(11)
       .text('-' + fmtMXN(p.loss), 430, y - 2, { width: 110, align: 'right' })
    // Comparamos en la MISMA unidad (por unidad base): precio/base vs costo/base.
    // El "precio de venta" por unidad de venta NO es comparable con el costo por base.
    const u = p.base_unit || 'u'
    const ppb = p.price_per_base != null ? `${fmtMXNf(p.price_per_base)}/${u}` : 'n/d'
    doc.fillColor(SUB).font('Helvetica').fontSize(8)
       .text(`Venta total ${fmtMXNf(p.revenue)}  ·  Costo total ${fmtMXNf(p.cost)}  ·  Precio ${ppb} vs Costo ${fmtMXNf(p.unit_cost)}/${u}`,
         MARGIN, y + 12, { width: doc.page.width - 2 * MARGIN })
    doc.y = y + 26
  })
}

// ─── Footer de todas las páginas ────────────────────────────────────────────
function drawFooterAllPages(doc, { tenantName, from, to }) {
  const pages = doc.bufferedPageRange()
  for (let i = pages.start; i < pages.start + pages.count; i++) {
    doc.switchToPage(i)
    const W = doc.page.width, H = doc.page.height
    doc.fillColor('#9CA3AF').font('Helvetica').fontSize(8)
       .text(`${tenantName}  ·  ${formatRangeInclusive(from, to)}`, MARGIN, H - 44, { width: W / 2 - MARGIN })
    doc.text(`Página ${i + 1} de ${pages.count}`, W / 2, H - 44, { width: W / 2 - MARGIN, align: 'right' })
  }
}

function formatPeriod(from, to) {
  // 'YYYY-MM-DD' inclusivo a 'YYYY-MM-DD' exclusivo. Si abarcan un solo mes
  // calendario completo, mostramos "Junio 2026"; si no, el rango inclusivo.
  const f = new Date(from + 'T00:00:00Z')
  const t = new Date(to + 'T00:00:00Z')
  t.setUTCDate(t.getUTCDate() - 1)
  if (f.getUTCFullYear() === t.getUTCFullYear() && f.getUTCMonth() === t.getUTCMonth()
      && f.getUTCDate() === 1
      && t.getUTCMonth() !== new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate() + 1)).getUTCMonth()) {
    return `${MONTHS_ES[f.getUTCMonth()]} ${f.getUTCFullYear()}`
  }
  return `${f.getUTCDate()} ${MONTHS_ES[f.getUTCMonth()].slice(0,3)} — ${t.getUTCDate()} ${MONTHS_ES[t.getUTCMonth()].slice(0,3)} ${t.getUTCFullYear()}`
}

// `to` es EXCLUSIVO; para el pie mostramos el último día inclusivo (más claro).
function formatRangeInclusive(from, to) {
  const t = new Date(to + 'T00:00:00Z')
  t.setUTCDate(t.getUTCDate() - 1)
  const toIncl = t.toISOString().slice(0, 10)
  return `${from} al ${toIncl}`
}

module.exports = { generateSalesPdf }
