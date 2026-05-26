'use strict'

/**
 * Golden master test #9: GET /api/production/scheduled-shifts
 *
 * Lista turnos pre-programados (futuros). Diferente del flujo de turnos
 * "reales" (production_shifts) — los scheduled_shifts son agenda, no operación.
 *
 * Patrón documentado en docs/saas-v2/01-golden-master-pattern.md.
 */

const { createTenant, loginAs, authedClient, cleanupTestTenants } = require('../helpers/factory')
const {
  seedProductionScenario,
  scheduleShift,
  normalizeForSnapshot,
} = require('../helpers/productionFactory')
const { pool } = require('../../src/db')

afterAll(async () => {
  await cleanupTestTenants()
  await pool.end()
})

describe('Golden master: GET /api/production/scheduled-shifts', () => {
  let client, tenantInfo, sessionUser, scenario, scheduled1, scheduled2

  beforeAll(async () => {
    tenantInfo = await createTenant({ label: 'gmsched', planSlug: 'owner' })
    const sess = await loginAs({
      slug: tenantInfo.tenant.slug,
      email: tenantInfo.email,
      password: tenantInfo.password,
    })
    sessionUser = sess.user
    client = authedClient({ slug: tenantInfo.tenant.slug, token: sess.token })

    // Necesitamos al menos una orden released para poder programar turnos
    scenario = await seedProductionScenario(client, { numOrders: 1, releaseFirst: 1 })

    // Programar 2 turnos: uno para mañana, uno para pasado mañana
    const tomorrow = new Date(Date.now() + 24*60*60*1000).toISOString().slice(0, 10)
    const dayAfter = new Date(Date.now() + 48*60*60*1000).toISOString().slice(0, 10)

    scheduled1 = await scheduleShift(client, {
      productionOrderId: scenario.orders[0].id,
      shiftNumber: '1',
      scheduledDate: tomorrow,
      scheduledStart: '08:00:00',
      operatorId: sessionUser.id,
      supervisorId: sessionUser.id,
      lineId: 1,
    })

    scheduled2 = await scheduleShift(client, {
      // Sin productionOrderId — el operador la elegirá al iniciar
      shiftNumber: '2',
      scheduledDate: dayAfter,
      scheduledStart: '16:00:00',
      operatorId: sessionUser.id,
      supervisorId: sessionUser.id,
      lineId: 2,
    })
  })

  test('Lista los 2 turnos programados con joins completos', async () => {
    const res = await client.get('/api/production/scheduled-shifts').expect(200)

    expect(Array.isArray(res.body)).toBe(true)
    expect(res.body).toHaveLength(2)

    // El primero debe tener orden asignada (con campos join)
    const withOrder = res.body.find(s => s.id === scheduled1.id)
    expect(withOrder).toBeTruthy()
    expect(withOrder).toHaveProperty('order_number')
    expect(withOrder).toHaveProperty('product_name', 'Esquinero PP Test')
    expect(withOrder).toHaveProperty('sku', 'TEST-PROD-001')
    expect(withOrder).toHaveProperty('operator_name', 'Test Admin')
    expect(withOrder).toHaveProperty('supervisor_name', 'Test Admin')

    // El segundo sin orden
    const withoutOrder = res.body.find(s => s.id === scheduled2.id)
    expect(withoutOrder).toBeTruthy()
    expect(withoutOrder.production_order_id).toBeNull()
    expect(withoutOrder.order_number).toBeNull()
    expect(withoutOrder.product_name).toBeNull()

    expect(normalizeForSnapshot(res.body)).toMatchSnapshot()
  })

  test('Filtra por operatorId', async () => {
    const res = await client.get(
      `/api/production/scheduled-shifts?operatorId=${sessionUser.id}`
    ).expect(200)
    expect(res.body).toHaveLength(2)
    res.body.forEach(s => {
      expect(s.operator_id).toBe(sessionUser.id)
    })
  })

  test('Filtra por operatorId inexistente devuelve vacío', async () => {
    const res = await client.get(
      '/api/production/scheduled-shifts?operatorId=00000000-0000-0000-0000-000000000000'
    ).expect(200)
    expect(res.body).toEqual([])
  })

  test('Filtra por dateFrom futuro devuelve vacío', async () => {
    // Fecha lejana — ninguno de nuestros 2 programados debería aparecer
    const farFuture = new Date(Date.now() + 365*24*60*60*1000).toISOString().slice(0, 10)
    const res = await client.get(
      `/api/production/scheduled-shifts?dateFrom=${farFuture}`
    ).expect(200)
    expect(res.body).toEqual([])
  })

  test('Devuelve vacío para tenant sin turnos programados', async () => {
    const other = await createTenant({ label: 'gmschedempty', planSlug: 'owner' })
    const sess = await loginAs({
      slug: other.tenant.slug, email: other.email, password: other.password,
    })
    const otherClient = authedClient({ slug: other.tenant.slug, token: sess.token })

    const res = await otherClient.get('/api/production/scheduled-shifts').expect(200)
    expect(res.body).toEqual([])
  })
})
