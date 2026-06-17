'use strict'

const { PDFParse } = require('pdf-parse')
const logger       = require('../../config/logger')

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
 *
 * Estrategia: la IA (Claude leyendo el PDF) es el camino BUENO — saca los
 * CONCEPTOS/líneas además de totales y emisor, que es lo que la conciliación
 * necesita. La extracción por texto casi nunca recupera las líneas, así que la
 * usamos solo como red de seguridad cuando NO hay API key o la IA falla, para
 * que el modal abra con los totales que se hayan podido leer en vez de reventar.
 */
async function parsePDF(buffer) {
  // 1. Texto (barato, sin red). Sirve de respaldo si la IA no está disponible.
  let textResult = null
  try {
    textResult = await extractPDFByText(buffer)
  } catch (err) {
    logger.warn('PDF text extraction failed', { error: err.message })
  }

  // 2. IA (Claude) — solo si hay API key configurada. Extracción rica con líneas.
  if (process.env.ANTHROPIC_API_KEY) {
    try {
      const result = await extractPDFByAI(buffer)
      logger.info('Supplier PDF extracted by AI')
      return { ...result, method: 'ai' }
    } catch (err) {
      logger.error('PDF AI extraction failed', { error: err.message })
      // cae al resultado por texto (si lo hay) en vez de abortar
    }
  } else {
    logger.info('ANTHROPIC_API_KEY no configurada — extracción de PDF solo por texto')
  }

  // 3. Sin IA (o falló): devolver lo que el texto haya logrado para completar a mano.
  if (textResult && isPDFResultUsable(textResult)) {
    logger.info('Supplier PDF extracted by text parser')
    return { ...textResult, method: 'text' }
  }

  throw createError(422, process.env.ANTHROPIC_API_KEY
    ? 'No se pudo extraer la información del PDF. Verifica que el archivo sea válido o sube el XML (CFDI).'
    : 'No se pudieron leer los datos del PDF. Sube el XML (CFDI) o configura ANTHROPIC_API_KEY para extracción con IA.')
}

async function extractPDFByText(buffer) {
  // pdf-parse v2 exporta la clase PDFParse (la API vieja `pdfParse(buffer)` ya no
  // existe → tronaba siempre). Mismo uso que business-partners/csfService.
  const parser = new PDFParse({ data: buffer })
  const data = await parser.getText()
  const text = data?.text || ''

  // UUID SAT (si es PDF de factura con timbre)
  const uuid = text.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)?.[0] || null

  // RFC emisor
  const rfcMatch = text.match(/RFC[:\s]+([A-ZÑ&]{3,4}\d{6}[A-Z0-9]{3})/i)
  const rfc = rfcMatch ? rfcMatch[1].trim() : null

  // Totales
  const subtotalMatch = text.match(/subtotal[:\s$]*([0-9,]+\.?\d{0,2})/i)
  // \b evita que "total" haga match DENTRO de "Subtotal" (ahí no hay frontera de
  // palabra antes de "total") y tome el subtotal por equivocación.
  const totalMatch    = text.match(/\btotal[:\s$]*([0-9,]+\.?\d{0,2})/i)
  const ivaMatch      = text.match(/(?:iva|impuesto)[:\s$]*([0-9,]+\.?\d{0,2})/i)

  const subtotal = subtotalMatch ? parseFloat(subtotalMatch[1].replace(/,/g, '')) : null
  const total    = totalMatch    ? parseFloat(totalMatch[1].replace(/,/g, ''))    : null
  const tax      = ivaMatch      ? parseFloat(ivaMatch[1].replace(/,/g, ''))      : null

  // Fecha
  const dateMatch = text.match(/fecha[:\s]+(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/i)
  const invoiceDate = dateMatch ? `${dateMatch[3]}-${dateMatch[2].padStart(2,'0')}-${dateMatch[1].padStart(2,'0')}` : null

  // Serie y folio (best-effort; varía mucho por proveedor). Evitamos confundir el
  // "Folio Fiscal" (que es el UUID) con el folio comercial.
  const serie = text.match(/\bserie[:\s]*([A-Z0-9-]{1,10})\b/i)?.[1]?.trim() || null
  const folioMatch = text.match(/\bfolio(?!\s*fiscal)[:\s]*([A-Z0-9-]{1,40})\b/i)
  const folio = folioMatch ? folioMatch[1].trim() : null

  // Nombre / razón social del emisor (best-effort, en orden de confiabilidad):
  //   1) ETIQUETA explícita del emisor ("Nombre del Emisor:", "Razón Social:") →
  //      funciona para persona FÍSICA y MORAL (la física no trae sufijo societario).
  //   2) una línea con SUFIJO societario (SA de CV, S de RL, SAPI, SC, SAS…) que
  //      CIERRE la línea → atrapa MORALES cuando el PDF no rotula al emisor.
  // En ambos casos se descarta el boilerplate fiscal del CFDI impreso. Antes un
  // regex laxo tomaba "…del SAT" como razón social (la "SA" de "SAT" + cola de 20
  // chars): ahora el sufijo debe CERRAR la línea (en "SAT" la "T" lo impide) y se
  // saltan las líneas de boilerplate. El guarda de "sello" es específico para NO
  // excluir razones sociales legítimas como "… SELLOS METÁLICOS SA DE CV".
  const BOILERPLATE = /cadena\s+original|sello\s+(?:digital|del)|certificaci[oó]n|complemento|timbre|folio\s+fiscal|\bSAT\b|r[eé]gimen|uso\s+cfdi|m[eé]todo\s+de\s+pago|forma\s+de\s+pago|representaci[oó]n\s+impresa/i
  // Limpia un valor capturado: corta colas (RFC/Régimen/CP que la etiqueta arrastró
  // en la misma línea), normaliza espacios y rechaza boilerplate / valores no-nombre.
  const cleanName = (v) => {
    if (!v) return null
    let s = String(v).replace(/^\s*[A-ZÑ&]{3,4}\d{6}[A-Z0-9]{3}\s*/i, '')           // RFC al inicio
                     .split(/\s+(?:R\.?F\.?C\.?|R[EÉ]GIMEN|R[EÉ]G\.?|C\.?P\.?|TEL)\b/i)[0]
    s = s.replace(/\s+/g, ' ').trim().replace(/[:\-\s]+$/, '')
    if (s.length < 3 || s.length > 80) return null
    if (!/[A-Za-zÁÉÍÓÚÑáéíóúñ]/.test(s)) return null
    if (BOILERPLATE.test(s)) return null
    return s
  }

  // 1) Por etiqueta del emisor (campos de NOMBRE/razón social → no traen RFC).
  const LABELED = [
    /nombre\s*(?:o\s*raz[oó]n\s*social)?\s*del?\s*emisor\s*[:\-]\s*([^\n]{3,90})/i,
    /raz[oó]n\s*social\s*del?\s*emisor\s*[:\-]\s*([^\n]{3,90})/i,
    /raz[oó]n\s*social\s*[:\-]\s*([^\n]{3,90})/i,
  ]
  let emisorName = null
  for (const re of LABELED) {
    const cand = cleanName(text.match(re)?.[1])
    if (cand) { emisorName = cand; break }
  }

  // 2) Por sufijo societario (morales sin etiqueta).
  if (!emisorName) {
    const SOC_SUFFIX = /\bS(?:\.?\s*A\.?\s*P\.?\s*I\.?|\.?\s*A\.?\s*S\.?|\.?\s*A\.?|\.?\s*C\.?|\.?\s*DE\s*R\.?\s*L\.?)(?:\s*DE\s*C\.?\s*V\.?)?\.?\s*$/i
    for (const raw of text.split('\n')) {
      const line = raw.replace(/\s+/g, ' ').trim()
      if (line.length < 3 || line.length > 80) continue
      if (BOILERPLATE.test(line)) continue
      if (SOC_SUFFIX.test(line)) { emisorName = line; break }
    }
  }

  // Moneda: por defecto MXN, pero si el texto menciona USD/dólares lo marcamos.
  const currency = /\b(USD|d[oó]lares?|dolar)\b/i.test(text) ? 'USD' : 'MXN'

  return {
    documentType: 'pdf',
    uuid,
    serie,
    folio,
    invoiceDate,
    currency,
    exchangeRate: null,
    subtotal,
    tax,
    total,
    emisor: { rfc, name: emisorName, regime: null },
    receptor: { rfc: null, name: null },
    lines: [],
  }
}

async function extractPDFByAI(buffer) {
  // Mismo patrón que business-partners/csfService.extractByAI (el que SÍ funciona
  // en prod): la API de Anthropic exige x-api-key + anthropic-version. Antes
  // faltaban ambos headers y la key → 401 siempre → la extracción por IA era
  // código muerto y todo PDF caía a "no se pudo extraer".
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY no configurada')

  const base64 = buffer.toString('base64')

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
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
