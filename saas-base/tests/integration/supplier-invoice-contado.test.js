'use strict'

/**
 * Factura de proveedor: la detección de "de contado" (partner_credit_type) y el
 * vencimiento de la CXP deben basarse en `supplier_credit_days` (el crédito que el
 * PROVEEDOR te concede), NO en `credit_days` (el crédito que TÚ le das al socio como
 * CLIENTE). El bug: leía credit_days → en un socio que también es cliente con crédito,
 * un proveedor de contado salía como 'credit' y no aparecía "Pagar ahora".
 */

const { createTenant, cleanupTestTenants } = require('../helpers/factory')
const { pool, query, withBypass } = require('../../src/db')
const { registerInvoice } = require('../../src/modules/purchases/supplierInvoiceService')

let tenantId, userId

async function makePartner({ type, creditDays, supplierCreditDays }) {
  const { rows } = await withBypass(() => query(
    `INSERT INTO business_partners (tenant_id, type, name, credit_days, supplier_credit_days)
     VALUES ($1,$2,'Proveedor X',$3,$4) RETURNING id`,
    [tenantId, type, creditDays, supplierCreditDays]))
  return rows[0].id
}

describe('Factura de proveedor — "contado" usa supplier_credit_days', () => {
  beforeAll(async () => {
    const info = await createTenant({ label: 'provcontado', planSlug: 'owner' })
    tenantId = info.tenant.id
    userId = info.user.id
  })

  afterAll(async () => { await cleanupTestTenants(); await pool.end() })

  test('proveedor sin crédito (supplier_credit_days=0) → cash + genera CXP', async () => {
    const sid = await makePartner({ type: 'supplier', creditDays: 0, supplierCreditDays: 0 })
    const inv = await registerInvoice({
      tenantId, supplierId: sid, documentNumber: 'SI-CASH-1', total: 116, userId,
    })
    expect(inv.partner_credit_type).toBe('cash')
    expect(inv.ap_id).toBeTruthy()  // la CXP se genera al registrar la factura
  })

  test('proveedor con crédito (supplier_credit_days=30) → credit + vencimiento posterior', async () => {
    const sid = await makePartner({ type: 'supplier', creditDays: 0, supplierCreditDays: 30 })
    const inv = await registerInvoice({
      tenantId, supplierId: sid, documentNumber: 'SI-CRED-1', total: 116,
      invoiceDate: '2026-06-01', userId,
    })
    expect(inv.partner_credit_type).toBe('credit')
    expect(inv.due_date).not.toBe('2026-06-01')  // se aplicó el crédito del proveedor
  })

  test('REGRESIÓN: socio Ambos con crédito de CLIENTE pero proveedor de contado → cash', async () => {
    // El bug leía credit_days (cliente = 30) → daba 'credit' y no mostraba "Pagar ahora".
    const sid = await makePartner({ type: 'both', creditDays: 30, supplierCreditDays: 0 })
    const inv = await registerInvoice({
      tenantId, supplierId: sid, documentNumber: 'SI-BOTH-1', total: 116, userId,
    })
    expect(inv.partner_credit_type).toBe('cash')
  })
})
