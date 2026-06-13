'use strict'

/**
 * Turno ATRASADO: registrar un turno programado que NUNCA se inició.
 *
 * Caso real: el operador hizo producción, la anotó en papel pero nunca confirmó
 * presencia en la app; ya pasaron otros turnos. El admin lo registra ahora con
 * su FECHA ORIGINAL para capturar lo de la hoja, sin afectar el turno de hoy.
 *
 * Cubre:
 *  - startMissedShift crea el turno de captura activo con la fecha del programado.
 *  - Solo aplica a días anteriores (un programado de hoy/futuro → 400).
 *  - No se puede iniciar otro si el operador ya tiene un turno abierto (409).
 *  - confirmPresence también bloquea si el operador tiene un turno abierto (409).
 */

const { createTenant, loginAs, authedClient, cleanupTestTenants } = require('../helpers/factory')
const { seedProductionScenario, scheduleShift } = require('../helpers/productionFactory')
const { pool } = require('../../src/db')

const inDays = (n) => new Date(Date.now() + n * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)

afterAll(async () => {
  await cleanupTestTenants()
  await pool.end()
})

describe('Turno atrasado: POST /api/production/scheduled-shifts/:id/start-missed', () => {
  let client, tenantInfo, sessionUser

  beforeAll(async () => {
    tenantInfo = await createTenant({ label: 'missedshift', planSlug: 'owner' })
    const sess = await loginAs({
      slug: tenantInfo.tenant.slug,
      email: tenantInfo.email,
      password: tenantInfo.password,
    })
    sessionUser = sess.user
    client = authedClient({ slug: tenantInfo.tenant.slug, token: sess.token })

    // Siembra catálogo/orden para que la programación funcione.
    await seedProductionScenario(client, { numOrders: 1, releaseFirst: 1 })
  })

  // Helper: programa un turno (la API no acepta fecha pasada) y lo backdatea por SQL.
  async function schedulePast({ shiftNumber, pastDate }) {
    const s = await scheduleShift(client, {
      shiftNumber,
      scheduledDate: inDays(1),
      operatorId: sessionUser.id,
      supervisorId: sessionUser.id,
      lineId: 1,
    })
    await pool.query('UPDATE scheduled_shifts SET scheduled_date = $1 WHERE id = $2', [pastDate, s.id])
    return s
  }

  test('inicia el turno atrasado con la fecha original y lo deja activo', async () => {
    const sched = await schedulePast({ shiftNumber: '1', pastDate: '2020-01-06' })

    const res = await client
      .post(`/api/production/scheduled-shifts/${sched.id}/start-missed`)
      .expect(200)

    // El turno de captura se crea ACTIVO y con la fecha del programado.
    expect(res.body.shift).toBeTruthy()
    expect(res.body.shift.status).toBe('active')
    expect(res.body.shift.shift_date).toBe(res.body.scheduledShift.scheduled_date)
    expect(res.body.shift.shift_date.slice(0, 10)).toBe('2020-01-06')

    // El programado queda enlazado y marcado activo.
    expect(res.body.scheduledShift.status).toBe('active')
    expect(res.body.scheduledShift.shift_id).toBe(res.body.shift.id)

    // El operador quedó como miembro del turno de runtime (puede capturar).
    const { rows: members } = await pool.query(
      'SELECT user_id FROM production_shift_members WHERE shift_id = $1',
      [res.body.shift.id]
    )
    expect(members.some(m => m.user_id === sessionUser.id)).toBe(true)
  })

  test('rechaza registrar como atrasado un turno que no es de un día anterior (400)', async () => {
    const sched = await scheduleShift(client, {
      shiftNumber: '2',
      scheduledDate: inDays(2),
      operatorId: sessionUser.id,
      supervisorId: sessionUser.id,
      lineId: 1,
    })

    const res = await client
      .post(`/api/production/scheduled-shifts/${sched.id}/start-missed`)
      .expect(400)
    expect(res.body.error).toMatch(/días anteriores/i)
  })

  test('confirmar presencia se bloquea si el operador ya tiene un turno abierto (409)', async () => {
    // El operador tiene activo el turno atrasado del primer test (sin cerrar).
    const sched = await scheduleShift(client, {
      shiftNumber: '1',
      scheduledDate: inDays(3),
      operatorId: sessionUser.id,
      supervisorId: sessionUser.id,
      lineId: 1,
    })

    const res = await client
      .post(`/api/production/scheduled-shifts/${sched.id}/confirm`)
      .expect(409)
    expect(res.body.error).toMatch(/abierto/i)
  })

  test('no permite iniciar otro turno atrasado si el operador ya tiene uno abierto (409)', async () => {
    const sched = await schedulePast({ shiftNumber: '2', pastDate: '2020-01-07' })

    const res = await client
      .post(`/api/production/scheduled-shifts/${sched.id}/start-missed`)
      .expect(409)
    expect(res.body.error).toMatch(/abierto/i)
  })
})
