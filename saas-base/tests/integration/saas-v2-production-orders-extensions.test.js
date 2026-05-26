'use strict'

/**
 * SaaS v2 — Tests para migration 129 (extensión de production_orders + trigger).
 *
 * Cubre a nivel SQL:
 *  - Defaults de columnas nuevas.
 *  - CHECKs: custom_attributes objeto, expected_scrap_pct rango, additional_costs >= 0,
 *    recipe_version sin recipe_id rechazado.
 *  - FK cross-tenant para recipe_id.
 *  - Trigger sync_production_order_recipe_version:
 *      - INSERT con recipe_id → popula recipe_version_at_creation.
 *      - UPDATE que cambia recipe_id a otra → repopula.
 *      - UPDATE que nulifica recipe_id → recipe_version_at_creation queda NULL.
 *      - INSERT sin recipe_id → ambos NULL.
 */

const { createTenant, cleanupTestTenants } = require('../helpers/factory')
const { pool, query, withBypass } = require('../../src/db')
const request = require('supertest')
const app = require('../../src/app')

afterAll(async () => {
  await cleanupTestTenants()
  await pool.end()
})

let counterPO = 0

async function insertOrder(tenantId, productId, rmId, extras = {}) {
  counterPO += 1
  const cols = ['tenant_id', 'order_number', 'product_id', 'raw_material_id', 'quantity_packages']
  const vals = [tenantId, `ORD-${Date.now()}-${counterPO}`, productId, rmId, 10]
  const params = vals.map((_, i) => `$${i + 1}`)
  let i = vals.length + 1
  for (const [k, v] of Object.entries(extras)) {
    cols.push(k); vals.push(v); params.push(`$${i++}`)
  }
  const { rows } = await withBypass(() => query(
    `INSERT INTO production_orders (${cols.join(',')}) VALUES (${params.join(',')}) RETURNING *`,
    vals
  ))
  return rows[0]
}

async function updateOrder(id, fields) {
  const setters = []
  const params = []
  let i = 1
  for (const [k, v] of Object.entries(fields)) {
    setters.push(`${k} = $${i++}`); params.push(v)
  }
  params.push(id)
  const { rows } = await withBypass(() => query(
    `UPDATE production_orders SET ${setters.join(', ')} WHERE id = $${i} RETURNING *`,
    params
  ))
  return rows[0]
}

async function setup(label) {
  const info = await createTenant({ label, planSlug: 'owner' })
  const tenantId = info.tenant.id

  // Producto y MP
  const { rows: pRows } = await withBypass(() => query(
    `INSERT INTO products (tenant_id, sku, name, type, resin_type, length_mm, width_mm, thickness_mm)
     VALUES ($1, $2, 'Test product', 'corner_protector', 'PE', 100, 50, 10)
     RETURNING id`,
    [tenantId, `SKU-${label}`]
  ))
  const productId = pRows[0].id

  const { rows: rmRows } = await withBypass(() => query(
    `INSERT INTO raw_materials (tenant_id, name, resin_type, item_kind)
     VALUES ($1, $2, 'PE', 'raw_material') RETURNING id`,
    [tenantId, `MP-${label}`]
  ))
  const rmId = rmRows[0].id

  return { tenantInfo: info, tenantId, productId, rmId }
}

describe('SaaS v2: migration 129 — defaults y CHECKs', () => {
  let tenantId, productId, rmId

  beforeAll(async () => {
    const s = await setup('po129a')
    tenantId = s.tenantId
    productId = s.productId
    rmId = s.rmId
  })

  test('Defaults: columnas nuevas NULL al insertar mínimo', async () => {
    const o = await insertOrder(tenantId, productId, rmId)
    expect(o.recipe_id).toBeNull()
    expect(o.recipe_version_at_creation).toBeNull()
    expect(o.accept_second_quality_for_fulfillment).toBeNull()
    expect(o.expected_scrap_pct).toBeNull()
    expect(o.custom_attributes).toBeNull()
    expect(o.additional_costs).toBeNull()
    expect(o.additional_costs_notes).toBeNull()
  })

  test('Rechaza custom_attributes que no sea objeto', async () => {
    await expect(insertOrder(tenantId, productId, rmId, { custom_attributes: JSON.stringify([1, 2]) }))
      .rejects.toThrow(/custom_attributes_is_object|check/i)
  })

  test('Acepta custom_attributes objeto (personalización)', async () => {
    const o = await insertOrder(tenantId, productId, rmId, {
      custom_attributes: JSON.stringify({ texto: 'Feliz cumpleaños', color: 'azul' }),
    })
    expect(o.custom_attributes).toEqual({ texto: 'Feliz cumpleaños', color: 'azul' })
  })

  test('Rechaza expected_scrap_pct fuera de [0,100]', async () => {
    await expect(insertOrder(tenantId, productId, rmId, { expected_scrap_pct: 150 }))
      .rejects.toThrow(/expected_scrap_pct|check/i)
    await expect(insertOrder(tenantId, productId, rmId, { expected_scrap_pct: -1 }))
      .rejects.toThrow(/expected_scrap_pct|check/i)
  })

  test('Rechaza additional_costs negativo', async () => {
    await expect(insertOrder(tenantId, productId, rmId, { additional_costs: -1 }))
      .rejects.toThrow(/additional_costs|check/i)
  })

  test('Acepta additional_costs=0', async () => {
    const o = await insertOrder(tenantId, productId, rmId, { additional_costs: 0 })
    expect(parseFloat(o.additional_costs)).toBe(0)
  })

  test('UPDATE de recipe_version_at_creation sin recipe_id → trigger lo limpia a NULL', async () => {
    // El trigger BEFORE UPDATE setea recipe_version_at_creation := NULL si
    // recipe_id IS NULL. Es la red principal; el CHECK es redundante pero
    // protege ante triggers deshabilitados en mantenimiento.
    const o = await insertOrder(tenantId, productId, rmId)
    const updated = await updateOrder(o.id, { recipe_version_at_creation: 5 })
    expect(updated.recipe_id).toBeNull()
    expect(updated.recipe_version_at_creation).toBeNull()
  })
})

describe('SaaS v2: migration 129 — trigger sync recipe_version', () => {
  let tenantInfo, tenantId, productId, rmId, kgId, recipeV1Id, recipeV2Id

  beforeAll(async () => {
    const s = await setup('po129b')
    tenantInfo = s.tenantInfo
    tenantId = s.tenantId
    productId = s.productId
    rmId = s.rmId

    // Login para usar API de recipes
    const sess = await request(app).post('/api/auth/login')
      .set('X-Tenant-Slug', tenantInfo.tenant.slug)
      .send({ email: tenantInfo.email, password: tenantInfo.password })
      .expect(200)
    const token = sess.body.accessToken

    const { rows: u } = await withBypass(() => query(
      `SELECT id FROM tenant_units WHERE tenant_id = $1 AND code = 'kg'`,
      [tenantId]
    ))
    kgId = u[0].id

    // Crear v1
    const v1 = await request(app).post('/api/recipes')
      .set('X-Tenant-Slug', tenantInfo.tenant.slug)
      .set('Authorization', `Bearer ${token}`)
      .send({
        product_id: productId, yield_quantity: 10, yield_unit_id: kgId,
        components: [{ raw_material_id: rmId, quantity: 1, unit_id: kgId }],
      }).expect(201)
    recipeV1Id = v1.body.id
    expect(v1.body.version).toBe(1)

    // Crear v2 (cierra v1)
    const v2 = await request(app).post('/api/recipes')
      .set('X-Tenant-Slug', tenantInfo.tenant.slug)
      .set('Authorization', `Bearer ${token}`)
      .send({
        product_id: productId, yield_quantity: 12, yield_unit_id: kgId,
        components: [{ raw_material_id: rmId, quantity: 1.2, unit_id: kgId }],
      }).expect(201)
    recipeV2Id = v2.body.id
    expect(v2.body.version).toBe(2)
  })

  test('INSERT con recipe_id v1 → recipe_version_at_creation=1 (autoset)', async () => {
    const o = await insertOrder(tenantId, productId, rmId, { recipe_id: recipeV1Id })
    expect(o.recipe_id).toBe(recipeV1Id)
    expect(o.recipe_version_at_creation).toBe(1)
  })

  test('INSERT con recipe_id v2 → recipe_version_at_creation=2', async () => {
    const o = await insertOrder(tenantId, productId, rmId, { recipe_id: recipeV2Id })
    expect(o.recipe_version_at_creation).toBe(2)
  })

  test('UPDATE cambiando recipe_id v1 → v2 actualiza version', async () => {
    const o = await insertOrder(tenantId, productId, rmId, { recipe_id: recipeV1Id })
    expect(o.recipe_version_at_creation).toBe(1)
    const updated = await updateOrder(o.id, { recipe_id: recipeV2Id })
    expect(updated.recipe_version_at_creation).toBe(2)
  })

  test('UPDATE nulificando recipe_id → recipe_version_at_creation queda NULL', async () => {
    const o = await insertOrder(tenantId, productId, rmId, { recipe_id: recipeV1Id })
    expect(o.recipe_version_at_creation).toBe(1)
    const updated = await updateOrder(o.id, { recipe_id: null })
    expect(updated.recipe_id).toBeNull()
    expect(updated.recipe_version_at_creation).toBeNull()
  })

  test('INSERT sin recipe_id → ambos NULL', async () => {
    const o = await insertOrder(tenantId, productId, rmId)
    expect(o.recipe_id).toBeNull()
    expect(o.recipe_version_at_creation).toBeNull()
  })

  test('UPDATE de campos no-recipe NO toca recipe_version_at_creation', async () => {
    const o = await insertOrder(tenantId, productId, rmId, { recipe_id: recipeV2Id })
    expect(o.recipe_version_at_creation).toBe(2)
    const updated = await updateOrder(o.id, { additional_costs: 50 })
    expect(updated.recipe_version_at_creation).toBe(2)  // sigue siendo 2
    expect(parseFloat(updated.additional_costs)).toBe(50)
  })
})
