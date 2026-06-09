'use strict'

/**
 * Fix 2026-06-09 — `validateShift` debe usar la MISMA cadena de fallback de
 * costo/kg que `getShiftSummary` (3 niveles: cargas MP → blended_cost_per_kg →
 * AVG de order_mp_formula → 0).
 *
 * Bug: validateShift tenía solo 2 fallbacks (cargas → blended → 0). Un turno SIN
 * carga de MP, sobre una orden con `order_mp_formula` pero `blended_cost_per_kg`
 * NULL (orden vieja / material costeado después), validaba con avgCostPerKg=0 →
 * congelaba shift_product_costs (y el inventario PT) en $0, mientras el resumen
 * recalculaba un promedio NO-cero usando el 3er fallback. Síntoma reportado:
 * "$0 en cada producto y sólo me muestra el promedio".
 *
 * Este test reproduce el estado (blended NULL + order_mp_formula con costo) y
 * verifica que tras validar, el costo por medida es > 0.
 */

const { createTenant, loginAs, authedClient, cleanupTestTenants } = require('../helpers/factory')
const { createRawMaterial, createProduct, releaseOrder, openShift } = require('../helpers/productionFactory')
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

describe('fix 2026-06-09 — costeo cae a order_mp_formula cuando no hay cargas ni blended', () => {
  test('turno sin MP cargada + orden con blended NULL → costo por medida > 0 (no $0)', async () => {
    const info = await createTenant({ label: uniq('costsrc'), planSlug: 'owner' })
    const sess = await loginAs({ slug: info.tenant.slug, email: info.email, password: info.password })
    const client = authedClient({ slug: info.tenant.slug, token: sess.token })
    const tenantId = info.tenant.id

    await ensureWarehouses(tenantId)

    // MP a $10/kg → AVG(cost_per_kg) de la fórmula = 10.
    const rm = await createRawMaterial(client, { name: uniq('PE'), costPerKg: 10 })
    const product = await createProduct(client, { sku: uniq('PROD'), name: 'Esquinero costsrc' })
    await client.post(`/api/products/${product.id}/quality-specs`, {
      gramsPerLinearMeter: 50, tolerancePct: 5, unitsPerPackage: 10, notes: 'test',
    }).expect(201)

    // Stock de MP para poder liberar la orden.
    const { rows: wh } = await withBypass(() => query(
      `SELECT id FROM warehouses WHERE tenant_id=$1 AND type='raw_material' LIMIT 1`, [tenantId]
    ))
    await withBypass(() => query(
      `INSERT INTO inventory_stock (tenant_id, warehouse_id, item_type, item_id, quantity, avg_cost, status)
       VALUES ($1,$2,'raw_material',$3,100000,10,'available')
       ON CONFLICT (tenant_id, warehouse_id, item_type, item_id, status) DO UPDATE SET quantity=EXCLUDED.quantity`,
      [tenantId, wh[0].id, rm.id]
    ))

    // Orden CON fórmula de MP (puebla order_mp_formula). createOrder calcula
    // blended_cost_per_kg automáticamente, así que lo forzamos a NULL para simular
    // una orden vieja / material costeado después → el bug solo aparece con blended NULL.
    const ordRes = await client.post('/api/production/orders', {
      productId: product.id, rawMaterialId: rm.id, quantityPackages: 50,
      mpFormula: [{ rawMaterialId: rm.id, percentage: 100 }],
    }).expect(201)
    const orderId = ordRes.body.id

    await withBypass(() => query(
      `UPDATE production_orders SET blended_cost_per_kg = NULL WHERE id = $1`, [orderId]
    ))
    // Sanity: la orden tiene fórmula y NO tiene blended.
    const { rows: ompf } = await withBypass(() => query(
      `SELECT (SELECT COUNT(*)::int FROM order_mp_formula WHERE production_order_id=$1) AS formula_rows,
              (SELECT blended_cost_per_kg FROM production_orders WHERE id=$1) AS blended`, [orderId]
    ))
    expect(ompf[0].formula_rows).toBeGreaterThan(0)
    expect(ompf[0].blended).toBeNull()

    await releaseOrder(client, orderId)

    const shift = await openShift(client, {
      lineId: 1, shiftNumber: '1', operatorId: sess.user.id, supervisorId: sess.user.id,
    })

    // Capturar SIN cargar MP (clave del bug: shift_mp_loads vacío).
    await client.post(`/api/production/shifts/${shift.id}/packages`, {
      productionOrderId: orderId, quantityUnits: 100, realWeightKg: 100,
    }).expect(201)

    await client.post(`/api/production/shifts/${shift.id}/close`).expect(200)
    await client.post(`/api/production/shifts/${shift.id}/validate`, { approved: true }).expect(200)

    // Con el 3er fallback (AVG order_mp_formula = $10/kg) el costo NO debe ser $0.
    const { rows: spc } = await withBypass(() => query(
      `SELECT cost_per_unit, total_cost, mp_cost FROM shift_product_costs WHERE shift_id = $1`,
      [shift.id]
    ))
    expect(spc.length).toBe(1)
    expect(parseFloat(spc[0].cost_per_unit)).toBeGreaterThan(0)
    expect(parseFloat(spc[0].mp_cost)).toBeGreaterThan(0)

    // Y el promedio del turno también > 0 (consistente con el resumen).
    const { rows: ps } = await withBypass(() => query(
      `SELECT cost_per_unit FROM production_shifts WHERE id = $1`, [shift.id]
    ))
    expect(parseFloat(ps[0].cost_per_unit)).toBeGreaterThan(0)
  })
})
