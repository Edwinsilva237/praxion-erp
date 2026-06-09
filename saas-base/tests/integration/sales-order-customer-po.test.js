'use strict'

/**
 * OC del cliente adjunta al pedido (sales_order attachments, mig 199, 2026-06-09).
 *
 * El cliente a veces exige su propia orden de compra impresa para recibir la
 * mercancía. Se adjunta el DOCUMENTO (PDF/foto) al pedido (category='customer_po')
 * y se puede descargar/imprimir desde el pedido y la remisión ligada. Aditivo.
 *
 * Cubre: subir → listar → aparece en getOrder → aditivo (no reemplaza) →
 *        descargar → eliminar → 404 en pedido inexistente.
 */

const { createTenant, loginAs, authedClient, cleanupTestTenants } = require('../helpers/factory')
const { createProduct } = require('../helpers/productionFactory')
const { pool } = require('../../src/db')

afterAll(async () => {
  await cleanupTestTenants()
  await pool.end()
})

const PDF = Buffer.from('%PDF-1.4\n test oc cliente\n%%EOF', 'utf8')

describe('OC del cliente adjunta al pedido (sales_order attachments)', () => {
  let client, orderId, product, partnerId

  beforeAll(async () => {
    const t = await createTenant({ label: 'custpo', planSlug: 'owner' })
    const sess = await loginAs({ slug: t.tenant.slug, email: t.email, password: t.password })
    client = authedClient({ slug: t.tenant.slug, token: sess.token })

    const pRes = await client.post('/api/business-partners', {
      name: 'Cliente OC', type: 'customer', rfc: 'XAXX010101000', is_active: true,
    })
    expect(pRes.status).toBe(201)
    partnerId = pRes.body.id

    product = await createProduct(client, { sku: 'POC-1' })

    const oRes = await client.post('/api/sales/orders', {
      partnerId, currency: 'MXN', poNumber: 'OC-123',
      lines: [{ productId: product.id, quantity: 5, unit: 'pieza', unitPrice: 10 }],
    })
    expect(oRes.status).toBe(201)
    orderId = oRes.body.id
  })

  test('sube un documento de OC y aparece en la lista y en getOrder', async () => {
    const up = await client.post(`/api/sales/orders/${orderId}/attachments`)
      .attach('file', PDF, { filename: 'oc-cliente.pdf', contentType: 'application/pdf' })
    expect(up.status).toBe(201)

    const list = await client.get(`/api/sales/orders/${orderId}/attachments`)
    expect(list.status).toBe(200)
    expect(list.body.length).toBe(1)
    expect(list.body[0].filename).toBe('oc-cliente.pdf')

    const det = await client.get(`/api/sales/orders/${orderId}`)
    expect(det.status).toBe(200)
    expect(Array.isArray(det.body.customerPoAttachments)).toBe(true)
    expect(det.body.customerPoAttachments.length).toBe(1)
    expect(det.body.customerPoAttachments[0].filename).toBe('oc-cliente.pdf')
  })

  test('es aditivo: un segundo documento NO reemplaza al primero', async () => {
    const up = await client.post(`/api/sales/orders/${orderId}/attachments`)
      .attach('file', PDF, { filename: 'oc-anexo.pdf', contentType: 'application/pdf' })
    expect(up.status).toBe(201)

    const list = await client.get(`/api/sales/orders/${orderId}/attachments`)
    expect(list.body.length).toBe(2)
  })

  test('descarga el documento (200)', async () => {
    const list = await client.get(`/api/sales/orders/${orderId}/attachments`)
    const att = list.body[0]
    const dl = await client.get(`/api/sales/orders/${orderId}/attachments/${att.id}/download`)
    expect(dl.status).toBe(200)
  })

  test('eliminar quita un documento (queda 1)', async () => {
    const list = await client.get(`/api/sales/orders/${orderId}/attachments`)
    const att = list.body[0]
    const del = await client.delete(`/api/sales/orders/${orderId}/attachments/${att.id}`)
    expect(del.status).toBe(200)

    const after = await client.get(`/api/sales/orders/${orderId}/attachments`)
    expect(after.body.length).toBe(1)
  })

  test('404 al subir a un pedido inexistente', async () => {
    const up = await client.post(`/api/sales/orders/00000000-0000-0000-0000-000000000000/attachments`)
      .attach('file', PDF, { filename: 'x.pdf', contentType: 'application/pdf' })
    expect(up.status).toBe(404)
  })
})
