'use strict'

/**
 * SaaS v2 — Mantenimiento de product_lots durante la operación del turno.
 *
 * Dos operaciones centrales:
 *
 *   ensureProductLotForPackage(client, ctx)
 *     → Resuelve "qué product_lot recibe este paquete" según granularidad:
 *        - per_shift: busca el lote activo del shift×product×quality; si existe
 *          lo aumenta (quantity_produced + quantity_remaining += real_weight_kg)
 *          y devuelve su id. Si no existe, lo crea.
 *        - per_package: siempre crea un lote nuevo.
 *        - per_attribute_set: lanza createError(501) — reservado para cuando
 *          tenant_product_kinds.capture_schema soporte lot-critical attrs.
 *
 *     Genera lot_number vía lotNumberGenerator + productLotResolver
 *     (pattern producto > tenant > default; SEQ contado para el día).
 *
 *   distributeRawMaterialLotsToProductLots(client, { tenantId, shiftId })
 *     → Genera lot_consumption en closeShift, una fila por cada par
 *       (raw_material_lot consumido en el turno × product_lot producido en
 *       el turno), distribuyendo proporcionalmente al peso producido.
 *
 *       Lógica:
 *        - Suma de kg consumidos por raw_material_lot = SUM(shift_mp_loads.kg
 *          WHERE shift_id = X AND lot_id IS NOT NULL).
 *        - Peso total producido = SUM(product_lots.quantity_produced WHERE
 *          shift_id = X).
 *        - Para cada (rmLot, prodLot): quantity_consumed = rmLot.totalKg ×
 *          (prodLot.quantity_produced / totalProduced).
 *
 *       Idempotente: hace DELETE de lot_consumption existentes del turno
 *       antes de insertar, para tolerar re-cierre tras reopen.
 *
 * Referencia: §4.3.2, §4.3.3, §4.5.
 */

const { generate } = require('./lotNumberGenerator')
const { resolveLotPattern, nextSequenceForDay } = require('./productLotResolver')

function createError(status, message) {
  const err = new Error(message); err.status = status; return err
}

/**
 * @returns {Promise<{ productLotId: string, isNewLot: boolean }>}
 */
async function ensureProductLotForPackage(client, {
  tenantId, shift, productId, qualityGradeId, warehouseId,
  realWeightKg, productionDate, productionOrderId, userId,
  granularity, productSku, productLotPattern,
}) {
  if (!tenantId || !productId || !qualityGradeId || !warehouseId) {
    throw new Error('ensureProductLotForPackage: tenantId/productId/qualityGradeId/warehouseId requeridos.')
  }
  if (granularity === 'per_attribute_set') {
    throw createError(501,
      'Granularidad de lotes por atributos críticos aún no está implementada. ' +
      'Configura el tenant en per_shift o per_package por ahora.')
  }
  if (granularity !== 'per_shift' && granularity !== 'per_package') {
    throw new Error(`granularity inválida: ${granularity}`)
  }

  const weight = parseFloat(realWeightKg)
  if (!(weight > 0)) throw new Error('realWeightKg debe ser > 0.')

  // per_shift: intentar reusar lote del shift×product×quality activo y producido aquí.
  if (granularity === 'per_shift') {
    const { rows: existing } = await client.query(
      `SELECT id, quantity_produced, quantity_remaining
       FROM product_lots
       WHERE tenant_id = $1 AND shift_id = $2 AND product_id = $3
         AND quality_grade_id = $4 AND origin = 'produced' AND status = 'active'
       FOR UPDATE`,
      [tenantId, shift.id, productId, qualityGradeId]
    )
    if (existing[0]) {
      await client.query(
        `UPDATE product_lots
         SET quantity_produced = quantity_produced + $1,
             quantity_remaining = quantity_remaining + $1
         WHERE id = $2`,
        [weight, existing[0].id]
      )
      return { productLotId: existing[0].id, isNewLot: false }
    }
  }

  // per_package, o per_shift sin existente: crear nuevo lote
  const seq = await nextSequenceForDay(client, {
    tenantId, productId, productionDate,
  })
  const lotNumber = generate(productLotPattern, {
    date: productionDate,
    shift: shift.shift_number,
    line: shift.line_id != null ? `L${shift.line_id}` : '',
    sku: productSku || '',
    seq,
  })

  const { rows: ins } = await client.query(
    `INSERT INTO product_lots
       (tenant_id, product_id, lot_number, origin, production_date,
        quality_grade_id, quantity_produced, quantity_remaining,
        warehouse_id, production_order_id, shift_id, created_by_user_id)
     VALUES ($1,$2,$3,'produced',$4,$5,$6,$6,$7,$8,$9,$10)
     RETURNING id`,
    [tenantId, productId, lotNumber, productionDate, qualityGradeId,
     weight, warehouseId, productionOrderId || null, shift.id, userId || null]
  )
  return { productLotId: ins[0].id, isNewLot: true }
}

/**
 * Genera lot_consumption para todos los pares (raw_material_lot × product_lot)
 * del turno. Idempotente: borra los existentes del shift antes de re-insertar.
 *
 * @returns {Promise<{ inserted: number, skipped: string }>}
 *   inserted: número de filas lot_consumption creadas.
 *   skipped: razón si no se generó nada (e.g. 'no_rm_lots', 'no_product_lots').
 */
async function distributeRawMaterialLotsToProductLots(client, { tenantId, shiftId }) {
  if (!tenantId || !shiftId) throw new Error('tenantId y shiftId son requeridos.')

  // Cargar shift_mp_loads con lot_id (consumos de MP del turno).
  // NOTA: ignoramos shift_mp_loads.unit_id intencionalmente — siempre
  // expresamos el consumo en kg (la columna shift_mp_loads.kg es canónica)
  // y resolvemos unit_id desde tenant_units.code='kg' abajo.
  const { rows: rmConsumption } = await client.query(
    `SELECT lot_id AS raw_material_lot_id,
            SUM(kg) AS total_kg
     FROM shift_mp_loads
     WHERE shift_id = $1 AND lot_id IS NOT NULL
     GROUP BY lot_id`,
    [shiftId]
  )

  if (rmConsumption.length === 0) {
    // Tenant lot-mode pero no se cargó MP con lote — nada que distribuir.
    return { inserted: 0, skipped: 'no_rm_lots' }
  }

  // Cargar product_lots producidos en el turno.
  const { rows: prodLots } = await client.query(
    `SELECT id, quantity_produced
     FROM product_lots
     WHERE shift_id = $1 AND origin = 'produced' AND status = 'active'`,
    [shiftId]
  )

  if (prodLots.length === 0) {
    return { inserted: 0, skipped: 'no_product_lots' }
  }

  const totalProduced = prodLots.reduce((acc, p) => acc + parseFloat(p.quantity_produced), 0)
  if (totalProduced <= 0) {
    return { inserted: 0, skipped: 'zero_produced' }
  }

  // Limpiar consumos anteriores del turno (idempotencia).
  await client.query(
    `DELETE FROM lot_consumption WHERE shift_id = $1 AND tenant_id = $2`,
    [shiftId, tenantId]
  )

  // Resolver unit_id canónico (kg) del tenant. Requerido por lot_consumption.
  const { rows: kgRows } = await client.query(
    `SELECT id FROM tenant_units WHERE tenant_id = $1 AND code = 'kg' LIMIT 1`,
    [tenantId]
  )
  const unitId = kgRows[0]?.id
  if (!unitId) {
    throw new Error('Tenant sin unidad kg configurada en tenant_units; necesaria para lot_consumption.')
  }

  let inserted = 0
  for (const rm of rmConsumption) {
    const totalKgFromRm = parseFloat(rm.total_kg)
    if (totalKgFromRm <= 0) continue

    for (const pl of prodLots) {
      const produced = parseFloat(pl.quantity_produced)
      if (produced <= 0) continue

      const share = produced / totalProduced
      const qtyConsumed = totalKgFromRm * share
      // Saltamos cantidades ínfimas (float noise).
      if (qtyConsumed < 1e-6) continue

      await client.query(
        `INSERT INTO lot_consumption
           (tenant_id, product_lot_id, raw_material_lot_id,
            quantity_consumed, unit_id, shift_id)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [tenantId, pl.id, rm.raw_material_lot_id,
         qtyConsumed.toFixed(6), unitId, shiftId]
      )
      inserted++
    }
  }

  return { inserted, skipped: null }
}

/**
 * SaaS v2 §5h: validar consistencia de alérgenos al cerrar turno.
 *
 * Para cada product_lot del shift, comparar declared product_allergens vs
 * UNION(raw_material_allergens) de los raw_material_lots consumidos (vía
 * lot_consumption). Discrepancia = alérgeno presente en MP que NO está
 * declarado en PT.
 *
 * Acción según tenant_process_config.allergen_mode:
 *   - 'strict': lanza 400 con detalle de la discrepancia → bloquea closeShift.
 *   - 'priority_only': si alguno de los alérgenos discrepantes es prioritario
 *     (NOM-051) → lanza 400; otros se reportan vía dispatchAlert.
 *   - 'alert_only': siempre dispatchAlert, nunca bloquea.
 *
 * IMPORTANTE: debe correr DESPUÉS de distributeRawMaterialLotsToProductLots
 * (necesita lot_consumption ya populado).
 *
 * @param {object} deps.dispatchAlert — para inyectar en tests si se quiere.
 * @returns {Promise<{ discrepancies: Array<{productLotId, missing: Array<{code,name,is_priority}>}>, blocked: boolean }>}
 */
async function validateAllergenConsistency(client, { tenantId, shiftId }, deps = {}) {
  if (!tenantId || !shiftId) throw new Error('tenantId y shiftId requeridos.')

  const dispatchAlert = deps.dispatchAlert || require('../alerts/alertService').dispatchAlert

  const { rows: cfg } = await client.query(
    `SELECT allergen_mode FROM tenant_process_config WHERE tenant_id = $1`,
    [tenantId]
  )
  const allergenMode = cfg[0]?.allergen_mode || 'priority_only'

  const { rows: prodLots } = await client.query(
    `SELECT id, product_id, lot_number FROM product_lots
     WHERE shift_id = $1 AND tenant_id = $2 AND origin = 'produced'`,
    [shiftId, tenantId]
  )

  const discrepancies = []
  for (const pl of prodLots) {
    // Alérgenos declarados en el producto
    const { rows: declared } = await client.query(
      `SELECT allergen_id FROM product_allergens
       WHERE product_id = $1 AND declaration = 'contains'`,
      [pl.product_id]
    )
    const declaredIds = new Set(declared.map(r => r.allergen_id))

    // Alérgenos heredados desde MP consumidas (vía lot_consumption → raw_material_lots → raw_material_allergens)
    const { rows: inherited } = await client.query(
      `SELECT DISTINCT rma.allergen_id, ta.code, ta.name, ta.is_priority
       FROM lot_consumption lc
       JOIN raw_material_lots rml ON rml.id = lc.raw_material_lot_id
       JOIN raw_material_allergens rma ON rma.raw_material_id = rml.raw_material_id
       JOIN tenant_allergens ta ON ta.id = rma.allergen_id
       WHERE lc.product_lot_id = $1
         AND rma.declaration = 'contains'`,
      [pl.id]
    )

    const missing = inherited.filter(a => !declaredIds.has(a.allergen_id))
    if (missing.length > 0) {
      discrepancies.push({ productLotId: pl.id, lotNumber: pl.lot_number, missing })
    }
  }

  if (discrepancies.length === 0) {
    return { discrepancies: [], blocked: false }
  }

  // Strict: cualquier discrepancia bloquea.
  if (allergenMode === 'strict') {
    const summary = discrepancies
      .map(d => `${d.lotNumber}: ${d.missing.map(m => m.code).join(',')}`)
      .join(' | ')
    const err = new Error(`Cierre bloqueado por discrepancia de alérgenos (modo strict): ${summary}`)
    err.status = 400
    err.discrepancies = discrepancies
    throw err
  }

  // priority_only: solo bloquea si la discrepancia incluye un alérgeno prioritario.
  if (allergenMode === 'priority_only') {
    const priorityBlocking = discrepancies.filter(d =>
      d.missing.some(a => a.is_priority)
    )
    if (priorityBlocking.length > 0) {
      const summary = priorityBlocking
        .map(d => `${d.lotNumber}: ${d.missing.filter(m => m.is_priority).map(m => m.code).join(',')}`)
        .join(' | ')
      const err = new Error(`Cierre bloqueado por alérgeno prioritario no declarado: ${summary}`)
      err.status = 400
      err.discrepancies = discrepancies
      throw err
    }
    // Los no-prioritarios solo generan alerta.
    for (const d of discrepancies) {
      await dispatchAlert(client, {
        tenantId,
        type: 'allergen_discrepancy',
        severity: 'warning',
        title: `Discrepancia de alérgenos en lote ${d.lotNumber}`,
        body: `MP consumida contiene alérgenos no declarados en el producto: ${d.missing.map(m => m.code).join(', ')}.`,
        payload: { lot_number: d.lotNumber, missing: d.missing, allergen_mode: allergenMode },
        sourceType: 'product_lot',
        sourceId: d.productLotId,
      })
    }
    return { discrepancies, blocked: false }
  }

  // alert_only: nunca bloquea, solo dispatcha.
  for (const d of discrepancies) {
    await dispatchAlert(client, {
      tenantId,
      type: 'allergen_discrepancy',
      severity: 'warning',
      title: `Discrepancia de alérgenos en lote ${d.lotNumber}`,
      body: `MP consumida contiene alérgenos no declarados en el producto: ${d.missing.map(m => m.code).join(', ')}.`,
      payload: { lot_number: d.lotNumber, missing: d.missing, allergen_mode: allergenMode },
      sourceType: 'product_lot',
      sourceId: d.productLotId,
    })
  }
  return { discrepancies, blocked: false }
}

module.exports = {
  ensureProductLotForPackage,
  distributeRawMaterialLotsToProductLots,
  validateAllergenConsistency,
}
