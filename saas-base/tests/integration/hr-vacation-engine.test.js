'use strict'

/**
 * Motor de periodos vacacionales (migs 224-227): tabla LFT, generación de
 * periodos por aniversario, saldos, movimientos y reglas configurables.
 */

const { createTenant, cleanupTestTenants } = require('../helpers/factory')
const { pool, query, withBypass } = require('../../src/db')
const employees = require('../../src/modules/hr/employeeService')
const vacations = require('../../src/modules/hr/vacationService')

let tenantId, userId

beforeAll(async () => {
  const info = await createTenant({ label: 'hr', planSlug: 'owner' })
  tenantId = info.tenant.id
  userId = info.user.id
})

afterAll(async () => { await cleanupTestTenants(); await pool.end() })

// Helper: crea un empleado directo por SQL (sin generar periodos) para controlar la fecha.
async function makeEmployee({ hireDate, salary = null, termination = null, number }) {
  const { rows } = await withBypass(() => query(
    `INSERT INTO employees (tenant_id, employee_number, full_name, hire_date, daily_salary, termination_date, status)
     VALUES ($1,$2,'Empleado Prueba',$3,$4,$5,$6) RETURNING id`,
    [tenantId, number, hireDate, salary, termination, termination ? 'inactive' : 'active']))
  return rows[0].id
}

describe('helpers puros — tabla LFT 2023', () => {
  test('entitledDaysFor devuelve los días de la reforma 2023', () => {
    const r = vacations.LFT_2023_DEFAULT
    expect(vacations.entitledDaysFor(1, r)).toBe(12)
    expect(vacations.entitledDaysFor(2, r)).toBe(14)
    expect(vacations.entitledDaysFor(5, r)).toBe(20)
    expect(vacations.entitledDaysFor(6, r)).toBe(22)
    expect(vacations.entitledDaysFor(10, r)).toBe(22)
    expect(vacations.entitledDaysFor(11, r)).toBe(24)
    expect(vacations.entitledDaysFor(31, r)).toBe(32)
    expect(vacations.entitledDaysFor(35, r)).toBe(32)
  })

  test('extrapola +2 por bloque de 5 años más allá del último rango', () => {
    const r = vacations.LFT_2023_DEFAULT
    expect(vacations.entitledDaysFor(36, r)).toBe(34)
    expect(vacations.entitledDaysFor(40, r)).toBe(34)
    expect(vacations.entitledDaysFor(41, r)).toBe(36)
  })

  test('años de servicio cumplidos respeta el aniversario', () => {
    const hire = vacations.parseYmd('2020-06-15')
    expect(vacations.completedYearsOfService(hire, vacations.parseYmd('2026-06-14'))).toBe(5) // un día antes
    expect(vacations.completedYearsOfService(hire, vacations.parseYmd('2026-06-15'))).toBe(6) // el aniversario
    expect(vacations.completedYearsOfService(hire, vacations.parseYmd('2020-06-15'))).toBe(0)
  })

  test('aniversario clampa 29-feb a 28-feb en años no bisiestos', () => {
    const hire = vacations.parseYmd('2020-02-29')
    expect(vacations.fmtYmd(vacations.anniversary(hire, 1))).toBe('2021-02-28')
    expect(vacations.fmtYmd(vacations.anniversary(hire, 4))).toBe('2024-02-29') // 2024 bisiesto
  })
})

describe('generación de periodos y saldo', () => {
  test('crear empleado genera un periodo por aniversario cumplido', async () => {
    const emp = await employees.create({
      tenantId, userId,
      body: { fullName: 'Ana López', hireDate: '2021-03-01', dailySalary: 500, employeeNumber: 'EMP-1001' },
    })
    // asOf fijo para determinismo
    const bal = await vacations.getBalance({ tenantId, employeeId: emp.id, asOf: '2026-07-14' })
    // 2022,2023,2024,2025,2026 → 5 aniversarios cumplidos
    expect(bal.periods).toHaveLength(5)
    expect(bal.years_of_service).toBe(5)
    // año 1→12, 2→14, 3→16, 4→18, 5→20
    expect(bal.periods.map(p => p.days_entitled)).toEqual([12, 14, 16, 18, 20])
    expect(bal.summary.total_entitled).toBe(80)
    // Los periodos 1-3 (aniversarios 2022-2024) ya prescribieron 18 meses después
    // → solo cuentan como pendientes los periodos 4 y 5 (18 + 20 = 38); 12+14+16=42 expiraron.
    expect(bal.summary.total_pending).toBe(38)
    expect(bal.summary.total_expired).toBe(42)
    // prima vacacional del último periodo = 20 * 500 * 0.25 = 2500
    expect(bal.periods[4].prima_vacacional).toBe(2500)
  })

  test('generación es idempotente (no duplica al re-correr)', async () => {
    const id = await makeEmployee({ hireDate: '2023-01-10', number: 'EMP-1002' })
    const first = await vacations.generatePeriodsForEmployee({ tenantId, employeeId: id, userId, asOf: '2026-07-14' })
    const second = await vacations.generatePeriodsForEmployee({ tenantId, employeeId: id, userId, asOf: '2026-07-14' })
    expect(first.created).toBe(3)     // 2024,2025,2026
    expect(second.created).toBe(0)
    expect(second.updated).toBe(3)
    const bal = await vacations.getBalance({ tenantId, employeeId: id, asOf: '2026-07-14' })
    expect(bal.periods).toHaveLength(3)
  })
})

describe('movimientos: tomar, ajustar, pagar', () => {
  let empId, periodId

  beforeAll(async () => {
    empId = await makeEmployee({ hireDate: '2022-05-01', salary: 400, number: 'EMP-1003' })
    await vacations.generatePeriodsForEmployee({ tenantId, employeeId: empId, userId, asOf: '2026-07-14' })
    const bal = await vacations.getBalance({ tenantId, employeeId: empId, asOf: '2026-07-14' })
    periodId = bal.periods[0].id // año 1 → 12 días
  })

  test('registrar días gozados baja el pendiente', async () => {
    await vacations.registerTaken({ tenantId, employeeId: empId, periodId, days: 5, startDate: '2026-06-01', endDate: '2026-06-05', userId })
    const bal = await vacations.getBalance({ tenantId, employeeId: empId, asOf: '2026-07-14' })
    const p = bal.periods.find(p => p.id === periodId)
    expect(p.taken).toBe(5)
    expect(p.pending).toBe(7)
  })

  test('no deja tomar más que el saldo pendiente', async () => {
    await expect(vacations.registerTaken({ tenantId, employeeId: empId, periodId, days: 99, userId }))
      .rejects.toThrow(/saldo suficiente/i)
  })

  test('ajuste positivo suma días; requiere nota', async () => {
    await expect(vacations.registerAdjustment({ tenantId, employeeId: empId, periodId, days: 2, userId }))
      .rejects.toThrow(/nota/i)
    await vacations.registerAdjustment({ tenantId, employeeId: empId, periodId, days: 2, note: 'días de cortesía', userId })
    const bal = await vacations.getBalance({ tenantId, employeeId: empId, asOf: '2026-07-14' })
    const p = bal.periods.find(p => p.id === periodId)
    expect(p.adjustment).toBe(2)
    expect(p.pending).toBe(9) // 12 - 5 + 2
  })

  test('borrar un movimiento restaura el saldo', async () => {
    const ledger = await vacations.getLedger({ tenantId, employeeId: empId })
    const taken = ledger.find(l => l.entry_type === 'taken')
    await vacations.deleteLedgerEntry({ tenantId, employeeId: empId, entryId: taken.id, userId })
    const bal = await vacations.getBalance({ tenantId, employeeId: empId, asOf: '2026-07-14' })
    const p = bal.periods.find(p => p.id === periodId)
    expect(p.taken).toBe(0)
    expect(p.pending).toBe(14) // 12 + 2 ajuste
  })
})

describe('tabla de días configurable por tenant', () => {
  test('sin personalizar usa LFT 2023 (isDefault=true)', async () => {
    const { isDefault, rules } = await vacations.getEntitlementRules({ tenantId })
    expect(isDefault).toBe(true)
    expect(rules[0]).toMatchObject({ years_from: 1, days_entitled: 12 })
  })

  test('personalizar sustituye el default y afecta la generación', async () => {
    await vacations.updateEntitlementRules({
      tenantId, userId,
      rules: [
        { years_from: 1, years_to: 1, days_entitled: 15 }, // más generoso que la ley
        { years_from: 2, years_to: null, days_entitled: 20 },
      ],
    })
    const { isDefault } = await vacations.getEntitlementRules({ tenantId })
    expect(isDefault).toBe(false)

    const id = await makeEmployee({ hireDate: '2023-08-01', number: 'EMP-1004' })
    await vacations.generatePeriodsForEmployee({ tenantId, employeeId: id, userId, asOf: '2026-07-14' })
    const bal = await vacations.getBalance({ tenantId, employeeId: id, asOf: '2026-07-14' })
    // Al 2026-07-14 el 3er aniversario (2026-08-01) aún no ocurre → 2 periodos:
    // 2024→año1→15, 2025→año2→20 (rango abierto)
    expect(bal.periods.map(p => p.days_entitled)).toEqual([15, 20])
  })

  test('reset vuelve al default LFT', async () => {
    const { isDefault } = await vacations.resetEntitlementRules({ tenantId, userId })
    expect(isDefault).toBe(true)
  })
})

describe('caducidad de periodos', () => {
  test('un periodo cuyo expires_at ya pasó se marca expired y no cuenta como pendiente', async () => {
    // Ingreso viejo: el año 1 (aniversario 2011) prescribió hace más de una década.
    const id = await makeEmployee({ hireDate: '2010-01-01', salary: 300, number: 'EMP-1005' })
    await vacations.generatePeriodsForEmployee({ tenantId, employeeId: id, userId, asOf: '2026-07-14' })
    const bal = await vacations.getBalance({ tenantId, employeeId: id, asOf: '2026-07-14' })
    const first = bal.periods[0]
    expect(first.status).toBe('expired')
    // el pendiente del expirado no suma al total pendiente
    expect(bal.summary.total_pending).toBeLessThan(bal.summary.total_entitled)
    expect(bal.summary.total_expired).toBeGreaterThan(0)
  })
})
