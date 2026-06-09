'use strict'

/**
 * Conteo cíclico — scope='all' incluye TODO el catálogo activo del tipo del
 * almacén, tenga o no existencia (fix 2026-06-09).
 *
 * Bug original: createCount armaba el snapshot SOLO con items que tuvieran
 *   - un renglón en inventory_stock, o
 *   - un nivel configurado en inventory_levels
 * para ese almacén. Los productos activos con stock 0 y sin nivel configurado
 * quedaban fuera del conteo en silencio (espejo de getStock includeZero, mig 193).
 *
 * Cubre:
 *   - scope='all' en almacén de PT incluye productos con stock, en cero sin nivel
 *     y en cero con nivel — sin duplicar (UNIQUE count_id+item+warehouse).
 *   - scope='with_stock' sigue trayendo SOLO los que tienen existencia.
 *   - scope='all' en almacén de MP incluye materias primas del catálogo y NO
 *     mete productos terminados (mapeo por tipo de almacén).
 */

const { createTenant, loginAs, authedClient, cleanupTestTenants } = require('../helpers/factory')
const { createProduct, createRawMaterial } = require('../helpers/productionFactory')
const { pool, query, withTransaction, withBypass } = require('../../src/db')
const inventoryService = require('../../src/modules/inventory/inventoryService')
const inventoryCountService = require('../../src/modules/inventory/inventoryCountService')

afterAll(async () => {
  await cleanupTestTenants()
  await pool.end()
})

describe('Conteo cíclico scope=all → todo el catálogo activo', () => {
  let client, tenantId, userId
  let warehousePT, warehouseMP
  let pWithStock, pZeroNoLevel, pZeroWithLevel
  let rawMaterial

  beforeAll(async () => {
    const t = await createTenant({ label: 'countall', planSlug: 'owner' })
    tenantId = t.tenant.id
    userId   = t.user.id
    const sess = await loginAs({ slug: t.tenant.slug, email: t.email, password: t.password })
    client = authedClient({ slug: t.tenant.slug, token: sess.token })

    pWithStock     = await createProduct(client, { sku: 'CNT-STK' })
    pZeroNoLevel   = await createProduct(client, { sku: 'CNT-ZERO' })   // el caso del bug
    pZeroWithLevel = await createProduct(client, { sku: 'CNT-LVL' })
    rawMaterial    = await createRawMaterial(client, { name: 'Resina CNT MP' })

    const whPT = await withBypass(() => query(
      `INSERT INTO warehouses (tenant_id, name, type, description, is_active)
       VALUES ($1, 'PT distribución', 'finished_product', 'fixture', true) RETURNING id`,
      [tenantId]
    ))
    warehousePT = whPT.rows[0].id

    const whMP = await withBypass(() => query(
      `INSERT INTO warehouses (tenant_id, name, type, description, is_active)
       VALUES ($1, 'MP test', 'raw_material', 'fixture', true) RETURNING id`,
      [tenantId]
    ))
    warehouseMP = whMP.rows[0].id

    // pWithStock: +5 piezas en el almacén PT
    await withTransaction((c) => inventoryService.recordMovement(c, {
      tenantId, warehouseId: warehousePT, itemType: 'product', itemId: pWithStock.id,
      movementType: 'adjustment_in', quantity: 5, unit: 'pza', unitCost: 12,
      statusTo: 'available', notes: 'fixture stock', createdBy: userId,
    }))

    // pZeroWithLevel: nivel configurado, SIN existencia
    await withBypass(() => query(
      `INSERT INTO inventory_levels (tenant_id, item_type, item_id, warehouse_id, min_stock, reorder_point)
       VALUES ($1, 'product', $2, $3, 10, 5)`,
      [tenantId, pZeroWithLevel.id, warehousePT]
    ))
  })

  test('scope=all incluye TODOS los productos activos (con stock, cero sin nivel, cero con nivel)', async () => {
    const count = await inventoryCountService.createCount({
      tenantId, countType: 'cyclic', warehouseId: warehousePT,
      scope: 'all', userId,
    })

    const byId = new Map(count.lines.map(l => [l.item_id, l]))

    // El caso del bug: producto en cero SIN nivel configurado → antes no salía.
    expect(byId.has(pZeroNoLevel.id)).toBe(true)
    expect(parseFloat(byId.get(pZeroNoLevel.id).system_qty)).toBe(0)

    // Producto con existencia conserva su cantidad de sistema.
    expect(byId.has(pWithStock.id)).toBe(true)
    expect(parseFloat(byId.get(pWithStock.id).system_qty)).toBe(5)

    // Producto en cero con nivel configurado también está.
    expect(byId.has(pZeroWithLevel.id)).toBe(true)

    // Sin duplicados (UNIQUE count_id+item+warehouse): cada producto aparece 1 vez.
    const productLines = count.lines.filter(l => l.item_type === 'product')
    const uniqueIds = new Set(productLines.map(l => l.item_id))
    expect(productLines.length).toBe(uniqueIds.size)

    // Todas las líneas son del almacén PT del conteo.
    for (const l of count.lines) expect(l.warehouse_id).toBe(warehousePT)
  })

  test('scope=with_stock trae SOLO los items con existencia > 0', async () => {
    const count = await inventoryCountService.createCount({
      tenantId, countType: 'cyclic', warehouseId: warehousePT,
      scope: 'with_stock', userId,
    })
    const ids = new Set(count.lines.map(l => l.item_id))
    expect(ids.has(pWithStock.id)).toBe(true)
    expect(ids.has(pZeroNoLevel.id)).toBe(false)
    expect(ids.has(pZeroWithLevel.id)).toBe(false)
  })

  test('scope=all en almacén de MP incluye materias primas y NO productos terminados', async () => {
    const count = await inventoryCountService.createCount({
      tenantId, countType: 'cyclic', warehouseId: warehouseMP,
      scope: 'all', userId,
    })
    const ids = new Set(count.lines.map(l => l.item_id))
    // El catálogo expandido es de materias primas (mapeo por tipo de almacén).
    expect(ids.has(rawMaterial.id)).toBe(true)
    expect(count.lines.every(l => l.item_type === 'raw_material')).toBe(true)
    // Ningún producto terminado se cuela en un almacén de MP.
    expect(ids.has(pWithStock.id)).toBe(false)
    expect(ids.has(pZeroNoLevel.id)).toBe(false)
  })
})
