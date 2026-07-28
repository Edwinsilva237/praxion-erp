'use strict'

/**
 * Ventas del periodo — las REVERSAS restan (pedido del usuario 2026-07-28:
 * "cuando se genera una NC debería restar del resumen de ventas, ¿no?").
 *
 * getSalesSnapshot ahora expone `credits` (NC timbradas del periodo +
 * devoluciones de venta SIN factura confirmadas) y `net_total` = total − credits.
 * Las devoluciones CON factura NO cuentan aquí: su resta entra por la NC cuando
 * se timbra — así ninguna reversa se cuenta dos veces.
 */

const { createTenant, cleanupTestTenants } = require('../helpers/factory')
const { pool, query, withBypass } = require('../../src/db')
const { getFinancialSnapshot } = require('../../src/modules/reports/financialSnapshot')

let tenantId, userId, partnerId

beforeAll(async () => {
  const t = await createTenant({ label: 'snapcred', planSlug: 'owner' })
  tenantId = t.tenant.id; userId = t.user.id
  const { rows } = await withBypass(() => query(
    `INSERT INTO business_partners (tenant_id, type, name)
     VALUES ($1, 'customer', 'Cliente credits') RETURNING id`, [tenantId]))
  partnerId = rows[0].id
})
afterAll(async () => { await cleanupTestTenants(); await pool.end() })

test('NC timbradas y devoluciones sin factura restan del total; con factura no duplica', async () => {
  // Venta bruta: factura timbrada 1160 + remisión sin facturar 500 = 1660.
  const inv = (await withBypass(() => query(
    `INSERT INTO invoices (tenant_id, type, cfdi_type, document_number, partner_id, status,
                           stamp_date, subtotal, tax_transferred, total, total_mxn)
     VALUES ($1,'issued','I','F-CRED-1',$2,'stamped',NOW(),1000,160,1160,1160) RETURNING id`,
    [tenantId, partnerId]))).rows[0]
  const dn = (await withBypass(() => query(
    `INSERT INTO delivery_notes (tenant_id, type, document_number, partner_id, total_mxn,
                                 subtotal_mxn, status, delivered_at, issue_date)
     VALUES ($1,'sale','R-CRED-1',$2,500,500,'delivered',NOW(),CURRENT_DATE) RETURNING id`,
    [tenantId, partnerId]))).rows[0]

  // Reversa 1: NC timbrada de 116 ligada a la factura.
  await withBypass(() => query(
    `INSERT INTO invoices (tenant_id, type, cfdi_type, document_number, partner_id, status,
                           stamp_date, subtotal, tax_transferred, total, total_mxn, related_invoice_id)
     VALUES ($1,'issued','E','NC-CRED-1',$2,'stamped',NOW(),100,16,116,116,$3)`,
    [tenantId, partnerId, inv.id]))

  // Reversa 2: devolución SIN factura confirmada de 100.
  await withBypass(() => query(
    `INSERT INTO sales_returns (tenant_id, return_number, partner_id, source_delivery_note_id,
                                status, return_date, total_mxn, credit_status, confirmed_at, created_by)
     VALUES ($1,'DEV-CRED-1',$2,$3,'confirmed',CURRENT_DATE,100,'not_applicable',NOW(),$4)`,
    [tenantId, partnerId, dn.id, userId]))

  // Devolución CON factura confirmada (999): NO debe restar — su reversa
  // entraría por su NC al timbrarse.
  await withBypass(() => query(
    `INSERT INTO sales_returns (tenant_id, return_number, partner_id, source_delivery_note_id,
                                source_invoice_id, status, return_date, total_mxn, credit_status,
                                confirmed_at, created_by)
     VALUES ($1,'DEV-CRED-2',$2,$3,$4,'confirmed',CURRENT_DATE,999,'pending',NOW(),$5)`,
    [tenantId, partnerId, dn.id, inv.id, userId]))

  const snap = (await getFinancialSnapshot({ tenantId })).sales
  expect(snap.total).toBeCloseTo(1660, 2)                       // bruta intacta
  expect(snap.credits.credit_notes).toBeCloseTo(116, 2)
  expect(snap.credits.credit_notes_count).toBe(1)
  expect(snap.credits.returns_uninvoiced).toBeCloseTo(100, 2)   // la de 999 NO
  expect(snap.credits.returns_count).toBe(1)
  expect(snap.credits.total).toBeCloseTo(216, 2)
  expect(snap.net_total).toBeCloseTo(1444, 2)
})
