'use strict'

/**
 * SaaS v2 — Prorrateo de costo por medida (mig 195).
 *
 * Un turno fabrica DOS medidas del mismo material con pesos distintos. Verifica:
 *  - shift_product_costs guarda un costo por SKU (MP por peso).
 *  - La medida más pesada tiene mayor cost_per_unit (NO el promedio plano).
 *  - El inventario PT (production_pt_entry) entra valuado con el costo de su medida.
 *  - El total del turno se conserva (Σ costo por medida = costo del turno).
 */

const { createTenant, loginAs, authedClient, cleanupTestTenants } = require('../helpers/factory')
const {
  createRawMaterial, createProduct, createOrder, releaseOrder,
  openShift, loadMp,
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

describe('mig 195 — prorrateo de costo por medida', () => {
  let client, tenantId, sess
  let productChico, productGrande, shift

  beforeAll(async () => {
    const info = await createTenant({ label: uniq('prorrateo'), planSlug: 'owner' })
    sess = await loginAs({ slug: info.tenant.slug, email: info.email, password: info.password })
    client = authedClient({ slug: info.tenant.slug, token: sess.token })
    tenantId = info.tenant.id

    await ensureWarehouses(tenantId)

    // MP a $10/kg → avgCostPerKg determinístico = 10.
    const rm = await createRawMaterial(client, { name: uniq('PE'), costPerKg: 10 })

    // Dos medidas del mismo material.
    productChico  = await createProduct(client, { sku: uniq('CHICO'),  name: 'Esquinero 2.0m' })
    productGrande = await createProduct(client, { sku: uniq('GRANDE'), name: 'Esquinero 2.5m' })
    for (const p of [productChico, productGrande]) {
      await client.post(`/api/products/${p.id}/quality-specs`, {
        gramsPerLinearMeter: 50, tolerancePct: 5, unitsPerPackage: 10, notes: 'test',
      }).expect(201)
    }

    // Stock de MP para liberar órdenes + cargar al turno.
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

    const orderChico  = await createOrder(client, { productId: productChico.id,  rawMaterialId: rm.id, quantityPackages: 50 })
    const orderGrande = await createOrder(client, { productId: productGrande.id, rawMaterialId: rm.id, quantityPackages: 50 })
    await releaseOrder(client, orderChico.id)
    await releaseOrder(client, orderGrande.id)

    shift = await openShift(client, {
      lineId: 1, shiftNumber: '1', operatorId: sess.user.id, supervisorId: sess.user.id,
    })

    // Carga MP (400 kg @ $10) → avgCostPerKg = 10.
    await loadMp(client, shift.id, { rawMaterialId: rm.id, kg: 400 })

    // Misma cantidad de PIEZAS (100 c/u) pero pesos distintos:
    //   chico  = 100 kg  → 1 kg/pza
    //   grande = 300 kg  → 3 kg/pza
    await client.post(`/api/production/shifts/${shift.id}/packages`, {
      productionOrderId: orderChico.id, quantityUnits: 100, realWeightKg: 100,
    }).expect(201)
    await client.post(`/api/production/shifts/${shift.id}/packages`, {
      productionOrderId: orderGrande.id, quantityUnits: 100, realWeightKg: 300,
    }).expect(201)

    await client.post(`/api/production/shifts/${shift.id}/close`).expect(200)
    await client.post(`/api/production/shifts/${shift.id}/validate`, { approved: true }).expect(200)
  })

  test('shift_product_costs guarda un costo por SKU, la medida pesada cuesta más', async () => {
    const { rows } = await withBypass(() => query(
      `SELECT product_id, units, total_kg, cost_per_unit
         FROM shift_product_costs WHERE shift_id = $1`,
      [shift.id]
    ))
    expect(rows).toHaveLength(2)
    const chico  = rows.find(r => r.product_id === productChico.id)
    const grande = rows.find(r => r.product_id === productGrande.id)

    // MP por peso: chico 100kg×$10/100pza = $10/pza ; grande 300kg×$10/100pza = $30/pza
    expect(parseFloat(chico.cost_per_unit)).toBeCloseTo(10, 4)
    expect(parseFloat(grande.cost_per_unit)).toBeCloseTo(30, 4)

    // El promedio plano viejo habría dado $20 a AMBOS — aquí difieren.
    expect(parseFloat(chico.cost_per_unit)).not.toBeCloseTo(parseFloat(grande.cost_per_unit), 2)
  })

  test('El total del turno se conserva (Σ por medida = costo total)', async () => {
    const { rows } = await withBypass(() => query(
      `SELECT SUM(total_cost) AS sum_total FROM shift_product_costs WHERE shift_id = $1`,
      [shift.id]
    ))
    // 100kg×10 + 300kg×10 = 4000
    expect(parseFloat(rows[0].sum_total)).toBeCloseTo(4000, 2)
  })

  test('El resumen del turno expone costs.productCosts por medida (para UI y PDF)', async () => {
    const res = await client.get(`/api/production/shifts/${shift.id}/summary`).expect(200)
    const pcs = res.body.costs.productCosts
    expect(Array.isArray(pcs)).toBe(true)
    expect(pcs).toHaveLength(2)
    const chico  = pcs.find(p => p.productId === productChico.id)
    const grande = pcs.find(p => p.productId === productGrande.id)
    expect(chico.costPerUnit).toBeCloseTo(10, 2)
    expect(grande.costPerUnit).toBeCloseTo(30, 2)
    expect(chico.sku).toBeTruthy()
  })

  test('El inventario PT entra valuado con el costo de cada medida (no el promedio)', async () => {
    const { rows } = await withBypass(() => query(
      `SELECT im.item_id, im.unit_cost
         FROM inventory_movements im
         JOIN warehouses w ON w.id = im.warehouse_id
        WHERE im.reference_type = 'production_shift' AND im.reference_id = $1
          AND im.movement_type = 'production_pt_entry' AND w.type = 'finished_product'`,
      [shift.id]
    ))
    const chicoMov  = rows.find(r => r.item_id === productChico.id)
    const grandeMov = rows.find(r => r.item_id === productGrande.id)
    expect(chicoMov).toBeTruthy()
    expect(grandeMov).toBeTruthy()
    expect(parseFloat(chicoMov.unit_cost)).toBeCloseTo(10, 4)
    expect(parseFloat(grandeMov.unit_cost)).toBeCloseTo(30, 4)
  })
})
