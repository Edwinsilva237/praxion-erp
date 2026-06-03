'use strict'

/**
 * Mig 190 — la factura CONSOLIDADA liga sus remisiones vía invoice_remissions
 * (su delivery_note_id queda NULL y sus invoice_lines no llevan
 * delivery_note_line_id). Antes lista/detalle quedaban ciegos → la remisión
 * facturada salía como "Listo para facturar" / "Pendiente de facturar".
 */

const { query, withBypass } = require('../../src/db')
const deliveryNoteService = require('../../src/modules/sales/deliveryNoteService')
const invoiceService      = require('../../src/modules/invoicing/invoiceService')
const productService      = require('../../src/modules/products/productService')
const { createTenant, cleanupTestTenants } = require('../helpers/factory')

async function makeDeliveredRemision(tenantId, partnerId, productId, num) {
  const { rows: dn } = await withBypass(() => query(
    `INSERT INTO delivery_notes (tenant_id, type, document_number, partner_id, status, currency)
     VALUES ($1,'sale',$2,$3,'delivered','MXN') RETURNING id`,
    [tenantId, num, partnerId]
  ))
  const noteId = dn[0].id
  await withBypass(() => query(
    `INSERT INTO delivery_note_lines
       (delivery_note_id, product_id, quantity_ordered, quantity_delivered, unit_price, line_number)
     VALUES ($1,$2,10,10,50,1)`,
    [noteId, productId]
  ))
  return noteId
}

describe('Factura consolidada ↔ remisión (mig 190 / invoice_remissions)', () => {
  let tenantId, userId, partnerId, productId, dn1, dn2, invId

  beforeAll(async () => {
    const info = await createTenant({ label: 'consol', planSlug: 'owner' })
    tenantId = info.tenant.id
    userId   = info.user.id
    const { rows: bp } = await withBypass(() => query(
      `INSERT INTO business_partners (tenant_id, type, name) VALUES ($1,'customer','Cliente Consol') RETURNING id`,
      [tenantId]
    ))
    partnerId = bp[0].id
    const p = await productService.createProduct({
      tenantId, userId, sku: 'CONS-1', name: 'Producto consol',
      type: 'resale', isProduced: false, satUnitCode: 'H87',
    })
    productId = p.id

    dn1 = await makeDeliveredRemision(tenantId, partnerId, productId, 'REM-CONS-1')
    dn2 = await makeDeliveredRemision(tenantId, partnerId, productId, 'REM-CONS-2')

    // Factura CONSOLIDADA tal cual queda en prod: delivery_note_id NULL, sin
    // invoice_lines.delivery_note_line_id, ligada SOLO vía invoice_remissions.
    const { rows: inv } = await withBypass(() => query(
      `INSERT INTO invoices (tenant_id, type, document_number, partner_id, status, delivery_note_id)
       VALUES ($1,'issued','FAC-CONS-1',$2,'stamped',NULL) RETURNING id`,
      [tenantId, partnerId]
    ))
    invId = inv[0].id
    await withBypass(() => query(
      `INSERT INTO invoice_remissions (invoice_id, delivery_note_id) VALUES ($1,$2),($1,$3)`,
      [invId, dn1, dn2]
    ))
  })

  afterAll(async () => { await cleanupTestTenants() })

  test('getDeliveryNote detecta la consolidada (header NULL → vía invoice_remissions)', async () => {
    const note = await deliveryNoteService.getDeliveryNote({ tenantId, noteId: dn1 })
    expect(note.invoice_id).toBe(invId)
    expect(note.invoice_number).toBe('FAC-CONS-1')
    // Las líneas se marcan facturadas (antes salían "Pendiente de facturar").
    expect(note.lines.length).toBeGreaterThan(0)
    expect(note.lines.every(l => l.invoice_id === invId)).toBe(true)
  })

  test('listDeliveryNotes devuelve invoice_id para remisiones consolidadas', async () => {
    const { data } = await deliveryNoteService.listDeliveryNotes({ tenantId, type: 'sale' })
    expect(data.find(d => d.id === dn1)?.invoice_id).toBe(invId)
    expect(data.find(d => d.id === dn2)?.invoice_id).toBe(invId)
  })

  test('el filtro invoiceable EXCLUYE las ya consolidadas', async () => {
    const { data } = await deliveryNoteService.listDeliveryNotes({ tenantId, type: 'sale', invoiceable: true })
    expect(data.find(d => d.id === dn1)).toBeUndefined()
    expect(data.find(d => d.id === dn2)).toBeUndefined()
  })

  test('guard: no re-facturar individualmente una remisión ya consolidada', async () => {
    await expect(invoiceService.createFromRemission({ tenantId, deliveryNoteId: dn1, userId }))
      .rejects.toThrow(/consolidada/i)
  })

  test('guard: no re-consolidar remisiones ya facturadas', async () => {
    await expect(invoiceService.createFromRemissions({ tenantId, deliveryNoteIds: [dn1, dn2], userId }))
      .rejects.toThrow(/ya tienen factura/i)
  })
})
