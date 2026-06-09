'use strict'

/**
 * Devoluciones a proveedor (Fase 2) — resolución fiscal (mig 198).
 *
 * Verifica las 3 vías (nota de crédito / cancelación / sustitución) y su efecto
 * en CXP (accounts_payable) y saldo a favor (ap_advances), más el ajuste del IVA
 * acreditable al-cobro (los "pagos" method='credit_note' NO cuentan) y los guards
 * de pre-requisito/idempotencia.
 */

const { randomUUID } = require('crypto')
const { createTenant, loginAs, authedClient, cleanupTestTenants } = require('../helpers/factory')
const { createRawMaterial } = require('../helpers/productionFactory')
const { pool, query, withBypass } = require('../../src/db')
const { getFinancialSnapshot } = require('../../src/modules/reports/financialSnapshot')

afterAll(async () => {
  await cleanupTestTenants()
  await pool.end()
})

// ── Helpers ──────────────────────────────────────────────────────────────────
// Monta un tenant con MP + almacén + stock + lote grande + proveedor.
async function setupTenant(label) {
  const info = await createTenant({ label, planSlug: 'owner' })
  const sess = await loginAs({ slug: info.tenant.slug, email: info.email, password: info.password })
  const client = authedClient({ slug: info.tenant.slug, token: sess.token })
  const tenantId = info.tenant.id

  const rm = await createRawMaterial(client, { name: 'PE Fiscal', costPerKg: 20 })
  const sup = await client.post('/api/business-partners', {
    name: 'Prov Fiscal', type: 'supplier', rfc: 'XAXX010101000', tax_name: 'PROV F', is_active: true,
  }).expect(201)
  const partnerId = sup.body.id

  const { warehouseId, lotId } = await withBypass(async () => {
    const w = await query(
      `INSERT INTO warehouses (tenant_id, name, type, is_active)
       VALUES ($1, 'MP F', 'raw_material', true) RETURNING id`, [tenantId])
    const wid = w.rows[0].id
    await query(
      `INSERT INTO inventory_stock (tenant_id, warehouse_id, item_type, item_id, quantity, avg_cost, status)
       VALUES ($1, $2, 'raw_material', $3, 1000, 20, 'available')`, [tenantId, wid, rm.id])
    const l = await query(
      `INSERT INTO raw_material_lots
         (tenant_id, raw_material_id, lot_number, warehouse_id,
          quantity_received, quantity_remaining, unit_cost, total_cost, status)
       VALUES ($1,$2,'LOT-F',$3,1000,1000,20,20000,'active') RETURNING id`, [tenantId, rm.id, wid])
    return { warehouseId: wid, lotId: l.rows[0].id }
  })

  return { client, tenantId, rm, partnerId, warehouseId, lotId }
}

async function mkDraftReturn(ctx, qty = 5) {
  const r = await ctx.client.post('/api/purchases/returns', {
    partnerId: ctx.partnerId,
    lines: [{ itemType: 'raw_material', itemId: ctx.rm.id, warehouseId: ctx.warehouseId, rawMaterialLotId: ctx.lotId, quantity: qty }],
  }).expect(201)
  return r.body.id
}
async function mkConfirmedReturn(ctx, qty = 5) {
  const id = await mkDraftReturn(ctx, qty)
  await ctx.client.post(`/api/purchases/returns/${id}/confirm`).expect(200)
  return id
}
async function mkInvoice(ctx, { number, total, tax = 0, subtotal }) {
  const res = await ctx.client.post('/api/purchases/invoices', {
    supplierId: ctx.partnerId, documentType: 'invoice',
    documentNumber: number, uuidSat: randomUUID(), invoiceDate: '2026-06-01',
    subtotal: subtotal != null ? subtotal : total - tax, tax, total,
  }).expect(201)
  return res.body  // { id, ap_id, ... }
}
async function pay(ctx, apId, amount) {
  await ctx.client.post('/api/purchases/payments', {
    supplierId: ctx.partnerId, method: 'transfer', reference: 'TRX',
    amount, applications: [{ apId, amountApplied: amount }],
  }).expect(201)
}
async function apRow(apId) {
  const { rows } = await withBypass(() => query(
    `SELECT amount_total, amount_paid, amount_pending, status FROM accounts_payable WHERE id = $1`, [apId]))
  return rows[0]
}
async function advances(ctx) {
  const { rows } = await withBypass(() => query(
    `SELECT amount, amount_available, payment_method FROM ap_advances
      WHERE tenant_id = $1 AND partner_id = $2 ORDER BY created_at`, [ctx.tenantId, ctx.partnerId]))
  return rows
}

// ── Tests ────────────────────────────────────────────────────────────────────
describe('Devoluciones a proveedor — Fase 2 (resolución fiscal)', () => {

  test('Nota de crédito sobre factura CON saldo reduce la CXP', async () => {
    const ctx = await setupTenant('cn-saldo')
    const inv = await mkInvoice(ctx, { number: 'F-1', total: 1160, tax: 160, subtotal: 1000 })
    const retId = await mkConfirmedReturn(ctx)

    const res = await ctx.client.post(`/api/purchases/returns/${retId}/resolve`, {
      resolution: 'credit_note', supplierInvoiceId: inv.id,
      creditNote: { invoiceNumber: 'NC-1', total: 580, tax: 80, subtotal: 500, invoiceDate: '2026-06-05', uuidSat: randomUUID() },
    }).expect(200)
    expect(res.body.fiscal_resolution).toBe('credit_note')
    expect(res.body.credit_status).toBe('resolved')
    expect(res.body.credit_note_number).toBe('NC-1')

    const ap = await apRow(inv.ap_id)
    expect(parseFloat(ap.amount_paid)).toBeCloseTo(580, 2)
    expect(parseFloat(ap.amount_pending)).toBeCloseTo(580, 2)
    expect(ap.status).toBe('partial')
    expect((await advances(ctx)).length).toBe(0)   // sin excedente
  })

  test('Nota de crédito sobre factura YA PAGADA genera saldo a favor por el total', async () => {
    const ctx = await setupTenant('cn-pagada')
    const inv = await mkInvoice(ctx, { number: 'F-1', total: 1160, tax: 160, subtotal: 1000 })
    await pay(ctx, inv.ap_id, 1160)
    const retId = await mkConfirmedReturn(ctx)

    await ctx.client.post(`/api/purchases/returns/${retId}/resolve`, {
      resolution: 'credit_note', supplierInvoiceId: inv.id,
      creditNote: { invoiceNumber: 'NC-1', total: 580, tax: 80, subtotal: 500, invoiceDate: '2026-06-05', uuidSat: randomUUID() },
    }).expect(200)

    const ap = await apRow(inv.ap_id)
    expect(ap.status).toBe('paid')
    expect(parseFloat(ap.amount_paid)).toBeCloseTo(1160, 2)   // sin cambio
    const adv = await advances(ctx)
    expect(adv.length).toBe(1)
    expect(parseFloat(adv[0].amount_available)).toBeCloseTo(580, 2)
    expect(adv[0].payment_method).toBe('credit_note')
  })

  test('Nota de crédito MAYOR al saldo: agota la CXP y el excedente va a saldo a favor', async () => {
    const ctx = await setupTenant('cn-exceso')
    const inv = await mkInvoice(ctx, { number: 'F-1', total: 1160, tax: 160, subtotal: 1000 })
    await pay(ctx, inv.ap_id, 400)   // pending 760
    const retId = await mkConfirmedReturn(ctx)

    await ctx.client.post(`/api/purchases/returns/${retId}/resolve`, {
      resolution: 'credit_note', supplierInvoiceId: inv.id,
      creditNote: { invoiceNumber: 'NC-1', total: 1000, tax: 0, subtotal: 1000, invoiceDate: '2026-06-05', uuidSat: randomUUID() },
    }).expect(200)

    const ap = await apRow(inv.ap_id)
    expect(ap.status).toBe('paid')                            // 400 + 760 aplicado = 1160
    expect(parseFloat(ap.amount_paid)).toBeCloseTo(1160, 2)
    const adv = await advances(ctx)
    expect(adv.length).toBe(1)
    expect(parseFloat(adv[0].amount_available)).toBeCloseTo(240, 2)  // 1000 − 760
  })

  test('Cancelación de factura IMPAGA anula la CXP sin saldo a favor', async () => {
    const ctx = await setupTenant('cancel-impaga')
    const inv = await mkInvoice(ctx, { number: 'F-1', total: 1160, tax: 160, subtotal: 1000 })
    const retId = await mkConfirmedReturn(ctx)

    const res = await ctx.client.post(`/api/purchases/returns/${retId}/resolve`, {
      resolution: 'cancellation', supplierInvoiceId: inv.id,
    }).expect(200)
    expect(res.body.fiscal_resolution).toBe('cancellation')
    expect(res.body.cancelled_invoice_number).toBe('F-1')

    const ap = await apRow(inv.ap_id)
    expect(ap.status).toBe('cancelled')
    expect((await advances(ctx)).length).toBe(0)
    const { rows } = await withBypass(() => query(
      `SELECT status FROM supplier_invoices WHERE id = $1`, [inv.id]))
    expect(rows[0].status).toBe('cancelled')

    // El estado de cuenta NO debe contar la factura cancelada como adeudo.
    const stmt = await ctx.client.get(`/api/purchases/suppliers/${ctx.partnerId}/statement`).expect(200)
    expect(parseFloat(stmt.body.summary.total_pending)).toBeCloseTo(0, 2)
    expect(stmt.body.documents.length).toBe(0)
  })

  test('Cancelación de factura PAGADA genera saldo a favor por lo pagado', async () => {
    const ctx = await setupTenant('cancel-pagada')
    const inv = await mkInvoice(ctx, { number: 'F-1', total: 1160, tax: 160, subtotal: 1000 })
    await pay(ctx, inv.ap_id, 1160)
    const retId = await mkConfirmedReturn(ctx)

    await ctx.client.post(`/api/purchases/returns/${retId}/resolve`, {
      resolution: 'cancellation', supplierInvoiceId: inv.id,
    }).expect(200)

    expect((await apRow(inv.ap_id)).status).toBe('cancelled')
    const adv = await advances(ctx)
    expect(adv.length).toBe(1)
    expect(parseFloat(adv[0].amount_available)).toBeCloseTo(1160, 2)
  })

  test('Sustitución: anula la original, crea la nueva con su CXP y las enlaza', async () => {
    const ctx = await setupTenant('sustitucion')
    const inv = await mkInvoice(ctx, { number: 'F-1', total: 1160, tax: 160, subtotal: 1000 })
    const retId = await mkConfirmedReturn(ctx)

    const res = await ctx.client.post(`/api/purchases/returns/${retId}/resolve`, {
      resolution: 'substitution', supplierInvoiceId: inv.id,
      substitute: { invoiceNumber: 'F-1-SUST', total: 580, tax: 80, subtotal: 500, invoiceDate: '2026-06-06', uuidSat: randomUUID() },
    }).expect(200)
    expect(res.body.fiscal_resolution).toBe('substitution')
    expect(res.body.substitute_invoice_number).toBe('F-1-SUST')

    const { rows: orig } = await withBypass(() => query(
      `SELECT status, replaced_by_invoice_id FROM supplier_invoices WHERE id = $1`, [inv.id]))
    expect(orig[0].status).toBe('cancelled')
    expect(orig[0].replaced_by_invoice_id).toBeTruthy()
    expect((await apRow(inv.ap_id)).status).toBe('cancelled')

    const { rows: newAp } = await withBypass(() => query(
      `SELECT ap.amount_total, ap.status
         FROM accounts_payable ap JOIN supplier_invoices si ON si.id = ap.document_id
        WHERE si.invoice_number = 'F-1-SUST' AND si.tenant_id = $1`, [ctx.tenantId]))
    expect(newAp.length).toBe(1)
    expect(parseFloat(newAp[0].amount_total)).toBeCloseTo(580, 2)
    expect(newAp[0].status).toBe('pending')
  })

  test('IVA acreditable: el pago de nota de crédito NO cuenta, el efectivo SÍ', async () => {
    const ctx = await setupTenant('iva-cn')
    const inv = await mkInvoice(ctx, { number: 'F-1', total: 1160, tax: 160, subtotal: 1000 })
    const retId = await mkConfirmedReturn(ctx)
    await ctx.client.post(`/api/purchases/returns/${retId}/resolve`, {
      resolution: 'credit_note', supplierInvoiceId: inv.id,
      creditNote: { invoiceNumber: 'NC-1', total: 580, tax: 80, subtotal: 500, invoiceDate: '2026-06-05', uuidSat: randomUUID() },
    }).expect(200)
    await pay(ctx, inv.ap_id, 580)   // paga el saldo restante en efectivo

    const snap = await getFinancialSnapshot({ tenantId: ctx.tenantId })
    // creditable = 580 × (160/1160) = 80 (solo el efectivo; la NC excluida).
    // Incluir la NC daría 160 = doble conteo.
    expect(snap.iva.creditable).toBeCloseTo(80, 1)
  })

  test('Guard: no se puede re-resolver una devolución ya resuelta', async () => {
    const ctx = await setupTenant('idem')
    const inv = await mkInvoice(ctx, { number: 'F-1', total: 1160, tax: 160, subtotal: 1000 })
    const retId = await mkConfirmedReturn(ctx)
    await ctx.client.post(`/api/purchases/returns/${retId}/resolve`, {
      resolution: 'cancellation', supplierInvoiceId: inv.id,
    }).expect(200)
    const r = await ctx.client.post(`/api/purchases/returns/${retId}/resolve`, {
      resolution: 'cancellation', supplierInvoiceId: inv.id,
    })
    expect(r.status).toBe(400)
  })

  test('Guard: no se puede resolver una devolución en BORRADOR', async () => {
    const ctx = await setupTenant('borrador')
    const inv = await mkInvoice(ctx, { number: 'F-1', total: 1160, tax: 160, subtotal: 1000 })
    const draftId = await mkDraftReturn(ctx)
    const r = await ctx.client.post(`/api/purchases/returns/${draftId}/resolve`, {
      resolution: 'cancellation', supplierInvoiceId: inv.id,
    })
    expect(r.status).toBe(400)
  })
})
