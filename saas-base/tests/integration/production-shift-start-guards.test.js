'use strict'

/**
 * Candado 1 (2026-07-10): confirmPresence valida
 *   (a) que el que inicia sea el operador asignado o miembro del turno, y
 *   (b) que la hora actual esté dentro de la ventana (default 30 min antes).
 * Supervisor/admin (production:manage → canManage) salta ambos.
 *
 * Se prueba a nivel de servicio porque el owner tiene production:manage y por la
 * ruta siempre entraría como canManage=true.
 */

const { createTenant, loginAs, authedClient, cleanupTestTenants } = require('../helpers/factory')
const { seedProductionScenario, scheduleShift } = require('../helpers/productionFactory')
const svcSched = require('../../src/modules/production/scheduledShiftService')
const { pool, query, withBypass } = require('../../src/db')

afterAll(async () => {
  await cleanupTestTenants()
  await pool.end()
})

const RANDOM_USER = '00000000-0000-0000-0000-000000000000'
// Fechas distintas por test para no chocar con el unique (línea, número, fecha).
const inDays = (n) => new Date(Date.now() + n * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)

async function grab(promise) {
  try { await promise; return null } catch (e) { return e }
}
async function setEarlyWindow(tenantId, shiftNumber, minutes) {
  await withBypass(() => query(
    `INSERT INTO tenant_shift_config
       (tenant_id, shift_number, name, start_time, duration_hours, confirmation_tolerance_minutes, early_start_window_minutes)
     VALUES ($1, $2, '', '08:00', 8, 15, $3)
     ON CONFLICT (tenant_id, shift_number)
     DO UPDATE SET early_start_window_minutes = EXCLUDED.early_start_window_minutes`,
    [tenantId, shiftNumber, minutes]
  ))
}
async function freeOperator(shiftId) {
  await withBypass(() => query(`UPDATE production_shifts SET status='reviewed' WHERE id=$1`, [shiftId]))
}

describe('Candado 1 — ventana de inicio + operador asignado en confirmPresence', () => {
  let client, tenantId, sessionUser, orders

  beforeAll(async () => {
    const info = await createTenant({ label: 'startguards', planSlug: 'owner' })
    const sess = await loginAs({ slug: info.tenant.slug, email: info.email, password: info.password })
    sessionUser = sess.user
    tenantId = info.tenant.id
    client = authedClient({ slug: info.tenant.slug, token: sess.token })
    const scenario = await seedProductionScenario(client, { numOrders: 4, releaseFirst: 4 })
    orders = scenario.orders
  })

  test('bloquea si el que inicia NO es el operador asignado', async () => {
    const sched = await scheduleShift(client, {
      productionOrderId: orders[0].id, shiftNumber: '1', scheduledDate: inDays(1),
      operatorId: sessionUser.id, supervisorId: sessionUser.id,
    })
    const err = await grab(svcSched.confirmPresence({
      tenantId, id: sched.id, userId: RANDOM_USER, canManage: false,
    }))
    expect(err).toBeTruthy()
    expect(err.status).toBe(403)
    expect(err.message).toMatch(/asignado a/i)
  })

  test('bloquea iniciar demasiado antes de la hora (ventana default 30 min)', async () => {
    const sched = await scheduleShift(client, {
      productionOrderId: orders[1].id, shiftNumber: '2', scheduledDate: inDays(2),
      operatorId: sessionUser.id, supervisorId: sessionUser.id,
    })
    const err = await grab(svcSched.confirmPresence({
      tenantId, id: sched.id, userId: sessionUser.id, canManage: false,
    }))
    expect(err).toBeTruthy()
    expect(err.status).toBe(400)
    expect(err.message).toMatch(/Aún no puedes iniciarlo/i)
  })

  test('permite iniciar dentro de la ventana (operador correcto)', async () => {
    // Ventana amplia para el turno 3 (SMALLINT máx 32767) → la fecha futura cae dentro.
    await setEarlyWindow(tenantId, 3, 32767)
    const sched = await scheduleShift(client, {
      productionOrderId: orders[2].id, shiftNumber: '3', scheduledDate: inDays(3),
      operatorId: sessionUser.id, supervisorId: sessionUser.id,
    })
    const res = await svcSched.confirmPresence({
      tenantId, id: sched.id, userId: sessionUser.id, canManage: false,
    })
    expect(res.shift?.id).toBeTruthy()
    await freeOperator(res.shift.id) // liberar al operador para el siguiente test
  })

  test('supervisor (canManage) salta la ventana aunque sea muy temprano', async () => {
    const sched = await scheduleShift(client, {
      productionOrderId: orders[3].id, shiftNumber: '1', scheduledDate: inDays(4),
      operatorId: sessionUser.id, supervisorId: sessionUser.id,
    })
    const res = await svcSched.confirmPresence({
      tenantId, id: sched.id, userId: sessionUser.id, canManage: true,
    })
    expect(res.shift?.id).toBeTruthy()
  })
})
