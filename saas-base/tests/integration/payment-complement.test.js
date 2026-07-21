'use strict'

/**
 * Complementos de pago de PROVEEDOR (REP, CFDI tipo P) — mig 235.
 *
 * Flujo: factura PPD registrada y pagada → el REP llega por el buzón →
 * NO crea gasto; se registra como complemento, se liga a la factura por UUID
 * (determinista) y al pago por aplicación (auto solo si es inequívoco).
 * Tablero de cumplimiento: PPD pagadas sin REP.
 */

process.env.INBOUND_INGEST_SECRET = 'test-ingest-secret-123'

const request = require('supertest')
const app = require('../../src/app')
const { pool, query, withBypass } = require('../../src/db')
const inboundEmailService = require('../../src/modules/inbound/inboundEmailService')
const supplierInvoiceService = require('../../src/modules/purchases/supplierInvoiceService')
const supplierComplementService = require('../../src/modules/purchases/supplierComplementService')
const documentParserService = require('../../src/modules/purchases/documentParserService')
const { createTenant, loginAs, authedClient, cleanupTestTenants } = require('../helpers/factory')

let tenantId, token, supplierId, client
let invoiceId, apId, paymentId

const TENANT_RFC   = 'AAA010101AAA'
const SUPPLIER_RFC = 'PRO010101AB2'
const INV_UUID  = 'aaaa1111-2222-3333-4444-555555555555'
const REP_UUID  = 'bbbb1111-2222-3333-4444-555555555555'
const REP2_UUID = 'cccc1111-2222-3333-4444-555555555555'
const INV2_UUID = 'dddd1111-2222-3333-4444-555555555555'

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64')

/** CFDI tipo P (REP) mínimo con Pagos 2.0. */
function repXml({ uuid, docUuid, monto = 1160, impPagado = 1160, saldoInsoluto = 0,
                  parcialidad = 1, receptorRfc = TENANT_RFC, emisorRfc = SUPPLIER_RFC,
                  fechaPago = '2026-07-15' }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<cfdi:Comprobante xmlns:cfdi="http://www.sat.gob.mx/cfd/4" xmlns:pago20="http://www.sat.gob.mx/Pagos20" Serie="P" Folio="88" Fecha="2026-07-16T10:00:00" SubTotal="0" Moneda="XXX" Total="0" TipoDeComprobante="P">
  <cfdi:Emisor Rfc="${emisorRfc}" Nombre="Proveedor Correo SA" RegimenFiscal="601"/>
  <cfdi:Receptor Rfc="${receptorRfc}" Nombre="Tenant Test SA" UsoCFDI="CP01"/>
  <cfdi:Conceptos>
    <cfdi:Concepto ClaveProdServ="84111506" Cantidad="1" ClaveUnidad="ACT" Descripcion="Pago" ValorUnitario="0" Importe="0"/>
  </cfdi:Conceptos>
  <cfdi:Complemento>
    <pago20:Pagos Version="2.0">
      <pago20:Totales MontoTotalPagos="${monto}"/>
      <pago20:Pago FechaPago="${fechaPago}T12:00:00" FormaDePagoP="03" MonedaP="MXN" TipoCambioP="1" Monto="${monto}">
        <pago20:DoctoRelacionado IdDocumento="${docUuid}" Serie="A" Folio="555" MonedaDR="MXN" EquivalenciaDR="1" NumParcialidad="${parcialidad}" ImpSaldoAnt="${monto}" ImpPagado="${impPagado}" ImpSaldoInsoluto="${saldoInsoluto}" ObjetoImpDR="02"/>
      </pago20:Pago>
    </pago20:Pagos>
    <tfd:TimbreFiscalDigital xmlns:tfd="http://www.sat.gob.mx/TimbreFiscalDigital" UUID="${uuid}"/>
  </cfdi:Complemento>
</cfdi:Comprobante>`
}

/** CFDI de Ingreso normal (para el guard de la subida manual). */
function invoiceXml({ uuid }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<cfdi:Comprobante xmlns:cfdi="http://www.sat.gob.mx/cfd/4" Serie="A" Folio="900" Fecha="2026-07-10T12:00:00" SubTotal="100" Moneda="MXN" Total="116" TipoDeComprobante="I" MetodoPago="PPD">
  <cfdi:Emisor Rfc="${SUPPLIER_RFC}" Nombre="Proveedor Correo SA" RegimenFiscal="601"/>
  <cfdi:Receptor Rfc="${TENANT_RFC}" Nombre="Tenant Test SA" UsoCFDI="G03"/>
  <cfdi:Complemento>
    <tfd:TimbreFiscalDigital xmlns:tfd="http://www.sat.gob.mx/TimbreFiscalDigital" UUID="${uuid}"/>
  </cfdi:Complemento>
</cfdi:Comprobante>`
}

beforeAll(async () => {
  const t = await createTenant({ label: 'repcomp', planSlug: 'owner' })
  tenantId = t.tenant.id

  const session = await loginAs({ slug: t.tenant.slug, email: t.email, password: t.password })
  client = authedClient({ slug: t.tenant.slug, token: session.token })

  const { rows: tk } = await withBypass(() => query(
    `SELECT inbound_email_token FROM tenants WHERE id = $1`, [tenantId]))
  token = tk[0].inbound_email_token

  await withBypass(() => query(
    `INSERT INTO tenant_fiscal_profiles (tenant_id, rfc, tax_name, tax_regime, zip_code, is_active)
     VALUES ($1,$2,'TENANT TEST SA','601','12345',true)`,
    [tenantId, TENANT_RFC]))

  const { rows: bp } = await withBypass(() => query(
    `INSERT INTO business_partners (tenant_id, type, name, rfc) VALUES ($1,'supplier','Proveedor Correo SA',$2) RETURNING id`,
    [tenantId, SUPPLIER_RFC]))
  supplierId = bp[0].id

  // Factura PPD registrada y PAGADA (el escenario que exige REP).
  const inv = await withBypass(() => supplierInvoiceService.registerInvoice({
    tenantId, supplierId,
    documentNumber: 'A-555', uuidSat: INV_UUID, serie: 'A', folio: '555',
    rfcEmisor: SUPPLIER_RFC, invoiceDate: '2026-07-10',
    subtotal: 1000, tax: 160, total: 1160,
    metodoPagoSat: 'PPD',
  }))
  invoiceId = inv.id

  const { rows: ap } = await withBypass(() => query(
    `SELECT id FROM accounts_payable WHERE tenant_id = $1 AND document_id = $2`,
    [tenantId, invoiceId]))
  apId = ap[0].id

  const pay = await withBypass(() => supplierInvoiceService.registerPayment({
    tenantId, supplierId,
    paymentDate: '2026-07-15', method: 'transfer', reference: 'SPEI-123',
    amount: 1160, currency: 'MXN',
    applications: [{ apId, amountApplied: 1160 }],
  }))
  paymentId = pay.id
})

afterAll(async () => { await cleanupTestTenants(); await pool.end() })

test('parser: CFDI tipo P → tipoComprobante, pagos y doctos relacionados', async () => {
  const parsed = await documentParserService.parseSupplierDocument(
    Buffer.from(repXml({ uuid: REP_UUID, docUuid: INV_UUID })), 'application/xml', 'rep.xml')
  expect(parsed.tipoComprobante).toBe('P')
  expect(parsed.paymentComplement.payments).toHaveLength(1)
  const p = parsed.paymentComplement.payments[0]
  expect(p.amount).toBe(1160)
  expect(p.paymentDate).toBe('2026-07-15')
  expect(p.paymentForm).toBe('03')
  expect(p.relatedDocs).toHaveLength(1)
  expect(p.relatedDocs[0].uuid).toBe(INV_UUID)
  expect(p.relatedDocs[0].parcialidad).toBe(1)
  expect(p.relatedDocs[0].impPagado).toBe(1160)
})

test('parser: CFDI de ingreso ahora trae MetodoPago', async () => {
  const parsed = await documentParserService.parseSupplierDocument(
    Buffer.from(invoiceXml({ uuid: '00000000-0000-0000-0000-00000000aa01' })), 'application/xml', 'f.xml')
  expect(parsed.tipoComprobante).toBe('I')
  expect(parsed.metodoPago).toBe('PPD')
})

test('tablero: la PPD pagada aparece SIN complemento antes de recibir el REP', async () => {
  const c = await supplierComplementService.listCompliance({ tenantId })
  const row = c.data.find(r => r.id === invoiceId)
  expect(row).toBeTruthy()
  expect(parseFloat(row.amount_paid_mxn)).toBeCloseTo(1160, 2)
  expect(parseFloat(row.covered_mxn)).toBeCloseTo(0, 2)
})

test('inbound: el REP NO crea gasto — se registra como complemento y se auto-liga', async () => {
  const r = await inboundEmailService.ingestInboundDocument({
    token, filename: 'rep.xml', mimetype: 'application/xml',
    contentBase64: b64(repXml({ uuid: REP_UUID, docUuid: INV_UUID })),
    from: 'proveedor@correo.mx',
  })
  expect(r.kind).toBe('payment_complement')
  expect(r.status).toBe('created')
  expect(r.matchStatus).toBe('matched')
  expect(r.docsMatched).toBe(1)
  expect(r.paymentLinked).toBe(true)

  // NO existe un gasto/factura con el UUID del REP.
  const { rows: si } = await withBypass(() => query(
    `SELECT id FROM supplier_invoices WHERE tenant_id = $1 AND uuid_sat = $2`,
    [tenantId, REP_UUID]))
  expect(si).toHaveLength(0)

  // El complemento quedó ligado a la factura Y al pago.
  const { rows: comp } = await withBypass(() => query(
    `SELECT c.id, c.supplier_payment_id, c.match_status, c.partner_id, c.amount
       FROM supplier_payment_complements c WHERE c.tenant_id = $1 AND c.cfdi_uuid = $2`,
    [tenantId, REP_UUID]))
  expect(comp).toHaveLength(1)
  expect(comp[0].supplier_payment_id).toBe(paymentId)
  expect(comp[0].match_status).toBe('matched')
  expect(comp[0].partner_id).toBe(supplierId)
  expect(parseFloat(comp[0].amount)).toBeCloseTo(1160, 2)

  const { rows: docs } = await withBypass(() => query(
    `SELECT supplier_invoice_id, imp_pagado, num_parcialidad
       FROM supplier_payment_complement_docs WHERE complement_id = $1`, [comp[0].id]))
  expect(docs).toHaveLength(1)
  expect(docs[0].supplier_invoice_id).toBe(invoiceId)
})

test('tablero: tras el REP la factura sale de "por vigilar"', async () => {
  const c = await supplierComplementService.listCompliance({ tenantId })
  expect(c.data.find(r => r.id === invoiceId)).toBeFalsy()
})

test('inbound: mismo REP otra vez → duplicado idempotente', async () => {
  const r = await inboundEmailService.ingestInboundDocument({
    token, filename: 'rep.xml', mimetype: 'application/xml',
    contentBase64: b64(repXml({ uuid: REP_UUID, docUuid: INV_UUID })),
  })
  expect(r.status).toBe('duplicate')
  const { rows } = await withBypass(() => query(
    `SELECT COUNT(*)::int AS n FROM supplier_payment_complements WHERE tenant_id = $1 AND cfdi_uuid = $2`,
    [tenantId, REP_UUID]))
  expect(rows[0].n).toBe(1)
})

test('inbound: candado de RFC receptor también aplica a los REP', async () => {
  await expect(inboundEmailService.ingestInboundDocument({
    token, filename: 'ajeno.xml', mimetype: 'application/xml',
    contentBase64: b64(repXml({
      uuid: '99999999-9999-9999-9999-999999999999', docUuid: INV_UUID,
      receptorRfc: 'ZZZ010101ZZ9' })),
  })).rejects.toMatchObject({ status: 403 })
})

test('REP con factura desconocida → review; al registrar la factura, rematch lo liga', async () => {
  // REP-2 llega ANTES de que la factura que liquida exista en el sistema.
  const r = await inboundEmailService.ingestInboundDocument({
    token, filename: 'rep2.xml', mimetype: 'application/xml',
    contentBase64: b64(repXml({ uuid: REP2_UUID, docUuid: INV2_UUID, monto: 500, impPagado: 500 })),
  })
  expect(r.status).toBe('created')
  expect(r.matchStatus).toBe('review')
  expect(r.docsMatched).toBe(0)

  // Llega la factura + su pago.
  const inv2 = await withBypass(() => supplierInvoiceService.registerInvoice({
    tenantId, supplierId,
    documentNumber: 'A-556', uuidSat: INV2_UUID, invoiceDate: '2026-07-12',
    rfcEmisor: SUPPLIER_RFC,
    subtotal: 431.03, tax: 68.97, total: 500,
    metodoPagoSat: 'PPD',
  }))
  const { rows: ap2 } = await withBypass(() => query(
    `SELECT id FROM accounts_payable WHERE tenant_id = $1 AND document_id = $2`,
    [tenantId, inv2.id]))
  await withBypass(() => supplierInvoiceService.registerPayment({
    tenantId, supplierId,
    paymentDate: '2026-07-15', method: 'transfer',
    amount: 500, currency: 'MXN',
    applications: [{ apId: ap2[0].id, amountApplied: 500 }],
  }))

  const updated = await withBypass(() => supplierComplementService.rematchComplement({
    tenantId, complementId: r.complementId }))
  expect(updated.match_status).toBe('matched')
  expect(updated.docs[0].supplier_invoice_id).toBe(inv2.id)
  expect(updated.supplier_payment_id).toBeTruthy()
})

test('HTTP: listado, detalle, tablero y detalle de pago con complementos', async () => {
  const list = await client.get('/api/purchases/complements')
  expect(list.status).toBe(200)
  expect(list.body.total).toBeGreaterThanOrEqual(2)

  const compId = list.body.data.find(c => c.cfdi_uuid === REP_UUID).id
  const det = await client.get(`/api/purchases/complements/${compId}`)
  expect(det.status).toBe(200)
  expect(det.body.docs).toHaveLength(1)
  expect(det.body.docs[0].invoice_number).toBe('A-555')

  const comp = await client.get('/api/purchases/complements/compliance')
  expect(comp.status).toBe(200)

  // El detalle del pago emitido incluye su REP.
  const pay = await client.get(`/api/purchases/payments/${paymentId}`)
  expect(pay.status).toBe(200)
  expect(pay.body.complements).toHaveLength(1)
  expect(pay.body.complements[0].cfdi_uuid).toBe(REP_UUID)
})

test('HTTP: subir XML a mano — REP entra, factura normal se rechaza con 400', async () => {
  // Un CFDI de ingreso NO pasa por esta puerta.
  const bad = await client.post('/api/purchases/complements/upload')
    .attach('file', Buffer.from(invoiceXml({ uuid: '00000000-0000-0000-0000-00000000aa02' })), 'factura.xml')
  expect(bad.status).toBe(400)

  // Un REP nuevo sí (y el duplicado responde 200 idempotente).
  const uuid = 'eeee1111-2222-3333-4444-555555555555'
  const ok = await client.post('/api/purchases/complements/upload')
    .attach('file', Buffer.from(repXml({ uuid, docUuid: INV_UUID, monto: 10, impPagado: 10 })), 'rep3.xml')
  expect(ok.status).toBe(201)
  expect(ok.body.status).toBe('created')

  const dup = await client.post('/api/purchases/complements/upload')
    .attach('file', Buffer.from(repXml({ uuid, docUuid: INV_UUID, monto: 10, impPagado: 10 })), 'rep3.xml')
  expect(dup.status).toBe(200)
  expect(dup.body.status).toBe('duplicate')

  // Limpieza del REP chico para no ensuciar el tablero de otros asserts.
  const { rows } = await withBypass(() => query(
    `SELECT id FROM supplier_payment_complements WHERE tenant_id = $1 AND cfdi_uuid = $2`,
    [tenantId, uuid]))
  await withBypass(() => supplierComplementService.removeComplement({
    tenantId, complementId: rows[0].id }))
})

test('CxP: el listado trae el semáforo rep_status', async () => {
  const res = await client.get('/api/purchases/cxp')
  expect(res.status).toBe(200)
  const row = res.body.data.find(d => d.document_number === 'A-555')
  expect(row).toBeTruthy()
  expect(row.rep_status).toBe('complete')
})
