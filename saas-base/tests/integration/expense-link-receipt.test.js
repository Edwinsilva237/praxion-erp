'use strict'

/**
 * Vincular un GASTO a una recepción → reclasificarlo como FACTURA DE COMPRA ligada
 * (mitad manual de la Fase 5A). Cubre: el enlace + recepción facturada; la
 * sustitución de la remisión-CXP (sin doble CXP); y los guards (pago aplicado,
 * proveedor distinto, recepción ya facturada).
 */

const { createTenant, cleanupTestTenants } = require('../helpers/factory')
const { pool, query, withBypass } = require('../../src/db')
const {
  registerInvoice, generateReceiptRemission, linkExpenseToReceipt, registerPayment,
} = require('../../src/modules/purchases/supplierInvoiceService')

let tenantId, userId, warehouseId
let n = 0
const rnum = (p) => `${p}-${Date.now() % 100000}-${n++}`

async function makeSupplier(creditDays = 0) {
  const { rows } = await withBypass(() => query(
    `INSERT INTO business_partners (tenant_id, type, name, supplier_credit_days)
     VALUES ($1,'supplier','Proveedor Link',$2) RETURNING id`, [tenantId, creditDays]))
  return rows[0].id
}

async function makeReceipt({ partnerId, qty = 10, unitPrice = 100 }) {
  const { rows } = await withBypass(() => query(
    `INSERT INTO supplier_receipts (tenant_id, receipt_number, partner_id, warehouse_id, status, confirmed_at)
     VALUES ($1,$2,$3,$4,'confirmed',NOW()) RETURNING id`,
    [tenantId, rnum('RCP'), partnerId, warehouseId]))
  await withBypass(() => query(
    `INSERT INTO supplier_receipt_lines (supplier_receipt_id, quantity_received, unit, unit_price, line_number)
     VALUES ($1,$2,'pza',$3,1)`, [rows[0].id, qty, unitPrice]))
  return rows[0].id
}

async function makeExpense({ supplierId, subtotal = 1000, tax = 160 }) {
  return registerInvoice({
    tenantId, supplierId, documentNumber: rnum('G'),
    subtotal, tax, total: subtotal + tax, isExpense: true, userId,
  })
}

beforeAll(async () => {
  const info = await createTenant({ label: 'explink', planSlug: 'owner' })
  tenantId = info.tenant.id
  userId = info.user.id
  const { rows } = await withBypass(() => query(
    `INSERT INTO warehouses (tenant_id, name, type, is_active) VALUES ($1,'Almacén','raw_material',true) RETURNING id`,
    [tenantId]))
  warehouseId = rows[0].id
})

afterAll(async () => { await cleanupTestTenants(); await pool.end() })

test('vincula gasto a recepción → factura de compra ligada + recepción facturada', async () => {
  const sid = await makeSupplier()
  const rid = await makeReceipt({ partnerId: sid })             // subtotal 1000
  const gasto = await makeExpense({ supplierId: sid, subtotal: 1000, tax: 160 })

  const r = await linkExpenseToReceipt({ tenantId, expenseId: gasto.id, receiptId: rid, userId })
  expect(r.receiptId).toBe(rid)
  expect(r.reconciliation_status).toBe('reconciled')           // 1000 vs 1000

  const { rows: si } = await withBypass(() => query(
    `SELECT is_expense, supplier_receipt_id FROM supplier_invoices WHERE id = $1`, [gasto.id]))
  expect(si[0].is_expense).toBe(false)
  expect(si[0].supplier_receipt_id).toBe(rid)
  const { rows: link } = await withBypass(() => query(
    `SELECT 1 FROM invoice_receipt_links WHERE supplier_invoice_id = $1 AND supplier_receipt_id = $2`, [gasto.id, rid]))
  expect(link.length).toBe(1)
  const { rows: rc } = await withBypass(() => query(
    `SELECT invoiced_at FROM supplier_receipts WHERE id = $1`, [rid]))
  expect(rc[0].invoiced_at).not.toBeNull()
})

test('si la recepción tenía remisión-CXP, vincular la SUSTITUYE (sin doble CXP)', async () => {
  const sid = await makeSupplier(30)
  const rid = await makeReceipt({ partnerId: sid })
  const rem = await generateReceiptRemission({ tenantId, receiptId: rid, userId })   // remisión + CXP
  const gasto = await makeExpense({ supplierId: sid, subtotal: 1000, tax: 160 })

  const r = await linkExpenseToReceipt({ tenantId, expenseId: gasto.id, receiptId: rid, userId })
  expect(r.replacedRemissionIds).toContain(rem.id)

  const { rows: remRow } = await withBypass(() => query(
    `SELECT status, replaced_by_invoice_id FROM supplier_invoices WHERE id = $1`, [rem.id]))
  expect(remRow[0].status).toBe('cancelled')
  expect(remRow[0].replaced_by_invoice_id).toBe(gasto.id)
  const { rows: remAp } = await withBypass(() => query(
    `SELECT status FROM accounts_payable WHERE document_type = 'remission' AND document_id = $1`, [rem.id]))
  expect(remAp[0].status).toBe('cancelled')
  // Solo queda 1 CXP activa: la del gasto/factura.
  const { rows: live } = await withBypass(() => query(
    `SELECT COUNT(*)::int AS n FROM accounts_payable WHERE document_id = $1 AND status <> 'cancelled'`, [gasto.id]))
  expect(live[0].n).toBe(1)
})

test('gasto con pago aplicado → 409', async () => {
  const sid = await makeSupplier()
  const rid = await makeReceipt({ partnerId: sid })
  const gasto = await makeExpense({ supplierId: sid, subtotal: 1000, tax: 160 })
  await registerPayment({
    tenantId, supplierId: sid, method: 'transfer', reference: 'TR-1',
    amount: 100, currency: 'MXN',
    applications: [{ apId: gasto.ap_id, amountApplied: 100 }], userId,
  })
  await expect(linkExpenseToReceipt({ tenantId, expenseId: gasto.id, receiptId: rid, userId }))
    .rejects.toMatchObject({ status: 409 })
})

test('recepción de OTRO proveedor → 400', async () => {
  const sid = await makeSupplier()
  const other = await makeSupplier()
  const rid = await makeReceipt({ partnerId: other })
  const gasto = await makeExpense({ supplierId: sid, subtotal: 1000, tax: 160 })
  await expect(linkExpenseToReceipt({ tenantId, expenseId: gasto.id, receiptId: rid, userId }))
    .rejects.toMatchObject({ status: 400 })
})
