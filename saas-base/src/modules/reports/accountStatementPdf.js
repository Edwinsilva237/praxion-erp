'use strict'

// PDF del estado de cuenta. Soporta dos modos:
//   - mode='all'     → resumen ejecutivo de TODAS las cuentas (para socios)
//   - mode='partner' → estado de cuenta detallado de UN cliente/proveedor
//                       (para enviar al cliente por correo de cobranza)

const PDFDocument = require('pdfkit')
const { getAccountStatement, getPartnerStatement } = require('./accountStatementReport')
const storage = require('../../utils/storage')
const { query } = require('../../db')
const { addPraxionFooterPDF, addPraxionFooterAllPagesPDF } = require('../../utils/praxionWitnessMark')

const fmtMXN  = (n) => new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 }).format(n || 0)
const fmtMXNf = (n) => new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' }).format(n || 0)
const fmtNum  = (n) => new Intl.NumberFormat('es-MX').format(n || 0)
const fmtDate = (d) => d ? new Date(d).toLocaleDateString('es-MX', { day: '2-digit', month: '2-digit', year: 'numeric' }) : '—'

const COLOR = {
  overdue:  '#DC2626', overdueBg:  '#FEE2E2',
  due_soon: '#D97706', due_soonBg: '#FEF3C7',
  current:  '#059669', currentBg:  '#D1FAE5',
  no_due:   '#6B7280', no_dueBg:   '#E5E7EB',
}

const STATUS_LABEL = {
  overdue:  'VENCIDO',
  due_soon: 'PRÓX. A VENCER',
  current:  'AL CORRIENTE',
  no_due:   'SIN FECHA',
}

async function generateAccountStatementPdf({ tenantId, direction, mode, partnerId, filters }) {
  const t = await getTenantBranding(tenantId)
  const labels = direction === 'in'
    ? { titleAll: 'CUENTAS POR COBRAR',  titleOne: 'ESTADO DE CUENTA', partnerNoun: 'cliente',   verb: 'cobrar' }
    : { titleAll: 'CUENTAS POR PAGAR',   titleOne: 'ESTADO DE CUENTA', partnerNoun: 'proveedor', verb: 'pagar'  }

  if (mode === 'partner') {
    const data = await getPartnerStatement({ tenantId, direction, partnerId })
    return renderPartnerPdf({ t, labels, data })
  }

  // mode === 'all'
  const data = await getAccountStatement({ tenantId, direction, filters: filters || {} })
  return renderGeneralPdf({ t, labels, data })
}

async function getTenantBranding(tenantId) {
  const { rows } = await query(
    `SELECT name, display_name, logo_storage_path,
            brand_color_primary, brand_color_secondary
       FROM tenants WHERE id = $1`, [tenantId]
  )
  const t = rows[0] || {}
  return {
    name:       t.display_name || t.name || 'Empresa',
    primary:    t.brand_color_primary   || '#5E9F32',
    secondary:  t.brand_color_secondary || '#3F7324',
    logoBuffer: t.logo_storage_path ? await storage.fetchBuffer(t.logo_storage_path) : null,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PDF GENERAL (todos los partners)
// ─────────────────────────────────────────────────────────────────────────────

function renderGeneralPdf({ t, labels, data }) {
  const doc = new PDFDocument({
    size: 'LETTER', margin: 40,
    info: { Title: `${labels.titleAll} — ${t.name}`, Author: 'Praxion Systems' },
  })
  const chunks = []
  doc.on('data', c => chunks.push(c))
  const finished = new Promise(resolve => doc.on('end', resolve))

  drawCover(doc, t, labels.titleAll, data.snapshot_date)
  doc.addPage()
  drawInternalHeader(doc, t, labels.titleAll)
  drawSummaryKpis(doc, data, t)
  drawAgingBars(doc, data, t)
  doc.addPage()
  drawInternalHeader(doc, t, labels.titleAll)
  drawTopPartners(doc, data, t, labels)

  drawFooter(doc, t.name)
  addPraxionFooterAllPagesPDF(doc)
  doc.end()
  return finished.then(() => Buffer.concat(chunks))
}

function drawSummaryKpis(doc, data, t) {
  const s = data.summary
  doc.fillColor(t.primary).font('Helvetica-Bold').fontSize(9)
     .text('RESUMEN', 40, doc.y, { characterSpacing: 2 })
  doc.moveDown(0.3)
  doc.fillColor('#1F2937').font('Helvetica-Bold').fontSize(22).text('Saldo pendiente total', 40, doc.y)
  doc.moveDown(0.5)
  doc.fillColor(t.primary).font('Helvetica-Bold').fontSize(42).text(fmtMXNf(s.total_pending_amount), 40, doc.y)
  doc.moveDown(0.5)
  doc.fillColor('#606060').font('Helvetica').fontSize(10).text(
    `${fmtNum(s.total_pending_count)} documento(s) pendiente(s) al ${data.snapshot_date}`, 40, doc.y
  )
  doc.moveDown(1.2)

  const cards = [
    { label: 'Vencido',          value: fmtMXN(s.overdue.amount),  sub: `${fmtNum(s.overdue.count)} docs`, accent: COLOR.overdue },
    { label: 'Próximo a vencer', value: fmtMXN(s.due_soon.amount), sub: `${fmtNum(s.due_soon.count)} docs`, accent: COLOR.due_soon },
    { label: 'Al corriente',     value: fmtMXN(s.current.amount),  sub: `${fmtNum(s.current.count)} docs`, accent: COLOR.current },
    { label: 'Saldo neto',       value: fmtMXN(s.net_balance),     sub: 'Pendiente − anticipos − NCs', accent: s.net_balance > 0 ? COLOR.overdue : COLOR.current },
  ]
  drawKpiGrid(doc, cards)
  doc.moveDown(1.5)
}

function drawAgingBars(doc, data, t) {
  doc.fillColor(t.primary).font('Helvetica-Bold').fontSize(9)
     .text('DISTRIBUCIÓN POR ANTIGÜEDAD', 40, doc.y, { characterSpacing: 2 })
  doc.moveDown(0.5)

  const s = data.summary
  const total = s.total_pending_amount
  if (total === 0) {
    doc.fillColor('#166534').font('Helvetica').fontSize(10)
       .text('✓ Sin saldos pendientes en este momento.', 40, doc.y)
    return
  }

  const buckets = [
    { label: 'Vencido',          data: s.overdue,  color: COLOR.overdue },
    { label: 'Próximo a vencer', data: s.due_soon, color: COLOR.due_soon },
    { label: 'Al corriente',     data: s.current,  color: COLOR.current },
    { label: 'Sin fecha',        data: s.no_due,   color: COLOR.no_due },
  ]

  buckets.forEach(b => {
    if (b.data.amount === 0) return
    const y = doc.y
    const pct = (b.data.amount / total) * 100
    const barMax = doc.page.width - 280
    const barW = Math.max(2, (b.data.amount / total) * barMax)

    doc.fillColor('#1F2937').font('Helvetica-Bold').fontSize(10).text(b.label, 40, y, { width: 100 })
    doc.fillColor('#606060').font('Helvetica').fontSize(8).text(`${b.data.count} doc${b.data.count !== 1 ? 's' : ''}`, 40, y + 12)
    doc.rect(150, y + 2, barW, 18).fill(b.color)
    doc.fillColor('#1F2937').font('Helvetica-Bold').fontSize(10)
       .text(fmtMXN(b.data.amount), 150 + barW + 8, y + 4)
    doc.fillColor('#606060').font('Helvetica').fontSize(8)
       .text(`${pct.toFixed(1)}%`, doc.page.width - 80, y + 6, { width: 40, align: 'right' })
    doc.y = y + 28
  })
  doc.moveDown(0.8)
}

function drawTopPartners(doc, data, t, labels) {
  const ordered = [...data.by_partner].sort((a, b) => b.overdue_amount - a.overdue_amount).slice(0, 15)
  doc.fillColor('#991B1B').font('Helvetica-Bold').fontSize(9)
     .text(`${labels.partnerNoun.toUpperCase()}S CON MAYOR SALDO`, 40, doc.y, { characterSpacing: 2 })
  doc.moveDown(0.5)

  if (ordered.length === 0) {
    doc.fillColor('#606060').font('Helvetica').fontSize(10).text('Sin saldos pendientes.', 40, doc.y)
    return
  }

  let y = doc.y
  doc.fillColor('#606060').font('Helvetica-Bold').fontSize(8)
  doc.text(labels.partnerNoun.toUpperCase(), 40,  y, { width: 230 })
  doc.text('# DOCS',                          270, y, { width: 50, align: 'right' })
  doc.text('VENCIDO',                         325, y, { width: 90, align: 'right' })
  doc.text('PENDIENTE',                       420, y, { width: 90, align: 'right' })
  doc.text('DÍAS MÁX',                        515, y, { width: 50, align: 'right' })
  doc.moveTo(40, y + 14).lineTo(565, y + 14).strokeColor('#E5E7EB').stroke()
  doc.y = y + 20

  ordered.forEach(p => {
    if (doc.y > doc.page.height - 60) { doc.addPage(); drawInternalHeader(doc, t, labels.titleAll); y = doc.y }
    const ry = doc.y
    doc.fillColor('#374151').font('Helvetica').fontSize(9)
    doc.text(p.partner_name, 40, ry, { width: 230, ellipsis: true })
    doc.text(fmtNum(p.docs_count), 270, ry, { width: 50, align: 'right' })
    if (p.overdue_amount > 0) {
      doc.font('Helvetica-Bold').fillColor(COLOR.overdue)
      doc.text(fmtMXN(p.overdue_amount), 325, ry, { width: 90, align: 'right' })
    } else {
      doc.font('Helvetica').fillColor('#9CA3AF')
      doc.text('—', 325, ry, { width: 90, align: 'right' })
    }
    doc.font('Helvetica').fillColor('#374151')
    doc.text(fmtMXN(p.pending_amount), 420, ry, { width: 90, align: 'right' })
    doc.text(p.max_days_overdue != null ? `${p.max_days_overdue}d` : '—', 515, ry, { width: 50, align: 'right' })
    doc.y = ry + 18
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// PDF INDIVIDUAL (un partner)
// ─────────────────────────────────────────────────────────────────────────────

function renderPartnerPdf({ t, labels, data }) {
  const doc = new PDFDocument({
    size: 'LETTER', margin: 40,
    info: { Title: `${labels.titleOne} — ${data.partner.name}`, Author: 'Praxion Systems' },
  })
  const chunks = []
  doc.on('data', c => chunks.push(c))
  const finished = new Promise(resolve => doc.on('end', resolve))

  drawPartnerHeader(doc, t, data, labels)
  drawPartnerSummary(doc, data, labels)
  drawPartnerDocuments(doc, data, t, labels)
  if (data.advances.length > 0)     drawPartnerAdvances(doc, data, t)
  if (data.credit_notes.length > 0) drawPartnerCreditNotes(doc, data, t)
  drawPartnerNetBalance(doc, data, labels)
  drawPartnerFooter(doc, t, data, labels)

  addPraxionFooterPDF(doc)
  doc.end()
  return finished.then(() => Buffer.concat(chunks))
}

function drawPartnerHeader(doc, t, data, labels) {
  const W = doc.page.width
  doc.rect(0, 0, W, 90).fill(t.primary)
  if (t.logoBuffer) {
    try { doc.image(t.logoBuffer, 30, 18, { fit: [54, 54] }) } catch (_) {}
  }
  doc.fillColor('white').font('Helvetica-Bold').fontSize(20).text(labels.titleOne, 100, 22)
  doc.font('Helvetica').fontSize(11).text(t.name.toUpperCase(), 100, 50)

  doc.fillColor('white').font('Helvetica').fontSize(9)
     .text(`Generado: ${new Date().toLocaleString('es-MX')}`, W - 250, 30, { width: 220, align: 'right' })
  doc.text(`Snapshot al ${data.snapshot_date}`, W - 250, 45, { width: 220, align: 'right' })

  doc.y = 110

  // Bloque del cliente
  doc.fillColor('#1F2937').font('Helvetica-Bold').fontSize(11)
     .text(`${capitalize(labels.partnerNoun)}`, 40, doc.y)
  doc.moveDown(0.2)
  doc.font('Helvetica-Bold').fontSize(14).text(data.partner.name, 40, doc.y)
  if (data.partner.tax_name && data.partner.tax_name !== data.partner.name) {
    doc.font('Helvetica').fontSize(10).fillColor('#606060').text(data.partner.tax_name, 40, doc.y)
  }
  if (data.partner.rfc) {
    doc.font('Helvetica').fontSize(10).fillColor('#606060').text(`RFC: ${data.partner.rfc}`, 40, doc.y)
  }
  doc.moveDown(1)
  doc.fillColor('#1F2937')
}

function drawPartnerSummary(doc, data, labels) {
  const s = data.summary
  const cards = [
    { label: 'Pendiente total', value: fmtMXN(s.total_pending_amount), sub: `${fmtNum(s.total_pending_count)} docs` },
    { label: 'Vencido',         value: fmtMXN(s.overdue.amount),  sub: `${fmtNum(s.overdue.count)} docs`,  accent: COLOR.overdue },
    { label: 'Próx. vencer',    value: fmtMXN(s.due_soon.amount), sub: `${fmtNum(s.due_soon.count)} docs`, accent: COLOR.due_soon },
    { label: 'Al corriente',    value: fmtMXN(s.current.amount),  sub: `${fmtNum(s.current.count)} docs`, accent: COLOR.current },
  ]
  drawKpiGrid(doc, cards)
  doc.moveDown(1)
}

function drawPartnerDocuments(doc, data, t, labels) {
  doc.fillColor(t.primary).font('Helvetica-Bold').fontSize(9)
     .text('DETALLE DE DOCUMENTOS PENDIENTES', 40, doc.y, { characterSpacing: 2 })
  doc.moveDown(0.5)

  if (data.documents.length === 0) {
    doc.fillColor('#166534').font('Helvetica').fontSize(11)
       .text('✓ Sin documentos pendientes. Gracias por su pago oportuno.', 40, doc.y)
    doc.moveDown(1)
    return
  }

  // Headers
  let y = doc.y
  doc.fillColor('#606060').font('Helvetica-Bold').fontSize(8)
  doc.text('DOCUMENTO',  40,  y, { width: 100 })
  doc.text('EMISIÓN',    150, y, { width: 60 })
  doc.text('VENCE',      215, y, { width: 60 })
  doc.text('ESTADO',     275, y, { width: 80 })
  doc.text('TOTAL',      360, y, { width: 70, align: 'right' })
  doc.text('PAGADO',     435, y, { width: 70, align: 'right' })
  doc.text('PENDIENTE',  510, y, { width: 60, align: 'right' })
  doc.moveTo(40, y + 14).lineTo(570, y + 14).strokeColor('#E5E7EB').stroke()
  doc.y = y + 20

  for (const d of data.documents) {
    if (doc.y > doc.page.height - 80) {
      doc.addPage()
      drawInternalHeader(doc, t, `${capitalize(labels.partnerNoun)}: ${data.partner.name}`)
    }
    const ry = doc.y
    const bg = COLOR[d.aging_status + 'Bg']
    if (bg) doc.rect(38, ry - 2, 534, 22).fill(bg)
    doc.fillColor('#1F2937').font('Helvetica-Bold').fontSize(9).text(d.document_number, 40, ry + 2, { width: 100 })
    doc.font('Helvetica').fontSize(9).fillColor('#374151')
    doc.text(fmtDate(d.issue_date), 150, ry + 2, { width: 60 })
    doc.fillColor(d.aging_status === 'overdue' ? COLOR.overdue : '#374151')
    doc.text(fmtDate(d.due_date),   215, ry + 2, { width: 60 })
    doc.fillColor(COLOR[d.aging_status] || '#374151').font('Helvetica-Bold').fontSize(8)
    let statusText = STATUS_LABEL[d.aging_status] || ''
    if (d.days_overdue != null && d.days_overdue > 0) statusText += ` (${d.days_overdue}d)`
    doc.text(statusText, 275, ry + 4, { width: 80 })
    doc.fillColor('#374151').font('Helvetica').fontSize(9)
    doc.text(fmtMXN(d.amount_total), 360, ry + 2, { width: 70, align: 'right' })
    doc.text(fmtMXN(d.amount_paid),  435, ry + 2, { width: 70, align: 'right' })
    doc.font('Helvetica-Bold').text(fmtMXN(d.amount_pending), 510, ry + 2, { width: 60, align: 'right' })
    doc.y = ry + 22
  }

  // Total
  const ry = doc.y
  doc.fillColor('#1F2937').font('Helvetica-Bold').fontSize(10)
  doc.text('TOTAL', 275, ry + 4, { width: 80 })
  doc.text(fmtMXN(data.documents.reduce((s, d) => s + d.amount_total, 0)),   360, ry + 4, { width: 70, align: 'right' })
  doc.text(fmtMXN(data.documents.reduce((s, d) => s + d.amount_paid, 0)),    435, ry + 4, { width: 70, align: 'right' })
  doc.text(fmtMXN(data.summary.total_pending_amount),                         510, ry + 4, { width: 60, align: 'right' })
  doc.y = ry + 24
}

function drawPartnerAdvances(doc, data, t) {
  if (doc.y > doc.page.height - 120) doc.addPage().y = 70
  doc.fillColor(COLOR.current).font('Helvetica-Bold').fontSize(9)
     .text('SALDO A FAVOR — ANTICIPOS', 40, doc.y, { characterSpacing: 2 })
  doc.moveDown(0.5)

  for (const a of data.advances) {
    const ry = doc.y
    doc.fillColor('#1F2937').font('Helvetica').fontSize(9)
       .text(`Anticipo del ${fmtDate(a.receipt_date)}${a.reference ? ` · Ref: ${a.reference}` : ''}`, 40, ry, { width: 400 })
    doc.font('Helvetica-Bold').fillColor(COLOR.current)
       .text(`+ ${fmtMXN(a.amount_available)}`, 440, ry, { width: 130, align: 'right' })
    doc.y = ry + 16
  }
  doc.moveDown(0.5)
}

function drawPartnerCreditNotes(doc, data, t) {
  if (doc.y > doc.page.height - 120) doc.addPage().y = 70
  doc.fillColor(COLOR.current).font('Helvetica-Bold').fontSize(9)
     .text('SALDO A FAVOR — NOTAS DE CRÉDITO', 40, doc.y, { characterSpacing: 2 })
  doc.moveDown(0.5)

  for (const c of data.credit_notes) {
    const ry = doc.y
    doc.fillColor('#1F2937').font('Helvetica').fontSize(9)
       .text(`${c.document_number} · ${fmtDate(c.issue_date)} · ${c.reason || ''}`, 40, ry, { width: 400 })
    doc.font('Helvetica-Bold').fillColor(COLOR.current)
       .text(`+ ${fmtMXN(c.total)}`, 440, ry, { width: 130, align: 'right' })
    doc.y = ry + 16
  }
  doc.moveDown(0.5)
}

function drawPartnerNetBalance(doc, data, labels) {
  if (doc.y > doc.page.height - 80) doc.addPage().y = 70
  const s = data.summary

  // Caja con saldo neto
  const W = doc.page.width
  const y = doc.y + 8
  doc.rect(40, y, W - 80, 60).fillAndStroke('#F9FAFB', '#E5E7EB')

  doc.fillColor('#606060').font('Helvetica').fontSize(9)
     .text('SALDO NETO POR ' + labels.verb.toUpperCase(), 60, y + 10, { characterSpacing: 1 })
  doc.fillColor(s.net_balance > 0 ? COLOR.overdue : COLOR.current).font('Helvetica-Bold').fontSize(28)
     .text(fmtMXNf(s.net_balance), 60, y + 25, { width: W - 120, align: 'right' })

  if (s.advances_available.amount + s.credit_notes_available.amount > 0) {
    doc.fillColor('#606060').font('Helvetica').fontSize(8)
       .text(
         `Pendiente ${fmtMXN(s.total_pending_amount)} − Anticipos ${fmtMXN(s.advances_available.amount)}` +
         (data.direction === 'in' ? ` − NCs ${fmtMXN(s.credit_notes_available.amount)}` : ''),
         60, y + 50, { width: W - 120, align: 'right' }
       )
  }
  doc.y = y + 75
}

function drawPartnerFooter(doc, t, data, labels) {
  if (doc.y > doc.page.height - 100) doc.addPage().y = 70
  doc.fillColor('#606060').font('Helvetica').fontSize(9)
     .text(
       `Estado de cuenta generado al ${data.snapshot_date}. ` +
       `Próximo a vencer = dentro de ${data.due_soon_days} días naturales. ` +
       `Cualquier discrepancia, favor de comunicarse para conciliación.`,
       40, doc.y, { width: doc.page.width - 80 }
     )
  doc.moveDown(0.5)
  doc.fillColor('#9CA3AF').font('Helvetica').fontSize(8)
     .text(`${t.name} · ${new Date().toLocaleString('es-MX')}`, 40, doc.page.height - 44,
       { width: doc.page.width - 80, align: 'center' })
}

// ─────────────────────────────────────────────────────────────────────────────
// Componentes compartidos
// ─────────────────────────────────────────────────────────────────────────────

function drawCover(doc, t, title, snapshotDate) {
  const W = doc.page.width, H = doc.page.height
  doc.rect(0, 0, W, 140).fill(t.primary)
  if (t.logoBuffer) {
    try { doc.image(t.logoBuffer, 40, 30, { fit: [120, 80] }) } catch (_) {}
  }
  doc.fillColor('white').font('Helvetica-Bold').fontSize(28).text(title, 180, 50)
  doc.font('Helvetica').fontSize(14).text(t.name.toUpperCase(), 180, 88)

  doc.fillColor('#1F2937').font('Helvetica').fontSize(11).text('SNAPSHOT AL', 40, 200)
  doc.font('Helvetica-Bold').fontSize(20).fillColor(t.primary).text(snapshotDate, 40, 218)
  doc.rect(40, 270, W - 80, 4).fill(t.secondary)

  doc.fillColor('#606060').font('Helvetica').fontSize(9)
     .text(`Generado el ${new Date().toLocaleString('es-MX')}`, 40, H - 80)
  doc.fillColor('#9CA3AF').font('Helvetica').fontSize(8)
     .text('Documento confidencial · Solo para socios y administración', 40, H - 65)
}

function drawInternalHeader(doc, t, subtitle) {
  const W = doc.page.width
  doc.rect(0, 0, W, 50).fill(t.primary)
  if (t.logoBuffer) {
    try { doc.image(t.logoBuffer, 30, 8, { fit: [50, 34] }) } catch (_) {}
  }
  doc.fillColor('white').font('Helvetica-Bold').fontSize(11).text(t.name.toUpperCase(), 90, 18)
  doc.font('Helvetica').fontSize(8).text(subtitle, 90, 32, { width: W - 130, ellipsis: true })
  doc.fillColor('#1F2937')
  doc.y = 70
}

function drawKpiGrid(doc, cards) {
  const startX = 40, y = doc.y
  const totalW = doc.page.width - 80
  const gap = 12
  const cardW = (totalW - gap * (cards.length - 1)) / cards.length
  const cardH = 75
  cards.forEach((c, i) => {
    const x = startX + i * (cardW + gap)
    doc.roundedRect(x, y, cardW, cardH, 6).fillAndStroke('#F9FAFB', '#E5E7EB')
    doc.fillColor('#606060').font('Helvetica').fontSize(8)
       .text(c.label.toUpperCase(), x + 12, y + 10, { characterSpacing: 1 })
    doc.fillColor(c.accent || '#1F2937').font('Helvetica-Bold').fontSize(16)
       .text(c.value, x + 12, y + 28, { width: cardW - 24 })
    if (c.sub) {
      doc.fillColor('#9CA3AF').font('Helvetica').fontSize(7)
         .text(c.sub, x + 12, y + 56, { width: cardW - 24 })
    }
  })
  doc.y = y + cardH + 4
}

function drawFooter(doc, tenantName) {
  const pages = doc.bufferedPageRange()
  for (let i = pages.start; i < pages.start + pages.count; i++) {
    doc.switchToPage(i)
    const W = doc.page.width, H = doc.page.height
    doc.fillColor('#9CA3AF').font('Helvetica').fontSize(8)
       .text(`${tenantName}  ·  ${new Date().toLocaleString('es-MX')}`, 40, H - 44, { width: W / 2 - 40 })
    doc.text(`Página ${i + 1} de ${pages.count}`, W / 2, H - 44, { width: W / 2 - 40, align: 'right' })
  }
}

function capitalize(s) { return s ? s[0].toUpperCase() + s.slice(1) : '' }

module.exports = { generateAccountStatementPdf }
