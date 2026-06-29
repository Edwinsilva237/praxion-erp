'use strict'

/**
 * suggestReceiptForExpense — SUGIERE (no liga) la recepción pendiente de factura
 * que cuadra con un gasto de mercancía. Reemplaza al auto-link de la 5A: como
 * vincular es IRREVERSIBLE (toca CXP/inventario y no hay undo), no se hace solo;
 * se sugiere y el humano confirma con linkExpenseToReceipt. Mismo criterio:
 * mismo proveedor + MXN + subtotal ±2% + recibida en ventana de fechas + UNA sola.
 */

const { createTenant, cleanupTestTenants } = require('../helpers/factory')
const { pool, query, withBypass } = require('../../src/db')
const {
  registerInvoice, suggestReceiptForExpense, registerPayment,
} = require('../../src/modules/purchases/supplierInvoiceService')

let tenantId, userId, warehouseId
let n = 0
const rnum = (p) => `${p}-${Date.now() % 100000}-${n++}`

async function makeSupplier() {
  const { rows } = await withBypass(() => query(
    `INSERT INTO business_partners (tenant_id, type, name) VALUES ($1,'supplier','Proveedor Sug') RETURNING id`,
    [tenantId]))
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
    subtotal, tax, total: subtotal + tax, isExpense: true, userId,   // invoiceDate → hoy (default)
  })
}

beforeAll(async () => {
  const info = await createTenant({ label: 'sugrcpt', planSlug: 'owner' })
  tenantId = info.tenant.id
  userId = info.user.id
  const { rows } = await withBypass(() => query(
    `INSERT INTO warehouses (tenant_id, name, type, is_active) VALUES ($1,'Almacén','raw_material',true) RETURNING id`,
    [tenantId]))
  warehouseId = rows[0].id
})

afterAll(async () => { await cleanupTestTenants(); await pool.end() })

test('gasto cuadra con UNA recepción pendiente → la sugiere', async () => {
  const sid = await makeSupplier()
  const rid = await makeReceipt({ partnerId: sid })                  // subtotal 1000
  const g = await makeExpense({ supplierId: sid, subtotal: 1000, tax: 160 })

  const s = await suggestReceiptForExpense({ tenantId, expenseId: g.id })
  expect(s.suggestion).not.toBeNull()
  expect(s.suggestion.id).toBe(rid)
  expect(s.candidateCount).toBe(1)
})

test('subtotal fuera de tolerancia → sin sugerencia', async () => {
  const sid = await makeSupplier()
  await makeReceipt({ partnerId: sid })                              // 1000
  const g = await makeExpense({ supplierId: sid, subtotal: 500, tax: 80 })

  const s = await suggestReceiptForExpense({ tenantId, expenseId: g.id })
  expect(s.suggestion).toBeNull()
  expect(s.candidateCount).toBe(0)
})

test('dos recepciones dentro de tolerancia → ambiguo → sin sugerencia', async () => {
  const sid = await makeSupplier()
  await makeReceipt({ partnerId: sid })                              // 1000
  await makeReceipt({ partnerId: sid })                              // 1000
  const g = await makeExpense({ supplierId: sid, subtotal: 1000, tax: 160 })

  const s = await suggestReceiptForExpense({ tenantId, expenseId: g.id })
  expect(s.suggestion).toBeNull()
  expect(s.candidateCount).toBe(2)
})

test('±2%: $1,015 contra recepción de $1,000 sí se sugiere', async () => {
  const sid = await makeSupplier()
  const rid = await makeReceipt({ partnerId: sid })                  // 1000
  const g = await makeExpense({ supplierId: sid, subtotal: 1015, tax: 162.4 })

  const s = await suggestReceiptForExpense({ tenantId, expenseId: g.id })
  expect(s.suggestion?.id).toBe(rid)                                 // |1015-1000| = 15 ≤ 20.3
})

test('gasto con pago aplicado → AÚN se sugiere (el pago no impide vincular)', async () => {
  const sid = await makeSupplier()
  const rid = await makeReceipt({ partnerId: sid })
  const g = await makeExpense({ supplierId: sid, subtotal: 1000, tax: 160 })
  await registerPayment({
    tenantId, supplierId: sid, method: 'transfer', reference: 'TR',
    amount: 100, currency: 'MXN',
    applications: [{ apId: g.ap_id, amountApplied: 100 }], userId,
  })
  const s = await suggestReceiptForExpense({ tenantId, expenseId: g.id })
  expect(s.suggestion?.id).toBe(rid)
})
