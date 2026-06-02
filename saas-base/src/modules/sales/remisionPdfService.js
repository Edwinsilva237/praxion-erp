'use strict'

const fs          = require('fs')
const path        = require('path')
const PDFDocument = require('pdfkit')
const { query }   = require('../../db')
const config      = require('../../config')
const { addPraxionFooterPDF } = require('../../utils/praxionWitnessMark')
const { loadTenantLogo, headerTextX, drawHeaderLogo } = require('../../utils/pdfBranding')

/**
 * Genera el PDF de una remisión (representación impresa, NO fiscal).
 * Mantiene el mismo look-and-feel que el PDF de factura para consistencia visual.
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
            t.name AS tenant_name,
            t.brand_color_primary, t.brand_color_secondary, t.logo_storage_path
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

  const logoBuffer = await loadTenantLogo(note.logo_storage_path)

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 40, size: 'LETTER' })
    const buffers = []
    doc.on('data', chunk => buffers.push(chunk))
    doc.on('end', () => resolve(Buffer.concat(buffers)))
    doc.on('error', reject)

    const W = doc.page.width - 80
    const gris     = '#F5F5F5'
    const azul     = note.brand_color_primary   || '#5E9F32'
    const acento   = note.brand_color_secondary || azul
    const negro    = '#222222'
    const grisText = '#666666'

    // ─── ENCABEZADO ────────────────────────────────────────────────
    const htx = headerTextX(!!logoBuffer)
    doc.rect(40, 40, W, 70).fill(azul)
    drawHeaderLogo(doc, logoBuffer)
    doc.fillColor('white').fontSize(18).font('Helvetica-Bold')
       .text(note.emisor_nombre || note.tenant_name || 'EMISOR', htx, 52, { width: W * 0.6 - (htx - 55) })

    doc.fontSize(9).font('Helvetica')
    if (note.emisor_rfc) {
      doc.text(`RFC: ${note.emisor_rfc}`, htx, 74)
         .text(`Régimen: ${note.emisor_regime || '-'}  |  CP: ${note.emisor_zip || '-'}`, htx, 86)
    }

    doc.fontSize(20).font('Helvetica-Bold')
       .text('REMISIÓN', 55 + W * 0.6, 50, { width: W * 0.4 - 15, align: 'right' })
    doc.fontSize(12).font('Helvetica-Bold')
       .text(note.document_number, 55 + W * 0.6, 74, { width: W * 0.4 - 15, align: 'right' })
    doc.fontSize(8).font('Helvetica')
       .text(showPrices ? 'Documento no fiscal' : 'Documento no fiscal · sin precios',
             55 + W * 0.6, 92, { width: W * 0.4 - 15, align: 'right' })

    // ─── DATOS GENERALES ───────────────────────────────────────────
    let y = 125
    doc.fillColor(negro).fontSize(9).font('Helvetica-Bold')
       .text('DATOS DE LA REMISIÓN', 40, y)

    y += 14
    doc.rect(40, y, W, 38).fill(gris)

    const col1 = 50, col2 = 220, col3 = 380, col4 = 500
    doc.fillColor(grisText).fontSize(8).font('Helvetica')
    doc.text('Fecha emisión:', col1, y + 5)
    doc.text('Pedido:',        col2, y + 5)
    doc.text('OC del cliente:', col3, y + 5)
    doc.text('Moneda:',        col4, y + 5)

    doc.fillColor(negro).font('Helvetica-Bold')
    const fechaStr = note.issue_date
      ? new Date(note.issue_date).toLocaleDateString('es-MX', { year: 'numeric', month: '2-digit', day: '2-digit' })
      : '-'
    doc.text(fechaStr, col1, y + 17)
    doc.text(note.order_number || '-', col2, y + 17)
    doc.text(note.sales_order_po || '-', col3, y + 17)
    doc.text(note.currency, col4, y + 17)

    // ─── CLIENTE / DESTINO ─────────────────────────────────────────
    y += 50
    const halfW = (W - 10) / 2

    doc.rect(40, y, halfW, 14).fill(azul)
    doc.fillColor('white').fontSize(8).font('Helvetica-Bold')
       .text('CLIENTE', 45, y + 3)

    doc.rect(40, y + 14, halfW, 52).fill(gris)
    doc.fillColor(negro).fontSize(8).font('Helvetica-Bold')
       .text(note.partner_tax_name || note.partner_name || '', 45, y + 18, { width: halfW - 10 })
    doc.font('Helvetica').fillColor(grisText)
       .text(`RFC: ${note.partner_rfc || '-'}`, 45, y + 30)
       .text(`${note.partner_city || ''} ${note.partner_state ? `, ${note.partner_state}` : ''} ${note.partner_zip || ''}`.trim() || '-',
             45, y + 41, { width: halfW - 10 })

    const rx = 40 + halfW + 10
    doc.rect(rx, y, halfW, 14).fill(azul)
    doc.fillColor('white').fontSize(8).font('Helvetica-Bold')
       .text('ENTREGA EN', rx + 5, y + 3)

    doc.rect(rx, y + 14, halfW, 52).fill(gris)
    doc.fillColor(negro).fontSize(8).font('Helvetica-Bold')
       .text(note.address_alias || 'Domicilio principal', rx + 5, y + 18, { width: halfW - 10 })
    doc.font('Helvetica').fillColor(grisText)
       .text(note.delivery_address || note.partner_address || '-', rx + 5, y + 30, { width: halfW - 10 })
       .text(`${note.delivery_city || note.partner_city || ''} ${note.delivery_state || note.partner_state ? `, ${note.delivery_state || note.partner_state}` : ''} ${note.delivery_zip || note.partner_zip || ''}`.trim() || '',
             rx + 5, y + 52, { width: halfW - 10 })

    // ─── CONCEPTOS ─────────────────────────────────────────────────
    y += 82
    doc.fillColor(negro).fontSize(9).font('Helvetica-Bold')
       .text('CONCEPTOS', 40, y)

    y += 14
    doc.rect(40, y, W, 16).fill(azul)
    doc.fillColor('white').fontSize(7.5).font('Helvetica-Bold')
    // Anchos de columna. Deben sumar <= 522 (de cx=45 al borde de la tabla en
    // x≈567) para que "Importe" NO se salga del margen derecho de la hoja.
    // Sin precios, la descripción absorbe el espacio de P. Unitario / Importe.
    const cw = showPrices
      ? { sku: 58, desc: 216, cant: 48, unit: 46, precio: 70, importe: 84 }
      : { sku: 70, desc: 330, cant: 60, unit: 62 }
    let cx = 45
    doc.text('SKU', cx, y + 4); cx += cw.sku
    doc.text('Descripción', cx, y + 4); cx += cw.desc
    doc.text('Cant.', cx, y + 4, { width: cw.cant, align: 'right' }); cx += cw.cant
    doc.text('Unidad', cx, y + 4); cx += cw.unit
    if (showPrices) {
      doc.text('P. Unitario', cx, y + 4, { width: cw.precio, align: 'right' }); cx += cw.precio
      doc.text('Importe', cx, y + 4, { width: cw.importe, align: 'right' })
    }

    y += 16
    lines.forEach((line, i) => {
      const rowH = 20
      const lineSubtotal = parseFloat(line.quantity_delivered) * parseFloat(line.unit_price) *
                           (1 - (parseFloat(line.discount_pct) || 0) / 100)
      doc.rect(40, y, W, rowH).fill(i % 2 === 0 ? 'white' : gris)
      doc.fillColor(negro).fontSize(7.5).font('Helvetica')
      cx = 45
      doc.text(line.sku || '', cx, y + 6, { width: cw.sku - 5 }); cx += cw.sku
      doc.text(line.product_name || '', cx, y + 6, { width: cw.desc - 5 }); cx += cw.desc
      doc.text(parseFloat(line.quantity_delivered).toFixed(2), cx, y + 6, { width: cw.cant, align: 'right' }); cx += cw.cant
      doc.text(line.unit || '', cx, y + 6, { width: cw.unit }); cx += cw.unit
      if (showPrices) {
        doc.text(fmt(line.unit_price), cx, y + 6, { width: cw.precio, align: 'right' }); cx += cw.precio
        doc.text(fmt(lineSubtotal), cx, y + 6, { width: cw.importe, align: 'right' })
      }
      y += rowH
    })

    // ─── TOTALES ───────────────────────────────────────────────────
    // La remisión NO incluye IVA — es un documento pre-fiscal. El IVA se
    // agrega cuando se emite el CFDI. Se omite por completo en la versión
    // sin precios (remisión de entrega).
    if (showPrices) {
      y += 10
      const tw = 200
      const tx = 40 + W - tw

      // Usamos subtotal como total (tax = 0 después de la migración 094).
      const totalRem = parseFloat(note.subtotal_mxn || note.total_mxn || 0)

      doc.rect(tx - 5, y, tw + 5, 22).fill(azul)
      doc.fillColor('white').fontSize(11).font('Helvetica-Bold')
         .text('TOTAL', tx, y + 6, { width: tw * 0.5 })
         .text(`${note.currency} ${fmt(totalRem)}`, tx + tw * 0.5, y + 6, { width: tw * 0.5 - 5, align: 'right' })
      y += 26

      // Leyenda IVA al facturar
      doc.fillColor(grisText).fontSize(7.5).font('Helvetica-Oblique')
         .text('* El IVA (16%) se calcula automáticamente al emitir la factura (CFDI).',
                40, y, { width: W - 10, align: 'left' })
      y += 4
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
      extras.push(['TC aplicado:', tcText])
    }
    if (note.credit_due_date) {
      const d = new Date(note.credit_due_date).toLocaleDateString('es-MX', { day: '2-digit', month: 'short', year: 'numeric' })
      extras.push(['Vence el:', d])
    }
    if (note.notes) extras.push(['Notas:', note.notes])

    if (extras.length > 0) {
      y += 30
      const headerH = 14
      doc.rect(40, y, W, headerH).fill(azul)
      doc.fillColor('white').fontSize(8).font('Helvetica-Bold')
         .text('DATOS ADICIONALES', 45, y + 3)
      y += headerH
      const bodyH = extras.length * 14 + 6
      doc.rect(40, y, W, bodyH).fill(gris)
      let exY = y + 4
      extras.forEach(([label, value]) => {
        doc.fillColor(grisText).fontSize(8).font('Helvetica-Bold').text(label, 50, exY, { width: 110 })
        doc.fillColor(negro).font('Helvetica').text(value, 160, exY, { width: W - 125 })
        exY += 14
      })
      y += bodyH
    }

    // ─── EVIDENCIA DE ENTREGA ──────────────────────────────────────
    if (note.status === 'delivered' || note.status === 'invoiced') {
      y += 20
      // Si no cabe el bloque, salto de página
      if (y > 600) { doc.addPage(); y = 40 }

      doc.rect(40, y, W, 14).fill(azul)
      doc.fillColor('white').fontSize(8).font('Helvetica-Bold')
         .text('EVIDENCIA DE ENTREGA', 45, y + 3)
      y += 14

      const evidenceH = photoFullPath ? 180 : 60
      doc.rect(40, y, W, evidenceH).fill(gris)

      doc.fillColor(grisText).fontSize(8).font('Helvetica').text('Recibido por:', 50, y + 8)
      doc.fillColor(negro).fontSize(10).font('Helvetica-Bold')
         .text(note.receiver_name || '-', 50, y + 20)

      if (note.delivered_at) {
        const dlv = new Date(note.delivered_at)
        const dlvStr = dlv.toLocaleString('es-MX', {
          day: '2-digit', month: '2-digit', year: 'numeric',
          hour: '2-digit', minute: '2-digit',
        })
        doc.fillColor(grisText).font('Helvetica').fontSize(8).text(`Fecha: ${dlvStr}`, 50, y + 38)
      }

      if (photoFullPath) {
        try {
          // Foto a la derecha del bloque
          doc.image(photoFullPath, 280, y + 8, {
            fit: [W - 250, evidenceH - 16],
            align: 'right',
            valign: 'top',
          })
        } catch {
          doc.fillColor(grisText).fontSize(7).text('(No se pudo incluir la foto)', 280, y + 10)
        }
      }
      y += evidenceH
    }

    // ─── PIE ───────────────────────────────────────────────────────
    y += 20
    if (y > 720) { doc.addPage(); y = 40 }
    doc.fillColor(grisText).fontSize(7).font('Helvetica')
       .text('Este documento es una remisión no fiscal. Para efectos fiscales se emite el CFDI correspondiente.',
             40, y, { width: W, align: 'center' })

    if (note.status === 'cancelled') {
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

function createError(status, message) {
  const err = new Error(message)
  err.status = status
  return err
}

module.exports = { generateRemisionPDF }
