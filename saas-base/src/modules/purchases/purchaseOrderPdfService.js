'use strict'

const PDFDocument = require('pdfkit')
const { query }   = require('../../db')
const { addPraxionFooterPDF } = require('../../utils/praxionWitnessMark')
const { loadTenantLogo, headerTextX, drawHeaderLogo } = require('../../utils/pdfBranding')

/**
 * Genera el PDF de una Orden de Compra (representación impresa, NO fiscal).
 * Look-and-feel consistente con la remisión y el recibo de pago.
 *
 * Incluye:
 *   - Header azul con datos del emisor (mi empresa)
 *   - Bloque Proveedor + bloque "Entregar en" (almacén destino + fecha esperada)
 *   - Tabla de líneas (clave/desc, cantidad, unidad, precio, importe)
 *   - Totales (subtotal, IVA, total)
 *   - Bloque "Datos de pago al proveedor" (banco/cuenta/CLABE) si están capturados
 *   - Bloque "Notas" libre (horarios de entrega, paquetería, instrucciones)
 *   - Pie: documento de control interno
 */
async function generatePurchaseOrderPDF({ tenantId, orderId }) {
  // OC + proveedor + emisor
  const { rows: oRows } = await query(
    `SELECT po.*,
            bp.id              AS partner_id,
            bp.name            AS partner_name,
            bp.tax_name        AS partner_tax_name,
            bp.rfc             AS partner_rfc,
            bp.address         AS partner_address,
            bp.city            AS partner_city,
            bp.state           AS partner_state,
            bp.zip_code        AS partner_zip,
            bp.website         AS partner_website,
            bp.supplier_bank_name      AS bank_name,
            bp.supplier_account_holder AS account_holder,
            bp.supplier_account_number AS account_number,
            bp.supplier_clabe          AS clabe,
            bp.supplier_swift          AS swift,
            bp.supplier_credit_days    AS credit_days,
            bp.supplier_lead_time_days AS lead_time_days,
            u.full_name        AS created_by_name,
            COALESCE(fp.rfc, tfi.rfc)               AS emisor_rfc,
            COALESCE(fp.tax_name, tfi.razon_social) AS emisor_nombre,
            COALESCE(fp.tax_regime, tfi.tax_regime) AS emisor_regime,
            COALESCE(fp.zip_code, tfi.zip_code)     AS emisor_zip,
            t.name             AS tenant_name,
            t.brand_color_primary, t.brand_color_secondary, t.logo_storage_path
       FROM purchase_orders po
       JOIN business_partners bp        ON bp.id = po.partner_id
       LEFT JOIN users u                ON u.id  = po.created_by
       -- Emisor (solicitante): los datos REALES viven en tenant_fiscal_profiles
       -- (pantalla "Datos fiscales"). tenant_fiscal_info solo la llena el seed,
       -- así que el COALESCE prefiere el perfil real y respalda a la tabla vieja.
       LEFT JOIN tenant_fiscal_info tfi ON tfi.tenant_id = po.tenant_id
       LEFT JOIN LATERAL (
         SELECT rfc, tax_name, tax_regime, zip_code
           FROM tenant_fiscal_profiles
          WHERE tenant_id = po.tenant_id
          ORDER BY is_active DESC, created_at ASC
          LIMIT 1
       ) fp ON true
       LEFT JOIN tenants t              ON t.id  = po.tenant_id
      WHERE po.id = $1 AND po.tenant_id = $2`,
    [orderId, tenantId]
  )
  if (!oRows.length) throw createError(404, 'Orden de compra no encontrada.')
  const po = oRows[0]

  // Líneas + nombre del item y nombre del almacén destino.
  // raw_materials NO tiene SKU ni sat_product_code; products sí.
  const { rows: lines } = await query(
    `SELECT pol.*,
            COALESCE(rm.name, p.name) AS item_name,
            p.sku                     AS item_sku,
            p.sat_product_code        AS sat_product_code,
            w.name                    AS warehouse_name
       FROM purchase_order_lines pol
       LEFT JOIN raw_materials  rm ON rm.id = pol.item_id AND pol.item_type = 'raw_material'
       LEFT JOIN products       p  ON p.id  = pol.item_id AND pol.item_type = 'product'
       LEFT JOIN warehouses     w  ON w.id  = pol.warehouse_id
      WHERE pol.purchase_order_id = $1
      ORDER BY pol.line_number`,
    [orderId]
  )

  // Almacén destino primario (el primero capturado, o nulo si todos son distintos)
  const warehouses = [...new Set(lines.map(l => l.warehouse_name).filter(Boolean))]
  const primaryWarehouse = warehouses.length === 1 ? warehouses[0] : (warehouses[0] || '—')
  const multipleWarehouses = warehouses.length > 1

  const logoBuffer = await loadTenantLogo(po.logo_storage_path)

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 40, size: 'LETTER' })
    const buffers = []
    doc.on('data', chunk => buffers.push(chunk))
    doc.on('end', () => resolve(Buffer.concat(buffers)))
    doc.on('error', reject)

    const W = doc.page.width - 80
    const gris     = '#F5F5F5'
    const azul     = po.brand_color_primary   || '#5E9F32'
    const verde    = po.brand_color_secondary || '#2C7A4A'
    const negro    = '#222222'
    const grisText = '#666666'

    // ─── ENCABEZADO ─────────────────────────────────────────────
    const htx = headerTextX(!!logoBuffer)
    doc.rect(40, 40, W, 70).fill(azul)
    drawHeaderLogo(doc, logoBuffer)
    // Nombre del emisor a 13pt con ellipsis en una sola línea — antes
    // se rompía a 2 líneas con razones sociales largas y pisaba el RFC.
    doc.fillColor('white').fontSize(13).font('Helvetica-Bold')
       .text(po.emisor_nombre || po.tenant_name || 'EMISOR', htx, 54,
             { width: W * 0.42 - (htx - 55), ellipsis: true, height: 16, lineBreak: false })
    doc.fontSize(9).font('Helvetica')
       .text(`RFC: ${po.emisor_rfc || ''}`, htx, 76, { width: W * 0.42 - (htx - 55) })
       .text(`Régimen: ${po.emisor_regime || ''}  |  CP: ${po.emisor_zip || ''}`,
             htx, 88, { width: W * 0.42 - (htx - 55) })

    const padR    = 15
    const rightW  = 220
    const rightX  = 40 + W - rightW - padR
    doc.fontSize(16).font('Helvetica-Bold')
       .text('ORDEN DE COMPRA', rightX, 54, { width: rightW, align: 'right' })
    doc.fontSize(11).font('Helvetica')
       .text(po.order_number, rightX, 75, { width: rightW, align: 'right' })
    doc.fontSize(8).fillColor('#CCCCCC')
       .text(`Emitida: ${fmtDate(po.created_at)}`, rightX, 92, { width: rightW, align: 'right' })

    // ─── DATOS DEL DOCUMENTO ────────────────────────────────────
    let y = 125
    doc.fillColor(negro).fontSize(9).font('Helvetica-Bold')
       .text('DATOS DE LA ORDEN', 40, y)

    y += 14
    const dataBoxH = 50
    doc.rect(40, y, W, dataBoxH).fill(gris)

    const col1 = 50, col2 = 220, col3 = 380, col4 = 500
    doc.fillColor(grisText).fontSize(8).font('Helvetica')
    doc.text('Estado:',        col1, y + 5)
    doc.text('Moneda:',        col2, y + 5)
    doc.text('Fecha esperada:', col3, y + 5)
    doc.text('Solicitó:',      col4, y + 5)

    doc.fillColor(negro).font('Helvetica-Bold')
    doc.text((po.status || '').toUpperCase(), col1, y + 17)
    doc.text(po.currency || 'MXN', col2, y + 17)
    doc.text(po.expected_date ? fmtDate(po.expected_date) : '—', col3, y + 17)
    doc.text(po.created_by_name || '—', col4, y + 17, { width: W - (col4 - 40) - 10 })

    doc.fillColor(grisText).font('Helvetica')
    doc.text('Lead time prov.:', col1, y + 33)
    doc.text('Crédito prov.:',   col2, y + 33)

    doc.fillColor(negro).font('Helvetica-Bold')
    doc.text(po.lead_time_days != null ? `${po.lead_time_days} días` : '—', col1, y + 45)
    doc.text(po.credit_days    != null ? `${po.credit_days} días`    : 'Contado', col2, y + 45)

    // ─── EMISOR / PROVEEDOR ─────────────────────────────────────
    y += dataBoxH + 12
    const halfW = (W - 10) / 2

    doc.rect(40, y, halfW, 14).fill(azul)
    doc.fillColor('white').fontSize(8).font('Helvetica-Bold')
       .text('SOLICITANTE', 45, y + 3)
    doc.rect(40, y + 14, halfW, 60).fill(gris)
    doc.fillColor(negro).fontSize(8).font('Helvetica-Bold')
       .text(po.emisor_nombre || po.tenant_name || '', 45, y + 18,
             { width: halfW - 10, ellipsis: true, height: 11, lineBreak: false })
    doc.font('Helvetica').fillColor(grisText)
       .text(`RFC: ${po.emisor_rfc || ''}`, 45, y + 30)
       .text(`Régimen: ${po.emisor_regime || ''}`, 45, y + 41)
       .text(`CP: ${po.emisor_zip || ''}`, 45, y + 52)

    const rx = 40 + halfW + 10
    doc.rect(rx, y, halfW, 14).fill(azul)
    doc.fillColor('white').fontSize(8).font('Helvetica-Bold')
       .text('PROVEEDOR', rx + 5, y + 3)
    doc.rect(rx, y + 14, halfW, 60).fill(gris)
    doc.fillColor(negro).fontSize(8).font('Helvetica-Bold')
       .text(po.partner_tax_name || po.partner_name || '', rx + 5, y + 18,
             { width: halfW - 10, ellipsis: true, height: 11, lineBreak: false })
    doc.font('Helvetica').fillColor(grisText)
       .text(`RFC: ${po.partner_rfc || ''}`, rx + 5, y + 30)
    const plaza = [po.partner_city, po.partner_state].filter(Boolean).join(', ') || '—'
    doc.text(plaza, rx + 5, y + 41, { width: halfW - 10, ellipsis: true, height: 11, lineBreak: false })
    doc.text(`CP: ${po.partner_zip || '—'}${po.partner_website ? '  ·  ' + po.partner_website : ''}`,
             rx + 5, y + 52, { width: halfW - 10, ellipsis: true, height: 11, lineBreak: false })

    // ─── ENTREGAR EN ────────────────────────────────────────────
    y += 90
    doc.fillColor(negro).fontSize(9).font('Helvetica-Bold')
       .text('ENTREGAR EN', 40, y)
    y += 14
    doc.rect(40, y, W, 28).fill(gris)
    doc.fillColor(grisText).fontSize(8).font('Helvetica')
       .text('Almacén destino:', 50, y + 5)
    doc.fillColor(negro).font('Helvetica-Bold')
       .text(
         multipleWarehouses
           ? `${primaryWarehouse} y otros (ver líneas)`
           : primaryWarehouse,
         50, y + 16, { width: W - 20 }
       )

    // ─── CONCEPTOS ──────────────────────────────────────────────
    y += 40
    doc.fillColor(negro).fontSize(9).font('Helvetica-Bold')
       .text('LÍNEAS A SURTIR', 40, y)

    y += 14
    // Suma = 525 (W=532). Cant. con padding derecho para no pegarse a Unidad.
    const cw = { clave: 60, desc: 175, alm: 70, cant: 50, unidad: 45, precio: 55, importe: 70 }
    let cx = 45
    // Cabecera de la tabla — extraída para poder repetirla al saltar de página.
    const drawLinesHeader = () => {
      doc.rect(40, y, W, 16).fill(azul)
      doc.fillColor('white').fontSize(7.5).font('Helvetica-Bold')
      let hx = 45
      doc.text('Clave',       hx, y + 4, { width: cw.clave });    hx += cw.clave
      doc.text('Descripción', hx, y + 4, { width: cw.desc });     hx += cw.desc
      doc.text('Almacén',     hx, y + 4, { width: cw.alm });      hx += cw.alm
      doc.text('Cant.',       hx, y + 4, { width: cw.cant - 6, align: 'right' }); hx += cw.cant
      doc.text('Unidad',      hx, y + 4, { width: cw.unidad });   hx += cw.unidad
      doc.text('P. Unit.',    hx, y + 4, { width: cw.precio, align: 'right' }); hx += cw.precio
      doc.text('Importe',     hx, y + 4, { width: cw.importe, align: 'right' })
      y += 16
    }
    drawLinesHeader()

    const bottomLimit = doc.page.height - 70
    lines.forEach((line, i) => {
      const desc = line.item_name || line.description || ''
      // Clave del proveedor + nota de la línea: se imprimen DEBAJO de la
      // descripción (gris, cursiva) para que el proveedor reconozca el producto.
      const skuProv = (line.supplier_sku || '').trim()
      const note    = (line.notes || '').trim()
      const extras  = []
      if (skuProv) extras.push(`Clave prov.: ${skuProv}`)
      if (note)    extras.push(`Nota: ${note}`)

      // La descripción AHORA envuelve a varias líneas — antes se truncaba con
      // ellipsis y cortaba los nombres largos. La altura de la fila se ajusta
      // a la descripción (que es la columna más alta) + las líneas extra.
      doc.fontSize(7.5).font('Helvetica')
      const descH = doc.heightOfString(desc, { width: cw.desc - 5 })
      doc.fontSize(6.5).font('Helvetica-Oblique')
      const extraH = extras.reduce((h, t) => h + doc.heightOfString(t, { width: cw.desc - 5 }), 0)
      const rowH  = Math.max(22, descH + (extras.length ? extraH + 3 : 0) + 12)

      // Salto de página: una fila alta puede no caber antes del pie.
      if (y + rowH > bottomLimit) {
        doc.addPage()
        y = 40
        drawLinesHeader()
      }

      doc.rect(40, y, W, rowH).fill(i % 2 === 0 ? 'white' : gris)
      doc.fillColor(negro).fontSize(7.5).font('Helvetica')
      cx = 45
      doc.text(line.item_sku || line.sat_product_code || '', cx, y + 7,
               { width: cw.clave, ellipsis: true, height: 10, lineBreak: false })
      cx += cw.clave
      doc.text(desc, cx, y + 7, { width: cw.desc - 5 })
      if (extras.length) {
        let ey = y + 7 + descH + 1
        doc.fontSize(6.5).font('Helvetica-Oblique').fillColor(grisText)
        for (const t of extras) {
          doc.text(t, cx, ey, { width: cw.desc - 5 })
          ey += doc.heightOfString(t, { width: cw.desc - 5 })
        }
        doc.fontSize(7.5).font('Helvetica').fillColor(negro)
      }
      cx += cw.desc
      doc.text(line.warehouse_name || '—', cx, y + 7,
               { width: cw.alm - 3, ellipsis: true, height: 10, lineBreak: false })
      cx += cw.alm
      doc.text(parseFloat(line.quantity).toLocaleString('es-MX', { maximumFractionDigits: 4 }),
               cx, y + 7, { width: cw.cant - 6, align: 'right' })
      cx += cw.cant
      doc.text(line.unit || '', cx, y + 7, { width: cw.unidad })
      cx += cw.unidad
      doc.text(fmt(line.unit_price), cx, y + 7, { width: cw.precio, align: 'right' })
      cx += cw.precio
      doc.font('Helvetica-Bold')
         .text(fmt(line.subtotal), cx, y + 7, { width: cw.importe, align: 'right' })
      y += rowH
    })

    // ─── TOTALES ────────────────────────────────────────────────
    y += 10
    const tw = 220
    const tx = 40 + W - tw

    const totalesRows = [
      ['Subtotal', fmt(po.subtotal_mxn)],
      ['IVA (16%)', fmt(po.tax_mxn)],
    ]
    totalesRows.forEach(([label, value]) => {
      doc.fillColor(grisText).fontSize(8).font('Helvetica')
         .text(label, tx, y, { width: tw * 0.5 })
      doc.fillColor(negro).font('Helvetica-Bold')
         .text(value, tx + tw * 0.5, y, { width: tw * 0.5 - 5, align: 'right' })
      y += 14
    })

    doc.rect(tx - 5, y, tw + 5, 22).fill(azul)
    doc.fillColor('white').fontSize(11).font('Helvetica-Bold')
       .text('TOTAL', tx, y + 6, { width: tw * 0.5 })
       .text(`${po.currency || 'MXN'} ${fmt(po.total_mxn)}`,
             tx + tw * 0.5, y + 6, { width: tw * 0.5 - 5, align: 'right' })
    y += 30

    // ─── DATOS BANCARIOS DEL PROVEEDOR ──────────────────────────
    const hasBank = po.bank_name || po.account_number || po.clabe
    if (hasBank) {
      doc.rect(40, y, W, 14).fill(verde)
      doc.fillColor('white').fontSize(8).font('Helvetica-Bold')
         .text('DATOS DE PAGO AL PROVEEDOR', 45, y + 3)
      y += 14
      const bankH = 46
      doc.rect(40, y, W, bankH).fill(gris)
      const bc1 = 50, bc2 = 220, bc3 = 390
      doc.fillColor(grisText).fontSize(8).font('Helvetica')
      doc.text('Banco:',    bc1, y + 5)
      doc.text('Titular:',  bc2, y + 5)
      doc.text('CLABE:',    bc3, y + 5)
      doc.fillColor(negro).font('Helvetica-Bold')
      doc.text(po.bank_name || '—',     bc1, y + 17, { width: bc2 - bc1 - 10 })
      doc.text(po.account_holder || '—', bc2, y + 17, { width: bc3 - bc2 - 10 })
      doc.text(po.clabe || '—',         bc3, y + 17, { width: W - (bc3 - 40) - 10, ellipsis: true, height: 10, lineBreak: false })

      doc.fillColor(grisText).font('Helvetica')
      doc.text('Cuenta:',   bc1, y + 31)
      if (po.swift) doc.text('SWIFT:', bc2, y + 31)
      doc.fillColor(negro).font('Helvetica-Bold')
      doc.text(po.account_number || '—', bc1, y + 41,
               { width: bc2 - bc1 - 10, ellipsis: true, height: 10, lineBreak: false })
      if (po.swift) doc.text(po.swift, bc2, y + 41)
      y += bankH + 10
    }

    // ─── NOTAS ──────────────────────────────────────────────────
    if (po.notes) {
      doc.rect(40, y, W, 14).fill(azul)
      doc.fillColor('white').fontSize(8).font('Helvetica-Bold')
         .text('NOTAS', 45, y + 3)
      y += 14
      const lineas    = po.notes.split('\n').length
      const aproxH    = Math.max(28, Math.min(140, lineas * 12 + Math.ceil(po.notes.length / 100) * 10))
      doc.rect(40, y, W, aproxH).fill(gris)
      doc.fillColor(negro).fontSize(8).font('Helvetica')
         .text(po.notes, 50, y + 6, { width: W - 20 })
      y += aproxH + 5
    }

    // ─── PIE ────────────────────────────────────────────────────
    y = Math.max(y + 15, doc.page.height - 60)
    doc.fillColor(grisText).fontSize(7).font('Helvetica-Oblique')
       .text(
         'Esta orden de compra es un documento de control interno. ' +
         'La factura del proveedor debe coincidir en precios y cantidades.',
         40, y, { width: W, align: 'center' })

    addPraxionFooterPDF(doc)
    doc.end()
  })
}

// ── Utilidades ──────────────────────────────────────────────────────────
const fmt = (n) => parseFloat(n || 0).toLocaleString('es-MX',
  { minimumFractionDigits: 2, maximumFractionDigits: 2 })

function fmtDate(d) {
  if (!d) return ''
  return new Date(d).toLocaleDateString('es-MX',
    { day: '2-digit', month: '2-digit', year: 'numeric' })
}

function createError(status, message) {
  const err = new Error(message)
  err.status = status
  return err
}

module.exports = { generatePurchaseOrderPDF }
