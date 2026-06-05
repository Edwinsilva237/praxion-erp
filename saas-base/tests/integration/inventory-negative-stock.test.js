'use strict'

/**
 * Inventario negativo + recompute desde el kardex (mig 193, sesión 2026-06-04).
 *
 * Cubre:
 *   - allowNegative=false → la salida clampa a 0 (comportamiento histórico).
 *   - allowNegative=true  → el saldo baja a negativo (bandera de falta de captura).
 *   - Endurecimiento del costo promedio: una entrada desde saldo negativo NO
 *     produce NaN/división por cero (curQty <= 0 → adopta el costo de la entrada).
 *   - getStock muestra negativos (quantity <> 0) y NO clampa.
 *   - getStock includeZero inyecta artículos del catálogo sin existencia (fila 0).
 *   - recomputeStockFromMovements revela el negativo de una sobreventa clampeada.
 */

const { createTenant, loginAs, authedClient, cleanupTestTenants } = require('../helpers/factory')
const { createProduct } = require('../helpers/productionFactory')
const { pool, query, withTransaction, withBypass } = require('../../src/db')
const inventoryService = require('../../src/modules/inventory/inventoryService')

afterAll(async () => {
  await cleanupTestTenants()
  await pool.end()
})

describe('Inventario negativo + recompute desde kardex (mig 193)', () => {
  let client, tenantId, userId, warehouseId, productA, productB, productZero

  beforeAll(async () => {
    const t = await createTenant({ label: 'negstock', planSlug: 'owner' })
    tenantId = t.tenant.id
    userId   = t.user.id
    const sess = await loginAs({ slug: t.tenant.slug, email: t.email, password: t.password })
    client = authedClient({ slug: t.tenant.slug, token: sess.token })

    productA    = await createProduct(client, { sku: 'NEG-A' })
    productB    = await createProduct(client, { sku: 'NEG-B' })
    productZero = await createProduct(client, { sku: 'NEG-ZERO' })

    const wh = await withBypass(() => query(
      `INSERT INTO warehouses (tenant_id, name, type, description, is_active)
       VALUES ($1, 'PT test', 'finished_product', 'fixture', true) RETURNING id`,
      [tenantId]
    ))
    warehouseId = wh.rows[0].id
  })

  async function recordSale(productId, qty, { allowNegative }) {
    return withTransaction((c) => inventoryService.recordMovement(c, {
      tenantId, warehouseId, itemType: 'product', itemId: productId,
      movementType: 'sale_exit', quantity: -qty, unit: 'pza', statusTo: 'available',
      referenceType: 'delivery_note', referenceId: null,
      notes: 'test sale', createdBy: userId, validateStock: false, allowNegative,
    }))
  }

  async function stockOf(productId) {
    const { rows } = await withBypass(() => query(
      `SELECT quantity::numeric AS quantity, avg_cost::numeric AS avg_cost
         FROM inventory_stock
        WHERE tenant_id=$1 AND warehouse_id=$2 AND item_type='product' AND item_id=$3 AND status='available'`,
      [tenantId, warehouseId, productId]
    ))
    return rows[0] ? { qty: parseFloat(rows[0].quantity), cost: parseFloat(rows[0].avg_cost) } : null
  }

  test('allowNegative=false clampa la salida a 0 (histórico)', async () => {
    const mov = await recordSale(productA.id, 10, { allowNegative: false })
    expect(parseFloat(mov.balance_after)).toBe(0)
    expect((await stockOf(productA.id)).qty).toBe(0)
  })

  test('allowNegative=true deja el saldo en negativo', async () => {
    const mov = await recordSale(productB.id, 10, { allowNegative: true })
    expect(parseFloat(mov.balance_after)).toBe(-10)
    expect((await stockOf(productB.id)).qty).toBe(-10)
  })

  test('costo endurecido: entrada desde saldo negativo NO produce NaN (denom = 0)', async () => {
    // productB está en -10. Entra +10 a costo 5 → saldo 0; con la fórmula vieja
    // el denominador (curQty + delta) sería 0 → NaN. Ahora adopta el costo entrante.
    await withTransaction((c) => inventoryService.recordMovement(c, {
      tenantId, warehouseId, itemType: 'product', itemId: productB.id,
      movementType: 'adjustment_in', quantity: 10, unit: 'pza', unitCost: 5,
      statusTo: 'available', notes: 'reentrada', createdBy: userId,
    }))
    const s = await stockOf(productB.id)
    expect(s.qty).toBe(0)
    expect(Number.isNaN(s.cost)).toBe(false)
    expect(s.cost).toBeCloseTo(5, 4)
  })

  test('getStock muestra negativos (quantity <> 0) y oculta los que están en 0', async () => {
    await recordSale(productB.id, 7, { allowNegative: true })  // productB → -7
    const res = await inventoryService.getStock({ tenantId, warehouseId, includeZero: false, limit: 200 })
    const rowB = res.data.find(r => r.item_id === productB.id)
    expect(rowB).toBeTruthy()
    expect(parseFloat(rowB.quantity)).toBe(-7)
    // productZero (sin movimientos) y productA (clampeado en 0) NO aparecen.
    expect(res.data.find(r => r.item_id === productZero.id)).toBeFalsy()
    expect(res.data.find(r => r.item_id === productA.id)).toBeFalsy()
  })

  test('getStock includeZero inyecta artículos del catálogo sin existencia', async () => {
    const res = await inventoryService.getStock({ tenantId, itemType: 'product', includeZero: true, limit: 1000 })
    const zeroRow = res.data.find(r => r.item_id === productZero.id)
    expect(zeroRow).toBeTruthy()
    expect(parseFloat(zeroRow.quantity)).toBe(0)
    expect(zeroRow.warehouse_id).toBeNull()
  })

  test('recompute desde kardex revela el negativo de una sobreventa clampeada', async () => {
    // productA: stock clampeado en 0, pero el kardex tiene un sale_exit -10.
    const preview = await inventoryService.recomputeStockFromMovements({ tenantId, apply: false })
    const diffA = preview.diffs.find(d => d.itemId === productA.id)
    expect(diffA).toBeTruthy()
    expect(diffA.currentQty).toBe(0)
    expect(diffA.computedQty).toBe(-10)
    expect(diffA.delta).toBe(-10)
    expect(preview.applied).toBe(false)
    // La vista previa NO escribe.
    expect((await stockOf(productA.id)).qty).toBe(0)

    // Aplicar → el saldo real queda en -10.
    const applied = await inventoryService.recomputeStockFromMovements({ tenantId, apply: true })
    expect(applied.applied).toBe(true)
    expect((await stockOf(productA.id)).qty).toBe(-10)
  })
})
