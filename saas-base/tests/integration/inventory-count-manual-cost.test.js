'use strict'

/**
 * Costo unitario manual en líneas de conteo SIN costo de sistema (mig 217).
 *
 * Para artículos que nunca tuvieron compra/producción con costo (system_avg_cost
 * = 0), el cierre valuaba el ajuste en $0. Ahora se puede capturar el costo SOLO
 * en esas líneas; el ajuste de cierre queda valuado y el producto adquiere costo.
 *
 * Candado: fijar costo sobre un artículo que YA tiene costo promedio válido se
 * rechaza (no se corrompe el costeo).
 */

const { createTenant, cleanupTestTenants } = require('../helpers/factory')
const { pool, query, withBypass } = require('../../src/db')
const countService = require('../../src/modules/inventory/inventoryCountService')

let tenantId, userId, whId, rmNoCostId, rmWithCostId

describe('Conteo — costo manual para artículos sin costo de sistema', () => {
  beforeAll(async () => {
    const t = await createTenant({ label: 'mancost', planSlug: 'owner' })
    tenantId = t.tenant.id
    userId   = t.user.id
    const wh = await withBypass(() => query(
      `INSERT INTO warehouses (tenant_id, name, type, is_active)
       VALUES ($1, 'MP', 'raw_material', true) RETURNING id`, [tenantId]))
    whId = wh.rows[0].id

    const rm1 = await withBypass(() => query(
      `INSERT INTO raw_materials (tenant_id, name, is_active)
       VALUES ($1, 'RM sin costo', true) RETURNING id`, [tenantId]))
    rmNoCostId = rm1.rows[0].id
    const rm2 = await withBypass(() => query(
      `INSERT INTO raw_materials (tenant_id, name, is_active)
       VALUES ($1, 'RM con costo', true) RETURNING id`, [tenantId]))
    rmWithCostId = rm2.rows[0].id

    // Sin costo: renglón con qty 0 y avg_cost 0.
    await withBypass(() => query(
      `INSERT INTO inventory_stock (tenant_id, warehouse_id, item_type, item_id, status, quantity, unit, avg_cost)
       VALUES ($1, $2, 'raw_material', $3, 'available', 0, 'kg', 0)`, [tenantId, whId, rmNoCostId]))
    // Con costo válido: 8/kg.
    await withBypass(() => query(
      `INSERT INTO inventory_stock (tenant_id, warehouse_id, item_type, item_id, status, quantity, unit, avg_cost)
       VALUES ($1, $2, 'raw_material', $3, 'available', 100, 'kg', 8)`, [tenantId, whId, rmWithCostId]))
  })

  afterAll(async () => { await cleanupTestTenants(); await pool.end() })

  test('capturar costo en artículo SIN costo → el ajuste se valúa y el producto adquiere costo', async () => {
    const c = await countService.createCount({ tenantId, countType: 'month_close', userId, countDate: '2026-06-30' })
    const line = c.lines.find(l => l.item_id === rmNoCostId)
    expect(parseFloat(line.system_avg_cost)).toBe(0)

    // Físico 20 kg + costo manual 5/kg.
    await countService.captureLine({
      tenantId, countId: c.id, lineId: line.id, physicalQty: 20, unitCost: 5, userId,
    })

    // El detalle ya refleja el costo efectivo y el valor de la diferencia.
    const reread = await countService.getCountById({ tenantId, countId: c.id })
    const l2 = reread.lines.find(l => l.item_id === rmNoCostId)
    expect(parseFloat(l2.captured_unit_cost)).toBe(5)
    expect(parseFloat(l2.effective_cost)).toBe(5)
    expect(parseFloat(l2.difference_value)).toBeCloseTo(100, 2)  // 20 × 5

    await countService.applyCount({ tenantId, countId: c.id, closingNotes: 'cierre', userId })

    const st = await query(
      `SELECT quantity, avg_cost FROM inventory_stock WHERE tenant_id=$1 AND item_id=$2`, [tenantId, rmNoCostId])
    expect(parseFloat(st.rows[0].quantity)).toBe(20)
    expect(parseFloat(st.rows[0].avg_cost)).toBeCloseTo(5, 4)  // el ajuste le dio costo

    const adj = await query(
      `SELECT total_in_value FROM inventory_adjustments WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 1`, [tenantId])
    expect(parseFloat(adj.rows[0].total_in_value)).toBeCloseTo(100, 2)  // ya NO es $0
  })

  test('candado: fijar costo en artículo con costo de sistema válido → 409', async () => {
    const c = await countService.createCount({ tenantId, countType: 'cyclic', warehouseId: whId, scope: 'with_stock', userId })
    const line = c.lines.find(l => l.item_id === rmWithCostId)
    expect(parseFloat(line.system_avg_cost)).toBe(8)

    await expect(countService.captureLine({
      tenantId, countId: c.id, lineId: line.id, physicalQty: 90, unitCost: 999, userId,
    })).rejects.toMatchObject({ status: 409 })
  })
})
