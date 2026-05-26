'use strict'

/**
 * Golden master test #8: GET /api/production/shifts/history
 *
 * Listado histórico paginado de turnos con filtros (status, operator,
 * dateFrom, dateTo). Incluye turnos en cualquier estado (a diferencia de
 * /shifts/active que solo lista los activos).
 *
 * Patrón documentado en docs/saas-v2/01-golden-master-pattern.md.
 */

const { createTenant, loginAs, authedClient, cleanupTestTenants } = require('../helpers/factory')
const { openShift, normalizeForSnapshot } = require('../helpers/productionFactory')
const { pool } = require('../../src/db')

afterAll(async () => {
  await cleanupTestTenants()
  await pool.end()
})

describe('Golden master: GET /api/production/shifts/history', () => {
  let client, tenantInfo, sessionUser, shift1, shift2

  beforeAll(async () => {
    tenantInfo = await createTenant({ label: 'gmshifthist', planSlug: 'owner' })
    const sess = await loginAs({
      slug: tenantInfo.tenant.slug,
      email: tenantInfo.email,
      password: tenantInfo.password,
    })
    sessionUser = sess.user
    client = authedClient({ slug: tenantInfo.tenant.slug, token: sess.token })

    // Abrir 2 turnos: uno se cierra, otro queda activo, así history tiene mezcla
    shift1 = await openShift(client, {
      lineId: 1, shiftNumber: '1',
      operatorId: sessionUser.id, supervisorId: sessionUser.id,
    })
    shift2 = await openShift(client, {
      lineId: 2, shiftNumber: '2',
      operatorId: sessionUser.id, supervisorId: sessionUser.id,
    })

    // Cerrar el primer turno → pasa a 'pending_handover'
    await client.post(`/api/production/shifts/${shift1.id}/close`)
  })

  test('Lista todos los turnos (sin filtro) con paginación', async () => {
    const res = await client.get('/api/production/shifts/history').expect(200)

    // Estructura esperada
    expect(res.body).toHaveProperty('data')
    expect(res.body).toHaveProperty('total', 2)
    expect(res.body).toHaveProperty('page', 1)
    expect(res.body).toHaveProperty('limit', 20)
    expect(Array.isArray(res.body.data)).toBe(true)
    expect(res.body.data).toHaveLength(2)

    // Campos esperados (join + agregados)
    const first = res.body.data[0]
    expect(first).toHaveProperty('operator_name', 'Test Admin')
    expect(first).toHaveProperty('supervisor_name', 'Test Admin')
    expect(first).toHaveProperty('total_meters')
    expect(first).toHaveProperty('orders_count')

    // Snapshot del shape completo
    expect(normalizeForSnapshot(res.body)).toMatchSnapshot()
  })

  test('Filtra por status=active devuelve solo el turno aún activo', async () => {
    const res = await client.get('/api/production/shifts/history?status=active').expect(200)
    expect(res.body.total).toBe(1)
    expect(res.body.data).toHaveLength(1)
    expect(res.body.data[0].status).toBe('active')
    expect(res.body.data[0].id).toBe(shift2.id)
  })

  test('Filtra por status=pending_handover devuelve el turno cerrado', async () => {
    const res = await client.get('/api/production/shifts/history?status=pending_handover').expect(200)
    expect(res.body.total).toBe(1)
    expect(res.body.data).toHaveLength(1)
    expect(res.body.data[0].status).toBe('pending_handover')
    expect(res.body.data[0].id).toBe(shift1.id)
  })

  test('Filtra por operatorId devuelve solo turnos de ese operador', async () => {
    const res = await client.get(`/api/production/shifts/history?operatorId=${sessionUser.id}`).expect(200)
    expect(res.body.total).toBe(2)
    res.body.data.forEach(s => {
      expect(s.operator_name).toBe('Test Admin')
    })
  })

  test('Filtra por operatorId inexistente devuelve vacío', async () => {
    const res = await client.get(
      '/api/production/shifts/history?operatorId=00000000-0000-0000-0000-000000000000'
    ).expect(200)
    expect(res.body.total).toBe(0)
    expect(res.body.data).toEqual([])
  })

  test('Paginación: limit=1 devuelve 1 turno pero total=2', async () => {
    const res = await client.get('/api/production/shifts/history?limit=1&page=1').expect(200)
    expect(res.body.data).toHaveLength(1)
    expect(res.body.total).toBe(2)
    expect(res.body.limit).toBe(1)
  })
})
