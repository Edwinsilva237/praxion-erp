'use strict'

/**
 * Recepciones — estado de facturación en la lista (2026-06-09).
 *
 * `listReceipts` ahora devuelve `invoiced_at` + el folio de la factura ligada
 * (subquery a supplier_invoice_receipts/supplier_invoices) y acepta el filtro
 * `invoiceStatus` ('pending' | 'invoiced'). Este smoke test valida que la SQL
 * (subquery + filtros) es VÁLIDA y ejecuta — Postgres resuelve las referencias
 * de tablas/columnas al planear, incluso con 0 filas, así que atrapa un nombre
 * de columna/tabla mal escrito en la subquery del folio.
 */

const { createTenant, loginAs, authedClient, cleanupTestTenants } = require('../helpers/factory')
const { pool } = require('../../src/db')

afterAll(async () => {
  await cleanupTestTenants()
  await pool.end()
})

describe('Recepciones: estado de facturación en la lista', () => {
  let client

  beforeAll(async () => {
    const t = await createTenant({ label: 'rcptinv', planSlug: 'owner' })
    const sess = await loginAs({ slug: t.tenant.slug, email: t.email, password: t.password })
    client = authedClient({ slug: t.tenant.slug, token: sess.token })
  })

  test('GET /receipts ejecuta la SQL de facturación (base + ambos filtros)', async () => {
    const base = await client.get('/api/purchases/receipts')
    expect(base.status).toBe(200)
    expect(Array.isArray(base.body.data)).toBe(true)

    const pending = await client.get('/api/purchases/receipts?invoiceStatus=pending')
    expect(pending.status).toBe(200)
    expect(Array.isArray(pending.body.data)).toBe(true)

    const invoiced = await client.get('/api/purchases/receipts?invoiceStatus=invoiced')
    expect(invoiced.status).toBe(200)
    expect(Array.isArray(invoiced.body.data)).toBe(true)
  })
})
