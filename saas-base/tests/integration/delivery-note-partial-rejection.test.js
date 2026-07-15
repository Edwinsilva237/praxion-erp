'use strict'

/**
 * Entrega parcial POR RECHAZO (mig 228 + recordDelivery.deliveredLines).
 *
 * Al registrar la entrega, el usuario puede indicar que el cliente rechazó/no
 * recibió parte de un producto. Entonces:
 *   - se descuenta inventario y se genera CXC SOLO por lo recibido,
 *   - la línea guarda quantity_delivered = recibido + rejection_reason,
 *   - el total de la remisión baja a lo recibido,
 *   - la remisión queda 'delivered' (la diferencia reabre el saldo del pedido).
 * Si NO se indica rechazo, la entrega sigue siendo 100% como siempre.
 */

const { createTenant, loginAs, authedClient, cleanupTestTenants } = require('../helpers/factory')
const { createProduct } = require('../helpers/productionFactory')
const { pool, query, withTransaction, withBypass } = require('../../src/db')
const inventoryService = require('../../src/modules/inventory/inventoryService')
const deliveryNoteService = require('../../src/modules/sales/deliveryNoteService')

let client, tenantId, userId, warehouseId, partnerId
let seq = 0
const uniq = () => `${Date.now()}-${++seq}`

async function seedProductWithStock(qty) {
  const product = await createProduct(client, { sku: `PRJ-${uniq()}` })
  await withTransaction((c) => inventoryService.recordMovement(c, {
    tenantId, warehouseId, itemType: 'product', itemId: product.id,
    movementType: 'adjustment_in', quantity: qty, unit: 'pieza', unitCost: 5,
    statusTo: 'available', notes: 'seed', createdBy: userId,
  }))
  return product
}

async function makeIssuedNote(productId, qty, unitPrice = 10) {
  const { rows: dn } = await withBypass(() => query(
    `INSERT INTO delivery_notes
       (tenant_id, type, document_number, partner_id, status, currency, total_mxn, subtotal_mxn, credit_due_date)
     VALUES ($1,'sale',$2,$3,'issued','MXN',$4,$4,CURRENT_DATE) RETURNING id`,
    [tenantId, `REM-${uniq()}`, partnerId, qty * unitPrice]))
  const noteId = dn[0].id
  const { rows: dnl } = await withBypass(() => query(
    `INSERT INTO delivery_note_lines
       (delivery_note_id, product_id, quantity_ordered, quantity_delivered,
        unit, unit_price, currency, discount_pct, line_number, pack_factor, quantity_base, warehouse_id)
     VALUES ($1,$2,$3,$3,'pieza',$4,'MXN',0,1,1,$3,$5) RETURNING id`,
    [noteId, productId, qty, unitPrice, warehouseId]))
  return { noteId, lineId: dnl[0].id }
}

async function availableStock(productId) {
  const { rows } = await withBypass(() => query(
    `SELECT COALESCE(SUM(quantity),0) AS q FROM inventory_stock
      WHERE tenant_id=$1 AND item_type='product' AND item_id=$2 AND status='available'`,
    [tenantId, productId]))
  return parseFloat(rows[0].q)
}

beforeAll(async () => {
  const t = await createTenant({ label: 'partialrej', planSlug: 'owner' })
  tenantId = t.tenant.id
  userId   = t.user.id
  const sess = await loginAs({ slug: t.tenant.slug, email: t.email, password: t.password })
  client = authedClient({ slug: t.tenant.slug, token: sess.token })

  const wh = await withBypass(() => query(
    `INSERT INTO warehouses (tenant_id, name, type, description, is_active)
     VALUES ($1,'PT rej','finished_product','fixture',true) RETURNING id`, [tenantId]))
  warehouseId = wh.rows[0].id

  const bp = await withBypass(() => query(
    `INSERT INTO business_partners (tenant_id, type, name) VALUES ($1,'customer','Cliente Rechazo') RETURNING id`,
    [tenantId]))
  partnerId = bp.rows[0].id
})
afterAll(async () => { await cleanupTestTenants(); await pool.end() })

test('rechazo parcial: descuenta y factura solo lo recibido; guarda el motivo', async () => {
  const product = await seedProductWithStock(100)
  const { noteId, lineId } = await makeIssuedNote(product.id, 100, 10)  // remisiona 100 @ $10

  const note = await deliveryNoteService.recordDelivery({
    tenantId, noteId, receiverName: 'Almacén cliente', userId,
    deliveredLines: [{ lineId, quantityDelivered: 90, rejectionReason: 'Rechazo por calidad' }],
  })

  // Remisión entregada, total ajustado a lo recibido (90 × 10).
  expect(note.status).toBe('delivered')
  expect(parseFloat(note.total_mxn)).toBeCloseTo(900, 2)

  // Inventario: solo se descontaron 90 → quedan 10.
  expect(await availableStock(product.id)).toBeCloseTo(10, 2)

  // Línea: quantity_delivered=90, quantity_base=90, motivo guardado. Ordenado intacto.
  const { rows: lrows } = await withBypass(() => query(
    `SELECT quantity_ordered, quantity_delivered, quantity_base, rejection_reason, subtotal
       FROM delivery_note_lines WHERE id=$1`, [lineId]))
  const l = lrows[0]
  expect(parseFloat(l.quantity_ordered)).toBeCloseTo(100, 2)
  expect(parseFloat(l.quantity_delivered)).toBeCloseTo(90, 2)
  expect(parseFloat(l.quantity_base)).toBeCloseTo(90, 2)
  expect(l.rejection_reason).toBe('Rechazo por calidad')
  expect(parseFloat(l.subtotal)).toBeCloseTo(900, 2)

  // CXC generada por lo recibido (900).
  const { rows: arRows } = await withBypass(() => query(
    `SELECT amount_total FROM accounts_receivable
      WHERE tenant_id=$1 AND document_type='remission' AND document_id=$2`, [tenantId, noteId]))
  expect(arRows.length).toBe(1)
  expect(parseFloat(arRows[0].amount_total)).toBeCloseTo(900, 2)
})

test('sin rechazo (deliveredLines ausente): entrega 100% como siempre', async () => {
  const product = await seedProductWithStock(50)
  const { noteId, lineId } = await makeIssuedNote(product.id, 50, 10)

  await deliveryNoteService.recordDelivery({ tenantId, noteId, receiverName: 'Receptor', userId })

  expect(await availableStock(product.id)).toBeCloseTo(0, 2)
  const { rows } = await withBypass(() => query(
    `SELECT quantity_delivered, rejection_reason FROM delivery_note_lines WHERE id=$1`, [lineId]))
  expect(parseFloat(rows[0].quantity_delivered)).toBeCloseTo(50, 2)
  expect(rows[0].rejection_reason).toBeNull()
})

test('capturar más de lo remisionado se rechaza (409)', async () => {
  const product = await seedProductWithStock(30)
  const { noteId, lineId } = await makeIssuedNote(product.id, 30, 10)

  await expect(
    deliveryNoteService.recordDelivery({
      tenantId, noteId, receiverName: 'Receptor', userId,
      deliveredLines: [{ lineId, quantityDelivered: 40 }],
    })
  ).rejects.toMatchObject({ status: 409 })
})
