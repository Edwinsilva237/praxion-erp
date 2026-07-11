'use strict'

/**
 * orderService.getItemStockByWarehouse: indicador de stock disponible al capturar
 * cantidades en un pedido. Devuelve existencias por almacén + total + el nivel
 * configurado (status_calc) cuando lo hay. El pedido no fija almacén, por eso el
 * desglose es por-almacén.
 */

const { createTenant, loginAs, authedClient, cleanupTestTenants } = require('../helpers/factory')
const { createProduct } = require('../helpers/productionFactory')
const { pool, query, withTransaction, withBypass } = require('../../src/db')
const inventoryService = require('../../src/modules/inventory/inventoryService')
const orderService = require('../../src/modules/sales/orderService')

let client, tenantId, userId, whMain, whSec, whEmpty
let seq = 0
const uniq = () => `${Date.now()}-${++seq}`

async function makeWarehouse(name, type = 'finished_product') {
  const { rows } = await withBypass(() => query(
    `INSERT INTO warehouses (tenant_id, name, type, description, is_active)
     VALUES ($1,$2,$3,'fixture',true) RETURNING id`, [tenantId, name, type]))
  return rows[0].id
}

async function seedStock({ warehouseId, productId, qty }) {
  await withTransaction((c) => inventoryService.recordMovement(c, {
    tenantId, warehouseId, itemType: 'product', itemId: productId,
    movementType: 'adjustment_in', quantity: qty, unit: 'pieza', unitCost: 5,
    statusTo: 'available', notes: 'seed', createdBy: userId,
  }))
}

beforeAll(async () => {
  const t = await createTenant({ label: 'itemstock', planSlug: 'owner' })
  tenantId = t.tenant.id
  userId   = t.user.id
  const sess = await loginAs({ slug: t.tenant.slug, email: t.email, password: t.password })
  client = authedClient({ slug: t.tenant.slug, token: sess.token })
  whMain  = await makeWarehouse('Distribución')
  whSec   = await makeWarehouse('Fábrica')
  whEmpty = await makeWarehouse('Vacío')
})
afterAll(async () => { await cleanupTestTenants(); await pool.end() })

test('desglosa por almacén, suma el total y omite almacenes sin stock ni nivel', async () => {
  const product = await createProduct(client, { sku: `STK-${uniq()}` })
  await seedStock({ warehouseId: whMain, productId: product.id, qty: 90 })
  await seedStock({ warehouseId: whSec,  productId: product.id, qty: 10 })

  const res = await orderService.getItemStockByWarehouse({
    tenantId, itemType: 'product', itemId: product.id,
  })

  expect(res.total_available).toBeCloseTo(100, 2)
  // whEmpty no tiene stock ni nivel → no aparece.
  const names = res.warehouses.map(w => w.warehouse_name).sort()
  expect(names).toEqual(['Distribución', 'Fábrica'])
  const main = res.warehouses.find(w => w.warehouse_name === 'Distribución')
  expect(parseFloat(main.quantity)).toBeCloseTo(90, 2)
  expect(main.status_calc).toBeNull()   // sin nivel configurado
})

test('marca status_calc=below_min cuando el nivel configurado lo indica', async () => {
  const product = await createProduct(client, { sku: `STK-${uniq()}` })
  await seedStock({ warehouseId: whSec, productId: product.id, qty: 10 })
  // Nivel configurado en Fábrica: min 50 → 10 < 50 = bajo mínimo.
  await withBypass(() => query(
    `INSERT INTO inventory_levels
       (tenant_id, item_type, item_id, warehouse_id, min_stock, reorder_point, max_stock, safety_stock)
     VALUES ($1,'product',$2,$3,50,60,200,0)`,
    [tenantId, product.id, whSec]))

  const res = await orderService.getItemStockByWarehouse({
    tenantId, itemType: 'product', itemId: product.id,
  })
  const fab = res.warehouses.find(w => w.warehouse_name === 'Fábrica')
  expect(fab).toBeTruthy()
  expect(fab.status_calc).toBe('below_min')
  expect(parseFloat(fab.min_stock)).toBeCloseTo(50, 2)
})

test('almacén con nivel configurado pero SIN stock aparece con cantidad 0', async () => {
  const product = await createProduct(client, { sku: `STK-${uniq()}` })
  await withBypass(() => query(
    `INSERT INTO inventory_levels
       (tenant_id, item_type, item_id, warehouse_id, min_stock, reorder_point, max_stock, safety_stock)
     VALUES ($1,'product',$2,$3,20,25,100,0)`,
    [tenantId, product.id, whMain]))

  const res = await orderService.getItemStockByWarehouse({
    tenantId, itemType: 'product', itemId: product.id,
  })
  expect(res.total_available).toBeCloseTo(0, 2)
  const main = res.warehouses.find(w => w.warehouse_name === 'Distribución')
  expect(main).toBeTruthy()
  expect(parseFloat(main.quantity)).toBeCloseTo(0, 2)
  expect(main.status_calc).toBe('below_min')   // 0 < 20
})