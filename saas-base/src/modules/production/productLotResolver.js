'use strict'

/**
 * SaaS v2 — Helpers para resolver pattern y secuencia al generar product_lots.
 *
 * Encapsula las dos consultas necesarias para que capturePackage / addPackage
 * puedan generar lot_numbers consistentes:
 *
 *   resolveLotPattern(client, { tenantId, productId })
 *     → string  — pattern resuelto en cascada:
 *         products.lot_number_pattern (si el producto lo tiene)
 *         > tenant_process_config.lot_number_pattern (si el tenant lo tiene)
 *         > DEFAULT_PATTERN del lotNumberGenerator
 *
 *   nextSequenceForDay(client, { tenantId, productId, productionDate })
 *     → integer — siguiente SEQ para este (tenant × producto × día).
 *       Cuenta product_lots existentes y devuelve count + 1.
 *
 * Ambos consultan dentro del client/transacción del caller para que el conteo
 * sea consistente con los inserts del mismo turno.
 *
 * Referencia: §4.5.1, §4.5.2.
 */

const { DEFAULT_PATTERN } = require('./lotNumberGenerator')

async function resolveLotPattern(client, { tenantId, productId }) {
  if (!tenantId || !productId) throw new Error('tenantId y productId son requeridos.')

  const { rows: prodRows } = await client.query(
    `SELECT lot_number_pattern FROM products WHERE id = $1 AND tenant_id = $2`,
    [productId, tenantId]
  )
  const productPattern = prodRows[0]?.lot_number_pattern
  if (productPattern && productPattern.trim()) return productPattern

  const { rows: cfgRows } = await client.query(
    `SELECT lot_number_pattern FROM tenant_process_config WHERE tenant_id = $1`,
    [tenantId]
  )
  const tenantPattern = cfgRows[0]?.lot_number_pattern
  if (tenantPattern && tenantPattern.trim()) return tenantPattern

  return DEFAULT_PATTERN
}

/**
 * Devuelve el siguiente SEQ entero para (tenant, producto, día).
 * Se basa en COUNT de product_lots existentes para ese día.
 *
 * NOTA: con UNIQUE(product_id, lot_number) el INSERT con SEQ duplicado fallará
 * y obligará a reintentar. Como capturePackage corre dentro de una transacción
 * y el siguiente shift_progress aumenta el contador, es muy improbable que dos
 * tenants entren en colisión; aún así el caller debe ser tolerante a un retry
 * en caso de carrera (defensa redundante con el constraint).
 */
async function nextSequenceForDay(client, { tenantId, productId, productionDate }) {
  if (!tenantId || !productId || !productionDate) {
    throw new Error('tenantId, productId y productionDate son requeridos.')
  }

  const { rows } = await client.query(
    `SELECT COUNT(*)::int AS cnt
     FROM product_lots
     WHERE tenant_id = $1 AND product_id = $2 AND production_date = $3`,
    [tenantId, productId, productionDate]
  )
  return (rows[0]?.cnt || 0) + 1
}

module.exports = {
  resolveLotPattern,
  nextSequenceForDay,
}
