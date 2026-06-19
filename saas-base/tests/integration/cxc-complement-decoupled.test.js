'use strict'

/**
 * Desacople cobro ↔ complemento de pago (cxcService.registerPayment).
 *
 * Regla nueva: el COBRO siempre se registra. El timbrado del complemento (CFDI
 * tipo P) ocurre DESPUÉS del commit; si Facturapi falla (p.ej. 503 "Service
 * Unavailable"), el cobro NO se pierde — el complemento queda PENDIENTE y se
 * reporta al operador, que puede timbrarlo luego.
 */

jest.mock('../../src/modules/invoicing/facturapiClient')

const { createTenant, cleanupTestTenants } = require('../helpers/factory')
const { pool, query, withBypass } = require('../../src/db')
const cxcService = require('../../src/modules/financials/cxcService')
const facturapiClient = require('../../src/modules/invoicing/facturapiClient')

let tenantId, userId, partnerId

// Factura PPD timbrada + su CXC. Lista para generar complemento de pago.
async function newPpdInvoiceAR(amountTotal) {
  const { rows: inv } = await withBypass(() => query(
    `INSERT INTO invoices
       (tenant_id, type, document_number, partner_id, status, payment_method,
        currency, cfdi_uuid, total, total_mxn, notes)
     VALUES ($1,'issued', $2, $3,'stamped','PPD','MXN',
             uuid_generate_v4(), $4, $4, '[facturapi_id:fa_test_orig]')
     RETURNING id, document_number`,
    [tenantId, `E-PPD-${Math.floor(amountTotal)}-${Date.now() % 100000}`, partnerId, amountTotal]))
  const invoiceId = inv[0].id

  const { rows: ar } = await withBypass(() => query(
    `INSERT INTO accounts_receivable
       (tenant_id, partner_id, document_type, document_id, document_number,
        currency, exchange_rate, amount_total, issue_date, created_by)
     VALUES ($1,$2,'invoice',$3,$4,'MXN',1,$5,CURRENT_DATE,$6)
     RETURNING id`,
    [tenantId, partnerId, invoiceId, inv[0].document_number, amountTotal, userId]))
  return { arId: ar[0].id, invoiceId }
}

async function getAR(arId) {
  const { rows } = await withBypass(() => query(
    `SELECT amount_paid, status FROM accounts_receivable WHERE id = $1`, [arId]))
  return rows[0]
}

async function paymentRow(arId) {
  const { rows } = await withBypass(() => query(
    `SELECT id, amount, payment_complement_id FROM ar_payments WHERE ar_id = $1
      ORDER BY created_at DESC LIMIT 1`, [arId]))
  return rows[0]
}

async function complementCount(invoiceId) {
  const { rows } = await withBypass(() => query(
    `SELECT COUNT(*)::int AS n FROM payment_complements WHERE invoice_id = $1`, [invoiceId]))
  return rows[0].n
}

describe('Desacople cobro ↔ complemento (registerPayment)', () => {
  beforeAll(async () => {
    const info = await createTenant({ label: 'cxcdec', planSlug: 'owner' })
    tenantId = info.tenant.id
    userId   = info.user.id
    const { rows } = await withBypass(() => query(
      `INSERT INTO business_partners (tenant_id, type, name, rfc, zip_code, tax_regime_code)
       VALUES ($1,'both','Cliente PPD','XAXX010101000','60000','601') RETURNING id`, [tenantId]))
    partnerId = rows[0].id
  })

  afterAll(async () => { await cleanupTestTenants(); await pool.end() })

  test('Facturapi 503: el cobro se registra y el complemento queda PENDIENTE', async () => {
    facturapiClient.getFacturapiForTenant.mockResolvedValue({
      invoices: {
        create: jest.fn(async () => {
          const e = new Error('Service Unavailable')
          e.status = 503
          throw e
        }),
      },
    })

    const { arId, invoiceId } = await newPpdInvoiceAR(1160)

    const res = await cxcService.registerPayment({
      tenantId, partnerId, method: 'transfer', reference: 'SPEI-503',
      amount: 1160, applications: [{ arId, amountApplied: 1160 }], userId,
    })

    // El cobro SÍ quedó registrado pese al fallo de timbrado.
    const ar = await getAR(arId)
    expect(parseFloat(ar.amount_paid)).toBeCloseTo(1160, 2)
    expect(ar.status).toBe('paid')

    const pay = await paymentRow(arId)
    expect(parseFloat(pay.amount)).toBeCloseTo(1160, 2)
    expect(pay.payment_complement_id).toBeNull()   // sin complemento ligado

    // El complemento se reporta PENDIENTE (transitorio) y NO se emitió ni guardó.
    expect(res.complementsIssued).toHaveLength(0)
    expect(res.complementsPending).toHaveLength(1)
    expect(res.complementsPending[0].transient).toBe(true)
    expect(res.complementsPending[0].ar_id).toBe(arId)
    expect(await complementCount(invoiceId)).toBe(0)
  }, 30000)

  test('Facturapi OK: el cobro se registra Y el complemento se timbra y liga', async () => {
    facturapiClient.getFacturapiForTenant.mockResolvedValue({
      invoices: {
        create: jest.fn(async () => ({ id: 'fa_comp_ok', uuid: '11111111-2222-3333-4444-555555555555' })),
      },
    })

    const { arId, invoiceId } = await newPpdInvoiceAR(580)

    const res = await cxcService.registerPayment({
      tenantId, partnerId, method: 'transfer', reference: 'SPEI-OK',
      amount: 580, applications: [{ arId, amountApplied: 580 }], userId,
    })

    expect(res.complementsPending).toHaveLength(0)
    expect(res.complementsIssued).toHaveLength(1)
    expect(res.complementsIssued[0].uuid).toBe('11111111-2222-3333-4444-555555555555')

    expect(await complementCount(invoiceId)).toBe(1)

    const pay = await paymentRow(arId)
    expect(pay.payment_complement_id).not.toBeNull()  // cobro ↔ complemento ligados
  }, 30000)
})
