'use strict'

/**
 * Recepciones — "Solicitar factura" con selección de destinatarios (2026-08-06).
 *
 * GET  /receipts/:id/invoice-request-context → correos candidatos del proveedor,
 *      buzón de facturas y resumen del correo (OC, fecha recepción, total c/IVA).
 * POST /receipts/:id/request-invoice acepta { toEmails } para mandar la
 *      solicitud solo a los correos elegidos; sin body cae a todos los contactos.
 * El total del correo lleva IVA: tasa efectiva de la OC, o 16% sin OC.
 */

// En tests no hay pg-boss ni SMTP: el fallback síncrono de enqueueEmail tiraría
// 502. Mockeamos la cola — lo que validamos aquí es el flujo, no el envío real.
jest.mock('../../src/queues/emailQueue', () => ({
  enqueueEmail: jest.fn().mockResolvedValue({ queued: true }),
  emailQueue: null,
  QUEUE_NAME: 'email',
}))

const { createTenant, loginAs, authedClient, cleanupTestTenants } = require('../helpers/factory')
const { pool, query, withBypass } = require('../../src/db')
const { enqueueEmail } = require('../../src/queues/emailQueue')

let tenantId, warehouseId, client
let n = 0
const rnum = (p) => `${p}-${Date.now() % 100000}-${n++}`

async function makeSupplier({ contacts = [] } = {}) {
  const { rows } = await withBypass(() => query(
    `INSERT INTO business_partners (tenant_id, type, name)
     VALUES ($1,'supplier','Proveedor Solicitud') RETURNING id`, [tenantId]))
  const id = rows[0].id
  for (const c of contacts) {
    await withBypass(() => query(
      `INSERT INTO business_partner_contacts (business_partner_id, name, email, is_primary)
       VALUES ($1,$2,$3,$4)`, [id, c.name, c.email, !!c.is_primary]))
  }
  return id
}

async function makeConfirmedReceipt({ partnerId, purchaseOrderId = null, qty = 10, unitPrice = 100 }) {
  const { rows: sr } = await withBypass(() => query(
    `INSERT INTO supplier_receipts (tenant_id, receipt_number, partner_id, warehouse_id,
                                    purchase_order_id, status, confirmed_at, received_date)
     VALUES ($1,$2,$3,$4,$5,'confirmed',NOW(),CURRENT_DATE) RETURNING id, receipt_number`,
    [tenantId, rnum('RCP'), partnerId, warehouseId, purchaseOrderId]))
  await withBypass(() => query(
    `INSERT INTO supplier_receipt_lines (supplier_receipt_id, quantity_received, unit, unit_price, line_number)
     VALUES ($1,$2,'pza',$3,1)`, [sr[0].id, qty, unitPrice]))
  return sr[0]
}

async function makePO({ partnerId, subtotal, tax }) {
  const { rows } = await withBypass(() => query(
    `INSERT INTO purchase_orders (tenant_id, order_number, partner_id, subtotal_mxn, tax_mxn, total_mxn, status)
     VALUES ($1,$2,$3,$4,$5,$6,'sent') RETURNING id, order_number`,
    [tenantId, rnum('OC'), partnerId, subtotal, tax, subtotal + tax]))
  return rows[0]
}

beforeAll(async () => {
  const info = await createTenant({ label: 'rcptreqinv', planSlug: 'owner' })
  tenantId = info.tenant.id
  const sess = await loginAs({ slug: info.tenant.slug, email: info.email, password: info.password })
  client = authedClient({ slug: info.tenant.slug, token: sess.token })
  const { rows } = await withBypass(() => query(
    `INSERT INTO warehouses (tenant_id, name, type, is_active) VALUES ($1,'Almacén','raw_material',true) RETURNING id`,
    [tenantId]))
  warehouseId = rows[0].id
})

afterAll(async () => { await cleanupTestTenants(); await pool.end() })

describe('Solicitar factura de recepción — contexto y destinatarios', () => {
  test('contexto: contactos del proveedor + total con IVA 16% sin OC', async () => {
    const sid = await makeSupplier({ contacts: [
      { name: 'Contadora', email: 'conta@prov.mx', is_primary: true },
      { name: 'Ventas',    email: 'ventas@prov.mx' },
    ] })
    const rcpt = await makeConfirmedReceipt({ partnerId: sid, qty: 10, unitPrice: 100 }) // subtotal 1000

    const res = await client.get(`/api/purchases/receipts/${rcpt.id}/invoice-request-context`).expect(200)
    expect(res.body.contacts.map(c => c.email)).toEqual(['conta@prov.mx', 'ventas@prov.mx'])
    expect(res.body.receipt.receipt_number).toBe(rcpt.receipt_number)
    expect(parseFloat(res.body.receipt.total_with_tax)).toBe(1160)   // 1000 × 1.16
  })

  test('contexto: la tasa de IVA sale de la OC (OC sin IVA → total = subtotal)', async () => {
    const sid = await makeSupplier({ contacts: [{ name: 'C', email: 'c@prov.mx' }] })
    const po  = await makePO({ partnerId: sid, subtotal: 2000, tax: 0 })   // OC con tasa 0
    const rcpt = await makeConfirmedReceipt({ partnerId: sid, purchaseOrderId: po.id, qty: 10, unitPrice: 100 })

    const res = await client.get(`/api/purchases/receipts/${rcpt.id}/invoice-request-context`).expect(200)
    expect(res.body.receipt.purchase_order_number).toBe(po.order_number)
    expect(parseFloat(res.body.receipt.total_with_tax)).toBe(1000)   // tasa 0 de la OC
  })

  test('enviar con toEmails usa SOLO esos correos', async () => {
    const sid = await makeSupplier({ contacts: [{ name: 'C', email: 'c@prov.mx' }] })
    const rcpt = await makeConfirmedReceipt({ partnerId: sid })

    const res = await client.post(`/api/purchases/receipts/${rcpt.id}/request-invoice`,
      { toEmails: ['elegido@prov.mx'] }).expect(200)
    expect(res.body.sentTo).toEqual(['elegido@prov.mx'])
    expect(res.body.requested_at).toBeTruthy()
  })

  test('enviar sin toEmails cae a todos los contactos del proveedor', async () => {
    const sid = await makeSupplier({ contacts: [
      { name: 'A', email: 'a@prov.mx', is_primary: true },
      { name: 'B', email: 'b@prov.mx' },
    ] })
    const rcpt = await makeConfirmedReceipt({ partnerId: sid })

    const res = await client.post(`/api/purchases/receipts/${rcpt.id}/request-invoice`, {}).expect(200)
    expect(res.body.sentTo.sort()).toEqual(['a@prov.mx', 'b@prov.mx'])
  })

  test('correo inválido en toEmails → 400', async () => {
    const sid = await makeSupplier({ contacts: [{ name: 'C', email: 'c@prov.mx' }] })
    const rcpt = await makeConfirmedReceipt({ partnerId: sid })

    const res = await client.post(`/api/purchases/receipts/${rcpt.id}/request-invoice`,
      { toEmails: ['no-es-correo'] }).expect(400)
    expect(res.body.error).toMatch(/inválido/i)
  })
})
