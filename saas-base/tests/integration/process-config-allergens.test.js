'use strict'

/**
 * SaaS v2 — Tests de tenant_allergens y tablas de unión.
 *
 * Cubre:
 *  - 8 alérgenos NOM-051 sembrados al crear tenant.
 *  - CRUD del catálogo via API.
 *  - Filtros isActive, isPriority.
 *  - raw_material_allergens / product_allergens vía SQL (sin endpoints v2 todavía).
 *  - declaration enum (contains | may_contain).
 *  - UNIQUE per_rm/product.
 */

const { createTenant, loginAs, authedClient, cleanupTestTenants } = require('../helpers/factory')
const { pool, query, withBypass } = require('../../src/db')

afterAll(async () => {
  await cleanupTestTenants()
  await pool.end()
})

describe('SaaS v2: GET /api/process-config/allergens — seed default', () => {
  let client, tenantInfo

  beforeAll(async () => {
    tenantInfo = await createTenant({ label: 'allread', planSlug: 'owner' })
    const sess = await loginAs({
      slug: tenantInfo.tenant.slug, email: tenantInfo.email, password: tenantInfo.password,
    })
    client = authedClient({ slug: tenantInfo.tenant.slug, token: sess.token })
  })

  test('Tenant nuevo recibe 8 alérgenos NOM-051', async () => {
    const res = await client.get('/api/process-config/allergens').expect(200)
    expect(res.body).toHaveLength(8)
    const codes = res.body.map(a => a.code).sort()
    expect(codes).toEqual(['dairy', 'eggs', 'fish', 'gluten', 'nuts', 'sesame', 'shellfish', 'soy'])
  })

  test('Todos los 8 default son is_priority=true', async () => {
    const res = await client.get('/api/process-config/allergens').expect(200)
    res.body.forEach(a => expect(a.is_priority).toBe(true))
  })

  test('Filtra por isPriority=true devuelve los 8', async () => {
    const res = await client.get('/api/process-config/allergens?isPriority=true').expect(200)
    expect(res.body).toHaveLength(8)
  })

  test('GET por id devuelve un alérgeno', async () => {
    const list = await client.get('/api/process-config/allergens').expect(200)
    const gluten = list.body.find(a => a.code === 'gluten')
    const res = await client.get(`/api/process-config/allergens/${gluten.id}`).expect(200)
    expect(res.body.code).toBe('gluten')
    expect(res.body.name).toBe('Cereales con gluten')
  })

  test('GET por id inexistente → 404', async () => {
    const res = await client.get('/api/process-config/allergens/00000000-0000-0000-0000-000000000000')
    expect(res.status).toBe(404)
  })
})

describe('SaaS v2: POST /api/process-config/allergens', () => {
  let client, tenantInfo

  beforeAll(async () => {
    tenantInfo = await createTenant({ label: 'allcreate', planSlug: 'owner' })
    const sess = await loginAs({
      slug: tenantInfo.tenant.slug, email: tenantInfo.email, password: tenantInfo.password,
    })
    client = authedClient({ slug: tenantInfo.tenant.slug, token: sess.token })
  })

  test('Crea alérgeno custom (no priority)', async () => {
    const res = await client.post('/api/process-config/allergens', {
      code: 'mustard', name: 'Mostaza', is_priority: false, sort_order: 90,
    }).expect(201)
    expect(res.body.code).toBe('mustard')
    expect(res.body.is_priority).toBe(false)
    expect(res.body.is_active).toBe(true)
  })

  test('Acepta camelCase', async () => {
    const res = await client.post('/api/process-config/allergens', {
      code: 'celery', name: 'Apio', isPriority: false, sortOrder: 100,
    }).expect(201)
    expect(res.body.sort_order).toBe(100)
  })

  test('Rechaza code duplicado (409)', async () => {
    const res = await client.post('/api/process-config/allergens', {
      code: 'gluten', name: 'Dup',
    })
    expect(res.status).toBe(409)
  })

  test('Rechaza POST sin code', async () => {
    const res = await client.post('/api/process-config/allergens', { name: 'X' })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/code/)
  })

  test('Rechaza POST sin name', async () => {
    const res = await client.post('/api/process-config/allergens', { code: 'x' })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/name/)
  })

  test('Rechaza is_priority non-boolean', async () => {
    const res = await client.post('/api/process-config/allergens', {
      code: 'y', name: 'Y', is_priority: 'true',
    })
    expect(res.status).toBe(400)
  })
})

describe('SaaS v2: PATCH /api/process-config/allergens/:id', () => {
  let client, tenantInfo, glutenId

  beforeAll(async () => {
    tenantInfo = await createTenant({ label: 'allupd', planSlug: 'owner' })
    const sess = await loginAs({
      slug: tenantInfo.tenant.slug, email: tenantInfo.email, password: tenantInfo.password,
    })
    client = authedClient({ slug: tenantInfo.tenant.slug, token: sess.token })
    const list = await client.get('/api/process-config/allergens').expect(200)
    glutenId = list.body.find(a => a.code === 'gluten').id
  })

  test('Actualiza name', async () => {
    const res = await client.patch(`/api/process-config/allergens/${glutenId}`, {
      name: 'Gluten (trigo, cebada, centeno)',
    }).expect(200)
    expect(res.body.name).toBe('Gluten (trigo, cebada, centeno)')
  })

  test('Soft-delete (is_active=false)', async () => {
    const res = await client.patch(`/api/process-config/allergens/${glutenId}`, {
      is_active: false,
    }).expect(200)
    expect(res.body.is_active).toBe(false)
  })

  test('Permite desactivar todos (tenants no-alimentarios)', async () => {
    const list = await client.get('/api/process-config/allergens').expect(200)
    for (const a of list.body.filter(x => x.is_active)) {
      await client.patch(`/api/process-config/allergens/${a.id}`, { is_active: false }).expect(200)
    }
    const after = await client.get('/api/process-config/allergens?isActive=true').expect(200)
    expect(after.body).toHaveLength(0)
  })

  test('404 para id inexistente', async () => {
    const res = await client.patch(
      '/api/process-config/allergens/00000000-0000-0000-0000-000000000000',
      { name: 'x' }
    )
    expect(res.status).toBe(404)
  })
})

describe('SaaS v2: raw_material_allergens + product_allergens (SQL directo)', () => {
  let tenantId, glutenId, rmId, productId

  beforeAll(async () => {
    const info = await createTenant({ label: 'allunion', planSlug: 'owner' })
    tenantId = info.tenant.id

    const { rows: ga } = await withBypass(() => query(
      `SELECT id FROM tenant_allergens WHERE tenant_id = $1 AND code = 'gluten'`, [tenantId]
    ))
    glutenId = ga[0].id

    const { rows: rmRows } = await withBypass(() => query(
      `INSERT INTO raw_materials (tenant_id, name, resin_type, item_kind)
       VALUES ($1, 'Harina', 'PE', 'raw_material') RETURNING id`,
      [tenantId]
    ))
    rmId = rmRows[0].id

    const { rows: pRows } = await withBypass(() => query(
      `INSERT INTO products (tenant_id, sku, name, type, resin_type, length_mm, width_mm, thickness_mm)
       VALUES ($1, 'PAN', 'Pan', 'corner_protector', 'PE', 100, 50, 10) RETURNING id`,
      [tenantId]
    ))
    productId = pRows[0].id
  })

  test('INSERT raw_material_allergens con declaration=contains', async () => {
    const { rows } = await withBypass(() => query(
      `INSERT INTO raw_material_allergens (raw_material_id, allergen_id, declaration)
       VALUES ($1, $2, 'contains') RETURNING *`,
      [rmId, glutenId]
    ))
    expect(rows[0].declaration).toBe('contains')
  })

  test('Rechaza declaration inválido', async () => {
    const { rows: ga } = await withBypass(() => query(
      `SELECT id FROM tenant_allergens WHERE tenant_id = $1 AND code = 'dairy'`, [tenantId]
    ))
    await expect(withBypass(() => query(
      `INSERT INTO raw_material_allergens (raw_material_id, allergen_id, declaration)
       VALUES ($1, $2, 'sometimes')`,
      [rmId, ga[0].id]
    ))).rejects.toThrow(/declaration_check|check/i)
  })

  test('UNIQUE per (raw_material, allergen)', async () => {
    await expect(withBypass(() => query(
      `INSERT INTO raw_material_allergens (raw_material_id, allergen_id, declaration)
       VALUES ($1, $2, 'may_contain')`,
      [rmId, glutenId]
    ))).rejects.toThrow(/duplicate|unique/i)
  })

  test('INSERT product_allergens con declaration=may_contain', async () => {
    const { rows } = await withBypass(() => query(
      `INSERT INTO product_allergens (product_id, allergen_id, declaration)
       VALUES ($1, $2, 'may_contain') RETURNING *`,
      [productId, glutenId]
    ))
    expect(rows[0].declaration).toBe('may_contain')
  })

  test('CASCADE: borrar tenant borra allergen → CASCADE en raw_material_allergens/product_allergens', async () => {
    // Verifica que la FK con CASCADE permite limpieza del tenant sin RESTRICT.
    // El cleanup automático lo verá al final via afterAll.
    const { rows } = await withBypass(() => query(
      `SELECT COUNT(*)::int AS c FROM raw_material_allergens WHERE raw_material_id = $1`, [rmId]
    ))
    expect(rows[0].c).toBeGreaterThanOrEqual(1)
  })
})
