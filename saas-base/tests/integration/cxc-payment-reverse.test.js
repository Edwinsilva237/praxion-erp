'use strict'

/**
 * Reversa de cobros de cliente — cxcService.reversePayment.
 *
 *  - Reversa de un cobro sin complemento (remisión): revierte saldo + marca
 *    reversado + lo saca del historial.
 *  - Reversa de una aplicación de anticipo: devuelve el saldo al anticipo.
 *  - Doble reversa: 409.
 *  - Reversa de un cobro que timbró complemento (CFDI tipo P): lo CANCELA ante
 *    el SAT (Facturapi mockeado) con motivo '02' y lo marca `cancelled`.
 */

// Facturapi mockeado (no se llama al SAT real en tests).
jest.mock('../../src/modules/invoicing/facturapiClient')

const { createTenant, cleanupTestTenants } = require('../helpers/factory')
const { pool, query, withBypass } = require('../../src/db')
const cxcService = require('../../src/modules/financials/cxcService')
const facturapiClient = require('../../src/modules/invoicing/facturapiClient')

let tenantId, userId, partnerId

async function newRemissionAR(amountTotal) {
  const { rows } = await withBypass(() => query(
    `INSERT INTO accounts_receivable
       (tenant_id, partner_id, document_type, document_id, document_number,
        currency, exchange_rate, amount_total, issue_date, created_by)
     VALUES ($1,$2,'remission', uuid_generate_v4(), 'REM-REV',
             'MXN', 1, $3, CURRENT_DATE, $4)
     RETURNING id`,
    [tenantId, partnerId, amountTotal, userId]))
  return rows[0].id
}

async function getAR(arId) {
  const { rows } = await withBypass(() => query(
    `SELECT amount_paid, amount_pending, status FROM accounts_receivable WHERE id = $1`, [arId]))
  return rows[0]
}

async function firstPaymentId(arId) {
  const { rows } = await withBypass(() => query(
    `SELECT id FROM ar_payments WHERE ar_id = $1 ORDER BY created_at ASC LIMIT 1`, [arId]))
  return rows[0].id
}

describe('Reversa de cobros (cxcService.reversePayment)', () => {
  beforeAll(async () => {
    const info = await createTenant({ label: 'cxcrev', planSlug: 'owner' })
    tenantId = info.tenant.id
    userId   = info.user.id
    const { rows } = await withBypass(() => query(
      `INSERT INTO business_partners (tenant_id, type, name)
       VALUES ($1,'both','Socio Reversa') RETURNING id`, [tenantId]))
    partnerId = rows[0].id
  })

  afterAll(async () => { await cleanupTestTenants(); await pool.end() })

  test('reversa un cobro sin complemento: revierte saldo y sale del historial', async () => {
    const arId = await newRemissionAR(1000)
    await cxcService.registerPayment({
      tenantId, partnerId, method: 'cash', amount: 1000,
      applications: [{ arId, amountApplied: 1000 }], userId,
    })

    let ar = await getAR(arId)
    expect(parseFloat(ar.amount_paid)).toBeCloseTo(1000, 2)
    expect(ar.status).toBe('paid')

    const payId = await firstPaymentId(arId)
    const res = await cxcService.reversePayment({ tenantId, paymentId: payId, reason: 'cobro mal aplicado', userId })
    expect(res.reversed).toBe(true)
    expect(res.newStatus).toBe('pending')
    expect(res.complementCancelled).toBeNull()

    ar = await getAR(arId)
    expect(parseFloat(ar.amount_paid)).toBeCloseTo(0, 2)
    expect(parseFloat(ar.amount_pending)).toBeCloseTo(1000, 2)  // columna generada
    expect(ar.status).toBe('pending')

    // El cobro reversado NO aparece en el historial de cobros.
    const hist = await cxcService.listPayments({ tenantId })
    expect(hist.data.find(p => p.id === payId)).toBeUndefined()
  })

  test('reversa una aplicación de anticipo devuelve el saldo al anticipo', async () => {
    const { rows: adv } = await withBypass(() => query(
      `INSERT INTO ar_advances
         (tenant_id, partner_id, amount, payment_method, receipt_date, created_by)
       VALUES ($1,$2,500,'transfer',CURRENT_DATE,$3) RETURNING id`,
      [tenantId, partnerId, userId]))
    const advanceId = adv[0].id

    const arId = await newRemissionAR(1000)
    await cxcService.applyAdvance({
      tenantId, partnerId, advanceId,
      applications: [{ arId, amountApplied: 300 }], userId,
    })

    let ar = await getAR(arId)
    expect(parseFloat(ar.amount_paid)).toBeCloseTo(300, 2)

    const payId = await firstPaymentId(arId)
    await cxcService.reversePayment({ tenantId, paymentId: payId, reason: 'anticipo mal aplicado', userId })

    ar = await getAR(arId)
    expect(parseFloat(ar.amount_paid)).toBeCloseTo(0, 2)
    expect(ar.status).toBe('pending')

    const { rows: a2 } = await withBypass(() => query(
      `SELECT amount_applied, amount_available FROM ar_advances WHERE id = $1`, [advanceId]))
    expect(parseFloat(a2[0].amount_applied)).toBeCloseTo(0, 2)       // saldo devuelto
    expect(parseFloat(a2[0].amount_available)).toBeCloseTo(500, 2)
  })

  test('doble reversa del mismo cobro lanza 409', async () => {
    const arId = await newRemissionAR(400)
    await cxcService.registerPayment({
      tenantId, partnerId, method: 'cash', amount: 400,
      applications: [{ arId, amountApplied: 400 }], userId,
    })
    const payId = await firstPaymentId(arId)
    await cxcService.reversePayment({ tenantId, paymentId: payId, reason: 'x', userId })

    await expect(
      cxcService.reversePayment({ tenantId, paymentId: payId, reason: 'otra vez', userId })
    ).rejects.toMatchObject({ status: 409 })
  })

  test('reversa de un cobro con complemento timbrado lo cancela ante el SAT (motivo 02)', async () => {
    const cancelSpy = jest.fn(async () => ({}))
    facturapiClient.getFacturapiForTenant.mockResolvedValue({ invoices: { cancel: cancelSpy } })

    // Factura mínima + AR factura + complemento timbrado + cobro ligado.
    const { rows: inv } = await withBypass(() => query(
      `INSERT INTO invoices (tenant_id, type, document_number, partner_id, status, total_mxn)
       VALUES ($1,'issued','F-REV-1',$2,'stamped',1160) RETURNING id`, [tenantId, partnerId]))
    const invoiceId = inv[0].id

    const { rows: ar } = await withBypass(() => query(
      `INSERT INTO accounts_receivable
         (tenant_id, partner_id, document_type, document_id, document_number,
          currency, exchange_rate, amount_total, amount_paid, status, issue_date, created_by)
       VALUES ($1,$2,'invoice',$3,'F-REV-1','MXN',1,1160,1160,'paid',CURRENT_DATE,$4)
       RETURNING id`, [tenantId, partnerId, invoiceId, userId]))
    const arId = ar[0].id

    const { rows: pc } = await withBypass(() => query(
      `INSERT INTO payment_complements
         (tenant_id, invoice_id, facturapi_id, cfdi_uuid, payment_date,
          payment_form, amount, currency, status, created_by)
       VALUES ($1,$2,'comp_rev_1', uuid_generate_v4(), CURRENT_DATE,
               '03', 1160, 'MXN', 'stamped', $3)
       RETURNING id, cfdi_uuid`, [tenantId, invoiceId, userId]))
    const complementId = pc[0].id

    const { rows: pay } = await withBypass(() => query(
      `INSERT INTO ar_payments
         (tenant_id, ar_id, amount, payment_method, reference, payment_date, created_by, payment_complement_id)
       VALUES ($1,$2,1160,'transfer','SPEI-1',CURRENT_DATE,$3,$4) RETURNING id`,
      [tenantId, arId, userId, complementId]))
    const payId = pay[0].id

    const res = await cxcService.reversePayment({ tenantId, paymentId: payId, reason: 'cobro duplicado', userId })

    // Se canceló el CFDI tipo P ante Facturapi con motivo 02.
    expect(cancelSpy).toHaveBeenCalledWith('comp_rev_1', { motive: '02' })
    expect(res.complementCancelled).toBe(pc[0].cfdi_uuid)

    // Complemento marcado cancelado + saldo revertido.
    const { rows: pcAfter } = await withBypass(() => query(
      `SELECT status FROM payment_complements WHERE id = $1`, [complementId]))
    expect(pcAfter[0].status).toBe('cancelled')

    const arAfter = await getAR(arId)
    expect(parseFloat(arAfter.amount_paid)).toBeCloseTo(0, 2)
    expect(arAfter.status).toBe('pending')
  })
})
