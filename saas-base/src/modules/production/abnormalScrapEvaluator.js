'use strict'

/**
 * SaaS v2 — Evaluador de "merma anormal" (shift_scrap.is_abnormal).
 *
 * Una merma es "anormal" cuando el total acumulado para una orden de
 * producción supera el % esperado vs el MP consumido. Las anormales se
 * cargan a cuenta de pérdida del período en lugar de inflar el costo
 * unitario del producto (cuando `tenant_process_config.treat_abnormal_scrap_as_loss=true`,
 * que es el default).
 *
 * Cascada del expected_scrap_pct (primer hit gana):
 *   1. production_orders.expected_scrap_pct       (override por orden)
 *   2. recipes.expected_scrap_pct (de la version snapshot en la orden)
 *   3. null → no se evalúa, is_abnormal=false siempre.
 *
 * MP base = total kg cargados en el turno (shift_mp_loads no diferencia
 * orden; típicamente una orden por turno en el modelo legacy).
 *
 * Referencia: docs/saas-v2/00-design.md §3.2 (anormal cuando supera %), §2.3.7.
 */

/**
 * @param {object} client  pg client (dentro de transacción)
 * @param {object} args
 * @param {string} args.tenantId
 * @param {string} args.shiftId
 * @param {string} args.productionOrderId   FK obligatoria (sin orden no se evalúa)
 * @param {number} args.candidateKg         kg de la nueva merma siendo registrada
 * @param {string} [args.excludeScrapId]    para edits: excluir este registro del acumulado
 * @returns {Promise<{ isAbnormal: boolean, threshold: number|null, accumulated: number, source: string|null }>}
 */
async function evaluateAbnormal(client, {
  tenantId, shiftId, productionOrderId, candidateKg, excludeScrapId,
}) {
  if (!productionOrderId) {
    return { isAbnormal: false, threshold: null, accumulated: 0, source: null }
  }
  if (candidateKg == null || isNaN(parseFloat(candidateKg))) {
    return { isAbnormal: false, threshold: null, accumulated: 0, source: null }
  }
  const candidate = parseFloat(candidateKg)

  // 1. Resolver expected_scrap_pct (orden → receta)
  const { rows: orderRows } = await client.query(
    `SELECT po.expected_scrap_pct AS order_pct,
            po.recipe_id, po.recipe_version_at_creation,
            r.expected_scrap_pct AS recipe_pct
     FROM production_orders po
     LEFT JOIN recipes r ON r.id = po.recipe_id
     WHERE po.id = $1 AND po.tenant_id = $2`,
    [productionOrderId, tenantId]
  )
  if (orderRows.length === 0) {
    return { isAbnormal: false, threshold: null, accumulated: 0, source: null }
  }
  const ord = orderRows[0]
  let expectedPct = null
  let source = null
  if (ord.order_pct != null) {
    expectedPct = parseFloat(ord.order_pct)
    source = 'order'
  } else if (ord.recipe_pct != null) {
    expectedPct = parseFloat(ord.recipe_pct)
    source = 'recipe'
  }
  if (expectedPct == null) {
    return { isAbnormal: false, threshold: null, accumulated: 0, source: null }
  }

  // 2. MP total consumida en el turno (kg).
  // shift_mp_loads no diferencia order; en modelo legacy 1-orden-por-turno
  // todo el MP "es" de esta orden. Si en el futuro varias órdenes comparten
  // turno, refinar para usar shift_progress.real_weight_kg.
  const { rows: mpRows } = await client.query(
    `SELECT COALESCE(SUM(kg), 0)::numeric AS total_mp_kg
     FROM shift_mp_loads
     WHERE shift_id = $1`,
    [shiftId]
  )
  const mpKg = parseFloat(mpRows[0].total_mp_kg)
  if (mpKg <= 0) {
    // Sin MP cargado aún, no se puede evaluar.
    return { isAbnormal: false, threshold: null, accumulated: candidate, source }
  }

  // 3. Scrap acumulado previo de esta orden en este turno (excluyendo el
  //    registro en edición, si aplica).
  const params = [shiftId, productionOrderId]
  let excludeClause = ''
  if (excludeScrapId) {
    params.push(excludeScrapId)
    excludeClause = `AND id != $${params.length}`
  }
  const { rows: prevRows } = await client.query(
    `SELECT COALESCE(SUM(kg), 0)::numeric AS prev_kg
     FROM shift_scrap
     WHERE shift_id = $1 AND production_order_id = $2 ${excludeClause}`,
    params
  )
  const accumulated = parseFloat(prevRows[0].prev_kg) + candidate

  const threshold = mpKg * (expectedPct / 100)
  const isAbnormal = accumulated > threshold
  return { isAbnormal, threshold, accumulated, source }
}

module.exports = { evaluateAbnormal }
