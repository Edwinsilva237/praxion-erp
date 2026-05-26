'use strict'

// Reporte de ventas ejecutivo en PDF. Pensado para presentar a socios:
// portada con marca del tenant, KPIs grandes, top 5 clientes/productos,
// tendencia semanal y alertas. Sin tablas crudas — visualmente limpio.

const PDFDocument = require('pdfkit')
const { getSalesReport } = require('./salesReport')
const storage = require('../../utils/storage')
const { query } = require('../../db')
const { addPraxionFooterAllPagesPDF } = require('../../utils/praxionWitnessMark')

const MONTHS_ES = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre']

const fmtMXN  = (n) => new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 }).format(n || 0)
const fmtMXNf = (n) => new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' }).format(n || 0)
const fmtPct  = (n) => n == null ? '—' : `${n.toFixed(1)}%`
const fmtNum  = (n, d = 0) => new Intl.NumberFormat('es-MX', { minimumFractionDigits: d, maximumFractionDigits: d }).format(n || 0)

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

  const doc = new PDFDocument({
    size: 'LETTER', margin: 40, info: {
      Title: `Reporte de Ventas — ${tenantName}`,
      Author: 'Praxion Systems',
    },
  })

  const chunks = []
  doc.on('data', c => chunks.push(c))
  const finished = new Promise(resolve => doc.on('end', resolve))

  // Página 1: Portada
  drawCover(doc, { tenantName, from, to, primary, secondary, logoBuffer })

  // Página 2+: KPIs y tablas
  doc.addPage()
  drawHeader(doc, { tenantName, primary, logoBuffer })
  drawKpis(doc, data, primary, secondary)
  drawTopCustomers(doc, data, primary)
  drawTopProducts(doc, data, primary)

  // Tendencia
  doc.addPage()
  drawHeader(doc, { tenantName, primary, logoBuffer })
  drawTrend(doc, data, primary, secondary)
  drawAlerts(doc, data)

  drawFooterAllPages(doc, { tenantName, from, to })
  addPraxionFooterAllPagesPDF(doc)

  doc.end()
  await finished
  return Buffer.concat(chunks)
}

// ─── Portada ────────────────────────────────────────────────────────────────
function drawCover(doc, { tenantName, from, to, primary, secondary, logoBuffer }) {
  const W = doc.page.width, H = doc.page.height

  // Banda superior de color primario
  doc.rect(0, 0, W, 140).fill(primary)

  // Logo (si existe)
  if (logoBuffer) {
    try { doc.image(logoBuffer, 40, 30, { fit: [120, 80], align: 'left' }) }
    catch (_) {}
  }

  // Título
  doc.fillColor('white').font('Helvetica-Bold').fontSize(28)
     .text('REPORTE DE VENTAS', 180, 50)
  doc.font('Helvetica').fontSize(14)
     .text(tenantName.toUpperCase(), 180, 88)

  // Subtítulo con periodo
  doc.fillColor('#1F2937').font('Helvetica').fontSize(11)
     .text(`PERIODO`, 40, 200)
  doc.font('Helvetica-Bold').fontSize(20).fillColor(primary)
     .text(formatPeriod(from, to), 40, 218)

  // Banda decorativa secundaria
  doc.rect(40, 270, W - 80, 4).fill(secondary)

  // Pie de portada
  doc.fillColor('#606060').font('Helvetica').fontSize(9)
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
  doc.fillColor('#1F2937') // reset color
  doc.y = 70
}

// ─── KPIs grandes ───────────────────────────────────────────────────────────
function drawKpis(doc, data, primary, secondary) {
  const c = data.totals_current
  const p = data.totals_previous
  const delta = c.revenue - p.revenue
  const deltaPct = p.revenue > 0 ? (delta / p.revenue) * 100 : null

  doc.fillColor(primary).font('Helvetica-Bold').fontSize(9)
     .text('RESUMEN EJECUTIVO', 40, doc.y, { characterSpacing: 2 })
  doc.moveDown(0.3)
  doc.fillColor('#1F2937').font('Helvetica-Bold').fontSize(22)
     .text('Ventas del periodo', 40, doc.y)
  doc.moveDown(0.5)

  // Cifra principal grande
  doc.fillColor(primary).font('Helvetica-Bold').fontSize(42)
     .text(fmtMXNf(c.revenue), 40, doc.y)

  // Comparativa
  if (p.revenue > 0) {
    const arrow = delta > 0 ? '▲' : delta < 0 ? '▼' : '='
    const color = delta > 0 ? '#166534' : delta < 0 ? '#991B1B' : '#606060'
    doc.fillColor(color).font('Helvetica-Bold').fontSize(11)
       .text(`${arrow} ${fmtMXN(Math.abs(delta))}${deltaPct != null ? ` (${deltaPct > 0 ? '+' : ''}${deltaPct.toFixed(1)}%)` : ''} vs periodo anterior`, 40, doc.y)
  }
  doc.moveDown(1.2)

  // Grid de 4 KPIs secundarios
  const cards = [
    { label: 'Entregas',       value: fmtNum(c.deliveries) },
    { label: 'Clientes',       value: fmtNum(c.customers) },
    { label: 'Utilidad bruta', value: fmtMXN(c.estimated_margin), accent: c.estimated_margin >= 0 ? primary : '#991B1B' },
    { label: 'Margen %',       value: fmtPct(c.margin_pct), accent: c.margin_pct > 20 ? primary : c.margin_pct < 0 ? '#991B1B' : '#606060' },
  ]
  drawKpiGrid(doc, cards, primary)
  doc.moveDown(1.5)
}

function drawKpiGrid(doc, cards, primary) {
  const startX = 40, y = doc.y
  const totalW = doc.page.width - 80
  const gap = 12
  const cardW = (totalW - gap * (cards.length - 1)) / cards.length
  const cardH = 75

  cards.forEach((c, i) => {
    const x = startX + i * (cardW + gap)
    // Card background sutil
    doc.roundedRect(x, y, cardW, cardH, 6)
       .fillAndStroke('#F9FAFB', '#E5E7EB')
    // Etiqueta
    doc.fillColor('#606060').font('Helvetica').fontSize(8)
       .text(c.label.toUpperCase(), x + 12, y + 12, { characterSpacing: 1 })
    // Valor
    doc.fillColor(c.accent || '#1F2937').font('Helvetica-Bold').fontSize(18)
       .text(c.value, x + 12, y + 32, { width: cardW - 24 })
  })
  doc.y = y + cardH + 4
}

// ─── Top 5 clientes ────────────────────────────────────────────────────────
function drawTopCustomers(doc, data, primary) {
  doc.fillColor(primary).font('Helvetica-Bold').fontSize(9)
     .text('TOP 5 CLIENTES', 40, doc.y, { characterSpacing: 2 })
  doc.moveDown(0.5)

  if (data.top_customers.length === 0) {
    doc.fillColor('#606060').font('Helvetica').fontSize(10).text('Sin datos en el periodo.', 40, doc.y)
    doc.moveDown(1)
    return
  }

  data.top_customers.forEach((c, i) => {
    const y = doc.y
    // Número
    doc.roundedRect(40, y, 22, 22, 3).fillAndStroke(primary, primary)
    doc.fillColor('white').font('Helvetica-Bold').fontSize(11)
       .text(String(i + 1), 40, y + 5, { width: 22, align: 'center' })
    // Nombre
    doc.fillColor('#1F2937').font('Helvetica-Bold').fontSize(11)
       .text(c.partner_name, 72, y + 4, { width: 280, ellipsis: true })
    doc.fillColor('#606060').font('Helvetica').fontSize(8)
       .text(`${c.deliveries} entregas`, 72, y + 18)
    // Monto
    doc.fillColor('#1F2937').font('Helvetica-Bold').fontSize(13)
       .text(fmtMXN(c.revenue), 360, y + 6, { width: 180, align: 'right' })

    doc.y = y + 28
  })
  doc.moveDown(0.5)
}

// ─── Top productos (5) ─────────────────────────────────────────────────────
function drawTopProducts(doc, data, primary) {
  if (doc.y > doc.page.height - 200) doc.addPage().y = 70
  doc.fillColor(primary).font('Helvetica-Bold').fontSize(9)
     .text('TOP 5 PRODUCTOS', 40, doc.y, { characterSpacing: 2 })
  doc.moveDown(0.5)

  const top5 = (data.by_product || []).slice(0, 5)
  if (top5.length === 0) {
    doc.fillColor('#606060').font('Helvetica').fontSize(10).text('Sin datos en el periodo.', 40, doc.y)
    doc.moveDown(1)
    return
  }

  // Header
  let y = doc.y
  doc.fillColor('#606060').font('Helvetica-Bold').fontSize(8)
  doc.text('SKU',      40,  y, { width: 80 })
  doc.text('PRODUCTO', 130, y, { width: 220 })
  doc.text('VENTAS',   360, y, { width: 90, align: 'right' })
  doc.text('% TOTAL',  460, y, { width: 80, align: 'right' })
  doc.moveTo(40, y + 14).lineTo(540, y + 14).strokeColor('#E5E7EB').stroke()
  doc.y = y + 20

  top5.forEach(p => {
    const ry = doc.y
    doc.fillColor('#374151').font('Helvetica').fontSize(9)
    doc.text(p.sku, 40, ry, { width: 80, ellipsis: true })
    doc.text(p.name, 130, ry, { width: 220, ellipsis: true })
    doc.font('Helvetica-Bold').text(fmtMXN(p.revenue), 360, ry, { width: 90, align: 'right' })
    doc.font('Helvetica').text(`${(p.pct_of_total || 0).toFixed(1)}%`, 460, ry, { width: 80, align: 'right' })
    doc.y = ry + 18
  })
  doc.moveDown(0.5)
}

// ─── Tendencia semanal ──────────────────────────────────────────────────────
function drawTrend(doc, data, primary, secondary) {
  doc.fillColor(primary).font('Helvetica-Bold').fontSize(9)
     .text('TENDENCIA SEMANAL', 40, doc.y, { characterSpacing: 2 })
  doc.moveDown(0.3)
  doc.fillColor('#1F2937').font('Helvetica-Bold').fontSize(16)
     .text('Ventas por semana', 40, doc.y)
  doc.moveDown(0.8)

  if (data.weekly_trend.length === 0) {
    doc.fillColor('#606060').font('Helvetica').fontSize(10).text('Sin datos en el periodo.', 40, doc.y)
    return
  }

  // Gráfica de barras
  const startX = 50, startY = doc.y
  const chartW = doc.page.width - 100
  const chartH = 180
  const max = Math.max(...data.weekly_trend.map(w => w.revenue), 1)
  const barW = (chartW - 40) / data.weekly_trend.length - 8

  // Eje y línea base
  doc.moveTo(startX, startY + chartH).lineTo(startX + chartW, startY + chartH)
     .strokeColor('#E5E7EB').stroke()

  data.weekly_trend.forEach((w, i) => {
    const h = (w.revenue / max) * (chartH - 20)
    const x = startX + 20 + i * (barW + 8)
    const y = startY + chartH - h
    doc.rect(x, y, barW, h).fill(primary)
    // Monto arriba
    if (w.revenue > 0) {
      doc.fillColor('#374151').font('Helvetica').fontSize(7)
         .text(fmtMXN(w.revenue), x - 5, y - 12, { width: barW + 10, align: 'center' })
    }
    // Fecha debajo
    doc.fillColor('#606060').font('Helvetica').fontSize(7)
       .text(new Date(w.week_start).toLocaleDateString('es-MX', { day: '2-digit', month: 'short' }),
             x - 5, startY + chartH + 6, { width: barW + 10, align: 'center' })
  })

  doc.y = startY + chartH + 40
}

// ─── Alertas de margen ──────────────────────────────────────────────────────
function drawAlerts(doc, data) {
  doc.fillColor('#991B1B').font('Helvetica-Bold').fontSize(9)
     .text('ALERTAS DE MARGEN', 40, doc.y, { characterSpacing: 2 })
  doc.moveDown(0.5)

  if (data.negative_margins.length === 0) {
    doc.fillColor('#166534').font('Helvetica').fontSize(10)
       .text('✓ Sin productos vendidos por debajo del costo en este periodo.', 40, doc.y)
    return
  }

  doc.fillColor('#374151').font('Helvetica').fontSize(10)
     .text(`${data.negative_margins.length} producto(s) se vendieron por debajo del costo:`, 40, doc.y)
  doc.moveDown(0.5)

  data.negative_margins.slice(0, 10).forEach(p => {
    const y = doc.y
    doc.fillColor('#1F2937').font('Helvetica-Bold').fontSize(9)
       .text(p.sku + ' — ' + p.name, 40, y, { width: 380, ellipsis: true })
    doc.fillColor('#991B1B').font('Helvetica-Bold').fontSize(11)
       .text('−' + fmtMXN(p.loss), 430, y - 2, { width: 110, align: 'right' })
    doc.fillColor('#606060').font('Helvetica').fontSize(8)
       .text(`Precio venta ${fmtMXNf(p.avg_price)}  ·  Costo ${fmtMXNf(p.unit_cost)}`, 40, y + 12)
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
       .text(`${tenantName}  ·  ${from} al ${to}`, 40, H - 44, { width: W / 2 - 40 })
    doc.text(`Página ${i + 1} de ${pages.count}`, W / 2, H - 44, { width: W / 2 - 40, align: 'right' })
  }
}

function formatPeriod(from, to) {
  // 'YYYY-MM-DD' inclusivo a YYYY-MM-DD exclusivo. Si abarcan un solo mes
  // calendario, mostramos "Mayo 2026". Si no, "1 May - 31 May 2026".
  const f = new Date(from + 'T00:00:00Z')
  const t = new Date(to + 'T00:00:00Z')
  t.setUTCDate(t.getUTCDate() - 1) // último día inclusivo
  if (f.getUTCFullYear() === t.getUTCFullYear() && f.getUTCMonth() === t.getUTCMonth()
      && f.getUTCDate() === 1
      && t.getUTCMonth() !== new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate() + 1)).getUTCMonth()) {
    return `${MONTHS_ES[f.getUTCMonth()]} ${f.getUTCFullYear()}`
  }
  return `${f.getUTCDate()} ${MONTHS_ES[f.getUTCMonth()].slice(0,3)} — ${t.getUTCDate()} ${MONTHS_ES[t.getUTCMonth()].slice(0,3)} ${t.getUTCFullYear()}`
}

module.exports = { generateSalesPdf }
