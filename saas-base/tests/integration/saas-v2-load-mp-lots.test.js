'use strict'

/**
 * SaaS v2 — Tests del refactor §5f: loadMp con motor de lotes.
 *
 * Cubre:
 *  - Legacy intacto: si tenant_process_config.uses_lots=false, comportamiento idéntico
 *    (sin lot_id, sin inventory_movement, mismo response shape).
 *  - uses_lots=true con lotId manual: valida, lockea, decrementa quantity_remaining,
 *    crea movimiento con raw_material_lot_id, marca depleted si llega a 0.
 *  - uses_lots=true sin lotId: auto-selección via lotSelector (FIFO por defecto, FEFO
 *    si uses_fefo=true + uses_expiry=true).
 *  - Errores: lote inexistente, lote de otra MP, lote no-active, qty insuficiente,
 *    shortfall (sin lotes que cubran), multi-lot greedy (rechaza, exige cargar uno a la vez).
 *  - Guards en editMpLoad/deleteMpLoad: rechazan si lot_id != null (defer a 5f.1).
 *
 * Mantiene golden masters verdes (uses_lots=false es default).
 */

const { createTenant, loginAs, authedClient, cleanupTestTenants } = require('../helpers/factory')
const {
  createRawMaterial, createProduct, createOrder, releaseOrder,
  openShift, loadMp, seedRawMaterialStock,
} = require('../helpers/productionFactory')
const { pool, query, withBypass } = require('../../src/db')

afterAll(async () => {
  await cleanupTestTenants()
  await pool.end()
})

let counter = 0
const uniq = (s) => `${s}${(Date.now() % 100000)}_${counter++}`

async function setupTenant({ label, usesLots = false, usesExpiry = false, usesFefo = false, costMethod = 'weighted_avg' }) {
  const info = await createTenant({ label, planSlug: 'owner' })
  const sess = await loginAs({ slug: info.tenant.slug, email: info.email, password: info.password })
  const client = authedClient({ slug: info.tenant.slug, token: sess.token })
  const tenantId = info.tenant.id

  await withBypass(() => query(
    `UPDATE tenant_process_config
     SET uses_lots = $2, uses_expiry = $3, uses_fefo = $4, cost_method = $5
     WHERE tenant_id = $1`,
    [tenantId, usesLots, usesExpiry, usesFefo, costMethod]
  ))

  // MP
  const rm = await createRawMaterial(client, { name: uniq('MP'), costPerKg: 10 })
  // Producto
  const product = await createProduct(client, { sku: uniq('SKU'), name: 'Producto Test' })
  // Stock disponible (para release de orden sin override)
  const stock = await seedRawMaterialStock(tenantId, rm.id, 1000, { avgCost: 10 })

  // Warehouse del seed (lo necesitamos para crear raw_material_lots en el mismo warehouse)
  const { rows: whRows } = await withBypass(() => query(
    `SELECT id FROM warehouses WHERE tenant_id = $1 AND type = 'raw_material' AND is_active = true
     ORDER BY created_at LIMIT 1`, [tenantId]
  ))
  const warehouseId = whRows[0].id

  // Orden + release + turno
  const order = await createOrder(client, { productId: product.id, rawMaterialId: rm.id, quantityPackages: 5 })
  await releaseOrder(client, order.id)
  const shift = await openShift(client, {
    lineId: 1, shiftNumber: '1', operatorId: sess.user.id, supervisorId: sess.user.id,
  })

  return { info, client, tenantId, rm, product, order, shift, warehouseId, sess }
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
// Legacy: uses_lots=false → comportamiento idéntico al pre-refactor
// ═══════════════════════════════════════════════════════════════════════════

describe('loadMp legacy (uses_lots=false)', () => {
  let ctx
  beforeAll(async () => { ctx = await setupTenant({ label: 'load-legacy', usesLots: false }) })

  test('Inserta shift_mp_loads sin lot_id ni inventory_movement', async () => {
    const load = await loadMp(ctx.client, ctx.shift.id, {
      rawMaterialId: ctx.rm.id, kg: 50, notes: 'legacy load',
    })
    expect(load.lot_id).toBeNull()
    expect(parseFloat(load.kg)).toBe(50)

    // No debe haber inventory_movements para este shift_mp_load (referenciado por id).
    const { rows: mvs } = await withBypass(() => query(
      `SELECT id FROM inventory_movements
       WHERE tenant_id = $1 AND reference_type = 'shift_mp_load' AND reference_id = $2`,
      [ctx.tenantId, load.id]
    ))
    expect(mvs.length).toBe(0)

    // Y mp_real_kg del turno se actualizó.
    const { rows: shiftRows } = await withBypass(() => query(
      `SELECT mp_real_kg FROM production_shifts WHERE id = $1`, [ctx.shift.id]
    ))
    expect(parseFloat(shiftRows[0].mp_real_kg)).toBe(50)
  })

  test('Permite editar y eliminar carga sin lot_id (modo operador)', async () => {
    const load = await loadMp(ctx.client, ctx.shift.id, { rawMaterialId: ctx.rm.id, kg: 10 })

    const editRes = await ctx.client.patch(
      `/api/production/shifts/${ctx.shift.id}/mp-loads/${load.id}`,
      { kg: 15 }
    )
    expect(editRes.status).toBe(200)
    expect(parseFloat(editRes.body.kg)).toBe(15)

    const delRes = await ctx.client.delete(`/api/production/shifts/${ctx.shift.id}/mp-loads/${load.id}`)
    expect(delRes.status).toBe(200)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// uses_lots=true: selección manual (lotId pasado por el operador)
// ═══════════════════════════════════════════════════════════════════════════

describe('loadMp con lote manual (uses_lots=true)', () => {
  let ctx, lotA
  beforeAll(async () => {
    ctx = await setupTenant({ label: 'load-manual', usesLots: true })
    lotA = await insertLot(ctx.tenantId, ctx.rm.id, ctx.warehouseId, {
      lot_number: 'LOT-A', quantity_received: 200, quantity_remaining: 200,
    })
  })

  test('Popula shift_mp_loads.lot_id, decrementa quantity_remaining y crea movement', async () => {
    const load = await loadMp(ctx.client, ctx.shift.id, {
      rawMaterialId: ctx.rm.id, kg: 50, lotId: lotA.id,
    })
    expect(load.lot_id).toBe(lotA.id)

    // Lote decrementado: 200 - 50 = 150
    const { rows: lotRows } = await withBypass(() => query(
      `SELECT quantity_remaining, status FROM raw_material_lots WHERE id = $1`, [lotA.id]
    ))
    expect(parseFloat(lotRows[0].quantity_remaining)).toBe(150)
    expect(lotRows[0].status).toBe('active')

    // Movement creado con raw_material_lot_id set
    const { rows: mvs } = await withBypass(() => query(
      `SELECT * FROM inventory_movements
       WHERE tenant_id = $1 AND reference_type = 'shift_mp_load' AND reference_id = $2`,
      [ctx.tenantId, load.id]
    ))
    expect(mvs.length).toBe(1)
    expect(mvs[0].raw_material_lot_id).toBe(lotA.id)
    expect(mvs[0].product_lot_id).toBeNull()
    expect(mvs[0].movement_type).toBe('production_mp_consumption')
    expect(parseFloat(mvs[0].quantity)).toBe(-50)
    expect(mvs[0].item_type).toBe('raw_material')
  })

  test('Consumir el resto del lote lo marca como depleted', async () => {
    // Lote queda con 150 después del test previo; cargamos los 150 restantes
    await loadMp(ctx.client, ctx.shift.id, {
      rawMaterialId: ctx.rm.id, kg: 150, lotId: lotA.id,
    })
    const { rows } = await withBypass(() => query(
      `SELECT status, quantity_remaining FROM raw_material_lots WHERE id = $1`, [lotA.id]
    ))
    expect(rows[0].status).toBe('depleted')
    expect(parseFloat(rows[0].quantity_remaining)).toBe(0)
  })

  test('Rechaza lote inexistente con 404', async () => {
    const res = await ctx.client.post(`/api/production/shifts/${ctx.shift.id}/mp-loads`, {
      rawMaterialId: ctx.rm.id, kg: 1, lotId: '00000000-0000-0000-0000-000000000000',
    })
    expect(res.status).toBe(404)
  })

  test('Rechaza lote de otra MP con 400', async () => {
    const otherMp = await createRawMaterial(ctx.client, { name: uniq('OTRA-MP') })
    const otherLot = await insertLot(ctx.tenantId, otherMp.id, ctx.warehouseId, { quantity_received: 50 })
    const res = await ctx.client.post(`/api/production/shifts/${ctx.shift.id}/mp-loads`, {
      rawMaterialId: ctx.rm.id, kg: 10, lotId: otherLot.id,
    })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/no corresponde/)
  })

  test('Rechaza lote en cuarentena con 400', async () => {
    const qLot = await insertLot(ctx.tenantId, ctx.rm.id, ctx.warehouseId, {
      quantity_received: 80, status: 'quarantined', quarantine_reason: 'pendiente COA',
    })
    const res = await ctx.client.post(`/api/production/shifts/${ctx.shift.id}/mp-loads`, {
      rawMaterialId: ctx.rm.id, kg: 10, lotId: qLot.id,
    })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/quarantined|estado/)
  })

  test('Rechaza si kg excede saldo del lote', async () => {
    const smallLot = await insertLot(ctx.tenantId, ctx.rm.id, ctx.warehouseId, {
      quantity_received: 5, quantity_remaining: 5,
    })
    const res = await ctx.client.post(`/api/production/shifts/${ctx.shift.id}/mp-loads`, {
      rawMaterialId: ctx.rm.id, kg: 10, lotId: smallLot.id,
    })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/no alcanza|disponibles/)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// uses_lots=true: auto-selección via lotSelector
// ═══════════════════════════════════════════════════════════════════════════

describe('loadMp con auto-selección FIFO (uses_lots=true, uses_fefo=false)', () => {
  let ctx
  beforeAll(async () => {
    ctx = await setupTenant({ label: 'load-fifo', usesLots: true, costMethod: 'fifo' })
  })

  test('Selecciona el lote más viejo (received_at ASC) cuando no se pasa lotId', async () => {
    const olderLot = await insertLot(ctx.tenantId, ctx.rm.id, ctx.warehouseId, {
      lot_number: 'OLD', quantity_received: 100, received_at: '2024-01-01',
    })
    const newerLot = await insertLot(ctx.tenantId, ctx.rm.id, ctx.warehouseId, {
      lot_number: 'NEW', quantity_received: 100, received_at: '2025-01-01',
    })
    const load = await loadMp(ctx.client, ctx.shift.id, { rawMaterialId: ctx.rm.id, kg: 20 })
    expect(load.lot_id).toBe(olderLot.id)
    expect(load.lot_id).not.toBe(newerLot.id)
  })

  test('Falla con 409 si no hay lotes activos disponibles', async () => {
    // Otro tenant fresh, sin lotes
    const ctx2 = await setupTenant({ label: 'load-empty', usesLots: true, costMethod: 'fifo' })
    const res = await ctx2.client.post(`/api/production/shifts/${ctx2.shift.id}/mp-loads`, {
      rawMaterialId: ctx2.rm.id, kg: 10,
    })
    expect(res.status).toBe(409)
    expect(res.body.error).toMatch(/Sin lotes activos|disponibles/)
  })

  test('Falla con 409 cuando el plan greedy requiere multi-lote', async () => {
    const ctx2 = await setupTenant({ label: 'load-multi', usesLots: true, costMethod: 'fifo' })
    // 2 lotes de 30kg cada uno; pedimos 50kg → greedy necesita ambos
    await insertLot(ctx2.tenantId, ctx2.rm.id, ctx2.warehouseId, { quantity_received: 30, received_at: '2024-01-01' })
    await insertLot(ctx2.tenantId, ctx2.rm.id, ctx2.warehouseId, { quantity_received: 30, received_at: '2024-06-01' })
    const res = await ctx2.client.post(`/api/production/shifts/${ctx2.shift.id}/mp-loads`, {
      rawMaterialId: ctx2.rm.id, kg: 50,
    })
    expect(res.status).toBe(409)
    expect(res.body.error).toMatch(/combinar|fuentes/)
  })

  test('Falla con 409 cuando hay shortfall (kg pedido > total disponible)', async () => {
    const ctx2 = await setupTenant({ label: 'load-shortfall', usesLots: true, costMethod: 'fifo' })
    await insertLot(ctx2.tenantId, ctx2.rm.id, ctx2.warehouseId, { quantity_received: 10 })
    const res = await ctx2.client.post(`/api/production/shifts/${ctx2.shift.id}/mp-loads`, {
      rawMaterialId: ctx2.rm.id, kg: 50,
    })
    expect(res.status).toBe(409)
    expect(res.body.error).toMatch(/cubren solo|Falta/)
  })
})

describe('loadMp con auto-selección FEFO (uses_lots=true, uses_fefo=true, uses_expiry=true)', () => {
  let ctx
  beforeAll(async () => {
    ctx = await setupTenant({
      label: 'load-fefo', usesLots: true, usesExpiry: true, usesFefo: true, costMethod: 'fifo',
    })
  })

  test('Selecciona el lote con expiry más cercano (NULLS LAST)', async () => {
    const farExpiry = await insertLot(ctx.tenantId, ctx.rm.id, ctx.warehouseId, {
      lot_number: 'FAR', quantity_received: 50,
      manufacture_date: '2026-01-01', expiry_date: '2027-12-31',
    })
    const nearExpiry = await insertLot(ctx.tenantId, ctx.rm.id, ctx.warehouseId, {
      lot_number: 'NEAR', quantity_received: 50,
      manufacture_date: '2026-01-01', expiry_date: '2026-12-31',
    })
    const load = await loadMp(ctx.client, ctx.shift.id, { rawMaterialId: ctx.rm.id, kg: 10 })
    expect(load.lot_id).toBe(nearExpiry.id)
    expect(load.lot_id).not.toBe(farExpiry.id)
  })

  test('Excluye lotes ya caducados (expiry_date <= NOW)', async () => {
    const ctx2 = await setupTenant({
      label: 'load-fefo-skip', usesLots: true, usesExpiry: true, usesFefo: true, costMethod: 'fifo',
    })
    await insertLot(ctx2.tenantId, ctx2.rm.id, ctx2.warehouseId, {
      lot_number: 'EXPIRED', quantity_received: 100,
      manufacture_date: '2020-01-01', expiry_date: '2020-12-31',
    })
    const fresh = await insertLot(ctx2.tenantId, ctx2.rm.id, ctx2.warehouseId, {
      lot_number: 'FRESH', quantity_received: 100,
      manufacture_date: '2026-01-01', expiry_date: '2027-12-31',
    })
    const load = await loadMp(ctx2.client, ctx2.shift.id, { rawMaterialId: ctx2.rm.id, kg: 20 })
    expect(load.lot_id).toBe(fresh.id)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// §5f.1: edit/delete con reversión del consumo de lote
// ═══════════════════════════════════════════════════════════════════════════

describe('editMpLoad §5f.1: ajusta quantity_remaining del lote', () => {
  let ctx, lot, load
  beforeAll(async () => {
    ctx = await setupTenant({ label: 'edit-up', usesLots: true })
    lot = await insertLot(ctx.tenantId, ctx.rm.id, ctx.warehouseId, { quantity_received: 100 })
    load = await loadMp(ctx.client, ctx.shift.id, {
      rawMaterialId: ctx.rm.id, kg: 20, lotId: lot.id,
    })
    // Lote ahora con 80
  })

  test('Subir kg consume más del lote (delta > 0)', async () => {
    const res = await ctx.client.patch(
      `/api/production/shifts/${ctx.shift.id}/mp-loads/${load.id}`,
      { kg: 30 }
    )
    expect(res.status).toBe(200)
    expect(parseFloat(res.body.kg)).toBe(30)

    const { rows } = await withBypass(() => query(
      `SELECT quantity_remaining, status FROM raw_material_lots WHERE id = $1`, [lot.id]
    ))
    expect(parseFloat(rows[0].quantity_remaining)).toBe(70)
    expect(rows[0].status).toBe('active')

    // Movimiento compensatorio adicional (negativo)
    const { rows: mvs } = await withBypass(() => query(
      `SELECT quantity FROM inventory_movements
       WHERE reference_type = 'shift_mp_load' AND reference_id = $1
       ORDER BY created_at ASC`, [load.id]
    ))
    expect(mvs.length).toBe(2)
    expect(parseFloat(mvs[0].quantity)).toBe(-20)
    expect(parseFloat(mvs[1].quantity)).toBe(-10)
  })

  test('Bajar kg refunda al lote (delta < 0)', async () => {
    const res = await ctx.client.patch(
      `/api/production/shifts/${ctx.shift.id}/mp-loads/${load.id}`,
      { kg: 5 }
    )
    expect(res.status).toBe(200)

    const { rows } = await withBypass(() => query(
      `SELECT quantity_remaining FROM raw_material_lots WHERE id = $1`, [lot.id]
    ))
    // 70 (estado tras el test previo) + 25 (refund de 30→5) = 95
    expect(parseFloat(rows[0].quantity_remaining)).toBe(95)
  })

  test('Rechaza si la subida excede el saldo disponible', async () => {
    const res = await ctx.client.patch(
      `/api/production/shifts/${ctx.shift.id}/mp-loads/${load.id}`,
      { kg: 200 } // load actual 5kg, intenta subir a 200 → delta 195, lote tiene 95
    )
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/no alcanza/)
  })
})

describe('editMpLoad §5f.1: reactivación depleted→active', () => {
  test('Bajar kg de una carga que dejó el lote depleted lo reactiva', async () => {
    const ctx = await setupTenant({ label: 'reactivate', usesLots: true })
    const lot = await insertLot(ctx.tenantId, ctx.rm.id, ctx.warehouseId, { quantity_received: 50 })
    // Cargar exactamente los 50kg → lote queda depleted
    const load = await loadMp(ctx.client, ctx.shift.id, {
      rawMaterialId: ctx.rm.id, kg: 50, lotId: lot.id,
    })
    let { rows } = await withBypass(() => query(
      `SELECT status, quantity_remaining FROM raw_material_lots WHERE id = $1`, [lot.id]
    ))
    expect(rows[0].status).toBe('depleted')

    // Bajar a 30 → refund 20 → lote vuelve a active con 20 disponibles
    const res = await ctx.client.patch(
      `/api/production/shifts/${ctx.shift.id}/mp-loads/${load.id}`,
      { kg: 30 }
    )
    expect(res.status).toBe(200)

    ;({ rows } = await withBypass(() => query(
      `SELECT status, quantity_remaining FROM raw_material_lots WHERE id = $1`, [lot.id]
    )))
    expect(rows[0].status).toBe('active')
    expect(parseFloat(rows[0].quantity_remaining)).toBe(20)
  })
})

describe('deleteMpLoad §5f.1: refunda toda la kg', () => {
  test('Refund completo + reactivación depleted→active', async () => {
    const ctx = await setupTenant({ label: 'del-refund', usesLots: true })
    const lot = await insertLot(ctx.tenantId, ctx.rm.id, ctx.warehouseId, { quantity_received: 40 })
    const load = await loadMp(ctx.client, ctx.shift.id, {
      rawMaterialId: ctx.rm.id, kg: 40, lotId: lot.id,
    })
    let { rows } = await withBypass(() => query(
      `SELECT status FROM raw_material_lots WHERE id = $1`, [lot.id]
    ))
    expect(rows[0].status).toBe('depleted')

    const res = await ctx.client.delete(`/api/production/shifts/${ctx.shift.id}/mp-loads/${load.id}`)
    expect(res.status).toBe(200)

    ;({ rows } = await withBypass(() => query(
      `SELECT status, quantity_remaining FROM raw_material_lots WHERE id = $1`, [lot.id]
    )))
    expect(rows[0].status).toBe('active')
    expect(parseFloat(rows[0].quantity_remaining)).toBe(40)

    // 2 movimientos: el de loadMp (-40) y el compensatorio del delete (+40)
    const { rows: mvs } = await withBypass(() => query(
      `SELECT quantity FROM inventory_movements
       WHERE reference_type = 'shift_mp_load' AND reference_id = $1
       ORDER BY created_at ASC`, [load.id]
    ))
    expect(mvs.length).toBe(2)
    expect(parseFloat(mvs[0].quantity)).toBe(-40)
    expect(parseFloat(mvs[1].quantity)).toBe(40)
  })
})
