'use strict'

/**
 * SaaS v2 — Resolver de calidades del catálogo tenant_quality_grades.
 *
 * Puente entre el flag binario legacy `shift_progress.is_second_quality` y el
 * catálogo configurable de N calidades de la migración 123. Reglas:
 *
 *   - Si viene `qualityGradeId` (UUID): busca por ID + tenant. Si no existe,
 *     cross-tenant, o inactivo → throw 400.
 *   - Si viene `gradeNumber` (1-5): busca por número + tenant. Si no existe
 *     o inactivo → throw 400.
 *   - Si viene `productDefaultId` y nada más: usa ese.
 *   - Si solo viene `isSecondQuality` (boolean):
 *       true  → grade_number=2 (o el primer grade activo con número > 1)
 *       false → product.default_quality_grade_id o grade_number=1
 *   - Si no se puede resolver → throw 500 (tenant sin calidades activas
 *     suficientes — config rota).
 *
 * Devuelve el row completo `{ id, grade_number, code, name,
 * counts_for_order_fulfillment, goes_to_warehouse_type_id, ... }` para que el
 * caller pueda decidir `is_second_quality` derivado (grade_number > 1) y
 * propagar `goes_to_warehouse_type_id` al inventory.
 *
 * Referencia: docs/saas-v2/00-design.md §2.2.6.
 */

function badRequest(msg) { const e = new Error(msg); e.status = 400; return e }
function configError(msg) { const e = new Error(msg); e.status = 500; return e }

/**
 * @param {object} client  pg client
 * @param {object} args
 * @param {string} args.tenantId
 * @param {string} [args.qualityGradeId]   UUID (path explícito SaaS v2)
 * @param {number} [args.gradeNumber]      1-5 (lookup alterno)
 * @param {string} [args.productDefaultId] UUID — default del producto
 * @param {boolean}[args.isSecondQuality]  fallback legacy
 * @returns {Promise<{ id, grade_number, code, name, counts_for_order_fulfillment,
 *                     goes_to_warehouse_type_id, is_active }>}
 */
async function resolveQualityGrade(client, {
  tenantId,
  qualityGradeId,
  gradeNumber,
  productDefaultId,
  isSecondQuality,
}) {
  if (!tenantId) throw configError('tenantId requerido para resolveQualityGrade.')

  // 1. Path explícito: qualityGradeId
  if (qualityGradeId) {
    const { rows } = await client.query(
      `SELECT id, grade_number, code, name, counts_for_order_fulfillment,
              goes_to_warehouse_type_id, is_active
       FROM tenant_quality_grades
       WHERE id = $1 AND tenant_id = $2`,
      [qualityGradeId, tenantId]
    )
    if (rows.length === 0) throw badRequest('qualityGradeId no existe en este tenant.')
    if (!rows[0].is_active) throw badRequest(`La calidad "${rows[0].code}" está inactiva.`)
    return rows[0]
  }

  // 2. Lookup por gradeNumber
  if (gradeNumber != null) {
    const n = parseInt(gradeNumber, 10)
    if (!Number.isInteger(n) || n < 1 || n > 5) {
      throw badRequest('gradeNumber debe ser entero entre 1 y 5.')
    }
    const { rows } = await client.query(
      `SELECT id, grade_number, code, name, counts_for_order_fulfillment,
              goes_to_warehouse_type_id, is_active
       FROM tenant_quality_grades
       WHERE tenant_id = $1 AND grade_number = $2`,
      [tenantId, n]
    )
    if (rows.length === 0) throw badRequest(`El tenant no tiene calidad con grade_number=${n}.`)
    if (!rows[0].is_active) throw badRequest(`La calidad grade_number=${n} está inactiva.`)
    return rows[0]
  }

  // 3. Fallback legacy: isSecondQuality boolean
  if (isSecondQuality === true) {
    // Primera calidad activa con número > 1 (típicamente grade 2)
    const { rows } = await client.query(
      `SELECT id, grade_number, code, name, counts_for_order_fulfillment,
              goes_to_warehouse_type_id, is_active
       FROM tenant_quality_grades
       WHERE tenant_id = $1 AND grade_number > 1 AND is_active = true
       ORDER BY grade_number LIMIT 1`,
      [tenantId]
    )
    if (!rows[0]) {
      throw configError('Tenant sin calidad secundaria activa configurada (necesaria para isSecondQuality=true).')
    }
    return rows[0]
  }

  // 4. Default: productDefaultId o grade_number=1
  if (productDefaultId) {
    const { rows } = await client.query(
      `SELECT id, grade_number, code, name, counts_for_order_fulfillment,
              goes_to_warehouse_type_id, is_active
       FROM tenant_quality_grades
       WHERE id = $1 AND tenant_id = $2`,
      [productDefaultId, tenantId]
    )
    if (rows[0] && rows[0].is_active) return rows[0]
    // Si el default del producto se desactivó, caer al grade 1
  }

  const { rows } = await client.query(
    `SELECT id, grade_number, code, name, counts_for_order_fulfillment,
            goes_to_warehouse_type_id, is_active
     FROM tenant_quality_grades
     WHERE tenant_id = $1 AND grade_number = 1 AND is_active = true LIMIT 1`,
    [tenantId]
  )
  if (!rows[0]) {
    throw configError('Tenant sin calidad grade_number=1 activa (config rota).')
  }
  return rows[0]
}

module.exports = { resolveQualityGrade }
