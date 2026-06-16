'use strict'

/**
 * Venta ANTICIPADA: el pedido se factura DIRECTO (una factura con delivery_note_id
 * NULL, NO consolidada, cuyas invoice_lines ligan por sales_order_line_id) y DESPUÉS
 * se van entregando remisiones parciales. La mercancía YA está facturada, así que la
 * remisión NO debe verse "Listo para facturar" ni aparecer en el modal de nueva factura.
 *
 * Antes: lista/detalle/filtro solo miraban delivery_note_id o invoice_remissions →
 * la remisión de una venta anticipada salía "Listo para facturar" y se re-facturaba.
 */

const { query, withBypass } = require('../../src/db')
const deliveryNoteService = require('../../src/modules/sales/deliveryNoteService')
const productService      = require('../../src/modules/products/productService')
const { createTenant, cleanupTestTenants } = require('../helpers/factory')

async function makeOrderLine(tenantId, partnerId, productId, userId, orderNumber) {
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
     VALUES ($1,$2,10,'pieza',100,'MXN',1) RETURNING id`,
    [o[0].id, productId]
  ))
  return { orderId: o[0].id, lineId: l[0].id }
}

// Factura DIRECTA/anticipada: delivery_note_id NULL, fuera de invoice_remissions,
// líneas ligadas al pedido por sales_order_line_id (así queda createDirect en prod).
async function makeDirectInvoice(tenantId, partnerId, productId, salesOrderLineId, docNumber) {
  const { rows: inv } = await withBypass(() => query(
    `INSERT INTO invoices (tenant_id, type, document_number, partner_id, status, delivery_note_id)
     VALUES ($1,'issued',$2,$3,'stamped',NULL) RETURNING id`,
    [tenantId, docNumber, partnerId]
  ))
  await withBypass(() => query(
    `INSERT INTO invoice_lines
       (invoice_id, product_id, description, quantity, unit, unit_price, tax_rate,
        sat_product_code, sat_unit_code, line_number, sales_order_line_id)
     VALUES ($1,$2,'Producto anticipo',10,'pieza',100,16,'44102305','H87',1,$3)`,
    [inv[0].id, productId, salesOrderLineId]
  ))
  return inv[0].id
}

// Remisión ENTREGADA cuya línea apunta al pedido (entrega parcial de la venta anticipada).
async function makeDeliveredRemision(tenantId, partnerId, productId, num, salesOrderLineId) {
  const { rows: dn } = await withBypass(() => query(
    `INSERT INTO delivery_notes (tenant_id, type, document_number, partner_id, status, currency, total_mxn)
     VALUES ($1,'sale',$2,$3,'delivered','MXN',116) RETURNING id`,
    [tenantId, num, partnerId]
  ))
  await withBypass(() => query(
    `INSERT INTO delivery_note_lines
       (delivery_note_id, product_id, quantity_ordered, quantity_delivered, unit_price, line_number, sales_order_line_id)
     VALUES ($1,$2,5,5,100,1,$3)`,
    [dn[0].id, productId, salesOrderLineId]
  ))
  return dn[0].id
}

describe('Venta anticipada ↔ remisión (factura directa por sales_order_line_id)', () => {
  let tenantId, userId, partnerId, productId
  let advDn1, advDn2, advInvId, normalDn

  beforeAll(async () => {
    const info = await createTenant({ label: 'advtag', planSlug: 'owner' })
    tenantId = info.tenant.id
    userId   = info.user.id
    const { rows: bp } = await withBypass(() => query(
      `INSERT INTO business_partners (tenant_id, type, name) VALUES ($1,'customer','Cliente Anticipo') RETURNING id`,
      [tenantId]
    ))
    partnerId = bp[0].id
    const p = await productService.createProduct({
      tenantId, userId, sku: 'ADVTAG-1', name: 'Producto anticipo',
      type: 'resale', isProduced: false, satUnitCode: 'H87', satProductCode: '44102305',
    })
    productId = p.id

    // Pedido facturado anticipadamente + 2 entregas parciales.
    const { lineId } = await makeOrderLine(tenantId, partnerId, productId, userId, 'OV-ADVTAG-1')
    advInvId = await makeDirectInvoice(tenantId, partnerId, productId, lineId, 'FAC-ADVTAG-1')
    advDn1 = await makeDeliveredRemision(tenantId, partnerId, productId, 'REM-ADVTAG-1', lineId)
    advDn2 = await makeDeliveredRemision(tenantId, partnerId, productId, 'REM-ADVTAG-2', lineId)

    // Control: remisión entregada SIN factura (pedido aparte) → sí debe ser facturable.
    const norm = await makeOrderLine(tenantId, partnerId, productId, userId, 'OV-NORMTAG-1')
    normalDn = await makeDeliveredRemision(tenantId, partnerId, productId, 'REM-NORMTAG-1', norm.lineId)
  })

  afterAll(async () => { await cleanupTestTenants() })

  test('getDeliveryNote detecta la factura anticipada (header NULL → vía sales_order_line_id)', async () => {
    const note = await deliveryNoteService.getDeliveryNote({ tenantId, noteId: advDn1 })
    expect(note.invoice_id).toBe(advInvId)
    expect(note.invoice_number).toBe('FAC-ADVTAG-1')
    expect(note.lines.length).toBeGreaterThan(0)
    expect(note.lines.every(l => l.invoice_id === advInvId)).toBe(true)
  })

  test('listDeliveryNotes devuelve invoice_id para remisiones de venta anticipada', async () => {
    const { data } = await deliveryNoteService.listDeliveryNotes({ tenantId, type: 'sale', limit: 200 })
    expect(data.find(d => d.id === advDn1)?.invoice_id).toBe(advInvId)
    expect(data.find(d => d.id === advDn2)?.invoice_id).toBe(advInvId)
  })

  test('el filtro invoiceable EXCLUYE las ya facturadas anticipadamente', async () => {
    const { data } = await deliveryNoteService.listDeliveryNotes({ tenantId, type: 'sale', invoiceable: true, limit: 200 })
    expect(data.find(d => d.id === advDn1)).toBeUndefined()
    expect(data.find(d => d.id === advDn2)).toBeUndefined()
  })

  test('control: una remisión entregada SIN factura sigue siendo facturable', async () => {
    const { data } = await deliveryNoteService.listDeliveryNotes({ tenantId, type: 'sale', invoiceable: true, limit: 200 })
    expect(data.find(d => d.id === normalDn)).toBeDefined()
    // …y sin factura ligada (sigue "Listo para facturar").
    const note = await deliveryNoteService.getDeliveryNote({ tenantId, noteId: normalDn })
    expect(note.invoice_id).toBeFalsy()
  })
})
