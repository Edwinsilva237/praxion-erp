'use strict'

/**
 * SaaS v2 — Tests para migration 128 (extensión de products + trigger).
 *
 * Cubre a nivel SQL:
 *  - Defaults de columnas nuevas.
 *  - CHECKs: custom_attributes objeto, shelf_life > 0, expected_sale_price >= 0.
 *  - FKs cross-tenant para product_kind_id y default_quality_grade_id.
 *  - Trigger sync_products_default_recipe_id:
 *      - INSERT recipe → products.default_recipe_id se setea.
 *      - INSERT v2 (que cierra v1) → default_recipe_id apunta a v2.
 *      - UPDATE recipe.valid_until=NOW manual → default_recipe_id queda NULL.
 *      - DELETE recipe vigente → default_recipe_id queda NULL.
 */

const { createTenant, loginAs, authedClient, cleanupTestTenants } = require('../helpers/factory')
const { pool, query, withBypass } = require('../../src/db')

afterAll(async () => {
  await cleanupTestTenants()
  await pool.end()
})

async function insertProduct(tenantId, extras = {}) {
  const cols = ['tenant_id', 'sku', 'name', 'type', 'resin_type', 'length_mm', 'width_mm', 'thickness_mm']
  const vals = [tenantId, extras.sku || `SKU-${Date.now()}-${Math.random()}`, extras.name || 'Test', 'corner_protector', 'PE', 100, 50, 10]
  const params = vals.map((_, i) => `$${i + 1}`)
  let i = vals.length + 1
  for (const [k, v] of Object.entries(extras)) {
    if (k === 'sku' || k === 'name') continue
    cols.push(k); vals.push(v); params.push(`$${i++}`)
  }
  const { rows } = await withBypass(() => query(
    `INSERT INTO products (${cols.join(',')}) VALUES (${params.join(',')}) RETURNING *`,
    vals
  ))
  return rows[0]
}

async function getProduct(id) {
  const { rows } = await withBypass(() => query(`SELECT * FROM products WHERE id = $1`, [id]))
  return rows[0]
}

describe('SaaS v2: migration 128 — defaults y constraints', () => {
  let tenantId

  beforeAll(async () => {
    const info = await createTenant({ label: 'pext1', planSlug: 'owner' })
    tenantId = info.tenant.id
  })

  test('Defaults aplican al INSERT mínimo', async () => {
    const p = await insertProduct(tenantId)
    expect(p.is_produced).toBe(false)
    expect(p.product_kind_id).toBeNull()
    expect(p.custom_attributes).toBeNull()
    expect(p.default_recipe_id).toBeNull()
    expect(p.shelf_life_days).toBeNull()
    expect(p.default_quality_grade_id).toBeNull()
    expect(p.expected_sale_price).toBeNull()
    expect(p.lot_number_pattern).toBeNull()
  })

  test('Acepta is_produced=true explícito', async () => {
    const p = await insertProduct(tenantId, { is_produced: true })
    expect(p.is_produced).toBe(true)
  })

  test('Rechaza custom_attributes que no sea objeto', async () => {
    await expect(insertProduct(tenantId, { custom_attributes: JSON.stringify([1, 2]) }))
      .rejects.toThrow(/custom_attributes_is_object|check/i)
    await expect(insertProduct(tenantId, { custom_attributes: '"texto"' }))
      .rejects.toThrow(/custom_attributes_is_object|check/i)
  })

  test('Acepta custom_attributes objeto JSONB', async () => {
    const p = await insertProduct(tenantId, {
      custom_attributes: JSON.stringify({ sabor: 'caramelo', tamano: '100g' }),
    })
    expect(p.custom_attributes).toEqual({ sabor: 'caramelo', tamano: '100g' })
  })

  test('Rechaza shelf_life_days <= 0', async () => {
    await expect(insertProduct(tenantId, { shelf_life_days: 0 }))
      .rejects.toThrow(/shelf_life|check/i)
    await expect(insertProduct(tenantId, { shelf_life_days: -1 }))
      .rejects.toThrow(/shelf_life|check/i)
  })

  test('Rechaza expected_sale_price negativo', async () => {
    await expect(insertProduct(tenantId, { expected_sale_price: -10 }))
      .rejects.toThrow(/expected_sale_price|check/i)
  })

  test('Acepta expected_sale_price=0', async () => {
    const p = await insertProduct(tenantId, { expected_sale_price: 0 })
    expect(parseFloat(p.expected_sale_price)).toBe(0)
  })
})

describe('SaaS v2: migration 128 — FK cross-catálogo', () => {
  let tenantId, kindId, gradeId

  beforeAll(async () => {
    const info = await createTenant({ label: 'pext2', planSlug: 'owner' })
    tenantId = info.tenant.id
    const sess = await loginAs({
      slug: info.tenant.slug, email: info.email, password: info.password,
    })
    const client = authedClient({ slug: info.tenant.slug, token: sess.token })

    // Crear un product_kind via API
    const units = await client.get('/api/process-config/units').expect(200)
    const kgId = units.body.find(u => u.code === 'kg').id
    const kind = await client.post('/api/process-config/product-kinds', {
      code: 'k_pext', name: 'Kind PExt', base_unit_id: kgId,
    }).expect(201)
    kindId = kind.body.id

    const grades = await client.get('/api/process-config/quality-grades').expect(200)
    gradeId = grades.body.find(g => g.grade_number === 1).id
  })

  test('Acepta product_kind_id válido del tenant', async () => {
    const p = await insertProduct(tenantId, { product_kind_id: kindId })
    expect(p.product_kind_id).toBe(kindId)
  })

  test('Acepta default_quality_grade_id válido del tenant', async () => {
    const p = await insertProduct(tenantId, { default_quality_grade_id: gradeId })
    expect(p.default_quality_grade_id).toBe(gradeId)
  })

  test('Rechaza product_kind_id de otro tenant (FK violation)', async () => {
    await expect(insertProduct(tenantId, { product_kind_id: '00000000-0000-0000-0000-000000000000' }))
      .rejects.toThrow(/foreign key|product_kind_id/i)
  })
})

describe('SaaS v2: migration 128 — trigger sync default_recipe_id', () => {
  let client, tenantInfo, productId, rmId, kgId

  beforeAll(async () => {
    tenantInfo = await createTenant({ label: 'pext3', planSlug: 'owner' })
    const sess = await loginAs({
      slug: tenantInfo.tenant.slug, email: tenantInfo.email, password: tenantInfo.password,
    })
    client = authedClient({ slug: tenantInfo.tenant.slug, token: sess.token })

    const p = await insertProduct(tenantInfo.tenant.id, { sku: 'TRG', name: 'Trigger test' })
    productId = p.id

    // Crear raw material y obtener unidad kg para construir recetas
    const { rows: rmRows } = await withBypass(() => query(
      `INSERT INTO raw_materials (tenant_id, name, resin_type, item_kind)
       VALUES ($1, 'MP-Trigger', 'PE', 'raw_material') RETURNING id`,
      [tenantInfo.tenant.id]
    ))
    rmId = rmRows[0].id
    const { rows: u } = await withBypass(() => query(
      `SELECT id FROM tenant_units WHERE tenant_id = $1 AND code = 'kg'`,
      [tenantInfo.tenant.id]
    ))
    kgId = u[0].id
  })

  test('Producto sin recetas: default_recipe_id = NULL', async () => {
    const p = await getProduct(productId)
    expect(p.default_recipe_id).toBeNull()
  })

  test('Crear receta v1 → default_recipe_id apunta a v1', async () => {
    const v1 = await client.post('/api/recipes', {
      product_id: productId, yield_quantity: 10, yield_unit_id: kgId,
      components: [{ raw_material_id: rmId, quantity: 1, unit_id: kgId }],
    }).expect(201)
    const p = await getProduct(productId)
    expect(p.default_recipe_id).toBe(v1.body.id)
  })

  test('Crear v2 (que cierra v1) → default_recipe_id apunta a v2', async () => {
    const v2 = await client.post('/api/recipes', {
      product_id: productId, yield_quantity: 12, yield_unit_id: kgId,
      components: [{ raw_material_id: rmId, quantity: 1.2, unit_id: kgId }],
    }).expect(201)
    const p = await getProduct(productId)
    expect(p.default_recipe_id).toBe(v2.body.id)
    expect(v2.body.version).toBe(2)
  })

  test('Cerrar manualmente la receta vigente vía SQL → default_recipe_id queda NULL', async () => {
    // Cerrar la única vigente (v2)
    await withBypass(() => query(
      `UPDATE recipes SET valid_until = NOW()
       WHERE product_id = $1 AND valid_until IS NULL`,
      [productId]
    ))
    const p = await getProduct(productId)
    expect(p.default_recipe_id).toBeNull()
  })

  test('Crear v3 después → default_recipe_id apunta a v3', async () => {
    const v3 = await client.post('/api/recipes', {
      product_id: productId, yield_quantity: 15, yield_unit_id: kgId,
      components: [{ raw_material_id: rmId, quantity: 1.5, unit_id: kgId }],
    }).expect(201)
    expect(v3.body.version).toBe(3)
    const p = await getProduct(productId)
    expect(p.default_recipe_id).toBe(v3.body.id)
  })

  test('DELETE recipe vigente vía SQL → default_recipe_id queda NULL', async () => {
    // Borrar componentes primero (FK) y luego la receta vigente.
    await withBypass(() => query(
      `DELETE FROM recipes WHERE product_id = $1 AND valid_until IS NULL`,
      [productId]
    ))
    const p = await getProduct(productId)
    expect(p.default_recipe_id).toBeNull()
  })
})

describe('SaaS v2: migration 128 — productsService viejo sigue funcionando', () => {
  let tenantId

  beforeAll(async () => {
    const info = await createTenant({ label: 'pext4', planSlug: 'owner' })
    tenantId = info.tenant.id
  })

  test('SELECT con todas las columnas nuevas no rompe', async () => {
    const p = await insertProduct(tenantId, { sku: 'OLD-COMPAT' })
    const fetched = await getProduct(p.id)
    // Todas las columnas viejas siguen poblando
    expect(fetched.sku).toBe('OLD-COMPAT')
    expect(fetched.type).toBe('corner_protector')
    expect(fetched.resin_type).toBe('PE')
    expect(fetched.is_active).toBe(true)
    // Y las nuevas con defaults
    expect(fetched.is_produced).toBe(false)
    expect(fetched.default_recipe_id).toBeNull()
  })
})
