'use strict'

/**
 * SaaS v2 — Service de recetas (recipes + recipe_components).
 *
 * Patrón "versioned aggregates":
 *  - POST crea una nueva versión vigente del producto. Si ya hay vigente,
 *    la cierra automáticamente (valid_until = NOW()).
 *  - PATCH solo permite editar metadata (name, is_active) — los cambios
 *    materiales (yield, scrap, components) NO se editan in-place: se hace
 *    POST de una nueva versión. Esto preserva trazabilidad de costeo
 *    histórico: una orden que referencia recipe_id no ve sus components
 *    mutados.
 *  - GET/list devuelve todas las versiones; filtro ?vigentOnly=true para
 *    quedarse con la activa de cada producto.
 *
 * Si en el futuro se quiere PATCH edit-in-place mientras no haya órdenes
 * referenciando la receta, agregar un endpoint diferente o un flag — pero
 * mantener este como el camino default.
 *
 * Referencia: §2.2.9 + §2.2.10.
 */

const { query, withTransaction } = require('../../db')
const { audit } = require('../../utils/audit')

// ─── Lecturas ─────────────────────────────────────────────────────────────

async function listRecipes({ tenantId, productId, vigentOnly, isActive }) {
  const params = [tenantId]
  const filters = []
  if (productId)            { params.push(productId); filters.push(`r.product_id = $${params.length}`) }
  if (vigentOnly === true)  { filters.push(`r.valid_until IS NULL`) }
  if (isActive !== undefined){ params.push(isActive); filters.push(`r.is_active = $${params.length}`) }
  const where = filters.length ? `AND ${filters.join(' AND ')}` : ''

  const { rows } = await query(
    `SELECT r.*,
            p.sku AS product_sku, p.name AS product_name,
            u.code AS yield_unit_code, u.symbol AS yield_unit_symbol,
            (SELECT COUNT(*)::int FROM recipe_components rc WHERE rc.recipe_id = r.id) AS components_count
     FROM recipes r
     JOIN products p     ON p.id = r.product_id
     JOIN tenant_units u ON u.id = r.yield_unit_id
     WHERE r.tenant_id = $1 ${where}
     ORDER BY p.name, r.version DESC`,
    params
  )
  return rows
}

async function getRecipe({ tenantId, id, includeComponents = true }) {
  const { rows } = await query(
    `SELECT r.*,
            p.sku AS product_sku, p.name AS product_name,
            u.code AS yield_unit_code, u.symbol AS yield_unit_symbol
     FROM recipes r
     JOIN products p     ON p.id = r.product_id
     JOIN tenant_units u ON u.id = r.yield_unit_id
     WHERE r.id = $1 AND r.tenant_id = $2`,
    [id, tenantId]
  )
  const recipe = rows[0] || null
  if (!recipe || !includeComponents) return recipe

  const { rows: comps } = await query(
    `SELECT rc.*,
            rm.name AS raw_material_name, rm.item_kind AS raw_material_kind,
            u.code AS unit_code, u.symbol AS unit_symbol
     FROM recipe_components rc
     JOIN raw_materials rm ON rm.id = rc.raw_material_id
     JOIN tenant_units u   ON u.id  = rc.unit_id
     WHERE rc.recipe_id = $1
     ORDER BY rc.sort_order, rm.name`,
    [id]
  )
  recipe.components = comps
  return recipe
}

// ─── Escrituras ──────────────────────────────────────────────────────────

/**
 * Crea una nueva versión vigente para el producto. Si ya existe una vigente,
 * la cierra (valid_until = NOW()) atómicamente en la misma transacción.
 *
 * components: array de { rawMaterialId, quantity, unitId, isOptional?,
 *   substituteGroup?, notes?, sortOrder? }
 */
async function createRecipe({
  tenantId, userId,
  productId, name, yieldQuantity, yieldUnitId,
  expectedScrapPct = null,
  components,
  ipAddress, userAgent,
}) {
  if (!productId) throw badReq('product_id es requerido.')
  if (!yieldUnitId) throw badReq('yield_unit_id es requerido.')
  if (yieldQuantity === undefined || yieldQuantity === null) throw badReq('yield_quantity es requerido.')
  const y = parseFloat(yieldQuantity)
  if (!Number.isFinite(y) || y <= 0) throw badReq('yield_quantity debe ser número positivo.')
  if (expectedScrapPct !== null && expectedScrapPct !== undefined) {
    const s = parseFloat(expectedScrapPct)
    if (!Number.isFinite(s) || s < 0 || s > 100) throw badReq('expected_scrap_pct debe estar entre 0 y 100.')
  }
  if (!Array.isArray(components) || components.length === 0) {
    throw badReq('components debe ser un array con al menos 1 elemento.')
  }

  // Validar FKs cross-tenant antes de abrir la transacción (más limpio para errores)
  await assertProductInTenant(tenantId, productId)
  await assertUnitInTenant(tenantId, yieldUnitId)

  const seenRm = new Set()
  for (const [idx, c] of components.entries()) {
    if (!c.rawMaterialId) throw badReq(`components[${idx}].raw_material_id es requerido.`)
    if (!c.unitId) throw badReq(`components[${idx}].unit_id es requerido.`)
    const q = parseFloat(c.quantity)
    if (!Number.isFinite(q) || q <= 0) throw badReq(`components[${idx}].quantity debe ser número positivo.`)
    if (seenRm.has(c.rawMaterialId)) {
      throw badReq(`components[${idx}].raw_material_id duplicado en la receta.`)
    }
    seenRm.add(c.rawMaterialId)
    await assertRawMaterialInTenant(tenantId, c.rawMaterialId)
    await assertUnitInTenant(tenantId, c.unitId)
  }

  return await withTransaction(async (client) => {
    // 1. Cerrar receta vigente actual del producto (si existe).
    await client.query(
      `UPDATE recipes SET valid_until = NOW()
       WHERE tenant_id = $1 AND product_id = $2 AND valid_until IS NULL`,
      [tenantId, productId]
    )

    // 2. Calcular nueva versión.
    const { rows: [{ next_version }] } = await client.query(
      `SELECT COALESCE(MAX(version), 0) + 1 AS next_version
       FROM recipes WHERE product_id = $1`,
      [productId]
    )

    // 3. Insertar receta nueva.
    const resolvedName = name && name.trim().length > 0
      ? name.trim()
      : `Receta v${next_version}`
    const { rows: [recipe] } = await client.query(
      `INSERT INTO recipes
         (tenant_id, product_id, version, name,
          yield_quantity, yield_unit_id, expected_scrap_pct,
          created_by_user_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING *`,
      [tenantId, productId, next_version, resolvedName,
       y, yieldUnitId, expectedScrapPct,
       userId]
    )

    // 4. Insertar componentes.
    for (const c of components) {
      await client.query(
        `INSERT INTO recipe_components
           (recipe_id, raw_material_id, quantity, unit_id,
            is_optional, substitute_group, notes, sort_order)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [recipe.id, c.rawMaterialId, parseFloat(c.quantity), c.unitId,
         c.isOptional === true, c.substituteGroup || null, c.notes || null,
         Number.isInteger(c.sortOrder) ? c.sortOrder : 0]
      )
    }

    return recipe
  })
    .then(async (recipe) => {
      await audit({
        tenantId, userId,
        action: 'recipe.created',
        resource: 'recipes',
        resourceId: recipe.id,
        payload: { productId, version: recipe.version, componentsCount: components.length },
        ipAddress, userAgent,
      })
      return await getRecipe({ tenantId, id: recipe.id, includeComponents: true })
    })
}

/**
 * Actualiza SOLO metadata: name, is_active.
 * Cambios materiales (yield/scrap/components) requieren POST de nueva versión.
 */
async function updateRecipe({
  tenantId, userId, id,
  name, isActive,
  ipAddress, userAgent,
}) {
  const current = await getRecipe({ tenantId, id, includeComponents: false })
  if (!current) {
    const err = new Error('Receta no encontrada.')
    err.status = 404
    throw err
  }

  const setters = []
  const params = []
  let i = 1

  if (name !== undefined) {
    if (typeof name !== 'string' || name.trim().length === 0) {
      throw badReq('name debe ser un string no vacío.')
    }
    setters.push(`name = $${i++}`); params.push(name.trim())
  }
  if (isActive !== undefined) {
    if (typeof isActive !== 'boolean') throw badReq('is_active debe ser boolean.')
    setters.push(`is_active = $${i++}`); params.push(isActive)
  }

  if (setters.length === 0) throw badReq('No hay campos válidos para actualizar (solo name e is_active son editables; cambios materiales requieren POST de nueva versión).')

  params.push(id, tenantId)
  await query(
    `UPDATE recipes SET ${setters.join(', ')}
     WHERE id = $${i++} AND tenant_id = $${i}`,
    params
  )

  await audit({
    tenantId, userId,
    action: 'recipe.updated',
    resource: 'recipes',
    resourceId: id,
    payload: { changedFields: setters.length },
    ipAddress, userAgent,
  })

  return await getRecipe({ tenantId, id, includeComponents: true })
}

// ─── Helpers ─────────────────────────────────────────────────────────────

async function assertProductInTenant(tenantId, productId) {
  const { rows } = await query(
    `SELECT 1 FROM products WHERE id = $1 AND tenant_id = $2`,
    [productId, tenantId]
  )
  if (rows.length === 0) throw badReq('product_id no existe en este tenant.')
}

async function assertUnitInTenant(tenantId, unitId) {
  const { rows } = await query(
    `SELECT 1 FROM tenant_units WHERE id = $1 AND tenant_id = $2`,
    [unitId, tenantId]
  )
  if (rows.length === 0) throw badReq('unit_id no existe en este tenant.')
}

async function assertRawMaterialInTenant(tenantId, rmId) {
  const { rows } = await query(
    `SELECT 1 FROM raw_materials WHERE id = $1 AND tenant_id = $2`,
    [rmId, tenantId]
  )
  if (rows.length === 0) throw badReq('raw_material_id no existe en este tenant.')
}

function badReq(msg) { const e = new Error(msg); e.status = 400; return e }

module.exports = {
  listRecipes, getRecipe, createRecipe, updateRecipe,
}
