'use strict'

/**
 * Tratamiento fiscal de una línea de factura (CFDI 4.0).
 *
 * Centraliza la lógica que antes estaba hardcodeada a "IVA Tasa 16%" en
 * stampService y xmlService. A partir de `objeto_imp` + `tax_factor` +
 * `tax_rate` de la línea decide qué impuestos lleva.
 *
 * Combinaciones soportadas (las que ofrece el menú "Tratamiento de IVA"):
 *   - objeto 02 · Tasa · 16  → IVA general
 *   - objeto 02 · Tasa · 8   → IVA región fronteriza
 *   - objeto 02 · Tasa · 0   → IVA tasa cero (aguacate, caña, alimentos, agro)
 *   - objeto 02 · Exento     → exento (sin tasa)
 *   - objeto 01 · (n/a)      → no objeto de impuesto (sin desglose)
 */

const VALID_FACTORS = ['Tasa', 'Cuota', 'Exento']

/**
 * Normaliza el tratamiento fiscal de una línea a una forma predecible.
 * @returns {{ objetoImp: string, factor: string, ratePct: number }}
 */
function normalizeLineTax(line = {}) {
  const objetoImp = String(line.objeto_imp || '02')
  let factor = line.tax_factor || 'Tasa'
  if (!VALID_FACTORS.includes(factor)) factor = 'Tasa'
  // La tasa va en porcentaje (16, 8, 0). Para Exento no aplica.
  const raw = line.tax_rate != null ? parseFloat(line.tax_rate) : 16
  const ratePct = factor === 'Exento' ? 0 : (Number.isFinite(raw) ? raw : 16)
  return { objetoImp, factor, ratePct }
}

/**
 * Arreglo `taxes` para el payload de Facturapi.
 *   - objeto '01' (no objeto) → sin impuestos. Facturapi deriva ObjetoImp=01.
 *   - factor 'Exento'         → IVA factor Exento (sin tasa).
 *   - factor 'Tasa'           → IVA factor Tasa con tasa (0 = tasa cero válida).
 *
 * Nota: el menú amigable no ofrece objeto '03' (sí objeto, sin desglose); si
 * llegara desde el dropdown avanzado se trata como sin desglose (taxes vacío).
 */
function buildFacturapiTaxes(line = {}) {
  const { objetoImp, factor, ratePct } = normalizeLineTax(line)
  if (objetoImp === '01' || objetoImp === '03') return []
  if (factor === 'Exento') return [{ type: 'IVA', factor: 'Exento' }]
  return [{ type: 'IVA', factor: 'Tasa', rate: ratePct / 100 }]
}

/** ¿La línea causa IVA trasladado? (para sumar el impuesto del comprobante) */
function lineCausesTax(line = {}) {
  const { objetoImp, factor, ratePct } = normalizeLineTax(line)
  if (objetoImp === '01' || objetoImp === '03') return false
  if (factor === 'Exento') return false
  return ratePct > 0
}

/**
 * Impuestos retenidos (withholding) para el payload de Facturapi, a partir de
 * la lista de retenciones de la factura [{ tax_type, rate }] (rate en %).
 * Se anexan a las `taxes` de cada concepto objeto de impuesto.
 */
function buildRetentionTaxes(retentions = []) {
  return (retentions || [])
    .filter(r => parseFloat(r.rate) > 0 && (r.tax_type === 'ISR' || r.tax_type === 'IVA'))
    .map(r => ({ type: r.tax_type, rate: parseFloat(r.rate) / 100, withholding: true }))
}

module.exports = {
  normalizeLineTax, buildFacturapiTaxes, lineCausesTax, buildRetentionTaxes, VALID_FACTORS,
}
