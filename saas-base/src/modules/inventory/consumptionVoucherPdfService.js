'use strict'

const PDFDocument = require('pdfkit')
const { query }   = require('../../db')
const storage     = require('../../utils/storage')
const { addPraxionFooterPDF } = require('../../utils/praxionWitnessMark')
const { asPdfImage } = require('../../utils/pdfBranding')

/**
 * PDF del vale de salida (consumo interno) — formato BÁSICO imprimible:
 * media carta (5.5×8.5"), blanco y negro, sin rellenos de color, estilo
 * remisión simple: artículo + cantidad, SIN costos (el valor vive solo en BD).
 *
 * Firmas: en "Entregó" se imprime el nombre del usuario que registró el vale
 * sobre la línea (aunque no haya firma manuscrita, queda la atribución); en
 * "Recibió", si el receptor firmó en pantalla la firma se incrusta sobre su
 * línea.
 */
async function generateConsumptionVoucherPDF({ tenantId, voucherId }) {
  const { rows: vrows } = await query(
    `SELECT cv.*, w.name AS warehouse_name, a.name AS area_name,
            u.full_name AS created_by_name,
            t.name AS tenant_name
       FROM consumption_vouchers cv
       JOIN warehouses w ON w.id = cv.warehouse_id
       JOIN tenant_consumption_areas a ON a.id = cv.area_id
       LEFT JOIN users u ON u.id = cv.created_by
       LEFT JOIN tenants t ON t.id = cv.tenant_id
      WHERE cv.id = $1 AND cv.tenant_id = $2`,
    [voucherId, tenantId]
  )
  if (!vrows.length) throw createError(404, 'Vale no encontrado.')
  const v = vrows[0]

  const { rows: lines } = await query(
    `SELECT m.quantity, m.unit, m.notes,
            COALESCE(rm.name, p.name) AS item_name,
            CASE m.item_type WHEN 'product' THEN p.sku ELSE NULL END AS item_sku
       FROM inventory_movements m
       LEFT JOIN raw_materials rm ON rm.id = m.item_id AND m.item_type = 'raw_material'
       LEFT JOIN products p       ON p.id  = m.item_id AND m.item_type = 'product'
      WHERE m.reference_type = 'consumption_voucher' AND m.reference_id = $1
        AND m.tenant_id = $2
      ORDER BY m.created_at ASC`,
    [voucherId, tenantId]
  )

  // Firma en pantalla del receptor (opcional) — se incrusta sobre su línea.
  let signatureImg = null
  if (v.receiver_signature_path) {
    try {
      const buf = await storage.fetchBuffer(v.receiver_signature_path)
      signatureImg = asPdfImage(buf)   // null si no es PNG/JPEG → se omite
    } catch { /* sin firma legible: queda la línea para firmar en papel */ }
  }

  return new Promise((resolve, reject) => {
    // Media carta (statement): 5.5 × 8.5 pulgadas = 396 × 612 pt, vertical.
    const M = 28
    const doc = new PDFDocument({ margin: M, size: [396, 612] })
    const buffers = []
    doc.on('data', chunk => buffers.push(chunk))
    doc.on('end', () => resolve(Buffer.concat(buffers)))
    doc.on('error', reject)

    const W = doc.page.width - M * 2
    const negro = '#000000'
    const gris  = '#555555'
    const linea = '#999999'

    // ─── ENCABEZADO (solo texto, sin color) ────────────────────────
    let y = M
    doc.fillColor(negro).font('Helvetica-Bold')
    let nameSize = 12
    while (nameSize > 8 && doc.fontSize(nameSize).widthOfString(v.tenant_name || 'EMISOR') > W * 0.55) {
      nameSize -= 0.5
    }
    doc.fontSize(nameSize).text(v.tenant_name || 'EMISOR', M, y + 2, { width: W * 0.55, lineBreak: false, ellipsis: true })

    doc.fontSize(12).text('VALE DE SALIDA', M + W * 0.55, y, { width: W * 0.45, align: 'right' })
    doc.fontSize(10).text(v.voucher_number, M + W * 0.55, y + 15, { width: W * 0.45, align: 'right' })
    doc.fontSize(7).font('Helvetica').fillColor(gris)
       .text('Consumo interno — no fiscal', M + W * 0.55, y + 28, { width: W * 0.45, align: 'right' })

    y += 40
    doc.moveTo(M, y).lineTo(M + W, y).strokeColor(negro).lineWidth(1).stroke()
    y += 8

    // ─── DATOS GENERALES ───────────────────────────────────────────
    const fechaStr = v.voucher_date
      ? new Date(v.voucher_date).toLocaleDateString('es-MX', { year: 'numeric', month: '2-digit', day: '2-digit' })
      : '—'
    const datos = [
      ['Fecha',          fechaStr],
      ['Almacén origen', v.warehouse_name || '—'],
      ['Área destino',   v.area_name || '—'],
    ]
    doc.fontSize(8)
    datos.forEach(([k, val]) => {
      doc.fillColor(gris).font('Helvetica').text(`${k}:`, M, y, { width: 80, lineBreak: false })
      doc.fillColor(negro).font('Helvetica-Bold').text(val, M + 82, y, { width: W - 82 })
      y = Math.max(y + 12, doc.y + 2)
    })
    y += 4

    // ─── MATERIAL ENTREGADO ────────────────────────────────────────
    const cw = { desc: W - 90, qty: 90 }
    const bottomLimit = doc.page.height - 40
    const drawLinesHeader = () => {
      doc.fillColor(negro).fontSize(7.5).font('Helvetica-Bold')
      doc.text('ARTÍCULO', M, y, { lineBreak: false })
      doc.text('CANTIDAD', M + cw.desc, y, { width: cw.qty, align: 'right' })
      y += 11
      doc.moveTo(M, y).lineTo(M + W, y).strokeColor(negro).lineWidth(0.8).stroke()
      y += 4
    }
    drawLinesHeader()

    lines.forEach((line) => {
      const qty  = Math.abs(parseFloat(line.quantity || 0))
      const desc = line.item_sku ? `${line.item_name} (${line.item_sku})` : (line.item_name || '—')

      doc.fontSize(7.5).font('Helvetica')
      const descH = doc.heightOfString(desc, { width: cw.desc - 8 })
      const rowH  = descH + 7

      if (y + rowH > bottomLimit) {
        doc.addPage()
        y = M
        drawLinesHeader()
      }

      doc.fillColor(negro).fontSize(7.5).font('Helvetica')
      doc.text(desc, M, y, { width: cw.desc - 8 })
      doc.text(`${fmtNum(qty)} ${line.unit || ''}`, M + cw.desc, y, { width: cw.qty, align: 'right' })
      y += rowH
      doc.moveTo(M, y - 3).lineTo(M + W, y - 3).strokeColor('#DDDDDD').lineWidth(0.4).stroke()
    })
    y += 8

    // ─── NOTAS ─────────────────────────────────────────────────────
    if (v.notes) {
      if (y + 30 > bottomLimit) { doc.addPage(); y = M }
      doc.fillColor(gris).fontSize(7.5).font('Helvetica-Bold').text('NOTAS', M, y)
      y += 10
      doc.fillColor(negro).font('Helvetica')
      doc.text(v.notes, M, y, { width: W })
      y = doc.y + 8
    }

    // ─── FIRMAS ────────────────────────────────────────────────────
    // Bloque de dos columnas al estilo remisión: en "Entregó" va impreso el
    // nombre del usuario que registró el vale (atribución aunque no firme);
    // en "Recibió" la firma en pantalla (si existe) sobre su línea.
    const blockH = signatureImg ? 92 : 64
    if (y + blockH + 20 > bottomLimit) { doc.addPage(); y = M }
    y += 10

    const half = W / 2
    const lineY = y + blockH - 22

    // Recibió (área) — columna izquierda, como "Recibí conforme" del ejemplo.
    doc.fillColor(gris).fontSize(7.5).font('Helvetica')
       .text(`Recibió (${v.area_name || 'área'})`, M, y, { width: half - 20 })
    if (signatureImg) {
      try {
        doc.image(signatureImg, M, y + 10, {
          fit: [half - 30, lineY - y - 14], align: 'center', valign: 'bottom',
        })
      } catch { /* firma ilegible: queda la línea en blanco */ }
    }
    doc.fillColor(negro).fontSize(9).font('Helvetica-Bold')
       .text(v.received_by || '', M, lineY - 12, { width: half - 30, align: 'center', lineBreak: false })
    doc.moveTo(M, lineY).lineTo(M + half - 20, lineY).strokeColor(linea).lineWidth(0.7).stroke()
    doc.fillColor(gris).fontSize(6.5).font('Helvetica')
       .text(signatureImg ? 'Nombre y firma (capturada en pantalla)' : 'Nombre y firma',
             M, lineY + 4, { width: half - 20, align: 'center' })

    // Entregó (almacén) — columna derecha: nombre del usuario sobre la línea.
    doc.fillColor(gris).fontSize(7.5).font('Helvetica')
       .text('Entregó (almacén)', M + half, y, { width: half - 20 })
    doc.fillColor(negro).fontSize(9).font('Helvetica-Bold')
       .text(v.created_by_name || '', M + half, lineY - 12, { width: half - 20, align: 'center', lineBreak: false })
    doc.moveTo(M + half, lineY).lineTo(M + W, lineY).strokeColor(linea).lineWidth(0.7).stroke()
    doc.fillColor(gris).fontSize(6.5).font('Helvetica')
       .text(v.created_by_name ? 'Nombre y firma — registró el vale en el sistema' : 'Nombre y firma',
             M + half, lineY + 4, { width: half - 20, align: 'center' })

    y += blockH

    // ─── PIE ───────────────────────────────────────────────────────
    y += 10
    if (y > doc.page.height - 50) { doc.addPage(); y = M }
    doc.fillColor(gris).fontSize(6.5).font('Helvetica')
       .text('Vale de salida por consumo interno — documento no fiscal de control de almacén.',
             M, y, { width: W, align: 'center' })

    if (v.status === 'cancelled') {
      doc.save()
      doc.rotate(-45, { origin: [doc.page.width / 2, doc.page.height / 2] })
      doc.fillColor('#BBBBBB').fontSize(44).font('Helvetica-Bold').opacity(0.3)
         .text('CANCELADO', 0, doc.page.height / 2 - 22, { width: doc.page.width, align: 'center' })
      doc.restore()
    }

    addPraxionFooterPDF(doc, { bottomOffset: 18 })
    doc.end()
  })
}

const fmtNum = (n) => parseFloat(n || 0).toLocaleString('es-MX', { minimumFractionDigits: 0, maximumFractionDigits: 3 })

function createError(status, message) {
  const err = new Error(message)
  err.status = status
  return err
}

module.exports = { generateConsumptionVoucherPDF }
