'use strict'

/**
 * Cancelar una remisión YA ENTREGADA revirtiendo inventario (mig 210 +
 * deliveryNoteService.cancelDelivery).
 *
 * Caso real: se entregó una remisión mal hecha y quedó bloqueada (entregar
 * descuenta inventario, lotes y genera la CXC). Ahora cancelarla:
 *   - regresa el stock (adjustment_in) al mismo almacén,
 *   - libera la CXC de la remisión (sin cobros),
 *   - deja la remisión 'cancelled' y reabre los pedidos cubiertos.
 * Guardas: factura activa → 409; CXC con cobro → 409.
 */

const { createTenant, loginAs, authedClient, cleanupTestTenants } = require('../helpers/factory')
const { createProduct } = require('../helpers/productionFactory')
const { pool, query, withTransaction, withBypass } = require('../../src/db')
const inventoryService = require('../../src/modules/inventory/inventoryService')
const deliveryNoteService = require('../../src/modules/sales/deliveryNoteService')

let client, tenantId, userId, warehouseId, partnerId
let seq = 0
const uniq = () => `${Date.now()}-${++seq}`

async function stockOf(productId) {
  const { rows } = await withBypass(() => query(
    `SELECT COALESCE(SUM(quantity), 0)::numeric AS q
       FROM inventory_stock
      WHERE tenant_id=$1 AND warehouse_id=$2 AND item_type='product' AND item_id=$3`,
    [tenantId, warehouseId, productId]))
  return parseFloat(rows[0].q)
}

async function arForNote(noteId) {
  const { rows } = await withBypass(() => query(
    `SELECT id, amount_paid FROM accounts_receivable
      WHERE tenant_id=$1 AND document_type='remission' AND document_id=$2`,
    [tenantId, noteId]))
  return rows[0] || null
}

// Crea un producto con 100 de stock, una remisión 'issued' con 1 línea, y la entrega.
async function seedDeliveredNote({ qty = 10 } = {}) {
  const product = await createProduct(client, { sku: `CANC-${uniq()}` })
  // Sembrar 100 de existencia.
  await withTransaction((c) => inventoryService.recordMovement(c, {
    tenantId, warehouseId, itemType: 'product', itemId: product.id,
    movementType: 'adjustment_in', quantity: 100, unit: 'pieza', unitCost: 5,
    statusTo: 'available', notes: 'seed', createdBy: userId,
  }))

  const { rows: dn } = await withBypass(() => query(
    `INSERT INTO delivery_notes
       (tenant_id, type, document_number, partner_id, status, currency, total_mxn, credit_due_date)
     VALUES ($1,'sale',$2,$3,'issued','MXN',$4,CURRENT_DATE) RETURNING id`,
    [tenantId, `REM-${uniq()}`, partnerId, qty * 10]))
  const noteId = dn[0].id
  await withBypass(() => query(
    `INSERT INTO delivery_note_lines
       (delivery_note_id, product_id, quantity_ordered, quantity_delivered,
        unit, unit_price, currency, discount_pct, line_number, pack_factor, quantity_base, warehouse_id)
     VALUES ($1,$2,$3,$3,'pieza',10,'MXN',0,1,1,$3,$4)`,
    [noteId, product.id, qty, warehouseId]))

  await deliveryNoteService.recordDelivery({
    tenantId, noteId, receiverName: 'Receptor Test', userId,
  })
  return { noteId, productId: product.id, qty }
}

beforeAll(async () => {
  const t = await createTenant({ label: 'cancelrev', planSlug: 'owner' })
  tenantId = t.tenant.id
  userId   = t.user.id
  const sess = await loginAs({ slug: t.tenant.slug, email: t.email, password: t.password })
  client = authedClient({ slug: t.tenant.slug, token: sess.token })

  const wh = await withBypass(() => query(
    `INSERT INTO warehouses (tenant_id, name, type, description, is_active)
     VALUES ($1,'PT cancel','finished_product','fixture',true) RETURNING id`, [tenantId]))
  warehouseId = wh.rows[0].id

  const bp = await withBypass(() => query(
    `INSERT INTO business_partners (tenant_id, type, name) VALUES ($1,'customer','Cliente Cancel') RETURNING id`,
    [tenantId]))
  partnerId = bp.rows[0].id
})
afterAll(async () => { await cleanupTestTenants(); await pool.end() })

test('entregar descuenta stock y crea la CXC; cancelar lo REVIERTE todo', async () => {
  const { noteId, productId } = await seedDeliveredNote({ qty: 10 })

  // Tras entregar: stock 100 - 10 = 90, CXC de remisión creada.
  expect(await stockOf(productId)).toBe(90)
  expect(await arForNote(noteId)).toBeTruthy()

  const r = await deliveryNoteService.cancelDelivery({ tenantId, noteId, reason: 'mal hecha', userId })
  expect(r.status).toBe('cancelled')
  expect(r.revertedInventory).toBe(true)

  // Stock regresó a 100, la CXC se liberó, la remisión quedó cancelada.
  expect(await stockOf(productId)).toBe(100)
  expect(await arForNote(noteId)).toBeNull()
  const { rows } = await withBypass(() => query(
    `SELECT status FROM delivery_notes WHERE id=$1`, [noteId]))
  expect(rows[0].status).toBe('cancelled')
})

test('guarda: con factura activa → 409 (cancela la factura primero)', async () => {
  const { noteId, productId } = await seedDeliveredNote({ qty: 5 })
  await withBypass(() => query(
    `INSERT INTO invoices (tenant_id, type, document_number, partner_id, status, delivery_note_id, total_mxn)
     VALUES ($1,'issued',$2,$3,'draft',$4,58)`,
    [tenantId, `F-${uniq()}`, partnerId, noteId]))

  await expect(deliveryNoteService.cancelDelivery({ tenantId, noteId, userId }))
    .rejects.toMatchObject({ status: 409 })
  // No revirtió: el stock sigue descontado.
  expect(await stockOf(productId)).toBe(95)
})

test('guarda: con un cobro aplicado en la CXC → 409 (reversa el cobro primero)', async () => {
  const { noteId, productId } = await seedDeliveredNote({ qty: 5 })
  await withBypass(() => query(
    `UPDATE accounts_receivable SET amount_paid = 1
      WHERE tenant_id=$1 AND document_type='remission' AND document_id=$2`,
    [tenantId, noteId]))

  await expect(deliveryNoteService.cancelDelivery({ tenantId, noteId, userId }))
    .rejects.toMatchObject({ status: 409 })
  expect(await stockOf(productId)).toBe(95)
})

test('cancelar una remisión NO entregada no toca inventario (revertedInventory=false)', async () => {
  const product = await createProduct(client, { sku: `CANC-${uniq()}` })
  await withTransaction((c) => inventoryService.recordMovement(c, {
    tenantId, warehouseId, itemType: 'product', itemId: product.id,
    movementType: 'adjustment_in', quantity: 50, unit: 'pieza', unitCost: 5,
    statusTo: 'available', notes: 'seed', createdBy: userId,
  }))
  const { rows: dn } = await withBypass(() => query(
    `INSERT INTO delivery_notes (tenant_id, type, document_number, partner_id, status, currency, total_mxn)
     VALUES ($1,'sale',$2,$3,'issued','MXN',10) RETURNING id`,
    [tenantId, `REM-${uniq()}`, partnerId]))
  const noteId = dn[0].id

  const r = await deliveryNoteService.cancelDelivery({ tenantId, noteId, userId })
  expect(r.status).toBe('cancelled')
  expect(r.revertedInventory).toBe(false)
  expect(await stockOf(product.id)).toBe(50)   // intacto
})
