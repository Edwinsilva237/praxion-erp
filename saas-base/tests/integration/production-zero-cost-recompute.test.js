'use strict'

/**
 * Herramienta admin (fix 2026-06-09) — recálculo de turnos validados con costo $0.
 *
 * Verifica el orquestador costRecomputeService:
 *   - previewZeroCostShifts lista el turno y lo marca looks_zero + revertible.
 *   - executeZeroCostRecompute hace revert→re-cerrar→re-validar y deja el costo > 0,
 *     con el turno de vuelta en 'reviewed'.
 *
 * Reproduce el estado real: un turno cuyo costo por medida quedó congelado en $0
 * (lo simulamos poniendo cost_per_unit=0 tras validar) y comprueba que se recompone.
 */

const { createTenant, loginAs, authedClient, cleanupTestTenants } = require('../helpers/factory')
const { createRawMaterial, createProduct, releaseOrder, openShift } = require('../helpers/productionFactory')
const { previewZeroCostShifts, executeZeroCostRecompute } = require('../../src/modules/production/costRecomputeService')
const { pool, query, withBypass } = require('../../src/db')

afterAll(async () => {
  await cleanupTestTenants()
  await pool.end()
})

let counter = 0
const uniq = (s) => `${s}${(Date.now() % 100000)}_${counter++}`

async function ensureWarehouses(tenantId) {
  return withBypass(async () => {
    for (const [name, type] of [
      ['Almacén MP', 'raw_material'], ['Almacén PT', 'finished_product'],
      ['Almacén WIP', 'wip'], ['Almacén Regrind', 'regrind'],
    ]) {
      await query(
        `INSERT INTO warehouses (tenant_id, name, type, is_active)
         SELECT $1,$2,$3,true WHERE NOT EXISTS (SELECT 1 FROM warehouses WHERE tenant_id=$1 AND type=$3)`,
        [tenantId, name, type]
      )
    }
  })
}

describe('herramienta admin — recálculo de turnos en $0', () => {
  test('preview lista el turno y execute lo recompone a costo > 0', async () => {
    const info = await createTenant({ label: uniq('zerorecost'), planSlug: 'owner' })
    const sess = await loginAs({ slug: info.tenant.slug, email: info.email, password: info.password })
    const client = authedClient({ slug: info.tenant.slug, token: sess.token })
    const tenantId = info.tenant.id

    await ensureWarehouses(tenantId)
    const rm = await createRawMaterial(client, { name: uniq('PE'), costPerKg: 10 })
    const product = await createProduct(client, { sku: uniq('PROD'), name: 'Esquinero recost' })
    await client.post(`/api/products/${product.id}/quality-specs`, {
      gramsPerLinearMeter: 50, tolerancePct: 5, unitsPerPackage: 10, notes: 'test',
    }).expect(201)

    const { rows: wh } = await withBypass(() => query(
      `SELECT id FROM warehouses WHERE tenant_id=$1 AND type='raw_material' LIMIT 1`, [tenantId]
    ))
    await withBypass(() => query(
      `INSERT INTO inventory_stock (tenant_id, warehouse_id, item_type, item_id, quantity, avg_cost, status)
       VALUES ($1,$2,'raw_material',$3,100000,10,'available')
       ON CONFLICT (tenant_id, warehouse_id, item_type, item_id, status) DO UPDATE SET quantity=EXCLUDED.quantity`,
      [tenantId, wh[0].id, rm.id]
    ))

    // Orden con fórmula (order_mp_formula) — el camino que dispara el fallback.
    const ord = await client.post('/api/production/orders', {
      productId: product.id, rawMaterialId: rm.id, quantityPackages: 50,
      mpFormula: [{ rawMaterialId: rm.id, percentage: 100 }],
    }).expect(201)
    const orderId = ord.body.id
    await releaseOrder(client, orderId)

    const shift = await openShift(client, {
      lineId: 1, shiftNumber: '1', operatorId: sess.user.id, supervisorId: sess.user.id,
    })
    // Capturar MENOS que la meta (500 u) para que la orden NO quede fulfilled
    // (si no, el revert se bloquea por ORDER_FULFILLED). Sin cargar MP.
    await client.post(`/api/production/shifts/${shift.id}/packages`, {
      productionOrderId: orderId, quantityUnits: 100, realWeightKg: 100,
    }).expect(201)
    await client.post(`/api/production/shifts/${shift.id}/close`).expect(200)
    await client.post(`/api/production/shifts/${shift.id}/validate`, { approved: true }).expect(200)

    // Simular el estado congelado en $0 (como los turnos validados antes del fix).
    await withBypass(() => query(
      `UPDATE production_shifts SET cost_per_unit = 0 WHERE id = $1`, [shift.id]
    ))
    await withBypass(() => query(
      `UPDATE shift_product_costs SET cost_per_unit = 0, total_cost = 0, mp_cost = 0 WHERE shift_id = $1`,
      [shift.id]
    ))

    const today = new Date().toISOString().slice(0, 10)

    // PREVIEW: el turno sale como candidato $0 y revertible.
    const preview = await previewZeroCostShifts({ tenantId, from: '2020-01-01', to: today })
    const row = preview.shifts.find(s => s.shift_id === shift.id)
    expect(row).toBeTruthy()
    expect(row.cost_per_unit).toBe(0)
    expect(row.looks_zero).toBe(true)
    expect(row.revertible).toBe(true)

    // EXECUTE: lo recompone.
    const res = await executeZeroCostRecompute({
      tenantId, shiftIds: [shift.id], userId: sess.user.id,
    })
    expect(res.fixed).toBe(1)
    expect(res.failed).toBe(0)
    expect(res.results[0].fixed).toBe(true)
    expect(res.results[0].before_cost_per_unit).toBe(0)
    expect(res.results[0].after_cost_per_unit).toBeGreaterThan(0)
    expect(res.results[0].final_status).toBe('reviewed')

    // El turno quedó 'reviewed' con costo > 0 y filas por medida > 0.
    const { rows: ps } = await withBypass(() => query(
      `SELECT status, cost_per_unit FROM production_shifts WHERE id = $1`, [shift.id]
    ))
    expect(ps[0].status).toBe('reviewed')
    expect(parseFloat(ps[0].cost_per_unit)).toBeGreaterThan(0)

    const { rows: spc } = await withBypass(() => query(
      `SELECT cost_per_unit FROM shift_product_costs WHERE shift_id = $1`, [shift.id]
    ))
    expect(spc.length).toBeGreaterThan(0)
    expect(parseFloat(spc[0].cost_per_unit)).toBeGreaterThan(0)
  })
})
