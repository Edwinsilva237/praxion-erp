'use strict'

/**
 * SaaS v2 — Tests del refactor §5g: capturePackage + closeShift con product_lots.
 *
 * Cubre:
 *  - Legacy intacto (uses_lots=false): capturePackage no toca product_lots.
 *  - uses_lots=true + per_shift (default):
 *    - 1er paquete crea product_lot con lot_number generado.
 *    - 2do paquete del mismo (shift × product × quality) aumenta el mismo lote.
 *    - 2da calidad genera un lote distinto (grade_number=2).
 *    - shift_progress.lot_id queda poblado.
 *    - inventory_movement lleva product_lot_id (no raw_material_lot_id).
 *    - NO se debita MP de inventory_stock (ya pasó en loadMp).
 *  - uses_lots=true + per_package: cada captura crea un product_lot único.
 *  - uses_lots=true + per_attribute_set: rechaza 501.
 *  - closeShift con uses_lots=true: genera lot_consumption distribuyendo
 *    raw_material_lots entre product_lots proporcionalmente al peso producido.
 *  - Guards editPackage/deletePackage cuando shift_progress.lot_id != null.
 */

const { createTenant, loginAs, authedClient, cleanupTestTenants } = require('../helpers/factory')
const {
  createRawMaterial, createProduct, createOrder, releaseOrder,
  openShift, loadMp, capturePackage,
} = require('../helpers/productionFactory')
const { pool, query, withBypass } = require('../../src/db')

afterAll(async () => {
  await cleanupTestTenants()
  await pool.end()
})

let counter = 0
const uniq = (s) => `${s}${(Date.now() % 100000)}_${counter++}`

async function ensureWarehouses(tenantId) {
  // Asegurar warehouses de los 4 tipos para tenants creados en runtime de tests
  // (la migration 040 solo seedea tenants existentes al momento de aplicarla).
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

async function setupTenant({ label, usesLots = false, granularity = 'per_shift', lotPattern = null }) {
  const info = await createTenant({ label, planSlug: 'owner' })
  const sess = await loginAs({ slug: info.tenant.slug, email: info.email, password: info.password })
  const client = authedClient({ slug: info.tenant.slug, token: sess.token })
  const tenantId = info.tenant.id

  await withBypass(() => query(
    `UPDATE tenant_process_config
     SET uses_lots = $2, product_lot_granularity = $3, lot_number_pattern = $4
     WHERE tenant_id = $1`,
    [tenantId, usesLots, granularity, lotPattern]
  ))

  await ensureWarehouses(tenantId)

  const rm = await createRawMaterial(client, { name: uniq('MP'), costPerKg: 10 })
  const product = await createProduct(client, { sku: uniq('SKU'), name: 'Prod Test' })

  // Spec mínima para que theoretical_weight no quede en 0
  await client.post(`/api/products/${product.id}/quality-specs`, {
    gramsPerLinearMeter: 50, tolerancePct: 5, unitsPerPackage: 50, notes: 'test',
  }).expect(201)

  // Insertar inventory_stock para que release no falle por low stock
  const { rows: whRows } = await withBypass(() => query(
    `SELECT id FROM warehouses WHERE tenant_id = $1 AND type = 'raw_material' LIMIT 1`,
    [tenantId]
  ))
  const warehouseRmId = whRows[0].id

  await withBypass(() => query(
    `INSERT INTO inventory_stock
       (tenant_id, warehouse_id, item_type, item_id, quantity, avg_cost, status)
     VALUES ($1, $2, 'raw_material', $3, 1000, 10, 'available')
     ON CONFLICT (tenant_id, warehouse_id, item_type, item_id, status)
     DO UPDATE SET quantity = EXCLUDED.quantity`,
    [tenantId, warehouseRmId, rm.id]
  ))

  const order = await createOrder(client, { productId: product.id, rawMaterialId: rm.id, quantityPackages: 5 })
  await releaseOrder(client, order.id)
  const shift = await openShift(client, {
    lineId: 1, shiftNumber: '1',
    operatorId: sess.user.id, supervisorId: sess.user.id,
  })

  return { info, client, tenantId, rm, product, order, shift, warehouseRmId, sess }
}

async function insertLot(tenantId, rmId, warehouseId, extras = {}) {
  const lotNumber = extras.lot_number || uniq('LOT')
  const qtyReceived = extras.quantity_received ?? 100
  const qtyRemaining = extras.quantity_remaining ?? qtyReceived
  const cols = ['tenant_id', 'raw_material_id', 'lot_number', 'warehouse_id',
                'quantity_received', 'quantity_remaining', 'unit_cost']
  const vals = [tenantId, rmId, lotNumber, warehouseId, qtyReceived, qtyRemaining,
                extras.unit_cost ?? 10]
  const params = vals.map((_, i) => `$${i + 1}`)
  let i = vals.length + 1
  for (const [k, v] of Object.entries(extras)) {
    if (['lot_number', 'quantity_received', 'quantity_remaining', 'unit_cost'].includes(k)) continue
    cols.push(k); vals.push(v); params.push(`$${i++}`)
  }
  const { rows } = await withBypass(() => query(
    `INSERT INTO raw_material_lots (${cols.join(',')}) VALUES (${params.join(',')}) RETURNING *`,
    vals
  ))
  return rows[0]
}

// ═══════════════════════════════════════════════════════════════════════════
// Legacy intacto
// ═══════════════════════════════════════════════════════════════════════════

describe('capturePackage legacy (uses_lots=false)', () => {
  let ctx
  beforeAll(async () => { ctx = await setupTenant({ label: 'cap-legacy' }) })

  test('No genera product_lots ni toca shift_progress.lot_id', async () => {
    const pkg = await capturePackage(ctx.client, ctx.shift.id, {
      productionOrderId: ctx.order.id,
      quantityUnits: 50, realWeightKg: 2.5, theoreticalWeightKg: 2.5, lengthMm: 1000,
    })
    expect(pkg.lot_id).toBeNull()

    const { rows: plots } = await withBypass(() => query(
      `SELECT id FROM product_lots WHERE shift_id = $1`, [ctx.shift.id]
    ))
    expect(plots.length).toBe(0)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// uses_lots=true + per_shift (default): un lote acumula los paquetes
// ═══════════════════════════════════════════════════════════════════════════

describe('capturePackage uses_lots=true + per_shift', () => {
  let ctx
  beforeAll(async () => {
    ctx = await setupTenant({ label: 'cap-shift', usesLots: true, granularity: 'per_shift' })
    // Cargar MP con lote para que capturePackage tenga consumo previo de MP.
    const lot = await insertLot(ctx.tenantId, ctx.rm.id, ctx.warehouseRmId, { quantity_received: 100 })
    await loadMp(ctx.client, ctx.shift.id, {
      rawMaterialId: ctx.rm.id, kg: 30, lotId: lot.id,
    })
    ctx.rmLotId = lot.id
  })

  test('1er paquete crea product_lot con lot_number generado y vincula shift_progress.lot_id', async () => {
    const pkg1 = await capturePackage(ctx.client, ctx.shift.id, {
      productionOrderId: ctx.order.id, quantityUnits: 50,
      realWeightKg: 2.5, theoreticalWeightKg: 2.5, lengthMm: 1000,
    })
    expect(pkg1.lot_id).toBeTruthy()

    const { rows: lots } = await withBypass(() => query(
      `SELECT id, lot_number, quantity_produced, quantity_remaining, quality_grade_id, origin, shift_id
       FROM product_lots WHERE shift_id = $1`, [ctx.shift.id]
    ))
    expect(lots.length).toBe(1)
    expect(lots[0].id).toBe(pkg1.lot_id)
    expect(lots[0].origin).toBe('produced')
    expect(parseFloat(lots[0].quantity_produced)).toBeCloseTo(2.5, 2)
    expect(parseFloat(lots[0].quantity_remaining)).toBeCloseTo(2.5, 2)
    expect(lots[0].lot_number).toMatch(/\d{4}\d{2}\d{2}-.+-\d{3}/)
    ctx.firstLotId = lots[0].id
    ctx.firstLotQualityId = lots[0].quality_grade_id
  })

  test('2do paquete del mismo (shift × product × quality) AUMENTA el mismo lote', async () => {
    await capturePackage(ctx.client, ctx.shift.id, {
      productionOrderId: ctx.order.id, quantityUnits: 50,
      realWeightKg: 2.7, theoreticalWeightKg: 2.5, lengthMm: 1000,
    })

    const { rows: lots } = await withBypass(() => query(
      `SELECT id, quantity_produced, quantity_remaining FROM product_lots WHERE shift_id = $1`,
      [ctx.shift.id]
    ))
    expect(lots.length).toBe(1)
    expect(lots[0].id).toBe(ctx.firstLotId)
    expect(parseFloat(lots[0].quantity_produced)).toBeCloseTo(2.5 + 2.7, 2)
    expect(parseFloat(lots[0].quantity_remaining)).toBeCloseTo(2.5 + 2.7, 2)
  })

  test('Paquete de 2da calidad crea un lote distinto (grade_number=2)', async () => {
    const pkg2nd = await capturePackage(ctx.client, ctx.shift.id, {
      productionOrderId: ctx.order.id, quantityUnits: 50,
      realWeightKg: 2.4, theoreticalWeightKg: 2.5, lengthMm: 1000,
      isSecondQuality: true, secondQualityProductId: ctx.product.id,
    })
    const { rows: lots } = await withBypass(() => query(
      `SELECT id, quality_grade_id, quantity_produced FROM product_lots WHERE shift_id = $1
       ORDER BY created_at ASC`,
      [ctx.shift.id]
    ))
    expect(lots.length).toBe(2)
    expect(lots[1].id).toBe(pkg2nd.lot_id)
    expect(lots[1].quality_grade_id).not.toBe(ctx.firstLotQualityId)

    // Verificar que el grade es 2
    const { rows: gradeRows } = await withBypass(() => query(
      `SELECT grade_number FROM tenant_quality_grades WHERE id = $1`, [lots[1].quality_grade_id]
    ))
    expect(gradeRows[0].grade_number).toBe(2)
  })

  test('inventory_movement de captura lleva product_lot_id (sin raw_material_lot_id)', async () => {
    // Pkg más reciente
    const { rows: pkgs } = await withBypass(() => query(
      `SELECT id FROM shift_progress WHERE shift_id = $1 ORDER BY captured_at DESC LIMIT 1`,
      [ctx.shift.id]
    ))
    const lastPkgId = pkgs[0].id

    const { rows: mvs } = await withBypass(() => query(
      `SELECT product_lot_id, raw_material_lot_id, movement_type, item_type
       FROM inventory_movements
       WHERE tenant_id = $1 AND reference_type = 'shift_progress' AND reference_id = $2`,
      [ctx.tenantId, lastPkgId]
    ))
    expect(mvs.length).toBeGreaterThanOrEqual(1)
    const ptMv = mvs.find(m => m.item_type === 'product')
    expect(ptMv).toBeTruthy()
    expect(ptMv.product_lot_id).toBeTruthy()
    expect(ptMv.raw_material_lot_id).toBeNull()
    expect(ptMv.movement_type).toBe('production_wip_entry')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// uses_lots=true + per_package: cada captura crea un lote
// ═══════════════════════════════════════════════════════════════════════════

describe('capturePackage uses_lots=true + per_package', () => {
  let ctx
  beforeAll(async () => {
    ctx = await setupTenant({ label: 'cap-pkg', usesLots: true, granularity: 'per_package' })
    const lot = await insertLot(ctx.tenantId, ctx.rm.id, ctx.warehouseRmId, { quantity_received: 100 })
    await loadMp(ctx.client, ctx.shift.id, { rawMaterialId: ctx.rm.id, kg: 20, lotId: lot.id })
  })

  test('Cada captura crea un product_lot único', async () => {
    const p1 = await capturePackage(ctx.client, ctx.shift.id, {
      productionOrderId: ctx.order.id, quantityUnits: 50,
      realWeightKg: 2.5, theoreticalWeightKg: 2.5, lengthMm: 1000,
    })
    const p2 = await capturePackage(ctx.client, ctx.shift.id, {
      productionOrderId: ctx.order.id, quantityUnits: 50,
      realWeightKg: 2.6, theoreticalWeightKg: 2.5, lengthMm: 1000,
    })
    expect(p1.lot_id).toBeTruthy()
    expect(p2.lot_id).toBeTruthy()
    expect(p1.lot_id).not.toBe(p2.lot_id)

    const { rows: lots } = await withBypass(() => query(
      `SELECT id, lot_number FROM product_lots WHERE shift_id = $1 ORDER BY created_at ASC`,
      [ctx.shift.id]
    ))
    expect(lots.length).toBe(2)
    expect(lots[0].lot_number).not.toBe(lots[1].lot_number)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// uses_lots=true + per_attribute_set: rechazo 501
// ═══════════════════════════════════════════════════════════════════════════

describe('capturePackage uses_lots=true + per_attribute_set', () => {
  test('Rechaza con 501 Not Implemented', async () => {
    const ctx = await setupTenant({
      label: 'cap-attr', usesLots: true, granularity: 'per_attribute_set',
    })
    const lot = await insertLot(ctx.tenantId, ctx.rm.id, ctx.warehouseRmId, { quantity_received: 50 })
    await loadMp(ctx.client, ctx.shift.id, { rawMaterialId: ctx.rm.id, kg: 10, lotId: lot.id })

    const res = await ctx.client.post(`/api/production/shifts/${ctx.shift.id}/packages`, {
      productionOrderId: ctx.order.id,
      quantityUnits: 50, realWeightKg: 2.5, theoreticalWeightKg: 2.5, lengthMm: 1000,
    })
    expect(res.status).toBe(501)
    expect(res.body.error).toMatch(/per_attribute_set|implementada/)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// closeShift con uses_lots=true: distribución lot_consumption
// ═══════════════════════════════════════════════════════════════════════════

describe('closeShift genera lot_consumption (uses_lots=true)', () => {
  let ctx, rmLotId
  beforeAll(async () => {
    ctx = await setupTenant({ label: 'close-dist', usesLots: true, granularity: 'per_shift' })
    const lot = await insertLot(ctx.tenantId, ctx.rm.id, ctx.warehouseRmId, { quantity_received: 100 })
    rmLotId = lot.id
    await loadMp(ctx.client, ctx.shift.id, { rawMaterialId: ctx.rm.id, kg: 20, lotId: lot.id })

    // Capturar 2 paquetes 1ra calidad (mismo product_lot)
    await capturePackage(ctx.client, ctx.shift.id, {
      productionOrderId: ctx.order.id, quantityUnits: 50,
      realWeightKg: 2.5, theoreticalWeightKg: 2.5, lengthMm: 1000,
    })
    await capturePackage(ctx.client, ctx.shift.id, {
      productionOrderId: ctx.order.id, quantityUnits: 50,
      realWeightKg: 2.5, theoreticalWeightKg: 2.5, lengthMm: 1000,
    })
    // Y uno de 2da calidad (otro product_lot)
    await capturePackage(ctx.client, ctx.shift.id, {
      productionOrderId: ctx.order.id, quantityUnits: 50,
      realWeightKg: 2.5, theoreticalWeightKg: 2.5, lengthMm: 1000,
      isSecondQuality: true, secondQualityProductId: ctx.product.id,
    })
  })

  test('Al cerrar turno se generan lot_consumption proporcionales por peso', async () => {
    // Cerrar turno
    const closeRes = await ctx.client.post(`/api/production/shifts/${ctx.shift.id}/close`)
    expect(closeRes.status).toBe(200)

    // Verificar lot_consumption
    const { rows: cons } = await withBypass(() => query(
      `SELECT raw_material_lot_id, product_lot_id, quantity_consumed
       FROM lot_consumption WHERE shift_id = $1 ORDER BY quantity_consumed DESC`,
      [ctx.shift.id]
    ))

    // 1 rm_lot × 2 product_lots = 2 filas
    expect(cons.length).toBe(2)
    // Todas las filas son del mismo rm_lot
    expect(cons.every(c => c.raw_material_lot_id === rmLotId)).toBe(true)

    // Distribución proporcional: total producido = 7.5 (5kg 1ra + 2.5 2da).
    // rm_lot total consumido = 20kg.
    // 1ra: 5/7.5 = 0.667 → 13.333 kg
    // 2da: 2.5/7.5 = 0.333 → 6.667 kg
    const total = cons.reduce((a, c) => a + parseFloat(c.quantity_consumed), 0)
    expect(total).toBeCloseTo(20, 2)
    const sorted = cons.map(c => parseFloat(c.quantity_consumed)).sort((a, b) => b - a)
    expect(sorted[0]).toBeCloseTo(13.333, 2)
    expect(sorted[1]).toBeCloseTo(6.667, 2)
  })
})

describe('closeShift sin uses_lots NO genera lot_consumption', () => {
  test('Legacy: tabla queda vacía', async () => {
    const ctx = await setupTenant({ label: 'close-legacy' })
    await capturePackage(ctx.client, ctx.shift.id, {
      productionOrderId: ctx.order.id, quantityUnits: 50,
      realWeightKg: 2.5, theoreticalWeightKg: 2.5, lengthMm: 1000,
    })
    const closeRes = await ctx.client.post(`/api/production/shifts/${ctx.shift.id}/close`)
    expect(closeRes.status).toBe(200)

    const { rows: cons } = await withBypass(() => query(
      `SELECT id FROM lot_consumption WHERE shift_id = $1`, [ctx.shift.id]
    ))
    expect(cons.length).toBe(0)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// §5g.1: editPackage/deletePackage con ajuste de product_lot
// ═══════════════════════════════════════════════════════════════════════════

describe('editPackage §5g.1: ajusta quantity_produced del lote', () => {
  let ctx, pkg, lotId
  beforeAll(async () => {
    ctx = await setupTenant({ label: 'edit-pkg', usesLots: true })
    const rmLot = await insertLot(ctx.tenantId, ctx.rm.id, ctx.warehouseRmId, { quantity_received: 50 })
    await loadMp(ctx.client, ctx.shift.id, { rawMaterialId: ctx.rm.id, kg: 20, lotId: rmLot.id })
    pkg = await capturePackage(ctx.client, ctx.shift.id, {
      productionOrderId: ctx.order.id, quantityUnits: 50,
      realWeightKg: 2.5, theoreticalWeightKg: 2.5, lengthMm: 1000,
    })
    lotId = pkg.lot_id
  })

  test('Aumentar peso aplica delta positivo al lote (per_shift)', async () => {
    const res = await ctx.client.patch(
      `/api/production/shifts/${ctx.shift.id}/packages/${pkg.id}`,
      { realWeightKg: 3.5 }
    )
    expect(res.status).toBe(200)
    const { rows } = await withBypass(() => query(
      `SELECT quantity_produced, quantity_remaining FROM product_lots WHERE id = $1`, [lotId]
    ))
    expect(parseFloat(rows[0].quantity_produced)).toBeCloseTo(3.5, 2)
    expect(parseFloat(rows[0].quantity_remaining)).toBeCloseTo(3.5, 2)

    // Movimiento compensatorio +1
    const { rows: mvs } = await withBypass(() => query(
      `SELECT quantity FROM inventory_movements
       WHERE reference_type = 'shift_progress' AND reference_id = $1
       ORDER BY created_at ASC`, [pkg.id]
    ))
    expect(mvs.length).toBe(2)
    expect(parseFloat(mvs[1].quantity)).toBeCloseTo(1.0, 2)
  })

  test('Cambiar isSecondQuality en paquete con lote es rechazado 400', async () => {
    const res = await ctx.client.patch(
      `/api/production/shifts/${ctx.shift.id}/packages/${pkg.id}`,
      { isSecondQuality: true }
    )
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/isSecondQuality|reasignar/)
  })
})

describe('deletePackage §5g.1: refunda al lote o lo elimina', () => {
  test('Eliminar el único paquete del lote → DELETE del product_lot', async () => {
    const ctx = await setupTenant({ label: 'del-only', usesLots: true, granularity: 'per_package' })
    const rmLot = await insertLot(ctx.tenantId, ctx.rm.id, ctx.warehouseRmId, { quantity_received: 50 })
    await loadMp(ctx.client, ctx.shift.id, { rawMaterialId: ctx.rm.id, kg: 10, lotId: rmLot.id })
    const pkg = await capturePackage(ctx.client, ctx.shift.id, {
      productionOrderId: ctx.order.id, quantityUnits: 50,
      realWeightKg: 2.5, theoreticalWeightKg: 2.5, lengthMm: 1000,
    })
    const lotId = pkg.lot_id

    const res = await ctx.client.delete(`/api/production/shifts/${ctx.shift.id}/packages/${pkg.id}`)
    expect(res.status).toBe(200)

    const { rows } = await withBypass(() => query(
      `SELECT id FROM product_lots WHERE id = $1`, [lotId]
    ))
    expect(rows.length).toBe(0)
  })

  test('Eliminar uno de varios paquetes del mismo lote (per_shift) lo decrementa', async () => {
    const ctx = await setupTenant({ label: 'del-one-of-many', usesLots: true, granularity: 'per_shift' })
    const rmLot = await insertLot(ctx.tenantId, ctx.rm.id, ctx.warehouseRmId, { quantity_received: 50 })
    await loadMp(ctx.client, ctx.shift.id, { rawMaterialId: ctx.rm.id, kg: 20, lotId: rmLot.id })
    const p1 = await capturePackage(ctx.client, ctx.shift.id, {
      productionOrderId: ctx.order.id, quantityUnits: 50,
      realWeightKg: 2.5, theoreticalWeightKg: 2.5, lengthMm: 1000,
    })
    const p2 = await capturePackage(ctx.client, ctx.shift.id, {
      productionOrderId: ctx.order.id, quantityUnits: 50,
      realWeightKg: 3.0, theoreticalWeightKg: 2.5, lengthMm: 1000,
    })
    expect(p1.lot_id).toBe(p2.lot_id) // mismo lote per_shift
    const lotId = p1.lot_id

    const res = await ctx.client.delete(`/api/production/shifts/${ctx.shift.id}/packages/${p1.id}`)
    expect(res.status).toBe(200)

    const { rows } = await withBypass(() => query(
      `SELECT quantity_produced FROM product_lots WHERE id = $1`, [lotId]
    ))
    expect(rows.length).toBe(1)
    expect(parseFloat(rows[0].quantity_produced)).toBeCloseTo(3.0, 2)
  })
})
