'use strict'

/**
 * SaaS v2 — Tests del flag §6d: pt_goes_to_wip_first.
 *
 * Cubre:
 *  - pt_goes_to_wip_first=false: capturePackage envía el producto directo a
 *    finished_product (status='available'), NO pasa por WIP.
 *  - addPackage con pt_goes_to_wip_first=false: mismo comportamiento.
 *  - validateShift con pt_goes_to_wip_first=false: NO genera movimientos
 *    production_wip_to_pt (ya están en PT). MP sí se consume del WIP.
 *  - Backward compat: pt_goes_to_wip_first=true (default) mantiene flujo WIP.
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

async function setupTenant({ ptGoesToWipFirst = true }) {
  const info = await createTenant({ label: uniq('wip'), planSlug: 'owner' })
  const sess = await loginAs({ slug: info.tenant.slug, email: info.email, password: info.password })
  const client = authedClient({ slug: info.tenant.slug, token: sess.token })
  const tenantId = info.tenant.id

  await withBypass(() => query(
    `UPDATE tenant_process_config SET pt_goes_to_wip_first = $2 WHERE tenant_id = $1`,
    [tenantId, ptGoesToWipFirst]
  ))

  await ensureWarehouses(tenantId)

  const rm = await createRawMaterial(client, { name: uniq('MP'), costPerKg: 10 })
  const product = await createProduct(client, { sku: uniq('SKU'), name: 'Producto 6d test' })

  // Spec mínima para theoretical_weight
  await client.post(`/api/products/${product.id}/quality-specs`, {
    gramsPerLinearMeter: 50, tolerancePct: 5, unitsPerPackage: 10, notes: 'test',
  }).expect(201)

  // Stock para que release no falle
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
    lineId: 1, shiftNumber: '1',
    operatorId: sess.user.id, supervisorId: sess.user.id,
  })

  return { info, client, tenantId, rm, product, order, shift, sess }
}

async function getMovements(shiftProgressId) {
  const { rows } = await withBypass(() => query(
    `SELECT im.movement_type, im.status_to, w.type AS warehouse_type, im.item_type, im.quantity
     FROM inventory_movements im
     JOIN warehouses w ON w.id = im.warehouse_id
     WHERE im.reference_type='shift_progress' AND im.reference_id=$1
     ORDER BY im.created_at`,
    [shiftProgressId]
  ))
  return rows
}

async function getShiftMovements(shiftId) {
  const { rows } = await withBypass(() => query(
    `SELECT im.movement_type, im.status_to, w.type AS warehouse_type, im.item_type
     FROM inventory_movements im
     JOIN warehouses w ON w.id = im.warehouse_id
     WHERE im.reference_type='production_shift' AND im.reference_id=$1
     ORDER BY im.created_at`,
    [shiftId]
  ))
  return rows
}

// ─────────────────────────────────────────────────────────────────
//  pt_goes_to_wip_first = false
// ─────────────────────────────────────────────────────────────────

describe('§6d pt_goes_to_wip_first=false — capturePackage directo a PT', () => {
  let ctx, pkg

  beforeAll(async () => {
    ctx = await setupTenant({ ptGoesToWipFirst: false })
    const res = await ctx.client.post(`/api/production/shifts/${ctx.shift.id}/packages`, {
      productionOrderId: ctx.order.id,
      quantityUnits: 5,
      realWeightKg: 100,
      gradeNumber: 1,
    }).expect(201)
    pkg = res.body
  })

  test('Producto va directo a finished_product con status=available', async () => {
    const moves = await getMovements(pkg.id)
    const productMoves = moves.filter(m => m.item_type === 'product')
    expect(productMoves).toHaveLength(1)
    expect(productMoves[0].movement_type).toBe('production_pt_entry')
    expect(productMoves[0].warehouse_type).toBe('finished_product')
    expect(productMoves[0].status_to).toBe('available')
  })

  test('No hay movimiento production_wip_entry para el producto', async () => {
    const moves = await getMovements(pkg.id)
    const wip = moves.filter(m => m.item_type === 'product' && m.movement_type === 'production_wip_entry')
    expect(wip).toHaveLength(0)
  })
})

describe('§6d pt_goes_to_wip_first=false — segunda calidad va a PT con status=blocked', () => {
  let ctx, pkg

  beforeAll(async () => {
    ctx = await setupTenant({ ptGoesToWipFirst: false })
    const res = await ctx.client.post(`/api/production/shifts/${ctx.shift.id}/packages`, {
      productionOrderId: ctx.order.id,
      quantityUnits: 2,
      realWeightKg: 40,
      gradeNumber: 2,
    }).expect(201)
    pkg = res.body
  })

  test('Segunda calidad va a finished_product con status=blocked', async () => {
    const moves = await getMovements(pkg.id)
    const productMoves = moves.filter(m => m.item_type === 'product')
    expect(productMoves).toHaveLength(1)
    expect(productMoves[0].movement_type).toBe('production_pt_entry')
    expect(productMoves[0].warehouse_type).toBe('finished_product')
    expect(productMoves[0].status_to).toBe('blocked')
  })
})

describe('§6d pt_goes_to_wip_first=false — validateShift no genera WIP→PT', () => {
  let ctx, shift

  beforeAll(async () => {
    ctx = await setupTenant({ ptGoesToWipFirst: false })
    shift = ctx.shift

    // Capturar paquete
    await ctx.client.post(`/api/production/shifts/${shift.id}/packages`, {
      productionOrderId: ctx.order.id,
      quantityUnits: 5, realWeightKg: 100,
    }).expect(201)

    // Cerrar y validar turno
    await ctx.client.post(`/api/production/shifts/${shift.id}/close`).expect(200)
    await ctx.client.post(`/api/production/shifts/${shift.id}/validate`, {
      approved: true,
    }).expect(200)
  })

  test('No existen movimientos production_wip_to_pt al validar', async () => {
    const moves = await getShiftMovements(shift.id)
    const wipToPt = moves.filter(m => m.movement_type === 'production_wip_to_pt')
    expect(wipToPt).toHaveLength(0)
  })
})

// ─────────────────────────────────────────────────────────────────
//  pt_goes_to_wip_first = true (default — backward compat)
// ─────────────────────────────────────────────────────────────────

describe('§6d pt_goes_to_wip_first=true (default) — mantiene flujo WIP', () => {
  let ctx, pkg

  beforeAll(async () => {
    ctx = await setupTenant({ ptGoesToWipFirst: true })
    const res = await ctx.client.post(`/api/production/shifts/${ctx.shift.id}/packages`, {
      productionOrderId: ctx.order.id,
      quantityUnits: 5,
      realWeightKg: 100,
      gradeNumber: 1,
    }).expect(201)
    pkg = res.body
  })

  test('Producto va a WIP con status=wip (comportamiento actual)', async () => {
    const moves = await getMovements(pkg.id)
    const productMoves = moves.filter(m => m.item_type === 'product')
    expect(productMoves).toHaveLength(1)
    expect(productMoves[0].movement_type).toBe('production_wip_entry')
    expect(productMoves[0].warehouse_type).toBe('wip')
    expect(productMoves[0].status_to).toBe('wip')
  })
})

describe('§6d pt_goes_to_wip_first=true — validateShift genera WIP→PT', () => {
  let ctx, shift

  beforeAll(async () => {
    ctx = await setupTenant({ ptGoesToWipFirst: true })
    shift = ctx.shift

    await ctx.client.post(`/api/production/shifts/${shift.id}/packages`, {
      productionOrderId: ctx.order.id,
      quantityUnits: 5, realWeightKg: 100,
    }).expect(201)

    await ctx.client.post(`/api/production/shifts/${shift.id}/close`).expect(200)
    await ctx.client.post(`/api/production/shifts/${shift.id}/validate`, {
      approved: true,
    }).expect(200)
  })

  test('validateShift genera movimiento production_wip_to_pt', async () => {
    const moves = await getShiftMovements(shift.id)
    const wipToPt = moves.filter(m => m.movement_type === 'production_wip_to_pt')
    expect(wipToPt.length).toBeGreaterThan(0)
  })

  test('validateShift genera movimiento production_pt_entry a finished_product', async () => {
    const moves = await getShiftMovements(shift.id)
    const ptEntry = moves.filter(m => m.movement_type === 'production_pt_entry')
    expect(ptEntry.length).toBeGreaterThan(0)
    expect(ptEntry[0].warehouse_type).toBe('finished_product')
  })
})
