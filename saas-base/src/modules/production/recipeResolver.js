'use strict'

/**
 * SaaS v2 — Resolver de receta/componentes para una production_order.
 *
 * Helper "puerta de entrada" del refactor de productionService. Su objetivo es
 * unificar la lectura de "qué MP consume esta orden" detrás de una sola API,
 * de modo que las funciones del productionService que necesiten la fórmula
 * no tengan que decidir caso a caso entre el modelo nuevo (recipes) y el
 * viejo (order_mp_formula).
 *
 * Tres modos posibles, en orden de preferencia:
 *
 *   1. `recipe`  — production_orders.recipe_id está set. Lee de recipes +
 *      recipe_components. Cada componente tiene `quantity` absoluta en
 *      `unit_id` específica. Es el modelo SaaS v2.
 *
 *   2. `legacy_formula` — recipe_id NULL pero existe order_mp_formula con N
 *      filas. Cada componente tiene `percentage` (suman 100). Unit asumida
 *      kg (modelo viejo de plástico).
 *
 *   3. `legacy_single` — recipe_id NULL y no hay formula, pero
 *      production_orders.raw_material_id está set. Una sola MP al 100%.
 *      Caso más simple del modelo viejo.
 *
 *   4. `none` — ninguno de los tres aplica. Devuelve componentes vacíos.
 *      Útil para órdenes en estado draft sin fórmula aún.
 *
 * El caller debe ramificar por `mode` para decidir cómo interpretar los
 * componentes (quantity vs percentage, unit_id vs kg asumido).
 *
 * Referencia: §2.2.9, §2.2.10, §2.3.4.
 */

const { query } = require('../../db')

/**
 * @param {object} params
 * @param {string} params.tenantId
 * @param {string} params.orderId
 * @param {object} [params.client]  Cliente de transacción opcional (pg client).
 *
 * @returns {Promise<null | {
 *   mode: 'recipe' | 'legacy_formula' | 'legacy_single' | 'none',
 *   orderId: string,
 *   recipeId: string | null,
 *   recipeVersion: number | null,
 *   yieldQuantity: number | null,
 *   yieldUnitId: string | null,
 *   yieldUnitCode: string | null,
 *   expectedScrapPct: number | null,
 *   components: Array<{
 *     rawMaterialId: string,
 *     rawMaterialName: string,
 *     quantity: number | null,
 *     percentage: number | null,
 *     unitId: string | null,
 *     unitCode: string | null,
 *     isOptional: boolean,
 *     substituteGroup: string | null,
 *     sortOrder: number,
 *   }>
 * }>}
 */
async function resolveRecipeForOrder({ tenantId, orderId, client = null }) {
  if (!tenantId || !orderId) {
    throw new Error('tenantId y orderId son requeridos.')
  }

  const q = (text, params) => (client ? client.query(text, params) : query(text, params))

  const { rows: orderRows } = await q(
    `SELECT id, tenant_id, recipe_id, recipe_version_at_creation,
            product_id, raw_material_id, quantity_packages
     FROM production_orders
     WHERE id = $1 AND tenant_id = $2`,
    [orderId, tenantId]
  )
  if (orderRows.length === 0) return null
  const order = orderRows[0]

  // ─── Modo 1: recipe (preferido) ────────────────────────────────────────
  if (order.recipe_id) {
    const { rows: recipeRows } = await q(
      `SELECT r.id, r.version, r.yield_quantity, r.yield_unit_id, r.expected_scrap_pct,
              u.code AS yield_unit_code
       FROM recipes r
       JOIN tenant_units u ON u.id = r.yield_unit_id
       WHERE r.id = $1`,
      [order.recipe_id]
    )
    // Si la receta fue borrada (raro — ON DELETE SET NULL), tratar como none.
    if (recipeRows.length === 0) {
      return emptyResult(orderId, 'none')
    }
    const recipe = recipeRows[0]

    const { rows: compRows } = await q(
      `SELECT rc.raw_material_id, rm.name AS raw_material_name,
              rc.quantity, rc.unit_id, u.code AS unit_code,
              rc.is_optional, rc.substitute_group, rc.sort_order
       FROM recipe_components rc
       JOIN raw_materials rm ON rm.id = rc.raw_material_id
       JOIN tenant_units u   ON u.id  = rc.unit_id
       WHERE rc.recipe_id = $1
       ORDER BY rc.sort_order, rm.name`,
      [order.recipe_id]
    )

    return {
      mode: 'recipe',
      orderId,
      recipeId: order.recipe_id,
      recipeVersion: order.recipe_version_at_creation ?? recipe.version,
      yieldQuantity: parseFloat(recipe.yield_quantity),
      yieldUnitId: recipe.yield_unit_id,
      yieldUnitCode: recipe.yield_unit_code,
      expectedScrapPct: recipe.expected_scrap_pct !== null ? parseFloat(recipe.expected_scrap_pct) : null,
      components: compRows.map(c => ({
        rawMaterialId: c.raw_material_id,
        rawMaterialName: c.raw_material_name,
        quantity: parseFloat(c.quantity),
        percentage: null,
        unitId: c.unit_id,
        unitCode: c.unit_code,
        isOptional: c.is_optional,
        substituteGroup: c.substitute_group,
        sortOrder: c.sort_order,
      })),
    }
  }

  // ─── Modo 2: legacy_formula (order_mp_formula con N filas) ─────────────
  const { rows: formulaRows } = await q(
    `SELECT omf.raw_material_id, rm.name AS raw_material_name,
            omf.percentage, omf.sort_order
     FROM order_mp_formula omf
     JOIN raw_materials rm ON rm.id = omf.raw_material_id
     WHERE omf.production_order_id = $1
     ORDER BY omf.sort_order, rm.name`,
    [orderId]
  )
  if (formulaRows.length > 0) {
    return {
      mode: 'legacy_formula',
      orderId,
      recipeId: null,
      recipeVersion: null,
      yieldQuantity: null,
      yieldUnitId: null,
      yieldUnitCode: null,
      expectedScrapPct: null,
      components: formulaRows.map(f => ({
        rawMaterialId: f.raw_material_id,
        rawMaterialName: f.raw_material_name,
        quantity: null,
        percentage: parseFloat(f.percentage),
        unitId: null,
        unitCode: 'kg',  // modelo viejo asume kg
        isOptional: false,
        substituteGroup: null,
        sortOrder: f.sort_order,
      })),
    }
  }

  // ─── Modo 3: legacy_single (solo raw_material_id en production_orders) ─
  if (order.raw_material_id) {
    const { rows: rmRows } = await q(
      `SELECT id, name FROM raw_materials WHERE id = $1 AND tenant_id = $2`,
      [order.raw_material_id, tenantId]
    )
    if (rmRows.length > 0) {
      return {
        mode: 'legacy_single',
        orderId,
        recipeId: null,
        recipeVersion: null,
        yieldQuantity: null,
        yieldUnitId: null,
        yieldUnitCode: null,
        expectedScrapPct: null,
        components: [{
          rawMaterialId: rmRows[0].id,
          rawMaterialName: rmRows[0].name,
          quantity: null,
          percentage: 100,
          unitId: null,
          unitCode: 'kg',
          isOptional: false,
          substituteGroup: null,
          sortOrder: 0,
        }],
      }
    }
  }

  // ─── Modo 4: none ──────────────────────────────────────────────────────
  return emptyResult(orderId, 'none')
}

function emptyResult(orderId, mode) {
  return {
    mode,
    orderId,
    recipeId: null,
    recipeVersion: null,
    yieldQuantity: null,
    yieldUnitId: null,
    yieldUnitCode: null,
    expectedScrapPct: null,
    components: [],
  }
}

module.exports = { resolveRecipeForOrder }
