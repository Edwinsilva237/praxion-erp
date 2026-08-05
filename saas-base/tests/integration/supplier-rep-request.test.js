'use strict'

/**
 * Solicitar REP (o su corrección) al proveedor desde un pago emitido — mig 242.
 *
 * Mockeamos enqueueEmail para validar el flujo sin enviar correo real:
 *   - pago PPD sin REP → 'missing': manda correo y marca rep_requested_at
 *   - pago con REP que no cuadra → 'mismatch': asunto de corrección
 *   - REP que ya cuadra → 409 (nada que solicitar)
 *   - pago solo PUE → 400 (no requiere REP)
 *   - proveedor sin contactos con correo → 400
 *   - pago reversado → 409
 */

jest.mock('../../src/queues/emailQueue', () => ({
  enqueueEmail: jest.fn().mockResolvedValue({ queued: true, jobId: 'x' }),
  emailQueue: null,
}))

const { randomUUID } = require('crypto')
const { pool, query, withBypass } = require('../../src/db')
const supplierComplementService = require('../../src/modules/purchases/supplierComplementService')
const { enqueueEmail } = require('../../src/queues/emailQueue')
const { createTenant, cleanupTestTenants } = require('../helpers/factory')

let tenantId, userId, partnerId, partnerNoEmailId, bankAccountId

beforeAll(async () => {
  const t = await createTenant({ label: 'reprequest', planSlug: 'owner' })
  tenantId = t.tenant.id
  userId   = t.user.id

  const { rows: ba } = await withBypass(() => query(
    `INSERT INTO bank_accounts (tenant_id, bank_name, alias, account_number)
     VALUES ($1,'BBVA Test','Operativa','001234567891') RETURNING id`, [tenantId]))
  bankAccountId = ba[0].id

  const { rows: sup } = await withBypass(() => query(
    `INSERT INTO business_partners (tenant_id, type, name, tax_name)
     VALUES ($1,'supplier','Prov REP','PROV REP SA DE CV') RETURNING id`, [tenantId]))
  partnerId = sup[0].id
  await withBypass(() => query(
    `INSERT INTO business_partner_contacts (business_partner_id, name, email, is_primary)
     VALUES ($1,'CxC','cobranza@prov.local',true)`, [partnerId]))

  const { rows: sup2 } = await withBypass(() => query(
    `INSERT INTO business_partners (tenant_id, type, name)
     VALUES ($1,'supplier','Prov REP Sin Correo') RETURNING id`, [tenantId]))
  partnerNoEmailId = sup2[0].id
})

afterAll(async () => { await cleanupTestTenants(); await pool.end() })

beforeEach(() => enqueueEmail.mockClear())

async function makePaidInvoice({ suffix, metodoPago, amount, partner = partnerId, bankId = null }) {
  const { rows: si } = await withBypass(() => query(
    `INSERT INTO supplier_invoices
       (tenant_id, invoice_number, status, partner_id, tax, total, total_mxn,
        invoice_date, metodo_pago_sat, uuid_sat)
     VALUES ($1,$2,'paid',$3,0,$4,$4,CURRENT_DATE,$5,$6) RETURNING id`,
    [tenantId, `SI-RREQ-${suffix}`, partner, amount, metodoPago, randomUUID()]))
  const { rows: sp } = await withBypass(() => query(
    `INSERT INTO supplier_payments
       (tenant_id, partner_id, payment_date, method, amount, currency,
        exchange_rate_value, amount_mxn, created_by, bank_account_id)
     VALUES ($1,$2,CURRENT_DATE,'transfer',$3,'MXN',1,$3,$4,$5) RETURNING id`,
    [tenantId, partner, amount, userId, bankId]))
  await withBypass(() => query(
    `INSERT INTO supplier_payment_applications
       (supplier_payment_id, supplier_invoice_id, amount_applied, created_by)
     VALUES ($1,$2,$3,$4)`, [sp[0].id, si[0].id, amount, userId]))
  return sp[0].id
}

async function linkComplement({ paymentId, amount }) {
  await withBypass(() => query(
    `INSERT INTO supplier_payment_complements
       (tenant_id, partner_id, cfdi_uuid, payment_date, amount, currency,
        supplier_payment_id, match_status)
     VALUES ($1,$2,$3,CURRENT_DATE,$4,'MXN',$5,'matched')`,
    [tenantId, partnerId, randomUUID(), amount, paymentId]))
}

test('pago PPD sin REP → solicita (missing), correo al contacto y rep_requested_at', async () => {
  const paymentId = await makePaidInvoice({
    suffix: 'MISS', metodoPago: 'PPD', amount: 1000, bankId: bankAccountId,
  })

  const res = await supplierComplementService.requestRepForPayment({ tenantId, paymentId, userId })
  expect(res.mode).toBe('missing')
  expect(res.sentTo).toEqual(['cobranza@prov.local'])
  expect(res.requested_at).toBeTruthy()

  expect(enqueueEmail).toHaveBeenCalledTimes(1)
  const call = enqueueEmail.mock.calls[0][0]
  expect(call.to).toEqual(['cobranza@prov.local'])
  expect(call.subject).toMatch(/^Solicitud de complemento de pago/)
  expect(call.html).toContain('SI-RREQ-MISS')
  // Datos para que el proveedor rastree la transferencia: método + banco
  // emisor con últimos 4 de la cuenta (nunca la cuenta completa).
  expect(call.html).toContain('Transferencia')
  expect(call.html).toContain('BBVA Test (cuenta •••• 7891)')
  expect(call.html).not.toContain('001234567891')

  const { rows } = await withBypass(() => query(
    `SELECT rep_requested_at FROM supplier_payments WHERE id = $1`, [paymentId]))
  expect(rows[0].rep_requested_at).toBeTruthy()
})

test('REP ligado que NO cuadra → solicita corrección (mismatch) con la diferencia', async () => {
  const paymentId = await makePaidInvoice({ suffix: 'DIFF', metodoPago: 'PPD', amount: 3000 })
  await linkComplement({ paymentId, amount: 2500 })

  const res = await supplierComplementService.requestRepForPayment({ tenantId, paymentId, userId })
  expect(res.mode).toBe('mismatch')

  const call = enqueueEmail.mock.calls[0][0]
  expect(call.subject).toMatch(/^Corrección de complemento de pago/)
  expect(call.html).toContain('no coincide con el pago realizado')
})

test('REP que ya cuadra → 409', async () => {
  const paymentId = await makePaidInvoice({ suffix: 'OK', metodoPago: 'PPD', amount: 2000 })
  await linkComplement({ paymentId, amount: 2000 })

  await expect(supplierComplementService.requestRepForPayment({ tenantId, paymentId, userId }))
    .rejects.toMatchObject({ status: 409 })
  expect(enqueueEmail).not.toHaveBeenCalled()
})

test('pago solo PUE → 400 (no requiere REP)', async () => {
  const paymentId = await makePaidInvoice({ suffix: 'PUE', metodoPago: 'PUE', amount: 500 })
  await expect(supplierComplementService.requestRepForPayment({ tenantId, paymentId, userId }))
    .rejects.toMatchObject({ status: 400 })
})

test('proveedor sin contactos con correo → 400 accionable', async () => {
  const paymentId = await makePaidInvoice({
    suffix: 'NOMAIL', metodoPago: 'PPD', amount: 700, partner: partnerNoEmailId,
  })
  await expect(supplierComplementService.requestRepForPayment({ tenantId, paymentId, userId }))
    .rejects.toMatchObject({ status: 400, message: expect.stringContaining('contactos con correo') })
})

test('pago reversado → 409', async () => {
  const paymentId = await makePaidInvoice({ suffix: 'REV', metodoPago: 'PPD', amount: 800 })
  await withBypass(() => query(
    `UPDATE supplier_payments SET reversed_at = NOW() WHERE id = $1`, [paymentId]))
  await expect(supplierComplementService.requestRepForPayment({ tenantId, paymentId, userId }))
    .rejects.toMatchObject({ status: 409 })
})
