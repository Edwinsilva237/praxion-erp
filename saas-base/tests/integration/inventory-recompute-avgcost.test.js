'use strict'

/**
 * Recalcular costo promedio desde el kardex (recomputeAvgCostFromMovements).
 *
 * Corrige promedios "pegados" en un valor que el kardex no justifica. Reproduce
 * los movimientos con la misma regla de promedio ponderado que updateStock (una
 * entrada a costo $0 NO baja el promedio).
 */

const { createTenant, cleanupTestTenants } = require('../helpers/factory')
const { pool, query, withBypass } = require('../../src/db')
const inventoryService = require('../../src/modules/inventory/inventoryService')

let tenantId, userId, wh, prod

describe('recomputeAvgCostFromMovements', () => {
  beforeAll(async () => {
    const t = await createTenant({ label: 'recavg', planSlug: 'owner' })
    tenantId = t.tenant.id
    userId = t.user.id
    wh = (await withBypass(() => query(
      `INSERT INTO warehouses (tenant_id,name,type,is_active,is_default) VALUES ($1,'Fabrica','finished_product',true,true) RETURNING id`, [tenantId]))).rows[0].id
    prod = (await withBypass(() => query(
      `INSERT INTO products (tenant_id,sku,name,type,base_unit,sale_unit) VALUES ($1,'PRO-1','Esquinero','corner_protector','pieza','pieza') RETURNING id`, [tenantId]))).rows[0].id

    // Kardex: +1000 @ $5.52, luego +500 @ $0 (producción sin costear).
    await withBypass(() => query(
      `INSERT INTO inventory_movements (tenant_id,warehouse_id,item_type,item_id,movement_type,quantity,unit,unit_cost,status_to,created_by,created_at) VALUES
        ($1,$2,'product',$3,'production_pt_entry',1000,'pza',5.52,'available',$4,'2026-06-01'),
        ($1,$2,'product',$3,'production_pt_entry',500,'pza',0,'available',$4,'2026-06-10')`,
      [tenantId, wh, prod, userId]))
    // Stock con avg PEGADO en $46.56 (inconsistente con el kardex).
    await withBypass(() => query(
      `INSERT INTO inventory_stock (tenant_id,warehouse_id,item_type,item_id,status,quantity,unit,avg_cost)
       VALUES ($1,$2,'product',$3,'available',1500,'pza',46.56)`, [tenantId, wh, prod]))
  })
  afterAll(async () => { await cleanupTestTenants(); await pool.end() })

  test('preview detecta el promedio pegado y calcula el real', async () => {
    const r = await inventoryService.recomputeAvgCostFromMovements({ tenantId, apply: false })
    expect(r.applied).toBe(false)
    expect(r.count).toBe(1)
    const d = r.diffs[0]
    expect(d.currentAvgCost).toBeCloseTo(46.56, 2)
    expect(d.recomputedAvgCost).toBeCloseTo(5.52, 2)  // $0 no baja el promedio; queda en 5.52
    expect(d.valueBefore).toBeCloseTo(1500 * 46.56, 2)
    expect(d.valueAfter).toBeCloseTo(1500 * 5.52, 2)
  })

  test('apply corrige el avg_cost en inventory_stock', async () => {
    await inventoryService.recomputeAvgCostFromMovements({ tenantId, apply: true })
    const { rows } = await query(
      `SELECT avg_cost FROM inventory_stock WHERE tenant_id=$1 AND item_id=$2 AND status='available'`, [tenantId, prod])
    expect(parseFloat(rows[0].avg_cost)).toBeCloseTo(5.52, 2)

    // Ya no hay diferencias tras aplicar.
    const r = await inventoryService.recomputeAvgCostFromMovements({ tenantId, apply: false })
    expect(r.count).toBe(0)
  })
})
