'use strict'

/**
 * Crear (o reusar) un PROVEEDOR a partir de un GASTO genérico — típicamente uno
 * que llegó por correo cuyo emisor no estaba en el catálogo (partner_id NULL,
 * generic_supplier = razón social del CFDI, y SIN accounts_payable).
 *
 * supplierInvoiceService.assignExpenseSupplier:
 *   - crea el proveedor con el RFC + nombre del CFDI y GENERA la CXP que faltaba;
 *   - dedup por RFC: reusa un socio existente y promueve un 'customer' a 'both';
 *   - respeta overrides del form; guarda contra gasto ya asignado / cancelado.
 */

const { pool, query, withBypass } = require('../../src/db')
const svc = require('../../src/modules/purchases/supplierInvoiceService')
const { createTenant, cleanupTestTenants } = require('../helpers/factory')

let tenantId, userId
let n = 0
const uniq = () => `${Date.now()}-${++n}`

// Crea un gasto GENÉRICO (sin partner_id, sin CXP) como lo deja el inbound.
async function genericExpense({ rfc = null, name = 'Proveedor Nuevo SA', total = 116, subtotal = 100, tax = 16 } = {}) {
  return svc.registerInvoice({
    tenantId, genericSupplier: name,
    documentNumber: `F-${uniq()}`, total, subtotal, tax,
    rfcEmisor: rfc, invoiceDate: '2026-06-10',
    isExpense: true, userId,
  })
}

beforeAll(async () => {
  const t = await createTenant({ label: 'expsup', planSlug: 'owner' })
  tenantId = t.tenant.id
  userId   = t.user.id
})
afterAll(async () => { await cleanupTestTenants(); await pool.end() })

test('crea proveedor nuevo desde el CFDI + genera la CXP que faltaba', async () => {
  const exp = await genericExpense({ rfc: 'NEW010101NE5', name: 'Acme Fletes SA' })

  // El gasto genérico NO tiene CXP todavía (registerInvoice solo la crea si hay supplierId).
  let ap = await withBypass(() => query(
    `SELECT id FROM accounts_payable WHERE document_id = $1`, [exp.id]))
  expect(ap.rows.length).toBe(0)

  const r = await svc.assignExpenseSupplier({ tenantId, id: exp.id, userId })
  expect(r.outcome).toBe('created')

  const { rows } = await withBypass(() => query(
    `SELECT partner_id, generic_supplier FROM supplier_invoices WHERE id = $1`, [exp.id]))
  expect(rows[0].partner_id).toBe(r.partner.id)
  expect(rows[0].generic_supplier).toBeNull()

  // El proveedor quedó con el RFC y nombre del CFDI, tipo supplier y EVENTUAL
  // (is_occasional=true por default → fuera del catálogo principal).
  const { rows: bp } = await withBypass(() => query(
    `SELECT name, rfc, type, is_occasional FROM business_partners WHERE id = $1`, [r.partner.id]))
  expect(bp[0].rfc).toBe('NEW010101NE5')
  expect(bp[0].name).toBe('Acme Fletes SA')
  expect(bp[0].type).toBe('supplier')
  expect(bp[0].is_occasional).toBe(true)

  // Ahora SÍ existe la CXP, ligada al proveedor, por el total del gasto.
  ap = await withBypass(() => query(
    `SELECT partner_id, amount_total FROM accounts_payable WHERE document_id = $1`, [exp.id]))
  expect(ap.rows.length).toBe(1)
  expect(ap.rows[0].partner_id).toBe(r.partner.id)
  expect(parseFloat(ap.rows[0].amount_total)).toBeCloseTo(116, 2)
})

test('dedup por RFC: si ya existe un proveedor con ese RFC, lo reusa (no duplica)', async () => {
  const RFC = 'DUP010101DU7'
  const { rows: pre } = await withBypass(() => query(
    `INSERT INTO business_partners (tenant_id, type, name, rfc)
     VALUES ($1,'supplier','Ya Existe SA',$2) RETURNING id`, [tenantId, RFC]))
  const existingId = pre[0].id

  const exp = await genericExpense({ rfc: RFC, name: 'Ya Existe SA' })
  const r = await svc.assignExpenseSupplier({ tenantId, id: exp.id, userId })
  expect(r.outcome).toBe('linked')
  expect(r.partner.id).toBe(existingId)

  const { rows: cnt } = await withBypass(() => query(
    `SELECT COUNT(*)::int AS n FROM business_partners
      WHERE tenant_id = $1 AND UPPER(REPLACE(rfc,' ','')) = $2`, [tenantId, RFC]))
  expect(cnt[0].n).toBe(1)   // no se creó duplicado
})

test('si el RFC pertenece a un CLIENTE, lo promueve a both', async () => {
  const RFC = 'CLI010101CL3'
  const { rows: pre } = await withBypass(() => query(
    `INSERT INTO business_partners (tenant_id, type, name, rfc)
     VALUES ($1,'customer','Cliente Que Vende SA',$2) RETURNING id`, [tenantId, RFC]))
  const custId = pre[0].id

  const exp = await genericExpense({ rfc: RFC })
  const r = await svc.assignExpenseSupplier({ tenantId, id: exp.id, userId })
  expect(r.outcome).toBe('promoted')
  expect(r.partner.id).toBe(custId)

  const { rows: bp } = await withBypass(() => query(
    `SELECT type FROM business_partners WHERE id = $1`, [custId]))
  expect(bp[0].type).toBe('both')
})

test('overrides del form (nombre/RFC/tipo) ganan sobre lo del CFDI', async () => {
  const exp = await genericExpense({ rfc: 'CFD010101CF1', name: 'Nombre del CFDI' })
  const r = await svc.assignExpenseSupplier({
    tenantId, id: exp.id, userId,
    name: 'Nombre Corregido SA', rfc: 'OVR010101OV9', partnerType: 'both',
  })
  expect(r.outcome).toBe('created')
  const { rows: bp } = await withBypass(() => query(
    `SELECT name, rfc, type FROM business_partners WHERE id = $1`, [r.partner.id]))
  expect(bp[0].name).toBe('Nombre Corregido SA')
  expect(bp[0].rfc).toBe('OVR010101OV9')
  expect(bp[0].type).toBe('both')
})

test('isOccasional=false (recurrente) → crea proveedor FORMAL (en el catálogo)', async () => {
  const exp = await genericExpense({ rfc: 'REC010101RE0', name: 'Proveedor Recurrente SA' })
  const r = await svc.assignExpenseSupplier({ tenantId, id: exp.id, userId, isOccasional: false })
  expect(r.outcome).toBe('created')
  const { rows: bp } = await withBypass(() => query(
    `SELECT is_occasional FROM business_partners WHERE id = $1`, [r.partner.id]))
  expect(bp[0].is_occasional).toBe(false)
})

test('guarda: gasto que ya tiene proveedor → 409', async () => {
  const exp = await genericExpense({ rfc: 'TWO010101TW2' })
  await svc.assignExpenseSupplier({ tenantId, id: exp.id, userId })
  await expect(svc.assignExpenseSupplier({ tenantId, id: exp.id, userId }))
    .rejects.toMatchObject({ status: 409 })
})

test('guarda: gasto cancelado → 409', async () => {
  const exp = await genericExpense({ rfc: 'CAN010101CA4' })
  await svc.cancelExpense({ tenantId, id: exp.id, userId })
  await expect(svc.assignExpenseSupplier({ tenantId, id: exp.id, userId }))
    .rejects.toMatchObject({ status: 409 })
})

test('partnerType inválido → 400', async () => {
  const exp = await genericExpense({ rfc: 'BAD010101BA6' })
  await expect(svc.assignExpenseSupplier({ tenantId, id: exp.id, userId, partnerType: 'customer' }))
    .rejects.toMatchObject({ status: 400 })
})

test('updateExpense: asignar proveedor por el dropdown a un gasto genérico genera la CXP faltante', async () => {
  const { rows: pre } = await withBypass(() => query(
    `INSERT INTO business_partners (tenant_id, type, name, rfc)
     VALUES ($1,'supplier','Proveedor del Dropdown SA','DRP010101DR8') RETURNING id`, [tenantId]))
  const supId = pre[0].id

  const exp = await genericExpense({ rfc: null, name: 'Sin RFC SA' })
  let ap = await withBypass(() => query(`SELECT id FROM accounts_payable WHERE document_id = $1`, [exp.id]))
  expect(ap.rows.length).toBe(0)

  await svc.updateExpense({ tenantId, id: exp.id, userId, supplierId: supId })

  ap = await withBypass(() => query(
    `SELECT partner_id, amount_total FROM accounts_payable WHERE document_id = $1`, [exp.id]))
  expect(ap.rows.length).toBe(1)
  expect(ap.rows[0].partner_id).toBe(supId)
  expect(parseFloat(ap.rows[0].amount_total)).toBeCloseTo(116, 2)
})
