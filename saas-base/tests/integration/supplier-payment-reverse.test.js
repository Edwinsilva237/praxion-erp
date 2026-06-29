'use strict'

/**
 * Reversa de pago a proveedor (supplierInvoiceService.reverseSupplierPayment):
 * deshace el efecto del pago en la CXP (amount_paid/status de accounts_payable y
 * balance/status de supplier_invoices), marca el pago reversado y lo saca del
 * historial de pagos emitidos.
 */

const { createTenant, cleanupTestTenants } = require('../helpers/factory')
const { pool, query, withBypass } = require('../../src/db')
const {
  registerInvoice, registerPayment, reverseSupplierPayment,
} = require('../../src/modules/purchases/supplierInvoiceService')
const cxpService = require('../../src/modules/purchases/cxpService')

let tenantId, userId, supplierId
let n = 0
const rnum = (p) => `${p}-${Date.now() % 100000}-${n++}`

async function makeInvoice({ subtotal = 1000, tax = 160 } = {}) {
  return registerInvoice({
    tenantId, supplierId, documentNumber: rnum('F'),
    subtotal, tax, total: subtotal + tax, userId,
  })
}
async function getAp(apId) {
  const { rows } = await withBypass(() => query(
    `SELECT amount_paid, status FROM accounts_payable WHERE id = $1`, [apId]))
  return rows[0]
}

describe('Reversa de pago a proveedor', () => {
  beforeAll(async () => {
    const info = await createTenant({ label: 'sprev', planSlug: 'owner' })
    tenantId = info.tenant.id
    userId   = info.user.id
    const { rows } = await withBypass(() => query(
      `INSERT INTO business_partners (tenant_id, type, name) VALUES ($1,'supplier','Prov Reversa') RETURNING id`,
      [tenantId]))
    supplierId = rows[0].id
  })

  afterAll(async () => { await cleanupTestTenants(); await pool.end() })

  test('reversa restaura la CXP y saca el pago del historial', async () => {
    const inv = await makeInvoice({ subtotal: 1000, tax: 160 })   // total 1160
    const pay = await registerPayment({
      tenantId, supplierId, method: 'transfer', reference: 'TR-FULL',
      amount: 1160, currency: 'MXN',
      applications: [{ apId: inv.ap_id, amountApplied: 1160 }], userId,
    })
    expect((await getAp(inv.ap_id)).status).toBe('paid')

    const r = await reverseSupplierPayment({ tenantId, paymentId: pay.id, reason: 'pago mal aplicado', userId })
    expect(r.reversed).toBe(true)
    expect(r.reversedApplications).toBe(1)

    const ap = await getAp(inv.ap_id)
    expect(parseFloat(ap.amount_paid)).toBeCloseTo(0, 2)
    expect(ap.status).toBe('pending')

    // El pago reversado ya no aparece en el historial de pagos emitidos.
    const list = await cxpService.listPayments({ tenantId })
    expect(list.data.find(p => p.id === pay.id)).toBeUndefined()
  })

  test('reversa de pago PARCIAL deja la CXP en pending', async () => {
    const inv = await makeInvoice({ subtotal: 1000, tax: 160 })
    const pay = await registerPayment({
      tenantId, supplierId, method: 'cash', reference: null,
      amount: 500, currency: 'MXN',
      applications: [{ apId: inv.ap_id, amountApplied: 500 }], userId,
    })
    expect((await getAp(inv.ap_id)).status).toBe('partial')

    await reverseSupplierPayment({ tenantId, paymentId: pay.id, reason: 'corrección', userId })
    const ap = await getAp(inv.ap_id)
    expect(parseFloat(ap.amount_paid)).toBeCloseTo(0, 2)
    expect(ap.status).toBe('pending')
  })

  test('doble reversa → 409', async () => {
    const inv = await makeInvoice()
    const pay = await registerPayment({
      tenantId, supplierId, method: 'transfer', reference: 'TR-2',
      amount: 100, currency: 'MXN',
      applications: [{ apId: inv.ap_id, amountApplied: 100 }], userId,
    })
    await reverseSupplierPayment({ tenantId, paymentId: pay.id, reason: 'x', userId })
    await expect(reverseSupplierPayment({ tenantId, paymentId: pay.id, reason: 'y', userId }))
      .rejects.toMatchObject({ status: 409 })
  })

  test('reversa sin razón → 400', async () => {
    const inv = await makeInvoice()
    const pay = await registerPayment({
      tenantId, supplierId, method: 'cash',
      amount: 100, currency: 'MXN',
      applications: [{ apId: inv.ap_id, amountApplied: 100 }], userId,
    })
    await expect(reverseSupplierPayment({ tenantId, paymentId: pay.id, reason: '  ', userId }))
      .rejects.toMatchObject({ status: 400 })
  })
})
