'use strict'

/**
 * SaaS v2 — Tests para la migration 126 (extensión de raw_materials).
 *
 * Esta migration es aditiva pura sin endpoints v2 todavía. Los tests verifican
 * a nivel SQL que:
 *  - Las columnas nuevas existen con los defaults correctos.
 *  - Los CHECK constraints funcionan (item_kind, rangos, jsonb_typeof).
 *  - Las FKs a tenant_units y warehouses se pueden usar.
 *  - El service viejo (rawMaterialService.js) sigue funcionando intacto.
 */

const { createTenant, cleanupTestTenants } = require('../helpers/factory')
const { query, pool, withBypass } = require('../../src/db')

afterAll(async () => {
  await cleanupTestTenants()
  await pool.end()
})

describe('SaaS v2: migration 126 — extensiones a raw_materials', () => {
  let tenantId, kgUnitId, mpWarehouseId

  beforeAll(async () => {
    const info = await createTenant({ label: 'rmext', planSlug: 'owner' })
    tenantId = info.tenant.id
    // Recuperar el unit "kg" sembrado
    const { rows: us } = await withBypass(() => query(
      `SELECT id FROM tenant_units WHERE tenant_id = $1 AND code = 'kg'`, [tenantId]
    ))
    kgUnitId = us[0].id
    // Crear un warehouse de MP (no hay seed por defecto; lo creamos directamente)
    const { rows: ws } = await withBypass(() => query(
      `INSERT INTO warehouses (tenant_id, name, type, is_active)
       VALUES ($1, 'Almacén MP test', 'raw_material', true)
       RETURNING id`,
      [tenantId]
    ))
    mpWarehouseId = ws[0].id
  })

  async function insertRm(extras = {}) {
    const cols = ['tenant_id', 'name', 'resin_type']
    const vals = [tenantId, extras.name || `rm-${Date.now()}-${Math.random()}`, 'PE']
    const params = ['$1', '$2', '$3']
    let i = 4
    for (const [k, v] of Object.entries(extras)) {
      if (k === 'name') continue
      cols.push(k); vals.push(v); params.push(`$${i++}`)
    }
    const { rows } = await withBypass(() => query(
      `INSERT INTO raw_materials (${cols.join(',')}) VALUES (${params.join(',')}) RETURNING *`,
      vals
    ))
    return rows[0]
  }

  test('Defaults de columnas nuevas se aplican al INSERT mínimo', async () => {
    const rm = await insertRm({ name: 'defaults-test' })
    expect(rm.item_kind).toBe('raw_material')
    expect(rm.requires_lot_tracking).toBe(false)
    expect(rm.requires_coa).toBe(false)
    expect(rm.unit_id).toBeNull()
    expect(rm.custom_attributes).toBeNull()
    expect(rm.default_warehouse_id).toBeNull()
    expect(rm.expected_yield_pct).toBeNull()
    expect(rm.default_shelf_life_days).toBeNull()
    expect(rm.standard_cost).toBeNull()
  })

  test('Acepta item_kind=packaging y additive', async () => {
    const pack = await insertRm({ name: 'pack-test', item_kind: 'packaging' })
    expect(pack.item_kind).toBe('packaging')
    const add = await insertRm({ name: 'add-test', item_kind: 'additive' })
    expect(add.item_kind).toBe('additive')
  })

  test('Rechaza item_kind inválido (CHECK)', async () => {
    await expect(insertRm({ name: 'bad-kind', item_kind: 'foo' })).rejects.toThrow(/rm_item_kind_check|check constraint/i)
  })

  test('Rechaza expected_yield_pct fuera de [0, 100]', async () => {
    await expect(insertRm({ name: 'yield-bad', expected_yield_pct: 150 })).rejects.toThrow(/rm_expected_yield_pct_range|check constraint/i)
    await expect(insertRm({ name: 'yield-neg', expected_yield_pct: -1 })).rejects.toThrow(/rm_expected_yield_pct_range|check constraint/i)
  })

  test('Acepta expected_yield_pct=0 y 100 (bordes inclusivos)', async () => {
    const a = await insertRm({ name: 'yield-0',   expected_yield_pct: 0 })
    const b = await insertRm({ name: 'yield-100', expected_yield_pct: 100 })
    expect(parseFloat(a.expected_yield_pct)).toBe(0)
    expect(parseFloat(b.expected_yield_pct)).toBe(100)
  })

  test('Rechaza default_shelf_life_days <= 0', async () => {
    await expect(insertRm({ name: 'shelf-0', default_shelf_life_days: 0 })).rejects.toThrow(/rm_default_shelf_life|check constraint/i)
    await expect(insertRm({ name: 'shelf-neg', default_shelf_life_days: -5 })).rejects.toThrow(/rm_default_shelf_life|check constraint/i)
  })

  test('Rechaza standard_cost negativo', async () => {
    await expect(insertRm({ name: 'cost-neg', standard_cost: -0.5 })).rejects.toThrow(/rm_standard_cost|check constraint/i)
  })

  test('Rechaza custom_attributes que no sea objeto JSONB', async () => {
    await expect(insertRm({ name: 'attr-arr', custom_attributes: JSON.stringify(['a', 'b']) }))
      .rejects.toThrow(/rm_custom_attributes_is_object|check constraint/i)
    await expect(insertRm({ name: 'attr-str', custom_attributes: '"hola"' }))
      .rejects.toThrow(/rm_custom_attributes_is_object|check constraint/i)
  })

  test('Acepta custom_attributes objeto JSONB válido', async () => {
    const rm = await insertRm({
      name: 'attr-ok',
      custom_attributes: JSON.stringify({ color: 'blanco', grado: 'A' }),
    })
    expect(rm.custom_attributes).toEqual({ color: 'blanco', grado: 'A' })
  })

  test('FK a tenant_units funciona; UPDATE setea unit_id', async () => {
    const rm = await insertRm({ name: 'unit-test', unit_id: kgUnitId })
    expect(rm.unit_id).toBe(kgUnitId)
  })

  test('FK a warehouses funciona para default_warehouse_id', async () => {
    const rm = await insertRm({ name: 'wh-test', default_warehouse_id: mpWarehouseId })
    expect(rm.default_warehouse_id).toBe(mpWarehouseId)
  })

  test('requires_lot_tracking y requires_coa se pueden setear true', async () => {
    const rm = await insertRm({
      name: 'lot-coa-test',
      requires_lot_tracking: true,
      requires_coa: true,
    })
    expect(rm.requires_lot_tracking).toBe(true)
    expect(rm.requires_coa).toBe(true)
  })

  test('rawMaterialService viejo sigue creando registros con defaults SaaS v2', async () => {
    // El service viejo NO setea las columnas nuevas; deben tomar defaults.
    const svc = require('../../src/modules/raw-materials/rawMaterialService')
    const rm = await svc.createRawMaterial({
      tenantId, name: 'created-by-old-svc',
      resinType: 'PE', materialType: 'virgin',
      unit: 'kg', maxRegrindPct: 30, costPerKg: 10,
      description: null, leadTimeDays: 7,
      userId: null, ipAddress: null, userAgent: null,
    })
    expect(rm.item_kind).toBe('raw_material')
    expect(rm.requires_lot_tracking).toBe(false)
    expect(rm.unit_id).toBeNull()
  })

  test('Índice parcial requires_lot_tracking solo indexa true', async () => {
    // Verificamos que el índice existe y tiene WHERE clause
    const { rows } = await query(
      `SELECT indexdef FROM pg_indexes
       WHERE schemaname='public' AND tablename='raw_materials'
         AND indexname='idx_raw_materials_requires_lot'`
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].indexdef).toMatch(/WHERE \(requires_lot_tracking = true\)/i)
  })
})
