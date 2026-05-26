'use strict'

/**
 * Golden master tests #2 y #3:
 *   - GET /api/production/orders        (lista paginada con filtros)
 *   - GET /api/production/orders/:id    (detalle individual con mpFormula)
 *
 * Patrón documentado en docs/saas-v2/01-golden-master-pattern.md.
 */

const { createTenant, loginAs, authedClient, cleanupTestTenants } = require('../helpers/factory')
const { seedProductionScenario, normalizeForSnapshot } = require('../helpers/productionFactory')
const { pool } = require('../../src/db')

// pool.end() solo se llama UNA vez al final del archivo (no por describe),
// para evitar "Cannot use a pool after calling end on the pool" cuando hay
// múltiples describes en el mismo archivo.
afterAll(async () => {
  await cleanupTestTenants()
  await pool.end()
})

describe('Golden master: GET /api/production/orders (listado)', () => {
  let client, tenantInfo, scenario

  beforeAll(async () => {
    tenantInfo = await createTenant({ label: 'gmorders', planSlug: 'owner' })
    const sess = await loginAs({
      slug: tenantInfo.tenant.slug,
      email: tenantInfo.email,
      password: tenantInfo.password,
    })
    client = authedClient({ slug: tenantInfo.tenant.slug, token: sess.token })

    // Escenario: 3 órdenes, 2 liberadas, 1 en draft
    scenario = await seedProductionScenario(client, {
      numOrders: 3,
      releaseFirst: 2,
    })
  })

  test('Lista todas las órdenes (sin filtro) con paginación', async () => {
    const res = await client.get('/api/production/orders').expect(200)

    // Verificaciones estructurales
    expect(res.body).toHaveProperty('data')
    expect(res.body).toHaveProperty('total')
    expect(res.body).toHaveProperty('page', 1)
    expect(res.body).toHaveProperty('limit', 50)
    expect(Array.isArray(res.body.data)).toBe(true)
    expect(res.body.data).toHaveLength(3)
    expect(res.body.total).toBe(3)

    // Snapshot del shape completo (data + meta)
    expect(normalizeForSnapshot(res.body)).toMatchSnapshot()
  })

  test('Filtra por status=released', async () => {
    const res = await client.get('/api/production/orders?status=released').expect(200)
    expect(res.body.data).toHaveLength(2)
    expect(res.body.total).toBe(2)
    res.body.data.forEach(o => {
      expect(o.status).toBe('released')
    })
  })

  test('Filtra por status=draft', async () => {
    const res = await client.get('/api/production/orders?status=draft').expect(200)
    expect(res.body.data).toHaveLength(1)
    expect(res.body.total).toBe(1)
    expect(res.body.data[0].status).toBe('draft')
  })

  test('Filtra por status inexistente devuelve vacío', async () => {
    const res = await client.get('/api/production/orders?status=completed').expect(200)
    expect(res.body.data).toHaveLength(0)
    expect(res.body.total).toBe(0)
  })

  test('Paginación: limit=2 devuelve 2 órdenes pero total=3', async () => {
    const res = await client.get('/api/production/orders?limit=2&page=1').expect(200)
    expect(res.body.data).toHaveLength(2)
    expect(res.body.total).toBe(3)
    expect(res.body.limit).toBe(2)
    expect(res.body.page).toBe(1)
  })

  test('Paginación: page=2 con limit=2 devuelve la tercera orden', async () => {
    const res = await client.get('/api/production/orders?limit=2&page=2').expect(200)
    expect(res.body.data).toHaveLength(1)
    expect(res.body.total).toBe(3)
    expect(res.body.page).toBe(2)
  })

  test('Orden por prioridad y luego sort_order (urgente primero)', async () => {
    const res = await client.get('/api/production/orders').expect(200)
    // El factory crea: orden 1=urgente, orden 2=alta, orden 3=normal
    expect(res.body.data[0].priority).toBe('urgente')
    expect(res.body.data[1].priority).toBe('alta')
    expect(res.body.data[2].priority).toBe('normal')
  })
})

describe('Golden master: GET /api/production/orders/:id (detalle)', () => {
  let client, tenantInfo, scenario

  beforeAll(async () => {
    tenantInfo = await createTenant({ label: 'gmorderdet', planSlug: 'owner' })
    const sess = await loginAs({
      slug: tenantInfo.tenant.slug,
      email: tenantInfo.email,
      password: tenantInfo.password,
    })
    client = authedClient({ slug: tenantInfo.tenant.slug, token: sess.token })

    scenario = await seedProductionScenario(client, {
      numOrders: 3,
      releaseFirst: 2,
    })
  })

  // No afterAll aquí: el archivo lleva uno global arriba.

  test('Devuelve detalle completo con campos calculados', async () => {
    const firstOrder = scenario.orders[0]
    const res = await client.get(`/api/production/orders/${firstOrder.id}`).expect(200)

    // Verificaciones de identidad
    expect(res.body.id).toBe(firstOrder.id)
    expect(res.body.priority).toBe('urgente')
    expect(res.body.status).toBe('released')

    // Campos join esperados
    expect(res.body).toHaveProperty('product_name')
    expect(res.body).toHaveProperty('sku', 'TEST-PROD-001')
    expect(res.body).toHaveProperty('raw_material_name', 'PP Virgen Test')
    expect(res.body).toHaveProperty('resin_type', 'PP')
    expect(res.body).toHaveProperty('cost_per_kg')
    expect(res.body).toHaveProperty('mpFormula')
    expect(Array.isArray(res.body.mpFormula)).toBe(true)

    // Snapshot completo
    expect(normalizeForSnapshot(res.body)).toMatchSnapshot()
  })

  test('Devuelve 404 para orden inexistente', async () => {
    // UUID válido pero inexistente
    const res = await client.get('/api/production/orders/00000000-0000-0000-0000-000000000000')
    expect(res.status).toBe(404)
  })

  test('mpFormula está vacío cuando la orden no se creó con fórmula', async () => {
    // El factory no pasa mpFormula al crear, así que debe venir vacío
    const firstOrder = scenario.orders[0]
    const res = await client.get(`/api/production/orders/${firstOrder.id}`).expect(200)
    expect(res.body.mpFormula).toEqual([])
  })

  test('Detalle de orden en draft también funciona', async () => {
    // La 3a orden quedó en draft (factory libera solo las primeras 2)
    const draftOrder = scenario.orders[2]
    const res = await client.get(`/api/production/orders/${draftOrder.id}`).expect(200)
    expect(res.body.id).toBe(draftOrder.id)
    expect(res.body.status).toBe('draft')
    expect(res.body.priority).toBe('normal')
  })
})
