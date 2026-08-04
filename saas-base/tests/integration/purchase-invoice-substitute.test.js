'use strict'

/**
 * Sustitución de CFDI de proveedor: el proveedor canceló la factura ante el SAT
 * y emitió otra. `substituteInvoice` cancela la vieja (+CxP) y traspasa sus
 * recepciones al sustituto — que puede ser un gasto ya en el sistema (buzón) o
 * los datos de un XML nuevo. Guards: pagos aplicados, proveedor distinto,
 * mismo UUID. `listSubstituteCandidates` filtra por proveedor y sin vincular.
 */

const { createTenant, cleanupTestTenants } = require('../helpers/factory')
const { pool, query, withBypass } = require('../../src/db')
const {
  registerInvoice, registerPayment, substituteInvoice, listSubstituteCandidates,
} = require('../../src/modules/purchases/supplierInvoiceService')

let tenantId, userId, warehouseId
let n = 0
const rnum = (p) => `${p}-${Date.now() % 100000}-${n++}`
const { randomUUID } = require('crypto')

// RFC único por proveedor (constraint bp_rfc_tenant_unique). Devuelve {id, rfc}.
async function makeSupplier(name = 'Proveedor Sust') {
  const rfc = `AAA0101${String(100 + (n++)).slice(-3)}XX`
  const { rows } = await withBypass(() => query(
    `INSERT INTO business_partners (tenant_id, type, name, rfc)
     VALUES ($1,'supplier',$2,$3) RETURNING id, rfc`, [tenantId, name, rfc]))
  return rows[0]
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

// Factura REAL ligada a una recepción (el punto de partida del escenario).
async function makeLinkedInvoice({ supplierId, receiptId, uuid, rfc = null, subtotal = 1000, tax = 160 }) {
  return registerInvoice({
    tenantId, supplierId, documentNumber: rnum('F'),
    uuidSat: uuid, rfcEmisor: rfc,
    subtotal, tax, total: subtotal + tax,
    receiptIds: [receiptId], userId,
  })
}

async function makeExpense({ supplierId, uuid = null, subtotal = 1000, tax = 160 }) {
  return registerInvoice({
    tenantId, supplierId, documentNumber: rnum('G'),
    uuidSat: uuid, subtotal, tax, total: subtotal + tax, isExpense: true, userId,
  })
}

beforeAll(async () => {
  const info = await createTenant({ label: 'invsust', planSlug: 'owner' })
  tenantId = info.tenant.id
  userId = info.user.id
  const { rows } = await withBypass(() => query(
    `INSERT INTO warehouses (tenant_id, name, type, is_active) VALUES ($1,'Almacén','raw_material',true) RETURNING id`,
    [tenantId]))
  warehouseId = rows[0].id
})

afterAll(async () => { await cleanupTestTenants(); await pool.end() })

test('sustitución con XML nuevo: cancela la vieja y liga la nueva a la misma recepción', async () => {
  const sup = await makeSupplier()
  const rid = await makeReceipt({ partnerId: sup.id })
  const vieja = await makeLinkedInvoice({ supplierId: sup.id, receiptId: rid, rfc: sup.rfc, uuid: randomUUID() })

  const res = await substituteInvoice({
    tenantId, invoiceId: vieja.id, userId, reason: 'error en precio',
    invoice: {
      documentNumber: rnum('F-SUST'), uuidSat: randomUUID(),
      rfcEmisor: sup.rfc, currency: 'MXN',
      subtotal: 1000, tax: 160, total: 1160,
    },
  })

  // Vieja: cancelada con nota cruzada + CxP cancelada.
  const { rows: old } = await withBypass(() => query(
    `SELECT status, notes FROM supplier_invoices WHERE id = $1`, [vieja.id]))
  expect(old[0].status).toBe('cancelled')
  expect(old[0].notes).toMatch(/\[Sustituida\]/)
  expect(old[0].notes).toMatch(/error en precio/)
  const { rows: oldAp } = await withBypass(() => query(
    `SELECT status FROM accounts_payable WHERE document_type='invoice' AND document_id = $1`, [vieja.id]))
  expect(oldAp[0].status).toBe('cancelled')

  // Nueva: viva, ligada a la MISMA recepción, con CxP propia y nota [Sustituye].
  const { rows: nueva } = await withBypass(() => query(
    `SELECT status, notes, is_expense FROM supplier_invoices WHERE id = $1`, [res.new.id]))
  expect(nueva[0].status).not.toBe('cancelled')
  expect(nueva[0].is_expense).toBe(false)
  expect(nueva[0].notes).toMatch(/\[Sustituye\]/)
  const { rows: link } = await withBypass(() => query(
    `SELECT 1 FROM invoice_receipt_links WHERE supplier_invoice_id = $1 AND supplier_receipt_id = $2`,
    [res.new.id, rid]))
  expect(link.length).toBe(1)
  const { rows: lines } = await withBypass(() => query(
    `SELECT invoiced_by_invoice_id FROM supplier_receipt_lines WHERE supplier_receipt_id = $1`, [rid]))
  expect(lines.every(l => l.invoiced_by_invoice_id === res.new.id)).toBe(true)
  const { rows: newAp } = await withBypass(() => query(
    `SELECT status FROM accounts_payable WHERE document_type='invoice' AND document_id = $1`, [res.new.id]))
  expect(newAp[0].status).not.toBe('cancelled')
  // La recepción sigue completamente facturada.
  const { rows: rc } = await withBypass(() => query(
    `SELECT invoiced_at FROM supplier_receipts WHERE id = $1`, [rid]))
  expect(rc[0].invoiced_at).not.toBeNull()
})

test('sustitución con gasto YA en el sistema (buzón): hereda enlaces y se reclasifica', async () => {
  const sup = await makeSupplier()
  const rid = await makeReceipt({ partnerId: sup.id })
  const vieja = await makeLinkedInvoice({ supplierId: sup.id, receiptId: rid, rfc: sup.rfc, uuid: randomUUID() })
  const gasto = await makeExpense({ supplierId: sup.id, uuid: randomUUID() })

  const res = await substituteInvoice({
    tenantId, invoiceId: vieja.id, newExpenseId: gasto.id, userId,
  })
  expect(res.new.id).toBe(gasto.id)

  const { rows: si } = await withBypass(() => query(
    `SELECT is_expense, supplier_receipt_id, reconciliation_status, notes
       FROM supplier_invoices WHERE id = $1`, [gasto.id]))
  expect(si[0].is_expense).toBe(false)
  expect(si[0].supplier_receipt_id).toBe(rid)
  expect(si[0].reconciliation_status).toBe('reconciled')   // 1000 vs 1000
  expect(si[0].notes).toMatch(/\[Sustituye\]/)
  const { rows: lines } = await withBypass(() => query(
    `SELECT invoiced_by_invoice_id FROM supplier_receipt_lines WHERE supplier_receipt_id = $1`, [rid]))
  expect(lines.every(l => l.invoiced_by_invoice_id === gasto.id)).toBe(true)
  const { rows: old } = await withBypass(() => query(
    `SELECT status FROM supplier_invoices WHERE id = $1`, [vieja.id]))
  expect(old[0].status).toBe('cancelled')
})

test('con pagos aplicados NO se puede sustituir (reversa el pago primero)', async () => {
  const sup = await makeSupplier()
  const rid = await makeReceipt({ partnerId: sup.id })
  const vieja = await makeLinkedInvoice({ supplierId: sup.id, receiptId: rid, rfc: sup.rfc, uuid: randomUUID() })
  await registerPayment({
    tenantId, supplierId: sup.id, method: 'transfer', reference: 'TR-S1',
    amount: 100, currency: 'MXN',
    applications: [{ apId: vieja.ap_id, amountApplied: 100 }], userId,
  })

  await expect(substituteInvoice({
    tenantId, invoiceId: vieja.id, userId,
    invoice: { documentNumber: rnum('F-X'), subtotal: 1000, tax: 160, total: 1160 },
  })).rejects.toThrow(/pagos aplicados/)
})

test('guards: gasto de otro proveedor y XML con el mismo UUID', async () => {
  const sup  = await makeSupplier()
  const sup2 = await makeSupplier('Otro Proveedor')
  const rid = await makeReceipt({ partnerId: sup.id })
  const uuidViejo = randomUUID()
  const vieja = await makeLinkedInvoice({ supplierId: sup.id, receiptId: rid, rfc: sup.rfc, uuid: uuidViejo })

  const gastoAjeno = await makeExpense({ supplierId: sup2.id })
  await expect(substituteInvoice({
    tenantId, invoiceId: vieja.id, newExpenseId: gastoAjeno.id, userId,
  })).rejects.toThrow(/otro proveedor/)

  await expect(substituteInvoice({
    tenantId, invoiceId: vieja.id, userId,
    invoice: { documentNumber: rnum('F-X'), uuidSat: uuidViejo, subtotal: 1000, tax: 160, total: 1160 },
  })).rejects.toThrow(/mismo UUID|MISMO CFDI/i)
})

test('candidatos: solo gastos vivos del MISMO proveedor sin recepción ligada', async () => {
  const sup  = await makeSupplier()
  const sup2 = await makeSupplier('Proveedor Ajeno')
  const rid = await makeReceipt({ partnerId: sup.id })
  const vieja = await makeLinkedInvoice({ supplierId: sup.id, receiptId: rid, rfc: sup.rfc, uuid: randomUUID() })

  const candidato = await makeExpense({ supplierId: sup.id, uuid: randomUUID(), subtotal: 990, tax: 158.4 })
  await makeExpense({ supplierId: sup2.id })                        // otro proveedor → fuera

  const list = await listSubstituteCandidates({ tenantId, invoiceId: vieja.id })
  const ids = list.map(c => c.id)
  expect(ids).toContain(candidato.id)
  // Nada de otros proveedores ni la propia factura.
  expect(list.every(c => c.id !== vieja.id)).toBe(true)
})
