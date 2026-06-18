'use strict'

/**
 * Tarjeta de IVA del dashboard (financialSnapshot.getIvaSnapshot): el "IVA cobrado/
 * pagado del mes" se calcula AL COBRO — sobre los PAGOS del mes, prorrateando la
 * porción de IVA de cada pago según IVA/total de su factura. Antes sumaba el IVA de
 * las facturas EMITIDAS, lo que inflaba el "cobrado" con facturas aún no pagadas.
 */

const { createTenant, cleanupTestTenants } = require('../helpers/factory')
const { pool, query, withBypass } = require('../../src/db')
const { getFinancialSnapshot } = require('../../src/modules/reports/financialSnapshot')
const supplierInvoiceService = require('../../src/modules/purchases/supplierInvoiceService')

let tenantId, userId, partnerId

describe('IVA del mes — base AL COBRO (sobre pagos, no facturas emitidas)', () => {
  beforeAll(async () => {
    const info = await createTenant({ label: 'ivacobro', planSlug: 'owner' })
    tenantId = info.tenant.id
    userId = info.user.id
    const { rows } = await withBypass(() => query(
      `INSERT INTO business_partners (tenant_id, type, name)
       VALUES ($1,'both','Socio IVA') RETURNING id`, [tenantId]))
    partnerId = rows[0].id
  })

  afterAll(async () => { await cleanupTestTenants(); await pool.end() })

  test('IVA cobrado = porción de IVA del PAGO recibido, no del total facturado', async () => {
    // Factura timbrada: total 1160, IVA 160 → ratio de IVA = 160/1160.
    const { rows: inv } = await withBypass(() => query(
      `INSERT INTO invoices
         (tenant_id, type, cfdi_type, document_number, partner_id, status, stamp_date,
          subtotal, tax_transferred, total, total_mxn)
       VALUES ($1,'issued','I','F-IVA-1',$2,'stamped',CURRENT_DATE,1000,160,1160,1160) RETURNING id`,
      [tenantId, partnerId]))
    const { rows: ar } = await withBypass(() => query(
      `INSERT INTO accounts_receivable
         (tenant_id, partner_id, document_type, document_id, document_number,
          currency, exchange_rate, amount_total, issue_date, created_by)
       VALUES ($1,$2,'invoice',$3,'F-IVA-1','MXN',1,1160,CURRENT_DATE,$4) RETURNING id`,
      [tenantId, partnerId, inv[0].id, userId]))
    // Cobro PARCIAL de 580 (la mitad) este mes → IVA cobrado = 580 × 160/1160 = 80.
    await withBypass(() => query(
      `INSERT INTO ar_payments (tenant_id, ar_id, amount, payment_method, payment_date, created_by)
       VALUES ($1,$2,580,'transfer',CURRENT_DATE,$3)`,
      [tenantId, ar[0].id, userId]))

    const snap = await getFinancialSnapshot({ tenantId })
    expect(snap.iva.transferred).toBeCloseTo(80, 2)  // ← no 160 (lo facturado)
  })

  test('IVA pagado = porción de IVA del pago a proveedor; neto a pagar', async () => {
    // Factura de proveedor con CFDI: total 580, IVA 80.
    const { rows: si } = await withBypass(() => query(
      `INSERT INTO supplier_invoices
         (tenant_id, invoice_number, status, partner_id, uuid_sat, tax, total, total_mxn, invoice_date)
       VALUES ($1,'SI-1','pending',$2,gen_random_uuid(),80,580,580,CURRENT_DATE) RETURNING id`,
      [tenantId, partnerId]))
    const { rows: sp } = await withBypass(() => query(
      `INSERT INTO supplier_payments
         (tenant_id, partner_id, payment_date, method, amount, currency, exchange_rate_value, amount_mxn, created_by)
       VALUES ($1,$2,CURRENT_DATE,'transfer',290,'MXN',1,290,$3) RETURNING id`,
      [tenantId, partnerId, userId]))
    // Aplica 290 (la mitad) → IVA pagado = 290 × 80/580 = 40.
    await withBypass(() => query(
      `INSERT INTO supplier_payment_applications
         (supplier_payment_id, supplier_invoice_id, amount_applied, created_by)
       VALUES ($1,$2,290,$3)`,
      [sp[0].id, si[0].id, userId]))

    const snap = await getFinancialSnapshot({ tenantId })
    expect(snap.iva.creditable).toBeCloseTo(40, 2)
    expect(snap.iva.transferred).toBeCloseTo(80, 2)  // del test anterior
    expect(snap.iva.net).toBeCloseTo(40, 2)          // 80 − 40
    expect(snap.iva.direction).toBe('to_pay')
  })

  // El IVA de los GASTOS (supplier_invoices.is_expense = true) también es acreditable:
  // misma tabla, la query NO filtra por is_expense. Pero AL PAGO → solo cuenta cuando
  // el gasto se liquida. Esto valida que el botón "Marcar como pagado" hace que su IVA
  // aparezca, y que se cuenta UNA sola vez (sin duplicar).
  test('gasto con CFDI: su IVA NO cuenta hasta pagarlo, y entra UNA sola vez al liquidarlo', async () => {
    const before = (await getFinancialSnapshot({ tenantId })).iva.creditable  // 40 (acumulado)

    // Gasto con CFDI: subtotal 1000, IVA 160, total 1160. Crea su CXP (proveedor de catálogo).
    const exp = await supplierInvoiceService.registerInvoice({
      tenantId, supplierId: partnerId,
      documentNumber: 'GASTO-IVA-1',
      uuidSat: '0a000000-0000-0000-0000-0000000000aa',
      subtotal: 1000, tax: 160, total: 1160,
      invoiceDate: new Date().toISOString().slice(0, 10), currency: 'MXN',
      isExpense: true, expenseCategoryId: null, userId,
    })
    expect(exp.ap_id).toBeTruthy()

    // Aún SIN pagar → el IVA del gasto NO debe sumar (base al pago).
    const unpaid = (await getFinancialSnapshot({ tenantId })).iva.creditable
    expect(unpaid).toBeCloseTo(before, 2)

    // Marcar pagado de contado → registra el pago y aplica a la CXP.
    await supplierInvoiceService.payExpense({ tenantId, id: exp.id, method: 'cash' })

    // Ahora el IVA del gasto (160) entra exactamente una vez: before + 160.
    const after = (await getFinancialSnapshot({ tenantId })).iva.creditable
    expect(after).toBeCloseTo(before + 160, 2)
  })
})
