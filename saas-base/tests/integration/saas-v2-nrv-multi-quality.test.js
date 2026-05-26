'use strict'

/**
 * SaaS v2 — Tests del §6c: NRV multi-calidad.
 *
 * Cubre:
 *  - PATCH /api/products/:id ahora acepta expected_sale_price (fix gap 4.2).
 *  - validateShift calcula cost_per_unit usando NRV: calidades inferiores se
 *    valúan a expected_sale_price × kg; cal-1 absorbe el costo restante.
 *  - getShiftSummary expone nrvLowerGrades, nrvWarning, costGrade1.
 *  - Edge case: NRV ≥ total cost → nrvWarning=true, costo sin descontar.
 *  - Sin calidades inferiores (solo cal-1): NRV=0, comportamiento idéntico
 *    al pre-6c (sin regresión).
 *
 * Escenario numérico:
 *  - MP: $10/kg, carga de 800 kg → avg_cost_per_kg = $10
 *  - Producción: 600 kg cal-1 (6 u) + 200 kg cal-2 (2 u)
 *  - expected_sale_price cal-2 = $5/kg → NRV = 200 × $5 = $1,000
 *  - totalCost = 800 × $10 = $8,000 (sin costos fijos)
 *  - costGrade1 = $8,000 − $1,000 = $7,000
 *  - costPerUnit = $7,000 / 6 ≈ $1,166.67
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
         WHERE NOT EXISTS (
           SELECT 1 FROM warehouses WHERE tenant_id = $1 AND type = $3
         )`,
        [tenantId, name, type]
      )
    }
  })
}

async function setupNrvScenario({ expectedSalePriceCal2 = 5 } = {}) {
  const info = await createTenant({ label: uniq('nrv'), planSlug: 'owner' })
  const sess = await loginAs({ slug: info.tenant.slug, email: info.email, password: info.password })
  const client = authedClient({ slug: info.tenant.slug, token: sess.token })
  const tenantId = info.tenant.id

  await ensureWarehouses(tenantId)

  // Materias primas
  const rm = await createRawMaterial(client, { name: uniq('MP'), costPerKg: 10 })

  // Producto A (cal-1)
  const productA = await createProduct(client, { sku: uniq('SKU-A'), name: 'Pellet Cal-1' })

  // Producto B (cal-2) con expected_sale_price
  const productB = await createProduct(client, { sku: uniq('SKU-B'), name: 'Pellet Cal-2' })
  await client.patch(`/api/products/${productB.id}`, {
    expected_sale_price: expectedSalePriceCal2,
  }).expect(200)

  // Stock para que release no falle
  const { rows: whRows } = await withBypass(() => query(
    `SELECT id FROM warehouses WHERE tenant_id=$1 AND type='raw_material' LIMIT 1`,
    [tenantId]
  ))
  await withBypass(() => query(
    `INSERT INTO inventory_stock
       (tenant_id, warehouse_id, item_type, item_id, quantity, avg_cost, status)
     VALUES ($1, $2, 'raw_material', $3, 2000, 10, 'available')
     ON CONFLICT (tenant_id, warehouse_id, item_type, item_id, status)
     DO UPDATE SET quantity = EXCLUDED.quantity`,
    [tenantId, whRows[0].id, rm.id]
  ))

  const order = await createOrder(client, { productId: productA.id, rawMaterialId: rm.id, quantityPackages: 20 })
  await releaseOrder(client, order.id)
  const shift = await openShift(client, {
    lineId: 1, shiftNumber: '1',
    operatorId: sess.user.id, supervisorId: sess.user.id,
  })

  // Cargar 800 kg de MP → avg_cost_per_kg=$10 para validateShift
  await loadMp(client, shift.id, { rawMaterialId: rm.id, kg: 800 })

  // Capturar 600 kg cal-1 (6 unidades)
  await client.post(`/api/production/shifts/${shift.id}/packages`, {
    productionOrderId: order.id,
    quantityUnits: 6, realWeightKg: 600, gradeNumber: 1,
  }).expect(201)

  // Capturar 200 kg cal-2 (2 unidades) con secondQualityProductId = productB
  await client.post(`/api/production/shifts/${shift.id}/packages`, {
    productionOrderId: order.id,
    quantityUnits: 2, realWeightKg: 200,
    gradeNumber: 2,
    secondQualityProductId: productB.id,
  }).expect(201)

  // Cerrar turno y validar
  await client.post(`/api/production/shifts/${shift.id}/close`).expect(200)
  await client.post(`/api/production/shifts/${shift.id}/validate`, { approved: true }).expect(200)

  return { info, client, tenantId, rm, productA, productB, order, shift }
}

// ─────────────────────────────────────────────────────────────────
//  Fix gap 4.2: PATCH /api/products acepta expected_sale_price
// ─────────────────────────────────────────────────────────────────

describe('§6c Gap 4.2: PATCH /api/products acepta expected_sale_price', () => {
  let client, productId

  beforeAll(async () => {
    const info = await createTenant({ label: uniq('patch'), planSlug: 'owner' })
    const sess = await loginAs({ slug: info.tenant.slug, email: info.email, password: info.password })
    client = authedClient({ slug: info.tenant.slug, token: sess.token })
    const p = await createProduct(client, { sku: uniq('SKU'), name: 'Prod PATCH test' })
    productId = p.id
  })

  test('PATCH acepta expected_sale_price y lo devuelve en la respuesta', async () => {
    const res = await client.patch(`/api/products/${productId}`, {
      expected_sale_price: 49.99,
    }).expect(200)
    expect(parseFloat(res.body.expected_sale_price)).toBeCloseTo(49.99, 2)
  })

  test('PATCH acepta expected_sale_price en camelCase también', async () => {
    const res = await client.patch(`/api/products/${productId}`, {
      expectedSalePrice: 25.00,
    }).expect(200)
    expect(parseFloat(res.body.expected_sale_price)).toBeCloseTo(25.00, 2)
  })

  test('PATCH puede limpiar expected_sale_price a NULL', async () => {
    const res = await client.patch(`/api/products/${productId}`, {
      expected_sale_price: null,
    }).expect(200)
    expect(res.body.expected_sale_price).toBeNull()
  })

  test('PATCH acepta is_produced', async () => {
    const res = await client.patch(`/api/products/${productId}`, {
      is_produced: true,
    }).expect(200)
    expect(res.body.is_produced).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────
//  NRV multi-calidad: validateShift
// ─────────────────────────────────────────────────────────────────

describe('§6c NRV: validateShift calcula cost_per_unit con NRV', () => {
  let ctx

  beforeAll(async () => {
    ctx = await setupNrvScenario({ expectedSalePriceCal2: 5 })
  })

  test('cost_per_unit en production_shifts es NRV-ajustado', async () => {
    const { rows } = await withBypass(() => query(
      `SELECT cost_per_unit FROM production_shifts WHERE id=$1`,
      [ctx.shift.id]
    ))
    // totalCost=$8,000, nrvLower=$1,000, costGrade1=$7,000, goodUnits=6
    const expected = 7000 / 6
    expect(parseFloat(rows[0].cost_per_unit)).toBeCloseTo(expected, 2)
  })

  test('cost_per_unit SIN NRV sería mayor (regresión: ratio correcto)', async () => {
    // Sin NRV: $8,000/6 ≈ $1,333.33. Con NRV: $7,000/6 ≈ $1,166.67.
    const { rows } = await withBypass(() => query(
      `SELECT cost_per_unit FROM production_shifts WHERE id=$1`,
      [ctx.shift.id]
    ))
    const withNrv    = parseFloat(rows[0].cost_per_unit)
    const withoutNrv = 8000 / 6
    expect(withNrv).toBeLessThan(withoutNrv)
  })
})

describe('§6c NRV: getShiftSummary expone breakdown NRV', () => {
  let ctx, summary

  beforeAll(async () => {
    ctx = await setupNrvScenario({ expectedSalePriceCal2: 5 })
    const res = await ctx.client.get(`/api/production/shifts/${ctx.shift.id}/summary`).expect(200)
    summary = res.body
  })

  test('nrvLowerGrades ≈ $1,000 (200 kg × $5)', async () => {
    expect(summary.costs.nrvLowerGrades).toBeCloseTo(1000, 1)
  })

  test('nrvWarning = false (NRV < totalCost)', async () => {
    expect(summary.costs.nrvWarning).toBe(false)
  })

  test('costGrade1 ≈ $7,000', async () => {
    expect(summary.costs.costGrade1).toBeCloseTo(7000, 1)
  })

  test('costPerUnit ≈ $7,000/6', async () => {
    expect(summary.costs.costPerUnit).toBeCloseTo(7000 / 6, 2)
  })
})

// ─────────────────────────────────────────────────────────────────
//  Edge case: NRV ≥ totalCost → nrvWarning=true
// ─────────────────────────────────────────────────────────────────

describe('§6c NRV edge case: NRV ≥ totalCost → nrvWarning=true', () => {
  let ctx, summary

  beforeAll(async () => {
    // expectedSalePriceCal2 = $50/kg → NRV = 200×50 = $10,000 > $8,000
    ctx = await setupNrvScenario({ expectedSalePriceCal2: 50 })
    const res = await ctx.client.get(`/api/production/shifts/${ctx.shift.id}/summary`).expect(200)
    summary = res.body
  })

  test('nrvWarning = true cuando NRV supera totalCost', async () => {
    expect(summary.costs.nrvWarning).toBe(true)
  })

  test('costGrade1 = totalCost (sin descontar cuando NRV anormal)', async () => {
    // totalCost ≈ $8,000; costGrade1 debe ser igual a totalCost
    expect(summary.costs.costGrade1).toBeCloseTo(summary.costs.totalCost, 1)
  })

  test('cost_per_unit = totalCost/goodUnits (sin descontar)', async () => {
    const { rows } = await withBypass(() => query(
      `SELECT cost_per_unit FROM production_shifts WHERE id=$1`,
      [ctx.shift.id]
    ))
    // Con nrvWarning: costGrade1 = $8,000, goodUnits=6 → $1,333.33
    const expectedNoNrv = 8000 / 6
    expect(parseFloat(rows[0].cost_per_unit)).toBeCloseTo(expectedNoNrv, 2)
  })
})

// ─────────────────────────────────────────────────────────────────
//  Sin calidades inferiores: NRV=0 (sin regresión)
// ─────────────────────────────────────────────────────────────────

describe('§6c NRV: solo cal-1 → NRV=0, cost_per_unit sin cambio', () => {
  let ctx, summary

  beforeAll(async () => {
    const info = await createTenant({ label: uniq('nrv1'), planSlug: 'owner' })
    const sess = await loginAs({ slug: info.tenant.slug, email: info.email, password: info.password })
    const client = authedClient({ slug: info.tenant.slug, token: sess.token })
    const tenantId = info.tenant.id

    await ensureWarehouses(tenantId)
    const rm = await createRawMaterial(client, { name: uniq('MP'), costPerKg: 10 })
    const product = await createProduct(client, { sku: uniq('SKU'), name: 'Prod cal-1 only' })

    const { rows: whRows } = await withBypass(() => query(
      `SELECT id FROM warehouses WHERE tenant_id=$1 AND type='raw_material' LIMIT 1`,
      [tenantId]
    ))
    await withBypass(() => query(
      `INSERT INTO inventory_stock
         (tenant_id, warehouse_id, item_type, item_id, quantity, avg_cost, status)
       VALUES ($1, $2, 'raw_material', $3, 1000, 10, 'available')
       ON CONFLICT (tenant_id, warehouse_id, item_type, item_id, status)
       DO UPDATE SET quantity = EXCLUDED.quantity`,
      [tenantId, whRows[0].id, rm.id]
    ))

    const order = await createOrder(client, { productId: product.id, rawMaterialId: rm.id, quantityPackages: 10 })
    await releaseOrder(client, order.id)
    const shift = await openShift(client, {
      lineId: 1, shiftNumber: '1', operatorId: sess.user.id, supervisorId: sess.user.id,
    })

    await loadMp(client, shift.id, { rawMaterialId: rm.id, kg: 300 })

    await client.post(`/api/production/shifts/${shift.id}/packages`, {
      productionOrderId: order.id,
      quantityUnits: 3, realWeightKg: 300, gradeNumber: 1,
    }).expect(201)

    await client.post(`/api/production/shifts/${shift.id}/close`).expect(200)
    await client.post(`/api/production/shifts/${shift.id}/validate`, { approved: true }).expect(200)

    const res = await client.get(`/api/production/shifts/${shift.id}/summary`).expect(200)
    summary = res.body
    ctx = { shift, client }
  })

  test('nrvLowerGrades = 0 cuando solo hay cal-1', async () => {
    expect(summary.costs.nrvLowerGrades).toBe(0)
  })

  test('nrvWarning = false', async () => {
    expect(summary.costs.nrvWarning).toBe(false)
  })

  test('costGrade1 = totalCost (sin descuento)', async () => {
    expect(summary.costs.costGrade1).toBeCloseTo(summary.costs.totalCost, 1)
  })

  test('costPerUnit = totalCost/3 (sin NRV: 300 kg × $10 / 3 u = $1,000/u)', async () => {
    // 300 kg × $10 = $3,000; goodUnits = 3 → $1,000/u
    expect(summary.costs.costPerUnit).toBeCloseTo(1000, 1)
  })
})
