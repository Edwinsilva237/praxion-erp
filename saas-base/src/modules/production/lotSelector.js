'use strict'

/**
 * SaaS v2 — Selector de raw_material_lots para consumo (FEFO/FIFO).
 *
 * Helper §4.6 del design. Dos APIs:
 *
 *   listAvailableLots(...) — devuelve lotes disponibles ordenados según el
 *     método configurado del tenant. Sin allocar nada. Útil para preview.
 *
 *   selectLotsForQuantity({ qty, ... }) — wrap del anterior + greedy: devuelve
 *     un plan de consumo [{ lotId, qtyToTake, ... }] que cubre `qty`.
 *     Si el inventario no alcanza, devuelve lo que pueda y marca shortfall.
 *
 * Modos de selección:
 *
 *   - `costMethod='weighted_avg'` o `usesLots=false`: NO selecciona lote.
 *     Devuelve `{ mode: 'no_lot' }` o `{ mode: 'no_lot', shortfall }` según
 *     se pueda satisfacer la cantidad con el inventario agregado.
 *     (El caller que pida valoración de costo debe consultar avg_cost del
 *     inventory_stock, esa lógica está fuera del scope de este helper.)
 *
 *   - `costMethod='fifo'` + `usesLots=true`: orden por `received_at ASC`.
 *
 *   - `costMethod='fefo'` + `usesLots=true` + `usesExpiry=true`: orden por
 *     `expiry_date ASC` (NULLS LAST) → desempate por `received_at ASC`.
 *     Excluye lotes con `expiry_date <= NOW()`.
 *
 * Reglas de exclusión (siempre):
 *   - status != 'active' → excluido (quarantined/expired/recalled/depleted).
 *   - quantity_remaining <= 0 → excluido.
 *
 * Override manual del operador (§4.6): NO es responsabilidad de este helper.
 * El caller (loadMp) puede recibir lot_id explícito y validar `getLotById`
 * que el lote es elegible — esa lógica vive en el service que lo usa.
 *
 * Referencia: §4.6.
 */

const { query } = require('../../db')

const SUPPORTED_COST_METHODS = ['weighted_avg', 'fifo', 'fefo', 'standard']

/**
 * @param {object} params
 * @param {string} params.tenantId
 * @param {string} params.rawMaterialId
 * @param {string} [params.warehouseId]  Si se omite, considera todos los almacenes del tenant.
 * @param {string} params.costMethod    'weighted_avg' | 'fifo' | 'fefo' | 'standard'
 * @param {boolean} [params.usesLots=true]
 * @param {boolean} [params.usesExpiry=true]
 * @param {object} [params.client]      Cliente de transacción opcional.
 *
 * @returns {Promise<Array<{
 *   id: string, lotNumber: string, quantityRemaining: number,
 *   unitCost: number | null, warehouseId: string,
 *   receivedAt: Date, expiryDate: Date | null
 * }>>}
 */
async function listAvailableLots({
  tenantId, rawMaterialId, warehouseId = null,
  costMethod, usesLots = true, usesExpiry = true,
  client = null,
}) {
  if (!tenantId || !rawMaterialId) {
    throw new Error('tenantId y rawMaterialId son requeridos.')
  }
  if (!SUPPORTED_COST_METHODS.includes(costMethod)) {
    throw new Error(`costMethod inválido: ${costMethod}. Soportados: ${SUPPORTED_COST_METHODS.join(', ')}.`)
  }

  // weighted_avg sin lotes: no aplica selección por lote
  if (!usesLots || costMethod === 'weighted_avg' || costMethod === 'standard') {
    return []
  }

  const q = (text, params) => (client ? client.query(text, params) : query(text, params))

  const params = [tenantId, rawMaterialId]
  let where = `WHERE rml.tenant_id = $1 AND rml.raw_material_id = $2
               AND rml.status = 'active' AND rml.quantity_remaining > 0`
  if (warehouseId) {
    params.push(warehouseId)
    where += ` AND rml.warehouse_id = $${params.length}`
  }

  // FEFO también excluye lotes ya caducados (expiry_date <= NOW)
  let orderBy
  if (costMethod === 'fefo' && usesExpiry) {
    where += ` AND (rml.expiry_date IS NULL OR rml.expiry_date > NOW())`
    orderBy = `ORDER BY rml.expiry_date NULLS LAST, rml.received_at ASC, rml.id ASC`
  } else {
    // FIFO puro
    orderBy = `ORDER BY rml.received_at ASC, rml.id ASC`
  }

  const { rows } = await q(
    `SELECT rml.id, rml.lot_number, rml.quantity_remaining, rml.unit_cost,
            rml.warehouse_id, rml.received_at, rml.expiry_date
     FROM raw_material_lots rml
     ${where}
     ${orderBy}`,
    params
  )

  return rows.map(r => ({
    id: r.id,
    lotNumber: r.lot_number,
    quantityRemaining: parseFloat(r.quantity_remaining),
    unitCost: r.unit_cost !== null ? parseFloat(r.unit_cost) : null,
    warehouseId: r.warehouse_id,
    receivedAt: r.received_at,
    expiryDate: r.expiry_date,
  }))
}

/**
 * Greedy: dado un qty, devuelve el plan de consumo (qué tomar de cada lote).
 *
 * @returns {Promise<{
 *   mode: 'no_lot' | 'fifo' | 'fefo',
 *   plan: Array<{ lotId: string, lotNumber: string, qtyToTake: number, unitCost: number | null, expiryDate: Date | null }>,
 *   totalAllocated: number,
 *   shortfall: number,    // qty - totalAllocated; 0 si se cubrió todo
 * }>}
 */
async function selectLotsForQuantity({
  tenantId, rawMaterialId, warehouseId = null,
  costMethod, usesLots = true, usesExpiry = true,
  qty,
  client = null,
}) {
  if (typeof qty !== 'number' || !Number.isFinite(qty) || qty <= 0) {
    throw new Error('qty debe ser número positivo.')
  }

  // Sin lotes: no allocamos, el caller maneja avg_cost
  if (!usesLots || costMethod === 'weighted_avg' || costMethod === 'standard') {
    return { mode: 'no_lot', plan: [], totalAllocated: 0, shortfall: qty }
  }

  const lots = await listAvailableLots({
    tenantId, rawMaterialId, warehouseId,
    costMethod, usesLots, usesExpiry, client,
  })

  const plan = []
  let remaining = qty
  for (const lot of lots) {
    if (remaining <= 0) break
    const take = Math.min(lot.quantityRemaining, remaining)
    plan.push({
      lotId: lot.id,
      lotNumber: lot.lotNumber,
      qtyToTake: take,
      unitCost: lot.unitCost,
      expiryDate: lot.expiryDate,
    })
    remaining -= take
  }

  const totalAllocated = qty - remaining
  return {
    mode: costMethod === 'fefo' && usesExpiry ? 'fefo' : 'fifo',
    plan,
    totalAllocated,
    shortfall: remaining > 1e-9 ? remaining : 0,  // tolerancia float
  }
}

module.exports = {
  listAvailableLots,
  selectLotsForQuantity,
  SUPPORTED_COST_METHODS,
}
