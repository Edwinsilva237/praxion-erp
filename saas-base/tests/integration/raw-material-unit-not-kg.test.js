'use strict'

/**
 * Materias primas con unidad distinta de kg.
 *
 * La unidad se elige POR MATERIAL en su catálogo (`raw_materials.unit`: kg,
 * ton, lt, pza, m, rollo), pero varias pantallas de inventario la ignoraban y
 * etiquetaban "kg" a todo lo que fuera materia prima. Solo se notaba mientras
 * el material NO tenía existencia: en cuanto hay saldo, la unidad viaja en la
 * fila de inventario y se mostraba bien.
 *
 * Aquí se fija que un material dado de alta en LITROS diga "lt" desde el
 * catálogo: en existencias por almacén, en la hoja de conteo, en el buscador de
 * artículos y en un ajuste de inventario que no manda unidad.
 */

const { createTenant, cleanupTestTenants } = require('../helpers/factory')
const { pool, query, withBypass } = require('../../src/db')
const levels = require('../../src/modules/inventory/inventoryLevelsService')
const inventoryService = require('../../src/modules/inventory/inventoryService')
const inventoryCountService = require('../../src/modules/inventory/inventoryCountService')

let ctx

afterAll(async () => { await cleanupTestTenants(); await pool.end() })

beforeAll(async () => {
  const info = await createTenant({ label: 'unidad-lt', planSlug: 'owner' })
  const tenantId = info.tenant.id

  ctx = await withBypass(async () => {
    const { rows: w } = await query(
      `INSERT INTO warehouses (tenant_id, name, type, is_active)
       VALUES ($1,'MP Unidad','raw_material',true) RETURNING id`, [tenantId])
    // Un material en LITROS y otro en kg, para contrastar.
    const { rows: lt } = await query(
      `INSERT INTO raw_materials (tenant_id, name, unit, is_active)
       VALUES ($1,'Solvente Litros','lt',true) RETURNING id`, [tenantId])
    const { rows: kg } = await query(
      `INSERT INTO raw_materials (tenant_id, name, unit, is_active)
       VALUES ($1,'Resina Kilos','kg',true) RETURNING id`, [tenantId])
    // Nivel mínimo configurado pero SIN existencia: es el caso que fallaba.
    await query(
      `INSERT INTO inventory_levels (tenant_id, warehouse_id, item_type, item_id, min_stock)
       VALUES ($1,$2,'raw_material',$3,10)`, [tenantId, w[0].id, lt[0].id])

    return { tenantId, warehouseId: w[0].id, ltId: lt[0].id, kgId: kg[0].id, userId: info.user.id }
  })
})

test('las existencias por almacén usan la unidad del material, no "kg"', async () => {
  const res = await withBypass(() => levels.getLevelsByItem({
    tenantId: ctx.tenantId, itemType: 'raw_material', itemId: ctx.ltId }))

  expect(res.levels.length).toBeGreaterThan(0)
  // Sin existencia todavía: la unidad tiene que salir del catálogo.
  expect(res.levels[0].current_stock).toBe('0')
  expect(res.levels[0].unit).toBe('lt')
})

test('el buscador de artículos ofrece el material en su unidad', async () => {
  const found = await withBypass(() => inventoryService.searchItems({
    tenantId: ctx.tenantId, q: 'Solvente' }))
  const item = found.find(i => i.name === 'Solvente Litros')

  expect(item).toBeTruthy()
  expect(item.unit).toBe('lt')
})

test('un ajuste sin unidad explícita registra el movimiento en litros', async () => {
  await withBypass(() => inventoryService.createAdjustmentDocument({
    tenantId: ctx.tenantId, warehouseId: ctx.warehouseId,
    reason: 'Carga inicial', notes: 'prueba de unidad',
    userId: ctx.userId,
    lines: [{ itemType: 'raw_material', itemId: ctx.ltId, direction: 'in',
              quantity: 40, unitCost: 12, notes: 'carga' }],   // ← sin `unit` a propósito
  }))

  const { rows } = await withBypass(() => query(
    `SELECT unit, quantity FROM inventory_stock
      WHERE tenant_id = $1 AND item_id = $2 AND status = 'available'`,
    [ctx.tenantId, ctx.ltId]))

  expect(rows[0].unit).toBe('lt')
  expect(parseFloat(rows[0].quantity)).toBeCloseTo(40, 3)
})

test('el material en kg no cambió de comportamiento', async () => {
  const found = await withBypass(() => inventoryService.searchItems({
    tenantId: ctx.tenantId, q: 'Resina' }))
  expect(found.find(i => i.name === 'Resina Kilos').unit).toBe('kg')
})

test('la hoja de conteo lista cada material en su unidad', async () => {
  // scope='all' arma la hoja con TODO el catálogo activo — incluyendo el
  // material que aún no tiene existencia, que era justo el que salía en "kg".
  const count = await withBypass(() => inventoryCountService.createCount({
    tenantId: ctx.tenantId, countType: 'cyclic', warehouseId: ctx.warehouseId,
    scope: 'all', userId: ctx.userId,
  }))
  const byId = new Map(count.lines.map(l => [l.item_id, l]))

  expect(byId.get(ctx.ltId).unit).toBe('lt')
  expect(byId.get(ctx.kgId).unit).toBe('kg')
})
