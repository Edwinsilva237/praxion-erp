'use strict'

const fs          = require('fs')
const path        = require('path')
const PDFDocument = require('pdfkit')
const { query }   = require('../../db')
const config      = require('../../config')
const { addPraxionFooterPDF } = require('../../utils/praxionWitnessMark')

/**
 * Genera el PDF de una remisión (representación impresa, NO fiscal).
 * Formato simple imprimible: media carta (5.5×8.5"), blanco y negro, sin
 * rellenos de color — mismo estilo que el vale de salida.
 *
 * Incluye al pie la foto de evidencia de entrega cuando existe.
 *
 * @param {boolean} [showPrices=true] - Cuando es false genera una remisión de
 *   entrega "sin precios": oculta las columnas P. Unitario / Importe, el bloque
 *   TOTAL y la leyenda de IVA. Útil para entregar al cliente sin revelar montos.
 */
async function generateRemisionPDF({ tenantId, noteId, showPrices = true }) {
  const { rows: nrows } = await query(
    `SELECT dn.*,
            bp.name AS partner_name, bp.tax_name AS partner_tax_name,
            bp.rfc AS partner_rfc,
            bp.address AS partner_address, bp.city AS partner_city,
            bp.state AS partner_state, bp.zip_code AS partner_zip,
            so.order_number, so.po_number AS sales_order_po,
            da.alias AS address_alias, da.address AS delivery_address,
            da.city AS delivery_city, da.state AS delivery_state,
            da.zip_code AS delivery_zip,
            COALESCE(fp.rfc, tfi.rfc) AS emisor_rfc, COALESCE(fp.tax_name, tfi.razon_social) AS emisor_nombre,
            COALESCE(fp.tax_regime, tfi.tax_regime) AS emisor_regime, COALESCE(fp.zip_code, tfi.zip_code) AS emisor_zip,
            t.name AS tenant_name
     FROM delivery_notes dn
     JOIN business_partners bp ON bp.id = dn.partner_id
     LEFT JOIN sales_orders so      ON so.id = dn.sales_order_id
     LEFT JOIN delivery_addresses da ON da.id = dn.delivery_address_id
     -- Emisor: datos reales en tenant_fiscal_profiles; tenant_fiscal_info es legacy/seed.
     LEFT JOIN tenant_fiscal_info tfi ON tfi.tenant_id = dn.tenant_id
     LEFT JOIN LATERAL (
       SELECT rfc, tax_name, tax_regime, zip_code
         FROM tenant_fiscal_profiles
        WHERE tenant_id = dn.tenant_id
        ORDER BY is_active DESC, created_at ASC
        LIMIT 1
     ) fp ON true
     LEFT JOIN tenants t              ON t.id = dn.tenant_id
     WHERE dn.id = $1 AND dn.tenant_id = $2`,
    [noteId, tenantId]
  )
  if (!nrows.length) throw createError(404, 'Remisión no encontrada.')
  const note = nrows[0]

  const { rows: lines } = await query(
    `SELECT dnl.*, p.sku, p.name AS product_name
     FROM delivery_note_lines dnl
     JOIN products p ON p.id = dnl.product_id
     WHERE dnl.delivery_note_id = $1 ORDER BY dnl.line_number`,
    [noteId]
  )

  // TC efectivo si hay líneas USD revaluadas
  let usdRate = null
  let usdRateDate = null
  if (note.currency === 'USD' && note.exchange_rate_value) {
    usdRate = parseFloat(note.exchange_rate_value)
  } else {
    const usdLine = lines.find(l => l.original_currency === 'USD' && l.applied_exchange_rate)
    if (usdLine) {
      usdRate = parseFloat(usdLine.applied_exchange_rate)
      usdRateDate = usdLine.applied_exchange_rate_date || null
    }
  }

  // Foto de evidencia (si existe en disco)
  let photoFullPath = null
  if (note.receiver_photo_path) {
    const candidate = path.join(config.uploads.dir, note.receiver_photo_path)
    if (fs.existsSync(candidate)) photoFullPath = candidate
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
    const bottomLimit = doc.page.height - 40

    // ─── ENCABEZADO (solo texto, sin color) ────────────────────────
    let y = M
    const emisorName = note.emisor_nombre || note.tenant_name || 'EMISOR'
    doc.fillColor(negro).font('Helvetica-Bold')
    let nameSize = 12
    while (nameSize > 8 && doc.fontSize(nameSize).widthOfString(emisorName) > W * 0.58) {
      nameSize -= 0.5
    }
    doc.fontSize(nameSize).text(emisorName, M, y + 2, { width: W * 0.58, lineBreak: false, ellipsis: true })

    doc.fontSize(11).text('REMISIÓN', M + W * 0.58, y, { width: W * 0.42, align: 'right' })
    doc.fontSize(9).text(note.document_number, M + W * 0.58, y + 14, { width: W * 0.42, align: 'right' })
    doc.fontSize(6.5).font('Helvetica').fillColor(gris)
       .text(showPrices ? 'Documento no fiscal' : 'Documento no fiscal · sin precios',
             M + W * 0.58, y + 26, { width: W * 0.42, align: 'right' })

    if (note.emisor_rfc) {
      doc.fontSize(7).fillColor(gris)
         .text(`RFC: ${note.emisor_rfc}   ·   Régimen: ${note.emisor_regime || '—'}   ·   CP: ${note.emisor_zip || '—'}`,
               M, y + nameSize + 6, { width: W * 0.58 })
    }

    y += 38
    doc.moveTo(M, y).lineTo(M + W, y).strokeColor(negro).lineWidth(1).stroke()
    y += 8

    // ─── DATOS GENERALES (dos columnas de etiqueta:valor) ──────────
    const fechaStr = note.issue_date
      ? new Date(note.issue_date).toLocaleDateString('es-MX', { year: 'numeric', month: '2-digit', day: '2-digit' })
      : '—'
    const half = W / 2
    const datoRow = (k1, v1, k2, v2) => {
      doc.fontSize(7.5)
      doc.fillColor(gris).font('Helvetica').text(`${k1}:`, M, y, { width: 62, lineBreak: false })
      doc.fillColor(negro).font('Helvetica-Bold').text(v1, M + 64, y, { width: half - 68, lineBreak: false, ellipsis: true })
      if (k2) {
        doc.fillColor(gris).font('Helvetica').text(`${k2}:`, M + half, y, { width: 62, lineBreak: false })
        doc.fillColor(negro).font('Helvetica-Bold').text(v2, M + half + 64, y, { width: half - 68, lineBreak: false, ellipsis: true })
      }
      y += 11
    }
    datoRow('Fecha emisión', fechaStr, 'Moneda', note.currency || 'MXN')
    if (note.order_number || note.sales_order_po) {
      datoRow('Pedido', note.order_number || '—', 'OC del cliente', note.sales_order_po || '—')
    }
    y += 4

    // ─── CLIENTE / DESTINO (dos columnas, solo texto) ──────────────
    doc.fillColor(gris).fontSize(7).font('Helvetica-Bold').text('CLIENTE', M, y)
    doc.text('ENTREGA EN', M + half + 5, y)
    y += 9
    const yCliente = y
    doc.fillColor(negro).fontSize(7.5).font('Helvetica-Bold')
       .text(note.partner_tax_name || note.partner_name || '', M, y, { width: half - 10 })
    doc.fillColor(gris).font('Helvetica').fontSize(7)
       .text(`RFC: ${note.partner_rfc || '—'}`, M, doc.y + 1, { width: half - 10 })
    const cityLine = `${note.partner_city || ''}${note.partner_state ? `, ${note.partner_state}` : ''} ${note.partner_zip || ''}`.trim()
    if (cityLine) doc.text(cityLine, M, doc.y + 1, { width: half - 10 })
    const yEndCliente = doc.y

    doc.fillColor(negro).fontSize(7.5).font('Helvetica-Bold')
       .text(note.address_alias || 'Domicilio principal', M + half + 5, yCliente, { width: half - 5 })
    doc.fillColor(gris).font('Helvetica').fontSize(7)
       .text(note.delivery_address || note.partner_address || '—', M + half + 5, doc.y + 1, { width: half - 5 })
    const destCity = `${note.delivery_city || note.partner_city || ''}${(note.delivery_state || note.partner_state) ? `, ${note.delivery_state || note.partner_state}` : ''} ${note.delivery_zip || note.partner_zip || ''}`.trim()
    if (destCity) doc.text(destCity, M + half + 5, doc.y + 1, { width: half - 5 })

    y = Math.max(yEndCliente, doc.y) + 8

    // ─── CONCEPTOS ─────────────────────────────────────────────────
    // Anchos de columna (suman W=340). Sin precios, la descripción absorbe
    // el espacio de P. Unitario / Importe.
    const cw = showPrices
      ? { sku: 42, desc: 117, cant: 34, unit: 33, precio: 52, importe: 62 }
      : { sku: 55, desc: 185, cant: 50, unit: 50 }
    const drawLinesHeader = () => {
      doc.fillColor(negro).fontSize(7).font('Helvetica-Bold')
      let hx = M
      doc.text('SKU', hx, y, { lineBreak: false }); hx += cw.sku
      doc.text('DESCRIPCIÓN', hx, y, { lineBreak: false }); hx += cw.desc
      doc.text('CANT.', hx, y, { width: cw.cant, align: 'right' }); hx += cw.cant
      doc.text('UNIDAD', hx, y + (showPrices ? 0 : 0), { width: cw.unit, align: 'right' }); hx += cw.unit
      if (showPrices) {
        doc.text('P. UNIT.', hx, y, { width: cw.precio, align: 'right' }); hx += cw.precio
        doc.text('IMPORTE', hx, y, { width: cw.importe, align: 'right' })
      }
      y += 10
      doc.moveTo(M, y).lineTo(M + W, y).strokeColor(negro).lineWidth(0.8).stroke()
      y += 4
    }
    drawLinesHeader()

    lines.forEach((line) => {
      const lineSubtotal = parseFloat(line.quantity_delivered) * parseFloat(line.unit_price) *
                           (1 - (parseFloat(line.discount_pct) || 0) / 100)
      doc.fontSize(7).font('Helvetica')
      const descH = doc.heightOfString(line.product_name || '', { width: cw.desc - 6 })
      const skuH  = doc.heightOfString(line.sku || '', { width: cw.sku - 4 })
      const rowH  = Math.max(descH, skuH, 8) + 6

      if (y + rowH > bottomLimit) {
        doc.addPage()
        y = M
        drawLinesHeader()
      }

      doc.fillColor(negro).fontSize(7).font('Helvetica')
      let cx = M
      doc.text(line.sku || '', cx, y, { width: cw.sku - 4 }); cx += cw.sku
      doc.text(line.product_name || '', cx, y, { width: cw.desc - 6 }); cx += cw.desc
      doc.text(parseFloat(line.quantity_delivered).toFixed(2), cx, y, { width: cw.cant, align: 'right' }); cx += cw.cant
      doc.text(line.unit || '', cx, y, { width: cw.unit, align: 'right' }); cx += cw.unit
      if (showPrices) {
        doc.text(fmt(line.unit_price), cx, y, { width: cw.precio, align: 'right' }); cx += cw.precio
        doc.text(fmt(lineSubtotal), cx, y, { width: cw.importe, align: 'right' })
      }
      y += rowH
      doc.moveTo(M, y - 3).lineTo(M + W, y - 3).strokeColor('#DDDDDD').lineWidth(0.4).stroke()
    })

    // ─── TOTALES ───────────────────────────────────────────────────
    // La remisión NO incluye IVA — es un documento pre-fiscal. El IVA se
    // agrega cuando se emite el CFDI. Se omite por completo en la versión
    // sin precios (remisión de entrega).
    if (showPrices) {
      y += 4
      if (y + 30 > bottomLimit) { doc.addPage(); y = M }
      // Usamos subtotal como total (tax = 0 después de la migración 094).
      const totalRem = parseFloat(note.subtotal_mxn || note.total_mxn || 0)
      doc.moveTo(M + W - 160, y).lineTo(M + W, y).strokeColor(negro).lineWidth(0.8).stroke()
      y += 5
      doc.fillColor(negro).fontSize(9.5).font('Helvetica-Bold')
         .text('TOTAL', M + W - 160, y, { width: 70, lineBreak: false })
         .text(`${note.currency} ${fmt(totalRem)}`, M + W - 160 + 60, y, { width: 100, align: 'right' })
      y += 14
      doc.fillColor(gris).fontSize(6.5).font('Helvetica-Oblique')
         .text('* El IVA (16%) se calcula automáticamente al emitir la factura (CFDI).', M, y, { width: W })
      y += 12
    } else {
      y += 8
    }

    // ─── DATOS ADICIONALES ─────────────────────────────────────────
    // El TC solo es relevante si se muestran montos.
    const extras = []
    if (usdRate && showPrices) {
      let tcText = `$${usdRate.toFixed(4)} MXN/USD`
      if (usdRateDate) {
        const d = new Date(usdRateDate).toLocaleDateString('es-MX', { day: '2-digit', month: 'short', year: 'numeric' })
        tcText += ` (${d})`
      }
      extras.push(['TC aplicado', tcText])
    }
    if (note.credit_due_date) {
      const d = new Date(note.credit_due_date).toLocaleDateString('es-MX', { day: '2-digit', month: 'short', year: 'numeric' })
      extras.push(['Vence el', d])
    }
    if (note.notes) extras.push(['Notas', note.notes])

    if (extras.length > 0) {
      if (y + 14 + extras.length * 11 > bottomLimit) { doc.addPage(); y = M }
      doc.fillColor(gris).fontSize(7).font('Helvetica-Bold').text('DATOS ADICIONALES', M, y)
      y += 10
      extras.forEach(([label, value]) => {
        doc.fillColor(gris).fontSize(7).font('Helvetica').text(`${label}:`, M, y, { width: 70, lineBreak: false })
        doc.fillColor(negro).font('Helvetica-Bold').text(value, M + 72, y, { width: W - 72 })
        y = Math.max(y + 11, doc.y + 2)
      })
      y += 4
    }

    // ─── EVIDENCIA DE ENTREGA ──────────────────────────────────────
    if (note.status === 'delivered' || note.status === 'invoiced') {
      const evidenceH = photoFullPath ? 120 : 34
      if (y + evidenceH + 14 > bottomLimit) { doc.addPage(); y = M }
      y += 6
      doc.fillColor(gris).fontSize(7).font('Helvetica-Bold').text('EVIDENCIA DE ENTREGA', M, y)
      y += 10

      doc.fillColor(gris).fontSize(7).font('Helvetica').text('Recibido por:', M, y, { width: 60, lineBreak: false })
      doc.fillColor(negro).fontSize(8.5).font('Helvetica-Bold')
         .text(note.receiver_name || '—', M + 62, y, { width: half - 62 })
      if (note.delivered_at) {
        const dlv = new Date(note.delivered_at)
        const dlvStr = dlv.toLocaleString('es-MX', {
          day: '2-digit', month: '2-digit', year: 'numeric',
          hour: '2-digit', minute: '2-digit',
        })
        doc.fillColor(gris).font('Helvetica').fontSize(7).text(`Fecha: ${dlvStr}`, M, y + 13)
      }

      if (photoFullPath) {
        try {
          // Foto a la derecha del bloque
          doc.image(photoFullPath, M + half + 5, y, {
            fit: [half - 5, evidenceH - 8],
            align: 'right',
            valign: 'top',
          })
        } catch {
          doc.fillColor(gris).fontSize(6.5).text('(No se pudo incluir la foto)', M + half + 5, y)
        }
      }
      y += evidenceH
    }

    // ─── PIE ───────────────────────────────────────────────────────
    y += 12
    if (y > doc.page.height - 50) { doc.addPage(); y = M }
    doc.fillColor(gris).fontSize(6.5).font('Helvetica')
       .text('Este documento es una remisión no fiscal. Para efectos fiscales se emite el CFDI correspondiente.',
             M, y, { width: W, align: 'center' })

    if (note.status === 'cancelled') {
      doc.save()
      doc.rotate(-45, { origin: [doc.page.width / 2, doc.page.height / 2] })
      doc.fillColor('#BBBBBB').fontSize(44).font('Helvetica-Bold').opacity(0.3)
         .text('CANCELADA', 0, doc.page.height / 2 - 22, { width: doc.page.width, align: 'center' })
      doc.restore()
    }

    addPraxionFooterPDF(doc, { bottomOffset: 18 })
    doc.end()
  })
}

const fmt = (n) => parseFloat(n || 0).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

function createError(status, message) {
  const err = new Error(message)
  err.status = status
  return err
}

module.exports = { generateRemisionPDF }
