'use strict'

/**
 * Bandera de tenant `block_sale_without_stock` (mig 223): cuando está encendida,
 * registrar la ENTREGA de una remisión se BLOQUEA con 400 si el almacén no tiene
 * existencia suficiente. Apagada (default) la entrega procede como siempre.
 */

const { createTenant, loginAs, authedClient, cleanupTestTenants } = require('../helpers/factory')
const { createProduct } = require('../helpers/productionFactory')
const { pool, query, withTransaction, withBypass } = require('../../src/db')
const inventoryService = require('../../src/modules/inventory/inventoryService')
const deliveryNoteService = require('../../src/modules/sales/deliveryNoteService')

let client, tenantId, userId, warehouseId, partnerId
let seq = 0
const uniq = () => `${Date.now()}-${++seq}`

async function setFlag(val) {
  await withBypass(() => query(
    `INSERT INTO tenant_process_config (tenant_id, block_sale_without_stock)
       VALUES ($1, $2)
     ON CONFLICT (tenant_id) DO UPDATE SET block_sale_without_stock = EXCLUDED.block_sale_without_stock`,
    [tenantId, val]))
}

async function seedProductWithStock(qty) {
  const product = await createProduct(client, { sku: `BLK-${uniq()}` })
  if (qty > 0) {
    await withTransaction((c) => inventoryService.recordMovement(c, {
      tenantId, warehouseId, itemType: 'product', itemId: product.id,
      movementType: 'adjustment_in', quantity: qty, unit: 'pieza', unitCost: 5,
      statusTo: 'available', notes: 'seed', createdBy: userId,
    }))
  }
  return product
}

async function makeIssuedNote(productId, qty) {
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
    [noteId, productId, qty, warehouseId]))
  return noteId
}

beforeAll(async () => {
  const t = await createTenant({ label: 'blocksale', planSlug: 'owner' })
  tenantId = t.tenant.id
  userId   = t.user.id
  const sess = await loginAs({ slug: t.tenant.slug, email: t.email, password: t.password })
  client = authedClient({ slug: t.tenant.slug, token: sess.token })

  const wh = await withBypass(() => query(
    `INSERT INTO warehouses (tenant_id, name, type, description, is_active)
     VALUES ($1,'PT block','finished_product','fixture',true) RETURNING id`, [tenantId]))
  warehouseId = wh.rows[0].id

  const bp = await withBypass(() => query(
    `INSERT INTO business_partners (tenant_id, type, name) VALUES ($1,'customer','Cliente Block') RETURNING id`,
    [tenantId]))
  partnerId = bp.rows[0].id
})
afterAll(async () => { await cleanupTestTenants(); await pool.end() })

test('bandera APAGADA (default): entrega aunque no haya stock suficiente', async () => {
  await setFlag(false)
  const product = await seedProductWithStock(5)
  const noteId = await makeIssuedNote(product.id, 10)   // pide 10, hay 5
  await expect(
    deliveryNoteService.recordDelivery({ tenantId, noteId, receiverName: 'Receptor', userId })
  ).resolves.toBeTruthy()
})

test('bandera ENCENDIDA: bloquea la entrega si no alcanza el stock (400)', async () => {
  await setFlag(true)
  const product = await seedProductWithStock(5)
  const noteId = await makeIssuedNote(product.id, 10)   // pide 10, hay 5
  await expect(
    deliveryNoteService.recordDelivery({ tenantId, noteId, receiverName: 'Receptor', userId })
  ).rejects.toMatchObject({ status: 400 })
})

test('bandera ENCENDIDA: permite entregar cuando SÍ alcanza', async () => {
  await setFlag(true)
  const product = await seedProductWithStock(20)
  const noteId = await makeIssuedNote(product.id, 10)   // pide 10, hay 20
  await expect(
    deliveryNoteService.recordDelivery({ tenantId, noteId, receiverName: 'Receptor', userId })
  ).resolves.toBeTruthy()
})