'use strict'

/**
 * Costo estándar/estimado por producto (mig 219).
 *  - createProduct/updateProduct persisten standard_cost; getProduct lo devuelve
 *    junto con el costo ACTUAL de inventario por almacén (stockCosts + weightedAvgCost).
 *  - PARACAÍDAS en updateStock: una ENTRADA de producto en $0 toma el standard_cost
 *    en lugar de $0 (producción/maquilador sin costo). El costo real siempre gana.
 */

const { createTenant, cleanupTestTenants } = require('../helpers/factory')
const { pool, query, withBypass, withTransaction } = require('../../src/db')
const productService = require('../../src/modules/products/productService')
const inventoryService = require('../../src/modules/inventory/inventoryService')

let tenantId, userId, wh

async function newProduct(sku, standardCost) {
  const p = await productService.createProduct({
    tenantId, sku, name: `Prod ${sku}`, isProduced: true,
    saleUnit: 'pieza', satUnitCode: 'H87', standardCost, userId,
  })
  return p.id
}

async function entry(itemId, qty, unitCost) {
  return withTransaction((c) => inventoryService.recordMovement(c, {
    tenantId, warehouseId: wh, itemType: 'product', itemId,
    movementType: 'adjustment_in', quantity: qty, unit: 'pza', unitCost,
    statusTo: 'available', notes: 'test entry', createdBy: userId,
  }))
}

async function costOf(itemId) {
  const { rows } = await withBypass(() => query(
    `SELECT quantity::numeric AS quantity, avg_cost::numeric AS avg_cost
       FROM inventory_stock
      WHERE tenant_id=$1 AND warehouse_id=$2 AND item_type='product' AND item_id=$3 AND status='available'`,
    [tenantId, wh, itemId]))
  return rows[0] ? { qty: parseFloat(rows[0].quantity), cost: parseFloat(rows[0].avg_cost) } : null
}

describe('product standard_cost', () => {
  beforeAll(async () => {
    const t = await createTenant({ label: 'stdcost', planSlug: 'owner' })
    tenantId = t.tenant.id; userId = t.user.id
    wh = (await withBypass(() => query(
      `INSERT INTO warehouses (tenant_id,name,type,is_active,is_default)
       VALUES ($1,'Fabrica','finished_product',true,true) RETURNING id`, [tenantId]))).rows[0].id
  })
  afterAll(async () => { await cleanupTestTenants(); await pool.end() })

  test('createProduct persiste standard_cost y getProduct lo devuelve', async () => {
    const id = await newProduct('STD-1', 7.5)
    const detail = await productService.getProduct({ tenantId, productId: id })
    expect(parseFloat(detail.standard_cost)).toBeCloseTo(7.5, 4)
    expect(detail.stockCosts).toEqual([])          // sin existencias aún
    expect(detail.weightedAvgCost).toBeNull()
  })

  test('paracaídas: primera entrada en $0 toma el standard_cost', async () => {
    const id = await newProduct('STD-2', 5)
    await entry(id, 100, 0)                          // entrada sin costo
    const s = await costOf(id)
    expect(s.qty).toBe(100)
    expect(s.cost).toBeCloseTo(5, 4)                 // NO $0
  })

  test('el costo real de una entrada > 0 SIEMPRE gana sobre el estándar', async () => {
    const id = await newProduct('STD-3', 5)
    await entry(id, 100, 8)                          // costo real 8
    const s = await costOf(id)
    expect(s.cost).toBeCloseTo(8, 4)                 // NO 5
  })

  test('mezcla ponderada: entrada en $0 se valúa al estándar y promedia', async () => {
    const id = await newProduct('STD-4', 10)
    await entry(id, 100, 20)                          // 100 @ 20 real → avg 20
    await entry(id, 100, 0)                           // 100 @ $0 → paracaídas 10
    const s = await costOf(id)                         // (100*20 + 100*10)/200 = 15
    expect(s.qty).toBe(200)
    expect(s.cost).toBeCloseTo(15, 4)
  })

  test('sin standard_cost: la entrada en $0 deja el costo en 0 (retrocompat)', async () => {
    const id = await newProduct('STD-5', null)
    await entry(id, 100, 0)
    const s = await costOf(id)
    expect(s.cost).toBeCloseTo(0, 4)
  })

  test('updateProduct fija y limpia standard_cost', async () => {
    const id = await newProduct('STD-6', null)
    await productService.updateProduct({ tenantId, productId: id, standardCost: 3.25, userId })
    let d = await productService.getProduct({ tenantId, productId: id })
    expect(parseFloat(d.standard_cost)).toBeCloseTo(3.25, 4)

    await productService.updateProduct({ tenantId, productId: id, standardCost: '', userId })
    d = await productService.getProduct({ tenantId, productId: id })
    expect(d.standard_cost).toBeNull()
  })

  test('2º paracaídas: sin standard_cost, la entrada en $0 toma el último WAC conocido en otro almacén', async () => {
    const id = await newProduct('STD-WAC', null)          // SIN standard_cost
    await entry(id, 100, 12)                                // Fábrica: 100 @ $12 (costo real previo)

    // Segundo almacén (Distribución). Entrada en $0 → debe tomar el WAC global (12).
    const wh2 = (await withBypass(() => query(
      `INSERT INTO warehouses (tenant_id,name,type,is_active)
       VALUES ($1,'Distribucion','finished_product',true) RETURNING id`, [tenantId]))).rows[0].id
    await withTransaction((c) => inventoryService.recordMovement(c, {
      tenantId, warehouseId: wh2, itemType: 'product', itemId: id,
      movementType: 'adjustment_in', quantity: 40, unit: 'pza', unitCost: 0,
      statusTo: 'available', notes: 'entrada $0 en 2º almacén', createdBy: userId,
    }))

    const { rows } = await withBypass(() => query(
      `SELECT avg_cost::numeric AS avg_cost FROM inventory_stock
        WHERE tenant_id=$1 AND warehouse_id=$2 AND item_type='product' AND item_id=$3 AND status='available'`,
      [tenantId, wh2, id]))
    expect(parseFloat(rows[0].avg_cost)).toBeCloseTo(12, 4)   // NO $0
  })

  test('getProduct expone stockCosts por almacén y promedio ponderado global', async () => {
    const id = await newProduct('STD-7', 4)
    await entry(id, 50, 4)
    const d = await productService.getProduct({ tenantId, productId: id })
    expect(d.stockCosts.length).toBeGreaterThanOrEqual(1)
    const row = d.stockCosts.find(r => parseFloat(r.quantity) === 50)
    expect(row).toBeTruthy()
    expect(parseFloat(row.avg_cost)).toBeCloseTo(4, 4)
    expect(d.weightedAvgCost).toBeCloseTo(4, 4)
  })
})
