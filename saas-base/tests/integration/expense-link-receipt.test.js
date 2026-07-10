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
  unlinkInvoiceFromReceipt,
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

// Recepción CONFIRMADA con N líneas; devuelve { id, lineIds[] }.
async function makeReceiptMultiline({ partnerId, lines }) {
  const { rows } = await withBypass(() => query(
    `INSERT INTO supplier_receipts (tenant_id, receipt_number, partner_id, warehouse_id, status, confirmed_at)
     VALUES ($1,$2,$3,$4,'confirmed',NOW()) RETURNING id`,
    [tenantId, rnum('RCP'), partnerId, warehouseId]))
  const lineIds = []
  for (let i = 0; i < lines.length; i++) {
    const { rows: l } = await withBypass(() => query(
      `INSERT INTO supplier_receipt_lines (supplier_receipt_id, quantity_received, unit, unit_price, line_number)
       VALUES ($1,$2,'pza',$3,$4) RETURNING id`,
      [rows[0].id, lines[i].qty, lines[i].unitPrice, i + 1]))
    lineIds.push(l[0].id)
  }
  return { id: rows[0].id, lineIds }
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

test('gasto YA PAGADO → se vincula y el pago se conserva en el mismo registro', async () => {
  const sid = await makeSupplier()
  const rid = await makeReceipt({ partnerId: sid })
  const gasto = await makeExpense({ supplierId: sid, subtotal: 1000, tax: 160 })
  await registerPayment({
    tenantId, supplierId: sid, method: 'transfer', reference: 'TR-1',
    amount: 100, currency: 'MXN',
    applications: [{ apId: gasto.ap_id, amountApplied: 100 }], userId,
  })

  // Antes esto daba 409; ahora se permite (la CXP y el pago viajan con el registro).
  const r = await linkExpenseToReceipt({ tenantId, expenseId: gasto.id, receiptId: rid, userId })
  expect(r.receiptId).toBe(rid)

  // Se reclasificó a factura de compra y la MISMA CXP conserva su pago.
  const { rows: si } = await withBypass(() => query(
    `SELECT is_expense FROM supplier_invoices WHERE id = $1`, [gasto.id]))
  expect(si[0].is_expense).toBe(false)
  const { rows: ap } = await withBypass(() => query(
    `SELECT amount_paid, status FROM accounts_payable WHERE id = $1`, [gasto.ap_id]))
  expect(parseFloat(ap[0].amount_paid)).toBeCloseTo(100, 2)
  expect(ap[0].status).not.toBe('cancelled')
})

test('facturación PARCIAL: cubrir solo una línea → la otra queda pendiente', async () => {
  const sid = await makeSupplier()
  const { id: rid, lineIds } = await makeReceiptMultiline({
    partnerId: sid, lines: [{ qty: 10, unitPrice: 100 }, { qty: 5, unitPrice: 100 }],   // 1000 y 500
  })
  const gasto = await makeExpense({ supplierId: sid, subtotal: 1000, tax: 160 })

  // Vincular cubriendo SOLO la primera línea (1000).
  await linkExpenseToReceipt({ tenantId, expenseId: gasto.id, receiptId: rid, receiptLineIds: [lineIds[0]], userId })

  const { rows: covered } = await withBypass(() => query(
    `SELECT invoiced_by_invoice_id FROM supplier_receipt_lines WHERE id = $1`, [lineIds[0]]))
  expect(covered[0].invoiced_by_invoice_id).toBe(gasto.id)
  const { rows: pending } = await withBypass(() => query(
    `SELECT invoiced_by_invoice_id FROM supplier_receipt_lines WHERE id = $1`, [lineIds[1]]))
  expect(pending[0].invoiced_by_invoice_id).toBeNull()           // la 2ª sigue pendiente
  const { rows: rc } = await withBypass(() => query(
    `SELECT invoiced_at FROM supplier_receipts WHERE id = $1`, [rid]))
  expect(rc[0].invoiced_at).toBeNull()                           // recepción NO totalmente facturada
})

test('vincula UNA factura a VARIAS recepciones de una vez', async () => {
  const sid = await makeSupplier()
  const r1 = await makeReceipt({ partnerId: sid, qty: 10, unitPrice: 100 })   // 1000
  const r2 = await makeReceipt({ partnerId: sid, qty: 5,  unitPrice: 100 })   // 500
  const gasto = await makeExpense({ supplierId: sid, subtotal: 1500, tax: 240 })

  const r = await linkExpenseToReceipt({
    tenantId, expenseId: gasto.id,
    receipts: [{ receiptId: r1 }, { receiptId: r2 }],
    userId,
  })
  expect(r.receiptIds).toEqual(expect.arrayContaining([r1, r2]))
  expect(r.reconciliation_status).toBe('reconciled')   // 1500 vs 1000+500

  // Ambas recepciones quedan ligadas a la misma factura y facturadas.
  for (const rid of [r1, r2]) {
    const { rows: link } = await withBypass(() => query(
      `SELECT 1 FROM invoice_receipt_links WHERE supplier_invoice_id = $1 AND supplier_receipt_id = $2`, [gasto.id, rid]))
    expect(link.length).toBe(1)
    const { rows: rc } = await withBypass(() => query(
      `SELECT invoiced_at FROM supplier_receipts WHERE id = $1`, [rid]))
    expect(rc[0].invoiced_at).not.toBeNull()
  }
  const { rows: si } = await withBypass(() => query(
    `SELECT is_expense FROM supplier_invoices WHERE id = $1`, [gasto.id]))
  expect(si[0].is_expense).toBe(false)
})

test('DESVINCULAR: vuelve a gasto, libera líneas y la recepción deja de estar facturada', async () => {
  const sid = await makeSupplier()
  const rid = await makeReceipt({ partnerId: sid })
  const gasto = await makeExpense({ supplierId: sid, subtotal: 1000, tax: 160 })
  await linkExpenseToReceipt({ tenantId, expenseId: gasto.id, receiptId: rid, userId })

  const r = await unlinkInvoiceFromReceipt({ tenantId, expenseId: gasto.id, userId })
  expect(r.receiptIds).toContain(rid)

  const { rows: si } = await withBypass(() => query(
    `SELECT is_expense, supplier_receipt_id FROM supplier_invoices WHERE id = $1`, [gasto.id]))
  expect(si[0].is_expense).toBe(true)             // volvió a ser gasto
  expect(si[0].supplier_receipt_id).toBeNull()
  const { rows: link } = await withBypass(() => query(
    `SELECT 1 FROM invoice_receipt_links WHERE supplier_invoice_id = $1`, [gasto.id]))
  expect(link.length).toBe(0)
  const { rows: lines } = await withBypass(() => query(
    `SELECT 1 FROM supplier_receipt_lines WHERE supplier_receipt_id = $1 AND invoiced_by_invoice_id = $2`, [rid, gasto.id]))
  expect(lines.length).toBe(0)
  const { rows: rc } = await withBypass(() => query(
    `SELECT invoiced_at FROM supplier_receipts WHERE id = $1`, [rid]))
  expect(rc[0].invoiced_at).toBeNull()

  // Y se puede re-vincular a otra recepción (la correcta).
  const rid2 = await makeReceipt({ partnerId: sid })
  const r2 = await linkExpenseToReceipt({ tenantId, expenseId: gasto.id, receiptId: rid2, userId })
  expect(r2.receiptId).toBe(rid2)
})

test('DESVINCULAR restaura la remisión-CXP que el enlace había sustituido', async () => {
  const sid = await makeSupplier(30)
  const rid = await makeReceipt({ partnerId: sid })
  const rem = await generateReceiptRemission({ tenantId, receiptId: rid, userId })
  const gasto = await makeExpense({ supplierId: sid, subtotal: 1000, tax: 160 })
  await linkExpenseToReceipt({ tenantId, expenseId: gasto.id, receiptId: rid, userId })   // sustituye la remisión

  await unlinkInvoiceFromReceipt({ tenantId, expenseId: gasto.id, userId })

  // La remisión vuelve a estar viva y a cubrir la recepción.
  const { rows: remRow } = await withBypass(() => query(
    `SELECT status, replaced_by_invoice_id FROM supplier_invoices WHERE id = $1`, [rem.id]))
  expect(remRow[0].status).toBe('pending')
  expect(remRow[0].replaced_by_invoice_id).toBeNull()
  const { rows: remAp } = await withBypass(() => query(
    `SELECT status FROM accounts_payable WHERE document_type = 'remission' AND document_id = $1`, [rem.id]))
  expect(remAp[0].status).toBe('pending')
  const { rows: lines } = await withBypass(() => query(
    `SELECT 1 FROM supplier_receipt_lines WHERE supplier_receipt_id = $1 AND invoiced_by_invoice_id = $2`, [rid, rem.id]))
  expect(lines.length).toBeGreaterThan(0)
})

test('desvincular una factura SIN enlace → 409', async () => {
  const sid = await makeSupplier()
  const gasto = await makeExpense({ supplierId: sid, subtotal: 1000, tax: 160 })
  await expect(unlinkInvoiceFromReceipt({ tenantId, expenseId: gasto.id, userId }))
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

// ── Cobertura por MONTO: 2+ facturas dividen el MISMO material de una recepción ──
describe('facturación parcial por MONTO (mismo material)', () => {
  const covered = (rid) => withBypass(() => query(
    `SELECT COALESCE(SUM(irl.amount_applied),0)::numeric AS c
       FROM invoice_receipt_links irl
       JOIN supplier_invoices si ON si.id = irl.supplier_invoice_id
      WHERE irl.supplier_receipt_id = $1 AND si.status <> 'cancelled' AND si.type = 'invoice'`,
    [rid])).then(r => parseFloat(r.rows[0].c))
  const invoicedAt = (rid) => withBypass(() => query(
    `SELECT invoiced_at FROM supplier_receipts WHERE id = $1`, [rid])).then(r => r.rows[0].invoiced_at)

  test('975 = 500 + 475: la 1ª deja la recepción parcial, la 2ª la completa', async () => {
    const sid = await makeSupplier()
    const rid = await makeReceipt({ partnerId: sid, qty: 975, unitPrice: 1 })   // subtotal 975
    const a = await makeExpense({ supplierId: sid, subtotal: 500, tax: 80 })
    const b = await makeExpense({ supplierId: sid, subtotal: 475, tax: 76 })

    const ra = await linkExpenseToReceipt({ tenantId, expenseId: a.id, receiptId: rid, userId })
    expect(ra.reconciliation_status).toBe('reconciled')     // 500 cubre 500 exacto
    expect(await covered(rid)).toBeCloseTo(500, 2)
    expect(await invoicedAt(rid)).toBeNull()                // sigue pendiente ($475)

    const rb = await linkExpenseToReceipt({ tenantId, expenseId: b.id, receiptId: rid, userId })
    expect(rb.reconciliation_status).toBe('reconciled')
    expect(await covered(rid)).toBeCloseTo(975, 2)
    expect(await invoicedAt(rid)).not.toBeNull()            // 500+475 = 975 → completa

    // Ambas quedaron como factura de compra (is_expense=false) con 2 CXP reales.
    const { rows: si } = await withBypass(() => query(
      `SELECT is_expense FROM supplier_invoices WHERE id IN ($1,$2)`, [a.id, b.id]))
    expect(si.every(r => r.is_expense === false)).toBe(true)
    const { rows: aps } = await withBypass(() => query(
      `SELECT COUNT(*)::int AS n FROM accounts_payable WHERE document_id IN ($1,$2) AND status <> 'cancelled'`, [a.id, b.id]))
    expect(aps[0].n).toBe(2)
  })

  test('con remisión-CXP: la 1ª la sustituye, la 2ª ya no (sin doble CXP)', async () => {
    const sid = await makeSupplier(30)
    const rid = await makeReceipt({ partnerId: sid, qty: 975, unitPrice: 1 })
    const rem = await generateReceiptRemission({ tenantId, receiptId: rid, userId })
    const a = await makeExpense({ supplierId: sid, subtotal: 500, tax: 80 })
    const b = await makeExpense({ supplierId: sid, subtotal: 475, tax: 76 })

    const ra = await linkExpenseToReceipt({ tenantId, expenseId: a.id, receiptId: rid, userId })
    expect(ra.replacedRemissionIds).toContain(rem.id)
    const rb = await linkExpenseToReceipt({ tenantId, expenseId: b.id, receiptId: rid, userId })
    expect(rb.replacedRemissionIds).toHaveLength(0)         // ya estaba cancelada

    const { rows: remAp } = await withBypass(() => query(
      `SELECT status FROM accounts_payable WHERE document_type = 'remission' AND document_id = $1`, [rem.id]))
    expect(remAp[0].status).toBe('cancelled')
    const { rows: live } = await withBypass(() => query(
      `SELECT COUNT(*)::int AS n FROM accounts_payable WHERE document_id IN ($1,$2) AND status <> 'cancelled'`, [a.id, b.id]))
    expect(live[0].n).toBe(2)
  })

  test('factura que EXCEDE el saldo cubre sólo el remanente y marca diferencia', async () => {
    const sid = await makeSupplier()
    const rid = await makeReceipt({ partnerId: sid, qty: 975, unitPrice: 1 })
    const a = await makeExpense({ supplierId: sid, subtotal: 500, tax: 80 })
    await linkExpenseToReceipt({ tenantId, expenseId: a.id, receiptId: rid, userId })   // cubre 500
    const big = await makeExpense({ supplierId: sid, subtotal: 600, tax: 96 })          // remanente = 475
    const rb = await linkExpenseToReceipt({ tenantId, expenseId: big.id, receiptId: rid, userId })
    expect(rb.reconciliation_status).toBe('with_diff')      // 600 factura vs 475 cubierto
    const { rows: link } = await withBypass(() => query(
      `SELECT amount_applied FROM invoice_receipt_links WHERE supplier_invoice_id = $1 AND supplier_receipt_id = $2`, [big.id, rid]))
    expect(parseFloat(link[0].amount_applied)).toBeCloseTo(475, 2)   // capado al remanente
    expect(await invoicedAt(rid)).not.toBeNull()           // completa la recepción
  })

  test('recepción cubierta al 100% → otra factura da 409', async () => {
    const sid = await makeSupplier()
    const rid = await makeReceipt({ partnerId: sid, qty: 975, unitPrice: 1 })
    const a = await makeExpense({ supplierId: sid, subtotal: 500, tax: 80 })
    const b = await makeExpense({ supplierId: sid, subtotal: 475, tax: 76 })
    await linkExpenseToReceipt({ tenantId, expenseId: a.id, receiptId: rid, userId })
    await linkExpenseToReceipt({ tenantId, expenseId: b.id, receiptId: rid, userId })
    const c = await makeExpense({ supplierId: sid, subtotal: 100, tax: 16 })
    await expect(linkExpenseToReceipt({ tenantId, expenseId: c.id, receiptId: rid, userId }))
      .rejects.toMatchObject({ status: 409 })
  })

  test('desvincular UNA de dos facturas parciales NO revive la remisión (sin doble CXP)', async () => {
    const sid = await makeSupplier(30)
    const rid = await makeReceipt({ partnerId: sid, qty: 975, unitPrice: 1 })
    const rem = await generateReceiptRemission({ tenantId, receiptId: rid, userId })
    const a = await makeExpense({ supplierId: sid, subtotal: 500, tax: 80 })
    const b = await makeExpense({ supplierId: sid, subtotal: 475, tax: 76 })
    await linkExpenseToReceipt({ tenantId, expenseId: a.id, receiptId: rid, userId })
    await linkExpenseToReceipt({ tenantId, expenseId: b.id, receiptId: rid, userId })

    // Desvincular A: B sigue cubriendo → la remisión NO revive.
    const u = await unlinkInvoiceFromReceipt({ tenantId, expenseId: a.id, userId })
    expect(u.restoredRemissionIds).toHaveLength(0)
    const { rows: remAp } = await withBypass(() => query(
      `SELECT status FROM accounts_payable WHERE document_type = 'remission' AND document_id = $1`, [rem.id]))
    expect(remAp[0].status).toBe('cancelled')          // sigue cancelada (no revivió)
    // CXP activas: A (vuelta a gasto, conserva su CXP) + B; NO la remisión → sin doble conteo.
    const { rows: live } = await withBypass(() => query(
      `SELECT COUNT(*)::int AS n FROM accounts_payable
        WHERE document_id IN ($1,$2) AND status <> 'cancelled'`, [a.id, b.id]))
    expect(live[0].n).toBe(2)
    // A volvió a ser gasto; B sigue como factura de compra.
    const { rows: si } = await withBypass(() => query(
      `SELECT id, is_expense FROM supplier_invoices WHERE id IN ($1,$2)`, [a.id, b.id]))
    expect(si.find(r => r.id === a.id).is_expense).toBe(true)
    expect(si.find(r => r.id === b.id).is_expense).toBe(false)
  })
})
