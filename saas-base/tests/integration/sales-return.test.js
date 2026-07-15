'use strict'

/**
 * Devoluciones de VENTA (mig 229 + salesReturnService).
 *
 * Cubre: devolución parcial SIN factura (reingresa inventario + baja CXC de la
 * remisión), validación de sobre-devolución, cancelación (revierte inventario +
 * CXC), y el caso CON factura (confirm solo mueve inventario; la nota de crédito
 * se emite aparte y marca credit_status='resolved'). La NC (Facturapi) se mockea.
 */

// La emisión de NC llama a creditNoteService (que timbra en Facturapi) — mock.
jest.mock('../../src/modules/invoicing/creditNoteService', () => ({
  createCreditNote: jest.fn(async () => ({
    id: null, document_number: 'NC-TEST-1', uuid: 'uuid-nc-test', amount: 300, total: 348,
  })),
}))

const { createTenant, loginAs, authedClient, cleanupTestTenants } = require('../helpers/factory')
const { createProduct } = require('../helpers/productionFactory')
const { pool, query, withTransaction, withBypass } = require('../../src/db')
const inventoryService = require('../../src/modules/inventory/inventoryService')
const deliveryNoteService = require('../../src/modules/sales/deliveryNoteService')
const salesReturnService = require('../../src/modules/sales/salesReturnService')
const creditNoteService = require('../../src/modules/invoicing/creditNoteService')

let client, tenantId, userId, warehouseId, partnerId
let seq = 0
const uniq = () => `${Date.now()}-${++seq}`

async function seedStock(productId, qty) {
  await withTransaction((c) => inventoryService.recordMovement(c, {
    tenantId, warehouseId, itemType: 'product', itemId: productId,
    movementType: 'adjustment_in', quantity: qty, unit: 'pieza', unitCost: 5,
    statusTo: 'available', notes: 'seed', createdBy: userId,
  }))
}

async function available(productId) {
  const { rows } = await withBypass(() => query(
    `SELECT COALESCE(SUM(quantity),0) q FROM inventory_stock
      WHERE tenant_id=$1 AND item_type='product' AND item_id=$2 AND status='available'`,
    [tenantId, productId]))
  return parseFloat(rows[0].q)
}

// Crea una remisión EMITIDA y la ENTREGA completa (mueve inventario + CXC).
async function makeDeliveredNote(productId, qty, price = 10) {
  const { rows: dn } = await withBypass(() => query(
    `INSERT INTO delivery_notes
       (tenant_id, type, document_number, partner_id, status, currency, total_mxn, subtotal_mxn, credit_due_date)
     VALUES ($1,'sale',$2,$3,'issued','MXN',$4,$4,CURRENT_DATE) RETURNING id`,
    [tenantId, `REM-${uniq()}`, partnerId, qty * price]))
  const noteId = dn[0].id
  const { rows: dnl } = await withBypass(() => query(
    `INSERT INTO delivery_note_lines
       (delivery_note_id, product_id, quantity_ordered, quantity_delivered,
        unit, unit_price, currency, discount_pct, line_number, pack_factor, quantity_base, warehouse_id)
     VALUES ($1,$2,$3,$3,'pieza',$4,'MXN',0,1,1,$3,$5) RETURNING id`,
    [noteId, productId, qty, price, warehouseId]))
  await deliveryNoteService.recordDelivery({ tenantId, noteId, receiverName: 'Cliente', userId })
  return { noteId, lineId: dnl[0].id }
}

async function arRemission(noteId) {
  const { rows } = await withBypass(() => query(
    `SELECT amount_total, amount_paid, amount_credited, amount_pending, status
       FROM accounts_receivable WHERE tenant_id=$1 AND document_type='remission' AND document_id=$2`,
    [tenantId, noteId]))
  return rows[0]
}

beforeAll(async () => {
  const t = await createTenant({ label: 'salesret', planSlug: 'owner' })
  tenantId = t.tenant.id; userId = t.user.id
  const sess = await loginAs({ slug: t.tenant.slug, email: t.email, password: t.password })
  client = authedClient({ slug: t.tenant.slug, token: sess.token })
  const wh = await withBypass(() => query(
    `INSERT INTO warehouses (tenant_id, name, type, description, is_active)
     VALUES ($1,'PT ret','finished_product','fx',true) RETURNING id`, [tenantId]))
  warehouseId = wh.rows[0].id
  const bp = await withBypass(() => query(
    `INSERT INTO business_partners (tenant_id, type, name) VALUES ($1,'customer','Cliente Ret') RETURNING id`,
    [tenantId]))
  partnerId = bp.rows[0].id
})
afterAll(async () => { await cleanupTestTenants(); await pool.end() })

test('SIN factura: devolución parcial reingresa inventario y baja la CXC de la remisión', async () => {
  const p = await createProduct(client, { sku: `RET-${uniq()}` })
  await seedStock(p.id, 100)
  const { noteId, lineId } = await makeDeliveredNote(p.id, 100, 10)  // entrega 100 → stock 0, CXC 1000
  expect(await available(p.id)).toBeCloseTo(0, 2)

  const ret = await salesReturnService.createReturn({
    tenantId, deliveryNoteId: noteId,
    lines: [{ deliveryNoteLineId: lineId, quantity: 30 }], userId,
  })
  expect(ret.status).toBe('draft')
  expect(ret.credit_status).toBe('not_applicable')   // sin factura
  expect(parseFloat(ret.total_mxn)).toBeCloseTo(300, 2)

  await salesReturnService.confirmReturn({ tenantId, returnId: ret.id, userId })

  expect(await available(p.id)).toBeCloseTo(30, 2)     // reingresaron 30
  const ar = await arRemission(noteId)
  expect(parseFloat(ar.amount_credited)).toBeCloseTo(300, 2)
  expect(parseFloat(ar.amount_pending)).toBeCloseTo(700, 2)
})

test('no se puede devolver más de lo entregado (409)', async () => {
  const p = await createProduct(client, { sku: `RET-${uniq()}` })
  await seedStock(p.id, 40)
  const { noteId, lineId } = await makeDeliveredNote(p.id, 40, 10)
  await expect(
    salesReturnService.createReturn({
      tenantId, deliveryNoteId: noteId,
      lines: [{ deliveryNoteLineId: lineId, quantity: 50 }], userId,
    })
  ).rejects.toMatchObject({ status: 409 })
})

test('cancelar una devolución confirmada revierte inventario y restaura la CXC', async () => {
  const p = await createProduct(client, { sku: `RET-${uniq()}` })
  await seedStock(p.id, 50)
  const { noteId, lineId } = await makeDeliveredNote(p.id, 50, 10)
  const ret = await salesReturnService.createReturn({
    tenantId, deliveryNoteId: noteId,
    lines: [{ deliveryNoteLineId: lineId, quantity: 20 }], userId,
  })
  await salesReturnService.confirmReturn({ tenantId, returnId: ret.id, userId })
  expect(await available(p.id)).toBeCloseTo(20, 2)
  expect(parseFloat((await arRemission(noteId)).amount_credited)).toBeCloseTo(200, 2)

  await salesReturnService.cancelReturn({ tenantId, returnId: ret.id, userId })
  expect(await available(p.id)).toBeCloseTo(0, 2)      // se sacó de nuevo
  expect(parseFloat((await arRemission(noteId)).amount_credited)).toBeCloseTo(0, 2)
})

test('CON factura: confirm solo mueve inventario; la NC se emite aparte y resuelve el crédito', async () => {
  const p = await createProduct(client, { sku: `RET-${uniq()}` })
  await seedStock(p.id, 100)
  const { noteId, lineId } = await makeDeliveredNote(p.id, 100, 10)

  // Factura TIMBRADA que cubre la remisión (liga directa).
  await withBypass(() => query(
    `INSERT INTO invoices (tenant_id, type, document_number, partner_id, status, delivery_note_id, total, total_mxn, cfdi_uuid)
     VALUES ($1,'issued',$2,$3,'stamped',$4,1160,1160,gen_random_uuid())`,
    [tenantId, `F-${uniq()}`, partnerId, noteId]))

  const ret = await salesReturnService.createReturn({
    tenantId, deliveryNoteId: noteId,
    lines: [{ deliveryNoteLineId: lineId, quantity: 30 }], userId,
  })
  expect(ret.source_invoice_id).toBeTruthy()
  expect(ret.credit_status).toBe('pending')            // con factura → NC pendiente

  await salesReturnService.confirmReturn({ tenantId, returnId: ret.id, userId })
  expect(await available(p.id)).toBeCloseTo(30, 2)      // inventario sí regresa
  // Con factura NO se toca la CXC de la remisión aquí.
  const draft = await salesReturnService.getReturn({ tenantId, returnId: ret.id })
  expect(draft.credit_status).toBe('pending')

  const done = await salesReturnService.emitCreditNote({ tenantId, returnId: ret.id, userId })
  expect(creditNoteService.createCreditNote).toHaveBeenCalledWith(
    expect.objectContaining({ invoiceId: ret.source_invoice_id, amount: 300, reason: 'return' })
  )
  expect(done.credit_status).toBe('resolved')
})
