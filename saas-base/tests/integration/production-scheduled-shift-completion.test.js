'use strict'

/**
 * Mig 201 / fix 2026-06-09 — sincronización scheduled_shifts ↔ production_shifts.
 *
 * Bug: al confirmar presencia, scheduled_shifts pasa a 'active', pero nunca tenía
 * transición terminal al validar el turno real. Resultado: en Programación los
 * turnos ya validados se veían "activos" para siempre, y Captura (que lee
 * production_shifts) decía "no hay turno activo".
 *
 * Verifica la corrección hacia adelante: al validar el turno (production_shift →
 * 'reviewed'), el scheduled_shift ligado pasa a 'completed'.
 */

const { createTenant, loginAs, authedClient, cleanupTestTenants } = require('../helpers/factory')
const {
  createRawMaterial, createProduct, createOrder, releaseOrder, scheduleShift, loadMp,
} = require('../helpers/productionFactory')
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
      ['Almacén MP', 'raw_material'],
      ['Almacén PT', 'finished_product'],
      ['Almacén WIP', 'wip'],
      ['Almacén Regrind', 'regrind'],
    ]) {
      await query(
        `INSERT INTO warehouses (tenant_id, name, type, is_active)
         SELECT $1, $2, $3, true
         WHERE NOT EXISTS (SELECT 1 FROM warehouses WHERE tenant_id = $1 AND type = $3)`,
        [tenantId, name, type]
      )
    }
  })
}

describe('fix 2026-06-09 — al validar, el scheduled_shift ligado pasa a completed', () => {
  test('programar → confirmar → capturar → cerrar → validar deja scheduled_shift en completed', async () => {
    const info = await createTenant({ label: uniq('schedsync'), planSlug: 'owner' })
    const sess = await loginAs({ slug: info.tenant.slug, email: info.email, password: info.password })
    const client = authedClient({ slug: info.tenant.slug, token: sess.token })
    const tenantId = info.tenant.id

    await ensureWarehouses(tenantId)

    const rm = await createRawMaterial(client, { name: uniq('PE'), costPerKg: 10 })
    const product = await createProduct(client, { sku: uniq('PROD'), name: 'Esquinero sched' })
    await client.post(`/api/products/${product.id}/quality-specs`, {
      gramsPerLinearMeter: 50, tolerancePct: 5, unitsPerPackage: 10, notes: 'test',
    }).expect(201)

    const { rows: whRows } = await withBypass(() => query(
      `SELECT id FROM warehouses WHERE tenant_id=$1 AND type='raw_material' LIMIT 1`, [tenantId]
    ))
    await withBypass(() => query(
      `INSERT INTO inventory_stock (tenant_id, warehouse_id, item_type, item_id, quantity, avg_cost, status)
       VALUES ($1, $2, 'raw_material', $3, 100000, 10, 'available')
       ON CONFLICT (tenant_id, warehouse_id, item_type, item_id, status)
       DO UPDATE SET quantity = EXCLUDED.quantity`,
      [tenantId, whRows[0].id, rm.id]
    ))

    const order = await createOrder(client, { productId: product.id, rawMaterialId: rm.id, quantityPackages: 50 })
    await releaseOrder(client, order.id)

    // Programar para HOY (confirmPresence exige status='scheduled', no chequea fecha).
    const today = new Date().toISOString().slice(0, 10)
    const scheduled = await scheduleShift(client, {
      productionOrderId: order.id, shiftNumber: '1', scheduledDate: today,
      operatorId: sess.user.id, supervisorId: sess.user.id, lineId: 1,
    })

    // Confirmar presencia → crea el production_shift activo, scheduled → 'active'.
    const confirmRes = await client.post(`/api/production/scheduled-shifts/${scheduled.id}/confirm`).expect(200)
    const shiftId = confirmRes.body.shift.id
    expect(confirmRes.body.shift.status).toBe('active')

    const { rows: afterConfirm } = await withBypass(() => query(
      `SELECT status FROM scheduled_shifts WHERE id = $1`, [scheduled.id]
    ))
    expect(afterConfirm[0].status).toBe('active')

    // Capturar, cerrar y validar.
    await loadMp(client, shiftId, { rawMaterialId: rm.id, kg: 100 })
    await client.post(`/api/production/shifts/${shiftId}/packages`, {
      productionOrderId: order.id, quantityUnits: 100, realWeightKg: 100,
    }).expect(201)
    await client.post(`/api/production/shifts/${shiftId}/close`).expect(200)
    await client.post(`/api/production/shifts/${shiftId}/validate`, { approved: true }).expect(200)

    // El turno real quedó 'reviewed' y el PROGRAMADO ligado quedó 'completed'
    // (antes se quedaba 'active' para siempre → "todos activos en Programación").
    const { rows: prod } = await withBypass(() => query(
      `SELECT status FROM production_shifts WHERE id = $1`, [shiftId]
    ))
    expect(prod[0].status).toBe('reviewed')

    const { rows: sched } = await withBypass(() => query(
      `SELECT status FROM scheduled_shifts WHERE id = $1`, [scheduled.id]
    ))
    expect(sched[0].status).toBe('completed')
  })
})
