'use strict'

/**
 * Edición manual del costo unitario (setStockCost): corrige productos a $0 o mal
 * costeados. Revalúa el saldo sin generar movimiento; deja auditoría.
 */

const { createTenant, cleanupTestTenants } = require('../helpers/factory')
const { pool, query, withBypass } = require('../../src/db')
const inventoryService = require('../../src/modules/inventory/inventoryService')

let tenantId, userId, wh, prod

describe('setStockCost', () => {
  beforeAll(async () => {
    const t = await createTenant({ label: 'setcost', planSlug: 'owner' })
    tenantId = t.tenant.id; userId = t.user.id
    wh = (await withBypass(() => query(
      `INSERT INTO warehouses (tenant_id,name,type,is_active,is_default) VALUES ($1,'Fabrica','finished_product',true,true) RETURNING id`, [tenantId]))).rows[0].id
    prod = (await withBypass(() => query(
      `INSERT INTO products (tenant_id,sku,name,type,base_unit,sale_unit) VALUES ($1,'PRO-1','Esquinero','corner_protector','pieza','pieza') RETURNING id`, [tenantId]))).rows[0].id
    await withBypass(() => query(
      `INSERT INTO inventory_stock (tenant_id,warehouse_id,item_type,item_id,status,quantity,unit,avg_cost)
       VALUES ($1,$2,'product',$3,'available',1500,'pza',0)`, [tenantId, wh, prod]))
  })
  afterAll(async () => { await cleanupTestTenants(); await pool.end() })

  test('fija el costo unitario y revalúa el saldo', async () => {
    const r = await inventoryService.setStockCost({
      tenantId, itemType: 'product', itemId: prod, warehouseId: wh,
      status: 'available', unitCost: 5.52, userId, note: 'costo maquilador',
    })
    expect(r.previousCost).toBeCloseTo(0, 2)
    expect(r.newCost).toBeCloseTo(5.52, 2)
    expect(r.valueAfter).toBeCloseTo(1500 * 5.52, 2)

    const { rows } = await query(
      `SELECT avg_cost FROM inventory_stock WHERE tenant_id=$1 AND item_id=$2 AND status='available'`, [tenantId, prod])
    expect(parseFloat(rows[0].avg_cost)).toBeCloseTo(5.52, 2)
  })

  test('rechaza costo negativo', async () => {
    await expect(inventoryService.setStockCost({
      tenantId, itemType: 'product', itemId: prod, warehouseId: wh, unitCost: -1, userId,
    })).rejects.toMatchObject({ status: 400 })
  })

  test('404 si no existe el saldo', async () => {
    await expect(inventoryService.setStockCost({
      tenantId, itemType: 'product', itemId: prod, warehouseId: wh, status: 'blocked', unitCost: 5, userId,
    })).rejects.toMatchObject({ status: 404 })
  })
})
