'use strict'

/**
 * Facturación PARCIAL de recepción por LÍNEA (mig 202).
 *
 * Una recepción con varias líneas (productos) se factura en varias facturas, una
 * por línea completa. invoiced_by_invoice_id rastrea qué factura cubre cada línea;
 * la recepción queda "totalmente facturada" (invoiced_at) solo cuando TODAS sus
 * líneas están cubiertas. Una línea ya cubierta por factura REAL no se re-factura.
 * Si la recepción tenía remisión-CXP, la primera factura real la anula y reabre las
 * líneas que no tomó.
 */

const { createTenant, loginAs, authedClient, cleanupTestTenants } = require('../helpers/factory')
const { pool, query, withBypass } = require('../../src/db')
const { generateReceiptRemission, registerInvoice } = require('../../src/modules/purchases/supplierInvoiceService')

let tenantId, userId, warehouseId, client
let n = 0
const rnum = (p) => `${p}-${Date.now() % 100000}-${n++}`

async function makeSupplier(supplierCreditDays = 0) {
  const { rows } = await withBypass(() => query(
    `INSERT INTO business_partners (tenant_id, type, name, supplier_credit_days)
     VALUES ($1,'supplier','Prov Parcial',$2) RETURNING id`, [tenantId, supplierCreditDays]))
  return rows[0].id
}

// Recepción confirmada con N líneas. lines = [{ qty, price }]. Devuelve { id, receipt_number, lineIds[] }.
async function makeReceipt(partnerId, lines) {
  const { rows: sr } = await withBypass(() => query(
    `INSERT INTO supplier_receipts (tenant_id, receipt_number, partner_id, warehouse_id, status, confirmed_at)
     VALUES ($1,$2,$3,$4,'confirmed',NOW()) RETURNING id, receipt_number`,
    [tenantId, rnum('RCP'), partnerId, warehouseId]))
  const lineIds = []
  for (let i = 0; i < lines.length; i++) {
    const { rows: l } = await withBypass(() => query(
      `INSERT INTO supplier_receipt_lines (supplier_receipt_id, quantity_received, unit, unit_price, line_number)
       VALUES ($1,$2,'pza',$3,$4) RETURNING id`, [sr[0].id, lines[i].qty, lines[i].price, i + 1]))
    lineIds.push(l[0].id)
  }
  return { ...sr[0], lineIds }
}

async function lineCover(lineId) {
  const { rows } = await withBypass(() => query(
    `SELECT invoiced_by_invoice_id FROM supplier_receipt_lines WHERE id = $1`, [lineId]))
  return rows[0].invoiced_by_invoice_id
}
async function receiptInvoicedAt(id) {
  const { rows } = await withBypass(() => query(`SELECT invoiced_at FROM supplier_receipts WHERE id = $1`, [id]))
  return rows[0].invoiced_at
}

beforeAll(async () => {
  const info = await createTenant({ label: 'rcptparcial', planSlug: 'owner' })
  tenantId = info.tenant.id
  userId = info.user.id
  const sess = await loginAs({ slug: info.tenant.slug, email: info.email, password: info.password })
  client = authedClient({ slug: info.tenant.slug, token: sess.token })
  const { rows } = await withBypass(() => query(
    `INSERT INTO warehouses (tenant_id, name, type, is_active) VALUES ($1,'Almacén','raw_material',true) RETURNING id`,
    [tenantId]))
  warehouseId = rows[0].id
})
afterAll(async () => { await cleanupTestTenants(); await pool.end() })

describe('Facturación parcial por línea', () => {
  test('2 líneas, 2 facturas: la recepción solo queda facturada al cubrir AMBAS', async () => {
    const sid = await makeSupplier(0)
    const rcpt = await makeReceipt(sid, [{ qty: 10, price: 60 }, { qty: 10, price: 40 }]) // A=600, B=400
    const [A, B] = rcpt.lineIds

    // Factura 1 cubre solo la línea A.
    const inv1 = await registerInvoice({
      tenantId, supplierId: sid, documentNumber: rnum('F'),
      subtotal: 600, tax: 96, total: 696, receiptLineIds: [A], userId,
    })
    expect(await lineCover(A)).toBe(inv1.id)
    expect(await lineCover(B)).toBeNull()
    expect(await receiptInvoicedAt(rcpt.id)).toBeNull() // aún falta B

    // Aún aparece como pendiente (con la línea B), y A ya NO es seleccionable.
    const pend = await client.get('/api/purchases/receipts/pending-invoice').expect(200)
    expect(pend.body.some(r => r.id === rcpt.id)).toBe(true)

    // No se puede re-facturar la línea A (ya cubierta por factura activa).
    await expect(registerInvoice({
      tenantId, supplierId: sid, documentNumber: rnum('F'),
      subtotal: 600, tax: 96, total: 696, receiptLineIds: [A], userId,
    })).rejects.toMatchObject({ status: 409 })

    // Factura 2 cubre la línea B → recepción TOTALMENTE facturada.
    const inv2 = await registerInvoice({
      tenantId, supplierId: sid, documentNumber: rnum('F'),
      subtotal: 400, tax: 64, total: 464, receiptLineIds: [B], userId,
    })
    expect(await lineCover(B)).toBe(inv2.id)
    expect(await receiptInvoicedAt(rcpt.id)).toBeTruthy() // ya todas cubiertas

    // Ya no aparece como pendiente.
    const pend2 = await client.get('/api/purchases/receipts/pending-invoice').expect(200)
    expect(pend2.body.some(r => r.id === rcpt.id)).toBe(false)
  })

  test('remisión + parcial: la factura real de una línea anula la remisión y REABRE la otra', async () => {
    const sid = await makeSupplier(0)
    const rcpt = await makeReceipt(sid, [{ qty: 10, price: 60 }, { qty: 10, price: 40 }])
    const [A, B] = rcpt.lineIds

    // Remisión-CXP cubre toda la recepción (ambas líneas).
    const rem = await generateReceiptRemission({ tenantId, receiptId: rcpt.id, userId })
    expect(await lineCover(A)).toBe(rem.id)
    expect(await lineCover(B)).toBe(rem.id)
    expect(await receiptInvoicedAt(rcpt.id)).toBeTruthy()

    // Llega la factura real de SOLO la línea A → anula la remisión y reabre B.
    const inv = await registerInvoice({
      tenantId, supplierId: sid, documentNumber: rnum('F'),
      subtotal: 600, tax: 96, total: 696, receiptLineIds: [A], userId,
    })
    expect(inv.replaced_remission_ids).toContain(rem.id)
    expect(await lineCover(A)).toBe(inv.id)   // A → factura real
    expect(await lineCover(B)).toBeNull()      // B reabierta (la remisión se anuló)
    expect(await receiptInvoicedAt(rcpt.id)).toBeNull() // falta B

    // La remisión quedó cancelada; su CXP también.
    const { rows: r } = await withBypass(() => query(
      `SELECT status FROM supplier_invoices WHERE id = $1`, [rem.id]))
    expect(r[0].status).toBe('cancelled')
  })
})
