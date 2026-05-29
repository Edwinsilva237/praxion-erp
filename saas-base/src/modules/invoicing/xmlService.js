'use strict'

const { query } = require('../../db')
const { normalizeLineTax } = require('./lineTax')

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

  // Retenciones (ISR / IVA) de la factura. Código SAT: ISR=001, IVA=002.
  const { rows: retentionRows } = await query(
    `SELECT tax_type, rate, amount FROM invoice_retentions WHERE invoice_id = $1`,
    [invoiceId]
  )
  const SAT_IMPUESTO = { ISR: '001', IVA: '002' }
  // Base gravable: subtotal de líneas objeto de impuesto ('02').
  const taxableBase = lines.reduce((s, l) =>
    s + (String(l.objeto_imp || '02') === '02' ? parseFloat(l.subtotal) : 0), 0)

  const fecha = new Date(inv.issue_date).toISOString().replace('Z', '').split('.')[0]
  const subtotal  = parseFloat(inv.subtotal).toFixed(2)
  const total     = parseFloat(inv.total).toFixed(2)

  // Agregado global de IVA trasladado, agrupado por tasa. Las líneas exentas y
  // las "no objeto" no entran al agregado (CFDI 4.0). Se calcula desde las
  // líneas para reflejar tasa cero / 8% / exento en vez de forzar 16%.
  const taxGroups = new Map() // tasa(6) → { base, importe }
  for (const line of lines) {
    const { objetoImp, factor, ratePct } = normalizeLineTax(line)
    if (objetoImp === '01' || objetoImp === '03' || factor === 'Exento') continue
    const tasa = (ratePct / 100).toFixed(6)
    const g = taxGroups.get(tasa) || { base: 0, importe: 0 }
    g.base    += parseFloat(line.subtotal)
    g.importe += parseFloat(line.tax_amount)
    taxGroups.set(tasa, g)
  }
  const totalTrasladado = [...taxGroups.values()].reduce((s, g) => s + g.importe, 0)
  const iva = totalTrasladado.toFixed(2)

  // Generar conceptos
  const conceptos = lines.map(line => {
    const { objetoImp, factor, ratePct } = normalizeLineTax(line)
    const cantidad   = parseFloat(line.quantity).toFixed(4)
    const precio     = parseFloat(line.unit_price).toFixed(4)
    const importe    = parseFloat(line.subtotal).toFixed(2)
    const impuesto   = parseFloat(line.tax_amount).toFixed(2)
    const base       = importe
    const descuento  = parseFloat(line.discount_pct) > 0
      ? `\n        Descuento="${(parseFloat(importe) * parseFloat(line.discount_pct) / 100).toFixed(2)}"`
      : ''

    // Bloque de impuestos del concepto según su tratamiento fiscal.
    //   - objeto 01/03 → sin nodo de impuestos (concepto auto-cerrado).
    //   - Exento       → Traslado TipoFactor Exento, sin tasa ni importe.
    //   - Tasa         → Traslado con la tasa real de la línea.
    //   - Retenciones  → en líneas objeto de impuesto, una por cada retención.
    let impuestosNode = ''
    if (objetoImp !== '01' && objetoImp !== '03') {
      const traslado = factor === 'Exento'
        ? `          <cfdi:Traslado Base="${base}" Impuesto="002" TipoFactor="Exento"/>`
        : `          <cfdi:Traslado Base="${base}" Impuesto="002" TipoFactor="Tasa" TasaOCuota="${(ratePct / 100).toFixed(6)}" Importe="${impuesto}"/>`
      const retNode = retentionRows.length
        ? `
        <cfdi:Retenciones>
${retentionRows.map(r =>
          `          <cfdi:Retencion Base="${base}" Impuesto="${SAT_IMPUESTO[r.tax_type]}" TipoFactor="Tasa" TasaOCuota="${(parseFloat(r.rate) / 100).toFixed(6)}" Importe="${(parseFloat(base) * parseFloat(r.rate) / 100).toFixed(2)}"/>`
        ).join('\n')}
        </cfdi:Retenciones>`
        : ''
      impuestosNode = `
      <cfdi:Impuestos>
        <cfdi:Traslados>
${traslado}
        </cfdi:Traslados>${retNode}
      </cfdi:Impuestos>`
    }

    const conceptoOpen = `    <cfdi:Concepto
        ClaveProdServ="${line.sat_product_code || '10111402'}"
        ClaveUnidad="${line.sat_unit_code || 'H87'}"
        Unidad="${line.unit}"
        Cantidad="${cantidad}"
        Descripcion="${escapeXML(line.description)}"
        ValorUnitario="${precio}"
        Importe="${importe}"
        ObjetoImp="${objetoImp}"${descuento}`

    return impuestosNode
      ? `${conceptoOpen}>${impuestosNode}\n    </cfdi:Concepto>`
      : `${conceptoOpen}/>`
  }).join('\n')

  // Nodo global de impuestos: retenciones (agregadas por impuesto) + traslados
  // (uno por tasa). Se omite solo si no hay ni traslados ni retenciones.
  const totalRetenido = retentionRows.reduce((s, r) => s + parseFloat(r.amount), 0)
  const retencionesNode = retentionRows.length
    ? `    <cfdi:Retenciones>
${retentionRows.map(r =>
      `      <cfdi:Retencion Impuesto="${SAT_IMPUESTO[r.tax_type]}" Importe="${parseFloat(r.amount).toFixed(2)}"/>`
    ).join('\n')}
    </cfdi:Retenciones>
`
    : ''
  const trasladosNode = taxGroups.size > 0
    ? `    <cfdi:Traslados>
${[...taxGroups.entries()].map(([tasa, g]) =>
      `      <cfdi:Traslado Base="${g.base.toFixed(2)}" Impuesto="002" TipoFactor="Tasa" TasaOCuota="${tasa}" Importe="${g.importe.toFixed(2)}"/>`
    ).join('\n')}
    </cfdi:Traslados>
`
    : ''
  const impuestosAttrs = [
    totalRetenido > 0 ? `TotalImpuestosRetenidos="${totalRetenido.toFixed(2)}"` : '',
    taxGroups.size > 0 ? `TotalImpuestosTrasladados="${iva}"` : '',
  ].filter(Boolean).join(' ')
  const impuestosGlobal = (taxGroups.size > 0 || retentionRows.length)
    ? `

  <cfdi:Impuestos ${impuestosAttrs}>
${retencionesNode}${trasladosNode}  </cfdi:Impuestos>`
    : ''

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
  </cfdi:Conceptos>${impuestosGlobal}

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
