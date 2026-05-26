'use strict'

/**
 * SaaS v2 — Tests de recipes + recipe_components.
 *
 * Cubre:
 *  - POST crea v1 con componentes; segundo POST cierra v1 y crea v2.
 *  - Constraint partial unique (solo una vigente por producto).
 *  - GET con/sin filtros; GET por id incluye components.
 *  - Validaciones: yields positivos, scrap_pct rango, components no vacío,
 *    rm/unit/product pertenecen al tenant, raw_material_id duplicado.
 *  - PATCH solo metadata; cambios materiales rechazados.
 */

const { createTenant, loginAs, authedClient, cleanupTestTenants } = require('../helpers/factory')
const { pool, query, withBypass } = require('../../src/db')

afterAll(async () => {
  await cleanupTestTenants()
  await pool.end()
})

// ─── Helpers para crear pre-requisitos (productos, raw_materials) ─────────

async function createProduct(tenantId, sku, name) {
  const { rows } = await withBypass(() => query(
    `INSERT INTO products (tenant_id, sku, name, type, resin_type, length_mm, width_mm, thickness_mm)
     VALUES ($1, $2, $3, 'corner_protector', 'PE', 100, 50, 10)
     RETURNING id`,
    [tenantId, sku, name]
  ))
  return rows[0].id
}

async function createRm(tenantId, name) {
  const { rows } = await withBypass(() => query(
    `INSERT INTO raw_materials (tenant_id, name, resin_type, item_kind)
     VALUES ($1, $2, 'PE', 'raw_material') RETURNING id`,
    [tenantId, name]
  ))
  return rows[0].id
}

async function getUnitId(tenantId, code) {
  const { rows } = await withBypass(() => query(
    `SELECT id FROM tenant_units WHERE tenant_id = $1 AND code = $2`,
    [tenantId, code]
  ))
  return rows[0].id
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe('SaaS v2: POST /api/recipes — crear y versionar', () => {
  let client, tenantInfo, productId, rm1, rm2, rm3, kgId, pzaId

  beforeAll(async () => {
    tenantInfo = await createTenant({ label: 'recpost', planSlug: 'owner' })
    const sess = await loginAs({
      slug: tenantInfo.tenant.slug, email: tenantInfo.email, password: tenantInfo.password,
    })
    client = authedClient({ slug: tenantInfo.tenant.slug, token: sess.token })

    productId = await createProduct(tenantInfo.tenant.id, 'PAL-50', 'Palomitas 50g')
    rm1 = await createRm(tenantInfo.tenant.id, 'Maíz palomero')
    rm2 = await createRm(tenantInfo.tenant.id, 'Aceite')
    rm3 = await createRm(tenantInfo.tenant.id, 'Sal')
    kgId  = await getUnitId(tenantInfo.tenant.id, 'kg')
    pzaId = await getUnitId(tenantInfo.tenant.id, 'pza')
  })

  test('Crea v1 con 3 componentes', async () => {
    const res = await client.post('/api/recipes', {
      product_id: productId,
      yield_quantity: 10,
      yield_unit_id: kgId,
      expected_scrap_pct: 5,
      components: [
        { raw_material_id: rm1, quantity: 8,    unit_id: kgId, sort_order: 10 },
        { raw_material_id: rm2, quantity: 0.5,  unit_id: kgId, sort_order: 20 },
        { raw_material_id: rm3, quantity: 0.1,  unit_id: kgId, sort_order: 30, is_optional: true },
      ],
    }).expect(201)
    expect(res.body.version).toBe(1)
    expect(res.body.name).toBe('Receta v1')  // auto-generado
    expect(parseFloat(res.body.yield_quantity)).toBe(10)
    expect(parseFloat(res.body.expected_scrap_pct)).toBe(5)
    expect(res.body.valid_until).toBeNull()
    expect(res.body.is_active).toBe(true)
    expect(res.body.components).toHaveLength(3)
    expect(res.body.product_sku).toBe('PAL-50')
    expect(res.body.yield_unit_code).toBe('kg')
  })

  test('Segundo POST crea v2 y cierra v1', async () => {
    const res = await client.post('/api/recipes', {
      product_id: productId,
      name: 'Receta mejorada',
      yield_quantity: 12,
      yield_unit_id: kgId,
      components: [
        { raw_material_id: rm1, quantity: 9, unit_id: kgId },
        { raw_material_id: rm2, quantity: 0.6, unit_id: kgId },
      ],
    }).expect(201)
    expect(res.body.version).toBe(2)
    expect(res.body.name).toBe('Receta mejorada')
    expect(res.body.valid_until).toBeNull()
    expect(res.body.components).toHaveLength(2)

    // v1 ahora tiene valid_until != NULL
    const list = await client.get(`/api/recipes?productId=${productId}`).expect(200)
    expect(list.body).toHaveLength(2)
    const v1 = list.body.find(r => r.version === 1)
    expect(v1.valid_until).not.toBeNull()
  })

  test('GET con vigentOnly=true devuelve solo v2', async () => {
    const res = await client.get(`/api/recipes?productId=${productId}&vigentOnly=true`).expect(200)
    expect(res.body).toHaveLength(1)
    expect(res.body[0].version).toBe(2)
  })

  test('Acepta camelCase en body y components', async () => {
    const otherProduct = await createProduct(tenantInfo.tenant.id, 'PAL-100', 'Palomitas 100g')
    const res = await client.post('/api/recipes', {
      productId: otherProduct,
      yieldQuantity: 20,
      yieldUnitId: kgId,
      components: [
        { rawMaterialId: rm1, quantity: 16, unitId: kgId, isOptional: false, sortOrder: 10 },
      ],
    }).expect(201)
    expect(res.body.version).toBe(1)
    expect(res.body.components).toHaveLength(1)
  })
})

describe('SaaS v2: POST /api/recipes — validaciones', () => {
  let client, tenantInfo, productId, rm1, kgId, otherTenantRmId

  beforeAll(async () => {
    tenantInfo = await createTenant({ label: 'recval', planSlug: 'owner' })
    const sess = await loginAs({
      slug: tenantInfo.tenant.slug, email: tenantInfo.email, password: tenantInfo.password,
    })
    client = authedClient({ slug: tenantInfo.tenant.slug, token: sess.token })

    productId = await createProduct(tenantInfo.tenant.id, 'TST', 'Test')
    rm1 = await createRm(tenantInfo.tenant.id, 'MP test')
    kgId = await getUnitId(tenantInfo.tenant.id, 'kg')

    // Tenant ajeno para validar aislamiento
    const other = await createTenant({ label: 'recval-other', planSlug: 'owner' })
    otherTenantRmId = await createRm(other.tenant.id, 'MP de otro tenant')
  })

  test('Rechaza POST sin product_id', async () => {
    const res = await client.post('/api/recipes', {
      yield_quantity: 10, yield_unit_id: kgId,
      components: [{ raw_material_id: rm1, quantity: 1, unit_id: kgId }],
    })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/product_id/)
  })

  test('Rechaza yield_quantity <= 0', async () => {
    const res = await client.post('/api/recipes', {
      product_id: productId, yield_quantity: 0, yield_unit_id: kgId,
      components: [{ raw_material_id: rm1, quantity: 1, unit_id: kgId }],
    })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/yield_quantity/)
  })

  test('Rechaza expected_scrap_pct fuera de rango', async () => {
    const res = await client.post('/api/recipes', {
      product_id: productId, yield_quantity: 1, yield_unit_id: kgId,
      expected_scrap_pct: 150,
      components: [{ raw_material_id: rm1, quantity: 1, unit_id: kgId }],
    })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/expected_scrap_pct/)
  })

  test('Rechaza components vacío', async () => {
    const res = await client.post('/api/recipes', {
      product_id: productId, yield_quantity: 10, yield_unit_id: kgId,
      components: [],
    })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/components/)
  })

  test('Rechaza component con quantity <= 0', async () => {
    const res = await client.post('/api/recipes', {
      product_id: productId, yield_quantity: 10, yield_unit_id: kgId,
      components: [{ raw_material_id: rm1, quantity: 0, unit_id: kgId }],
    })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/quantity/)
  })

  test('Rechaza raw_material_id duplicado en components', async () => {
    const res = await client.post('/api/recipes', {
      product_id: productId, yield_quantity: 10, yield_unit_id: kgId,
      components: [
        { raw_material_id: rm1, quantity: 1, unit_id: kgId },
        { raw_material_id: rm1, quantity: 2, unit_id: kgId },
      ],
    })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/duplicado/)
  })

  test('Rechaza product_id de otro tenant', async () => {
    const res = await client.post('/api/recipes', {
      product_id: '00000000-0000-0000-0000-000000000000',
      yield_quantity: 1, yield_unit_id: kgId,
      components: [{ raw_material_id: rm1, quantity: 1, unit_id: kgId }],
    })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/product_id/)
  })

  test('Rechaza raw_material_id de otro tenant', async () => {
    const res = await client.post('/api/recipes', {
      product_id: productId, yield_quantity: 1, yield_unit_id: kgId,
      components: [{ raw_material_id: otherTenantRmId, quantity: 1, unit_id: kgId }],
    })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/raw_material_id/)
  })

  test('Rechaza yield_unit_id inexistente', async () => {
    const res = await client.post('/api/recipes', {
      product_id: productId, yield_quantity: 1,
      yield_unit_id: '00000000-0000-0000-0000-000000000000',
      components: [{ raw_material_id: rm1, quantity: 1, unit_id: kgId }],
    })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/unit_id/)
  })
})

describe('SaaS v2: GET /api/recipes/:id (con componentes)', () => {
  let client, tenantInfo, recipeId, rm1, rm2, kgId

  beforeAll(async () => {
    tenantInfo = await createTenant({ label: 'recget', planSlug: 'owner' })
    const sess = await loginAs({
      slug: tenantInfo.tenant.slug, email: tenantInfo.email, password: tenantInfo.password,
    })
    client = authedClient({ slug: tenantInfo.tenant.slug, token: sess.token })

    const productId = await createProduct(tenantInfo.tenant.id, 'GTP', 'Producto get test')
    rm1 = await createRm(tenantInfo.tenant.id, 'Aceite A')
    rm2 = await createRm(tenantInfo.tenant.id, 'Aceite B')
    kgId = await getUnitId(tenantInfo.tenant.id, 'kg')

    const post = await client.post('/api/recipes', {
      product_id: productId,
      yield_quantity: 5, yield_unit_id: kgId,
      components: [
        { raw_material_id: rm1, quantity: 1, unit_id: kgId, substitute_group: 'aceite', sort_order: 10 },
        { raw_material_id: rm2, quantity: 1, unit_id: kgId, substitute_group: 'aceite', sort_order: 20 },
      ],
    })
    recipeId = post.body.id
  })

  test('GET por id incluye components ordenados por sort_order', async () => {
    const res = await client.get(`/api/recipes/${recipeId}`).expect(200)
    expect(res.body.components).toHaveLength(2)
    expect(res.body.components[0].sort_order).toBe(10)
    expect(res.body.components[1].sort_order).toBe(20)
    expect(res.body.components[0].substitute_group).toBe('aceite')
    expect(res.body.components[0].raw_material_name).toBe('Aceite A')
    expect(res.body.components[0].unit_code).toBe('kg')
  })

  test('GET de id inexistente → 404', async () => {
    const res = await client.get('/api/recipes/00000000-0000-0000-0000-000000000000')
    expect(res.status).toBe(404)
  })
})

describe('SaaS v2: PATCH /api/recipes/:id — solo metadata', () => {
  let client, tenantInfo, recipeId, rm1, kgId

  beforeAll(async () => {
    tenantInfo = await createTenant({ label: 'recpatch', planSlug: 'owner' })
    const sess = await loginAs({
      slug: tenantInfo.tenant.slug, email: tenantInfo.email, password: tenantInfo.password,
    })
    client = authedClient({ slug: tenantInfo.tenant.slug, token: sess.token })

    const productId = await createProduct(tenantInfo.tenant.id, 'PCH', 'PCH')
    rm1 = await createRm(tenantInfo.tenant.id, 'MP')
    kgId = await getUnitId(tenantInfo.tenant.id, 'kg')

    const post = await client.post('/api/recipes', {
      product_id: productId,
      yield_quantity: 1, yield_unit_id: kgId,
      components: [{ raw_material_id: rm1, quantity: 1, unit_id: kgId }],
    })
    recipeId = post.body.id
  })

  test('PATCH name funciona', async () => {
    const res = await client.patch(`/api/recipes/${recipeId}`, {
      name: 'Receta renombrada',
    }).expect(200)
    expect(res.body.name).toBe('Receta renombrada')
  })

  test('PATCH is_active=false funciona', async () => {
    const res = await client.patch(`/api/recipes/${recipeId}`, {
      is_active: false,
    }).expect(200)
    expect(res.body.is_active).toBe(false)
  })

  test('PATCH rechaza campos materiales (yield_quantity)', async () => {
    const res = await client.patch(`/api/recipes/${recipeId}`, {
      yield_quantity: 999,
    })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/nueva versión/)
  })

  test('PATCH sin campos válidos → 400', async () => {
    const res = await client.patch(`/api/recipes/${recipeId}`, {})
    expect(res.status).toBe(400)
  })

  test('PATCH name vacío → 400', async () => {
    const res = await client.patch(`/api/recipes/${recipeId}`, { name: '  ' })
    expect(res.status).toBe(400)
  })

  test('404 para id inexistente', async () => {
    const res = await client.patch(
      '/api/recipes/00000000-0000-0000-0000-000000000000',
      { name: 'x' }
    )
    expect(res.status).toBe(404)
  })
})
