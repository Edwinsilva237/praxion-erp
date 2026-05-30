'use strict'

const PDFDocument = require('pdfkit')
const { query }   = require('../../db')
const { addPraxionFooterPDF } = require('../../utils/praxionWitnessMark')
const { loadTenantLogo, headerTextX, drawHeaderLogo } = require('../../utils/pdfBranding')

/**
 * Genera la representación impresa (PDF) de una factura.
 */
async function generatePDF({ tenantId, invoiceId }) {
  // Obtener factura completa
  const { rows: invRows } = await query(
    `SELECT inv.*,
            bp.name AS partner_name,
            bp.tax_name AS partner_tax_name,
            bp.rfc AS partner_rfc,
            bp.tax_regime_code AS partner_tax_regime,
            bp.zip_code AS partner_zip_code,
            tfi.rfc AS emisor_rfc, tfi.razon_social AS emisor_nombre,
            tfi.tax_regime AS emisor_regime, tfi.zip_code AS emisor_zip,
            t.brand_color_primary, t.brand_color_secondary, t.logo_storage_path
     FROM invoices inv
     JOIN business_partners bp ON bp.id = inv.partner_id
     LEFT JOIN tenant_fiscal_info tfi ON tfi.tenant_id = inv.tenant_id
     LEFT JOIN tenants t ON t.id = inv.tenant_id
     WHERE inv.id = $1 AND inv.tenant_id = $2`,
    [invoiceId, tenantId]
  )
  if (!invRows.length) throw createError(404, 'Factura no encontrada.')
  const inv = invRows[0]

  // Obtener líneas
  const { rows: lines } = await query(
    `SELECT il.*, p.sku, p.name AS product_name
     FROM invoice_lines il
     LEFT JOIN products p ON p.id = il.product_id
     WHERE il.invoice_id = $1
     ORDER BY il.line_number`,
    [invoiceId]
  )

  // Retenciones (ISR / IVA) — para desglosarlas en los totales.
  const { rows: retentions } = await query(
    `SELECT tax_type, rate, amount FROM invoice_retentions
      WHERE invoice_id = $1 ORDER BY tax_type`,
    [invoiceId]
  )

  // Remisiones origen — para mostrar trazabilidad en el PDF
  let remisionNumbers = []
  if (inv.delivery_note_id) {
    const { rows: dn } = await query(
      `SELECT document_number FROM delivery_notes WHERE id = $1`,
      [inv.delivery_note_id]
    )
    if (dn[0]) remisionNumbers = [dn[0].document_number]
  } else {
    const { rows: consolidated } = await query(
      `SELECT document_number FROM accounts_receivable
        WHERE tenant_id = $1
          AND document_type = 'remission'
          AND notes LIKE '%[Consolidada en factura ' || $2 || ']%'
        ORDER BY document_number`,
      [tenantId, inv.document_number]
    )
    remisionNumbers = consolidated.map(r => r.document_number)
  }

  // Notas limpias (quitar la marca interna [facturapi_id:...])
  const cleanNotes = (inv.notes || '').replace(/\s*\[facturapi_id:[^\]]+\]\s*/g, '').trim() || null

  // Detectar el TC efectivo aplicado en esta factura. Dos casos:
  //  a) Factura completa USD → exchange_rate_value del header.
  //  b) Factura MXN con líneas originalmente USD (revaluadas) → applied_exchange_rate
  //     de cualquier línea con original_currency='USD'. La fecha viene de
  //     applied_exchange_rate_date (puede ser del último día hábil si fin de semana).
  let usdRate = null
  let usdRateDate = null
  let usdRateLabel = null
  if (inv.currency === 'USD' && inv.exchange_rate_value) {
    usdRate = parseFloat(inv.exchange_rate_value)
    usdRateLabel = 'Tipo de cambio'
  } else {
    const usdLine = lines.find(l =>
      l.original_currency === 'USD' && l.applied_exchange_rate
    )
    if (usdLine) {
      usdRate = parseFloat(usdLine.applied_exchange_rate)
      usdRateDate = usdLine.applied_exchange_rate_date || null
      usdRateLabel = 'TC aplicado a líneas USD'
    }
  }

  const logoBuffer = await loadTenantLogo(inv.logo_storage_path)

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 40, size: 'LETTER' })
    const buffers = []
    doc.on('data', chunk => buffers.push(chunk))
    doc.on('end', () => resolve(Buffer.concat(buffers)))
    doc.on('error', reject)

    const W = doc.page.width - 80  // ancho útil
    const gris     = '#F5F5F5'
    const azul     = inv.brand_color_primary   || '#1A3A5C'
    const acento   = inv.brand_color_secondary || azul
    const negro    = '#222222'
    const grisText = '#666666'

    // ─── ENCABEZADO ────────────────────────────────────────────────
    const htx = headerTextX(!!logoBuffer)
    doc.rect(40, 40, W, 70).fill(azul)
    drawHeaderLogo(doc, logoBuffer)

    doc.fillColor('white').fontSize(18).font('Helvetica-Bold')
       .text(inv.emisor_nombre || 'EMISOR', htx, 52, { width: W * 0.6 - (htx - 55) })

    doc.fontSize(9).font('Helvetica')
       .text(`RFC: ${inv.emisor_rfc || ''}`, htx, 74)
       .text(`Régimen: ${inv.emisor_regime || ''}  |  CP: ${inv.emisor_zip || inv.lugar_expedicion || ''}`, htx, 86)

    // Número de factura (derecha)
    doc.fontSize(22).font('Helvetica-Bold')
       .text(inv.document_number, 55 + W * 0.6, 48, { width: W * 0.4 - 15, align: 'right' })
    doc.fontSize(9).font('Helvetica')
       .text(`Serie: ${inv.series || '-'}  |  Folio: ${inv.folio || '-'}`, 55 + W * 0.6, 76, { width: W * 0.4 - 15, align: 'right' })

    // ─── DATOS GENERALES ───────────────────────────────────────────
    let y = 125
    doc.fillColor(negro).fontSize(9).font('Helvetica-Bold')
       .text('DATOS DEL COMPROBANTE', 40, y)

    y += 14
    doc.rect(40, y, W, 50).fill(gris)

    const col1 = 50, col2 = 220, col3 = 380, col4 = 500
    doc.fillColor(grisText).fontSize(8).font('Helvetica')
    doc.text('Fecha emisión:', col1, y + 5)
    doc.text('Método de pago:', col2, y + 5)
    doc.text('Forma de pago:', col3, y + 5)
    doc.text('Moneda:', col4, y + 5)

    doc.fillColor(negro).font('Helvetica-Bold')
    const fechaStr = new Date(inv.issue_date).toLocaleDateString('es-MX', { year: 'numeric', month: '2-digit', day: '2-digit' })
    doc.text(fechaStr, col1, y + 17)
    doc.text(inv.payment_method || '-', col2, y + 17)
    doc.text(formasPago[inv.payment_form] || inv.payment_form || '-', col3, y + 17)
    doc.text(inv.currency, col4, y + 17)

    doc.fillColor(grisText).font('Helvetica')
    doc.text('Uso CFDI:', col1, y + 31)
    doc.text('Exportación:', col2, y + 31)
    doc.fillColor(negro).font('Helvetica-Bold')
    doc.text(usosCFDI[inv.use_cfdi] || inv.use_cfdi || '-', col1, y + 42)
    doc.text(inv.exportacion === '01' ? 'No aplica' : inv.exportacion, col2, y + 42)

    // ─── EMISOR / RECEPTOR ─────────────────────────────────────────
    y += 65
    const halfW = (W - 10) / 2

    // Emisor
    doc.rect(40, y, halfW, 14).fill(azul)
    doc.fillColor('white').fontSize(8).font('Helvetica-Bold')
       .text('EMISOR', 45, y + 3)

    doc.rect(40, y + 14, halfW, 52).fill(gris)
    doc.fillColor(negro).fontSize(8).font('Helvetica-Bold')
       .text(inv.emisor_nombre || '', 45, y + 18, { width: halfW - 10 })
    doc.font('Helvetica').fillColor(grisText)
       .text(`RFC: ${inv.emisor_rfc || ''}`, 45, y + 30)
       .text(`Régimen: ${inv.emisor_regime || ''}`, 45, y + 41)
       .text(`CP Expedición: ${inv.lugar_expedicion || inv.emisor_zip || ''}`, 45, y + 52)

    // Receptor
    const rx = 40 + halfW + 10
    doc.rect(rx, y, halfW, 14).fill(azul)
    doc.fillColor('white').fontSize(8).font('Helvetica-Bold')
       .text('RECEPTOR', rx + 5, y + 3)

    doc.rect(rx, y + 14, halfW, 52).fill(gris)
    doc.fillColor(negro).fontSize(8).font('Helvetica-Bold')
       .text(inv.receptor_legal_name || inv.partner_tax_name || inv.partner_name || '', rx + 5, y + 18, { width: halfW - 10 })
    doc.font('Helvetica').fillColor(grisText)
       .text(`RFC: ${inv.partner_rfc || ''}`, rx + 5, y + 30)
       .text(`Régimen: ${inv.receptor_tax_regime || inv.partner_tax_regime || ''}`, rx + 5, y + 41)
       .text(`CP Fiscal: ${inv.receptor_zip_code || inv.partner_zip_code || ''}`, rx + 5, y + 52)

    // ─── CONCEPTOS ─────────────────────────────────────────────────
    y += 82
    doc.fillColor(negro).fontSize(9).font('Helvetica-Bold')
       .text('CONCEPTOS', 40, y)

    y += 14
    // Encabezado tabla
    doc.rect(40, y, W, 16).fill(azul)
    doc.fillColor('white').fontSize(7.5).font('Helvetica-Bold')
    const cw = { clave: 70, desc: 190, cant: 45, unit: 40, precio: 65, desc2: 40, importe: 70 }
    let cx = 45
    doc.text('Clave SAT', cx, y + 4); cx += cw.clave
    doc.text('Descripción', cx, y + 4); cx += cw.desc
    doc.text('Cant.', cx, y + 4, { width: cw.cant, align: 'right' }); cx += cw.cant
    doc.text('Unidad', cx, y + 4); cx += cw.unit
    doc.text('P. Unitario', cx, y + 4, { width: cw.precio, align: 'right' }); cx += cw.precio
    doc.text('Desc%', cx, y + 4, { width: cw.desc2, align: 'right' }); cx += cw.desc2
    doc.text('Importe', cx, y + 4, { width: cw.importe, align: 'right' })

    y += 16
    lines.forEach((line, i) => {
      const rowH = 18
      doc.rect(40, y, W, rowH).fill(i % 2 === 0 ? 'white' : gris)
      doc.fillColor(negro).fontSize(7.5).font('Helvetica')
      cx = 45
      doc.text(line.sat_product_code || '', cx, y + 5, { width: cw.clave }); cx += cw.clave
      doc.text(line.description || '', cx, y + 5, { width: cw.desc - 5 }); cx += cw.desc
      doc.text(parseFloat(line.quantity).toFixed(2), cx, y + 5, { width: cw.cant, align: 'right' }); cx += cw.cant
      doc.text(line.unit || '', cx, y + 5, { width: cw.unit }); cx += cw.unit
      doc.text(fmt(line.unit_price), cx, y + 5, { width: cw.precio, align: 'right' }); cx += cw.precio
      doc.text(`${parseFloat(line.discount_pct || 0).toFixed(0)}%`, cx, y + 5, { width: cw.desc2, align: 'right' }); cx += cw.desc2
      doc.text(fmt(line.subtotal), cx, y + 5, { width: cw.importe, align: 'right' })
      y += rowH
    })

    // ─── TOTALES ───────────────────────────────────────────────────
    y += 10
    const tw = 200
    const tx = 40 + W - tw

    const totalesRows = [
      ['Subtotal', fmt(inv.subtotal)],
      ['IVA', fmt(inv.tax_transferred)],
    ]
    // Retenciones desglosadas por tipo (ISR / IVA). Si por algún motivo no hay
    // detalle pero sí hay monto retenido, mostramos el agregado.
    if (retentions.length) {
      retentions.forEach(r => {
        const label = `Ret. ${r.tax_type} (${parseFloat(r.rate).toFixed(2)}%)`
        totalesRows.push([label, `- ${fmt(r.amount)}`])
      })
    } else if (parseFloat(inv.tax_withheld) > 0) {
      totalesRows.push(['Retenciones', `- ${fmt(inv.tax_withheld)}`])
    }

    totalesRows.forEach(([label, value]) => {
      doc.fillColor(grisText).fontSize(8).font('Helvetica')
         .text(label, tx, y, { width: tw * 0.5 })
      doc.fillColor(negro).font('Helvetica-Bold')
         .text(value, tx + tw * 0.5, y, { width: tw * 0.5 - 5, align: 'right' })
      y += 14
    })

    // Total
    doc.rect(tx - 5, y, tw + 5, 20).fill(azul)
    doc.fillColor('white').fontSize(10).font('Helvetica-Bold')
       .text('TOTAL', tx, y + 5, { width: tw * 0.5 })
       .text(`${inv.currency} ${fmt(inv.total)}`, tx + tw * 0.5, y + 5, { width: tw * 0.5 - 5, align: 'right' })

    // ─── DATOS ADICIONALES (OC, TC, remisiones, notas) ─────────────
    const extras = []
    if (inv.po_number) {
      extras.push(['OC del cliente:', String(inv.po_number)])
    }
    if (usdRate) {
      let tcText = `$${usdRate.toFixed(4)} MXN/USD`
      if (usdRateDate) {
        const d = new Date(usdRateDate).toLocaleDateString('es-MX', { day: '2-digit', month: 'short', year: 'numeric' })
        tcText += ` (${d})`
      }
      extras.push([`${usdRateLabel}:`, tcText])
    }
    if (remisionNumbers.length > 0) {
      const label = remisionNumbers.length === 1 ? 'Remisión origen:' : 'Remisiones consolidadas:'
      extras.push([label, remisionNumbers.join(', ')])
    }
    if (cleanNotes) {
      extras.push(['Notas:', cleanNotes])
    }

    if (extras.length > 0) {
      y += 25
      const headerH = 14
      doc.rect(40, y, W, headerH).fill(azul)
      doc.fillColor('white').fontSize(8).font('Helvetica-Bold')
         .text('DATOS ADICIONALES', 45, y + 3)
      y += headerH

      const bodyH = extras.length * 14 + 6
      doc.rect(40, y, W, bodyH).fill(gris)

      let exY = y + 4
      extras.forEach(([label, value]) => {
        doc.fillColor(grisText).fontSize(8).font('Helvetica-Bold')
           .text(label, 50, exY, { width: 130 })
        doc.fillColor(negro).font('Helvetica')
           .text(value, 180, exY, { width: W - 145 })
        exY += 14
      })
      y += bodyH
    }

    // ─── UUID (si está timbrado) ───────────────────────────────────
    if (inv.cfdi_uuid) {
      y += 15
      doc.rect(40, y, W, 30).fill(gris)
      doc.fillColor(grisText).fontSize(7).font('Helvetica')
         .text('FOLIO FISCAL (UUID):', 50, y + 5)
      doc.fillColor(negro).font('Helvetica-Bold')
         .text(inv.cfdi_uuid, 50, y + 16, { width: W - 20 })
    }

    // ─── PIE ───────────────────────────────────────────────────────
    y += inv.cfdi_uuid ? 40 : 30
    doc.fillColor(grisText).fontSize(7).font('Helvetica')
       .text('Este documento es una representación impresa de un CFDI.', 40, y, { width: W, align: 'center' })

    if (inv.status === 'draft') {
      doc.save()
      doc.rotate(-45, { origin: [doc.page.width / 2, doc.page.height / 2] })
      doc.fillColor('#DDDDDD').fontSize(60).font('Helvetica-Bold').opacity(0.3)
         .text('BORRADOR', 0, doc.page.height / 2 - 30, { width: doc.page.width, align: 'center' })
      doc.restore()
    }

    addPraxionFooterPDF(doc)
    doc.end()
  })
}

const formasPago = {
  '01': 'Efectivo', '02': 'Cheque', '03': 'Transferencia',
  '04': 'Tarjeta crédito', '28': 'Tarjeta débito', '99': 'Por definir',
}

const usosCFDI = {
  'G01': 'Adquisición de mercancias', 'G02': 'Devoluciones',
  'G03': 'Gastos en general', 'I01': 'Construcciones',
  'I02': 'Mobilario y equipo', 'S01': 'Sin efectos fiscales',
  'CP01': 'Pagos', 'CN01': 'Nómina',
}

const fmt = (n) => parseFloat(n || 0).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

function createError(status, message) {
  const err = new Error(message)
  err.status = status
  return err
}

module.exports = { generatePDF }
