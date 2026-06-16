'use strict'

/**
 * Detalle por línea en la OC (mig 207): clave/concepto del proveedor + nota.
 *
 * - `supplier_sku` (clave del proveedor) se guarda en la línea, se imprime en el
 *   PDF y se RECUERDA en supplier_prices (auto-aprende → la próxima OC la precarga).
 * - `notes` (detalle de ESTA OC) ya existía en la columna; ahora el form la manda.
 */

const { pool, query, withBypass, withTransaction } = require('../../src/db')
const purchaseOrderService = require('../../src/modules/purchases/purchaseOrderService')
const supplierPriceService = require('../../src/modules/purchases/supplierPriceService')
const purchaseOrderPdfService = require('../../src/modules/purchases/purchaseOrderPdfService')
const { createTenant, cleanupTestTenants } = require('../helpers/factory')

let tenantId, userId, supplierId, rmId, warehouseId

async function makeSupplier(name) {
  const { rows } = await withBypass(() => query(
    `INSERT INTO business_partners (tenant_id, type, name) VALUES ($1,'supplier',$2) RETURNING id`,
    [tenantId, name]
  ))
  return rows[0].id
}
async function makeRawMaterial(name) {
  const { rows } = await withBypass(() => query(
    `INSERT INTO raw_materials (tenant_id, name) VALUES ($1,$2) RETURNING id`,
    [tenantId, name]
  ))
  return rows[0].id
}

beforeAll(async () => {
  const t = await createTenant({ label: 'oclinedetail', planSlug: 'owner' })
  tenantId = t.tenant.id
  userId   = t.user.id
  supplierId = await makeSupplier('Proveedor Detalle')
  rmId       = await makeRawMaterial('Resina Detalle')
  const { rows: wh } = await withBypass(() => query(
    `SELECT id FROM warehouses WHERE tenant_id = $1 ORDER BY created_at LIMIT 1`, [tenantId]
  ))
  warehouseId = wh[0].id
})

afterAll(async () => { await cleanupTestTenants(); await pool.end() })

test('createOrder guarda supplier_sku + notes por línea y getOrder los devuelve', async () => {
  const oc = await purchaseOrderService.createOrder({
    tenantId, partnerId: supplierId, currency: 'MXN', userId,
    lines: [{
      itemType: 'raw_material', itemId: rmId, quantity: 10, unit: 'kg',
      unitPrice: 25, warehouseId,
      supplierSku: 'PROV-RES-77', notes: 'Color natural, sin pigmento',
    }],
  })
  const full = await purchaseOrderService.getOrder({ tenantId, orderId: oc.id })
  expect(full.lines).toHaveLength(1)
  expect(full.lines[0].supplier_sku).toBe('PROV-RES-77')
  expect(full.lines[0].notes).toBe('Color natural, sin pigmento')
})

test('la clave del proveedor se RECUERDA → la sugerencia la devuelve (auto-aprendizaje)', async () => {
  const s = await supplierPriceService.getSuggestedSupplierPrice({
    tenantId, supplierId, itemType: 'raw_material', itemId: rmId,
  })
  expect(s.supplierSku).toBe('PROV-RES-77')
  expect(s.unit_price).toBe(25)
})

test('una 2ª OC SIN clave NO borra la clave aprendida (COALESCE)', async () => {
  await purchaseOrderService.createOrder({
    tenantId, partnerId: supplierId, currency: 'MXN', userId,
    lines: [{ itemType: 'raw_material', itemId: rmId, quantity: 3, unit: 'kg', unitPrice: 26, warehouseId }],
  })
  const s = await supplierPriceService.getSuggestedSupplierPrice({
    tenantId, supplierId, itemType: 'raw_material', itemId: rmId,
  })
  expect(s.supplierSku).toBe('PROV-RES-77')  // se conservó
  expect(s.unit_price).toBe(26)              // el precio sí se actualizó
})

test('addOrderLine acepta supplier_sku + notes', async () => {
  const oc = await purchaseOrderService.createOrder({
    tenantId, partnerId: supplierId, currency: 'MXN', userId,
    lines: [{ itemType: 'raw_material', itemId: rmId, quantity: 1, unit: 'kg', unitPrice: 10, warehouseId }],
  })
  const line = await purchaseOrderService.addOrderLine({
    tenantId, orderId: oc.id, itemType: 'raw_material', itemId: rmId,
    quantity: 2, unit: 'kg', unitPrice: 11, warehouseId,
    supplierSku: 'PROV-RES-99', notes: 'Tarima de 1 ton', userId,
  })
  expect(line.supplier_sku).toBe('PROV-RES-99')
  expect(line.notes).toBe('Tarima de 1 ton')
})

test('updateOrderLine fija y LIMPIA la nota / clave (centinela undefined vs string)', async () => {
  const oc = await purchaseOrderService.createOrder({
    tenantId, partnerId: supplierId, currency: 'MXN', userId,
    lines: [{
      itemType: 'raw_material', itemId: rmId, quantity: 1, unit: 'kg', unitPrice: 10, warehouseId,
      supplierSku: 'A-1', notes: 'nota vieja',
    }],
  })
  const full = await purchaseOrderService.getOrder({ tenantId, orderId: oc.id })
  const lineId = full.lines[0].id

  // Cambia la clave, no toca la nota (no se manda) → la nota se conserva.
  await purchaseOrderService.updateOrderLine({
    tenantId, orderId: oc.id, lineId, supplierSku: 'A-2',
  })
  let l = (await purchaseOrderService.getOrder({ tenantId, orderId: oc.id })).lines[0]
  expect(l.supplier_sku).toBe('A-2')
  expect(l.notes).toBe('nota vieja')

  // Manda notes='' explícito → se limpia.
  await purchaseOrderService.updateOrderLine({
    tenantId, orderId: oc.id, lineId, notes: '',
  })
  l = (await purchaseOrderService.getOrder({ tenantId, orderId: oc.id })).lines[0]
  expect(l.notes).toBeNull()
  expect(l.supplier_sku).toBe('A-2')  // intacta
})

test('el PDF se genera con la clave/nota por línea (smoke, no truena)', async () => {
  const oc = await purchaseOrderService.createOrder({
    tenantId, partnerId: supplierId, currency: 'MXN', userId,
    lines: [{
      itemType: 'raw_material', itemId: rmId, quantity: 4, unit: 'kg', unitPrice: 12, warehouseId,
      supplierSku: 'PROV-PDF-01', notes: 'Detalle largo para forzar el alto de fila dinámico en el PDF',
    }],
  })
  const buf = await purchaseOrderPdfService.generatePurchaseOrderPDF({ tenantId, orderId: oc.id })
  expect(Buffer.isBuffer(buf)).toBe(true)
  expect(buf.length).toBeGreaterThan(1000)
})
