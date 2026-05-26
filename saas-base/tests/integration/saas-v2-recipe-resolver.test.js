'use strict'

/**
 * SaaS v2 — Tests del recipeResolver.
 *
 * Cubre los 4 modos:
 *  - recipe         (production_orders.recipe_id set)
 *  - legacy_formula (order_mp_formula con N filas)
 *  - legacy_single  (solo production_orders.raw_material_id)
 *  - none           (sin nada — orden draft sin fórmula)
 *
 * También cross-tenant isolation y orden inexistente.
 */

const { createTenant, loginAs, authedClient, cleanupTestTenants } = require('../helpers/factory')
const { pool, query, withBypass } = require('../../src/db')
const { resolveRecipeForOrder } = require('../../src/modules/production/recipeResolver')

afterAll(async () => {
  await cleanupTestTenants()
  await pool.end()
})

let counter = 0
const uniq = (s) => `${s}${(Date.now() % 100000)}_${counter++}`

async function setup(label) {
  const info = await createTenant({ label, planSlug: 'owner' })
  const tenantId = info.tenant.id

  const { rows: pRows } = await withBypass(() => query(
    `INSERT INTO products (tenant_id, sku, name, type, resin_type, length_mm, width_mm, thickness_mm)
     VALUES ($1, $2, 'Producto', 'corner_protector', 'PE', 100, 50, 10) RETURNING id`,
    [tenantId, uniq('S')]
  ))
  const productId = pRows[0].id

  const { rows: rm1 } = await withBypass(() => query(
    `INSERT INTO raw_materials (tenant_id, name, resin_type, item_kind)
     VALUES ($1, $2, 'PE', 'raw_material') RETURNING id`,
    [tenantId, uniq('MP-A')]
  ))
  const { rows: rm2 } = await withBypass(() => query(
    `INSERT INTO raw_materials (tenant_id, name, resin_type, item_kind)
     VALUES ($1, $2, 'PE', 'raw_material') RETURNING id`,
    [tenantId, uniq('MP-B')]
  ))

  const { rows: u } = await withBypass(() => query(
    `SELECT id FROM tenant_units WHERE tenant_id = $1 AND code = 'kg'`, [tenantId]
  ))
  const kgId = u[0].id

  return {
    tenantInfo: info, tenantId, productId,
    rmAId: rm1[0].id, rmBId: rm2[0].id, kgId,
  }
}

async function insertOrder(tenantId, productId, rmId, extras = {}) {
  const cols = ['tenant_id', 'order_number', 'product_id', 'raw_material_id', 'quantity_packages']
  const vals = [tenantId, uniq('O'), productId, rmId, 10]
  const params = vals.map((_, i) => `$${i + 1}`)
  let i = vals.length + 1
  for (const [k, v] of Object.entries(extras)) {
    cols.push(k); vals.push(v); params.push(`$${i++}`)
  }
  const { rows } = await withBypass(() => query(
    `INSERT INTO production_orders (${cols.join(',')}) VALUES (${params.join(',')}) RETURNING id`,
    vals
  ))
  return rows[0].id
}

describe('SaaS v2: recipeResolver — modo recipe', () => {
  let ctx, recipeId, orderId

  beforeAll(async () => {
    ctx = await setup('rr-rec')

    const sess = await loginAs({
      slug: ctx.tenantInfo.tenant.slug,
      email: ctx.tenantInfo.email,
      password: ctx.tenantInfo.password,
    })
    const client = authedClient({ slug: ctx.tenantInfo.tenant.slug, token: sess.token })

    // Crear receta v1 con 2 componentes
    const recipe = await client.post('/api/recipes', {
      product_id: ctx.productId,
      yield_quantity: 100,
      yield_unit_id: ctx.kgId,
      expected_scrap_pct: 5,
      components: [
        { raw_material_id: ctx.rmAId, quantity: 80, unit_id: ctx.kgId, sort_order: 10 },
        { raw_material_id: ctx.rmBId, quantity: 20, unit_id: ctx.kgId, sort_order: 20, is_optional: true },
      ],
    }).expect(201)
    recipeId = recipe.body.id

    orderId = await insertOrder(ctx.tenantId, ctx.productId, ctx.rmAId, { recipe_id: recipeId })
  })

  test('Devuelve mode=recipe con componentes ordenados y meta de receta', async () => {
    const result = await resolveRecipeForOrder({ tenantId: ctx.tenantId, orderId })
    expect(result.mode).toBe('recipe')
    expect(result.recipeId).toBe(recipeId)
    expect(result.recipeVersion).toBe(1)
    expect(result.yieldQuantity).toBe(100)
    expect(result.yieldUnitCode).toBe('kg')
    expect(result.expectedScrapPct).toBe(5)
    expect(result.components).toHaveLength(2)
    expect(result.components[0].quantity).toBe(80)
    expect(result.components[0].unitCode).toBe('kg')
    expect(result.components[0].percentage).toBeNull()
    expect(result.components[1].isOptional).toBe(true)
  })

  test('Componentes incluyen raw_material_name y substitute_group', async () => {
    const result = await resolveRecipeForOrder({ tenantId: ctx.tenantId, orderId })
    expect(result.components[0].rawMaterialName).toMatch(/MP-A/)
    expect(result.components[1].rawMaterialName).toMatch(/MP-B/)
    expect(result.components[0].substituteGroup).toBeNull()
  })
})

describe('SaaS v2: recipeResolver — modo legacy_formula', () => {
  let ctx, orderId

  beforeAll(async () => {
    ctx = await setup('rr-lf')
    orderId = await insertOrder(ctx.tenantId, ctx.productId, ctx.rmAId)
    // Insertar formula con 2 MPs (sin recipe_id)
    await withBypass(() => query(
      `INSERT INTO order_mp_formula (production_order_id, raw_material_id, percentage, sort_order)
       VALUES ($1, $2, 70, 10), ($1, $3, 30, 20)`,
      [orderId, ctx.rmAId, ctx.rmBId]
    ))
  })

  test('Devuelve mode=legacy_formula con porcentajes', async () => {
    const result = await resolveRecipeForOrder({ tenantId: ctx.tenantId, orderId })
    expect(result.mode).toBe('legacy_formula')
    expect(result.recipeId).toBeNull()
    expect(result.components).toHaveLength(2)
    expect(result.components[0].percentage).toBe(70)
    expect(result.components[1].percentage).toBe(30)
    expect(result.components[0].quantity).toBeNull()
    expect(result.components[0].unitCode).toBe('kg')
  })

  test('Ordena por sort_order', async () => {
    const result = await resolveRecipeForOrder({ tenantId: ctx.tenantId, orderId })
    expect(result.components[0].sortOrder).toBe(10)
    expect(result.components[1].sortOrder).toBe(20)
  })
})

describe('SaaS v2: recipeResolver — modo legacy_single', () => {
  let ctx, orderId

  beforeAll(async () => {
    ctx = await setup('rr-ls')
    orderId = await insertOrder(ctx.tenantId, ctx.productId, ctx.rmAId)
    // No insertamos formula, no asignamos recipe_id → cae en legacy_single
  })

  test('Devuelve mode=legacy_single con un componente al 100%', async () => {
    const result = await resolveRecipeForOrder({ tenantId: ctx.tenantId, orderId })
    expect(result.mode).toBe('legacy_single')
    expect(result.components).toHaveLength(1)
    expect(result.components[0].rawMaterialId).toBe(ctx.rmAId)
    expect(result.components[0].percentage).toBe(100)
    expect(result.components[0].unitCode).toBe('kg')
  })
})

describe('SaaS v2: recipeResolver — modo none', () => {
  let ctx, orderId

  beforeAll(async () => {
    ctx = await setup('rr-none')
    // Crear orden sin raw_material_id (la columna es opcional post-migration 039)
    const cols = ['tenant_id', 'order_number', 'product_id', 'quantity_packages']
    const vals = [ctx.tenantId, uniq('O'), ctx.productId, 5]
    const { rows } = await withBypass(() => query(
      `INSERT INTO production_orders (${cols.join(',')}) VALUES ($1,$2,$3,$4) RETURNING id`,
      vals
    ))
    orderId = rows[0].id
  })

  test('Devuelve mode=none con components vacío', async () => {
    const result = await resolveRecipeForOrder({ tenantId: ctx.tenantId, orderId })
    expect(result.mode).toBe('none')
    expect(result.components).toEqual([])
    expect(result.recipeId).toBeNull()
  })
})

describe('SaaS v2: recipeResolver — edge cases', () => {
  let ctx

  beforeAll(async () => { ctx = await setup('rr-edge') })

  test('Orden inexistente → null', async () => {
    const result = await resolveRecipeForOrder({
      tenantId: ctx.tenantId,
      orderId: '00000000-0000-0000-0000-000000000000',
    })
    expect(result).toBeNull()
  })

  test('Orden de OTRO tenant → null (cross-tenant isolation)', async () => {
    const otherCtx = await setup('rr-other')
    const otherOrderId = await insertOrder(otherCtx.tenantId, otherCtx.productId, otherCtx.rmAId)
    const result = await resolveRecipeForOrder({
      tenantId: ctx.tenantId,  // tenant DIFERENTE
      orderId: otherOrderId,
    })
    expect(result).toBeNull()
  })

  test('Falla sin tenantId o orderId', async () => {
    await expect(resolveRecipeForOrder({ tenantId: null, orderId: '...' })).rejects.toThrow()
    await expect(resolveRecipeForOrder({ tenantId: ctx.tenantId, orderId: null })).rejects.toThrow()
  })
})
