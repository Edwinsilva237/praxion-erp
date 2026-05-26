'use strict'

/**
 * Golden master test #1: GET /api/production/queue
 *
 * Captura el comportamiento actual exacto de la cola de órdenes de producción
 * para que cualquier refactor del productionService.js mantenga la misma
 * salida (o requiera actualizar el snapshot conscientemente).
 *
 * Patrón documentado en docs/saas-v2/01-golden-master-pattern.md.
 */

const { createTenant, loginAs, authedClient, cleanupTestTenants } = require('../helpers/factory')
const { seedProductionScenario, normalizeForSnapshot } = require('../helpers/productionFactory')
const { pool } = require('../../src/db')

describe('Golden master: GET /api/production/queue', () => {
  let client, tenantInfo, scenario

  beforeAll(async () => {
    tenantInfo = await createTenant({ label: 'gmqueue', planSlug: 'owner' })
    const sess = await loginAs({
      slug: tenantInfo.tenant.slug,
      email: tenantInfo.email,
      password: tenantInfo.password,
    })
    client = authedClient({ slug: tenantInfo.tenant.slug, token: sess.token })

    // Siembra escenario: 3 órdenes, las primeras 2 liberadas → deben aparecer en queue.
    scenario = await seedProductionScenario(client, {
      numOrders: 3,
      releaseFirst: 2,
    })
  })

  afterAll(async () => {
    await cleanupTestTenants()
    await pool.end()
  })

  test('Devuelve exactamente las órdenes liberadas, en orden por prioridad', async () => {
    const res = await client.get('/api/production/queue').expect(200)

    // Verificaciones estructurales independientes del snapshot
    expect(Array.isArray(res.body)).toBe(true)
    expect(res.body).toHaveLength(2)  // sólo las 2 liberadas

    // Verifica orden por prioridad: urgente antes que alta
    expect(res.body[0].priority).toBe('urgente')
    expect(res.body[1].priority).toBe('alta')

    // Golden master snapshot del response normalizado
    expect(normalizeForSnapshot(res.body)).toMatchSnapshot()
  })

  test('Filtra por lineId cuando se pasa (returns vacío si no hay órdenes en esa línea)', async () => {
    // Pasamos un lineId inexistente — debería retornar array vacío
    const res = await client.get('/api/production/queue?lineId=99999').expect(200)
    expect(Array.isArray(res.body)).toBe(true)
    expect(res.body).toHaveLength(0)
  })

  test('Excluye órdenes en estado draft', async () => {
    const res = await client.get('/api/production/queue').expect(200)
    const statuses = res.body.map(o => o.status)
    expect(statuses).not.toContain('draft')
    statuses.forEach(s => {
      expect(['released', 'in_progress']).toContain(s)
    })
  })

  test('Incluye campos de avance (units_produced, progress_pct)', async () => {
    const res = await client.get('/api/production/queue').expect(200)
    for (const order of res.body) {
      expect(order).toHaveProperty('units_produced')
      expect(order).toHaveProperty('packages_produced')
      expect(order).toHaveProperty('progress_pct')
      // Como no hemos capturado ningún paquete, progress debe ser 0
      expect(Number(order.units_produced)).toBe(0)
      expect(Number(order.progress_pct)).toBe(0)
    }
  })
})
