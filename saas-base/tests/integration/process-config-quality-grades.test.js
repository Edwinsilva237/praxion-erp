'use strict'

/**
 * SaaS v2 — Tests de tenant_quality_grades.
 */

const { createTenant, loginAs, authedClient, cleanupTestTenants } = require('../helpers/factory')
const { pool } = require('../../src/db')

afterAll(async () => {
  await cleanupTestTenants()
  await pool.end()
})

describe('SaaS v2: GET /api/process-config/quality-grades', () => {
  let client, tenantInfo

  beforeAll(async () => {
    tenantInfo = await createTenant({ label: 'qgread', planSlug: 'owner' })
    const sess = await loginAs({
      slug: tenantInfo.tenant.slug, email: tenantInfo.email, password: tenantInfo.password,
    })
    client = authedClient({ slug: tenantInfo.tenant.slug, token: sess.token })
  })

  test('Tenant nuevo recibe 3 calidades default sembradas', async () => {
    const res = await client.get('/api/process-config/quality-grades').expect(200)
    expect(res.body).toHaveLength(3)
    expect(res.body.map(g => g.grade_number)).toEqual([1, 2, 3])
    expect(res.body.map(g => g.code)).toEqual(['primera', 'segunda', 'tercera'])
  })

  test('Grade=1 cuenta para cumplimiento de orden; 2 y 3 no', async () => {
    const res = await client.get('/api/process-config/quality-grades').expect(200)
    expect(res.body[0].counts_for_order_fulfillment).toBe(true)
    expect(res.body[1].counts_for_order_fulfillment).toBe(false)
    expect(res.body[2].counts_for_order_fulfillment).toBe(false)
  })

  test('Default goes_to_warehouse_type_id apunta a producto_terminado', async () => {
    const res = await client.get('/api/process-config/quality-grades').expect(200)
    res.body.forEach(g => {
      expect(g.warehouse_type_code).toBe('producto_terminado')
    })
  })

  test('Filtra por isActive=true', async () => {
    const res = await client.get('/api/process-config/quality-grades?isActive=true').expect(200)
    expect(res.body).toHaveLength(3)
  })

  test('GET por id incluye warehouse_type_name', async () => {
    const list = await client.get('/api/process-config/quality-grades').expect(200)
    const primera = list.body.find(g => g.grade_number === 1)
    const res = await client.get(`/api/process-config/quality-grades/${primera.id}`).expect(200)
    expect(res.body).toHaveProperty('warehouse_type_name', 'Producto terminado')
  })
})

describe('SaaS v2: POST /api/process-config/quality-grades', () => {
  let client, tenantInfo

  beforeAll(async () => {
    tenantInfo = await createTenant({ label: 'qgcreate', planSlug: 'owner' })
    const sess = await loginAs({
      slug: tenantInfo.tenant.slug, email: tenantInfo.email, password: tenantInfo.password,
    })
    client = authedClient({ slug: tenantInfo.tenant.slug, token: sess.token })
  })

  test('Crea cuarta calidad (grade=4)', async () => {
    const res = await client.post('/api/process-config/quality-grades', {
      grade_number: 4,
      code: 'cuarta',
      name: 'Cuarta — Personal',
      counts_for_order_fulfillment: false,
    }).expect(201)
    expect(res.body.grade_number).toBe(4)
    expect(res.body.code).toBe('cuarta')
  })

  test('Rechaza grade_number > 5', async () => {
    const res = await client.post('/api/process-config/quality-grades', {
      grade_number: 6, code: 'x', name: 'x',
    })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/grade_number/)
  })

  test('Rechaza grade_number < 1', async () => {
    const res = await client.post('/api/process-config/quality-grades', {
      grade_number: 0, code: 'x', name: 'x',
    })
    expect(res.status).toBe(400)
  })

  test('Rechaza grade_number duplicado (409)', async () => {
    const res = await client.post('/api/process-config/quality-grades', {
      grade_number: 1, code: 'segunda_primera', name: 'Dup',
    })
    expect(res.status).toBe(409)
    expect(res.body.error).toMatch(/grade_number/)
  })

  test('Rechaza code duplicado (409)', async () => {
    const res = await client.post('/api/process-config/quality-grades', {
      grade_number: 5, code: 'primera', name: 'Dup code',
    })
    expect(res.status).toBe(409)
    expect(res.body.error).toMatch(/code/)
  })

  test('Rechaza color en formato inválido', async () => {
    const res = await client.post('/api/process-config/quality-grades', {
      grade_number: 5, code: 'q5', name: 'Q5',
      default_color: 'red',
    })
    expect(res.status).toBe(400)
  })

  test('Rechaza goes_to_warehouse_type_id inexistente', async () => {
    const res = await client.post('/api/process-config/quality-grades', {
      grade_number: 5, code: 'q5x', name: 'Q5',
      goes_to_warehouse_type_id: '00000000-0000-0000-0000-000000000000',
    })
    expect(res.status).toBe(400)
  })
})

describe('SaaS v2: PATCH /api/process-config/quality-grades/:id', () => {
  let client, tenantInfo, primeraId, segundaId, terceraId

  beforeAll(async () => {
    tenantInfo = await createTenant({ label: 'qgupd', planSlug: 'owner' })
    const sess = await loginAs({
      slug: tenantInfo.tenant.slug, email: tenantInfo.email, password: tenantInfo.password,
    })
    client = authedClient({ slug: tenantInfo.tenant.slug, token: sess.token })
    const list = await client.get('/api/process-config/quality-grades').expect(200)
    primeraId = list.body.find(g => g.grade_number === 1).id
    segundaId = list.body.find(g => g.grade_number === 2).id
    terceraId = list.body.find(g => g.grade_number === 3).id
  })

  test('Actualiza name', async () => {
    const res = await client.patch(`/api/process-config/quality-grades/${primeraId}`, {
      name: 'Calidad apta (renombrada)',
    }).expect(200)
    expect(res.body.name).toBe('Calidad apta (renombrada)')
  })

  test('Cambia counts_for_order_fulfillment de segunda a true', async () => {
    const res = await client.patch(`/api/process-config/quality-grades/${segundaId}`, {
      counts_for_order_fulfillment: true,
    }).expect(200)
    expect(res.body.counts_for_order_fulfillment).toBe(true)
  })

  test('Cambia color a hex válido', async () => {
    const res = await client.patch(`/api/process-config/quality-grades/${terceraId}`, {
      default_color: '#FFA500',
    }).expect(200)
    expect(res.body.default_color).toBe('#FFA500')
  })

  test('Soft-delete (is_active=false) de una de tres', async () => {
    const res = await client.patch(`/api/process-config/quality-grades/${terceraId}`, {
      is_active: false,
    }).expect(200)
    expect(res.body.is_active).toBe(false)
  })

  test('Rechaza desactivar la última calidad activa', async () => {
    // Desactivar segunda (queda solo primera activa)
    await client.patch(`/api/process-config/quality-grades/${segundaId}`, {
      is_active: false,
    }).expect(200)
    // Intentar desactivar primera (la última) → debe fallar
    const res = await client.patch(`/api/process-config/quality-grades/${primeraId}`, {
      is_active: false,
    })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/última/)
  })

  test('404 para id inexistente', async () => {
    const res = await client.patch(
      '/api/process-config/quality-grades/00000000-0000-0000-0000-000000000000',
      { name: 'x' }
    )
    expect(res.status).toBe(404)
  })
})
