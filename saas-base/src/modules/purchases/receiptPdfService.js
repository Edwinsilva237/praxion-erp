'use strict'

const PDFDocument = require('pdfkit')
const { query }   = require('../../db')
const storage     = require('../../utils/storage')
const { addPraxionFooterPDF } = require('../../utils/praxionWitnessMark')
const { loadTenantLogo, headerTextX, drawHeaderLogo, asPdfImage } = require('../../utils/pdfBranding')

/**
 * Genera el PDF de una recepción de material (representación impresa, NO fiscal),
 * con el branding del tenant (logo + colores), igual look-and-feel que la remisión
 * de ventas. Incluye al pie la evidencia de entrega cuando es una imagen — útil
 * sobre todo para la "firma de entrega" de recepciones sin documento (paquetería).
 *
 * La evidencia se descarga de storage (R2 o disco) vía fetchBuffer → funciona en
 * producción (R2), a diferencia de leer del filesystem local.
 */
async function generateReceiptPDF({ tenantId, receiptId }) {
  const { rows: rrows } = await query(
    `SELECT sr.*,
            po.order_number AS purchase_order_number,
            bp.name AS partner_name, bp.rfc AS partner_rfc,
            w.name  AS warehouse_name,
            u.full_name  AS created_by_name,
            cb.full_name AS confirmed_by_name,
            COALESCE(fp.rfc, tfi.rfc) AS emisor_rfc, COALESCE(fp.tax_name, tfi.razon_social) AS emisor_nombre,
            COALESCE(fp.tax_regime, tfi.tax_regime) AS emisor_regime, COALESCE(fp.zip_code, tfi.zip_code) AS emisor_zip,
            t.name AS tenant_name,
            t.brand_color_primary, t.brand_color_secondary, t.logo_storage_path
     FROM supplier_receipts sr
     LEFT JOIN purchase_orders   po  ON po.id  = sr.purchase_order_id
     LEFT JOIN business_partners bp  ON bp.id  = sr.partner_id
     LEFT JOIN warehouses        w   ON w.id   = sr.warehouse_id
     LEFT JOIN users             u   ON u.id   = sr.created_by
     LEFT JOIN users             cb  ON cb.id  = sr.confirmed_by
     -- Emisor: datos reales en tenant_fiscal_profiles; tenant_fiscal_info es legacy/seed.
     LEFT JOIN tenant_fiscal_info tfi ON tfi.tenant_id = sr.tenant_id
     LEFT JOIN LATERAL (
       SELECT rfc, tax_name, tax_regime, zip_code
         FROM tenant_fiscal_profiles
        WHERE tenant_id = sr.tenant_id
        ORDER BY is_active DESC, created_at ASC
        LIMIT 1
     ) fp ON true
     LEFT JOIN tenants            t   ON t.id  = sr.tenant_id
     WHERE sr.id = $1 AND sr.tenant_id = $2`,
    [receiptId, tenantId]
  )
  if (!rrows.length) throw createError(404, 'Recepción no encontrada.')
  const rec = rrows[0]

  const { rows: lines } = await query(
    `SELECT srl.*,
            COALESCE(rm.name, pt.name)       AS item_name,
            COALESCE(rm.unit, pt.sale_unit)  AS item_unit,
            pol.quantity AS ordered_qty
     FROM supplier_receipt_lines srl
     LEFT JOIN purchase_order_lines pol ON pol.id = srl.purchase_order_line_id
     LEFT JOIN raw_materials rm ON rm.id = srl.item_id AND srl.item_type = 'raw_material'
     LEFT JOIN products      pt ON pt.id = srl.item_id AND srl.item_type = 'product'
     WHERE srl.supplier_receipt_id = $1
     ORDER BY srl.line_number`,
    [receiptId]
  )

  // Evidencia: solo incrustamos imágenes (pdfkit dibuja PNG/JPEG). PDFs no.
  let evidenceImg = null
  if (rec.evidence_path && (rec.evidence_mimetype || '').startsWith('image/')) {
    try {
      const buf = await storage.fetchBuffer(rec.evidence_path)
      evidenceImg = asPdfImage(buf) // null si no es PNG/JPEG → se omite
    } catch { /* sin evidencia legible: se omite */ }
  }

  const logoBuffer = await loadTenantLogo(rec.logo_storage_path)

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 40, size: 'LETTER' })
    const buffers = []
    doc.on('data', chunk => buffers.push(chunk))
    doc.on('end', () => resolve(Buffer.concat(buffers)))
    doc.on('error', reject)

    const W = doc.page.width - 80
    const gris     = '#F5F5F5'
    const azul     = rec.brand_color_primary || '#5E9F32'
    const negro    = '#222222'
    const grisText = '#666666'

    // ─── ENCABEZADO ────────────────────────────────────────────────
    const htx = headerTextX(!!logoBuffer)
    doc.rect(40, 40, W, 70).fill(azul)
    drawHeaderLogo(doc, logoBuffer)

    // Nombre del emisor en UNA línea: si la razón social es larga, encogemos la
    // fuente (18→10) en vez de dejar que envuelva y se encime con el RFC (y=74).
    const emisorName  = rec.emisor_nombre || rec.tenant_name || 'EMISOR'
    const emisorNameW = W * 0.6 - (htx - 55)
    let emisorSize = 18
    doc.font('Helvetica-Bold')
    while (emisorSize > 10 && doc.fontSize(emisorSize).widthOfString(emisorName) > emisorNameW) {
      emisorSize -= 0.5
    }
    doc.fillColor('white').fontSize(emisorSize).font('Helvetica-Bold')
       .text(emisorName, htx, 52, { width: emisorNameW, lineBreak: false, ellipsis: true })

    doc.fontSize(9).font('Helvetica')
    if (rec.emisor_rfc) {
      doc.text(`RFC: ${rec.emisor_rfc}`, htx, 74)
         .text(`Régimen: ${rec.emisor_regime || '-'}  |  CP: ${rec.emisor_zip || '-'}`, htx, 86)
    }

    doc.fontSize(18).font('Helvetica-Bold')
       .text('RECEPCIÓN', 55 + W * 0.6, 50, { width: W * 0.4 - 15, align: 'right' })
    doc.fontSize(12).font('Helvetica-Bold')
       .text(rec.receipt_number, 55 + W * 0.6, 74, { width: W * 0.4 - 15, align: 'right' })
    doc.fontSize(8).font('Helvetica')
       .text('Documento no fiscal', 55 + W * 0.6, 92, { width: W * 0.4 - 15, align: 'right' })

    // ─── DATOS GENERALES ───────────────────────────────────────────
    let y = 125
    doc.fillColor(negro).fontSize(9).font('Helvetica-Bold')
       .text('DATOS DE LA RECEPCIÓN', 40, y)

    y += 14
    doc.rect(40, y, W, 38).fill(gris)
    const col1 = 50, col2 = 220, col3 = 380, col4 = 500
    doc.fillColor(grisText).fontSize(8).font('Helvetica')
    doc.text('Fecha:',          col1, y + 5)
    doc.text('OC referencia:',  col2, y + 5)
    doc.text('Folio proveedor:', col3, y + 5)
    doc.text('Almacén:',        col4, y + 5)

    doc.fillColor(negro).font('Helvetica-Bold')
    const fechaStr = rec.received_date
      ? new Date(rec.received_date).toLocaleDateString('es-MX', { year: 'numeric', month: '2-digit', day: '2-digit' })
      : '-'
    const folioProv = rec.document_type
      ? `${rec.document_type} ${rec.document_number || ''}`.trim()
      : (rec.document_number || '-')
    doc.text(fechaStr, col1, y + 17, { width: col2 - col1 - 8 })
    doc.text(rec.purchase_order_number || '-', col2, y + 17, { width: col3 - col2 - 8 })
    doc.text(folioProv || '-', col3, y + 17, { width: col4 - col3 - 8 })
    doc.text(rec.warehouse_name || '-', col4, y + 17, { width: 40 + W - col4 - 8 })

    // ─── PROVEEDOR ─────────────────────────────────────────────────
    y += 50
    doc.rect(40, y, W, 14).fill(azul)
    doc.fillColor('white').fontSize(8).font('Helvetica-Bold')
       .text('PROVEEDOR', 45, y + 3)
    doc.rect(40, y + 14, W, 30).fill(gris)
    doc.fillColor(negro).fontSize(9).font('Helvetica-Bold')
       .text(rec.partner_name || rec.generic_supplier || '—', 45, y + 19, { width: W - 10 })
    if (rec.partner_rfc) {
      doc.font('Helvetica').fillColor(grisText).fontSize(8)
         .text(`RFC: ${rec.partner_rfc}`, 45, y + 32)
    }

    // ─── CONCEPTOS ─────────────────────────────────────────────────
    y += 60
    doc.fillColor(negro).fontSize(9).font('Helvetica-Bold')
       .text('MATERIAL RECIBIDO', 40, y)

    y += 14
    const cw = { desc: 232, oc: 78, rec: 78, precio: 66, importe: 68 }
    let cx = 45
    // Cabecera de la tabla — extraída para poder repetirla al saltar de página.
    const drawLinesHeader = () => {
      doc.rect(40, y, W, 16).fill(azul)
      doc.fillColor('white').fontSize(7.5).font('Helvetica-Bold')
      let hx = 45
      doc.text('Artículo', hx, y + 4); hx += cw.desc
      doc.text('OC pend.', hx, y + 4, { width: cw.oc, align: 'right' }); hx += cw.oc
      doc.text('Recibido', hx, y + 4, { width: cw.rec, align: 'right' }); hx += cw.rec
      doc.text('P. Unit.', hx, y + 4, { width: cw.precio, align: 'right' }); hx += cw.precio
      doc.text('Importe', hx, y + 4, { width: cw.importe, align: 'right' })
      y += 16
    }
    drawLinesHeader()

    const bottomLimit = doc.page.height - 70
    let total = 0
    lines.forEach((line, i) => {
      const recibido = parseFloat(line.quantity_received || 0)
      const precio   = parseFloat(line.unit_price || 0)
      const importe  = recibido * precio
      total += importe
      const unit = line.item_unit || line.unit || ''
      const desc = line.item_name || line.description || '—'

      // Altura de fila dinámica: la descripción envuelve a varias líneas y la
      // fila crece con ella — antes rowH fija (20) hacía que un nombre largo se
      // encimara con la fila de abajo.
      doc.fontSize(7.5).font('Helvetica')
      const descH = doc.heightOfString(desc, { width: cw.desc - 5 })
      const rowH  = Math.max(20, descH + 10)

      // Salto de página: una fila alta puede no caber antes del pie.
      if (y + rowH > bottomLimit) {
        doc.addPage()
        y = 40
        drawLinesHeader()
      }

      doc.rect(40, y, W, rowH).fill(i % 2 === 0 ? 'white' : gris)
      doc.fillColor(negro).fontSize(7.5).font('Helvetica')
      cx = 45
      doc.text(desc, cx, y + 6, { width: cw.desc - 5 }); cx += cw.desc
      doc.text(line.ordered_qty != null ? `${fmtNum(line.ordered_qty)} ${unit}` : '—', cx, y + 6, { width: cw.oc, align: 'right' }); cx += cw.oc
      doc.text(`${fmtNum(recibido)} ${unit}`, cx, y + 6, { width: cw.rec, align: 'right' }); cx += cw.rec
      doc.text(fmt(precio), cx, y + 6, { width: cw.precio, align: 'right' }); cx += cw.precio
      doc.text(fmt(importe), cx, y + 6, { width: cw.importe, align: 'right' })
      y += rowH
    })

    // ─── TOTAL ─────────────────────────────────────────────────────
    y += 10
    const tw = 200
    const tx = 40 + W - tw
    doc.rect(tx - 5, y, tw + 5, 22).fill(azul)
    doc.fillColor('white').fontSize(11).font('Helvetica-Bold')
       .text('TOTAL', tx, y + 6, { width: tw * 0.5 })
       .text(`MXN ${fmt(total)}`, tx + tw * 0.5, y + 6, { width: tw * 0.5 - 5, align: 'right' })
    y += 28

    // ─── NOTAS ─────────────────────────────────────────────────────
    if (rec.notes) {
      doc.rect(40, y, W, 14).fill(azul)
      doc.fillColor('white').fontSize(8).font('Helvetica-Bold').text('NOTAS', 45, y + 3)
      y += 14
      const notesH = 24
      doc.rect(40, y, W, notesH).fill(gris)
      doc.fillColor(negro).fontSize(8).font('Helvetica')
         .text(rec.notes, 45, y + 5, { width: W - 10 })
      y += notesH + 6
    }

    // ─── EVIDENCIA / FIRMA DE ENTREGA ──────────────────────────────
    y += 14
    if (y > 560) { doc.addPage(); y = 40 }
    doc.rect(40, y, W, 14).fill(azul)
    doc.fillColor('white').fontSize(8).font('Helvetica-Bold')
       .text('EVIDENCIA DE ENTREGA', 45, y + 3)
    y += 14

    const blockH = evidenceImg ? 200 : 56
    doc.rect(40, y, W, blockH).fill(gris)
    doc.fillColor(grisText).fontSize(8).font('Helvetica').text('Recibió:', 50, y + 8)
    doc.fillColor(negro).fontSize(10).font('Helvetica-Bold')
       .text(rec.created_by_name || '-', 50, y + 20)
    if (rec.confirmed_by_name) {
      doc.fillColor(grisText).fontSize(8).font('Helvetica').text('Confirmó:', 50, y + 36)
      doc.fillColor(negro).fontSize(10).font('Helvetica-Bold').text(rec.confirmed_by_name, 50, y + 48)
    }
    if (evidenceImg) {
      try {
        doc.image(evidenceImg, 250, y + 8, { fit: [W - 220, blockH - 16], align: 'right', valign: 'top' })
      } catch {
        doc.fillColor(grisText).fontSize(7).text('(No se pudo incluir la evidencia)', 250, y + 10)
      }
    } else if (rec.evidence_path) {
      doc.fillColor(grisText).fontSize(7.5).font('Helvetica-Oblique')
         .text('Evidencia adjunta (documento): consultar en el sistema.', 250, y + 12, { width: W - 220 })
    }
    y += blockH

    // ─── PIE ───────────────────────────────────────────────────────
    y += 18
    if (y > 720) { doc.addPage(); y = 40 }
    doc.fillColor(grisText).fontSize(7).font('Helvetica')
       .text('Comprobante de recepción de material — documento no fiscal de control interno.',
             40, y, { width: W, align: 'center' })

    if (rec.status === 'cancelled') {
      doc.save()
      doc.rotate(-45, { origin: [doc.page.width / 2, doc.page.height / 2] })
      doc.fillColor('#DDDDDD').fontSize(60).font('Helvetica-Bold').opacity(0.3)
         .text('CANCELADA', 0, doc.page.height / 2 - 30, { width: doc.page.width, align: 'center' })
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

module.exports = { generateReceiptPDF }
