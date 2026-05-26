'use strict'

const pdfParse = require('pdf-parse')
const logger   = require('../../config/logger')

/**
 * Detecta el tipo de archivo y extrae datos del documento.
 * Soporta: XML CFDI, PDF de factura, PDF de OC/remisión de proveedor.
 *
 * @param {Buffer} buffer - Contenido del archivo
 * @param {string} mimetype - 'text/xml', 'application/xml' o 'application/pdf'
 * @param {string} originalname - Nombre original del archivo
 * @returns {object} Datos extraídos para precargar en la recepción
 */
async function parseSupplierDocument(buffer, mimetype, originalname) {
  const isXML = mimetype.includes('xml') || originalname.toLowerCase().endsWith('.xml')
  const isPDF = mimetype === 'application/pdf' || originalname.toLowerCase().endsWith('.pdf')

  if (isXML) {
    return parseXMLCFDI(buffer)
  } else if (isPDF) {
    return parsePDF(buffer)
  } else {
    throw createError(400, 'Formato no soportado. Sube un XML (CFDI) o PDF.')
  }
}

// ─── XML CFDI ────────────────────────────────────────────────────────────────

/**
 * Parsea un XML de CFDI 4.0 o 3.3 del SAT.
 * Extrae: UUID, emisor, totales y conceptos (líneas).
 */
function parseXMLCFDI(buffer) {
  const xml = buffer.toString('utf8')

  // UUID
  const uuid = extractXMLAttr(xml, /TimbreFiscalDigital[^>]+UUID="([^"]+)"/i) ||
               extractXMLAttr(xml, /tfd:TimbreFiscalDigital[^>]+UUID="([^"]+)"/i)

  // Serie y folio
  const serie = extractXMLAttr(xml, /cfdi:Comprobante[^>]+Serie="([^"]+)"/i) ||
                extractXMLAttr(xml, /<Comprobante[^>]+Serie="([^"]+)"/i)
  const folio = extractXMLAttr(xml, /cfdi:Comprobante[^>]+Folio="([^"]+)"/i) ||
                extractXMLAttr(xml, /<Comprobante[^>]+Folio="([^"]+)"/i)

  // Fecha
  const fecha = extractXMLAttr(xml, /Comprobante[^>]+Fecha="([^"]+)"/i)
  const invoiceDate = fecha ? fecha.split('T')[0] : null

  // Totales
  const subtotal = parseFloat(extractXMLAttr(xml, /Comprobante[^>]+SubTotal="([^"]+)"/i) || '0')
  const total    = parseFloat(extractXMLAttr(xml, /Comprobante[^>]+Total="([^"]+)"/i) || '0')
  const tax      = parseFloat((total - subtotal).toFixed(2))

  // Moneda y tipo de cambio
  const currency     = extractXMLAttr(xml, /Comprobante[^>]+Moneda="([^"]+)"/i) || 'MXN'
  const exchangeRate = parseFloat(extractXMLAttr(xml, /Comprobante[^>]+TipoCambio="([^"]+)"/i) || '1')

  // Emisor (proveedor)
  const rfcEmisor     = extractXMLAttr(xml, /Emisor[^>]+Rfc="([^"]+)"/i)
  const nombreEmisor  = extractXMLAttr(xml, /Emisor[^>]+Nombre="([^"]+)"/i)
  const regimenEmisor = extractXMLAttr(xml, /Emisor[^>]+RegimenFiscal="([^"]+)"/i)

  // Receptor
  const rfcReceptor    = extractXMLAttr(xml, /Receptor[^>]+Rfc="([^"]+)"/i)
  const nombreReceptor = extractXMLAttr(xml, /Receptor[^>]+Nombre="([^"]+)"/i)

  // Conceptos (líneas)
  const lines = extractXMLConceptos(xml)

  const result = {
    documentType: 'xml_cfdi',
    uuid,
    serie,
    folio,
    invoiceDate,
    currency,
    exchangeRate: currency === 'MXN' ? null : exchangeRate,
    subtotal,
    tax,
    total,
    emisor: {
      rfc:    rfcEmisor,
      name:   nombreEmisor,
      regime: regimenEmisor,
    },
    receptor: {
      rfc:  rfcReceptor,
      name: nombreReceptor,
    },
    lines,
    method: 'xml',
  }

  logger.info('CFDI XML parsed', { uuid, rfcEmisor, total })
  return result
}

/**
 * Extrae todos los conceptos del XML CFDI.
 */
function extractXMLConceptos(xml) {
  const lines = []
  const conceptoRegex = /<(?:cfdi:)?Concepto\s([^>]+?)(?:\/>|>)/gi
  let match

  while ((match = conceptoRegex.exec(xml)) !== null) {
    const attrs = match[1]
    const qty         = parseFloat(extractAttrFromString(attrs, 'Cantidad') || '0')
    const unit        = extractAttrFromString(attrs, 'Unidad') || extractAttrFromString(attrs, 'ClaveUnidad') || ''
    const description = extractAttrFromString(attrs, 'Descripcion') || extractAttrFromString(attrs, 'Descripción') || ''
    const unitPrice   = parseFloat(extractAttrFromString(attrs, 'ValorUnitario') || '0')
    const amount      = parseFloat(extractAttrFromString(attrs, 'Importe') || '0')

    if (qty > 0 || description) {
      lines.push({ quantity: qty, unit, description, unitPrice, amount })
    }
  }

  return lines
}

function extractXMLAttr(xml, regex) {
  const match = xml.match(regex)
  return match ? match[1].trim() : null
}

function extractAttrFromString(str, attrName) {
  const regex = new RegExp(`${attrName}="([^"]*)"`, 'i')
  const match = str.match(regex)
  return match ? match[1] : null
}

// ─── PDF ─────────────────────────────────────────────────────────────────────

/**
 * Parsea un PDF de factura o remisión de proveedor.
 * Intenta extracción por texto primero, luego Claude API como fallback.
 */
async function parsePDF(buffer) {
  try {
    const result = await extractPDFByText(buffer)
    if (isPDFResultUsable(result)) {
      logger.info('Supplier PDF extracted by text parser')
      return { ...result, method: 'text' }
    }
    logger.info('PDF text extraction incomplete, trying AI fallback')
  } catch (err) {
    logger.warn('PDF text extraction failed', { error: err.message })
  }

  try {
    const result = await extractPDFByAI(buffer)
    logger.info('Supplier PDF extracted by AI')
    return { ...result, method: 'ai' }
  } catch (err) {
    logger.error('PDF AI extraction failed', { error: err.message })
    throw createError(422, 'No se pudo extraer la información del documento. Verifica que el archivo sea válido.')
  }
}

async function extractPDFByText(buffer) {
  const data = await pdfParse(buffer)
  const text = data.text

  // UUID SAT (si es PDF de factura con timbre)
  const uuid = text.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)?.[0] || null

  // RFC emisor
  const rfcMatch = text.match(/RFC[:\s]+([A-ZÑ&]{3,4}\d{6}[A-Z0-9]{3})/i)
  const rfc = rfcMatch ? rfcMatch[1].trim() : null

  // Totales
  const subtotalMatch = text.match(/subtotal[:\s$]*([0-9,]+\.?\d{0,2})/i)
  const totalMatch    = text.match(/total[:\s$]*([0-9,]+\.?\d{0,2})/i)
  const ivaMatch      = text.match(/(?:iva|impuesto)[:\s$]*([0-9,]+\.?\d{0,2})/i)

  const subtotal = subtotalMatch ? parseFloat(subtotalMatch[1].replace(/,/g, '')) : null
  const total    = totalMatch    ? parseFloat(totalMatch[1].replace(/,/g, ''))    : null
  const tax      = ivaMatch      ? parseFloat(ivaMatch[1].replace(/,/g, ''))      : null

  // Fecha
  const dateMatch = text.match(/fecha[:\s]+(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/i)
  const invoiceDate = dateMatch ? `${dateMatch[3]}-${dateMatch[2].padStart(2,'0')}-${dateMatch[1].padStart(2,'0')}` : null

  return {
    documentType: 'pdf',
    uuid,
    serie: null,
    folio: null,
    invoiceDate,
    currency: 'MXN',
    exchangeRate: null,
    subtotal,
    tax,
    total,
    emisor: { rfc, name: null, regime: null },
    receptor: { rfc: null, name: null },
    lines: [],
  }
}

async function extractPDFByAI(buffer) {
  const base64 = buffer.toString('base64')

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2000,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'document',
            source: { type: 'base64', media_type: 'application/pdf', data: base64 },
          },
          {
            type: 'text',
            text: `Extrae los datos de este documento (puede ser una factura, remisión o orden de compra de proveedor en México).
Responde ÚNICAMENTE con JSON válido, sin texto adicional, sin markdown:
{
  "documentType": "invoice | remission | purchase_order | unknown",
  "uuid": "UUID del timbre fiscal si existe, null si no",
  "serie": "serie del documento o null",
  "folio": "folio o número del documento o null",
  "invoiceDate": "fecha en formato YYYY-MM-DD o null",
  "currency": "MXN o USD",
  "exchangeRate": null,
  "subtotal": 0.00,
  "tax": 0.00,
  "total": 0.00,
  "emisor": {
    "rfc": "RFC del emisor/proveedor o null",
    "name": "Razón social del emisor/proveedor o null",
    "regime": "Régimen fiscal o null"
  },
  "receptor": {
    "rfc": "RFC del receptor o null",
    "name": "Razón social del receptor o null"
  },
  "lines": [
    {
      "quantity": 0.00,
      "unit": "kg | pza | caja | etc",
      "description": "descripción del concepto",
      "unitPrice": 0.00,
      "amount": 0.00
    }
  ]
}
Si algún dato no está disponible, usa null. Para números usa punto decimal.`,
          },
        ],
      }],
    }),
  })

  if (!response.ok) throw new Error(`Claude API error: ${response.status}`)

  const data = await response.json()
  const text = data.content?.[0]?.text || ''

  try {
    const clean = text.replace(/```json|```/g, '').trim()
    return JSON.parse(clean)
  } catch {
    throw new Error('Claude returned invalid JSON')
  }
}

function isPDFResultUsable(result) {
  return result.total !== null && result.total > 0
}

function createError(status, message) {
  const err = new Error(message)
  err.status = status
  return err
}

module.exports = { parseSupplierDocument }
