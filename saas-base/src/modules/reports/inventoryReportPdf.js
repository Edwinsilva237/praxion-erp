'use strict'

// Reporte de inventario en PDF con marca del tenant y gráficos:
//   - KPIs (valor total, artículos, almacenes)
//   - Barras: valor por almacén
//   - Barras horizontales: top artículos por valor
//   - Tabla: valor por tipo de almacén (con barra de %)
//   - Alertas: costo $0 y existencias negativas
// Glyphs ASCII/WinAnsi (PDFKit con Helvetica no dibuja ▲/−/✓/⚠).

const PDFDocument = require('pdfkit')
const { getInventoryReport } = require('./inventoryReport')
const storage = require('../../utils/storage')
const { query } = require('../../db')
const { addPraxionFooterAllPagesPDF } = require('../../utils/praxionWitnessMark')

const fmtMXN  = (n) => new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 }).format(n || 0)
const fmtMXNf = (n) => new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' }).format(n || 0)
const fmtNum  = (n, d = 0) => new Intl.NumberFormat('es-MX', { minimumFractionDigits: d, maximumFractionDigits: d }).format(n || 0)

const INK = '#1F2937', SUB = '#606060', LINE = '#E5E7EB', ZEBRA = '#F9FAFB'
const NEG = '#991B1B', WARN = '#B45309'
const MARGIN = 40
const BOTTOM = 60

async function generateInventoryPdf({ tenantId }) {
  const { rows: tRows } = await query(
    `SELECT name, display_name, logo_storage_path, brand_color_primary, brand_color_secondary
       FROM tenants WHERE id = $1`, [tenantId])
  const t = tRows[0] || {}
  const tenantName = t.display_name || t.name || 'Empresa'
  const primary    = t.brand_color_primary   || '#5E9F32'
  const secondary  = t.brand_color_secondary || '#3F7324'
  const logo       = t.logo_storage_path ? await storage.fetchBuffer(t.logo_storage_path) : null

  const data = await getInventoryReport({ tenantId })
  const ctx = { tenantName, primary, secondary, logo }

  const doc = new PDFDocument({ size: 'LETTER', margin: MARGIN, info: {
    Title: `Reporte de Inventario — ${tenantName}`, Author: 'Praxion Systems' } })
  const chunks = []
  doc.on('data', c => chunks.push(c))
  const done = new Promise(r => doc.on('end', r))

  drawCover(doc, ctx, data)
  newPage(doc, ctx)
  drawKpis(doc, ctx, data)
  drawWarehouseChart(doc, ctx, data)
  drawTopItems(doc, ctx, data)
  drawByType(doc, ctx, data)
  drawAlerts(doc, ctx, data)

  drawFooter(doc, tenantName)
  addPraxionFooterAllPagesPDF(doc)
  doc.end()
  await done
  return Buffer.concat(chunks)
}

function bottomLimit(doc) { return doc.page.height - BOTTOM }
function ensure(doc, ctx, need) { if (doc.y + need > bottomLimit(doc)) newPage(doc, ctx) }

function newPage(doc, ctx) {
  doc.addPage()
  const W = doc.page.width
  doc.rect(0, 0, W, 50).fill(ctx.primary)
  if (ctx.logo) { try { doc.image(ctx.logo, 30, 8, { fit: [50, 34] }) } catch (_) {} }
  doc.fillColor('white').font('Helvetica-Bold').fontSize(11).text(ctx.tenantName.toUpperCase(), 90, 18)
  doc.font('Helvetica').fontSize(8).text('Reporte de inventario', 90, 32)
  doc.fillColor(INK); doc.y = 70
}

function section(doc, text, color) {
  doc.fillColor(color).font('Helvetica-Bold').fontSize(9).text(text, MARGIN, doc.y, { characterSpacing: 2 })
  doc.moveDown(0.5)
}

function drawCover(doc, ctx, data) {
  const W = doc.page.width, H = doc.page.height
  doc.rect(0, 0, W, 140).fill(ctx.primary)
  if (ctx.logo) { try { doc.image(ctx.logo, 40, 30, { fit: [120, 80] }) } catch (_) {} }
  doc.fillColor('white').font('Helvetica-Bold').fontSize(28).text('REPORTE DE INVENTARIO', 180, 50)
  doc.font('Helvetica').fontSize(14).text(ctx.tenantName.toUpperCase(), 180, 88)

  doc.fillColor(INK).font('Helvetica').fontSize(11).text('VALOR TOTAL DEL INVENTARIO', 40, 200)
  doc.font('Helvetica-Bold').fontSize(34).fillColor(ctx.primary).text(fmtMXNf(data.totals.total_value), 40, 218)
  doc.rect(40, 270, W - 80, 4).fill(ctx.secondary)

  doc.fillColor(SUB).font('Helvetica').fontSize(10).text(
    `${fmtNum(data.totals.distinct_items)} artículos distintos en ${fmtNum(data.totals.warehouses)} almacenes. `
    + 'Valor = existencia × costo promedio ponderado de cada artículo.', 40, 300, { width: W - 80, lineGap: 2 })

  doc.fillColor(SUB).font('Helvetica').fontSize(9).text(`Generado el ${new Date().toLocaleString('es-MX')}`, 40, H - 80)
  doc.fillColor('#9CA3AF').font('Helvetica').fontSize(8).text('Documento confidencial · Solo para socios y administración', 40, H - 65)
}

function drawKpis(doc, ctx, data) {
  section(doc, 'RESUMEN', ctx.primary)
  const cards = [
    { label: 'Valor total',        value: fmtMXN(data.totals.total_value), accent: ctx.primary },
    { label: 'Artículos',          value: fmtNum(data.totals.distinct_items) },
    { label: 'Almacenes',          value: fmtNum(data.totals.warehouses) },
    { label: 'Alertas',            value: fmtNum(data.totals.zero_cost_count + data.totals.negative_count),
      accent: (data.totals.zero_cost_count + data.totals.negative_count) ? WARN : SUB },
  ]
  const startX = MARGIN, y = doc.y, totalW = doc.page.width - 2 * MARGIN, gap = 12
  const cardW = (totalW - gap * (cards.length - 1)) / cards.length, cardH = 64
  cards.forEach((c, i) => {
    const x = startX + i * (cardW + gap)
    doc.roundedRect(x, y, cardW, cardH, 6).fillAndStroke(ZEBRA, LINE)
    doc.fillColor(SUB).font('Helvetica').fontSize(8).text(c.label.toUpperCase(), x + 10, y + 10, { characterSpacing: 1, width: cardW - 20 })
    doc.fillColor(c.accent || INK).font('Helvetica-Bold').fontSize(15).text(c.value, x + 10, y + 30, { width: cardW - 20 })
  })
  doc.y = y + cardH + 14
}

// ── Barras verticales: valor por almacén ──
function drawWarehouseChart(doc, ctx, data) {
  ensure(doc, ctx, 260)
  section(doc, 'VALOR POR ALMACÉN', ctx.primary)
  const whs = data.by_warehouse.slice(0, 8)
  if (!whs.length) { doc.fillColor(SUB).font('Helvetica').fontSize(10).text('Sin existencias.', MARGIN, doc.y); doc.moveDown(1); return }

  const startX = 55, startY = doc.y + 6, chartW = doc.page.width - 110, chartH = 150
  const max = Math.max(...whs.map(w => w.value), 1)
  const barW = (chartW - 20) / whs.length - 10
  doc.moveTo(startX, startY + chartH).lineTo(startX + chartW, startY + chartH).strokeColor(LINE).stroke()
  whs.forEach((w, i) => {
    const h = (Math.max(w.value, 0) / max) * (chartH - 18)
    const x = startX + 12 + i * (barW + 10), y = startY + chartH - h
    doc.rect(x, y, barW, h).fill(ctx.primary)
    doc.fillColor('#374151').font('Helvetica').fontSize(7).text(fmtMXN(w.value), x - 6, y - 11, { width: barW + 12, align: 'center' })
    doc.fillColor(SUB).font('Helvetica').fontSize(7).text(w.name, x - 6, startY + chartH + 5, { width: barW + 12, align: 'center', height: 16, ellipsis: true })
  })
  doc.y = startY + chartH + 34
}

// ── Barras horizontales: top artículos por valor ──
function drawTopItems(doc, ctx, data) {
  ensure(doc, ctx, 220)
  section(doc, 'TOP ARTÍCULOS POR VALOR', ctx.primary)
  const top = data.top_items.slice(0, 10)
  if (!top.length) { doc.fillColor(SUB).font('Helvetica').fontSize(10).text('Sin existencias.', MARGIN, doc.y); doc.moveDown(1); return }

  const labelW = 200, barMaxW = doc.page.width - 2 * MARGIN - labelW - 70
  const max = Math.max(...top.map(i => i.value), 1)
  const rowH = 16
  top.forEach(it => {
    if (doc.y + rowH > bottomLimit(doc)) newPage(doc, ctx)
    const y = doc.y
    doc.fillColor(INK).font('Helvetica').fontSize(8)
       .text(`${it.code ? it.code + ' ' : ''}${it.name}`, MARGIN, y + 2, { width: labelW - 6, height: 11, ellipsis: true })
    const w = (Math.max(it.value, 0) / max) * barMaxW
    doc.rect(MARGIN + labelW, y, Math.max(w, 1), 10).fill(ctx.secondary)
    doc.fillColor('#374151').font('Helvetica-Bold').fontSize(8)
       .text(fmtMXN(it.value), MARGIN + labelW + barMaxW + 6, y + 1, { width: 64, align: 'right' })
    doc.y = y + rowH
  })
  doc.moveDown(0.6)
}

// ── Tabla: valor por tipo de almacén ──
function drawByType(doc, ctx, data) {
  ensure(doc, ctx, 120)
  section(doc, 'VALOR POR TIPO DE ALMACÉN', ctx.primary)
  const rows = data.by_warehouse_type
  if (!rows.length) { doc.moveDown(0.5); return }
  const startX = MARGIN, barCol = 230, total = data.totals.total_value || 1
  rows.forEach(g => {
    if (doc.y + 18 > bottomLimit(doc)) newPage(doc, ctx)
    const y = doc.y
    doc.fillColor(INK).font('Helvetica').fontSize(9).text(g.label, startX, y, { width: 150, height: 11, ellipsis: true })
    doc.fillColor(SUB).font('Helvetica').fontSize(8).text(`${g.items} art.`, startX + 152, y + 1, { width: 50 })
    const barMax = 180, w = (Math.max(g.value, 0) / total) * barMax
    doc.rect(barCol, y + 1, Math.max(w, 1), 8).fill(ctx.primary)
    doc.fillColor(INK).font('Helvetica-Bold').fontSize(9).text(fmtMXN(g.value), barCol + barMax + 8, y, { width: 80, align: 'right' })
    doc.fillColor(SUB).font('Helvetica').fontSize(8).text(`${g.pct.toFixed(0)}%`, barCol + barMax + 92, y + 1, { width: 30, align: 'right' })
    doc.y = y + 16
  })
  doc.moveDown(0.6)
}

function drawAlerts(doc, ctx, data) {
  ensure(doc, ctx, 80)
  section(doc, 'ALERTAS', NEG)
  const z = data.alerts.zero_cost, n = data.alerts.negative
  if (!z.length && !n.length) {
    doc.fillColor('#166534').font('Helvetica').fontSize(10).text('Sin alertas: inventario consistente (sin costos en $0 ni existencias negativas).', MARGIN, doc.y)
    return
  }
  if (z.length) {
    doc.fillColor(WARN).font('Helvetica-Bold').fontSize(9).text(`${z.length} renglón(es) con costo $0 (existencia sin valuar):`, MARGIN, doc.y)
    doc.moveDown(0.3)
    z.slice(0, 12).forEach(i => {
      if (doc.y + 12 > bottomLimit(doc)) newPage(doc, ctx)
      const y = doc.y
      doc.fillColor(INK).font('Helvetica').fontSize(8).text(`${i.code ? i.code + ' - ' : ''}${i.name}`, MARGIN, y, { width: 320, height: 11, ellipsis: true })
      doc.fillColor(SUB).text(`${fmtNum(i.quantity, 2)} ${i.unit || ''} en ${i.warehouse_name}`, MARGIN + 330, y, { width: 200, height: 11, ellipsis: true })
      doc.y = y + 12
    })
    doc.moveDown(0.4)
  }
  if (n.length) {
    if (doc.y + 30 > bottomLimit(doc)) newPage(doc, ctx)
    doc.fillColor(NEG).font('Helvetica-Bold').fontSize(9).text(`${n.length} renglón(es) con existencia NEGATIVA:`, MARGIN, doc.y)
    doc.moveDown(0.3)
    n.slice(0, 12).forEach(i => {
      if (doc.y + 12 > bottomLimit(doc)) newPage(doc, ctx)
      const y = doc.y
      doc.fillColor(INK).font('Helvetica').fontSize(8).text(`${i.code ? i.code + ' - ' : ''}${i.name}`, MARGIN, y, { width: 320, height: 11, ellipsis: true })
      doc.fillColor(NEG).text(`${fmtNum(i.quantity, 2)} ${i.unit || ''} en ${i.warehouse_name}`, MARGIN + 330, y, { width: 200, height: 11, ellipsis: true })
      doc.y = y + 12
    })
  }
}

function drawFooter(doc, tenantName) {
  const pages = doc.bufferedPageRange()
  for (let i = pages.start; i < pages.start + pages.count; i++) {
    doc.switchToPage(i)
    const W = doc.page.width, H = doc.page.height
    doc.fillColor('#9CA3AF').font('Helvetica').fontSize(8)
       .text(`${tenantName}  ·  Inventario al ${new Date().toLocaleDateString('es-MX')}`, MARGIN, H - 44, { width: W / 2 - MARGIN })
    doc.text(`Página ${i + 1} de ${pages.count}`, W / 2, H - 44, { width: W / 2 - MARGIN, align: 'right' })
  }
}

module.exports = { generateInventoryPdf }
