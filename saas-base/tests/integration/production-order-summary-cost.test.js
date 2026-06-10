'use strict'

/**
 * Fix 2026-06-09 — "Producción por orden" mostraba $0.0000/pza en cada orden.
 *
 * Causa: el objeto de cada orden en getShiftSummary.production.orderSummary NO
 * traía `costPerUnit` (solo `costPerMeter` global). Cuando las piezas no tienen
 * largo capturado (length_mm=0 → metros=0), el frontend cae a `o.costPerUnit`
 * inexistente y muestra $0.0000/pza — aunque el costo por medida (shift_product_costs)
 * SÍ estaba bien.
 *
 * Verifica que cada orden del resumen lleva el costo de SU medida (>0), y que NO
 * es el promedio plano del turno.
 */

const { createTenant, loginAs, authedClient, cleanupTestTenants } = require('../helpers/factory')
const { createRawMaterial, createProduct, createOrder, releaseOrder, openShift, loadMp } = require('../helpers/productionFactory')
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

describe('fix 2026-06-09 — Producción por orden con costo por medida (no $0)', () => {
  test('cada orden del resumen lleva el costo de su medida, no $0 ni el promedio plano', async () => {
    const info = await createTenant({ label: uniq('ordcost'), planSlug: 'owner' })
    const sess = await loginAs({ slug: info.tenant.slug, email: info.email, password: info.password })
    const client = authedClient({ slug: info.tenant.slug, token: sess.token })
    const tenantId = info.tenant.id

    await ensureWarehouses(tenantId)
    const rm = await createRawMaterial(client, { name: uniq('PE'), costPerKg: 10 })
    const chico  = await createProduct(client, { sku: uniq('CHICO'),  name: 'Esquinero 2.0m' })
    const grande = await createProduct(client, { sku: uniq('GRANDE'), name: 'Esquinero 2.5m' })
    for (const p of [chico, grande]) {
      await client.post(`/api/products/${p.id}/quality-specs`, {
        gramsPerLinearMeter: 50, tolerancePct: 5, unitsPerPackage: 10, notes: 'test',
      }).expect(201)
    }
    const { rows: wh } = await withBypass(() => query(
      `SELECT id FROM warehouses WHERE tenant_id=$1 AND type='raw_material' LIMIT 1`, [tenantId]
    ))
    await withBypass(() => query(
      `INSERT INTO inventory_stock (tenant_id, warehouse_id, item_type, item_id, quantity, avg_cost, status)
       VALUES ($1,$2,'raw_material',$3,100000,10,'available')
       ON CONFLICT (tenant_id, warehouse_id, item_type, item_id, status) DO UPDATE SET quantity=EXCLUDED.quantity`,
      [tenantId, wh[0].id, rm.id]
    ))

    const ordChico  = await createOrder(client, { productId: chico.id,  rawMaterialId: rm.id, quantityPackages: 50 })
    const ordGrande = await createOrder(client, { productId: grande.id, rawMaterialId: rm.id, quantityPackages: 50 })
    await releaseOrder(client, ordChico.id)
    await releaseOrder(client, ordGrande.id)

    const shift = await openShift(client, {
      lineId: 1, shiftNumber: '1', operatorId: sess.user.id, supervisorId: sess.user.id,
    })
    await loadMp(client, shift.id, { rawMaterialId: rm.id, kg: 400 }) // $10/kg

    // chico: 100 u / 100 kg → $10/u ; grande: 100 u / 300 kg → $30/u. SIN lengthMm (metros=0).
    await client.post(`/api/production/shifts/${shift.id}/packages`, {
      productionOrderId: ordChico.id, quantityUnits: 100, realWeightKg: 100,
    }).expect(201)
    await client.post(`/api/production/shifts/${shift.id}/packages`, {
      productionOrderId: ordGrande.id, quantityUnits: 100, realWeightKg: 300,
    }).expect(201)
    await client.post(`/api/production/shifts/${shift.id}/close`).expect(200)
    await client.post(`/api/production/shifts/${shift.id}/validate`, { approved: true }).expect(200)

    const res = await client.get(`/api/production/shifts/${shift.id}/summary`).expect(200)
    const os = res.body.production.orderSummary
    expect(os).toHaveLength(2)

    const chicoRow  = os.find(o => o.orderId === ordChico.id)
    const grandeRow = os.find(o => o.orderId === ordGrande.id)
    expect(chicoRow).toBeTruthy()
    expect(grandeRow).toBeTruthy()

    // Cada orden trae costPerUnit > 0 (antes era undefined → $0 en pantalla).
    expect(chicoRow.costPerUnit).toBeGreaterThan(0)
    expect(grandeRow.costPerUnit).toBeGreaterThan(0)

    // Y es el costo de SU medida, NO el promedio plano ($20). chico≈$10, grande≈$30.
    expect(chicoRow.costPerUnit).toBeCloseTo(10, 1)
    expect(grandeRow.costPerUnit).toBeCloseTo(30, 1)
    expect(chicoRow.costPerUnit).not.toBeCloseTo(grandeRow.costPerUnit, 1)
  })
})
