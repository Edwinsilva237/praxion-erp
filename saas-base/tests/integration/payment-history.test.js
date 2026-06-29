'use strict'

/**
 * Historial de pagos: cxcService.listPayments (cobros recibidos) y
 * cxpService.listPayments (pagos emitidos) devuelven la lista cronológica de pagos
 * reales con su documento, socio y método.
 */

const { createTenant, cleanupTestTenants } = require('../helpers/factory')
const { pool, query, withBypass } = require('../../src/db')
const cxcService = require('../../src/modules/financials/cxcService')
const cxpService = require('../../src/modules/purchases/cxpService')

let tenantId, userId, partnerId

describe('Historial de pagos (recibidos / emitidos)', () => {
  beforeAll(async () => {
    const info = await createTenant({ label: 'paymhist', planSlug: 'owner' })
    tenantId = info.tenant.id
    userId = info.user.id
    const { rows } = await withBypass(() => query(
      `INSERT INTO business_partners (tenant_id, type, name)
       VALUES ($1,'both','Socio Pagos') RETURNING id`, [tenantId]))
    partnerId = rows[0].id
  })

  afterAll(async () => { await cleanupTestTenants(); await pool.end() })

  test('listPayments (cobros) devuelve el cobro con documento y socio', async () => {
    const { rows: inv } = await withBypass(() => query(
      `INSERT INTO invoices (tenant_id, type, document_number, partner_id, status, total_mxn)
       VALUES ($1,'issued','F-HIST-1',$2,'draft',1160) RETURNING id`, [tenantId, partnerId]))
    const { rows: ar } = await withBypass(() => query(
      `INSERT INTO accounts_receivable
         (tenant_id, partner_id, document_type, document_id, document_number,
          currency, exchange_rate, amount_total, issue_date, created_by)
       VALUES ($1,$2,'invoice',$3,'F-HIST-1','MXN',1,1160,CURRENT_DATE,$4) RETURNING id`,
      [tenantId, partnerId, inv[0].id, userId]))
    await withBypass(() => query(
      `INSERT INTO ar_payments (tenant_id, ar_id, amount, payment_method, payment_date, created_by)
       VALUES ($1,$2,580,'transfer',CURRENT_DATE,$3)`, [tenantId, ar[0].id, userId]))

    const res = await cxcService.listPayments({ tenantId })
    expect(res.total).toBe(1)
    expect(res.totalAmount).toBeCloseTo(580, 2)
    expect(res.data[0].document_number).toBe('F-HIST-1')
    expect(res.data[0].partner_name).toBe('Socio Pagos')
    expect(res.data[0].payment_method).toBe('transfer')
  })

  test('listPayments (pagos a proveedor) devuelve el pago con documentos aplicados', async () => {
    const { rows: si } = await withBypass(() => query(
      `INSERT INTO supplier_invoices
         (tenant_id, invoice_number, status, partner_id, tax, total, total_mxn, invoice_date)
       VALUES ($1,'SI-HIST-1','pending',$2,80,580,580,CURRENT_DATE) RETURNING id`,
      [tenantId, partnerId]))
    const { rows: sp } = await withBypass(() => query(
      `INSERT INTO supplier_payments
         (tenant_id, partner_id, payment_date, method, amount, currency, exchange_rate_value, amount_mxn, created_by)
       VALUES ($1,$2,CURRENT_DATE,'cash',300,'MXN',1,300,$3) RETURNING id`,
      [tenantId, partnerId, userId]))
    await withBypass(() => query(
      `INSERT INTO supplier_payment_applications (supplier_payment_id, supplier_invoice_id, amount_applied, created_by)
       VALUES ($1,$2,300,$3)`, [sp[0].id, si[0].id, userId]))

    const res = await cxpService.listPayments({ tenantId })
    expect(res.total).toBe(1)
    expect(res.totalAmount).toBeCloseTo(300, 2)
    expect(res.data[0].partner_name).toBe('Socio Pagos')
    expect(res.data[0].payment_method).toBe('cash')
    expect(res.data[0].applied_docs).toContain('SI-HIST-1')
  })

  test('filtro por método acota el resultado', async () => {
    const res = await cxcService.listPayments({ tenantId, method: 'cash' })
    expect(res.total).toBe(0)  // el único cobro fue 'transfer'
  })

  test('listPayments y getPaymentDetail exponen el complemento de pago ligado', async () => {
    const { rows: inv } = await withBypass(() => query(
      `INSERT INTO invoices (tenant_id, type, document_number, partner_id, status,
                             payment_method, currency, cfdi_uuid, total, total_mxn, notes)
       VALUES ($1,'issued','F-COMP-1',$2,'stamped','PPD','MXN',uuid_generate_v4(),1160,1160,'[facturapi_id:fa_x]')
       RETURNING id`, [tenantId, partnerId]))
    const { rows: ar } = await withBypass(() => query(
      `INSERT INTO accounts_receivable
         (tenant_id, partner_id, document_type, document_id, document_number,
          currency, exchange_rate, amount_total, issue_date, created_by)
       VALUES ($1,$2,'invoice',$3,'F-COMP-1','MXN',1,1160,CURRENT_DATE,$4) RETURNING id`,
      [tenantId, partnerId, inv[0].id, userId]))
    const { rows: pc } = await withBypass(() => query(
      `INSERT INTO payment_complements
         (tenant_id, invoice_id, facturapi_id, cfdi_uuid, payment_date, payment_form, amount, currency, status, created_by)
       VALUES ($1,$2,'fa_comp_hist','12345678-90ab-cdef-1234-567890abcdef',CURRENT_DATE,'03',1160,'MXN','stamped',$3)
       RETURNING id`, [tenantId, inv[0].id, userId]))
    const { rows: pay } = await withBypass(() => query(
      `INSERT INTO ar_payments (tenant_id, ar_id, amount, payment_method, payment_date, created_by, payment_complement_id)
       VALUES ($1,$2,1160,'transfer',CURRENT_DATE,$3,$4) RETURNING id`,
      [tenantId, ar[0].id, userId, pc[0].id]))

    const list = await cxcService.listPayments({ tenantId, method: 'transfer' })
    const row = list.data.find(r => r.id === pay[0].id)
    expect(row.complement_facturapi_id).toBe('fa_comp_hist')
    expect(row.complement_status).toBe('stamped')

    const detail = await cxcService.getPaymentDetail({ tenantId, paymentId: pay[0].id })
    expect(detail.complement_facturapi_id).toBe('fa_comp_hist')
    expect(detail.complement_uuid).toBe('12345678-90ab-cdef-1234-567890abcdef')
    expect(detail.document_number).toBe('F-COMP-1')
    expect(parseFloat(detail.amount)).toBeCloseTo(1160, 2)
  })
})
