'use strict'

/**
 * Capa HTTP del módulo de RH: rutas de empleados + vacaciones + tabla de días,
 * pasando por auth, tenant y checkPermission('hr', …). Complementa a
 * hr-vacation-engine.test.js (que prueba el servicio directo).
 */

const { createTenant, loginAs, authedClient, cleanupTestTenants } = require('../helpers/factory')
const { pool } = require('../../src/db')

let client, employeeId

beforeAll(async () => {
  const info = await createTenant({ label: 'hrroutes', planSlug: 'owner' })
  const auth = await loginAs({ slug: info.tenant.slug, email: info.email, password: info.password })
  client = authedClient({ slug: info.tenant.slug, token: auth.token })
})

afterAll(async () => { await cleanupTestTenants(); await pool.end() })

describe('empleados', () => {
  test('POST /hr/employees crea con folio automático y genera periodos', async () => {
    const res = await client.post('/api/hr/employees', {
      fullName: 'Rutas Prueba', hireDate: '2024-02-01', dailySalary: 450,
    }).expect(201)
    expect(res.body.employee_number).toMatch(/^EMP-\d{4}$/)
    expect(res.body.hire_date).toBe('2024-02-01')
    employeeId = res.body.id
  })

  test('GET /hr/employees lista al empleado', async () => {
    const res = await client.get('/api/hr/employees').expect(200)
    expect(res.body.some(e => e.id === employeeId)).toBe(true)
  })

  test('PATCH /hr/employees/:id aplica los cambios del body camelCase', async () => {
    const res = await client.patch(`/api/hr/employees/${employeeId}`, {
      fullName: 'Rutas Editado', position: 'Almacenista', hireDate: '2024-03-01',
    }).expect(200)
    expect(res.body.full_name).toBe('Rutas Editado')
    expect(res.body.position).toBe('Almacenista')
    expect(res.body.hire_date).toBe('2024-03-01')
  })

  test('GET /hr/employees/:id/vacations devuelve periodos + resumen', async () => {
    const res = await client.get(`/api/hr/employees/${employeeId}/vacations`).expect(200)
    // 2025-02-01 y 2026-02-01 cumplidos → 2 periodos
    expect(res.body.periods).toHaveLength(2)
    expect(res.body.periods.map(p => p.days_entitled)).toEqual([12, 14])
    expect(res.body.summary.total_pending).toBe(26)
  })
})

describe('movimientos', () => {
  test('POST taken baja el pendiente del periodo', async () => {
    const bal = await client.get(`/api/hr/employees/${employeeId}/vacations`).expect(200)
    const period = bal.body.periods[0]
    await client.post(`/api/hr/employees/${employeeId}/vacations/taken`, {
      periodId: period.id, days: 5, startDate: '2026-06-01', endDate: '2026-06-05',
    }).expect(201)

    const after = await client.get(`/api/hr/employees/${employeeId}/vacations`).expect(200)
    expect(after.body.periods[0].pending).toBe(7)

    const ledger = await client.get(`/api/hr/employees/${employeeId}/vacations/ledger`).expect(200)
    expect(ledger.body).toHaveLength(1)
    expect(ledger.body[0].entry_type).toBe('taken')
  })

  test('POST taken con exceso responde 400', async () => {
    const bal = await client.get(`/api/hr/employees/${employeeId}/vacations`).expect(200)
    const res = await client.post(`/api/hr/employees/${employeeId}/vacations/taken`, {
      periodId: bal.body.periods[0].id, days: 999,
    }).expect(400)
    expect(res.body.error).toMatch(/saldo/i)
  })
})

describe('tabla de días por antigüedad', () => {
  test('GET rules devuelve el default LFT', async () => {
    const res = await client.get('/api/hr/vacations/rules').expect(200)
    expect(res.body.isDefault).toBe(true)
    expect(res.body.rules[0]).toMatchObject({ years_from: 1, days_entitled: 12 })
  })

  test('PUT rules personaliza y reset restaura', async () => {
    const put = await client.put('/api/hr/vacations/rules', {
      rules: [{ years_from: 1, years_to: null, days_entitled: 30 }],
    }).expect(200)
    expect(put.body.isDefault).toBe(false)

    const reset = await client.post('/api/hr/vacations/rules/reset').expect(200)
    expect(reset.body.isDefault).toBe(true)
  })
})
