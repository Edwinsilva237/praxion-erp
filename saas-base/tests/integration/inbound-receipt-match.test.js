'use strict'

/**
 * Fase 5A — el CFDI entrante por correo se AUTO-LIGA a una recepción pendiente
 * de factura del mismo proveedor cuando el subtotal cuadra (±2%) → se registra
 * como FACTURA DE COMPRA ligada a la recepción (no como gasto suelto). Si hay 0 o
 * varias coincidencias, o no es MXN, cae a GASTO (comportamiento anterior).
 */

process.env.INBOUND_INGEST_SECRET = 'test-ingest-secret-5a'

const { pool, query, withBypass } = require('../../src/db')
const inboundEmailService = require('../../src/modules/inbound/inboundEmailService')
const { createTenant, cleanupTestTenants } = require('../helpers/factory')

let tenantId, token, warehouseId
let n = 0
const rnum = (p) => `${p}-${Date.now() % 100000}-${n++}`
const TENANT_RFC = 'AAA010101AAA'
const DOC_DATE = '2026-06-10'   // misma fecha en el CFDI y en la recepción (ventana ±)

function cfdiXml({ uuid, folio, subtotal = 1000, tax = 160, total, currency = 'MXN', emisorRfc }) {
  const t = total != null ? total : subtotal + tax
  return `<?xml version="1.0" encoding="UTF-8"?>
<cfdi:Comprobante xmlns:cfdi="http://www.sat.gob.mx/cfd/4" Serie="A" Folio="${folio}" Fecha="${DOC_DATE}T12:00:00" SubTotal="${subtotal}" Moneda="${currency}" Total="${t}">
  <cfdi:Emisor Rfc="${emisorRfc}" Nombre="Proveedor Mercancia SA" RegimenFiscal="601"/>
  <cfdi:Receptor Rfc="${TENANT_RFC}" Nombre="Tenant Test SA" UsoCFDI="G03"/>
  <cfdi:Conceptos>
    <cfdi:Concepto Cantidad="1" ClaveUnidad="H87" Descripcion="Mercancia" ValorUnitario="${subtotal}" Importe="${subtotal}"/>
  </cfdi:Conceptos>
  <cfdi:Complemento>
    <tfd:TimbreFiscalDigital xmlns:tfd="http://www.sat.gob.mx/TimbreFiscalDigital" UUID="${uuid}"/>
  </cfdi:Complemento>
</cfdi:Comprobante>`
}
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64')

async function makeSupplier(rfc) {
  const { rows } = await withBypass(() => query(
    `INSERT INTO business_partners (tenant_id, type, name, rfc, supplier_credit_days)
     VALUES ($1,'supplier','Proveedor Mercancia SA',$2,30) RETURNING id`, [tenantId, rfc]))
  return rows[0].id
}

// Recepción CONFIRMADA con una línea (subtotal generado = qty × unit_price).
async function makeReceipt({ partnerId, qty = 10, unitPrice = 100 }) {
  const { rows: sr } = await withBypass(() => query(
    `INSERT INTO supplier_receipts (tenant_id, receipt_number, partner_id, warehouse_id, status, confirmed_at, received_date)
     VALUES ($1,$2,$3,$4,'confirmed',NOW(),$5::date) RETURNING id`,
    [tenantId, rnum('RCP'), partnerId, warehouseId, DOC_DATE]))
  await withBypass(() => query(
    `INSERT INTO supplier_receipt_lines (supplier_receipt_id, quantity_received, unit, unit_price, line_number)
     VALUES ($1,$2,'pza',$3,1)`, [sr[0].id, qty, unitPrice]))
  return sr[0].id
}

beforeAll(async () => {
  const info = await createTenant({ label: 'inbmatch', planSlug: 'owner' })
  tenantId = info.tenant.id
  const { rows: tk } = await withBypass(() => query(
    `SELECT inbound_email_token FROM tenants WHERE id = $1`, [tenantId]))
  token = tk[0].inbound_email_token
  await withBypass(() => query(
    `INSERT INTO tenant_fiscal_profiles (tenant_id, rfc, tax_name, tax_regime, zip_code, is_active)
     VALUES ($1,$2,'TENANT TEST SA','601','12345',true)`, [tenantId, TENANT_RFC]))
  const { rows: w } = await withBypass(() => query(
    `INSERT INTO warehouses (tenant_id, name, type, is_active) VALUES ($1,'Almacén','raw_material',true) RETURNING id`,
    [tenantId]))
  warehouseId = w[0].id
})

afterAll(async () => { await cleanupTestTenants(); await pool.end() })

test('CFDI cuadra con UNA recepción pendiente → factura de compra ligada (no gasto)', async () => {
  const rfc = 'PRA010101AB1'
  const sid = await makeSupplier(rfc)
  const rid = await makeReceipt({ partnerId: sid, qty: 10, unitPrice: 100 })   // subtotal 1000

  const r = await inboundEmailService.ingestInboundDocument({
    token, filename: 'merc.xml', mimetype: 'application/xml',
    contentBase64: b64(cfdiXml({ uuid: 'a1111111-1111-1111-1111-111111111111', folio: '5001', subtotal: 1000, tax: 160, emisorRfc: rfc })),
  })

  expect(r.status).toBe('created')
  expect(r.kind).toBe('purchase_invoice')
  expect(r.linkedReceiptId).toBe(rid)

  // Es factura de compra (no gasto) y la recepción quedó facturada.
  const { rows } = await withBypass(() => query(
    `SELECT is_expense, type FROM supplier_invoices WHERE id = $1`, [r.expenseId]))
  expect(rows[0].is_expense).toBe(false)
  const { rows: rc } = await withBypass(() => query(
    `SELECT invoiced_at FROM supplier_receipts WHERE id = $1`, [rid]))
  expect(rc[0].invoiced_at).not.toBeNull()
})

test('subtotal fuera de tolerancia → cae a gasto', async () => {
  const rfc = 'PRB020202CD2'
  const sid = await makeSupplier(rfc)
  await makeReceipt({ partnerId: sid, qty: 10, unitPrice: 100 })                // subtotal 1000

  const r = await inboundEmailService.ingestInboundDocument({
    token, filename: 'gasto.xml', mimetype: 'application/xml',
    contentBase64: b64(cfdiXml({ uuid: 'b2222222-2222-2222-2222-222222222222', folio: '5002', subtotal: 500, tax: 80, emisorRfc: rfc })),
  })

  expect(r.status).toBe('created')
  expect(r.kind).toBe('expense')
  expect(r.linkedReceiptId).toBeNull()
  const { rows } = await withBypass(() => query(
    `SELECT is_expense FROM supplier_invoices WHERE id = $1`, [r.expenseId]))
  expect(rows[0].is_expense).toBe(true)
})

test('dos recepciones pendientes dentro de tolerancia → ambiguo → gasto', async () => {
  const rfc = 'PRC030303EF3'
  const sid = await makeSupplier(rfc)
  await makeReceipt({ partnerId: sid, qty: 10, unitPrice: 100 })                // subtotal 1000
  await makeReceipt({ partnerId: sid, qty: 10, unitPrice: 100 })                // subtotal 1000 (otra)

  const r = await inboundEmailService.ingestInboundDocument({
    token, filename: 'ambiguo.xml', mimetype: 'application/xml',
    contentBase64: b64(cfdiXml({ uuid: 'c3333333-3333-3333-3333-333333333333', folio: '5003', subtotal: 1000, tax: 160, emisorRfc: rfc })),
  })

  expect(r.status).toBe('created')
  expect(r.kind).toBe('expense')           // 2 coincidencias → no auto-liga
  expect(r.linkedReceiptId).toBeNull()
})

test('±2%: $1,015 contra recepción de $1,000 sí liga (dentro de tolerancia)', async () => {
  const rfc = 'PRD040404GH4'
  const sid = await makeSupplier(rfc)
  const rid = await makeReceipt({ partnerId: sid, qty: 10, unitPrice: 100 })    // subtotal 1000

  const r = await inboundEmailService.ingestInboundDocument({
    token, filename: 'tol.xml', mimetype: 'application/xml',
    contentBase64: b64(cfdiXml({ uuid: 'd4444444-4444-4444-4444-444444444444', folio: '5004', subtotal: 1015, tax: 162.4, emisorRfc: rfc })),
  })

  expect(r.kind).toBe('purchase_invoice')  // |1015-1000| = 15 ≤ 1015×0.02 = 20.3
  expect(r.linkedReceiptId).toBe(rid)
})

// Nota: el camino USD del inbound (auto-liga deshabilitado por el guard
// currency==='MXN') no se prueba aquí porque registrar CUALQUIER factura USD
// exige un tipo de cambio para la fecha — limitación preexistente, ajena a 5A.
