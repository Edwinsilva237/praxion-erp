'use strict'

/**
 * Módulo de GASTOS — detalle, edición y cancelación (supplier_invoices con
 * is_expense=true). Cubre las reglas de seguridad:
 *   - editar montos solo sin pago aplicado (CXP en sync);
 *   - agregar el CFDI después + anti-duplicado por UUID;
 *   - cancelar solo sin pago → status=cancelled + CXP cancelado;
 *   - un gasto pagado no se edita en monto ni se cancela (pero sí en notas).
 */

const crypto = require('crypto')
const { createTenant, cleanupTestTenants } = require('../helpers/factory')
const { pool, query, withBypass } = require('../../src/db')
const {
  registerInvoice, getExpense, updateExpense, cancelExpense, registerPayment,
} = require('../../src/modules/purchases/supplierInvoiceService')

let tenantId, userId, supplierId, categoryId, categoryId2

async function makeSupplier(name = 'Proveedor Gasto') {
  const { rows } = await withBypass(() => query(
    `INSERT INTO business_partners (tenant_id, type, name, supplier_credit_days)
     VALUES ($1,'supplier',$2,0) RETURNING id`, [tenantId, name]))
  return rows[0].id
}
async function makeCategory(code, name) {
  const { rows } = await withBypass(() => query(
    `INSERT INTO tenant_expense_categories (tenant_id, code, name)
     VALUES ($1,$2,$3) RETURNING id`, [tenantId, code, name]))
  return rows[0].id
}
async function getAp(apId) {
  const { rows } = await withBypass(() => query(
    `SELECT status, amount_total, amount_paid FROM accounts_payable WHERE id = $1`, [apId]))
  return rows[0]
}
async function makeExpense({ subtotal = 1000, tax = 160, uuidSat = null } = {}) {
  return registerInvoice({
    tenantId, supplierId,
    documentNumber: `GASTO-${crypto.randomUUID().slice(0, 8)}`,
    subtotal, tax, total: subtotal + tax,
    isExpense: true, expenseCategoryId: categoryId, uuidSat, userId,
  })
}

describe('Gastos — detalle, edición y cancelación', () => {
  beforeAll(async () => {
    const info = await createTenant({ label: 'gastos', planSlug: 'owner' })
    tenantId = info.tenant.id
    userId = info.user.id
    supplierId  = await makeSupplier()
    categoryId  = await makeCategory('test_renta', 'Renta test')
    categoryId2 = await makeCategory('test_luz',   'Luz test')
  })
  afterAll(async () => { await cleanupTestTenants(); await pool.end() })

  test('registrar gasto → getExpense con los dos semáforos', async () => {
    const exp = await makeExpense()
    const got = await getExpense({ tenantId, id: exp.id })
    expect(got.is_expense).toBe(true)
    expect(got.has_cfdi).toBe(false)         // sin CFDI
    expect(got.ap_status).toBe('pending')    // sin pagar
    expect(parseFloat(got.total)).toBeCloseTo(1160)
    expect(got.expense_category_id).toBe(categoryId)
  })

  test('editar categoría + agregar el CFDI después', async () => {
    const exp = await makeExpense()
    const uuid = crypto.randomUUID()
    await updateExpense({ tenantId, id: exp.id, userId, expenseCategoryId: categoryId2, uuidSat: uuid })
    const got = await getExpense({ tenantId, id: exp.id })
    expect(got.expense_category_id).toBe(categoryId2)
    expect(got.has_cfdi).toBe(true)
    expect(got.uuid_sat).toBe(uuid)
  })

  test('editar monto sin pago → actualiza factura Y CXP', async () => {
    const exp = await makeExpense({ subtotal: 1000, tax: 160 })
    await updateExpense({ tenantId, id: exp.id, userId, subtotal: 2000, tax: 320 })
    const got = await getExpense({ tenantId, id: exp.id })
    expect(parseFloat(got.total)).toBeCloseTo(2320)
    const ap = await getAp(exp.ap_id)
    expect(parseFloat(ap.amount_total)).toBeCloseTo(2320)  // el CXP quedó en sync
  })

  test('UUID duplicado al editar → 409', async () => {
    const uuid = crypto.randomUUID()
    await makeExpense({ uuidSat: uuid })
    const b = await makeExpense()
    await expect(updateExpense({ tenantId, id: b.id, userId, uuidSat: uuid }))
      .rejects.toMatchObject({ status: 409 })
  })

  test('gasto PAGADO → no se edita el monto ni se cancela (pero sí las notas)', async () => {
    const exp = await makeExpense({ subtotal: 500, tax: 80 })
    await registerPayment({
      tenantId, supplierId, method: 'transfer', reference: 'TR-1',
      amount: 580, currency: 'MXN',
      applications: [{ apId: exp.ap_id, amountApplied: 580 }], userId,
    })
    await expect(updateExpense({ tenantId, id: exp.id, userId, subtotal: 999 }))
      .rejects.toMatchObject({ status: 409 })
    await expect(cancelExpense({ tenantId, id: exp.id, userId }))
      .rejects.toMatchObject({ status: 409 })
    const upd = await updateExpense({ tenantId, id: exp.id, userId, notes: 'pagado en efectivo' })
    expect(upd.notes).toContain('pagado')   // editar campos NO monetarios sí se permite
  })

  test('cancelar gasto sin pago → status cancelled + CXP cancelado; ya no se edita', async () => {
    const exp = await makeExpense()
    const res = await cancelExpense({ tenantId, id: exp.id, userId, reason: 'capturado por error' })
    expect(res.status).toBe('cancelled')
    const ap = await getAp(exp.ap_id)
    expect(ap.status).toBe('cancelled')
    await expect(updateExpense({ tenantId, id: exp.id, userId, notes: 'x' }))
      .rejects.toMatchObject({ status: 409 })
  })
})
