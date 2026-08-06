'use strict'

const PDFDocument = require('pdfkit')
const { query }   = require('../../db')
const { addPraxionFooterPDF } = require('../../utils/praxionWitnessMark')
const { loadTenantLogo, headerTextX, drawHeaderLogo } = require('../../utils/pdfBranding')

/**
 * PDF del vale de salida (consumo interno) — documento no fiscal de control,
 * mismo look-and-feel que la recepción de compras. Incluye bloque de firmas
 * (Entregó / Recibió) para imprimir y firmar en piso.
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

    y += 14
    const cw = { desc: 290, qty: 90, costo: 70, importe: 72 }
    const drawLinesHeader = () => {
      doc.rect(40, y, W, 16).fill(azul)
      doc.fillColor('white').fontSize(7.5).font('Helvetica-Bold')
      let hx = 45
      doc.text('Artículo', hx, y + 4); hx += cw.desc
      doc.text('Cantidad', hx, y + 4, { width: cw.qty, align: 'right' }); hx += cw.qty
      doc.text('Costo prom.', hx, y + 4, { width: cw.costo, align: 'right' }); hx += cw.costo
      doc.text('Importe', hx, y + 4, { width: cw.importe, align: 'right' })
      y += 16
    }
    drawLinesHeader()

    const bottomLimit = doc.page.height - 70
    let total = 0
    lines.forEach((line, i) => {
      const qty     = Math.abs(parseFloat(line.quantity || 0))
      const costo   = parseFloat(line.unit_cost || 0)
      const importe = qty * costo
      total += importe
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
      doc.text(`${fmtNum(qty)} ${line.unit || ''}`, cx, y + 6, { width: cw.qty, align: 'right' }); cx += cw.qty
      doc.text(fmt(costo), cx, y + 6, { width: cw.costo, align: 'right' }); cx += cw.costo
      doc.text(fmt(importe), cx, y + 6, { width: cw.importe, align: 'right' })
      y += rowH
    })

    // ─── TOTAL ─────────────────────────────────────────────────────
    y += 10
    const tw = 220
    const tx = 40 + W - tw
    doc.rect(tx - 5, y, tw + 5, 22).fill(azul)
    doc.fillColor('white').fontSize(11).font('Helvetica-Bold')
       .text('VALOR TOTAL', tx, y + 6, { width: tw * 0.55 })
       .text(`MXN ${fmt(total)}`, tx + tw * 0.55, y + 6, { width: tw * 0.45 - 5, align: 'right' })
    y += 28

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
    const blockH = 80
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

    // Recibió (área)
    doc.fillColor(grisText).fontSize(8).font('Helvetica')
       .text(`Recibió (${v.area_name || 'área'}):`, 50 + half, y + 8)
    doc.fillColor(negro).fontSize(10).font('Helvetica-Bold')
       .text(v.received_by || '—', 50 + half, y + 20, { width: half - 30 })
    doc.moveTo(50 + half, y + blockH - 22).lineTo(30 + W, y + blockH - 22)
       .strokeColor('#999999').lineWidth(0.7).stroke()
    doc.fillColor(grisText).fontSize(7).font('Helvetica')
       .text('Firma', 50 + half, y + blockH - 18, { width: half - 30, align: 'center' })

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

const fmt = (n) => parseFloat(n || 0).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const fmtNum = (n) => parseFloat(n || 0).toLocaleString('es-MX', { minimumFractionDigits: 0, maximumFractionDigits: 3 })

function createError(status, message) {
  const err = new Error(message)
  err.status = status
  return err
}

module.exports = { generateConsumptionVoucherPDF }
