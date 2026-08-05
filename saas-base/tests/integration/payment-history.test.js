'use strict'

/**
 * Historial de pagos: cxcService.listPayments (cobros recibidos) y
 * cxpService.listPayments (pagos emitidos) devuelven la lista cronológica de pagos
 * reales con su documento, socio y método.
 */

const { randomUUID } = require('crypto')
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

  // ─── Semáforo REP en pagos emitidos (rep_status) ──────────────────────────
  describe('rep_status en cxpService.listPayments', () => {
    // Crea factura (metodoPago PUE/PPD) + pago aplicado; devuelve el paymentId.
    async function makePaidInvoice({ suffix, metodoPago, amount }) {
      const { rows: si } = await withBypass(() => query(
        `INSERT INTO supplier_invoices
           (tenant_id, invoice_number, status, partner_id, tax, total, total_mxn,
            invoice_date, metodo_pago_sat, uuid_sat)
         VALUES ($1,$2,'paid',$3,0,$4,$4,CURRENT_DATE,$5,$6) RETURNING id`,
        [tenantId, `SI-REP-${suffix}`, partnerId, amount, metodoPago, randomUUID()]))
      const { rows: sp } = await withBypass(() => query(
        `INSERT INTO supplier_payments
           (tenant_id, partner_id, payment_date, method, amount, currency,
            exchange_rate_value, amount_mxn, created_by)
         VALUES ($1,$2,CURRENT_DATE,'transfer',$3,'MXN',1,$3,$4) RETURNING id`,
        [tenantId, partnerId, amount, userId]))
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
            supplier_payment_id, match_status, created_by)
         VALUES ($1,$2,$3,CURRENT_DATE,$4,'MXN',$5,'matched',$6)`,
        [tenantId, partnerId, randomUUID(), amount, paymentId, userId]))
    }

    let payMissing, payMatched, payMismatch, payPue

    beforeAll(async () => {
      payMissing  = await makePaidInvoice({ suffix: 'MISS',  metodoPago: 'PPD', amount: 1000 })
      payMatched  = await makePaidInvoice({ suffix: 'MATCH', metodoPago: 'PPD', amount: 2000 })
      payMismatch = await makePaidInvoice({ suffix: 'DIFF',  metodoPago: 'PPD', amount: 3000 })
      payPue      = await makePaidInvoice({ suffix: 'PUE',   metodoPago: 'PUE', amount: 4000 })
      await linkComplement({ paymentId: payMatched,  amount: 1999.5 }) // dentro de tolerancia máx($1, 0.5%)
      await linkComplement({ paymentId: payMismatch, amount: 2500 })   // fuera de tolerancia
    })

    test('cada pago trae su rep_status: missing / matched / mismatch / not_required', async () => {
      const res = await cxpService.listPayments({ tenantId, limit: 100 })
      const byId = Object.fromEntries(res.data.map(r => [r.id, r]))

      expect(byId[payMissing].rep_status).toBe('missing')
      expect(byId[payMissing].has_ppd).toBe(true)
      expect(byId[payMissing].rep_count).toBe(0)

      expect(byId[payMatched].rep_status).toBe('matched')
      expect(byId[payMatched].rep_count).toBe(1)

      expect(byId[payMismatch].rep_status).toBe('mismatch')
      expect(parseFloat(byId[payMismatch].rep_amount)).toBeCloseTo(2500, 2)

      expect(byId[payPue].rep_status).toBe('not_required')
      expect(byId[payPue].has_ppd).toBe(false)
    })

    test('filtro rep=missing acota lista Y totales', async () => {
      const res = await cxpService.listPayments({ tenantId, rep: 'missing', limit: 100 })
      expect(res.data.map(r => r.id)).toEqual([payMissing])
      expect(res.total).toBe(1)
      expect(res.totalAmount).toBeCloseTo(1000, 2)
    })

    test('filtro rep=mismatch y rep=matched separan bien', async () => {
      const mm = await cxpService.listPayments({ tenantId, rep: 'mismatch', limit: 100 })
      expect(mm.data.map(r => r.id)).toEqual([payMismatch])
      const ok = await cxpService.listPayments({ tenantId, rep: 'matched', limit: 100 })
      expect(ok.data.map(r => r.id)).toEqual([payMatched])
    })

    test('valor de filtro desconocido se ignora (no truena, no filtra)', async () => {
      const res = await cxpService.listPayments({ tenantId, rep: 'x-invalido', limit: 100 })
      expect(res.data.length).toBeGreaterThanOrEqual(4)
    })
  })
})
