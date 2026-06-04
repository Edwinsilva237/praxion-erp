'use strict'

/**
 * Facturación anticipada (factura DIRECTA → entregas parciales): al registrar la
 * entrega de una remisión, `generateCXC` NO debe crear una cuenta por cobrar tipo
 * 'remission' si el pedido YA tiene una factura directa activa — esa CXC ya existe
 * por la factura y duplicarla descuadraría la cobranza.
 *
 * Distinción clave: factura DIRECTA = delivery_note_id NULL **y** NO está en
 * invoice_remissions. Una factura CONSOLIDADA (también delivery_note_id NULL, pero
 * ligada en invoice_remissions) NO debe bloquear la CXC de una nueva remisión.
 */

const { createTenant, cleanupTestTenants } = require('../helpers/factory')
const { pool, query, withBypass, withTransaction } = require('../../src/db')
const productService = require('../../src/modules/products/productService')
const deliveryNoteService = require('../../src/modules/sales/deliveryNoteService')

let tenantId, userId, partnerId, productId

async function cxcCount(docType, docId) {
  const { rows } = await withBypass(() => query(
    `SELECT COUNT(*)::int AS n FROM accounts_receivable
      WHERE tenant_id=$1 AND document_type=$2 AND document_id=$3`,
    [tenantId, docType, docId]
  ))
  return rows[0].n
}

async function makeOrder(orderNumber) {
  const { rows: o } = await withBypass(() => query(
    `INSERT INTO sales_orders
       (tenant_id, order_number, partner_id, status, currency,
        subtotal_mxn, tax_mxn, total_mxn, direct_invoice, created_by)
     VALUES ($1,$2,$3,'confirmed','MXN',100,16,116,true,$4) RETURNING id`,
    [tenantId, orderNumber, partnerId, userId]
  ))
  const { rows: l } = await withBypass(() => query(
    `INSERT INTO sales_order_lines
       (sales_order_id, product_id, quantity, unit, unit_price, currency, line_number)
     VALUES ($1,$2,1,'pieza',100,'MXN',1) RETURNING id`,
    [o[0].id, productId]
  ))
  return { orderId: o[0].id, lineId: l[0].id }
}

async function makeDirectInvoice(docNumber, salesOrderLineId, { consolidated = false } = {}) {
  const { rows: inv } = await withBypass(() => query(
    `INSERT INTO invoices (tenant_id, type, document_number, partner_id, status, delivery_note_id)
     VALUES ($1,'issued',$2,$3,'draft',NULL) RETURNING id`,
    [tenantId, docNumber, partnerId]
  ))
  const invId = inv[0].id
  await withBypass(() => query(
    `INSERT INTO invoice_lines
       (invoice_id, product_id, description, quantity, unit, unit_price, tax_rate,
        sat_product_code, sat_unit_code, line_number, sales_order_line_id)
     VALUES ($1,$2,'Producto anticipo',1,'pieza',100,16,'44102305','H87',1,$3)`,
    [invId, productId, salesOrderLineId]
  ))
  if (consolidated) {
    // Liga la factura como CONSOLIDADA a una remisión cualquiera (la marca como no-directa).
    const prevDn = await makeNote('REM-prev-' + docNumber, salesOrderLineId)
    await withBypass(() => query(
      `INSERT INTO invoice_remissions (invoice_id, delivery_note_id) VALUES ($1,$2)`,
      [invId, prevDn]
    ))
  }
  return invId
}

async function makeNote(docNumber, salesOrderLineId) {
  const { rows: dn } = await withBypass(() => query(
    `INSERT INTO delivery_notes
       (tenant_id, type, document_number, partner_id, status, currency, total_mxn)
     VALUES ($1,'sale',$2,$3,'issued','MXN',116) RETURNING id`,
    [tenantId, docNumber, partnerId]
  ))
  await withBypass(() => query(
    `INSERT INTO delivery_note_lines
       (delivery_note_id, product_id, quantity_ordered, quantity_delivered, unit_price, line_number, sales_order_line_id)
     VALUES ($1,$2,1,1,100,1,$3)`,
    [dn[0].id, productId, salesOrderLineId]
  ))
  return dn[0].id
}

async function runGenerateCXC(dnId) {
  await withTransaction(async (client) => {
    await deliveryNoteService.generateCXC(client, {
      tenantId,
      note: { id: dnId, partner_id: partnerId, document_number: 'REM', total_mxn: 116, credit_due_date: null },
      userId,
    })
  })
}

describe('Facturación anticipada — la remisión NO duplica la CXC', () => {
  beforeAll(async () => {
    const info = await createTenant({ label: 'advcxc', planSlug: 'owner' })
    tenantId = info.tenant.id
    userId = info.user.id
    const p = await productService.createProduct({
      tenantId, userId, sku: 'ADV-1', name: 'Producto anticipo',
      type: 'resale', isProduced: false, saleUnit: 'pieza',
      satUnitCode: 'H87', satProductCode: '44102305',
    })
    productId = p.id
    const { rows } = await withBypass(() => query(
      `INSERT INTO business_partners (tenant_id, type, name)
       VALUES ($1,'customer','Cliente Anticipo') RETURNING id`,
      [tenantId]
    ))
    partnerId = rows[0].id
  })

  afterAll(async () => { await cleanupTestTenants(); await pool.end() })

  test('CON factura directa previa → NO crea CXC de remisión (no duplica)', async () => {
    const { lineId } = await makeOrder('OV-ADV-1')
    await makeDirectInvoice('F-ADV-1', lineId)
    const dnId = await makeNote('REM-ADV-1', lineId)

    await runGenerateCXC(dnId)
    expect(await cxcCount('remission', dnId)).toBe(0)
  })

  test('SIN factura previa → SÍ crea la CXC de remisión (flujo normal intacto)', async () => {
    const { lineId } = await makeOrder('OV-NORM-1')
    const dnId = await makeNote('REM-NORM-1', lineId)

    await runGenerateCXC(dnId)
    expect(await cxcCount('remission', dnId)).toBe(1)
  })

  test('Con factura CONSOLIDADA (en invoice_remissions) → SÍ crea CXC (no es directa)', async () => {
    const { lineId } = await makeOrder('OV-CONS-1')
    await makeDirectInvoice('F-CONS-1', lineId, { consolidated: true })
    const dnId = await makeNote('REM-CONS-new', lineId)

    await runGenerateCXC(dnId)
    expect(await cxcCount('remission', dnId)).toBe(1)
  })
})
