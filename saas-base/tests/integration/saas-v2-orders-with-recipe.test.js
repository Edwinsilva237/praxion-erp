'use strict'

/**
 * SaaS v2 — Tests del refactor §5d-2 + §5e:
 *
 *  - previewStockForNewOrder con `recipeId + totalPtKg` (path nuevo).
 *  - createOrder con `recipe_id` (mutuamente excluyente con mp_formula).
 *  - updateOrder con `recipe_id`: asignar/cambiar/limpiar; restricción de capturas.
 *  - Validaciones: recipe no existe, recipe de otro tenant, recipe de otro producto.
 *  - Trigger sync_production_order_recipe_version sigue funcionando vía service.
 */

const { createTenant, loginAs, authedClient, cleanupTestTenants } = require('../helpers/factory')
const { pool, query, withBypass } = require('../../src/db')

afterAll(async () => {
  await cleanupTestTenants()
  await pool.end()
})

let counter = 0
const uniq = (s) => `${s}${(Date.now() % 100000)}_${counter++}`

async function setup(label) {
  const info = await createTenant({ label, planSlug: 'owner' })
  const sess = await loginAs({
    slug: info.tenant.slug, email: info.email, password: info.password,
  })
  const client = authedClient({ slug: info.tenant.slug, token: sess.token })
  const tenantId = info.tenant.id

  const { rows: pRows } = await withBypass(() => query(
    `INSERT INTO products (tenant_id, sku, name, type, resin_type, length_mm, width_mm, thickness_mm)
     VALUES ($1, $2, 'P', 'corner_protector', 'PE', 100, 50, 10) RETURNING id`,
    [tenantId, uniq('S')]
  ))
  const productId = pRows[0].id

  const { rows: rmRows } = await withBypass(() => query(
    `INSERT INTO raw_materials (tenant_id, name, resin_type, item_kind)
     VALUES ($1, $2, 'PE', 'raw_material'), ($1, $3, 'PE', 'raw_material') RETURNING id`,
    [tenantId, uniq('MP-A'), uniq('MP-B')]
  ))
  const rmAId = rmRows[0].id
  const rmBId = rmRows[1].id

  const { rows: u } = await withBypass(() => query(
    `SELECT id FROM tenant_units WHERE tenant_id = $1 AND code = 'kg'`, [tenantId]
  ))
  const kgId = u[0].id

  // Crear receta v1 con 2 componentes (yield 100 kg)
  const recipe = await client.post('/api/recipes', {
    product_id: productId,
    yield_quantity: 100, yield_unit_id: kgId, expected_scrap_pct: 5,
    components: [
      { raw_material_id: rmAId, quantity: 80, unit_id: kgId, sort_order: 10 },
      { raw_material_id: rmBId, quantity: 20, unit_id: kgId, sort_order: 20 },
    ],
  }).expect(201)

  return { info, client, tenantId, productId, rmAId, rmBId, kgId, recipeId: recipe.body.id }
}

// ─── createOrder ──────────────────────────────────────────────────────────

describe('SaaS v2: POST /api/production/orders con recipe_id', () => {
  let ctx

  beforeAll(async () => { ctx = await setup('ord-rec-create') })

  test('Crea orden con recipe_id; recipe_version_at_creation=1 (trigger)', async () => {
    const res = await ctx.client.post('/api/production/orders', {
      productId: ctx.productId,
      quantityPackages: 10,
      recipeId: ctx.recipeId,
    }).expect(201)
    expect(res.body.recipe_id).toBe(ctx.recipeId)
    expect(res.body.recipe_version_at_creation).toBe(1)
  })

  test('Rechaza si se pasan recipe_id Y mp_formula juntos (400)', async () => {
    const res = await ctx.client.post('/api/production/orders', {
      productId: ctx.productId,
      quantityPackages: 5,
      recipeId: ctx.recipeId,
      mpFormula: [{ rawMaterialId: ctx.rmAId, percentage: 100 }],
    })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/mutuamente excluyentes|recipe_id/)
  })

  test('Rechaza recipe_id inexistente (400)', async () => {
    const res = await ctx.client.post('/api/production/orders', {
      productId: ctx.productId,
      quantityPackages: 5,
      recipeId: '00000000-0000-0000-0000-000000000000',
    })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/recipe_id no existe/)
  })

  test('Rechaza recipe_id de otro producto (400)', async () => {
    // Otro producto sin recetas asociadas
    const { rows: p2 } = await withBypass(() => query(
      `INSERT INTO products (tenant_id, sku, name, type, resin_type, length_mm, width_mm, thickness_mm)
       VALUES ($1, $2, 'P2', 'corner_protector', 'PE', 100, 50, 10) RETURNING id`,
      [ctx.tenantId, uniq('S2')]
    ))
    const res = await ctx.client.post('/api/production/orders', {
      productId: p2[0].id,
      quantityPackages: 5,
      recipeId: ctx.recipeId,  // recipe del primer producto
    })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/no corresponde al producto/)
  })

  test('Modo legacy (sin recipe_id, con mpFormula) sigue funcionando intacto', async () => {
    const res = await ctx.client.post('/api/production/orders', {
      productId: ctx.productId,
      rawMaterialId: ctx.rmAId,
      lengthMm: 100,
      quantityPackages: 8,
      mpFormula: [
        { rawMaterialId: ctx.rmAId, percentage: 80 },
        { rawMaterialId: ctx.rmBId, percentage: 20 },
      ],
    }).expect(201)
    expect(res.body.recipe_id).toBeNull()
    expect(res.body.recipe_version_at_creation).toBeNull()
    // Verificar que SÍ se insertaron filas en order_mp_formula
    const { rows } = await withBypass(() => query(
      `SELECT COUNT(*)::int AS c FROM order_mp_formula WHERE production_order_id = $1`,
      [res.body.id]
    ))
    expect(rows[0].c).toBe(2)
  })

  test('Orden con recipe_id NO inserta filas en order_mp_formula', async () => {
    const res = await ctx.client.post('/api/production/orders', {
      productId: ctx.productId,
      quantityPackages: 3,
      recipeId: ctx.recipeId,
    }).expect(201)
    const { rows } = await withBypass(() => query(
      `SELECT COUNT(*)::int AS c FROM order_mp_formula WHERE production_order_id = $1`,
      [res.body.id]
    ))
    expect(rows[0].c).toBe(0)
  })
})

// ─── updateOrder ──────────────────────────────────────────────────────────

describe('SaaS v2: PATCH /api/production/orders/:id con recipe_id', () => {
  let ctx, legacyOrderId, recipeOrderId

  beforeAll(async () => {
    ctx = await setup('ord-rec-update')

    // Orden legacy (con mp_formula)
    const r1 = await ctx.client.post('/api/production/orders', {
      productId: ctx.productId, lengthMm: 100, quantityPackages: 10,
      mpFormula: [{ rawMaterialId: ctx.rmAId, percentage: 100 }],
    }).expect(201)
    legacyOrderId = r1.body.id

    // Orden con recipe
    const r2 = await ctx.client.post('/api/production/orders', {
      productId: ctx.productId, quantityPackages: 10, recipeId: ctx.recipeId,
    }).expect(201)
    recipeOrderId = r2.body.id
  })

  test('PATCH asignar recipe_id a orden legacy', async () => {
    const res = await ctx.client.patch(`/api/production/orders/${legacyOrderId}`, {
      recipeId: ctx.recipeId,
    }).expect(200)
    expect(res.body.recipe_id).toBe(ctx.recipeId)
    expect(res.body.recipe_version_at_creation).toBe(1)
    // Limpia order_mp_formula viejo
    const { rows } = await withBypass(() => query(
      `SELECT COUNT(*)::int AS c FROM order_mp_formula WHERE production_order_id = $1`,
      [legacyOrderId]
    ))
    expect(rows[0].c).toBe(0)
  })

  test('PATCH recipeId=null limpia a NULL (vuelve a legacy)', async () => {
    const res = await ctx.client.patch(`/api/production/orders/${recipeOrderId}`, {
      recipeId: null,
    }).expect(200)
    expect(res.body.recipe_id).toBeNull()
    expect(res.body.recipe_version_at_creation).toBeNull()
  })

  test('PATCH sin recipeId no toca el campo', async () => {
    // Re-asignar recipe primero
    await ctx.client.patch(`/api/production/orders/${recipeOrderId}`, {
      recipeId: ctx.recipeId,
    }).expect(200)
    // PATCH solo notes
    const res = await ctx.client.patch(`/api/production/orders/${recipeOrderId}`, {
      notes: 'Nota nueva',
    }).expect(200)
    expect(res.body.recipe_id).toBe(ctx.recipeId)
    expect(res.body.notes).toBe('Nota nueva')
  })

  test('PATCH rechaza recipe_id y mp_formula juntos (400)', async () => {
    const res = await ctx.client.patch(`/api/production/orders/${recipeOrderId}`, {
      recipeId: ctx.recipeId,
      mpFormula: [{ rawMaterialId: ctx.rmAId, percentage: 100 }],
    })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/mutuamente excluyentes/)
  })

  test('PATCH rechaza recipe_id inexistente', async () => {
    const res = await ctx.client.patch(`/api/production/orders/${recipeOrderId}`, {
      recipeId: '00000000-0000-0000-0000-000000000000',
    })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/recipe_id no existe/)
  })
})

// ─── previewStockForNewOrder ──────────────────────────────────────────────

describe('SaaS v2: POST /api/production/orders/preview-stock con recipe_id', () => {
  let ctx

  beforeAll(async () => { ctx = await setup('ord-rec-preview') })

  test('Path nuevo: recipeId + totalPtKg devuelve items con requiredKg por componente', async () => {
    const res = await ctx.client.post('/api/production/orders/preview-stock', {
      recipeId: ctx.recipeId,
      totalPtKg: 200,  // 2× la corrida (yield_quantity=100), reproceso=5%
    }).expect(200)
    expect(res.body.items).toHaveLength(2)
    // Componente A: 80 kg × 2 corridas × 1.05 = 168
    expect(res.body.items[0].requiredKg).toBeCloseTo(168, 2)
    // Componente B: 20 kg × 2 corridas × 1.05 = 42
    expect(res.body.items[1].requiredKg).toBeCloseTo(42, 2)
    // Sin stock disponible → ok=false (todo missing)
    expect(res.body.ok).toBe(false)
    expect(res.body.meta.ptKgEstimado).toBe(200)
    expect(res.body.meta.reprocessFactor).toBeCloseTo(0.05, 2)
  })

  test('Rechaza recipeId sin totalPtKg (400)', async () => {
    const res = await ctx.client.post('/api/production/orders/preview-stock', {
      recipeId: ctx.recipeId,
    })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/totalPtKg/)
  })

  test('Rechaza recipeId inexistente (404)', async () => {
    const res = await ctx.client.post('/api/production/orders/preview-stock', {
      recipeId: '00000000-0000-0000-0000-000000000000',
      totalPtKg: 100,
    })
    expect(res.status).toBe(404)
  })

  test('Path legacy (mpFormula + lengthMm + quantityPackages) sigue funcionando', async () => {
    const res = await ctx.client.post('/api/production/orders/preview-stock', {
      productId: ctx.productId,
      lengthMm: 100,
      quantityPackages: 10,
      mpFormula: [
        { rawMaterialId: ctx.rmAId, percentage: 70 },
        { rawMaterialId: ctx.rmBId, percentage: 30 },
      ],
    }).expect(200)
    expect(res.body).toHaveProperty('items')
    expect(res.body).toHaveProperty('totals')
    expect(res.body).toHaveProperty('meta')
  })
})
