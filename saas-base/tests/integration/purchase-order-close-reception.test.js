'use strict'

/**
 * "Dar por completa" una OC de cantidad estimada (materia prima a granel).
 *
 * Caso real: se pide una cantidad estimada (25,000 kg de plástico), pero el
 * embarque real casi nunca cuadra al kilo → la OC quedaría en
 * 'partially_received' para siempre. `closeOrderReception` la pasa a 'closed'
 * aunque lo recibido no alcance lo pedido, sin mover inventario.
 *
 * Cubre: (1) cierre feliz desde partially_received; (2) una recepción confirmada
 * TARDÍA no revive una OC cerrada; (3) no se puede cerrar una OC que no está
 * parcialmente recibida.
 */

const { pool, query, withBypass } = require('../../src/db')
const purchaseOrderService   = require('../../src/modules/purchases/purchaseOrderService')
const supplierReceiptService = require('../../src/modules/purchases/supplierReceiptService')
const { createTenant, cleanupTestTenants } = require('../helpers/factory')

let tenantId, userId, supplierId, rmId, warehouseId

beforeAll(async () => {
  const t = await createTenant({ label: 'occlose', planSlug: 'owner' })
  tenantId = t.tenant.id
  userId   = t.user.id
  const { rows: sup } = await withBypass(() => query(
    `INSERT INTO business_partners (tenant_id, type, name) VALUES ($1,'supplier','Prov Granel') RETURNING id`,
    [tenantId]
  ))
  supplierId = sup[0].id
  const { rows: rm } = await withBypass(() => query(
    `INSERT INTO raw_materials (tenant_id, name) VALUES ($1,'Resina Estimada') RETURNING id`,
    [tenantId]
  ))
  rmId = rm[0].id
  const { rows: wh } = await withBypass(() => query(
    `SELECT id FROM warehouses WHERE tenant_id = $1 ORDER BY created_at LIMIT 1`, [tenantId]
  ))
  warehouseId = wh[0].id
})

afterAll(async () => { await cleanupTestTenants(); await pool.end() })

/** Crea una OC estimada (25,000), la confirma y recibe `qty` real → partially_received. */
async function makePartiallyReceivedOrder(qty) {
  const oc = await purchaseOrderService.createOrder({
    tenantId, partnerId: supplierId, currency: 'MXN', userId,
    lines: [{ itemType: 'raw_material', itemId: rmId, quantity: 25000, unit: 'kg', unitPrice: 20, warehouseId }],
  })
  await purchaseOrderService.confirmOrder({ tenantId, orderId: oc.id, userId })
  const full = await purchaseOrderService.getOrder({ tenantId, orderId: oc.id })
  const lineId = full.lines[0].id

  const receipt = await supplierReceiptService.createReceipt({
    tenantId, purchaseOrderId: oc.id, partnerId: supplierId, warehouseId, userId,
    lines: [{
      purchaseOrderLineId: lineId, itemType: 'raw_material', itemId: rmId,
      quantityReceived: qty, unit: 'kg', unitPrice: 20, warehouseId,
    }],
  })
  await supplierReceiptService.confirmReceipt({ tenantId, receiptId: receipt.id, userId })

  const after = await purchaseOrderService.getOrder({ tenantId, orderId: oc.id })
  expect(after.status).toBe('partially_received')
  return { orderId: oc.id, lineId }
}

test('cierra una OC estimada parcialmente recibida (llega de MENOS) → closed', async () => {
  const { orderId } = await makePartiallyReceivedOrder(24500) // 24,500 de 25,000
  const res = await purchaseOrderService.closeOrderReception({
    tenantId, orderId, reason: 'Embarque completo, era estimada', userId,
  })
  expect(res.status).toBe('closed')

  const oc = await purchaseOrderService.getOrder({ tenantId, orderId })
  expect(oc.status).toBe('closed')

  // Queda registro en la bitácora de status.
  const { rows } = await withBypass(() => query(
    `SELECT to_status, notes FROM document_status_log
      WHERE tenant_id=$1 AND entity_type='purchase_order' AND entity_id=$2
        AND to_status='closed'`,
    [tenantId, orderId]
  ))
  expect(rows).toHaveLength(1)
  expect(rows[0].notes).toBe('Embarque completo, era estimada')
})

test('una recepción confirmada TARDÍA no revive una OC cerrada', async () => {
  const { orderId, lineId } = await makePartiallyReceivedOrder(24000)
  await purchaseOrderService.closeOrderReception({ tenantId, orderId, userId })

  // Llega una recepción rezagada y se confirma → NO debe reabrir la OC.
  const late = await supplierReceiptService.createReceipt({
    tenantId, purchaseOrderId: orderId, partnerId: supplierId, warehouseId, userId,
    lines: [{
      purchaseOrderLineId: lineId, itemType: 'raw_material', itemId: rmId,
      quantityReceived: 300, unit: 'kg', unitPrice: 20, warehouseId,
    }],
  })
  await supplierReceiptService.confirmReceipt({ tenantId, receiptId: late.id, userId })

  const oc = await purchaseOrderService.getOrder({ tenantId, orderId })
  expect(oc.status).toBe('closed') // sigue cerrada
})

test('no se puede cerrar una OC que no está parcialmente recibida (404)', async () => {
  const oc = await purchaseOrderService.createOrder({
    tenantId, partnerId: supplierId, currency: 'MXN', userId,
    lines: [{ itemType: 'raw_material', itemId: rmId, quantity: 100, unit: 'kg', unitPrice: 20, warehouseId }],
  })
  await purchaseOrderService.confirmOrder({ tenantId, orderId: oc.id, userId }) // queda en 'sent'
  await expect(
    purchaseOrderService.closeOrderReception({ tenantId, orderId: oc.id, userId })
  ).rejects.toMatchObject({ status: 404 })
})
