'use strict'

/**
 * Liberar 2ª calidad: mueve stock de PRODUCTO de 'blocked' → 'available' en el
 * mismo almacén, conservando el costo (se promedia en disponible). Kardex + audit.
 */

const { createTenant, cleanupTestTenants } = require('../helpers/factory')
const { pool, query, withBypass, withTransaction } = require('../../src/db')
const inventoryService = require('../../src/modules/inventory/inventoryService')
const productService = require('../../src/modules/products/productService')

let tenantId, userId, wh

async function entry(itemId, qty, unitCost, status) {
  return withTransaction((c) => inventoryService.recordMovement(c, {
    tenantId, warehouseId: wh, itemType: 'product', itemId,
    movementType: status === 'blocked' ? 'production_pt_entry' : 'adjustment_in',
    quantity: qty, unit: 'pza', unitCost, statusTo: status,
    notes: 'seed', createdBy: userId,
  }))
}

async function stockOf(itemId, status) {
  const { rows } = await withBypass(() => query(
    `SELECT quantity::numeric AS quantity, avg_cost::numeric AS avg_cost
       FROM inventory_stock
      WHERE tenant_id=$1 AND warehouse_id=$2 AND item_type='product' AND item_id=$3 AND status=$4`,
    [tenantId, wh, itemId, status]))
  return rows[0] ? { qty: parseFloat(rows[0].quantity), cost: parseFloat(rows[0].avg_cost) } : null
}

async function newProduct(sku) {
  const p = await productService.createProduct({
    tenantId, sku, name: `Prod ${sku}`, isProduced: true,
    saleUnit: 'pieza', satUnitCode: 'H87', userId,
  })
  return p.id
}

describe('releaseBlockedStock', () => {
  beforeAll(async () => {
    const t = await createTenant({ label: 'relblk', planSlug: 'owner' })
    tenantId = t.tenant.id; userId = t.user.id
    wh = (await withBypass(() => query(
      `INSERT INTO warehouses (tenant_id,name,type,is_active,is_default)
       VALUES ($1,'Fabrica','finished_product',true,true) RETURNING id`, [tenantId]))).rows[0].id
  })
  afterAll(async () => { await cleanupTestTenants(); await pool.end() })

  test('libera todo el bloqueado a disponible conservando el costo', async () => {
    const id = await newProduct('REL-1')
    await entry(id, 2350, 20, 'available')   // 1ª calidad
    await entry(id, 650, 6, 'blocked')       // 2ª calidad apartada

    const res = await inventoryService.releaseBlockedStock({ tenantId, warehouseId: wh, itemId: id, userId })
    expect(res.released).toBeCloseTo(650, 4)
    expect(res.remainingBlocked).toBeCloseTo(0, 4)

    expect((await stockOf(id, 'blocked')).qty).toBeCloseTo(0, 4)
    const avail = await stockOf(id, 'available')
    expect(avail.qty).toBeCloseTo(3000, 4)                 // 2350 + 650
    expect(avail.cost).toBeCloseTo((2350 * 20 + 650 * 6) / 3000, 3)  // promedio ponderado
  })

  test('libera una cantidad parcial y deja el resto bloqueado', async () => {
    const id = await newProduct('REL-2')
    await entry(id, 100, 6, 'blocked')
    await inventoryService.releaseBlockedStock({ tenantId, warehouseId: wh, itemId: id, quantity: 40, userId })
    expect((await stockOf(id, 'blocked')).qty).toBeCloseTo(60, 4)
    expect((await stockOf(id, 'available')).qty).toBeCloseTo(40, 4)
  })

  test('rechaza liberar más de lo bloqueado', async () => {
    const id = await newProduct('REL-3')
    await entry(id, 10, 6, 'blocked')
    await expect(
      inventoryService.releaseBlockedStock({ tenantId, warehouseId: wh, itemId: id, quantity: 50, userId })
    ).rejects.toThrow(/bloqueadas/i)
  })

  test('404 si no hay stock bloqueado', async () => {
    const id = await newProduct('REL-4')
    await entry(id, 10, 6, 'available')
    await expect(
      inventoryService.releaseBlockedStock({ tenantId, warehouseId: wh, itemId: id, userId })
    ).rejects.toThrow(/bloqueado/i)
  })
})
