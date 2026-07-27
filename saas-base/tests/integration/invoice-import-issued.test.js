'use strict'

/**
 * Importación de facturas EMITIDAS timbradas en OTRO sistema (mig 236).
 *
 * Flujo: parse (preview) → import (invoice 'stamped' source='imported' + CXC
 * con saldo real + cliente auto por RFC receptor) → cobro de una PPD importada
 * timbra el REP vía Facturapi referenciando el cfdi_uuid crudo, continuando la
 * numeración de parcialidades del sistema anterior.
 */

jest.mock('../../src/modules/invoicing/facturapiClient')

const request = require('supertest')
const app = require('../../src/app')
const { pool, query, withBypass } = require('../../src/db')
const importIssuedService = require('../../src/modules/invoicing/importIssuedService')
const cxcService = require('../../src/modules/financials/cxcService')
const facturapiClient = require('../../src/modules/invoicing/facturapiClient')
const { createTenant, loginAs, cleanupTestTenants } = require('../helpers/factory')

let tenantId, slug, authToken, userId, customerId

const TENANT_RFC   = 'AAA010101AAA'   // EMISOR (nosotros)
const CUSTOMER_RFC = 'CLI010101CL5'   // receptor conocido
const NEW_RFC      = 'NVO010101NV9'   // receptor sin cliente → se crea

function issuedXml({ uuid, folio = '10', serie = 'F', receptorRfc = CUSTOMER_RFC,
                     receptorName = 'Cliente Migrado SA', emisorRfc = TENANT_RFC,
                     subtotal = 1000, total = 1160, metodoPago = 'PUE', tipo = 'I' }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<cfdi:Comprobante xmlns:cfdi="http://www.sat.gob.mx/cfd/4" Serie="${serie}" Folio="${folio}" Fecha="2026-06-15T12:00:00" SubTotal="${subtotal}" Moneda="MXN" Total="${total}" TipoDeComprobante="${tipo}" MetodoPago="${metodoPago}">
  <cfdi:Emisor Rfc="${emisorRfc}" Nombre="TENANT TEST SA" RegimenFiscal="601"/>
  <cfdi:Receptor Rfc="${receptorRfc}" Nombre="${receptorName}" DomicilioFiscalReceptor="64000" RegimenFiscalReceptor="601" UsoCFDI="G03"/>
  <cfdi:Conceptos>
    <cfdi:Concepto Cantidad="1" ClaveUnidad="H87" Descripcion="Producto migrado" ValorUnitario="${subtotal}" Importe="${subtotal}"/>
  </cfdi:Conceptos>
  <cfdi:Complemento>
    <tfd:TimbreFiscalDigital xmlns:tfd="http://www.sat.gob.mx/TimbreFiscalDigital" UUID="${uuid}"/>
  </cfdi:Complemento>
</cfdi:Comprobante>`
}

const toFile = (xml) => ({
  filename: 'f.xml', mimetype: 'application/xml',
  contentBase64: Buffer.from(xml, 'utf8').toString('base64'),
})

beforeAll(async () => {
  const t = await createTenant({ label: 'impissued', planSlug: 'owner' })
  tenantId = t.tenant.id
  slug = t.tenant.slug
  userId = t.user.id

  const session = await loginAs({ slug, email: t.email, password: t.password })
  authToken = session.token

  // RFC del tenant (candado: el EMISOR debe ser nuestro).
  await withBypass(() => query(
    `INSERT INTO tenant_fiscal_profiles (tenant_id, rfc, tax_name, tax_regime, zip_code, is_active)
     VALUES ($1,$2,'TENANT TEST SA','601','12345',true)`,
    [tenantId, TENANT_RFC]))

  // Cliente existente (match por RFC receptor).
  const { rows: bp } = await withBypass(() => query(
    `INSERT INTO business_partners (tenant_id, type, name, rfc, credit_type, credit_days)
     VALUES ($1,'customer','Cliente Migrado SA',$2,'credit',30) RETURNING id`,
    [tenantId, CUSTOMER_RFC]))
  customerId = bp[0].id
})

afterAll(async () => { await cleanupTestTenants(); await pool.end() })

// ── Paso 1: preview ──────────────────────────────────────────────────────────

test('parseBatch: factura válida → ok con cliente emparejado por RFC receptor', async () => {
  const out = await importIssuedService.parseBatch({
    tenantId, files: [toFile(issuedXml({ uuid: 'ff000001-0000-0000-0000-000000000001' }))],
  })
  expect(out.summary).toMatchObject({ ok: 1, duplicates: 0, errors: 0 })
  expect(out.rows[0].matchedPartner?.id).toBe(customerId)
  expect(out.rows[0].metodoPago).toBe('PUE')
  // No filtra internals al frontend.
  expect(out.rows[0]._parsed).toBeUndefined()
})

test('parseBatch: emisor ajeno → error (esta pantalla es de facturas propias)', async () => {
  const out = await importIssuedService.parseBatch({
    tenantId, files: [toFile(issuedXml({
      uuid: 'ff000002-0000-0000-0000-000000000002', emisorRfc: 'ZZZ010101ZZ9' }))],
  })
  expect(out.summary.errors).toBe(1)
  expect(out.rows[0].error).toMatch(/emisor/i)
})

test('parseBatch: CFDI tipo P o E → error claro', async () => {
  const out = await importIssuedService.parseBatch({
    tenantId, files: [
      toFile(issuedXml({ uuid: 'ff000003-0000-0000-0000-000000000003', tipo: 'E' })),
    ],
  })
  expect(out.rows[0].status).toBe('error')
  expect(out.rows[0].error).toMatch(/nota de crédito/i)
})

// ── Paso 2: import ──────────────────────────────────────────────────────────

test('importBatch: crea la factura stamped/imported + CXC completa (PUE sin ajustes)', async () => {
  const uuid = 'ff000010-0000-0000-0000-000000000010'
  const out = await importIssuedService.importBatch({
    tenantId, userId, files: [toFile(issuedXml({ uuid, folio: '20' }))],
  })
  expect(out.summary).toMatchObject({ created: 1, errors: 0 })

  const { rows: inv } = await withBypass(() => query(
    `SELECT * FROM invoices WHERE tenant_id = $1 AND cfdi_uuid = $2`, [tenantId, uuid]))
  expect(inv[0].status).toBe('stamped')
  expect(inv[0].source).toBe('imported')
  expect(inv[0].partner_id).toBe(customerId)
  expect(inv[0].document_number).toBe('F-20')
  expect(parseFloat(inv[0].total)).toBeCloseTo(1160, 2)

  const { rows: ar } = await withBypass(() => query(
    `SELECT * FROM accounts_receivable
      WHERE tenant_id = $1 AND document_type = 'invoice' AND document_id = $2`,
    [tenantId, inv[0].id]))
  expect(ar).toHaveLength(1)
  expect(parseFloat(ar[0].amount_total)).toBeCloseTo(1160, 2)
  expect(parseFloat(ar[0].amount_paid)).toBeCloseTo(0, 2)
  expect(ar[0].status).toBe('pending')
  // Vencimiento = emisión + 30 días de crédito del cliente.
  expect(ar[0].due_date.toISOString().slice(0, 10)).toBe('2026-07-15')

  // Respaldo XML pegado a la factura.
  const { rows: att } = await withBypass(() => query(
    `SELECT mime_type FROM attachments
      WHERE tenant_id = $1 AND entity_type = 'invoice' AND entity_id = $2 AND category = 'cfdi'`,
    [tenantId, inv[0].id]))
  expect(att).toHaveLength(1)
})

test('importBatch: PPD con saldo/parcialidades capturados → CXC parcial y campos imported_*', async () => {
  const uuid = 'ff000011-0000-0000-0000-000000000011'
  const out = await importIssuedService.importBatch({
    tenantId, userId,
    files: [toFile(issuedXml({ uuid, folio: '21', metodoPago: 'PPD', subtotal: 2000, total: 2320 }))],
    adjustments: { [uuid]: { balance: 1320, installments: 2 } },   // ya abonaron 1000 allá
  })
  expect(out.summary.created).toBe(1)

  const { rows: inv } = await withBypass(() => query(
    `SELECT * FROM invoices WHERE tenant_id = $1 AND cfdi_uuid = $2`, [tenantId, uuid]))
  expect(inv[0].payment_method).toBe('PPD')
  expect(parseFloat(inv[0].imported_initial_balance)).toBeCloseTo(1320, 2)
  expect(inv[0].imported_installments).toBe(2)

  const { rows: ar } = await withBypass(() => query(
    `SELECT amount_total, amount_paid, amount_pending, status FROM accounts_receivable
      WHERE tenant_id = $1 AND document_id = $2`, [tenantId, inv[0].id]))
  expect(parseFloat(ar[0].amount_paid)).toBeCloseTo(1000, 2)
  expect(parseFloat(ar[0].amount_pending)).toBeCloseTo(1320, 2)
  expect(ar[0].status).toBe('partial')
})

test('importBatch: receptor sin cliente → lo crea con RFC/régimen/CP del XML', async () => {
  const uuid = 'ff000012-0000-0000-0000-000000000012'
  const out = await importIssuedService.importBatch({
    tenantId, userId,
    files: [toFile(issuedXml({
      uuid, folio: '22', receptorRfc: NEW_RFC, receptorName: 'Cliente Nuevo SA' }))],
  })
  expect(out.summary.created).toBe(1)
  expect(out.summary.customersCreated).toBe(1)

  const { rows: bp } = await withBypass(() => query(
    `SELECT type, name, zip_code, tax_regime_code FROM business_partners
      WHERE tenant_id = $1 AND rfc = $2`, [tenantId, NEW_RFC]))
  expect(bp).toHaveLength(1)
  expect(bp[0].type).toBe('customer')
  expect(bp[0].name).toBe('Cliente Nuevo SA')
  expect(bp[0].zip_code).toBe('64000')
  expect(bp[0].tax_regime_code).toBe('601')
})

test('importBatch: mismo UUID otra vez → duplicate (idempotente)', async () => {
  const uuid = 'ff000010-0000-0000-0000-000000000010'
  const out = await importIssuedService.importBatch({
    tenantId, userId, files: [toFile(issuedXml({ uuid, folio: '20' }))],
  })
  expect(out.summary).toMatchObject({ created: 0, duplicates: 1 })
  const { rows } = await withBypass(() => query(
    `SELECT COUNT(*)::int AS n FROM invoices WHERE tenant_id = $1 AND cfdi_uuid = $2`,
    [tenantId, uuid]))
  expect(rows[0].n).toBe(1)
})

test('importBatch: saldo mayor al total → error en esa factura', async () => {
  const uuid = 'ff000013-0000-0000-0000-000000000013'
  const out = await importIssuedService.importBatch({
    tenantId, userId,
    files: [toFile(issuedXml({ uuid, folio: '23', metodoPago: 'PPD' }))],
    adjustments: { [uuid]: { balance: 99999 } },
  })
  expect(out.summary.errors).toBe(1)
  expect(out.results[0].error).toMatch(/Saldo inválido/i)
})

// ── Cobro de una PPD importada → REP con parcialidad N+1 ────────────────────

test('registerPayment sobre PPD importada: timbra REP por cfdi_uuid con parcialidad continuada', async () => {
  const uuid = 'ff000020-0000-0000-0000-000000000020'
  await importIssuedService.importBatch({
    tenantId, userId,
    files: [toFile(issuedXml({ uuid, folio: '30', metodoPago: 'PPD', subtotal: 1000, total: 1160 }))],
    adjustments: { [uuid]: { balance: 660, installments: 1 } },   // 1 REP emitido allá, deben 660
  })
  const { rows: inv } = await withBypass(() => query(
    `SELECT id FROM invoices WHERE tenant_id = $1 AND cfdi_uuid = $2`, [tenantId, uuid]))
  const invoiceId = inv[0].id
  const { rows: arRows } = await withBypass(() => query(
    `SELECT id FROM accounts_receivable WHERE tenant_id = $1 AND document_id = $2`,
    [tenantId, invoiceId]))
  const arId = arRows[0].id

  let captured
  facturapiClient.getFacturapiForTenant.mockResolvedValue({
    invoices: {
      create: jest.fn(async (payload) => {
        captured = payload
        return { id: 'fa_rep_imported', uuid: '99999999-8888-7777-6666-555555555555' }
      }),
    },
  })

  const res = await cxcService.registerPayment({
    tenantId, partnerId: customerId, method: 'transfer', reference: 'SPEI-IMP',
    amount: 660, applications: [{ arId, amountApplied: 660 }], userId,
  })

  expect(res.complementsIssued).toHaveLength(1)
  const doc = captured.complements[0].data.related_documents[0]
  expect(doc.uuid).toBe(uuid)              // referencia el UUID del PAC original
  expect(doc.installment).toBe(2)          // 1 emitida allá + esta
  expect(doc.last_balance).toBeCloseTo(660, 2)   // saldo al importar − REPs locales previos
  expect(doc.amount).toBeCloseTo(660, 2)

  // El complemento local quedó ligado al cobro.
  const { rows: pc } = await withBypass(() => query(
    `SELECT COUNT(*)::int AS n FROM payment_complements
      WHERE tenant_id = $1 AND invoice_id = $2 AND status = 'stamped'`, [tenantId, invoiceId]))
  expect(pc[0].n).toBe(1)
})

// ── Ramas Facturapi bloqueadas con mensaje claro ────────────────────────────

test('cancel-sat y sync-sat de una importada → 409 con mensaje claro', async () => {
  const { rows: inv } = await withBypass(() => query(
    `SELECT id FROM invoices WHERE tenant_id = $1 AND cfdi_uuid = $2`,
    [tenantId, 'ff000010-0000-0000-0000-000000000010']))

  const headers = { 'X-Tenant-Slug': slug, Authorization: `Bearer ${authToken}` }
  const r1 = await request(app)
    .post(`/api/invoicing/invoices/${inv[0].id}/cancel-sat`).set(headers)
    .send({ motive: '02' })
  expect(r1.status).toBe(409)
  expect(r1.body.error).toMatch(/importada|otro sistema/i)

  const r2 = await request(app)
    .post(`/api/invoicing/invoices/${inv[0].id}/sync-sat`).set(headers).send({})
  expect(r2.status).toBe(409)
})

test('xml-stamped de una importada → sirve el XML de respaldo (no Facturapi)', async () => {
  const { rows: inv } = await withBypass(() => query(
    `SELECT id FROM invoices WHERE tenant_id = $1 AND cfdi_uuid = $2`,
    [tenantId, 'ff000010-0000-0000-0000-000000000010']))
  const res = await request(app)
    .get(`/api/invoicing/invoices/${inv[0].id}/xml-stamped`)
    .set({ 'X-Tenant-Slug': slug, Authorization: `Bearer ${authToken}` })
  expect(res.status).toBe(200)
  expect(res.headers['content-type']).toContain('xml')
  expect(res.text || res.body.toString()).toContain('ff000010-0000-0000-0000-000000000010')
})

// ── Rutas HTTP del wizard ───────────────────────────────────────────────────

test('POST /invoicing/import/parse y /invoicing/import (multipart) funcionan', async () => {
  const headers = { 'X-Tenant-Slug': slug, Authorization: `Bearer ${authToken}` }
  const xml = issuedXml({ uuid: 'ff000030-0000-0000-0000-000000000030', folio: '40', metodoPago: 'PPD' })

  const p = await request(app)
    .post('/api/invoicing/import/parse').set(headers)
    .attach('files', Buffer.from(xml), 'f40.xml')
  expect(p.status).toBe(200)
  expect(p.body.summary.ok).toBe(1)

  const i = await request(app)
    .post('/api/invoicing/import').set(headers)
    .field('adjustments', JSON.stringify({
      'ff000030-0000-0000-0000-000000000030': { balance: 500, installments: 3 },
    }))
    .attach('files', Buffer.from(xml), 'f40.xml')
  expect(i.status).toBe(200)
  expect(i.body.summary.created).toBe(1)

  const { rows } = await withBypass(() => query(
    `SELECT imported_installments, imported_initial_balance FROM invoices
      WHERE tenant_id = $1 AND cfdi_uuid = $2`,
    [tenantId, 'ff000030-0000-0000-0000-000000000030']))
  expect(rows[0].imported_installments).toBe(3)
  expect(parseFloat(rows[0].imported_initial_balance)).toBeCloseTo(500, 2)
})
