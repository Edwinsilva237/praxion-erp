'use strict'

const PDFDocument = require('pdfkit')
const { query }   = require('../../db')
const { addPraxionFooterPDF } = require('../../utils/praxionWitnessMark')

/**
 * Genera el PDF de una cotización (representación impresa, NO fiscal).
 * Mantiene el mismo look-and-feel que el PDF de remisión/factura.
 *
 * Diferencias respecto a remisión:
 *   - No hay sección de evidencia de entrega.
 *   - Muestra "Vigencia" (valid_until) y leyenda sobre IVA aplicado al facturar.
 *   - Marca "CANCELADA" / "RECHAZADA" / "EXPIRADA" en watermark cuando aplique.
 */
async function generateQuotationPDF({ tenantId, quotationId }) {
  const { rows: qrows } = await query(
    `SELECT q.*,
            bp.name AS partner_name, bp.tax_name AS partner_tax_name,
            bp.rfc AS partner_rfc,
            bp.address AS partner_address, bp.city AS partner_city,
            bp.state AS partner_state, bp.zip_code AS partner_zip,
            tfi.rfc AS emisor_rfc, tfi.razon_social AS emisor_nombre,
            tfi.tax_regime AS emisor_regime, tfi.zip_code AS emisor_zip,
            t.name AS tenant_name,
            t.brand_color_primary, t.brand_color_secondary,
            so.order_number AS converted_order_number
       FROM quotations q
       JOIN business_partners bp ON bp.id = q.partner_id
       LEFT JOIN sales_orders so ON so.id = q.converted_order_id
       LEFT JOIN tenant_fiscal_info tfi ON tfi.tenant_id = q.tenant_id
       LEFT JOIN tenants t              ON t.id = q.tenant_id
      WHERE q.id = $1 AND q.tenant_id = $2`,
    [quotationId, tenantId]
  )
  if (!qrows.length) throw createError(404, 'Cotización no encontrada.')
  const quot = qrows[0]

  const { rows: lines } = await query(
    `SELECT ql.*, p.sku, p.name AS product_name
       FROM quotation_lines ql
       JOIN products p ON p.id = ql.product_id
      WHERE ql.quotation_id = $1
      ORDER BY ql.line_number`,
    [quotationId]
  )

  const usdRate = quot.currency === 'USD' && quot.exchange_rate_value
    ? parseFloat(quot.exchange_rate_value)
    : null

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 40, size: 'LETTER' })
    const buffers = []
    doc.on('data', chunk => buffers.push(chunk))
    doc.on('end', () => resolve(Buffer.concat(buffers)))
    doc.on('error', reject)

    const W = doc.page.width - 80
    const gris     = '#F5F5F5'
    const azul     = quot.brand_color_primary   || '#1A3A5C'
    const acento   = quot.brand_color_secondary || azul
    const negro    = '#222222'
    const grisText = '#666666'

    // ─── ENCABEZADO ────────────────────────────────────────────────
    doc.rect(40, 40, W, 70).fill(azul)
    doc.fillColor('white').fontSize(18).font('Helvetica-Bold')
       .text(quot.emisor_nombre || quot.tenant_name || 'EMISOR', 55, 52, { width: W * 0.6 })

    doc.fontSize(9).font('Helvetica')
    if (quot.emisor_rfc) {
      doc.text(`RFC: ${quot.emisor_rfc}`, 55, 74)
         .text(`Régimen: ${quot.emisor_regime || '-'}  |  CP: ${quot.emisor_zip || '-'}`, 55, 86)
    }

    doc.fontSize(20).font('Helvetica-Bold')
       .text('COTIZACIÓN', 55 + W * 0.6, 50, { width: W * 0.4 - 15, align: 'right' })
    doc.fontSize(12).font('Helvetica-Bold')
       .text(quot.quotation_number, 55 + W * 0.6, 74, { width: W * 0.4 - 15, align: 'right' })
    doc.fontSize(8).font('Helvetica')
       .text('Documento no fiscal', 55 + W * 0.6, 92, { width: W * 0.4 - 15, align: 'right' })

    // ─── DATOS GENERALES ───────────────────────────────────────────
    let y = 125
    doc.fillColor(negro).fontSize(9).font('Helvetica-Bold')
       .text('DATOS DE LA COTIZACIÓN', 40, y)

    y += 14
    doc.rect(40, y, W, 38).fill(gris)

    const col1 = 50, col2 = 220, col3 = 380, col4 = 500
    doc.fillColor(grisText).fontSize(8).font('Helvetica')
    doc.text('Fecha emisión:', col1, y + 5)
    doc.text('Vigencia hasta:', col2, y + 5)
    doc.text('Estado:',         col3, y + 5)
    doc.text('Moneda:',         col4, y + 5)

    doc.fillColor(negro).font('Helvetica-Bold')
    const fechaStr = quot.created_at
      ? new Date(quot.created_at).toLocaleDateString('es-MX', { year: 'numeric', month: '2-digit', day: '2-digit' })
      : '-'
    const vigenciaStr = quot.valid_until
      ? new Date(quot.valid_until).toLocaleDateString('es-MX', { year: 'numeric', month: '2-digit', day: '2-digit' })
      : 'Sin vigencia'
    doc.text(fechaStr, col1, y + 17)
    doc.text(vigenciaStr, col2, y + 17)
    doc.text(statusLabel(quot.status), col3, y + 17)
    doc.text(quot.currency, col4, y + 17)

    // ─── CLIENTE ───────────────────────────────────────────────────
    y += 50
    doc.rect(40, y, W, 14).fill(azul)
    doc.fillColor('white').fontSize(8).font('Helvetica-Bold')
       .text('CLIENTE', 45, y + 3)

    doc.rect(40, y + 14, W, 52).fill(gris)
    doc.fillColor(negro).fontSize(8).font('Helvetica-Bold')
       .text(quot.partner_tax_name || quot.partner_name || '', 45, y + 18, { width: W - 10 })
    doc.font('Helvetica').fillColor(grisText)
       .text(`RFC: ${quot.partner_rfc || '-'}`, 45, y + 30)
       .text(`${quot.partner_address || ''}`.trim() || '-', 45, y + 41, { width: W - 10 })
       .text(`${quot.partner_city || ''}${quot.partner_state ? `, ${quot.partner_state}` : ''} ${quot.partner_zip || ''}`.trim() || '',
             45, y + 52, { width: W - 10 })

    // ─── CONCEPTOS ─────────────────────────────────────────────────
    y += 82
    doc.fillColor(negro).fontSize(9).font('Helvetica-Bold')
       .text('CONCEPTOS', 40, y)

    y += 14
    doc.rect(40, y, W, 16).fill(azul)
    doc.fillColor('white').fontSize(7.5).font('Helvetica-Bold')
    // Columnas: suma = 522 pts (W=532), deja ~10pt de margen derecho.
    // El gap entre "Cant." (right-align) y "Unidad" (left-align) se da con
    // width reducido en Cant para no pegarse al texto siguiente.
    const cw = { sku: 55, desc: 200, cant: 42, unit: 50, precio: 75, importe: 100 }
    const GAP = 4
    let cx = 45
    doc.text('SKU',        cx, y + 4, { width: cw.sku - GAP });                    cx += cw.sku
    doc.text('Descripción',cx, y + 4, { width: cw.desc - GAP });                   cx += cw.desc
    doc.text('Cant.',      cx, y + 4, { width: cw.cant - GAP, align: 'right' });   cx += cw.cant
    doc.text('Unidad',     cx, y + 4, { width: cw.unit - GAP });                   cx += cw.unit
    doc.text('P. Unitario',cx, y + 4, { width: cw.precio - GAP, align: 'right' }); cx += cw.precio
    doc.text('Importe',    cx, y + 4, { width: cw.importe - GAP, align: 'right' })

    y += 16
    lines.forEach((line, i) => {
      const rowH = 20
      const lineSubtotal = parseFloat(line.subtotal || 0)
      doc.rect(40, y, W, rowH).fill(i % 2 === 0 ? 'white' : gris)
      doc.fillColor(negro).fontSize(7.5).font('Helvetica')
      cx = 45
      doc.text(line.sku || '',          cx, y + 6, { width: cw.sku - GAP });                    cx += cw.sku
      doc.text(line.product_name || '', cx, y + 6, { width: cw.desc - GAP });                   cx += cw.desc
      doc.text(parseFloat(line.quantity).toFixed(2), cx, y + 6, { width: cw.cant - GAP, align: 'right' }); cx += cw.cant
      doc.text(line.unit || '',         cx, y + 6, { width: cw.unit - GAP });                   cx += cw.unit
      doc.text(fmt(line.unit_price),    cx, y + 6, { width: cw.precio - GAP, align: 'right' }); cx += cw.precio
      doc.text(fmt(lineSubtotal),       cx, y + 6, { width: cw.importe - GAP, align: 'right' })
      y += rowH
    })

    // ─── TOTALES ───────────────────────────────────────────────────
    y += 10
    const tw = 200
    const tx = 40 + W - tw

    const totalQuot = parseFloat(quot.subtotal_mxn || quot.total_mxn || 0)

    doc.rect(tx - 5, y, tw + 5, 22).fill(azul)
    doc.fillColor('white').fontSize(11).font('Helvetica-Bold')
       .text('TOTAL', tx, y + 6, { width: tw * 0.5 })
       .text(`${quot.currency} ${fmt(totalQuot)}`, tx + tw * 0.5, y + 6, { width: tw * 0.5 - 5, align: 'right' })
    y += 26

    doc.fillColor(grisText).fontSize(7.5).font('Helvetica-Oblique')
       .text('* El IVA (16%) se agrega al emitir la factura (CFDI).',
              40, y, { width: W - 10, align: 'left' })
    y += 4

    // ─── DATOS ADICIONALES ─────────────────────────────────────────
    const extras = []
    if (usdRate) {
      extras.push(['TC aplicado:', `$${usdRate.toFixed(4)} MXN/USD`])
    }
    if (quot.converted_order_number) {
      extras.push(['Convertida a pedido:', quot.converted_order_number])
    }
    if (quot.rejected_reason) {
      extras.push(['Motivo rechazo:', quot.rejected_reason])
    }
    if (quot.notes) extras.push(['Notas:', quot.notes])

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

    // ─── PIE ───────────────────────────────────────────────────────
    y += 20
    if (y > 720) { doc.addPage(); y = 40 }
    doc.fillColor(grisText).fontSize(7).font('Helvetica')
       .text('Esta cotización es un documento no fiscal. Los precios están sujetos a vigencia y disponibilidad.',
             40, y, { width: W, align: 'center' })

    // Watermark según estado terminal
    const watermark = terminalWatermark(quot.status)
    if (watermark) {
      doc.save()
      doc.rotate(-45, { origin: [doc.page.width / 2, doc.page.height / 2] })
      doc.fillColor('#DDDDDD').fontSize(60).font('Helvetica-Bold').opacity(0.3)
         .text(watermark, 0, doc.page.height / 2 - 30, { width: doc.page.width, align: 'center' })
      doc.restore()
    }

    addPraxionFooterPDF(doc)
    doc.end()
  })
}

function statusLabel(status) {
  return {
    draft:     'Borrador',
    sent:      'Enviada',
    accepted:  'Aceptada',
    converted: 'Convertida',
    rejected:  'Rechazada',
    expired:   'Expirada',
    cancelled: 'Cancelada',
  }[status] || status
}

function terminalWatermark(status) {
  if (status === 'cancelled') return 'CANCELADA'
  if (status === 'rejected')  return 'RECHAZADA'
  if (status === 'expired')   return 'EXPIRADA'
  return null
}

const fmt = (n) => parseFloat(n || 0).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

function createError(status, message) {
  const err = new Error(message)
  err.status = status
  return err
}

module.exports = { generateQuotationPDF }
