'use strict'

/**
 * Redacta el response de orden de producción según permisos del usuario:
 *
 *   - Sin `production:read_recipe`:
 *       · mpFormula (lista de ingredientes con kg y %) se reemplaza por un
 *         resumen seguro `mpFormulaSummary = { components_count }`.
 *       · raw_material_name / resin_type / cost_per_kg del row principal se
 *         dejan tal cual (información del producto, no de la fórmula). El
 *         frontend decide si los muestra.
 *
 *   - Sin `production:read_recipe_costs` (pero CON read_recipe):
 *       · cost_per_kg de cada item de mpFormula se omite.
 *       · blended_cost_per_kg de la orden se omite.
 *
 *   - Con ambos: response sin cambios.
 *
 * El helper es idempotente y soporta tanto un row individual como un array.
 *
 * Usage:
 *   const perms = await getUserPermissions(req.auth.userId)
 *   res.json(redactOrder(order, perms))
 *   res.json({ data: rows.map(r => redactOrder(r, perms)), ...rest })
 */

const RECIPE_PERM = 'production:read_recipe'
const COSTS_PERM  = 'production:read_recipe_costs'

function redactOrder(row, perms) {
  if (!row || typeof row !== 'object') return row

  const canSeeRecipe = perms.has(RECIPE_PERM)
  const canSeeCosts  = perms.has(COSTS_PERM)

  let out = { ...row }

  // 1) mpFormula
  if (Array.isArray(out.mpFormula)) {
    if (!canSeeRecipe) {
      out.mpFormulaSummary = { components_count: out.mpFormula.length }
      out.mpFormula = null
    } else if (!canSeeCosts) {
      out.mpFormula = out.mpFormula.map(({ cost_per_kg, ...rest }) => rest)
    }
  }

  // 2) Campos de costo en la orden raíz
  if (!canSeeCosts) {
    delete out.blended_cost_per_kg
  }

  return out
}

function redactOrderList(rows, perms) {
  return rows.map(r => redactOrder(r, perms))
}

module.exports = { redactOrder, redactOrderList, RECIPE_PERM, COSTS_PERM }
