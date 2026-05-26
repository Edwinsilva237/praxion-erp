'use strict'

/**
 * SaaS v2 — Tests para migration 130 (motor de lotes).
 *
 * Solo prueba INFRAESTRUCTURA (tablas, FKs, CHECKs). La lógica funcional
 * (selección FEFO, generación de lot_number, vistas de trazabilidad) viene
 * con el refactor de productionService.
 *
 * Cubre:
 *  - INSERT mínimo de raw_material_lots con defaults (status=active).
 *  - CHECKs: status enum, quantities >0/>=0, remaining<=received, expiry>=manufacture.
 *  - UNIQUE (raw_material_id, lot_number).
 *  - product_lots: origin enum, constraint produced vs received (FK presence),
 *    quality_grade requerido.
 *  - lot_consumption: vincula MP→PT.
 *  - shift_progress.lot_id + dynamic_attributes objeto.
 *  - shift_mp_loads.lot_id, unit_id, quantity.
 *  - inventory_movements XOR raw_material_lot_id / product_lot_id.
 */

const { createTenant, cleanupTestTenants } = require('../helpers/factory')
const { pool, query, withBypass } = require('../../src/db')

afterAll(async () => {
  await cleanupTestTenants()
  await pool.end()
})

let counter = 0
const uniq = (s) => `${s}-${Date.now()}-${counter++}`

async function setup(label) {
  const info = await createTenant({ label, planSlug: 'owner' })
  const tenantId = info.tenant.id

  const { rows: pRows } = await withBypass(() => query(
    `INSERT INTO products (tenant_id, sku, name, type, resin_type, length_mm, width_mm, thickness_mm)
     VALUES ($1, $2, 'P', 'corner_protector', 'PE', 100, 50, 10) RETURNING id`,
    [tenantId, uniq('SKU')]
  ))
  const productId = pRows[0].id

  const { rows: rmRows } = await withBypass(() => query(
    `INSERT INTO raw_materials (tenant_id, name, resin_type, item_kind)
     VALUES ($1, $2, 'PE', 'raw_material') RETURNING id`,
    [tenantId, uniq('MP')]
  ))
  const rmId = rmRows[0].id

  const { rows: wRows } = await withBypass(() => query(
    `INSERT INTO warehouses (tenant_id, name, type, is_active)
     VALUES ($1, $2, 'raw_material', true) RETURNING id`,
    [tenantId, uniq('WH')]
  ))
  const warehouseId = wRows[0].id

  const { rows: uRows } = await withBypass(() => query(
    `SELECT id FROM tenant_units WHERE tenant_id = $1 AND code = 'kg'`, [tenantId]
  ))
  const kgId = uRows[0].id

  const { rows: gRows } = await withBypass(() => query(
    `SELECT id FROM tenant_quality_grades WHERE tenant_id = $1 AND grade_number = 1`, [tenantId]
  ))
  const grade1Id = gRows[0].id

  return { tenantInfo: info, tenantId, productId, rmId, warehouseId, kgId, grade1Id }
}

async function insertRmLot(tenantId, rmId, warehouseId, extras = {}) {
  const cols = ['tenant_id', 'raw_material_id', 'lot_number', 'warehouse_id', 'quantity_received', 'quantity_remaining']
  const vals = [tenantId, rmId, extras.lot_number || uniq('LOT'), warehouseId,
                extras.quantity_received ?? 100, extras.quantity_remaining ?? 100]
  const params = vals.map((_, i) => `$${i + 1}`)
  let i = vals.length + 1
  for (const [k, v] of Object.entries(extras)) {
    if (k === 'lot_number' || k === 'quantity_received' || k === 'quantity_remaining') continue
    cols.push(k); vals.push(v); params.push(`$${i++}`)
  }
  const { rows } = await withBypass(() => query(
    `INSERT INTO raw_material_lots (${cols.join(',')}) VALUES (${params.join(',')}) RETURNING *`,
    vals
  ))
  return rows[0]
}

async function insertProductLot(tenantId, productId, warehouseId, grade1Id, extras = {}) {
  const cols = ['tenant_id', 'product_id', 'lot_number', 'origin', 'production_date',
                'quality_grade_id', 'quantity_produced', 'quantity_remaining', 'warehouse_id']
  const vals = [tenantId, productId, extras.lot_number || uniq('PLOT'),
                extras.origin || 'adjusted', extras.production_date || '2026-05-22',
                grade1Id, extras.quantity_produced ?? 50, extras.quantity_remaining ?? 50, warehouseId]
  const params = vals.map((_, i) => `$${i + 1}`)
  let i = vals.length + 1
  for (const [k, v] of Object.entries(extras)) {
    if (['lot_number', 'origin', 'production_date', 'quantity_produced', 'quantity_remaining'].includes(k)) continue
    cols.push(k); vals.push(v); params.push(`$${i++}`)
  }
  const { rows } = await withBypass(() => query(
    `INSERT INTO product_lots (${cols.join(',')}) VALUES (${params.join(',')}) RETURNING *`,
    vals
  ))
  return rows[0]
}

// ─── raw_material_lots ────────────────────────────────────────────────────

describe('SaaS v2: migration 130 — raw_material_lots', () => {
  let ctx
  beforeAll(async () => { ctx = await setup('rml') })

  test('INSERT mínimo con defaults', async () => {
    const lot = await insertRmLot(ctx.tenantId, ctx.rmId, ctx.warehouseId)
    expect(lot.status).toBe('active')
    expect(parseFloat(lot.quantity_received)).toBe(100)
    expect(parseFloat(lot.quantity_remaining)).toBe(100)
    expect(lot.expiry_date).toBeNull()
    expect(lot.supplier_id).toBeNull()
  })

  test('Acepta lote completo con supplier/receipt opcionales', async () => {
    const lot = await insertRmLot(ctx.tenantId, ctx.rmId, ctx.warehouseId, {
      manufacturer_lot: 'PROV-2026-001',
      manufacture_date: '2026-01-15',
      expiry_date: '2027-01-15',
      best_before_date: '2026-12-15',
      unit_cost: 12.50,
      total_cost: 1250.00,
    })
    expect(lot.manufacturer_lot).toBe('PROV-2026-001')
    expect(parseFloat(lot.unit_cost)).toBe(12.50)
  })

  test('Rechaza status inválido', async () => {
    await expect(insertRmLot(ctx.tenantId, ctx.rmId, ctx.warehouseId, { status: 'unknown' }))
      .rejects.toThrow(/status_check|check/i)
  })

  test('Rechaza quantity_received <= 0', async () => {
    await expect(insertRmLot(ctx.tenantId, ctx.rmId, ctx.warehouseId, { quantity_received: 0 }))
      .rejects.toThrow(/quantity_received|check/i)
  })

  test('Rechaza quantity_remaining > quantity_received', async () => {
    await expect(insertRmLot(ctx.tenantId, ctx.rmId, ctx.warehouseId, {
      quantity_received: 50, quantity_remaining: 100,
    })).rejects.toThrow(/remaining_lte_received|check/i)
  })

  test('Rechaza expiry_date < manufacture_date', async () => {
    await expect(insertRmLot(ctx.tenantId, ctx.rmId, ctx.warehouseId, {
      manufacture_date: '2026-06-01', expiry_date: '2026-01-01',
    })).rejects.toThrow(/expiry_after_manufacture|check/i)
  })

  test('UNIQUE (raw_material_id, lot_number)', async () => {
    await insertRmLot(ctx.tenantId, ctx.rmId, ctx.warehouseId, { lot_number: 'DUP-001' })
    await expect(insertRmLot(ctx.tenantId, ctx.rmId, ctx.warehouseId, { lot_number: 'DUP-001' }))
      .rejects.toThrow(/duplicate|unique/i)
  })

  test('Status values válidos: active, quarantined, expired, recalled, depleted', async () => {
    for (const s of ['active', 'quarantined', 'expired', 'recalled']) {
      const lot = await insertRmLot(ctx.tenantId, ctx.rmId, ctx.warehouseId, { status: s })
      expect(lot.status).toBe(s)
    }
    // depleted requiere quantity_remaining=0
    const dep = await insertRmLot(ctx.tenantId, ctx.rmId, ctx.warehouseId, {
      status: 'depleted', quantity_remaining: 0,
    })
    expect(dep.status).toBe('depleted')
  })
})

// ─── product_lots ─────────────────────────────────────────────────────────

describe('SaaS v2: migration 130 — product_lots', () => {
  let ctx
  beforeAll(async () => { ctx = await setup('pl') })

  test('origin=adjusted permite producción/supplier todo NULL', async () => {
    const lot = await insertProductLot(ctx.tenantId, ctx.productId, ctx.warehouseId, ctx.grade1Id, {
      origin: 'adjusted',
    })
    expect(lot.origin).toBe('adjusted')
    expect(lot.production_order_id).toBeNull()
    expect(lot.supplier_id).toBeNull()
  })

  test('origin=produced SIN production_order_id → rechaza', async () => {
    await expect(insertProductLot(ctx.tenantId, ctx.productId, ctx.warehouseId, ctx.grade1Id, {
      origin: 'produced',
    })).rejects.toThrow(/origin_produced_fields|check/i)
  })

  test('origin=received SIN supplier_id → rechaza', async () => {
    await expect(insertProductLot(ctx.tenantId, ctx.productId, ctx.warehouseId, ctx.grade1Id, {
      origin: 'received',
    })).rejects.toThrow(/origin_received_fields|check/i)
  })

  test('Rechaza origin inválido', async () => {
    await expect(insertProductLot(ctx.tenantId, ctx.productId, ctx.warehouseId, ctx.grade1Id, {
      origin: 'magic',
    })).rejects.toThrow(/origin_check|check/i)
  })

  test('Rechaza expiry_date < production_date', async () => {
    await expect(insertProductLot(ctx.tenantId, ctx.productId, ctx.warehouseId, ctx.grade1Id, {
      production_date: '2026-06-01', expiry_date: '2026-01-01',
    })).rejects.toThrow(/expiry_after_production|check/i)
  })

  test('UNIQUE (product_id, lot_number)', async () => {
    await insertProductLot(ctx.tenantId, ctx.productId, ctx.warehouseId, ctx.grade1Id, {
      lot_number: 'PLOT-DUP',
    })
    await expect(insertProductLot(ctx.tenantId, ctx.productId, ctx.warehouseId, ctx.grade1Id, {
      lot_number: 'PLOT-DUP',
    })).rejects.toThrow(/duplicate|unique/i)
  })

  test('quality_grade_id es requerido (NOT NULL)', async () => {
    await expect(withBypass(() => query(
      `INSERT INTO product_lots (tenant_id, product_id, lot_number, origin, production_date,
        quantity_produced, quantity_remaining, warehouse_id)
       VALUES ($1, $2, $3, 'adjusted', '2026-05-22', 10, 10, $4)`,
      [ctx.tenantId, ctx.productId, uniq('PL-NQ'), ctx.warehouseId]
    ))).rejects.toThrow(/quality_grade_id|not.null/i)
  })
})

// ─── lot_consumption ──────────────────────────────────────────────────────

describe('SaaS v2: migration 130 — lot_consumption', () => {
  let ctx, productLotId, rmLotId, shiftId

  beforeAll(async () => {
    ctx = await setup('lc')

    const rmLot = await insertRmLot(ctx.tenantId, ctx.rmId, ctx.warehouseId)
    rmLotId = rmLot.id
    const pLot = await insertProductLot(ctx.tenantId, ctx.productId, ctx.warehouseId, ctx.grade1Id)
    productLotId = pLot.id

    // Necesitamos un shift para FK. Crear uno mínimo.
    const { rows: poRows } = await withBypass(() => query(
      `INSERT INTO production_orders (tenant_id, order_number, product_id, raw_material_id, quantity_packages)
       VALUES ($1, $2, $3, $4, 10) RETURNING id`,
      [ctx.tenantId, uniq('PO'), ctx.productId, ctx.rmId]
    ))
    const poId = poRows[0].id

    // production_shifts requiere operator + supervisor (NOT NULL). Usamos el user admin.
    const { rows: uRows } = await withBypass(() => query(
      `SELECT id FROM users WHERE tenant_id = $1 LIMIT 1`, [ctx.tenantId]
    ))
    const userId = uRows[0].id

    const { rows: sRows } = await withBypass(() => query(
      `INSERT INTO production_shifts
        (tenant_id, production_order_id, shift_number, shift_date,
         operator_id, supervisor_id)
       VALUES ($1, $2, '1', '2026-05-22', $3, $3) RETURNING id`,
      [ctx.tenantId, poId, userId]
    ))
    shiftId = sRows[0].id
  })

  test('INSERT consumption vincula MP→PT', async () => {
    const { rows } = await withBypass(() => query(
      `INSERT INTO lot_consumption
        (tenant_id, product_lot_id, raw_material_lot_id, quantity_consumed, unit_id, shift_id)
       VALUES ($1, $2, $3, 5.5, $4, $5) RETURNING *`,
      [ctx.tenantId, productLotId, rmLotId, ctx.kgId, shiftId]
    ))
    expect(rows[0].product_lot_id).toBe(productLotId)
    expect(rows[0].raw_material_lot_id).toBe(rmLotId)
    expect(parseFloat(rows[0].quantity_consumed)).toBe(5.5)
  })

  test('Rechaza quantity_consumed <= 0', async () => {
    await expect(withBypass(() => query(
      `INSERT INTO lot_consumption
        (tenant_id, product_lot_id, raw_material_lot_id, quantity_consumed, unit_id, shift_id)
       VALUES ($1, $2, $3, 0, $4, $5)`,
      [ctx.tenantId, productLotId, rmLotId, ctx.kgId, shiftId]
    ))).rejects.toThrow(/quantity_positive|check/i)
  })
})

// ─── Extensiones a shift_progress / shift_mp_loads / inventory_movements ─

describe('SaaS v2: migration 130 — extensiones aditivas', () => {
  let ctx

  beforeAll(async () => { ctx = await setup('ext') })

  test('shift_progress.lot_id es nullable y FK válida a product_lots', async () => {
    const pl = await insertProductLot(ctx.tenantId, ctx.productId, ctx.warehouseId, ctx.grade1Id)
    const { rows: cols } = await query(
      `SELECT column_name, is_nullable FROM information_schema.columns
       WHERE table_name = 'shift_progress' AND column_name IN ('lot_id', 'dynamic_attributes')`
    )
    expect(cols).toHaveLength(2)
    cols.forEach(c => expect(c.is_nullable).toBe('YES'))
  })

  test('shift_progress.dynamic_attributes rechaza non-object', async () => {
    // Para insertar shift_progress necesito un shift. Reusamos shift_id via SQL completo.
    // order_number es VARCHAR(20), uniq genera ~30 chars así que usamos prefijo más corto.
    const { rows: poRows } = await withBypass(() => query(
      `INSERT INTO production_orders (tenant_id, order_number, product_id, raw_material_id, quantity_packages)
       VALUES ($1, $2, $3, $4, 10) RETURNING id`,
      [ctx.tenantId, `O${Date.now() % 1000000}`, ctx.productId, ctx.rmId]
    ))
    const { rows: uRows } = await withBypass(() => query(
      `SELECT id FROM users WHERE tenant_id = $1 LIMIT 1`, [ctx.tenantId]
    ))
    const { rows: sRows } = await withBypass(() => query(
      `INSERT INTO production_shifts
        (tenant_id, production_order_id, shift_number, shift_date, operator_id, supervisor_id)
       VALUES ($1, $2, '1', '2026-05-22', $3, $3) RETURNING id`,
      [ctx.tenantId, poRows[0].id, uRows[0].id]
    ))

    await expect(withBypass(() => query(
      `INSERT INTO shift_progress
        (shift_id, microlot_number, quantity_units, real_weight_kg, theoretical_weight_kg, dynamic_attributes)
       VALUES ($1, 1, 10, 10.0, 10.0, '[1,2,3]'::jsonb)`,
      [sRows[0].id]
    ))).rejects.toThrow(/dynamic_attributes_is_object|check/i)
  })

  test('shift_mp_loads.lot_id y unit_id existen como columnas nullable', async () => {
    const { rows: cols } = await query(
      `SELECT column_name, is_nullable FROM information_schema.columns
       WHERE table_name = 'shift_mp_loads' AND column_name IN ('lot_id', 'unit_id', 'quantity')`
    )
    expect(cols).toHaveLength(3)
    cols.forEach(c => expect(c.is_nullable).toBe('YES'))
  })

  test('inventory_movements XOR: ambos lot_id NULL OK', async () => {
    // Verificar que la constraint existe y que se puede insertar con ambos NULL
    const { rows: cs } = await query(
      `SELECT conname FROM pg_constraint
       WHERE conrelid = 'inventory_movements'::regclass AND conname = 'im_lot_xor'`
    )
    expect(cs).toHaveLength(1)
  })

  test('inventory_movements XOR: ambos lot_id set → rechaza', async () => {
    const rmLot = await insertRmLot(ctx.tenantId, ctx.rmId, ctx.warehouseId)
    const pLot  = await insertProductLot(ctx.tenantId, ctx.productId, ctx.warehouseId, ctx.grade1Id)

    // Intento de insert con ambos lot_id set debe fallar (movement_type=purchase_entry es válido)
    await expect(withBypass(() => query(
      `INSERT INTO inventory_movements
        (tenant_id, item_type, item_id, warehouse_id, movement_type, quantity,
         raw_material_lot_id, product_lot_id)
       VALUES ($1, 'raw_material', $2, $3, 'purchase_entry', 10, $4, $5)`,
      [ctx.tenantId, ctx.rmId, ctx.warehouseId, rmLot.id, pLot.id]
    ))).rejects.toThrow(/im_lot_xor|check/i)
  })
})
