'use strict'

const PDFDocument = require('pdfkit')
const { query }   = require('../../db')
const storage     = require('../../utils/storage')
const { addPraxionFooterPDF } = require('../../utils/praxionWitnessMark')
const { loadTenantLogo, headerTextX, drawHeaderLogo, asPdfImage } = require('../../utils/pdfBranding')

/**
 * PDF del vale de salida (consumo interno) — formato BÁSICO imprimible, estilo
 * remisión simple: artículo + cantidad, SIN costos (el valor vive solo en BD).
 * Bloque de firmas Entregó / Recibió; si el receptor firmó en pantalla, la
 * firma se incrusta sobre su línea.
 */
async function generateConsumptionVoucherPDF({ tenantId, voucherId }) {
  const { rows: vrows } = await query(
    `SELECT cv.*, w.name AS warehouse_name, a.name AS area_name,
            u.full_name AS created_by_name,
            t.name AS tenant_name, t.brand_color_primary, t.logo_storage_path
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
    `SELECT m.quantity, m.unit, m.unit_cost, m.notes,
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

  const logoBuffer = await loadTenantLogo(v.logo_storage_path)

  // Firma en pantalla del receptor (opcional) — se incrusta sobre su línea.
  let signatureImg = null
  if (v.receiver_signature_path) {
    try {
      const buf = await storage.fetchBuffer(v.receiver_signature_path)
      signatureImg = asPdfImage(buf)   // null si no es PNG/JPEG → se omite
    } catch { /* sin firma legible: queda la línea para firmar en papel */ }
  }

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 40, size: 'LETTER' })
    const buffers = []
    doc.on('data', chunk => buffers.push(chunk))
    doc.on('end', () => resolve(Buffer.concat(buffers)))
    doc.on('error', reject)

    const W = doc.page.width - 80
    const gris     = '#F5F5F5'
    const azul     = v.brand_color_primary || '#5E9F32'
    const negro    = '#222222'
    const grisText = '#666666'

    // ─── ENCABEZADO ────────────────────────────────────────────────
    const htx = headerTextX(!!logoBuffer)
    doc.rect(40, 40, W, 70).fill(azul)
    drawHeaderLogo(doc, logoBuffer)

    const emisorName  = v.tenant_name || 'EMISOR'
    const emisorNameW = W * 0.6 - (htx - 55)
    let emisorSize = 18
    doc.font('Helvetica-Bold')
    while (emisorSize > 10 && doc.fontSize(emisorSize).widthOfString(emisorName) > emisorNameW) {
      emisorSize -= 0.5
    }
    doc.fillColor('white').fontSize(emisorSize).font('Helvetica-Bold')
       .text(emisorName, htx, 52, { width: emisorNameW, lineBreak: false, ellipsis: true })

    doc.fontSize(18).font('Helvetica-Bold')
       .text('VALE DE SALIDA', 55 + W * 0.6, 50, { width: W * 0.4 - 15, align: 'right' })
    doc.fontSize(12).font('Helvetica-Bold')
       .text(v.voucher_number, 55 + W * 0.6, 74, { width: W * 0.4 - 15, align: 'right' })
    doc.fontSize(8).font('Helvetica')
       .text('Consumo interno — no fiscal', 55 + W * 0.6, 92, { width: W * 0.4 - 15, align: 'right' })

    // ─── DATOS GENERALES ───────────────────────────────────────────
    let y = 125
    doc.fillColor(negro).fontSize(9).font('Helvetica-Bold')
       .text('DATOS DEL VALE', 40, y)

    y += 14
    doc.rect(40, y, W, 38).fill(gris)
    const col1 = 50, col2 = 190, col3 = 360
    doc.fillColor(grisText).fontSize(8).font('Helvetica')
    doc.text('Fecha:',          col1, y + 5)
    doc.text('Almacén origen:', col2, y + 5)
    doc.text('Área destino:',   col3, y + 5)

    doc.fillColor(negro).font('Helvetica-Bold')
    const fechaStr = v.voucher_date
      ? new Date(v.voucher_date).toLocaleDateString('es-MX', { year: 'numeric', month: '2-digit', day: '2-digit' })
      : '-'
    doc.text(fechaStr, col1, y + 17, { width: col2 - col1 - 8 })
    doc.text(v.warehouse_name || '-', col2, y + 17, { width: col3 - col2 - 8 })
    doc.text(v.area_name || '-', col3, y + 17, { width: 40 + W - col3 - 8 })

    // ─── MATERIAL ENTREGADO ────────────────────────────────────────
    y += 52
    doc.fillColor(negro).fontSize(9).font('Helvetica-Bold')
       .text('MATERIAL ENTREGADO', 40, y)

    // Formato básico estilo remisión simple: artículo + cantidad. SIN costos —
    // el valor del consumo vive solo en BD para los reportes.
    y += 14
    const cw = { desc: 380, qty: 142 }
    const drawLinesHeader = () => {
      doc.rect(40, y, W, 16).fill(azul)
      doc.fillColor('white').fontSize(7.5).font('Helvetica-Bold')
      let hx = 45
      doc.text('Artículo', hx, y + 4); hx += cw.desc
      doc.text('Cantidad', hx, y + 4, { width: cw.qty, align: 'right' })
      y += 16
    }
    drawLinesHeader()

    const bottomLimit = doc.page.height - 70
    lines.forEach((line, i) => {
      const qty  = Math.abs(parseFloat(line.quantity || 0))
      const desc = line.item_sku ? `${line.item_name} (${line.item_sku})` : (line.item_name || '—')

      doc.fontSize(7.5).font('Helvetica')
      const descH = doc.heightOfString(desc, { width: cw.desc - 5 })
      const rowH  = Math.max(20, descH + 10)

      if (y + rowH > bottomLimit) {
        doc.addPage()
        y = 40
        drawLinesHeader()
      }

      doc.rect(40, y, W, rowH).fill(i % 2 === 0 ? 'white' : gris)
      doc.fillColor(negro).fontSize(7.5).font('Helvetica')
      let cx = 45
      doc.text(desc, cx, y + 6, { width: cw.desc - 5 }); cx += cw.desc
      doc.text(`${fmtNum(qty)} ${line.unit || ''}`, cx, y + 6, { width: cw.qty, align: 'right' })
      y += rowH
    })
    y += 10

    // ─── NOTAS ─────────────────────────────────────────────────────
    if (v.notes) {
      doc.rect(40, y, W, 14).fill(azul)
      doc.fillColor('white').fontSize(8).font('Helvetica-Bold').text('NOTAS', 45, y + 3)
      y += 14
      doc.fontSize(8).font('Helvetica')
      const notesH = Math.max(24, doc.heightOfString(v.notes, { width: W - 10 }) + 10)
      doc.rect(40, y, W, notesH).fill(gris)
      doc.fillColor(negro).text(v.notes, 45, y + 5, { width: W - 10 })
      y += notesH + 6
    }

    // ─── FIRMAS ────────────────────────────────────────────────────
    y += 14
    if (y > 560) { doc.addPage(); y = 40 }
    doc.rect(40, y, W, 14).fill(azul)
    doc.fillColor('white').fontSize(8).font('Helvetica-Bold')
       .text('ENTREGA Y RECEPCIÓN', 45, y + 3)
    y += 14
    const blockH = signatureImg ? 120 : 80
    doc.rect(40, y, W, blockH).fill(gris)

    const half = W / 2
    // Entregó (almacenista)
    doc.fillColor(grisText).fontSize(8).font('Helvetica').text('Entregó (almacén):', 50, y + 8)
    doc.fillColor(negro).fontSize(10).font('Helvetica-Bold')
       .text(v.created_by_name || '—', 50, y + 20, { width: half - 30 })
    doc.moveTo(50, y + blockH - 22).lineTo(40 + half - 20, y + blockH - 22)
       .strokeColor('#999999').lineWidth(0.7).stroke()
    doc.fillColor(grisText).fontSize(7).font('Helvetica')
       .text('Firma', 50, y + blockH - 18, { width: half - 30, align: 'center' })

    // Recibió (área) — si firmó en pantalla, la firma va sobre su línea.
    doc.fillColor(grisText).fontSize(8).font('Helvetica')
       .text(`Recibió (${v.area_name || 'área'}):`, 50 + half, y + 8)
    doc.fillColor(negro).fontSize(10).font('Helvetica-Bold')
       .text(v.received_by || '—', 50 + half, y + 20, { width: half - 30 })
    if (signatureImg) {
      try {
        doc.image(signatureImg, 50 + half, y + 30, {
          fit: [half - 30, blockH - 56], align: 'center', valign: 'bottom',
        })
      } catch { /* firma ilegible: queda la línea en blanco */ }
    }
    doc.moveTo(50 + half, y + blockH - 22).lineTo(30 + W, y + blockH - 22)
       .strokeColor('#999999').lineWidth(0.7).stroke()
    doc.fillColor(grisText).fontSize(7).font('Helvetica')
       .text(signatureImg ? 'Firma capturada en pantalla' : 'Firma',
             50 + half, y + blockH - 18, { width: half - 30, align: 'center' })

    y += blockH

    // ─── PIE ───────────────────────────────────────────────────────
    y += 18
    if (y > 720) { doc.addPage(); y = 40 }
    doc.fillColor(grisText).fontSize(7).font('Helvetica')
       .text('Vale de salida por consumo interno — documento no fiscal de control de almacén.',
             40, y, { width: W, align: 'center' })

    if (v.status === 'cancelled') {
      doc.save()
      doc.rotate(-45, { origin: [doc.page.width / 2, doc.page.height / 2] })
      doc.fillColor('#DDDDDD').fontSize(60).font('Helvetica-Bold').opacity(0.3)
         .text('CANCELADO', 0, doc.page.height / 2 - 30, { width: doc.page.width, align: 'center' })
      doc.restore()
    }

    addPraxionFooterPDF(doc)
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
