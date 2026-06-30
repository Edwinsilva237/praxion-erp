'use strict'

/**
 * Salida de venta — fallback por EXISTENCIA entre almacenes (Fábrica → Distribución).
 *
 * Caso real: el mismo SKU producido tiene doble origen — se fabrica (entra a
 * Fábrica, tipo finished_product) y a veces se compra a un maquilador (entra a
 * Distribución, tipo resale). La venta debe descontar de Fábrica si alcanza, y
 * si no, del stock en Distribución. Si ninguno alcanza, cae al default del tipo
 * preferido (puede quedar negativo, como antes).
 */

const { createTenant, cleanupTestTenants } = require('../helpers/factory')
const { pool, query, withBypass, withTransaction } = require('../../src/db')
const { resolveWarehouseForLine } = require('../../src/modules/sales/deliveryNoteService')

let tenantId, fabrica, distribucion, productId

describe('resolveWarehouseForLine — fallback por existencia', () => {
  beforeAll(async () => {
    const t = await createTenant({ label: 'whfb', planSlug: 'owner' })
    tenantId = t.tenant.id
    fabrica = (await withBypass(() => query(
      `INSERT INTO warehouses (tenant_id,name,type,is_active,is_default)
       VALUES ($1,'Fabrica','finished_product',true,true) RETURNING id`, [tenantId]))).rows[0].id
    distribucion = (await withBypass(() => query(
      `INSERT INTO warehouses (tenant_id,name,type,is_active,is_default)
       VALUES ($1,'Distribucion','resale',true,true) RETURNING id`, [tenantId]))).rows[0].id
    productId = (await withBypass(() => query(
      `INSERT INTO products (tenant_id,sku,name,type,base_unit,sale_unit,is_produced)
       VALUES ($1,'P1','Esquinero','corner_protector','pieza','pieza',true) RETURNING id`, [tenantId]))).rows[0].id
  })
  afterAll(async () => { await cleanupTestTenants(); await pool.end() })

  const setStock = (wh, q) => withBypass(() => query(
    `INSERT INTO inventory_stock (tenant_id,warehouse_id,item_type,item_id,status,quantity,unit,avg_cost)
     VALUES ($1,$2,'product',$3,'available',$4,'pieza',10)
     ON CONFLICT (tenant_id,warehouse_id,item_type,item_id,status) DO UPDATE SET quantity=$4`,
    [tenantId, wh, productId, q]))
  const pick = (q) => withTransaction(c => resolveWarehouseForLine(c, tenantId, null, 'corner_protector', productId, q))

  test('Fábrica alcanza → sale de Fábrica', async () => {
    await setStock(fabrica, 100); await setStock(distribucion, 50)
    expect(await pick(30)).toBe(fabrica)
  })

  test('Fábrica NO alcanza pero Distribución sí → sale de Distribución', async () => {
    await setStock(fabrica, 10); await setStock(distribucion, 50)
    expect(await pick(30)).toBe(distribucion)
  })

  test('ninguno alcanza → cae al default del tipo preferido (Fábrica)', async () => {
    await setStock(fabrica, 0); await setStock(distribucion, 0)
    expect(await pick(30)).toBe(fabrica)
  })

  test('warehouse_id explícito en la línea → se respeta sin recalcular', async () => {
    expect(await withTransaction(c =>
      resolveWarehouseForLine(c, tenantId, distribucion, 'corner_protector', productId, 30))).toBe(distribucion)
  })
})
