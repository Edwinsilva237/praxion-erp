'use strict'

/**
 * getMovementDetail: detalle de un movimiento del kardex + su documento origen
 * resuelto (ajuste, o "sin documento" para movimientos manuales).
 */

const { createTenant, cleanupTestTenants } = require('../helpers/factory')
const { pool, query, withBypass, withTransaction } = require('../../src/db')
const inventoryService = require('../../src/modules/inventory/inventoryService')
const productService = require('../../src/modules/products/productService')

let tenantId, userId, wh, productId

describe('getMovementDetail (documento origen)', () => {
  beforeAll(async () => {
    const t = await createTenant({ label: 'movdet', planSlug: 'owner' })
    tenantId = t.tenant.id; userId = t.user.id
    wh = (await withBypass(() => query(
      `INSERT INTO warehouses (tenant_id,name,type,is_active,is_default)
       VALUES ($1,'Fabrica','finished_product',true,true) RETURNING id`, [tenantId]))).rows[0].id
    const p = await productService.createProduct({
      tenantId, sku: 'MD-1', name: 'Prod MD-1', isProduced: true,
      saleUnit: 'pieza', satUnitCode: 'H87', userId,
    })
    productId = p.id
  })
  afterAll(async () => { await cleanupTestTenants(); await pool.end() })

  test('resuelve un movimiento de AJUSTE a su folio', async () => {
    const adj = await inventoryService.createAdjustmentDocument({
      tenantId, warehouseId: wh, reason: 'conteo', notes: 'test',
      lines: [{ itemType: 'product', itemId: productId, direction: 'in', quantity: 10, unitCost: 5, notes: 'alta' }],
      userId,
    })
    const { rows } = await withBypass(() => query(
      `SELECT id FROM inventory_movements
        WHERE tenant_id=$1 AND reference_type='inventory_adjustment' AND reference_id=$2 LIMIT 1`,
      [tenantId, adj.id]))
    const movId = rows[0].id

    const detail = await inventoryService.getMovementDetail({ tenantId, movementId: movId })
    expect(detail).toBeTruthy()
    expect(detail.item_name).toBe('Prod MD-1')
    expect(detail.source.type).toBe('inventory_adjustment')
    expect(detail.source.folio).toBe(adj.adjustment_number)
    expect(detail.source.label).toContain('Ajuste')
    expect(detail.source.module).toBe('inventario')
  })

  test('movimiento sin documento origen', async () => {
    const mov = await withTransaction((c) => inventoryService.recordMovement(c, {
      tenantId, warehouseId: wh, itemType: 'product', itemId: productId,
      movementType: 'adjustment_in', quantity: 3, unit: 'pza', unitCost: 4,
      statusTo: 'available', notes: 'suelto', createdBy: userId,
    }))
    const detail = await inventoryService.getMovementDetail({ tenantId, movementId: mov.id })
    expect(detail.source.type).toBe('manual')
    expect(detail.source.label).toMatch(/sin documento/i)
  })

  test('404 (null) si el movimiento no existe / otro tenant', async () => {
    const detail = await inventoryService.getMovementDetail({
      tenantId, movementId: '00000000-0000-0000-0000-000000000000',
    })
    expect(detail).toBeNull()
  })
})
