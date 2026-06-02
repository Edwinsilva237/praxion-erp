'use strict'

/**
 * Precios por proveedor (mig 188) — para precargar la OC rápido.
 *
 * Cubre: auto-aprendizaje al crear la OC, prioridad manual > aprendido,
 * fallback al costo estándar del ítem, y el endpoint de sugerencia.
 */

const request = require('supertest')
const app = require('../../src/app')
const { createTenant, loginAs, cleanupTestTenants } = require('../helpers/factory')
const { pool, query, withBypass, withTransaction } = require('../../src/db')
const purchaseOrderService = require('../../src/modules/purchases/purchaseOrderService')
const supplierPriceService = require('../../src/modules/purchases/supplierPriceService')

let tenantId, userId, supplierId, rmId, warehouseId, session, tenant

async function makeSupplier(name = 'Proveedor Test') {
  const { rows } = await withBypass(() => query(
    `INSERT INTO business_partners (tenant_id, type, name) VALUES ($1, 'supplier', $2) RETURNING id`,
    [tenantId, name]
  ))
  return rows[0].id
}
async function makeRawMaterial(name, standardCost = null) {
  const { rows } = await withBypass(() => query(
    `INSERT INTO raw_materials (tenant_id, name, standard_cost) VALUES ($1, $2, $3) RETURNING id`,
    [tenantId, name, standardCost]
  ))
  return rows[0].id
}

beforeAll(async () => {
  tenant = await createTenant({ label: 'supplierprice', planSlug: 'owner' })
  tenantId = tenant.tenant.id
  userId   = tenant.user.id
  session  = await loginAs({ slug: tenant.tenant.slug, email: tenant.email, password: tenant.password })
  supplierId = await makeSupplier()
  rmId       = await makeRawMaterial('Resina X')
  const { rows: wh } = await withBypass(() => query(
    `SELECT id FROM warehouses WHERE tenant_id = $1 ORDER BY created_at LIMIT 1`, [tenantId]
  ))
  warehouseId = wh[0].id
})

afterAll(async () => {
  await cleanupTestTenants()
  await pool.end()
})

test('auto-aprende el precio al crear una OC → la sugerencia lo devuelve (source po)', async () => {
  // Sin precio aún → null (la MP no tiene standard_cost).
  const before = await supplierPriceService.getSuggestedSupplierPrice({
    tenantId, supplierId, itemType: 'raw_material', itemId: rmId,
  })
  expect(before).toBeNull()

  await purchaseOrderService.createOrder({
    tenantId, partnerId: supplierId, currency: 'MXN', userId,
    lines: [{ itemType: 'raw_material', itemId: rmId, quantity: 10, unit: 'kg', unitPrice: 25, warehouseId }],
  })

  const after = await supplierPriceService.getSuggestedSupplierPrice({
    tenantId, supplierId, itemType: 'raw_material', itemId: rmId,
  })
  expect(after.unit_price).toBe(25)
  expect(after.source).toBe('po')
})

test('un precio MANUAL gana sobre el aprendido', async () => {
  await supplierPriceService.upsertManualSupplierPrice({
    tenantId, supplierId, itemType: 'raw_material', itemId: rmId,
    unitPrice: 20, supplierSku: 'PROV-RESINA-01', userId,
  })
  const s = await supplierPriceService.getSuggestedSupplierPrice({
    tenantId, supplierId, itemType: 'raw_material', itemId: rmId,
  })
  expect(s.unit_price).toBe(20)
  expect(s.source).toBe('manual')
  expect(s.supplierSku).toBe('PROV-RESINA-01')
})

test('fallback al costo estándar del ítem cuando no hay precio del proveedor', async () => {
  const otherSupplier = await makeSupplier('Otro Proveedor')
  const rmWithCost = await makeRawMaterial('Pigmento Azul', 12.5)
  const s = await supplierPriceService.getSuggestedSupplierPrice({
    tenantId, supplierId: otherSupplier, itemType: 'raw_material', itemId: rmWithCost,
  })
  expect(s.unit_price).toBe(12.5)
  expect(s.source).toBe('item_cost')
})

test('una 2ª OC del mismo día actualiza el precio aprendido (upsert, sin spamear filas)', async () => {
  const sup = await makeSupplier('Prov Upsert')
  const rm  = await makeRawMaterial('Item Upsert')
  await purchaseOrderService.createOrder({
    tenantId, partnerId: sup, currency: 'MXN', userId,
    lines: [{ itemType: 'raw_material', itemId: rm, quantity: 5, unit: 'kg', unitPrice: 25, warehouseId }],
  })
  await purchaseOrderService.createOrder({
    tenantId, partnerId: sup, currency: 'MXN', userId,
    lines: [{ itemType: 'raw_material', itemId: rm, quantity: 5, unit: 'kg', unitPrice: 30, warehouseId }],
  })
  const s = await supplierPriceService.getSuggestedSupplierPrice({
    tenantId, supplierId: sup, itemType: 'raw_material', itemId: rm,
  })
  expect(s.unit_price).toBe(30)   // el último gana
  expect(s.source).toBe('po')
  const { rows } = await withBypass(() => query(
    `SELECT COUNT(*)::int AS c FROM supplier_prices
      WHERE business_partner_id = $1 AND item_id = $2 AND source = 'po'`, [sup, rm]))
  expect(rows[0].c).toBe(1)        // upsert: una sola fila, no spam
})

test('la recepción aprende el precio REAL (source receipt) y corrige el de la OC', async () => {
  const sup = await makeSupplier('Prov Recep')
  const rm  = await makeRawMaterial('Item Recep')
  await purchaseOrderService.createOrder({
    tenantId, partnerId: sup, currency: 'MXN', userId,
    lines: [{ itemType: 'raw_material', itemId: rm, quantity: 5, unit: 'kg', unitPrice: 25, warehouseId }],
  })
  let s = await supplierPriceService.getSuggestedSupplierPrice({
    tenantId, supplierId: sup, itemType: 'raw_material', itemId: rm,
  })
  expect(s.source).toBe('po')

  // Lo que de verdad llegó (la recepción) fue 27 → corrige.
  await withTransaction(async (client) => {
    await supplierPriceService.learnFromLines(client, {
      tenantId, supplierId: sup, currency: 'MXN', source: 'receipt', userId,
      lines: [{ itemType: 'raw_material', itemId: rm, unitPrice: 27 }],
    })
  })
  s = await supplierPriceService.getSuggestedSupplierPrice({
    tenantId, supplierId: sup, itemType: 'raw_material', itemId: rm,
  })
  expect(s.unit_price).toBe(27)
  expect(s.source).toBe('receipt')
})

test('endpoint GET /api/purchases/suggested-price devuelve la sugerencia', async () => {
  const res = await request(app)
    .get('/api/purchases/suggested-price')
    .query({ supplierId, itemType: 'raw_material', itemId: rmId })
    .set('Authorization', `Bearer ${session.token}`)
    .set('X-Tenant-Slug', tenant.tenant.slug)
    .expect(200)
  expect(res.body.unit_price).toBe(20)   // el manual sigue ganando
  expect(res.body.source).toBe('manual')
})
