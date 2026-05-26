'use strict'

// Reporte de producción ejecutivo en PDF. Portada con marca, KPIs grandes,
// top productos y operadores, tendencia semanal y mermas. Mismo estilo que
// el reporte de ventas para mantener coherencia visual.

const PDFDocument = require('pdfkit')
const { getProductionReport } = require('./productionReport')
const storage = require('../../utils/storage')
const { query } = require('../../db')
const { addPraxionFooterAllPagesPDF } = require('../../utils/praxionWitnessMark')

const MONTHS_ES = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre']

const fmtMXN  = (n) => new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 }).format(n || 0)
const fmtMXNf = (n) => new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' }).format(n || 0)
const fmtPct  = (n) => n == null ? '—' : `${n.toFixed(1)}%`
const fmtNum  = (n, d = 0) => new Intl.NumberFormat('es-MX', { minimumFractionDigits: d, maximumFractionDigits: d }).format(n || 0)

async function generateProductionPdf({ tenantId, from, to }) {
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

  const data = await getProductionReport({ tenantId, from, to })

  const doc = new PDFDocument({
    size: 'LETTER', margin: 40, info: {
      Title: `Reporte de Producción — ${tenantName}`,
      Author: 'Praxion Systems',
    },
  })

  const chunks = []
  doc.on('data', c => chunks.push(c))
  const finished = new Promise(resolve => doc.on('end', resolve))

  drawCover(doc, { tenantName, from, to, primary, secondary, logoBuffer })

  doc.addPage()
  drawHeader(doc, { tenantName, primary, logoBuffer })
  drawKpis(doc, data, primary, secondary)
  drawTopProducts(doc, data, primary)
  drawTopOperators(doc, data, primary)

  doc.addPage()
  drawHeader(doc, { tenantName, primary, logoBuffer })
  drawTrend(doc, data, primary, secondary)
  drawScrapAlerts(doc, data)

  drawFooterAllPages(doc, { tenantName, from, to })
  addPraxionFooterAllPagesPDF(doc)

  doc.end()
  await finished
  return Buffer.concat(chunks)
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
     .text('REPORTE DE PRODUCCIÓN', 180, 50)
  doc.font('Helvetica').fontSize(14)
     .text(tenantName.toUpperCase(), 180, 88)

  doc.fillColor('#1F2937').font('Helvetica').fontSize(11)
     .text(`PERIODO`, 40, 200)
  doc.font('Helvetica-Bold').fontSize(20).fillColor(primary)
     .text(formatPeriod(from, to), 40, 218)

  doc.rect(40, 270, W - 80, 4).fill(secondary)

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
     .text('Reporte de producción', 90, 32)
  doc.fillColor('#1F2937')
  doc.y = 70
}

// ─── KPIs grandes ───────────────────────────────────────────────────────────
function drawKpis(doc, data, primary, secondary) {
  const c = data.totals_current
  const p = data.totals_previous
  const delta = c.pt_units - p.pt_units
  const deltaPct = p.pt_units > 0 ? (delta / p.pt_units) * 100 : null

  doc.fillColor(primary).font('Helvetica-Bold').fontSize(9)
     .text('RESUMEN EJECUTIVO', 40, doc.y, { characterSpacing: 2 })
  doc.moveDown(0.3)
  doc.fillColor('#1F2937').font('Helvetica-Bold').fontSize(22)
     .text('Producción del periodo', 40, doc.y)
  doc.moveDown(0.5)

  // Cifra principal: piezas producidas
  doc.fillColor(primary).font('Helvetica-Bold').fontSize(42)
     .text(`${fmtNum(c.pt_units)} pzs`, 40, doc.y)

  if (p.pt_units > 0) {
    const arrow = delta > 0 ? '▲' : delta < 0 ? '▼' : '='
    const color = delta > 0 ? '#166534' : delta < 0 ? '#991B1B' : '#606060'
    doc.fillColor(color).font('Helvetica-Bold').fontSize(11)
       .text(`${arrow} ${fmtNum(Math.abs(delta))} piezas${deltaPct != null ? ` (${deltaPct > 0 ? '+' : ''}${deltaPct.toFixed(1)}%)` : ''} vs periodo anterior`, 40, doc.y)
  }
  doc.moveDown(1.2)

  // Grid de KPIs secundarios. Si hay esquineros con length_mm, mostramos
  // costo/metro como 5ª tarjeta.
  const cards = [
    { label: 'Turnos cerrados', value: fmtNum(c.shifts) },
    { label: 'Rendimiento',     value: fmtPct(c.yield_pct), accent: c.yield_pct > 90 ? primary : c.yield_pct < 80 ? '#991B1B' : '#606060' },
    { label: 'Costo total',     value: fmtMXN(c.total_cost) },
    { label: 'Costo unitario',  value: fmtMXNf(c.unit_cost) },
  ]
  if (c.avg_cost_per_meter != null) {
    cards.push({ label: 'Costo / metro', value: fmtMXNf(c.avg_cost_per_meter), accent: secondary })
  }
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
    doc.roundedRect(x, y, cardW, cardH, 6)
       .fillAndStroke('#F9FAFB', '#E5E7EB')
    doc.fillColor('#606060').font('Helvetica').fontSize(8)
       .text(c.label.toUpperCase(), x + 12, y + 12, { characterSpacing: 1 })
    doc.fillColor(c.accent || '#1F2937').font('Helvetica-Bold').fontSize(18)
       .text(c.value, x + 12, y + 32, { width: cardW - 24 })
  })
  doc.y = y + cardH + 4
}

// ─── Top 5 productos ───────────────────────────────────────────────────────
function drawTopProducts(doc, data, primary) {
  doc.fillColor(primary).font('Helvetica-Bold').fontSize(9)
     .text('TOP 5 PRODUCTOS PRODUCIDOS', 40, doc.y, { characterSpacing: 2 })
  doc.moveDown(0.5)

  const top = (data.by_product || []).slice(0, 5)
  if (top.length === 0) {
    doc.fillColor('#606060').font('Helvetica').fontSize(10).text('Sin datos en el periodo.', 40, doc.y)
    doc.moveDown(1)
    return
  }

  top.forEach((p, i) => {
    const y = doc.y
    doc.roundedRect(40, y, 22, 22, 3).fillAndStroke(primary, primary)
    doc.fillColor('white').font('Helvetica-Bold').fontSize(11)
       .text(String(i + 1), 40, y + 5, { width: 22, align: 'center' })
    doc.fillColor('#1F2937').font('Helvetica-Bold').fontSize(11)
       .text(p.name, 72, y + 4, { width: 280, ellipsis: true })
    doc.fillColor('#606060').font('Helvetica').fontSize(8)
       .text(`${p.sku} · ${p.shifts} turnos · yield ${fmtPct(p.yield_pct)}`, 72, y + 18, { width: 280, ellipsis: true })
    doc.fillColor('#1F2937').font('Helvetica-Bold').fontSize(13)
       .text(`${fmtNum(p.pt_units)} pzs`, 360, y + 6, { width: 180, align: 'right' })

    doc.y = y + 28
  })
  doc.moveDown(0.5)
}

// ─── Top 5 operadores ──────────────────────────────────────────────────────
function drawTopOperators(doc, data, primary) {
  if (doc.y > doc.page.height - 200) doc.addPage().y = 70
  doc.fillColor(primary).font('Helvetica-Bold').fontSize(9)
     .text('TOP 5 OPERADORES', 40, doc.y, { characterSpacing: 2 })
  doc.moveDown(0.5)

  const top = (data.by_operator || []).slice(0, 5)
  if (top.length === 0) {
    doc.fillColor('#606060').font('Helvetica').fontSize(10).text('Sin datos en el periodo.', 40, doc.y)
    doc.moveDown(1)
    return
  }

  let y = doc.y
  doc.fillColor('#606060').font('Helvetica-Bold').fontSize(8)
  doc.text('OPERADOR',     40,  y, { width: 220 })
  doc.text('TURNOS',       260, y, { width: 60, align: 'right' })
  doc.text('PIEZAS',       330, y, { width: 80, align: 'right' })
  doc.text('PZS/HORA',     420, y, { width: 80, align: 'right' })
  doc.text('SCRAP %',      510, y, { width: 60, align: 'right' })
  doc.moveTo(40, y + 14).lineTo(570, y + 14).strokeColor('#E5E7EB').stroke()
  doc.y = y + 20

  top.forEach(op => {
    const ry = doc.y
    doc.fillColor('#374151').font('Helvetica').fontSize(9)
    doc.text(op.operator_name, 40, ry, { width: 220, ellipsis: true })
    doc.text(String(op.shifts), 260, ry, { width: 60, align: 'right' })
    doc.font('Helvetica-Bold').text(fmtNum(op.pt_units), 330, ry, { width: 80, align: 'right' })
    doc.font('Helvetica').text(fmtNum(op.units_per_hour, 1), 420, ry, { width: 80, align: 'right' })
    doc.text(`${op.scrap_pct.toFixed(1)}%`, 510, ry, { width: 60, align: 'right' })
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
     .text('Piezas producidas por semana', 40, doc.y)
  doc.moveDown(0.8)

  if (data.weekly_trend.length === 0) {
    doc.fillColor('#606060').font('Helvetica').fontSize(10).text('Sin datos en el periodo.', 40, doc.y)
    return
  }

  const startX = 50, startY = doc.y
  const chartW = doc.page.width - 100
  const chartH = 180
  const max = Math.max(...data.weekly_trend.map(w => w.pt_units), 1)
  const barW = (chartW - 40) / data.weekly_trend.length - 8

  doc.moveTo(startX, startY + chartH).lineTo(startX + chartW, startY + chartH)
     .strokeColor('#E5E7EB').stroke()

  data.weekly_trend.forEach((w, i) => {
    const h = (w.pt_units / max) * (chartH - 20)
    const x = startX + 20 + i * (barW + 8)
    const y = startY + chartH - h
    doc.rect(x, y, barW, h).fill(primary)
    if (w.pt_units > 0) {
      doc.fillColor('#374151').font('Helvetica').fontSize(7)
         .text(fmtNum(w.pt_units), x - 5, y - 12, { width: barW + 10, align: 'center' })
    }
    doc.fillColor('#606060').font('Helvetica').fontSize(7)
       .text(new Date(w.week_start).toLocaleDateString('es-MX', { day: '2-digit', month: 'short' }),
             x - 5, startY + chartH + 6, { width: barW + 10, align: 'center' })
  })

  doc.y = startY + chartH + 40
}

// ─── Alertas de mermas ──────────────────────────────────────────────────────
function drawScrapAlerts(doc, data) {
  doc.fillColor('#991B1B').font('Helvetica-Bold').fontSize(9)
     .text('PRODUCTOS CON MAYOR MERMA', 40, doc.y, { characterSpacing: 2 })
  doc.moveDown(0.5)

  const top = data.scrap_analysis.by_product.slice(0, 8)
  if (top.length === 0) {
    doc.fillColor('#166534').font('Helvetica').fontSize(10)
       .text('✓ Sin mermas significativas en el periodo.', 40, doc.y)
    return
  }

  top.forEach(p => {
    const y = doc.y
    doc.fillColor('#1F2937').font('Helvetica-Bold').fontSize(9)
       .text(`${p.sku} — ${p.name}`, 40, y, { width: 380, ellipsis: true })
    doc.fillColor('#991B1B').font('Helvetica-Bold').fontSize(11)
       .text(`${p.scrap_pct.toFixed(1)}%`, 430, y - 2, { width: 110, align: 'right' })
    doc.fillColor('#606060').font('Helvetica').fontSize(8)
       .text(`Scrap ${fmtNum(p.scrap_kg, 2)} kg  ·  PT ${fmtNum(p.pt_kg, 2)} kg  ·  MP consumida ${fmtNum(p.mp_kg, 2)} kg`, 40, y + 12)
    doc.y = y + 26
  })
}

// ─── Footer ────────────────────────────────────────────────────────────────
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

module.exports = { generateProductionPdf }
