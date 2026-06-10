'use strict'

/**
 * Fase 2 Compras — "No se espera factura" → CXP sin factura (remisión, SIN IVA).
 *
 * generateReceiptRemission crea un supplier_invoice tipo 'remission' + accounts_payable
 * type='remission' por el valor de la recepción, vencimiento por supplier_credit_days.
 * Si después llega el CFDI real, registrar la factura de esa recepción anula la
 * remisión automáticamente (replaced_by_invoice_id) y cancela su CXP.
 */

const { createTenant, loginAs, authedClient, cleanupTestTenants } = require('../helpers/factory')
const { pool, query, withBypass } = require('../../src/db')
const { generateReceiptRemission, registerInvoice } = require('../../src/modules/purchases/supplierInvoiceService')

let tenantId, userId, warehouseId, client, slug
let n = 0
const rnum = (p) => `${p}-${Date.now() % 100000}-${n++}`

async function makeSupplier(supplierCreditDays = 0) {
  const { rows } = await withBypass(() => query(
    `INSERT INTO business_partners (tenant_id, type, name, supplier_credit_days)
     VALUES ($1,'supplier','Proveedor S/F',$2) RETURNING id`, [tenantId, supplierCreditDays]))
  return rows[0].id
}

// Recepción CONFIRMADA con una línea (subtotal = qty × unit_price).
async function makeConfirmedReceipt({ partnerId, qty = 10, unitPrice = 100, status = 'confirmed' }) {
  const confirmedAt = status === 'confirmed' ? new Date() : null
  const { rows: sr } = await withBypass(() => query(
    `INSERT INTO supplier_receipts (tenant_id, receipt_number, partner_id, warehouse_id, status, confirmed_at)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, receipt_number`,
    [tenantId, rnum('RCP'), partnerId, warehouseId, status, confirmedAt]))
  await withBypass(() => query(
    `INSERT INTO supplier_receipt_lines (supplier_receipt_id, quantity_received, unit, unit_price, line_number)
     VALUES ($1,$2,'pza',$3,1)`, [sr[0].id, qty, unitPrice]))
  return sr[0]
}

beforeAll(async () => {
  const info = await createTenant({ label: 'rcptremision', planSlug: 'owner' })
  tenantId = info.tenant.id
  userId = info.user.id
  slug = info.tenant.slug
  const sess = await loginAs({ slug, email: info.email, password: info.password })
  client = authedClient({ slug, token: sess.token })
  const { rows } = await withBypass(() => query(
    `INSERT INTO warehouses (tenant_id, name, type, is_active) VALUES ($1,'Almacén','raw_material',true) RETURNING id`,
    [tenantId]))
  warehouseId = rows[0].id
})

afterAll(async () => { await cleanupTestTenants(); await pool.end() })

describe('Fase 2 — CXP sin factura desde recepción', () => {
  test('genera remisión SIN IVA con CXP y vencimiento por supplier_credit_days', async () => {
    const sid = await makeSupplier(30)
    const rcpt = await makeConfirmedReceipt({ partnerId: sid, qty: 10, unitPrice: 100 }) // subtotal 1000

    const rem = await generateReceiptRemission({ tenantId, receiptId: rcpt.id, userId })

    expect(rem.type).toBe('remission')
    expect(parseFloat(rem.tax)).toBe(0)            // SIN IVA
    expect(parseFloat(rem.total)).toBe(1000)       // = subtotal de la recepción
    expect(rem.invoice_number).toBe(`S/F-${rcpt.receipt_number}`)
    expect(rem.ap_id).toBeTruthy()                 // CXP generada

    // CXP en accounts_payable tipo 'remission', vencimiento 30 días después.
    const { rows: ap } = await withBypass(() => query(
      `SELECT document_type, amount_total, due_date, issue_date, status FROM accounts_payable WHERE id = $1`, [rem.ap_id]))
    expect(ap[0].document_type).toBe('remission')
    expect(parseFloat(ap[0].amount_total)).toBe(1000)
    const days = Math.round((new Date(ap[0].due_date) - new Date(ap[0].issue_date)) / 86400000)
    expect(days).toBe(30)

    // La recepción quedó marcada como facturada (invoiced_at).
    const { rows: r } = await withBypass(() => query(
      `SELECT invoiced_at FROM supplier_receipts WHERE id = $1`, [rcpt.id]))
    expect(r[0].invoiced_at).toBeTruthy()
  })

  test('sustitución: registrar la factura real anula la remisión y su CXP (replaced_by)', async () => {
    const sid = await makeSupplier(0)
    const rcpt = await makeConfirmedReceipt({ partnerId: sid, qty: 10, unitPrice: 100 })
    const rem = await generateReceiptRemission({ tenantId, receiptId: rcpt.id, userId })

    // Llega el CFDI real → registrar la factura de esa recepción.
    const inv = await registerInvoice({
      tenantId, supplierId: sid, documentNumber: rnum('FAC'),
      subtotal: 1000, tax: 160, total: 1160, receiptIds: [rcpt.id], userId,
    })
    expect(inv.type).toBe('invoice')
    expect(inv.replaced_remission_ids).toContain(rem.id)

    // La remisión quedó cancelada y enlazada a la factura.
    const { rows: remRow } = await withBypass(() => query(
      `SELECT status, replaced_by_invoice_id FROM supplier_invoices WHERE id = $1`, [rem.id]))
    expect(remRow[0].status).toBe('cancelled')
    expect(remRow[0].replaced_by_invoice_id).toBe(inv.id)

    // Su CXP-remisión quedó cancelada (no doble CXP).
    const { rows: apRow } = await withBypass(() => query(
      `SELECT status FROM accounts_payable WHERE document_type='remission' AND document_id = $1`, [rem.id]))
    expect(apRow[0].status).toBe('cancelled')
  })

  test('no permite generar CXP de una recepción en BORRADOR', async () => {
    const sid = await makeSupplier(0)
    const rcpt = await makeConfirmedReceipt({ partnerId: sid, status: 'draft' })
    await expect(generateReceiptRemission({ tenantId, receiptId: rcpt.id, userId }))
      .rejects.toMatchObject({ status: 409 })
  })

  test('no permite generar CXP dos veces (ya tiene documento)', async () => {
    const sid = await makeSupplier(0)
    const rcpt = await makeConfirmedReceipt({ partnerId: sid })
    await generateReceiptRemission({ tenantId, receiptId: rcpt.id, userId })
    await expect(generateReceiptRemission({ tenantId, receiptId: rcpt.id, userId }))
      .rejects.toMatchObject({ status: 409 })
  })

  test('selector pendiente-de-factura: con remisión-CXP SÍ aparece (para sustituir); tras la factura NO', async () => {
    const sid = await makeSupplier(0)
    const rcpt = await makeConfirmedReceipt({ partnerId: sid })
    await generateReceiptRemission({ tenantId, receiptId: rcpt.id, userId })

    // Una recepción con SOLO remisión-CXP sigue siendo "pendiente de factura real"
    // (con flag has_remission) → así se puede registrar el CFDI y sustituir.
    const pend1 = await client.get('/api/purchases/receipts/pending-invoice').expect(200)
    const row = pend1.body.find(r => r.id === rcpt.id)
    expect(row).toBeTruthy()
    expect(row.has_remission).toBe(true)

    // Registrar la factura real → sustituye la remisión.
    await registerInvoice({
      tenantId, supplierId: sid, documentNumber: rnum('FAC'),
      subtotal: 1000, tax: 160, total: 1160, receiptIds: [rcpt.id], userId,
    })

    // Con factura REAL activa → ya NO aparece como pendiente (no se factura dos veces).
    const pend2 = await client.get('/api/purchases/receipts/pending-invoice').expect(200)
    expect(pend2.body.some(r => r.id === rcpt.id)).toBe(false)
  })
})
