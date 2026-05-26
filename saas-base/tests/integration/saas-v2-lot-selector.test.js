'use strict'

/**
 * SaaS v2 — Tests del lotSelector (§4.6).
 *
 * Cubre:
 *  - weighted_avg / sin uses_lots → no_lot
 *  - FIFO con varios lotes (orden por received_at)
 *  - FEFO con expiry_date (orden por expiry, desempate por received_at)
 *  - Excluir lotes no-active (quarantined, recalled, expired, depleted)
 *  - Excluir quantity_remaining = 0
 *  - Excluir lotes ya caducados (FEFO)
 *  - selectLotsForQuantity greedy + shortfall
 *  - Filtro por warehouse_id opcional
 */

const { createTenant, cleanupTestTenants } = require('../helpers/factory')
const { pool, query, withBypass } = require('../../src/db')
const {
  listAvailableLots,
  selectLotsForQuantity,
  SUPPORTED_COST_METHODS,
} = require('../../src/modules/production/lotSelector')

afterAll(async () => {
  await cleanupTestTenants()
  await pool.end()
})

let counter = 0
const uniq = (s) => `${s}${(Date.now() % 100000)}_${counter++}`

async function setup(label) {
  const info = await createTenant({ label, planSlug: 'owner' })
  const tenantId = info.tenant.id

  const { rows: rmRows } = await withBypass(() => query(
    `INSERT INTO raw_materials (tenant_id, name, resin_type, item_kind)
     VALUES ($1, $2, 'PE', 'raw_material') RETURNING id`,
    [tenantId, uniq('MP')]
  ))
  const rawMaterialId = rmRows[0].id

  const { rows: wRows1 } = await withBypass(() => query(
    `INSERT INTO warehouses (tenant_id, name, type, is_active)
     VALUES ($1, $2, 'raw_material', true) RETURNING id`,
    [tenantId, uniq('WHA')]
  ))
  const { rows: wRows2 } = await withBypass(() => query(
    `INSERT INTO warehouses (tenant_id, name, type, is_active)
     VALUES ($1, $2, 'raw_material', true) RETURNING id`,
    [tenantId, uniq('WHB')]
  ))

  return { tenantId, rawMaterialId, warehouseAId: wRows1[0].id, warehouseBId: wRows2[0].id }
}

async function insertLot(ctx, overrides = {}) {
  const fields = {
    tenant_id:          ctx.tenantId,
    raw_material_id:    ctx.rawMaterialId,
    lot_number:         uniq('L'),
    warehouse_id:       ctx.warehouseAId,
    quantity_received:  100,
    quantity_remaining: 100,
    status:             'active',
    received_at:        new Date(),
    ...overrides,
  }
  const cols = Object.keys(fields)
  const vals = Object.values(fields)
  const params = vals.map((_, i) => `$${i + 1}`)
  const { rows } = await withBypass(() => query(
    `INSERT INTO raw_material_lots (${cols.join(',')}) VALUES (${params.join(',')}) RETURNING *`,
    vals
  ))
  return rows[0]
}

// ─── weighted_avg + sin uses_lots ─────────────────────────────────────────

describe('SaaS v2: lotSelector — weighted_avg / sin uses_lots', () => {
  let ctx
  beforeAll(async () => { ctx = await setup('ls-avg') })

  test('weighted_avg devuelve [] (no selecciona lote)', async () => {
    await insertLot(ctx)
    const result = await listAvailableLots({
      tenantId: ctx.tenantId, rawMaterialId: ctx.rawMaterialId,
      costMethod: 'weighted_avg',
    })
    expect(result).toEqual([])
  })

  test('selectLotsForQuantity weighted_avg → mode=no_lot, plan=[], shortfall=qty', async () => {
    const result = await selectLotsForQuantity({
      tenantId: ctx.tenantId, rawMaterialId: ctx.rawMaterialId,
      costMethod: 'weighted_avg', qty: 50,
    })
    expect(result.mode).toBe('no_lot')
    expect(result.plan).toEqual([])
    expect(result.totalAllocated).toBe(0)
    expect(result.shortfall).toBe(50)
  })

  test('fifo con usesLots=false → no_lot', async () => {
    const result = await selectLotsForQuantity({
      tenantId: ctx.tenantId, rawMaterialId: ctx.rawMaterialId,
      costMethod: 'fifo', usesLots: false, qty: 10,
    })
    expect(result.mode).toBe('no_lot')
  })

  test('standard también devuelve no_lot', async () => {
    const result = await selectLotsForQuantity({
      tenantId: ctx.tenantId, rawMaterialId: ctx.rawMaterialId,
      costMethod: 'standard', qty: 5,
    })
    expect(result.mode).toBe('no_lot')
  })
})

// ─── FIFO ─────────────────────────────────────────────────────────────────

describe('SaaS v2: lotSelector — FIFO', () => {
  let ctx, lotA, lotB, lotC

  beforeAll(async () => {
    ctx = await setup('ls-fifo')
    // Insertar lotes en orden cronológico (más viejo → más nuevo)
    lotA = await insertLot(ctx, { received_at: new Date('2026-01-01'), quantity_remaining: 30 })
    lotB = await insertLot(ctx, { received_at: new Date('2026-02-01'), quantity_remaining: 50 })
    lotC = await insertLot(ctx, { received_at: new Date('2026-03-01'), quantity_remaining: 20 })
  })

  test('listAvailableLots devuelve los 3 ordenados por received_at ASC', async () => {
    const result = await listAvailableLots({
      tenantId: ctx.tenantId, rawMaterialId: ctx.rawMaterialId,
      costMethod: 'fifo',
    })
    expect(result.map(l => l.id)).toEqual([lotA.id, lotB.id, lotC.id])
  })

  test('selectLotsForQuantity qty=20 toma solo de A', async () => {
    const result = await selectLotsForQuantity({
      tenantId: ctx.tenantId, rawMaterialId: ctx.rawMaterialId,
      costMethod: 'fifo', qty: 20,
    })
    expect(result.mode).toBe('fifo')
    expect(result.plan).toHaveLength(1)
    expect(result.plan[0].lotId).toBe(lotA.id)
    expect(result.plan[0].qtyToTake).toBe(20)
    expect(result.totalAllocated).toBe(20)
    expect(result.shortfall).toBe(0)
  })

  test('qty=50 consume todo A (30) + 20 de B', async () => {
    const result = await selectLotsForQuantity({
      tenantId: ctx.tenantId, rawMaterialId: ctx.rawMaterialId,
      costMethod: 'fifo', qty: 50,
    })
    expect(result.plan).toHaveLength(2)
    expect(result.plan[0]).toMatchObject({ lotId: lotA.id, qtyToTake: 30 })
    expect(result.plan[1]).toMatchObject({ lotId: lotB.id, qtyToTake: 20 })
    expect(result.shortfall).toBe(0)
  })

  test('qty=200 toma todo lo disponible (100) y reporta shortfall=100', async () => {
    const result = await selectLotsForQuantity({
      tenantId: ctx.tenantId, rawMaterialId: ctx.rawMaterialId,
      costMethod: 'fifo', qty: 200,
    })
    expect(result.plan).toHaveLength(3)
    expect(result.totalAllocated).toBe(100)
    expect(result.shortfall).toBe(100)
  })
})

// ─── FEFO ─────────────────────────────────────────────────────────────────

describe('SaaS v2: lotSelector — FEFO', () => {
  let ctx, lotEarlyExpiry, lotLateExpiry, lotNoExpiry

  beforeAll(async () => {
    ctx = await setup('ls-fefo')
    // Lote más viejo pero expira más tarde
    lotLateExpiry = await insertLot(ctx, {
      received_at: new Date('2026-01-01'),
      expiry_date: '2027-12-31',
      quantity_remaining: 40,
    })
    // Lote más nuevo pero expira pronto
    lotEarlyExpiry = await insertLot(ctx, {
      received_at: new Date('2026-03-01'),
      expiry_date: '2026-06-30',
      quantity_remaining: 30,
    })
    // Lote sin expiry (queda al final por NULLS LAST)
    lotNoExpiry = await insertLot(ctx, {
      received_at: new Date('2026-02-01'),
      expiry_date: null,
      quantity_remaining: 50,
    })
  })

  test('FEFO ordena por expiry ASC (NULLS LAST), desempate por received_at', async () => {
    const result = await listAvailableLots({
      tenantId: ctx.tenantId, rawMaterialId: ctx.rawMaterialId,
      costMethod: 'fefo', usesExpiry: true,
    })
    expect(result.map(l => l.id)).toEqual([lotEarlyExpiry.id, lotLateExpiry.id, lotNoExpiry.id])
  })

  test('FEFO selectLotsForQuantity prefiere el que expira pronto', async () => {
    const result = await selectLotsForQuantity({
      tenantId: ctx.tenantId, rawMaterialId: ctx.rawMaterialId,
      costMethod: 'fefo', usesExpiry: true, qty: 15,
    })
    expect(result.mode).toBe('fefo')
    expect(result.plan[0].lotId).toBe(lotEarlyExpiry.id)
  })

  test('FEFO excluye lotes ya caducados', async () => {
    const ctx2 = await setup('ls-fefo-exp')
    const expired = await insertLot(ctx2, {
      expiry_date: '2020-01-01',  // muy en el pasado
      quantity_remaining: 100,
    })
    const valid = await insertLot(ctx2, {
      expiry_date: '2099-01-01',
      quantity_remaining: 100,
    })
    const result = await listAvailableLots({
      tenantId: ctx2.tenantId, rawMaterialId: ctx2.rawMaterialId,
      costMethod: 'fefo', usesExpiry: true,
    })
    expect(result.map(l => l.id)).toEqual([valid.id])
    // expired no aparece porque la WHERE lo filtra
    void expired
  })
})

// ─── Exclusión por status y quantity_remaining ────────────────────────────

describe('SaaS v2: lotSelector — exclusiones', () => {
  let ctx

  beforeAll(async () => { ctx = await setup('ls-excl') })

  test('Excluye lotes con status != active', async () => {
    const active     = await insertLot(ctx, { received_at: new Date('2026-01-01'), quantity_remaining: 10 })
    const quarantined= await insertLot(ctx, { received_at: new Date('2026-01-02'), quantity_remaining: 10, status: 'quarantined' })
    const recalled   = await insertLot(ctx, { received_at: new Date('2026-01-03'), quantity_remaining: 10, status: 'recalled' })
    const expired    = await insertLot(ctx, { received_at: new Date('2026-01-04'), quantity_remaining: 10, status: 'expired' })

    const result = await listAvailableLots({
      tenantId: ctx.tenantId, rawMaterialId: ctx.rawMaterialId,
      costMethod: 'fifo',
    })
    expect(result.map(l => l.id)).toEqual([active.id])
    void quarantined; void recalled; void expired
  })

  test('Excluye lotes con quantity_remaining = 0 (depleted)', async () => {
    const ctx2 = await setup('ls-dep')
    const depleted = await insertLot(ctx2, {
      received_at: new Date('2026-01-01'),
      quantity_remaining: 0, quantity_received: 100,
      status: 'depleted',
    })
    const withStock = await insertLot(ctx2, {
      received_at: new Date('2026-01-02'),
      quantity_remaining: 50,
    })
    const result = await listAvailableLots({
      tenantId: ctx2.tenantId, rawMaterialId: ctx2.rawMaterialId,
      costMethod: 'fifo',
    })
    expect(result.map(l => l.id)).toEqual([withStock.id])
    void depleted
  })
})

// ─── Filtro por warehouse ─────────────────────────────────────────────────

describe('SaaS v2: lotSelector — filtro por warehouse', () => {
  let ctx, lotA, lotB

  beforeAll(async () => {
    ctx = await setup('ls-wh')
    lotA = await insertLot(ctx, { warehouse_id: ctx.warehouseAId, received_at: new Date('2026-01-01'), quantity_remaining: 30 })
    lotB = await insertLot(ctx, { warehouse_id: ctx.warehouseBId, received_at: new Date('2026-01-02'), quantity_remaining: 30 })
  })

  test('Sin warehouseId devuelve ambos', async () => {
    const result = await listAvailableLots({
      tenantId: ctx.tenantId, rawMaterialId: ctx.rawMaterialId,
      costMethod: 'fifo',
    })
    expect(result).toHaveLength(2)
  })

  test('Con warehouseAId solo devuelve A', async () => {
    const result = await listAvailableLots({
      tenantId: ctx.tenantId, rawMaterialId: ctx.rawMaterialId,
      warehouseId: ctx.warehouseAId, costMethod: 'fifo',
    })
    expect(result.map(l => l.id)).toEqual([lotA.id])
  })

  test('Con warehouseBId solo devuelve B', async () => {
    const result = await listAvailableLots({
      tenantId: ctx.tenantId, rawMaterialId: ctx.rawMaterialId,
      warehouseId: ctx.warehouseBId, costMethod: 'fifo',
    })
    expect(result.map(l => l.id)).toEqual([lotB.id])
  })
})

// ─── Validaciones / API ───────────────────────────────────────────────────

describe('SaaS v2: lotSelector — validaciones y exports', () => {
  test('costMethod inválido → throws', async () => {
    await expect(listAvailableLots({
      tenantId: '00000000-0000-0000-0000-000000000000',
      rawMaterialId: '00000000-0000-0000-0000-000000000000',
      costMethod: 'magic',
    })).rejects.toThrow(/costMethod/)
  })

  test('Falta tenantId o rawMaterialId → throws', async () => {
    await expect(listAvailableLots({
      rawMaterialId: '00000000-0000-0000-0000-000000000000',
      costMethod: 'fifo',
    })).rejects.toThrow(/tenantId/)
  })

  test('selectLotsForQuantity rechaza qty <= 0', async () => {
    await expect(selectLotsForQuantity({
      tenantId: '00000000-0000-0000-0000-000000000000',
      rawMaterialId: '00000000-0000-0000-0000-000000000000',
      costMethod: 'fifo', qty: 0,
    })).rejects.toThrow(/qty/)
    await expect(selectLotsForQuantity({
      tenantId: '00000000-0000-0000-0000-000000000000',
      rawMaterialId: '00000000-0000-0000-0000-000000000000',
      costMethod: 'fifo', qty: -5,
    })).rejects.toThrow(/qty/)
  })

  test('SUPPORTED_COST_METHODS lista los 4 modos', () => {
    expect(SUPPORTED_COST_METHODS).toEqual(['weighted_avg', 'fifo', 'fefo', 'standard'])
  })
})
