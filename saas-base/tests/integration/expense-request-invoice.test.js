'use strict'

/**
 * Gastos — solicitar factura al proveedor por correo.
 * El happy-path manda correo; en test SMTP está vacío (setup.js) → mockeamos
 * enqueueEmail para validar el flujo sin enviar nada real.
 */

jest.mock('../../src/queues/emailQueue', () => ({
  enqueueEmail: jest.fn().mockResolvedValue({ queued: false }),
  emailQueue: null,
  QUEUE_NAME: 'emails',
}))

const crypto = require('crypto')
const { createTenant, cleanupTestTenants } = require('../helpers/factory')
const { pool, query, withBypass } = require('../../src/db')
const { enqueueEmail } = require('../../src/queues/emailQueue')
const {
  registerInvoice, requestExpenseInvoice, getExpense,
} = require('../../src/modules/purchases/supplierInvoiceService')

let tenantId, userId, supplierId, categoryId

async function makeExpense({ uuidSat = null } = {}) {
  return registerInvoice({
    tenantId, supplierId, documentNumber: `GASTO-${crypto.randomUUID().slice(0, 8)}`,
    subtotal: 1000, tax: 160, total: 1160,
    isExpense: true, expenseCategoryId: categoryId, uuidSat, userId,
  })
}

describe('Gastos — solicitar factura al proveedor', () => {
  beforeAll(async () => {
    const info = await createTenant({ label: 'gastoreq', planSlug: 'owner' })
    tenantId = info.tenant.id
    userId = info.user.id
    const { rows: s } = await withBypass(() => query(
      `INSERT INTO business_partners (tenant_id, type, name) VALUES ($1,'supplier','Prov Req') RETURNING id`, [tenantId]))
    supplierId = s[0].id
    const { rows: c } = await withBypass(() => query(
      `INSERT INTO tenant_expense_categories (tenant_id, code, name) VALUES ($1,'req','Req') RETURNING id`, [tenantId]))
    categoryId = c[0].id
  })
  afterAll(async () => { await cleanupTestTenants(); await pool.end() })
  beforeEach(() => enqueueEmail.mockClear())

  test('proveedor sin contacto con correo → 400 (no manda nada)', async () => {
    const exp = await makeExpense()
    await expect(requestExpenseInvoice({ tenantId, id: exp.id, userId }))
      .rejects.toMatchObject({ status: 400 })
    expect(enqueueEmail).not.toHaveBeenCalled()
  })

  test('gasto que YA tiene CFDI → 400', async () => {
    const exp = await makeExpense({ uuidSat: crypto.randomUUID() })
    await expect(requestExpenseInvoice({ tenantId, id: exp.id, userId }))
      .rejects.toMatchObject({ status: 400 })
    expect(enqueueEmail).not.toHaveBeenCalled()
  })

  test('con contacto-email → encola el correo y marca invoice_requested_at', async () => {
    await withBypass(() => query(
      `INSERT INTO business_partner_contacts (business_partner_id, name, email, is_primary)
       VALUES ($1,'Contacto','prov@example.com',true)`, [supplierId]))
    const exp = await makeExpense()
    const res = await requestExpenseInvoice({ tenantId, id: exp.id, userId })
    expect(res.sentTo).toContain('prov@example.com')
    expect(res.requested_at).toBeTruthy()
    expect(enqueueEmail).toHaveBeenCalledTimes(1)
    const got = await getExpense({ tenantId, id: exp.id })
    expect(got.invoice_requested_at).toBeTruthy()
  })
})
