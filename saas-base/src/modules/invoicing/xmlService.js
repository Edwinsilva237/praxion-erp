'use strict'

const { query } = require('../../db')

/**
 * Genera el XML de un CFDI 4.0 sin timbre (para pruebas y vista previa).
 * Cuando se integre el PAC, este XML se enviará a timbrar.
 */
async function generateXML({ tenantId, invoiceId }) {
  // Obtener factura completa
  const { rows: invRows } = await query(
    `SELECT inv.*,
            bp.name AS partner_name, bp.rfc AS partner_rfc,
            bp.tax_regime_code AS partner_tax_regime,
            bp.zip_code AS partner_zip_code,
            tfi.rfc AS emisor_rfc, tfi.razon_social AS emisor_nombre,
            tfi.tax_regime AS emisor_regime, tfi.zip_code AS emisor_zip
     FROM invoices inv
     JOIN business_partners bp ON bp.id = inv.partner_id
     LEFT JOIN tenant_fiscal_info tfi ON tfi.tenant_id = inv.tenant_id
     WHERE inv.id = $1 AND inv.tenant_id = $2`,
    [invoiceId, tenantId]
  )
  if (!invRows.length) throw createError(404, 'Factura no encontrada.')
  const inv = invRows[0]

  // Obtener líneas
  const { rows: lines } = await query(
    `SELECT il.*, p.sku
     FROM invoice_lines il
     LEFT JOIN products p ON p.id = il.product_id
     WHERE il.invoice_id = $1
     ORDER BY il.line_number`,
    [invoiceId]
  )

  const fecha = new Date(inv.issue_date).toISOString().replace('Z', '').split('.')[0]
  const subtotal  = parseFloat(inv.subtotal).toFixed(2)
  const total     = parseFloat(inv.total).toFixed(2)
  const iva       = parseFloat(inv.tax_transferred).toFixed(2)

  // Generar conceptos
  const conceptos = lines.map(line => {
    const cantidad   = parseFloat(line.quantity).toFixed(4)
    const precio     = parseFloat(line.unit_price).toFixed(4)
    const importe    = parseFloat(line.subtotal).toFixed(2)
    const impuesto   = parseFloat(line.tax_amount).toFixed(2)
    const base       = importe
    const descuento  = parseFloat(line.discount_pct) > 0
      ? `\n        Descuento="${(parseFloat(importe) * parseFloat(line.discount_pct) / 100).toFixed(2)}"`
      : ''

    return `    <cfdi:Concepto
        ClaveProdServ="${line.sat_product_code || '10111402'}"
        ClaveUnidad="${line.sat_unit_code || 'H87'}"
        Unidad="${line.unit}"
        Cantidad="${cantidad}"
        Descripcion="${escapeXML(line.description)}"
        ValorUnitario="${precio}"
        Importe="${importe}"
        ObjetoImp="${line.objeto_imp || '02'}"${descuento}>
      <cfdi:Impuestos>
        <cfdi:Traslados>
          <cfdi:Traslado
            Base="${base}"
            Impuesto="002"
            TipoFactor="Tasa"
            TasaOCuota="0.160000"
            Importe="${impuesto}"/>
        </cfdi:Traslados>
      </cfdi:Impuestos>
    </cfdi:Concepto>`
  }).join('\n')

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<cfdi:Comprobante
  xmlns:cfdi="http://www.sat.gob.mx/cfd/4"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xsi:schemaLocation="http://www.sat.gob.mx/cfd/4 cfdv40.xsd"
  Version="4.0"
  Serie="${inv.series || ''}"
  Folio="${inv.folio || inv.document_number}"
  Fecha="${fecha}"
  FormaPago="${inv.payment_form || '03'}"
  SubTotal="${subtotal}"
  Moneda="${inv.currency}"${inv.currency === 'USD' ? `\n  TipoCambio="${parseFloat(inv.exchange_rate_value).toFixed(6)}"` : ''}
  Total="${total}"
  TipoDeComprobante="${inv.cfdi_type}"
  Exportacion="${inv.exportacion || '01'}"
  MetodoPago="${inv.payment_method}"
  LugarExpedicion="${inv.lugar_expedicion || inv.emisor_zip}">

  <cfdi:Emisor
    Rfc="${inv.emisor_rfc}"
    Nombre="${escapeXML(inv.emisor_nombre)}"
    RegimenFiscal="${inv.emisor_regime}"/>

  <cfdi:Receptor
    Rfc="${inv.partner_rfc}"
    Nombre="${escapeXML(inv.partner_name)}"
    DomicilioFiscalReceptor="${inv.receptor_zip_code || inv.partner_zip_code || ''}"
    RegimenFiscalReceptor="${inv.receptor_tax_regime || inv.partner_tax_regime || ''}"
    UsoCFDI="${inv.use_cfdi}"/>

  <cfdi:Conceptos>
${conceptos}
  </cfdi:Conceptos>

  <cfdi:Impuestos TotalImpuestosTrasladados="${iva}">
    <cfdi:Traslados>
      <cfdi:Traslado
        Base="${subtotal}"
        Impuesto="002"
        TipoFactor="Tasa"
        TasaOCuota="0.160000"
        Importe="${iva}"/>
    </cfdi:Traslados>
  </cfdi:Impuestos>

</cfdi:Comprobante>`

  return { xml, filename: `${inv.document_number}.xml`, invoice: inv }
}

function escapeXML(str) {
  if (!str) return ''
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function createError(status, message) {
  const err = new Error(message)
  err.status = status
  return err
}

module.exports = { generateXML }
