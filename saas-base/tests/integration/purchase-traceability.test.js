'use strict'

/**
 * Reporte de trazabilidad de compras — expediente OC → recepción → factura →
 * devolución/NC → pagos → REP.
 *
 * Arma una cadena completa (OC y recepción por SQL — el reporte solo LEE;
 * factura, pago, devolución y NC por los services/APIs reales) y verifica que
 * el expediente contenga todos los eslabones con folio + UUID, más el
 * semáforo de REP y las OCs sin factura.
 */

const { randomUUID } = require('crypto')
const { createTenant, loginAs, authedClient, cleanupTestTenants } = require('../helpers/factory')
const { createRawMaterial } = require('../helpers/productionFactory')
const { pool, query, withBypass } = require('../../src/db')
const { getPurchaseTraceability } = require('../../src/modules/reports/purchaseTraceability')
const { generatePurchaseTraceabilityWorkbook } = require('../../src/modules/reports/purchaseTraceabilityExcel')

const FROM = '2020-01-01'
const TO   = '2100-01-01'

let ctx

afterAll(async () => { await cleanupTestTenants(); await pool.end() })

beforeAll(async () => {
  const info = await createTenant({ label: 'trace', planSlug: 'owner' })
  const sess = await loginAs({ slug: info.tenant.slug, email: info.email, password: info.password })
  const client = authedClient({ slug: info.tenant.slug, token: sess.token })
  const tenantId = info.tenant.id

  const rm = await createRawMaterial(client, { name: 'PE Trace', costPerKg: 10 })
  const sup = await client.post('/api/business-partners', {
    name: 'Prov Trace', type: 'supplier', rfc: 'XAXX010101000', tax_name: 'PROV TRACE SA', is_active: true,
  }).expect(201)
  const partnerId = sup.body.id

  const seeded = await withBypass(async () => {
    const w = await query(
      `INSERT INTO warehouses (tenant_id, name, type, is_active)
       VALUES ($1, 'MP T', 'raw_material', true) RETURNING id`, [tenantId])
    const warehouseId = w.rows[0].id
    await query(
      `INSERT INTO inventory_stock (tenant_id, warehouse_id, item_type, item_id, quantity, avg_cost, status)
       VALUES ($1, $2, 'raw_material', $3, 500, 10, 'available')`, [tenantId, warehouseId, rm.id])

    // OC con factura (parte del expediente) + OC que se queda sin factura.
    const po = await query(
      `INSERT INTO purchase_orders (tenant_id, order_number, partner_id, status, total_mxn, created_by)
       VALUES ($1, 'OC-TRZ-1', $2, 'received', 1160, $3) RETURNING id`, [tenantId, partnerId, info.user.id])
    await query(
      `INSERT INTO purchase_orders (tenant_id, order_number, partner_id, status, total_mxn, created_by)
       VALUES ($1, 'OC-TRZ-ABIERTA', $2, 'sent', 999, $3)`, [tenantId, partnerId, info.user.id])

    const rec = await query(
      `INSERT INTO supplier_receipts (tenant_id, receipt_number, purchase_order_id, partner_id,
                                      warehouse_id, received_date, status, document_number, created_by)
       VALUES ($1, 'REC-TRZ-1', $2, $3, $4, CURRENT_DATE, 'confirmed', 'REM-PROV-9', $5) RETURNING id`,
      [tenantId, po.rows[0].id, partnerId, warehouseId, info.user.id])
    // subtotal es columna GENERADA (quantity_received * unit_price) → no se inserta.
    const line = await query(
      `INSERT INTO supplier_receipt_lines (supplier_receipt_id, line_number, item_type, item_id,
                                           quantity_received, unit, unit_price, warehouse_id)
       VALUES ($1, 1, 'raw_material', $2, 100, 'kg', 10, $3) RETURNING id`,
      [rec.rows[0].id, rm.id, warehouseId])
    return { warehouseId, receiptId: rec.rows[0].id, receiptLineId: line.rows[0].id }
  })

  // Factura PPD ligada a la recepción.
  const invUuid = randomUUID().toUpperCase()
  const inv = await client.post('/api/purchases/invoices', {
    supplierId: partnerId, documentType: 'invoice', documentNumber: 'F-TRZ-1',
    uuidSat: invUuid, invoiceDate: '2026-06-01', subtotal: 1000, tax: 160, total: 1160,
  }).expect(201)
  await withBypass(() => query(
    `UPDATE supplier_invoices SET metodo_pago_sat = 'PPD' WHERE id = $1`, [inv.body.id]))
  await withBypass(() => query(
    `INSERT INTO invoice_receipt_links (tenant_id, supplier_invoice_id, supplier_receipt_id, amount_applied)
     VALUES ($1, $2, $3, 1000)`, [info.tenant.id, inv.body.id, seeded.receiptId]))

  // Pago parcial + REP cruzado por el mismo monto.
  await client.post('/api/purchases/payments', {
    supplierId: partnerId, method: 'transfer', reference: 'TRX-TRZ',
    amount: 580, applications: [{ apId: inv.body.ap_id, amountApplied: 580 }],
  }).expect(201)
  const { rows: pays } = await withBypass(() => query(
    `SELECT sp.id FROM supplier_payments sp
      WHERE sp.tenant_id = $1 AND sp.partner_id = $2 AND sp.method = 'transfer'`, [info.tenant.id, partnerId]))
  const repUuid = randomUUID().toUpperCase()
  await withBypass(() => query(
    `INSERT INTO supplier_payment_complements
       (tenant_id, partner_id, cfdi_uuid, serie, folio, payment_date, amount, currency,
        supplier_payment_id, match_status)
     VALUES ($1, $2, $3, 'P', '55', CURRENT_DATE, 580, 'MXN', $4, 'matched')`,
    [info.tenant.id, partnerId, repUuid, pays[0].id]))

  // Devolución parcial sobre la recepción → resolución con nota de crédito.
  const ret = await client.post('/api/purchases/returns', {
    partnerId, sourceReceiptId: seeded.receiptId,
    lines: [{ itemType: 'raw_material', itemId: rm.id, warehouseId: seeded.warehouseId,
              quantity: 10, unit: 'kg', unitCost: 10, sourceReceiptLineId: seeded.receiptLineId }],
  }).expect(201)
  await client.post(`/api/purchases/returns/${ret.body.id}/confirm`).expect(200)
  const ncUuid = randomUUID().toUpperCase()
  await client.post(`/api/purchases/returns/${ret.body.id}/resolve`, {
    resolution: 'credit_note', supplierInvoiceId: inv.body.id,
    creditNote: { invoiceNumber: 'NC-TRZ-1', uuidSat: ncUuid, total: 116, tax: 16, subtotal: 100,
                  invoiceDate: '2026-06-10' },
  }).expect(200)

  ctx = { tenantId: info.tenant.id, partnerId, invUuid, ncUuid, repUuid }
})

test('el expediente contiene la cadena completa: OC, recepción, factura, pago, REP, devolución y NC', async () => {
  const data = await getPurchaseTraceability({ tenantId: ctx.tenantId, from: FROM, to: TO })

  expect(data.summary.chains).toBe(1)   // solo F-TRZ-1 — la NC no abre expediente propio
  const chain = data.chains.find(c => c.invoice.number === 'F-TRZ-1')
  expect(chain).toBeTruthy()
  expect(chain.partner.rfc).toBe('XAXX010101000')
  expect(chain.ocs).toEqual(['OC-TRZ-1'])
  expect(chain.receipts).toEqual(['REC-TRZ-1'])

  const types = chain.events.map(e => e.type)
  for (const t of ['oc', 'receipt', 'invoice', 'payment', 'rep', 'return', 'credit_note']) {
    expect(types).toContain(t)
  }

  // Postgres normaliza los uuid a minúsculas → comparar sin distinguir caja.
  const invoiceEvt = chain.events.find(e => e.type === 'invoice')
  expect(invoiceEvt.uuid.toUpperCase()).toBe(ctx.invUuid)
  const ncEvt = chain.events.find(e => e.type === 'credit_note')
  expect(ncEvt.doc).toBe('NC-TRZ-1')
  expect(ncEvt.uuid.toUpperCase()).toBe(ctx.ncUuid)
  expect(ncEvt.detail).toContain('DEV-')
  const repEvt = chain.events.find(e => e.type === 'rep')
  expect(repEvt.uuid.toUpperCase()).toBe(ctx.repUuid)
  expect(parseFloat(repEvt.amount)).toBeCloseTo(580, 2)

  // PPD: pago real de 580 (transfer) con REP cruzado por 580 → 'ok'. La NC
  // aplicada (116) NO cuenta para el semáforo — no exige REP.
  expect(chain.flags.rep_status).toBe('ok')
  expect(chain.flags.has_nc).toBe(true)
})

test('resumen de summary.chains cuenta solo facturas/remisiones (la NC no abre expediente)', async () => {
  const data = await getPurchaseTraceability({ tenantId: ctx.tenantId, from: FROM, to: TO })
  const numbers = data.chains.map(c => c.invoice.number)
  expect(numbers).toContain('F-TRZ-1')
  expect(numbers).not.toContain('NC-TRZ-1')
})

test('las OCs sin factura aparecen como expedientes abiertos', async () => {
  const data = await getPurchaseTraceability({ tenantId: ctx.tenantId, from: FROM, to: TO })
  const abiertas = data.pending_ocs.map(o => o.order_number)
  expect(abiertas).toContain('OC-TRZ-ABIERTA')
  expect(abiertas).not.toContain('OC-TRZ-1')   // ya tiene factura vía la recepción
})

test('filtro por proveedor y Excel se generan sin error', async () => {
  const filtered = await getPurchaseTraceability({
    tenantId: ctx.tenantId, from: FROM, to: TO, partnerId: ctx.partnerId })
  expect(filtered.chains.length).toBeGreaterThan(0)

  const otro = await getPurchaseTraceability({
    tenantId: ctx.tenantId, from: FROM, to: TO, partnerId: randomUUID() })
  expect(otro.chains.length).toBe(0)

  const buffer = await generatePurchaseTraceabilityWorkbook({
    tenantId: ctx.tenantId, from: FROM, to: TO, tenantName: 'Test Trace' })
  expect(Buffer.isBuffer(Buffer.from(buffer))).toBe(true)
  expect(buffer.byteLength).toBeGreaterThan(5000)
})
