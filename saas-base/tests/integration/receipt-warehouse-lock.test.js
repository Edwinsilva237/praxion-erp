'use strict'

/**
 * Candado de almacén en recepciones contra OC (2026-08-01).
 *
 * Caso real: la OC destinaba la mercancía a un almacén, pero al recibir se
 * eligió otro a mano ("Fábrica" vs "Distribución") y el inventario quedó
 * repartido. Regla: cada línea ligada a un renglón de OC debe entrar al
 * almacén de ESE renglón; `warehouseOverride:true` (la ruta valida el permiso
 * warehouses:update) permite la excepción consciente y queda auditada.
 */

const { pool, query, withBypass } = require('../../src/db')
const purchaseOrderService   = require('../../src/modules/purchases/purchaseOrderService')
const supplierReceiptService = require('../../src/modules/purchases/supplierReceiptService')
const { createTenant, cleanupTestTenants } = require('../helpers/factory')

let tenantId, userId, supplierId, rmId, whA, whB

beforeAll(async () => {
  const t = await createTenant({ label: 'whlock', planSlug: 'owner' })
  tenantId = t.tenant.id
  userId   = t.user.id
  const { rows: sup } = await withBypass(() => query(
    `INSERT INTO business_partners (tenant_id, type, name) VALUES ($1,'supplier','Prov Candado') RETURNING id`,
    [tenantId]
  ))
  supplierId = sup[0].id
  const { rows: rm } = await withBypass(() => query(
    `INSERT INTO raw_materials (tenant_id, name) VALUES ($1,'Resina Candado') RETURNING id`,
    [tenantId]
  ))
  rmId = rm[0].id
  const { rows: wh } = await withBypass(() => query(
    `SELECT id FROM warehouses WHERE tenant_id = $1 ORDER BY created_at LIMIT 1`, [tenantId]
  ))
  whA = wh[0].id
  // Segundo almacén del mismo tipo que el primero (el "equivocado").
  const { rows: wh2 } = await withBypass(() => query(
    `INSERT INTO warehouses (tenant_id, name, type)
     SELECT tenant_id, 'Almacén Distribución', type FROM warehouses WHERE id = $1
     RETURNING id`, [whA]
  ))
  whB = wh2[0].id
})

afterAll(async () => { await cleanupTestTenants(); await pool.end() })

/** OC confirmada con una línea destinada al almacén A. */
async function makeOrder() {
  const oc = await purchaseOrderService.createOrder({
    tenantId, partnerId: supplierId, currency: 'MXN', userId,
    lines: [{ itemType: 'raw_material', itemId: rmId, quantity: 100, unit: 'kg', unitPrice: 20, warehouseId: whA }],
  })
  await purchaseOrderService.confirmOrder({ tenantId, orderId: oc.id, userId })
  const full = await purchaseOrderService.getOrder({ tenantId, orderId: oc.id })
  return { orderId: oc.id, lineId: full.lines[0].id }
}

function receiptBody(orderId, lineId, warehouseId, extra = {}) {
  return {
    tenantId, purchaseOrderId: orderId, partnerId: supplierId, warehouseId, userId,
    lines: [{
      purchaseOrderLineId: lineId, itemType: 'raw_material', itemId: rmId,
      quantityReceived: 100, unit: 'kg', unitPrice: 20, warehouseId,
    }],
    ...extra,
  }
}

test('recibir en un almacén DISTINTO al de la OC → 409 con mensaje claro', async () => {
  const { orderId, lineId } = await makeOrder()
  await expect(
    supplierReceiptService.createReceipt(receiptBody(orderId, lineId, whB))
  ).rejects.toMatchObject({ status: 409 })
  await expect(
    supplierReceiptService.createReceipt(receiptBody(orderId, lineId, whB))
  ).rejects.toThrow(/almacén/i)
})

test('recibir en el almacén que dicta la OC → OK', async () => {
  const { orderId, lineId } = await makeOrder()
  const receipt = await supplierReceiptService.createReceipt(receiptBody(orderId, lineId, whA))
  expect(receipt.warehouse_id).toBe(whA)
})

test('con warehouseOverride entra al almacén distinto y queda AUDITADO', async () => {
  const { orderId, lineId } = await makeOrder()
  const receipt = await supplierReceiptService.createReceipt(
    receiptBody(orderId, lineId, whB, { warehouseOverride: true })
  )
  expect(receipt.warehouse_id).toBe(whB)

  const { rows: audits } = await withBypass(() => query(
    `SELECT payload FROM audit_logs
      WHERE tenant_id = $1 AND action = 'supplier_receipt.created'
        AND resource_id = $2`,
    [tenantId, receipt.id]
  ))
  expect(audits).toHaveLength(1)
  expect(audits[0].payload.warehouseOverridden).toBe(true)
})

test('editar un borrador cambiándolo a un almacén distinto al de la OC → 409; con override pasa', async () => {
  const { orderId, lineId } = await makeOrder()
  const receipt = await supplierReceiptService.createReceipt(receiptBody(orderId, lineId, whA))

  const editBody = {
    tenantId, receiptId: receipt.id, warehouseId: whB, userId,
    lines: [{
      purchaseOrderLineId: lineId, itemType: 'raw_material', itemId: rmId,
      quantityReceived: 100, unit: 'kg', unitPrice: 20, warehouseId: whB,
    }],
  }
  await expect(supplierReceiptService.updateReceipt(editBody))
    .rejects.toMatchObject({ status: 409 })

  const updated = await supplierReceiptService.updateReceipt({ ...editBody, warehouseOverride: true })
  expect(updated.warehouse_id).toBe(whB)
})

test('recepción SIN OC (proveedor genérico) no aplica candado', async () => {
  const receipt = await supplierReceiptService.createReceipt({
    tenantId, genericSupplier: 'Proveedor suelto', warehouseId: whB, userId,
    lines: [{ itemType: 'raw_material', itemId: rmId, quantityReceived: 5, unit: 'kg', unitPrice: 20, warehouseId: whB }],
  })
  expect(receipt.warehouse_id).toBe(whB)
})
