'use strict'

const { PDFParse } = require('pdf-parse')
const logger = require('../../config/logger')

/**
 * Extrae datos fiscales de una Constancia de Situación Fiscal (CSF) del SAT.
 *
 * Estrategia en cascada:
 *   1) pdf-parse (JS puro, sin dependencias externas) → parser regex.
 *   2) Si el PDF no contiene texto (escaneado) o el regex no encontró datos
 *      suficientes, fallback a Claude API con visión.
 *   3) Si Claude no está configurado y el path 1 falló, error claro.
 */
async function extractCSF(buffer) {
  let extractedText = ''
  let textErrorMsg = null

  // Intento 1: extracción por texto vía pdf-parse
  try {
    extractedText = await extractTextWithPdfParse(buffer)
    if (extractedText && extractedText.length > 100) {
      const result = parseCSFText(extractedText)
      if (isComplete(result)) {
        logger.info('CSF extracted by pdf-parse text parser')
        return { ...result, method: 'text' }
      }
      logger.info('CSF text extraction incomplete — trying AI fallback', { result })
    } else {
      textErrorMsg = 'El PDF no contiene texto extraíble (posible imagen escaneada).'
      logger.info('CSF text extraction returned empty text', { length: extractedText?.length || 0 })
    }
  } catch (err) {
    textErrorMsg = err.message
    logger.warn('CSF text extraction failed', { error: err.message })
  }

  // Intento 2: Claude API con visión
  if (!process.env.ANTHROPIC_API_KEY) {
    throw createError(422,
      textErrorMsg
        ? `${textErrorMsg} Configura ANTHROPIC_API_KEY para usar análisis con IA, o sube un PDF de CSF nativo del SAT.`
        : 'No se encontraron datos clave (RFC, nombre, régimen). Verifica que sea una CSF válida o configura ANTHROPIC_API_KEY para análisis con IA.'
    )
  }

  try {
    const result = await extractByAI(buffer)
    logger.info('CSF extracted by AI')
    return { ...result, method: 'ai' }
  } catch (err) {
    logger.error('CSF AI extraction failed', { error: err.message })
    throw createError(422, `No se pudo extraer la CSF (texto: ${textErrorMsg || 'parser incompleto'}; IA: ${err.message}).`)
  }
}

/**
 * Extrae texto del PDF usando pdf-parse (lib JS pura, cross-platform).
 */
async function extractTextWithPdfParse(buffer) {
  const parser = new PDFParse({ data: buffer })
  const result = await parser.getText()
  return result?.text || ''
}

/**
 * Parsea el texto extraído del PDF del SAT.
 * Patrones ajustados al formato real donde valores están en líneas separadas.
 *
 * Persona física (RFC 13 chars) y persona moral (12 chars) tienen secciones
 * diferentes; extraemos RFC primero para decidir qué patrón de nombre usar.
 */
function parseCSFText(text) {
  const rfc = extractRFC(text)
  const personType = rfc?.length === 13 ? 'fisica'
                   : rfc?.length === 12 ? 'moral'
                   : null
  const regime = extractTaxRegime(text)
  return {
    rfc,
    name:           extractName(text, personType),
    taxRegime:      regime.text,
    taxRegimeCode:  regime.code,
    zipCode:        extractZipCode(text),
    address:        extractAddress(text),
    city:           extractCity(text),
    state:          extractState(text),
    neighborhood:   extractNeighborhood(text),
    issuedAt:       extractIssuedAt(text),
  }
}

// ─── Helpers de extracción ────────────────────────────────────────────────────

function extractRFC(text) {
  const m1 = text.match(/^([A-ZÑ&]{3,4}\d{6}[A-Z0-9]{3})$/m)
  if (m1) return m1[1].trim()
  const m2 = text.match(/RFC[:\s]+([A-ZÑ&]{3,4}\d{6}[A-Z0-9]{3})/i)
  if (m2) return m2[1].trim()
  return null
}

/**
 * `personType`:
 *   - 'fisica' → arma nombre desde Nombre(s) + Apellidos. NUNCA usa
 *     "Nombre Comercial" porque en CSF de persona física ese campo no
 *     existe y el regex captura accidentalmente el header del bloque
 *     siguiente ("Datos del domicilio registrado").
 *   - 'moral'  → usa Denominación/Razón Social. Nombre Comercial es
 *     fallback solo si está claramente presente.
 *   - null     → intenta ambos en orden, con guard anti-header.
 */
function extractName(text, personType = null) {
  // Persona física: armar siempre desde Nombre + Apellidos.
  if (personType === 'fisica') {
    const fis = nombrePersonaFisica(text)
    if (fis) return fis
    // Sin nombres extraíbles, dejar null (mejor que tomar un header como nombre).
    return null
  }

  // Persona moral: Denominación/Razón Social primero.
  if (personType === 'moral') {
    const razon = extractByLabel(text, /Denominaci[oó]n\/Raz[oó]n Social/i)
    if (razon) return razon
    const comercial = extractByLabel(text, /Nombre Comercial/i)
    if (comercial) return comercial
    return null
  }

  // Sin tipo definido: probar todos los patrones con guard anti-header.
  const candidates = [
    extractByLabel(text, /Denominaci[oó]n\/Raz[oó]n Social/i),
    extractByLabel(text, /Nombre Comercial/i),
    nombrePersonaFisica(text),
  ]
  return candidates.find(Boolean) || null
}

/**
 * Extrae el valor que sigue a un label, ya sea en la misma línea o en la
 * siguiente. Descarta capturas que parecen ser otro header (terminan con `:`,
 * o son un texto conocido de sección).
 */
function extractByLabel(text, labelRegex) {
  // Mismo renglón: "Label: VALOR"
  const same = text.match(new RegExp(labelRegex.source + `:\\s*([^\\n]+)`, labelRegex.flags))
  if (same && !looksLikeHeader(same[1])) return same[1].trim()
  // Siguiente renglón: "Label:\n VALOR"
  const next = text.match(new RegExp(labelRegex.source + `:\\s*\\n\\s*([^\\n]+)`, labelRegex.flags))
  if (next && !looksLikeHeader(next[1])) return next[1].trim()
  return null
}

function looksLikeHeader(raw) {
  if (!raw) return true
  const s = raw.trim()
  if (!s) return true
  if (s.endsWith(':')) return true
  // Headers conocidos del CSF que pueden colarse cuando el campo está vacío.
  const KNOWN_HEADERS = [
    /^Datos del domicilio/i,
    /^Datos de Identificaci/i,
    /^Reg[ií]menes?$/i,
    /^Fecha/i,
    /^Tipo de Persona/i,
    /^CURP/i,
    /^RFC/i,
  ]
  return KNOWN_HEADERS.some(re => re.test(s))
}

function nombrePersonaFisica(text) {
  // SAT a veces escribe "Nombre (s):" con espacio antes del paréntesis
  const nombres   = text.match(/Nombre\s*\(s\):\s*\n?\s*([^\n]+)/i)
  const apellido1 = text.match(/Primer Apellido:\s*\n?\s*([^\n]+)/i)
  const apellido2 = text.match(/Segundo Apellido:\s*\n?\s*([^\n]+)/i)
  const partes = [
    nombres   && !looksLikeHeader(nombres[1])   ? nombres[1].trim()   : null,
    apellido1 && !looksLikeHeader(apellido1[1]) ? apellido1[1].trim() : null,
    apellido2 && !looksLikeHeader(apellido2[1]) ? apellido2[1].trim() : null,
  ].filter(Boolean)
  return partes.length >= 2 ? partes.join(' ') : null
}

/**
 * Patrones de régimen fiscal SAT conocidos. Texto literal que aparece en
 * la CSF. Búsqueda con flag `i` (case-insensitive) y sin acentos opcionales.
 *
 * El orden importa: ponemos los más específicos primero para evitar que
 * "Régimen General de Ley Personas Morales" matchee con "Régimen General"
 * de algún otro régimen genérico.
 */
// Mapeo de patrones de régimen a código SAT. Orden importa: los más
// específicos primero para evitar matches parciales (ej. "Incorporación
// Fiscal" tiene que evaluarse antes que "Régimen de Sueldos").
const REGIME_PATTERNS = [
  { code: '601', pattern: /R[eé]gimen General de Ley Personas Morales/i },
  { code: '603', pattern: /Personas Morales con Fines no Lucrativos/i },
  { code: '605', pattern: /Sueldos y Salarios e Ingresos Asimilados/i },
  { code: '605', pattern: /R[eé]gimen de Sueldos y Salarios/i },
  { code: '606', pattern: /R[eé]gimen de Arrendamiento/i },
  { code: '606', pattern: /^\s*Arrendamiento\s*$/im },
  { code: '607', pattern: /Enajenaci[oó]n o Adquisici[oó]n de Bienes/i },
  { code: '608', pattern: /Dem[aá]s ingresos/i },
  { code: '609', pattern: /Consolidaci[oó]n/i },
  { code: '610', pattern: /Residentes en el Extranjero/i },
  { code: '611', pattern: /R[eé]gimen de los ingresos por dividendos/i },
  { code: '611', pattern: /Ingresos por Dividendos/i },
  { code: '612', pattern: /R[eé]gimen de las? Personas? F[ií]sicas? con Actividades Empresariales y Profesionales/i },
  { code: '612', pattern: /Personas F[ií]sicas con Actividades Empresariales/i },
  { code: '614', pattern: /R[eé]gimen de los ingresos por intereses/i },
  { code: '614', pattern: /Ingresos por intereses/i },
  { code: '615', pattern: /Ingresos por obtenci[oó]n de premios/i },
  { code: '616', pattern: /Sin obligaciones fiscales/i },
  { code: '620', pattern: /Sociedades Cooperativas de Producci[oó]n/i },
  { code: '621', pattern: /R[eé]gimen de Incorporaci[oó]n Fiscal/i },
  { code: '621', pattern: /Incorporaci[oó]n Fiscal/i },
  { code: '622', pattern: /Actividades Agr[ií]colas,? Ganaderas,? Silv[ií]colas/i },
  { code: '623', pattern: /Opcional para Grupos de Sociedades/i },
  { code: '624', pattern: /Coordinados/i },
  { code: '625', pattern: /R[eé]gimen de las Actividades Empresariales con ingresos por Plataformas Tecnol[oó]gicas/i },
  { code: '625', pattern: /Plataformas Tecnol[oó]gicas/i },
  { code: '626', pattern: /R[eé]gimen Simplificado de Confianza/i },
  { code: '626', pattern: /\bRESICO\b/i },
]

/**
 * Aísla la sección "Regímenes" de la CSF para buscar SOLO ahí.
 *
 * Las CSF traen el texto "Régimen General de Ley Personas Morales" y similares
 * en disclaimers, instrucciones o boilerplate del SAT que NO son el régimen
 * del contribuyente. Si escaneamos todo el texto, esos falsos positivos
 * ganan al verdadero régimen del contribuyente (que está en la sección
 * "Regímenes Registrados").
 *
 * La sección típica:
 *   Regímenes [Registrados]
 *   Régimen        Fecha Inicio    Fecha Fin
 *   <régimen 1>    DD/MM/YYYY      DD/MM/YYYY      ← histórico (con fin)
 *   <régimen 2>    DD/MM/YYYY                      ← vigente (sin fin)
 *
 *   [Obligaciones | siguiente sección]
 */
function extractRegimesSection(text) {
  const lines = text.split('\n').map(l => l.trim())
  const startIdx = lines.findIndex(l => /^Reg[ií]menes(\s+Registrados)?:?\s*$/i.test(l))
  if (startIdx < 0) return null
  // Buscar dónde termina la sección. Heurística: siguiente header conocido,
  // o un bloque de 3 líneas vacías, o 30 líneas como tope duro.
  const endHeaders = /^(Obligaciones|Datos de Identificaci[oó]n|Domicilio|Caracter[ií]sticas Fiscales)/i
  let endIdx = lines.length
  let blankRun = 0
  for (let i = startIdx + 1; i < Math.min(startIdx + 30, lines.length); i++) {
    if (endHeaders.test(lines[i])) { endIdx = i; break }
    if (lines[i] === '') { blankRun++; if (blankRun >= 3) { endIdx = i; break } }
    else { blankRun = 0 }
  }
  return lines.slice(startIdx + 1, endIdx)
}

/**
 * Aplica los REGIME_PATTERNS a un conjunto de líneas. Si hay varios matches,
 * prefiere el que esté en una línea "vigente" (la siguiente línea o la misma
 * no tiene fecha de fin completa). Si no se puede determinar, devuelve el
 * último match (la CSF suele listar primero los regímenes históricos y al
 * final los actuales).
 */
function matchRegimeInLines(lines) {
  const matches = []
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]
    if (!l) continue
    if (/^R[eé]gimen$/i.test(l)) continue
    if (/^Fecha (Inicio|Fin|de)\b/i.test(l)) continue
    if (/^\d{2}[\/\-]\d{2}[\/\-]\d{4}$/.test(l)) continue
    if (/^\d{4}[\/\-]\d{2}[\/\-]\d{2}$/.test(l)) continue

    // Código SAT al inicio de la línea (formato moderno)
    const codeMatch = l.match(/^(\d{3})\b/)
    if (codeMatch && REGIME_PATTERNS.some(r => r.code === codeMatch[1])) {
      matches.push({ text: l, code: codeMatch[1], lineIdx: i, raw: l })
      continue
    }
    for (const { code, pattern } of REGIME_PATTERNS) {
      if (pattern.test(l)) {
        matches.push({ text: l, code, lineIdx: i, raw: l })
        break
      }
    }
  }
  if (matches.length === 0) return null
  if (matches.length === 1) return matches[0]

  // Heurística "vigente": una línea con DOS fechas completas (DD/MM/YYYY o
  // YYYY-MM-DD) probablemente es un régimen histórico (tiene fecha de fin).
  // Una línea con UNA sola fecha (o ninguna) es probablemente vigente.
  const dateRe = /(\d{2}[\/\-]\d{2}[\/\-]\d{4}|\d{4}[\/\-]\d{2}[\/\-]\d{2})/g
  const scored = matches.map(m => {
    const lineDates = (m.raw.match(dateRe) || []).length
    const nextLineDates = (lines[m.lineIdx + 1]?.match(dateRe) || []).length
    const totalDates = lineDates + nextLineDates
    // Más fechas = más probable que sea histórico (penaliza)
    return { ...m, score: -totalDates }
  })
  // El último match con score más alto gana (último por convención SAT
  // pone al final el régimen vigente).
  scored.sort((a, b) => (b.score - a.score) || (b.lineIdx - a.lineIdx))
  return scored[0]
}

/**
 * Devuelve { text, code } del régimen detectado en la CSF, o { text:null, code:null }.
 *
 * Estrategia (en orden de preferencia):
 *  1) Buscar SOLO en la sección "Regímenes" del PDF. Esto evita falsos
 *     positivos de boilerplate SAT en otras secciones (ej. instrucciones
 *     que mencionan "Régimen General de Ley Personas Morales" como ejemplo).
 *  2) Si hay varios regímenes en esa sección, preferir el vigente (sin
 *     fecha de fin) y/o el último (convención SAT: histórico arriba, actual abajo).
 *  3) Solo si NO hay sección "Regímenes" identificable, escanear el texto
 *     completo como último recurso (CSFs antiguas o con layout corrupto).
 */
function extractTaxRegime(text) {
  const sectionLines = extractRegimesSection(text)
  if (sectionLines && sectionLines.length > 0) {
    const match = matchRegimeInLines(sectionLines)
    if (match) return { text: match.text, code: match.code }
  }
  // Fallback global: solo si no encontramos la sección.
  for (const { code, pattern } of REGIME_PATTERNS) {
    const m = text.match(pattern)
    if (m) return { text: m[0].trim(), code }
  }
  return { text: null, code: null }
}

function extractZipCode(text) {
  const m = text.match(/C[oó]digo Postal:?\s*(\d{5})/i)
  return m ? m[1] : null
}

function extractAddress(text) {
  const vialidad = text.match(/Nombre de Vialidad:\s*([^\n]+)/i)
  const numExt   = text.match(/N[uú]mero Exterior:\s*([^\n]+)/i)
  const numInt   = text.match(/N[uú]mero Interior:\s*([^\n\s][^\n]+)/i)
  if (vialidad) {
    return [
      vialidad[1].trim(),
      numExt?.[1]?.trim() || '',
      numInt?.[1]?.trim() ? `INT ${numInt[1].trim()}` : '',
    ].filter(Boolean).join(' ')
  }
  const m = text.match(/Domicilio[:\s]+([^\n]+)/i)
  return m ? m[1].trim() : null
}

function extractCity(text) {
  const m = text.match(/Nombre del Municipio o Demarcaci[oó]n Territorial:\s*([^\n]+)/i)
  return m ? m[1].trim() : null
}

function extractState(text) {
  const m = text.match(/Nombre de la Entidad Federativa:\s*([^\n]+)/i)
  return m ? normalizeState(m[1].trim()) : null
}

function extractNeighborhood(text) {
  const m = text.match(/Nombre de la Colonia:\s*([^\n]+)/i)
  return m ? m[1].trim() : null
}

function extractIssuedAt(text) {
  const MESES = {
    'ENERO':'01','FEBRERO':'02','MARZO':'03','ABRIL':'04',
    'MAYO':'05','JUNIO':'06','JULIO':'07','AGOSTO':'08',
    'SEPTIEMBRE':'09','OCTUBRE':'10','NOVIEMBRE':'11','DICIEMBRE':'12',
  }
  // Formato partido en dos líneas: "A 02 DE ABRIL\nDE 2026"
  const m1 = text.match(/A\s+(\d{1,2})\s+DE\s+([A-ZÁÉÍÓÚ]+)\s*\nDE\s+(\d{4})/i)
  if (m1) {
    const mes = MESES[m1[2].toUpperCase()]
    if (mes) return `${m1[3]}-${mes}-${m1[1].padStart(2, '0')}`
  }
  // Una sola línea: "02 DE ABRIL DE 2026"
  const m2 = text.match(/(\d{1,2})\s+DE\s+([A-ZÁÉÍÓÚ]+)\s+DE\s+(\d{4})/i)
  if (m2) {
    const mes = MESES[m2[2].toUpperCase()]
    if (mes) return `${m2[3]}-${mes}-${m2[1].padStart(2, '0')}`
  }
  // Formato numérico DD/MM/YYYY
  const m3 = text.match(/Fecha de emisi[oó]n[:\s]+(\d{2})[\/\-](\d{2})[\/\-](\d{4})/i)
  if (m3) return `${m3[3]}-${m3[2]}-${m3[1]}`
  return null
}

function normalizeState(raw) {
  const map = {
    'MICHOACAN DE OCAMPO':             'Michoacán',
    'CIUDAD DE MEXICO':                'Ciudad de México',
    'ESTADO DE MEXICO':                'México',
    'MEXICO':                          'México',
    'NUEVO LEON':                      'Nuevo León',
    'SAN LUIS POTOSI':                 'San Luis Potosí',
    'QUERETARO':                       'Querétaro',
    'YUCATAN':                         'Yucatán',
    'BAJA CALIFORNIA SUR':             'Baja California Sur',
    'QUINTANA ROO':                    'Quintana Roo',
    'COAHUILA DE ZARAGOZA':            'Coahuila',
    'COAHUILA':                        'Coahuila',
    'VERACRUZ DE IGNACIO DE LA LLAVE': 'Veracruz',
    'VERACRUZ':                        'Veracruz',
  }
  const upper = raw.toUpperCase().trim()
  return map[upper] || raw
}

// ─── Extracción por AI ────────────────────────────────────────────────────────

async function extractByAI(buffer) {
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
      max_tokens: 1000,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'document',
            source: { type: 'base64', media_type: 'application/pdf', data: base64 },
          },
          {
            type: 'text',
            text: `Extrae los siguientes datos de esta Constancia de Situación Fiscal del SAT de México.
Responde ÚNICAMENTE con JSON válido, sin texto adicional, sin markdown:
{
  "rfc": "RFC completo",
  "name": "Razón social o nombre completo (usar Nombre Comercial si existe)",
  "taxRegime": "Régimen fiscal completo (primera línea de la sección Regímenes)",
  "zipCode": "Código postal fiscal de 5 dígitos",
  "address": "Nombre de Vialidad más Número Exterior",
  "city": "Nombre del Municipio o Demarcación Territorial",
  "state": "Nombre de la Entidad Federativa",
  "neighborhood": "Nombre de la Colonia",
  "issuedAt": "Fecha de emisión en formato YYYY-MM-DD"
}
Si algún dato no está disponible, usa null.`,
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

// ─── Utilidades ───────────────────────────────────────────────────────────────

function isComplete(result) {
  return !!(result.rfc && result.name && (result.zipCode || result.taxRegime))
}

function validateCSFVigency(issuedAt) {
  if (!issuedAt) return { isValid: false, daysOld: null, message: 'Fecha de emisión no encontrada.' }
  const issued  = new Date(issuedAt)
  const now     = new Date()
  const daysOld = Math.floor((now - issued) / (1000 * 60 * 60 * 24))
  const isValid = daysOld <= 90
  return {
    isValid,
    daysOld,
    message: isValid
      ? `CSF vigente — emitida hace ${daysOld} días`
      : `CSF vencida — emitida hace ${daysOld} días (máximo 90 días)`,
  }
}

function inferPersonType(rfc) {
  if (!rfc) return null
  return rfc.length === 13 ? 'fisica' : 'moral'
}

function createError(status, message) {
  const err = new Error(message)
  err.status = status
  return err
}

module.exports = { extractCSF, validateCSFVigency, inferPersonType, extractTaxRegime }
