'use strict'

/**
 * Golden master test #6: GET /api/production/shifts/active
 *
 * Lista los turnos en estado 'active' o 'pending_handover' del tenant.
 * Excluye turnos cerrados ('reviewed', 'pending_management', 'closed').
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

describe('Golden master: GET /api/production/shifts/active', () => {
  let client, tenantInfo, sessionUser, shift1

  beforeAll(async () => {
    tenantInfo = await createTenant({ label: 'gmshift', planSlug: 'owner' })
    const sess = await loginAs({
      slug: tenantInfo.tenant.slug,
      email: tenantInfo.email,
      password: tenantInfo.password,
    })
    sessionUser = sess.user
    client = authedClient({ slug: tenantInfo.tenant.slug, token: sess.token })

    // Abrir 1 turno con el admin como operador Y supervisor (simplificación de test)
    shift1 = await openShift(client, {
      lineId: 1,
      shiftNumber: '1',
      operatorId: sessionUser.id,
      supervisorId: sessionUser.id,
    })
  })

  test('Lista el turno activo con todos los campos de detalle', async () => {
    const res = await client.get('/api/production/shifts/active').expect(200)

    expect(Array.isArray(res.body)).toBe(true)
    expect(res.body).toHaveLength(1)

    const shift = res.body[0]
    expect(shift.id).toBe(shift1.id)
    expect(shift.status).toBe('active')
    expect(shift.shift_number).toBe('1')
    expect(shift.line_id).toBe(1)
    expect(shift.operator_id).toBe(sessionUser.id)
    expect(shift.supervisor_id).toBe(sessionUser.id)
    // Campos de detalle (join)
    expect(shift).toHaveProperty('operator_name', 'Test Admin')
    expect(shift).toHaveProperty('supervisor_name', 'Test Admin')
    // Agregados (sin paquetes aún capturados)
    expect(Number(shift.pt_units_produced)).toBe(0)

    expect(normalizeForSnapshot(res.body)).toMatchSnapshot()
  })

  test('Permite abrir un segundo turno en otra línea — ahora la lista tiene 2', async () => {
    await openShift(client, {
      lineId: 2,
      shiftNumber: '2',
      operatorId: sessionUser.id,
      supervisorId: sessionUser.id,
    })

    const res = await client.get('/api/production/shifts/active').expect(200)
    expect(res.body).toHaveLength(2)
    // Ambos deben ser status 'active'
    res.body.forEach(s => {
      expect(['active', 'pending_handover']).toContain(s.status)
    })
    // Verificar que están ordenados por started_at (1ro primero)
    expect(res.body[0].id).toBe(shift1.id)
  })

  test('No incluye turnos cerrados (status=closed)', async () => {
    // Cerrar el primer turno
    await client.post(`/api/production/shifts/${shift1.id}/close`)

    const res = await client.get('/api/production/shifts/active').expect(200)
    // El turno cerrado puede quedar en 'pending_handover' (esperando handover)
    // o en otro estado — verificamos que NO esté en 'closed'
    res.body.forEach(s => {
      expect(s.status).not.toBe('closed')
      expect(s.status).not.toBe('reviewed')
    })
  })

  test('Devuelve array vacío para tenant sin turnos activos', async () => {
    // Crear otro tenant aislado y verificar
    const other = await createTenant({ label: 'gmshiftempty', planSlug: 'owner' })
    const sess = await loginAs({
      slug: other.tenant.slug, email: other.email, password: other.password,
    })
    const otherClient = authedClient({ slug: other.tenant.slug, token: sess.token })

    const res = await otherClient.get('/api/production/shifts/active').expect(200)
    expect(res.body).toEqual([])
  })
})
