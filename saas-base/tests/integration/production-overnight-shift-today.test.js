'use strict'

/**
 * Regresión (2026-07-17): un turno NOCTURNO que cruza la medianoche debe seguir
 * apareciendo en la pantalla de captura de su operador DESPUÉS de las 12am.
 *
 * Bug: `getTodayShiftsForOperator` filtraba `scheduled_date = hoy` (zona MX). El
 * Turno 3 (23:00→07:00) vive con la scheduled_date del día que ARRANCA; al entrar
 * el operador pasada la medianoche, "hoy" ya era el día siguiente y su turno
 * desaparecía → "Sin turnos asignados hoy", sin opción de iniciar.
 *
 * Fix: la ventana "de hoy" incluye los turnos NOCTURNOS de AYER cuya corrida
 * (scheduled_start + duración configurada) todavía no termina.
 */

const { createTenant, loginAs, authedClient, cleanupTestTenants } = require('../helpers/factory')
const { seedProductionScenario } = require('../helpers/productionFactory')
const svcSched = require('../../src/modules/production/scheduledShiftService')
const { pool, query, withBypass } = require('../../src/db')

afterAll(async () => {
  await cleanupTestTenants()
  await pool.end()
})

// Inserta un scheduled_shift directamente (permite fechas pasadas, que el flujo
// normal de programación no acepta).
async function insertScheduled({ tenantId, orderId, shiftNumber, date, start, operatorId }) {
  const { rows } = await withBypass(() => query(
    `INSERT INTO scheduled_shifts
       (tenant_id, production_order_id, shift_number, scheduled_date,
        scheduled_start, operator_id, supervisor_id, line_id, created_by, status)
     VALUES ($1,$2,$3,$4,$5,$6,$6,$7,$6,'scheduled')
     RETURNING id`,
    [tenantId, orderId, shiftNumber, date, start, operatorId, shiftNumber]
  ))
  return rows[0].id
}

async function upsertShiftConfig(tenantId, shiftNumber, durationHours, startTime) {
  await withBypass(() => query(
    `INSERT INTO tenant_shift_config
       (tenant_id, shift_number, name, start_time, duration_hours,
        confirmation_tolerance_minutes, early_start_window_minutes)
     VALUES ($1,$2,'',$4,$3,15,30)
     ON CONFLICT (tenant_id, shift_number)
     DO UPDATE SET duration_hours = EXCLUDED.duration_hours, start_time = EXCLUDED.start_time`,
    [tenantId, shiftNumber, durationHours, startTime]
  ))
}

describe('Turno nocturno sigue visible después de medianoche', () => {
  let client, tenantId, sessionUser, orders, yesterday

  beforeAll(async () => {
    const info = await createTenant({ label: 'overnight', planSlug: 'owner' })
    const sess = await loginAs({ slug: info.tenant.slug, email: info.email, password: info.password })
    sessionUser = sess.user
    tenantId = info.tenant.id
    client = authedClient({ slug: info.tenant.slug, token: sess.token })
    const scenario = await seedProductionScenario(client, { numOrders: 2, releaseFirst: 2 })
    orders = scenario.orders

    const { rows } = await withBypass(() => query(
      `SELECT (NOW() AT TIME ZONE 'America/Mexico_City')::date::text AS d,
              ((NOW() AT TIME ZONE 'America/Mexico_City')::date - 1)::text AS y`
    ))
    yesterday = rows[0].y

    // Turno 3 (nocturno): duración 30h garantiza que su fin sea futuro durante
    // TODO el día de hoy sin importar a qué hora corra el test.
    await upsertShiftConfig(tenantId, 3, 30, '23:00')
    // Turno 1 (diurno): 8h → si es de ayer, ya terminó hace horas.
    await upsertShiftConfig(tenantId, 1, 8, '08:00')
  })

  test('el turno NOCTURNO de ayer aún-en-curso aparece en "mis turnos de hoy"', async () => {
    const nightId = await insertScheduled({
      tenantId, orderId: orders[0].id, shiftNumber: 3,
      date: yesterday, start: '23:00', operatorId: sessionUser.id,
    })
    const shifts = await svcSched.getTodayShiftsForOperator({ tenantId, operatorId: sessionUser.id })
    const found = shifts.find(s => s.id === nightId)
    expect(found).toBeTruthy()
    expect(found.status).toBe('scheduled')
  })

  test('un turno DIURNO de ayer (ya terminado) NO aparece', async () => {
    const dayId = await insertScheduled({
      tenantId, orderId: orders[1].id, shiftNumber: 1,
      date: yesterday, start: '08:00', operatorId: sessionUser.id,
    })
    const shifts = await svcSched.getTodayShiftsForOperator({ tenantId, operatorId: sessionUser.id })
    expect(shifts.find(s => s.id === dayId)).toBeFalsy()
  })
})
