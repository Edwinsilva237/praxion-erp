'use strict'

/**
 * Reposición en especie (mig 240): el proveedor repone el material devuelto
 * con material bueno — sin nota de crédito, la factura original sigue vigente.
 *
 * Flujo probado:
 *   OC → recepción original (entra stock) → devolución con "espera reposición"
 *   (sale stock) → aparece en pending-replacement → recepción CONTRA la
 *   devolución (entra stock al costo original) → cobertura por línea → al
 *   completarse, la devolución se resuelve como 'replacement' sin tocar CxP.
 *
 * Candados: OC+devolución a la vez (400), devolución sin marcar (400),
 * remisión-CxP sobre una reposición (409), cancelar una devolución con
 * reposición recibida (400), exclusión del filtro "sin factura".
 */

const { pool, query, withBypass } = require('../../src/db')
const purchaseOrderService   = require('../../src/modules/purchases/purchaseOrderService')
const supplierReceiptService = require('../../src/modules/purchases/supplierReceiptService')
const supplierReturnService  = require('../../src/modules/purchases/supplierReturnService')
const supplierInvoiceService = require('../../src/modules/purchases/supplierInvoiceService')
const { createTenant, cleanupTestTenants } = require('../helpers/factory')

let tenantId, userId, supplierId, rmId, warehouseId

beforeAll(async () => {
  const t = await createTenant({ label: 'reposicion', planSlug: 'owner' })
  tenantId = t.tenant.id
  userId   = t.user.id
  const { rows: sup } = await withBypass(() => query(
    `INSERT INTO business_partners (tenant_id, type, name) VALUES ($1,'supplier','Prov Reposicion') RETURNING id`,
    [tenantId]
  ))
  supplierId = sup[0].id
  const { rows: rm } = await withBypass(() => query(
    `INSERT INTO raw_materials (tenant_id, name, unit) VALUES ($1,'Resina Repuesta','kg') RETURNING id`,
    [tenantId]
  ))
  rmId = rm[0].id
  const { rows: wh } = await withBypass(() => query(
    `SELECT id FROM warehouses WHERE tenant_id = $1 ORDER BY created_at LIMIT 1`, [tenantId]
  ))
  warehouseId = wh[0].id
})

afterAll(async () => { await cleanupTestTenants(); await pool.end() })

async function stockQty() {
  const { rows } = await withBypass(() => query(
    `SELECT COALESCE(SUM(quantity), 0) AS q FROM inventory_stock
      WHERE tenant_id = $1 AND item_type = 'raw_material' AND item_id = $2 AND warehouse_id = $3`,
    [tenantId, rmId, warehouseId]
  ))
  return parseFloat(rows[0].q)
}

/** OC confirmada + recepción original confirmada de `qty` kg a $20. */
async function receiveOriginal(qty) {
  const oc = await purchaseOrderService.createOrder({
    tenantId, partnerId: supplierId, currency: 'MXN', userId,
    lines: [{ itemType: 'raw_material', itemId: rmId, quantity: qty, unit: 'kg', unitPrice: 20, warehouseId }],
  })
  await purchaseOrderService.confirmOrder({ tenantId, orderId: oc.id, userId })
  const full = await purchaseOrderService.getOrder({ tenantId, orderId: oc.id })
  const receipt = await supplierReceiptService.createReceipt({
    tenantId, purchaseOrderId: oc.id, partnerId: supplierId, warehouseId, userId,
    lines: [{
      purchaseOrderLineId: full.lines[0].id, itemType: 'raw_material', itemId: rmId,
      quantityReceived: qty, unit: 'kg', unitPrice: 20, warehouseId,
    }],
  })
  await supplierReceiptService.confirmReceipt({ tenantId, receiptId: receipt.id, userId })
  const det = await supplierReceiptService.getReceipt({ tenantId, receiptId: receipt.id })
  return { receipt: det, receiptLineId: det.lines[0].id }
}

/** Devolución confirmada de `qty` kg contra la línea de recepción, con reposición esperada. */
async function makeReturn(qty, receiptLineId, { replacementExpected = true } = {}) {
  const ret = await supplierReturnService.createReturn({
    tenantId, partnerId: supplierId, userId, replacementExpected,
    lines: [{
      itemType: 'raw_material', itemId: rmId, warehouseId,
      quantity: qty, unit: 'kg', sourceReceiptLineId: receiptLineId,
    }],
  })
  await supplierReturnService.confirmReturn({ tenantId, returnId: ret.id, userId })
  return supplierReturnService.getReturn({ tenantId, returnId: ret.id })
}

test('flujo completo: devolución con reposición → recepción contra la devolución → resuelta', async () => {
  const { receiptLineId } = await receiveOriginal(100)
  const stockAfterOriginal = await stockQty()

  const ret = await makeReturn(40, receiptLineId)
  expect(ret.replacement_expected).toBe(true)
  expect(ret.credit_status).toBe('pending')
  expect(await stockQty()).toBeCloseTo(stockAfterOriginal - 40, 3)

  // Aparece como pendiente de reposición, con costo original y pendiente 40.
  const pending = await supplierReturnService.listPendingReplacements({ tenantId })
  const mine = pending.find(p => p.id === ret.id)
  expect(mine).toBeTruthy()
  expect(parseFloat(mine.lines[0].pending)).toBeCloseTo(40, 3)
  expect(parseFloat(mine.lines[0].unitCost)).toBeCloseTo(20, 2)
  expect(mine.lines[0].sourceReceipt).toBeTruthy() // traza a la recepción original

  // Recepción de la reposición CONTRA la devolución (sin OC).
  const repl = await supplierReceiptService.createReceipt({
    tenantId, replacementReturnId: ret.id, warehouseId, userId,
    documentType: 'remision', documentNumber: 'R-REPO-1',
    lines: [{ itemType: 'raw_material', itemId: rmId, quantityReceived: 40, unit: 'kg', unitPrice: 20, warehouseId }],
  })
  expect(repl.replacement_return_id).toBe(ret.id)
  expect(repl.partner_id).toBe(supplierId) // proveedor resuelto desde la devolución

  await supplierReceiptService.confirmReceipt({ tenantId, receiptId: repl.id, userId })

  // Inventario restaurado al nivel original.
  expect(await stockQty()).toBeCloseTo(stockAfterOriginal, 3)

  // La devolución quedó cubierta y resuelta como reposición.
  const after = await supplierReturnService.getReturn({ tenantId, returnId: ret.id })
  expect(parseFloat(after.lines[0].quantity_replaced)).toBeCloseTo(40, 3)
  expect(after.replacement_completed_at).toBeTruthy()
  expect(after.fiscal_resolution).toBe('replacement')
  expect(after.credit_status).toBe('resolved')
  expect(after.replacement_receipts.map(r => r.receipt_number)).toContain(repl.receipt_number)

  // El detalle de la recepción trae la cadena de auditoría (DEV + origen).
  const replDet = await supplierReceiptService.getReceipt({ tenantId, receiptId: repl.id })
  expect(replDet.replacement_return_number).toBe(ret.return_number)
  expect(replDet.replacement_origin[0].source_receipt_number).toBeTruthy()

  // Y ya no aparece en pendientes de reposición.
  const pendingAfter = await supplierReturnService.listPendingReplacements({ tenantId })
  expect(pendingAfter.find(p => p.id === ret.id)).toBeUndefined()

  // La reposición NO cuenta como "sin factura" y NO puede generar CxP-remisión.
  const { data: sinFactura } = await supplierReceiptService.listReceipts({
    tenantId, invoiceStatus: 'pending', limit: 100,
  })
  expect(sinFactura.find(r => r.id === repl.id)).toBeUndefined()
  await expect(
    supplierInvoiceService.generateReceiptRemission({ tenantId, receiptId: repl.id, userId })
  ).rejects.toMatchObject({ status: 409 })
})

test('reposición PARCIAL: cubre lo recibido y la devolución sigue pendiente', async () => {
  const { receiptLineId } = await receiveOriginal(50)
  const ret = await makeReturn(30, receiptLineId)

  const r1 = await supplierReceiptService.createReceipt({
    tenantId, replacementReturnId: ret.id, warehouseId, userId,
    lines: [{ itemType: 'raw_material', itemId: rmId, quantityReceived: 10, unit: 'kg', unitPrice: 20, warehouseId }],
  })
  await supplierReceiptService.confirmReceipt({ tenantId, receiptId: r1.id, userId })

  let mid = await supplierReturnService.getReturn({ tenantId, returnId: ret.id })
  expect(parseFloat(mid.lines[0].quantity_replaced)).toBeCloseTo(10, 3)
  expect(mid.replacement_completed_at).toBeNull()
  expect(mid.credit_status).toBe('pending')

  const r2 = await supplierReceiptService.createReceipt({
    tenantId, replacementReturnId: ret.id, warehouseId, userId,
    lines: [{ itemType: 'raw_material', itemId: rmId, quantityReceived: 20, unit: 'kg', unitPrice: 20, warehouseId }],
  })
  await supplierReceiptService.confirmReceipt({ tenantId, receiptId: r2.id, userId })

  const done = await supplierReturnService.getReturn({ tenantId, returnId: ret.id })
  expect(parseFloat(done.lines[0].quantity_replaced)).toBeCloseTo(30, 3)
  expect(done.replacement_completed_at).toBeTruthy()
  expect(done.fiscal_resolution).toBe('replacement')
  expect(done.replacement_receipts).toHaveLength(2)
})

test('candados: OC+devolución a la vez, devolución sin marcar, cancelar con reposición recibida', async () => {
  const { receiptLineId } = await receiveOriginal(30)

  // Devolución SIN marcar reposición → la recepción contra ella se rechaza.
  const noRepl = await makeReturn(10, receiptLineId, { replacementExpected: false })
  await expect(
    supplierReceiptService.createReceipt({
      tenantId, replacementReturnId: noRepl.id, warehouseId, userId,
      lines: [{ itemType: 'raw_material', itemId: rmId, quantityReceived: 10, unit: 'kg', unitPrice: 20, warehouseId }],
    })
  ).rejects.toMatchObject({ status: 400 })

  // Marcarla después con el toggle sí la habilita.
  await supplierReturnService.setReplacementExpected({ tenantId, returnId: noRepl.id, expected: true, userId })

  // OC y devolución a la vez → 400.
  const oc = await purchaseOrderService.createOrder({
    tenantId, partnerId: supplierId, currency: 'MXN', userId,
    lines: [{ itemType: 'raw_material', itemId: rmId, quantity: 5, unit: 'kg', unitPrice: 20, warehouseId }],
  })
  await expect(
    supplierReceiptService.createReceipt({
      tenantId, purchaseOrderId: oc.id, replacementReturnId: noRepl.id, warehouseId, userId,
      lines: [{ itemType: 'raw_material', itemId: rmId, quantityReceived: 5, unit: 'kg', unitPrice: 20, warehouseId }],
    })
  ).rejects.toMatchObject({ status: 400 })

  // Recibir la reposición y luego intentar CANCELAR la devolución → 400.
  const repl = await supplierReceiptService.createReceipt({
    tenantId, replacementReturnId: noRepl.id, warehouseId, userId,
    lines: [{ itemType: 'raw_material', itemId: rmId, quantityReceived: 10, unit: 'kg', unitPrice: 20, warehouseId }],
  })
  await supplierReceiptService.confirmReceipt({ tenantId, receiptId: repl.id, userId })
  await expect(
    supplierReturnService.cancelReturn({ tenantId, returnId: noRepl.id, userId })
  ).rejects.toMatchObject({ status: 400 })
})
