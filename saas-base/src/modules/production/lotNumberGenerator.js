'use strict'

/**
 * SaaS v2 — Generador de lot_numbers según patrón configurable.
 *
 * Función pura: dado un patrón string y un contexto, devuelve el lot_number
 * resultante reemplazando las variables.
 *
 * Variables soportadas (§4.5.1):
 *   {YYYY}  — Año 4 dígitos        ej. 2026
 *   {YY}    — Año 2 dígitos        ej. 26
 *   {MM}    — Mes 2 dígitos        ej. 05
 *   {DD}    — Día 2 dígitos        ej. 22
 *   {JJJ}   — Día juliano 3 dig    ej. 142
 *   {SHIFT} — Número de turno      ej. 2
 *   {LINE}  — Código de línea      ej. L1
 *   {SKU}   — SKU del producto     ej. PAL-MTQ-50G
 *   {SEQ}   — Secuencia (la pasa el caller, ej. 001)
 *
 * Variables NO encontradas en ctx se reemplazan por string vacío.
 *
 * Ejemplos:
 *   generate('{YYYY}{MM}{DD}-{SKU}-{SEQ}', {date: '2026-05-22', sku: 'PAL', seq: 1})
 *     → '20260522-PAL-001'
 *
 *   generate('LOT-{YYYY}{JJJ}-{LINE}-{SHIFT}', {date: '2026-05-22', line: 'L1', shift: 2})
 *     → 'LOT-2026142-L1-2'
 *
 *   generate('{SKU}/{YYYY}{MM}/{SEQ}', {date: '2026-05-22', sku: 'PAL-MTQ-50G', seq: 47})
 *     → 'PAL-MTQ-50G/202605/047'
 *
 * Validación: el lot_number resultante debe ser <= 60 chars (límite de la
 * columna raw_material_lots/product_lots.lot_number). Lanza si excede.
 *
 * Referencia: §4.5.1.
 */

const MAX_LOT_NUMBER_LENGTH = 60

const DEFAULT_PATTERN = '{YYYY}{MM}{DD}-{SKU}-{SEQ}'

/**
 * @param {string} pattern  Plantilla con placeholders {VAR}.
 * @param {object} ctx
 * @param {Date|string} [ctx.date]   Fecha de producción. Acepta Date o ISO string. Default: new Date().
 * @param {number|string} [ctx.shift] Número de turno.
 * @param {string} [ctx.line]         Código de línea.
 * @param {string} [ctx.sku]          SKU del producto.
 * @param {number} [ctx.seq]          Secuencia entera (typically diaria por producto). Se zero-padea a 3 dígitos por default.
 * @param {number} [ctx.seqPadding]   Override de padding para {SEQ}. Default: 3.
 *
 * @returns {string}  El lot_number generado.
 */
function generate(pattern, ctx = {}) {
  if (typeof pattern !== 'string' || pattern.trim().length === 0) {
    throw new Error('pattern debe ser un string no vacío.')
  }

  const date = parseDate(ctx.date)
  const yyyy = String(date.getUTCFullYear())
  const yy   = yyyy.slice(-2)
  const mm   = String(date.getUTCMonth() + 1).padStart(2, '0')
  const dd   = String(date.getUTCDate()).padStart(2, '0')
  const jjj  = String(julianDayOfYear(date)).padStart(3, '0')

  const seqPadding = Number.isInteger(ctx.seqPadding) && ctx.seqPadding > 0 ? ctx.seqPadding : 3
  const seq = ctx.seq !== undefined && ctx.seq !== null
    ? String(ctx.seq).padStart(seqPadding, '0')
    : ''

  const shift = ctx.shift !== undefined && ctx.shift !== null ? String(ctx.shift) : ''
  const line  = ctx.line  || ''
  const sku   = ctx.sku   || ''

  const vars = {
    YYYY: yyyy,
    YY:   yy,
    MM:   mm,
    DD:   dd,
    JJJ:  jjj,
    SHIFT: shift,
    LINE:  line,
    SKU:   sku,
    SEQ:   seq,
  }

  // Reemplazo de placeholders. Solo reconoce {WORD} con UPPER+dígitos.
  const result = pattern.replace(/\{([A-Z][A-Z0-9_]*)\}/g, (match, varName) => {
    return vars[varName] !== undefined ? vars[varName] : ''
  })

  if (result.length === 0) {
    throw new Error('El lot_number resultante quedó vacío. Verifica el patrón y el contexto.')
  }
  if (result.length > MAX_LOT_NUMBER_LENGTH) {
    throw new Error(`El lot_number resultante (${result.length} chars) excede el máximo de ${MAX_LOT_NUMBER_LENGTH}. Pattern: "${pattern}".`)
  }

  return result
}

/**
 * Lista las variables soportadas — útil para UI de configuración del patrón.
 */
function supportedVariables() {
  return ['YYYY', 'YY', 'MM', 'DD', 'JJJ', 'SHIFT', 'LINE', 'SKU', 'SEQ']
}

// ─── Helpers ─────────────────────────────────────────────────────────────

function parseDate(input) {
  if (input === undefined || input === null) return new Date()
  if (input instanceof Date) {
    if (isNaN(input.getTime())) throw new Error('ctx.date inválido.')
    return input
  }
  const d = new Date(input)
  if (isNaN(d.getTime())) throw new Error('ctx.date inválido.')
  return d
}

function julianDayOfYear(date) {
  const start = Date.UTC(date.getUTCFullYear(), 0, 0)
  const diff  = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) - start
  return Math.floor(diff / 86400000)
}

module.exports = {
  generate,
  supportedVariables,
  DEFAULT_PATTERN,
  MAX_LOT_NUMBER_LENGTH,
}
