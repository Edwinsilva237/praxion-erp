'use strict'

/**
 * SaaS v2 — Tests de tenant_warehouse_types.
 *
 * Cubre:
 *  - Tenant nuevo recibe 5 tipos default sembrados
 *  - CRUD: GET (lista, by id), POST, PATCH
 *  - Validación: system_role enum, default_scrap_destination solo para scrap
 *  - Color hex format
 *  - Soft-delete vía is_active
 */

const { createTenant, loginAs, authedClient, cleanupTestTenants } = require('../helpers/factory')
const { pool } = require('../../src/db')

afterAll(async () => {
  await cleanupTestTenants()
  await pool.end()
})

describe('SaaS v2: GET /api/process-config/warehouse-types', () => {
  let client, tenantInfo

  beforeAll(async () => {
    tenantInfo = await createTenant({ label: 'whtlist', planSlug: 'owner' })
    const sess = await loginAs({
      slug: tenantInfo.tenant.slug, email: tenantInfo.email, password: tenantInfo.password,
    })
    client = authedClient({ slug: tenantInfo.tenant.slug, token: sess.token })
  })

  test('Tenant nuevo tiene 5 tipos default sembrados', async () => {
    const res = await client.get('/api/process-config/warehouse-types').expect(200)
    expect(res.body).toHaveLength(5)
    const codes = res.body.map(t => t.code).sort()
    expect(codes).toEqual(['embalaje', 'materia_prima', 'merma', 'producto_terminado', 'wip'])
  })

  test('El tipo "merma" trae system_role=scrap y default_scrap_destination=discard', async () => {
    const res = await client.get('/api/process-config/warehouse-types').expect(200)
    const merma = res.body.find(t => t.code === 'merma')
    expect(merma.system_role).toBe('scrap')
    expect(merma.default_scrap_destination).toBe('discard')
  })

  test('Tipos no-scrap NO tienen default_scrap_destination', async () => {
    const res = await client.get('/api/process-config/warehouse-types').expect(200)
    res.body.filter(t => t.system_role !== 'scrap').forEach(t => {
      expect(t.default_scrap_destination).toBeNull()
    })
  })

  test('Filtra por system_role=input devuelve 2 (materia_prima + embalaje)', async () => {
    const res = await client.get('/api/process-config/warehouse-types?systemRole=input').expect(200)
    expect(res.body).toHaveLength(2)
    expect(res.body.map(t => t.code).sort()).toEqual(['embalaje', 'materia_prima'])
  })

  test('GET por id', async () => {
    const list = await client.get('/api/process-config/warehouse-types').expect(200)
    const mp = list.body.find(t => t.code === 'materia_prima')
    const res = await client.get(`/api/process-config/warehouse-types/${mp.id}`).expect(200)
    expect(res.body.code).toBe('materia_prima')
    expect(res.body.system_role).toBe('input')
  })

  test('GET por id inexistente devuelve 404', async () => {
    const res = await client.get('/api/process-config/warehouse-types/00000000-0000-0000-0000-000000000000')
    expect(res.status).toBe(404)
  })
})

describe('SaaS v2: POST /api/process-config/warehouse-types', () => {
  let client, tenantInfo

  beforeAll(async () => {
    tenantInfo = await createTenant({ label: 'whtcreate', planSlug: 'owner' })
    const sess = await loginAs({
      slug: tenantInfo.tenant.slug, email: tenantInfo.email, password: tenantInfo.password,
    })
    client = authedClient({ slug: tenantInfo.tenant.slug, token: sess.token })
  })

  test('Crea tipo nuevo para reventa (system_role=resale)', async () => {
    const res = await client.post('/api/process-config/warehouse-types', {
      code: 'reventa',
      name: 'Reventa',
      system_role: 'resale',
      sort_order: 60,
    }).expect(201)
    expect(res.body.code).toBe('reventa')
    expect(res.body.system_role).toBe('resale')
    expect(res.body.default_scrap_destination).toBeNull()
  })

  test('Crea tipo scrap con default_scrap_destination=sell', async () => {
    const res = await client.post('/api/process-config/warehouse-types', {
      code: 'merma_vendible',
      name: 'Merma vendible',
      system_role: 'scrap',
      default_scrap_destination: 'sell',
    }).expect(201)
    expect(res.body.default_scrap_destination).toBe('sell')
  })

  test('Si system_role≠scrap, default_scrap_destination se fuerza NULL', async () => {
    const res = await client.post('/api/process-config/warehouse-types', {
      code: 'output_extra',
      name: 'Output con destino enviado por error',
      system_role: 'output',
      default_scrap_destination: 'sell',  // no debería persistir
    }).expect(201)
    expect(res.body.default_scrap_destination).toBeNull()
  })

  test('Rechaza system_role inválido', async () => {
    const res = await client.post('/api/process-config/warehouse-types', {
      code: 'foo', name: 'Foo', system_role: 'invented',
    })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/system_role/)
  })

  test('Rechaza default_scrap_destination inválido en tipo scrap', async () => {
    const res = await client.post('/api/process-config/warehouse-types', {
      code: 'foo_scrap', name: 'Foo',
      system_role: 'scrap',
      default_scrap_destination: 'invented_dest',
    })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/default_scrap_destination/)
  })

  test('Rechaza color en formato inválido', async () => {
    const res = await client.post('/api/process-config/warehouse-types', {
      code: 'color_bad', name: 'Bad color', system_role: 'input',
      color: 'red',  // no hex
    })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/color/)
  })

  test('Acepta color hex válido', async () => {
    const res = await client.post('/api/process-config/warehouse-types', {
      code: 'with_color', name: 'Con color', system_role: 'input',
      color: '#FF5733',
    }).expect(201)
    expect(res.body.color).toBe('#FF5733')
  })

  test('Rechaza código duplicado (409)', async () => {
    const res = await client.post('/api/process-config/warehouse-types', {
      code: 'materia_prima', name: 'Otra MP', system_role: 'input',
    })
    expect(res.status).toBe(409)
  })

  test('Faltan campos requeridos → 400', async () => {
    const r1 = await client.post('/api/process-config/warehouse-types', { name: 'sin code' })
    expect(r1.status).toBe(400)
    const r2 = await client.post('/api/process-config/warehouse-types', { code: 'x' })
    expect(r2.status).toBe(400)
    const r3 = await client.post('/api/process-config/warehouse-types', {
      code: 'x', name: 'y',
    })
    expect(r3.status).toBe(400)  // sin system_role
  })
})

describe('SaaS v2: PATCH /api/process-config/warehouse-types/:id', () => {
  let client, tenantInfo, mermaId, mpId

  beforeAll(async () => {
    tenantInfo = await createTenant({ label: 'whtupd', planSlug: 'owner' })
    const sess = await loginAs({
      slug: tenantInfo.tenant.slug, email: tenantInfo.email, password: tenantInfo.password,
    })
    client = authedClient({ slug: tenantInfo.tenant.slug, token: sess.token })
    const list = await client.get('/api/process-config/warehouse-types').expect(200)
    mermaId = list.body.find(t => t.code === 'merma').id
    mpId    = list.body.find(t => t.code === 'materia_prima').id
  })

  test('Actualiza name y sort_order', async () => {
    const res = await client.patch(`/api/process-config/warehouse-types/${mpId}`, {
      name: 'MP renombrada',
      sort_order: 100,
    }).expect(200)
    expect(res.body.name).toBe('MP renombrada')
    expect(res.body.sort_order).toBe(100)
    expect(res.body.code).toBe('materia_prima')  // no cambia
  })

  test('Cambia default_scrap_destination del tipo scrap', async () => {
    const res = await client.patch(`/api/process-config/warehouse-types/${mermaId}`, {
      default_scrap_destination: 'reprocess',
    }).expect(200)
    expect(res.body.default_scrap_destination).toBe('reprocess')
  })

  test('Rechaza default_scrap_destination en tipo no-scrap', async () => {
    const res = await client.patch(`/api/process-config/warehouse-types/${mpId}`, {
      default_scrap_destination: 'sell',
    })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/scrap/)
  })

  test('Soft-delete vía is_active=false', async () => {
    const res = await client.patch(`/api/process-config/warehouse-types/${mpId}`, {
      is_active: false,
    }).expect(200)
    expect(res.body.is_active).toBe(false)
  })

  test('404 para id inexistente', async () => {
    const res = await client.patch(
      '/api/process-config/warehouse-types/00000000-0000-0000-0000-000000000000',
      { name: 'x' }
    )
    expect(res.status).toBe(404)
  })

  test('Filtra el filtro de los campos no permitidos (no cambia system_role ni code)', async () => {
    const res = await client.patch(`/api/process-config/warehouse-types/${mpId}`, {
      code: 'hack_code',
      system_role: 'output',
      name: 'cambio name solo',
    }).expect(200)
    expect(res.body.name).toBe('cambio name solo')
    expect(res.body.code).toBe('materia_prima')
    expect(res.body.system_role).toBe('input')
  })
})

describe('SaaS v2: Backfill de warehouses existentes', () => {
  let client, tenantInfo

  beforeAll(async () => {
    tenantInfo = await createTenant({ label: 'whtbf', planSlug: 'owner' })
    const sess = await loginAs({
      slug: tenantInfo.tenant.slug, email: tenantInfo.email, password: tenantInfo.password,
    })
    client = authedClient({ slug: tenantInfo.tenant.slug, token: sess.token })
  })

  test('Warehouses creados antes de migration 121 tienen warehouse_type_id si su type matcheaba el mapping', async () => {
    // Verificamos vía DB que warehouses globales (no este tenant — tenants
    // nuevos no tienen warehouses) tienen el FK populado correctamente
    const { pool } = require('../../src/db')
    const r = await pool.query(`
      SELECT COUNT(*) FILTER (WHERE warehouse_type_id IS NULL) AS null_count,
             COUNT(*) AS total
      FROM warehouses
      WHERE type IN ('raw_material','regrind','wip','finished_product')
    `)
    // Todos los warehouses con type en el mapeo deben estar linkeados
    expect(parseInt(r.rows[0].null_count, 10)).toBe(0)
  })
})
